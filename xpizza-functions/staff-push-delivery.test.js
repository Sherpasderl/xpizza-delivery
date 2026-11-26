'use strict';
// S2 delivery proof (PLAN-brand-agnostic-convergence r9 §3-S, #334-4; Codex #414 P2-1): the REAL triggers — notifyStaffOnNewOrder,
// flushStaffPushQueue, sweepStuckOrders (index.js exports, in-process) — through the REAL fanoutStaffPush → sendStaffPush, over the
// honest RTDB model; every push is captured at the send seam (web-push sendNotification). Subscribers: a current dispatcher, a
// merchant account, a driver account, a REVOKED dispatcher (dispatchers/{uid} removed), and — in DLV-FAIL-CLOSED — a dispatcher whose
// membership read fails.
//   DLV-NEWORDER / DLV-FLUSH / DLV-STUCK  each trigger pushes to the current dispatcher ONLY
//   DLV-REVOKED       the revoked dispatcher receives nothing, and its subscription (like the merchant's / driver's) is pruned
//   DLV-FAIL-CLOSED   an unreadable membership: no push, and the subscription is kept
//   DLV-REJECTED-SEND           a non-terminal send failure logs its line (asserted to EXECUTE): status + category only
//   DLV-REJECTED-LIST-READ-*    the staff_push list read rejects (its error message carries ids): each trigger's catch line EXECUTES
//                               (notifyStaffOnNewOrder / flushStaffPushQueue / sweepStuckOrders), with no id and no message
//   DLV-B3-LABEL / DLV-B3-BUFFER / DLV-B3-GROUPED  (B3, audit G4) a THIRD restaurant's order is labelled by ITS identity
//                     display_name (never «X. Pizza»), buffered under its own id, and the grouped follow-up (a legacy buffer + the
//                     third restaurant) names each restaurant by its identity label
//   DLV-B3-MIXED      (Codex #421) a mixed-version deploy: B3 appends → the PRIOR (S2, 17f93d535) flusher sends → B3 appends → B3 flushes;
//                     and the reverse (the S2 notifier appends → B3 flushes): every count is sent exactly once, no id is lost
//   DLV-LOGS          no captured staff-push log line (fan-out, send, revocation, the three trigger catches) carries a uid or an order id
// Run: node staff-push-delivery.test.js
for (const k of ['FUNCTION_TARGET', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) delete process.env[k];
const assert = require('assert');
const WATCHDOG = setTimeout(() => { console.error('staff-push-delivery: FAILED — watchdog (20 s)'); process.exit(1); }, 20000);
const { makeHonestDb } = require('./_honest-rtdb-model');

// the send seam: index.js's `webpush` IS this module object
const sends = [];
const webpush = require('web-push');
let SEND_FAIL = null;   // a cell sets an error the send seam rejects with
const bodies = [];
webpush.sendNotification = async (sub, payload) => { sends.push(sub.endpoint); try { bodies.push(JSON.parse(payload).body); } catch (_) { bodies.push(null); } if (SEND_FAIL) throw SEND_FAIL; return { statusCode: 201 }; };
let DB = null;
const dbMod = require('firebase-admin/database');
dbMod.getDatabase = () => DB;   // BEFORE index.js destructures it
const idx = require('./index.js');

let n = 0; const fails = [];
async function cell(label, fn) { try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
const EP = (uid) => `https://push.example/${uid}`;
const SUB = (uid) => ({ subscription: { endpoint: EP(uid), keys: { p256dh: 'p', auth: 'a' } }, updated_at: 1 });
const UIDS = { disp: 'u_disp_current_00001', merch: 'u_merchant_acct_0001', drv: 'u_driver_acct_000001', revoked: 'u_disp_revoked_00001' };
const OID = 'XPZ-ORDER-SECRET-77';
const world = (extra = {}) => ({
  dispatchers: { [UIDS.disp]: true },                                    // the revoked dispatcher's entry is already removed
  staff_push: { [UIDS.disp]: SUB(UIDS.disp), [UIDS.merch]: SUB(UIDS.merch), [UIDS.drv]: SUB(UIDS.drv), [UIDS.revoked]: SUB(UIDS.revoked) },
  config: { push: { coalesce_window_ms: 60000 } },
  ...extra,
});
const read = async (p) => (await DB.ref(p).once('value')).val();
const snap = (v) => ({ val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))), exists: () => v != null });
const capture = () => { const out = []; const o = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error']) console[k] = (...a) => { out.push(a.map(String).join(' ')); };
  return { out, done: () => Object.assign(console, o) }; };
const ALL_LOGS = [];
async function run(fn) { sends.length = 0; bodies.length = 0; const c = capture(); try { await fn(); } finally { c.done(); ALL_LOGS.push(...c.out); } return [...sends]; }

