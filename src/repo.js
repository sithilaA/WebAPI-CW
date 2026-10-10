// Loaders for single resources, shared by the route modules.
// loadRow       -> 404 when missing
// loadVisible   -> 404 when missing, 403 when outside the caller's jurisdiction
const db = require('./db');
const { notFound } = require('./errors');
const { assertInScope, assertProvinceVisible } = require('./scope');

// Common FROM chain for anything below a substation. Aliases: si, gs, d, p.
const INSTALLATION_FROM = `solar_installation si
  JOIN grid_substation gs ON gs.id = si.substation_id
  JOIN district d ON d.id = gs.district_id
  JOIN province p ON p.id = d.province_id`;

const INSTALLATION_COLUMNS = `si.id, si.name, si.owner_name, si.meter_id, si.capacity_kw,
  si.installed_on::text AS installed_on, si.substation_id, gs.district_id, d.province_id,
  si.created_at, si.updated_at`;

const ENTITIES = {
  province: {
    label: 'Province',
    sql: 'SELECT p.id, p.name, p.code, p.created_at, p.updated_at FROM province p WHERE p.id = $1',
    check: (user, row) => assertProvinceVisible(user, row.id),
  },
  district: {
    label: 'District',
    sql: 'SELECT d.id, d.name, d.province_id, d.created_at, d.updated_at FROM district d WHERE d.id = $1',
    check: (user, row) => assertInScope(user, { district_id: row.id, province_id: row.province_id }),
  },
  substation: {
    label: 'Grid substation',
    sql: `SELECT gs.id, gs.name, gs.capacity_mva, gs.district_id, d.province_id, gs.created_at, gs.updated_at
          FROM grid_substation gs JOIN district d ON d.id = gs.district_id WHERE gs.id = $1`,
    check: (user, row) => assertInScope(user, row),
  },
  installation: {
    label: 'Installation',
    // Extra name columns support the composite /overview resource.
    sql: `SELECT ${INSTALLATION_COLUMNS}, gs.name AS substation_name, d.name AS district_name,
                 p.name AS province_name
          FROM ${INSTALLATION_FROM} WHERE si.id = $1`,
    check: (user, row) => assertInScope(user, row),
  },
};

async function loadRow(kind, id) {
  const entity = ENTITIES[kind];
  const { rows } = await db.query(entity.sql, [id]);
  if (rows.length === 0) throw notFound(`${entity.label} ${id} not found`);
  return rows[0];
}

async function loadVisible(kind, user, id) {
  const row = await loadRow(kind, id);
  ENTITIES[kind].check(user, row);
  return row;
}

// Public representation of an installation (never exposes api_key_hash).
const installationRep = (r) => ({
  id: r.id,
  name: r.name,
  owner_name: r.owner_name,
  meter_id: r.meter_id,
  capacity_kw: r.capacity_kw,
  installed_on: r.installed_on,
  substation_id: r.substation_id,
  district_id: r.district_id,
  province_id: r.province_id,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

const READING_COLUMNS = `r.id, r.installation_id, r.ts AS timestamp, r.power_kw, r.energy_kwh,
  r.voltage, r.received_at`;

// Runs a paginated SELECT plus its COUNT with the same FROM/WHERE.
async function pagedQuery({ select, from, where, params, order, limit, offset }) {
  const count = await db.query(`SELECT COUNT(*)::int AS n FROM ${from} WHERE ${where}`, params);
  const withPaging = [...params, limit, offset];
  const { rows } = await db.query(
    `SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${order}
     LIMIT $${withPaging.length - 1} OFFSET $${withPaging.length}`,
    withPaging
  );
  return { rows, total: count.rows[0].n };
}

module.exports = {
  INSTALLATION_FROM,
  INSTALLATION_COLUMNS,
  READING_COLUMNS,
  loadRow,
  loadVisible,
  installationRep,
  pagedQuery,
};
