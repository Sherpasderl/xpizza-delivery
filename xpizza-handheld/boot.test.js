// H1b — boot.js: the serialized boot decision and the device-auth watch, across every notification ordering codex r2 reproduced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideBoot, createAuthWatch, runBoot, runPair, signedOutPatch } from './boot.js';

const saved = { uid: 'hh_tb_norte_a', rid: 'tb_norte' };
const later = (v, ms) => new Promise((r) => setTimeout(() => r(v), ms));
const browserSt = { native: false, blocked: false };
const nativeBlocked = { native: true, blocked: true };

test('decideBoot waits for BOTH the status and the first Auth state, whichever resolves first (P1-1)', async () => {
  // Auth first, status later — the reproduced race: still ONE decision, from both inputs
  assert.deepEqual(await decideBoot({ saved, hasPin: true, statusP: later(nativeBlocked, 20), firstAuthP: later({ uid: saved.uid }, 1) }),
    { route: 'checks', signOut: false, status: nativeBlocked });
  // status first, Auth later
  assert.equal((await decideBoot({ saved, hasPin: true, statusP: later(browserSt, 1), firstAuthP: later({ uid: saved.uid }, 20) })).route, 'main');
});

test('decideBoot routes: foreign uid → sign out; paired + PIN → main / checks; paired no PIN → checks; else login', async () => {
  const d = (o) => decideBoot({ statusP: Promise.resolve(browserSt), firstAuthP: Promise.resolve(null), saved: null, hasPin: false, ...o });
  assert.deepEqual(await d({ saved, hasPin: true, firstAuthP: Promise.resolve({ uid: 'someone_else' }) }), { route: 'login', signOut: true, status: browserSt },
    'a different authenticated uid never reaches the list (P1-1)');
  assert.equal((await d({ saved, hasPin: true })).route, 'main', 'offline cold start: Auth not restored yet (null) → the list, banner until the snapshot');
  assert.equal((await d({ saved, hasPin: true, statusP: Promise.resolve(nativeBlocked) })).route, 'checks', 'the native guard on every boot');
  assert.equal((await d({ saved, hasPin: false, firstAuthP: Promise.resolve({ uid: saved.uid }) })).route, 'checks');
  assert.equal((await d({ saved, hasPin: false })).route, 'login');
  assert.equal((await d({})).route, 'login');
});

test('auth watch: the device sign-in notification BEFORE the controller assigns its session still counts; a later null is a loss (P1-2)', () => {
  const losses = [];
  const w = createAuthWatch({ onLoss: (why) => losses.push(why) });
  w.expect('hh_new');                                  // set BEFORE signInWithCustomToken (pairing)
  w.observe(null);                                     // the pre-sign-in state: not a loss
  w.observe({ uid: 'hh_new' });                        // the sign-in lands (possibly before doPair assigns sess)
  assert.deepEqual(losses, []);
  w.observe(null);                                     // the device identity disappears
  assert.deepEqual(losses, ['signed_out']);
  w.observe(null);
  assert.deepEqual(losses, ['signed_out'], 'reported once');
});

test('auth watch: a different uid is a loss; nothing is watched before expect() or after clear()', () => {
  const losses = [];
  const w = createAuthWatch({ onLoss: (why) => losses.push(why) });
  w.observe({ uid: 'x' }); w.observe(null);
  assert.deepEqual(losses, [], 'not expecting anything yet');
  w.expect('hh_a');
  w.observe({ uid: 'hh_b' });
  assert.deepEqual(losses, ['other_uid']);
  w.clear(); w.observe(null); w.observe({ uid: 'z' });
  assert.deepEqual(losses, ['other_uid'], 'cleared at sign-out');
  w.expect('hh_c'); w.observe({ uid: 'hh_c' }); w.observe(null);
  assert.deepEqual(losses, ['other_uid', 'signed_out'], 're-armed by the next expect()');
});

// a tiny controller harness: generations, a teardown that bumps them, and the watch wired as app.js wires it
function harness() {
  const h = { gen: 1, sess: null, phase: 'boot', signOuts: 0, routes: [] };
  h.watch = createAuthWatch({ onLoss: () => h.teardown() });
  h.teardown = async () => { h.gen++; h.signOuts++; h.sess = null; h.phase = 'login'; h.watch.clear(); };
  h.genNow = () => h.gen; h.isLive = (g) => g === h.gen;
  return h;
}
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

test('codex H1b r3 P1-1: a restored session — watch armed BEFORE Auth; the restored user counts as seen; null after restore → sign-out', async () => {
  const h = harness(); h.watch.expect(saved.uid);                  // armed before the Auth subscription
  const auth = deferred(); const status = deferred();
  const run = runBoot({ saved, hasPin: true, statusP: status.p, firstAuthP: auth.p, genNow: h.genNow, isLive: h.isLive, signOut: h.teardown,
    route: (d) => { h.phase = d.route; h.sess = saved; h.routes.push(d.route); } });
  h.watch.observe({ uid: saved.uid }); auth.resolve({ uid: saved.uid }); // Auth first …
  status.resolve(browserSt);                                         // … status later
  assert.equal(await run, 'main');
  h.watch.observe(null);                                             // the device identity disappears after the restore
  assert.deepEqual([h.signOuts, h.phase, h.sess], [1, 'login', null]);
});

