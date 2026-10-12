/**
 * Authenticated-subscription coverage for the DISPATCH cash bar's /driver_cash read (driver-cuadre slice §8).
 *
 * Run against the Firebase RTDB emulator (from xpizza-functions/):
 *   npm run test:driver-cash-subscription
 *     = node tools/emulator-run.js --only database "node test/driver-cash-subscription.emulator.test.js"
 *
 * The UNIQUE dispatch-side concern: the dispatch cash bar subscribes to the /driver_cash PARENT, and must render
 * an explicit error (never a silent L0) when that read is denied. So this proves:
 *   A. SMOKE (one parent allow/deny pair) — a dispatcher CAN read the /driver_cash parent; a plain driver CANNOT.
 *      (2f's driver-cuadre-rules emulator test owns the FULL grant matrix — child reads, customer/unauth/mixed-role
 *      denials, writes/validates. This keeps only the smoke pair the dispatch reader directly depends on.)
 *   B. SUBSCRIPTION WIRE — a value listener with an error callback (the exact shape subscribeToDriverCash uses)
 *      FIRES onData for a dispatcher and fires the ERROR callback (not silence/timeout) for a denied context. That
 *      error callback is what lets the cash bar render its explicit error state instead of a silent L0.
 *
 * RULES SOURCE: ONLY the rules file in THIS tree (xpizza-reference/database.rules.json). This test ships WITH the
 * driver-cuadre rules (deploy order: rules -> driver-shift fns -> dispatch -> driver app), so it is green only once
 * integrated with that branch. If the tree's rules lack the /driver_cash parent grant it FAILS LOUDLY — it never
 * silently tests another commit's rules.
 *
 * Plain-node style (no jest) to match the repo's existing emulator tests.
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

// Read ONLY this tree's rules, so the test always verifies what ships with it. Fail loudly if the /driver_cash
// parent grant isn't present yet (expected until integrated with the cuadre branch — they deploy together).
function loadRules() {
  const rules = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
  const dc = (JSON.parse(rules).rules || {}).driver_cash;
  assert.ok(
    dc && typeof dc['.read'] === 'string' && dc['.read'].includes('dispatchers'),
    "xpizza-reference/database.rules.json lacks the /driver_cash parent .read grant — this test ships WITH the " +
    "driver-cuadre rules (2f's slice) and is green only once integrated with that branch (they deploy together).");
  return rules;
}

const DISP = 'disp-uid';   // a dispatcher (seeded into /dispatchers)
const DRV = 'drv-uid';     // authenticated driver, NOT a dispatcher

let n = 0;
const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ✓ ${++n} ${label}`); };
const no = async (label, pr) => { await assertFails(pr); console.log(`  ✓ ${++n} ${label}`); };

// A value-listener subscription with BOTH callbacks (the exact shape subscribeToDriverCash uses) → resolves with
// the FIRST of { data | error | timeout }.
function subscribeOnce(db, p, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const r = db.ref(p);
    let done = false;
    const onData = (snap) => { if (done) return; done = true; r.off('value', onData); resolve({ kind: 'data', val: snap.val() }); };
    const onErr = (err) => { if (done) return; done = true; r.off('value', onData); resolve({ kind: 'error', code: err && err.code }); };
    r.on('value', onData, onErr);
    setTimeout(() => { if (done) return; done = true; r.off('value', onData); resolve({ kind: 'timeout' }); }, timeoutMs);
  });
}

(async () => {
  // Faithfulness guard: the REAL reader uses a value listener on 'driver_cash' WITH an error callback — so the wire
  // exercised below matches production (not a hand-rolled shape). [test-must-originate-from-real-writer]
  const readerSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-dispatch', 'xpizza-delivery.js'), 'utf8');
  const sub = readerSrc.slice(readerSrc.indexOf('export function subscribeToDriverCash'), readerSrc.indexOf('export function subscribeToScheduledOrders'));
  assert.ok(/ref\(db,\s*'driver_cash'\)/.test(sub), "reader reads 'driver_cash'");
  assert.ok(/onValue\(\s*[\s\S]*?\(err\)\s*=>\s*\{\s*if\s*\(onError\)\s*onError\(err\)/.test(sub), 'reader passes an ERROR callback to onValue (surfaces a denied read, never silent)');
  console.log(`  ✓ ${++n} reader subscribeToDriverCash = value-listener on driver_cash + error callback (the wire tested below)`);

  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-drivercash', database: { rules: loadRules() } });

  // Seed /dispatchers/{DISP} + a cuadre record with rules DISABLED.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref('dispatchers/' + DISP).set(true);
    await db.ref(`driver_cash/${DRV}/s1/cuadre`).set({ cash_owed: 100, cash_order_count: 1, closed_at: Date.now(), provisional: false });
  });

  const dispDb = env.authenticatedContext(DISP).database();   // dispatcher
  const drvDb = env.authenticatedContext(DRV).database();     // plain driver (not a dispatcher)
  const get = (db, p) => db.ref(p).get();

  // ── A. SMOKE — one parent allow/deny pair (2f's rules test owns the full matrix) ──────────────────
  await ok('A: DISPATCHER reads the /driver_cash PARENT (the cash-bar subscription)', get(dispDb, 'driver_cash'));
  await no('A: a plain driver CANNOT read the /driver_cash parent', get(drvDb, 'driver_cash'));

  // ── B. SUBSCRIPTION WIRE — onData for a dispatcher; the ERROR callback for a denied context ────────
  const dispSub = await subscribeOnce(dispDb, 'driver_cash');
  assert.strictEqual(dispSub.kind, 'data', 'dispatcher subscription FIRES onData (not error/timeout)');
  assert.ok(dispSub.val && dispSub.val[DRV], 'dispatcher subscription delivers the driver_cash snapshot');
  console.log(`  ✓ ${++n} B: dispatcher value-listener fires onData with the driver_cash snapshot`);

  const drvSub = await subscribeOnce(drvDb, 'driver_cash');
  assert.strictEqual(drvSub.kind, 'error', 'a denied parent subscription FIRES the error callback (NOT silence/timeout) → the cash bar renders its explicit error state, never a silent L0');
  console.log(`  ✓ ${++n} B: a denied (non-dispatcher) value-listener fires the ERROR callback (→ error state, never L0)`);

  await env.cleanup();
  console.log(`\ndriver-cash-subscription: OK (${n} checks)`);
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAIL:', e && (e.stack || e.message)); process.exit(1); });
