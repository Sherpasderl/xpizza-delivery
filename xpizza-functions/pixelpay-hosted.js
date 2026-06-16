/**
 * X Pizza — PixelPay Hosted Payment client (Stage H1).
 *
 * "Venta Directa" via PixelPay's **Hosted Payment Gateway** (redirect): the SERVER
 * creates a charge with a SERVER-SET amount, the customer pays on PixelPay's hosted
 * checkout (card + 3DS by PixelPay), and an authenticated `_callback` delivers the
 * authoritative amount + payment_hash. See HOSTED-PAYMENT-PLAN.md (Codex-approved).
 *
 * Forced pivot: the acquirer (Ficohsa) allows only direct sale, not AUTH+Capture.
 * The browser never sets the amount → money-safe.
 *
 * NOTE: for hosted/other the signature is a **form field `_client_signature`** (NOT the
 * `x-client-signature` HEADER used by the JSON transaction APIs). Same formula:
 * HMAC-SHA3-512(secret, app_key | pixelpay_order_id | app_url).
 */
const { resolvePixelPayConfig } = require('./pixelpay-config');
const ppCrypto = require('./pixelpay');

const REQUEST_TIMEOUT_MS = 30000;

/**
 * Parse a decimal-lempira amount (string or number) into INTEGER CENTAVOS, so the
 * callback amount can be compared to order.total_cents without float drift (I2).
 * Accepts "299", "299.5", "299.50", 299, 299.9. Returns NaN for anything malformed
 * (so a bad/absent amount can never accidentally equal a real total).
 */
function toCents(amount) {
  if (amount == null) return NaN;
  const s = String(amount).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/**
 * Create a hosted charge. Returns { ok, url, httpStatus, errors, raw }.
 * Never throws for HTTP/PixelPay errors (returns ok:false); only network/abort rejects.
 *   pixelpayOrderId = `${order_id}-${attemptId}` (the `_order_id` we send + sign + later verify).
 *   amountLempiras  = server-set total, decimal HNL (string-formatted by the caller).
 */
async function createHostedCharge({
  pixelpayOrderId, amountLempiras, firstName, lastName, email,
  completeUrl, cancelUrl, callbackUrl, expiresAt
}) {
  const cfg = resolvePixelPayConfig();
  const signature = ppCrypto.clientSignature(cfg.secret, [cfg.app_key, pixelpayOrderId, cfg.app_url]);

  const params = new URLSearchParams();
  params.set('_key', cfg.app_key);
  params.set('_client_signature', signature);          // form field (not header) for hosted
  params.set('_amount', String(amountLempiras));        // server-set; decimal HNL
  params.set('_order_id', pixelpayOrderId);
  params.set('_currency', 'HNL');
  params.set('_first_name', firstName);
  params.set('_last_name', lastName);
  params.set('_email', email);                          // must be a valid email (PixelPay requires)
  params.set('_complete', completeUrl);
  params.set('_cancel', cancelUrl);
  params.set('_callback', callbackUrl);                 // includes ?secret=<PIXELPAY_WEBHOOK_SECRET>
  if (expiresAt) params.set('expired_at', expiresAt);   // charge TTL (yyyy/mm/dd hh:mm)
  params.set('json', 'true');                            // → { success, url } instead of an HTML redirect

  // sandbox simulator lives at hosted/sandbox; production at hosted/other.
  const action = cfg.mode === 'sandbox' ? 'hosted/sandbox' : 'hosted/other';
  const url = `${String(cfg.endpoint).replace(/\/+$/, '')}/api/v2/transaction/${action}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  return {
    ok: res.ok && !!(json && json.success === true && typeof json.url === 'string'),
    httpStatus: res.status,
    url: (json && json.url) || null,
    errors: (json && json.errors) || null,
    raw: json
  };
}

// Format an epoch-ms instant as PixelPay's `expired_at` ("yyyy/mm/dd hh:mm") in Honduras time.
function formatPixelPayExpiry(msEpoch) {
  const HN_OFFSET_MS = -6 * 60 * 60 * 1000;
  const d = new Date(Number(msEpoch) + HN_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

module.exports = { createHostedCharge, toCents, formatPixelPayExpiry };
