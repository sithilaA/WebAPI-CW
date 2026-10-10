// Solar installations: the metered assets.
//   read  : collection (filterable), atomic, composite /overview
//   write : create under a substation, PUT / PATCH / DELETE, API-key rotation (national only)
const router = require('express').Router();
const db = require('../db');
const {
  ah, idParam, parsePagination, parseSort, paginate, sendRepresentation, assertIfMatch,
  validateBody, sendCreated,
} = require('../http');
const { requireUser, requireRole } = require('../auth');
const { scopeSql, parseHierarchyFilters, assertFiltersInScope, filterConditions } = require('../scope');
const {
  INSTALLATION_FROM, INSTALLATION_COLUMNS, READING_COLUMNS,
  loadRow, loadVisible, installationRep, pagedQuery,
} = require('../repo');
const { generateDeviceKey } = require('../keys');
const { colomboDayStart } = require('../time');
const { validationError, badRequest } = require('../errors');

const national = [requireUser, requireRole('national')];

const INSTALLATION_SCHEMA = {
  name: { type: 'string', required: true, max: 120 },
  owner_name: { type: 'string', required: true, max: 120 },
  meter_id: { type: 'string', required: true, max: 50 },
  capacity_kw: { type: 'number', required: true, min: 0.1, max: 1000 },
  installed_on: { type: 'date', required: true },
  substation_id: { type: 'integer', required: true, min: 1 },
};
// When creating under /substations/:id/installations the parent comes from the URL.
const { substation_id: _parent, ...CREATE_SCHEMA } = INSTALLATION_SCHEMA;

const SORT_FIELDS = { id: 'si.id', name: 'si.name', capacity_kw: 'si.capacity_kw', installed_on: 'si.installed_on' };

async function listInstallations(req, res, fixed = {}) {
  const { page, limit, offset } = parsePagination(req.query);
  const sort = parseSort(req.query, SORT_FIELDS, 'id');
  const filters = { ...parseHierarchyFilters(req.query), ...fixed };
  await assertFiltersInScope(req.user, filters);

  const params = [];
  const conds = [scopeSql(req.user, params, { province: 'd.province_id', district: 'd.id' })];
  conds.push(...filterConditions(filters, params));

  const { rows, total } = await pagedQuery({
    select: INSTALLATION_COLUMNS,
    from: INSTALLATION_FROM,
    where: conds.join(' AND '),
    params,
    order: `${sort.sql}, si.id`,
    limit,
    offset,
  });
  sendRepresentation(req, res, paginate(req, { rows, total, page, limit }));
}

// ---------------------------------------------------------------- collection & creation

router.get('/installations', requireUser, ah((req, res) => listInstallations(req, res)));

router.get(
  '/substations/:id/installations',
  requireUser,
  ah(async (req, res) => {
    const substation = await loadVisible('substation', req.user, idParam(req));
    await listInstallations(req, res, { substation: substation.id });
  })
);

