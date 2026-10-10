// End-to-end tests: boots the real app on a random port against an in-memory PGlite
// database seeded with a small dataset, and exercises the API over HTTP.
process.env.PGLITE_DIR = 'memory://';
process.env.JWT_SECRET = 'test-secret';
process.env.INGEST_RATE_LIMIT_PER_MIN = '1000';
process.env.LOGIN_RATE_LIMIT_PER_MIN = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { runSeed } = require('../src/seed');
const { createApp } = require('../src/app');

let server;
let base;
let seed;
const tokens = {};

async function call(method, path, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = h['Content-Type'] || 'application/json';
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}

const login = async (email) => {
  const r = await call('POST', '/auth/login', { body: { email, password: seed.password } });
  assert.equal(r.status, 200);
  return r.json.access_token;
};

function assertErrorShape(r, status, code) {
  assert.equal(r.status, status, r.text);
  assert.ok(r.json && r.json.error, 'error envelope present');
  assert.equal(r.json.error.status, status);
  if (code) assert.equal(r.json.error.code, code);
  assert.equal(typeof r.json.error.message, 'string');
  assert.ok(Array.isArray(r.json.error.details));
}

before(async () => {
  seed = await runSeed({ installations: 35, days: 2, log: () => {} });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.national = await login('national@slsea.test');
  tokens.western = await login('province.western@slsea.test');
  tokens.colombo = await login('district.colombo@slsea.test');
  tokens.kandy = await login('district.kandy@slsea.test');
});

after(async () => {
  server.close();
  await db.close();
});

const userByEmail = (email) => seed.users.find((u) => u.email === email);

// ------------------------------------------------------------------ authentication

test('login: wrong password -> 401 in the standard error shape', async () => {
  const r = await call('POST', '/auth/login', { body: { email: 'national@slsea.test', password: 'nope' } });
  assertErrorShape(r, 401, 'UNAUTHENTICATED');
});

test('login: missing fields -> 400 VALIDATION_ERROR with details', async () => {
  const r = await call('POST', '/auth/login', { body: {} });
  assertErrorShape(r, 400, 'VALIDATION_ERROR');
  assert.ok(r.json.error.details.length >= 2);
});

test('no token -> 401 with WWW-Authenticate', async () => {
  const r = await call('GET', '/provinces');
  assertErrorShape(r, 401, 'UNAUTHENTICATED');
  assert.equal(r.headers.get('www-authenticate'), 'Bearer');
});

test('garbage token -> 401', async () => {
  assertErrorShape(await call('GET', '/provinces', { token: 'abc.def.ghi' }), 401, 'UNAUTHENTICATED');
});

// ------------------------------------------------------------------ read path & jurisdiction scope

test('national user sees all 9 provinces and 25 districts', async () => {
  const p = await call('GET', '/provinces', { token: tokens.national });
  assert.equal(p.status, 200);
  assert.equal(p.json.pagination.total, 9);
  let districts = 0;
  for (const prov of p.json.data) {
    const d = await call('GET', `/provinces/${prov.id}/districts`, { token: tokens.national });
    districts += d.json.pagination.total;
  }
  assert.equal(districts, 25);
});

test('district user: sees only own province/district, 403 on another district', async () => {
  const colombo = userByEmail('district.colombo@slsea.test');
  const kandy = userByEmail('district.kandy@slsea.test');

  const provinces = await call('GET', '/provinces', { token: tokens.colombo });
  assert.equal(provinces.json.pagination.total, 1);

  const own = await call('GET', `/provinces/${colombo.province_id}/districts`, { token: tokens.colombo });
  assert.equal(own.json.pagination.total, 1);
  assert.equal(own.json.data[0].id, colombo.district_id);

  assert.equal((await call('GET', `/districts/${colombo.district_id}`, { token: tokens.colombo })).status, 200);
  assertErrorShape(await call('GET', `/districts/${kandy.district_id}`, { token: tokens.colombo }), 403, 'FORBIDDEN');
  assertErrorShape(await call('GET', `/districts/${kandy.district_id}/generation-summary`, { token: tokens.colombo }), 403);
  assertErrorShape(await call('GET', `/districts/${kandy.district_id}/substations`, { token: tokens.colombo }), 403);
});

