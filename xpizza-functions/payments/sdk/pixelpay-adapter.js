'use strict';
// The REAL PixelPay impl behind the SDK adapter contract (PLAN-sdk-d4-r4 S0). makeAdapter (psp-adapter.js) wraps it: a throw,
// a timeout or a malformed answer is `unknown` / `inconclusive` there. This module adds the wire calls and an EVIDENCE-FIRST
// mapping: an outcome other than unknown / inconclusive comes only from the spec'd success shape or from an envelope recorded
// in the PixelPay sandbox (EVIDENCE below, filled from payments/sdk/fixtures/pixelpay). HTTP status alone never decides.
// Config: ONE secret (SDK_PP_CONFIG, payments/sdk/secrets.js), parsed strictly; the hosted checkout's env config is never read.
// Only the pure crypto of pixelpay.js is shared. Logging: one allowlisted diagnostic per call — never a token, card field,
// customer field, header, signature or body.
const PP = require('../../pixelpay');

const DEADLINE_MS = 15000;
const MODES = Object.freeze(['sandbox', 'production']);
const NAMESPACES = Object.freeze(['prod', 'staging', 'sandbox']);
const CONFIG_KEYS = Object.freeze(['mode', 'namespace', 'endpoint', 'app_url', 'key_id', 'auth_hash', 'secret', 'merchant_email', 'gw_token']);
const VOID_REASON = 'sherpa_cancel_hold';

// Recorded sandbox evidence. EMPTY until the fixtures exist: every 202 / 402 / non-success envelope is then `unknown`, and every
// status read `inconclusive` (it can only lock, never decide). Each entry is added from a recorded, redacted fixture.
const EVIDENCE = Object.freeze({
  challenge: Object.freeze([]),       // (status, json) → true for a recorded 3DS challenge envelope
  decline: Object.freeze([]),         // (status, json) → { code } for a recorded definitive decline
  captureDecline: Object.freeze([]),
  voidRefused: Object.freeze([]),
  status: null,                       // (json) → { state, uuid, amount } from a recorded status envelope, or null
});

