'use strict';

const crypto = require('crypto');

// PURE. Content key = the order's CONTENT (phone + cart + type + slot), NOT its order_id. Two rapid
// submissions with the same content share a key → the server treats the 2nd as a re-tap (of ONE cart),
// not a distinct order. Phone normalized to its LAST 8 DIGITS (the platform's canonical phone key — same
// as muteKeyFor / order-matching: country-code / formatting insensitive). RTDB-safe hex (no . $ # [ ] /).
// order_id is deliberately EXCLUDED — this identifies the cart content, not the submission.
//
// PLAN-menu-ordering §3: the forms now serialize a cart in INSERTION order, so one cart can arrive as "A | B" or "B | A".
// The key is ORDER-INDEPENDENT: items_text is split into its LINES at top-level " | " only (X. Pizza writes a pizza's
// per-instance extras as "[Pizza 1: … | Pizza 2: …]" — a separator INSIDE brackets belongs to its line, so a line keeps
// its extras and two different carts never share a key), and the lines are sorted. A one-line cart keys exactly as it
// always did; text whose brackets do not balance is keyed verbatim (as before — never a looser key).
function canonicalItemsText(itemsText) {
  const s = String(itemsText == null ? '' : itemsText).trim();
  const lines = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth < 0) return s; }
    else if (depth === 0 && s.startsWith(' | ', i)) { lines.push(s.slice(start, i)); start = i + 3; i += 2; }
  }
  if (depth !== 0) return s;
  lines.push(s.slice(start));
  return lines.sort().join(' | ');
}

function contentKeyOf(phone, itemsText, orderType, scheduledFor) {
  const norm = [
    String(phone == null ? '' : phone).replace(/\D/g, '').slice(-8),
    itemsText,
    String(orderType == null ? '' : orderType),
    Number.isFinite(scheduledFor) ? String(scheduledFor) : '',
  ].join('|');
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 32);
}

function orderContentKey({ phone, itemsText, orderType, scheduledFor } = {}) {
  return contentKeyOf(phone, canonicalItemsText(itemsText), orderType, scheduledFor);
}

// The key as it was before §3 (items_text VERBATIM). Stamps written by the previous deploy sit under it, so the
// materialize-side duplicate guard also reads it while such stamps can still be live.
function orderContentKeyVerbatim({ phone, itemsText, orderType, scheduledFor } = {}) {
  return contentKeyOf(phone, String(itemsText == null ? '' : itemsText).trim(), orderType, scheduledFor);
}

// A "re-tap" (→ skip the phone rate-limit increment) = the SAME content seen from this phone within the
// window (far edge exclusive). Non-finite / missing stamp → NOT a re-tap → count normally (fail-safe).
function isContentRetap(rec, now, windowMs) {
  return !!rec && Number.isFinite(rec.at) && (now - rec.at) < windowMs;
}

// Hashed bucket key for /rate_limits and /recent_order_content — avoids storing raw IPs/phones and dodges
// forbidden RTDB key chars ('.', ':', '+'). PURE. (Extracted from index.js so require-safe modules — e.g. the
// F3 materialize-side duplicate guard — can resolve the SAME content-stamp path index.js writes.)
function rateLimitKey(raw) {
  return require('crypto').createHash('sha256').update(String(raw)).digest('hex').slice(0, 32);
}

// The content stamp this order's content resolves to: the ORDER-INDEPENDENT key's, and — while stamps written before §3
// can still be live — the VERBATIM key's; when both exist the LATEST `at` wins (exactly what one shared key gave before:
// the last writer's stamp). A one-line cart has one key, so one read. Any read error THROWS — each caller already treats
// an error as its own fail-safe (count normally / materialize normally).
async function readContentStamp(db, { phone, itemsText, orderType, scheduledFor } = {}) {
  const args = { phone, itemsText, orderType, scheduledFor };
  const base = `recent_order_content/${rateLimitKey(phone)}`;
  const keys = [...new Set([orderContentKey(args), orderContentKeyVerbatim(args)])];
  const recs = (await Promise.all(keys.map((k) => db.ref(`${base}/${k}`).once('value').then((snap) => snap.val())))).filter((r) => r != null);
  if (!recs.length) return null;
  const at = (r) => (r && Number.isFinite(r.at) ? r.at : -Infinity);
  return recs.reduce((best, r) => (at(r) > at(best) ? r : best));
}

module.exports = { orderContentKey, orderContentKeyVerbatim, canonicalItemsText, readContentStamp, isContentRetap, rateLimitKey };
