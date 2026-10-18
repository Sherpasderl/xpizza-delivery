/**
 * PLATFORM F2 Q3 (RUNBOOK-F2-Q3 §4; a Q4 PRECONDITION) — a dormant PRE-Q2 KDS that returns after the narrowing is denied CLEANLY.
 * The REAL kitchen SDK of main b98cd04d (git-archived) runs as an authenticated kitchen user of x_pizza (emulator mockUserToken)
 * against the N-HUMAN rules (xpizza-reference/f2-narrow/N-human.rules.json): its whole-collection subscriptions
 * (subscribeToOrders, subscribeScheduledOrders, subscribeCancelAcks — all root reads) are DENIED, and the denial is clean:
 *   - exactly its 3 listeners attach, and EACH is cancelled with PERMISSION_DENIED within a bound (observed, not inferred
 *     from silence — codex Q3 r1 P2-4);
 *   - then, over a quiet period: no order data ever reaches its callbacks, no re-subscribe (the listener count does not
 *     grow), no further cancellation;
 *   - no write is issued;
 *   - no uncaught exception or unhandled rejection.
 * Positive controls (so the denial is not vacuous):
 *   - the SAME pre-Q2 SDK under today's rules (R-pre = xpizza-reference/database.rules.json) receives the live order, the
 *     scheduled order and the acks, with no cancellation;
 *   - the Q2 SDK under N-human receives the live and the scheduled order through its location query, with no cancellation.
 * Harness integrity (codex Q3 r1 P2-3): the watchdog is armed first and ALL setup runs inside the guarded block; any harness
 * error exits non-zero, and so does reaching the end with zero assertions or an empty event loop before the verdict.
 * The old DRIVER build's equivalent is 2f's. Run: npm run test:kds-pre-q2-denial
 */
const watchdog = setTimeout(() => { console.error('kds-pre-q2-denial.emulator: FAIL — timed out'); process.exit(1); }, 240000);
let finished = false;
// an event loop that drains before the verdict (e.g. a swallowed setup failure) is a FAIL, never a silent exit 0
process.on('beforeExit', () => { if (!finished) { console.error('kds-pre-q2-denial.emulator: FAIL — exited before the verdict'); process.exit(1); } });
const uncaught = [];
// errors raised while subscriptions are live are RECORDED (asserted empty below), never swallowed: every phase re-checks them
const recordUncaught = (e) => uncaught.push(String((e && e.stack) || e));
process.on('uncaughtException', recordUncaught);
process.on('unhandledRejection', recordUncaught);

