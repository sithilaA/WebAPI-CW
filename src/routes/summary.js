// Processing-style (derived) resource: aggregate generation for one district.
const router = require('express').Router();
const db = require('../db');
const { ah, idParam, sendRepresentation } = require('../http');
const { requireUser } = require('../auth');
const { loadVisible } = require('../repo');
const { colomboDayStart } = require('../time');

const REPORTING_WINDOW_MS = 30 * 60 * 1000;
const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

// GET /districts/:id/generation-summary
//  as_of               newest reading timestamp in the district (the "now" of the data)
//  current_power_kw    sum of the latest power of installations that reported within 30 min of as_of
//  today_energy_kwh    energy generated since 00:00 Asia/Colombo on the day of as_of
router.get(
  '/districts/:id/generation-summary',
  requireUser,
  ah(async (req, res) => {
    const district = await loadVisible('district', req.user, idParam(req));

    // Latest reading per installation (LATERAL + index = one cheap lookup each).
    const { rows: sites } = await db.query(
      `SELECT si.id, si.capacity_kw, l.ts, l.power_kw
       FROM solar_installation si
       JOIN grid_substation gs ON gs.id = si.substation_id
       LEFT JOIN LATERAL (
         SELECT r.ts, r.power_kw FROM generation_reading r
         WHERE r.installation_id = si.id ORDER BY r.ts DESC LIMIT 1
       ) l ON TRUE
       WHERE gs.district_id = $1`,
      [district.id]
    );

    const timestamps = sites.filter((s) => s.ts).map((s) => s.ts.getTime());
    const asOf = timestamps.length ? new Date(Math.max(...timestamps)) : null;
    const reporting = asOf ? sites.filter((s) => s.ts && asOf - s.ts <= REPORTING_WINDOW_MS) : [];
    const currentPower = reporting.reduce((sum, s) => sum + s.power_kw, 0);
    const capacity = sites.reduce((sum, s) => sum + s.capacity_kw, 0);

    let todayEnergy = 0;
    if (asOf) {
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(per_site.kwh), 0) AS kwh FROM (
           SELECT MAX(r.energy_kwh) - MIN(r.energy_kwh) AS kwh
           FROM generation_reading r
           JOIN solar_installation si ON si.id = r.installation_id
           JOIN grid_substation gs ON gs.id = si.substation_id
           WHERE gs.district_id = $1 AND r.ts >= $2 AND r.ts <= $3
           GROUP BY r.installation_id
         ) per_site`,
        [district.id, colomboDayStart(asOf).toISOString(), asOf.toISOString()]
      );
      todayEnergy = rows[0].kwh;
    }

    sendRepresentation(req, res, {
      district: { id: district.id, name: district.name, province_id: district.province_id },
      as_of: asOf,
      timezone: 'Asia/Colombo',
      installations_total: sites.length,
      installations_reporting: reporting.length,
      installed_capacity_kw: round(capacity, 2),
      current_power_kw: round(currentPower, 3),
      capacity_utilisation_pct: capacity > 0 ? round((currentPower / capacity) * 100, 1) : 0,
      today_energy_kwh: round(todayEnergy, 3),
    });
  })
);

module.exports = router;