(async () => {
  assert.strictEqual(typeof idx.notifyStaffOnNewOrder.run, 'function', 'premise: the real triggers');
  await cell('DLV-NEWORDER: an order turning live pushes to the current dispatcher ONLY', async (L) => {
    DB = makeHonestDb(world());
    const after = { status: 'new', payment_method: 'cash', restaurant_id: 'x_pizza', customer_name: 'Ana', display_number: 7, created_at: Date.now() };
    const got = await run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(after) }, params: { orderId: OID } }));
    assert.deepStrictEqual(got, [EP(UIDS.disp)], `🔴 ${L}: ${JSON.stringify(got)}`);
  });
  await cell('DLV-FLUSH: the grouped follow-up pushes to the current dispatcher ONLY', async (L) => {
    DB = makeHonestDb(world({ staff_push_state: { last_sent_at: 1, pending: { x_pizza: 2, la_musa: 1, ids: ['a', 'b', 'c'] } } }));
    const got = await run(() => idx.flushStaffPushQueue.run({}));
    assert.deepStrictEqual(got, [EP(UIDS.disp)], `🔴 ${L}: ${JSON.stringify(got)}`);
  });
  await cell('DLV-STUCK: a stuck-order alert pushes to the current dispatcher ONLY', async (L) => {
    DB = makeHonestDb(world({ orders: { [OID]: { status: 'ready', order_type: 'delivery', restaurant_id: 'x_pizza', customer_name: 'Ana', created_at: Date.now() - 3600000 } } }));
    const got = await run(() => idx.sweepStuckOrders.run({}));
    assert.deepStrictEqual(got, [EP(UIDS.disp)], `🔴 ${L}: ${JSON.stringify(got)}`);
  });
  await cell('DLV-REVOKED: the revoked dispatcher receives nothing; its (and the merchant\'s / driver\'s) subscription is pruned', async (L) => {
    DB = makeHonestDb(world());
    const after = { status: 'new', payment_method: 'cash', restaurant_id: 'x_pizza', customer_name: 'Ana', created_at: Date.now() };
    const got = await run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(after) }, params: { orderId: OID } }));
    assert.ok(!got.includes(EP(UIDS.revoked)), `🔴 ${L}: the revoked dispatcher was pushed`);
    assert.deepStrictEqual(Object.keys((await read('staff_push')) || {}).sort(), [UIDS.disp], `🔴 ${L}: only the current dispatcher's subscription remains`);
  });
  await cell('DLV-FAIL-CLOSED: an unreadable membership check — no push, subscription kept', async (L) => {
    DB = makeHonestDb(world({ dispatchers: { [UIDS.disp]: true, [UIDS.revoked]: true } }), { beforeRead: async (p) => { if (p === `dispatchers/${UIDS.revoked}`) throw new Error('unavailable'); } });
    const after = { status: 'new', payment_method: 'cash', restaurant_id: 'x_pizza', customer_name: 'Ana', created_at: Date.now() };
    const got = await run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(after) }, params: { orderId: OID } }));
    assert.deepStrictEqual(got, [EP(UIDS.disp)], `🔴 ${L}: ${JSON.stringify(got)}`);
    assert.deepStrictEqual(await read(`staff_push/${UIDS.revoked}`), SUB(UIDS.revoked), `🔴 ${L}: an unknown is never deleted`);
  });
  const live = { status: 'new', payment_method: 'cash', restaurant_id: 'x_pizza', customer_name: 'Ana', created_at: Date.now() };
  const lines = (from) => ALL_LOGS.slice(from);
  await cell('DLV-REJECTED-SEND: a non-terminal send failure logs its line — status + category only', async (L) => {
    DB = makeHonestDb(world()); SEND_FAIL = Object.assign(new Error(`push failed for ${UIDS.disp} ${OID}`), { statusCode: 500 }); const from = ALL_LOGS.length;
    try { await run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(live) }, params: { orderId: OID } })); } finally { SEND_FAIL = null; }
    assert.ok(lines(from).includes('sendStaffPush: failed status=500 (neworder)'), `🔴 ${L}: the failed-send line executed, redacted (${JSON.stringify(lines(from))})`);
  });
  const listReadFails = (extra = {}) => makeHonestDb(world(extra), { beforeRead: async (p) => { if (p === 'staff_push') throw Object.assign(new Error(`read failed at /staff_push for ${UIDS.disp} order ${OID}`), { code: 'unavailable' }); } });
  await cell('DLV-REJECTED-LIST-READ-NEW: notifyStaffOnNewOrder\'s catch line executes, with no id and no message', async (L) => {
    DB = listReadFails(); const from = ALL_LOGS.length;
    await run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(live) }, params: { orderId: OID } }));
    assert.ok(lines(from).includes('notifyStaffOnNewOrder: fanout failed unavailable'), `🔴 ${L}: ${JSON.stringify(lines(from))}`);
  });
  await cell('DLV-REJECTED-LIST-READ-FLUSH: flushStaffPushQueue\'s catch line executes, with no message', async (L) => {
    DB = listReadFails({ staff_push_state: { last_sent_at: 1, pending: { x_pizza: 1, la_musa: 0, ids: ['a'] } } }); const from = ALL_LOGS.length;
    await run(() => idx.flushStaffPushQueue.run({}));
    assert.ok(lines(from).includes('flushStaffPushQueue: fanout failed unavailable'), `🔴 ${L}: ${JSON.stringify(lines(from))}`);
  });
  await cell('DLV-REJECTED-LIST-READ-STUCK: sweepStuckOrders\'s catch line executes, with no id and no message', async (L) => {
    DB = listReadFails({ orders: { [OID]: { status: 'ready', order_type: 'delivery', restaurant_id: 'x_pizza', customer_name: 'Ana', created_at: Date.now() - 3600000 } } }); const from = ALL_LOGS.length;
    await run(() => idx.sweepStuckOrders.run({}));
    assert.ok(lines(from).includes('sweepStuckOrders: fanout failed unavailable'), `🔴 ${L}: ${JSON.stringify(lines(from))}`);
  });
  const ID = { x_pizza: { display_name: 'X. Pizza' }, tb_third: { display_name: 'Tercera Casa' } };
  const third = { status: 'new', payment_method: 'cash', restaurant_id: 'tb_third', customer_name: 'Ana', display_number: 9, created_at: Date.now() };
  await cell('DLV-B3-LABEL: a third restaurant\'s new order is labelled by ITS identity display_name', async (L) => {
    DB = makeHonestDb(world({ restaurants: { x_pizza: { identity: ID.x_pizza }, tb_third: { identity: ID.tb_third } } }));
    await run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(third) }, params: { orderId: 'o3rd' } }));
    assert.deepStrictEqual(bodies, ['Tercera Casa · #9 · Ana'], `🔴 ${L}: ${JSON.stringify(bodies)}`);
  });
  await cell('DLV-B3-BUFFER: inside the window, the third restaurant is buffered under its OWN id', async (L) => {
    DB = makeHonestDb(world({ staff_push_state: { last_sent_at: Date.now(), pending: { x_pizza: 1, ids: ['old'] } }, restaurants: { tb_third: { identity: ID.tb_third } } }));
    const got = await run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(third) }, params: { orderId: 'o3rd' } }));
    assert.deepStrictEqual(got, [], `${L}: premise, buffered (no push)`);
    const p = (await read('staff_push_state')).pending;
    assert.deepStrictEqual(p, { x_pizza: 1, tb_third: 1, ids: ['old', 'o3rd'] }, `🔴 ${L}: the FLAT buffer (today's shape): ${JSON.stringify(p)}`);
  });
  await cell('DLV-B3-GROUPED: the grouped follow-up (legacy buffer + a third restaurant) names each by its identity label', async (L) => {
    DB = makeHonestDb(world({ staff_push_state: { last_sent_at: 1, pending: { x_pizza: 1, tb_third: 2, ids: ['a', 'b', 'c'] } }, restaurants: { x_pizza: { identity: ID.x_pizza }, tb_third: { identity: ID.tb_third } } }));
    await run(() => idx.flushStaffPushQueue.run({}));
    assert.deepStrictEqual(bodies, ['2 Tercera Casa · 1 X. Pizza'], `🔴 ${L}: ${JSON.stringify(bodies)}`);
  });
  await cell('DLV-B3-MIXED: B3 ↔ the prior S2 code over one buffer — every count sent exactly once, no id lost', async (L) => {
    const cp = require('child_process'); const os = require('os'); const path = require('path'); const fs = require('fs');
    const PRIOR = '17f93d53546368ba5c5d62e540b4d99a4e776099';
    const show = (p) => cp.execFileSync('git', ['show', `${PRIOR}:xpizza-functions/${p}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
    const T1 = path.join(__dirname, 'index.prior-s2.tmp.js'); const T2 = path.join(__dirname, 'staff-push.prior-s2.tmp.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-mixed-'));
    fs.writeFileSync(T1, show('index.js').split("require('./staff-push')").join("require('./staff-push.prior-s2.tmp.js')")); fs.writeFileSync(T2, show('staff-push.js'));
    const prior = (mode, ev) => {   // run one PRIOR trigger over the current world; the world continues from its result
      const w = path.join(dir, `w${Math.random()}.json`), o = `${w}.out`; fs.writeFileSync(w, JSON.stringify(DB.root));
      const args = [path.join(__dirname, 'test', '_prior-staff-push-run.js'), mode, w, o]; if (ev) { fs.writeFileSync(`${w}.ev`, JSON.stringify(ev)); args.push(`${w}.ev`); }
      const r = cp.spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', timeout: 30000 });
      assert.strictEqual(r.status, 0, `${L}: the prior ${mode} ran (${(r.stderr || '').slice(0, 200)})`);
      const out = JSON.parse(fs.readFileSync(o, 'utf8')); DB = makeHonestDb(out.root); return out.bodies;
    };
    const order = (rid) => ({ status: 'new', payment_method: 'cash', restaurant_id: rid, customer_name: 'Ana', created_at: Date.now() });
    const b3notify = (rid, oid) => run(() => idx.notifyStaffOnNewOrder.run({ data: { before: snap(null), after: snap(order(rid)) }, params: { orderId: oid } }));
    const openWindow = async () => DB.ref('staff_push_state/last_sent_at').set(Date.now());   // inside the window ⇒ buffer
    const closeWindow = async () => DB.ref('staff_push_state/last_sent_at').set(1);           // past the window ⇒ flush
    try {
      DB = makeHonestDb(world({ restaurants: { x_pizza: { identity: { display_name: 'X. Pizza' } }, la_musa: { identity: { display_name: 'La Musa' } } } }));
      // B3 appends → the PRIOR flusher
      await openWindow(); await b3notify('x_pizza', 'o1'); await b3notify('la_musa', 'o2');
      assert.deepStrictEqual((await read('staff_push_state')).pending, { x_pizza: 1, la_musa: 1, ids: ['o1', 'o2'] }, `${L}: premise, B3 wrote the flat buffer`);
      await closeWindow(); const s2Bodies = prior('flush');
      assert.deepStrictEqual(s2Bodies, ['1 X. Pizza · 1 La Musa'], `🔴 ${L}: the prior flusher sends both counts: ${JSON.stringify(s2Bodies)}`);
      const afterS2 = (await read('staff_push_state')).pending; assert.deepStrictEqual(require('./staff-push').pendingCounts(afterS2), {}, `🔴 ${L}: nothing left to double-send`);
      // B3 appends → B3 flushes
      await openWindow(); await b3notify('la_musa', 'o3');
      assert.deepStrictEqual(require('./staff-push').pendingCounts((await read('staff_push_state')).pending), { la_musa: 1 }, `${L}: premise`);
      await closeWindow(); const b3Bodies = await run(() => idx.flushStaffPushQueue.run({})).then(() => [...bodies]);
      assert.deepStrictEqual(b3Bodies, ['1 La Musa'], `🔴 ${L}: ${JSON.stringify(b3Bodies)}`);
      // the reverse: the PRIOR notifier appends → B3 flushes
      await openWindow(); prior('notify', { orderId: 'o4', after: order('x_pizza') });
      assert.deepStrictEqual(require('./staff-push').pendingCounts((await read('staff_push_state')).pending), { x_pizza: 1 }, `🔴 ${L}: B3 reads the prior notifier's buffer`);
      await closeWindow(); await run(() => idx.flushStaffPushQueue.run({}));
      assert.deepStrictEqual([...bodies], ['1 X. Pizza'], `🔴 ${L}: ${JSON.stringify(bodies)}`);
    } finally { for (const p of [T1, T2]) fs.rmSync(p, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await cell('DLV-LOGS: no fan-out / send / revocation log line carries a uid or an order id', async (L) => {
    const lines = ALL_LOGS.filter((l) => /fanoutStaffPush|sendStaffPush|staff_push_revoked|notifyStaffOnNewOrder|flushStaffPushQueue|sweepStuckOrders/.test(l));
    assert.ok(lines.some((l) => /fanoutStaffPush: 1\/1 sent \(neworder\)/.test(l)) && lines.some((l) => /fanoutStaffPush: 1\/1 sent \(stuck\)/.test(l)), `${L}: premise, the fan-out logged (${JSON.stringify(lines)})`);
    assert.ok(lines.length >= 8, `${L}: premise, every staff-push line family was captured (${lines.length})`);
    const leak = lines.filter((l) => Object.values(UIDS).some((u) => l.includes(u)) || l.includes(OID));
    assert.deepStrictEqual(leak, [], `🔴 ${L}`);
  });
  clearTimeout(WATCHDOG);
  if (fails.length) { console.log(`FAIL(${fails.length}): ${fails.join(' | ')}`); process.exit(1); }
  console.log(`staff-push-delivery: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