test('provincial user: own province yes, another province no', async () => {
  const western = userByEmail('province.western@slsea.test');
  const kandy = userByEmail('district.kandy@slsea.test');
  assert.equal((await call('GET', `/provinces/${western.province_id}`, { token: tokens.western })).status, 200);
  assertErrorShape(await call('GET', `/provinces/${kandy.province_id}`, { token: tokens.western }), 403);
  assertErrorShape(await call('GET', `/districts/${kandy.district_id}`, { token: tokens.western }), 403);
});

test('installation lists are scoped in the query; foreign filters are 403', async () => {
  const colombo = userByEmail('district.colombo@slsea.test');
  const kandy = userByEmail('district.kandy@slsea.test');
  const list = await call('GET', '/installations?limit=500', { token: tokens.colombo });
  assert.equal(list.status, 200);
  assert.ok(list.json.pagination.total > 0);
  assert.ok(list.json.data.every((i) => i.district_id === colombo.district_id));

  assertErrorShape(await call('GET', `/installations?district=${kandy.district_id}`, { token: tokens.colombo }), 403);
  assertErrorShape(await call('GET', `/readings?district=${kandy.district_id}`, { token: tokens.colombo }), 403);

  const all = await call('GET', '/installations?limit=500', { token: tokens.national });
  assert.equal(all.json.pagination.total, 35);
});

test('single installation outside scope -> 403, unknown -> 404, bad id -> 400', async () => {
  const kandyInst = (await call('GET', `/installations?district=${userByEmail('district.kandy@slsea.test').district_id}`, { token: tokens.national })).json.data[0];
  assertErrorShape(await call('GET', `/installations/${kandyInst.id}`, { token: tokens.colombo }), 403);
  assertErrorShape(await call('GET', '/installations/999999', { token: tokens.national }), 404, 'RESOURCE_NOT_FOUND');
  assertErrorShape(await call('GET', '/installations/abc', { token: tokens.national }), 400);
});

test('composite overview and last-known reading', async () => {
  const inst = (await call('GET', '/installations', { token: tokens.national })).json.data[0];
  const ov = await call('GET', `/installations/${inst.id}/overview`, { token: tokens.national });
  assert.equal(ov.status, 200);
  assert.ok(ov.json.district.name && ov.json.province.name && ov.json.substation.name);
  assert.ok(ov.json.latest_reading);
  assert.equal(ov.json.reading_count, 192);

  const latest = await call('GET', `/installations/${inst.id}/readings/latest`, { token: tokens.national });
  assert.equal(latest.status, 200);
  assert.equal(latest.json.id, ov.json.latest_reading.id);
});

test('hierarchy fields never leak the device key hash', async () => {
  const inst = (await call('GET', '/installations', { token: tokens.national })).json.data[0];
  const r = await call('GET', `/installations/${inst.id}`, { token: tokens.national });
  assert.ok(!('api_key_hash' in r.json));
  assert.ok(!r.text.includes('api_key'));
});

// ------------------------------------------------------------------ history: pagination, filter, sort, conditional GET

test('readings history: pagination envelope, links and total', async () => {
  const inst = (await call('GET', '/installations', { token: tokens.national })).json.data[0];
  const p1 = await call('GET', `/installations/${inst.id}/readings?limit=50`, { token: tokens.national });
  assert.equal(p1.status, 200);
  assert.equal(p1.json.data.length, 50);
  assert.equal(p1.json.pagination.total, 192);
  assert.equal(p1.json.pagination.total_pages, 4);
  assert.equal(p1.json.links.prev, null);
  assert.ok(p1.json.links.next.includes('page=2'));
  assert.ok(p1.headers.get('link').includes('rel="next"'));

  const last = await call('GET', `/installations/${inst.id}/readings?limit=50&page=4`, { token: tokens.national });
  assert.equal(last.json.data.length, 42);
  assert.equal(last.json.links.next, null);
  assert.ok(last.json.links.prev.includes('page=3'));
});

test('readings history: sorting by timestamp asc / desc', async () => {
  const inst = (await call('GET', '/installations', { token: tokens.national })).json.data[0];
  const asc = (await call('GET', `/installations/${inst.id}/readings?sort=timestamp&limit=20`, { token: tokens.national })).json.data;
  const desc = (await call('GET', `/installations/${inst.id}/readings?sort=-timestamp&limit=20`, { token: tokens.national })).json.data;
  assert.ok(asc[0].timestamp < asc[19].timestamp);
  assert.ok(desc[0].timestamp > desc[19].timestamp);
  assertErrorShape(await call('GET', `/installations/${inst.id}/readings?sort=password`, { token: tokens.national }), 400);
});

