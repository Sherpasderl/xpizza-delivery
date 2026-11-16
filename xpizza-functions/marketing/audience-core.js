'use strict';
// offer-audience (PLAN-5f-offer-audience r4.1, owner SIMPLE DECISIONS:5011 + 5013) — the PURE audience core. No I/O, no clock, no PII out.
//   · idsOf: the brand-scoped identity codes. h = HMAC-SHA256(key, "aud:v1:<p|e>:" + brandId + ":" + input), input = the verified phone's
//     phone_hash (otp-lib, already salted) or a VERIFIED email (trim + lower). Brand-scoped ⇒ unlinkable across brands without the key; the
//     key is the owner's AUDIENCE_KEY_V1 secret. No key / no brand / nothing verified ⇒ null (fail closed: no code is ever guessed).
//   · hnMonthOf / hnDayOf / cutoffMonth / dayBefore: the HN (UTC−6, no DST) keys of the marker month, its month index, the 24-month
//     retention cutoff (owner 5013) and the audience_ids 30-day deadline index.
//   · kindOf: NEW ⇔ no delivered/completed order at the BRAND (any branch) in the account's history AND no marker for its phone / email.
// Brand-agnostic: no rid / brand literal.
const crypto = require('node:crypto');

const KV = 'v1';
const KEY_MIN = 32;
const HN_OFFSET_MS = 6 * 3600000;
const RETENTION_MONTHS = 24;                       // owner DECISIONS:5013 — 24 months after the last delivered order at the brand
const FULFILLED = Object.freeze(['delivered', 'completed']);
const HEX64 = /^[0-9a-f]{64}$/;

const str = (v) => typeof v === 'string' && v.length > 0;
const mac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');

// → { p?, e?, kv } | null
function idsOf({ key, brandId, phoneHash = null, email = null, emailVerified = false } = {}) {
  if (!str(key) || key.length < KEY_MIN || !str(brandId)) return null;
  const out = {};
  if (str(phoneHash)) out.p = mac(key, `aud:${KV}:p:${brandId}:${phoneHash}`);
  if (emailVerified === true && typeof email === 'string') {
    const em = email.trim().toLowerCase();
    if (em) out.e = mac(key, `aud:${KV}:e:${brandId}:${em}`);
  }
  if (!out.p && !out.e) return null;
  return { ...out, kv: KV };
}

// what idsOf produces, exactly: { p?, e? } hex HMACs (≥ 1) + kv — for the frozen orders/{id}/audience_ids and a signed aud.ids
function idsShapeOk(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v.kv !== KV) return false;
  const ks = Object.keys(v);
  if (!ks.every((k) => k === 'p' || k === 'e' || k === 'kv')) return false;
  if (!('p' in v) && !('e' in v)) return false;
  return (!('p' in v) || HEX64.test(v.p)) && (!('e' in v) || HEX64.test(v.e));
}

const pad = (n) => String(n).padStart(2, '0');
const hnDate = (ms) => (Number.isFinite(ms) ? new Date(ms - HN_OFFSET_MS) : null);
function hnMonthOf(ms) { const d = hnDate(ms); return d ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}` : null; }
function hnDayOf(ms) { const d = hnDate(ms); return d ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : null; }
// the first retained month: (current HN month − 24). A marker month < cutoff is expired — never written, swept when present.
function cutoffMonth(nowMs) {
  const d = hnDate(nowMs); if (!d) return null;
  const idx = d.getUTCFullYear() * 12 + d.getUTCMonth() - RETENTION_MONTHS;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}
// the HN day key `days` days before today (the audience_ids deadline: buckets with key < this are overdue)
function dayBefore(nowMs, days) { return Number.isFinite(nowMs) ? hnDayOf(nowMs - days * 86400000) : null; }

// the FLAT index keys (PLAN r4.1 §5, ruling T9): `<YYYY-MM>_<h>` (marker expiry) and `<YYYY-MM-DD>_<orderId>` (the audience_ids deadline) —
// a key sorts by its date prefix, so orderByKey().endBefore(<cutoff>).limitToFirst(N) is exactly the N oldest overdue entries
const monthKey = (month, h) => `${month}_${h}`;
const dayKey = (ms, orderId) => `${hnDayOf(ms)}_${orderId}`;
const keyParts = (k) => { const i = typeof k === 'string' ? k.indexOf('_') : -1; return i > 0 ? { date: k.slice(0, i), id: k.slice(i + 1) } : null; };

// rows: user_orders/{uid} entries (restaurant + status); brandOfRid: { rid → brandId } for the rows' rids; markers: { p?: bool, e?: bool }
function kindOf({ brandId, rows, brandOfRid, markers }) {
  if (markers && (markers.p === true || markers.e === true)) return 'returning';
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && FULFILLED.includes(r.status) && str(r.restaurant) && brandOfRid && brandOfRid[r.restaurant] === brandId) return 'returning';
  }
  return 'new';
}

// the SIGNED audience block of a quote (PLAN r4.1 §3): { kind, sel, ids } exactly. sel = the SELECTED offer (any audience) or null = the
// signed absence of one; ids = the codes for a new / returning member, null for kind 'none' (a guest / an unresolved member).
const KINDS = Object.freeze(['new', 'returning', 'none']);
function audShapeOk(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const ks = Object.keys(a).sort();
  if (ks.join() !== 'ids,kind,sel' || !KINDS.includes(a.kind)) return false;
  const s = a.sel;
  if (s !== null && !(s && typeof s === 'object' && Object.keys(s).sort().join() === 'discount_cents,offer_id,rev' && str(s.offer_id)
    && Number.isSafeInteger(s.rev) && s.rev >= 1 && Number.isSafeInteger(s.discount_cents) && s.discount_cents >= 0)) return false;
  return a.kind === 'none' ? a.ids === null : idsShapeOk(a.ids);
}

module.exports = { monthKey, dayKey, keyParts, KINDS, audShapeOk, KV, KEY_MIN, RETENTION_MONTHS, FULFILLED, idsOf, idsShapeOk, hnMonthOf, hnDayOf, cutoffMonth, dayBefore, kindOf };
