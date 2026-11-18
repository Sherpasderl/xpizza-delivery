'use strict';
// PLAN-directory-endpoint-r0 (advisor GO 11-13) — getRestaurantDirectory: the capp's public directory. The handler index.js exports is
// directory-endpoint.makeDirectoryEndpoint({ getDatabase, restaurantRegistry }) over the REAL makeDirectoryDeps + the REAL pricing view
// (the quote's loadPricing read) + the REAL handleDirectory, driven here over an RTDB fake. Run: node directory/directory-endpoint.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RR = require('../catalog/restaurant-registry');
const { makeDirectoryEndpoint } = require('./directory-endpoint');
let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const H7 = Object.fromEntries(DAYS.map((d) => [d, { open: true, start: '11:00', end: '21:30' }]));
const IDENT = (name, active) => ({ name, display_name: name, location_name: 'Centro', address_line: 'Blvd. Sur 12', hub_lat: 14.1, hub_lng: -87.2, active, phone: '+50400000000', whatsapp_instance: 'inst_test', brand_id: 'tb_brand', hours: H7, version: 1, delivery_radius_km: 6 });   // the shape restaurant-config accepts (directory.test.js IDENT)
const PRICING = { policy_version: 2, bands: [{ max_km: 3, cents: 3000 }, { max_km: 6, cents: 4500 }], restaurants: { app: { active: true, free_delivery: true }, tb_on: { active: true, free_delivery: true } } };
function world({ presentationDown = false } = {}) {
  const data = { 'restaurants/tb_on/identity': IDENT('On', true), 'restaurants/tb_off/identity': IDENT('Off', false), 'platform_config/delivery_pricing': PRICING };
  const snap = (p) => { if (presentationDown && /\/presentation$/.test(p)) throw new Error('rtdb down'); const v = Object.prototype.hasOwnProperty.call(data, p) ? JSON.parse(JSON.stringify(data[p])) : null; return { val: () => v, exists: () => v !== null }; };
  const rtdb = { ref: (p) => ({ once: async () => snap(p), get: async () => snap(p) }) };
  const registry = RR.createRestaurantRegistry({ listIds: async () => ['tb_off', 'tb_on'], floor: [] });
  let dbCalls = 0;
  const handler = makeDirectoryEndpoint({ getDatabase: () => { dbCalls += 1; return rtdb; }, restaurantRegistry: () => registry });
  return { handler, dbCalls: () => dbCalls };
}
function res() {
  const r = { statusCode: null, headers: {}, body: null };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.end = (b) => { r.body = b === undefined ? null : b; return r; };
  return r;
}
const req = (method = 'GET', inm) => ({ method, get: (h) => (h === 'If-None-Match' ? inm : undefined) });
const call = async (w, rq) => { const r = res(); const l = console.warn; console.warn = () => {}; try { await w.handler(rq, r); } finally { console.warn = l; } return r; };

(async () => {
  await cell('DE-ACTIVE-ONLY: only a registered AND active restaurant is listed (enforced on the server); its promo is the quote\'s read (free delivery forced off, basis pricing)', async (L) => {
    const r = await call(world(), req());
    assert.strictEqual(r.statusCode, 200, L);
    const b = JSON.parse(r.body);
    assert.deepStrictEqual(b.restaurants.map((e) => e.restaurant_id), ['tb_on'], `${L}: tb_off (inactive) is never listed`);
    assert.deepStrictEqual(b.restaurants[0].promo, { free_delivery: false, label: null, basis: 'pricing' }, `${L}: promo`);
    assert.deepStrictEqual(b.restaurants[0].fee, { state: 'priced', from_cents: 3000 }, `${L}: fee`);
  });
  await cell('DE-ETAG-304: a complete body carries an ETag + public max-age=30 + Vary: Origin; the same validator ⇒ 304', async (L) => {
    const w = world(); const r1 = await call(w, req());
    assert.strictEqual(JSON.parse(r1.body).complete, true, `${L}: premise complete`);
    assert.ok(r1.headers.ETag, `${L}: ETag`);
    assert.deepStrictEqual([r1.headers['Cache-Control'], r1.headers.Vary], ['public, max-age=30', 'Origin'], L);
    const r2 = await call(w, req('GET', r1.headers.ETag));
    assert.strictEqual(r2.statusCode, 304, `${L}: 304`);
  });
  await cell('DE-PARTIAL-NO-STORE: a degraded build (presentation unreadable) ⇒ 200 complete:false, no-store, NO ETag, and never 304 on an old validator', async (L) => {
    const ok = world(); const etag = (await call(ok, req())).headers.ETag;
    const w = world({ presentationDown: true });
    const r = await call(w, req('GET', etag));
    assert.strictEqual(r.statusCode, 200, `${L}: never 304`);
    assert.strictEqual(JSON.parse(r.body).complete, false, `${L}: partial`);
    assert.deepStrictEqual([r.headers['Cache-Control'], r.headers.ETag], ['no-store', undefined], `${L}: never cached`);
  });
  await cell('DE-METHOD: anything but GET ⇒ 405, no-store', async (L) => {
    const r = await call(world(), req('POST'));
    assert.deepStrictEqual([r.statusCode, r.headers['Cache-Control']], [405, 'no-store'], L);
  });
  await cell('DE-DEPS-ONCE: the deps (and the database handle) are built once per instance, lazily', async (L) => {
    const w = world(); assert.strictEqual(w.dbCalls(), 0, `${L}: nothing at construction`);
    await call(w, req()); await call(w, req());
    assert.strictEqual(w.dbCalls(), 2, `${L}: one handle for the deps + one for the pricing view, once`);
  });
  await cell('DE-EXPORT: index.js exports getRestaurantDirectory exactly as planned (public CORS list, minInstances 0) over makeDirectoryEndpoint', (L) => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const lines = src.split('\n').filter((l) => l.startsWith('exports.getRestaurantDirectory'));
    assert.strictEqual(lines.length, 1, `${L}: one export`);
    assert.ok(lines[0].startsWith("exports.getRestaurantDirectory = onRequest({ region: 'us-central1', cors: PUBLIC_MENU_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10, minInstances: 0 }, require('./directory/directory-endpoint').makeDirectoryEndpoint({ getDatabase, restaurantRegistry }));"), `${L}: ${lines[0]}`);
    assert.ok(src.indexOf(lines[0]) > src.indexOf('const { PUBLIC_MENU_ORIGINS }'), `${L}: after PUBLIC_MENU_ORIGINS is defined`);
  });
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`directory-endpoint: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
