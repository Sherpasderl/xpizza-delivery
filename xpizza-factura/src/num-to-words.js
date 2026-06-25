'use strict';

/**
 * Spanish "monto en letras" for SAR facturas, matching the La Musa "Soft Restaurant V11"
 * template (same Merchant, Sherpa S. de R.L.):
 *   - UPPERCASE, no accents (thermal ESC/POS codepage safety)
 *   - "UN MIL" for 1000..1999 (template convention, not standard "MIL")
 *   - apocope of "UNO" -> "UN" before MIL and before the noun LEMPIRA(S)
 *   - centavos rendered as "NN/100 M.N."
 *
 * Money is integer centavos everywhere (consistent with the platform's *_cents model).
 */

const UNIDADES = [
  'CERO', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE',
  'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISEIS', 'DIECISIETE',
  'DIECIOCHO', 'DIECINUEVE', 'VEINTE', 'VEINTIUNO', 'VEINTIDOS', 'VEINTITRES',
  'VEINTICUATRO', 'VEINTICINCO', 'VEINTISEIS', 'VEINTISIETE', 'VEINTIOCHO', 'VEINTINUEVE'
];
const DECENAS = ['', '', '', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
const CENTENAS = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS',
  'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];

// "UNO" -> "UN" at the end of a group (before MIL / a masculine noun): UNO, VEINTIUNO,
// "TREINTA Y UNO" all apocopate by trimming the trailing "UNO".
function apocopar(s) {
  return s.replace(/UNO$/, 'UN');
}

// 0..999 in words.
function tresCifras(n) {
  if (n === 100) return 'CIEN';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  let words = c > 0 ? CENTENAS[c] : '';
  if (resto > 0) {
    let r;
    if (resto < 30) {
      r = UNIDADES[resto];
    } else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      r = DECENAS[d] + (u > 0 ? ' Y ' + UNIDADES[u] : '');
    }
    words = words ? words + ' ' + r : r;
  }
  return words;
}

// Non-negative integer in words. Supports up to the millions.
function numeroALetras(n) {
  n = Math.trunc(n);
  if (n === 0) return 'CERO';
  const millones = Math.floor(n / 1000000);
  const miles = Math.floor((n % 1000000) / 1000);
  const resto = n % 1000;
  const parts = [];
  if (millones > 0) {
    parts.push(millones === 1 ? 'UN MILLON' : apocopar(tresCifras(millones)) + ' MILLONES');
  }
  if (miles > 0) {
    parts.push(apocopar(tresCifras(miles)) + ' MIL'); // "UN MIL", "VEINTIUN MIL", "DOS MIL"
  }
  if (resto > 0) {
    parts.push(tresCifras(resto));
  }
  return parts.join(' ');
}

// Integer centavos -> full SON: line, e.g. 145500 ->
// "UN MIL CUATROCIENTOS CINCUENTA Y CINCO LEMPIRAS 00/100 M.N."
function montoEnLetras(totalCents) {
  totalCents = Math.round(totalCents);
  const lempiras = Math.floor(totalCents / 100);
  const centavos = totalCents % 100;
  const words = apocopar(numeroALetras(lempiras));
  const noun = lempiras === 1 ? 'LEMPIRA' : 'LEMPIRAS';
  const cc = String(centavos).padStart(2, '0');
  return `${words} ${noun} ${cc}/100 M.N.`;
}

module.exports = { numeroALetras, montoEnLetras };
