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

// §3 r2 — THE PRE-§3 TEXT OF THIS CART. A stamp written before §3 came from a client that serialized in MENU order, so
// its verbatim key is the key of THIS cart's lines re-ordered into menu order — whatever order they arrive in now. The
// client lines ("{n}x {name} (L{price}){extras}") are stably sorted by their dish's position in `menuNames` (the cached
// catalog snapshot's names, in item_order); the lines the SERVER appends (a reward's "… (Recompensa)") stay last, in
// order, exactly as they were appended then. null when it cannot be rebuilt faithfully: no snapshot, unbalanced
// brackets, or a line whose dish the snapshot does not name.
const LEGACY_LINE = /^\d+x (.+?) \(L\d+(?:\.\d+)?\)/;
const SERVER_LINE = / \(Recompensa\)$/;
function topLevelLines(s) {
  const lines = []; let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth < 0) return null; }
    else if (depth === 0 && s.startsWith(' | ', i)) { lines.push(s.slice(start, i)); start = i + 3; i += 2; }
  }
  if (depth !== 0) return null;
  lines.push(s.slice(start));
  return lines;
}
// The order's top-level lines split into CLIENT lines and the SERVER-appended "… (Recompensa)" lines after them; null when
// the text is not a shape either writer produces (unbalanced brackets, a client line after a server line).
function splitLines(itemsText) {
  const lines = topLevelLines(String(itemsText == null ? '' : itemsText).trim()); if (!lines) return null;
  const client = [], server = [];
  for (const line of lines) {
    if (SERVER_LINE.test(line)) { server.push(line); continue; }
    if (server.length) return null;
    client.push(line);
  }
  return { client, server };
}
// §3 r4 — the MENU-ORDER PERMUTATION of the order's own client lines: perm[k] = the index (in the order's text) of the
// line a pre-§3 client would have written k-th. null when it cannot be rebuilt faithfully (no snapshot, a dish it does not name).
function legacyOrderOf(itemsText, menuNames) {
  if (!Array.isArray(menuNames) || !menuNames.length) return null;
  const sp = splitLines(itemsText); if (!sp) return null;
  const at = new Map(menuNames.map((n, i) => [n, i]));
  const ranked = [];
  for (const [i, line] of sp.client.entries()) {
    const m = LEGACY_LINE.exec(line); if (!m || !at.has(m[1])) return null;
    ranked.push({ r: at.get(m[1]), i });
  }
  return ranked.sort((a, b) => (a.r - b.r) || (a.i - b.i)).map((x) => x.i);
}
// the legacy text of THIS order's lines in the order `perm` gives — or null unless `perm` is a true permutation of them
// (an array — or RTDB's dense index object — of every client-line index exactly once). A corrupted permutation can never
// name another order's content: at worst it names this cart's lines in another order (a missed hold, never a false one).
function legacyTextByOrder(itemsText, perm) {
  const sp = splitLines(itemsText); if (!sp) return null;
  const arr = Array.isArray(perm) ? perm
    : (perm && typeof perm === 'object' && Object.keys(perm).every((k, i, ks) => k === String(i) && ks.length) ? Object.keys(perm).map((k) => perm[k]) : null);
  const n = sp.client.length;
  if (!arr || arr.length !== n || !n) return null;
  const seen = new Set();
  for (const i of arr) { if (!Number.isInteger(i) || i < 0 || i >= n || seen.has(i)) return null; seen.add(i); }
  return arr.map((i) => sp.client[i]).concat(sp.server).join(' | ');
}
function legacyItemsText(itemsText, menuNames) {
  const perm = legacyOrderOf(itemsText, menuNames);
  return perm == null ? null : legacyTextByOrder(itemsText, perm);
}
// §3 r4 — what makes two orders the SAME cart for the duplicate guard: the order-independent key of their CLIENT lines
// (phone, the lines without the server-appended reward lines, type, slot). A reward one order redeemed and the other did
// not is not a different cart; any other difference is.
function clientContentKey({ phone, itemsText, orderType, scheduledFor } = {}) {
  const sp = splitLines(itemsText);
  return orderContentKey({ phone, itemsText: sp ? sp.client.join(' | ') : itemsText, orderType, scheduledFor });
}

