'use strict';
// R3 §3a — NEGATIVE ACCEPTANCE for the census (codex r1 P1-1): each synthetic source unit below is injected into the
// REAL census run (alongside the whole repo) and must turn it RED for the stated reason. Plus one positive cell: a new
// WhatsApp send reading items_text becomes an R9 READER site (send-boundary data flow). Static, no emulator.
const assert = require('assert');
const { build } = require('./census-build');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const unit = (name, code) => ({ file: `xpizza-functions/zz-r3-negative-${name}.js`, scope: 'functions', kind: 'fn', code, lineOffset: 0, module: false });
const problemsWith = (u) => build({ extraUnits: [u] }).problems;

const base = build();
assert.deepStrictEqual(base.problems, [], `premise — the real census is clean (${base.problems.slice(0, 3).join(' | ')})`);

const cases = [
  ['spread', unit('spread', "function f(order) { return { ...order, seen: true }; }\nmodule.exports = { f };"), /unmapped opaque .*zz-r3-negative-spread.*spread/],
  ['service_charge', unit('svc', "async function f(db, id) { await db.ref(`orders/${id}`).update({ service_charge_cents: 900 }); }\nmodule.exports = { f };"), /NEW order field written: 'service_charge_cents'|write sentinel: .*service_charge_cents/],
  ['tipAmount', unit('tip', "async function f(db, id) { await db.ref(`orders/${id}`).update({ tipAmount: 100 }); }\nmodule.exports = { f };"), /NEW order field written: 'tipAmount'|write sentinel: .*tipAmount/],
  ['new-field', unit('newf', "async function f(db, id) { await db.ref('orders').child(id).update({ loyalty_tier: 'gold' }); }\nmodule.exports = { f };"), /NEW order field written: 'loyalty_tier'/],
  ['template-path', unit('fee', "async function f(db, id) { await db.ref(`orders/${id}/delivery_fee_cents`).set(7000); }\nmodule.exports = { f };"), /NEW order field written: 'delivery_fee_cents'|write sentinel: .*delivery_fee_cents/],
];
for (const [name, u, re] of cases) {
  const p = problemsWith(u);
  assert.ok(p.some((x) => re.test(x)), `🔴 R3-CENSUS-NEG ${name}: the census stayed GREEN for ${u.file} (problems: ${JSON.stringify(p.slice(0, 4))})`);
  ok(`${name}: RED — ${p.filter((x) => re.test(x))[0].slice(0, 140)}`);
}
// codex r2 P1-1 probes, injected AS index.js / createOrderApp.all (where the reviewed opaque resolution lives)
const asIndex = (code) => ({ file: 'xpizza-functions/index.js', scope: 'functions', kind: 'fn', code, lineOffset: 0, module: false });
// P1-a: UNREACHABLE ON SURFACE is reviewed, both ways — a new unreferenced page function reading an order amount is RED
// until reviewed; a reviewed-unreachable function that becomes referenced makes its entry stale (RED: review its mapping)
{
  const page = (code) => ({ file: 'xpizza-kitchen/zz-r3-probe.js', scope: 'xpizza-kitchen', kind: 'page', module: true, lineOffset: 0, code });
  const a = problemsWith(page('export function deadTotalProbe(order) { return order.total; }'));
  assert.ok(a.some((x) => /UNREACHABLE on its surface \(xpizza-kitchen\/zz-r3-probe\.js#deadTotalProbe/.test(x)), `🔴 R3-CENSUS-NEG unreachable-unreviewed: passed (${JSON.stringify(a.slice(0, 3))})`);
  // referenced from TOP-LEVEL code (a root): the reviewed-unreachable SDK function is now reachable on the KDS
  const b = problemsWith(page("import * as XPD from './xpizza-delivery.js'; window.__wire = XPD.assignOrderToDriver;"));
  assert.ok(b.some((x) => /stale unreachableOnSurface entry: xpizza-kitchen\/xpizza-delivery\.js#assignOrderToDriver/.test(x)), `🔴 R3-CENSUS-NEG unreachable-revived: passed (${JSON.stringify(b.slice(0, 3))})`);
  // transitive: a helper referenced ONLY by an unreferenced function is unreachable too (fixpoint, not first-order)
  const c = problemsWith(page('function deadHelperTotal(o) { return o.total; } export function deadCaller(o) { return deadHelperTotal(o); }'));
  assert.ok(c.some((x) => /UNREACHABLE on its surface \(xpizza-kitchen\/zz-r3-probe\.js#deadHelperTotal/.test(x)), `🔴 R3-CENSUS-NEG unreachable-transitive: passed (${JSON.stringify(c.slice(0, 3))})`);
  ok('unreachable on surface, reviewed both ways: a new unreferenced KDS function reading order.total → RED; a helper called only by a dead function → RED (fixpoint); referencing a reviewed-unreachable SDK function from top-level code (window.__wire = XPD.assignOrderToDriver) → its entry is stale → RED');
}
// codex rebase-r2 P1: a non-fact review is bound to its SITE — created_at is reviewed in other functions, but a NEW
// created_at filter inside the driver's cash shiftDeliveries is unreviewed there → RED (codex's probe)
{
  const u = { file: 'xpizza-driver/cash-helpers.js', scope: 'xpizza-driver', kind: 'page', module: true, lineOffset: 0,
    code: "export function shiftDeliveries(ordersMap, uid, sinceMs) { const out = []; for (const id in ordersMap) { const o = ordersMap[id]; if (o && o.created_at < sinceMs) continue; if (o.delivered_by_driver_uid === uid) out.push(o.total); } return out; }" };
  const p = problemsWith(u);
  assert.ok(p.some((x) => /unregistered field read on a money path: 'created_at' \(xpizza-driver\/cash-helpers\.js shiftDeliveries/.test(x)), `🔴 R3-CENSUS-NEG per-site-binding: a created_at filter inside shiftDeliveries passed (problems: ${JSON.stringify(p.slice(0, 4))})`);
  ok('per-site binding: created_at reviewed elsewhere, but a NEW created_at filter inside the driver cash shiftDeliveries → RED (codex rebase-r2 probe)');
}
for (const [name, code, re] of [
  ['update-spread-computed-key', "createOrderApp.all(async (req, res) => { await rtdb.ref('orders/probe').update({ ...{ ['service_charge_cents']: 900 } }); });", /service_charge_cents/],
  ['opaque-builder-object', "createOrderApp.all(async (req, res) => { await rtdb.ref('orders/probe').set(buildNewMoneyPayload()); });", /opaque order write unresolved: .*opaque-order-object .*buildNewMoneyPayload/],
  ['write-above-orders', "createOrderApp.all(async (req, res) => { await rtdb.ref('orders').set({ probe: { surcharge_cents: 900 } }); });", /NEW order field written: 'surcharge_cents'/],
  // codex r3 P1-1: unresolved ROOT writes
  ['root-unresolved-payload', "createOrderApp.all(async (req, res) => { await rtdb.ref().update(buildNewMoneyPayload()); });", /opaque order write unresolved: .*unresolved-root-write .*buildNewMoneyPayload/],
  ['root-computed-key', "createOrderApp.all(async (req, res) => { await rtdb.ref().update({ [newOrderPath]: { ['service_charge_cents']: 900 } }); });", /opaque order write unresolved: .*computed-key-at-root .*newOrderPath/],
  ['root-spread', "createOrderApp.all(async (req, res) => { await rtdb.ref().update({ ...newMoneyUpdates }); });", /opaque order write unresolved: .*spread-at-root .*newMoneyUpdates/],
  // codex r4 P1-1: NESTED spreads at the root / orders (the rule applies recursively, at every depth)
  ['root-nested-spread', "createOrderApp.all(async (req, res) => { await rtdb.ref().update({ ...{ ...newMoneyUpdates } }); });", /opaque order write unresolved: .*spread-at-root .*newMoneyUpdates/],
  ['root-spread-computed-key', "createOrderApp.all(async (req, res) => { await rtdb.ref().update({ ...{ [newOrderPath]: { ['service_charge_cents']: 900 } } }); });", /opaque order write unresolved: .*computed-key-at-root .*newOrderPath/],
  ['root-triple-spread', "createOrderApp.all(async (req, res) => { await rtdb.ref().update({ ...{ ...{ ...newMoneyUpdates } } }); });", /opaque order write unresolved: .*spread-at-root .*newMoneyUpdates/],
  ['root-nested-resolved-field', "createOrderApp.all(async (req, res) => { await rtdb.ref().update({ ...{ ...{ ['orders/probe/surcharge_cents']: 900 } } }); });", /NEW order field written: 'surcharge_cents'/],
  ['orders-nested-spread', "createOrderApp.all(async (req, res) => { await rtdb.ref('orders').update({ ...{ ...newMoneyUpdates } }); });", /opaque order write unresolved: .*spread-in-order-write .*newMoneyUpdates/],
  // B4: a field assigned onto a multipath entry AFTER the fact (createOrder's `.redemption = …` shape) — dot, literal
  // bracket and deeper forms name the field; a dynamic field segment is opaque
  ['multipath-member-assign', "createOrderApp.all(async (req, res) => { const updates = {}; updates[`orders/${id}`] = { status: 'new' }; updates[`orders/${id}`].surcharge_cents = 900; await rtdb.ref().update(updates); });", /NEW order field written: 'surcharge_cents'/],
  ['multipath-member-assign-bracket', "createOrderApp.all(async (req, res) => { const updates = {}; updates[`orders/${id}`] = {}; updates[`orders/${id}`]['surcharge_cents'] = 900; await rtdb.ref().update(updates); });", /NEW order field written: 'surcharge_cents'/],
  ['multipath-member-assign-deep', "createOrderApp.all(async (req, res) => { const held = {}; held['orders/' + id] = {}; held['orders/' + id].surcharge.cents = 900; await rtdb.ref().update(held); });", /NEW order field written: 'surcharge'/],
  ['multipath-member-assign-dynamic', "createOrderApp.all(async (req, res) => { const updates = {}; updates[`orders/${id}`] = {}; updates[`orders/${id}`][feeField] = 900; await rtdb.ref().update(updates); });", /opaque order write unresolved: .*dynamic-field-segment/],
  // codex r5 P1-2: a transaction at the ROOT / on /orders is opaque (its updater is never analysed) — RED unless bound
  ['root-transaction', "createOrderApp.all(async (req, res) => { await rtdb.ref().transaction(root => ({ ...root, orders: { ...root.orders, probe: { ['service_charge_cents']: 900 } } })); });", /opaque order write unresolved: .*transaction-at-root/],
  ['orders-transaction', "createOrderApp.all(async (req, res) => { await rtdb.ref('orders').transaction((all) => all); });", /opaque order write unresolved: .*transaction-above-orders/],
  ['root-transaction-slash', "createOrderApp.all(async (req, res) => { await rtdb.ref('/').transaction(fixUp); });", /opaque order write unresolved: .*transaction-at-root .*fixUp/],
  ['modular-root-transaction', "createOrderApp.all(async (req, res) => { await runTransaction(ref(db), (root) => root); });", /opaque order write unresolved: .*transaction-at-root/],
  // codex rebase-r1 P1 (generalized): an UNREGISTERED identity field on a CASH read (a function that reads an amount)
  ['unregistered-identity-on-cash-read', "function shiftCashProbe(o, uid) { return o.delivered_by_courier_uid === uid ? o.total : 0; }", /unregistered field read on a money path: 'delivered_by_courier_uid'/],
  // codex rebase-r2 P1: EVERY read form of an unregistered field on a money path → RED (bracket, optional, destructuring
  // with default, nested destructuring)
  ['money-path-bracket', "function shiftCashProbeB(o, uid) { return o['courier_cash_exempt'] ? 0 : o.total; }", /unregistered field read on a money path: 'courier_cash_exempt' .*shiftCashProbeB/],
  ['money-path-optional', "function shiftCashProbeO(o, uid) { return o?.courier_cash_exempt ? 0 : o.total; }", /unregistered field read on a money path: 'courier_cash_exempt' .*shiftCashProbeO/],
  ['money-path-destructure-default', "function shiftCashProbeD(o, uid) { const { courier_cash_exempt = false } = o; return courier_cash_exempt ? 0 : o.total; }", /unregistered field read on a money path: 'courier_cash_exempt' .*shiftCashProbeD/],
  ['money-path-destructure-nested', "function shiftCashProbeN(o, uid) { const { courier: { exempt } } = o; return exempt ? 0 : o.total; }", /unregistered field read on a money path: 'courier' .*shiftCashProbeN/],
]) {
  const p = problemsWith(asIndex(code));
  assert.ok(p.some((x) => re.test(x)), `🔴 R3-CENSUS-NEG ${name}: the census stayed GREEN (problems: ${JSON.stringify(p.slice(0, 4))})`);
  ok(`${name} (injected into index.js / createOrderApp.all): RED — ${p.filter((x) => re.test(x))[0].slice(0, 130)}`);
}
// B4 r1 (codex R3-B4 r1, advisor ruling: WRITE PROVENANCE). Each REAL writer codex probed, edited in memory to add a
// `surcharge_cents` write the old shape-matcher missed, must turn the census RED; so must every synthetic shape below.
{
  const fsx = require('fs'); const pathx = require('path');
  const REPO_FN = pathx.join(__dirname, '..');
  const real = (file, from, to) => {
    const code = fsx.readFileSync(pathx.join(REPO_FN, file), 'utf8');
    assert.strictEqual(code.split(from).length - 1, 1, `premise — the probe anchor occurs exactly once in ${file}: ${from}`);
    return { file: `xpizza-functions/${file}`, scope: 'functions', kind: 'fn', code: code.replace(from, to), lineOffset: 0, module: false, replace: true };
  };
  const NEW_S = /NEW order field written: 'surcharge_cents'/;
  for (const [name, u, re] of [
    ['real: createOrder record field before the multipath map (create-order-build.js:67)', real('create-order-build.js', '    orderRecord.lat = lat;\n', '    orderRecord.lat = lat;\n    orderRecord.surcharge_cents = 900;\n'), NEW_S],
    ['real: helper mutates an ALIAS of updates[orders/…] (attachCustomerAttribution orderRec)', real('create-order-build.js', '  orderRec.customer_uid = customer_uid;\n', '  orderRec.customer_uid = customer_uid;\n  orderRec.surcharge_cents = 900;\n'), NEW_S],
    ['real: chargeOnlineOrder pendingOrderRecord mutation → acquireHostedAttempt transaction spread (index.js:1813)', real('index.js', '    pendingOrderRecord.lat = lat;\n', '    pendingOrderRecord.lat = lat;\n    pendingOrderRecord.surcharge_cents = 900;\n'), NEW_S],
    ['real: Object.assign(pendingOrderRecord, …) (index.js:1878)', real('index.js', 'Object.assign(pendingOrderRecord, hubSnapshot(id));', 'Object.assign(pendingOrderRecord, hubSnapshot(id), { surcharge_cents: 900 });'), NEW_S],
    ['real: a builder RETURN reached through Object.assign → transaction (restaurant-config hubSnapshot)', real('restaurant-config.js', '  if (dn) snap.restaurant_display_name = dn;\n', '  if (dn) snap.restaurant_display_name = dn;\n  snap.surcharge_cents = 900;\n'), NEW_S],
    ['real: a patch prop added after its literal, before .update(patch) (index.js:6398)', real('index.js', '    const patch = { release_at: Math.min(Number(order.release_at) || now, now) };\n', '    const patch = { release_at: Math.min(Number(order.release_at) || now, now) };\n    patch.surcharge_cents = 900;\n'), NEW_S],
    ['real: .remove() of an order field (index.js:2749)', real('index.js', 'await db.ref(`orders/${orderId}/paid_strand_seen_at`).remove();', 'await db.ref(`orders/${orderId}/surcharge_cents`).remove();'), NEW_S],
    ['real: Object.assign(updates[orders/…], {…}) in createOrder', real('index.js', '  if (redemptionCanonical) updates[`orders/${orderId}`].redemption = redemptionCanonical;', '  if (redemptionCanonical) updates[`orders/${orderId}`].redemption = redemptionCanonical; Object.assign(updates[`orders/${orderId}`], { surcharge_cents: 900 });'), NEW_S],
    ['synthetic: updates[computedPath] with a locally computed order path', asIndex("createOrderApp.all(async (req, res) => { const p = `orders/${id}`; const updates = {}; updates[p] = { surcharge_cents: 900 }; await db.ref().update(updates); });"), NEW_S],
    ['synthetic: updates[<unresolvable path>] at the root → opaque', asIndex("createOrderApp.all(async (req, res) => { const updates = {}; updates[pathFor(id)] = { surcharge_cents: 900 }; await db.ref().update(updates); });"), /opaque order write unresolved: .*computed-key-at-root .*pathFor\(id\)/],
    ['synthetic: Object.assign(updates[\'orders/x\'], {…})', asIndex("createOrderApp.all(async (req, res) => { const updates = { 'orders/x': {} }; Object.assign(updates['orders/x'], { surcharge_cents: 900 }); await db.ref().update(updates); });"), NEW_S],
    ['synthetic: a ref PARAMETER resolved at its call sites', asIndex("async function stampProbe(orderRef) { await orderRef.update({ surcharge_cents: 900 }); }\ncreateOrderApp.all(async (req, res) => { await stampProbe(db.ref(`orders/${id}`)); });"), NEW_S],
    ['synthetic: a DESTRUCTURED parameter spread into an order write', asIndex("function buildProbe({ fee }) { return { [`orders/${id}`]: { ...fee } }; }\ncreateOrderApp.all(async (req, res) => { await db.ref().update(buildProbe({ fee: { surcharge_cents: 900 } })); });"), NEW_S],
    // P2a: ANY non-literal FIELD key is opaque, never a literal `surcharge_*`
    ['dynamic field: concatenation', asIndex("createOrderApp.all(async (req, res) => { const updates = { 'orders/x': {} }; updates['orders/x']['surcharge_' + kind] = 1; await db.ref().update(updates); });"), /opaque order write unresolved: .*dynamic-field-segment .*orders\/x\/surcharge_\*/],
    ['dynamic field: template in an object key', asIndex("createOrderApp.all(async (req, res) => { await db.ref(`orders/${id}`).update({ [`surcharge_${kind}`]: 1 }); });"), /opaque order write unresolved: .*dynamic-field-segment .*surcharge_\*/],
    ['dynamic field: template in a ref path', asIndex("createOrderApp.all(async (req, res) => { await db.ref(`orders/${id}/surcharge_${kind}`).set(1); });"), /opaque order write unresolved: .*dynamic-field-segment .*orders\/\*\/surcharge_\*/],
    // the explicit over-approximation: a multipath map that ESCAPES without a sink in view is recorded as written
    ['escaped multipath map (returned, no sink in view)', asIndex("function zzEscapeProbe(id) { const m = {}; m[`orders/${id}`] = { surcharge_cents: 900 }; return m; }"), NEW_S],
  ]) {
    const p = problemsWith(u);
    assert.ok(p.some((x) => re.test(x)), `🔴 R3-CENSUS-NEG provenance ${name}: the census stayed GREEN (problems: ${JSON.stringify(p.slice(0, 4))})`);
    ok(`provenance — ${name}: RED — ${p.filter((x) => re.test(x))[0].slice(0, 110)}`);
  }
  // B4 r2 (codex R3-B4 r2, advisor ruling: FAIL CLOSED — a value reaching a write is fully resolved or carries an OPAQUE
  // marker; never an empty provenance). Each probe below must turn the census RED.
  const DYN = /opaque order write unresolved: .*dynamic-field-segment/;
  const OPQ = /opaque order write unresolved: /;
  for (const [name, u, re] of [
    ['r2 P1-1 real: delegated transaction return + a dynamic key (claim-order bindDecision)', real('claim-order.js', '  return { ...cur, customer_uid: uid };\n', "  return { ...cur, customer_uid: uid, ['surcharge_' + uid]: 900 };\n"), DYN],
    ['r2 P1-1 real: delegated transaction return + an unresolved spread (claim-order bindDecision)', real('claim-order.js', '  return { ...cur, customer_uid: uid };\n', '  return { ...cur, customer_uid: uid, ...JSON.parse(\'{"surcharge_cents":900}\') };\n'), /opaque order write unresolved: .*spread-in-order-write/],
    ['r2 P1-2 real: an order path added to the graduation verdicts before the root loop', real('index.js', '    for (const path in out.verdicts) updates[path] = out.verdicts[path];', "    out.verdicts['orders/probe/surcharge_cents'] = 900;\n    for (const path in out.verdicts) updates[path] = out.verdicts[path];"), NEW_S],
    ['r2 P1-2 real: the graduation helper builds its path by a call (no longer a literal tree)', real('ready-time-graduation.js', '    const path = `ready_time_graduation/${s.g.v}/${s.g.restaurant}/${s.g.source}/${s.g.bucket_key}`;', "    const path = ['orders', s.g.restaurant, 'surcharge_cents'].join('/');"), /opaque order write unresolved: .*readyTimeGraduationMonitor computed-key-at-root/],
    ['r2 P1-2 real: acquireOnlineAttempt called through a require-then-assign ALIAS', real('index.js', "chargeOnlineApp.all('*', async (req, res) => {\n", "const chargeProbe = require('./pixelpay-charge').acquireOnlineAttempt;\nchargeOnlineApp.all('*', async (req, res) => {\n  await chargeProbe(db, req.body.id, { surcharge_cents: 900 }, 'fp');\n"), NEW_S],
    ['r2 P1-2 real: acquireOnlineAttempt passed as a VALUE (callers out of view)', real('index.js', "chargeOnlineApp.all('*', async (req, res) => {\n", "const attemptFns = [require('./pixelpay-charge').acquireOnlineAttempt];\nchargeOnlineApp.all('*', async (req, res) => {\n"), /opaque order write unresolved: .*function-escapes .*acquireOnlineAttempt/],
    ['r2 P1-3 real: the order record handed to a class instance that mutates this.rec', real('create-order-build.js', '  updates[`orders/${orderId}`] = orderRecord;\n', '  updates[`orders/${orderId}`] = orderRecord;\n  class RecordProbe { constructor(r) { this.rec = r; } stamp() { this.rec.surcharge_cents = 900; } }\n  new RecordProbe(orderRecord).stamp();\n'), /opaque order write unresolved: .*orderRecord — escapes \(new\)/],
    ['r2 P1-3 real: an ARRAY element pushed to /orders (charge handler)', real('index.js', "chargeOnlineApp.all('*', async (req, res) => {\n", "chargeOnlineApp.all('*', async (req, res) => {\n  const batchProbe = []; batchProbe.push({ surcharge_cents: 900 }); await db.ref('orders').push(batchProbe[0]);\n"), OPQ],
    ['r2 P1-3 synthetic: a `this`-rooted payload', asIndex("class P { async go(db, id) { this.rec = {}; this.rec.surcharge_cents = 900; await db.ref(`orders/${id}`).set(this.rec); } }"), OPQ],
    ['r2 P1-3 synthetic: an object passed to an untracked call before the write', asIndex("createOrderApp.all(async (req, res) => { const rec = { status: 'new' }; mysteryMutator(rec); await db.ref(`orders/${id}`).set(rec); });"), /opaque order write unresolved: .*rec — escapes \(call:mysteryMutator\)/],
    ['r2 P1-3 synthetic: a dynamic FIRST segment at the root could be orders', asIndex("createOrderApp.all(async (req, res) => { const updates = {}; updates[`${tree}/x/surcharge_cents`] = 1; await db.ref().update(updates); });"), /opaque order write unresolved: .*computed-key-at-root/],
    ['r2 P2-4: a constant-folded key IS the literal field (resolved provenance, recorded as written)', real('create-order-build.js', '    orderRecord.lat = lat;\n', "    orderRecord.lat = lat;\n    const feeKey = 'surcharge_' + 'cents';\n    orderRecord[feeKey] = 900;\n"), NEW_S],
  ]) {
    const p = problemsWith(u);
    assert.ok(p.some((x) => re.test(x)), `🔴 R3-CENSUS-NEG fail-closed ${name}: the census stayed GREEN (problems: ${JSON.stringify(p.slice(0, 4))})`);
    ok(`fail-closed — ${name}: RED — ${p.filter((x) => re.test(x))[0].slice(0, 110)}`);
  }
  // a bound opaque write is bound to its COUNT: a second write of the same shape is RED (B4 r2: re-pointed to the one
  // remaining binding — acquireOnlineAttempt's pendingOrderRecord, which has no production caller)
  {
    const p = problemsWith(real('pixelpay-charge.js', 'async function acquireOnlineAttempt(db, orderId, pendingOrderRecord, fingerprint, genId = genAttemptId, canonicalFp = null, textBinding = null) {\n', 'async function acquireOnlineAttempt(db, orderId, pendingOrderRecord, fingerprint, genId = genAttemptId, canonicalFp = null, textBinding = null) {\n  await db.ref(`orders/${orderId}`).set(pendingOrderRecord);\n'));
    assert.ok(p.some((x) => /acquireOnlineAttempt opaque-order-object \(pendingOrderRecord\) matches 2 write\(s\), reviewed for 1/.test(x)), `🔴 R3-CENSUS-NEG second-bound-write: the census stayed GREEN (problems: ${JSON.stringify(p.slice(0, 4))})`);
    ok('second-bound-write: a second unresolved write of the bound shape → RED (the binding is bound to its count)');
  }
  // r2: a LOCAL call resolves to the local function, never to a same-named function of another file (whose parameter
  // escaping would make this quiet write a false opaque)
  {
    const other = { file: 'xpizza-functions/zz-r3-negative-other.js', scope: 'functions', kind: 'fn', lineOffset: 0, module: false, code: 'function readProbe(r) { mysteryMutator(r); }\nmodule.exports = { readProbe };' };
    const local = asIndex("function readProbe(r) { return !!r; }\ncreateOrderApp.all(async (req, res) => { const rec = { status: 'new' }; readProbe(rec); await db.ref(`orders/${id}`).set(rec); });");
    const p = build({ extraUnits: [other, local] }).problems;
    assert.deepStrictEqual(p, [], `🔴 R3-CENSUS-NEG fail-closed local-call: a local call was resolved to another file's same-named function (${JSON.stringify(p.slice(0, 3))})`);
    ok('fail-closed — a local call binds to the LOCAL function (another file\'s same-named escaping helper does not apply): QUIET');
  }
  // B4 r3 (codex R3-B4 r3: 4 P1 "silent empty" holes) — each must turn the census RED
  const H = "chargeOnlineApp.all('*', async (req, res) => {\n";
  const deep = Array.from({ length: 16 }, (_, i) => (i === 0 ? 'function zzDeep0() { return { surcharge_cents: 900 }; }' : `function zzDeep${i}() { return zzDeep${i - 1}(); }`)).join('\n');
  for (const [name, u, re] of [
    ['r3 P1-1 real: `cur || {…}` in an updater (charge handler)', real('index.js', H, H + "  await db.ref('orders/probe').transaction((cur) => cur || { surcharge_cents: 900 });\n"), NEW_S],
    ['r3 P1-1 real: `cur && {…}` in an updater (charge handler)', real('index.js', H, H + "  await db.ref('orders/probe').transaction((cur) => cur && { surcharge_cents: 900 });\n"), NEW_S],
    ['r3 P1-1 real: the updater REASSIGNS its parameter and returns it', real('index.js', H, H + "  await db.ref('orders/probe').transaction((cur) => { cur = { surcharge_cents: 900 }; return cur; });\n"), NEW_S],
    ['r3 P1-1 real: `cur = { ...cur, f }` before the bindDecision return', real('claim-order.js', '  return { ...cur, customer_uid: uid };\n', '  cur = { ...cur, surcharge_cents: 900 };\n  return { ...cur, customer_uid: uid };\n'), NEW_S],
    ['r3 P1-2 real: acquireOnlineAttempt through an alias `.call(…)`', real('index.js', H, "const chargeProbe = require('./pixelpay-charge').acquireOnlineAttempt;\n" + H + "  await chargeProbe.call(null, db, req.body.id, { surcharge_cents: 900 }, 'fp');\n"), /opaque order write unresolved: .*function-escapes .*acquireOnlineAttempt/],
    ['r3 P1-2 real: acquireOnlineAttempt alias escaping through Promise.resolve(alias).then', real('index.js', H, "const chargeProbe = require('./pixelpay-charge').acquireOnlineAttempt;\n" + H + "  await Promise.resolve(chargeProbe).then((f) => f(db, req.body.id, { surcharge_cents: 900 }, 'fp'));\n"), /opaque order write unresolved: .*function-escapes .*acquireOnlineAttempt/],
    ['r3 P1-2 real: a destructured alias `.apply(…)`', real('index.js', H, "const { acquireOnlineAttempt: aoaProbe } = require('./pixelpay-charge');\n" + H + "  await aoaProbe.apply(null, [db, req.body.id, { surcharge_cents: 900 }, 'fp']);\n"), /opaque order write unresolved: .*function-escapes .*acquireOnlineAttempt/],
    ['r3 P1-3 real: Object.defineProperty on the create-order record', real('create-order-build.js', '  updates[`orders/${orderId}`] = orderRecord;\n', "  Object.defineProperty(orderRecord, 'surcharge_cents', { value: 900, enumerable: true });\n  updates[`orders/${orderId}`] = orderRecord;\n"), /opaque order write unresolved: .*orderRecord — escapes \(call:Object\.defineProperty\)/],
    ['r3 P1-3 synthetic: a fresh {} populated by Object.defineProperty, then .update()', asIndex("createOrderApp.all(async (req, res) => { const rec = {}; Object.defineProperty(rec, 'surcharge_cents', { value: 900, enumerable: true }); await db.ref(`orders/${id}`).update(rec); });"), /escapes \(call:Object\.defineProperty\)/],
    ['r3 P1-4 real: a 16-deep builder chain into an order .update() (charge handler)', real('index.js', H, deep + '\n' + H + "  await db.ref('orders/probe').update(zzDeep15());\n"), /NEW order field written: 'surcharge_cents'|analysis-limit/],
    ['r3 P1-4: a 60-deep builder chain hits the ANALYSIS LIMIT → opaque, never empty', asIndex(Array.from({ length: 60 }, (_, i) => (i === 0 ? 'function zzLim0() { return { surcharge_cents: 900 }; }' : `function zzLim${i}() { return zzLim${i - 1}(); }`)).join('\n') + "\ncreateOrderApp.all(async (req, res) => { await db.ref(`orders/${id}`).update(zzLim59()); });"), /opaque order write unresolved: .*analysis-limit/],
    ['r3: a SNAPSHOT of another order spread into this order', asIndex("createOrderApp.all(async (req, res) => { const other = (await db.ref(`orders/${otherId}`).once('value')).val(); await db.ref(`orders/${id}`).set({ ...other }); });"), /opaque order write unresolved: .*snapshot-spread/],
    ['r3 real: a PATH BUILDER now names another order field (factura statusPath)', real('factura/factura-helpers.js', 'const statusPath = (oid) => `orders/${oid}/factura_status`;', 'const statusPath = (oid) => `orders/${oid}/surcharge_cents`;'), NEW_S],
    // codex R3-B4 r5 probes (each alone on the real charge handler) + the r5 typed-empty rule
    ["r5 P1-1 real: a literal-computed `db['ref'](…)` receiver", real('index.js', H, H + "  await db['ref']('orders/probe').update({ surcharge_cents: 900 });\n"), NEW_S],
    ['r5 P1-1 real: a conditional receiver (union of its branches)', real('index.js', H, H + "  await (req.x ? db.ref('orders/probe') : db.ref('orders/other')).update({ surcharge_cents: 900 });\n"), NEW_S],
    ['r5 P1-2 real: a destructuring DEFAULT carries its payload', real('index.js', H, H + "  const { payload: r5probeRec = { surcharge_cents: 900 } } = {};\n  await db.ref('orders/probe').update(r5probeRec);\n"), NEW_S],
    ['r5 P1-3 real: a for-of binding is UNMODELLED (opaque), never empty', real('index.js', H, H + "  for (const r5probeRec of [{ surcharge_cents: 900 }]) { await db.ref('orders/probe').update(r5probeRec); }\n"), /opaque order write unresolved: .*unmodelled-for-of-binding/],
    ['r5 P1-4 real: a conditional member-assignment BASE lands on each branch', real('index.js', H, H + "  const r5probeRec = {};\n  (true ? r5probeRec : r5probeRec).surcharge_cents = 900;\n  await db.ref('orders/probe').update(r5probeRec);\n"), NEW_S],
    ['r5 (c) real: a catch parameter is UNMODELLED (opaque)', real('index.js', H, H + "  try { throw { surcharge_cents: 900 }; } catch (r5probeErr) { await db.ref('orders/probe').update(r5probeErr); }\n"), /opaque order write unresolved: .*unmodelled-catch-param/],
    ['r5 (d) real: an unfollowable member-assignment base is an OPAQUE write on its function', real('index.js', H, H + "  const r5probeRec = {};\n  ({ o: r5probeRec }).o.surcharge_cents = 900;\n  await db.ref('orders/probe').update(r5probeRec);\n"), /opaque order write unresolved: .*chargeOnlineApp.* unmodelled-member-base/],
    ['r5 (b) real: a write on a REF-LIKE receiver that does not resolve is an OPAQUE write', real('index.js', H, H + "  await db[req.m]('orders/probe').update({ surcharge_cents: 900 });\n"), /opaque order write unresolved: .*unresolved-ref-receiver/],
    ['r6 P2: a parameter-sink property selection passes the choke point (a missing property is opaque)', asIndex("async function zzk({ payload }) { await db.ref(`orders/${id}`).update(payload); }\ncreateOrderApp.all(async (req, res) => { await zzk({}); });"), /opaque order write unresolved: .*no-provenance-param-property/],
    ['r5 (a) typed empty: a MISSING property of a resolved object is opaque, never absence', asIndex("createOrderApp.all(async (req, res) => { const zw = { a: 1 }; await db.ref(`orders/${id}`).update(zw.b); });"), /opaque order write unresolved: .*no-provenance-MemberExpression/],
  ]) {
    const p = problemsWith(u);
    assert.ok(p.some((x) => re.test(x)), `🔴 R3-CENSUS-NEG fail-closed ${name}: the census stayed GREEN (problems: ${JSON.stringify(p.slice(0, 4))})`);
    ok(`fail-closed — ${name}: RED — ${p.filter((x) => re.test(x))[0].slice(0, 110)}`);
  }
  // r3: a JSON deep clone keeps its source's provenance — a clone of a resolved, classified record is QUIET
  {
    const p = problemsWith(asIndex("createOrderApp.all(async (req, res) => { const rec = { status: 'new' }; await db.ref(`orders/${id}`).set(JSON.parse(JSON.stringify(rec))); });"));
    assert.deepStrictEqual(p, [], `🔴 R3-CENSUS-NEG fail-closed json-clone: a deep clone of a resolved record was reported (${JSON.stringify(p.slice(0, 3))})`);
    ok('fail-closed — a JSON deep clone of a resolved record keeps its provenance: QUIET');
  }
  // r4 SEMANTIC CLOSURE (replaces r3's syntactic empty-site audit, which codex showed unsound): a GENERATED corpus — every
  // node kind on the walker's handled lists plus a sample of unhandled ones, each placed in a write-reaching position on
  // the REAL charge handler — and every one must SURFACE: the field it writes, or an opaque. Only a silent empty fails.
  {
    const W = "await db.ref('orders/probe')";
    const S = '{ surcharge_cents: 900 }';
    const corpus = [
      // payload expression kinds (handled)
      ['expr: object literal', `${W}.update(${S});`],
      ['expr: identifier', `const zp = ${S}; ${W}.update(zp);`],
      ['expr: member', `const zw = { a: ${S} }; ${W}.update(zw.a);`],
      ['expr: conditional', `${W}.update(req.x ? ${S} : {});`],
      ['expr: logical ||', `${W}.update(req.x || ${S});`],
      ['expr: logical &&', `${W}.update(req.x && ${S});`],
      ['expr: logical ??', `${W}.update(req.x ?? ${S});`],
      ['expr: parenthesized', `${W}.update((${S}));`],
      ['expr: own builder call', `function zf() { return ${S}; } ${W}.update(zf());`],
      ['expr: Object.assign', `${W}.update(Object.assign({}, ${S}));`],
      ['expr: JSON deep clone', `${W}.update(JSON.parse(JSON.stringify(${S})));`],
      ['expr: structuredClone', `${W}.update(structuredClone(${S}));`],
      ['expr: snapshot of another ref', `const zo = (await db.ref('orders/other').once('value')).val(); ${W}.set({ ...zo });`],
      // object property kinds
      ['property: shorthand', `const surcharge_cents = 900; ${W}.update({ surcharge_cents });`],
      ['property: computed literal', `${W}.update({ ['surcharge_cents']: 900 });`],
      ['property: computed dynamic', `${W}.update({ [req.k]: 900 });`],
      ['property: getter', `${W}.update({ get surcharge_cents() { return 900; } });`],
      ['property: a getter BESIDE a plain field (codex r4: the filtered property)', `${W}.update({ status: 'new', get surcharge_cents() { return 900; } });`],
      ['property: method', `${W}.update({ surcharge_cents() { return 900; } });`],
      ['property: spread of a literal', `${W}.update({ ...${S} });`],
      ['property: spread of an unknown', `${W}.update({ ...req.body });`],
      // assignment operators / targets
      ['assign: =', `const za = {}; za.surcharge_cents = 900; ${W}.update(za);`],
      ['assign: ||= (codex r4 P1-1)', `const za = {}; za.surcharge_cents ||= 900; ${W}.update(za);`],
      ['assign: &&=', `const za = {}; za.surcharge_cents &&= 900; ${W}.update(za);`],
      ['assign: ??=', `const za = {}; za.surcharge_cents ??= 900; ${W}.update(za);`],
      ['assign: +=', `const za = {}; za.surcharge_cents += 900; ${W}.update(za);`],
      ['assign: ++', `const za = {}; za.surcharge_cents++; ${W}.update(za);`],
      ['assign: updater cur ||= (codex r4 P1-1)', `${W}.transaction((cur) => { cur ||= ${S}; return cur; });`],
      ['assign: updater cur &&= (codex r4 P1-1)', `${W}.transaction((cur) => { cur &&= ${S}; return cur; });`],
      ['assign: object destructuring (codex r4 P1-1)', `let za = {}; ({ payload: za } = { payload: ${S} }); ${W}.update(za);`],
      ['assign: array destructuring', `let za = {}; [za] = [${S}]; ${W}.update(za);`],
      ['assign: destructuring onto a member', `const za = {}; ({ v: za.surcharge_cents } = { v: 900 }); ${W}.update(za);`],
      ['assign: onto a builder call result', `const zmr = {}; function zmf() { return zmr; } zmf().surcharge_cents = 900; ${W}.update(zmr);`],
      // declaration / parameter patterns
      ['pattern: nested object', `const { a: { b: zr } } = { a: { b: ${S} } }; ${W}.update(zr);`],
      ['pattern: array', `const [zr] = [${S}]; ${W}.update(zr);`],
      ['pattern: rest', `const { ...zr } = ${S}; ${W}.update(zr);`],
      ['pattern: array parameter', `function zg([r]) { return r; } ${W}.update(zg([${S}]));`],
      ['pattern: nested parameter', `function zh({ a: { b } }) { return b; } ${W}.update(zh({ a: { b: ${S} } }));`],
      // unhandled expression kinds (default-deny)
      ['unhandled: array element', `${W}.update([${S}][0]);`],
      ['unhandled: Array.of (codex r4 P1-3)', `${W}.update(Array.of(${S})[0]);`],
      ['unhandled: an array AS the payload (written as index keys)', `${W}.set([${S}]);`],
      ['unhandled: sequence', `${W}.update((0, ${S}));`],
      ['unhandled: assignment expression', `let zt; ${W}.update((zt = ${S}));`],
      ['unhandled: optional chain', `const zw = { a: ${S} }; ${W}.update(zw?.a);`],
      ['unhandled: new', `class Zc { constructor() { this.surcharge_cents = 900; } } ${W}.update(new Zc());`],
      ['unhandled: Object.fromEntries', `${W}.update(Object.fromEntries([['surcharge_cents', 900]]));`],
      ['unhandled: Reflect.set', `const za = {}; Reflect.set(za, 'surcharge_cents', 900); ${W}.update(za);`],
      ['unhandled: Object.defineProperty', `const za = {}; Object.defineProperty(za, 'surcharge_cents', { value: 900, enumerable: true }); ${W}.update(za);`],
      ['unhandled: tagged template', `const zt = (x) => x; ${W}.update(zt\`x\`);`],
      // callee forms
      ["callee: ['update'] (codex r4 P1-2)", `${W}['update'](${S});`],
      ['callee: ["set"]', `${W}["set"](${S});`],
      ['callee: template key', `${W}[\`update\`](${S});`],
      ['callee: dynamic key', `${W}[req.m](${S});`],
      ['callee: .update.call', `const zref = db.ref('orders/probe'); await zref.update.call(zref, ${S});`],
      ['callee: extracted + bound', `const zref = db.ref('orders/probe'); const zu = zref.update.bind(zref); await zu(${S});`],
      ['callee: .set', `${W}.set(${S});`],
      ['callee: .push', `await db.ref('orders').push(${S});`],
      ['callee: .remove of a field', "await db.ref('orders/probe/surcharge_cents').remove();"],
      ['callee: .transaction', `${W}.transaction(() => (${S}));`],
      // r5 (codex R3-B4 r5): receivers, bindings without a plain init, member bases
      ["receiver: db['ref'] (codex r5 P1-1)", `await db['ref']('orders/probe').update(${S});`],
      ['receiver: conditional (codex r5 P1-1)', `await (req.x ? db.ref('orders/probe') : db.ref('orders/other')).update(${S});`],
      ['receiver: sequence', `await (0, db.ref('orders/probe')).update(${S});`],
      ['receiver: logical', `await (req.r || db.ref('orders/probe')).update(${S});`],
      ['receiver: pushed child', `await db.ref('orders').push().set(${S});`],
      ['receiver: snapshot .ref', `const zs = await db.ref('orders/probe').once('value'); await zs.ref.update(${S});`],
      ['receiver: dynamic ref method', `await db[req.m]('orders/probe').update(${S});`],
      ['binding: destructuring default (codex r5 P1-2)', `const { payload: zr = ${S} } = {}; ${W}.update(zr);`],
      ['binding: for-of (codex r5 P1-3)', `for (const zr of [${S}]) { ${W}.update(zr); }`],
      ['binding: for-of onto an existing variable', `let zr = {}; for (zr of [${S}]) ; ${W}.update(zr);`],
      ['binding: for-in key as a field', `const zo = {}; for (const zk in ${S}) zo[zk] = 900; ${W}.update(zo);`],
      ['binding: catch parameter', `try { throw ${S}; } catch (zr) { ${W}.update(zr); }`],
      ['binding: default parameter', `function zg(zr = ${S}) { return zr; } ${W}.update(zg());`],
      ['binding: default parameter, explicit undefined', `function zg(zr = ${S}) { return zr; } ${W}.update(zg(undefined));`],
      ['binding: destructured parameter default', `function zh({ p: zr = ${S} }) { return zr; } ${W}.update(zh({}));`],
      ['member base: ternary (codex r5 P1-4)', `const zr = {}; (true ? zr : zr).surcharge_cents = 900; ${W}.update(zr);`],
      ['member base: logical', `const zr = {}; (req.x || zr).surcharge_cents = 900; ${W}.update(zr);`],
      ['member base: sequence', `const zr = {}; (0, zr).surcharge_cents = 900; ${W}.update(zr);`],
      ['member base: object literal (unfollowable)', `const zr = {}; ({ o: zr }).o.surcharge_cents = 900; ${W}.update(zr);`],
      // r6 (codex R3-B4 r6): cycles, spread arguments, helper-returned / multi-path refs, inherited properties
      ['cycle: a binding revisited for another property (codex r6 P1-1)', `const zsrc = { a: {}, b: ${S} }; const { a: za } = zsrc; const { b: zb = {} } = zsrc; ${W}.update(Object.assign({}, za, zb));`],
      ['cycle: a recursive builder frame (codex r6 P1-1)', `function zrec(n, x) { return n ? zrec(0, ${S}) : x; } ${W}.update(zrec(1, {}));`],
      ['argument: a spread before the parameter (codex r6 P1-2)', `function zsec(a, b) { return b; } ${W}.update(zsec(...[0, ${S}]));`],
      ['argument: a spread into a parameter sink beside a plain call', `async function zsk(a, v) { await db.ref('orders/probe').update(v); } await zsk(0, { status: 'x' }); await zsk(...[0, ${S}]);`],
      ['receiver: a helper-returned ref (codex r6 P1-3)', `function zrf() { return db.ref('orders/probe'); } await zrf().update(${S});`],
      ['receiver: a helper with a default path parameter (codex r6 P1-3)', `function zrp(p = 'orders/probe') { return db.ref(p); } await zrp().update(${S});`],
      ['receiver: a path parameter, two callers', `function zpp(p) { return db.ref(p); } await zpp('other/probe').update({ x: 1 }); await zpp('orders/probe').update(${S});`],
      ['receiver: a ref binding reassigned (codex r6 P1-4)', `let zr = db.ref('other/probe'); zr = db.ref('orders/probe'); await zr.update(${S});`],
      ['receiver: a ref parameter, two callers (codex r6 P1-4)', `async function zw(r, v) { await r.update(v); } await zw(db.ref('other/probe'), { x: 1 }); await zw(db.ref('orders/probe'), ${S});`],
      ['property: inherited via __proto__ into a parameter sink (codex r6 P2)', `async function zk({ payload }) { await db.ref('orders/probe').update(payload); } await zk({ __proto__: { payload: ${S} } });`],
      ['property: inherited via __proto__ under a default (codex r6 P2)', `const { payload: zr = {} } = { __proto__: { payload: ${S} } }; ${W}.update(zr);`],
    ];
    // ONE census build: construct i is one line of its own block, writing field `surcharge_<i>` at `orders/probe<i>` — it
    // surfaces iff its field is reported NEW, or an opaque is reported on its line
    const H = "chargeOnlineApp.all('*', async (req, res) => {\n";
    const at = fsx.readFileSync(pathx.join(REPO_FN, 'index.js'), 'utf8').split(H)[0].split('\n').length + 1;   // the first injected line
    // every `z…` identifier is suffixed per construct: the walker scopes bindings per FUNCTION (a safe merge), so a shared
    // name would let one construct's opaque surface another's write and mask a silent one
    const block = corpus.map(([, code], i) => `  { ${code.replace(/\bz([a-z]+)\b/g, (_, n) => `z${n}${i}x`).replace(/surcharge_cents/g, `surcharge_${i}`).replace(/orders\/probe/g, `orders/probe${i}`).replace(/'orders'\)\.push/g, `'orders').push`)} }`).join('\n');
    const p = problemsWith(real('index.js', H, `${H}${block}\n`));
    const silent = [];
    corpus.forEach(([name], i) => {
      const line = at + i;
      const hit = p.some((x) => x.includes(`NEW order field written: 'surcharge_${i}'`) || (/^opaque order write unresolved: xpizza-functions\/index\.js /.test(x) && x.includes(` line ${line} `)));
      if (!hit) silent.push(`${name} (line ${line})`);
    });
    assert.ok(p.length >= corpus.length - 5, `premise — the corpus surfaces problems (${p.length})`);
    assert.deepStrictEqual(silent, [], '🔴 R3-CENSUS-NEG semantic corpus: a write-reaching construct was SILENT (neither its field nor an opaque surfaced)');
    ok(`fail-closed — semantic corpus: all ${corpus.length} constructs (handled kinds + a sample of unhandled ones, on the real charge handler) surface a field or an opaque — no silent empty`);
  }
  // r4: modelled forms RESOLVE (not merely surface): a logical assignment and a literal-bracket write of classified
  // fields are QUIET — so a regression that turns them opaque is RED too
  for (const [name, code] of [
    ['||= of a classified field', "createOrderApp.all(async (req, res) => { const za = {}; za.status ||= 'new'; await db.ref(`orders/${id}`).update(za); });"],
    ['||= of an object binding', "createOrderApp.all(async (req, res) => { let za = {}; za ||= { status: 'new' }; await db.ref(`orders/${id}`).update(za); });"],
    ['??= of an object binding', "createOrderApp.all(async (req, res) => { let zb; zb ??= { status: 'new' }; await db.ref(`orders/${id}`).update(zb); });"],
    ["['update'] with a classified field", "createOrderApp.all(async (req, res) => { await db.ref(`orders/${id}`)['update']({ status: 'new' }); });"],
    ["db['ref'] receiver", "createOrderApp.all(async (req, res) => { await db['ref'](`orders/${id}`).update({ status: 'new' }); });"],
    ['conditional receiver', "createOrderApp.all(async (req, res) => { await (req.x ? db.ref(`orders/${id}`) : db.ref(`orders/${other}`)).update({ status: 'new' }); });"],
    ['pushed child receiver', "createOrderApp.all(async (req, res) => { await db.ref('orders').push().set({ status: 'new' }); });"],
    ['ternary member base', "createOrderApp.all(async (req, res) => { const za = {}; (req.x ? za : za).status = 'new'; await db.ref(`orders/${id}`).update(za); });"],
    ['destructuring default over a missing key', "createOrderApp.all(async (req, res) => { const { p: za = { status: 'new' } } = {}; await db.ref(`orders/${id}`).update(za); });"],
    ['declared, then assigned', "createOrderApp.all(async (req, res) => { let za; za = { status: 'new' }; await db.ref(`orders/${id}`).update(za); });"],
    ['helper-returned order ref', "createOrderApp.all(async (req, res) => { function zr() { return db.ref(`orders/${id}`); } await zr().update({ status: 'new' }); });"],
    ['a path parameter with a default', "createOrderApp.all(async (req, res) => { function zp(p = `orders/${id}`) { return db.ref(p); } await zp().update({ status: 'new' }); });"],
    ['ref binding reassigned between order paths', "createOrderApp.all(async (req, res) => { let zr = db.ref(`orders/${a}`); zr = db.ref(`orders/${b}`); await zr.update({ status: 'new' }); });"],
    ['a binding revisited by siblings (not a cycle)', "createOrderApp.all(async (req, res) => { const zs = { a: { status: 'new' } }; const { a: za } = zs; const { a: zb } = zs; await db.ref(`orders/${id}`).update(Object.assign({}, za, zb)); });"],
  ]) {
    const p = problemsWith(asIndex(code));
    assert.deepStrictEqual(p, [], `🔴 R3-CENSUS-NEG resolved-form ${name}: a modelled form did not resolve (${JSON.stringify(p.slice(0, 3))})`);
    ok(`fail-closed — modelled form resolves: ${name}: QUIET`);
  }
  // r2 P2-5: an UNUSED local object literal inside a real transaction updater is QUIET (provenance runs to the return)
  {
    const p = problemsWith(real('pixelpay-hosted-charge.js', "      if (decided.kind === 'create') {\n", "      const localProbe = { surcharge_cents: 900 };\n      if (decided.kind === 'create') {\n"));
    assert.deepStrictEqual(p, [], `🔴 R3-CENSUS-NEG fail-closed r2 P2-5: an unused local literal inside acquireHostedAttempt's updater was reported (${JSON.stringify(p.slice(0, 3))})`);
    ok('fail-closed — r2 P2-5 real: an unused local literal inside the acquireHostedAttempt updater: QUIET');
  }
  // P2b: a purely LOCAL object that never persists (no sink, never escapes) is QUIET — no false write finding
  for (const [name, code] of [
    ['local-only multipath object', "createOrderApp.all(async (req, res) => { const local = { 'orders/probe': {} }; local['orders/probe'].surcharge_cents = 1; });"],
    ['local-only record object', "createOrderApp.all(async (req, res) => { const rec = {}; rec.surcharge_cents = 1; console.log(Object.keys(rec).length); });"],
  ]) {
    const p = problemsWith(asIndex(code));
    assert.deepStrictEqual(p, [], `🔴 R3-CENSUS-NEG provenance ${name}: a local object that never persists was reported (${JSON.stringify(p.slice(0, 3))})`);
    ok(`provenance — ${name}: QUIET (never reaches a write, never escapes)`);
  }
}
// the sentinel AND the inventory both fire for a delivery fee on a template path (two independent nets)
{
  const p = problemsWith(cases.find((c) => c[0] === 'template-path')[1]);
  assert.ok(p.some((x) => /write sentinel/.test(x)) && p.some((x) => /NEW order field written/.test(x)), `🔴 R3-CENSUS-NEG template-path: both the sentinel and the write inventory must fire (${JSON.stringify(p.slice(0, 4))})`);
  ok('template-path delivery fee: BOTH nets fire (write sentinel + new-field inventory)');
}
// positive: a WhatsApp send that reads items_text is an R9 reader site (send-boundary data flow, one hop)
{
  const u = unit('wa', "const whatsapp = require('./whatsapp');\nasync function f(order) { const body = `Pedido: ${order.items_text}`; await whatsapp.sendMessage(order.customer_phone, body, order.restaurant_id); }\nmodule.exports = { f };");
  const { doc } = build({ extraUnits: [u] });
  const s = doc.sites.filter((x) => x.id.startsWith('xpizza-functions/zz-r3-negative-wa.js#f#items_text'));
  assert.ok(s.length === 1 && s[0].r === 'R9' && s[0].rule === 'send-boundary', `🔴 R3-CENSUS-NEG wa: the items_text read feeding a WhatsApp send is not an R9 reader (${JSON.stringify(s)})`);
  ok('positive: a new WhatsApp send reading items_text (through a body variable) is mapped R9 by send-boundary data flow — with an obligation, not exempted');
}
console.log(`\nr3-census negative: OK (${n})`);
