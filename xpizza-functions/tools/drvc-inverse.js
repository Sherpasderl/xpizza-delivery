'use strict';
// DRIVER C (PLAN-driver-server-C-llegue r3) — the slice's index.js INVERSE: C adds ONE delimited block at the END of index.js,
//   "\n/* drvc:begin */ … /* drvc:end */\n"
// and nothing else. unapplyDrvcIndex removes it (exactly once, both delimiters, begin before end), returning F (c8b08cf1)'s index.js
// byte-for-byte. It is the NEWEST layer, so every index.js-reversing guard applies it FIRST (innermost), before DRIVER F's inverse.
const BEGIN = '/* drvc:begin */';
const END = '/* drvc:end */';

function unapplyDrvcIndex(src) {
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  if (b < 0 || e < 0) throw new Error(`drvc block not found exactly once (begin ${b >= 0}, end ${e >= 0})`);
  if (src.indexOf(BEGIN, b + 1) >= 0 || src.indexOf(END, e + 1) >= 0) throw new Error('drvc block not found exactly once (a second delimiter)');
  if (e < b) throw new Error('drvc block delimiters out of order');
  const start = b - 1;
  if (src[start] !== '\n') throw new Error('drvc block is not preceded by its blank-line separator');
  const stop = e + END.length;
  if (src[stop] !== '\n') throw new Error('drvc block is not followed by its trailing newline');
  return src.slice(0, start) + src.slice(stop + 1);
}


// …and its module hunks: whatsapp.js is PINNED by an older guard (brand-server-wiring.guard.test.js), so C's insertions there (the
// «llegó» template, tplArrived, instanceFor, their exports) are reversed here — each must occur exactly once. Generated from the
// c8b08cf1 → C diff; a file C did not touch passes through unchanged.
const MODULE_HUNKS = Object.freeze([
 {
  "file": "whatsapp.js",
  "now": "\n// DRIVER C (PLAN-driver-server-C-llegue r3; OWNER-APPROVED mockup MOCKUP-driver-C-llegue-customer.html, frame 1) — the driver\n// tapped «Llegué»: the arrival notice, then «Sigue su ubicación:» + the tracking link (the tplDriverAssigned layout).\nfunction renderArrived({ customerName, trackingToken, restaurantId }) {\n  const name = typeof customerName === 'string' && customerName.trim() ? customerName.trim() : null;\n  return [\n    `${name ? `¡${name}, tu repartidor llegó!` : '¡Tu repartidor llegó!'} 🛵 Ya está afuera con tu pedido.`,\n    ``,\n    `Sigue su ubicación:`,\n    trackingUrl(trackingToken, restaurantId)\n  ].join('\\n');\n}\n\n",
  "was": "\n"
 },
 {
  "file": "whatsapp.js",
  "now": "  cancelled: renderCancelled, pickupReady: renderPickupReady, preparing: renderPreparing, otp: renderOtp,\n  arrived: renderArrived,\n",
  "was": "  cancelled: renderCancelled, pickupReady: renderPickupReady, preparing: renderPreparing, otp: renderOtp,\n"
 },
 {
  "file": "whatsapp.js",
  "now": "const tplOtp = (args) => defer('otp', args);\nconst tplArrived = (args) => defer('arrived', args);   // DRIVER C\n\n// DRIVER C (Codex r1 P2-8) — WHICH UltraMsg instance a restaurant routes to, FAIL-CLOSED: resolveWhatsappConfig sends any\n// unknown id through the default instance (today's senders rely on that and are unchanged); the arrival notice instead\n// requires a restaurant with its OWN instance — the default instance's restaurant, or la_musa with its creds — else null.\nfunction instanceFor(restaurantId, env = process.env) {\n  if (restaurantId === 'la_musa') return resolveWhatsappConfig(restaurantId, env) ? 'la_musa' : null;\n  if (restaurantId === 'x_pizza') return 'default';\n  return null;\n}\n",
  "was": "const tplOtp = (args) => defer('otp', args);\n"
 },
 {
  "file": "whatsapp.js",
  "now": "  tplPreparing,\n  tplArrived,\n  instanceFor,\n",
  "was": "  tplPreparing,\n"
 }
]);
function unapplyDrvcModule(file, src) {
  let out = src;
  for (const h of MODULE_HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`drvc-inverse: ${file}: a C hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const FILES = Object.freeze([...new Set(MODULE_HUNKS.map((h) => h.file))]);

module.exports = { BEGIN, END, unapplyDrvcIndex, MODULE_HUNKS, FILES, unapplyDrvcModule };
