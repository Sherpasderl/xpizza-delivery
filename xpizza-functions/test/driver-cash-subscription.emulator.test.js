/**
 * Authenticated-subscription coverage for the DISPATCH cash bar's /driver_cash read (driver-cuadre slice §8).
 *
 * Run against the Firebase RTDB emulator (from xpizza-functions/):
 *   node tools/emulator-run.js --only database "node test/driver-cash-subscription.emulator.test.js"
 *
 * Two things, against 2f's REAL /driver_cash rules:
 *   A. GRANT MATRIX — the reads the dispatch cash bar performs are authorized for a dispatcher and DENIED for
 *      everyone else: the parent /driver_cash read (dispatcher only; driver/customer/unauth/customer-token-with-
 *      dispatcher-uid all denied) + the per-driver child read (own driver / dispatcher allowed; other driver /
 *      customer denied). (2f's rules slice owns the full write/validate matrix; this is the READ grants the
 *      dispatch reader depends on.)
 *   B. SUBSCRIPTION WIRE — a value listener with an error callback (exactly what subscribeToDriverCash uses) FIRES
 *      onData for a dispatcher and fires the ERROR callback (not silence) for a denied context. This is why the
 *      cash bar can render an explicit error state instead of a silent L0 when the read is denied.
 *
 * Rules source: prefer the local xpizza-reference/database.rules.json once it carries the /driver_cash parent
 * .read (post-merge); pre-merge, fall back to 2f's commit 3f37c79 (advisor/cuadre-3f37c79) — the authoritative
 * grants for this slice (advisor-directed). Coordinate with xpizza-delivery-2f only if the READ grants move.
 *
 * Plain-node style (no jest) to match the repo's existing emulator tests.
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

// ── Load 2f's /driver_cash rules (local-preferred, 3f37c79-fallback) ──
function loadRules() {
  const localPath = path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json');
  try {
    const local = fs.readFileSync(localPath, 'utf8');
    const dc = JSON.parse(local).rules && JSON.parse(local).rules.driver_cash;
    if (dc && typeof dc['.read'] === 'string' && dc['.read'].includes('dispatchers')) {
      console.log('  (rules: local xpizza-reference/database.rules.json — carries the /driver_cash parent .read)');
      return local;
    }
  } catch (_) { /* fall through to 2f's commit */ }
  console.log('  (rules: git show 3f37c79:xpizza-reference/database.rules.json — 2f advisor/cuadre-3f37c79)');
  return execSync('git show 3f37c79:xpizza-reference/database.rules.json', { cwd: __dirname, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

const DISP = 'disp-uid';        // a dispatcher (seeded into /dispatchers)
const DRV = 'drv-uid';          // authenticated driver, NOT a dispatcher
const OTHER = 'other-drv-uid';  // a different driver
const CUST = 'cust-uid';        // a customer-claim token

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
  const assert = require('assert');

  // Faithfulness guard: the REAL reader uses a value listener on 'driver_cash' WITH an error callback — so the
  // wire exercised below matches production (not a hand-rolled shape). [test-must-originate-from-real-writer]
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
    await db.ref(`driver_cash/${OTHER}/s1/cuadre`).set({ cash_owed: 50, cash_order_count: 1, closed_at: Date.now(), provisional: true });
  });

  const dispDb = env.authenticatedContext(DISP).database();                       // dispatcher
  const drvDb = env.authenticatedContext(DRV).database();                         // plain driver
  const custDb = env.authenticatedContext(CUST, { customer: true }).database();   // customer-claim token
  const dispCustDb = env.authenticatedContext(DISP, { customer: true }).database(); // dispatcher UID but customer token
  const anonDb = env.unauthenticatedContext().database();                         // unauthenticated
  const get = (db, p) => db.ref(p).get();

  // ── A. GRANT MATRIX ──────────────────────────────────────────────────────────────────────────────
  await ok('A: DISPATCHER reads the /driver_cash PARENT (the cash bar subscription)', get(dispDb, 'driver_cash'));
  await no('A: a plain driver CANNOT read the /driver_cash parent', get(drvDb, 'driver_cash'));
  await no('A: a customer-claim token CANNOT read the parent', get(custDb, 'driver_cash'));
  await no('A: a customer token WITH a dispatcher uid CANNOT read the parent (customer !== true)', get(dispCustDb, 'driver_cash'));
  await no('A: unauthenticated CANNOT read the parent', get(anonDb, 'driver_cash'));
  await ok('A: a driver reads their OWN child', get(drvDb, `driver_cash/${DRV}`));
  await no('A: a driver CANNOT read ANOTHER driver\'s child', get(drvDb, `driver_cash/${OTHER}`));
  await ok('A: a dispatcher reads any driver\'s child', get(dispDb, `driver_cash/${OTHER}`));
  await no('A: a customer-claim token CANNOT read a child (absolute customer exclusion)', get(custDb, `driver_cash/${DRV}`));

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
