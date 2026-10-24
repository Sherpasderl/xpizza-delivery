'use strict';
// Order colonia (PLAN-colonia-address-area r1, Codex r2 APPROVED) — the test-only INVERSE of the slice's hunks on byte-pinned
// files (hot-file invariant, see memory index-js-inverse-fold-invariant). All SAME-LINE (no line inserted):
//   index.js — validateOrderPayload's address_area field; chargeOnlineOrder's conditional pendingOrderRecord.address_area;
//   create-order-build.js — buildCreateOrderUpdates' conditional orderRecord.address_area.
// Each `now` must occur EXACTLY once. Proof (area-wiring.guard): unapplyAreaIndex(index.js) === acf32fc8:index.js and
// unapplyAreaModule(f, f's src) === acf32fc8:<f> byte-for-byte; other modules pass through. Composed INNERMOST at every fold.

const BASE = 'acf32fc8';
const HUNKS = Object.freeze([
  {
    file: 'index.js',
    now: "    address_details: sanitizeText(body.address_details, 300), address_area: body.order_type === 'delivery' ? require('./address-area').addressAreaFrom(body.address_area) : '',   // colonia (PLAN-colonia r1): server policy, '' = omitted\n",
    was: "    address_details: sanitizeText(body.address_details, 300),\n",
  },
  {
    file: 'index.js',
    now: "    pendingOrderRecord.address_details = fields.address_details; if (fields.address_area) pendingOrderRecord.address_area = fields.address_area;   // colonia: only when kept\n",
    was: "    pendingOrderRecord.address_details = fields.address_details;\n",
  },
  {
    file: 'create-order-build.js',
    now: "    orderRecord.address_details = fields.address_details; if (fields.address_area) orderRecord.address_area = fields.address_area;   // colonia (PLAN-colonia r1): only when kept\n",
    was: "    orderRecord.address_details = fields.address_details;\n",
  },
]);
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))].filter((f) => f !== 'index.js'));

function unapply(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const i = out.indexOf(h.now);
    if (i < 0 || out.indexOf(h.now, i + 1) !== -1) throw new Error(`area-inverse: ${file} hunk not found exactly once: ${h.now.slice(0, 70)}`);
    out = out.slice(0, i) + h.was + out.slice(i + h.now.length);
  }
  return out;
}

const unapplyAreaIndex = (src) => unapply('index.js', src);
const unapplyAreaModule = (file, src) => (FILES.includes(file) ? unapply(file, src) : src);

module.exports = { unapplyAreaIndex, unapplyAreaModule, HUNKS, FILES, BASE };