router.post(
  '/substations/:id/installations',
  ...national,
  ah(async (req, res) => {
    const substation = await loadRow('substation', idParam(req));
    const b = validateBody(req.body, CREATE_SCHEMA);
    const { key, hash } = generateDeviceKey();
    const { rows } = await db.query(
      `INSERT INTO solar_installation (substation_id, name, owner_name, meter_id, capacity_kw, installed_on, api_key_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [substation.id, b.name, b.owner_name, b.meter_id, b.capacity_kw, b.installed_on, hash]
    );
    const row = await loadRow('installation', rows[0].id);
    // The plaintext key is shown exactly once; only its hash is stored.
    res.set('Cache-Control', 'no-store');
    sendCreated(req, res, `/installations/${row.id}`, { ...installationRep(row), device_api_key: key });
  })
);

// ---------------------------------------------------------------- atomic resource

router.get(
  '/installations/:id',
  requireUser,
  ah(async (req, res) => {
    const row = await loadVisible('installation', req.user, idParam(req));
    sendRepresentation(req, res, installationRep(row), row.updated_at);
  })
);

async function resolveSubstation(id) {
  const { rows } = await db.query('SELECT id FROM grid_substation WHERE id = $1', [id]);
  if (rows.length === 0) throw validationError([{ field: 'substation_id', issue: 'does not refer to an existing substation' }]);
}

async function applyUpdate(req, res, { partial }) {
  const id = idParam(req);
  const current = await loadRow('installation', id);
  assertIfMatch(req, installationRep(current));

  const body = validateBody(req.body, INSTALLATION_SCHEMA, { partial });
  if (partial && Object.keys(body).length === 0) {
    throw badRequest('PATCH body must contain at least one field to change');
  }
  const next = { ...installationRep(current), ...body };
  if (body.substation_id !== undefined) await resolveSubstation(body.substation_id);

  await db.query(
    `UPDATE solar_installation SET name = $1, owner_name = $2, meter_id = $3, capacity_kw = $4,
            installed_on = $5, substation_id = $6, updated_at = now() WHERE id = $7`,
    [next.name, next.owner_name, next.meter_id, next.capacity_kw, next.installed_on, next.substation_id, id]
  );
  const row = await loadRow('installation', id);
  sendRepresentation(req, res, installationRep(row), row.updated_at);
}

// PUT replaces the whole resource (idempotent); PATCH changes only the supplied fields.
router.put('/installations/:id', ...national, ah((req, res) => applyUpdate(req, res, { partial: false })));
router.patch('/installations/:id', ...national, ah((req, res) => applyUpdate(req, res, { partial: true })));

router.delete(
  '/installations/:id',
  ...national,
  ah(async (req, res) => {
    const id = idParam(req);
    assertIfMatch(req, installationRep(await loadRow('installation', id)));
    await db.query('DELETE FROM solar_installation WHERE id = $1', [id]); // readings cascade
    res.status(204).end();
  })
);

// Issues a new device key; the previous key stops working immediately.
router.post(
  '/installations/:id/api-key',
  ...national,
  ah(async (req, res) => {
    const id = idParam(req);
    await loadRow('installation', id);
    const { key, hash } = generateDeviceKey();
    await db.query('UPDATE solar_installation SET api_key_hash = $1, updated_at = now() WHERE id = $2', [hash, id]);
    res.set('Cache-Control', 'no-store').status(200).json({ installation_id: id, device_api_key: key });
  })
);

// ---------------------------------------------------------------- composite resource

// An installation together with its most relevant related data in one response.
router.get(
  '/installations/:id/overview',
  requireUser,
  ah(async (req, res) => {
    const row = await loadVisible('installation', req.user, idParam(req));

    const latest = await db.query(
      `SELECT ${READING_COLUMNS} FROM generation_reading r
       WHERE r.installation_id = $1 ORDER BY r.ts DESC LIMIT 1`,
      [row.id]
    );
    const latestReading = latest.rows[0] || null;

    // "Today" = the Colombo calendar day of the most recent reading, so the figure stays
    // meaningful for seeded data; with live devices it is simply today.
    let todayEnergy = 0;
    if (latestReading) {
      const dayStart = colomboDayStart(latestReading.timestamp);
      const e = await db.query(
        `SELECT COALESCE(MAX(energy_kwh) - MIN(energy_kwh), 0) AS kwh FROM generation_reading
         WHERE installation_id = $1 AND ts >= $2 AND ts <= $3`,
        [row.id, dayStart.toISOString(), latestReading.timestamp.toISOString()]
      );
      todayEnergy = Math.round(e.rows[0].kwh * 1000) / 1000;
    }

    const count = await db.query('SELECT COUNT(*)::int AS n FROM generation_reading WHERE installation_id = $1', [row.id]);

    sendRepresentation(req, res, {
      ...installationRep(row),
      substation: { id: row.substation_id, name: row.substation_name },
      district: { id: row.district_id, name: row.district_name },
      province: { id: row.province_id, name: row.province_name },
      latest_reading: latestReading,
      today_energy_kwh: todayEnergy,
      reading_count: count.rows[0].n,
    });
  })
);

module.exports = router;
