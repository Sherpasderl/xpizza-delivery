'use strict';
/**
 * H1c-server (PLAN-H1c, APPROVED) — the handheld push against the REAL RTDB emulator, through the DEPLOYED exports of index.js
 * (in-process via their own .run(), as test/merchant-assign-hold does) and PRODUCTION authorization: the real resolveBrand over
 * brands/ + identity fixtures, the real authorizeHandheld (codex H1c-server r1 P2-4). Messaging is stubbed at the Admin boundary
 * (Messaging.prototype.sendEach) — tests reach loopback only. Run: npm run test:merchant-push
 *   1. production authorization: an unregistered uid, a revoked row, a claim for another rid, a location with no brand membership
 *      → refused by the real callables; a registered device registers (row + index {rid, uid, epoch, seq}, the hash returned)
 *   2. codex r1 P1-1: the ownership race on REAL transactions — A claims T and pauses before its row write, B claims T → A ends
 *      'aborted', ONE owner; a late superseded row never receives (the real trigger sends only to the index owner)
 *   3. codex r1 P1-2: an E1 unregister whose index cleanup lands after an E2 re-register keeps E2's index
 *   4. reconcile through the real export: the fence before the read; pending + transition at via the indexed location query
 *   5. S2 / S3 through the real triggers: one data message per owning device + the push log; accept → one logical resolution;
 *      a marker-only reject → resolved; codex r4 reorderings; KDS and legacy orders → zero sends and zero writes
 *   6. dead token compare-and-clear on a real row + its index; a retained failure is logged with its code (no token)
 */
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

const assert = require('assert');
require('../lib/admin');
const { getDatabase } = require('firebase-admin/database');
const { Messaging } = require('firebase-admin/messaging');
const IO = require('../merchant/merchant-push-io');

// ── the Admin messaging boundary: every send the deployed code makes lands here ──
let outbox = []; let failFor = {}; let onSend = null;
Messaging.prototype.sendEach = async function (msgs) {
  outbox.push(...msgs);
  if (onSend) { const h = onSend; onSend = null; await h(msgs); }
  return { responses: msgs.map((m) => (failFor[m.token] ? { success: false, error: { code: failFor[m.token] } } : { success: true })) };
};
const fns = require('../index');

const db = getDatabase();
const T0 = Date.now();
const EP = 'epoch_abcdefghij0123'; const EP2 = 'epoch_ZYXWVUTSRQ9876';
let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);
const val = async (p) => (await db.ref(p).once('value')).val();
const dev = (uid, rid = 'tb_norte') => ({ uid, token: { handheld: true, rid } });
const call = (name, auth, data) => fns[name].run({ data, auth, rawRequest: { headers: {} } });
const codeOf = async (p) => { try { await p; return 'ok'; } catch (e) { return e.code; } };
const snap = (v) => ({ val: () => v });
const trigger = (name, oid, before, after, at) => fns[name].run({ params: { orderId: oid }, time: new Date(at).toISOString(), data: { before: snap(before), after: snap(after) } });
const order = (oid, over = {}) => ({ order_id: oid, restaurant_id: 'tb_norte', routing_reason: 'nearest', status: 'new', created_at: T0 - 9000, ...over });

