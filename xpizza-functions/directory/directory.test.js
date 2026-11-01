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
    assert.strictEqual(r.body.complete, false, 'DIR-PRESENTATION-FAIL-PARTIAL'); assert.deepStrictEqual(r.body.restaurants[0].degraded, [...PS.SERVED_FIELDS].sort()); assert.strictEqual(r.body.restaurants[0].kicker, null); }
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

  // ── 7. presentation shape + the writer, against a fake with REAL RTDB semantics (Codex directory r1 P2-2/3/5) ──
  {
    // RTDB storage semantics: null deletes; EMPTY arrays/objects vanish; map keys come back REORDERED (sorted); arrays keep order
    const norm = (v) => {
      if (v === null || v === undefined) return undefined;
      if (Array.isArray(v)) { const a = v.map(norm).filter((x) => x !== undefined); return a.length ? a : undefined; }
      if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) { const x = norm(v[k]); if (x !== undefined) o[k] = x; } return Object.keys(o).length ? o : undefined; }
      return v;
    };
    const mkRtdb = (init = {}) => { const store = {}; for (const [k, v] of Object.entries(init)) store[k] = norm(v);
      return { store, ref: (p) => ({ once: async () => ({ val: () => (store[p] === undefined ? null : JSON.parse(JSON.stringify(store[p]))) }),
        update: async (patch) => { const cur = { ...(store[p] || {}) }; for (const [k, v] of Object.entries(patch)) { const x = norm(v); if (x === undefined) delete cur[k]; else cur[k] = x; } store[p] = norm(cur); } }) }; };
    const { randomToken } = require('../catalog/identity-registry');
    const { catalogSnapshot } = require('../catalog/generate-form-bundle');
    const realIds = [randomToken(), randomToken(), catalogSnapshot('la_musa').items[0].display.id];   // x_pizza minted tokens + a la_musa grandfathered slug
    assert.ok(/^[0-9A-Z]{10}$/.test(realIds[0]) && realIds[2] === 'dimsum_01', 'premise: real canonical ids (minted uppercase + grandfathered slug)');
    assert.deepStrictEqual(PS.presentationErrors({ house: realIds }), [], 'PRES-HOUSE-CANONICAL-IDS');
    assert.deepStrictEqual(PS.pickPresentation({ house: realIds }).fields.house, realIds, 'PRES-HOUSE-CASE-PRESERVED');
    assert.deepStrictEqual(PS.presentationErrors(PRES), [], 'PRES-VALID');
    for (const [k, v] of [['eta_delivery_min', [45, 30]], ['payments', ['card']], ['order_id_prefix', 'tb'], ['logo_url', 'javascript:x'], ['meals', { 'BAD KEY': 'x' }], ['unit', ['one']], ['cuisines', []], ['meals', {}], ['house', ['a/b']], ['house_hidden', false]])
      assert.ok(PS.presentationErrors({ [k]: v }).length > 0, `PRES-REFUSES ${k} ${JSON.stringify(v)}`);
    assert.ok(PS.presentationErrors({ house: ['X'], house_hidden: true }).some((e) => /exclusive/.test(e)), 'PRES-HOUSE-EXCLUSIVE');
    assert.ok(PS.presentationErrors({ extra: 1 }).some((e) => /unknown field extra/.test(e)), 'PRES-UNKNOWN-FIELD');
    assert.throws(() => SEED.parseArgs(['--file', 'x.json']), /--project is required/, 'SEEDP-PROJECT-REQUIRED');
    const quiet = () => {};
    const db = mkRtdb({ 'restaurants/tb_a/presentation': { kicker: 'old' } });
    await SEED.run(db, { tb_a: { ...PRES, house: realIds } }, { apply: false, force: false }, quiet);
    assert.deepStrictEqual(db.store['restaurants/tb_a/presentation'], { kicker: 'old' }, 'SEEDP-DRY-RUN');
    const res1 = await SEED.run(db, { tb_a: { ...PRES, house: realIds, meals: { z_pizza: 'compartir', a_pasta: 'cena' } } }, { apply: true, force: false }, quiet);
    assert.ok(res1.tb_a.skipped.includes('kicker') && db.store['restaurants/tb_a/presentation'].kicker === 'old', 'SEEDP-NO-CLOBBER');
    assert.deepStrictEqual(Object.keys(db.store['restaurants/tb_a/presentation'].meals), ['a_pasta', 'z_pizza'], 'premise: RTDB reordered the map keys');
    ok('SEEDP-READBACK-STRUCTURAL: a reordered map (meals z/a) reads back as equal — no false mismatch');
    // explicit EMPTY house survives storage as house_hidden and is served as house:[] (distinct from absent)
    await SEED.run(db, { tb_a: { house: [] } }, { apply: true, force: true }, quiet);
    const st = db.store['restaurants/tb_a/presentation'];
    assert.strictEqual(st.house, undefined, 'SEEDP-HOUSE-EMPTY-CLEARS-LIST'); assert.strictEqual(st.house_hidden, true, 'SEEDP-HOUSE-HIDDEN-PERSISTED');
    assert.deepStrictEqual(PS.pickPresentation(st).fields.house, [], 'DIR-HOUSE-EXPLICIT-EMPTY-SERVED');
    assert.strictEqual(PS.pickPresentation({ kicker: 'x' }).fields.house, undefined, 'DIR-HOUSE-ABSENT-STAYS-ABSENT');
    const dirEmpty = await D.buildDirectory(mkDeps({ deps: { readPresentation: async () => st } }));
    assert.deepStrictEqual(dirEmpty.body.restaurants[0].house, [], 'DIR-HOUSE-HIDDEN-IN-BODY'); assert.ok(!dirEmpty.body.restaurants[0].degraded.includes('house'));
    assert.ok(!('house_hidden' in dirEmpty.body.restaurants[0]), 'DIR-HOUSE-HIDDEN-NOT-SERVED-RAW');
    await SEED.run(db, { tb_a: { house: realIds } }, { apply: true, force: true }, quiet);
    assert.deepStrictEqual([db.store['restaurants/tb_a/presentation'].house, db.store['restaurants/tb_a/presentation'].house_hidden], [realIds, undefined], 'SEEDP-HOUSE-LIST-CLEARS-HIDDEN');
    { const before = JSON.stringify(db.store['restaurants/tb_a/presentation']);
      const r = await SEED.run(db, { tb_a: { ...PRES, house: 'x' } }, { apply: true, force: true }, quiet);
      assert.ok(r.tb_a.rejected && r.tb_a.rejected.some((e) => /invalid house/.test(e)), `SEEDP-VALIDATES ${JSON.stringify(r)}`);
      assert.strictEqual(JSON.stringify(db.store['restaurants/tb_a/presentation']), before, 'SEEDP-VALIDATES rejected rid untouched'); }
    ok('presentation (real-RTDB fake): canonical dish ids (minted + grandfathered, case kept); house:[] persists as house_hidden and is served as []; absent ≠ empty; per-field no-clobber unless --force; dry-run writes nothing');
  }

  // ── 7b. Codex directory r2: explicit-empty taxonomy CLEARS; a rejection is per restaurant; --force repairs a house conflict ──
  {
    const norm = (v) => {
      if (v === null || v === undefined) return undefined;
      if (Array.isArray(v)) { const a = v.map(norm).filter((x) => x !== undefined); return a.length ? a : undefined; }
      if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) { const x = norm(v[k]); if (x !== undefined) o[k] = x; } return Object.keys(o).length ? o : undefined; }
      return v;
    };
    const mkRtdb = (init = {}) => { const store = {}; for (const [k, v] of Object.entries(init)) store[k] = norm(v);
      return { store, ref: (p) => ({ once: async () => ({ val: () => (store[p] === undefined ? null : JSON.parse(JSON.stringify(store[p]))) }),
        update: async (patch) => { const cur = { ...(store[p] || {}) }; for (const [k, v] of Object.entries(patch)) { const x = norm(v); if (x === undefined) delete cur[k]; else cur[k] = x; } store[p] = norm(cur); } }) }; };
    const P = (rid) => `restaurants/${rid}/presentation`;
    const lines = []; const log = (l) => lines.push(l);
    // P2-1: {} / [] clear an existing assignment (with --force); a rejected rid is reported and the REST of the batch still runs
    const db = mkRtdb({ [P('tb_a')]: { meals: { pizzas: 'compartir' }, cuisines: ['pizza'], kicker: 'k' }, [P('tb_c')]: { kicker: 'old' } });
    const r = await SEED.run(db, { tb_a: { meals: {}, cuisines: [] }, tb_bad: { house: 'x' }, tb_c: { kicker: 'new' }, 'BAD RID': { kicker: 'x' } }, { apply: true, force: true }, log);
    assert.deepStrictEqual(db.store[P('tb_a')], { kicker: 'k' }, `SEEDP-EMPTY-TAXONOMY-CLEARS ${JSON.stringify(db.store[P('tb_a')])}`);
    assert.deepStrictEqual([...r.tb_a.clear].sort(), ['cuisines', 'meals'], `SEEDP-CLEAR-REPORTED ${JSON.stringify(r.tb_a)}`);
    assert.ok(r.tb_bad && r.tb_bad.rejected && r.tb_bad.rejected.some((e) => /invalid house/.test(e)), `SEEDP-REJECT-PER-RID ${JSON.stringify(r.tb_bad)}`);
    assert.ok(r['BAD RID'] && r['BAD RID'].rejected, 'SEEDP-REJECT-PER-RID bad rid');
    assert.strictEqual(db.store[P('tb_bad')], undefined, 'SEEDP-REJECT-WRITES-NOTHING');
    assert.strictEqual(db.store[P('tb_c')].kicker, 'new', 'SEEDP-REJECT-DOES-NOT-ABORT-BATCH');
    assert.ok(lines.some((l) => /REJECTED/.test(l) && /tb_bad/.test(l)), `SEEDP-REJECT-LOGGED ${JSON.stringify(lines)}`);
    assert.strictEqual(SEED.exitCodeFor(r), 1, 'SEEDP-REJECT-EXIT-NONZERO');
    assert.strictEqual(SEED.exitCodeFor({ tb_c: r.tb_c }), 0, 'SEEDP-CLEAN-EXIT-ZERO');
    // clearing respects no-clobber: an existing assignment is only cleared with --force; clearing an absent field writes nothing
    const db2 = mkRtdb({ [P('tb_a')]: { meals: { pizzas: 'compartir' } } });
    const r2 = await SEED.run(db2, { tb_a: { meals: {}, cuisines: [] } }, { apply: true, force: false }, () => {});
    assert.deepStrictEqual([db2.store[P('tb_a')], r2.tb_a.clear, [...r2.tb_a.skipped].sort()], [{ meals: { pizzas: 'compartir' } }, [], ['cuisines', 'meals']], `SEEDP-CLEAR-NEEDS-FORCE ${JSON.stringify(r2)}`);
    // P2-2: a stored CONFLICT (house + house_hidden) is repaired by --force even when the requested value already matches
    for (const [want, expect, label] of [[[], { house_hidden: true }, 'SEEDP-FORCE-REPAIRS-CONFLICT-HIDDEN'], [['ABERVHPJ1C'], { house: ['ABERVHPJ1C'] }, 'SEEDP-FORCE-REPAIRS-CONFLICT-LIST']]) {
      const db3 = mkRtdb({ [P('tb_a')]: { house: ['ABERVHPJ1C'], house_hidden: true } });
      await SEED.run(db3, { tb_a: { house: want } }, { apply: true, force: true }, () => {});
      assert.deepStrictEqual(db3.store[P('tb_a')], expect, `${label} ${JSON.stringify(db3.store[P('tb_a')])}`);
      assert.deepStrictEqual(PS.pickPresentation(db3.store[P('tb_a')]).fields.house, want, `${label} served`);
    }
    ok('Codex r2: {}/[] taxonomy clears (with --force; absent = no-op); a rejected rid is reported, writes nothing, the batch continues, exit 1; --force repairs a house/house_hidden conflict');
  }

  // ── 8. P1 TARGET SAFETY: the RTDB destination is bound to the stated project; an inherited URL can never redirect it ──
  {
    const URL0 = 'https://xpizza-delivery-default-rtdb.firebaseio.com';
    assert.strictEqual(SEED.assertDatabaseTarget('xpizza-delivery', URL0, {}), URL0, 'SEEDP-TARGET-OK');
    assert.strictEqual(SEED.assertDatabaseTarget('xpizza-delivery', URL0, { FB_DATABASE_URL: `${URL0}/` }), URL0, 'SEEDP-TARGET-SAME-URL-OK');
    for (const [label, env] of [['FB_DATABASE_URL', { FB_DATABASE_URL: 'https://prod-other-default-rtdb.firebaseio.com' }], ['FIREBASE_DATABASE_URL', { FIREBASE_DATABASE_URL: 'https://x.firebaseio.com' }],
      ['FIREBASE_CONFIG url', { FIREBASE_CONFIG: JSON.stringify({ databaseURL: 'https://x.firebaseio.com' }) }], ['FIREBASE_CONFIG project', { FIREBASE_CONFIG: JSON.stringify({ projectId: 'other' }) }]])
      assert.throws(() => SEED.assertDatabaseTarget('xpizza-delivery', URL0, env), (e) => e.code === 'seed_presentation_refused', `SEEDP-TARGET-REFUSES ${label}`);
    assert.throws(() => SEED.assertDatabaseTarget('staging-proj', URL0, {}), /does not belong to project staging-proj/, 'SEEDP-TARGET-PROJECT-MISMATCH');
    // the REAL CLI: an inherited foreign FB_DATABASE_URL ⇒ a refusal banner, exit 2, ZERO connection attempts (tools/no-connect.js)
    const os = require('os'); const path = require('path'); const fsm = require('fs'); const { spawnSync } = require('child_process');
    const dir = fsm.mkdtempSync(path.join(os.tmpdir(), 'seedp-')); const file = path.join(dir, 'p.json'); fsm.writeFileSync(file, JSON.stringify({ tb_a: { kicker: 'x' } }));
    const env = { ...process.env, FB_DATABASE_URL: 'https://some-other-project-default-rtdb.firebaseio.com', GOOGLE_CLOUD_PROJECT: 'xpizza-delivery', NO_CONNECT_DIR: dir, HOME: os.tmpdir(),
      NODE_OPTIONS: `--require ${path.join(__dirname, '..', 'tools', 'no-connect.js')}` };
    for (const k of Object.keys(env)) if (/_EMULATOR_HOST|_EMULATOR_ADDRESS|FIREBASE_EMULATOR_HUB|FUNCTIONS_EMULATOR|FIREBASE_CONFIG/.test(k)) delete env[k];
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'seed-presentation.js'), '--project', 'xpizza-delivery', '--file', file, '--apply'], { encoding: 'utf8', env, timeout: 60000 });
    assert.strictEqual(r.status, 2, `SEEDP-CLI-REFUSES (exit ${r.status}) ${r.stderr.slice(-400)}`);
    assert.match(r.stderr, /^🔴 REFUSED — FB_DATABASE_URL=/m, 'SEEDP-CLI-BANNER');
    // tools/no-connect.js writes one .rec per process: START, any CONNECT/FETCH lines, then `EXIT <code> <connects> <spawns>`
    const recs = fsm.readdirSync(dir).filter((f) => f.endsWith('.rec')).map((f) => fsm.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean));
    assert.strictEqual(recs.length, 1, 'premise: the no-connect recorder observed the CLI process');
    assert.deepStrictEqual(recs[0].filter((l) => !/^(START|EXIT) /.test(l)), [], 'SEEDP-CLI-NO-CONNECT (no connect / fetch lines)');
    assert.ok(/^EXIT 2 0 0$/.test(recs[0][recs[0].length - 1]), `SEEDP-CLI-NO-CONNECT (EXIT 2, 0 connects, 0 spawns): ${recs[0].join(' | ')}`);
    ok('P1 target safety: the RTDB URL must belong to the stated project; FB_DATABASE_URL / FIREBASE_DATABASE_URL / FIREBASE_CONFIG naming another database REFUSE; the real CLI exits 2 with the banner and zero connection attempts');
  }

  // ── 9. P2-4 with the REAL makeDirectoryDeps + getIdentity: a CACHED INACTIVE store during an outage ⇒ partial, never 304 ──
  {
    const { makeDirectoryDeps } = require('./directory-deps');
    const rid = 'tb_cached_inactive_p24';
    let down = false;
    const ident = IDENT('Off', { active: false });
    const rtdb = { ref: (p) => ({ once: async () => {
      if (p === 'platform_config/customer_app') return { val: () => null, exists: () => false };
      if (p === `restaurants/${rid}/identity`) { if (down) throw new Error('rtdb down'); return { val: () => ident, exists: () => true }; }
      return { val: () => null, exists: () => false };
    } }) };
    const registry = RR.createRestaurantRegistry({ listIds: async () => [rid], floor: [] });
    const deps = makeDirectoryDeps({ rtdb, registry, pricingView: async () => ({ fee: { state: 'none' }, promo: null, coverage_km: null }) });
    const r1 = mkRes(); await D.handleDirectory(req(undefined), r1, deps);
    assert.strictEqual(r1.statusCode, 200); const etag = r1.headers.ETag; assert.ok(etag, 'premise: a complete, fresh build carries an ETag');
    assert.deepStrictEqual(JSON.parse(r1.body).restaurants, [], 'premise: the inactive store is omitted');
    down = true;   // the identity read now fails; getIdentity serves the warm (inactive) cache within its TTL
    const r2 = mkRes(); await D.handleDirectory(req(etag), r2, deps);
    assert.strictEqual(r2.statusCode, 200, 'DIR-CACHED-INACTIVE-NEVER-304');
    assert.strictEqual(r2.headers.ETag, undefined, 'DIR-CACHED-INACTIVE-NO-ETAG');
    assert.strictEqual(JSON.parse(r2.body).complete, false, 'DIR-CACHED-INACTIVE-PARTIAL');
    ok('P2-4 (real makeDirectoryDeps + getIdentity): a cached INACTIVE identity during an outage ⇒ complete:false, no ETag, never 304');
  }
  console.log(`\ndirectory: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
