// Jurisdiction scoping for the read path.
//   national   : everything
//   provincial : resources inside their province
//   district   : resources inside their district (and the province record above it)
// Lists are filtered inside the SQL query (out-of-scope rows are never fetched or counted).
// Single resources are loaded first (404 if missing) and then checked (403 if out of scope).
const db = require('./db');
const { forbidden, badRequest } = require('./errors');
const { intQuery } = require('./http');

// Can the user see a resource that lives in the given district/province?
function inScope(user, ref) {
  if (user.role === 'national') return true;
  if (user.role === 'provincial') return ref.province_id === user.province_id;
  return ref.district_id === user.district_id;
}

function assertInScope(user, ref) {
  if (!inScope(user, ref)) throw forbidden('This resource is outside your jurisdiction');
}

// Province records are visible to provincial users and to the district users inside them.
function assertProvinceVisible(user, provinceId) {
  if (user.role !== 'national' && user.province_id !== provinceId) {
    throw forbidden('This resource is outside your jurisdiction');
  }
}

// SQL condition limiting rows to the user's jurisdiction. `cols` names the SQL columns that
// hold the province id and the district id for the rows being listed.
function scopeSql(user, params, cols) {
  if (user.role === 'national') return 'TRUE';
  if (user.role === 'provincial') {
    params.push(user.province_id);
    return `${cols.province} = $${params.length}`;
  }
  params.push(user.district_id);
  return `${cols.district} = $${params.length}`;
}

// ?province= &district= &substation= (and optionally &installation=) filters.
function parseHierarchyFilters(query, { installation = false } = {}) {
  const details = [];
  const f = {
    province: intQuery(query, 'province', details),
    district: intQuery(query, 'district', details),
    substation: intQuery(query, 'substation', details),
  };
  if (installation) f.installation = intQuery(query, 'installation', details);
  if (details.length) throw badRequest('Invalid filter parameters', details);
  return f;
}

// An explicit filter that points at another jurisdiction is rejected (403) instead of being
// silently ignored. Ids that do not exist simply produce an empty result.
async function assertFiltersInScope(user, f) {
  if (user.role === 'national') return;

  if (f.province !== undefined && f.province !== user.province_id) {
    throw forbidden('The province filter is outside your jurisdiction');
  }
  if (f.district !== undefined) {
    const { rows } = await db.query('SELECT id, province_id FROM district WHERE id = $1', [f.district]);
    if (rows[0] && !inScope(user, { district_id: rows[0].id, province_id: rows[0].province_id })) {
      throw forbidden('The district filter is outside your jurisdiction');
    }
  }
  if (f.substation !== undefined) {
    const { rows } = await db.query(
      `SELECT gs.district_id, d.province_id FROM grid_substation gs
       JOIN district d ON d.id = gs.district_id WHERE gs.id = $1`,
      [f.substation]
    );
    if (rows[0] && !inScope(user, rows[0])) {
      throw forbidden('The substation filter is outside your jurisdiction');
    }
  }
  if (f.installation !== undefined) {
    const { rows } = await db.query(
      `SELECT gs.district_id, d.province_id FROM solar_installation si
       JOIN grid_substation gs ON gs.id = si.substation_id
       JOIN district d ON d.id = gs.district_id WHERE si.id = $1`,
      [f.installation]
    );
    if (rows[0] && !inScope(user, rows[0])) {
      throw forbidden('The installation filter is outside your jurisdiction');
    }
  }
}

// Builds WHERE conditions for queries joined as: gs (grid_substation), d (district) [, si].
function filterConditions(f, params) {
  const conds = [];
  const add = (sql, value) => {
    params.push(value);
    conds.push(`${sql} = $${params.length}`);
  };
  if (f.province !== undefined) add('d.province_id', f.province);
  if (f.district !== undefined) add('d.id', f.district);
  if (f.substation !== undefined) add('gs.id', f.substation);
  if (f.installation !== undefined) add('si.id', f.installation);
  return conds;
}

module.exports = {
  inScope,
  assertInScope,
  assertProvinceVisible,
  scopeSql,
  parseHierarchyFilters,
  assertFiltersInScope,
  filterConditions,
};
