// Province -> District -> Grid Substation: collections nested under their parent,
// atomic resources by id, and national-only create / replace / delete.
const router = require('express').Router();
const db = require('../db');
const {
  ah, idParam, parsePagination, parseSort, paginate, sendRepresentation, sendCreated, assertIfMatch, validateBody,
} = require('../http');
const { requireUser, requireRole } = require('../auth');
const { scopeSql } = require('../scope');
const { loadRow, loadVisible, pagedQuery } = require('../repo');

const national = [requireUser, requireRole('national')];

const PROVINCE_SCHEMA = {
  name: { type: 'string', required: true, max: 100 },
  code: { type: 'string', required: true, max: 10 },
};
const DISTRICT_SCHEMA = { name: { type: 'string', required: true, max: 100 } };
const SUBSTATION_SCHEMA = {
  name: { type: 'string', required: true, max: 100 },
  capacity_mva: { type: 'number', required: true, min: 0.1, max: 10000 },
};

const created = (req, res, path, body) => sendCreated(req, res, path, body, body.updated_at);

// ---------------------------------------------------------------- provinces

router.get(
  '/provinces',
  requireUser,
  ah(async (req, res) => {
    const { page, limit, offset } = parsePagination(req.query);
    const sort = parseSort(req.query, { id: 'p.id', name: 'p.name' }, 'id');
    const params = [];
    // Provincial and district users both see only the province they belong to.
    const where = req.user.role === 'national' ? 'TRUE' : (params.push(req.user.province_id), `p.id = $${params.length}`);
    const { rows, total } = await pagedQuery({
      select: 'p.id, p.name, p.code, p.created_at, p.updated_at',
      from: 'province p',
      where,
      params,
      order: `${sort.sql}, p.id`,
      limit,
      offset,
    });
    sendRepresentation(req, res, paginate(req, { rows, total, page, limit }));
  })
);

router.post(
  '/provinces',
  ...national,
  ah(async (req, res) => {
    const b = validateBody(req.body, PROVINCE_SCHEMA);
    const { rows } = await db.query(
      'INSERT INTO province (name, code) VALUES ($1, $2) RETURNING id',
      [b.name, b.code]
    );
    const row = await loadRow('province', rows[0].id);
    created(req, res, `/provinces/${row.id}`, row);
  })
);

router.get(
  '/provinces/:id',
  requireUser,
  ah(async (req, res) => {
    const row = await loadVisible('province', req.user, idParam(req));
    sendRepresentation(req, res, row, row.updated_at);
  })
);

router.put(
  '/provinces/:id',
  ...national,
  ah(async (req, res) => {
    const id = idParam(req);
    assertIfMatch(req, await loadRow('province', id));
    const b = validateBody(req.body, PROVINCE_SCHEMA);
    await db.query('UPDATE province SET name = $1, code = $2, updated_at = now() WHERE id = $3', [b.name, b.code, id]);
    const row = await loadRow('province', id);
    sendRepresentation(req, res, row, row.updated_at);
  })
);

router.delete(
  '/provinces/:id',
  ...national,
  ah(async (req, res) => {
    const id = idParam(req);
    assertIfMatch(req, await loadRow('province', id));
    await db.query('DELETE FROM province WHERE id = $1', [id]); // 409 if districts still reference it
    res.status(204).end();
  })
);

// ---------------------------------------------------------------- districts (scoped under a province)

router.get(
  '/provinces/:id/districts',
  requireUser,
  ah(async (req, res) => {
    const province = await loadVisible('province', req.user, idParam(req));
    const { page, limit, offset } = parsePagination(req.query);
    const sort = parseSort(req.query, { id: 'd.id', name: 'd.name' }, 'id');
    const params = [province.id];
    const scope = scopeSql(req.user, params, { province: 'd.province_id', district: 'd.id' });
    const { rows, total } = await pagedQuery({
      select: 'd.id, d.name, d.province_id, d.created_at, d.updated_at',
      from: 'district d',
      where: `d.province_id = $1 AND ${scope}`,
      params,
      order: `${sort.sql}, d.id`,
      limit,
      offset,
    });
    sendRepresentation(req, res, paginate(req, { rows, total, page, limit }));
  })
);

