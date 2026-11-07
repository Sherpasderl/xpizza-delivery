'use strict';
// WhatsApp gateway health (OWNER-approved 2026-10-22). UltraMsg QUEUES a send and answers "accepted" even while the linked device
// is UNLINKED, so a disconnected gateway fails silently (sends "succeed", nothing is delivered). Every 30 min this asks each
// configured UltraMsg instance for its status and, when it is unlinked, logs ONE severity=ERROR line naming the restaurant(s) —
// the existing Cloud Functions error alert (any severity>=ERROR) emails the owner. index.js re-exports it in its single
// /* wahealth:begin */ … /* wahealth:end */ block (tools/wahealth-inverse.js).
//   · Brands come from data: the restaurant registry's known ids through whatsapp.js resolveWhatsappConfig — no brand literal here.
//     Ids that resolve to the SAME instance are checked once (one HTTP call per instance per run) and named together.
//   · Verdict: authenticated → silent; qr / disconnected (or substatus disconnected / logged out) → ERROR; any other state
//     (initialize, loading, retrying, standby, …) → WARNING. A failed status call (timeout, network, non-2xx, redirect, bad or
//     unknown JSON) is a WARNING — never reported as "disconnected".
//   · /config/whatsapp_enabled === false (sends deliberately off) → still checked, but an unlinked instance is a WARNING. That read
//     is bounded (CONFIG_TIMEOUT_MS); on expiry the check proceeds as enabled and logs a WARNING config_timeout.
//   · Logs ONLY allowlisted status labels and fixed failure codes (codex r1 P1) — never an upstream string, an exception message,
//     the token or the request URL (the token rides in its query string). No state, no dedupe.
//   · ONE deadline per status call covers the request AND the body read; redirects are refused, not followed (codex r1 P2).
const { onSchedule } = require('firebase-functions/v2/scheduler');

const TIMEOUT_MS = 8000;
const CONFIG_TIMEOUT_MS = 3000;
const ERROR_STATES = new Set(['qr', 'disconnected']);
const ERROR_SUBSTATES = new Set(['disconnected', 'logged out']);

// The instance id is the last path segment of the resolver's apiBase (https://api.ultramsg.com/{instance}).
const instanceOf = (apiBase) => String(apiBase).replace(/\/+$/, '').split('/').pop();

// Defensive read of {"status":{"accountStatus":{"status":"authenticated","substatus":"connected"}}} → { state, sub } | null.
function readAccountStatus(body) {
  const outer = body && typeof body === 'object' ? body.status : null;
  const acct = outer && typeof outer === 'object' ? outer.accountStatus : null;
  const state = acct && typeof acct === 'object' ? acct.status : null;
  if (typeof state !== 'string' || !state.trim()) return null;
  const sub = typeof acct.substatus === 'string' ? acct.substatus.trim().toLowerCase() : null;
  return { state: state.trim().toLowerCase(), sub };
}

function classify(st) {
  if (!st) return 'unknown';
  if (ERROR_STATES.has(st.state) || (st.sub && ERROR_SUBSTATES.has(st.sub))) return 'down';
  if (st.state === 'authenticated') return 'ok';
  return 'transient';
}

// The ONLY status text that is ever logged: a fixed label, never the upstream string.
function labelOf(st) {
  if (!st) return 'unrecognised';
  if (ERROR_STATES.has(st.state)) return st.state;
  if (st.sub === 'logged out') return 'logged_out';
  if (st.sub === 'disconnected') return 'disconnected';
  if (st.state === 'authenticated') return 'authenticated';
  return 'transient';
}

// A fixed failure code for a thrown error — never its message (node-fetch's carries the URL, so the token).
const DEADLINE = Symbol('deadline');
function failureCode(e) {
  if (e === DEADLINE || (e && (e.name === 'AbortError' || e.type === 'request-timeout' || e.type === 'body-timeout'))) return 'timeout';
  if (e && e.name === 'SyntaxError') return 'bad_json';
  if (e && e.type === 'invalid-json') return 'bad_json';
  return 'network';
}
const httpCode = (s) => (Number.isInteger(s) && s >= 100 && s <= 599 ? `http_${s}` : 'http_unknown');

// work(signal) raced against ONE timer (cleared on every path); on expiry the signal is aborted and DEADLINE is thrown.
async function withDeadline(work, ms) {
  const ac = new AbortController();
  let timer = null;
  const expiry = new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(DEADLINE); }, ms); });
  const p = Promise.resolve().then(() => work(ac.signal));
  p.catch(() => {});   // a rejection landing AFTER the deadline is swallowed silently (codex r2)
  try { return await Promise.race([p, expiry]); } finally { clearTimeout(timer); }
}

