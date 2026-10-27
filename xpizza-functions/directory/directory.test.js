'use strict';
// S7a-1 directory core — schema + allowlist, the dependency matrix, ETag rules, negative fields, the paired activity check,
// registry readNow, presentation shape + writer. Run: node directory/directory.test.js
const assert = require('assert');
const D = require('./directory');
const PS = require('./presentation-shape');
const PC = require('./platform-config');
const SEED = require('../tools/seed-presentation');
const PM = require('../catalog/public-menu');
const RR = require('../catalog/restaurant-registry');
const RC = require('../restaurant-config');
const SCHED = require('../scheduled-orders');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const H7 = Object.fromEntries(DAYS.map((d) => [d, d === 'mon' ? { open: false } : { open: true, start: '11:00', end: '21:30' }]));
const IDENT = (name, extra = {}) => ({ name, display_name: `${name} Display`, location_name: 'Centro', address_line: 'Blvd. Sur 12', hub_lat: 14.1, hub_lng: -87.2,
  active: true, phone: '+50400000000', whatsapp_instance: 'inst_SECRET', brand_id: 'tb_brand', factura_config: { cai: 'SECRET' }, hours: H7, version: 1, delivery_radius_km: 6, ...extra });
const PRES = { kicker: 'Hornos de leña', unit: ['pizza', 'pizzas'], cuisines: ['pizza', 'italiana'], logo_url: 'https://cdn.test/logo.png', logo_wide: false,
  hero_url: 'https://cdn.test/hero.jpg', asset_base: 'https://cdn.test/a', eta_delivery_min: [30, 45], eta_pickup_min: [15, 20], payments: ['online', 'cash'],
  pickup: true, order_id_prefix: 'TBA', house: ['ghost_dish_9', 'pz_01'], meals: { pizzas: 'compartir' } };
const PLATFORM_RAW = { city_label: 'Tegucigalpa', cuisines: [{ id: 'pizza', label: 'Pizza' }, { id: 'pizza', label: 'dup' }, { id: 'BAD ID', label: 'x' }], meals: { compartir: 'Para compartir' },
  social: { min_reorders: 3, min_ratings: 5 }, value: { median_up_to_cents: 25000 }, admin_secret: 'nope' };
const PRICING = { fee: { state: 'priced', from_cents: 3000 }, promo: { free_delivery: true, label: 'Envío gratis hoy' }, coverage_km: 5, bands: [{ max_km: 2, cents: 9000 }], policy_version: 'p7' };

function mkDeps(over = {}) {
  const idents = over.idents || { tb_a: IDENT('A'), tb_b: IDENT('B'), tb_off: IDENT('Off', { active: false }) };
  return {
    readRegistry: async () => ({ ok: true, ids: over.ids || ['tb_a', 'tb_off', 'tb_b'] }),
    readPlatform: async () => PC.pickPlatform(PLATFORM_RAW),
    activity: async (rid) => { const id = idents[rid]; if (over.activityThrows && over.activityThrows.includes(rid)) throw new Error('down'); return { active: !!(id && id.active), source: (over.cacheRids || []).includes(rid) ? 'cache' : 'fresh', identity: id }; },
    loadSchedule: async () => ({ valid: true, hours: H7, cfg: SCHED.resolveCfg(), source: 'fresh' }),
    readPresentation: async () => PRES,
    pricingView: async () => PRICING,
    ...over.deps,
  };
}
function mkRes() {
  const r = { statusCode: null, headers: {}, body: null, ended: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.end = (b) => { r.body = b === undefined ? null : b; r.ended = true; return r; };
  r.json = () => { throw new Error('res.json must not be used (Express would attach its own ETag)'); };
  return r;
}
const req = (inm, method = 'GET') => ({ method, get: (h) => (h.toLowerCase() === 'if-none-match' ? inm : undefined) });
const allKeys = (v, acc = new Set()) => { if (Array.isArray(v)) v.forEach((x) => allKeys(x, acc)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); allKeys(x, acc); } return acc; };

