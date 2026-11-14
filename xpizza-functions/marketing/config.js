'use strict';
// PLAN-3a-marketing-server r0 §2.6 / §5 (advisor APPROVED 2026-11-14) — platform_config/marketing: the three server-stated switches
// and the Sherpa-set Anuncio price + thresholds. ONE reader, FAIL-CLOSED: a missing, malformed or unreadable node means every
// switch OFF (never a guessed «on»). Sherpa-set data (owner 4673): merchants read it through the portal read, never write it.
//   { policy_version ≥ 1, offers_enabled, anuncio_enabled, collections_enabled, anuncio_price_cents, thresholds: { rating_min,
//     min_ratings }, history[≤ 10], updated_at, updated_by }
// The ONE writer is writeMarketingConfig (version CAS, the pricing-admin pattern), run by the owner's CLI
// (tools/marketing-config-admin.js) — a Sherpa-admin portal editor waits for its mockup (r1 §5.7).

const PATH = 'platform_config/marketing';
const EXIT_MARKER = 'platform_config/pending_sweep_exit';   // written by the owner after the pending-sweep exit deploy (the go-live gate)
const HISTORY_MAX = 10;
const SWITCHES = Object.freeze(['offers_enabled', 'anuncio_enabled', 'collections_enabled']);
const OFF = Object.freeze({ policy_version: 0, offers_enabled: false, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: null, thresholds: null });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;
const exactKeys = (o, req, opt = []) => isObj(o) && req.every((k) => k in o) && Object.keys(o).every((k) => req.includes(k) || opt.includes(k));

// the settable fields (the CLI's --set JSON, and each history entry's `new`)
function settableOf(c) {
  if (!exactKeys(c, [...SWITCHES, 'anuncio_price_cents', 'thresholds'])) return null;
  if (!SWITCHES.every((k) => typeof c[k] === 'boolean')) return null;
  if (!isInt(c.anuncio_price_cents, 100, 10_000_000)) return null;
  const t = c.thresholds;
  if (!exactKeys(t, ['rating_min', 'min_ratings'], ['paused_max_h_30d']) || typeof t.rating_min !== 'number' || !(t.rating_min >= 1 && t.rating_min <= 5) || !isInt(t.min_ratings, 1, 1000)) return null;
  if ('paused_max_h_30d' in t && !(typeof t.paused_max_h_30d === 'number' && t.paused_max_h_30d >= 0 && t.paused_max_h_30d <= 720)) return null;
  // paused_max_h_30d (advisor 11-14, «not paused-heavy»): paused-while-open hours over the last 30 HN days; default 4 (the merit bar)
  return { offers_enabled: c.offers_enabled, anuncio_enabled: c.anuncio_enabled, collections_enabled: c.collections_enabled,
    anuncio_price_cents: c.anuncio_price_cents, thresholds: { rating_min: t.rating_min, min_ratings: t.min_ratings, paused_max_h_30d: 'paused_max_h_30d' in t ? t.paused_max_h_30d : 4 } };
}

// a STORED node → the effective config; anything off-shape → OFF (a malformed node never enables a switch)
function parseConfig(v) {
  if (!isObj(v) || !isInt(v.policy_version, 1, 1e15)) return { ...OFF };
  const pick = {};
  for (const k of [...SWITCHES, 'anuncio_price_cents', 'thresholds']) pick[k] = v[k];
  const s = settableOf(pick);
  return s ? { policy_version: v.policy_version, ...s } : { ...OFF };
}

// → the effective config; `unavailable: true` when the read itself failed (callers: a read states OFF, a write answers 503)
async function readMarketingConfig(db) {
  let v;
  try { v = (await db.ref(PATH).once('value')).val(); } catch (_) { return { ...OFF, unavailable: true }; }
  return parseConfig(v);
}

