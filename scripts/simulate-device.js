// Simulates metering devices pushing live readings, to demonstrate the write path.
//   node scripts/simulate-device.js --base http://localhost:3000 --count 5 --interval 10
// Reads seed-output/device-keys.json (written by `npm run seed`). Each tick, every simulated
// device POSTs one reading for its own installation using its own API key.
const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const base = args.base || 'http://localhost:3000';
const count = Number(args.count) || 5;
const intervalSec = Number(args.interval) || 10;

const keys = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed-output', 'device-keys.json'), 'utf8')).slice(0, count);
const state = new Map(keys.map((k) => [k.installation_id, { energy: k.last_energy_kwh, last: new Date(k.last_timestamp) }]));

function sunFactor(date) {
  const hour = ((date.getTime() + 5.5 * 3600e3) % 86400e3) / 3600e3; // Colombo local hour
  return hour > 6 && hour < 18 ? Math.sin((Math.PI * (hour - 6)) / 12) ** 1.3 : 0;
}

async function tick() {
  const now = new Date();
  now.setMilliseconds(0);
  for (const k of keys) {
    const s = state.get(k.installation_id);
    if (now <= s.last) continue; // never send a timestamp older than the last one
    const power = Math.round(5 * 0.85 * sunFactor(now) * (0.8 + 0.4 * Math.random()) * 1000) / 1000;
    s.energy = Math.round((s.energy + (power * (now - s.last)) / 3600e3) * 1000) / 1000;
    s.last = now;
    const res = await fetch(`${base}/installations/${k.installation_id}/readings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${k.api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timestamp: now.toISOString(), power_kw: power, energy_kwh: s.energy, voltage: 230 }),
    });
    console.log(`${now.toISOString()} installation ${k.installation_id} -> ${res.status} ${res.headers.get('location') || ''}`);
  }
}

console.log(`Simulating ${keys.length} devices against ${base} every ${intervalSec}s (Ctrl+C to stop)`);
tick();
setInterval(tick, intervalSec * 1000);