test('readings history: time window filter', async () => {
  const inst = (await call('GET', '/installations', { token: tokens.national })).json.data[0];
  const newest = (await call('GET', `/installations/${inst.id}/readings?limit=1`, { token: tokens.national })).json.data[0];
  const to = new Date(newest.timestamp);
  const from = new Date(to.getTime() - 60 * 60 * 1000); // last hour inclusive -> 5 readings
  const r = await call('GET', `/installations/${inst.id}/readings?from=${from.toISOString()}&to=${to.toISOString()}`, { token: tokens.national });
  assert.equal(r.json.pagination.total, 5);
  assertErrorShape(await call('GET', `/installations/${inst.id}/readings?from=yesterday`, { token: tokens.national }), 400);
});

test('cross-installation history filters by district and scopes by role', async () => {
  const colombo = userByEmail('district.colombo@slsea.test');
  const r = await call('GET', `/readings?district=${colombo.district_id}&limit=10`, { token: tokens.national });
  assert.equal(r.status, 200);
  assert.ok(r.json.pagination.total > 0);
  const own = await call('GET', '/readings?limit=10', { token: tokens.colombo });
  assert.equal(own.json.pagination.total, r.json.pagination.total);
});

test('conditional GET: ETag then 304 with empty body', async () => {
  const inst = (await call('GET', '/installations', { token: tokens.national })).json.data[0];
  const first = await call('GET', `/installations/${inst.id}`, { token: tokens.national });
  const etag = first.headers.get('etag');
  assert.ok(etag);
  assert.ok(first.headers.get('last-modified'));

  const again = await call('GET', `/installations/${inst.id}`, { token: tokens.national, headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.text, '');

  const stale = await call('GET', `/installations/${inst.id}`, { token: tokens.national, headers: { 'If-None-Match': '"other"' } });
  assert.equal(stale.status, 200);

  const ims = await call('GET', `/installations/${inst.id}`, {
    token: tokens.national,
    headers: { 'If-Modified-Since': first.headers.get('last-modified') },
  });
  assert.equal(ims.status, 304);

  const list = await call('GET', `/installations/${inst.id}/readings`, { token: tokens.national });
  const list304 = await call('GET', `/installations/${inst.id}/readings`, { token: tokens.national, headers: { 'If-None-Match': list.headers.get('etag') } });
  assert.equal(list304.status, 304);
});

// ------------------------------------------------------------------ write path: the device

test('device ingest: 201 + Location, then GET the created reading', async () => {
  const key = seed.keys[0];
  const ts = new Date().toISOString();
  const r = await call('POST', `/installations/${key.installation_id}/readings`, {
    token: key.api_key,
    body: { timestamp: ts, power_kw: 2.5, energy_kwh: key.last_energy_kwh + 1, voltage: 231.2 },
  });
  assert.equal(r.status, 201, r.text);
  assert.ok(r.headers.get('location').endsWith(`/installations/${key.installation_id}/readings/${r.json.id}`));
  assert.ok(r.headers.get('etag'));
  assert.equal(r.json.installation_id, key.installation_id);

  const fetched = await call('GET', new URL(r.headers.get('location')).pathname, { token: tokens.national });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get('etag'), r.headers.get('etag'));

  const latest = await call('GET', `/installations/${key.installation_id}/readings/latest`, { token: tokens.national });
  assert.equal(latest.json.id, r.json.id);
});

test('device ingest: duplicate timestamp -> 409 DUPLICATE_READING', async () => {
  const key = seed.keys[1];
  const body = { timestamp: new Date().toISOString(), power_kw: 1, energy_kwh: key.last_energy_kwh + 1, voltage: 230 };
  assert.equal((await call('POST', `/installations/${key.installation_id}/readings`, { token: key.api_key, body })).status, 201);
  assertErrorShape(await call('POST', `/installations/${key.installation_id}/readings`, { token: key.api_key, body }), 409, 'DUPLICATE_READING');
});

