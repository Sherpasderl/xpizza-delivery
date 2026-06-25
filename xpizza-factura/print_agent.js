'use strict';

/**
 * Print agent — runs on the Surface Pro (KDS host) as an always-on Node service (NSSM).
 * Watches /facturas/{restaurantId}, claims each record transactionally (no double-print),
 * renders ESC/POS, and sends raw bytes to the Epson TM-T20IV over WinUSB (Zadig).
 *
 * HARDWARE-DEPENDENT — not unit-tested. The pure pieces it relies on (decidePrintClaim,
 * renderFactura) are fully tested. Config via .env (see SETUP.md):
 *   FB_DATABASE_URL, GOOGLE_APPLICATION_CREDENTIALS (or SERVICE_ACCOUNT_JSON),
 *   RESTAURANT_ID, USB_VID, USB_PID, PRINT_CLAIM_TTL_MS
 */

require('dotenv').config();
const admin = require('firebase-admin');
const usb = require('usb');
const { renderFactura } = require('./src/escpos');
const { decidePrintClaim } = require('./src/print-claim');

const RID = process.env.RESTAURANT_ID || 'x_pizza';
const VID = parseInt(process.env.USB_VID || '0x04B8', 16); // Epson
const PID = parseInt(process.env.USB_PID || '0x0202', 16); // VERIFY with Zadig (SP variant!)
const TTL = parseInt(process.env.PRINT_CLAIM_TTL_MS || '60000', 10);
const OWNER = `${require('os').hostname()}:${process.pid}`;

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: process.env.FB_DATABASE_URL,
});
const db = admin.database();

// ---- USB: send a Buffer to the printer's bulk-OUT endpoint ----
function sendToPrinter(buf) {
  return new Promise((resolve, reject) => {
    const device = usb.findByIds(VID, PID);
    if (!device) return reject(new Error(`printer not found (VID=${VID.toString(16)} PID=${PID.toString(16)})`));
    try {
      device.open();
    } catch (e) {
      return reject(new Error(`device.open failed (Zadig/WinUSB driver?): ${e.message}`));
    }
    const iface = device.interfaces[0];
    if (iface.isKernelDriverActive && iface.isKernelDriverActive()) {
      try { iface.detachKernelDriver(); } catch (_) { /* not on Windows */ }
    }
    iface.claim();
    const out = iface.endpoints.find((e) => e.direction === 'out');
    if (!out) { iface.release(() => device.close()); return reject(new Error('no OUT endpoint')); }
    out.transfer(buf, (err) => {
      iface.release(true, () => { try { device.close(); } catch (_) {} });
      err ? reject(err) : resolve();
    });
  });
}

// ---- handle one factura record ----
async function handle(orderId) {
  const ref = db.ref(`facturas/${RID}/${orderId}`);
  let decision;
  const now = Date.now();
  const tx = await ref.transaction((rec) => {
    decision = decidePrintClaim(rec, { owner: OWNER, now, ttlMs: TTL });
    if (decision.action !== 'claim') return rec; // no change
    return { ...rec, print_claim: decision.nextClaim };
  });
  if (!decision || decision.action !== 'claim') return; // skipped

  const record = tx.snapshot.val();
  try {
    await sendToPrinter(renderFactura(record, 2)); // two copies (D4)
    await ref.update({ printed: true, printed_at: now, print_error: null, print_claim: null });
    console.log(`[print] ${record.factura_number} (${orderId}) OK`);
  } catch (e) {
    await ref.update({ print_error: String(e.message).slice(0, 300), print_claim: null });
    console.error(`[print] ${orderId} FAILED: ${e.message}`);
  }
}

function start() {
  console.log(`[agent] watching /facturas/${RID} as ${OWNER}`);
  const root = db.ref(`facturas/${RID}`);
  root.on('child_added', (snap) => handle(snap.key).catch((e) => console.error('[agent] child_added', e)));
  root.on('child_changed', (snap) => handle(snap.key).catch((e) => console.error('[agent] child_changed', e)));
}

start();
