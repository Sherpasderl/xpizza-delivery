'use strict';
// LEDGER S4 (PLAN-5f-ledger-shadow-s1-r3 §1 S4; PLAN-sherpa-ledger r4.6 §4 + amendment 3) — Sherpa's commission RATE, PURE.
// The setting lives at ledger_settings/commission/{scope}/{push} = { bp, effective_from }: server-only (no rule), written ONLY by the owner's
// append-only CLI (tools/set-commission-rate.js); scope = '_default' (every restaurant) or one restaurant id (a per-restaurant rate,
// Sherpa-set — never merchant-editable). Versioned, NEVER retro: an order is rated by its restaurant's own latest entry effective at the
// order's AUTHORITATIVE date (orders/{id}.created_at — Codex #110 r2), else the default's; an order dated before every entry has NO rate
// (null ⇒ the projector reports rate_missing). Malformed entries are ignored. bp = basis points of the food the customer paid (1,000 = 10 %).
const NODE = 'ledger_settings/commission';
const DEFAULT = '_default';
const MIN_BP = 0; const MAX_BP = 10000;
const MIN_EFFECTIVE_FROM = Date.UTC(2026, 0, 1);
const MAX_AHEAD_MS = 366 * 86400000;
const RID = /^[a-z0-9_]{1,64}$/;

const validEntry = (e) => !!e && typeof e === 'object' && Number.isSafeInteger(e.bp) && e.bp >= MIN_BP && e.bp <= MAX_BP
  && Number.isSafeInteger(e.effective_from) && e.effective_from >= MIN_EFFECTIVE_FROM;
const validRid = (rid) => typeof rid === 'string' && RID.test(rid) && rid !== DEFAULT;

// the latest valid entry of one scope effective at `at` (ties: the greater key) → { bp, key } | null
function inScope(entries, at) {
  let best = null;
  for (const [key, e] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    if (!validEntry(e) || e.effective_from > at) continue;
    if (!best || e.effective_from > best.e.effective_from || (e.effective_from === best.e.effective_from && key > best.key)) best = { key, e };
  }
  return best && { bp: best.e.bp, key: best.key };
}

// settings = the whole ledger_settings/commission node; at = orders/{id}.created_at → { bp, scope, key } | null
function rateAt(settings, rid, at) {
  if (!validRid(rid) || !Number.isSafeInteger(at) || !settings || typeof settings !== 'object') return null;
  for (const scope of [rid, DEFAULT]) {
    const hit = inScope(settings[scope], at);
    if (hit) return { bp: hit.bp, scope, key: hit.key };
  }
  return null;
}

module.exports = { NODE, DEFAULT, MIN_BP, MAX_BP, MIN_EFFECTIVE_FROM, MAX_AHEAD_MS, validEntry, validRid, rateAt };