router.post(
  '/provinces/:id/districts',
  ...national,
  ah(async (req, res) => {
    const province = await loadRow('province', idParam(req));
    const b = validateBody(req.body, DISTRICT_SCHEMA);
    const { rows } = await db.query('INSERT INTO district (province_id, name) VALUES ($1, $2) RETURNING id', [province.id, b.name]);
    created(req, res, `/districts/${rows[0].id}`, await loadRow('district', rows[0].id));
  })
);

router.get(
  '/districts/:id',
  requireUser,
  ah(async (req, res) => {
    const row = await loadVisible('district', req.user, idParam(req));
    sendRepresentation(req, res, row, row.updated_at);
  })
);

router.put(
  '/districts/:id',
  ...national,
  ah(async (req, res) => {
    const id = idParam(req);
    assertIfMatch(req, await loadRow('district', id));
    const b = validateBody(req.body, DISTRICT_SCHEMA);
    await db.query('UPDATE district SET name = $1, updated_at = now() WHERE id = $2', [b.name, id]);
    const row = await loadRow('district', id);
    sendRepresentation(req, res, row, row.updated_at);
  })
);

router.delete(
  '/districts/:id',
  ...national,
  ah(async (req, res) => {
    const id = idParam(req);
    assertIfMatch(req, await loadRow('district', id));
    await db.query('DELETE FROM district WHERE id = $1', [id]);
    res.status(204).end();
  })
);

// ---------------------------------------------------------------- grid substations (scoped under a district)

router.get(
  '/districts/:id/substations',
  requireUser,
  ah(async (req, res) => {
    const district = await loadVisible('district', req.user, idParam(req));
    const { page, limit, offset } = parsePagination(req.query);
    const sort = parseSort(req.query, { id: 'gs.id', name: 'gs.name', capacity_mva: 'gs.capacity_mva' }, 'id');
    const { rows, total } = await pagedQuery({
      select: 'gs.id, gs.name, gs.capacity_mva, gs.district_id, d.province_id, gs.created_at, gs.updated_at',
      from: 'grid_substation gs JOIN district d ON d.id = gs.district_id',
      where: 'gs.district_id = $1',
      params: [district.id],
      order: `${sort.sql}, gs.id`,
      limit,
      offset,
    });
    sendRepresentation(req, res, paginate(req, { rows, total, page, limit }));
  })
);

router.post(
  '/districts/:id/substations',
  ...national,
  ah(async (req, res) => {
    const district = await loadRow('district', idParam(req));
    const b = validateBody(req.body, SUBSTATION_SCHEMA);
    const { rows } = await db.query(
      'INSERT INTO grid_substation (district_id, name, capacity_mva) VALUES ($1, $2, $3) RETURNING id',
      [district.id, b.name, b.capacity_mva]
    );
    created(req, res, `/substations/${rows[0].id}`, await loadRow('substation', rows[0].id));
  })
);

router.get(
  '/substations/:id',
  requireUser,
  ah(async (req, res) => {
    const row = await loadVisible('substation', req.user, idParam(req));
    sendRepresentation(req, res, row, row.updated_at);
  })
);

router.put(
  '/substations/:id',
  ...national,
  ah(async (req, res) => {
    const id = idParam(req);
    assertIfMatch(req, await loadRow('substation', id));
    const b = validateBody(req.body, SUBSTATION_SCHEMA);
    await db.query('UPDATE grid_substation SET name = $1, capacity_mva = $2, updated_at = now() WHERE id = $3', [b.name, b.capacity_mva, id]);
    const row = await loadRow('substation', id);
    sendRepresentation(req, res, row, row.updated_at);
  })
);

router.delete(
  '/substations/:id',
  ...national,
  ah(async (req, res) => {
    const id = idParam(req);
    assertIfMatch(req, await loadRow('substation', id));
    await db.query('DELETE FROM grid_substation WHERE id = $1', [id]);
    res.status(204).end();
  })
);

module.exports = router;
