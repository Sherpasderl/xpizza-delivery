'use strict';
// S3c envío activation prerequisites (Customer App) — the test-only exact INVERSE of the slice's hunks in the pinned order-path MODULE
// whatsapp.js (the «Envío» receipt line: envioLines + the `envio` argument of renderOrderReceived; see memory pinned-module-inverse).
// Main's DRIVER C pins whatsapp.js byte-for-byte (drvc-wiring DRVC-MOD-BASE; brand-server-wiring's pre-C check), so every guard that
// pins it reverses the capp hunks FIRST, newest first — s2tip's, then THESE — and then C's. Proof: unapplyS3cModule(f, 72ba5a0d:f) ===
// 786a328a:f byte-for-byte, and on the capp line unapplyS3cModule(unapplyS2tipModule(f)) === 786a328a:f (s3c-wiring.guard). Each hunk
// must occur EXACTLY once, else this throws. GENERATED from `git diff 786a328a 72ba5a0d -- whatsapp.js`; JSON-quoted strings.

const HUNKS = [
 {
  "file": "whatsapp.js",
  "now": "// S3c: the «Envío» line (order-received for a DELIVERY only — a pickup never carries envío) — only when delivery_cents > 0;\n// absent (every order while envío is dark) → no line, byte-identical. A free-delivery promo covering it reads «Gratis». `total` is the CHARGED total.\nfunction envioLines(envio) {\n  if (!envio || !Number.isSafeInteger(envio.cents) || envio.cents <= 0) return [];\n  const net = Math.max(0, envio.cents - (Number.isSafeInteger(envio.promo_cents) ? envio.promo_cents : 0));\n  return [net === 0 ? '🛵 Envío: Gratis' : `🛵 Envío: L${net / 100}`];\n}\n\nfunction renderOrderReceived({ customerName, orderId, itemsText, total, trackingToken, restaurantId, brand, envio }) {\n",
  "was": "function renderOrderReceived({ customerName, orderId, itemsText, total, trackingToken, restaurantId, brand }) {\n"
 },
 {
  "file": "whatsapp.js",
  "now": "    ...envioLines(envio),\n",
  "was": ""
 }
];

const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))]);

function unapplyS3cModule(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const i = out.indexOf(h.now);
    if (i < 0 || out.indexOf(h.now, i + 1) !== -1) throw new Error(`s3c-module-inverse: ${file} hunk not found exactly once: ${h.now.slice(0, 80)}`);
    out = out.slice(0, i) + h.was + out.slice(i + h.now.length);
  }
  return out;
}

module.exports = { unapplyS3cModule, FILES, HUNKS, BASE: '786a328a' };
