'use strict';
// DRIVER C — arrived-notify.js: one valid «Llegué» tap → at most one customer notice. Synthetic tb_ fixtures, brand-agnostic
// (the routing fakes name no real restaurant). Run: node arrived-notify.test.js
const assert = require('assert');
const { notifyArrived, makeMirrorUpdater, oidOf } = require('./arrived-notify');
const { tagOf } = require('./tracking/tag');

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };
const quiet = { warn: () => {} };
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// path-map fake: nested reads, the Admin null-first transaction pass, per-path failures, and a hook that mutates the data
// just before the n-th read of a path (to flip eligibility between the first check and the recheck)
// commitAs[path](proposed, real): the server commits a DIFFERENT value than this updater proposed (a concurrent writer won) —
// the committed snapshot is what the core must verify, never its own proposal (Codex r1 P2-3)
// failTxnNth[path] = n: only the n-th transaction on that path throws (e.g. the FINAL write after a successful claim)
function fakeDb(init, { failRead = [], failTxn = [], onRead = null, commitAs = {}, failTxnNth = {} } = {}) {
  const db = { data: clone(init), writes: [], reads: {} };
  const get = (p) => p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), db.data);
  const put = (p, v) => { const ks = p.split('/'); let o = db.data; for (const k of ks.slice(0, -1)) o = o[k] = o[k] || {}; if (v === null) delete o[ks.at(-1)]; else o[ks.at(-1)] = clone(v); };
  db.ref = (p) => ({
    once: async () => {
      db.reads[p] = (db.reads[p] || 0) + 1;
      if (onRead) onRead(p, db.reads[p], db);
      if (failRead.includes(p)) throw new Error(`tb_read_failed ${p}`);
      const v = get(p); return { val: () => (v === undefined ? null : clone(v)) };
    },
    transaction: async (fn) => {
      db.txns = db.txns || {}; db.txns[p] = (db.txns[p] || 0) + 1;
      if (failTxn.includes(p) || failTxnNth[p] === db.txns[p]) throw new Error(`tb_txn_failed ${p}`);
      const real = get(p) === undefined ? null : clone(get(p));
      if (real !== null) { const spec = fn(null); if (spec === undefined) return { committed: false, snapshot: { val: () => clone(real) } }; }
      const next = fn(clone(real));
      if (next === undefined) return { committed: false, snapshot: { val: () => clone(real) } };
      if (next === null && real === null) return { committed: true, snapshot: { val: () => null } };
      if (commitAs[p]) { const won = commitAs[p](clone(next), clone(real)); put(p, won); db.writes.push(p); return { committed: true, snapshot: { val: () => clone(won) } }; }
      put(p, next); db.writes.push(p);
      return { committed: true, snapshot: { val: () => clone(next) } };
    },
  });
  db.get = get; db.put = put;
  return db;
}