// controlled interleavings on the REAL transactions: a one-shot hook awaited BEFORE the transaction on a path runs
const beforeTxn = new Map();
(() => {
  let o = Object.getPrototypeOf(db.ref('x'));
  while (o && !Object.prototype.hasOwnProperty.call(o, 'transaction')) o = Object.getPrototypeOf(o);
  const orig = o.transaction;
  o.transaction = async function (...a) {
    const path = decodeURIComponent(new URL(this.toString()).pathname).replace(/^\//, '');
    const h = beforeTxn.get(path);
    if (h) { beforeTxn.delete(path); await h(); }
    return orig.apply(this, a);
  };
})();
const gate = () => { let open; let reached; const opened = new Promise((r) => { open = r; }); const at = new Promise((r) => { reached = r; }); return { open, at, hook: async () => { reached(); await opened; } }; };

(async () => {
  // production authorization fixtures: brand membership + identity, exactly what the real resolveBrand reads (a third synthetic brand)
  await db.ref().set({
    brands: { tb: { name: 'Marca TB', active: true, locations: { tb_norte: 'member', tb_centro: 'member' }, activation: { state: 'on', since: 1 } } },
    restaurants: {
      tb_norte: { order_surface: 'handheld', identity: { brand_id: 'tb', location_name: 'Norte', prep_default_min: 18 },
        handhelds: { hh_a: { kind: 'handheld', revoked: false }, hh_b: { kind: 'handheld', revoked: false }, hh_r: { kind: 'handheld', revoked: true } } },
      tb_centro: { order_surface: 'kds', identity: { brand_id: 'tb', location_name: 'Centro', prep_default_min: 20 }, handhelds: { hh_c: { kind: 'handheld', revoked: false } } },
      tb_huerfana: { order_surface: 'handheld', identity: { brand_id: 'tb', location_name: 'Huérfana' }, handhelds: { hh_h: { kind: 'handheld', revoked: false } } },
    },
    orders: { o1: order('o1'), o2: order('o2'), o3: order('o3'), oc: order('oc', { restaurant_id: 'tb_centro' }), ol: order('ol', { routing_reason: null }) },
  });

  // 1. production authorization through the real callable
  const reg = (uid, token, epoch, rid = 'tb_norte') => call('merchantRegisterPush', dev(uid, rid), { rid, token, epoch });
  assert.strictEqual(await codeOf(call('merchantRegisterPush', null, { rid: 'tb_norte', token: 'TOKA', epoch: EP })), 'unauthenticated');
  assert.strictEqual(await codeOf(reg('hh_forged', 'TOKA', EP)), 'permission-denied', 'an unregistered uid');
  assert.strictEqual(await codeOf(reg('hh_r', 'TOKA', EP)), 'permission-denied', 'a revoked row');
  assert.strictEqual(await codeOf(call('merchantRegisterPush', dev('hh_a', 'tb_centro'), { rid: 'tb_norte', token: 'TOKA', epoch: EP })), 'permission-denied', 'a claim for another rid');
  assert.strictEqual(await codeOf(reg('hh_h', 'TOKH', EP, 'tb_huerfana')), 'permission-denied', 'a location the brand does not list (no membership)');
  assert.strictEqual(await val(`merchant_push_tokens/${IO.sha('TOKH')}`), null);
  assert.deepStrictEqual(await reg('hh_a', 'TOKA', EP), { ok: true, registered_token_hash: IO.sha('TOKA') });
  assert.deepStrictEqual(await val(`merchant_push_tokens/${IO.sha('TOKA')}`), { rid: 'tb_norte', uid: 'hh_a', epoch: EP, seq: 1 });
  assert.deepStrictEqual([await val('restaurants/tb_norte/handhelds/hh_a/fcm_token'), await val('restaurants/tb_norte/handhelds/hh_a/push_seq')], ['TOKA', 1]);
  ok('production authorization: anonymous / unregistered / revoked / foreign-rid / non-member refused by the real callable; a device registers (row + index + seq)');

  // 2. P1-1 ownership race on real transactions
  const g = gate();
  beforeTxn.set('restaurants/tb_norte/handhelds/hh_a', g.hook);                       // A's ROW write waits; its claim already committed
  const a = reg('hh_a', 'TRACE', EP);
  await g.at;
  assert.deepStrictEqual(await reg('hh_b', 'TRACE', EP2), { ok: true, registered_token_hash: IO.sha('TRACE') });
  g.open();
  assert.strictEqual(await codeOf(a), 'aborted', 'the superseded claim fails (native retries)');
  assert.strictEqual(await val('restaurants/tb_norte/handhelds/hh_a/fcm_token'), null, 'the superseded row does not keep TRACE (its stale TOKA was replaced; native retries)');
  assert.strictEqual(await val(`merchant_push_tokens/${IO.sha('TOKA')}`), null, 'A\'s previous token index went with its row write');
  assert.deepStrictEqual(await val(`merchant_push_tokens/${IO.sha('TRACE')}`), { rid: 'tb_norte', uid: 'hh_b', epoch: EP2, seq: 2 });
  // a late superseded row write (A holds TRACE under seq 1) never receives: the real trigger sends to the index owner only
  await db.ref('restaurants/tb_norte/handhelds/hh_a').update({ fcm_token: 'TRACE', push_seq: 1, push_epoch: EP });
  outbox = [];
  const s0 = await trigger('merchantPushOnStatus', 'o1', null, 'new', T0 + 100);
  assert.deepStrictEqual(outbox.map((m) => [m.token, m.data.epoch]), [['TRACE', EP2]], 'one message, to hh_b');
  assert.deepStrictEqual([s0.sent, s0.not_owned], [1, 1]);
  await reg('hh_a', 'TOKA2', EP);                                                    // A re-registers its own installation
  ok('codex r1 P1-1 on real transactions: a paused claim superseded by another → aborted, ONE owner; a late superseded row never receives');

  // 3. P1-2: E1 cleanup after an E2 re-register of the same token keeps E2's index
  const g2 = gate();
  beforeTxn.set(`merchant_push_tokens/${IO.sha('TOKA2')}`, g2.hook);                 // the unregister's INDEX cleanup waits
  const u = call('merchantUnregisterPush', dev('hh_a'), { rid: 'tb_norte', epoch: EP });
  await g2.at;
  await reg('hh_a', 'TOKA2', EP2);                                                   // the next pairing re-registers the same installation
  g2.open();
  assert.deepStrictEqual(await u, { ok: true, cleared: true });
  assert.deepStrictEqual(await val(`merchant_push_tokens/${IO.sha('TOKA2')}`), { rid: 'tb_norte', uid: 'hh_a', epoch: EP2, seq: 2 }, 'the newer claim survives');
  assert.deepStrictEqual(await call('merchantUnregisterPush', dev('hh_a'), { rid: 'tb_norte', epoch: EP }), { ok: true, cleared: false }, 'a stale epoch never unregisters');
  assert.strictEqual(await val('restaurants/tb_norte/handhelds/hh_a/fcm_token'), 'TOKA2');
  ok('codex r1 P1-2 on real transactions: an E1 index cleanup landing after an E2 re-register keeps E2; a stale epoch unregisters nothing');

  // 4. reconcile through the real export (the real indexed location query)
  await db.ref('merchant_push_log/o2').set({ new_at: T0 + 30 });
  const before = Date.now();
  const rc = await call('merchantPendingOrders', dev('hh_a'), { rid: 'tb_norte' });
  assert.ok(rc.fence >= before && rc.fence <= Date.now());
  assert.deepStrictEqual(rc.pending, [{ order_id: 'o1', at: T0 + 100 }, { order_id: 'o2', at: T0 + 30 }, { order_id: 'o3', at: T0 - 9000 }], 'legacy excluded; at = log new_at, else created_at');
  assert.strictEqual(await codeOf(call('merchantPendingOrders', dev('hh_c', 'tb_centro'), { rid: 'tb_norte' })), 'permission-denied');
  ok('reconcile via the real callable: the fence before the read; pending + transition at via the indexed location query; foreign device refused');

  // 5. S2 / S3 through the real triggers
  outbox = [];
  const s2 = await trigger('merchantPushOnStatus', 'o3', null, 'new', T0 + 200);
  assert.deepStrictEqual([s2.type, s2.sent], ['new_order', 2]);
  assert.deepStrictEqual(outbox.map((m) => [m.token, m.data.epoch, m.data.at]).sort(), [['TOKA2', EP2, String(T0 + 200)], ['TRACE', EP2, String(T0 + 200)]]);
  assert.deepStrictEqual(await val('merchant_push_log/o3'), { new_at: T0 + 200 });
  await db.ref('orders/o3').update({ status: 'preparing', handheld_answered: { kind: 'accepted' } });
  outbox = [];
  await trigger('merchantPushOnStatus', 'o3', 'new', 'preparing', T0 + 300);
  await trigger('merchantPushOnAnswered', 'o3', null, { kind: 'accepted' }, T0 + 300);
  assert.deepStrictEqual(outbox.map((m) => m.data.type), ['resolved', 'resolved'], 'one resolved per device, ONE logical resolution');
  assert.strictEqual(await val('merchant_push_log/o3'), null);
  await db.ref('orders/o2/handheld_answered').set({ kind: 'rejected' });
  outbox = [];
  assert.strictEqual((await trigger('merchantPushOnAnswered', 'o2', null, { kind: 'rejected' }, T0 + 400)).type, 'resolved', 'a marker-only reject');
  await db.ref('orders/o1/status').set('preparing');
  await trigger('merchantPushOnStatus', 'o1', 'new', 'preparing', T0 + 50);           // a delayed S3 OLDER than the entry (100)
  assert.deepStrictEqual(await val('merchant_push_log/o1'), { new_at: T0 + 100 }, 'r4: kept');
  const whole = JSON.stringify(await val('/'));
  outbox = [];
  for (const oid of ['oc', 'ol']) { await trigger('merchantPushOnStatus', oid, null, 'new', T0 + 600); await trigger('merchantPushOnStatus', oid, 'new', 'preparing', T0 + 601); }
  assert.strictEqual(outbox.length, 0);
  assert.strictEqual(JSON.stringify(await val('/')), whole, 'zero writes');
  ok('S2 / S3 through the real triggers: owners only + the push log; accept → one resolution; marker reject → resolved; r4 kept; KDS / legacy → zero sends, zero writes');

  // 6. dead token + retained failure diagnostics on real rows
  const lines = []; const warn0 = console.warn; console.warn = (l) => lines.push(String(l));
  try {
    failFor = { TRACE: 'messaging/registration-token-not-registered', TOKA2: 'messaging/invalid-argument' };
    await db.ref('orders/o1/status').set('new');
    const sd = await trigger('merchantPushOnStatus', 'o1', 'releasing', 'new', T0 + 700);
    assert.deepStrictEqual([sd.failed, sd.cleared], [2, 1]);
  } finally { console.warn = warn0; failFor = {}; }
  assert.strictEqual(await val('restaurants/tb_norte/handhelds/hh_b/fcm_token'), null, 'the dead token is cleared');
  assert.strictEqual(await val(`merchant_push_tokens/${IO.sha('TRACE')}`), null, '…with its index entry');
  assert.strictEqual(await val('restaurants/tb_norte/handhelds/hh_a/fcm_token'), 'TOKA2', 'invalid-argument retained');
  const diag = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter((x) => x && x.event === 'merchant_push');
  assert.deepStrictEqual(diag.map((d) => [d.reason, d.codes]), [['send_failed', { 'messaging/invalid-argument': 1 }]]);
  assert.ok(lines.every((l) => !/TOKA2|TRACE/.test(l) && !l.includes(IO.sha('TOKA2'))), 'no token / hash logged');
  ok('dead token compare-and-cleared with its index on real rows; a retained failure is logged with its code, never a token');

  console.log(`\nmerchant-push: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('merchant-push FAILED:', e && e.stack || e); process.exit(1); });
