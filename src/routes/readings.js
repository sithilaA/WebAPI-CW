// Generation readings: an append-only time series.
//   write (device) : POST /installations/:id/readings
//   read  (user)   : history (paginated, filtered, sorted), last-known reading, single reading,
//                    and a cross-installation history (GET /readings)
// Readings are never updated or deleted, so PUT / PATCH / DELETE answer 405.
const router = require('express').Router();
const config = require('../config');
const db = require('../db');
const {
  ah, idParam, parsePagination, parseSort, parseWindow, paginate, sendRepresentation, validateBody, sendCreated,
} = require('../http');
const { requireUser, requireDevice } = require('../auth');
const { scopeSql, parseHierarchyFilters, assertFiltersInScope, filterConditions } = require('../scope');
const { READING_COLUMNS, loadVisible, pagedQuery } = require('../repo');
const { rateLimit } = require('../rateLimit');
const { validationError, conflict, notFound, methodNotAllowed } = require('../errors');

const READING_SCHEMA = {
  timestamp: { type: 'timestamp', required: true },
  power_kw: { type: 'number', required: true, min: 0, max: 100000 },
  energy_kwh: { type: 'number', required: true, min: 0, max: 100000000 },
  voltage: { type: 'number', required: true, min: 1, max: 1000 },
};

const SORT_FIELDS = { timestamp: 'r.ts', power_kw: 'r.power_kw', energy_kwh: 'r.energy_kwh' };

// Joins each reading up the hierarchy so it can be filtered / scoped by substation, district, province.
const READINGS_FROM = `generation_reading r
  JOIN solar_installation si ON si.id = r.installation_id
  JOIN grid_substation gs ON gs.id = si.substation_id
  JOIN district d ON d.id = gs.district_id`;
const MAX_FUTURE_MS = 5 * 60 * 1000;

const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.ingestLimitPerMin,
  keyFn: (req) => `installation:${req.principal.installationId}`,
  message: 'Too many readings from this device. Slow down.',
});

const notAllowed = (...methods) => (req, res, next) => next(methodNotAllowed(methods));

// ---------------------------------------------------------------- history & ingestion

router
  .route('/installations/:id/readings')
  .get(
    requireUser,
    ah(async (req, res) => {
      const installation = await loadVisible('installation', req.user, idParam(req));
      const { page, limit, offset } = parsePagination(req.query);
      const sort = parseSort(req.query, SORT_FIELDS, '-timestamp');
      const { from, to } = parseWindow(req.query);

      const params = [installation.id];
      const conds = ['r.installation_id = $1'];
      if (from) { params.push(from.toISOString()); conds.push(`r.ts >= $${params.length}`); }
      if (to) { params.push(to.toISOString()); conds.push(`r.ts <= $${params.length}`); }

      const { rows, total } = await pagedQuery({
        select: READING_COLUMNS,
        from: 'generation_reading r',
        where: conds.join(' AND '),
        params,
        order: `${sort.sql}, r.id`,
        limit,
        offset,
      });
      sendRepresentation(req, res, paginate(req, { rows, total, page, limit }));
    })
  )
  .post(
    requireDevice,
    ingestLimiter,
    ah(async (req, res) => {
      const installationId = idParam(req);
      const b = validateBody(req.body, READING_SCHEMA);
      const ts = new Date(b.timestamp);
      if (ts.getTime() > Date.now() + MAX_FUTURE_MS) {
        throw validationError([{ field: 'timestamp', issue: 'must not be more than 5 minutes in the future' }]);
      }

      let row;
      try {
        const { rows } = await db.query(
          `INSERT INTO generation_reading (installation_id, ts, power_kw, energy_kwh, voltage)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, installation_id, ts AS timestamp, power_kw, energy_kwh, voltage, received_at`,
          [installationId, ts.toISOString(), b.power_kw, b.energy_kwh, b.voltage]
        );
        row = rows[0];
      } catch (err) {
        if (err.code === '23505') {
          throw conflict('DUPLICATE_READING', 'A reading for this installation at this timestamp already exists', [
            { field: 'timestamp', issue: 'already recorded' },
          ]);
        }
        throw err;
      }
      sendCreated(req, res, `/installations/${installationId}/readings/${row.id}`, row, row.received_at);
    })
  )
  .all(notAllowed('GET', 'HEAD', 'POST'));

// Operational view: the single most recent reading, exposed as a derived resource.
router
  .route('/installations/:id/readings/latest')
  .get(
    requireUser,
    ah(async (req, res) => {
      const installation = await loadVisible('installation', req.user, idParam(req));
      const { rows } = await db.query(
        `SELECT ${READING_COLUMNS} FROM generation_reading r
         WHERE r.installation_id = $1 ORDER BY r.ts DESC LIMIT 1`,
        [installation.id]
      );
      if (rows.length === 0) throw notFound(`Installation ${installation.id} has not reported any readings yet`);
      sendRepresentation(req, res, rows[0], rows[0].received_at);
    })
  )
  .all(notAllowed('GET', 'HEAD'));

router
  .route('/installations/:id/readings/:readingId')
  .get(
    requireUser,
    ah(async (req, res) => {
      const installation = await loadVisible('installation', req.user, idParam(req));
      const readingId = idParam(req, 'readingId');
      const { rows } = await db.query(
        `SELECT ${READING_COLUMNS} FROM generation_reading r WHERE r.id = $1 AND r.installation_id = $2`,
        [readingId, installation.id]
      );
      if (rows.length === 0) throw notFound(`Reading ${readingId} not found for installation ${installation.id}`);
      sendRepresentation(req, res, rows[0], rows[0].received_at);
    })
  )
  .all(notAllowed('GET', 'HEAD')); // append-only: no PUT / PATCH / DELETE

// ---------------------------------------------------------------- cross-installation history

// Analytical view across the hierarchy, e.g. /readings?district=3&from=...&to=...&sort=-timestamp
router.get(
  '/readings',
  requireUser,
  ah(async (req, res) => {
    const { page, limit, offset } = parsePagination(req.query);
    const sort = parseSort(req.query, SORT_FIELDS, '-timestamp');
    const { from, to } = parseWindow(req.query);
    const filters = parseHierarchyFilters(req.query, { installation: true });
    await assertFiltersInScope(req.user, filters);

    const params = [];
    const conds = [scopeSql(req.user, params, { province: 'd.province_id', district: 'd.id' })];
    conds.push(...filterConditions(filters, params));
    if (from) { params.push(from.toISOString()); conds.push(`r.ts >= $${params.length}`); }
    if (to) { params.push(to.toISOString()); conds.push(`r.ts <= $${params.length}`); }

    const { rows, total } = await pagedQuery({
      select: READING_COLUMNS,
      from: READINGS_FROM,
      where: conds.join(' AND '),
      params,
      order: `${sort.sql}, r.id`,
      limit,
      offset,
    });
    sendRepresentation(req, res, paginate(req, { rows, total, page, limit }));
  })
);

module.exports = router;
