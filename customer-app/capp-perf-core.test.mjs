// Customer app — the perf-plan core pieces (PLAN-capp-S7a r3.3 + r3.4, PLAN-capp-S4 r5.3; APPROVED as a plan), DARK, against the
// REAL modules and the REAL served envelopes (the S0 rig's real publish). Light: no emulator.
//   r3.4-1  per-configuration last-seen price provenance in cart snapshots (data only — the notice UI waits on frame 13)
//   r3.3-F2 the MenuCache `presentation` state; menuFingerprint (canonical raw-envelope sha-256)
//   r3.3-F1 store-entry eligibility on its own 60 s clock
//   r3.3-F5 the auth `unresolved` state (never guest; `unavailable` after 10 s)
// Run: node --test customer-app/capp-perf-core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { adaptMenu } = require('./capp-menu.js');
const { createCart } = require('./capp-cart.js');
const { menuFingerprint } = require('./capp-checkout.js');
const { createMenuCache, PRESENT_MS, SKEW_MS, FRESH_MS } = require('./capp-menu-cache.js');
const { createEligibility, WINDOW_MS } = require('./capp-eligibility.js');
const { createAuthState, UNAVAILABLE_MS } = require('./capp-auth-state.js');
const { provisionBrand } = await import(join(ROOT, 'xpizza-functions/contract/capp/capture.mjs'));
const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const ENV = (await quiet(() => provisionBrand('x_pizza'))).envelope;
const clone = (x) => JSON.parse(JSON.stringify(x));
const ekey = (e) => (e && e.extra_id != null && e.extra_id !== '' ? String(e.extra_id) : String(e && e.id));
const dkey = (d) => (d && d.dish_id != null && d.dish_id !== '' ? String(d.dish_id) : String(d && d.id));
// a served envelope with ONE price changed, as a new publish would serve it
const withDishPrice = (env, key, p) => { const e = clone(env); e.menu.dishes.find((d) => dkey(d) === key).price = p; return e; };
const withExtraPrice = (env, key, p) => { const e = clone(env); e.menu.extras.find((x) => ekey(x) === key).price = p; return e; };
const M1 = adaptMenu(ENV);
const dish = M1.dishes.find((d) => !d.launcher && !d.variantOf && M1.extrasFor(d.key).filter((e) => e.supported).length >= 2);
const [E1, E2] = M1.extrasFor(dish.key).filter((e) => e.supported);
const other = M1.dishes.find((d) => !d.launcher && !d.variantOf && d.key !== dish.key);
const c = (l) => Math.round(l * 100);

