'use strict';

/**
 * Force a reprint of a STRANDED factura (printed:false) — e.g. one left unprinted by a brief
 * printer outage. Clears the print flags so the always-on print agent re-fires and prints the
 * SAME número/CAI (NOT a new factura, NO número allocation).
 *
 * REFUSES printed:true and void records:
 *  - printed:true → reprinting an ISSUED+printed factura as a customer COPY is a fiscal COPIA
 *    decision (needs a renderer "REIMPRESIÓN/COPIA" marker + owner sign-off) — out of scope here.
 *  - void → the document is voided; do not print.
 *
 * Usage (on the Surface): node tools/reprint.js <orderId>
 */

require('dotenv').config();
const admin = require('firebase-admin');
const { reprintDecision } = require('../src/print-recovery');

const RID = process.env.RESTAURANT_ID || 'x_pizza';
const orderId = process.argv[2];
if (!orderId) { console.error('usage: node tools/reprint.js <orderId>'); process.exit(2); }

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: process.env.FB_DATABASE_URL,
});
const db = admin.database();

(async () => {
  const ref = db.ref(`facturas/${RID}/${orderId}`);
  const rec = (await ref.once('value')).val();
  const d = reprintDecision(rec);
  if (d.action !== 'reprint') {
    console.error(`refuse: ${d.reason} (${orderId})` +
      (d.reason === 'already_printed'
        ? ' — a reprint of an ISSUED+printed factura needs a fiscal COPIA decision; not done here.'
        : ''));
    process.exit(1);
  }
  await ref.update({ printed: false, printed_at: null, print_error: null, print_claim: null });
  console.log(`reprint queued: ${rec.factura_number} (${orderId}) — the print agent will print it shortly.`);
  process.exit(0);
})().catch((e) => { console.error('error:', e && e.message); process.exit(1); });
