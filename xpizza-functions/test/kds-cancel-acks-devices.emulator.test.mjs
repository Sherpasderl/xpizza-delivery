/**
 * PLATFORM F2 Q2 (codex F2q2 r1 P2-2) — cross-device cancel-acks on the REAL kitchen SDK: two independent clients (A, B — each its
 * own firebase app and connection) on the RTDB emulator drive exactly what the KDS page calls: createKdsCancelAcks(onChange) →
 * set.setIds([...cancelled in view]) → writeCancelAck / removeCancelAck, reading set.acks() / isReady / isAbsent in onChange.
 * Asserted on each device's CALLBACK HISTORY (the acks() snapshot at every onChange), and on the instrumented listener counts:
 *   1. archive on A → shows on B; recall on B → clears on A (and on B)
 *   2. A goes OFFLINE, B archives, A reconnects → A converges to the archived state
 *   3. detach / re-attach: no stale ack after detach, UNREAD until the fresh listener delivers, no leaked listeners; teardown → 0
 * The rules here are permissive (this proves the SDK's cross-device behaviour; access is test:f2-access-rules).
 *   npm run test:kds-cancel-acks-devices
 */
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { makeKdsLoader } from './_kds-sdk-loader.mjs';

const require = createRequire(import.meta.url);
require('./_emulator-required')('database');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const PROJECT = 'demo-kds-acks-devices';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const env = await initializeTestEnvironment({ projectId: PROJECT, database: { rules: JSON.stringify({ rules: { '.read': true, '.write': true } }) } });
const L = makeKdsLoader(PROJECT);
try {
  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref().update({ 'orders/C1': { order_id: 'C1', restaurant_id: 'x_pizza', status: 'cancelled' }, 'orders/C2': { order_id: 'C2', restaurant_id: 'x_pizza', status: 'cancelled' } }));
  const A = await L.loadKds('xpizzakitchen.netlify.app');
  const B = await L.loadKds('xpizzakitchen.netlify.app');
  const { __LISTENERS: LS, goOffline, goOnline } = await L.shim();
  const hist = { A: [], B: [] };
  const mk = (X, who) => { const s = X.createKdsCancelAcks(() => { hist[who].push({ acks: Object.keys(s.acks()).sort().join(','), C1: s.isReady('C1') ? (s.isAbsent('C1') ? 'absent' : 'present') : 'unread' }); }); return s; };
  const sa = mk(A, 'A'); const sb = mk(B, 'B');
  sa.setIds(['C1']); sb.setIds(['C1']);
  assert.strictEqual(sa.isReady('C1'), false, 'before delivery the id is UNREAD');
  await sleep(700);
  assert.deepStrictEqual([hist.A.at(-1).C1, hist.B.at(-1).C1], ['absent', 'absent'], 'initial delivery: confirmed absent on both');
  assert.strictEqual(LS.active, 2, 'one listener per device per eligible order');

  // 1. archive on A → B; recall on B → A
  await A.writeCancelAck('C1'); await sleep(700);
  assert.strictEqual(hist.B.at(-1).C1, 'present', 'B sees A\'s archive'); assert.strictEqual(hist.A.at(-1).C1, 'present');
  await B.removeCancelAck('C1'); await sleep(700);
  assert.strictEqual(hist.A.at(-1).C1, 'absent', 'A sees B\'s recall'); assert.strictEqual(hist.B.at(-1).C1, 'absent');
  ok(`archive on A shows on B; recall on B clears on A — callback history A ${JSON.stringify(hist.A.map((h) => h.C1))}, B ${JSON.stringify(hist.B.map((h) => h.C1))}`);

  // 2. A offline; B archives; A reconnects → converges
  const aBefore = hist.A.length;
  goOffline(A.getDb());
  await B.writeCancelAck('C1'); await sleep(700);
  assert.strictEqual(hist.B.at(-1).C1, 'present');
  assert.ok(hist.A.slice(aBefore).every((h) => h.C1 !== 'present'), 'while offline A has NOT seen the archive');
  goOnline(A.getDb()); await sleep(1500);
  assert.strictEqual(hist.A.at(-1).C1, 'present', 'after reconnect A CONVERGES to the archived state');
  ok(`A offline → B archives → A reconnects → A converges (A's history while offline then after: ${JSON.stringify(hist.A.slice(aBefore).map((h) => h.C1))})`);

  // 3. detach / re-attach on A: no stale ack, UNREAD until delivered, no leaked listeners
  const activeBefore = LS.active;
  sa.setIds([]);
  assert.strictEqual(LS.active, activeBefore - 1, 'detach releases the listener');
  assert.deepStrictEqual(sa.acks(), {}, 'no stale ack after detach');
  sa.setIds(['C1', 'C2']);
  assert.strictEqual(sa.isReady('C1'), false, 're-attached: UNREAD until the fresh listener delivers');
  assert.strictEqual(LS.active, activeBefore + 1, 'exactly the eligible ids are listened to (C1 + C2)');
  await sleep(700);
  assert.strictEqual(hist.A.at(-1).C1, 'present', 'the fresh listener delivers the archived state');
  assert.strictEqual(sa.isAbsent('C2'), true);
  sa.setIds(['C2']); sa.setIds(['C2']); assert.strictEqual(LS.active, activeBefore, 'an unchanged set attaches nothing new');
  sa.teardown(); sb.teardown();
  assert.strictEqual(LS.active, 0, 'teardown → no listener left');
  assert.strictEqual(LS.attached, LS.detached, `every attached listener was detached (${LS.attached}/${LS.detached})`);
  ok(`detach → no stale ack; re-attach → UNREAD then delivered; no leaked listeners (attached ${LS.attached} = detached ${LS.detached}); teardown → 0 active`);
} finally {
  await env.cleanup(); L.cleanup();
}
console.log(`kds-cancel-acks-devices.emulator: OK (${n})`);
process.exit(0);
