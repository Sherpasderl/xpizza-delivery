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