test('device ingest: key for another installation -> 403, no key -> 401, bad key -> 401', async () => {
  const a = seed.keys[2];
  const b = seed.keys[3];
  const body = { timestamp: new Date().toISOString(), power_kw: 1, energy_kwh: 10, voltage: 230 };
  assertErrorShape(await call('POST', `/installations/${b.installation_id}/readings`, { token: a.api_key, body }), 403, 'FORBIDDEN');
  assertErrorShape(await call('POST', `/installations/${a.installation_id}/readings`, { body }), 401);
  assertErrorShape(await call('POST', `/installations/${a.installation_id}/readings`, { token: 'slsea_dev_wrong', body }), 401);
});

test('write/read split: a user (even national) cannot ingest; a device cannot read', async () => {
  const key = seed.keys[4];
  const body = { timestamp: new Date().toISOString(), power_kw: 1, energy_kwh: 10, voltage: 230 };
  assertErrorShape(await call('POST', `/installations/${key.installation_id}/readings`, { token: tokens.national, body }), 403);
  assertErrorShape(await call('GET', `/installations/${key.installation_id}/readings`, { token: key.api_key }), 403);
  assertErrorShape(await call('GET', '/provinces', { token: key.api_key }), 403);
  assertErrorShape(await call('PUT', `/installations/${key.installation_id}`, { token: key.api_key, body: {} }), 403);
});

test('device ingest: validation errors -> 400 with details; malformed JSON; wrong media type', async () => {
  const key = seed.keys[5];
  const path = `/installations/${key.installation_id}/readings`;
  const bad = await call('POST', path, { token: key.api_key, body: { timestamp: 'nope', power_kw: -1, voltage: 'x', extra: 1 } });
  assertErrorShape(bad, 400, 'VALIDATION_ERROR');
  const fields = bad.json.error.details.map((d) => d.field);
  for (const f of ['timestamp', 'power_kw', 'energy_kwh', 'voltage', 'extra']) assert.ok(fields.includes(f), f);

  const future = await call('POST', path, {
    token: key.api_key,
    body: { timestamp: new Date(Date.now() + 3600e3).toISOString(), power_kw: 1, energy_kwh: 10, voltage: 230 },
  });
  assertErrorShape(future, 400, 'VALIDATION_ERROR');

  assertErrorShape(await call('POST', path, { token: key.api_key, body: '{bad json', raw: true }), 400, 'MALFORMED_JSON');
  assertErrorShape(
    await call('POST', path, { token: key.api_key, body: 'x=1', raw: true, headers: { 'Content-Type': 'text/plain' } }),
    415, 'UNSUPPORTED_MEDIA_TYPE'
  );
});

test('readings are append-only: PUT / PATCH / DELETE -> 405 with Allow', async () => {
  const inst = (await call('GET', '/installations', { token: tokens.national })).json.data[0];
  const reading = (await call('GET', `/installations/${inst.id}/readings?limit=1`, { token: tokens.national })).json.data[0];
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const r = await call(method, `/installations/${inst.id}/readings/${reading.id}`, { token: tokens.national, body: {} });
    assertErrorShape(r, 405, 'METHOD_NOT_ALLOWED');
    assert.ok(r.headers.get('allow').includes('GET'));
  }
});

// ------------------------------------------------------------------ errors & negotiation

test('unknown route -> 404 standard error; Accept: text/html -> 406', async () => {
  assertErrorShape(await call('GET', '/nope', { token: tokens.national }), 404, 'RESOURCE_NOT_FOUND');
  assertErrorShape(await call('GET', '/provinces', { token: tokens.national, headers: { Accept: 'text/html' } }), 406, 'NOT_ACCEPTABLE');
});

test('invalid pagination -> 400', async () => {
  assertErrorShape(await call('GET', '/provinces?limit=0', { token: tokens.national }), 400);
  assertErrorShape(await call('GET', '/provinces?page=abc', { token: tokens.national }), 400);
});

// ------------------------------------------------------------------ stretch: district summary

test('district generation summary', async () => {
  const colombo = userByEmail('district.colombo@slsea.test');
  const r = await call('GET', `/districts/${colombo.district_id}/generation-summary`, { token: tokens.colombo });
  assert.equal(r.status, 200);
  assert.ok(r.json.installations_total > 0);
  assert.ok(r.json.as_of);
  assert.equal(typeof r.json.current_power_kw, 'number');
  assert.ok(r.json.today_energy_kwh >= 0);
  assert.ok(r.headers.get('etag'));
});

// ------------------------------------------------------------------ writable resources (national only)

