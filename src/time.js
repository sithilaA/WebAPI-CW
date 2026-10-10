// Sri Lanka Standard Time is UTC+05:30 all year (no daylight saving), so "today" is
// computed with a fixed offset.
const COLOMBO_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Start (as a UTC instant) of the Colombo calendar day that contains `instant`.
function colomboDayStart(instant) {
  const local = instant.getTime() + COLOMBO_OFFSET_MS;
  return new Date(Math.floor(local / DAY_MS) * DAY_MS - COLOMBO_OFFSET_MS);
}

// Fractional local hour (0-24) in Colombo for an instant; used by the seed generator.
function colomboHour(instant) {
  const local = instant.getTime() + COLOMBO_OFFSET_MS;
  return (((local % DAY_MS) + DAY_MS) % DAY_MS) / (60 * 60 * 1000);
}

module.exports = { colomboDayStart, colomboHour, COLOMBO_OFFSET_MS };
