'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { numeroALetras, montoEnLetras } = require('../src/num-to-words');

// Spec source: the three real SAR facturas from La Musa Gastro Pub (same Merchant,
// "Soft Restaurant V11" template). We MATCH that template's conventions exactly:
//   - UPPERCASE, no accents (thermal ESC/POS codepage safety)
//   - "UN MIL" for 1000..1999 (template quirk — La Musa #00013653 prints "UN MIL...")
//   - centavos as "NN/100 M.N."

// ---- numeroALetras: integer -> Spanish words ----

test('numeroALetras: units', () => {
  assert.equal(numeroALetras(0), 'CERO');
  assert.equal(numeroALetras(5), 'CINCO');
  assert.equal(numeroALetras(9), 'NUEVE');
});

test('numeroALetras: 16 and 22 use the fused one-word forms without accents', () => {
  assert.equal(numeroALetras(16), 'DIECISEIS');
  assert.equal(numeroALetras(22), 'VEINTIDOS');
});

test('numeroALetras: tens with "Y"', () => {
  assert.equal(numeroALetras(31), 'TREINTA Y UNO');
  assert.equal(numeroALetras(55), 'CINCUENTA Y CINCO');
});

test('numeroALetras: 100 is CIEN but 101 is CIENTO UNO', () => {
  assert.equal(numeroALetras(100), 'CIEN');
  assert.equal(numeroALetras(101), 'CIENTO UNO');
});

test('numeroALetras: hundreds irregular forms', () => {
  assert.equal(numeroALetras(500), 'QUINIENTOS');
  assert.equal(numeroALetras(700), 'SETECIENTOS');
  assert.equal(numeroALetras(900), 'NOVECIENTOS');
});

test('numeroALetras: 243 (factura #00013631)', () => {
  assert.equal(numeroALetras(243), 'DOSCIENTOS CUARENTA Y TRES');
});

test('numeroALetras: 1455 uses "UN MIL" (factura #00013653)', () => {
  assert.equal(numeroALetras(1455), 'UN MIL CUATROCIENTOS CINCUENTA Y CINCO');
});

test('numeroALetras: 3332 (factura #00013639)', () => {
  assert.equal(numeroALetras(3332), 'TRES MIL TRESCIENTOS TREINTA Y DOS');
});

test('numeroALetras: 2000 is DOS MIL (not DOS MILES)', () => {
  assert.equal(numeroALetras(2000), 'DOS MIL');
});

test('numeroALetras: 21000 apocopates to VEINTIUN MIL', () => {
  assert.equal(numeroALetras(21000), 'VEINTIUN MIL');
});

// ---- montoEnLetras: integer centavos -> full SON: line ----

test('montoEnLetras: 145500 centavos -> full line (factura #00013653)', () => {
  assert.equal(
    montoEnLetras(145500),
    'UN MIL CUATROCIENTOS CINCUENTA Y CINCO LEMPIRAS 00/100 M.N.'
  );
});

test('montoEnLetras: 24300 centavos (factura #00013631)', () => {
  assert.equal(
    montoEnLetras(24300),
    'DOSCIENTOS CUARENTA Y TRES LEMPIRAS 00/100 M.N.'
  );
});

test('montoEnLetras: 333200 centavos (factura #00013639)', () => {
  assert.equal(
    montoEnLetras(333200),
    'TRES MIL TRESCIENTOS TREINTA Y DOS LEMPIRAS 00/100 M.N.'
  );
});

test('montoEnLetras: non-zero centavos render as NN/100', () => {
  assert.equal(
    montoEnLetras(69540),
    'SEISCIENTOS NOVENTA Y CINCO LEMPIRAS 40/100 M.N.'
  );
});

test('montoEnLetras: pads single-digit centavos to two digits', () => {
  assert.equal(montoEnLetras(20005), 'DOSCIENTOS LEMPIRAS 05/100 M.N.');
});

test('montoEnLetras: exactly one lempira is singular LEMPIRA', () => {
  assert.equal(montoEnLetras(100), 'UN LEMPIRA 00/100 M.N.');
});
