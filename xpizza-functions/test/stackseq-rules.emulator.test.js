/**
 * BUILD-stacked-seq-server r5 T1 — the sequencing rules against the REAL compiled ruleset (xpizza-reference/database.rules.json).
 * Run: npm run test:stackseq-rules
 *   A. stacks/{id} READ: its own driver and a dispatcher only — never another driver, a customer token (even one whose uid
 *      collides with a dispatcher or with the driver), or a handheld.
 *   B. stacks/{id} WRITE: denied to EVERY client (driver, dispatcher, svc-assigner) — the Admin transaction is its only writer.
 *   C. the five task-copy leaves on a DELIVERY task: svc-assigner and a dispatcher may write them; the assigned driver (whose
 *      parent grant covers the task) may NOT change them — only rewrite them unchanged; a customer token (even a
 *      dispatcher-colliding uid) and a handheld are denied; svc-assigner may not put them on a PICKUP task.
 * Plain-node style (no jest), as the repo's other rules emulator tests.
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');

const DISP = 'u_disp_tb000000000000000';
const DRV = 'u_drv_tb0000000000000000';
const OTHER = 'u_other_tb00000000000000';
const SVC = 'svc-assigner';
const SID = 'stk_0123456789abcdef0123456789abcdef';
const LEAVES = { stack_id: SID, stop_seq: 2, stack_uid: DRV, stack_at: 1000, stack_plus_min: 3 };

(async () => {
  let n = 0;
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });
  const reset = () => env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref().set({
      dispatchers: { [DISP]: { role: 'dispatcher' } },
      driver_accounts: { [DRV]: { enabled: true, onboarding_state: 'active' }, [OTHER]: { enabled: true, onboarding_state: 'active' } },
      stacks: { [SID]: { state: 'committed', driver_uid: DRV, pair: ['ord_a', 'ord_b'], ranks: { ord_a: 1, ord_b: 2 }, plus_min: 3 } },
      tasks: {
        ord_b_delivery: { order_id: 'ord_b', type: 'delivery', status: 'accepted', assigned_driver_id: DRV, assigned_at: 900, ...LEAVES },
        ord_b_pickup: { order_id: 'ord_b', type: 'pickup', status: 'accepted', assigned_driver_id: DRV, assigned_at: 900 },
      },
    });
  });
  await reset();

  const as = (uid, claims) => env.authenticatedContext(uid, claims).database();
  const drv = as(DRV); const other = as(OTHER); const disp = as(DISP); const svc = as(SVC);
  const custDisp = as(DISP, { customer: true }); const custDrv = as(DRV, { customer: true });
  const hand = as(DRV, { handheld: true }); const handDisp = as(DISP, { handheld: true });

  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ok ${++n} ${label}`); };
  const S = (db) => db.ref(`stacks/${SID}`);
  const D = (db, leaf) => db.ref(`tasks/ord_b_delivery${leaf ? `/${leaf}` : ''}`);

  // ---------- A. stacks reads ----------
  await ok('own driver reads its stack', S(drv).once('value'));
  await ok('a dispatcher reads a stack', S(disp).once('value'));
  await no('another driver cannot read it', S(other).once('value'));
  await no('a customer token whose uid is a dispatcher cannot read it', S(custDisp).once('value'));
  await no('a customer token whose uid is the driver cannot read it', S(custDrv).once('value'));
  await no('a handheld cannot read it', S(hand).once('value'));
  await no('a handheld with a dispatcher uid cannot read it', S(handDisp).once('value'));
  await no('nobody lists stacks/', drv.ref('stacks').once('value'));

  // ---------- B. stacks writes: every client denied ----------
  for (const [label, db] of [['the driver', drv], ['a dispatcher', disp], ['svc-assigner', svc]]) {
    await no(`${label} cannot write a stack`, S(db).set({ state: 'committed', driver_uid: DRV }));
    await no(`${label} cannot update a stack field`, S(db).child('plus_min').set(9));
    await no(`${label} cannot create a stack`, db.ref('stacks/stk_new').set({ state: 'refused', driver_uid: DRV }));
  }

  // ---------- C. task copies ----------
  for (const [leaf, v] of Object.entries({ stack_id: 'stk_other', stop_seq: 1, stack_uid: OTHER, stack_at: 2000, stack_plus_min: 5 })) {
    await ok(`svc-assigner writes ${leaf}`, D(svc, leaf).set(v)); await reset();
    await ok(`a dispatcher writes ${leaf}`, D(disp, leaf).set(v)); await reset();
    await no(`the assigned driver cannot change ${leaf}`, D(drv, leaf).set(v));
    await ok(`the assigned driver may rewrite ${leaf} unchanged`, D(drv, leaf).set(LEAVES[leaf]));
    await no(`a customer token (dispatcher uid) cannot change ${leaf}`, D(custDisp, leaf).set(v));
    await no(`a handheld cannot change ${leaf}`, D(hand, leaf).set(v));
    await no(`another driver cannot change ${leaf}`, D(other, leaf).set(v));
  }
  // the driver's whole-task write: unchanged copies pass, a changed copy is refused
  await ok('the driver writes its task with the copies unchanged', D(drv).update({ status: 'accepted', stop_seq: 2 }));
  await no('the driver cannot change a copy inside a multi-field update', D(drv).update({ stop_seq: 1 }));
  // svc-assigner: delivery tasks only
  await no('svc-assigner cannot put a copy on a PICKUP task', svc.ref('tasks/ord_b_pickup/stop_seq').set(1));
  // the finalize shape: ONE multipath update by svc-assigner over both members' copies
  await env.withSecurityRulesDisabled(async (ctx) => { await ctx.database().ref('tasks/ord_a_delivery').set({ order_id: 'ord_a', type: 'delivery', status: 'accepted', assigned_driver_id: DRV, assigned_at: 800 }); });
  await ok('svc-assigner writes both members in one multipath update', svc.ref().update({
    'tasks/ord_a_delivery/stack_id': SID, 'tasks/ord_a_delivery/stop_seq': 1, 'tasks/ord_a_delivery/stack_uid': DRV, 'tasks/ord_a_delivery/stack_at': 1000, 'tasks/ord_a_delivery/stack_plus_min': null,
    'tasks/ord_b_delivery/stop_seq': 2,
  }));

  await env.cleanup();
  console.log(`\nstackseq-rules(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
