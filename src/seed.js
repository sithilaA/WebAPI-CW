// Seed data: 9 provinces, 25 districts, ~31 grid substations, 240 installations and
// 7 days of 15-minute readings per installation (~161k rows), plus one user per jurisdiction.
// Generation follows a realistic diurnal curve in Sri Lanka time (zero overnight).
//
//   npm run seed                      (embedded database)
//   DATABASE_URL=... npm run seed -- --yes   (hosted database; --yes confirms the reset)
//
// WARNING: seeding DROPS and recreates every table.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { ensureSchema } = require('./migrate');
const { generateDeviceKey } = require('./keys');
const { colomboHour, COLOMBO_OFFSET_MS } = require('./time');

const GEOGRAPHY = [
  { name: 'Western', code: 'WP', districts: ['Colombo', 'Gampaha', 'Kalutara'] },
  { name: 'Central', code: 'CP', districts: ['Kandy', 'Matale', 'Nuwara Eliya'] },
  { name: 'Southern', code: 'SP', districts: ['Galle', 'Matara', 'Hambantota'] },
  { name: 'Northern', code: 'NP', districts: ['Jaffna', 'Kilinochchi', 'Mannar', 'Vavuniya', 'Mullaitivu'] },
  { name: 'Eastern', code: 'EP', districts: ['Batticaloa', 'Ampara', 'Trincomalee'] },
  { name: 'North Western', code: 'NW', districts: ['Kurunegala', 'Puttalam'] },
  { name: 'North Central', code: 'NC', districts: ['Anuradhapura', 'Polonnaruwa'] },
  { name: 'Uva', code: 'UP', districts: ['Badulla', 'Monaragala'] },
  { name: 'Sabaragamuwa', code: 'SG', districts: ['Ratnapura', 'Kegalle'] },
];

// Busier districts get a second grid substation.
const EXTRA_SUBSTATIONS = ['Colombo', 'Colombo', 'Gampaha', 'Kandy', 'Galle', 'Kurunegala'];

const FIRST_NAMES = ['Nimal', 'Kamal', 'Sunil', 'Nadeesha', 'Ishara', 'Thilini', 'Ruwan', 'Chamara', 'Dilani', 'Priyantha',
  'Sathya', 'Arun', 'Kumar', 'Lakshmi', 'Mohamed', 'Fathima', 'Anushka', 'Pradeep', 'Samanthi', 'Roshan'];
const LAST_NAMES = ['Perera', 'Fernando', 'Silva', 'Jayasuriya', 'Wickramasinghe', 'Rajapaksha', 'Bandara', 'Gunawardena',
  'Senanayake', 'Kumaran', 'Nadarajah', 'Rahman', 'Dissanayake', 'Herath', 'Amarasinghe'];
const CAPACITIES_KW = [3, 3, 4, 5, 5, 5, 6, 8, 10, 10, 15, 25];

const INTERVAL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_ROWS = 700;

// Small deterministic PRNG so every seed run produces the same data shape.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

function generateReadings(inst, endMs, days, rng) {
  const steps = days * 96;
  const dayCloud = new Map();
  const rows = [];
  let energy = inst.startEnergy;
  for (let k = 0; k < steps; k += 1) {
    const ts = new Date(endMs - (steps - 1 - k) * INTERVAL_MS);
    const dayKey = Math.floor((ts.getTime() + COLOMBO_OFFSET_MS) / DAY_MS);
    if (!dayCloud.has(dayKey)) dayCloud.set(dayKey, 0.45 + 0.55 * rng()); // sunny vs overcast day
    const hour = colomboHour(ts);
    const sun = hour > 6 && hour < 18 ? Math.sin((Math.PI * (hour - 6)) / 12) ** 1.3 : 0;
    let cloud = dayCloud.get(dayKey) * (0.9 + 0.2 * rng());
    if (rng() < 0.04) cloud *= 0.4; // passing cloud
    const power = round(inst.capacity * 0.85 * sun * cloud, 3);
    energy = round(energy + power * 0.25, 3);
    const voltage = round(229 + 4 * sun + (rng() - 0.5) * 4, 1);
    rows.push([inst.id, ts.toISOString(), power, energy, voltage]);
  }
  return rows;
}

