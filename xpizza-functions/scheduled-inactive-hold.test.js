'use strict';
// ORCHESTRATION O1a (PLAN-multi-location-orchestration r3.1 §5) — the scheduled-release INACTIVE hold. Run: node scheduled-inactive-hold.test.js
//   1. PARITY: for every branch that is NOT `identity.active === false` (active true, field absent, identity absent, malformed,
//      read failure) every path — open → release, bad hours → scheduled_blocked + alert, paused / unavailable → control hold —
//      produces byte-identical writes, final state and alerts to the BASE module (this file's source with the O1a inverse
//      applied, compiled in place), for cash and a captured card.
//   2. INACTIVE → hold: the claim rolled back by the SAME function the pause hold uses (releasing → scheduled, ownership
//      cleared), no materialization, no scheduled_blocked even with bad hours, ONE create-only dispatcher alert
//      scheduled_inactive_{orderId}; deps.alert is never called. A paused AND inactive branch → today's pause hold, no alert.
//   3. Every entry point (releaseOne, recoverStaleReleasing) holds; reactivation → the next attempt releases normally.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const REL = require('./scheduled-release-core');
const { unapplyOrchO1aModule } = require('./tools/orch-o1a-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FILE = path.join(__dirname, 'scheduled-release-core.js');
const compile = (src) => { const m = new Module(FILE, module); m.filename = FILE; m.paths = Module._nodeModulePaths(__dirname); m._compile(src, FILE); return m.exports; };
const BASE = compile(unapplyOrchO1aModule('scheduled-release-core.js', fs.readFileSync(FILE, 'utf8')));

function makeDb(initial = {}, { throwOn = null } = {}) {
  const root = JSON.parse(JSON.stringify(initial));
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const ops = [];
  const getAt = (p) => { if (!p) return root; let x = root; for (const k of p.split('/')) { if (x == null) return null; x = x[k]; } return x === undefined ? null : x; };
  const setAt = (p, val) => { const a = p.split('/'); let x = root; for (let i = 0; i < a.length - 1; i++) { if (x[a[i]] == null || typeof x[a[i]] !== 'object') x[a[i]] = {}; x = x[a[i]]; } if (val === null) delete x[a[a.length - 1]]; else x[a[a.length - 1]] = val; };
  const ref = (p = '') => ({
    async once() { ops.push(['once', p]); if (throwOn === p) throw new Error('read failed'); return { val: () => clone(getAt(p)) }; },
    async transaction(fn) { ops.push(['transaction', p]); fn(null); const cur = clone(getAt(p)); const nx = fn(cur); if (nx === undefined) return { committed: false, snapshot: { val: () => cur } }; setAt(p, clone(nx)); return { committed: true, snapshot: { val: () => clone(getAt(p)) } }; },
    async update(patch) { ops.push(['update', p, JSON.stringify(patch)]); if (!p) { for (const [k, v] of Object.entries(patch)) setAt(k, clone(v)); return; } for (const [k, v] of Object.entries(patch)) setAt(`${p}/${k}`, clone(v)); },
  });
  return { ref, getAt, ops, root };
}

const NOW = 1_800_000_000_000;
const OPEN = { open: true, start: '00:00', end: '23:59' };
const HOURS = { sun: OPEN, mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN };
const CLOSED = { sun: { open: false }, mon: { open: false }, tue: { open: false }, wed: { open: false }, thu: { open: false }, fri: { open: false }, sat: { open: false } };
const CASH = { payment_method: 'cash' };
const CARD = { payment_method: 'online', payment_status: 'confirmed', charged_at: NOW - 86_400_000 };
const order = (pay, extra = {}) => ({ order_id: 'S1', restaurant_id: 'tb_rel', status: 'releasing', release_claim_id: 'c1', releasing_since: NOW - 5, scheduled_for: NOW + 3_600_000,
  release_at: NOW - 1, order_type: 'delivery', total: 100, customer_name: 'Ana', ...pay, ...extra });
const deps = (db, decision, alerts) => ({ db, alert: async (k, d) => alerts.push([k, d]), genToken: () => 'TOK', restaurantFallback: { lat: 1, lng: 2, name: 'R', phone: '+504' },
  ...(decision === undefined ? {} : { orderControl: async () => decision }) });

async function run(mod, init, { decision, throwOn, entry = 'finalize' } = {}) {
  const db = makeDb(init, { throwOn }); const alerts = [];
  const d = deps(db, decision, alerts);
  let r;
  if (entry === 'finalize') r = await mod.finalizeRelease(d, 'S1', db.getAt('orders/S1'), NOW);
  else if (entry === 'releaseOne') r = await mod.releaseOne(d, { orderId: 'S1', now: NOW, claimId: 'c2' });
  else r = await mod.recoverStaleReleasing(d, { orderId: 'S1', now: NOW, claimId: 'c3', cfg: {} });
  return { r, state: db.root, writes: db.ops.filter((o) => o[0] !== 'once'), reads: db.ops.filter((o) => o[0] === 'once').map((o) => o[1]), alerts };
}

(async () => {
  // ── 1. parity with the base module for every non-inactive branch ──
  const identities = {
    'active:true': (h) => ({ hours: h, active: true }),
    'active absent': (h) => ({ hours: h }),
    'active malformed': (h) => ({ hours: h, active: 'false' }),
    'identity absent': () => null,
  };
  let cases = 0;
  for (const [pname, pay] of [['cash', CASH], ['card', CARD]]) {
    for (const [iname, mk] of Object.entries(identities)) {
      for (const [hname, hours] of [['open', HOURS], ['bad hours', CLOSED]]) {
        for (const decision of [undefined, null, 'paused', 'unavailable']) {
          const id = mk(hours);
          const init = { orders: { S1: order(pay) }, ...(id ? { restaurants: { tb_rel: { identity: id } } } : {}) };
          const a = await run(BASE, init, { decision }); const b = await run(REL, init, { decision });
          const label = `${pname} / ${iname} / ${hname} / control ${decision}`;
          assert.deepStrictEqual(b.r, a.r, `${label}: result`);
          assert.deepStrictEqual(b.state, a.state, `${label}: final state`);
          assert.deepStrictEqual(b.writes, a.writes, `${label}: writes (byte-identical patches, same order)`);
          assert.deepStrictEqual(b.alerts, a.alerts, `${label}: alerts`);
          cases += 1;
        }
      }
    }
    // an unreadable `active` → today's path
    for (const hours of [HOURS, CLOSED]) {
      const init = { orders: { S1: order(pay) }, restaurants: { tb_rel: { identity: { hours, active: false } } } };
      const a = await run(BASE, init, {}); const b = await run(REL, init, { throwOn: 'restaurants/tb_rel/identity/active' });
      assert.deepStrictEqual([b.r, b.state, b.writes, b.alerts], [a.r, a.state, a.writes, a.alerts], `${pname}: active read failure → today's behaviour`);
      cases += 1;
    }
  }
  ok(`PARITY: ${cases} cases (cash + captured card × active true / absent / malformed / identity absent / unreadable × open / bad hours × no control / open / paused / unavailable) — result, final state, every write and every alert byte-identical to the base module`);

  // ── 2. inactive → hold ──
  for (const [pname, pay] of [['cash', CASH], ['card', CARD]]) {
    for (const hours of [HOURS, CLOSED]) {
      const init = { orders: { S1: order(pay, { scheduled_blocked: undefined }) }, restaurants: { tb_rel: { identity: { hours, active: false } } } };
      const b = await run(REL, init, { decision: null });
      assert.deepStrictEqual(b.r, { released: false, blocked: false, held: true, cause: 'inactive' });
      const o = b.state.orders.S1;
      assert.strictEqual(o.status, 'scheduled'); assert.ok(o.release_claim_id === undefined && o.releasing_since === undefined, 'release ownership cleared');
      assert.ok(o.scheduled_blocked === undefined && o.control_held === undefined, 'no scheduled_blocked (even with bad hours), no control marker');
      assert.strictEqual(o.tracking_token, undefined, 'no materialization');
      if (pay === CARD) assert.strictEqual(o.charged_at, CARD.charged_at, 'the captured card is untouched');
      assert.deepStrictEqual(b.writes, [
        ['update', 'orders/S1', JSON.stringify({ status: 'scheduled', release_claim_id: null, releasing_since: null })],
        ['transaction', 'dispatcher_alerts/scheduled_inactive_S1'],
      ], `${pname}: the pause rollback's exact patch + ONE alert`);
      assert.deepStrictEqual(b.state.dispatcher_alerts, { scheduled_inactive_S1: { type: 'scheduled_inactive', order_id: 'S1', restaurant_id: 'tb_rel', created_at: NOW } });
      assert.deepStrictEqual(b.alerts, [], 'deps.alert never called');
      assert.ok(!b.reads.includes('restaurants/tb_rel/identity/hours'), 'decided BEFORE the hours read');
    }
  }
  {
    const init = { orders: { S1: order(CASH) }, restaurants: { tb_rel: { identity: { hours: HOURS, active: false } } }, dispatcher_alerts: { scheduled_inactive_S1: { type: 'scheduled_inactive', order_id: 'S1', restaurant_id: 'tb_rel', created_at: 5 } } };
    const b = await run(REL, init, {});
    assert.strictEqual(b.state.dispatcher_alerts.scheduled_inactive_S1.created_at, 5, 'create-only: a repeat hold keeps the first alert');
  }
  {
    const init = { orders: { S1: order(CASH) }, restaurants: { tb_rel: { identity: { hours: HOURS, active: false } } } };
    const a = await run(BASE, init, { decision: 'paused' }); const b = await run(REL, init, { decision: 'paused' });
    assert.deepStrictEqual([b.r, b.state, b.writes, b.alerts], [a.r, a.state, a.writes, a.alerts], 'paused AND inactive → today\'s pause hold');
    assert.ok(!b.reads.includes('restaurants/tb_rel/identity/active'), 'pause returns before the active read');
  }
  ok('INACTIVE → hold: claim rolled back with the pause path\'s exact patch, no materialization / no scheduled_blocked (even with bad hours) / card untouched, ONE create-only alert, deps.alert unused; paused AND inactive → today\'s pause hold (no alert)');

  // ── 3. entry points + reactivation ──
  {
    const sched = (extra) => ({ ...order(CASH, extra), status: 'scheduled', release_claim_id: undefined, releasing_since: undefined });
    let b = await run(REL, { orders: { S1: sched() }, restaurants: { tb_rel: { identity: { hours: HOURS, active: false } } } }, { entry: 'releaseOne' });
    assert.strictEqual(b.r.cause, 'inactive'); assert.strictEqual(b.state.orders.S1.status, 'scheduled');
    b = await run(REL, { orders: { S1: { ...order(CASH), releasing_since: NOW - 3_600_000 } }, restaurants: { tb_rel: { identity: { hours: HOURS, active: false } } } }, { entry: 'recover' });
    assert.deepStrictEqual([b.r.recovered, b.r.cause, b.state.orders.S1.status], [true, 'inactive', 'scheduled'], 'stale-claim recovery holds too');
    const st = b.state; st.restaurants.tb_rel.identity.active = true;
    const again = await run(REL, st, { entry: 'releaseOne' });
    assert.strictEqual(again.r.released, true, 'reactivated → the next attempt releases normally');
    assert.strictEqual(again.state.orders.S1.status, 'new');
  }
  ok('entry points: releaseOne and stale-claim recovery hold an inactive branch; after reactivation the next attempt releases normally');

  console.log(`\nscheduled-inactive-hold: OK (${n})`);
})().catch((e) => { console.error('scheduled-inactive-hold FAILED:', e && e.stack || e); process.exit(1); });
