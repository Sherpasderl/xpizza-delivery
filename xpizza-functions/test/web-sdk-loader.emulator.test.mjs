/**
 * TRACKER FIXES milestone 1 — the _web-sdk-loader smoke: the REAL driver SDK (xpizza-driver/xpizza-delivery.js) as an
 * authenticated driver against PRODUCTION rules on the RTDB emulator. Proves (a) real rules-checked writes succeed for the
 * owner (acceptTask → pickupComplete → completeTask, the money-grade completion batch), (b) a different driver's write on
 * those tasks is DENIED by the rules (no stub would deny it), (c) every write passes through the capture hooks with its
 * payload (beforeWrite/afterWrite), (d) two loads are independent clients.
 * Run: node tools/emulator-run.js --only database "node test/web-sdk-loader.emulator.test.mjs"
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeWebSdkLoader } from './_web-sdk-loader.mjs';

const require = createRequire(import.meta.url);
require('./_emulator-required')('database');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const here = path.dirname(fileURLToPath(import.meta.url));
const RULES = fs.readFileSync(path.join(here, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const PROJECT = 'demo-websdk-smoke';
const D1 = 'u_drv_smoke_1000000000000', D2 = 'u_drv_smoke_2000000000000';
const OID = 'o_smoke_1';
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const watchdog = setTimeout(() => { console.error('web-sdk-loader smoke: FAIL — timed out'); process.exit(1); }, 120000);
let env, L1, L2, L3;
try {
  env = await initializeTestEnvironment({ projectId: PROJECT, database: { rules: RULES } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref().update({
      [`drivers/${D1}`]: { name: 'uno', status: 'available', active: true },
      [`drivers/${D2}`]: { name: 'dos', status: 'available', active: true },
      [`orders/${OID}`]: { order_id: OID, restaurant_id: 'tb_centro', status: 'ready', payment_method: 'cash', total: 100, customer_name: 'Ana', created_at: 1 },
      [`tasks/${OID}_pickup`]: { order_id: OID, restaurant_id: 'tb_centro', type: 'pickup', status: 'assigned', assigned_driver_id: D1, linked_task_id: `${OID}_delivery`, created_at: 1 },
      [`tasks/${OID}_delivery`]: { order_id: OID, type: 'delivery', status: 'assigned', assigned_driver_id: D1, linked_task_id: `${OID}_pickup`, depends_on_task_id: `${OID}_pickup`, created_at: 1 },
    });
  });
  const ops = [];
  L1 = makeWebSdkLoader({ project: PROJECT, site: 'xpizza-driver', uid: D1, hooks: {
    beforeWrite: async (o) => { ops.push(['before', o.kind, o.path]); },
    afterWrite: async (o) => { ops.push(['after', o.kind, o.path]); },
  } });
  const X1 = await L1.load();
  await X1.acceptTask(D1, `${OID}_pickup`);
  const read = async (p) => { let v; await env.withSecurityRulesDisabled(async (ctx) => { v = (await ctx.database().ref(p).once('value')).val(); }); return v; };
  assert.strictEqual(await read(`tasks/${OID}_pickup/status`), 'accepted', 'acceptTask committed under real rules');
  assert.strictEqual(await read(`drivers/${D1}/current_task_id`), `${OID}_pickup`);
  ok('the REAL driver SDK acceptTask commits under production rules (task accepted, pointer set)');

  await X1.pickupComplete(D1, `${OID}_pickup`);
  assert.strictEqual(await read(`orders/${OID}/status`), 'out_for_delivery');
  assert.strictEqual(await read(`drivers/${D1}/current_task_id`), `${OID}_delivery`);
  await X1.completeTask(D1, `${OID}_delivery`);
  assert.strictEqual(await read(`orders/${OID}/status`), 'delivered');
  assert.strictEqual(await read(`orders/${OID}/delivered_by_driver_uid`), D1, 'the money-grade attribution stamp passed the rules');
  ok('pickupComplete → completeTask: the real atomic batches commit; delivered_by_driver_uid = the actor (rules-enforced)');

  assert.ok(ops.length >= 6 && ops.filter((o) => o[0] === 'before').length === ops.filter((o) => o[0] === 'after').length, `hooks saw every write before+after (${JSON.stringify(ops)})`);
  assert.ok(ops.every((o, i) => i % 2 === 0 ? o[0] === 'before' : o[0] === 'after'), 'each write is bracketed (serialized before → ack → after)');
  ok(`every SDK write passed through the capture hooks, bracketed before/after (${ops.length / 2} writes)`);

  // (b) a different driver is DENIED by the rules on D1's tasks (a stub would let it through)
  await env.withSecurityRulesDisabled((ctx) => ctx.database().ref().update({
    [`orders/o_smoke_2`]: { order_id: 'o_smoke_2', restaurant_id: 'tb_centro', status: 'ready', payment_method: 'cash', total: 100, customer_name: 'Bo', created_at: 2 },
    [`tasks/o_smoke_2_pickup`]: { order_id: 'o_smoke_2', restaurant_id: 'tb_centro', type: 'pickup', status: 'assigned', assigned_driver_id: D1, linked_task_id: 'o_smoke_2_delivery', created_at: 2 },
    [`tasks/o_smoke_2_delivery`]: { order_id: 'o_smoke_2', type: 'delivery', status: 'assigned', assigned_driver_id: D1, linked_task_id: 'o_smoke_2_pickup', created_at: 2 },
  }));
  L2 = makeWebSdkLoader({ project: PROJECT, site: 'xpizza-driver', uid: D2 });
  const X2 = await L2.load();
  let denied = null;
  try { await X2.acceptTask(D2, 'o_smoke_2_pickup'); } catch (e) { denied = String(e && (e.code || e.message)); }
  assert.ok(denied && /permission|denied/i.test(denied), `D2's write on D1's task is DENIED by the rules (got ${denied})`);
  assert.strictEqual(await read('tasks/o_smoke_2_pickup/status'), 'assigned', 'and nothing changed');
  ok(`a different driver's acceptTask on D1's task is DENIED by production rules (${denied}) — no stub semantics`);

  // (c) the SAME denial on a NON-default namespace (index.js's Admin one): the emulator rule-binds only the default namespace, so
  // the loader must load the production rules into `ns` itself — without that, this write would be ALLOWED
  const NSX = 'xpizza-delivery-default-rtdb';
  const [eh, ep] = process.env.FIREBASE_DATABASE_EMULATOR_HOST.split(':');
  const seedX = await fetch(`http://${eh}:${ep}/.json?ns=${NSX}`, { method: 'PATCH', headers: { Authorization: 'Bearer owner' }, body: JSON.stringify({
    'tasks/o_smoke_3_pickup': { order_id: 'o_smoke_3', restaurant_id: 'tb_centro', type: 'pickup', status: 'assigned', assigned_driver_id: D1, linked_task_id: 'o_smoke_3_delivery', created_at: 3 },
    'tasks/o_smoke_3_delivery': { order_id: 'o_smoke_3', type: 'delivery', status: 'assigned', assigned_driver_id: D1, linked_task_id: 'o_smoke_3_pickup', created_at: 3 },
  }) });
  assert.ok(seedX.ok, 'seeded the non-default namespace');
  L3 = makeWebSdkLoader({ project: PROJECT, site: 'xpizza-driver', uid: D2, ns: NSX });
  const X3 = await L3.load();
  let deniedX = null;
  try { await X3.acceptTask(D2, 'o_smoke_3_pickup'); } catch (e) { deniedX = String(e && (e.code || e.message)); }
  assert.ok(deniedX && /permission|denied/i.test(deniedX), `on ns=${NSX} too, D2's write is DENIED (got ${deniedX})`);
  const st = await (await fetch(`http://${eh}:${ep}/tasks/o_smoke_3_pickup/status.json?ns=${NSX}`, { headers: { Authorization: 'Bearer owner' } })).json();
  assert.strictEqual(st, 'assigned', 'and nothing changed');
  ok(`on the NON-default namespace ${NSX} the loader rule-binds the clients too: the foreign acceptTask is DENIED`);
} catch (e) {
  console.error('web-sdk-loader smoke: FAIL\n', e); process.exit(1);
} finally {
  try { L1 && L1.cleanup(); L2 && L2.cleanup(); L3 && L3.cleanup(); if (env) await env.cleanup(); } catch (_) {}
}
clearTimeout(watchdog);
console.log(`web-sdk-loader smoke: OK (${n})`);
process.exit(0);