async function insertReadings(rows) {
  for (let i = 0; i < rows.length; i += BATCH_ROWS) {
    const chunk = rows.slice(i, i + BATCH_ROWS);
    const params = [];
    const tuples = chunk.map((r, j) => {
      params.push(...r);
      const o = j * 5;
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5})`;
    });
    await db.query(
      `INSERT INTO generation_reading (installation_id, ts, power_kw, energy_kwh, voltage) VALUES ${tuples.join(', ')}`,
      params
    );
  }
}

async function runSeed({ installations = 240, days = 7, password, log = console.log } = {}) {
  const rng = mulberry32(20260824);
  const userPassword = password || process.env.SEED_PASSWORD || crypto.randomBytes(9).toString('base64url');

  log('Resetting schema...');
  await db.exec(
    'DROP TABLE IF EXISTS generation_reading, app_user, solar_installation, grid_substation, district, province CASCADE'
  );
  await ensureSchema();

  log('Seeding geography...');
  const provinces = [];
  const districts = [];
  const substations = [];
  for (const p of GEOGRAPHY) {
    const pr = await db.query('INSERT INTO province (name, code) VALUES ($1, $2) RETURNING id', [p.name, p.code]);
    const province = { id: pr.rows[0].id, name: p.name };
    provinces.push(province);
    for (const dName of p.districts) {
      const dr = await db.query('INSERT INTO district (province_id, name) VALUES ($1, $2) RETURNING id', [province.id, dName]);
      const district = { id: dr.rows[0].id, name: dName, province };
      districts.push(district);
      const count = 1 + EXTRA_SUBSTATIONS.filter((n) => n === dName).length;
      for (let s = 1; s <= count; s += 1) {
        const name = `${dName} GSS-${s}`;
        const mva = [31.5, 63, 90, 120][Math.floor(rng() * 4)];
        const sr = await db.query(
          'INSERT INTO grid_substation (district_id, name, capacity_mva) VALUES ($1, $2, $3) RETURNING id',
          [district.id, name, mva]
        );
        substations.push({ id: sr.rows[0].id, name, district });
      }
    }
  }

  log(`Seeding ${installations} installations...`);
  const keys = [];
  const insts = [];
  for (let i = 0; i < installations; i += 1) {
    // Every substation gets at least one installation, the rest are spread randomly.
    const sub = i < substations.length ? substations[i] : substations[Math.floor(rng() * substations.length)];
    const capacity = CAPACITIES_KW[Math.floor(rng() * CAPACITIES_KW.length)];
    const owner = `${FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)]} ${LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)]}`;
    const meterId = `SLM-${String(100000 + i)}`;
    const installedOn = `${2019 + Math.floor(rng() * 7)}-${String(1 + Math.floor(rng() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rng() * 28)).padStart(2, '0')}`;
    const { key, hash } = generateDeviceKey();
    const r = await db.query(
      `INSERT INTO solar_installation (substation_id, name, owner_name, meter_id, capacity_kw, installed_on, api_key_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [sub.id, `${sub.district.name} Rooftop ${i + 1}`, owner, meterId, capacity, installedOn, hash]
    );
    const inst = { id: r.rows[0].id, capacity, meterId, startEnergy: round(500 + rng() * 7500, 3) };
    insts.push(inst);
    keys.push({ installation_id: inst.id, meter_id: meterId, api_key: key });
  }

  const endMs = Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS;
  log(`Seeding ${days} days of 15-minute readings per installation...`);
  let total = 0;
  for (const [idx, inst] of insts.entries()) {
    const rows = generateReadings(inst, endMs, days, rng);
    await insertReadings(rows);
    total += rows.length;
    const last = rows[rows.length - 1];
    keys[idx].last_timestamp = last[1];
    keys[idx].last_energy_kwh = last[3];
    if ((idx + 1) % 50 === 0) log(`  ${idx + 1}/${insts.length} installations`);
  }

  log('Seeding users...');
  const hash = await bcrypt.hash(userPassword, 10);
  const users = [];
  const addUser = async (name, email, role, provinceId, districtId) => {
    await db.query(
      'INSERT INTO app_user (name, email, password_hash, role, province_id, district_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [name, email, hash, role, provinceId, districtId]
    );
    users.push({ email, role, name, province_id: provinceId, district_id: districtId });
  };
  await addUser('SLSEA National Administrator', 'national@slsea.test', 'national', null, null);
  for (const p of provinces) {
    await addUser(`${p.name} Provincial Officer`, `province.${slug(p.name)}@slsea.test`, 'provincial', p.id, null);
  }
  for (const d of districts) {
    await addUser(`${d.name} District Officer`, `district.${slug(d.name)}@slsea.test`, 'district', d.province.id, d.id);
  }

  log(`Done: ${provinces.length} provinces, ${districts.length} districts, ${substations.length} substations, ` +
    `${insts.length} installations, ${total} readings, ${users.length} users.`);
  return { keys, users, password: userPassword, counts: { provinces: provinces.length, districts: districts.length, substations: substations.length, installations: insts.length, readings: total } };
}

module.exports = { runSeed };

if (require.main === module) {
  (async () => {
    const hosted = Boolean(process.env.DATABASE_URL);
    if (hosted && !process.argv.includes('--yes')) {
      console.error('DATABASE_URL is set: seeding will DROP and recreate all tables there.\nRe-run with --yes to confirm.');
      process.exit(1);
    }
    const result = await runSeed({
      installations: Number(process.env.SEED_INSTALLATIONS) || 240,
      days: Number(process.env.SEED_DAYS) || 7,
    });
    const outDir = path.join(__dirname, '..', 'seed-output');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'device-keys.json'), JSON.stringify(result.keys, null, 2));
    fs.writeFileSync(
      path.join(outDir, 'users.json'),
      JSON.stringify({ password_for_all_users: result.password, users: result.users }, null, 2)
    );
    console.log('Credentials written to seed-output/ (gitignored): device-keys.json, users.json');
    await db.close();
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
