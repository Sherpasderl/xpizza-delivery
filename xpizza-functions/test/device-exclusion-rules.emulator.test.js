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
      [`restaurants/${RID}/availability_audit/k1`]: { at: 1 },
      [`restaurants/${RID}/item_availability/k1`]: { available: true },
      [`driver_accounts/${UID}`]: { role: 'driver' }, [`drivers/${UID}`]: { name: 'Dev Person', status: 'off_shift', ingest_token_hash: 'h1', current_shift_id: 's1' },
      [`driver_cash/${UID}/s1/total`]: 1,
      'orders/O3': { order_id: 'O3', status: 'delivered', restaurant_id: RID, payment_method: 'cash', delivered_by_driver_uid: 'other-drv' },
      'orders/O1': { order_id: 'O1', status: 'ready', restaurant_id: RID, payment_method: 'cash', pickup_task_id: 'O1_pickup', delivery_task_id: 'O1_delivery' },
      'tasks/O1_delivery': { order_id: 'O1', type: 'delivery', status: 'accepted', assigned_driver_id: UID },
      'tasks/O1_pickup': { order_id: 'O1', type: 'pickup', status: 'accepted', assigned_driver_id: UID },
      'order_tracking/tok1': { status: 'ready' }, 'order_timelines/O1/e1': { at: 1 }, 'config/x': 1,
      'config/rewards_public/redemption_live': true, 'public/brands/tb_brand': { name: 'Third' },
      'menus/tb_centro': { a: 1 }, 'menus/_meta': { v: 1 }, 'kds_cancel_acks/O1': { at: 1, by: UID },
      'order_control/tb_centro/current': { paused: false }, 'dispatcher_alerts/a1': { at: 1 }, 'incoming_messages/m1': { at: 1 },
      'order_predictions/O1': { m: 1 }, 'ready_time_graduation/x': 1,
      [`staff_push/${UID}/t`]: { token: 'x' }, [`user_profiles/${UID}`]: { phone: '50499998888', phone_hash: 'ph_dev', created_at: 1700000000000, last_login: 1700000000000 },
      'drivers/drv-t': { name: 'Token Driver', status: 'off_shift', ingest_token_hash: 'h0', current_shift_id: 's1' }, [`user_orders/${UID}/O1`]: true, [`user_rewards/${UID}/b`]: 1,
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

  // ── WRITES (codex Q0 r1 P2-2/P2-3): every non-public .write leaf, DERIVED from the rules, has a case. Per case the DEVICE
  //    attempt runs FIRST against the same state and the SAME value, then the control (human = the same uid without the claim,
  //    or the svc-assigner identity for its leaves) must succeed — so a device denial can only come from the exclusion.
  const T = (o) => ({ order_id: o.split('_')[0], type: o.endsWith('_pickup') ? 'pickup' : 'delivery', status: 'pending' });
  const IDENT = { name: 'Centro', hub_lat: 15.5, hub_lng: -88, phone: '+504', whatsapp_instance: 'i', whatsapp_enabled: false, delivery_radius_km: 5, hours: { sun: { open: true, start: '12:00', end: '19:45' } }, active: true, version: 2 };
  const SVC = 'svc';
  const WRITE_CASES = {
    '/dispatchers/$uid/.write': ['dispatchers/zz_new', true],
    '/drivers/$driver_id/.write': [`drivers/${UID}/name`, 'Dev Person 2', { descendant: true }],
    '/drivers/$driver_id/status/.write': [`drivers/${UID}/status`, 'available', SVC],
    '/drivers/$driver_id/active/.write': [`drivers/${UID}/active`, false, SVC],
    '/drivers/$driver_id/shift_started_at/.write': [`drivers/${UID}/shift_started_at`, 2, SVC],
    '/drivers/$driver_id/last_ping/.write': [`drivers/${UID}/last_ping`, 2, SVC],
    '/drivers/$driver_id/current_task_id/.write': [`drivers/${UID}/current_task_id`, 'O1_delivery', SVC],
    '/drivers/$driver_id/location_source/.write': [`drivers/${UID}/location_source`, 'gps', SVC],
    '/drivers/$driver_id/current_shift_id/.write': [`drivers/${UID}/current_shift_id`, 's1', SVC],
    '/drivers/$driver_id/current_hub_lat/.write': [`drivers/${UID}/current_hub_lat`, 15.5, SVC],
    '/drivers/$driver_id/current_hub_lng/.write': [`drivers/${UID}/current_hub_lng`, -88, SVC],
    '/drivers/$driver_id/current_restaurant_id/.write': [`drivers/${UID}/current_restaurant_id`, RID, SVC],
    '/drivers/$driver_id/current_hub_task_id/.write': [`drivers/${UID}/current_hub_task_id`, 'O1_pickup', SVC],
    '/drivers/$driver_id/ingest_token_hash/.write': [`drivers/${UID}/ingest_token_hash`, 'h1', SVC],
    '/staff_push/$uid/.write': [`staff_push/${UID}/t2`, { token: 'y' }, { descendant: true }],
    '/tasks/$task_id/.write': ['tasks/O9_pickup', T('O9_pickup')],
    '/tasks/$task_id/status/.write': ['tasks/O1_delivery/status', 'accepted', SVC],
    '/tasks/$task_id/assigned_driver_id/.write': ['tasks/O1_delivery/assigned_driver_id', UID, SVC],
    '/tasks/$task_id/assigned_at/.write': ['tasks/O1_delivery/assigned_at', 2, SVC],
    '/tasks/$task_id/accepted_at/.write': ['tasks/O1_delivery/accepted_at', 2, SVC],
    '/tasks/$task_id/assignment_deadline/.write': ['tasks/O1_delivery/assignment_deadline', 2, SVC],
    '/tasks/$task_id/assignment_attempts/.write': ['tasks/O1_delivery/assignment_attempts', 1, SVC],
    '/tasks/$task_id/auto_assigned/.write': ['tasks/O1_delivery/auto_assigned', true, SVC],
    '/tasks/$task_id/half_claim_since/.write': ['tasks/O1_delivery/half_claim_since', 2, SVC],
    '/tasks/$task_id/retry_count/.write': ['tasks/O1_delivery/retry_count', 1, SVC],
    '/tasks/$task_id/last_swept/.write': ['tasks/O1_delivery/last_swept', 2, SVC],
    '/orders/$order_id/.write': ['orders/O1/notes', 'n', { descendant: true }],
    '/orders/$order_id/status/.write': ['orders/O1/status', 'out_for_delivery'],
    '/orders/$order_id/picked_up_at/.write': ['orders/O1/picked_up_at', 2],
    '/orders/$order_id/delivered_at/.write': ['orders/O1/delivered_at', 2],
    '/orders/$order_id/delivered_by_driver_uid/.write': ['orders/O3/delivered_by_driver_uid', UID],
    '/config/.write': ['config/y', 2, { descendant: true }],
    '/dispatcher_alerts/$alert_id/.write': ['dispatcher_alerts/a2', { at: 2 }, { descendant: true }],
    '/order_tracking/$token/.write': ['order_tracking/tok2', { status: 'new' }, { descendant: true }],
    '/incoming_messages/$msg_id/.write': ['incoming_messages/m2', { at: 2 }, { descendant: true }],
    '/kitchen/$uid/.write': ['kitchen/zz_new', true],
    '/kds_cancel_acks/$order_id/.write': ['kds_cancel_acks/O1', { at: 2, by: UID }],
    '/driver_cash/$driver_id/$shift_id/cuadre/.write': [`driver_cash/${UID}/s1/cuadre`, { cash_owed: 0, cash_order_count: 0, closed_at: 1 }],
    // a token ROTATION is one multi-path update (the rule checks the new driver hash and that the uid is not a dispatcher)
    '/driver_tokens/$hash/.write': ['', { 'drivers/drv-t/ingest_token_hash': 'h2', 'driver_tokens/h2': { uid: 'drv-t', shift_id: 's1' } }, { svc: true, op: 'update' }],
    '/restaurants/$restaurant_id/identity/.write': [`restaurants/${RID}/identity`, IDENT],
    '/restaurants/$restaurant_id/kitchen_staff/$uid/.write': [`restaurants/${RID}/kitchen_staff/zz_new`, true],
    '/restaurants/$restaurant_id/item_availability/$key/.write': [`restaurants/${RID}/item_availability/k2`, { available: true, updated_at: 1 }],
    '/restaurants/$restaurant_id/availability_audit/$key/.write': [`restaurants/${RID}/availability_audit/k2`, { at: 2 }],
    '/menus/$rid/.write': [`menus/${RID}/b`, 2, { descendant: true }],
    '/user_profiles/$uid/.write': [`user_profiles/${UID}`, { name: 'Dev' }, { op: 'update' }],
  };
  const writeLeaves = [];
  (function walkW(node, p) {
    for (const [k, v] of Object.entries(node)) {
      if (k === '.write' && v !== false) writeLeaves.push(`${p}/.write`);
      else if (v && typeof v === 'object' && !k.startsWith('.')) walkW(v, `${p}/${k}`);
    }
  })(RULES, '');
  assert.deepStrictEqual(writeLeaves.filter((l) => !WRITE_CASES[l]).sort(), [], 'every non-false .write leaf in the rules has a case (a new write leaf must add one)');
  assert.deepStrictEqual(Object.keys(WRITE_CASES).filter((l) => !writeLeaves.includes(l)).sort(), [], 'no stale case (each names a real write leaf)');
  const controlFailed = []; let descendants = 0;
  for (const leaf of writeLeaves) {
    const [p, v, opt] = WRITE_CASES[leaf];
    const svc = opt === SVC || !!(opt && opt.svc);
    const dev = svc ? svcDevice : device;
    const ctl = svc ? svcHuman : human;
    const at = (db) => (p === '' ? db.ref() : db.ref(p));
    const op = (db) => (opt && opt.op === 'update' ? at(db).update(v) : at(db).set(v));
    await assertFails(op(dev));                                              // device FIRST, same state, same value
    try { await assertSucceeds(op(ctl)); } catch (e) { controlFailed.push(`${leaf} (${p}): ${String(e.message || e).slice(0, 80)}`); continue; }
    if (opt && opt.descendant) {
      await assertFails(dev.ref(`${p}/zz_desc`).set(1));
      await assertSucceeds(ctl.ref(`${p}/zz_desc`).set(1));
      descendants += 1;
    }
  }
  assert.deepStrictEqual(controlFailed, [], `every control write must succeed (else its device cell is vacuous):\n  ${controlFailed.join('\n  ')}`);
  pass(`${writeLeaves.length} write leaves (derived from the rules; each with a case): the DEVICE attempt — same uid + roles (or the svc identity + claim), same state, same value — is DENIED, then the control succeeds; ${descendants} inherited-descendant writes likewise`);

  await env.cleanup();
  console.log(`device-exclusion-rules.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('device-exclusion-rules.emulator: FAIL\n', e); process.exit(1); });