const isStr = (v) => typeof v === 'string' && v.length > 0;
function parseConfig(raw) {
  let c; try { c = JSON.parse(String(raw || '')); } catch (_) { return null; }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const keys = Object.keys(c);
  if (keys.length !== CONFIG_KEYS.length || !CONFIG_KEYS.every((k) => keys.includes(k))) return null;
  if (!MODES.includes(c.mode) || !NAMESPACES.includes(c.namespace)) return null;
  for (const k of ['endpoint', 'app_url', 'key_id', 'auth_hash', 'secret', 'merchant_email']) if (!isStr(c[k])) return null;
  if (c.gw_token !== null && !isStr(c.gw_token)) return null;
  let u; try { u = new URL(c.endpoint); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;
  return Object.freeze({ ...c, endpoint: c.endpoint.replace(/\/+$/, '') });
}

// integer cents ⇄ the provider's 2-decimal lempira STRING (strict both ways)
const toLempiras = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
function parseLempiras(v) {
  if (typeof v !== 'string' || !/^\d+\.\d{2}$/.test(v) || /^0\d/.test(v)) return null;
  const [w, f] = v.split('.');
  return Number(w) * 100 + Number(f);
}

function makePixelPayImpl(cfg, { fetchImpl = fetch, deadlineMs = DEADLINE_MS, log = console } = {}) {
  const sandbox = cfg.mode === 'sandbox';
  const diag = (call, http_status, outcome, code, op_id) => { try { log.info(`sdkpp ${JSON.stringify({ call, http_status, outcome, code: code || null, op_id: op_id || null })}`); } catch (_) { /* logging never decides */ } };

  // ONE deadline over connect + response + the FULL body read; a failure of any kind resolves to { status: null }
  async function post(action, body, sigFields, extra = {}) {
    const headers = { 'x-auth-key': cfg.key_id, 'x-auth-hash': cfg.auth_hash, 'Content-Type': 'application/json', Accept: 'application/json', ...extra };
    if (cfg.gw_token) headers['x-gw-access-token'] = cfg.gw_token;
    if (sigFields) headers['x-client-signature'] = PP.clientSignature(cfg.secret, sigFields);
    const payload = sandbox ? { ...body, env: 'sandbox' } : body;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deadlineMs);
    try {
      const r = await fetchImpl(`${cfg.endpoint}/api/v2/transaction/${action}`, { method: 'POST', headers, body: JSON.stringify(payload), signal: ac.signal });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch (_) { json = null; }
      return { status: r.status, json };
    } catch (_) { return { status: null, json: null }; } finally { clearTimeout(timer); }
  }
  const data = (j) => (j && typeof j.data === 'object' && j.data !== null && !Array.isArray(j.data) ? j.data : null);
  const match = (list, status, json) => { for (const f of list) { const m = f(status, json); if (m) return m; } return null; };

  return {
    async pspAuthorize({ token, amount_cents, op_id, ref, authentication_identifier, payer }) {
      const amount = toLempiras(amount_cents);
      const body = { card_token: token, order_id: ref, order_currency: 'HNL', order_amount: amount, customer_name: payer && payer.name };
      if (payer && isStr(payer.email)) body.customer_email = payer.email;   // an order without an email sends none (never a made-up one)
      if (isStr(authentication_identifier)) body.authentication_identifier = authentication_identifier;
      const { status, json } = await post('auth', body, [cfg.key_id, ref, cfg.app_url]);
      let out = { outcome: 'unknown' };
      const d = data(json);
      if (status === 200 && json && json.success === true && d && isStr(d.payment_uuid) && (d.response_approved === undefined || d.response_approved === true)) {
        const cents = parseLempiras(d.transaction_approved_amount);
        if (cents === amount_cents) out = { outcome: 'approved', uuid: d.payment_uuid, amount_cents: cents };
      } else if (match(EVIDENCE.challenge, status, json)) out = { outcome: 'requires_action', uuid: d && isStr(d.payment_uuid) ? d.payment_uuid : undefined };
      else { const m = match(EVIDENCE.decline, status, json); if (m) out = { outcome: 'definitive_decline', code: m.code || null }; }
      diag('auth', status, out.outcome, out.code, op_id);
      return out;
    },
    async pspCapture({ uuid, amount_cents, op_id }) {
      const amount = toLempiras(amount_cents);
      const { status, json } = await post('capture', { payment_uuid: uuid, transaction_approved_amount: amount }, [cfg.key_id, amount, uuid, cfg.app_url]);
      let out = { outcome: 'unknown' };
      const d = data(json);
      if (status === 200 && json && json.success === true && d && d.payment_uuid === uuid && parseLempiras(d.transaction_approved_amount) === amount_cents) out = { outcome: 'captured', uuid, amount_cents };
      else { const m = match(EVIDENCE.captureDecline, status, json); if (m) out = { outcome: 'declined', code: m.code || null }; }
      diag('capture', status, out.outcome, out.code, op_id);
      return out;
    },
    async pspVoid({ uuid, op_id, ref }) {
      let out = { outcome: 'unknown' };
      let status = null;
      if (sandbox || isStr(ref)) {
        const body = { payment_uuid: uuid, void_reason: VOID_REASON };
        const extra = {};
        if (!sandbox) { body.void_signature = PP.voidSignature(cfg.merchant_email, ref, cfg.secret); extra['x-auth-user'] = PP.platformUser(cfg.merchant_email); }
        const res = await post('void', body, null, extra);
        status = res.status;
        const d = data(res.json);
        if (status === 200 && res.json && res.json.success === true && d && d.payment_uuid === uuid) out = { outcome: 'voided', uuid };
        else if (match(EVIDENCE.voidRefused, status, res.json)) out = { outcome: 'refused', uuid };
      }
      diag('void', status, out.outcome, null, op_id);
      return out;
    },
    async pspStatus({ uuid }) {
      const { status, json } = await post('status', { payment_uuid: uuid }, [cfg.key_id, uuid, cfg.app_url]);
      let out = { state: 'inconclusive', uuid };
      const ev = status === 200 && EVIDENCE.status ? EVIDENCE.status(json) : null;
      if (ev && ev.uuid === uuid) { const cents = parseLempiras(ev.amount); if (cents != null) out = { state: ev.state, uuid, amount_cents: cents }; }
      diag('status', status, out.state, null, null);
      return out;
    },
  };
}

module.exports = { parseConfig, makePixelPayImpl, toLempiras, parseLempiras, EVIDENCE, DEADLINE_MS, CONFIG_KEYS, VOID_REASON };
