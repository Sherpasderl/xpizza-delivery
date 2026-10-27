// Customer app S7a-1/S7a-2 shell logic (PLAN-capp-S7a r2 §1.3, §2.1; APPROVED as a plan): the shell navigation (one history owner,
// recorded predecessor, consumed / blocked / pass, self-caused backs) and the shared MenuCache (global concurrency, dedupe,
// rid validation, 304 rules, stale retention, retry, independent subscribers). Pure — a fake window; no DOM.
// Run: node --test customer-app/capp-s7a1-shell.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createShellNav } = require('./capp-shell-nav.js');
const { createMenuCache, STALE_MS, FRESH_MS } = require('./capp-menu-cache.js');

// a FAITHFUL session history (Codex r2 New 4): indexed entries; pushState truncates the forward entries; back / forward / go move
// the index and queue an ASYNC popstate carrying the destination entry's state
function fakeWin() {
  const win = { _l: null, q: [] };
  win.history = { entries: [null], i: 0, get state() { return this.entries[this.i]; },
    pushState(st) { this.entries = this.entries.slice(0, this.i + 1); this.entries.push(st); this.i = this.entries.length - 1; },
    go(k) { const j = Math.max(0, Math.min(this.entries.length - 1, this.i + k)); if (j === this.i) return; this.i = j; win.q.push({ state: this.entries[j] }); },
    back() { this.go(-1); }, forward() { this.go(1); } };
  win.addEventListener = (t, f) => { if (t === 'popstate') win._l = f; };
  win.removeEventListener = (t, f) => { if (win._l === f) win._l = null; };
  win.flush = () => { const out = []; while (win.q.length) { const e = win.q.shift(); out.push(win._l ? win._l(e) : 'none'); } return out; };   // deliver the queued popstates
  win.device = () => { win.history.back(); return win.flush()[0]; };     // a device / browser Back
  win.fwd = () => { win.history.forward(); return win.flush(); };        // a browser Forward
  return win;
}
function rigNav() {
  const shown = [], left = [];
  const win = fakeWin();
  const nav = createShellNav({ win, onShow: (e, x) => shown.push({ e, x }), onLeave: (e) => left.push(e) });
  return { nav, win, shown, left };
}

test('S7a-1 N4: store-root `pass` returns to the RECORDED predecessor — Buscar with its query and scroll; Inicio only when there is none', () => {
  const R = rigNav();
  R.nav.go({ name: 'search' });
  R.nav.go({ name: 'store', rid: 'rid_a' }, { q: 'pizza', scroll: 120 });   // leaving Buscar saves its state
  const ad = R.nav.adapterFor(R.nav.current()); ad.subscribe(() => 'pass');
  assert.equal(R.win.device(), 'pass');
  const last = R.shown.at(-1);
  assert.deepEqual([last.e.name, last.x.restored], ['search', { q: 'pizza', scroll: 120 }], '🔴 Buscar → store back returns to Buscar with its query');
  assert.deepEqual(R.left.map((e) => e.rid), ['rid_a'], 'the store mount is left (destroyed) only after pass');
  const D = rigNav(); D.nav.go({ name: 'search' }); D.nav.tab({ name: 'store', rid: 'rid_b' }); D.nav.adapterFor(D.nav.current()).subscribe(() => 'pass');   // a tab to the store: no recorded predecessor
  D.win.device(); assert.equal(D.shown.at(-1).e.name, 'home', 'no predecessor (a deep link) ⇒ the Inicio fallback');
});

test('S7a-1 §1.3: consumed ⇒ the mount handled it (the store stays); blocked ⇒ the browser entry is RE-PUSHED, nothing left; a UI-caused back is never re-delivered', () => {
  const R = rigNav();
  R.nav.go({ name: 'store', rid: 'rid_a' });
  const ad = R.nav.adapterFor(R.nav.current()); let result = 'consumed', calls = 0; ad.subscribe(() => { calls++; return result; });
  ad.push(); ad.push();   // checkout → tip
  assert.equal(R.win.device(), 'consumed'); assert.deepEqual([ad.owns(), R.left.length], [true, 0], 'one in-store entry left, the store stays');
  const at = R.win.history.i;
  result = 'blocked';
  assert.equal(R.win.device(), 'blocked');
  assert.equal(R.win.history.i, at, '🔴 blocked: the popped browser entry is restored (re-pushed)');
  assert.equal(R.left.length, 0, 'blocked never leaves or destroys the store');
  calls = 0; ad.back(); assert.deepEqual(R.win.flush(), ['self']); assert.equal(calls, 0, '🔴 a UI-caused back is never re-delivered to the mount');
  ad.push(); ad.push(); assert.equal(ad.owns(), true); ad.go(-2); assert.deepEqual(R.win.flush(), ['self']); assert.equal(ad.owns(), false, 'go(-k) pops k of the mount\'s entries');
  assert.deepEqual(Object.keys(ad).sort(), ['back', 'go', 'owns', 'push', 'subscribe'], 'EXACTLY the approved adapter interface');
});

