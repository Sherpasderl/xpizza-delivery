// PORTAL-UI 1b — COPY TRUTH for the owner-approved «Activar sucursal» help (PLAN r4 §2e E-f, MANDATORY per the advisor's r4
// approval): «Empieza a recibir pedidos de nuevo. Los pedidos programados se vuelven a revisar automáticamente; algunos pueden
// necesitar atención del despacho.» — asserted against the behaviour it describes, through the REAL scheduled-release core
// (xpizza-functions/scheduled-release-core.js, 5f-owned, loaded READ-ONLY; nothing is edited or stubbed inside it — only its
// injected deps: an in-memory db, the alert sink, the token minter). After reactivation (identity.active true):
//   1. a valid due order        → re-reviewed AND released (status new)                    «se vuelven a revisar automáticamente»
//   2. a paused branch          → re-reviewed, still HELD (no release)                     «algunos …» (not «se liberan solos»)
//   3. an expired slot          → re-reviewed, scheduled_blocked + a dispatcher alert      «… necesitar atención del despacho»
//      (+ hours changed since booking: the same blocked path)
//   4. an already-blocked order → never re-claimed (skipped) — it stays with the dispatcher «… atención del despacho»
// Run: node --test xpizza-portal/branches-1b-copytruth.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REL = require('../xpizza-functions/scheduled-release-core.js');
const S = require('../xpizza-functions/scheduled-orders.js');

const E_F = 'Empieza a recibir pedidos de nuevo. Los pedidos programados se vuelven a revisar automáticamente; algunos pueden necesitar atención del despacho.';

function makeDb(initial) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const getAt = (p) => { if (!p) return root; let x = root; for (const k of p.split('/')) { if (x == null) return null; x = x[k]; } return x === undefined ? null : x; };
  const setAt = (p, val) => { const a = p.split('/'); let x = root; for (let i = 0; i < a.length - 1; i++) { if (x[a[i]] == null || typeof x[a[i]] !== 'object') x[a[i]] = {}; x = x[a[i]]; } if (val === null) delete x[a[a.length - 1]]; else x[a[a.length - 1]] = val; };
  const ref = (p = '') => ({
    async once() { return { val: () => clone(getAt(p)) }; },
    async transaction(fn) { fn(null); const cur = clone(getAt(p)); const nx = fn(cur); if (nx === undefined) return { committed: false, snapshot: { val: () => cur } }; setAt(p, clone(nx)); return { committed: true, snapshot: { val: () => clone(getAt(p)) } }; },
    async update(patch) { if (!p) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; } for (const [k, v] of Object.entries(patch)) setAt(`${p}/${k}`, clone(v)); },
  });
  return { ref, root };
}
const NOW = 1_800_000_000_000;
const OPEN = { open: true, start: '00:00', end: '23:59' };
const HOURS = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((k) => [k, OPEN]));
const CLOSED = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((k) => [k, { open: false }]));
const due = (extra = {}) => ({ order_id: 'S1', restaurant_id: 'marca_s', status: 'scheduled', scheduled_for: NOW + 3_600_000, release_at: NOW - 1,
  order_type: 'delivery', total: 100, customer_name: 'Ana', payment_method: 'cash', ...extra });
// the branch was just REACTIVATED: identity.active === true
async function attempt(orderFields, { hours = HOURS, decision } = {}) {
  const db = makeDb({ orders: { S1: due(orderFields) }, restaurants: { marca_s: { identity: { hours, active: true } } } });
  const alerts = [];
  const deps = { db, alert: async (k, d) => alerts.push([k, d]), genToken: () => 'TOK', restaurantFallback: { lat: 1, lng: 2, name: 'R', phone: '+504' },
    ...(decision === undefined ? {} : { orderControl: async () => decision }) };
  const decided = S.releaseDecision(db.root.orders.S1, NOW, {});
  const r = await REL.releaseOne(deps, { orderId: 'S1', now: NOW, claimId: 'c1' });
  return { decided, r, order: db.root.orders.S1, alerts };
}

test('E-f copy truth: after reactivation, scheduled orders are re-reviewed automatically and SOME need the dispatcher (all four cases, real core)', async () => {
  // 1. valid → re-reviewed and released
  const ok = await attempt({});
  assert.equal(ok.decided.action, 'claim', 'the sweep re-reviews it on its own');
  assert.equal(ok.r.released, true);
  assert.equal(ok.order.status, 'new');
  assert.equal(ok.alerts.length, 0);
  // 2. paused → re-reviewed, still held: so the copy must NOT promise «se liberan solos»
  const held = await attempt({}, { decision: 'paused' });
  assert.equal(held.decided.action, 'claim');
  assert.deepEqual([held.r.released, held.r.held, held.order.status], [false, true, 'scheduled']);
  // 3a. an expired slot → blocked + a dispatcher alert («atención del despacho»)
  const expired = await attempt({ scheduled_for: NOW - 24 * 3_600_000 });
  assert.deepEqual([expired.r.released, expired.r.blocked, expired.order.scheduled_blocked, expired.order.blocked_reason], [false, true, true, 'missed_window']);
  assert.deepEqual(expired.alerts.map((a) => a[0]), ['scheduled_blocked']);
  // 3b. hours changed since booking (closed at the slot) → the same blocked path
  const closed = await attempt({}, { hours: CLOSED });
  assert.deepEqual([closed.r.blocked, closed.order.blocked_reason, closed.alerts.map((a) => a[0])], [true, 'closed_at_slot', ['scheduled_blocked']]);
  // 4. already blocked → skipped by the sweep and never re-claimed: it stays with the dispatcher
  const blocked = await attempt({ scheduled_blocked: true, blocked_reason: 'missed_window' });
  assert.deepEqual([blocked.decided.action, blocked.decided.reason], ['skip', 'blocked']);
  assert.deepEqual([blocked.r.released, blocked.r.claimed, blocked.order.status, blocked.alerts.length], [false, false, 'scheduled', 0]);
});

test('E-f is the string the portal ships (the view renders exactly this help; the false «se liberan solos» never ships)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./branches-view.js', import.meta.url), 'utf8');
  assert.equal(src.split(E_F).length - 1, 1, 'the E-f help is rendered once, verbatim');
  assert.ok(!/liberan solos|para pickup|avisa al despacho/.test(src));
});
