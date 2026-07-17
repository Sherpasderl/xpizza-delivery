'use strict';

/**
 * Pure factura LAYOUT — record -> array of monospaced lines for an 80mm thermal printer
 * (TM-T20IV, Font A = 48 columns). No I/O, no ESC/POS bytes here; the ESC/POS encoder
 * (escpos.js) wraps these lines with bold/double-height/cut. Replicates the La Musa
 * "Soft Restaurant V11" SAR template field-for-field (same Merchant). Money is integer
 * centavos, copied verbatim from the order; the renderer does NO tax math.
 */

const { montoEnLetras } = require('./num-to-words');
const { formatLempiras } = require('./money');

const WIDTH = 48;
const L = (cents) => 'L' + formatLempiras(cents);

function center(s) {
  s = String(s);
  if (s.length >= WIDTH) return s.slice(0, WIDTH);
  const pad = Math.floor((WIDTH - s.length) / 2);
  return ' '.repeat(pad) + s;
}

// left label + right value justified to the full width
function lr(left, right) {
  left = String(left);
  right = String(right);
  const gap = WIDTH - left.length - right.length;
  if (gap < 1) return (left + ' ' + right).slice(0, WIDTH);
  return left + ' '.repeat(gap) + right;
}

// whole "label:value" cluster pushed to the right margin (importe / ISV block)
function rightBlock(s) {
  s = String(s);
  return s.length >= WIDTH ? s.slice(0, WIDTH) : ' '.repeat(WIDTH - s.length) + s;
}

const sep = () => '='.repeat(WIDTH);

function wrap(text) {
  const words = String(text).split(' ');
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > WIDTH) {
      out.push(line);
      line = w;
    } else {
      line = line ? line + ' ' + w : w;
    }
  }
  if (line) out.push(line);
  return out;
}

// CANT / DESCRIPCION / DESC% / PRECIO row. PRECIO = tax-exclusive base, right-aligned.
const ITEM_RIGHT = 18; // 6 (desc%) + 12 (price)
const ITEM_LEFT = WIDTH - ITEM_RIGHT;
function itemRow(qty, description, descPctStr, priceStr) {
  const left = `${qty} ${description}`.padEnd(ITEM_LEFT).slice(0, ITEM_LEFT);
  const right = String(descPctStr).padStart(6) + String(priceStr).padStart(12);
  return left + right;
}

function layoutFactura(rec) {
  const lines = [];
  const push = (...xs) => xs.forEach((x) => lines.push(x));

  if (rec.is_temp) {
    push(center('*** FACTURA DE PRUEBA ***'));
    push(center('*** NO VALIDA FISCALMENTE ***'));
    push('');
  }

  // ---- Emisor header ----
  push(center(rec.restaurant_name));
  push(center(rec.legal_name));
  push(center(`RTN:${rec.rtn}`));
  if (rec.address_1) push(center(rec.address_1));
  if (rec.address_2) push(center(rec.address_2));
  if (rec.email) push(center(`CORREO:${rec.email}`));
  if (rec.phone) push(center(`TELEFONO ${rec.phone}`));
  push(center(`CAI:${rec.cai_code}`));
  push(sep());

  // ---- Document head ----
  // PEDIDO = the friendly per-restaurant daily #N (set at print time from the order's display_number;
  // see print_agent). Absent → the line is omitted, never blank. REF = the permanent unique order id
  // (was labeled PEDIDO) — always present for traceability since #N resets daily.
  if (Number.isFinite(rec.display_number)) push(`PEDIDO:#${rec.display_number}`);
  push(`REF:${rec.order_id || rec.pedido}`);
  push(`FACTURA:${rec.factura_number}`);
  push(center(`${rec.fecha}  ${rec.hora}`));
  push(`RTN :${rec.rtn_cliente || ''}`);
  push(`CLIENTE:${rec.cliente || ''}`);
  push(sep());

  // ---- Line items ----
  push('CANT.DESCRIPCION'.padEnd(ITEM_LEFT).slice(0, ITEM_LEFT) + 'DESC.'.padStart(6) + 'PRECIO'.padStart(12));
  for (const it of rec.items) {
    push(itemRow(it.qty, it.description, `${it.desc_pct}%`, L(it.base_cents)));
  }
  push('');

  // ---- Importe + ISV block (right-aligned) ----
  push(rightBlock(`DESC GENERAL % :${rec.desc_general_pct || 0}.00%`));
  push(rightBlock(`DESC. Y REB. OTORG :${L(rec.desc_rebaja_cents || 0)}`));
  push(rightBlock(`IMPORTE EXONERADO :${L(rec.exonerado_cents || 0)}`));
  push(rightBlock(`IMPORTE EXENTO :${L(rec.exento_cents || 0)}`));
  push(rightBlock(`IMPORTE GRAVADO 15.00% :${L(rec.gravado_15_cents || 0)}`));
  push(rightBlock(`IMPORTE GRAVADO 18.00% :${L(rec.gravado_18_cents || 0)}`));
  push(rightBlock(`ISV 15.00% :${L(rec.isv_15_cents || 0)}`));
  push(rightBlock(`ISV 18.00% :${L(rec.isv_18_cents || 0)}`));
  push('');

  // ---- Totals ----
  push(lr('SUB TOTAL:', L(rec.subtotal_cents)));
  push(lr('ISV', L(rec.isv_total_cents)));
  push(lr('TOTAL:', L(rec.total_cents)));
  push('');

  // ---- Amount in words ----
  for (const wline of wrap(`SON:${montoEnLetras(rec.total_cents)}`)) push(wline);

  // ---- Payment ----
  push(lr(`FORMAS DE PAGO:${rec.forma_de_pago_label}:`, L(rec.total_cents)));
  push(lr('CAMBIO:', L(rec.cambio_cents || 0)));
  push('');

  // ---- Authorization ----
  push(`FECHA LIMITE:${rec.fecha_limite}`);
  push('RANGO AUTORIZADO :');
  push(`DESDE : ${rec.rango_desde}`);
  push(`HASTA : ${rec.rango_hasta}`);
  push('NO. CORRE O/C EXOGERADA:');
  push('NO. CORRE CONST EXONERADA:');
  push('NO. REGISTRO SAG:');
  push('');

  // ---- Footer ----
  push(center('BUEN PROVECHO'));
  push(center('PEDIDOS EN LINEA - orders.xpizza.hn'));
  push(center('ORIGINAL CLIENTE-COPIA OBLIGADO TRIBUTARIO'));

  return lines;
}

module.exports = { layoutFactura, WIDTH };
