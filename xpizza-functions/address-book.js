'use strict';
// PLAN-3a-addr r0 (S-ADDR-1/2, advisor APPROVED 2026-11-13) — the member's ADDRESS BOOK as the server reads and serves it:
// user_profiles/{uid}/{addresses/{id}, default_address}. ONE shape rule, the RTDB rules' own (xpizza-reference/database.rules.json
// user_profiles/$uid/addresses/$addrId): id a_[a-f0-9]{6,32}; label 1–40; detected 1–200; details ≤ 200; lat −90..90; lng −180..180;
// created_at + last_used_at numbers; no other key. A stored entry that fails it is DROPPED (never guessed, never repaired).
// Owner-only PII: nothing here logs, and no caller may log an address field.

const ADDR_ID_RE = /^a_[a-f0-9]{6,32}$/;
const BOOK_MAX = 20;   // served cap (legacy books hold ≤ 10 by their client); bounds a self-written oversized book
const ENTRY_KEYS = ['label', 'detected', 'details', 'lat', 'lng', 'created_at', 'last_used_at'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

// the rules' shape for ONE stored entry
function isValidEntry(id, e) {
  if (typeof id !== 'string' || !ADDR_ID_RE.test(id) || !isObj(e)) return false;
  if (Object.keys(e).some((k) => !ENTRY_KEYS.includes(k))) return false;
  return isStr(e.label, 1, 40) && isStr(e.detected, 1, 200) && isStr(e.details, 0, 200)
    && isNum(e.lat, -90, 90) && isNum(e.lng, -180, 180)
    && typeof e.created_at === 'number' && Number.isFinite(e.created_at) && typeof e.last_used_at === 'number' && Number.isFinite(e.last_used_at);
}

// the SERVED book from a profile → { addresses: [{ id, label, detected, details, lat, lng, last_used_at }], default_address: id | null }
// newest use first (last_used_at desc, then id); at most BOOK_MAX; default_address only when it names a SERVED entry. Never created_at.
function projectBook(profile) {
  const book = isObj(profile) && isObj(profile.addresses) ? profile.addresses : {};
  const rows = Object.keys(book).filter((id) => isValidEntry(id, book[id]))
    .map((id) => { const e = book[id]; return { id, label: e.label, detected: e.detected, details: e.details, lat: e.lat, lng: e.lng, last_used_at: e.last_used_at }; })
    .sort((a, b) => (b.last_used_at - a.last_used_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, BOOK_MAX);
  const def = isObj(profile) ? profile.default_address : null;
  return { addresses: rows, default_address: typeof def === 'string' && rows.some((r) => r.id === def) ? def : null };
}

module.exports = { projectBook, isValidEntry, ADDR_ID_RE, BOOK_MAX, ENTRY_KEYS };
