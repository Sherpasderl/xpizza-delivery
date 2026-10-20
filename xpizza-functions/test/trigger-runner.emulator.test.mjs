/**
 * TRACKER FIXES milestone 1 — the _trigger-runner self-test, against the REAL index.js exports on the RTDB emulator.
 *  (1) a status write inside a step yields events for the real /orders/{orderId}/status triggers, delivered via .run(), and their
 *      own writes cascade (the tracking mirror's status lands);
 *  (2) retry follows EXPORT METADATA: a throwing retry:false handler is NOT re-delivered; a throwing retry:true one IS;
 *  (3) negative controls: an Admin write outside any step fails quiesce ("unattributed"); overlapping steps throw; a client
 *      write outside a step throws;
 *  (4) A→B then B→C in two steps → two events (no lost intermediate);
 *  (5)–(7) codex build r1 P1-3: per-WRITE capture — two writes in ONE step → two events; a committed write then a throw keeps its
 *      event; a failed client write releases the lock.
 * Run: node tools/emulator-run.js --only firestore,database --project demo-xpizza "node test/trigger-runner.emulator.test.mjs"
 */
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { makeTriggerRunner, listDatabaseTriggers } from './_trigger-runner.mjs';

const require = createRequire(import.meta.url);
require('./_emulator-required')('database');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'test-secret';
const app = require('../index.js');
const whatsapp = require('../whatsapp');
whatsapp.sendMessage = async () => ({ id: 'stub' });   // no external sends in this self-test
const { getDatabase } = require('firebase-admin/database');
const { onValueWritten } = require('firebase-functions/v2/database');
const db = getDatabase();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const watchdog = setTimeout(() => { console.error('trigger-runner: FAIL — timed out'); process.exit(1); }, 180000);
try {
  assert.match(db.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost)/, 'emulator only');
  await db.ref('/').set(null);
  const OID = 'o_tr_1', TOK = 'TOKtr1';
  await db.ref().update({
    [`orders/${OID}`]: { order_id: OID, restaurant_id: 'tb_centro', status: 'ready', tracking_token: TOK, payment_method: 'cash', created_at: 1 },
    [`order_tracking/${TOK}`]: { order_id: OID, status: 'ready', created_at: 1 },
  });

  const trig = listDatabaseTriggers(app);
  assert.ok(trig.length >= 20, `the runner discovers the real database triggers (${trig.length})`);
  assert.strictEqual(trig.find((t) => t.name === 'clearTrackerMirrorOnDone').retry, true);
  assert.strictEqual(trig.find((t) => t.name === 'sendOrderStatusNotifications').retry, false);
  ok(`discovers ${trig.length} real database triggers with their patterns and retry metadata (clearTrackerMirrorOnDone retry:true; sendOrderStatusNotifications retry:false)`);

  // (1) + (4)
  const R = makeTriggerRunner({ app, db, entities: { orders: [OID] }, only: ['sendOrderStatusNotifications', 'mirrorStatusToHistory', 'clearTrackerMirrorOnDone'] });
  await R.step('status→out_for_delivery', () => db.ref(`orders/${OID}/status`).set('out_for_delivery'));
  await R.step('status→delivered', () => db.ref(`orders/${OID}/status`).set('delivered'));
  const statusEvents = R.queue.filter((e) => e.path === `orders/${OID}/status`).map((e) => `${e.trigger.name}:${e.before}→${e.after}`);
  assert.ok(statusEvents.includes('sendOrderStatusNotifications:ready→out_for_delivery') && statusEvents.includes('sendOrderStatusNotifications:out_for_delivery→delivered'), `two steps → two events each, no lost intermediate (${statusEvents.join(', ')})`);
  await R.quiesce();
  assert.deepStrictEqual(R.failures, []);
  assert.strictEqual((await db.ref(`order_tracking/${TOK}/status`).once('value')).val(), 'delivered', 'the real handlers ran via .run() and their writes landed');
  assert.ok(R.delivered.some((d) => d.startsWith('clearTrackerMirrorOnDone')), 'clearTrackerMirrorOnDone delivered on the leaving edge');
  ok(`A→B, B→C in two steps → events ${statusEvents.length} (each transition seen); the real triggers ran via .run(), the tracking status landed (${R.delivered.length} deliveries)`);
  R.close();

  // (2) retry follows export metadata — real firebase-functions wrappers
  let calls = { noRetry: 0, retry: 0 };
  const fake = {
    boomNoRetry: onValueWritten({ ref: '/orders/{orderId}/status', region: 'us-central1' }, async () => { calls.noRetry += 1; throw new Error('boom'); }),
    boomRetry: onValueWritten({ ref: '/orders/{orderId}/status', region: 'us-central1', retry: true }, async () => { calls.retry += 1; if (calls.retry < 3) throw new Error('flaky'); }),
  };
  const R2 = makeTriggerRunner({ app: fake, db, entities: { orders: [OID] } });
  await R2.step('status→cancelled', () => db.ref(`orders/${OID}/status`).set('cancelled'));
  await R2.quiesce();
  assert.strictEqual(calls.noRetry, 1, 'a throwing retry:false handler is delivered ONCE (not re-delivered)');
  assert.strictEqual(calls.retry, 3, 'a throwing retry:true handler is re-delivered until it succeeds');
  assert.deepStrictEqual(R2.failures.map((f) => f.label), ['boomNoRetry(orders/o_tr_1/status)'], 'only the retry:false failure is recorded');
  ok('retry follows export metadata: retry:false → 1 delivery + recorded failure; retry:true → re-delivered (3 attempts) until success');
  R2.close();

  // (3) negative controls
  const R3 = makeTriggerRunner({ app: fake, db, entities: { orders: [OID] } });
  await db.ref(`orders/${OID}/note`).set('outside');   // Admin write outside any step
  await assert.rejects(R3.quiesce(), /unattributed Admin write/, 'an Admin write outside a step fails quiesce');
  R3.close();
  const R4 = makeTriggerRunner({ app: fake, db, entities: { orders: [OID] } });
  await assert.rejects(R4.step('outer', () => R4.step('inner', async () => {})), /nested\/overlapping step/, 'overlapping steps throw');
  await assert.rejects(R4.clientHooks.beforeWrite(), /client write outside step/i, 'a client write outside a step is refused');
  R4.close();
  ok('negative controls: an unattributed Admin write fails quiesce; overlapping steps throw; a client write outside a step throws');

  // (5) codex build r1 P1-3: two sequential writes INSIDE ONE step → TWO events (A→B, B→C), never collapsed to A→C
  await db.ref(`orders/${OID}/status`).set('ready');
  const R5 = makeTriggerRunner({ app: fake, db, entities: { orders: [OID] } });
  await R5.step('two writes', async () => { await db.ref(`orders/${OID}/status`).set('preparing'); await db.ref(`orders/${OID}/status`).set('out_for_delivery'); });
  const ev5 = [...new Set(R5.queue.map((e) => `${e.before}→${e.after}`))];
  assert.deepStrictEqual(ev5, ['ready→preparing', 'preparing→out_for_delivery'], `two writes in one step → two transitions (${ev5})`);
  R5.queue.length = 0; R5.close();
  ok('per-write capture: two sequential writes inside ONE step yield two events (A→B, B→C), not A→C');

  // (6) a committed write followed by a THROW in the same step: the step rethrows AND the committed write's event is kept
  const R6 = makeTriggerRunner({ app: fake, db, entities: { orders: [OID] } });
  await assert.rejects(R6.step('write then throw', async () => { await db.ref(`orders/${OID}/status`).set('delivered'); throw new Error('later work failed'); }), /later work failed/);
  const ev6 = [...new Set(R6.queue.map((e) => `${e.before}→${e.after}`))];
  assert.deepStrictEqual(ev6, ['out_for_delivery→delivered'], `the committed write's event survives the throw (${ev6})`);
  R6.queue.length = 0; R6.close();
  ok('per-write capture: a committed write followed by a throw keeps its event (the step still rethrows)');

  // (7) a client write's error path releases the per-write lock (a denied write must not wedge the runner)
  const R7 = makeTriggerRunner({ app: fake, db, entities: { orders: [OID] } });
  await assert.rejects(R7.step('client write fails', async () => {
    await R7.clientHooks.beforeWrite({ kind: 'set', path: `orders/${OID}/status`, value: 'x' });
    await R7.clientHooks.onWriteError({ kind: 'set', path: `orders/${OID}/status`, value: 'x' }, new Error('PERMISSION_DENIED'));
    throw new Error('PERMISSION_DENIED');
  }), /PERMISSION_DENIED/);
  await R7.step('next step still runs', () => db.ref(`orders/${OID}/status`).set('completed'));
  assert.ok(R7.queue.some((e) => e.after === 'completed'), 'the runner is not wedged after a failed client write');
  R7.queue.length = 0; R7.close();
  ok('a failed client write releases the per-write lock (onWriteError); the next step runs and is captured');
} catch (e) {
  console.error('trigger-runner: FAIL\n', e); process.exit(1);
}
clearTimeout(watchdog);
console.log(`trigger-runner: OK (${n})`);
process.exit(0);
