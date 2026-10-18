/**
 * PLATFORM F2 Q3 (RUNBOOK-F2-Q3 §4; a Q4 PRECONDITION) — a dormant PRE-Q2 KDS that returns after the narrowing is denied CLEANLY.
 * The REAL kitchen SDK of main b98cd04d (git-archived) runs as an authenticated kitchen user of x_pizza (emulator mockUserToken)
 * against the N-HUMAN rules (xpizza-reference/f2-narrow/N-human.rules.json): its whole-collection subscriptions
 * (subscribeToOrders, subscribeScheduledOrders, subscribeCancelAcks — all root reads) are DENIED, and the denial is clean:
 *   - no order data ever reaches its callbacks;
 *   - no retry / re-subscribe storm (the listener count does not grow while we wait);
 *   - no write is issued;
 *   - no uncaught exception or unhandled rejection.
 * Positive controls (so the denial is not vacuous):
 *   - the SAME pre-Q2 SDK under today's rules (R-pre = xpizza-reference/database.rules.json) receives the order;
 *   - the Q2 SDK under N-human receives the order through its location query.
 * The old DRIVER build's equivalent is 2f's. Run: npm run test:kds-pre-q2-denial
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeKdsLoader } from './_kds-sdk-loader.mjs';

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
  'orders/O1': { order_id: 'O1', restaurant_id: 'x_pizza', status: 'new', created_at: 1 }, 'orders/O2': { order_id: 'O2', restaurant_id: 'x_pizza', status: 'cancelled', created_at: 1 },
  'kds_cancel_acks/O2': { at: 1, by: UID } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const uncaught = [];
// record errors raised by the SDK while subscriptions are live (asserted empty), but never swallow a harness failure: after the
// final assertion the handlers are removed, and a top-level rejection exits non-zero via the catch below
const recordUncaught = (e) => uncaught.push(String(e && e.message));
process.on('uncaughtException', recordUncaught);
process.on('unhandledRejection', recordUncaught);

// the pre-Q2 kitchen folder
const OLD = fs.mkdtempSync(path.join(os.tmpdir(), 'kds-pre-q2-'));
execFileSync('bash', ['-c', `git archive b98cd04d xpizza-kitchen | tar -x -C ${OLD}`], { cwd: ROOT });
const OLD_KITCHEN = path.join(OLD, 'xpizza-kitchen');

async function run(label, rules, kitchenDir, subscribe) {
  const project = `demo-kds-preq2-${label.toLowerCase()}`;
  const env = await initializeTestEnvironment({ projectId: project, database: { rules } });
  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref().update(SEED));
  const L = makeKdsLoader(project, { kitchenDir, mockUser: { sub: UID, user_id: UID } });
  try {
    const X = await L.loadKds('xpizzakitchen.netlify.app');
    const { __LISTENERS: LS, __WRITES: W } = await L.shim();
    const got = { orders: [], sched: [], acks: [] };
    const unsubs = subscribe(X, got);
    await sleep(1500);
    const attachedAfterFirst = LS.attached;
    await sleep(3000);
    const r = { got, attached1: attachedAfterFirst, attached2: LS.attached, writes: W.slice() };
    for (const u of unsubs) { try { u(); } catch (_) { /* best effort */ } }
    return r;
  } finally { await env.cleanup(); L.cleanup(); }
}
const OLD_SUBS = (X, got) => [X.subscribeToOrders((m) => got.orders.push(Object.keys(m || {}))), X.subscribeScheduledOrders((m) => got.sched.push(Object.keys(m || {}))), X.subscribeCancelAcks((m) => got.acks.push(Object.keys(m || {})))];

const watchdog = setTimeout(() => { console.error('kds-pre-q2-denial.emulator: FAIL — timed out'); process.exit(1); }, 240000);
try {
  // the pre-Q2 SDK under N-human: denied cleanly
  const old = await run('H-old', RULES.H, OLD_KITCHEN, OLD_SUBS);
  assert.deepStrictEqual([old.got.orders, old.got.sched, old.got.acks], [[], [], []], `no data reaches the pre-Q2 callbacks under N-human (${JSON.stringify(old.got)})`);
  assert.strictEqual(old.attached2, old.attached1, `no re-subscribe storm (listeners ${old.attached1} → ${old.attached2})`);
  assert.ok(old.attached1 <= 3, `at most its three subscriptions were attached (${old.attached1})`);
  assert.deepStrictEqual(old.writes, [], `no write issued (${JSON.stringify(old.writes)})`);
  assert.deepStrictEqual(uncaught, [], `no uncaught exception / unhandled rejection (${uncaught.join(' | ')})`);
  ok(`pre-Q2 KDS (b98cd04d SDK) under N-human: its 3 whole-collection subscriptions are DENIED — no data, no re-subscribe (${old.attached1} listeners, unchanged over 3 s), no writes, no uncaught error`);

  // positive control 1: the same pre-Q2 SDK under today's rules receives the order
  const ctl = await run('R-old', RULES.R, OLD_KITCHEN, OLD_SUBS);
  assert.ok(ctl.got.orders.some((k) => k.includes('O1')), `control: under today's rules the pre-Q2 SDK receives O1 (${JSON.stringify(ctl.got)})`);
  assert.ok(ctl.got.acks.some((k) => k.includes('O2')), 'control: and its whole-collection acks');
  ok('control: the SAME pre-Q2 SDK under today\'s rules (R-pre) receives the orders and the acks — the denial above is the narrowing, not the harness');

  // positive control 2: the Q2 SDK under N-human receives the order through its location query
  const q2 = await run('H-q2', RULES.H, null, (X, got) => [X.subscribeToOrders((m) => got.orders.push(Object.keys(m || {}))), X.subscribeScheduledOrders((m) => got.sched.push(Object.keys(m || {})))]);
  assert.ok(q2.got.orders.some((k) => k.includes('O1')), `control: the Q2 SDK under N-human receives O1 (${JSON.stringify(q2.got)})`);
  assert.deepStrictEqual(q2.writes, []);
  ok('control: the Q2 SDK under N-human receives O1 through its location query (orderByChild restaurant_id equalTo x_pizza)');
  assert.deepStrictEqual(uncaught, [], `no uncaught exception (${uncaught.join(' | ')})`);
} catch (e) {
  console.error('kds-pre-q2-denial.emulator: FAIL\n', e); process.exit(1);
} finally {
  fs.rmSync(OLD, { recursive: true, force: true });
}
clearTimeout(watchdog);
console.log(`kds-pre-q2-denial.emulator: OK (${n})`);
process.exit(0);
