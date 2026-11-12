/**
 * D4 S0 — the one-step OWNER re-run (advisor 11-12): STATUS evidence only. PUBLIC sandbox (https://pixelpay.dev, documented public
 * test credentials), the gateway token from env PIXELPAY_GW_ACCESS_TOKEN only (never printed / written), hard host assert.
 * The first run's uuids / references were redacted in process, so two of the three status questions need ONE fresh sandbox
 * authorization each to have something to query (amount 1, no money):
 *   1. status of an UNKNOWN uuid                    (no auth needed)
 *   2. status BY order_id (our reference)           (needs auth A: an approved L 1.00)
 *   3. status of a CHALLENGED, never-completed uuid  (needs auth B: the 3DS test card, which the bank challenges)
 * Calls, in order: tokenize visa, tokenize 3DS, auth A, auth B, 4 status reads. ONE call per case, no retries.
 * Every response is redacted IN PROCESS through the schema allowlist (xpizza-functions/payments/sdk/fixtures/redact-pixelpay.js).
 * A Cloudflare challenge (header cf-mitigated, or an HTML body) prints «CHALLENGED with token at <step>» and stops EVERYTHING;
 * a plain JSON 403 is recorded like any other response.
 * Usage: node probe-d4-status.js <outDir>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PixelPay = require('@pixelpay/sdk-core');
const { redact } = require('../xpizza-functions/payments/sdk/fixtures/redact-pixelpay');

const ENDPOINT = 'https://pixelpay.dev';
const HOST = 'pixelpay.dev';
const KEY = '1234567890';
const SECRET = '@s4ndb0x-abcd-1234-n1l4-p1x3l';
const HASH = crypto.createHash('md5').update(SECRET).digest('hex');
const GW = process.env.PIXELPAY_GW_ACCESS_TOKEN || '';
const outDir = process.argv[2];
if (!outDir) { console.error('usage: node probe-d4-status.js <outDir>'); process.exit(2); }
if (!GW) { console.error('PIXELPAY_GW_ACCESS_TOKEN is not set — nothing was called'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const sig = (fields) => crypto.createHmac('sha3-512', SECRET).update(fields.map(String).join('|')).digest('hex');
const ref = (tag) => `sdkstatus${tag}${Date.now().toString(36)}`.slice(0, 29);
let challenged = false;
const stop = (step) => { if (!challenged) { challenged = true; console.log(`CHALLENGED with token at ${step}`); } };
const write = (name, rec) => fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ provenance: { recorded: new Date().toISOString().slice(0, 10), host: HOST, sdk: '@pixelpay/sdk-core 2.5.2', gateway_token: 'sent (value not recorded)', redaction: 'schema allowlist' }, ...rec }, null, 1));

async function call(name, apiPath, body, sigFields) {
  if (challenged) return null;
  const url = new URL(`${ENDPOINT}/${apiPath}`);
  if (url.host !== HOST || url.protocol !== 'https:') throw new Error('host assert failed');
  const headers = { 'x-auth-key': KEY, 'x-auth-hash': HASH, 'x-gw-access-token': GW, 'Content-Type': 'application/json', Accept: 'application/json' };
  if (sigFields) headers['x-client-signature'] = sig(sigFields);
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 15000);
  let status = null, text = '', cf = null, ctype = '';
  try {
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    status = r.status; cf = r.headers.get('cf-mitigated'); ctype = r.headers.get('content-type') || ''; text = await r.text();
  } catch (_) { status = 'transport_error'; } finally { clearTimeout(timer); }
  if (cf || /text\/html/i.test(ctype) || /^\s*</.test(text)) { stop(name); return null; }   // a bot challenge — never a plain JSON 403
  let json = null; try { json = JSON.parse(text); } catch (_) { json = null; }
  write(name, { name, path: apiPath, request_body_keys: Object.keys(body).sort(), http_status: status, json: json != null, response: json != null ? redact(json) : '<non-json body>' });
  console.log(`${name}: HTTP ${status}`);
  return { status, json };
}
async function tokenize(name, number) {
  if (challenged) return null;
  const settings = new PixelPay.Models.Settings(); settings.setupSandbox();
  if (new URL(settings.endpoint).host !== HOST) throw new Error('host assert failed');
  settings.setupHeaders({ 'x-gw-access-token': GW });
  const c = new PixelPay.Requests.CardTokenization();
  Object.assign(c, { number, cvv2: '300', expire_month: '12', expire_year: '2028', cardholder: 'Prueba Sherpa', address: 'Col. Prueba 123', country: 'HN', state: 'HN-CR', city: 'San Pedro Sula', zip: '21101', phone: '50400000000', email: 'cliente.prueba@gmail.com' });
  let res = null; try { res = await new PixelPay.Services.Tokenization(settings).vaultCard(c); } catch (_) { res = null; }
  if (!res) { console.log(`${name}: tokenization failed (no token)`); return null; }
  if (res.status === 403) { stop(name); return null; }
  console.log(`${name}: HTTP ${res.status}`);
  return (res.data && res.data.token) || null;
}
const authBody = (r, token) => ({ card_token: token, order_id: r, order_currency: 'HNL', order_amount: '1.00', customer_name: 'Prueba Sherpa', customer_email: 'cliente.prueba@gmail.com', env: 'sandbox' });
const uuidOf = (x) => (x && x.json && x.json.data && x.json.data.payment_uuid) || null;

(async () => {
  await call('status-unknown-uuid', 'api/v2/transaction/status', { payment_uuid: 'P-00000000-0000-0000-0000-000000000000', env: 'sandbox' }, [KEY, 'P-00000000-0000-0000-0000-000000000000', ENDPOINT]);
  const tv = await tokenize('tokenize-visa', '4111111111111111');
  const t3 = await tokenize('tokenize-3ds', '4000000000001000');
  const rA = ref('a'); const rB = ref('c');
  const a = tv ? await call('auth-approved-for-status', 'api/v2/transaction/auth', authBody(rA, tv), [KEY, rA, ENDPOINT]) : null;
  const b = t3 ? await call('auth-challenged-for-status', 'api/v2/transaction/auth', authBody(rB, t3), [KEY, rB, ENDPOINT]) : null;
  if (a) await call('status-by-order-id', 'api/v2/transaction/status', { order_id: rA, env: 'sandbox' }, null);
  const uB = uuidOf(b);
  if (uB) await call('status-challenged-uuid', 'api/v2/transaction/status', { payment_uuid: uB, env: 'sandbox' }, [KEY, uB, ENDPOINT]);
  if (uB) await call('status-challenged-by-order-id', 'api/v2/transaction/status', { order_id: rB, env: 'sandbox' }, null);
  process.exit(challenged ? 3 : 0);
})().catch(() => { console.log('probe failed (details withheld: they could carry request data)'); process.exit(1); });
