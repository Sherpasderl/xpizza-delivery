/**
 * RULES HARDENING — driver-written order status (PLAN-rules-driver-terminal-hardening r1.1 §4). HEAVY: RTDB emulator.
 * Every case runs the SAME real client writer + synthetic tb_ fixture against SEPARATE namespaces, each loaded with its own
 * ruleset and verified active (assertActiveRules, fail closed):
 *   rh-base  = the rules at BASE_SHA (before this change)        rh-cand = the candidate canonical rules
 *   rh-nh-*  / rh-nf-* = the committed f2-narrow N-human / N-full artifacts (base + cand)        rh-mut-Mk = one mutant each
 * GREEN = identical outcomes on base and cand; RED = ACCEPTED on base, REFUSED on cand (proven both ways, never assumed).
 * Writers: the real driver / dispatch / dispatch-mobile SDKs (_web-sdk-loader) and the real KDS SDK (_kds-sdk-loader). The C2
 * interleaving runs the REAL cancelOrderCore inside the loader's awaited beforeWrite — after the writer's reads, before its
 * batch is submitted. Admin terminal SHAPES (R3, R5a) copy the exact field sets of the cited server writers.
 * Every assertion carries its case label (marker rule). Run: npm run test:rules-driver-terminal
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { makeWebSdkLoader, putRules, assertActiveRules } from './_web-sdk-loader.mjs';
import { makeKdsLoader } from './_kds-sdk-loader.mjs';

const require = createRequire(import.meta.url);
require('./_emulator-required')('database');
const admin = require('firebase-admin');
const { cancelOrderCore } = require('../cancel-order-core');
const { voidOrRefund } = require('../pixelpay-cancel');

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..', '..');
const BASE_SHA = '638d42f5';   // the branch base (train tip): the rules BEFORE this change
const gitShow = (p) => execFileSync('git', ['-C', REPO, 'show', `${BASE_SHA}:${p}`], { encoding: 'utf8' });
const readRepo = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const RULES = {
  base: gitShow('xpizza-reference/database.rules.json'),
  cand: readRepo('xpizza-reference/database.rules.json'),
  'nh-base': gitShow('xpizza-reference/f2-narrow/N-human.rules.json'),
  'nf-base': gitShow('xpizza-reference/f2-narrow/N-full.rules.json'),
  'nh-cand': readRepo('xpizza-reference/f2-narrow/N-human.rules.json'),
  'nf-cand': readRepo('xpizza-reference/f2-narrow/N-full.rules.json'),
};
assert.notStrictEqual(RULES.base, RULES.cand, 'premise: the candidate differs from the base');

// ── mutants (§4.3): each a transform of the CANDIDATE status leaf; each must actually change it ──
const T = (oid) => `root.child('tasks').child($order_id + '_${oid}')`;
const PICK_OWN = `${T('pickup')}.child('assigned_driver_id').val() === auth.uid`;
const DEL_OWN = `${T('delivery')}.child('assigned_driver_id').val() === auth.uid`;
const PICK_LIVE = ` && ${T('pickup')}.child('status').val() !== 'cancelled'`;
const DEL_LIVE = ` && ${T('delivery')}.child('status').val() !== 'cancelled'`;
const CONJ = " && (newData.exists() || root.child('dispatchers').child(auth.uid).exists() || root.child('kitchen').child(auth.uid).exists())";
const MUTANTS = {
  M1: { v: (v) => v.replace("data.val() !== 'cancelled' && data.val() !== 'delivered' && data.val() !== 'completed' && ", '') },
  M2: { v: (v) => v.replace(PICK_LIVE, '').replace(DEL_LIVE, '') },
  M3: { v: (v) => v.replace(`${DEL_OWN} && `, '') },
  M4: { v: (v) => v.replace(`'out_for_delivery' && ${PICK_OWN}`, `'out_for_delivery' && @@D`).replace(`'delivered' && ${DEL_OWN}`, `'delivered' && ${PICK_OWN}`).replace('@@D', DEL_OWN) },
  M5: { v: (v) => v.replace("(newData.val() === 'delivered' && ", "((newData.val() === 'delivered' || newData.val() === 'completed') && ") },
  M6: { w: (w) => w.replace(CONJ, '') },
  M7: { w: (w) => w.replace(CONJ, ` && (newData.exists() || root.child('dispatchers').child(auth.uid).exists() || root.child('kitchen').child(auth.uid).exists() || ${DEL_OWN} || ${PICK_OWN})`) },
};
for (const [k, m] of Object.entries(MUTANTS)) {
  const j = JSON.parse(RULES.cand); const st = j.rules.orders.$order_id.status;
  const v0 = st['.validate'], w0 = st['.write'];
  if (m.v) st['.validate'] = m.v(v0);
  if (m.w) st['.write'] = m.w(w0);
  assert.ok(st['.validate'] !== v0 || st['.write'] !== w0, `MUTANT-APPLIES ${k}: the transform changed the candidate`);
  RULES[`mut-${k}`] = JSON.stringify(j);
}

const HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
const ns = (rs) => `rh-${rs}`;
const apps = new Map();
const adb = (rs) => {
  if (!apps.has(rs)) apps.set(rs, admin.initializeApp({ databaseURL: `http://${HOST}?ns=${ns(rs)}` }, `rh-admin-${rs}`));
  return apps.get(rs).database();
};
const loaders = [];
const rulesUp = new Set();
async function ensureRules(rs) {
  if (rulesUp.has(rs)) return;
  await putRules(ns(rs), RULES[rs]); await assertActiveRules(ns(rs), RULES[rs]); rulesUp.add(rs);
}
// a real client of `site` as `uid` on ruleset rs; hooks is mutable (beforeWrite installed per case)
async function client(rs, site, uid, hooks = {}) {
  await ensureRules(rs);
  const L = makeWebSdkLoader({ project: 'demo-xpizza', site, uid, hooks, ns: ns(rs), rulesText: RULES[rs] });
  loaders.push(L);
  const X = await L.load();
  await assertActiveRules(ns(rs), RULES[rs]);   // after the client loaded: still OUR ruleset
  return X;
}
async function kds(rs, uid, claims = {}) {
  await ensureRules(rs);
  const L = makeKdsLoader(ns(rs), { mockUser: { sub: uid, user_id: uid, ...claims } });
  loaders.push(L);
  const K = await L.loadKds('xpizzakitchendisplay.netlify.app');
  await assertActiveRules(ns(rs), RULES[rs]);
  return K;
}
const read = async (rs, p) => (await adb(rs).ref(p).once('value')).val();
const seed = (rs, updates) => adb(rs).ref().update(updates);
// outcome of a client write: 'accepted' | 'refused' (a rules denial) — any OTHER error fails the case loudly
async function attempt(label, fn) {
  try { await fn(); return 'accepted'; } catch (e) {
    const m = String((e && (e.code || e.message)) || e);
    if (/permission|denied/i.test(m)) return 'refused';
    throw new Error(`${label}: unexpected error (not a rules denial): ${m}`);
  }
}

let seq = 0;
const now = Date.now();
// one delivery order with its two task legs; every id is fresh per call (no cross-case stacking)
function order(rs, { status = 'ready', pickupOwner, deliveryOwner, pickupStatus = 'accepted', deliveryStatus = 'assigned', payment = 'cash', rid = 'tb_r1', extra = {} } = {}) {
  const oid = `tb_rh_${rs.replace(/[^a-z0-9]/gi, '_')}_${++seq}`;
  const u = {
    [`orders/${oid}`]: { order_id: oid, restaurant_id: rid, order_type: 'delivery', status, payment_method: payment, payment_status: payment === 'cash' ? 'pending' : 'confirmed', total: 100, customer_name: 'tb', created_at: now + seq, ...extra },
    [`tasks/${oid}_pickup`]: { order_id: oid, restaurant_id: rid, type: 'pickup', status: pickupStatus, linked_task_id: `${oid}_delivery`, created_at: now + seq, ...(pickupOwner ? { assigned_driver_id: pickupOwner } : {}) },
    [`tasks/${oid}_delivery`]: { order_id: oid, restaurant_id: rid, type: 'delivery', status: deliveryStatus, linked_task_id: `${oid}_pickup`, depends_on_task_id: `${oid}_pickup`, created_at: now + seq, ...(deliveryOwner ? { assigned_driver_id: deliveryOwner } : {}) },
  };
  return { oid, u };
}
const driver = (rs, tag) => {
  const uid = `u_rh_${tag}_${rs.replace(/[^a-z0-9]/gi, '')}_${++seq}`;
  return { uid, u: { [`drivers/${uid}`]: { name: tag, status: 'available', active: true } } };
};
// the REAL dispatcher cancel (cash; no provider call) — deps-injected exactly like test/cancel-order.emulator.test.js
const realCancel = (rs, oid) => cancelOrderCore({ db: adb(rs), client: { voidTransaction: async () => ({ ok: true }) }, voidOrRefund, alert: async () => {}, serverTimestamp: now },
  { orderId: oid, actor: 'u_rh_dispatcher', reason: 'rh', now: Date.now(), claimId: `CID-${++seq}` });
// fires `fn` ONCE, at the writer's first root multi-path update (after its reads, before submission)
const onBatch = (hooks, fn) => { let done = false; hooks.beforeWrite = async (o) => { if (!done && o.kind === 'update' && o.path === '') { done = true; await fn(); } }; };

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const results = {};   // label → { base, cand } outcomes, for the hand-back table
const watchdog = setTimeout(() => { console.error('rules-driver-terminal: FAIL — timed out'); process.exit(1); }, 15 * 60 * 1000);

// ── the case bodies: each returns its outcome on ruleset rs (and asserts its own per-ruleset state where noted) ──
const CASES = {
  // GREEN
  async G1(rs) {
    const d = driver(rs, 'g1'); const o = order(rs, { pickupOwner: d.uid, deliveryOwner: d.uid, pickupStatus: 'assigned' });
    await seed(rs, { ...d.u, ...o.u });
    const X = await client(rs, 'xpizza-driver', d.uid);
    return attempt('G1', async () => { await X.acceptTask(d.uid, `${o.oid}_pickup`); await X.pickupComplete(d.uid, `${o.oid}_pickup`); await X.completeTask(d.uid, `${o.oid}_delivery`);
      assert.strictEqual(await read(rs, `orders/${o.oid}/status`), 'delivered', `G1 ${rs} delivered`); });
  },
  async G2(rs) {
    const d = driver(rs, 'g2'); const a = order(rs, { pickupOwner: d.uid, deliveryOwner: d.uid }); const b = order(rs, { pickupOwner: d.uid, deliveryOwner: d.uid });
    await seed(rs, { ...d.u, ...a.u, ...b.u });
    const X = await client(rs, 'xpizza-driver', d.uid);
    return attempt('G2', async () => {
      await X.pickupComplete(d.uid, `${a.oid}_pickup`);
      assert.deepStrictEqual([await read(rs, `orders/${a.oid}/status`), await read(rs, `orders/${b.oid}/status`)], ['out_for_delivery', 'out_for_delivery'], `G2 ${rs} one batch picks up both`);
      await X.completeTask(d.uid, `${a.oid}_delivery`); await X.completeTask(d.uid, `${b.oid}_delivery`);
      assert.deepStrictEqual([await read(rs, `orders/${a.oid}/status`), await read(rs, `orders/${b.oid}/status`)], ['delivered', 'delivered'], `G2 ${rs} both delivered`);
    });
  },
  async G3(rs) {
    const d = driver(rs, 'g3'); const o = order(rs, { status: 'out_for_delivery', pickupOwner: d.uid, deliveryOwner: d.uid, pickupStatus: 'completed', deliveryStatus: 'accepted' });
    await seed(rs, { ...d.u, ...o.u });
    const X = await client(rs, 'xpizza-driver', d.uid);
    return attempt('G3', async () => { await X.markTaskInProgress(d.uid, `${o.oid}_delivery`); await X.completeTask(d.uid, `${o.oid}_delivery`); });
  },
  async G4(rs) {
    const d = driver(rs, 'g4'); const o = order(rs, { pickupOwner: d.uid, deliveryOwner: d.uid, pickupStatus: 'assigned', rid: 'tb_r2' });
    await seed(rs, { ...d.u, ...o.u });
    const X = await client(rs, 'xpizza-driver', d.uid);
    return attempt('G4', async () => { const r = await X.acceptSecondOrder(d.uid, `${o.oid}_pickup`); assert.ok(r.ok, `G4 ${rs} acceptSecondOrder`);
      await X.pickupComplete(d.uid, `${o.oid}_pickup`); await X.completeTask(d.uid, `${o.oid}_delivery`); });
  },
  async G5(rs) {
    const old = driver(rs, 'g5old'); const nu = driver(rs, 'g5new'); const disp = `u_rh_disp_${++seq}`;
    const o = order(rs, { pickupOwner: old.uid, deliveryOwner: old.uid, pickupStatus: 'assigned' });
    await seed(rs, { ...old.u, ...nu.u, ...o.u, [`dispatchers/${disp}`]: true });
    const D = await client(rs, 'xpizza-dispatch', disp);
    const r = await D.reassignOrder(o.oid, nu.uid, old.uid); assert.ok(r && r.ok, `G5 ${rs} reassign ok (${JSON.stringify(r)})`);
    const XO = await client(rs, 'xpizza-driver', old.uid);
    const lateOld = await attempt('G5-old', () => XO.setOrderStatus(o.oid, 'out_for_delivery'));
    assert.strictEqual(lateOld, 'refused', `G5 ${rs} the OLD driver's late write stays refused (ownership)`);
    const XN = await client(rs, 'xpizza-driver', nu.uid);
    return attempt('G5', async () => { await XN.acceptTask(nu.uid, `${o.oid}_pickup`); await XN.pickupComplete(nu.uid, `${o.oid}_pickup`); await XN.completeTask(nu.uid, `${o.oid}_delivery`); });
  },
  async G6(rs) {
    const d = driver(rs, 'g6'); const disp = `u_rh_disp_${++seq}`; const o = order(rs, { pickupStatus: 'pending', deliveryStatus: 'pending' });
    await seed(rs, { ...d.u, ...o.u, [`dispatchers/${disp}`]: true });
    const M = await client(rs, 'xpizza-dispatch-mobile', disp);
    const r = await M.assignOrderToDriver(o.oid, d.uid); assert.ok(r && r.ok, `G6 ${rs} mobile assign ok (${JSON.stringify(r)})`);
    const X = await client(rs, 'xpizza-driver', d.uid);
    return attempt('G6', async () => { await X.acceptTask(d.uid, `${o.oid}_pickup`); await X.pickupComplete(d.uid, `${o.oid}_pickup`); await X.completeTask(d.uid, `${o.oid}_delivery`); });
  },
  async G7(rs) {
    const disp = `u_rh_disp_${++seq}`; await seed(rs, { [`dispatchers/${disp}`]: true });
    const D = await client(rs, 'xpizza-dispatch', disp);
    const out = [];
    for (const v of ['new', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'completed', 'cancelled']) {
      const o = order(rs, { status: v === 'ready' ? 'new' : 'ready' }); await seed(rs, o.u);
      out.push(`${v}:${await attempt(`G7-${v}`, () => D.setOrderStatus(o.oid, v))}`);
    }
    return out.join(',');
  },
  async G8(rs) {
    const k = `u_rh_kitchen_${++seq}`; await seed(rs, { [`kitchen/${k}`]: true });
    const K = await kds(rs, k);
    const a = order(rs, { status: 'new' }); const p = order(rs, { status: 'ready', extra: { order_type: 'pickup' } });
    await seed(rs, { ...a.u, ...p.u });
    return attempt('G8', async () => { await K.setOrderStatus(a.oid, 'preparing'); await K.setOrderStatus(a.oid, 'ready'); await K.setOrderStatus(p.oid, 'completed'); });
  },
  async G9(rs) {   // dual dispatcher+driver completion: the unchanged stamp rule decides, identically
    const d = driver(rs, 'g9'); const o = order(rs, { status: 'out_for_delivery', pickupOwner: d.uid, deliveryOwner: d.uid, pickupStatus: 'completed', deliveryStatus: 'accepted' });
    await seed(rs, { ...d.u, ...o.u, [`dispatchers/${d.uid}`]: true });
    const X = await client(rs, 'xpizza-driver', d.uid);
    return attempt('G9', () => X.completeTask(d.uid, `${o.oid}_delivery`));
  },
  async G9b(rs) {  // kitchen+driver: the completion REPLAY over a real cancel stays EXEMPT (documented residual R-1)
    const d = driver(rs, 'g9b'); const o = order(rs, { status: 'out_for_delivery', pickupOwner: d.uid, deliveryOwner: d.uid, pickupStatus: 'completed', deliveryStatus: 'accepted' });
    await seed(rs, { ...d.u, ...o.u, [`kitchen/${d.uid}`]: true });
    const hooks = {}; const X = await client(rs, 'xpizza-driver', d.uid, hooks);
    onBatch(hooks, () => realCancel(rs, o.oid));
    return attempt('G9b', () => X.completeTask(d.uid, `${o.oid}_delivery`));
  },
  async G10(rs) {
    const d = driver(rs, 'g10'); const o = order(rs, { status: 'out_for_delivery', pickupOwner: d.uid, deliveryOwner: d.uid, pickupStatus: 'completed', deliveryStatus: 'accepted' });
    await seed(rs, { ...d.u, ...o.u });
    const X = await client(rs, 'xpizza-driver', d.uid);
    return attempt('G10', () => X.setOrderStatus(o.oid, 'out_for_delivery'));
  },
  async G10a(rs) {
    const disp = `u_rh_disp_${++seq}`; const o = order(rs, { status: 'ready' }); await seed(rs, { ...o.u, [`dispatchers/${disp}`]: true });
    const D = await client(rs, 'xpizza-dispatch', disp);
    return attempt('G10a', () => D.setOrderStatus(o.oid, null));
  },
  async G11(rs) {  // delivery leg still 'assigned' (pickup completed): the "not cancelled" choice
    const d = driver(rs, 'g11'); const o = order(rs, { status: 'out_for_delivery', pickupOwner: d.uid, deliveryOwner: d.uid, pickupStatus: 'completed', deliveryStatus: 'assigned' });
    await seed(rs, { ...d.u, ...o.u });
    const X = await client(rs, 'xpizza-driver', d.uid);
    return attempt('G11', () => X.completeTask(d.uid, `${o.oid}_delivery`));
  },
  async G12(rs) {  // a NON-terminal intervening change (real KDS preparing→ready) does not refuse the queued pickup batch
    const d = driver(rs, 'g12'); const k = `u_rh_kitchen_${++seq}`; const o = order(rs, { status: 'preparing', pickupOwner: d.uid, deliveryOwner: d.uid });
    await seed(rs, { ...d.u, ...o.u, [`kitchen/${k}`]: true });
    const K = await kds(rs, k);
    const hooks = {}; const X = await client(rs, 'xpizza-driver', d.uid, hooks);
    onBatch(hooks, async () => { await K.setOrderStatus(o.oid, 'ready'); assert.strictEqual(await read(rs, `orders/${o.oid}/status`), 'ready', `G12 ${rs} premise: KDS moved it`); });
    return attempt('G12', () => X.pickupComplete(d.uid, `${o.oid}_pickup`));
  },
  // RED
  async R1(rs) {   // C2-delivery: the real cancel lands between completeTask's reads and its batch
    const d = driver(rs, 'r1'); const o = order(rs, { status: 'out_for_delivery', pickupOwner: d.uid, deliveryOwner: d.uid, pickupStatus: 'completed', deliveryStatus: 'accepted' });
    await seed(rs, { ...d.u, ...o.u, [`drivers/${d.uid}/current_task_id`]: `${o.oid}_delivery` });
    const hooks = {}; const X = await client(rs, 'xpizza-driver', d.uid, hooks);
    let ptr; onBatch(hooks, async () => { await realCancel(rs, o.oid); assert.strictEqual(await read(rs, `orders/${o.oid}/status`), 'cancelled', `R1 ${rs} premise: cancelled`); ptr = await read(rs, `drivers/${d.uid}/current_task_id`); });
    const out = await attempt('R1', () => X.completeTask(d.uid, `${o.oid}_delivery`));
    if (out === 'refused') {
      assert.deepStrictEqual([await read(rs, `orders/${o.oid}/status`), await read(rs, `orders/${o.oid}/delivered_by_driver_uid`), await read(rs, `tasks/${o.oid}_delivery/status`), await read(rs, `drivers/${d.uid}/current_task_id`)],
        ['cancelled', null, 'cancelled', ptr], `R1 ${rs} the WHOLE batch refused: order cancelled, no stamp, task cancelled, pointer as the cancel left it`);
    }
    return out;
  },
  async R2(rs) {   // C2-pickup
    const d = driver(rs, 'r2'); const o = order(rs, { status: 'ready', pickupOwner: d.uid, deliveryOwner: d.uid });
    await seed(rs, { ...d.u, ...o.u });
    const hooks = {}; const X = await client(rs, 'xpizza-driver', d.uid, hooks);
    onBatch(hooks, () => realCancel(rs, o.oid));
    const out = await attempt('R2', () => X.pickupComplete(d.uid, `${o.oid}_pickup`));
    if (out === 'refused') assert.deepStrictEqual([await read(rs, `orders/${o.oid}/status`), await read(rs, `orders/${o.oid}/picked_up_at`), await read(rs, `tasks/${o.oid}_pickup/status`)], ['cancelled', null, 'cancelled'], `R2 ${rs} nothing lands`);
    return out;
  },
  async R3(rs) {   // order cancelled by an Admin STATUS-ONLY shape (tasks stay live): the order pre-status check in isolation
    const out = [];
    for (const [shape, fields] of [['hosted-void', { status: 'cancelled', payment_status: 'refunded' }], ['abandon', { payment_status: 'abandoned', status: 'cancelled' }]]) {
      // pickup: order cancelled from 'ready'; delivery: order cancelled from 'out_for_delivery'
      const dp = driver(rs, 'r3p'); const op = order(rs, { status: 'ready', pickupOwner: dp.uid, deliveryOwner: dp.uid, payment: 'online' });
      const dd = driver(rs, 'r3d'); const od = order(rs, { status: 'out_for_delivery', pickupOwner: dd.uid, deliveryOwner: dd.uid, pickupStatus: 'completed', deliveryStatus: 'accepted', payment: 'online' });
      await seed(rs, { ...dp.u, ...op.u, ...dd.u, ...od.u });
      await adb(rs).ref(`orders/${op.oid}`).update(fields); await adb(rs).ref(`orders/${od.oid}`).update(fields);   // pixelpay-hosted-webhook.js:155 / resolve-manual.js:155 field sets
      const XP = await client(rs, 'xpizza-driver', dp.uid); const XD = await client(rs, 'xpizza-driver', dd.uid);
      out.push(`${shape}-pickup:${await attempt(`R3-${shape}-pickup`, () => XP.pickupComplete(dp.uid, `${op.oid}_pickup`))}`);
      out.push(`${shape}-delivery:${await attempt(`R3-${shape}-delivery`, () => XD.completeTask(dd.uid, `${od.oid}_delivery`))}`);
    }
    return out.join(',');
  },
  async R4(rs) {   // a LIVE order whose owned task is cancelled inside beforeWrite: the task-cancelled check in isolation
    const out = [];
    const dp = driver(rs, 'r4p'); const op = order(rs, { status: 'ready', pickupOwner: dp.uid, deliveryOwner: dp.uid });
    const dd = driver(rs, 'r4d'); const od = order(rs, { status: 'out_for_delivery', pickupOwner: dd.uid, deliveryOwner: dd.uid, pickupStatus: 'completed', deliveryStatus: 'accepted' });
    await seed(rs, { ...dp.u, ...op.u, ...dd.u, ...od.u });
    const hp = {}; const XP = await client(rs, 'xpizza-driver', dp.uid, hp); onBatch(hp, () => adb(rs).ref(`tasks/${op.oid}_pickup/status`).set('cancelled'));
    const hd = {}; const XD = await client(rs, 'xpizza-driver', dd.uid, hd); onBatch(hd, () => adb(rs).ref(`tasks/${od.oid}_delivery/status`).set('cancelled'));
    out.push(`pickup:${await attempt('R4-pickup', () => XP.pickupComplete(dp.uid, `${op.oid}_pickup`))}`);
    out.push(`delivery:${await attempt('R4-delivery', () => XD.completeTask(dd.uid, `${od.oid}_delivery`))}`);
    return out.join(',');
  },
  async R5(rs) {   // terminal pre-states isolating the status validator
    const da = driver(rs, 'r5a'); const oa = order(rs, { status: 'out_for_delivery', pickupOwner: da.uid, deliveryOwner: da.uid, pickupStatus: 'completed', deliveryStatus: 'accepted', payment: 'online' });
    const db_ = driver(rs, 'r5b'); const ob = order(rs, { status: 'ready', pickupOwner: db_.uid, deliveryOwner: db_.uid });
    await seed(rs, { ...da.u, ...oa.u, ...db_.u, ...ob.u });
    await adb(rs).ref(`orders/${oa.oid}`).update({ payment_status: 'confirmed', status: 'completed', blocked_reason: null, fulfilled_offline_at: now, resolution: 'offline_fulfilled' });   // resolve-manual.js:235 close_fulfilled field set
    await adb(rs).ref(`orders/${ob.oid}/status`).set('delivered');
    const XA = await client(rs, 'xpizza-driver', da.uid); const XB = await client(rs, 'xpizza-driver', db_.uid);
    return [`a:${await attempt('R5a', () => XA.completeTask(da.uid, `${oa.oid}_delivery`))}`, `b:${await attempt('R5b', () => XB.pickupComplete(db_.uid, `${ob.oid}_pickup`))}`].join(',');
  },
  async R6(rs) {   // C1: crafted driver statuses, each from a fresh fixture whose prior differs
    const out = [];
    for (const v of ['completed', 'ready', 'new', 'preparing', 'cancelled']) {
      const d = driver(rs, `r6${v}`); const o = order(rs, { status: 'out_for_delivery', pickupOwner: d.uid, deliveryOwner: d.uid, pickupStatus: 'completed', deliveryStatus: 'accepted' });
      await seed(rs, { ...d.u, ...o.u });
      const X = await client(rs, 'xpizza-driver', d.uid);
      out.push(`${v}:${await attempt(`R6-${v}`, () => X.setOrderStatus(o.oid, v))}`);
    }
    return out.join(',');
  },
  async R7(rs) {   // stacked mixed batch: B cancelled after the reads → COMPLETE rejection on cand; then G13 recovery
    const d = driver(rs, 'r7'); const a = order(rs, { status: 'ready', pickupOwner: d.uid, deliveryOwner: d.uid }); const b = order(rs, { status: 'ready', pickupOwner: d.uid, deliveryOwner: d.uid });
    await seed(rs, { ...d.u, ...a.u, ...b.u });
    const hooks = {}; const X = await client(rs, 'xpizza-driver', d.uid, hooks);
    onBatch(hooks, () => realCancel(rs, b.oid));
    const out = await attempt('R7', () => X.pickupComplete(d.uid, `${a.oid}_pickup`));
    if (out === 'refused') {
      assert.deepStrictEqual([await read(rs, `orders/${a.oid}/status`), await read(rs, `orders/${a.oid}/picked_up_at`), await read(rs, `tasks/${a.oid}_pickup/status`), await read(rs, `orders/${b.oid}/status`)],
        ['ready', null, 'accepted', 'cancelled'], `R7 ${rs} COMPLETE rejection: A unchanged, B stays cancelled`);
      hooks.beforeWrite = null;
      const g13 = await attempt('G13', () => X.pickupComplete(d.uid, `${a.oid}_pickup`));   // the REAL refreshed writer: its fresh scan excludes B
      assert.strictEqual(g13, 'accepted', `G13 ${rs} the retry picks up A`);
      assert.deepStrictEqual([await read(rs, `orders/${a.oid}/status`), await read(rs, `orders/${b.oid}/status`)], ['out_for_delivery', 'cancelled'], `G13 ${rs} A picked up, B stays cancelled`);
      results.G13 = { ...(results.G13 || {}), [rs]: g13 };
    }
    return out;
  },
  async R8(rs) {   // the A/B window: delivery leg reassigned to B while the pickup is still A's
    const A = driver(rs, 'r8a'); const B = driver(rs, 'r8b');
    const o = order(rs, { status: 'out_for_delivery', pickupOwner: A.uid, deliveryOwner: B.uid, pickupStatus: 'completed', deliveryStatus: 'assigned' });
    await seed(rs, { ...A.u, ...B.u, ...o.u });
    const X = await client(rs, 'xpizza-driver', A.uid);
    return attempt('R8', () => X.setOrderStatus(o.oid, 'delivered'));
  },
  async R9(rs) {   // driver DELETE of status (pickup owner; delivery owner)
    const dp = driver(rs, 'r9p'); const B = driver(rs, 'r9x'); const op = order(rs, { status: 'ready', pickupOwner: dp.uid, deliveryOwner: B.uid });
    const dd = driver(rs, 'r9d'); const od = order(rs, { status: 'out_for_delivery', pickupOwner: B.uid, deliveryOwner: dd.uid, pickupStatus: 'completed', deliveryStatus: 'accepted' });
    await seed(rs, { ...dp.u, ...B.u, ...op.u, ...dd.u, ...od.u });
    const XP = await client(rs, 'xpizza-driver', dp.uid); const XD = await client(rs, 'xpizza-driver', dd.uid);
    return [`pickup-owner:${await attempt('R9-pickup', () => XP.setOrderStatus(op.oid, null))}`, `delivery-owner:${await attempt('R9-delivery', () => XD.setOrderStatus(od.oid, null))}`].join(',');
  },
};

const allRefused = (s) => String(s).split(',').every((x) => x.endsWith('refused'));
const allAccepted = (s) => String(s).split(',').every((x) => x.endsWith('accepted'));
try {
  // ── GREEN: identical on base and cand ──
  for (const g of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G9b', 'G10', 'G10a', 'G11', 'G12']) {
    const b = await CASES[g]('base'); const c = await CASES[g]('cand');
    results[g] = { base: b, cand: c };
    assert.strictEqual(c, b, `${g} GREEN: identical outcome on base and cand (base ${b}, cand ${c})`);
    if (g === 'G9') assert.ok(allRefused(c), `G9 the dual dispatcher+driver completion is refused by the UNCHANGED stamp rule, as on base (${c})`);
    else assert.ok(allAccepted(c), `${g} accepted on both (${c})`);
    ok(`${g} GREEN — base ${b} · cand ${c}`);
  }
  // ── G8b: a restaurant-scoped kitchen_staff account (no /kitchen) on the STAGED variants, base and cand ──
  for (const v of ['nh', 'nf']) {
    const out = {};
    for (const side of ['base', 'cand']) {
      const rs = `${v}-${side}`; const k = `u_rh_ks_${++seq}`; const other = `u_rh_ks_other_${++seq}`;
      await seed(rs, { [`restaurants/tb_r1/kitchen_staff/${k}`]: true, [`restaurants/tb_r9/kitchen_staff/${other}`]: true });
      const K = await kds(rs, k); const KO = await kds(rs, other);
      const a = order(rs, { status: 'new' }); const p = order(rs, { status: 'ready', extra: { order_type: 'pickup' } }); const x = order(rs, { status: 'new' });
      await seed(rs, { ...a.u, ...p.u, ...x.u });
      const own = await attempt(`G8b-${rs}`, async () => { await K.setOrderStatus(a.oid, 'preparing'); await K.setOrderStatus(a.oid, 'ready'); await K.setOrderStatus(p.oid, 'completed'); });
      const foreign = await attempt(`G8b-foreign-${rs}`, () => KO.setOrderStatus(x.oid, 'preparing'));
      out[side] = `own:${own},foreign:${foreign}`;
    }
    results[`G8b-${v}`] = out;
    assert.strictEqual(out.cand, 'own:accepted,foreign:refused', `G8b ${v} cand: scoped kitchen_staff writes its restaurant's preparing/ready/pickup-completed; another restaurant's is refused (${out.cand})`);
    assert.strictEqual(out.cand, out.base, `G8b ${v} identical to the staged base (${out.base})`);
    ok(`G8b ${v === 'nh' ? 'N-human' : 'N-full'} — base ${out.base} · cand ${out.cand}`);
  }
  // ── RED: accepted on base, refused on cand ──
  for (const r of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9']) {
    const b = await CASES[r]('base'); const c = await CASES[r]('cand');
    results[r] = { base: b, cand: c };
    assert.ok(allAccepted(b), `${r} RED premise: ACCEPTED on base (${b})`);
    assert.ok(allRefused(c), `${r} RED: REFUSED on cand (${c})`);
    ok(`${r} RED — base ${b} · cand ${c}`);
  }
  assert.strictEqual(results.G13 && results.G13.cand, 'accepted', 'G13 the real refreshed pickupComplete recovers A on cand');
  ok('G13 recovery — cand accepted (A picked up, B stays cancelled)');
  // ── mutants: each in its own namespace; KILLED = its killing RED case is ACCEPTED under the mutant (the cand RED assertion would fail) ──
  const KILLERS = { M1: ['R3', 'R5'], M2: ['R4'], M3: ['R8'], M4: ['R8'], M5: ['R6'], M6: ['R9'], M7: ['R9'] };
  for (const [m, killers] of Object.entries(KILLERS)) {
    const rs = `mut-${m}`; const by = [];
    for (const r of killers) {
      const out = await CASES[r](rs);
      const hit = m === 'M5' ? String(out).split(',').includes('completed:accepted') : String(out).split(',').some((x) => x.endsWith('accepted'));
      if (hit) by.push(`${r}(${out})`);
    }
    assert.ok(by.length > 0, `MUTANT ${m} SURVIVED — none of ${killers.join('/')} is accepted under it`);
    ok(`MUTANT ${m} KILLED by ${by.join(' ')}`);
  }
} catch (e) {
  console.error('rules-driver-terminal: FAIL\n', e && e.stack || e); process.exit(1);
} finally {
  try { for (const L of loaders) L.cleanup(); for (const a of apps.values()) await a.delete(); } catch (_) {}
}
clearTimeout(watchdog);
console.log('RESULTS', JSON.stringify(results));
console.log(`rules-driver-terminal: OK (${n})`);
process.exit(0);