// ── r3.4-1: last-seen price provenance per CONFIGURATION ──
test('r3.4-1: without { provenance: true } every snapshot is byte-identical to before (no `seen` anywhere)', () => {
  const k = createCart(M1); k.inc(dish.key); k.add(dish.key, [E1.key], 2);
  const snap = k.snapshot();
  assert.deepEqual(Object.keys(snap.lines[0]).sort(), ['added', 'ex', 'key', 'qty'], 'the v2 line shape, unchanged');
  assert.ok(!JSON.stringify(snap).includes('seen'));
});
test('r3.4-1: a provenance cart records, per instance, the dish and each selected extra in cents, from the menu it was built on', () => {
  const k = createCart(M1, { provenance: true }); k.inc(dish.key); k.add(dish.key, [E1.key], 1);
  assert.deepEqual(k.snapshot().lines[0].seen, [{ b: c(dish.price), x: {} }, { b: c(dish.price), x: { [E1.key]: c(E1.price) } }], 'the per-instance provenance, in cents');
  assert.deepEqual(k.priceChanges(), [], 'nothing changed against its own menu');
});
test('r3.4-1 (advisor case): plain + the same dish with an extra; the EXTRA changes ⇒ ONE change, only that group, its old subtotal', () => {
  const k = createCart(M1, { provenance: true }); k.inc(dish.key); k.add(dish.key, [E1.key], 2);
  const M2 = adaptMenu(withExtraPrice(ENV, E1.key, E1.price + 10));
  const r = createCart(M2, { provenance: true }); assert.deepEqual(r.hydrate(k.snapshot()), { dropped: 0 });
  const from = c(dish.price + E1.price), to = c(dish.price + E1.price + 10);
  assert.deepEqual(r.priceChanges().map((x) => ({ ...x })), [{ key: dish.key, sig: E1.key, name: dish.name, n: 2, fromCents: from, toCents: to, oldSubtotalCents: from * 2, newSubtotalCents: to * 2 }],
    '🔴 one line, the configured unit (dish + extra), the plain group untouched');
});
test('r3.4-1: a base increase and a base decrease are each disclosed per group', () => {
  for (const delta of [25, -15]) {
    const k = createCart(M1, { provenance: true }); k.inc(dish.key); k.add(dish.key, [E1.key], 1);
    const r = createCart(adaptMenu(withDishPrice(ENV, dish.key, dish.price + delta)), { provenance: true }); r.hydrate(k.snapshot());
    assert.deepEqual(r.priceChanges().map((x) => [x.sig, x.fromCents, x.toCents]), [['', c(dish.price), c(dish.price + delta)], [E1.key, c(dish.price + E1.price), c(dish.price + delta + E1.price)]], `delta ${delta}`);
  }
});
test('r3.4-1: an offset INSIDE one configuration that leaves its unit equal is not disclosed; offsets ACROSS groups disclose each', () => {
  const k = createCart(M1, { provenance: true }); k.add(dish.key, [E1.key], 1);
  let env = withDishPrice(ENV, dish.key, dish.price + 10); env = withExtraPrice(env, E1.key, E1.price - 10);
  const r = createCart(adaptMenu(env), { provenance: true }); r.hydrate(k.snapshot());
  assert.deepEqual(r.priceChanges(), [], 'the configured unit the customer saw is unchanged (advisor ruling)');
  const k2 = createCart(M1, { provenance: true }); k2.inc(dish.key); k2.inc(other.key);
  let env2 = withDishPrice(ENV, dish.key, dish.price + 10); env2 = withDishPrice(env2, other.key, other.price - 10);
  const r2 = createCart(adaptMenu(env2), { provenance: true }); r2.hydrate(k2.snapshot());
  assert.equal(r2.subtotalCents(), k2.subtotalCents(), 'premise: the cart total is equal');
  assert.deepEqual(r2.priceChanges().map((x) => x.key), [dish.key, other.key], '🔴 each group disclosed even though the total is equal');
});
test('r3.4-1: edit RE-snapshots from the menu the sheet showed; clone (line +) COPIES the source; remove drops', () => {
  const k = createCart(M1, { provenance: true }); k.add(dish.key, [E1.key], 1);
  const M2 = adaptMenu(withExtraPrice(ENV, E1.key, E1.price + 10));
  const clonek = createCart(M2, { provenance: true }); clonek.hydrate(k.snapshot());
  clonek.lineInc(dish.key, E1.key);
  assert.equal(clonek.priceChanges()[0].n, 2, 'the clone carries its source\'s last-seen prices (identical configuration)');
  clonek.lineDec(dish.key, E1.key);
  assert.equal(clonek.priceChanges()[0].n, 1, 'remove drops one instance\'s provenance with it');
  clonek.edit(dish.key, E1.key, [E2.key]);
  assert.deepEqual(clonek.priceChanges(), [], 'an edit re-snapshots from the sheet\'s menu — the customer saw those prices');
  assert.deepEqual(clonek.snapshot().lines[0].seen, [{ b: c(dish.price), x: { [E2.key]: c(E2.price) } }], 'the edited instance carries the prices the sheet showed');
  const s = createCart(M2, { provenance: true }); s.hydrate(k.snapshot()); s.setInstance(dish.key, 0, [E1.key]);
  assert.deepEqual(s.priceChanges(), [], 'dressing one instance re-snapshots it');
  const q = createCart(M2, { provenance: true }); q.hydrate(k.snapshot()); q.setQty(dish.key, 3);
  assert.deepEqual(q.priceChanges().map((x) => x.n), [1], 'padding adds PLAIN instances snapshotted now; the old one keeps its provenance');
});
test('r3.4-1: an old snapshot (no `seen`), a malformed `seen`, or a non-provenance cart ⇒ no disclosure (never a guess)', () => {
  const k = createCart(M1, { provenance: true }); k.add(dish.key, [E1.key], 1);
  const M2 = adaptMenu(withExtraPrice(ENV, E1.key, E1.price + 10));
  const plain = { v: 2, lines: k.lines() };
  for (const [label, snap] of [['no seen', plain],
    ['wrong extra set', { v: 2, lines: k.snapshot().lines.map((l) => ({ ...l, seen: [{ b: 1, x: {} }] })) }],
    ['negative cents', { v: 2, lines: k.snapshot().lines.map((l) => ({ ...l, seen: [{ b: -1, x: { [E1.key]: 1 } }] })) }],
    ['length mismatch', { v: 2, lines: k.snapshot().lines.map((l) => ({ ...l, seen: [] })) }]]) {
    const r = createCart(M2, { provenance: true }); assert.deepEqual(r.hydrate(snap), { dropped: 0 }, `${label}: the line is restored`);
    assert.deepEqual(r.priceChanges(), [], `${label}: no disclosure`);
  }
  const np = createCart(M2); np.hydrate(k.snapshot());
  assert.deepEqual(np.priceChanges(), [], 'a non-provenance cart ignores stored provenance');
});

