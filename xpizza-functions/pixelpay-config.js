/**
 * X Pizza — PixelPay environment / credential resolver.
 *
 * `PIXELPAY_MODE` selects the credential set so the SAME code runs against the
 * sandbox during development and production at go-live:
 *
 *   - 'sandbox'    → built-in PUBLIC sandbox creds (pixelpay.dev). No real money.
 *                    These are documented by PixelPay ("Sandbox via API") and are
 *                    intentionally shared/public, so it's safe to hardcode them.
 *   - 'production' → reads PIXELPAY_ENDPOINT / KEY_ID / PUBLIC_KEY / SECRET /
 *                    MERCHANT_EMAIL from .env (server-only secrets).
 *
 * IMPORTANT — `auth_hash` (the x-auth-hash header) is a CONFIGURED credential we
 * use VERBATIM, never re-derived. PixelPay's derivation differs per environment
 * (sandbox = MD5(secret); production "Public key" = SHA-512(secret)), so deriving
 * it in code would silently break one of the two environments. Always use the
 * value the portal shows.
 */

// PixelPay's documented public sandbox. `x-auth-hash` here is MD5(secret); the
// sign secret is the published sandbox secret. Outcome is driven by order_amount
// (1 = success, 2 = declined, …, 14). See PAYMENT-PLAN.md "Sandbox".
const SANDBOX = Object.freeze({
  mode: 'sandbox',
  endpoint: 'https://pixelpay.dev',
  app_key: '1234567890',
  auth_hash: '36cdf8271723276cb6f94904f8bde4b6', // = MD5('@s4ndb0x-abcd-1234-n1l4-p1x3l')
  secret: '@s4ndb0x-abcd-1234-n1l4-p1x3l',       // published sandbox signing secret
  merchant_email: 'sandbox@pixelpay.dev',
  // The SDK puts `env` in the request BODY from settings.environment. setupSandbox() sets
  // it to "sandbox"; WITHOUT it the gateway treats the sandbox key as a prod key (400
  // "El valor KEY es inválido" — verified). Production (setupCredentials) leaves it unset.
  env: 'sandbox',
  // The PixelPay sandbox ONLY recognizes order_amount 1-14 (each maps to a test outcome:
  // 1=success, 2=declined, …). Real menu totals (L251+) return "test case N doesn't exist".
  // So in SANDBOX we charge a fixed small TEST amount through PixelPay (default 1=success;
  // override via PIXELPAY_SANDBOX_AMOUNT to test 2=declined etc.). The ORDER's real total
  // is untouched — only the PixelPay auth/capture amount is mapped. Production never does this.
  sandbox_amount: Math.min(14, Math.max(1, parseInt(process.env.PIXELPAY_SANDBOX_AMOUNT, 10) || 1))
});

/**
 * Resolve the active PixelPay credential set. Throws (caller → 500) if
 * production mode is selected but the .env config is incomplete — we must never
 * fall back to sandbox for a real charge, nor sign with a missing secret.
 */
function resolvePixelPayConfig() {
  const mode = String(process.env.PIXELPAY_MODE || 'sandbox').trim().toLowerCase();

  if (mode === 'production' || mode === 'prod' || mode === 'live') {
    const cfg = {
      mode: 'production',
      endpoint: process.env.PIXELPAY_ENDPOINT,
      app_key: process.env.PIXELPAY_KEY_ID,
      auth_hash: process.env.PIXELPAY_PUBLIC_KEY, // portal "Public key" = SHA-512(secret), used verbatim
      secret: process.env.PIXELPAY_SECRET,        // RAW secret (NOT the public key)
      merchant_email: process.env.PIXELPAY_MERCHANT_EMAIL,
      // Production omits `env` (the SDK leaves settings.environment unset under setupCredentials).
      // Override only if PixelPay's prod gateway turns out to require env:"live".
      env: process.env.PIXELPAY_ENV || undefined
    };
    const missing = Object.entries(cfg)
      .filter(([k, v]) => k !== 'env' && (v == null || v === ''))
      .map(([k]) => k);
    if (missing.length) {
      throw new Error(`PixelPay production config incomplete (missing: ${missing.join(', ')})`);
    }
    return cfg;
  }

  // Default: sandbox (safe — no real money).
  return { ...SANDBOX };
}

/**
 * The `app_url` field folded into the x-client-signature
 * (HMAC-SHA3-512(secret, app_key | pixelpay_order_id | app_url)). It must equal
 * the value PixelPay validates the signed sale against.
 *
 * VERIFY-IN-SANDBOX: this is the one signature input whose exact value PixelPay
 * expects is integration-specific — pin it against a sandbox sale before relying
 * on it. Configurable via PIXELPAY_APP_URL; defaults to the order-form origin.
 */
function pixelPayAppUrl() {
  return String(process.env.PIXELPAY_APP_URL || 'https://xpizzaorders.netlify.app')
    .trim()
    .replace(/\/+$/, '');
}

/**
 * The order_callback (webhook) URL the browser SDK attaches to the sale so
 * PixelPay nudges us out-of-band. The receiver (pixelPayWebhook) is Stage 4;
 * including the URL now is harmless. Configurable via PIXELPAY_CALLBACK_URL.
 */
function pixelPayCallbackUrl() {
  return String(
    process.env.PIXELPAY_CALLBACK_URL ||
    'https://us-central1-xpizza-delivery.cloudfunctions.net/pixelPayWebhook'
  ).trim();
}

/**
 * The lempira amount to charge through PixelPay for an order. PRODUCTION uses the
 * real total (centavos → lempiras). SANDBOX maps it to a fixed 1-14 test amount
 * (the sandbox rejects any other amount) — the order's real total is untouched.
 */
function pixelPayChargeAmountLempiras(cfg, totalCents) {
  if (cfg && cfg.mode === 'sandbox') return cfg.sandbox_amount;
  return Number((Number(totalCents) / 100).toFixed(2));
}

module.exports = { resolvePixelPayConfig, pixelPayAppUrl, pixelPayCallbackUrl, pixelPayChargeAmountLempiras };
