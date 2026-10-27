'use strict';
// INTL PHONE S-core step 3 — the PURE core of the owner's read-only phone census (tools/phone-census.js). It classes each STORED order
// phone by what the strict wire contract (phone/intl.js parseSubmitted; flag config/phone_wire_strict) would do with it, so the owner
// can decide the flip. COUNTS ONLY: the output never carries a phone, its digits, a hash, a suffix or an order id.
//   classify(v)                     → 'accept:qualified:<cc>' | 'accept:bare8' | 'reject:<why>' | 'empty'
//   aggregate(orders, {nowMs, days}) → {window_days, orders_in_window, skipped_no_timestamp, totals, by_restaurant, would_reject, flip_safe}
//                                     flip_safe (advisor ruling Option S) ⇔ ≥1 order in the window AND would_reject == 0 AND accept:bare8 == 0
//                                     (bare-8 is the ONE class whose stored form — hence its dedup bucket — changes under strict; > 0 ⇒ STOP, Option D)
//   parseArgs(argv)                 → {ok, days} | {ok:false, error}   (--project is require-project's; anything else is refused)
const { parseSubmitted, SUPPORTED } = require('../phone/intl');
const DAY_MS = 86400e3;

function classify(v) {
  if (v == null || v === '') return 'empty';
  if (typeof v !== 'string') return 'reject:non_string';
  const p = parseSubmitted(v);
  if (p) return v.trim().startsWith('+') ? `accept:qualified:${p.cc}` : 'accept:bare8';
  const s = v.trim().replace(/[ \-().]/g, '');
  if (/^\+\d+$/.test(s)) {
    const d = s.slice(1);
    if (d.length === 8) return 'reject:plus_8';
    return SUPPORTED.some((c) => d.startsWith(c.cc)) ? 'reject:qualified_wrong_length' : 'reject:qualified_unsupported';
  }
  if (/^\d+$/.test(s) && parseSubmitted('+' + s)) return 'reject:cc_digits_no_plus';
  return 'reject:bare_other';
}

function aggregate(orders, { nowMs, days }) {
  const since = nowMs - days * DAY_MS;
  const totals = {}, byR = {}; let inWin = 0, skipped = 0, rejects = 0;
  for (const o of Object.values(orders || {})) {
    if (!o || typeof o !== 'object') continue;
    if (!Number.isFinite(o.created_at)) { skipped++; continue; }
    if (o.created_at < since || o.created_at > nowMs) continue;
    inWin++;
    const c = classify(o.customer_phone);
    const rid = typeof o.restaurant_id === 'string' && o.restaurant_id ? o.restaurant_id : '(none)';
    totals[c] = (totals[c] || 0) + 1;
    (byR[rid] = byR[rid] || {})[c] = (byR[rid][c] || 0) + 1;
    if (c.startsWith('reject:')) rejects++;
  }
  return { window_days: days, orders_in_window: inWin, skipped_no_timestamp: skipped, totals, by_restaurant: byR, would_reject: rejects, flip_safe: inWin > 0 && rejects === 0 && !totals['accept:bare8'] };
}

// The exact config/phone_wire_strict value the owner writes at the flip (phone/flag.js evaluateStrict accepts it), or null.
function flipConfig(report, generatedAtMs, enabledAtMs) {
  if (!report || report.flip_safe !== true) return null;
  return { enabled: true, enabled_at: enabledAtMs, census: { flip_safe: true, generated_at: generatedAtMs, orders_in_window: report.orders_in_window } };
}

function parseArgs(argv) {
  let days = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') { i++; continue; }
    if (a.startsWith('--project=')) continue;
    if (a === '--days' && days === null && /^\d+$/.test(argv[i + 1] || '')) { days = Number(argv[++i]); continue; }
    return { ok: false, error: `unknown or repeated argument ${JSON.stringify(a)} (only --project <id> and --days <1..90>)` };
  }
  if (days === null) days = 30;
  if (!(days >= 1 && days <= 90)) return { ok: false, error: '--days must be an integer 1..90' };
  return { ok: true, days };
}

module.exports = { classify, aggregate, flipConfig, parseArgs };