// ── r3.3-F2 New-2: menuFingerprint ──
test('r3.3-F2: menuFingerprint is stable over key order, changes with content, and is what "unchanged" means (adapted models never deep-equal)', async () => {
  const a = await menuFingerprint(ENV);
  assert.match(a, /^[0-9a-f]{64}$/);
  const reordered = Object.fromEntries(Object.entries(clone(ENV)).reverse()); reordered.menu = Object.fromEntries(Object.entries(reordered.menu).reverse());
  assert.equal(await menuFingerprint(reordered), a, 'key order is not content');
  assert.notEqual(await menuFingerprint(withDishPrice(ENV, dish.key, dish.price + 1)), a, '🔴 a price change is a different menu');
  assert.notDeepStrictEqual(adaptMenu(ENV), adaptMenu(clone(ENV)), 'premise (Codex r2 New-2): two adaptations of identical input are not deep-equal');
  await assert.rejects(menuFingerprint({ rid: 'x' }), /no menu/);
});

// ── r3.3-F2: the MenuCache `presentation` state ──
function rig(now0) {
  let t = now0; const calls = []; const persisted = []; let reply = null;
  const cache = createMenuCache({ now: () => t, fetchEnvelope: (rid, etag) => { calls.push({ rid, etag }); return Promise.resolve(typeof reply === 'function' ? reply(rid, etag) : reply); },
    validateBody: (rid, body) => !!body && body.rid === rid && !!adaptMenu(body), persist: (rid, rec) => persisted.push(rec) });
  return { cache, calls, persisted, set: (r) => { reply = r; }, at: (x) => { t = x; } };
}
const T0 = Date.UTC(2026, 9, 27, 18, 0, 0);
const rec = (age, extra = {}) => ({ v: 1, rid: ENV.rid, etag: 'e1', fetched_at: T0 - age, body: ENV, ...extra });
test('r3.3-F2: a valid persisted record enters as `presentation` — its ORIGINAL age kept, never fresh, never complete', () => {
  const R = rig(T0); assert.equal(R.cache.seed(ENV.rid, rec(5 * 3600e3)), true);
  const e = R.cache.peek(ENV.rid);
  assert.deepEqual([e.state, e.fetched_at, e.presented_until], ['presentation', T0 - 5 * 3600e3, T0 - 5 * 3600e3 + PRESENT_MS], '🔴 the ORIGINAL fetched_at and its 24 h expiry');
  assert.equal(R.cache.complete([ENV.rid]), false, '🔴 presentation never makes search complete');
});
test('r3.3-F2: the 24 h boundary is the ORIGINAL fetch + 24 h, at peek', () => {
  const R = rig(T0); R.cache.seed(ENV.rid, rec(0));
  R.at(T0 + PRESENT_MS - 60e3); assert.equal(R.cache.peek(ENV.rid).state, 'presentation', '23 h 59 m: still browsable');
  R.at(T0 + PRESENT_MS + 60e3); assert.equal(R.cache.peek(ENV.rid), null, '24 h 01 m: gone (never stale, never failed)');
});
test('r3.3-F2: seed refuses a record that is ≥ 24 h old, from the future beyond the skew, of another rid, a bad version or an invalid body', () => {
  const bad = [['24 h old', rec(PRESENT_MS)], ['future', rec(-(SKEW_MS + 1))], ['other rid', { ...rec(0), rid: 'zz' }], ['body of another rid', rec(0, { body: { ...ENV, rid: 'zz' } })],
    ['v2', rec(0, { v: 2 })], ['no menu', rec(0, { body: { rid: ENV.rid } })], ['no time', rec(0, { fetched_at: NaN })]];
  for (const [label, r] of bad) { const R = rig(T0); assert.equal(R.cache.seed(ENV.rid, r), false, label); assert.equal(R.cache.peek(ENV.rid), null, label); }
  const R = rig(T0); assert.equal(R.cache.seed(ENV.rid, rec(-(SKEW_MS - 1000))), true, 'a small clock skew is tolerated');
});
test('r3.3-F2: get() always requests a presentation entry WITH its etag; a matching 304 promotes it to fresh (new fetched_at) and persists', async () => {
  const R = rig(T0); R.cache.seed(ENV.rid, rec(3600e3)); const seen = []; R.cache.subscribe(ENV.rid, (e) => seen.push(e && e.state));
  R.set({ status: 304 });
  const e = await R.cache.get(ENV.rid);
  assert.deepEqual(R.calls, [{ rid: ENV.rid, etag: 'e1' }], 'not a cache hit; the presentation etag is the validator');
  assert.deepEqual([e.state, e.fetched_at, e.body === ENV, 'presented_until' in e], ['fresh', T0, true, false], 'promoted to fresh, the presentation fields dropped');
  assert.deepEqual(seen, ['fresh'], 'subscribers get the promotion');
  assert.deepEqual(R.persisted.map((r) => [r.v, r.rid, r.etag, r.fetched_at]), [[1, ENV.rid, 'e1', T0]], 'the fresh body is persisted with its new time');
});
test('r3.3-F2: a validated 200 promotes; a failed request leaves `presentation` until it expires (never stale / failed)', async () => {
  const R = rig(T0); R.cache.seed(ENV.rid, rec(3600e3)); R.set({ status: 0 });
  const e = await R.cache.get(ENV.rid);
  assert.equal(e.state, 'presentation', '🔴 a failure keeps the browse view');
  assert.equal(R.calls.length, 2, 'the ONE retry still applies');
  R.set({ status: 200, body: ENV, etag: 'e2' });
  const f = await R.cache.get(ENV.rid);
  assert.deepEqual([f.state, f.etag], ['fresh', 'e2']);
  R.at(T0 + FRESH_MS + 1); assert.equal(R.cache.peek(ENV.rid).state, 'stale', 'the existing deadlines apply once fresh (untouched)');
});
test('r3.3-F2: a body already held in memory is never replaced by an older persisted one', async () => {
  const R = rig(T0); R.set({ status: 200, body: ENV, etag: 'e9' }); await R.cache.get(ENV.rid);
  assert.equal(R.cache.seed(ENV.rid, rec(1000)), false); assert.equal(R.cache.peek(ENV.rid).etag, 'e9');
});

