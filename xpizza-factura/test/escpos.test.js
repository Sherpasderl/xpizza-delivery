'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { styleFor, encodeFactura, CMD } = require('../src/escpos');
const { logoBytes, WIDTH, HEIGHT, DATA } = require('../src/logo');

const rec = { restaurant_name: 'X PIZZA', is_temp: false };
const GS_V0 = Buffer.from([0x1d, 0x76, 0x30]); // GS v 0 — raster image

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

// ---- brand logo raster (GS v 0) ----

test('logoBytes: valid GS v 0 raster — centered, dims match DATA length', () => {
  const b = logoBytes();
  assert.deepEqual([...b.subarray(0, 3)], [0x1b, 0x61, 0x01]); // ESC a 1 (center)
  const i = b.indexOf(GS_V0);
  assert.ok(i >= 0, 'contains GS v 0');
  const wb = b[i + 4] | (b[i + 5] << 8);   // xL xH = bytes/row
  const h = b[i + 6] | (b[i + 7] << 8);    // yL yH = height dots
  assert.equal(wb, WIDTH >> 3);
  assert.equal(h, HEIGHT);
  assert.equal(DATA.length, (WIDTH >> 3) * HEIGHT); // no padding drift
  assert.ok(b.includes(Buffer.from([0x1b, 0x61, 0x00]))); // ESC a 0 restore
});

test('encodeFactura default (text path) carries NO raster — protects the byte tests', () => {
  const buf = encodeFactura(rec, ['X PIZZA']);
  assert.equal(buf.indexOf(GS_V0), -1);
});

test('encodeFactura {logo:true} emits the brand block + SUPPRESSES the plain-text brand header', () => {
  const buf = encodeFactura(rec, ['X PIZZA', 'SHERPA S. DE R.L.'], { logo: true });
  assert.deepEqual([...buf.subarray(0, CMD.INIT.length)], CMD.INIT); // INIT still first (reset before image)
  // the brand name ('X PIZZA') is part of the raster block → no such text in the buffer
  assert.equal(buf.indexOf(Buffer.from('X PIZZA', 'latin1')), -1);
  // the combined brand block is present (one raster) after INIT
  const raster = buf.indexOf(GS_V0);
  assert.ok(raster > 0, 'brand raster present after INIT');
  // a non-brand line still prints as text
  assert.ok(buf.includes(Buffer.from('SHERPA S. DE R.L.', 'latin1')));
});
