/**
 * PLATFORM F2 Q0 (PLAN-F2-query-rules §0) — behavioural suite against the RTDB emulator: a DEVICE token
 * (auth.token.handheld === true) passes NO grant meant for a human, while the SAME uid without the device claim keeps every
 * grant it has today.
 *   The device uid is given EVERY human role (dispatcher, global kitchen, kitchen_staff of both test rids, driver account,
 *   task assignee, own-uid records): a "role collision". So each human cell is a positive control: if a human cell passes and
 *   the device cell fails, the device exclusion alone denied it.
 *   READ cells are derived from the rules themselves (every non-public .read leaf, $vars bound to fixtures) plus a descendant
 *   read under each. WRITE cells cover the own-uid / role-gated writes the audit lists. PUBLIC reads stay open to devices.
 *   npm run test:device-exclusion-rules
 */
require('./_emulator-required')('database');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES_TEXT = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const RULES = JSON.parse(RULES_TEXT).rules;
const UID = 'dev-uid';                      // the device's own uid — and, in the human control, the same person-less uid
const RID = 'tb_centro';
const BIND = { $uid: UID, $driver_id: UID, $restaurant_id: RID, $order_id: 'O1', $task_id: 'O1_delivery', $token: 'tok1',
  $alert_id: 'a1', $msg_id: 'm1', $shift_id: 's1', $hash: 'h1', $key: 'k1', $rid: RID };
const PUBLIC = ['/config/rewards_public/redemption_live', '/public/brands', '/order_tracking/$token',
  '/restaurants/$restaurant_id/item_availability', '/menus', '/menus/_meta'];