test('S7a-1: a tab switch leaves a top store mount; destroy unsubscribes the popstate listener', () => {
  const R = rigNav(); R.nav.go({ name: 'store', rid: 'rid_a' });
  R.nav.tab({ name: 'orders' });
  assert.deepEqual([R.left.map((e) => e.rid), R.nav.current().name, R.nav.depth()], [['rid_a'], 'orders', 1]);
  R.nav.destroy(); assert.equal(R.win._l, null);
});

test('Codex r2 New 3: EVERY shell exit asks the mount — tab / the shell\'s back / a screen over the store are refused while it answers blocked; nothing is left or destroyed', () => {
  const R = rigNav(); R.nav.go({ name: 'search' }); R.nav.go({ name: 'store', rid: 'rid_a' });
  let verdict = 'blocked'; const asked = []; R.nav.adapterFor(R.nav.current()).subscribe((intent) => { asked.push(intent); return intent === 'leave' ? verdict : 'consumed'; });
  const shown0 = R.shown.length, at = R.win.history.i;
  assert.deepEqual([R.nav.tab({ name: 'orders' }), R.nav.back(), R.nav.go({ name: 'search' })], [false, false, false], '🔴 a blocked mount is never left, destroyed or covered (each exit refused)');
  assert.deepEqual([R.nav.current().name, R.left.length, R.shown.length, R.win.history.i, asked], ['store', 0, shown0, at, ['leave', 'leave', 'leave']], '🔴 a blocked mount is never left, destroyed or covered');
  verdict = 'pass';
  assert.equal(R.nav.tab({ name: 'orders' }), true);
  assert.deepEqual([R.nav.current().name, R.left.map((e) => e.rid)], ['orders', ['rid_a']], 'a mount that may leave is left on the tab');
});

test('Codex r2 New 4: browser Forward is never processed as a Back — Inicio → Buscar → store, Back ⇒ Buscar, Forward ⇒ undone (Buscar stays, the predecessor intact), Back ⇒ Inicio', () => {
  const R = rigNav(); R.nav.go({ name: 'search' }, { q: 'pizza' }); R.nav.go({ name: 'store', rid: 'rid_a' }, { q: 'pizza' });
  R.nav.adapterFor(R.nav.current()).subscribe(() => 'pass');
  assert.equal(R.win.device(), 'pass'); assert.equal(R.nav.current().name, 'search');
  const shown = R.shown.length;
  assert.deepEqual(R.win.fwd(), ['forward', 'self'], 'the forward move is undone (one self-caused correction)');
  assert.deepEqual([R.nav.current().name, R.nav.depth(), R.shown.length, R.win.history.i], ['search', 2, shown, 1], '🔴 a Forward never pops the recorded predecessor');
  assert.equal(R.win.device(), 'popped'); assert.equal(R.nav.current().name, 'home', 'Back from Buscar ⇒ Inicio');
});

// ── MenuCache ──
function deferredFetcher() {
  const calls = []; const pending = [];
  const fetchEnvelope = (rid, etag) => new Promise((resolve) => { calls.push({ rid, etag }); pending.push({ rid, etag, resolve }); });
  return { fetchEnvelope, calls, pending, answer: (i, r) => pending[i].resolve(r) };
}
const tick = () => new Promise((r) => setImmediate(r));
const env = (rid, extra = {}) => ({ status: 200, body: { rid, menu: { dishes: [] }, ...extra }, etag: `e_${rid}` });

test('S7a-2 MenuCache: ONE global concurrency of 3 across consumers; in-flight dedupe; independent subscribers (leaving Inicio cancels nothing Buscar shares)', async () => {
  const F = deferredFetcher(); const M = createMenuCache({ fetchEnvelope: F.fetchEnvelope });
  const inicio = ['a', 'b', 'c', 'd', 'e'].map((r) => M.get(r));
  const buscarA = M.get('a');
  await tick();
  assert.deepEqual([F.calls.length, M._active(), M._queued()], [3, 3, 2], '🔴 global concurrency 3 across Inicio+Buscar');
  const seen = []; const unsub = M.subscribe('a', (e) => seen.push(['inicio', e.state])); M.subscribe('a', (e) => seen.push(['buscar', e.state]));
  unsub();   // Inicio unmounts
  F.answer(0, env('a')); const ea = await buscarA;
  assert.equal(ea, await inicio[0], 'Buscar reuses the in-flight Inicio request (one fetch)');
  assert.deepEqual(seen, [['buscar', 'fresh']], 'the remaining consumer still gets it');
  assert.equal(F.calls.filter((c) => c.rid === 'a').length, 1);
  for (let i = 1; i < 5; i++) { await tick(); if (F.pending[i]) F.answer(i, env(F.pending[i].rid)); }
  await Promise.all(inicio);
  assert.ok(M.complete(['a', 'b', 'c', 'd', 'e']));
});