const SECRET = 'tb_secret';
const OID = 'tb_o1', TID = 'tb_o1_delivery', UID = 'tb_drv_b', OTHER = 'tb_drv_a', TOKEN = 'TbTqkABCDEFG', RID = 'tb_rest', NOW = 1_800_000_000_000;
const ARR = { at: NOW - 1000, by: UID };
const IDENT = { hub_lat: 1, hub_lng: 2, delivery_radius_km: 5, version: 1, active: true, name: 'Tb Rest', phone: '+50400000000' };
// The fixture is built by the PRODUCTION writers where they exist (Codex r1 P2-3): the order / tasks / tracker node come from
// create-order-build.js buildCreateOrderUpdates (the cash-delivery combo, re-pointed at tb_ ids), the live tracker identity from
// tracking/mx-txn.js makeNodeUpdater (the recompute writer) with owner_tag = tagOf(secret, uid), the legacy shape from
// tracking/legacy-encode.js. Only the assignment + pickup transition (written by index.js / the driver client, not requirable
// here) are applied as the leaves those writers set.
const { buildCreateOrderUpdates } = require('./create-order-build');
const { COMBOS } = require('./deploy/combo-validation');
const { makeNodeUpdater } = require('./tracking/mx-txn');
const { legacyFields } = require('./tracking/legacy-encode');
function built() {
  const c = COMBOS.cash_delivery;
  const u = buildCreateOrderUpdates({ ...c.input, orderId: OID, trackingToken: TOKEN, restaurantId: RID,
    hubSnap: { ...c.snapshot, restaurant_display_name: 'Tb Rest', restaurant_name: 'Tb Rest' } });
  const order = { ...u[`orders/${OID}`], customer_name: 'Daniela', status: 'out_for_delivery', picked_up_at: NOW - 120000 };
  const task = { ...u[`tasks/${TID}`], status: 'in_progress', assigned_driver_id: UID, assigned_at: NOW - 60000, accepted_at: NOW - 59000, arrived: { ...ARR } };
  const trackerLive = makeNodeUpdater({ s: 7, derived: { mode: 'live', owner_tag: tagOf(SECRET, UID), shift_id: 's1' }, smp: { owner_tag: tagOf(SECRET, UID), shift_id: 's1' },
    name: 'Bruno', order: { status: 'out_for_delivery' } })(u[`order_tracking/${TOKEN}`]);
  return { order, task, pickup: u[`tasks/${OID}_pickup`], trackerLive, trackerBase: u[`order_tracking/${TOKEN}`] };
}
const legacyTracker = (name) => { const b = built().trackerBase; return { ...b, status: 'out_for_delivery', ...legacyFields({ mode: 'live', hasLocation: true, name }), driver_location: { lat: 15.6, lng: -88.1, at: NOW } }; };
function world(o = {}) {
  const b = built();
  return {
    tasks: { [TID]: b.task, [`${OID}_pickup`]: b.pickup },
    orders: { [OID]: b.order },
    order_tracking: { [TOKEN]: b.trackerLive },
    config: { driver_caps: { arrived_notify: true }, whatsapp_enabled: true },
    restaurants: { [RID]: { identity: IDENT } },
    drivers: {}, driver_accounts: {},
    ...o,
  };
}
{
  const b = built();
  assert.strictEqual(b.order.delivery_task_id, TID, 'premise: the production builder sets the exact delivery_task_id');
  assert.strictEqual(b.trackerLive.mx.mode, 'live', 'premise: the recompute writer produced a live claim');
  assert.strictEqual(b.trackerLive.mx.owner_tag, tagOf(SECRET, UID), 'premise: owned by the tapper');
}
function deps(o = {}) {
  const sent = [];
  const wa = {
    instanceFor: (rid) => (rid === RID ? 'default' : (rid === 'tb_rest2' ? 'tb_second' : null)),
    isEnabledForRestaurant: async () => true,
    isRoutingValid: require('./restaurant-config').isRoutingValid,
    tplArrived: (a) => ({ tpl: 'arrived', ...a }),
    sendMessage: async (to, body, rid) => { sent.push({ to, body, rid }); return { sent: 'true', id: 'tb_msg' }; },
    isSendConfirmed: require('./whatsapp').isSendConfirmed,
    ...(o.wa || {}),
  };
  return { sent, d: { wa, resolveDriverName: o.resolveDriverName || (async (db, uid) => (uid === UID ? 'Bruno' : 'Ana')), tagOf, secret: SECRET, log: quiet } };
}
const run = (db, d, a = ARR) => notifyArrived(db, { taskId: TID, arrived: a, now: NOW }, d);
const notice = (db) => db.get(`arrived_notices/${OID}`);