test('codex H1b r3 P1-1: a FOREIGN uid while the status is still pending → loss; the boot continuation then routes NOTHING', async () => {
  const h = harness(); h.watch.expect(saved.uid);
  const status = deferred();
  const run = runBoot({ saved, hasPin: true, statusP: status.p, firstAuthP: Promise.resolve({ uid: 'intruder' }), genNow: h.genNow, isLive: h.isLive,
    signOut: h.teardown, route: (d) => h.routes.push(d.route) });
  h.watch.observe({ uid: 'intruder' });                             // the observer sees it before the status resolves
  status.resolve(nativeBlocked);
  assert.equal(await run, 'stale');
  assert.deepEqual([h.signOuts, h.routes, h.phase, h.sess], [1, [], 'login', null]);
});

test('codex H1b r3 P1-1: status first, Auth later — both orders route once; an intervening teardown stops the boot', async () => {
  const h = harness(); h.watch.expect(saved.uid);
  const auth = deferred();
  const run = runBoot({ saved, hasPin: true, statusP: Promise.resolve(browserSt), firstAuthP: auth.p, genNow: h.genNow, isLive: h.isLive,
    signOut: h.teardown, route: (d) => h.routes.push(d.route) });
  await h.teardown();                                                // e.g. a feed sessionLost before Auth resolved
  auth.resolve({ uid: saved.uid });
  assert.equal(await run, 'stale');
  assert.deepEqual(h.routes, []);
});

test('codex H1b r3 P1-2: auth loss DURING refreshStatus → stays on login with no session; nothing resumes', async () => {
  const h = harness(); h.phase = 'branch';
  const status = deferred();
  const pairing = { pair: async () => { h.watch.expect('hh_new'); h.watch.observe({ uid: 'hh_new' }); return { ok: true, session: { uid: 'hh_new', rid: 'tb_norte' } }; } };
  const run = runPair({ pairing, sel: { rid: 'tb_norte' }, label: 'x', genNow: h.genNow, isLive: h.isLive, refreshStatus: () => status.p,
    onSession: (s) => { h.sess = s; }, onDone: () => { h.phase = 'checks'; }, onRefused: () => { h.phase = 'refused'; } });
  await Promise.resolve(); await Promise.resolve();
  h.watch.observe(null);                                             // the device identity is lost while the status is being read
  status.resolve(browserSt);
  assert.equal(await run, 'stale');
  assert.deepEqual([h.phase, h.sess, h.signOuts], ['login', null, 1]);
});

test('runPair: a teardown during pair() itself → no session is ever assigned', async () => {
  const h = harness();
  const pr = deferred();
  const run = runPair({ pairing: { pair: () => pr.p }, sel: {}, label: 'x', genNow: h.genNow, isLive: h.isLive, refreshStatus: async () => browserSt,
    onSession: (s) => { h.sess = s; }, onDone: () => { h.phase = 'checks'; }, onRefused: () => {} });
  await h.teardown();
  pr.resolve({ ok: true, session: { uid: 'u' } });
  assert.equal(await run, 'stale');
  assert.deepEqual([h.sess, h.phase], [null, 'login']);
});

test('codex H1b r4 P2: a teardown during pairing → the login is usable again (working reset); a stale pairing touches no state', async () => {
  const S = { phase: 'branch', working: true, pairing: { rows: [] }, sel: { rid: 'tb_norte' }, loginErr: 'x', pairErr: 'y' };
  Object.assign(S, signedOutPatch());
  assert.equal(S.working, false, 'the login button is enabled after the teardown');
  assert.deepEqual([S.phase, S.pairing, S.sel, S.loginErr, S.pairErr], ['login', null, null, '', '']);
  assert.notStrictEqual(signedOutPatch().opened, signedOutPatch().opened, 'fresh objects each time');
  // the pairing resolves AFTER the teardown (generation bumped): runPair reports stale and calls none of its state setters
  let gen = 1; let resolve; const calls = [];
  const p = runPair({ pairing: { pair: () => new Promise((r) => { resolve = r; }) }, sel: { rid: 'tb_norte' }, label: 'x', genNow: () => gen, isLive: (g) => g === gen,
    refreshStatus: async () => calls.push('status'), onSession: () => calls.push('session'), onDone: () => calls.push('done'), onRefused: () => calls.push('refused') });
  gen++; Object.assign(S, signedOutPatch());
  resolve({ ok: true, session: { uid: 'u', rid: 'tb_norte' } });
  assert.equal(await p, 'stale');
  assert.deepEqual(calls, []);
  assert.equal(S.working, false);
});
