/**
 * Driver diagnostics sink — a NEW isolated function (ADD-ONLY, logging-only).
 *
 * Purpose: catch the accept-reassign incident — a swipe-accept whose RTDB write never
 * reached the server (see docs/superpowers/specs/2026-08-04-driver-accept-diagnostics-optionB.md).
 * The driver app POSTs small client-emitted event batches here; we admin-write them to
 * driver_events/{uid} for the owner to read via the Firebase console after a recurrence.
 *
 * NOTHING existing is modified. Deployed as its own function (scoped `--only`, zero collateral).
 * Dark by default — the CLIENT gates all of this on config/driver_diag_enabled; the server is
 * simply idle unless posted to.
 *
 * AUTH: the SAME per-shift opaque token as ingestDriverLocation, in the CUSTOM `x-driver-token`
 * header — NOT `Authorization: Bearer`, which Cloud Functions gen2 rejects at the infra layer
 * before it reaches us (see index.js:3084, the exact reason ingestDriverLocation uses this header).
 * Token → uid via the EXISTING ./driver-ingest validator, imported READ-ONLY (not modified).
 */

const { onRequest } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');
const { hashToken, validateIngestToken } = require('./driver-ingest');

const MAX_EVENTS = 50;                         // per request
const MAX_KEEP = 200;                          // retained events per uid
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;    // 7 days
const RATE_MAX = 120;                          // soft per-uid guard (mirror ingestDriverLocation)
const RATE_WINDOW_MS = 60 * 1000;
const MAX_STR = 500;                           // ctx string cap
const MAX_CTX_KEYS = 12;                       // ctx fanout cap
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const diagRate = new Map();

// ---------- pure helpers (unit-tested in driver-diag.test.js) ----------

// One event → a bounded, RTDB-safe plain object. Keeps `type`/`at` plus up to MAX_CTX_KEYS
// primitive ctx fields (strings capped, objects/arrays/nullish dropped, unsafe/illegal keys skipped).
function sanitizeEvent(e) {
  const out = { type: String(e.type).slice(0, 40), at: e.at };
  let n = 0;
  for (const k of Object.keys(e)) {
    if (k === 'type' || k === 'at') continue;
    if (UNSAFE_KEYS.has(k) || /[.#$/[\]]/.test(k)) continue;   // RTDB-illegal / prototype-pollution
    if (n >= MAX_CTX_KEYS) break;
    const val = e[k];
    const ty = typeof val;
    if (ty === 'string') { out[k] = val.slice(0, MAX_STR); n++; }
    else if (ty === 'number' && Number.isFinite(val)) { out[k] = val; n++; }
    else if (ty === 'boolean') { out[k] = val; n++; }
    // objects/arrays/null/undefined intentionally dropped (bounded, no nesting)
  }
  return out;
}

// { events:[...] } → { ok, events:[sanitized...] }. ok:false for a non-{events:array} body
// (the handler 400s). Drops malformed events (no string type / non-finite at), caps to maxEvents.
function validateDiagEvents(body, maxEvents = MAX_EVENTS) {
  const raw = Array.isArray(body && body.events) ? body.events : null;
  if (!raw) return { ok: false };
  const events = raw
    .filter((e) => e && typeof e === 'object'
      && typeof e.type === 'string' && e.type.length > 0
      && Number.isFinite(e.at))
    .slice(0, maxEvents)
    .map(sanitizeEvent);
  return { ok: true, events };
}

// existing = { pushId: {at, ...} } → array of pushIds to delete: anything older than maxAgeMs,
// plus anything beyond the newest maxKeep (by `at`). Pure; bounds per-uid growth.
function computeDiagPrune(existing, { now, maxKeep = MAX_KEEP, maxAgeMs = MAX_AGE_MS } = {}) {
  const entries = Object.entries(existing || {})
    .map(([k, v]) => ({ k, at: (v && Number.isFinite(v.at)) ? v.at : 0 }))
    .sort((a, b) => a.at - b.at);   // oldest first
  const del = new Set();
  for (const e of entries) if (e.at < now - maxAgeMs) del.add(e.k);
  const overflow = entries.length - maxKeep;
  for (let i = 0; i < overflow; i++) del.add(entries[i].k);
  return [...del];
}

// ---------- the handler (thin; all side effects here) ----------

const driverDiagIngest = onRequest({ region: 'us-central1' }, async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    // Same opaque per-shift token as ingestDriverLocation, in the x-driver-token header.
    const raw = (req.get('x-driver-token') || '').trim();
    if (!raw) return res.status(401).json({ error: 'missing token' });

    const db = getDatabase();
    const tokenRec = (await db.ref(`driver_tokens/${hashToken(raw)}`).once('value')).val();
    if (!tokenRec) return res.status(401).json({ error: 'invalid token' });
    const uid = tokenRec.uid;

    // Soft per-uid rate guard (mirror ingestDriverLocation; per-instance best-effort).
    const nowMs = Date.now();
    const rl = diagRate.get(uid);
    if (!rl || nowMs - rl.windowStart > RATE_WINDOW_MS) diagRate.set(uid, { count: 1, windowStart: nowMs });
    else if (rl.count >= RATE_MAX) return res.status(429).json({ error: 'rate_limited' });
    else rl.count++;

    // Validate the token the SAME way (TTL + shift-binding), read-only.
    const driver = (await db.ref(`drivers/${uid}`).once('value')).val() || {};
    const v = validateIngestToken(tokenRec, { now: nowMs, currentShiftId: driver.current_shift_id });
    if (!v.ok) return res.status(401).json({ error: v.reason });

    const parsed = validateDiagEvents(req.body, MAX_EVENTS);
    if (!parsed.ok) return res.status(400).json({ error: 'bad payload' });

    const base = db.ref(`driver_events/${uid}`);
    await Promise.all(parsed.events.map((e) => base.push(e)));

    // Inline prune (bounded growth).
    const existing = (await base.once('value')).val() || {};
    const toDelete = computeDiagPrune(existing, { now: nowMs });
    if (toDelete.length) {
      const upd = {};
      for (const k of toDelete) upd[k] = null;
      await base.update(upd);
    }

    return res.status(200).json({ ok: true, accepted: parsed.events.length, pruned: toDelete.length });
  } catch (e) {
    // Add-only + fail-safe: a bad payload / transient error never affects anything else.
    return res.status(400).json({ error: 'bad request' });
  }
});

module.exports = { driverDiagIngest, validateDiagEvents, computeDiagPrune };