(async () => {
  // ── 1. complete build: ONE schema, allowlist, order, inactive absent ──
  const full = await D.buildDirectory(mkDeps());
  assert.strictEqual(full.status, 200);
  assert.deepStrictEqual(Object.keys(full.body), D.BODY_FIELDS, 'DIR-BODY-SCHEMA');
  assert.strictEqual(full.body.complete, true, 'DIR-COMPLETE');
  assert.deepStrictEqual(full.body.restaurants.map((r) => r.restaurant_id), ['tb_a', 'tb_b'], 'DIR-ORDER-AND-INACTIVE-ABSENT');
  for (const r of full.body.restaurants) assert.deepStrictEqual(Object.keys(r), D.ENTRY_FIELDS, `DIR-ENTRY-SCHEMA ${r.restaurant_id}`);
  const a = full.body.restaurants[0];
  assert.strictEqual(a.name, 'A Display'); assert.strictEqual(a.branch, 'Centro'); assert.strictEqual(a.pickup_addr, 'Blvd. Sur 12');
  assert.deepStrictEqual(a.house, ['ghost_dish_9', 'pz_01'], 'DIR-HOUSE-UNFILTERED (no catalog dependency)');
  assert.deepStrictEqual(a.fee, { state: 'priced', from_cents: 3000 }); assert.deepStrictEqual(a.promo, { free_delivery: true, label: 'Envío gratis hoy' }); assert.strictEqual(a.coverage_km, 5);
  assert.strictEqual(a.schedule_state, 'ok'); assert.strictEqual(a.schedule.hours, H7); assert.deepStrictEqual(a.degraded, []);
  assert.deepStrictEqual(full.body.platform, { city_label: 'Tegucigalpa', cuisines: [{ id: 'pizza', label: 'Pizza' }], meals: { compartir: 'Para compartir' }, social: { min_reorders: 3, min_ratings: 5 }, value: { median_up_to_cents: 25000 } }, 'DIR-PLATFORM-ALLOWLIST');
  ok('complete: ONE body schema; every entry exactly the allowlist; registry order; inactive absent; house unfiltered; platform allowlisted');

  // ── 2. NEGATIVE fields: no raw identity, no admin pricing config, no unknown presentation key, nothing inactive ──
  {
    const deps = mkDeps({ deps: { readPresentation: async () => ({ ...PRES, secret_note: 'x', phone: '+504' }) } });
    const keys = allKeys((await D.buildDirectory(deps)).body);
    for (const k of ['phone', 'whatsapp_instance', 'brand_id', 'factura_config', 'cai', 'active', 'version', 'delivery_radius_km', 'bands', 'policy_version', 'secret_note', 'admin_secret', 'display_name', 'location_name', 'address_line'])
      assert.ok(!keys.has(k), `DIR-NEGATIVE-FIELD ${k}`);
    const txt = JSON.stringify((await D.buildDirectory(deps)).body);
    assert.ok(!txt.includes('SECRET') && !txt.includes('tb_off') && !txt.includes('Off Display'), 'DIR-NEGATIVE-VALUES (secrets / inactive entry)');
    ok('negative: no raw identity keys, no admin pricing config, no unknown presentation key, no inactive entry anywhere in the body');
  }

  // ── 3. dependency matrix ──
  assert.deepStrictEqual(await D.buildDirectory(mkDeps({ deps: { readRegistry: async () => ({ ok: false, error: 'x' }) } })), { status: 503 }, 'DIR-REGISTRY-FAIL-503');
  assert.deepStrictEqual(await D.buildDirectory(mkDeps({ deps: { readRegistry: async () => { throw new Error('x'); } } })), { status: 503 }, 'DIR-REGISTRY-THROW-503');
  assert.deepStrictEqual(await D.buildDirectory(mkDeps({ deps: { readPlatform: async () => { throw new Error('x'); } } })), { status: 503 }, 'DIR-PLATFORM-FAIL-503');
  { const r = await D.buildDirectory(mkDeps({ deps: { readPlatform: async () => null } })); assert.strictEqual(r.body.platform, null); assert.strictEqual(r.body.complete, true, 'DIR-PLATFORM-ABSENT-COMPLETE'); }
  { const r = await D.buildDirectory(mkDeps({ ids: [] })); assert.deepStrictEqual([r.body.restaurants, r.body.complete], [[], true], 'DIR-ZERO-STORES-COMPLETE'); }
  { const r = await D.buildDirectory(mkDeps({ activityThrows: ['tb_b'] })); assert.deepStrictEqual(r.body.unavailable, ['tb_b']); assert.strictEqual(r.body.complete, false, 'DIR-ACTIVITY-FAIL-PARTIAL'); assert.deepStrictEqual(r.body.restaurants.map((x) => x.restaurant_id), ['tb_a']); }
  { const r = await D.buildDirectory(mkDeps({ cacheRids: ['tb_a'] })); assert.strictEqual(r.body.complete, false, 'DIR-CACHE-ACTIVITY-PARTIAL'); }
  { const r = await D.buildDirectory(mkDeps({ deps: { loadSchedule: async () => ({ valid: false, hours: null, cfg: SCHED.resolveCfg(), source: 'fresh' }) } }));
    assert.deepStrictEqual([r.body.restaurants[0].schedule, r.body.restaurants[0].schedule_state, r.body.complete], [null, 'unavailable', true], 'DIR-SCHEDULE-INVALID-LISTED-COMPLETE'); }
  { const r = await D.buildDirectory(mkDeps({ deps: { loadSchedule: async () => { throw new Error('503'); } } })); assert.deepStrictEqual([r.body.restaurants[0].schedule_state, r.body.complete], ['unavailable', false], 'DIR-SCHEDULE-FAIL-PARTIAL'); }
  { const r = await D.buildDirectory(mkDeps({ deps: { loadSchedule: async () => ({ valid: true, hours: H7, cfg: SCHED.resolveCfg(), source: 'cache' }) } })); assert.strictEqual(r.body.complete, false, 'DIR-SCHEDULE-CACHE-PARTIAL'); }
  { const r = await D.buildDirectory(mkDeps({ deps: { readPresentation: async () => { throw new Error('x'); } } }));
    assert.strictEqual(r.body.complete, false, 'DIR-PRESENTATION-FAIL-PARTIAL'); assert.deepStrictEqual(r.body.restaurants[0].degraded, [...PS.FIELD_NAMES].sort()); assert.strictEqual(r.body.restaurants[0].kicker, null); }
  { const r = await D.buildDirectory(mkDeps({ deps: { readPresentation: async () => null } })); assert.strictEqual(r.body.complete, true, 'DIR-PRESENTATION-ABSENT-COMPLETE'); assert.ok(r.body.restaurants[0].degraded.includes('house')); }
  { const r = await D.buildDirectory(mkDeps({ deps: { readPresentation: async () => ({ ...PRES, hero_url: 'http://insecure', house: 'not-a-list' }) } }));
    assert.strictEqual(r.body.restaurants[0].hero_url, null, 'DIR-INVALID-FIELD-WITHHELD'); assert.ok(r.body.restaurants[0].degraded.includes('hero_url') && r.body.restaurants[0].degraded.includes('house')); }
  { const r = await D.buildDirectory(mkDeps({ deps: { pricingView: async () => { throw new Error('x'); } } }));
    assert.deepStrictEqual([r.body.restaurants[0].fee, r.body.restaurants[0].promo, r.body.restaurants[0].coverage_km, r.body.complete], [{ state: 'unavailable' }, null, null, false], 'DIR-PRICING-FAIL-PARTIAL'); }
  for (const [f, want] of [[{ state: 'none' }, { state: 'none' }], [{ state: 'invalid' }, { state: 'invalid' }], [{ state: 'priced', from_cents: -1 }, { state: 'invalid' }], [{ state: 'free' }, { state: 'invalid' }], [{ state: 'priced', from_cents: 0, bands: [1] }, { state: 'priced', from_cents: 0 }]]) {
    const r = await D.buildDirectory(mkDeps({ deps: { pricingView: async () => ({ fee: f, promo: null, coverage_km: null }) } }));
    assert.deepStrictEqual(r.body.restaurants[0].fee, want, `DIR-FEE-STATE ${JSON.stringify(f)}`);
  }
  ok('dependency matrix: registry/platform failure → 503; platform absent → null (complete); zero stores complete; activity failure → unavailable[] partial; cache source partial; schedule invalid listed+complete / failed or cached partial; presentation failed partial / absent complete / invalid field withheld; pricing failure → fee unavailable partial; fee states strict');

  // ── 4. HTTP: complete → ETag + max-age + 304; partial → no ETag, never 304; 503 / 405 → no-store ──
  {
    const res = mkRes(); await D.handleDirectory(req(undefined), res, mkDeps());
    assert.strictEqual(res.statusCode, 200); const etag = res.headers.ETag; assert.ok(/^"[0-9a-f]{64}"$/.test(etag), 'DIR-ETAG'); assert.strictEqual(res.headers['Cache-Control'], 'public, max-age=30');
    assert.deepStrictEqual(JSON.parse(res.body), full.body);
    const r304 = mkRes(); await D.handleDirectory(req(etag), r304, mkDeps()); assert.strictEqual(r304.statusCode, 304, 'DIR-304');
    const rW = mkRes(); await D.handleDirectory(req(`W/${etag}`), rW, mkDeps()); assert.strictEqual(rW.statusCode, 304, 'DIR-304-WEAK');
    // warm → partial → the SAME conditional request: 200 partial, no ETag, NEVER 304
    const rp = mkRes(); await D.handleDirectory(req(etag), rp, mkDeps({ cacheRids: ['tb_a'] }));
    assert.strictEqual(rp.statusCode, 200, 'DIR-PARTIAL-NEVER-304'); assert.strictEqual(rp.headers.ETag, undefined, 'DIR-PARTIAL-NO-ETAG'); assert.strictEqual(rp.headers['Cache-Control'], 'no-store');
    const r5 = mkRes(); await D.handleDirectory(req(etag), r5, mkDeps({ deps: { readRegistry: async () => ({ ok: false }) } }));
    assert.strictEqual(r5.statusCode, 503, 'DIR-503-NEVER-304'); assert.strictEqual(r5.headers.ETag, undefined); assert.deepStrictEqual(JSON.parse(r5.body), { ok: false, error: 'directory_unavailable', retryable: true });
    const rpost = mkRes(); await D.handleDirectory(req(undefined, 'POST'), rpost, mkDeps()); assert.strictEqual(rpost.statusCode, 405);
    // the ETag covers EVERY field: change one nested value → a new ETag
    const deps2 = mkDeps({ deps: { readPresentation: async () => ({ ...PRES, meals: { pizzas: 'desayuno' } }) } });
    const r2 = mkRes(); await D.handleDirectory(req(etag), r2, deps2); assert.strictEqual(r2.statusCode, 200, 'DIR-ETAG-COVERS-NESTED'); assert.notStrictEqual(r2.headers.ETag, etag);
    ok('HTTP: complete → strong ETag + public max-age=30 + 304 (strong/weak); partial or 503 with a matching If-None-Match → never 304, no ETag, no-store; 405; nested change moves the ETag');
  }

  // ── 5. PAIRED activity: activityWithSource ≡ defaultIsActive (same getIdentity, same predicate); source reported ──
  {
    for (const [label, mk] of [
      ['fresh-active', () => ({ fresh: IDENT('P'), fail: false })], ['fresh-inactive', () => ({ fresh: IDENT('P', { active: false }), fail: false })],
    ]) {
      const st = mk(); const rid = `tb_pair_${label}`;
      const db = { ref: () => ({ once: async () => { if (st.fail) throw new Error('down'); return { exists: () => true, val: () => st.fresh }; } }) };
      const old = await PM.defaultIsActive(db)(rid); const neu = await PM.activityWithSource(db)(rid);
      assert.strictEqual(neu.active, old, `DIR-PAIRED-ACTIVITY ${label}`); assert.strictEqual(neu.source, 'fresh');
    }
    // cache: a fresh read primes the cache, then a failure within TTL serves the cache — both functions agree; source 'cache'
    let fail = false; const rid = 'tb_pair_cache';
    const db = { ref: () => ({ once: async () => { if (fail) throw new Error('down'); return { exists: () => true, val: () => IDENT('C') }; } }) };
    await PM.defaultIsActive(db)(rid); fail = true;
    assert.strictEqual(await PM.defaultIsActive(db)(rid), true); const c = await PM.activityWithSource(db)(rid); assert.deepStrictEqual([c.active, c.source], [true, 'cache'], 'DIR-PAIRED-CACHE');
    // failure past TTL: both THROW
    const rid2 = 'tb_pair_cold'; const dbF = { ref: () => ({ once: async () => { throw new Error('down'); } }) };
    await assert.rejects(() => PM.defaultIsActive(dbF)(rid2)); await assert.rejects(() => PM.activityWithSource(dbF)(rid2), 'DIR-PAIRED-FAIL');
    ok('paired: activityWithSource agrees with defaultIsActive (fresh active/inactive, cache, failure) and reports the source');
  }

  // ── 6. registry readNow: non-swallowing, the same union as known(), floor kept on an empty read ──
  {
    let mode = 'ok';
    const reg = RR.createRestaurantRegistry({ listIds: async () => { if (mode === 'fail') throw new Error('fs down'); return mode === 'empty' ? [] : ['tb_x', ' bad id ', 'tb_y']; }, floor: ['x_pizza'] });
    const r1 = await reg.readNow(); assert.deepStrictEqual([r1.ok, r1.ids, r1.fresh], [true, ['x_pizza', 'tb_x', 'tb_y'], true], 'DIR-READNOW-UNION');
    assert.deepStrictEqual([...reg.known()], r1.ids, 'DIR-READNOW-EQUALS-KNOWN');
    mode = 'empty'; const r2 = await reg.readNow(); assert.deepStrictEqual(r2.ids, ['x_pizza', 'tb_x', 'tb_y'], 'DIR-READNOW-EMPTY-KEEPS-LAST-GOOD');
    mode = 'fail'; const r3 = await reg.readNow(); assert.strictEqual(r3.ok, false, 'DIR-READNOW-NOT-SWALLOWED');
    await reg.refresh(); assert.ok(reg.known().has('tb_x'), 'known/refresh unchanged: a failure still keeps last-good');
    const dirEmpty = await D.buildDirectory(mkDeps({ deps: { readRegistry: async () => ({ ok: true, ids: ['x_pizza'] }) }, idents: { x_pizza: IDENT('Floor') } }));
    assert.deepStrictEqual([dirEmpty.body.restaurants.map((x) => x.restaurant_id), dirEmpty.body.complete], [['x_pizza'], true], 'DIR-EMPTY-READ-FLOOR-LISTED');
    ok('registry readNow: floor ∪ last-good ∪ fresh (== known()); an empty read keeps last-good; a failure is ok:false (refresh still swallows)');
  }

  // ── 7. presentation shape + the writer (plan / dry-run / idempotent per field / --force / read-back) ──
  {
    assert.deepStrictEqual(PS.presentationErrors(PRES), [], 'PRES-VALID');
    for (const [k, v] of [['eta_delivery_min', [45, 30]], ['payments', ['card']], ['order_id_prefix', 'tb'], ['logo_url', 'javascript:x'], ['meals', { 'BAD KEY': 'x' }], ['unit', ['one']]])
      assert.ok(PS.presentationErrors({ [k]: v }).length > 0, `PRES-REFUSES ${k}`);
    assert.ok(PS.presentationErrors({ extra: 1 }).some((e) => /unknown field extra/.test(e)), 'PRES-UNKNOWN-FIELD');
    assert.throws(() => SEED.parseArgs(['--file', 'x.json']), /--project is required/, 'SEEDP-PROJECT-REQUIRED');
    const store = { 'restaurants/tb_a/presentation': { kicker: 'old' } }; const writes = [];
    const db = { ref: (p) => ({ once: async () => ({ val: () => store[p] || null }), update: async (v) => { writes.push([p, v]); store[p] = { ...(store[p] || {}), ...v }; } }) };
    const quiet = () => {};
    await SEED.run(db, { tb_a: PRES }, { apply: false, force: false }, quiet); assert.strictEqual(writes.length, 0, 'SEEDP-DRY-RUN');
    const res1 = await SEED.run(db, { tb_a: PRES }, { apply: true, force: false }, quiet);
    assert.ok(res1.tb_a.skipped.includes('kicker') && store['restaurants/tb_a/presentation'].kicker === 'old', 'SEEDP-NO-CLOBBER');
    await SEED.run(db, { tb_a: PRES }, { apply: true, force: true }, quiet); assert.strictEqual(store['restaurants/tb_a/presentation'].kicker, PRES.kicker, 'SEEDP-FORCE');
    assert.ok(writes.every(([p]) => p === 'restaurants/tb_a/presentation'), 'SEEDP-ONLY-PRESENTATION-NODE');
    await assert.rejects(() => SEED.run(db, { tb_a: { ...PRES, house: 'x' } }, { apply: true, force: true }, quiet), /presentation invalid house/, 'SEEDP-VALIDATES');
    ok('presentation: one shared shape (writer refuses unknown/invalid fields; reader withholds invalid); seed-presentation is dry-run by default, --project required, per-field no-clobber unless --force, writes only the presentation node');
  }
  console.log(`\ndirectory: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
