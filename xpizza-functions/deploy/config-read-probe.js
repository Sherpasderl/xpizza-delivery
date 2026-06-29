'use strict';

/**
 * (C) Zero-write prod config-read probe (replaces the dropped order-writing canary).
 *
 * Sends ONE out-of-delivery-zone createOrder to the DEPLOYED function. The deployed reader runs
 * getIdentity (reading PROD seeded config) + the zone-check and returns 400 with the radius it used,
 * BEFORE any write / rate-limit / WhatsApp / factura / task / PixelPay call (in 3b, getIdentity +
 * zone-check sit after the idempotency *read* and before the write + rate-limit).
 *
 * Proves: the deployed reader serves prod identity (fresh-or-warm) and routes by it. Does NOT prove
 * byte-identical materialized/cash behavior — that is the emulator + goldens' job (label honestly).
 *
 * Allowed non-customer side-effects (Codex C#2): a Cloud Logging warn line + the in-memory warm-cache
 * mutation. ZERO customer/fiscal/payment state — proven by the post-probe absence read below.
 *
 * Env: CREATEORDER_URL, INTAKE_SECRET, PROBE_STAMP (high-entropy), FB_DATABASE_URL, GOOGLE_APPLICATION_CREDENTIALS.
 */
const admin = require('firebase-admin');
const { assertSafeProbe, assertProbeResponse, PROBE_PREFIX } = require('./probe-guard');

function probePayload(stamp) {
  return {
    order_id: `${PROBE_PREFIX}${stamp}`,
    order_type: 'delivery',
    customer_name: 'DEPLOY PROBE',
    customer_phone: '+50400000000',
    items_text: 'Margherita x1',
    // A valid MENU_PRICES item so validateOrderPayload's server re-pricing (computeServerTotal,
    // index.js:310) passes — it runs BEFORE the zone-check and rejects empty/unknown items. Pricing
    // is pure (no writes), so this preserves the zero-write property; the out-of-zone coords still
    // trigger the 400 before any write/rate-limit/WhatsApp/factura/task/PixelPay.
    items: [{ name: 'Margherita', qty: 1 }],
    payment_method: 'cash',
    lat: 14.0, lng: -87.0, // ~180km from the hub — far outside the 7km zone (guarded below)
    address_detected: 'PROBE — out of zone',
    address_details: 'probe',
  };
}

(async () => {
  const url = process.env.CREATEORDER_URL;
  const secret = process.env.INTAKE_SECRET;
  const stamp = process.env.PROBE_STAMP;
  if (!url || !secret || !stamp) throw new Error('CREATEORDER_URL, INTAKE_SECRET and PROBE_STAMP (high-entropy) are required');

  const payload = probePayload(stamp);

  // C#5 — hard-fail locally BEFORE sending unless provably a zero-write out-of-zone delivery probe.
  const { distKm } = assertSafeProbe(payload);
  console.log(`probe: sending out-of-zone delivery (${distKm.toFixed(0)}km from hub), order_id=${payload.order_id}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(payload),
  });
  let body = {};
  try { body = await res.json(); } catch (_) { /* non-JSON body */ }

  // Hard-fail unless exactly 400 + zone message + radius 7 (200 => a real order was created — ABORT).
  const { radiusKm } = assertProbeResponse(res.status, body);
  console.log(`probe: deployed reader served prod identity → radius ${radiusKm}km (fresh-or-warm config-read OK)`);

  // C#2 — empirical zero-state proof: nothing was written for the probe id. (order_tracking is
  // token-keyed and rate-limit is bucket-keyed; both are written strictly AFTER the zone-check 400,
  // so their absence follows from orders/{id} being absent — the deterministic keys below are the proof.)
  const EMU = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
  const PID = process.env.GCLOUD_PROJECT || 'demo-xpizza';
  admin.initializeApp(
    EMU
      ? { projectId: PID, databaseURL: `http://${EMU}?ns=${PID}-default-rtdb` } // dry-run: same ns as emu-seed.js
      : { credential: admin.credential.applicationDefault(), databaseURL: process.env.FB_DATABASE_URL }
  );
  const db = admin.database();
  const id = payload.order_id;
  for (const p of [`orders/${id}`, `tasks/${id}_pickup`, `tasks/${id}_delivery`]) {
    if ((await db.ref(p).once('value')).exists()) throw new Error(`ZERO-WRITE VIOLATION — ${p} exists after the probe`);
  }
  console.log('probe: zero-state confirmed — no order/task written. OK');
  process.exit(0);
})().catch((e) => { console.error('probe: FAIL —', e.message); process.exit(1); });