// The owner's write: ONE transaction with the caller's `expected` version (0 = create). → { ok, policy_version } |
// { ok:false, code: 'superseded'|'current_malformed'|'bad_config'|'unavailable', current? }. dryRun reads and validates only.
async function writeMarketingConfig(db, { expected, config, actor, now, dryRun = false }) {
  const next = settableOf(config);
  if (!next) return { ok: false, code: 'bad_config' };
  if (!isInt(expected, 0, 1e15 - 2) || typeof actor !== 'string' || !actor) return { ok: false, code: 'bad_config' };
  /* GO-LIVE GATE (PLAN-5f-pending-sweep r1 §4, advisor 11-14): offers may be switched ON only once the owner has recorded that the
     pending-sweep exit is deployed (platform_config/pending_sweep_exit = { at, by }) — the price path's offer_changed refusals retire
     hosted attempts down the path that used to orphan pending orders. Switching off is never gated; an unreadable marker fails closed. */
  if (next.offers_enabled === true) {
    let m;
    try { m = (await db.ref(EXIT_MARKER).once('value')).val(); } catch (_) { return { ok: false, code: 'unavailable' }; }
    if (!isObj(m) || !Number.isSafeInteger(m.at) || m.at <= 0 || typeof m.by !== 'string' || !m.by) return { ok: false, code: 'pending_sweep_exit_required' };
  }
  if (dryRun) {
    let cur;
    try { cur = (await db.ref(PATH).once('value')).val(); } catch (_) { return { ok: false, code: 'unavailable' }; }
    const pv = isObj(cur) ? cur.policy_version : 0;
    if ((cur === null ? 0 : pv) !== expected) return { ok: false, code: 'superseded', current: cur === null ? 0 : pv };
    return { ok: true, dry_run: true, policy_version: expected + 1, next };
  }
  let last = null;
  let tx;
  try {
    tx = await db.ref(PATH).transaction((cur) => {
      const d = { why: null, current: null };
      last = d;
      if (cur === null) {   // the speculative null-first pass: a non-zero expectation re-runs against the server's node
        if (expected !== 0) { d.why = 'stale_null'; return null; }
        d.why = 'write';
        return nodeOf(0, []);
      }
      if (!isObj(cur) || !isInt(cur.policy_version, 1, 1e15)) { d.why = 'current_malformed'; return undefined; }
      if (cur.policy_version !== expected) { d.why = 'superseded'; d.current = cur.policy_version; return undefined; }
      d.why = 'write';
      return nodeOf(cur.policy_version, Array.isArray(cur.history) ? cur.history.filter(isObj) : []);
    });
  } catch (_) {
    return { ok: false, code: 'unavailable' };
  }
  function nodeOf(prev, kept) {
    const entry = { actor, prev_version: prev, new_version: prev + 1, new: next, at: now };
    return { policy_version: prev + 1, ...next, history: [entry, ...kept].slice(0, HISTORY_MAX), updated_at: now, updated_by: actor };
  }
  const why = last && last.why;
  if (why === 'superseded') return { ok: false, code: 'superseded', current: last.current };
  if (why === 'current_malformed') return { ok: false, code: 'current_malformed' };
  const s = tx && tx.snapshot ? tx.snapshot.val() : null;
  if (why === 'stale_null') return s === null ? { ok: false, code: 'superseded', current: 0 } : { ok: false, code: 'unavailable' };
  if (why !== 'write' || !tx.committed || !isObj(s) || s.policy_version !== expected + 1) return { ok: false, code: 'unavailable' };
  return { ok: true, policy_version: expected + 1 };
}

// what every portal read STATES (rule: always stated, each === true)
const switchesOf = (cfg) => Object.fromEntries(SWITCHES.map((k) => [k, cfg[k] === true]));

module.exports = { PATH, EXIT_MARKER, HISTORY_MAX, SWITCHES, OFF, settableOf, parseConfig, readMarketingConfig, writeMarketingConfig, switchesOf };
