'use strict';
/**
 * S1a PARITY EVIDENCE (codex r1 P1-7) — drives the REAL converted writers through a RULES-ENFORCED svc-assigner
 * handle, against the REAL compiled ruleset, and measures latency vs the bypass handle.
 *
 * ⚠️ HARNESS NOTE (verified empirically, reported to the advisor): the RTDB emulator does NOT enforce security rules
 * for a firebase-admin Admin SDK connection even with databaseAuthVariableOverride={uid:'svc-assigner'} — all such
 * writes are allowed (the Admin connection is privileged in the emulator). So the production restricted handle cannot
 * be rule-tested through the Admin SDK here. The FAITHFUL equivalent is @firebase/rules-unit-testing's
 * authenticatedContext('svc-assigner'): a real transaction-capable DB handle whose writes are evaluated against the
 * SAME rules with the SAME auth.uid='svc-assigner' — identical rule evaluation to production's svc-assigner app.
 * (In production the override Admin app IS rule-bound; only the emulator privileges Admin connections.)
 *
 * Proves, through that rules-enforced handle, driving the REAL writers (buildAssignmentUpdates is LIFTED out of index.js
 * and executed — not duplicated; the driver accept uses the real stackedTasksToAccept cascade; completion uses the real
 * buildCompleteTaskUpdates):
 *   - TOLERANT (dark) = UNCHANGED outcome: the REAL claimDelivery (transaction) claims null→enabled; the lifted
 *     buildAssignmentUpdates lands on BOTH legs (matrix-asserted) for a normal, a stacked, and a sweeper finalize;
 *     the shift-open token rotation (create + bound prior-delete, with shift_id + delete NEGATIVES); a restoring
 *     (non-null) rollback that runs UNCONDITIONALLY and restores the prior owner;
 *   - the TIMEOUT reassign flow run through the LIFTED monitorAssignmentTimeout core (handle-select → claim → finalize
 *     → the denial catches, release + alert): flag-ON eligible replacement (both legs land), flag-ON suspended at claim
 *     and suspended-between-claim-and-finalize (release to SIN ASIGNAR + alert, never restoring the expired owner), and
 *     flag-OFF (svcDb===db) claim + finalize denials that propagate / ordinary-rollback with ZERO account reads, and a
 *     finalize denial whose eligibility classification THROWS falling back to main's rollback (codex r4 P1); plus the
 *     REAL desktop + mobile client assignment batch (lifted from each client's assignOrderToDriver with a source-parity
 *     check) and its CAS claim, both-legs for an eligible target and DENIED for a suspended one (codex r4 P2);
 *   - the REAL driver accept at the rules layer: first (lone), stacked (same-hub cascade), second (cross-hub owner
 *     write), and a NEGATIVE (a driver cannot accept another driver's task); plus the real completion batch;
 *   - a COLD transaction (the first claim on a fresh env) and an OFFLINE→reconnect delayed commit both land;
 *   - the svcWriteOrFallback SAFETY NET: an svc write denied in tolerant mode falls back + raises a loud alert;
 *   - CLOSED bites: the same real claim is DENIED for a SUSPENDED driver, allowed for an eligible one;
 *   - LATENCY of the real claim→finalize cycle, rules-enforced vs bypass, is MEASURED and reported (not asserted).
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('url');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const { claimDelivery } = require('../claim-delivery');   // the REAL claim helper the converted handlers call

const D_EN = 'u_parity_enabled0000000';
const D_EN2 = 'u_parity_enabled1111111';   // a SECOND eligible driver — the reassignment target + second-accept actor
const D_SUSP = 'u_parity_suspended00000';
const NOW = 1_760_000_000_000;

// codex r2 P1-5: LIFT the REAL buildAssignmentUpdates out of index.js (brace-match) and run it with injected deps, so
// the finalize is the actual converted builder — not a duplicate. The sweeper path adds retry_count/last_swept exactly
// as index.js:sweepPendingOrders does after the builder.
function liftFn(name) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  let at = src.indexOf(`function ${name}(`); assert.notStrictEqual(at, -1, `lift ${name}`);
  if (src.slice(at - 6, at) === 'async ') at -= 6;   // keep the `async ` prefix, else an async body's await becomes a syntax error
  let i = src.indexOf('{', at), d = 0, end = i; for (; end < src.length; end++) { if (src[end] === '{') d++; else if (src[end] === '}') { d--; if (!d) break; } }
  return src.slice(at, end + 1);
}
// eslint-disable-next-line no-new-func
const buildAssignmentUpdates = new Function('ServerValue', 'ACCEPT_TIMEOUT_MS', `${liftFn('buildAssignmentUpdates')}; return buildAssignmentUpdates;`)({ TIMESTAMP: NOW }, 60000);
const sweeperFinalize = (orderId, driverId) => { const u = buildAssignmentUpdates(orderId, driverId, 1, true, false); u[`tasks/${orderId}_delivery/retry_count`] = 1; u[`tasks/${orderId}_delivery/last_swept`] = NOW; return u; };

// codex r3 P1-4: LIFT the ACTUAL reassign core of monitorAssignmentTimeout (handle-select → claim → finalize → the
// eligibility/ordinary denial catches) out of index.js and RUN it with the real svc-handle fns, claim helper and
// release/alert helpers injected — so the flag-off short-circuit and the claim/finalize denial recovery are exercised
// end-to-end against the real rules, not re-implemented. (The 60s sleep + pickEligibleDriver selection precede this
// segment and are not under review; nextDriver is passed as the already-selected replacement.)
const svcHandleLib = require('../lib/svc-handle');
const { releaseDeliveryFromDriver } = require('../claim-delivery');
function liftSegment(startNeedle, endNeedle) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const a = src.indexOf(startNeedle); assert.notStrictEqual(a, -1, 'seg start');
  const b = src.indexOf(endNeedle, a); assert.notStrictEqual(b, -1, 'seg end');
  return src.slice(a, b + endNeedle.length);
}
const REASSIGN_SEG = liftSegment(
  '    const svcDb = await pickHandle(db);   // S1a §3 (codex r2 P1-2)',
  "await rollbackOrAlert(db, claim, orderId, 'timeout-reassign');  // restore timed-out driver (alert on double-fault; also the fall-back when eligibility can't be established — codex r4 P1)\n    }");
const reassignBody = [liftFn('buildAssignmentUpdates'), liftFn('expectedIneligibleOrMain'), liftFn('releaseToSinAsignar'), liftFn('releaseAndAlert'), liftFn('rollbackOrAlert'), `return (async () => {\n${REASSIGN_SEG}\n})();`].join('\n');
const REASSIGN_PARAMS = ['db', 'orderId', 'driverId', 'nextDriver', 'attempts', 'pickHandle', 'svcWriteOrFallback', 'claimDelivery', 'isExpectedEligibilityDenial', 'releaseDeliveryFromDriver', 'ServerValue', 'ACCEPT_TIMEOUT_MS', 'console'];
// eslint-disable-next-line no-new-func
const runReassignFn = new Function(...REASSIGN_PARAMS, reassignBody);
const runReassign = (o) => runReassignFn(o.db, o.orderId, o.driverId, o.nextDriver, 1, o.pickHandle, o.svcWriteOrFallback || svcHandleLib.svcWriteOrFallback, claimDelivery, o.isExpectedEligibilityDenial, releaseDeliveryFromDriver, { TIMESTAMP: NOW }, 60000, console);

// codex r6/r7 P2-2: bind the dispatch CLIENT batch to the ACTUAL shipped code STRUCTURALLY (acorn), tightly:
//   (a) select the UNIQUE EXPORTED assignOrderToDriver and fail if another declaration of that name exists (decoy);
//   (b) the CAS, the non-stacked deadline+for-of, and the half_claim_since clear must be DIRECT statements of that
//       function's real blocks (function body / else block / try block) — never a nested fn or a conditional;
//   (c) the CAS is validated structurally (runTransaction(ref(…assigned_driver_id…), <callback>)) and its REAL lifted
//       callback is EXECUTED (so a changed callback changes the result), never a handwritten equivalent.
const acorn = require('acorn');
function fnBodySpans(src, file) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  // (a) the unique EXPORTED declaration; reject any other declaration of the name (a decoy)
  const exported = ast.body.filter((s) => s.type === 'ExportNamedDeclaration' && s.declaration && s.declaration.type === 'FunctionDeclaration' && s.declaration.id.name === 'assignOrderToDriver').map((s) => s.declaration);
  assert.equal(exported.length, 1, `exactly one EXPORTED assignOrderToDriver in ${file}`);
  const fn = exported[0];
  let others = 0; (function w(n) { if (!n || typeof n !== 'object') return; if (n !== fn && n.type === 'FunctionDeclaration' && n.id && n.id.name === 'assignOrderToDriver') others++; for (const k in n) { const v = n[k]; if (Array.isArray(v)) v.forEach(w); else if (v && typeof v === 'object' && v.type) w(v); } })(ast);
  assert.equal(others, 0, `no decoy/nested assignOrderToDriver declaration in ${file}`);
  const stmts = fn.body.body;
  // (c) CAS: a DIRECT `const claim = await runTransaction(ref(…assigned_driver_id…), <callback>)` statement of the body
  const casDecl = stmts.find((s) => s.type === 'VariableDeclaration' && s.declarations[0] && s.declarations[0].id.name === 'claim' && s.declarations[0].init && s.declarations[0].init.type === 'AwaitExpression' && s.declarations[0].init.argument.type === 'CallExpression' && s.declarations[0].init.argument.callee.name === 'runTransaction');
  assert.ok(casDecl, `direct CAS (const claim = await runTransaction(…)) statement in assignOrderToDriver (${file})`);
  const casCall = casDecl.declarations[0].init.argument;
  assert.ok(casCall.arguments[0] && casCall.arguments[0].type === 'CallExpression' && casCall.arguments[0].callee.name === 'ref' && /assigned_driver_id/.test(src.slice(casCall.arguments[0].start, casCall.arguments[0].end)), `CAS ref targets the delivery assigned_driver_id (${file})`);
  const casCb = casCall.arguments[1];
  assert.ok(casCb && /Function/.test(casCb.type), `CAS callback is a function (${file})`);
  // (b) the main try block → the isStacked if/else → the else (non-stacked) block holds a DIRECT deadline decl + for-of;
  // the half_claim clear is a DIRECT expression-statement of the try block (not inside the if/else, a nested fn, etc.)
  const tryStmt = stmts.find((s) => s.type === 'TryStatement');
  assert.ok(tryStmt, `try block in assignOrderToDriver (${file})`);
  const tb = tryStmt.block.body;
  const ifStacked = tb.find((s) => s.type === 'IfStatement' && src.slice(s.test.start, s.test.end) === 'isStacked');
  assert.ok(ifStacked && ifStacked.alternate && ifStacked.alternate.type === 'BlockStatement', `isStacked if/else in assignOrderToDriver (${file})`);
  const elseStmts = ifStacked.alternate.body;
  const deadlineDecl = elseStmts.find((s) => s.type === 'VariableDeclaration' && s.declarations[0] && s.declarations[0].id.name === 'deadline' && /Date\.now\(\) \+ ACCEPT_TIMEOUT_MS/.test(src.slice(s.start, s.end)));
  const loop = elseStmts.find((s) => s.type === 'ForOfStatement' && /\[pickupTaskId, deliveryTaskId\]/.test(src.slice(s.right.start, s.right.end)) && /assignment_deadline/.test(src.slice(s.start, s.end)) && /assignment_attempts/.test(src.slice(s.start, s.end)));
  assert.ok(deadlineDecl && loop && deadlineDecl.end <= loop.start, `direct non-stacked deadline + for-of in the else block (${file})`);
  const clearStmt = tb.find((s) => s.type === 'ExpressionStatement' && s.expression.type === 'AssignmentExpression' && s.expression.operator === '=' && s.expression.right.type === 'Literal' && s.expression.right.value === null && /deliveryTaskId\}\/half_claim_since`\]$/.test(src.slice(s.expression.left.start, s.expression.left.end)));
  assert.ok(clearStmt, `direct half_claim_since clear statement in the try block (${file})`);
  return { casCbText: src.slice(casCb.start, casCb.end), batchText: src.slice(deadlineDecl.start, loop.end), clearText: src.slice(clearStmt.start, clearStmt.end) };
}
function clientBatch(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  const { casCbText, batchText, clearText } = fnBodySpans(src, file);
  // the 3 codex r7 drift probes — each must go RED (desktop AND mobile):
  const probes = [
    ['decoy nested assignOrderToDriver + exported clear deleted', (s) => s.replace('export async function assignOrderToDriver(orderId, driverId, allTasks = null) {', 'async function assignOrderToDriver() { updates[`tasks/${deliveryTaskId}/half_claim_since`] = null; }\nexport async function assignOrderToDriver(orderId, driverId, allTasks = null) {').replace('    updates[`tasks/${deliveryTaskId}/half_claim_since`] = null;\n', '')],
    ['clear moved into if (false) { … }', (s) => s.replace('    updates[`tasks/${deliveryTaskId}/half_claim_since`] = null;', '    if (false) { updates[`tasks/${deliveryTaskId}/half_claim_since`] = null; }')],
    ['CAS callback changed to return null (original kept in a block comment)', (s) => s.replace('(cur) => (cur == null ? driverId : undefined));', '/* (cur) => (cur == null ? driverId : undefined) */ (cur) => (cur == null ? null : undefined));')],
  ];
  for (const [label, mut] of probes) {
    const mutated = mut(src); assert.notStrictEqual(mutated, src, `${file}: probe '${label}' changed the source`);
    if (/CAS callback changed/.test(label)) {
      // (c) EXECUTION-bound: the lifted callback from the mutated source must execute DIFFERENTLY (claims null, not the driver)
      const r = fnBodySpans(mutated, file); const cb = new Function('driverId', `return ${r.casCbText};`)('DRV');
      assert.notEqual(cb(null), 'DRV', `probe '${label}': the executed lifted callback must change (${file})`);
    } else {
      assert.throws(() => fnBodySpans(mutated, file), `drift probe '${label}' must go RED (${file})`);
    }
  }
  // the REAL lifted CAS callback, executed in the test's transaction (a changed callback changes the claim)
  const claimCb = (driver) => new Function('driverId', `return ${casCbText};`)(driver);
  // eslint-disable-next-line no-new-func
  const batchFn = new Function('updates', 'pickupTaskId', 'deliveryTaskId', 'driverId', 'TASK_STATUS', 'serverTimestamp', 'ACCEPT_TIMEOUT_MS', `${batchText}\n${clearText}`);
  return {
    claimCb,
    build: (oid, driver) => { const u = {}; batchFn(u, `${oid}_pickup`, `${oid}_delivery`, driver, { ASSIGNED: 'assigned' }, () => NOW, 60000); return u; },
  };
}
const DISPATCH_ASSIGNERS = [
  { key: 'desktop', fn: 'assignOrderToDriver', ...clientBatch('xpizza-dispatch/xpizza-delivery.js') },
  { key: 'mobile', fn: 'assignOrderToDriver', ...clientBatch('xpizza-dispatch-mobile/xpizza-delivery.js') },
];

