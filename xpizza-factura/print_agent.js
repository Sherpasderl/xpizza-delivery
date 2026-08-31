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
const { printedAckFailed } = require('./src/print-recovery');

const RID = process.env.RESTAURANT_ID || 'x_pizza';
const VID = parseInt(process.env.USB_VID || '0x04B8', 16); // Epson
const PID = parseInt(process.env.USB_PID || '0x0202', 16); // VERIFY with Zadig (SP variant!)
const TTL = parseInt(process.env.PRINT_CLAIM_TTL_MS || '60000', 10);
const RETRY_MS = parseInt(process.env.PRINT_RETRY_INTERVAL_MS || '60000', 10);
const OWNER = `${require('os').hostname()}:${process.pid}`;

// Facturas seen as not-yet-printed → retried on a timer until they print (printer-recovery
// self-heal). In-memory only; startup child_added rehydrates it after any restart.
const pendingRetry = new Map();

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
      // Already printed on paper but we couldn't record it (Fix A marker) → do NOT auto-(re)print;
      // leave for manual resolution. Makes printed_ack_failed a real guard, not just a log line.
      if (printedAckFailed(r)) { decision = { action: 'skip', reason: 'printed_ack_failed' }; return undefined; }
      decision = decidePrintClaim(r, { owner: OWNER, now, ttlMs: TTL });
      if (decision.action !== 'claim') return undefined; // abort cleanly (no write/delete)
      return { ...r, print_claim: decision.nextClaim };
    });
    if (!decision || decision.action !== 'claim') {
      // Terminal (printed/void/absent) → drop from retry. Keep it queued if another owner
      // holds a live claim (that owner's attempt may still fail and strand the record).
      if (decision && decision.reason !== 'claimed_by_other') pendingRetry.delete(orderId);
      return;
    }

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
    let physicallyPrinted = false;
    try {
      await sendToPrinter(renderFactura(record, 2)); // two copies (D4)
      physicallyPrinted = true;
      await ref.update({ printed: true, printed_at: now, print_error: null, print_claim: null });
      pendingRetry.delete(orderId); // printed → done
      console.log(`[print] ${record.factura_number} (${orderId}) OK`);
    } catch (e) {
      if (physicallyPrinted) {
        // Printed on paper but couldn't record it → DO NOT auto-reprint (would duplicate the número).
        // Drop from retry + flag for a manual eyeball.
        pendingRetry.delete(orderId);
        await ref.update({ print_error: `printed_ack_failed: ${String(e.message).slice(0, 260)}`, print_claim: null }).catch(() => {});
        console.error(`[print] ${orderId} PRINTED but ack failed — NOT retrying (manual check): ${e.message}`);
      } else {
        await ref.update({ print_error: String(e.message).slice(0, 300), print_claim: null });
        pendingRetry.set(orderId, record); // genuine print failure → retry until it prints
        console.error(`[print] ${orderId} FAILED: ${e.message}`);
      }
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
  // Prune a deleted node so a stale captured record can't be resurrected + reprinted on the timer.
  // (Facturas are voided, never deleted, in the fiscal lifecycle — this is defensive.)
  root.on('child_removed', (snap) => pendingRetry.delete(snap.key));

  // Self-heal: re-run handle() for every stranded (printed:false) factura each interval, so a
  // record left by a brief printer outage (paper-out / USB drop / power) prints once the printer
  // recovers — no manual RTDB poke. handle() is the single authority on membership; the unchanged
  // transactional decidePrintClaim still guards every print (overlapping ticks can't double-print).
  // Fail-safe: a retry error is logged, never crashes the always-on service.
  setInterval(() => {
    for (const [orderId, rec] of pendingRetry) {
      handle(orderId, rec).catch((e) => console.error('[retry]', orderId, e && e.message));
    }
  }, RETRY_MS);
  console.log(`[agent] retry sweep every ${RETRY_MS}ms`);
}

start();