test('admin CRUD on the hierarchy: 201 + Location, PUT, If-Match 412, DELETE 204 then 404', async () => {
  assertErrorShape(await call('POST', '/provinces', { token: tokens.western, body: { name: 'X', code: 'XX' } }), 403);

  const created = await call('POST', '/provinces', { token: tokens.national, body: { name: 'Test Province', code: 'TP' } });
  assert.equal(created.status, 201);
  const path = new URL(created.headers.get('location')).pathname;

  const get = await call('GET', path, { token: tokens.national });
  const etag = get.headers.get('etag');

  const stale = await call('PUT', path, { token: tokens.national, body: { name: 'Renamed', code: 'TP' }, headers: { 'If-Match': '"stale"' } });
  assertErrorShape(stale, 412, 'PRECONDITION_FAILED');

  const put = await call('PUT', path, { token: tokens.national, body: { name: 'Renamed', code: 'TP' }, headers: { 'If-Match': etag } });
  assert.equal(put.status, 200);
  assert.equal(put.json.name, 'Renamed');
  // PUT is idempotent: repeating it yields the same state
  const putAgain = await call('PUT', path, { token: tokens.national, body: { name: 'Renamed', code: 'TP' } });
  assert.equal(putAgain.json.name, 'Renamed');

  const dup = await call('POST', '/provinces', { token: tokens.national, body: { name: 'Renamed', code: 'ZZ' } });
  assertErrorShape(dup, 409, 'CONFLICT');

  const district = await call('POST', `${path}/districts`, { token: tokens.national, body: { name: 'Test District' } });
  assert.equal(district.status, 201);
  assertErrorShape(await call('DELETE', path, { token: tokens.national }), 409, 'CONFLICT'); // still has a district

  assert.equal((await call('DELETE', new URL(district.headers.get('location')).pathname, { token: tokens.national })).status, 204);
  assert.equal((await call('DELETE', path, { token: tokens.national })).status, 204);
  assertErrorShape(await call('DELETE', path, { token: tokens.national }), 404);
});

test('installation lifecycle: create (one-time key), key works, PATCH, rotate key, DELETE', async () => {
  const sub = (await call('GET', `/districts/${userByEmail('district.colombo@slsea.test').district_id}/substations`, { token: tokens.national })).json.data[0];
  const created = await call('POST', `/substations/${sub.id}/installations`, {
    token: tokens.national,
    body: { name: 'New Rooftop', owner_name: 'Test Owner', meter_id: 'SLM-TEST-1', capacity_kw: 6.5, installed_on: '2026-01-15' },
  });
  assert.equal(created.status, 201, created.text);
  const path = new URL(created.headers.get('location')).pathname;
  const key1 = created.json.device_api_key;
  assert.ok(key1.startsWith('slsea_dev_'));
  assert.equal((await call('GET', path, { token: tokens.national })).json.device_api_key, undefined);

  const body = { timestamp: new Date().toISOString(), power_kw: 1, energy_kwh: 5, voltage: 230 };
  assert.equal((await call('POST', `${path}/readings`, { token: key1, body })).status, 201);

  const patch = await call('PATCH', path, { token: tokens.national, body: { capacity_kw: 8 } });
  assert.equal(patch.status, 200);
  assert.equal(patch.json.capacity_kw, 8);
  assert.equal(patch.json.name, 'New Rooftop');
  assertErrorShape(await call('PATCH', path, { token: tokens.national, body: {} }), 400);

  const dupMeter = await call('POST', `/substations/${sub.id}/installations`, {
    token: tokens.national,
    body: { name: 'Other', owner_name: 'X', meter_id: 'SLM-TEST-1', capacity_kw: 3, installed_on: '2026-01-15' },
  });
  assertErrorShape(dupMeter, 409, 'CONFLICT');

  const rotated = await call('POST', `${path}/api-key`, { token: tokens.national });
  assert.equal(rotated.status, 200);
  const body2 = { ...body, timestamp: new Date(Date.now() + 1000).toISOString() };
  assertErrorShape(await call('POST', `${path}/readings`, { token: key1, body: body2 }), 401); // old key revoked
  assert.equal((await call('POST', `${path}/readings`, { token: rotated.json.device_api_key, body: body2 })).status, 201);

  assert.equal((await call('DELETE', path, { token: tokens.national })).status, 204);
  assertErrorShape(await call('GET', path, { token: tokens.national }), 404);
});
