/**
 * DRIVER F (PLAN-driver-server-F-problema r2 §2.1 / §2.6 / §3) — the «Problema con este pedido» report path and the dispatch
 * contact leaf, under the REAL database rules. Run: npm run test:driver-problems-rules
 *   driver_problems/{oid}/{pid}: create-only by the order's assigned delivery OR pickup driver, own `by`, server `now`, the six
 *   reasons, ≤200-char note, no extra child; never modified / deleted (also via ancestors or multipath); read by dispatchers only.
 *   config/dispatch_contact: ONE E.164 string (a narrowing .validate only — the config grants are unchanged).
 * Synthetic tb_ ids only.
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const DISP = 'u_tbdisp0000000000000000';
const DRV = 'u_tbdrv00000000000000000';     // the order's DELIVERY driver
const PICK = 'u_tbpick0000000000000000';    // the order's PICKUP driver (before pickup, «esperando en el restaurante»)
const OTHER = 'u_tbother000000000000000';
const DEACT = 'u_tbdeact000000000000000';
const OID = 'tb_order_1', OID2 = 'tb_order_2';
const TS = { '.sv': 'timestamp' };

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-drvf', database: { rules: RULES } });
  let n = 0;
  // the label rides on the failure too, so a broken rule fails on ITS OWN case (mutation kills are attributed by it)
  const ok = async (label, pr) => { try { await assertSucceeds(pr); } catch (e) { throw new Error(`FAILED: ${label} — ${e && e.message}`); } console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { try { await assertFails(pr); } catch (e) { throw new Error(`FAILED: ${label} — ${e && e.message}`); } console.log(`  ok ${++n} ${label}`); };
  const admin = async (fn) => { let v; await env.withSecurityRulesDisabled(async (ctx) => { v = await fn(ctx.database()); }); return v; };
  const read = (p) => admin(async (db) => (await db.ref(p).get()).val());

  const seed = () => admin(async (db) => {
    await db.ref('/').set(null);
    await db.ref(`dispatchers/${DISP}`).set({ name: 'D' });
    await db.ref(`driver_accounts/${DEACT}`).set({ deactivated: true });
    await db.ref(`tasks/${OID}_delivery`).set({ order_id: OID, type: 'delivery', status: 'accepted', assigned_driver_id: DRV });
    await db.ref(`tasks/${OID}_pickup`).set({ order_id: OID, type: 'pickup', status: 'accepted', assigned_driver_id: PICK });
    await db.ref(`tasks/${OID2}_delivery`).set({ order_id: OID2, type: 'delivery', status: 'accepted', assigned_driver_id: DEACT });
    await db.ref(`driver_problems/${OID}/p_existing`).set({ reason: 'other', by: DRV, at: 1 });
    await db.ref('config/whatsapp_enabled').set(true);
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).database();
  const drv = ctx(DRV), pick = ctx(PICK), other = ctx(OTHER), deact = ctx(DEACT), disp = ctx(DISP);
  const rep = (by, o = {}) => ({ reason: 'customer_no_answer', by, at: TS, ...o });
  await seed();

  // ============ CREATE ============
  await ok('the assigned DELIVERY driver creates a report', drv.ref(`driver_problems/${OID}/p1`).set(rep(DRV)));
  await ok('the assigned PICKUP driver creates a report', pick.ref(`driver_problems/${OID}/p2`).set(rep(PICK, { reason: 'waiting_restaurant' })));
  for (const reason of ['waiting_restaurant', 'not_ready_incomplete', 'customer_no_answer', 'address_not_found', 'restaurant_closed', 'other']) {
    await ok(`reason ${reason} is accepted`, drv.ref(`driver_problems/${OID}/r_${reason}`).set(rep(DRV, { reason })));
  }
  await ok('a 200-char note is accepted', drv.ref(`driver_problems/${OID}/p_note200`).set(rep(DRV, { reason: 'other', note: 'x'.repeat(200) })));
  const landed = await read(`driver_problems/${OID}/p1`);
  assert.strictEqual(typeof landed.at, 'number', 'premise: `at` landed as the server timestamp');

  // ============ DENIED CREATES ============
  await no('unauthenticated is DENIED', env.unauthenticatedContext().database().ref(`driver_problems/${OID}/d1`).set(rep(DRV)));
  await no('another (unassigned) driver is DENIED', other.ref(`driver_problems/${OID}/d2`).set(rep(OTHER)));
  await no('a CUSTOMER token with the assigned uid is DENIED', ctx(DRV, { customer: true }).ref(`driver_problems/${OID}/d3`).set(rep(DRV)));
  await no('a HANDHELD token with the assigned uid is DENIED', ctx(DRV, { handheld: true }).ref(`driver_problems/${OID}/d4`).set(rep(DRV)));
  await no('a DEACTIVATED assigned driver is DENIED', deact.ref(`driver_problems/${OID2}/d5`).set(rep(DEACT)));
  await no('a spoofed `by` is DENIED', drv.ref(`driver_problems/${OID}/d6`).set(rep(PICK)));
  await no('a missing reason is DENIED', drv.ref(`driver_problems/${OID}/d7`).set({ by: DRV, at: TS }));
  await no('a missing by is DENIED', drv.ref(`driver_problems/${OID}/d8`).set({ reason: 'other', at: TS }));
  await no('a missing at is DENIED', drv.ref(`driver_problems/${OID}/d9`).set({ reason: 'other', by: DRV }));
  await no('a non-now at is DENIED', drv.ref(`driver_problems/${OID}/d10`).set(rep(DRV, { at: 1 })));
  await no('an unknown reason is DENIED', drv.ref(`driver_problems/${OID}/d11`).set(rep(DRV, { reason: 'tb_unknown' })));
  await no('a non-string note is DENIED', drv.ref(`driver_problems/${OID}/d12`).set(rep(DRV, { note: 5 })));
  await no('a 201-char note is DENIED', drv.ref(`driver_problems/${OID}/d13`).set(rep(DRV, { note: 'x'.repeat(201) })));
  await no('an extra child is DENIED', drv.ref(`driver_problems/${OID}/d14`).set(rep(DRV, { tb_extra: 1 })));
  await no('a report on an order the driver holds no task for is DENIED', drv.ref(`driver_problems/${OID2}/d15`).set(rep(DRV)));

  // ============ NEVER MODIFIED / DELETED ============
  await no('an overwrite of an existing report is DENIED', drv.ref(`driver_problems/${OID}/p_existing`).set(rep(DRV)));
  await no('a child modification is DENIED', drv.ref(`driver_problems/${OID}/p_existing/reason`).set('waiting_restaurant'));
  await no('a record deletion is DENIED', drv.ref(`driver_problems/${OID}/p_existing`).remove());
  await no('a child deletion is DENIED', drv.ref(`driver_problems/${OID}/p_existing/reason`).remove());
  await no('$oid replacement is DENIED', drv.ref(`driver_problems/${OID}`).set({ p9: rep(DRV) }));
  await no('$oid deletion is DENIED', drv.ref(`driver_problems/${OID}`).remove());
  await no('driver_problems replacement is DENIED', drv.ref('driver_problems').set({ [OID]: { p9: rep(DRV) } }));
  await no('driver_problems deletion is DENIED', drv.ref('driver_problems').remove());
  await no('a dispatcher cannot write a report either', disp.ref(`driver_problems/${OID}/d16`).set(rep(DISP)));
  assert.deepStrictEqual(await read(`driver_problems/${OID}/p_existing`), { reason: 'other', by: DRV, at: 1 }, 'the existing report is byte-unchanged');

  // ============ MULTIPATH (Codex r2 P2-2): authorized path-by-path, atomic ============
  await ok('ALLOWED: a root update creating two valid reports at fresh push ids', drv.ref().update({
    [`driver_problems/${OID}/m1`]: rep(DRV), [`driver_problems/${OID}/m2`]: rep(DRV, { reason: 'other' }) }));
  assert.ok(await read(`driver_problems/${OID}/m1`) && await read(`driver_problems/${OID}/m2`), 'both multipath creates landed');
  await no('DENIED: create one + modify an existing report', drv.ref().update({
    [`driver_problems/${OID}/m3`]: rep(DRV), [`driver_problems/${OID}/p_existing/reason`]: 'waiting_restaurant' }));
  await no('DENIED: create one + delete an existing report', drv.ref().update({
    [`driver_problems/${OID}/m4`]: rep(DRV), [`driver_problems/${OID}/p_existing`]: null }));
  await no('DENIED: create one + an unauthorized path', drv.ref().update({
    [`driver_problems/${OID}/m5`]: rep(DRV), 'dispatcher_alerts/tb_x': { type: 'driver_problem' } }));
  for (const p of ['m3', 'm4', 'm5']) assert.strictEqual(await read(`driver_problems/${OID}/${p}`), null, `atomic: ${p} was not written`);
  assert.deepStrictEqual(await read(`driver_problems/${OID}/p_existing`), { reason: 'other', by: DRV, at: 1 }, 'atomic: the existing report survived');
  assert.strictEqual(await read('dispatcher_alerts/tb_x'), null, 'atomic: the unauthorized path was not written');

  // ============ READS ============
  await no('a driver CANNOT read reports (not even its own)', drv.ref(`driver_problems/${OID}/p1`).get());
  await no('a driver CANNOT read the collection', drv.ref('driver_problems').get());
  await ok('a dispatcher reads the collection', disp.ref('driver_problems').get());
  await ok('a dispatcher reads a report', disp.ref(`driver_problems/${OID}/p1`).get());
  await no('a HANDHELD dispatcher is DENIED the read', ctx(DISP, { handheld: true }).ref('driver_problems').get());
  await no('a customer is DENIED the read', ctx('u_tbcust00000000000000000', { customer: true }).ref('driver_problems').get());

  // ============ dispatcher_alerts unchanged: a driver still cannot write one directly ============
  await no('a driver still CANNOT write dispatcher_alerts', drv.ref(`dispatcher_alerts/driver_problem_${OID}_p1`).set({ type: 'driver_problem', order_id: OID }));

  // ============ config/dispatch_contact (owner: ONE number) ============
  await ok('a dispatcher writes a valid E.164 dispatch contact', disp.ref('config/dispatch_contact').set('+50499998888'));
  await ok('a driver reads the dispatch contact', drv.ref('config/dispatch_contact').get());
  for (const [label, v] of [['no plus', '50499998888'], ['leading zero', '+0123456789'], ['too short', '+5049999'], ['too long', '+5049999888877776'],
    ['letters', '+504abc98888'], ['spaces', '+504 9999 8888'], ['a number', 50499998888], ['a per-restaurant map', { tb_rest: '+50499998888' }]]) {
    await no(`a malformed dispatch contact (${label}) is DENIED`, disp.ref('config/dispatch_contact').set(v));
  }
  assert.strictEqual(await read('config/dispatch_contact'), '+50499998888', 'the valid value survived every denied write');
  await no('a driver CANNOT write the dispatch contact (config grant unchanged)', drv.ref('config/dispatch_contact').set('+50411112222'));
  await ok('a dispatcher still writes a sibling config leaf (unchanged)', disp.ref('config/whatsapp_enabled').set(false));
  await ok('a dispatcher can clear the dispatch contact (row hidden)', disp.ref('config/dispatch_contact').remove());

  await env.cleanup();
  console.log(`\ndriver-problems-rules: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
