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
    // Kernel-driver detach is Linux-only; on Windows/WinUSB isKernelDriverActive() THROWS
    // LIBUSB_ERROR_NOT_SUPPORTED. Guard the whole block so Windows just skips it.
    try {
      if (iface.isKernelDriverActive()) iface.detachKernelDriver();
    } catch (_) { /* not supported on Windows/WinUSB — expected, ignore */ }
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
// `known` is the snapshot value from the child_added/child_changed event — used as the
// fallback when firebase-admin invokes the transaction updater with `null` first on a cold
// local cache (otherwise decidePrintClaim(null) skips as 'absent' and the record never prints).
// In-process guard: the agent's OWN writes (print_claim, printed) fire child_changed, which
// re-enters handle() for the same record. Skip if we're already processing this orderId, so
// transactions/updates on one node never overlap (avoids firebase repoAbortTransactions).
const inFlight = new Set();

async function handle(orderId, known) {
  if (inFlight.has(orderId)) return;
  inFlight.add(orderId);
  try {
    const ref = db.ref(`facturas/${RID}/${orderId}`);
    let decision;
    const now = Date.now();
    const tx = await ref.transaction((rec) => {
      const r = rec == null ? known : rec;
      decision = decidePrintClaim(r, { owner: OWNER, now, ttlMs: TTL });
      if (decision.action !== 'claim') return undefined; // abort cleanly (no write/delete)
      return { ...r, print_claim: decision.nextClaim };
    });
    if (!decision || decision.action !== 'claim') return; // skipped

    const record = tx.snapshot.val();
    // Best-effort #N: read the order's display_number FRESH at print time (by now the platform allocator
    // has stamped it) so PEDIDO:#N is consistent, not race-dependent on factura-build timing. NEVER blocks
    // the print — a slow/failed read (2s cap) just prints REF-only. Read-only; enriches the record for render.
    if (record && record.order_id) {
      try {
        const dnSnap = await Promise.race([
          db.ref(`orders/${record.order_id}/display_number`).once('value'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('dn-timeout')), 2000)),
        ]);
        const dn = dnSnap.val();
        if (Number.isFinite(dn)) record.display_number = dn;
      } catch (_) { /* fail-open: print REF-only, never block the factura */ }
    }
    try {
      await sendToPrinter(renderFactura(record, 2)); // two copies (D4)
      await ref.update({ printed: true, printed_at: now, print_error: null, print_claim: null });
      console.log(`[print] ${record.factura_number} (${orderId}) OK`);
    } catch (e) {
      await ref.update({ print_error: String(e.message).slice(0, 300), print_claim: null });
      console.error(`[print] ${orderId} FAILED: ${e.message}`);
    }
  } finally {
    inFlight.delete(orderId);
  }
}

function start() {
  console.log(`[agent] watching /facturas/${RID} as ${OWNER}`);
  const root = db.ref(`facturas/${RID}`);
  root.on('child_added', (snap) => handle(snap.key, snap.val()).catch((e) => console.error('[agent] child_added', e)));
  root.on('child_changed', (snap) => handle(snap.key, snap.val()).catch((e) => console.error('[agent] child_changed', e)));
}

start();