// The content stamp this order's content resolves to: the ORDER-INDEPENDENT key's, and — while stamps written before §3
// can still be live — the LEGACY key's (the pre-§3 text of this cart, rebuilt in menu order from `menuNames`). When the
// legacy text cannot be rebuilt (no cached snapshot, a dish it does not name), the incoming text's verbatim key is read
// instead and that is LOGGED with the order_id. When several stamps exist the LATEST `at` wins (what one shared key gave
// before: the last writer's stamp). Any read error THROWS — each caller already treats an error as its own fail-safe.
async function readContentStamp(db, { phone, itemsText, orderType, scheduledFor } = {}, { menuNames = null, orderId = null, log = (...a) => console.warn(...a) } = {}) {
  const args = { phone, itemsText, orderType, scheduledFor };
  const legacy = legacyItemsText(itemsText, menuNames);
  let legacyKey;
  if (legacy != null) legacyKey = contentKeyOf(phone, legacy, orderType, scheduledFor);
  else {
    legacyKey = orderContentKeyVerbatim(args);
    try { log('content_key_legacy_unavailable', JSON.stringify({ order_id: orderId == null ? null : String(orderId), reason: Array.isArray(menuNames) ? 'unmatched_line' : 'no_menu_snapshot' })); } catch (_) {}
  }
  return readContentStampByKeys(db, phone, [orderContentKey(args), legacyKey]);
}
// The stamp under any of `keys` (deduped); the LATEST `at` wins. Any read error THROWS (each caller fails safe on its own).
async function readContentStampByKeys(db, phone, keys) {
  const base = `recent_order_content/${rateLimitKey(phone)}`;
  const ks = [...new Set(keys.filter((k) => typeof k === 'string' && k))];
  const recs = (await Promise.all(ks.map((k) => db.ref(`${base}/${k}`).once('value').then((snap) => snap.val())))).filter((r) => r != null);
  if (!recs.length) return null;
  const at = (r) => (r && Number.isFinite(r.at) ? r.at : -Infinity);
  return recs.reduce((best, r) => (at(r) > at(best) ? r : best));
}

// §3 r3 — an order's content keys, computed ONCE at the card checkout's intake (where the catalog snapshot is warm) and
// PERSISTED on the pending order, so the confirm-side duplicate guard — confirm / webhook / sweep / materialize run in
// separate instances with a cold catalog cache — never needs menu names. `content_key` is the order-independent key;
// `content_legacy_order` the MENU-ORDER PERMUTATION of the order's own client lines (r4: never a free-floating key — the
// reader rebuilds the pre-§3 verbatim key from the order's OWN items_text and validates the permutation). When it cannot be
// rebuilt (no cached snapshot, a dish it does not name) it is absent, `content_key_legacy_reason` says why, and it is
// LOGGED with the order_id; the guard then reads the incoming verbatim key (as readContentStamp does). {} when no key.
function contentKeysRecord({ phone, itemsText, orderType, scheduledFor } = {}, { menuNames = null, orderId = null, log = (...a) => console.warn(...a) } = {}) {
  const args = { phone, itemsText, orderType, scheduledFor };
  const content_key = orderContentKey(args);
  if (!content_key) return {};
  const perm = legacyOrderOf(itemsText, menuNames);
  if (perm != null) return { content_key, content_legacy_order: perm };
  const reason = Array.isArray(menuNames) ? 'unmatched_line' : 'no_menu_snapshot';
  try { log('content_key_legacy_unavailable', JSON.stringify({ order_id: orderId == null ? null : String(orderId), reason })); } catch (_) {}
  return { content_key, content_key_legacy_reason: reason };
}

// the pre-§3 verbatim key of an order rebuilt from its OWN content + the persisted permutation; null when invalid
function legacyKeyByOrder({ phone, itemsText, orderType, scheduledFor } = {}, perm) {
  const t = legacyTextByOrder(itemsText, perm);
  return t == null ? null : contentKeyOf(phone, t, orderType, scheduledFor);
}

module.exports = { orderContentKey, orderContentKeyVerbatim, canonicalItemsText, legacyItemsText, readContentStamp, readContentStampByKeys, contentKeysRecord, legacyOrderOf, legacyKeyByOrder, clientContentKey, isContentRetap, rateLimitKey };
