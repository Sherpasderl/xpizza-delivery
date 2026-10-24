/**
 * DRIVER C (PLAN-driver-server-C-llegue r3 §2.1 / §2.7 / §6) — the «Llegué» tap leaf and the server-only result, under the REAL
 * database rules. Run: npm run test:arrived-rules
 *   tasks/{oid}_delivery/arrived: created once by the assigned driver ({at: now, by: self}, named children before $other); the
 *   task-parent grant still allows replacement / deletion (harmless — the server claim is the only dedupe authority).
 *   arrived_notices/{oid}: no client write; an ABSENT result readable by the eligible assigned driver (a listener survives the
 *   claim); an existing one only by its `by`; customer / handheld / deactivated tokens excluded.
 * Synthetic tb_ ids only.
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'u_tbdisp0000000000000000';
const DRV = 'u_tbdrv00000000000000000';
const OTHER = 'u_tbother000000000000000';
const DEACT = 'u_tbdeact000000000000000';
const OID = 'tb_order_1', OID2 = 'tb_order_2', OID3 = 'tb_order_3';
const TS = { '.sv': 'timestamp' };

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-drvc', database: { rules: RULES } });
  let n = 0;
  const ok = async (label, pr) => { try { await assertSucceeds(pr); } catch (e) { throw new Error(`FAILED: ${label} — ${e && e.message}`); } console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { try { await assertFails(pr); } catch (e) { throw new Error(`FAILED: ${label} — ${e && e.message}`); } console.log(`  ok ${++n} ${label}`); };
  const admin = async (fn) => { let v; await env.withSecurityRulesDisabled(async (ctx) => { v = await fn(ctx.database()); }); return v; };
  const read = (p) => admin(async (db) => (await db.ref(p).get()).val());
  const task = (oid, uid, o = {}) => ({ order_id: oid, type: 'delivery', status: 'in_progress', assigned_driver_id: uid, ...o });
  const seed = () => admin(async (db) => {
    await db.ref('/').set(null);
    await db.ref(`dispatchers/${DISP}`).set({ name: 'D' });
    await db.ref(`driver_accounts/${DEACT}`).set({ deactivated: true });
    await db.ref(`tasks/${OID}_delivery`).set(task(OID, DRV));
    await db.ref(`tasks/${OID}_pickup`).set({ order_id: OID, type: 'pickup', status: 'completed', assigned_driver_id: DRV });
    await db.ref(`tasks/${OID2}_delivery`).set(task(OID2, DEACT));
    await db.ref(`tasks/${OID3}_delivery`).set(task(OID3, DRV, { arrived: { at: 1, by: DRV } }));
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).database();
  const drv = ctx(DRV), other = ctx(OTHER), deact = ctx(DEACT);
  const arr = (by = DRV, o = {}) => ({ at: TS, by, ...o });
  const leaf = (oid) => `tasks/${oid}_delivery/arrived`;
  await seed();

  // ============ THE TAP ============
  await ok('the assigned driver creates arrived {at: now, by: self} (named at / by are not rejected by $other)', drv.ref(leaf(OID)).set(arr()));
  const landed = await read(leaf(OID));
  assert.ok(typeof landed.at === 'number' && landed.by === DRV, 'premise: the server timestamp landed');
  await no('a second create (overwrite) is DENIED', drv.ref(leaf(OID)).set(arr()));
  await no('a child modification is DENIED', drv.ref(`${leaf(OID)}/by`).set(DRV));
  await seed();
  await no('a CUSTOMER token with the assigned uid is DENIED', ctx(DRV, { customer: true }).ref(leaf(OID)).set(arr()));
  await no('a HANDHELD token with the assigned uid is DENIED', ctx(DRV, { handheld: true }).ref(leaf(OID)).set(arr()));
  await no('a DEACTIVATED assigned driver is DENIED', deact.ref(leaf(OID2)).set(arr(DEACT)));
  await no('another driver is DENIED', other.ref(leaf(OID)).set(arr(OTHER)));
  await no('a non-now at is DENIED', drv.ref(leaf(OID)).set(arr(DRV, { at: 1 })));
  await no('a spoofed by is DENIED', drv.ref(leaf(OID)).set(arr(OTHER)));
  await no('a missing by is DENIED', drv.ref(leaf(OID)).set({ at: TS }));
  await no('an extra child is DENIED', drv.ref(leaf(OID)).set(arr(DRV, { tb_extra: 1 })));
  await no('a PICKUP task is DENIED', drv.ref(`tasks/${OID}_pickup/arrived`).set(arr()));
  await no('unauthenticated is DENIED', env.unauthenticatedContext().database().ref(leaf(OID)).set(arr()));

  // delete → recreate is ALLOWED by the inherited task grant (harmless: the server claim dedupes — arrived-notify.test.js)
  await ok('the existing task grant ALLOWS deleting the arrival leaf', drv.ref(leaf(OID3)).remove());
  await ok('…and recreating it (a replayable leaf — the claim is the sole dedupe authority)', drv.ref(leaf(OID3)).set(arr()));
  await seed();
  await ok('a task-parent replacement without arrived is ALLOWED (existing grant, harmless)', drv.ref(`tasks/${OID3}_delivery`).set(task(OID3, DRV)));
  await ok('a task deletion is ALLOWED (existing grant, harmless)', drv.ref(`tasks/${OID3}_delivery`).remove());
  await seed();
  await ok('a multipath update creating arrived with another own-task leaf is ALLOWED', drv.ref().update({ [leaf(OID)]: arr(), [`tasks/${OID}_delivery/status`]: 'in_progress' }));
  await seed();
  await no('a multipath update with an unauthorized path FAILS atomically', drv.ref().update({ [leaf(OID)]: arr(), 'arrived_notices/tb_order_1': { state: 'final' } }));
  assert.strictEqual(await read(leaf(OID)), null, 'atomic: arrived was not written');

  // ============ arrived_notices ============
  await no('a driver CANNOT write arrived_notices', drv.ref(`arrived_notices/${OID}`).set({ state: 'final', by: DRV }));
  await no('a dispatcher CANNOT write arrived_notices', ctx(DISP).ref(`arrived_notices/${OID}`).set({ state: 'final', by: DISP }));
  await ok('an ABSENT result is readable by the eligible assigned driver', drv.ref(`arrived_notices/${OID}`).get());
  await no('an absent result is DENIED to another driver', other.ref(`arrived_notices/${OID}`).get());
  await no('an absent result is DENIED to a customer token with the assigned uid', ctx(DRV, { customer: true }).ref(`arrived_notices/${OID}`).get());
  await no('an absent result is DENIED to a handheld token with the assigned uid', ctx(DRV, { handheld: true }).ref(`arrived_notices/${OID}`).get());
  await no('an absent result is DENIED to a deactivated assigned driver', deact.ref(`arrived_notices/${OID2}`).get());
  await no('the collection is not readable', drv.ref('arrived_notices').get());

  // a listener attached BEFORE the claim survives claim → final and sees every state
  {
    const seen = []; let cancelled = null;
    const ref = drv.ref(`arrived_notices/${OID}`);
    const cb = ref.on('value', (s) => seen.push(s.val()), (e) => { cancelled = e; });
    await new Promise((r) => setTimeout(r, 300));
    await admin((db) => db.ref(`arrived_notices/${OID}`).set({ state: 'claimed', by: DRV, arrival_at: 5, task_id: `${OID}_delivery`, claimed_at: 6 }));
    await new Promise((r) => setTimeout(r, 300));
    await admin((db) => db.ref(`arrived_notices/${OID}`).update({ state: 'final', wa: 'sent', tracker: true, final_at: 7 }));
    await new Promise((r) => setTimeout(r, 300));
    ref.off('value', cb);
    assert.strictEqual(cancelled, null, 'FAILED: a listener attached before the claim is never cancelled');
    assert.deepStrictEqual(seen.map((v) => (v ? v.state : null)).filter((x, i, arr) => i === 0 || x !== arr[i - 1]), [null, 'claimed', 'final'], 'FAILED: the listener sees absent → claimed → final');
    console.log(`  ok ${++n} a listener attached BEFORE the claim survives and sees absent → claimed → final`);
  }
  await ok('an existing result is readable by its `by`', drv.ref(`arrived_notices/${OID}`).get());
  await admin((db) => db.ref(`tasks/${OID}_delivery/assigned_driver_id`).set(OTHER));
  await no('an existing result is DENIED to the NEW assignee (bound to its own driver)', other.ref(`arrived_notices/${OID}`).get());
  await ok('…and stays readable by its `by` after reassignment / task deletion', drv.ref(`arrived_notices/${OID}`).get());
  await no('an existing result is DENIED to a customer token with the `by` uid', ctx(DRV, { customer: true }).ref(`arrived_notices/${OID}`).get());
  await no('an existing result is DENIED to a handheld token with the `by` uid', ctx(DRV, { handheld: true }).ref(`arrived_notices/${OID}`).get());
  await admin((db) => db.ref(`driver_accounts/${DRV}`).set({ deactivated: true }));
  await no('an existing result is DENIED to its `by` once deactivated', drv.ref(`arrived_notices/${OID}`).get());

  await env.cleanup();
  console.log(`\narrived-rules: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