// ── r3.3-F1: eligibility on its own clock ──
test('r3.3-F1: enterable for 60 s after the last SUCCESSFUL verification; a hanging request never extends it', () => {
  let t = 1000; const el = createEligibility({ now: () => t });
  assert.equal(el.state('a'), 'held', 'cached / never verified ⇒ held entry');
  el.verified({ listed: ['a', 'b'], complete: true, at: t });
  t += WINDOW_MS - 1; assert.equal(el.state('a'), 'enterable');
  t += 1; assert.equal(el.state('a'), 'held', '🔴 60 s after the last success — a request still in flight changes nothing');
  el.verified({ listed: ['a'], complete: false, at: t });
  assert.deepEqual([el.state('a'), el.state('b')], ['enterable', 'held'], 'a partial verifies what it lists and never tombstones');
  el.verified({ listed: ['a'], complete: true, at: t });
  assert.equal(el.state('b'), 'gone', 'a complete response that omits a store tombstones it');
});
test('Codex perf-core r1 #1: a PARTIAL that omits a store still inside its window makes it HELD (not tombstoned, not left enterable)', () => {
  let t = 1000; const el = createEligibility({ now: () => t });
  el.verified({ listed: ['a', 'b'], complete: true, at: t });
  t += 1000; assert.equal(el.state('b'), 'enterable', 'premise: B is still fresh when the partial arrives');
  el.verified({ listed: ['a'], complete: false, at: t });
  assert.deepEqual([el.state('a'), el.state('b')], ['enterable', 'held'], '🔴 omitted by a partial ⇒ held (never tombstoned)');
  el.verified({ listed: ['a', 'b'], complete: false, at: t });
  assert.equal(el.state('b'), 'enterable', 'a later response that lists it verifies it again');
});
test('Codex perf-core r1 #2: once expiry has been observed, a clock rolled BACK cannot revive eligibility (high-water clock)', () => {
  let t = 1000; const el = createEligibility({ now: () => t });
  el.verified({ listed: ['a'], complete: true, at: t });
  t = 61000; assert.equal(el.state('a'), 'held', 'premise: expired');
  t = 30000; assert.equal(el.state('a'), 'held', '🔴 a rollback never revives an expired eligibility');
  el.verified({ listed: ['a'], complete: true, at: t });
  assert.equal(el.state('a'), 'enterable', 'only a NEW successful verification does');
});

