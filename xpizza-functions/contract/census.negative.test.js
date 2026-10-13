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
  const b = problemsWith(page("import * as XPD from './xpizza-delivery.js'; export function wire() { return XPD.assignOrderToDriver; }"));
  assert.ok(b.some((x) => /stale unreachableOnSurface entry: xpizza-kitchen\/xpizza-delivery\.js#assignOrderToDriver/.test(x)), `🔴 R3-CENSUS-NEG unreachable-revived: passed (${JSON.stringify(b.slice(0, 3))})`);
  ok('unreachable on surface, reviewed both ways: a new unreferenced KDS function reading order.total → RED; referencing a reviewed-unreachable SDK function (XPD.assignOrderToDriver) → its entry is stale → RED');
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
  ['second-bound-write', "createOrderApp.all(async (req, res) => { const heldUpdates = { ['orders/x']: record }; await db.ref().update(heldUpdates); });", /matches 2 write\(s\), reviewed for 1/],
]) {
  const p = problemsWith(asIndex(code));
  assert.ok(p.some((x) => re.test(x)), `🔴 R3-CENSUS-NEG ${name}: the census stayed GREEN (problems: ${JSON.stringify(p.slice(0, 4))})`);
  ok(`${name} (injected into index.js / createOrderApp.all): RED — ${p.filter((x) => re.test(x))[0].slice(0, 130)}`);
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
