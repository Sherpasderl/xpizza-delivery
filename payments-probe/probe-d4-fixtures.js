/**
 * D4 S0 — record the PixelPay SANDBOX envelopes the SDK adapter maps (PLAN-sdk-d4-r4 S0). OWNER-RUN (advisor 11-11): it carries
 * the existing gateway token, which no session ever holds.
 *   - PUBLIC sandbox only: https://pixelpay.dev with its documented public test credentials (hard host assert on every call).
 *   - The gateway token is read ONLY from env PIXELPAY_GW_ACCESS_TOKEN and sent as `x-gw-access-token` on EVERY call (the SDK
 *     tokenization included). It is never printed, logged or written; neither is any header, hash or raw response.
 *   - Responses are REDACTED IN PROCESS before anything touches disk (identifiers, tokens, hashes, names, emails, card fields →
 *     fixed placeholders; shapes, keys, statuses, messages, transaction types and amounts kept).
 *   - ONE call per case, no retries. Any Cloudflare / bot challenge (403, cf-mitigated) stops EVERYTHING; one line is printed:
 *     «CHALLENGED with token at <step>».
 * Usage: node probe-d4-fixtures.js <outDir>      (prints only «<step>: HTTP <status>» lines)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PixelPay = require('@pixelpay/sdk-core');

const ENDPOINT = 'https://pixelpay.dev';
const HOST = 'pixelpay.dev';
const KEY = '1234567890';
const SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const HASH = crypto.createHash('md5').update(SECRET).digest('hex');
const APP_URL = ENDPOINT;
const GW = process.env.PIXELPAY_GW_ACCESS_TOKEN || '';
const outDir = process.argv[2];
if (!outDir) { console.error('usage: node probe-d4-fixtures.js <outDir>'); process.exit(2); }
if (!GW) { console.error('PIXELPAY_GW_ACCESS_TOKEN is not set — nothing was called'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const sig = (fields) => crypto.createHmac('sha3-512', SECRET).update(fields.map(String).join('|')).digest('hex');
const ref = (tag) => `sdkprobe${tag}${Date.now().toString(36)}`.slice(0, 29);
let challenged = false;

// ── redaction: the SHARED schema allowlist (Codex S0/S1 r2) — the same redactor the committed fixtures pass through ───────
const { redact } = require('../xpizza-functions/payments/sdk/fixtures/redact-pixelpay');
const write = (name, rec) => fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ provenance: { recorded: new Date().toISOString().slice(0, 10), host: HOST, sdk: '@pixelpay/sdk-core 2.5.2', gateway_token: 'sent (value not recorded)' }, ...rec }, null, 1));
const stop = (step) => { if (!challenged) { challenged = true; console.log(`CHALLENGED with token at ${step}`); } };

async function call(name, apiPath, body, sigFields, extraHeaders = {}) {
  if (challenged) return null;
  const url = new URL(`${ENDPOINT}/${apiPath}`);
  if (url.host !== HOST || url.protocol !== 'https:') throw new Error('host assert failed');
  const headers = { 'x-auth-key': KEY, 'x-auth-hash': HASH, 'x-gw-access-token': GW, 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders };
  if (sigFields) headers['x-client-signature'] = sig(sigFields);
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 15000);
  let status = null, text = '', cf = null;
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    status = r.status; cf = r.headers.get('cf-mitigated'); text = await r.text();
  } catch (_) { text = ''; status = 'transport_error'; } finally { clearTimeout(timer); }
  if (status === 403 || cf) { stop(name); return null; }
  let json = null; try { json = JSON.parse(text); } catch (_) { json = null; }
  write(name, { name, path: apiPath, request_body_keys: Object.keys(body).sort(), http_status: status, json: json != null, response: json != null ? redact(json) : '<non-json body>' });
  console.log(`${name}: HTTP ${status}`);
  return { status, json };
}

async function tokenize(name, number, cvv) {
  if (challenged) return null;
  const settings = new PixelPay.Models.Settings(); settings.setupSandbox();
  if (new URL(settings.endpoint).host !== HOST) throw new Error('host assert failed');
  settings.setupHeaders({ 'x-gw-access-token': GW });
  const svc = new PixelPay.Services.Tokenization(settings);
  const c = new PixelPay.Requests.CardTokenization();
  Object.assign(c, { number, cvv2: cvv, expire_month: '12', expire_year: '2028', cardholder: 'Prueba Sherpa', address: 'Col. Prueba 123', country: 'HN', state: 'HN-CR', city: 'San Pedro Sula', zip: '21101', phone: '50400000000', email: 'cliente.prueba@gmail.com' });
  let res = null; try { res = await svc.vaultCard(c); } catch (_) { res = null; }
  if (!res) { console.log(`${name}: tokenization failed (no token)`); return null; }   // advisor nit: a failure is not a challenge
  if (res.status === 403) { stop(name); return null; }
  const token = res.data && res.data.token;
  write(name, { name, sdk: 'Tokenization.vaultCard', http_status: res.status, response: redact({ success: res.success, message: res.message, data: res.data }) });
  console.log(`${name}: HTTP ${res.status}`);
  return token || null;
}

const authBody = (r, token, amount, extra = {}) => ({ card_token: token, order_id: r, order_currency: 'HNL', order_amount: amount, customer_name: 'Prueba Sherpa', customer_email: 'cliente.prueba@gmail.com', env: 'sandbox', ...extra });
const uuidOf = (x) => (x && x.json && x.json.data && x.json.data.payment_uuid) || null;

(async () => {
  const tok = await tokenize('t01-tokenize-visa', '4111111111111111', '300');
  if (!tok) { if (!challenged) console.log('t01: no token — stopping'); process.exit(challenged ? 3 : 1); }
  const r1 = ref('a');
  const a1 = await call('auth-approved', 'api/v2/transaction/auth', authBody(r1, tok, '1.00'), [KEY, r1, APP_URL]);
  const u1 = uuidOf(a1);
  if (u1) {
    await call('status-authorized', 'api/v2/transaction/status', { payment_uuid: u1, env: 'sandbox' }, [KEY, u1, APP_URL]);
    await call('capture', 'api/v2/transaction/capture', { payment_uuid: u1, transaction_approved_amount: '1.00', env: 'sandbox' }, [KEY, '1.00', u1, APP_URL]);
    await call('status-captured', 'api/v2/transaction/status', { payment_uuid: u1, env: 'sandbox' }, [KEY, u1, APP_URL]);
  }
  const r2 = ref('v');
  const u2 = uuidOf(await call('auth-for-void', 'api/v2/transaction/auth', authBody(r2, tok, '1.00'), [KEY, r2, APP_URL]));
  if (u2) {
    await call('void', 'api/v2/transaction/void', { payment_uuid: u2, void_reason: 'sherpa_cancel_hold', env: 'sandbox' }, null);
    await call('status-voided', 'api/v2/transaction/status', { payment_uuid: u2, env: 'sandbox' }, [KEY, u2, APP_URL]);
  }
  const r3 = ref('d');
  await call('auth-declined', 'api/v2/transaction/auth', authBody(r3, tok, '2.00'), [KEY, r3, APP_URL]);
  const r4 = ref('x');
  const u4 = uuidOf(await call('auth-for-overcapture', 'api/v2/transaction/auth', authBody(r4, tok, '1.00'), [KEY, r4, APP_URL]));
  if (u4) await call('capture-over-auth', 'api/v2/transaction/capture', { payment_uuid: u4, transaction_approved_amount: '2.00', env: 'sandbox' }, [KEY, '2.00', u4, APP_URL]);
  const tok3 = await tokenize('t02-tokenize-3ds', '4000000000001000', '300');
  if (tok3) {
    const r5 = ref('t');
    await call('auth-3ds-pan-server', 'api/v2/transaction/auth', authBody(r5, tok3, '1.00'), [KEY, r5, APP_URL]);
    const r6 = ref('c');
    await call('auth-challenge', 'api/v2/transaction/auth', authBody(r6, tok3, '1.00', { authentication_request: true }), [KEY, r6, APP_URL]);
  }
  const r7 = ('sdk' + Date.now().toString(36) + 'a'.repeat(26)).slice(0, 29);
  await call('auth-ref29', 'api/v2/transaction/auth', authBody(r7, tok, '1.00'), [KEY, r7, APP_URL]);
  const r8 = ('sdk' + Date.now().toString(36)).padEnd(64, 'b');
  await call('auth-ref64', 'api/v2/transaction/auth', authBody(r8, tok, '1.00'), [KEY, r8, APP_URL]);
  if (u1) await call('auth-duplicate-ref', 'api/v2/transaction/auth', authBody(r1, tok, '1.00'), [KEY, r1, APP_URL]);
  await call('status-unknown-uuid', 'api/v2/transaction/status', { payment_uuid: 'P-00000000-0000-0000-0000-000000000000', env: 'sandbox' }, [KEY, 'P-0', APP_URL]);
  await call('status-by-order-id', 'api/v2/transaction/status', { order_id: r1, env: 'sandbox' }, null);
  process.exit(challenged ? 3 : 0);
})().catch(() => { console.log('probe failed (details withheld: they could carry request data)'); process.exit(1); });