const DENY_BOUND_MS = 10000;
const QUIET_MS = 3000;
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let OLD = null;
let fs = null;
try {
  const assert = (await import('node:assert')).default;
  fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { execFileSync } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const { makeKdsLoader } = await import('./_kds-sdk-loader.mjs');

  const require = createRequire(import.meta.url);
  require('./_emulator-required')('database');
  const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.join(here, '..', '..');
  const RULES = {
    R: fs.readFileSync(path.join(ROOT, 'xpizza-reference', 'database.rules.json'), 'utf8'),
    H: fs.readFileSync(path.join(ROOT, 'xpizza-reference', 'f2-narrow', 'N-human.rules.json'), 'utf8'),
  };
  const UID = 'kds-old';
  const SEED = { [`kitchen/${UID}`]: true, [`restaurants/x_pizza/kitchen_staff/${UID}`]: true,
    'orders/O1': { order_id: 'O1', restaurant_id: 'x_pizza', status: 'new', created_at: 1 },
    'orders/O2': { order_id: 'O2', restaurant_id: 'x_pizza', status: 'cancelled', created_at: 1 },
    'orders/O3': { order_id: 'O3', restaurant_id: 'x_pizza', status: 'scheduled', created_at: 1, scheduled_for: 4102444800000, release_at: 4102443000000 },
    'kds_cancel_acks/O2': { at: 1, by: UID } };

  // the pre-Q2 kitchen folder
  OLD = fs.mkdtempSync(path.join(os.tmpdir(), 'kds-pre-q2-'));
  execFileSync('bash', ['-c', `git archive b98cd04d xpizza-kitchen | tar -x -C ${OLD}`], { cwd: ROOT });
  const OLD_KITCHEN = path.join(OLD, 'xpizza-kitchen');
  assert.ok(fs.existsSync(path.join(OLD_KITCHEN, 'xpizza-delivery.js')), 'the archived pre-Q2 SDK exists');

  // phase 1 (bounded): wait for `want` cancellations; phase 2: the quiet period. Returns every observation.
  async function run(label, rules, kitchenDir, subscribe, want) {
    const project = `demo-kds-preq2-${label.toLowerCase()}`;
    const env = await initializeTestEnvironment({ projectId: project, database: { rules } });
    const L = makeKdsLoader(project, { kitchenDir, mockUser: { sub: UID, user_id: UID } });
    try {
      await env.withSecurityRulesDisabled((ctx) => ctx.database().ref().update(SEED));
      const X = await L.loadKds('xpizzakitchen.netlify.app');
      const { __LISTENERS: LS, __WRITES: W } = await L.shim();
      const got = { orders: [], sched: [], acks: [] };
      const unsubs = subscribe(X, got);
      const t0 = Date.now();
      while (want > 0 && LS.cancels.length < want && Date.now() - t0 < DENY_BOUND_MS) await sleep(50);
      if (want === 0) await sleep(1500);   // controls: let the data arrive
      const phase1 = { attached: LS.attached, cancels: LS.cancels.slice(), got: JSON.parse(JSON.stringify(got)), ms: Date.now() - t0 };
      await sleep(QUIET_MS);
      const r = { got, phase1, attached2: LS.attached, cancels2: LS.cancels.slice(), writes: W.slice() };
      for (const u of unsubs) { try { u(); } catch (_) { /* best effort */ } }
      return r;
    } finally { await env.cleanup(); L.cleanup(); }
  }
  const OLD_SUBS = (X, got) => [X.subscribeToOrders((m) => got.orders.push(Object.keys(m || {}))), X.subscribeScheduledOrders((m) => got.sched.push(Object.keys(m || {}))), X.subscribeCancelAcks((m) => got.acks.push(Object.keys(m || {})))];
  const denied = (c) => /permission[_ ]denied/i.test(`${c.code} ${c.message}`);

  // the pre-Q2 SDK under N-human: each of its 3 subscriptions is CANCELLED with PERMISSION_DENIED, then stays quiet
  const old = await run('H-old', RULES.H, OLD_KITCHEN, OLD_SUBS, 3);
  assert.strictEqual(old.phase1.attached, 3, `exactly its three subscriptions attach (${old.phase1.attached})`);
  assert.strictEqual(old.phase1.cancels.length, 3, `all three are cancelled within ${DENY_BOUND_MS} ms (${JSON.stringify(old.phase1.cancels)})`);
  assert.ok(old.phase1.cancels.every(denied), `each cancellation is PERMISSION_DENIED (${JSON.stringify(old.phase1.cancels)})`);
  assert.deepStrictEqual(old.phase1.cancels.map((c) => c.path.replace(/^.*?\/\/[^/]+/, '')).sort(), ['/kds_cancel_acks', '/orders', '/orders'],
    `one per subscription: /orders (live), /orders (scheduled), /kds_cancel_acks (${JSON.stringify(old.phase1.cancels.map((c) => c.path))})`);
  ok(`pre-Q2 KDS (b98cd04d SDK) under N-human: its 3 whole-collection subscriptions attach and EACH is cancelled PERMISSION_DENIED (${old.phase1.ms} ms)`);
  assert.deepStrictEqual([old.got.orders, old.got.sched, old.got.acks], [[], [], []], `no data reaches the pre-Q2 callbacks (${JSON.stringify(old.got)})`);
  assert.strictEqual(old.attached2, 3, `no re-subscribe over the ${QUIET_MS} ms quiet period (listeners 3 → ${old.attached2})`);
  assert.strictEqual(old.cancels2.length, 3, `no further cancellation in the quiet period (${old.cancels2.length})`);
  assert.deepStrictEqual(old.writes, [], `no write issued (${JSON.stringify(old.writes)})`);
  assert.deepStrictEqual(uncaught, [], `no uncaught exception / unhandled rejection (${uncaught.join(' | ')})`);
  ok(`…and then stays clean for ${QUIET_MS} ms: no data, no re-subscribe, no further cancellation, no writes, no uncaught error`);

  // positive control 1: the same pre-Q2 SDK under today's rules receives the live order, the scheduled order and the acks
  const ctl = await run('R-old', RULES.R, OLD_KITCHEN, OLD_SUBS, 0);
  assert.ok(ctl.got.orders.some((k) => k.includes('O1')), `control: under today's rules the pre-Q2 SDK receives live O1 (${JSON.stringify(ctl.got)})`);
  assert.ok(ctl.got.sched.some((k) => k.includes('O3')), `control: and scheduled O3 (${JSON.stringify(ctl.got)})`);
  assert.ok(ctl.got.acks.some((k) => k.includes('O2')), `control: and its whole-collection acks (${JSON.stringify(ctl.got)})`);
  assert.deepStrictEqual(ctl.cancels2, [], `control: no cancellation under today's rules (${JSON.stringify(ctl.cancels2)})`);
  ok('control: the SAME pre-Q2 SDK under today\'s rules (R-pre) receives the live order, the scheduled order and the acks, no cancellation — the denial above is the narrowing, not the harness');

  // positive control 2: the Q2 SDK under N-human receives the live and the scheduled order through its location query
  const q2 = await run('H-q2', RULES.H, null, (X, got) => [X.subscribeToOrders((m) => got.orders.push(Object.keys(m || {}))), X.subscribeScheduledOrders((m) => got.sched.push(Object.keys(m || {})))], 0);
  assert.ok(q2.got.orders.some((k) => k.includes('O1')), `control: the Q2 SDK under N-human receives live O1 (${JSON.stringify(q2.got)})`);
  assert.ok(q2.got.sched.some((k) => k.includes('O3')), `control: and scheduled O3 (${JSON.stringify(q2.got)})`);
  assert.deepStrictEqual(q2.cancels2, [], `control: no cancellation (${JSON.stringify(q2.cancels2)})`);
  assert.deepStrictEqual(q2.writes, []);
  ok('control: the Q2 SDK under N-human receives the live and the scheduled order through its location query (orderByChild restaurant_id equalTo x_pizza), no cancellation');
  assert.deepStrictEqual(uncaught, [], `no uncaught exception (${uncaught.join(' | ')})`);
  assert.ok(n > 0, 'at least one assertion block ran');
} catch (e) {
  console.error('kds-pre-q2-denial.emulator: FAIL\n', e); process.exit(1);
} finally {
  if (OLD && fs) fs.rmSync(OLD, { recursive: true, force: true });
}
if (n !== 4) { console.error(`kds-pre-q2-denial.emulator: FAIL — ${n} of 4 assertion blocks ran`); process.exit(1); }
finished = true;
clearTimeout(watchdog);
console.log(`kds-pre-q2-denial.emulator: OK (${n})`);
process.exit(0);
