'use strict';
/**
 * Dev preview: render a factura from a sample order through the REAL math pipeline
 * (priceBreakdown + reconcileLineBases) so the layout + numbers can be eyeballed.
 * Not production code. Run: node preview.js
 */
const { priceBreakdown, reconcileLineBases } = require('./src/money');
const { layoutFactura, WIDTH } = require('./src/renderer');

// A sample cash delivery order (prices are tax-INCLUSIVE menu prices, in centavos).
const order = {
  pedido: 'ORD-7788',
  items: [
    { qty: 2, description: 'PIZZA PEPPERONI MEDIANA', unit_gross_cents: 20000 },
    { qty: 1, description: 'COCA-COLA 600ML', unit_gross_cents: 3000 },
    { qty: 1, description: 'PALITROQUES DE AJO', unit_gross_cents: 9000 },
  ],
  forma_de_pago_label: 'EFECTIVO',
  cash_tendered_cents: 60000, // customer pays with L600
};

// --- build the factura record (the part allocateFacturaNumber will do server-side) ---
const lineGross = order.items.map((i) => i.unit_gross_cents * i.qty);
const total_cents = lineGross.reduce((a, b) => a + b, 0);
const { subtotal_cents, isv_cents } = priceBreakdown(total_cents);
const bases = reconcileLineBases(lineGross, subtotal_cents);

const record = {
  restaurant_name: 'X PIZZA',
  legal_name: 'SHERPA S. DE R.L.',
  rtn: '05019024114145',
  address_1: 'BLVD. LOS PROCERES, 1RA CALLE, 20 AVE. N.O.',
  address_2: 'SAN PEDRO SULA, CORTES, HONDURAS',
  email: 'sherpasderl@gmail.com',
  phone: '(504) 9373-6607 / 9251-0352',
  cai_code: 'TEMP-CAI-PENDIENTE-SAR',
  factura_number: '000-001-01-00000123',
  pedido: order.pedido,
  fecha: '25/06/2026',
  hora: '07:24:16 PM',
  cliente: '',
  rtn_cliente: '',
  items: order.items.map((it, idx) => ({
    qty: it.qty,
    description: it.description,
    desc_pct: 0,
    base_cents: bases[idx],
  })),
  desc_general_pct: 0,
  desc_rebaja_cents: 0,
  exonerado_cents: 0,
  exento_cents: 0,
  gravado_15_cents: subtotal_cents,
  gravado_18_cents: 0,
  isv_15_cents: isv_cents,
  isv_18_cents: 0,
  subtotal_cents,
  isv_total_cents: isv_cents,
  total_cents,
  forma_de_pago_label: order.forma_de_pago_label,
  cambio_cents: order.cash_tendered_cents - total_cents,
  fecha_limite: '20/11/2026',
  rango_desde: '000-001-01-00000001',
  rango_hasta: '000-001-01-00008000',
  is_temp: true,
};

const rule = '+' + '-'.repeat(WIDTH) + '+';
console.log('\n' + rule);
for (const line of layoutFactura(record)) console.log('|' + line.padEnd(WIDTH) + '|');
console.log(rule);

// math sanity echo
const colSum = record.items.reduce((a, i) => a + i.base_cents, 0);
console.log(`\nmath check:`);
console.log(`  PRECIO column sum = ${colSum}  subtotal_cents = ${subtotal_cents}  -> ${colSum === subtotal_cents ? 'MATCH' : 'MISMATCH'}`);
console.log(`  subtotal + isv   = ${subtotal_cents + isv_cents}  total_cents = ${total_cents}  -> ${subtotal_cents + isv_cents === total_cents ? 'MATCH' : 'MISMATCH'}`);
console.log(`  cambio           = L${(record.cambio_cents / 100).toFixed(2)} (paid L${(order.cash_tendered_cents / 100).toFixed(2)} on L${(total_cents / 100).toFixed(2)})\n`);