test('S7a-2 MenuCache: a 200 for another rid fails; a 304 needs the retained matching body (else a validator-less re-fetch); failed revalidation keeps the body STALE (search partial) then FAILED', async () => {
  let t = 1000; const script = [];
  const M = createMenuCache({ now: () => t, fetchEnvelope: async (rid, etag) => { const r = script.shift(); r.seen = etag; return r; } });
  script.push(env('x')); script[0].body.rid = 'zzz';   // a definitive 200 for another rid (not retried)
  assert.equal((await M.get('x')).state, 'failed', '🔴 envelope.rid must equal the requested rid');
  script.push(env('y')); await M.get('y'); t += FRESH_MS + 1;
  const v304 = { status: 304 }; script.push(v304); const e2 = await M.get('y');
  assert.deepEqual([v304.seen, e2.state, e2.body.rid], ['e_y', 'fresh', 'y'], 'a 304 with the retained matching body ⇒ fresh');
  // a 304 when nothing is retained ⇒ re-fetch WITHOUT a validator
  const lone = { status: 304 }; const full = env('z'); script.push(lone, full);
  const ez = await M.get('z'); assert.deepEqual([lone.seen, full.seen, ez.state], [null, null, 'fresh'], '304 requires the retained matching body');
  t += FRESH_MS + 1; script.push({ status: 503 }, { status: 503 });   // revalidation fails (and its one retry)
  const es = await M.get('y'); assert.equal(es.state, 'stale');
  assert.equal(M.complete(['y', 'z']), false, '🔴 a stale rid makes search partial — never a complete «No encontramos»');
  t += STALE_MS; assert.equal(M.peek('y').state, 'failed', 'past the stale window ⇒ failed');
});

test('Codex r2 New 5: the deadlines apply at READ time — a body past FRESH_MS reads stale, past STALE_MS failed, even while its revalidation is pending; never complete', async () => {
  let t = 0; const F = deferredFetcher(); const M = createMenuCache({ fetchEnvelope: F.fetchEnvelope, now: () => t });
  const g = M.get('a'); await tick(); F.answer(0, env('a')); await g;
  assert.deepEqual([M.peek('a').state, M.complete(['a'])], ['fresh', true]);
  t += FRESH_MS + 1; M.get('a'); await tick();   // a revalidation is pending
  assert.deepEqual([M.peek('a').state, !!M.peek('a').body, M.complete(['a'])], ['stale', true, false], '🔴 past FRESH_MS: stale (renderable), never complete');
  t += STALE_MS; 
  assert.deepEqual([M.peek('a').state, M.peek('a').body, M.complete(['a'])], ['failed', null, false], '🔴 past STALE_MS: failed, even while revalidating');
  F.answer(1, env('a')); await tick(); await tick();
  assert.equal(M.peek('a').state, 'fresh', 'the revalidation lands ⇒ fresh');
});

test('Codex r2 New 6: the validator-less re-fetch after an unusable 304 gets the same ONE retry', async () => {
  const seq = [{ status: 304 }, { status: 503 }, env('w')]; const seen = [];
  const M = createMenuCache({ fetchEnvelope: async (rid, etag) => { seen.push(etag); return seq.shift(); } });
  const e = await M.get('w');
  assert.deepEqual([e.state, seen.length], ['fresh', 3], '🔴 304 ⇒ re-fetch ⇒ 503 ⇒ ONE retry ⇒ fresh');
});

test('S7a-2 MenuCache: ONE retry on a network error / 5xx', async () => {
  const seq = [{ status: 0 }, env('r')]; const M = createMenuCache({ fetchEnvelope: async () => seq.shift() });
  assert.equal((await M.get('r')).state, 'fresh');
  const seq2 = [{ status: 500 }, { status: 500 }, env('q')]; const M2 = createMenuCache({ fetchEnvelope: async () => seq2.shift() });
  assert.equal((await M2.get('q')).state, 'failed', 'only one retry');
});