function readLeaves(n, p = '', out = []) {
  for (const [k, v] of Object.entries(n)) {
    if (k === '.read' && v !== false) out.push(p || '/');
    else if (v && typeof v === 'object' && !k.startsWith('.')) readLeaves(v, `${p}/${k}`, out);
  }
  return out;
}
const bind = (p) => p.split('/').map((s) => (s.startsWith('$') ? BIND[s] : s)).join('/').replace(/^\//, '');

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-device-exclusion', database: { rules: RULES_TEXT } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref().update({
      [`dispatchers/${UID}`]: true, [`kitchen/${UID}`]: true,
      [`restaurants/${RID}/kitchen_staff/${UID}`]: true, [`restaurants/${RID}/identity/name`]: 'Centro',
      [`restaurants/${RID}/client_floor/kitchen`]: 1, [`restaurants/${RID}/availability_audit/k1`]: { at: 1 },
      [`restaurants/${RID}/item_availability/k1`]: { available: true },
      [`driver_accounts/${UID}`]: { role: 'driver' }, [`drivers/${UID}`]: { name: 'Dev Person', status: 'offline' },
      [`driver_cash/${UID}/s1/total`]: 1,
      'orders/O1': { order_id: 'O1', status: 'ready', restaurant_id: RID, payment_method: 'cash', pickup_task_id: 'O1_pickup', delivery_task_id: 'O1_delivery' },
      'tasks/O1_delivery': { order_id: 'O1', type: 'delivery', status: 'accepted', assigned_driver_id: UID },
      'tasks/O1_pickup': { order_id: 'O1', type: 'pickup', status: 'accepted', assigned_driver_id: UID },
      'order_tracking/tok1': { status: 'ready' }, 'order_timelines/O1/e1': { at: 1 }, 'config/x': 1,
      'config/rewards_public/redemption_live': true, 'public/brands/tb_brand': { name: 'Third' },
      'menus/tb_centro': { a: 1 }, 'menus/_meta': { v: 1 }, 'kds_cancel_acks/O1': { at: 1, by: UID },
      'order_control/tb_centro/current': { paused: false }, 'dispatcher_alerts/a1': { at: 1 }, 'incoming_messages/m1': { at: 1 },
      'order_predictions/O1': { m: 1 }, 'ready_time_graduation/x': 1,
      [`staff_push/${UID}/t`]: { token: 'x' }, [`user_profiles/${UID}`]: { phone: '1' }, [`user_orders/${UID}/O1`]: true, [`user_rewards/${UID}/b`]: 1,
    });
  });
  const human = env.authenticatedContext(UID, {}).database();
  const device = env.authenticatedContext(UID, { handheld: true, rid: RID }).database();
  const anonDevice = env.authenticatedContext('dev-2', { handheld: true, rid: RID }).database();   // a device with NO roles at all
  const svcHuman = env.authenticatedContext('svc-assigner', { svc_assigner: true }).database();
  const svcDevice = env.authenticatedContext('svc-assigner', { svc_assigner: true, handheld: true }).database();
  let n = 0; const pass = (l) => console.log(`  ✓ ${++n} ${l}`);

  // ── every non-public .read leaf: human control allowed, device denied (own + descendant) ──
  const leaves = readLeaves(RULES).filter((p) => !PUBLIC.includes(p));
  assert.ok(leaves.length >= 20, `premise: the read inventory is derived from the rules (${leaves.length})`);
  const humanDenied = [];
  for (const p of leaves) {
    const at = bind(p);
    try { await assertSucceeds(human.ref(at).once('value')); } catch (_) { humanDenied.push(p); continue; }
    await assertFails(device.ref(at).once('value'));
    await assertFails(device.ref(`${at}/zz_descendant`).once('value'));
    await assertFails(anonDevice.ref(at).once('value'));
  }
  // the human control must cover every leaf the role-collision uid can hold; the only ones it cannot are pinned below
  assert.deepStrictEqual(humanDenied, [], `human control must pass every read leaf (else the device cell is vacuous): ${humanDenied.join(', ')}`);
  pass(`${leaves.length} non-public read leaves (derived from the rules): the human control (same uid, every role) reads each; the device token — with the same roles, and a role-less device — is DENIED on each and on a descendant`);

  // ── public reads stay open to devices ──
  for (const p of PUBLIC) await assertSucceeds(device.ref(bind(p)).once('value'));
  pass(`${PUBLIC.length} pinned public reads: open to a device token`);

  // ── own-uid and role-gated WRITES: human allowed, device denied ──
  const W = [
    ['own staff_push', `staff_push/${UID}/t2`, { token: 'y' }],
    ['dispatcher: kitchen roster', `kitchen/zz_new`, true],
    ['dispatcher: kitchen_staff', `restaurants/${RID}/kitchen_staff/zz_new`, true],
    ['dispatcher: alert', 'dispatcher_alerts/a2', { at: 2 }],
    ['dispatcher: incoming message', 'incoming_messages/m2', { at: 2 }],
    ['dispatcher: tracking', 'order_tracking/tok2', { status: 'new' }],
    ['dispatcher: config', 'config/y', 2],
    ['dispatcher: menus', `menus/${RID}/b`, 2],
    ['kitchen: cancel ack', 'kds_cancel_acks/O1', { at: 2, by: UID }],
    ['dispatcher/kitchen: order status', 'orders/O1/status', 'out_for_delivery'],
  ];
  const humanWriteDenied = [];
  for (const [label, p, v] of W) {
    try { await assertSucceeds(human.ref(p).set(v)); } catch (e) { humanWriteDenied.push(`${label} (${p})`); continue; }
    await assertFails(device.ref(p).set(v));
  }
  assert.deepStrictEqual(humanWriteDenied, [], `human write controls must pass: ${humanWriteDenied.join('; ')}`);
  pass(`${W.length} own-uid / role-gated writes: the human control writes each; the device token (same uid + roles) is DENIED`);

  // ── svc-assigner identity: the service keeps its leaves; a device claim on that uid is denied ──
  await assertSucceeds(svcHuman.ref(`drivers/${UID}/status`).set('available'));
  await assertFails(svcDevice.ref(`drivers/${UID}/status`).set('offline'));
  pass('svc-assigner leaf write: the service identity is allowed; the same uid carrying a device claim is DENIED');

  await env.cleanup();
  console.log(`device-exclusion-rules.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('device-exclusion-rules.emulator: FAIL\n', e); process.exit(1); });
