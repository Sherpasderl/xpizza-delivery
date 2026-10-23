'use strict';
// WhatsApp gateway health (OWNER-approved 2026-10-22). UltraMsg QUEUES a send and answers "accepted" even while the linked device
// is UNLINKED, so a disconnected gateway fails silently (sends "succeed", nothing is delivered). Every 30 min this asks each
// configured UltraMsg instance for its status and, when it is unlinked, logs ONE severity=ERROR line naming the restaurant(s) —
// the existing Cloud Functions error alert (any severity>=ERROR) emails the owner. index.js re-exports it in its single
// /* wahealth:begin */ … /* wahealth:end */ block (tools/wahealth-inverse.js).
//   · Brands come from data: the restaurant registry's known ids through whatsapp.js resolveWhatsappConfig — no brand literal here.
//     Ids that resolve to the SAME instance are checked once (one HTTP call per instance per run) and named together.
//   · Verdict: authenticated → silent; qr / disconnected (or substatus disconnected / logged out) → ERROR; any other state
//     (initialize, loading, retrying, standby, …) → WARNING. A failed status call (timeout, network, non-2xx, bad or unknown
//     JSON) is a WARNING — never reported as "disconnected".
//   · /config/whatsapp_enabled === false (sends deliberately off) → still checked, but an unlinked instance is a WARNING.
//   · Never logs the token or the request URL (the token rides in its query string). No state, no dedupe.
const { onSchedule } = require('firebase-functions/v2/scheduler');

const TIMEOUT_MS = 8000;
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
  const results = await Promise.all([...byInstance.values()].map(async (g) => {
    const instance = instanceOf(g.apiBase);
    const who = { rids: g.rids.join(','), instance };
    let st = null;
    try {
      const res = await fetchImpl(`${g.apiBase}/instance/status?token=${encodeURIComponent(g.token)}`, { method: 'GET', timeout: timeoutMs });
      if (!res || !res.ok) {
        log.warn(`whatsapp-health: status check failed rid=${who.rids} instance=${instance} http=${res ? res.status : 'none'}`, who);
        return { ...who, verdict: 'check_failed' };
      }
      st = readAccountStatus(await res.json());
    } catch (e) {
      log.warn(`whatsapp-health: status check failed rid=${who.rids} instance=${instance} error=${(e && e.name) || 'Error'}`, who);
      return { ...who, verdict: 'check_failed' };
    }
    const verdict = classify(st);
    const shown = st ? `${st.state}${st.sub ? '/' + st.sub : ''}` : 'unreadable';
    if (verdict === 'down') {
      const line = `whatsapp-health: DISCONNECTED rid=${who.rids} instance=${instance} status=${shown} — re-link the device (QR) in UltraMsg`;
      if (enabled) log.error(line, who); else log.warn(`${line} (whatsapp_enabled=false)`, who);
    } else if (verdict === 'transient') {
      log.warn(`whatsapp-health: not ready rid=${who.rids} instance=${instance} status=${shown}`, who);
    } else if (verdict === 'unknown') {
      log.warn(`whatsapp-health: unrecognised status response rid=${who.rids} instance=${instance}`, who);
    }
    return { ...who, verdict };
  }));
  return results;
}

// The deployable function. deps are injected by index.js (the registry singleton lives there).
function makeHealthFunction({ knownRids, getDb }) {
  return onSchedule(
    { schedule: 'every 30 minutes', region: 'us-central1', timeoutSeconds: 60, memory: '256MiB', maxInstances: 1, retryCount: 0 },
    async () => {
      const logger = require('firebase-functions/logger');
      const whatsapp = require('../whatsapp');
      try {
        const rids = await knownRids();
        const enabled = await whatsapp.isEnabled(getDb());
        await checkInstances({ rids, resolve: (rid) => whatsapp.resolveWhatsappConfig(rid), fetchImpl: require('node-fetch'), enabled, log: logger });
      } catch (e) {
        logger.warn(`whatsapp-health: run failed ${(e && e.message) || e}`);
      }
    });
}

module.exports = { checkInstances, readAccountStatus, classify, instanceOf, makeHealthFunction, TIMEOUT_MS };
