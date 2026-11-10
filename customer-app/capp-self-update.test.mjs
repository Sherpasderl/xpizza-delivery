// Customer app S2a (PLAN-capp-S2-r4 §2.4) — the app self-update adapter, against the REAL shared coordinator
// (platform sherpa-client.js create()) with a stamped identity: a reload is refused on a payment return, while a placement is
// in flight, while unresolved payment state exists, and on the tip / placing / Enviando screens; the snapshot round-trips
// through the coordinator's sessionStorage; the pay stash is never touched. Light: no emulator.
// Run: node --test customer-app/capp-self-update.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const U = require('./capp-self-update.js');

const base = (o = {}) => ({ state: () => ({ screen: 'checkout', placing: false, sheetOpen: false, ...o.st }), unresolved: () => !!o.unresolved, search: () => o.search || '', quiet: () => o.quiet !== false });

test('canReload: refused on a ?pay= return, a placement in flight, unresolved payment state, and the tip / placing / Enviando screens', () => {
  assert.equal(U.createAdapter(base()).canReload({ mode: 'idle' }), true, 'premise: an idle checkout may reload');
  const refused = [
    ['a payment return', { search: '?pay=complete&order=X&t=y' }],
    ['a placement in flight', { st: { placing: true } }],
    ['unresolved payment state', { unresolved: true }],
    ['the tip step', { st: { screen: 'tip' } }],
    ['the placing card', { st: { screen: 'placing' } }],
    ['Enviando', { st: { screen: 'sending' } }],
  ];
  for (const [what, o] of refused) for (const mode of ['idle', 'checkout']) assert.equal(U.createAdapter(base(o)).canReload({ mode }), false, `${what} (${mode})`);
  assert.equal(U.createAdapter(base({ st: { sheetOpen: true } })).canReload({ mode: 'idle' }), false, 'ordinary update: an open sheet');
  assert.equal(U.createAdapter(base({ quiet: false })).canReload({ mode: 'idle' }), false, 'ordinary update: a recent tap');
  assert.equal(U.createAdapter(base({ st: { sheetOpen: true }, quiet: false })).canReload({ mode: 'checkout' }), true, 'the 426 transition skips only the quietness checks');
  assert.equal(U.createAdapter({ state: () => { throw new Error('x'); } }).canReload({}), false, 'unreadable = not safe');
});

test('through the REAL coordinator: the snapshot round-trips via sessionStorage; the pay stash and pending_place are never touched', async () => {
  const SC = require(join(ROOT, 'platform/client/sherpa-client.js'));
  const ss = new Map(); const ls = new Map([['ta_pending_pay', '{"order_id":"X","t":"p"}'], ['capp:rid_a:pending_place', '{"order_id":"X"}']]);
  const metas = { 'sherpa-app': 'orders', 'sherpa-deployment': 'orders-app', 'sherpa-context': 'platform', 'app-build': 'b1', 'app-compat': '1', 'sherpa-env': 'preview' };
  const doc = { querySelector: (q) => { const m = /meta\[name="([^"]+)"\]/.exec(q); return m && metas[m[1]] ? { getAttribute: () => metas[m[1]] } : null; },
    addEventListener: () => {}, dispatchEvent: () => {}, visibilityState: 'visible', body: { appendChild: () => {} }, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }) };
  const reloads = [];
  const mk = () => SC.create({ window: { document: doc, sessionStorage: { getItem: (k) => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)), removeItem: (k) => ss.delete(k) },
    localStorage: { getItem: (k) => ls.get(k) ?? null }, location: { reload() {} }, addEventListener: () => {}, CustomEvent: function () {}, console: { warn() {} } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ build: 'b2', compat: 1 }) }), reload: () => reloads.push(1), setTimeout: () => 0, setInterval: () => 0, now: () => 1e12 });
  const sc = mk();
  assert.equal(sc.inert, false, 'premise: a stamped identity');
  let restored = null;
  const host = { state: () => ({ screen: 'checkout', placing: false, sheetOpen: false }), unresolved: () => false, search: () => '', snapshot: () => ({ cart: { v: 2, lines: [1] }, flow: { mode: 'delivery' } }) };
  const a = U.register(sc, host);
  assert.ok(a && typeof a.canReload === 'function', 'registered');
  const snap = a.prepareReload({ mode: 'idle' });
  assert.deepEqual(snap, { cart: { v: 2, lines: [1] }, flow: { mode: 'delivery' } });
  // the coordinator's stored snapshot is handed back to afterReload on the next page
  ss.set('sherpa_reload_snapshot', JSON.stringify({ v: 1, deployment: 'orders-app', mode: 'idle', data: snap }));   // the coordinator's KEY_SNAPSHOT
  const sc2 = mk();
  U.register(sc2, { ...host, restore: (d) => { restored = d; } });
  assert.deepEqual(restored, snap, 'afterReload restores the snapshot the coordinator stored');
  assert.equal(ss.has('sherpa_reload_snapshot'), false, 'restored at most once');
  assert.deepEqual([ls.get('ta_pending_pay'), ls.get('capp:rid_a:pending_place')], ['{"order_id":"X","t":"p"}', '{"order_id":"X"}'], '🔴 creds untouched');
  assert.equal(U.register({ inert: true, registerAdapter: () => assert.fail('must not register') }, host), null, 'an inert module: nothing registered');
});

test('no restaurant literal in the adapter', () => {
  assert.equal(readFileSync(join(ROOT, 'customer-app/capp-self-update.js'), 'utf8').match(/x_pizza|la_musa|xpizza|lamusa|X\.? ?Pizza|La Musa/i), null);
});
