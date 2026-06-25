'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { styleFor, encodeFactura, CMD } = require('../src/escpos');

const rec = { restaurant_name: 'X PIZZA', is_temp: false };

// ---- styleFor: which lines get emphasis (bold + double-HEIGHT only; never double-width,
// which would break the 48-col grid) ----

test('styleFor: brand line is bold + double-height', () => {
  assert.deepEqual(styleFor('                    X PIZZA', rec), { bold: true, doubleHeight: true });
});

test('styleFor: TOTAL line is bold + double-height', () => {
  assert.deepEqual(styleFor('TOTAL:                                   L430.00', rec), { bold: true, doubleHeight: true });
});

test('styleFor: SUB TOTAL and ISV total are bold, not double-height', () => {
  assert.deepEqual(styleFor('SUB TOTAL:                               L373.91', rec), { bold: true, doubleHeight: false });
  assert.deepEqual(styleFor('ISV                                       L56.09', rec), { bold: true, doubleHeight: false });
});

test('styleFor: FACTURA DE PRUEBA banner is bold + double-height', () => {
  assert.deepEqual(styleFor('           *** FACTURA DE PRUEBA ***', rec), { bold: true, doubleHeight: true });
  assert.deepEqual(styleFor('         *** NO VALIDA FISCALMENTE ***', rec), { bold: true, doubleHeight: true });
});

test('styleFor: importe block ISV lines are NOT emphasized (they start with spaces)', () => {
  assert.deepEqual(styleFor('                              ISV 15.00% :L67.83', rec), { bold: false, doubleHeight: false });
});

test('styleFor: plain item line is unstyled', () => {
  assert.deepEqual(styleFor('2 PIZZA PEPPERONI MEDIANA         0%     L347.83', rec), { bold: false, doubleHeight: false });
});

// ---- encodeFactura: bytes ----

test('encodeFactura returns a Buffer starting with the init command', () => {
  const buf = encodeFactura(rec, ['X PIZZA', 'TOTAL: L1.00']);
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual([...buf.subarray(0, CMD.INIT.length)], CMD.INIT);
});

test('encodeFactura selects a Latin codepage', () => {
  const buf = encodeFactura(rec, ['X PIZZA']);
  assert.ok(buf.includes(Buffer.from(CMD.CODEPAGE)));
});

test('encodeFactura ends with feed + cut', () => {
  const buf = encodeFactura(rec, ['X PIZZA']);
  assert.ok(buf.includes(Buffer.from(CMD.CUT)));
  assert.ok(buf.indexOf(Buffer.from(CMD.CUT)) > buf.length - CMD.CUT.length - 8); // cut is near the end
});

test('encodeFactura emits the line text as latin1 bytes', () => {
  const buf = encodeFactura(rec, ['CLIENTE:FOTEX']);
  assert.ok(buf.includes(Buffer.from('CLIENTE:FOTEX', 'latin1')));
});

test('encodeFactura wraps an emphasized line in bold-on/bold-off', () => {
  const buf = encodeFactura(rec, ['TOTAL: L1.00']);
  const boldOn = buf.indexOf(Buffer.from(CMD.BOLD_ON));
  const text = buf.indexOf(Buffer.from('TOTAL: L1.00', 'latin1'));
  const boldOff = buf.indexOf(Buffer.from(CMD.BOLD_OFF));
  assert.ok(boldOn >= 0 && text > boldOn && boldOff > text, 'bold-on must precede text, bold-off must follow');
});

test('encodeFactura does not bold a plain line', () => {
  const buf = encodeFactura(rec, ['2 PIZZA PEPPERONI MEDIANA         0%     L347.83']);
  assert.equal(buf.indexOf(Buffer.from(CMD.BOLD_ON)), -1);
});