// rids: iterable of restaurant ids; resolve(rid) → { apiBase, token } | null; fetchImpl: node-fetch compatible.
async function checkInstances({ rids, resolve, fetchImpl, enabled = true, timeoutMs = TIMEOUT_MS, log }) {
  const byInstance = new Map();
  for (const rid of rids) {
    let cfg = null;
    try { cfg = resolve(rid); } catch (_) { cfg = null; }
    if (!cfg || !cfg.apiBase || !cfg.token) continue;          // not configured for this restaurant → nothing to check
    const g = byInstance.get(cfg.apiBase) || { apiBase: cfg.apiBase, token: cfg.token, rids: [] };
    g.rids.push(rid);
    byInstance.set(cfg.apiBase, g);
  }
  return Promise.all([...byInstance.values()].map(async (g) => {
    const instance = instanceOf(g.apiBase);
    const who = { rids: g.rids.join(','), instance };
    const failed = (code) => { log.warn(`whatsapp-health: status check failed rid=${who.rids} instance=${instance} reason=${code}`, { ...who, reason: code }); return { ...who, verdict: 'check_failed', reason: code }; };
    let got;
    try {
      got = await withDeadline(async (signal) => {
        const res = await fetchImpl(`${g.apiBase}/instance/status?token=${encodeURIComponent(g.token)}`, { method: 'GET', redirect: 'manual', timeout: timeoutMs, signal });
        if (!res) return { code: 'network' };
        if (res.status >= 300 && res.status < 400) return { code: 'redirect' };
        if (!res.ok) return { code: httpCode(res.status) };
        return { body: await res.json() };
      }, timeoutMs);
    } catch (e) {
      return failed(failureCode(e));
    }
    if (got.code) return failed(got.code);
    const st = readAccountStatus(got.body);
    const verdict = classify(st);
    const label = labelOf(st);
    if (verdict === 'down') {
      const line = `whatsapp-health: DISCONNECTED rid=${who.rids} instance=${instance} status=${label} — re-link the device (QR) in UltraMsg`;
      if (enabled) log.error(line, { ...who, status: label }); else log.warn(`${line} (whatsapp_enabled=false)`, { ...who, status: label });
    } else if (verdict === 'transient') {
      log.warn(`whatsapp-health: not ready rid=${who.rids} instance=${instance} status=${label}`, { ...who, status: label });
    } else if (verdict === 'unknown') {
      log.warn(`whatsapp-health: unrecognised status response rid=${who.rids} instance=${instance} status=${label}`, { ...who, status: label });
    }
    return { ...who, verdict, status: label };
  }));
}

// /config/whatsapp_enabled read DIRECTLY (codex r2): whatsapp.isEnabled logs its raw error message, so it is not used here. This
// reader never logs — it returns the flag (absent → enabled, as isEnabled) or throws a FIXED code, which runHealth maps.
async function readEnabledFlag(db) {
  let v;
  try { v = (await db.ref('config/whatsapp_enabled').once('value')).val(); } catch (_) { throw new Error('config_error'); }
  return v !== false;
}

// One scheduled run. Every dependency is injected (the scheduler wrapper passes the real ones), so a test drives it end to end.
async function runHealth({ knownRids, readEnabled, resolve, fetchImpl, log, timeoutMs = TIMEOUT_MS, configTimeoutMs = CONFIG_TIMEOUT_MS }) {
  try {
    const rids = await knownRids();
    let enabled = true;   // enabled-unknown → treated as enabled: an unlinked gateway still pages
    try {
      enabled = (await withDeadline(() => readEnabled(), configTimeoutMs)) !== false;
    } catch (e) {
      log.warn(`whatsapp-health: whatsapp_enabled read failed reason=${e === DEADLINE ? 'config_timeout' : 'config_error'} (checking as enabled)`, { reason: e === DEADLINE ? 'config_timeout' : 'config_error' });
    }
    return await checkInstances({ rids, resolve, fetchImpl, enabled, timeoutMs, log });
  } catch (_) {
    log.warn('whatsapp-health: run failed reason=run_error', { reason: 'run_error' });
    return null;
  }
}

// The deployable function. deps are injected by index.js (the registry singleton lives there).
// registry: index.js's restaurantRegistry accessor — warmed (ready) HERE, then its known ids (index.js's own warm sites are the order
// handlers only; catalog/restaurant-registry.test.js pins that count).
function makeHealthFunction({ registry, getDb, configTimeoutMs = CONFIG_TIMEOUT_MS }) {
  const knownRids = async () => { const r = registry(); await r.ready(); return [...r.known()]; };
  return onSchedule(
    { schedule: 'every 30 minutes', region: 'us-central1', timeoutSeconds: 60, memory: '256MiB', maxInstances: 1, retryCount: 0 },
    async () => {
      const whatsapp = require('../whatsapp');
      await runHealth({ knownRids, readEnabled: () => readEnabledFlag(getDb()), resolve: (rid) => whatsapp.resolveWhatsappConfig(rid),
        fetchImpl: require('node-fetch'), log: require('firebase-functions/logger'), configTimeoutMs });
    });
}

module.exports = { checkInstances, runHealth, readEnabledFlag, readAccountStatus, classify, labelOf, failureCode, withDeadline, instanceOf, makeHealthFunction, TIMEOUT_MS, CONFIG_TIMEOUT_MS };
