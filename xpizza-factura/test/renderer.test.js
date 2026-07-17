'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { layoutFactura, WIDTH } = require('../src/renderer');

// A realistic X. Pizza factura record (15%-only). Money is integer centavos, copied
// verbatim from the order; per-line base_cents already reconciled to subtotal_cents.
function sampleRecord(overrides = {}) {
  return {
    restaurant_name: 'X PIZZA',
    legal_name: 'SHERPA S. DE R.L.',
    rtn: '05019024114145',
    address_1: 'BLVD. LOS PROCERES, 1RA CALLE, 20 AVE. N.O.',
    address_2: 'SAN PEDRO SULA, CORTES, HONDURAS',
    email: 'sherpasderl@gmail.com',
    phone: '(504) 9373-6607 / 9251-0352',
    cai_code: '440857-E69455-F78EE0-63BE03-0909E2-B2',
    factura_number: '000-001-01-00000123',
    pedido: 'ORD-7788',
    fecha: '25/06/2026',
    hora: '07:24:16 PM',
    cliente: '',
    rtn_cliente: '',
    items: [
      { qty: 2, description: 'PIZZA PEPPERONI', desc_pct: 0, base_cents: 34783 },
      { qty: 1, description: 'COCA-COLA', desc_pct: 0, base_cents: 2608 },
    ],
    desc_general_pct: 0,
    desc_rebaja_cents: 0,
    exonerado_cents: 0,
    exento_cents: 0,
    gravado_15_cents: 37391,
    gravado_18_cents: 0,
    isv_15_cents: 5609,
    isv_18_cents: 0,
    subtotal_cents: 37391,
    isv_total_cents: 5609,
    total_cents: 43000,
    forma_de_pago_label: 'EFECTIVO',
    cambio_cents: 7000,
    fecha_limite: '20/11/2026',
    rango_desde: '000-001-01-00000001',
    rango_hasta: '000-001-01-00008000',
    is_temp: false,
    ...overrides,
  };
}

function render(rec) {
  const lines = layoutFactura(rec);
  return { lines, text: lines.join('\n') };
}

test('every line fits the 80mm width (48 cols)', () => {
  const { lines } = render(sampleRecord());
  assert.equal(WIDTH, 48);
  for (const l of lines) assert.ok(l.length <= WIDTH, `line too long (${l.length}): "${l}"`);
});

test('header carries brand, legal entity, RTN and CAI', () => {
  const { text } = render(sampleRecord());
  assert.match(text, /X PIZZA/);
  assert.match(text, /SHERPA S\. DE R\.L\./);
  assert.match(text, /RTN:05019024114145/);
  assert.match(text, /CAI:440857-E69455-F78EE0-63BE03-0909E2-B2/);
});

test('REF carries the order id; FACTURA number prints; no MESA/MESERO', () => {
  const { text } = render(sampleRecord());
  assert.match(text, /REF:ORD-7788/);
  assert.match(text, /FACTURA:000-001-01-00000123/);
  assert.doesNotMatch(text, /MESA|MESERO/);
  // no display_number in the base record → NO PEDIDO:#N line (REF alone, never blank, never flaky)
  assert.doesNotMatch(text, /PEDIDO:#/);
});

test('PEDIDO:#N prints when display_number is set (print-time lookup); REF still carries the id', () => {
  const { text } = render(sampleRecord({ display_number: 47 }));
  assert.match(text, /PEDIDO:#47/);
  assert.match(text, /REF:ORD-7788/);       // full order id stays on the doc (traceable; #N resets daily)
});

test('no-RTN sale leaves CLIENTE and RTN lines blank', () => {
  const { text } = render(sampleRecord());
  assert.match(text, /CLIENTE:\s*$/m);
});

test('RTN sale fills CLIENTE with razon social and the buyer RTN', () => {
  const { text } = render(sampleRecord({ cliente: 'FOTEX', rtn_cliente: '05019024077021' }));
  assert.match(text, /CLIENTE:FOTEX/);
  assert.match(text, /RTN ?:05019024077021/);
});

test('item lines show qty, description and right-aligned tax-exclusive PRECIO', () => {
  const { lines, text } = render(sampleRecord());
  assert.match(text, /PIZZA PEPPERONI/);
  const pizza = lines.find((l) => l.includes('PIZZA PEPPERONI'));
  assert.match(pizza, /^2\b/);          // qty first
  assert.match(pizza, /L347\.83$/);     // base 34783 -> L347.83, right-aligned at line end
  const coke = lines.find((l) => l.includes('COCA-COLA'));
  assert.match(coke, /L26\.08$/);       // base 2608
});

test('importe + ISV block prints both 15% and 18% lines, 18% as 0.00', () => {
  const { text } = render(sampleRecord());
  assert.match(text, /IMPORTE GRAVADO 15\.00% ?:.*373\.91/);
  assert.match(text, /IMPORTE GRAVADO 18\.00% ?:.*0\.00/);
  assert.match(text, /ISV 15\.00% ?:.*56\.09/);
  assert.match(text, /ISV 18\.00% ?:.*0\.00/);
  assert.match(text, /IMPORTE EXONERADO ?:.*0\.00/);
  assert.match(text, /IMPORTE EXENTO ?:.*0\.00/);
});

test('SUB TOTAL / ISV / TOTAL carry the verbatim order cents', () => {
  const { text } = render(sampleRecord());
  assert.match(text, /SUB ?TOTAL: ?.*373\.91/);
  assert.match(text, /ISV ?.*56\.09/);
  assert.match(text, /TOTAL: ?.*430\.00/);
});

test('SON: amount-in-words matches the total', () => {
  const { text } = render(sampleRecord());
  assert.match(text, /SON:CUATROCIENTOS TREINTA LEMPIRAS 00\/100 M\.N\./);
});

test('forma de pago and cambio print', () => {
  const { text } = render(sampleRecord());
  assert.match(text, /FORMAS DE PAGO:EFECTIVO: ?.*430\.00/);
  assert.match(text, /CAMBIO: ?.*70\.00/);
});

test('fecha limite and authorized range print', () => {
  const { text } = render(sampleRecord());
  assert.match(text, /FECHA LIMITE:20\/11\/2026/);
  assert.match(text, /RANGO ?AUTORIZADO/);
  assert.match(text, /DESDE ?: ?000-001-01-00000001/);
  assert.match(text, /HASTA ?: ?000-001-01-00008000/);
});

test('footer carries the two-copy legal line', () => {
  const { text } = render(sampleRecord());
  assert.match(text, /ORIGINAL CLIENTE-COPIA OBLIGADO TRIBUTARIO/);
});

test('temp config stamps FACTURA DE PRUEBA / NO VALIDA FISCALMENTE', () => {
  const { text } = render(sampleRecord({ is_temp: true }));
  assert.match(text, /FACTURA DE PRUEBA/);
  assert.match(text, /NO VALIDA FISCALMENTE/);
});

test('production config does NOT stamp the prueba banner', () => {
  const { text } = render(sampleRecord({ is_temp: false }));
  assert.doesNotMatch(text, /FACTURA DE PRUEBA/);
});
