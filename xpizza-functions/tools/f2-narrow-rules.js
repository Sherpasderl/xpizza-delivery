#!/usr/bin/env node
'use strict';
// PLATFORM F2 Q1 (PLAN-F2-query-rules §1.5–1.7) — the NARROW-RULES TRANSFORM. narrow(baseRules, variant) is a pure, deterministic
// function: it changes ONLY the allowlisted leaves below, each after checking that the leaf's SOURCE expression equals the pinned
// expected string (a drifted base is REFUSED — a main-side rule change forces a review), and leaves every other leaf byte-equal.
//   N-human (Q4): dispatcher · kitchen_staff · drivers · svc-assigner · brand owners          R-post = N-human (alias)
//   N-full  (Q6): N-human + managers + the device COLLECTION-query clause                     R-pre  = the input (base+Q0+indexes)
// Expressions are ternary-free (device-exclusion.guard rejects `?:`), and every value that could be null is checked with
// isString() BEFORE it is used as a path segment (a rules error denies the whole leaf, sibling alternatives included).
// CLI: node tools/f2-narrow-rules.js --write   (re)writes xpizza-reference/f2-narrow/{N-human,N-full}.rules.json
//      node tools/f2-narrow-rules.js --check   exit 1 if a committed artifact differs from the transform of the current base
const fs = require('fs');
const path = require('path');

const ABSENT = Symbol('absent');
const Q0 = "auth != null && auth.token.handheld !== true";
const G = `${Q0} && auth.token.customer !== true && root.child('driver_accounts').child(auth.uid).child('deactivated').val() !== true`;
const DISP = "root.child('dispatchers').child(auth.uid).exists()";
const REST = (r) => `root.child('restaurants').child(${r})`;
const kitchen = (r) => `${REST(r)}.child('kitchen_staff').child(auth.uid).exists()`;
// brand owner (PLAN §1.5, codex Q1 r1 P1-1): the owners of the RESOLVED brand — restaurants/{identity.brand_id}/owners when the
// location's identity names a brand — and the location's own restaurants/{rid}/owners ONLY when it names none (a legacy brand IS
// its location, F1). Written as two mutually exclusive disjuncts instead of `brand_id ? … : rid` (no ternaries).
const owner = (r) => `((${REST(r)}.child('identity').child('brand_id').isString() && ${REST(`${REST(r)}.child('identity').child('brand_id').val()`)}.child('owners').child(auth.uid).exists()) || (!${REST(r)}.child('identity').child('brand_id').exists() && ${REST(r)}.child('owners').child(auth.uid).exists()))`;
const manager = (r) => `${REST(r)}.child('managers').child(auth.uid).exists()`;
const scope = (r, full) => `(${kitchen(r)} || ${owner(r)}${full ? ` || ${manager(r)}` : ''})`;
const ORDER_RID = "root.child('orders').child($order_id).child('restaurant_id')";
const driverOrder = (node) => `(auth.uid !== 'svc-assigner' && (root.child('tasks').child($order_id + '_pickup').child('assigned_driver_id').val() === auth.uid || root.child('tasks').child($order_id + '_delivery').child('assigned_driver_id').val() === auth.uid || ${node}.child('delivered_by_driver_uid').val() === auth.uid || ${node}.child('delivered_by_uid').val() === auth.uid))`;
const LOC_QUERY = (full) => `(query.orderByChild === 'restaurant_id' && query.equalTo.length > 0 && ${scope('query.equalTo', full)})`;
const HIST_QUERY = "((query.orderByChild === 'delivered_by_driver_uid' || query.orderByChild === 'delivered_by_uid') && query.equalTo === auth.uid && auth.uid !== 'svc-assigner')";
// the device clause (N-full only): a COLLECTION query on its own registered, non-revoked rid — never a point read
const DEVICE = "auth.token.handheld === true && auth.token.customer !== true && query.orderByChild === 'restaurant_id' && query.equalTo === auth.token.rid && auth.token.rid.length > 0 && root.child('restaurants').child(auth.token.rid).child('handhelds').child(auth.uid).child('kind').val() === 'handheld' && root.child('restaurants').child(auth.token.rid).child('handhelds').child(auth.uid).child('revoked').val() === false";
const DEVICE_ALTERNATIVES = Object.freeze([Object.freeze({ leaf: '/orders/.read', alternative: DEVICE })]);
// svc-assigner reads: DERIVED leaf grants (PLAN §1.5) — the leaves its transactions read, recorded from the parity/eligibility
// suites run in CLOSED mode against narrow(base). Never the task parent.
const SVC_TASK_READ_LEAVES = Object.freeze(['assigned_driver_id']);
const SVC_READ = `${Q0} && auth.uid === 'svc-assigner'`;

