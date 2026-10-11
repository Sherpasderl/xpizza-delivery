'use strict';
// 1D add-product B (codex PB-1 r1 P1-3; advisor conditions 2026-10-10) — THE CHARGE-INPUT CANONICALIZER. Run: node catalog/charge-inputs.test.js
//   CENSUS: every `body.X` the order paths read (createOrder, chargeOnlineOrder, validateOrderPayload, the confirmed-net gate
//   input) is classified — in the fingerprint, or non-charge with a reason; the fields the forms send that nothing reads are
//   proven unread. A dynamic `body[...]` read anywhere in those paths fails the census (it could read anything).
//   FINGERPRINT: changing ANY charge field changes it (and keeps it computable); changing a non-charge field does not; an
//   unclassified field makes it null (→ the caller falls through); key order is irrelevant.
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
const CI = require('./charge-inputs');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const idx = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');
const section = (startMarker) => {
  const s = idx.indexOf(startMarker);
  assert.ok(s > 0, `premise: ${startMarker} is in index.js`);
  const e = idx.indexOf('\nexports.', s + startMarker.length);
  return idx.slice(s, e > 0 ? e : undefined);
};
const fnBody = (src, name) => {
  const s = src.indexOf(`function ${name}(`);
  assert.ok(s >= 0, `premise: function ${name} exists`);
  let depth = 0;
  for (let i = src.indexOf('{', s); i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) return src.slice(s, i + 1); } }
  throw new Error(`unbalanced ${name}`);
};
const PATHS = {
  createOrder: section('createOrderApp.all('),
  chargeOnlineOrder: section('chargeOnlineApp.all('),
  validateOrderPayload: fnBody(idx, 'validateOrderPayload'),
  gateInputFromRequest: fnBody(readFileSync(join(__dirname, '..', 'token-gate.js'), 'utf8'), 'gateInputFromRequest'),
};
const READ = new Set();
for (const [name, src] of Object.entries(PATHS)) {
  let code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // the ONE accepted dynamic read: validateOrderPayload's `for (const f of required) … body[f]` over a LITERAL list —
  // its names are read off that literal (so they are classified like any other read) and only that exact loop is excused
  const req = /const required = \[([^\]]*)\];\s*for \(const f of required\) \{\s*if \(body\[f\] == null \|\| body\[f\] === ''\)/.exec(code);
  if (req) {
    for (const m of req[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)) READ.add(m[1]);
    code = code.replace(req[0], '');
  }
  assert.ok(!/\bbody\s*\[/.test(code), `🔴 ${name} reads body[...] dynamically — the census cannot classify that`);
  for (const m of code.matchAll(/\bbody\.([A-Za-z_][A-Za-z0-9_]*)/g)) READ.add(m[1]);
  for (const m of code.matchAll(/\(req\.body \|\| \{\}\)\.([A-Za-z_][A-Za-z0-9_]*)/g)) READ.add(m[1]);
}
const CHARGE = new Set(CI.CHARGE_INPUT_FIELDS);
const NON = new Set(Object.keys(CI.NON_CHARGE_FIELDS));
const UNREAD = new Set(Object.keys(CI.UNREAD_FORM_FIELDS));

{
  assert.ok(READ.size >= 15 && READ.has('items') && READ.has('redeem') && READ.has('lat'), `premise: the census reads the real handlers (${[...READ].join(', ')})`);
  const unclassified = [...READ].filter((f) => !CHARGE.has(f) && !NON.has(f));
  assert.deepStrictEqual(unclassified, [], `🔴 a body field the order paths READ is neither a charge input nor justified as non-charge: ${unclassified.join(', ')}`);
  const readButUnread = [...UNREAD].filter((f) => READ.has(f));
  assert.deepStrictEqual(readButUnread, [], `🔴 a field declared "never read" IS read: ${readButUnread.join(', ')}`);
  for (const [a, b, la, lb] of [[CHARGE, NON, 'charge', 'non-charge'], [CHARGE, UNREAD, 'charge', 'unread'], [NON, UNREAD, 'non-charge', 'unread']]) {
    assert.deepStrictEqual([...a].filter((f) => b.has(f)), [], `a field is both ${la} and ${lb}`);
  }
  for (const [f, why] of Object.entries({ ...CI.NON_CHARGE_FIELDS, ...CI.UNREAD_FORM_FIELDS })) assert.ok(typeof why === 'string' && why.length > 12, `${f} carries its reason`);
  ok(`census: all ${READ.size} body fields the order paths read are classified (${[...READ].filter((f) => CHARGE.has(f)).length} charge, ${[...READ].filter((f) => NON.has(f)).length} non-charge with reasons); ${UNREAD.size} form-sent fields are proven unread; no dynamic body[...] read`);
}

const SAMPLE = {
  order_id: 'XP-1', restaurant_id: 'x_pizza', order_type: 'delivery', scheduled_for: null, pickup_time: 'standard', lat: 14.1, lng: -87.2,
  address_detected: 'Col. X', address_details: 'casa azul', payment_method: 'card', total: 1308, items_text: '2x NY Plain Slice - Combinada (L654)',
  razon_social: '', rtn_cliente: '',
  items: [{ id: 33, name: 'NY Plain Slice - Combinada', qty: 2, price: 654, extras: [{ instance: 0, name: 'Salsa Roja', price: 39 }, { instance: 1, name: 'Mozzarella', price: 50 }] }],
  redeem: { type: 'free_pizza_choice', item_id: 'Carnivora', name: 'Carnivora' },
  customer_name: 'Ana Pérez', customer_phone: '99990000', customer_email: 'a@b.hn', notes: 'sin cebolla', quote_token: 'tok', expected_net_cents: 130800,
  maps_link: 'x', waze_link: 'y', payment_status: 'pending', timestamp: 1, redeem_total_cents: 0, redemption: {}, scheduled: false, total_cents: 130800,
  cash_tendered: null, free_order: false,
};
const fp = CI.chargeInputsFingerprint;
{
  const base = fp(SAMPLE);
  assert.ok(/^[0-9a-f]{64}$/.test(base), 'a full form payload is fingerprinted');
  const reordered = Object.fromEntries(Object.entries(SAMPLE).reverse());
  assert.strictEqual(fp(reordered), base, 'key order is irrelevant');
  const change = (v) => (typeof v === 'number' ? v + 1 : typeof v === 'string' ? `${v}_x` : v === null ? 'set' : typeof v === 'boolean' ? !v : { changed: v });
  for (const f of CI.CHARGE_INPUT_FIELDS) {
    const b = { ...SAMPLE, [f]: change(SAMPLE[f]) };
    const got = fp(b);
    assert.ok(got && got !== base, `🔴 changing the CHARGE input ${f} must change the fingerprint (and keep it computable)`);
    const dropped = { ...SAMPLE }; delete dropped[f];
    assert.ok(fp(dropped) && fp(dropped) !== base, `🔴 omitting the charge input ${f} must change the fingerprint`);
  }
  for (const f of [...NON, ...UNREAD]) assert.strictEqual(fp({ ...SAMPLE, [f]: change(SAMPLE[f]) }), base, `a non-charge field (${f}) never moves it`);
  ok(`fingerprint: each of the ${CI.CHARGE_INPUT_FIELDS.length} charge inputs moves it (changed or omitted); the ${NON.size + UNREAD.size} non-charge fields never do; key order is irrelevant`);
}
{
  const base = fp(SAMPLE);
  const item = (patch) => ({ ...SAMPLE, items: [{ ...SAMPLE.items[0], ...patch }] });
  assert.notStrictEqual(fp(item({ extras: [{ instance: 0, name: 'Salsa Blanca', price: 39 }, { instance: 1, name: 'Mozzarella', price: 50 }] })), base, 'a different option on a line');
  assert.notStrictEqual(fp(item({ extras: [{ instance: 1, name: 'Salsa Roja', price: 39 }, { instance: 0, name: 'Mozzarella', price: 50 }] })), base, 'the same options on different instances (instance structure)');
  assert.notStrictEqual(fp(item({ id: 32, name: 'NY Plain Slice - Salsa Vodka' })), base, 'a different variant');
  assert.notStrictEqual(fp({ ...SAMPLE, redeem: { ...SAMPLE.redeem, item_id: 'Pepperoni' } }), base, 'a different reward selection');
  assert.notStrictEqual(fp({ ...SAMPLE, address_details: 'casa verde' }), base, 'a different fee-bearing address');
  assert.strictEqual(fp({ ...SAMPLE, surprise: 1 }), null, '🔴 an UNCLASSIFIED field → null (the caller falls through)');
  for (const bad of [null, [], 'x', 7]) assert.strictEqual(fp(bad), null, `a non-object body (${JSON.stringify(bad)}) → null`);
  ok('lines: a different option, the same options on other instances, a different variant, reward or address each move it; an unclassified field or a non-object body → null');
}
console.log(`\ncharge-inputs: OK (${n})`);