// ── r3.3-F5: auth state ──
function authRig() {
  const timers = new Map(); let id = 0; let cb = null, eb = null; let subs = 0;
  const T = { setTimeout: (f, ms) => { timers.set(++id, { f, ms }); return id; }, clearTimeout: (h) => timers.delete(h) };
  const fire = () => { const all = [...timers.values()]; timers.clear(); for (const x of all) x.f(); };
  return { T, fire, timers, subscribe: (ok, err) => { subs++; cb = ok; eb = err; return () => { cb = null; }; }, user: (u) => cb && cb(u), fail: () => eb && eb(new Error('init')), subs: () => subs };
}
test('r3.3-F5: unresolved until the FIRST callback; a tap waits and acts for the resolved identity — a 9 s restoration lands as MEMBER', async () => {
  const R = authRig(); const a = createAuthState({ subscribe: R.subscribe, timers: R.T });
  assert.equal(a.state(), 'unresolved');
  let got = null; a.whenResolved().then((s) => { got = s; });
  await Promise.resolve(); assert.equal(got, null, '🔴 never assumed guest while unresolved');
  assert.deepEqual([...R.timers.values()].map((x) => x.ms), [UNAVAILABLE_MS]);
  R.user({ uid: 'u1' }); await Promise.resolve();
  assert.deepEqual([a.state(), got, a.user().uid], ['member', 'member', 'u1']);
  const g = createAuthState({ subscribe: (ok) => { ok(null); return () => {}; }, timers: R.T });
  assert.equal(g.state(), 'guest', 'a first callback with no user IS guest');
});
test('r3.3-F5: no first callback in 10 s, or an init failure ⇒ `unavailable`, NEVER guest; a later callback wins; retry re-subscribes', async () => {
  const R = authRig(); const a = createAuthState({ subscribe: R.subscribe, timers: R.T });
  R.fire(); assert.equal(a.state(), 'unavailable', '🔴 not guest');
  assert.equal(await a.whenResolved(), 'unavailable');
  R.user({ uid: 'late' }); assert.equal(a.state(), 'member', 'the SDK answering later still wins');
  const R2 = authRig(); const b = createAuthState({ subscribe: R2.subscribe, timers: R2.T });
  R2.fail(); assert.equal(b.state(), 'unavailable');
  assert.equal(b.retry(), true); assert.deepEqual([b.state(), R2.subs()], ['unresolved', 2], '«Reintentar» re-initializes');
  const c3 = createAuthState({ subscribe: () => { throw new Error('sdk missing'); }, timers: R2.T });
  assert.equal(c3.state(), 'unavailable', 'an SDK that throws ⇒ unavailable');
});
test('Codex perf-core r1 #5: with NO validateBody nothing is seeded — not even a body that names its rid (never trusted unchecked)', async () => {
  const cache = createMenuCache({ now: () => T0, fetchEnvelope: () => Promise.resolve({ status: 304 }) });
  assert.equal(cache.seed('a', { v: 1, rid: 'a', etag: 'e', fetched_at: T0, body: { rid: 'a' } }), false, '🔴 {body:{rid:"a"}} is refused without a validator');
  assert.equal(cache.seed(ENV.rid, rec(0)), false, 'even a real envelope: a persisted body is never trusted unchecked');
  assert.equal(cache.peek('a'), null);
  await cache.get('a');
  assert.equal(cache.complete(['a']), false, 'so a later 304 can never promote an unchecked body');
});