// codex r5 P1: a db view whose reads on the given paths NEVER resolve (writes + other reads delegate), to prove a
// HANGING denial-path read is bounded and recovery runs within budget. Only `.ref(path).once/.get` is intercepted.
function hangReads(realDb, hangPrefixes) {
  const hung = () => new Promise(() => {});
  return new Proxy(realDb, {
    get(t, prop, r) {
      if (prop === 'ref') return (p) => {
        const node = realDb.ref(p);
        if (hangPrefixes.some((h) => p === h || String(p).startsWith(h))) {
          return new Proxy(node, { get(nt, np) { if (np === 'once' || np === 'get') return hung; const v = nt[np]; return typeof v === 'function' ? v.bind(nt) : v; } });
        }
        return node;
      };
      const v = Reflect.get(t, prop, r); return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}
const withWatchdog = (p, ms, label) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error(`watchdog: ${label} did not recover within ${ms}ms`)), ms))]);
// Like hangReads, but hangs only the FIRST read on the prefix (subsequent reads delegate): the svcWriteOrFallback
// classification read times out, the independent expectedIneligibleOrMain read then succeeds (codex r6 P2-1).
function hangFirstRead(realDb, prefix) {
  let hung = false;
  return new Proxy(realDb, {
    get(t, prop, r) {
      if (prop === 'ref') return (p) => {
        const node = realDb.ref(p);
        if (String(p).startsWith(prefix)) return new Proxy(node, { get(nt, np) { if ((np === 'once' || np === 'get') && !hung) { hung = true; return () => new Promise(() => {}); } const v = nt[np]; return typeof v === 'function' ? v.bind(nt) : v; } });
        return node;
      };
      const v = Reflect.get(t, prop, r); return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}
// capture console.error around a block (the lifted handler + svc-handle both log through the global console)
async function captureErr(fn) { const logs = []; const orig = console.error; console.error = (...a) => { logs.push(a.map(String).join(' ')); }; try { await fn(); } finally { console.error = orig; } return logs; }

(async () => {
  const { buildCompleteTaskUpdates } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-driver', 'driver-complete.js')).href);
  const { stackedTasksToAccept } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-driver', 'stacking-helpers.js')).href);
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza', database: { rules: RULES } });

  const svc = env.authenticatedContext('svc-assigner', { svc_assigner: true }).database();   // RULES-ENFORCED as svc-assigner (the restricted handle)
  const drv = env.authenticatedContext(D_EN).database();             // the real driver (D_EN), rules-enforced
  const drv2 = env.authenticatedContext(D_EN2).database();           // the SECOND real driver (D_EN2), rules-enforced
  let n = 0; const ok = (l) => console.log(`  ok ${++n} ${l}`);

  // both-leg matrix assertion: after a finalize, BOTH the pickup and delivery legs carry the driver + status
  async function assertBothLegs(oid, driverId, status) {
    await env.withSecurityRulesDisabled(async (c) => {
      const db = c.database();
      for (const leg of ['pickup', 'delivery']) {
        const t = (await db.ref(`tasks/${oid}_${leg}`).get()).val() || {};
        assert.equal(t.assigned_driver_id, driverId, `${oid}_${leg} assigned_driver_id`);
        assert.equal(t.status, status, `${oid}_${leg} status`);
        assert.equal(t.auto_assigned, true, `${oid}_${leg} auto_assigned`);
      }
    });
  }
  // the REAL driver accept-update map (mirrors xpizza-delivery.js acceptTask: status+accepted_at on the task,
  // current_task_id + driver status, PLUS the same-hub stacked cascade via the real stackedTasksToAccept)
  function acceptUpdates(driverId, taskId, allTasks) {
    const u = { [`tasks/${taskId}/status`]: 'accepted', [`tasks/${taskId}/accepted_at`]: NOW, [`drivers/${driverId}/current_task_id`]: taskId, [`drivers/${driverId}/status`]: 'assigned' };
    for (const tid of stackedTasksToAccept(allTasks, driverId, allTasks[taskId] && allTasks[taskId].order_id)) { u[`tasks/${tid}/status`] = 'accepted'; u[`tasks/${tid}/accepted_at`] = NOW; }
    return u;
  }

  async function seedMode(mode) { await env.withSecurityRulesDisabled((c) => c.database().ref('platform_config/driver_enforcement_mode').set(mode)); }
  async function seedOrder(oid, { ownerDelivery = null, status = 'pending' } = {}) {
    await env.withSecurityRulesDisabled(async (c) => {
      const db = c.database();
      await db.ref(`tasks/${oid}_pickup`).set({ order_id: oid, type: 'pickup', status });
      const del = { order_id: oid, type: 'delivery', status }; if (ownerDelivery) del.assigned_driver_id = ownerDelivery;
      await db.ref(`tasks/${oid}_delivery`).set(del);
      await db.ref(`orders/${oid}`).set({ status: 'out_for_delivery', payment_method: 'cash', total: 200, customer_name: 'Ana' });
    });
  }

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.database();
    await db.ref(`driver_accounts/${D_EN}`).set({ enabled: true, onboarding_state: 'active', grandfathered: true });
    await db.ref(`driver_accounts/${D_EN2}`).set({ enabled: true, onboarding_state: 'active', grandfathered: true });
    await db.ref(`driver_accounts/${D_SUSP}`).set({ enabled: false, onboarding_state: 'active' });
    await db.ref(`drivers/${D_EN}`).set({ name: 'EN', status: 'off_shift', active: false });
    await db.ref(`drivers/${D_EN2}`).set({ name: 'EN2', status: 'off_shift', active: false });
    await db.ref(`drivers/${D_SUSP}`).set({ name: 'SU', status: 'off_shift', active: false });
  });

  // premise: the handle is rules-enforced (cannot write an arbitrary drivers field)
  await assertFails(svc.ref(`drivers/${D_EN}/name`).set('hacked')); ok('premise: the svc-assigner handle is RULES-ENFORCED (an arbitrary drivers write is denied)');

  // ================= TOLERANT (dark) — unchanged outcome through the real writers =================
  await seedMode(null);
  await seedOrder('oP1');
  const t0 = Date.now();
  const claim = await claimDelivery(svc, 'oP1', D_EN);   // COLD txn: the first real transaction on a fresh env
  assert.ok(claim.claimed, 'cold claim committed');
  ok(`COLD transaction: the first REAL claimDelivery (null→enabled) committed through the restricted handle (${Date.now() - t0}ms)`);
  await assertSucceeds(svc.ref().update(buildAssignmentUpdates('oP1', D_EN, 1, true, false))); await assertBothLegs('oP1', D_EN, 'assigned'); ok('TOLERANT: the REAL buildAssignmentUpdates finalizes the assignment on BOTH legs (matrix-asserted)');

  await seedOrder('oP4');
  await assertSucceeds((async () => { const c = await claimDelivery(svc, 'oP4', D_EN); assert.ok(c.claimed); await svc.ref().update(buildAssignmentUpdates('oP4', D_EN, 1, true, true)); })()); await assertBothLegs('oP4', D_EN, 'accepted'); ok('TOLERANT: real claim + STACKED builder (accepted) on both legs (matrix-asserted)');
  await seedOrder('oP5');
  await assertSucceeds((async () => { const c = await claimDelivery(svc, 'oP5', D_EN); assert.ok(c.claimed); await svc.ref().update(sweeperFinalize('oP5', D_EN)); })()); await assertBothLegs('oP5', D_EN, 'assigned'); ok('TOLERANT: real claim + SWEEPER builder (retry_count + last_swept, delivery leg)');

  // shift-open + bound token rotation
  await assertSucceeds(svc.ref().update({ [`drivers/${D_EN}/active`]: true, [`drivers/${D_EN}/status`]: 'available', [`drivers/${D_EN}/current_shift_id`]: 'sft1', [`drivers/${D_EN}/location_source`]: 'native', [`drivers/${D_EN}/ingest_token_hash`]: 'h1', 'driver_tokens/h1': { uid: D_EN, shift_id: 'sft1', issued_at: NOW, expires_at: NOW + 1000, revoked_at: null } })); ok('TOLERANT: svc opens a shift + mints the bound ingest token');
  await assertSucceeds(svc.ref().update({ [`drivers/${D_EN}/current_shift_id`]: 'sft2', [`drivers/${D_EN}/ingest_token_hash`]: 'h2', 'driver_tokens/h2': { uid: D_EN, shift_id: 'sft2', issued_at: NOW, expires_at: NOW + 1000, revoked_at: null }, 'driver_tokens/h1': null })); ok('TOLERANT: svc rotates to a new shift+token WITHIN the rotation (token.shift_id==current_shift_id, prior-token delete bound to the replacement)');
  // rotation NEGATIVE: a token whose shift_id does not match the driver current_shift_id is denied
  await assertFails(svc.ref().update({ [`drivers/${D_EN}/ingest_token_hash`]: 'h3', 'driver_tokens/h3': { uid: D_EN, shift_id: 'MISMATCH', issued_at: NOW, expires_at: NOW + 1000, revoked_at: null } })); ok('TOLERANT: rotation NEGATIVE — a token whose shift_id ≠ the driver current_shift_id is denied');
  // rotation DELETE NEGATIVE: deleting the live token WITHOUT installing a replacement (drivers still points at it) is denied
  await assertFails(svc.ref().update({ 'driver_tokens/h2': null })); ok('TOLERANT: rotation DELETE NEGATIVE — deleting the prior token while the driver still points at it (no replacement installed) is denied');

  // restoring (non-null) rollback through the restricted handle — UNCONDITIONAL: force the claim, then always roll back
  await seedOrder('oP3', { ownerDelivery: D_EN, status: 'assigned' });
  const rc = await claimDelivery(svc, 'oP3', D_EN2, { expectCurrent: D_EN });
  assert.ok(rc.claimed, 'forced reassign claim committed (so the rollback actually runs)');
  await env.withSecurityRulesDisabled(async (c) => { assert.equal((await c.database().ref('tasks/oP3_delivery/assigned_driver_id').get()).val(), D_EN2, 'claim moved it to D_EN2'); });
  await rc.rollback();
  await env.withSecurityRulesDisabled(async (c) => { assert.equal((await c.database().ref('tasks/oP3_delivery/assigned_driver_id').get()).val(), D_EN, 'rollback restored the ORIGINAL owner'); });
  ok('TOLERANT: a restoring (non-null) rollback through the restricted handle runs UNCONDITIONALLY and restores the prior owner');

  // ================= TIMEOUT reassign flow — the LIFTED monitorAssignmentTimeout core, run end-to-end (codex r3 P1-4) =================
  const setAcct = (uid, patch) => env.withSecurityRulesDisabled((c) => c.database().ref(`driver_accounts/${uid}`).update(patch));
  const legOf = async (oid, leg) => { let v; await env.withSecurityRulesDisabled(async (c) => { v = (await c.database().ref(`tasks/${oid}_${leg}`).get()).val() || {}; }); return v; };
  const alertFor = async (oid) => { let hit; await env.withSecurityRulesDisabled(async (c) => { hit = Object.values((await c.database().ref('dispatcher_alerts').get()).val() || {}).some((a) => a && a.type === 'no_drivers_available' && a.order_id === oid); }); return hit; };
  const seedReassign = async (oid) => { await seedOrder(oid, { ownerDelivery: D_EN, status: 'assigned' }); await env.withSecurityRulesDisabled((c) => c.database().ref(`tasks/${oid}_pickup/assigned_driver_id`).set(D_EN)); };

  // (A) flag-ON, eligible replacement → claim+finalize land BOTH legs on the next driver (allowed transition)
  await seedReassign('oT1');
  await env.withSecurityRulesDisabled((c) => runReassign({ db: c.database(), orderId: 'oT1', driverId: D_EN, nextDriver: { driverId: D_EN2 }, pickHandle: async () => svc, isExpectedEligibilityDenial: svcHandleLib.isExpectedEligibilityDenial }));
  await assertBothLegs('oT1', D_EN2, 'assigned'); ok('TIMEOUT (lifted handler, flag-ON): eligible replacement → claim+finalize land both legs on the next driver (allowed transition)');

  // (B) flag-ON, replacement SUSPENDED at CLAIM → release to SIN ASIGNAR + alert (never stranded on the timed-out owner)
  await setAcct(D_EN2, { enabled: false });
  await seedReassign('oT2');
  await env.withSecurityRulesDisabled((c) => runReassign({ db: c.database(), orderId: 'oT2', driverId: D_EN, nextDriver: { driverId: D_EN2 }, pickHandle: async () => svc, isExpectedEligibilityDenial: svcHandleLib.isExpectedEligibilityDenial }));
  { const d = await legOf('oT2', 'delivery'), p = await legOf('oT2', 'pickup');
    assert.equal(d.assigned_driver_id ?? null, null, 'delivery released'); assert.equal(d.status, 'pending'); assert.equal(p.assigned_driver_id ?? null, null, 'pickup released');
    assert.ok(await alertFor('oT2'), 'a no_drivers_available alert was raised'); }
  ok('TIMEOUT (lifted handler, flag-ON): a SUSPENDED replacement at CLAIM → releases both legs to SIN ASIGNAR + raises an alert (denied transition)');
  await setAcct(D_EN2, { enabled: true });

  // (C) flag-ON, replacement SUSPENDED BETWEEN claim and finalize → release to SIN ASIGNAR + alert, NEVER restore the expired owner
  await seedReassign('oT3');
  await env.withSecurityRulesDisabled(async (c) => {
    const bypass = c.database();
    const spyWrite = async (db, handle, fn, opts) => { if (opts.site === 'timeout.finalize') await bypass.ref(`driver_accounts/${D_EN2}/enabled`).set(false); return svcHandleLib.svcWriteOrFallback(db, handle, fn, opts); };
    await runReassign({ db: bypass, orderId: 'oT3', driverId: D_EN, nextDriver: { driverId: D_EN2 }, pickHandle: async () => svc, svcWriteOrFallback: spyWrite, isExpectedEligibilityDenial: svcHandleLib.isExpectedEligibilityDenial });
  });
  { const d = await legOf('oT3', 'delivery'), p = await legOf('oT3', 'pickup');
    assert.equal(d.assigned_driver_id ?? null, null, 'delivery released, NOT restored'); assert.notEqual(d.assigned_driver_id, D_EN, 'the EXPIRED owner was not restored'); assert.equal(p.assigned_driver_id ?? null, null);
    assert.ok(await alertFor('oT3'), 'a no_drivers_available alert was raised'); }
  ok('TIMEOUT (lifted handler, flag-ON): replacement SUSPENDED between claim and finalize → releases to SIN ASIGNAR + alert, never restores the expired owner');
  await setAcct(D_EN2, { enabled: true });

  // (D) flag-OFF (svcDb===db): a CLAIM denial propagates immediately — ZERO account reads, no release (byte-for-byte main)
  await setAcct(D_EN2, { enabled: false });
  await seedReassign('oT4');
  { let reads = 0; const spyClass = async (...a) => { reads++; return svcHandleLib.isExpectedEligibilityDenial(...a); };
    let threw = null; try { await runReassign({ db: svc, orderId: 'oT4', driverId: D_EN, nextDriver: { driverId: D_EN2 }, pickHandle: async () => svc, isExpectedEligibilityDenial: spyClass }); } catch (e) { threw = e; }
    assert.ok(threw && /permission/i.test(String((threw && (threw.code || threw.message)) || threw)), 'the denial PROPAGATED');
    assert.equal(reads, 0, 'ZERO account reads (classification short-circuited by svcDb===db)');
    assert.equal((await legOf('oT4', 'delivery')).assigned_driver_id, D_EN, 'delivery NOT released — still on the original owner'); }
  ok('TIMEOUT (lifted handler, flag-OFF): a claim denial propagates immediately — zero account reads, no release (byte-for-byte main)');
  await setAcct(D_EN2, { enabled: true });

  // (E) flag-OFF (svcDb===db): a FINALIZE denial takes the ORDINARY rollback path — zero account reads, no SIN ASIGNAR release
  await seedReassign('oT5');
  { let reads = 0; const spyClass = async (...a) => { reads++; return svcHandleLib.isExpectedEligibilityDenial(...a); };
    const spyWrite = async (db, handle, fn, opts) => { if (opts.site === 'timeout.finalize') await env.withSecurityRulesDisabled((c) => c.database().ref(`driver_accounts/${D_EN2}/enabled`).set(false)); return svcHandleLib.svcWriteOrFallback(db, handle, fn, opts); };
    await runReassign({ db: svc, orderId: 'oT5', driverId: D_EN, nextDriver: { driverId: D_EN2 }, pickHandle: async () => svc, svcWriteOrFallback: spyWrite, isExpectedEligibilityDenial: spyClass });
    assert.equal(reads, 0, 'ZERO account reads (classification short-circuited by svcDb===db)');
    assert.equal((await legOf('oT5', 'delivery')).assigned_driver_id, D_EN, 'ordinary rollback restored the owner — no SIN ASIGNAR release'); }
  ok('TIMEOUT (lifted handler, flag-OFF): a finalize denial takes the ordinary rollback path — zero account reads, no SIN ASIGNAR release (byte-for-byte main)');
  await setAcct(D_EN2, { enabled: true });

  // (F) flag-ON, FINALIZE denial but the eligibility CLASSIFICATION READ THROWS → fall back to MAIN: ordinary rollback,
  // both legs consistent on the pre-reassign owner, NO SIN ASIGNAR release, original denial not swallowed (codex r4 P1)
  await seedReassign('oT6');
  await env.withSecurityRulesDisabled(async (c) => {
    const bypass = c.database();
    const spyWrite = async (db, handle, fn, opts) => { if (opts.site === 'timeout.finalize') await bypass.ref(`driver_accounts/${D_EN2}/enabled`).set(false); return svcHandleLib.svcWriteOrFallback(db, handle, fn, opts); };
    const throwingClass = async () => { throw new Error('account read failed'); };
    await runReassign({ db: bypass, orderId: 'oT6', driverId: D_EN, nextDriver: { driverId: D_EN2 }, pickHandle: async () => svc, svcWriteOrFallback: spyWrite, isExpectedEligibilityDenial: throwingClass });
  });
  { const d = await legOf('oT6', 'delivery'), p = await legOf('oT6', 'pickup');
    assert.equal(d.assigned_driver_id, D_EN, 'classification threw → ordinary rollback restored the owner (main behaviour), NOT released');
    assert.equal(p.assigned_driver_id, D_EN, 'both legs consistent on the pre-reassign owner');
    assert.equal(await alertFor('oT6'), false, 'no SIN ASIGNAR / no_drivers_available alert when ineligibility was never established'); }
  ok('TIMEOUT (lifted handler, flag-ON): a FINALIZE denial whose eligibility classification THROWS falls back to main — ordinary rollback, both legs consistent, no release (codex r4 P1)');
  await setAcct(D_EN2, { enabled: true });

  // (G/H/I) codex r5 P1 — a HANGING denial-path read must never stall the handler: each case is bounded by the read
  // deadline and must RECOVER within the test's own watchdog. The read deadline is shortened for the test; the WRITE
  // wrapper is never deadline-wrapped (only the reads), so there is no late fallback write.
  const prevDeadline = svcHandleLib._setReadDeadlineForTest(300);
  try {
    // (G) TOLERANT, the ACCOUNT (classification) read hangs → can't establish ineligibility → main's ordinary rollback
    await seedReassign('oT7');
    await env.withSecurityRulesDisabled(async (c) => {
      const bypass = c.database();
      const hungDb = hangReads(bypass, [`driver_accounts/${D_EN2}`]);
      const spyWrite = async (db, handle, fn, opts) => { if (opts.site === 'timeout.finalize') await bypass.ref(`driver_accounts/${D_EN2}/enabled`).set(false); return svcHandleLib.svcWriteOrFallback(db, handle, fn, opts); };
      await withWatchdog(runReassign({ db: hungDb, orderId: 'oT7', driverId: D_EN, nextDriver: { driverId: D_EN2 }, pickHandle: async () => svc, svcWriteOrFallback: spyWrite, isExpectedEligibilityDenial: svcHandleLib.isExpectedEligibilityDenial }), 3000, 'hung account read');
    });
    { const d = await legOf('oT7', 'delivery'), p = await legOf('oT7', 'pickup');
      assert.equal(d.assigned_driver_id, D_EN, 'hung account read → ordinary rollback restored the owner'); assert.equal(p.assigned_driver_id, D_EN, 'both legs consistent');
      assert.equal(await alertFor('oT7'), false, 'no SIN ASIGNAR release when ineligibility could not be established (read hung)'); }
    ok('TIMEOUT (lifted handler, flag-ON, TOLERANT): a HUNG account (classification) read is bounded → main rollback within budget, both legs consistent (codex r5 P1)');
    await setAcct(D_EN2, { enabled: true });

    // (H) CLOSED, the account read hangs INSIDE expectedIneligibleOrMain (closed skips svcWriteOrFallback's own reads) →
    // rollback; the classifier-timeout log must still carry the KNOWN mode=closed (codex r7 P2-1).
    await seedReassign('oT8');
    await seedMode('closed');
    const logsH = await captureErr(() => env.withSecurityRulesDisabled(async (c) => {
      const bypass = c.database();
      const hungDb = hangReads(bypass, [`driver_accounts/${D_EN2}`]);
      const spyWrite = async (db, handle, fn, opts) => { if (opts.site === 'timeout.finalize') await bypass.ref(`driver_accounts/${D_EN2}/enabled`).set(false); return svcHandleLib.svcWriteOrFallback(db, handle, fn, opts); };
      await withWatchdog(runReassign({ db: hungDb, orderId: 'oT8', driverId: D_EN, nextDriver: { driverId: D_EN2 }, pickHandle: async () => svc, svcWriteOrFallback: spyWrite, isExpectedEligibilityDenial: svcHandleLib.isExpectedEligibilityDenial }), 3000, 'hung account read (closed)');
    }));
    { const d = await legOf('oT8', 'delivery'), p = await legOf('oT8', 'pickup');
      assert.equal(d.assigned_driver_id, D_EN, 'closed + hung account read → rollback restored the owner'); assert.equal(p.assigned_driver_id, D_EN, 'both legs consistent');
      assert.ok(logsH.some((l) => /classification unavailable/.test(l) && /read=account/.test(l) && /mode=closed/.test(l)), 'the closed-mode classifier timeout logged read=account + mode=closed (codex r7 P2-1)'); }
    ok('TIMEOUT (lifted handler, flag-ON, CLOSED): a HUNG account read is bounded → main rollback within budget, logging read=account + mode=closed (codex r5 P1 + r7 P2-1)');
    await seedMode(null);
    await setAcct(D_EN2, { enabled: true });

    // (I) TOLERANT, the MODE read hangs inside svcWriteOrFallback → it can't decide the fallback (throws the ORIGINAL denial);
    // the segment's INDEPENDENT account classification (not hung) positively establishes ineligibility → bounded release.
    // The timeout must be LOGGED on the release path too (codex r6 P2-1).
    await seedReassign('oT9');
    const logsI = await captureErr(() => env.withSecurityRulesDisabled(async (c) => {
      const bypass = c.database();
      const hungDb = hangReads(bypass, ['platform_config/driver_enforcement_mode']);
      const spyWrite = async (db, handle, fn, opts) => { if (opts.site === 'timeout.finalize') await bypass.ref(`driver_accounts/${D_EN2}/enabled`).set(false); return svcHandleLib.svcWriteOrFallback(db, handle, fn, opts); };
      await withWatchdog(runReassign({ db: hungDb, orderId: 'oT9', driverId: D_EN, nextDriver: { driverId: D_EN2 }, pickHandle: async () => svc, svcWriteOrFallback: spyWrite, isExpectedEligibilityDenial: svcHandleLib.isExpectedEligibilityDenial }), 3000, 'hung mode read');
    }));
    { const d = await legOf('oT9', 'delivery'), p = await legOf('oT9', 'pickup');
      assert.equal(d.assigned_driver_id ?? null, null, 'hung mode read bounded; the independent account classification established ineligibility → released'); assert.equal(p.assigned_driver_id ?? null, null);
      assert.ok(await alertFor('oT9'), 'the bounded recovery still raised the SIN ASIGNAR alert');
      assert.ok(logsI.some((l) => /classify_timeout/.test(l) && /mode/.test(l)), 'the MODE read timeout was logged (svc-handle)');
      assert.ok(logsI.some((l) => /classify_timeout carried/.test(l) && /release \(positively ineligible\)/.test(l)), 'the release path logged the carried timeout + decision'); }
    ok('TIMEOUT (lifted handler, flag-ON, TOLERANT): a HUNG mode read is bounded → release via the independent classification, WITH the timeout logged on the release path (codex r5 P1 + r6 P2-1)');
    await setAcct(D_EN2, { enabled: true });

    // (J) TOLERANT, the FIRST account read (svcWriteOrFallback) TIMES OUT, the SECOND (expectedIneligibleOrMain) succeeds
    // and establishes ineligibility → release, with BOTH the timeout log and the carried-timeout release log (codex r6 P2-1)
    await seedReassign('oT10');
    const logsJ = await captureErr(() => env.withSecurityRulesDisabled(async (c) => {
      const bypass = c.database();
      const hungDb = hangFirstRead(bypass, `driver_accounts/${D_EN2}`);
      const spyWrite = async (db, handle, fn, opts) => { if (opts.site === 'timeout.finalize') await bypass.ref(`driver_accounts/${D_EN2}/enabled`).set(false); return svcHandleLib.svcWriteOrFallback(db, handle, fn, opts); };
      await withWatchdog(runReassign({ db: hungDb, orderId: 'oT10', driverId: D_EN, nextDriver: { driverId: D_EN2 }, pickHandle: async () => svc, svcWriteOrFallback: spyWrite, isExpectedEligibilityDenial: svcHandleLib.isExpectedEligibilityDenial }), 3000, 'first account read hangs then succeeds');
    }));
    { const d = await legOf('oT10', 'delivery'), p = await legOf('oT10', 'pickup');
      assert.equal(d.assigned_driver_id ?? null, null, 'the second account read established ineligibility → released'); assert.equal(p.assigned_driver_id ?? null, null);
      assert.ok(await alertFor('oT10'), 'release alert raised');
      assert.ok(logsJ.some((l) => /classify_timeout/.test(l) && /account/.test(l)), 'the FIRST (svcWriteOrFallback) account-read timeout was logged');
      assert.ok(logsJ.some((l) => /classify_timeout carried/.test(l) && /release \(positively ineligible\)/.test(l)), 'the release path logged the carried timeout + the release decision'); }
    ok('TIMEOUT (lifted handler, flag-ON, TOLERANT): first account read TIMES OUT, second succeeds + ineligible → release + BOTH timeout logs (codex r6 P2-1)');
    await setAcct(D_EN2, { enabled: true });
  } finally { svcHandleLib._setReadDeadlineForTest(prevDeadline); }

  // DESKTOP/MOBILE assignment — the ACTUAL client batch construction, LIFTED from each client with a source-parity check,
  // plus the client's own CAS claim, run through the rules-enforced dispatcher handle for an eligible AND a denied
  // (suspended) target (codex r4 P2). Both legs are asserted; the §2 invariant bites both the claim and the batch.
  await env.withSecurityRulesDisabled((c) => c.database().ref('dispatchers/disp-parity').set({ name: 'Disp' }));
  const dispAuth = env.authenticatedContext('disp-parity', { dispatcher: true }).database();
  const bothLegsClient = async (oid, driver, status) => { for (const leg of ['pickup', 'delivery']) { const t = await legOf(oid, leg); assert.equal(t.assigned_driver_id, driver, `${oid}_${leg} driver`); assert.equal(t.status, status, `${oid}_${leg} status`); } };
  // the CAS runs the client's REAL lifted callback (codex r7 P2-2(c)) — a changed callback changes the claim
  const clientClaim = (oid, cb) => dispAuth.ref(`tasks/${oid}_delivery/assigned_driver_id`).transaction(cb);
  for (const client of DISPATCH_ASSIGNERS) {
    assert.equal(client.claimCb(D_EN)(null), D_EN, `${client.key}: the lifted CAS callback claims the driver on a null leaf`);
    // eligible: the client's real CAS claim commits, then its lifted batch lands BOTH legs (assigned)
    await seedOrder(`oD_${client.key}_ok`);
    const claimOk = await assertSucceeds(clientClaim(`oD_${client.key}_ok`, client.claimCb(D_EN)));
    assert.equal(claimOk.snapshot.val(), D_EN, 'the real CAS callback committed to the eligible driver');
    await assertSucceeds(dispAuth.ref().update(client.build(`oD_${client.key}_ok`, D_EN)));
    await bothLegsClient(`oD_${client.key}_ok`, D_EN, 'assigned');
    // denied (suspended): the §2 invariant bites BOTH the real CAS claim AND the lifted batch; assert both legs stay
    // pending/unassigned AFTER EACH denied operation (codex r6 P2-2)
    await seedOrder(`oD_${client.key}_no`);
    const legsPending = async (why) => { for (const leg of ['pickup', 'delivery']) { const t = await legOf(`oD_${client.key}_no`, leg); assert.equal(t.assigned_driver_id ?? null, null, `${why}: ${leg} stays unassigned`); assert.equal(t.status, 'pending', `${why}: ${leg} stays pending`); } };
    await assertFails(clientClaim(`oD_${client.key}_no`, client.claimCb(D_SUSP))); await legsPending('after denied CAS claim');
    await assertFails(dispAuth.ref().update(client.build(`oD_${client.key}_no`, D_SUSP))); await legsPending('after denied batch');
    ok(`DESKTOP/MOBILE (${client.key}): the REAL lifted ${client.fn} CAS claim + both-leg batch land for an eligible target and are DENIED for a suspended one (both legs stay pending/unassigned; scoped source-parity + drift-negative)`);
  }

  // the REAL driver completion batch (both-leg + stamp) through the driver handle
  await seedOrder('oP2', { ownerDelivery: D_EN, status: 'assigned' });
  await env.withSecurityRulesDisabled(async (c) => { await c.database().ref('tasks/oP2_delivery').update({ status: 'accepted' }); });
  let inputs; await env.withSecurityRulesDisabled(async (c) => { const db = c.database(); inputs = { task: (await db.ref('tasks/oP2_delivery').get()).val(), allTasks: (await db.ref('tasks').get()).val() || {} }; });
  await assertSucceeds(drv.ref().update(buildCompleteTaskUpdates({ driverId: D_EN, taskId: 'oP2_delivery', task: inputs.task, allTasks: inputs.allTasks, now: NOW }))); ok('TOLERANT: the REAL driver completion batch (buildCompleteTaskUpdates) lands + stamps');

  // ================= DRIVER ACCEPT (first / stacked / second) — the REAL driver-auth handle against the real rules =================
  // Advisor improvement: try to drive the ACTUAL web-SDK writers from xpizza-driver/xpizza-delivery.js; if that module
  // can't load in node (it imports the Firebase WEB SDK via bare specifiers that don't resolve from functions/), fall
  // back to the rule-path probe below and SAY WHY. The probe is itself faithful: it applies the EXACT acceptTask update
  // map (built from the real stackedTasksToAccept) through the rules-enforced driver-auth handle.
  let acceptVia = 'rule-path probe (driver-auth handle + real acceptTask update map)';
  try {
    await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-driver', 'xpizza-delivery.js')).href);
    acceptVia = 'real xpizza-delivery.js web-SDK writers';
  } catch (e) {
    console.log(`  note: web-SDK accept writers not loadable in node (${String(e && e.code || e.message).slice(0, 40)}); using the rule-path probe instead`);
  }
  async function readAllTasks() { let a; await env.withSecurityRulesDisabled(async (c) => { a = (await c.database().ref('tasks').get()).val() || {}; }); return a; }

  // first accept (lone order): the assigned driver flips their own pickup leg → accepted (+ driver fields)
  await seedOrder('oA1', { ownerDelivery: D_EN, status: 'assigned' });
  await env.withSecurityRulesDisabled(async (c) => { await c.database().ref('tasks/oA1_pickup/assigned_driver_id').set(D_EN); });
  await assertSucceeds(drv.ref().update(acceptUpdates(D_EN, 'oA1_pickup', await readAllTasks()))); ok(`DRIVER FIRST ACCEPT: the assigned driver accepts a lone order through the real rules [${acceptVia}]`);

  // stacked accept: accepting one same-hub order auto-accepts the driver's OTHER assigned same-hub order (real stackedTasksToAccept)
  await seedOrder('oA2', { ownerDelivery: D_EN, status: 'assigned' });
  await seedOrder('oA3', { ownerDelivery: D_EN, status: 'assigned' });
  await env.withSecurityRulesDisabled(async (c) => { const db = c.database(); await db.ref('tasks/oA2_pickup/assigned_driver_id').set(D_EN); await db.ref('tasks/oA3_pickup/assigned_driver_id').set(D_EN); });
  const stackUpd = acceptUpdates(D_EN, 'oA2_pickup', await readAllTasks());
  assert.ok(Object.keys(stackUpd).some((k) => k.startsWith('tasks/oA3_')), 'the real stackedTasksToAccept cascaded the SAME-HUB sibling order into the accept batch');
  await assertSucceeds(drv.ref().update(stackUpd)); await env.withSecurityRulesDisabled(async (c) => { assert.equal((await c.database().ref('tasks/oA3_pickup/status').get()).val(), 'accepted', 'the stacked sibling was auto-accepted'); }); ok('DRIVER STACKED ACCEPT: accepting one order auto-accepts the same-hub sibling (real cascade) through the rules');

  // second accept (cross-hub swipe): a pure owner task-status write (acceptSecondOrder writes no driver fields)
  await seedOrder('oS1', { ownerDelivery: D_EN, status: 'assigned' });
  await env.withSecurityRulesDisabled(async (c) => { await c.database().ref('tasks/oS1_pickup/assigned_driver_id').set(D_EN); });
  await assertSucceeds(drv.ref().update({ 'tasks/oS1_pickup/status': 'accepted', 'tasks/oS1_pickup/accepted_at': NOW })); ok('DRIVER SECOND ACCEPT: a cross-hub second accept (owner task-status write, no driver fields) is allowed');

  // NEGATIVE: a driver accepting a task that is NOT assigned to them is denied by the rules
  await assertFails(drv2.ref().update({ 'tasks/oA1_pickup/status': 'accepted', 'tasks/oA1_pickup/accepted_at': NOW })); ok('DRIVER ACCEPT NEGATIVE: a driver cannot accept a task assigned to a DIFFERENT driver (rule-denied)');

  // ================= CLOSED — the restricted handle is bitten for an ineligible driver =================
  await seedMode('closed');
  await seedOrder('oC1');
  await assertFails(claimDelivery(svc, 'oC1', D_SUSP)); ok('CLOSED: the real claim is DENIED for a SUSPENDED driver (the invariant bites the restricted handle)');
  await seedOrder('oC2');
  await assertSucceeds((async () => { const c = await claimDelivery(svc, 'oC2', D_EN); assert.ok(c.claimed); })()); ok('CLOSED: the real claim still succeeds for an ELIGIBLE driver');
  await seedMode(null);

  // ================= OFFLINE → reconnect delayed commit =================
  await seedOrder('oR1');
  svc.goOffline();
  const offlineWrite = svc.ref('tasks/oR1_delivery/assigned_driver_id').set(D_EN);
  svc.goOnline();
  await assertSucceeds(offlineWrite); ok('RECONNECT: a write queued while the restricted handle was OFFLINE commits on reconnect');

  // ================= SAFETY NET: svcWriteOrFallback real fallback (denied-in-tolerant → default handle + alert) =================
  const { svcWriteOrFallback } = require('../lib/svc-handle');
  await seedMode(null);   // tolerant
  await env.withSecurityRulesDisabled(async (c) => {
    const bypass = c.database();   // the DEFAULT (bypass) handle; svc is the rules-enforced handle
    await svcWriteOrFallback(bypass, svc, (h) => h.ref(`drivers/${D_EN}/name`).set('viaFallback'), { site: 'parity.test', target: D_EN });
    assert.equal((await bypass.ref(`drivers/${D_EN}/name`).get()).val(), 'viaFallback', 'the denied svc write fell back to the default handle');
    const alerts = (await bypass.ref('dispatcher_alerts').get()).val() || {};
    assert.ok(Object.values(alerts).some((a) => a.type === 'svc_handle_fallback' && a.site === 'parity.test'), 'a loud svc_handle_fallback alert was raised');
  });
  ok('SAFETY NET: an svc write DENIED in tolerant mode falls back to the default handle + raises a loud alert (real emulator)');

  // ================= LATENCY: rules-enforced handle vs bypass handle, the REAL claim→finalize cycle (measured, not asserted) =================
  // Measures the whole assignment unit the monitor pays — the claimDelivery transaction + the buildAssignmentUpdates
  // finalize — so the figure reflects the rule-evaluation cost of the actual critical path, not a bare leaf write.
  const N = 5;
  const seedBench = async (c, prefix) => { const db = c.database(); for (let i = 0; i < N; i++) { const oid = `${prefix}${i}`; await db.ref(`tasks/${oid}_pickup`).set({ order_id: oid, type: 'pickup', status: 'pending' }); await db.ref(`tasks/${oid}_delivery`).set({ order_id: oid, type: 'delivery', status: 'pending' }); } };
  const claimFinalize = async (dbh, oid) => { const c = await claimDelivery(dbh, oid, D_EN); assert.ok(c.claimed); await dbh.ref().update(buildAssignmentUpdates(oid, D_EN, 1, true, false)); };
  await env.withSecurityRulesDisabled((c) => seedBench(c, 'bSvc'));
  const sSvc = Date.now(); for (let i = 0; i < N; i++) await claimFinalize(svc, `bSvc${i}`); const svcMs = (Date.now() - sSvc) / N;
  let bypassMs; await env.withSecurityRulesDisabled(async (c) => { await seedBench(c, 'bByp'); const s = Date.now(); for (let i = 0; i < N; i++) await claimFinalize(c.database(), `bByp${i}`); bypassMs = (Date.now() - s) / N; });
  ok(`LATENCY (measured, not asserted): rules-enforced svc claim→finalize ${svcMs.toFixed(1)}ms vs bypass ${bypassMs.toFixed(1)}ms (Δ ${(svcMs - bypassMs).toFixed(1)}ms)`);

  await env.cleanup();
  console.log(`\ndriver-assignment-parity(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('driver-assignment-parity(emulator) FAILED:', e && e.stack || e); process.exit(1); });