(async () => {
  // the happy path: one send, the mirror bound to the tapper, the final outcome
  {
    const db = fakeDb(world()); const { sent, d } = deps();
    const r = await run(db, d);
    assert.deepStrictEqual(r, { outcome: 'final', wa: 'sent', tracker: true }, 'DRVC-HAPPY outcome');
    assert.strictEqual(sent.length, 1, 'DRVC-HAPPY-ONE-SEND');
    assert.deepStrictEqual(sent[0], { to: '+50499999999', body: { tpl: 'arrived', customerName: 'Daniela', trackingToken: TOKEN, restaurantId: RID }, rid: RID }, 'DRVC-HAPPY-SEND the same validated rid goes to the template AND the sender');
    assert.deepStrictEqual(db.get(`order_tracking/${TOKEN}/arrived`), { at: ARR.at, owner_tag: tagOf(SECRET, UID), name: 'Bruno' }, 'DRVC-HAPPY-MIRROR');
    assert.deepStrictEqual(notice(db), { state: 'final', by: UID, arrival_at: ARR.at, task_id: TID, claimed_at: NOW, wa: 'sent', tracker: true, final_at: NOW }, 'DRVC-HAPPY-FINAL');
    assert.deepStrictEqual(db.get(`orders/${OID}`), world().orders[OID], 'DRVC-NO-ORDER-WRITE the order is never written');
  }
  ok('happy path: one send, mirror bound to the tapper, final {sent, tracker:true}, the order untouched');

  // every eligibility exit → ZERO writes, no send
  const exits = [
    ['cap absent', (w) => { delete w.config.driver_caps; }],
    ['cap false', (w) => { w.config.driver_caps.arrived_notify = false; }],
    ['cap malformed', (w) => { w.config.driver_caps.arrived_notify = 'true'; }],
    ['task gone', (w) => { delete w.tasks[TID]; }],
    ['arrival replaced', (w) => { w.tasks[TID].arrived = { at: NOW - 5, by: UID }; }],
    ['by ≠ owner', (w) => { w.tasks[TID].assigned_driver_id = OTHER; }],
    ['tap before assigned_at', (w) => { w.tasks[TID].assigned_at = NOW; }],
    ['tap before accepted_at (no assigned_at)', (w) => { delete w.tasks[TID].assigned_at; w.tasks[TID].accepted_at = NOW; }],
    ['task not delivery', (w) => { w.tasks[TID].type = 'pickup'; }],
    ['task order_id mismatch', (w) => { w.tasks[TID].order_id = 'tb_other'; }],
    ['wrong delivery_task_id', (w) => { w.orders[OID].delivery_task_id = 'tb_x_delivery'; }],
    ['task status pending', (w) => { w.tasks[TID].status = 'pending'; }],
    ['task completed', (w) => { w.tasks[TID].status = 'completed'; }],
    ['driver deactivated', (w) => { w.driver_accounts[UID] = { deactivated: true }; }],
    ['order gone', (w) => { delete w.orders[OID]; }],
    ['order not out_for_delivery', (w) => { w.orders[OID].status = 'preparing'; }],
    ['cancel_claim_id set', (w) => { w.orders[OID].cancel_claim_id = 'tb_c'; }],
    ['resolving_action cancel', (w) => { w.orders[OID].resolving_action = 'cancel'; }],
  ];
  for (const [label, mut] of exits) {
    const w = world(); mut(w);
    const db = fakeDb(w); const { sent, d } = deps();
    const r = await run(db, d);
    assert.strictEqual(r.outcome, 'ineligible', `DRVC-EXIT ${label} → ineligible`);
    assert.strictEqual(db.writes.length, 0, `DRVC-EXIT-NOWRITE ${label} → zero writes`);
    assert.strictEqual(sent.length, 0, `DRVC-EXIT-NOSEND ${label}`);
  }
  ok(`all ${exits.length} eligibility exits (cap, stale event, assignment time, task, deactivation, order, cancel) → zero writes, no send`);

  // legacy rows: no assigned_at / accepted_at → by === owner alone decides
  {
    const w = world(); delete w.tasks[TID].assigned_at;
    const db = fakeDb(w); const { sent, d } = deps();
    assert.strictEqual((await run(db, d)).wa, 'sent', 'DRVC-LEGACY-ROW no assignment timestamps → owner equality decides');
    assert.strictEqual(sent.length, 1, 'DRVC-LEGACY-ROW-SEND');
  }
  ok('a legacy row with no assignment timestamps rests on by === owner');

  // the cap unreadable → zero side effects; an eligibility read failure → zero side effects
  for (const p of ['config/driver_caps/arrived_notify', `tasks/${TID}`, `orders/${OID}`]) {
    const db = fakeDb(world(), { failRead: [p] }); const { sent, d } = deps();
    const r = await run(db, d);
    assert.strictEqual(r.outcome, 'read_failed', `DRVC-READFAIL ${p}`);
    assert.strictEqual(db.writes.length + sent.length, 0, `DRVC-READFAIL-ZERO ${p}`);
  }
  ok('an unreadable cap / task / order → zero side effects');

  // malformed events
  for (const [tid, a] of [[TID, null], [TID, { at: 'x', by: UID }], [TID, { at: 1, by: '' }], ['tb_o1_pickup', ARR], ['_delivery', ARR]]) {
    const db = fakeDb(world()); const { sent, d } = deps();
    const r = await notifyArrived(db, { taskId: tid, arrived: a, now: NOW }, d);
    assert.strictEqual(r.outcome, 'malformed', `DRVC-MALFORMED ${tid} ${JSON.stringify(a)}`);
    assert.strictEqual(db.writes.length + sent.length, 0, 'DRVC-MALFORMED-ZERO');
  }
  assert.strictEqual(oidOf('tb_o1_delivery'), 'tb_o1', 'DRVC-OID');
  ok('malformed events / non-delivery task ids → nothing');

  // the null-first collision: an existing claim → the optimistic proposal loses; no send, no write
  {
    const w = world(); w.arrived_notices = { [OID]: { state: 'claimed', by: OTHER, arrival_at: 5, task_id: TID, claimed_at: 5 } };
    const db = fakeDb(w); const { sent, d } = deps();
    const r = await run(db, d);
    assert.strictEqual(r.outcome, 'lost', 'DRVC-NULLFIRST the optimistic claim loses on the real value');
    assert.strictEqual(sent.length, 0, 'DRVC-NULLFIRST-NOSEND');
    assert.strictEqual(db.writes.length, 0, 'DRVC-NULLFIRST-NOWRITE (loser silence)');
    assert.deepStrictEqual(notice(db), w.arrived_notices[OID], 'DRVC-NULLFIRST-INTACT');
  }
  ok('null-first collision: an existing claim wins; the loser sends nothing and writes nothing');

  // two concurrent events (a delete + recreate replay) → ONE send
  {
    const db = fakeDb(world()); const { sent, d } = deps();
    const [a, b] = await Promise.all([run(db, d), run(db, d)]);
    assert.deepStrictEqual([a.outcome, b.outcome].sort(), ['final', 'lost'], 'DRVC-CONCURRENT one winner, one silent loser');
    assert.strictEqual(sent.length, 1, 'DRVC-CONCURRENT-ONE-SEND');
    const again = await run(db, d);
    assert.strictEqual(again.outcome, 'lost', 'DRVC-REPLAY a later replay of the same arrival is deduped by the claim');
    assert.strictEqual(sent.length, 1, 'DRVC-REPLAY-NOSEND');
  }
  ok('two concurrent events / a later replay → exactly one send (the claim is the only dedupe authority)');

  // the FULL recheck: each condition flips between the first check and the recheck → skipped, no send
  const flips = [
    ['status leaves in_progress (same owner)', (db) => db.put(`tasks/${TID}/status`, 'completed')],
    ['reassigned away and back with a newer assigned_at', (db) => db.put(`tasks/${TID}/assigned_at`, NOW)],
    ['deactivated in between', (db) => db.put(`driver_accounts/${UID}/deactivated`, true)],
    ['cancel_claim_id set in between', (db) => db.put(`orders/${OID}/cancel_claim_id`, 'tb_c')],
    ['the cap turned off in between', (db) => db.put('config/driver_caps/arrived_notify', false)],
  ];
  for (const [label, flip] of flips) {
    const db = fakeDb(world(), { onRead: (p, n, x) => { if (p === `restaurants/${RID}/identity` && n === 1) flip(x); } });
    const { sent, d } = deps();
    const r = await run(db, d);
    assert.deepStrictEqual(r, { outcome: 'final', wa: 'skipped', tracker: false }, `DRVC-RECHECK ${label} → skipped`);
    assert.strictEqual(sent.length, 0, `DRVC-RECHECK-NOSEND ${label}`);
    assert.strictEqual(db.get(`order_tracking/${TOKEN}/arrived`), undefined, `DRVC-RECHECK-NOMIRROR ${label}`);
    assert.strictEqual(notice(db).wa, 'skipped', `DRVC-RECHECK-FINAL ${label}`);
  }
  ok('the FULL recheck: every eligibility condition flipping before the send → skipped, no mirror, no send');

  // isSendConfirmed: {} / null / a throw → unconfirmed (never "not sent"), and never a resend
  for (const [label, impl] of [['{}', async () => ({})], ['null', async () => null], ['throws', async () => { throw new Error('tb'); }]]) {
    const db = fakeDb(world()); const { sent, d } = deps({ wa: { sendMessage: async (...a) => { sent.push(a); return impl(); } } });
    const r = await run(db, d);
    assert.strictEqual(r.wa, 'unconfirmed', `DRVC-UNCONFIRMED ${label}`);
    assert.strictEqual(sent.length, 1, `DRVC-NO-RESEND ${label}`);
  }
  ok('an unconfirmed provider result ({} / null / a throw) → unconfirmed, sent once, never resent');

  // routing, fail closed in THIS handler: unknown rid, no instance, invalid identity, the global flag off / unreadable,
  // a non-default instance switched off → no send (the mirror still reflects the valid arrival)
  const routes = [
    ['unknown rid (no own instance)', (w) => { w.orders[OID].restaurant_id = 'tb_unknown'; w.restaurants.tb_unknown = { identity: IDENT }; }, {}],
    ['identity not routing-valid', (w) => { w.restaurants[RID].identity = { name: 'x' }; }, {}],
    ['global flag false', (w) => { w.config.whatsapp_enabled = false; }, {}],
    ['global flag unreadable', () => {}, { failRead: ['config/whatsapp_enabled'] }],
    ['second instance switched off', (w) => { w.orders[OID].restaurant_id = 'tb_rest2'; w.restaurants.tb_rest2 = { identity: IDENT }; }, { off: true }],
  ];
  for (const [label, mut, opt] of routes) {
    const w = world(); mut(w);
    const db = fakeDb(w, { failRead: opt.failRead || [] });
    const { sent, d } = deps({ wa: opt.off ? { isEnabledForRestaurant: async () => false } : {} });
    const r = await run(db, d);
    assert.strictEqual(r.wa, 'skipped', `DRVC-ROUTE ${label} → skipped`);
    assert.strictEqual(sent.length, 0, `DRVC-ROUTE-NOSEND ${label}`);
    assert.strictEqual(r.tracker, true, `DRVC-ROUTE-MIRROR ${label} (a valid arrival still mirrors)`);
  }
  {
    const w = world(); w.orders[OID].restaurant_id = 'tb_rest2'; w.restaurants.tb_rest2 = { identity: IDENT };
    const db = fakeDb(w); const { sent, d } = deps();
    assert.strictEqual((await run(db, d)).wa, 'sent', 'DRVC-ROUTE-SECOND an enabled second instance sends');
    assert.strictEqual(sent[0].rid, 'tb_rest2', 'DRVC-ROUTE-SECOND-RID');
  }
  ok('routing fails closed (unknown rid, invalid identity, flag off / unreadable, instance off); an enabled second instance sends');

  // no customer phone → skipped
  {
    const w = world(); delete w.orders[OID].customer_phone;
    const db = fakeDb(w); const { sent, d } = deps();
    assert.strictEqual((await run(db, d)).wa, 'skipped', 'DRVC-NOPHONE'); assert.strictEqual(sent.length, 0, 'DRVC-NOPHONE-NOSEND');
  }
  ok('no customer phone → skipped');

  // THE MIRROR
  {
    // genuinely absent tracker → nothing created
    const w = world(); delete w.order_tracking;
    const db = fakeDb(w); const { d } = deps();
    const r = await run(db, d);
    assert.strictEqual(r.tracker, false, 'DRVC-MIRROR-ABSENT tracker:false');
    assert.strictEqual(db.get(`order_tracking/${TOKEN}`), undefined, 'DRVC-MIRROR-ABSENT-NOCREATE no partial public tracker');
  }
  {
    // cold cache, existing node: the first pass returns null, the re-run commits
    const up = makeMirrorUpdater({ oid: OID, arrived: ARR, expectedTag: tagOf(SECRET, UID), expectedName: 'Bruno' });
    assert.strictEqual(up(null), null, 'DRVC-MIRROR-COLDNULL the cold pass returns null (never aborts)');
  }
  const mir = [
    ['the tracker shows driver A, B taps (mx)', (w) => { w.order_tracking[TOKEN].mx.owner_tag = tagOf(SECRET, OTHER); }],
    ['mode waiting', (w) => { w.order_tracking[TOKEN].mx.mode = 'waiting'; }],
    ['mode neutral', (w) => { w.order_tracking[TOKEN].mx.mode = 'neutral'; }],
    ['order_id mismatch', (w) => { w.order_tracking[TOKEN].order_id = 'tb_other'; }],
    ['tracker not out_for_delivery', (w) => { w.order_tracking[TOKEN].status = 'delivered'; }],
    ['legacy mismatch: shows «Ana», Bruno taps', (w) => { w.order_tracking[TOKEN] = legacyTracker('Ana'); }],
    ['legacy is_active_drop false', (w) => { w.order_tracking[TOKEN] = { ...legacyTracker('Bruno'), ...legacyFields({ mode: 'waiting', hasLocation: true, name: 'Bruno' }) }; }],
  ];
  for (const [label, mut] of mir) {
    const w = world(); mut(w);
    const db = fakeDb(w); const { sent, d } = deps();
    const r = await run(db, d);
    assert.strictEqual(r.tracker, false, `DRVC-MIRROR-REFUSED ${label}`);
    assert.strictEqual(db.get(`order_tracking/${TOKEN}/arrived`), undefined, `DRVC-MIRROR-NOWRITE ${label}`);
    assert.strictEqual(sent.length, 1, `DRVC-MIRROR-SEND-INDEPENDENT ${label} (WhatsApp is independent of the mirror)`);
  }
  {
    const w = world(); w.order_tracking[TOKEN] = legacyTracker('Bruno');
    const db = fakeDb(w); const { d } = deps();
    assert.strictEqual((await run(db, d)).tracker, true, 'DRVC-MIRROR-LEGACY-MATCH');
    assert.deepStrictEqual(db.get(`order_tracking/${TOKEN}/arrived`), { at: ARR.at, owner_tag: tagOf(SECRET, UID), name: 'Bruno' }, 'DRVC-MIRROR-LEGACY-NAME the stored name is the tapper\'s');
  }
  {
    const w = world(); w.order_tracking[TOKEN] = legacyTracker('Bruno');
    const db = fakeDb(w); const { d } = deps({ resolveDriverName: async () => null });
    assert.strictEqual((await run(db, d)).tracker, false, 'DRVC-MIRROR-LEGACY-NONAME a null expected name → tracker:false');
  }
  {
    const db = fakeDb(world(), { failTxn: [`order_tracking/${TOKEN}`] }); const { sent, d } = deps();
    const r = await run(db, d);
    assert.deepStrictEqual([r.tracker, r.wa, sent.length], [false, 'sent', 1], 'DRVC-MIRROR-FAIL a mirror failure → tracker:false, the send still happens');
  }
  {
    const w = world(); delete w.orders[OID].tracking_token;
    const db = fakeDb(w); const { d } = deps();
    assert.strictEqual((await run(db, d)).tracker, false, 'DRVC-MIRROR-NOTOKEN');
  }
  ok('the mirror: absent node never created, cold pass returns null, refused for another driver / waiting / neutral / order mismatch / legacy name mismatch; legacy match stores the tapper\'s name; failures → tracker:false');

  // the stored tag is ALWAYS tagOf(secret, by) — never a copied tracker tag
  {
    const up = makeMirrorUpdater({ oid: OID, arrived: ARR, expectedTag: tagOf(SECRET, UID), expectedName: 'Bruno' });
    const next = up({ order_id: OID, status: 'out_for_delivery', mx: { mode: 'live', owner_tag: tagOf(SECRET, UID), name: 'Bruno' } });
    assert.strictEqual(next.arrived.owner_tag, tagOf(SECRET, UID), 'DRVC-TAG');
  }
  ok('the stored owner_tag is tagOf(secret, by)');

  // claim / final failures
  {
    const db = fakeDb(world(), { failTxn: [`arrived_notices/${OID}`] }); const { sent, d } = deps();
    const r = await run(db, d);
    assert.strictEqual(r.outcome, 'claim_failed', 'DRVC-CLAIMFAIL'); assert.strictEqual(sent.length, 0, 'DRVC-CLAIMFAIL-NOSEND');
  }
  {
    // the final outcome refuses when the record no longer names this arrival
    const db = fakeDb(world(), { onRead: (p, n, x) => { if (p === `restaurants/${RID}/identity` && n === 1) x.put(`arrived_notices/${OID}`, { state: 'final', by: OTHER, arrival_at: 1 }); } });
    const { d } = deps();
    await run(db, d);
    assert.deepStrictEqual(notice(db), { state: 'final', by: OTHER, arrival_at: 1 }, 'DRVC-FINAL-MISMATCH another arrival\'s record is never overwritten');
  }
  ok('a claim failure → no send; the final outcome never overwrites a record naming another arrival');

  // ── Codex r1 P2-1: the EXACT task pointer — absent / malformed → skip, at the first check AND at the recheck ──
  for (const bad of [undefined, null, '', false, 0, 'tb_o1_pickup']) {
    const w = world(); if (bad === undefined) delete w.orders[OID].delivery_task_id; else w.orders[OID].delivery_task_id = bad;
    const db = fakeDb(w); const { sent, d } = deps();
    const r = await run(db, d);
    assert.strictEqual(r.outcome, 'ineligible', `DRVC-POINTER first check: delivery_task_id ${JSON.stringify(bad)} → skip`);
    assert.strictEqual(db.writes.length + sent.length, 0, `DRVC-POINTER-ZERO ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, '', false, 0]) {
    const db = fakeDb(world(), { onRead: (p, n, x) => { if (p === `restaurants/${RID}/identity` && n === 1) x.put(`orders/${OID}/delivery_task_id`, bad); } });
    const { sent, d } = deps();
    const r = await run(db, d);
    assert.deepStrictEqual(r, { outcome: 'final', wa: 'skipped', tracker: false }, `DRVC-POINTER recheck: delivery_task_id → ${JSON.stringify(bad)} → skipped`);
    assert.strictEqual(sent.length, 0, `DRVC-POINTER-RECHECK-NOSEND ${JSON.stringify(bad)}`);
  }
  ok('the exact task pointer: absent / null / "" / false / 0 / another task → skip at the first check AND at the recheck');

  // ── Codex r1 P2-2: no valid tracking token → NO send (never «/undefined»), no mirror; the driver keeps the contact fallback ──
  for (const bad of [undefined, null, '', 'tb_tok', 'a/b/c', 'TbTqkABCDEFG'.padEnd(70, 'x'), 12345678,
    'ABCDEF', 'AAAAAAAAAAAAA', '000000000000', 'undefined', 'null', 'TbTok1234567', 'TbTqkABCDEF', 'TbTqkABCDEFGH', 'TbTqkABCDEF0', 'TbTqkABCDEFl', 'TbTqkABCDEF_']) {
    const w = world(); if (bad === undefined) delete w.orders[OID].tracking_token; else w.orders[OID].tracking_token = bad;
    const db = fakeDb(w); const { sent, d } = deps();
    const r = await run(db, d);
    assert.strictEqual(r.wa, 'skipped', `DRVC-TOKEN ${JSON.stringify(bad)} → no send`);
    assert.strictEqual(sent.length, 0, `DRVC-TOKEN-NOSEND ${JSON.stringify(bad)}`);
    assert.strictEqual(r.tracker, false, `DRVC-TOKEN-NOMIRROR ${JSON.stringify(bad)}`);
  }
  {
    // and with the REAL template: a valid token is in the link; the link never ends in /undefined
    const W = require('./whatsapp');
    const db = fakeDb(world()); const { sent, d } = deps({ wa: { tplArrived: W.tplArrived } });
    await run(db, d);
    const text = W.renderTemplate(sent[0].body, null);
    assert.ok(text.endsWith(`/${TOKEN}`), 'DRVC-TOKEN-LINK the real template carries the order\'s token');
    assert.doesNotMatch(text, /undefined|null/, 'DRVC-TOKEN-LINK-CLEAN');
  }
  {
    const { validToken, TOKEN_ALPHABET } = require('./arrived-notify');
    assert.strictEqual(validToken(TOKEN), true, 'DRVC-TOKEN-FIXTURE premise: the fixture is a REAL-generator-shaped token');
    for (let i = 0; i < 200; i++) {   // the generator's own algorithm (index.js generateTrackingToken), reproduced: always valid
      const bytes = require('crypto').randomBytes(12); let t = ''; for (let k = 0; k < 12; k++) t += TOKEN_ALPHABET[bytes[k] % TOKEN_ALPHABET.length];
      assert.strictEqual(validToken(t), true, `DRVC-TOKEN-GEN ${t}`);
    }
  }
  ok('no valid tracking token (absent / null / "" / bad shape / too long / non-string) → no send and no mirror; the real template links the token');

  // ── Codex r1 P2-3: the COMMITTED snapshot decides, never this updater's proposal ──
  {
    // the claim: a concurrent claim committed instead (another by / another arrival_at) → lost: no send, no final write
    for (const [label, mut] of [['by', (v) => ({ ...v, by: OTHER })], ['arrival_at', (v) => ({ ...v, arrival_at: ARR.at - 1 })], ['state', (v) => ({ ...v, state: 'final' })]]) {
      const db = fakeDb(world(), { commitAs: { [`arrived_notices/${OID}`]: (proposed) => mut(proposed) } });
      const { sent, d } = deps();
      const r = await run(db, d);
      assert.strictEqual(r.outcome, 'lost', `DRVC-CLAIM-SNAP committed ${label} differs → lost`);
      assert.strictEqual(sent.length, 0, `DRVC-CLAIM-SNAP-NOSEND ${label}`);
      assert.strictEqual(db.get(`order_tracking/${TOKEN}/arrived`), undefined, `DRVC-CLAIM-SNAP-NOMIRROR ${label}`);
    }
  }
  {
    // the mirror: the committed tracker carries a different arrival (at / owner_tag) → tracker:false (the send is independent)
    for (const [label, mut] of [['at', (v) => ({ ...v, arrived: { ...v.arrived, at: v.arrived.at + 1 } })], ['owner_tag', (v) => ({ ...v, arrived: { ...v.arrived, owner_tag: 'tb_other_tag' } })], ['no arrival', (v) => { const x = { ...v }; delete x.arrived; return x; }]]) {
      const db = fakeDb(world(), { commitAs: { [`order_tracking/${TOKEN}`]: (proposed) => mut(proposed) } });
      const { sent, d } = deps();
      const r = await run(db, d);
      assert.strictEqual(r.tracker, false, `DRVC-MIRROR-SNAP committed ${label} differs → tracker:false`);
      assert.strictEqual(sent.length, 1, `DRVC-MIRROR-SNAP-SEND ${label}`);
    }
    // legacy: the committed tracker names someone else → tracker:false
    const w = world(); w.order_tracking[TOKEN] = legacyTracker('Bruno');
    const db = fakeDb(w, { commitAs: { [`order_tracking/${TOKEN}`]: (proposed) => ({ ...proposed, arrived: { ...proposed.arrived, name: 'Ana' } }) } });
    const { d } = deps();
    assert.strictEqual((await run(db, d)).tracker, false, 'DRVC-MIRROR-SNAP-LEGACY committed legacy name differs → tracker:false');
  }
  {
    // the FINAL write fails after a successful claim + send: no throw, sent exactly once, the record stays `claimed` (residual)
    const db = fakeDb(world(), { failTxnNth: { [`arrived_notices/${OID}`]: 2 } });
    const { sent, d } = deps();
    const r = await run(db, d);
    assert.strictEqual(sent.length, 1, 'DRVC-FINAL-FAIL sent exactly once');
    assert.strictEqual(r.wa, 'sent', 'DRVC-FINAL-FAIL-OUTCOME');
    assert.strictEqual(notice(db).state, 'claimed', 'DRVC-FINAL-FAIL-CLAIMED the record stays claimed — the driver shows no banner (contact fallback)');
  }
  ok('the committed snapshot decides: a claim / mirror committed with another by, arrival_at, at, owner_tag or legacy name never counts as won / mirrored; a final-write failure keeps the claim and never resends');

  console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