// H1a (PLAN-H1a BC1): the KDS is dark at a handheld location — a kitchen status write there is refused. Its kitchen test is the
// same expression as the grant's, so the narrowing below rewrites BOTH (replaceAll): the denial follows the narrowed grant.
const H1A_DARK_KDS = " && !(root.child('kitchen').child(auth.uid).exists() && root.child('orders').child($order_id).child('restaurant_id').isString() && root.child('restaurants').child(root.child('orders').child($order_id).child('restaurant_id').val()).child('order_surface').val() === 'handheld')";
// the pinned SOURCE of every changed leaf (on base = main + Q0 + Q1 indexes)
const SRC = {
  '/orders/.read': `${G}`,
  '/orders/$order_id/.read': ABSENT,
  '/orders/$order_id/status/.write': `${Q0} && (root.child('dispatchers').child(auth.uid).exists() || root.child('kitchen').child(auth.uid).exists() || root.child('tasks').child($order_id + '_delivery').child('assigned_driver_id').val() === auth.uid || root.child('tasks').child($order_id + '_pickup').child('assigned_driver_id').val() === auth.uid) && !(newData.val() === 'cancelled' && root.child('orders').child($order_id).child('payment_method').val() === 'online' && (root.child('orders').child($order_id).child('payment_status').val() === 'confirmed' || root.child('orders').child($order_id).child('payment_status').val() === 'pending')) && root.child('driver_accounts').child(auth.uid).child('deactivated').val() !== true && auth.uid !== 'svc-assigner'${H1A_DARK_KDS}`,
  '/tasks/.read': `${G}`,
  '/tasks/$task_id/.read': ABSENT,
  ...Object.fromEntries(SVC_TASK_READ_LEAVES.map((l) => [`/tasks/$task_id/${l}/.read`, ABSENT])),
  '/order_timelines/.read': `${G}`,
  '/order_timelines/$order_id/.read': ABSENT,
  '/kds_cancel_acks/.read': `${Q0} && root.child('kitchen').child(auth.uid).exists()`,
  '/kds_cancel_acks/$order_id/.read': ABSENT,
  '/kds_cancel_acks/$order_id/.write': `${Q0} && root.child('kitchen').child(auth.uid).exists()`,
};
const KITCHEN_OF_ORDER = `(${ORDER_RID}.isString() && ${kitchen(`${ORDER_RID}.val()`)})`;
// the new value of every changed leaf (undefined = the key is removed)
function target(variant) {
  const full = variant === 'N-full';
  return {
    '/orders/.read': `${G} && (${DISP} || ${LOC_QUERY(full)} || ${HIST_QUERY})${full ? ` || (${DEVICE})` : ''}`,
    '/orders/$order_id/.read': `${G} && ((data.child('restaurant_id').isString() && ${scope("data.child('restaurant_id').val()", full)}) || ${driverOrder('data')})`,
    '/orders/$order_id/status/.write': SRC['/orders/$order_id/status/.write'].replaceAll("root.child('kitchen').child(auth.uid).exists()", KITCHEN_OF_ORDER),
    '/tasks/.read': `${G} && (${DISP} || (query.orderByChild === 'assigned_driver_id' && query.equalTo === auth.uid && auth.uid !== 'svc-assigner'))`,
    '/tasks/$task_id/.read': `${G} && auth.uid !== 'svc-assigner' && data.child('assigned_driver_id').val() === auth.uid`,
    ...Object.fromEntries(SVC_TASK_READ_LEAVES.map((l) => [`/tasks/$task_id/${l}/.read`, SVC_READ])),
    '/order_timelines/.read': `${G} && ${DISP}`,
    '/order_timelines/$order_id/.read': `${G} && (${DISP} || (${ORDER_RID}.isString() && ${scope(`${ORDER_RID}.val()`, full)}) || ${driverOrder("root.child('orders').child($order_id)")})`,
    '/kds_cancel_acks/.read': undefined,
    '/kds_cancel_acks/$order_id/.read': `${Q0} && ${KITCHEN_OF_ORDER}`,
    '/kds_cancel_acks/$order_id/.write': `${Q0} && ${KITCHEN_OF_ORDER}`,
  };
}
const VARIANTS = ['N-human', 'N-full', 'R-pre', 'R-post'];
const CHANGED_LEAVES = (variant) => Object.keys(SRC).filter((k) => {
  const t = target(variant)[k]; const s = SRC[k];
  return !(s === ABSENT ? t === undefined : t === s);
});

function narrow(base, variant) {
  if (!VARIANTS.includes(variant)) throw new Error(`unknown variant ${variant}`);
  const out = JSON.parse(JSON.stringify(base));   // never mutates the input
  if (variant === 'R-pre') return out;
  const v = variant === 'R-post' ? 'N-human' : variant;
  const T = target(v);
  for (const leaf of Object.keys(SRC)) {
    const segs = leaf.split('/').filter(Boolean); const key = segs.pop();
    let node = out.rules;
    for (const s of segs) { if (!node[s] || typeof node[s] !== 'object') node[s] = {}; node = node[s]; }
    const have = Object.prototype.hasOwnProperty.call(node, key) ? node[key] : ABSENT;
    if (have !== SRC[leaf]) throw new Error(`source drift at ${leaf}: expected ${SRC[leaf] === ABSENT ? 'ABSENT' : JSON.stringify(SRC[leaf]).slice(0, 120)}, found ${have === ABSENT ? 'ABSENT' : JSON.stringify(have).slice(0, 120)}`);
    if (T[leaf] === undefined) delete node[key]; else node[key] = T[leaf];
  }
  return out;
}
const serialize = (rules) => `${JSON.stringify(rules, null, 2)}\n`;

module.exports = { narrow, serialize, CHANGED_LEAVES, DEVICE_ALTERNATIVES, SVC_TASK_READ_LEAVES, VARIANTS };

if (require.main === module) {
  const REF = path.join(__dirname, '..', '..', 'xpizza-reference');
  const base = JSON.parse(fs.readFileSync(path.join(REF, 'database.rules.json'), 'utf8'));
  const mode = process.argv[2];
  if (mode !== '--write' && mode !== '--check') { console.error('usage: f2-narrow-rules.js --write | --check'); process.exit(2); }
  let bad = 0;
  for (const variant of ['N-human', 'N-full']) {
    const file = path.join(REF, 'f2-narrow', `${variant}.rules.json`);
    const want = serialize(narrow(base, variant));
    if (mode === '--write') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, want); console.log(`wrote ${path.relative(process.cwd(), file)}`); }
    else if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== want) { console.error(`STALE ${variant}`); bad += 1; }
  }
  process.exit(bad ? 1 : 0);
}
