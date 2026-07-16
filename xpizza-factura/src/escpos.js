'use strict';

/**
 * ESC/POS byte encoder for the Epson TM-T20IV (80mm, Font A = 48 cols). Wraps the pure
 * text lines from renderer.layoutFactura() with init, codepage, per-line emphasis, and a
 * cut. Emphasis is BOLD + double-HEIGHT only — never double-width, which would push lines
 * past the 48-column grid the layout relies on.
 */

const { layoutFactura } = require('./renderer');
const { logoBytes } = require('./logo');

const CMD = {
  INIT: [0x1b, 0x40], // ESC @  — reset
  CODEPAGE: [0x1b, 0x74, 19], // ESC t 19 — PC858 (Latin-1 + ñ, €)
  BOLD_ON: [0x1b, 0x45, 0x01],
  BOLD_OFF: [0x1b, 0x45, 0x00],
  SIZE_NORMAL: [0x1d, 0x21, 0x00], // GS ! 0
  SIZE_DBL_H: [0x1d, 0x21, 0x01], // GS ! — double height, single width
  FEED: [0x0a, 0x0a, 0x0a],
  CUT: [0x1d, 0x56, 0x42, 0x00], // GS V 66 0 — partial cut w/ feed
};

// Emphasis policy. Lines are the already-padded layout strings.
function styleFor(line, rec) {
  const t = line.trim();
  if (t.includes('FACTURA DE PRUEBA') || t.includes('NO VALIDA FISCALMENTE')) {
    return { bold: true, doubleHeight: true };
  }
  if (rec.restaurant_name && t === rec.restaurant_name) {
    return { bold: true, doubleHeight: true };
  }
  if (line.startsWith('TOTAL:')) return { bold: true, doubleHeight: true };
  if (line.startsWith('SUB TOTAL:') || line.startsWith('ISV ')) {
    return { bold: true, doubleHeight: false };
  }
  return { bold: false, doubleHeight: false };
}

// Encode given pre-laid-out lines into one ESC/POS Buffer. `opts.logo` prepends
// the centered brand raster right after INIT (kept opt-in so the byte-level unit
// tests on the text path stay free of the 11KB image blob; the production
// renderFactura path sets it).
function encodeFactura(rec, lines, { logo = false } = {}) {
  const parts = [Buffer.from(CMD.INIT), Buffer.from(CMD.CODEPAGE)];
  if (logo) parts.push(logoBytes());
  for (const line of lines) {
    // In logo mode, the "X. Pizza" wordmark is baked into the logo block above,
    // so suppress the plain-text brand header (a thermal printer can't set a
    // custom text font — the brand name prints as part of the raster).
    if (logo && rec.restaurant_name && line.trim() === rec.restaurant_name) {
      continue;
    }
    const s = styleFor(line, rec);
    if (s.doubleHeight) parts.push(Buffer.from(CMD.SIZE_DBL_H));
    if (s.bold) parts.push(Buffer.from(CMD.BOLD_ON));
    parts.push(Buffer.from(line, 'latin1'));
    if (s.bold) parts.push(Buffer.from(CMD.BOLD_OFF));
    if (s.doubleHeight) parts.push(Buffer.from(CMD.SIZE_NORMAL));
    parts.push(Buffer.from([0x0a])); // LF
  }
  parts.push(Buffer.from(CMD.FEED), Buffer.from(CMD.CUT));
  return Buffer.concat(parts);
}

// Convenience: render a record straight to bytes. `copies` repeats the body (D4: two copies).
function renderFactura(rec, copies = 2) {
  const lines = layoutFactura(rec);
  const bufs = [];
  for (let i = 0; i < copies; i++) bufs.push(encodeFactura(rec, lines, { logo: true }));
  return Buffer.concat(bufs);
}

module.exports = { styleFor, encodeFactura, renderFactura, CMD };
