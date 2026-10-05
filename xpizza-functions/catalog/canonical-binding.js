'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-b — THE FORMAT-TAG CONTRACT AND THE CANONICAL PROJECTIONS (PLAN-D4b §A, §B).
//
// EXPANSION RELEASE: nothing here is reached by a writer. Every binding READER gains a canonical branch,
// selected ONLY by a format tag read from the server-authoritative artifact that supplies the fingerprint
// (the HMAC-verified token payload; the stored order / reservation record), from THE SAME SNAPSHOT. No
// writer in D4-b ever produces that tag, so in production every branch taken is the legacy one — and the
// legacy branches are byte-identical to before (catalog/d4b-legacy-hashes.golden.json).
//
// 🔴 A CANONICAL PROJECTION IS THE LEGACY NORMALIZED STRUCTURE WITH ONLY THE IDENTITY KEYS SUBSTITUTED
// (§B), hashed by the SAME legacy functions plus `v:"c1"`. The substituted key is a STRING:
//     ck(kind, cid) = JSON.stringify(["c1", kind, cid])
// — an object key would be stringified to "[object Object]" by the legacy hashers (quote-token.js keyOf)
// and collapse every identity into one. Separation from legacy formats comes from the authoritative tag
// selection and the versioned payloads, NOT from the key namespace (a legacy key could spell a ck string).
//
// 🔴 IDENTITY = THE PRICED OBJECT (§B.6, advisor Q4). Each cid is DERIVED from the legacy key the pricing
// route priced (itemPricingKey), through the request's usable D4-a context. A line's own dish_id/extra_id
// claim, when present, must equal it; an absent claim is not a refusal; an unresolvable key or an
// unusable context → `unverifiable` → the caller REFUSES (never null, never a legacy fall-through).
// ---------------------------------------------------------------------------
const { cartFingerprint, normalizeCartForFingerprint } = require('../quote-token');
const { redemptionFingerprint } = require('../rewards-redeem');
/* LAZY, because these modules sit in the require graph ABOVE this one (the charge acquirers and the reservation
   writer load this module): a top-level require would capture a half-built exports object during a cycle. The same
   functions are used, resolved at call time. */
const orderFingerprint = (...a) => require('../pixelpay-charge').orderFingerprint(...a);
const bindingFp = (...a) => require('../rewards-reserve').bindingFp(...a);

const FORMAT_LEGACY = 'legacy';
const FORMAT_CANONICAL = 'canonical';
const CANONICAL_VERSION = 'c1';
const ORDER_BINDING_PREFIX = 'c1:';      // the selected canonical order binding, as passed to a reservation (§B.4)

// ── §A.2 — the format of an artifact. Absent → legacy (exactly); "canonical" → canonical; anything else → refuse.
function formatOf(artifact, field = 'fp_format') {
  if (!artifact || typeof artifact !== 'object' || !Object.prototype.hasOwnProperty.call(artifact, field) || artifact[field] === undefined) {
    return { ok: true, format: FORMAT_LEGACY };
  }
  if (artifact[field] === FORMAT_CANONICAL) return { ok: true, format: FORMAT_CANONICAL };
  return { ok: false, reason: 'binding_format_invalid' };
}

const ck = (kind, cid) => JSON.stringify([CANONICAL_VERSION, kind, cid]);
const unverifiable = (detail) => ({ ok: false, reason: 'cart_unverifiable', detail });

// The (kind, legacyKey) → canonicalId map of a USABLE D4-a context. null when the context cannot be used.
function identityMap(context) {
  if (!context || context.usableAsIdentity !== true || !Array.isArray(context.objects)) return null;
  const m = { dish: new Map(), extra: new Map() };
  for (const o of context.objects) {
    if (o && (o.kind === 'dish' || o.kind === 'extra') && typeof o.canonicalId === 'string' && o.canonicalId) m[o.kind].set(o.legacyKey, o.canonicalId);
  }
  return m;
}
/* §B.6 / Q4 (codex D4-b r1 S2): a claim is ABSENT only when the property is missing or undefined — that is not a
   refusal. A PRESENT claim must be a non-empty string EQUAL to the derived cid; any other present value (a number,
   boolean, object, null, "") is not "no claim", it is an invalid one → unverifiable. Canonical branch only. */
function claimAgrees(rec, field, cid) {
  if (!rec || typeof rec !== 'object' || !Object.prototype.hasOwnProperty.call(rec, field) || rec[field] === undefined) return true;
  return typeof rec[field] === 'string' && rec[field] !== '' && rec[field] === cid;
}

// ── §B.1 — the cart: normalizeCartForFingerprint's output with ONLY the ids substituted ───────────────
function canonicalCartNorm(items, rid, context) {
  const map = identityMap(context);
  if (!map) return unverifiable('context_unusable');
  const norm = normalizeCartForFingerprint(items, rid);           // the legacy normalization, unchanged
  if (!norm) return unverifiable('unfingerprintable_cart');
  const out = [];
  for (let i = 0; i < norm.length; i += 1) {
    const line = norm[i], raw = items[i];
    const cid = map.dish.get(line.id);
    if (!cid) return unverifiable(`unresolved_dish:${line.id}`);
    if (!claimAgrees(raw, 'dish_id', cid)) return unverifiable(`dish_claim_invalid:${line.id}`);
    const rawExtras = (raw && Array.isArray(raw.extras)) ? raw.extras : [];
    const extras = [];
    for (let j = 0; j < line.extras.length; j += 1) {
      const e = line.extras[j];
      const ecid = map.extra.get(e.id);
      if (!ecid) return unverifiable(`unresolved_extra:${e.id}`);
      if (!claimAgrees(rawExtras[j], 'extra_id', ecid)) return unverifiable(`extra_claim_invalid:${e.id}`);
      extras.push({ id: ck('extra', ecid), qty: e.qty });
    }
    out.push({ id: ck('dish', cid), qty: line.qty, extras });
  }
  return { ok: true, norm: out };
}

// The legacy comparator at the sites that sort by legacy key (la_musa `ids.sort()`, rewards-redeem.js):
// the default sort over strings, i.e. UTF-16 code-unit order.
const byKey = (field) => (a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0);

// ── §B.2 — the reward: THREE identity fields, each substituted; items re-sorted by ck ────────────────
// `redemption` is the resolved legacy redemption ({ model, freeItems, canonical }). The kind is the kind
// the reward actually resolved to: the menu first, then extras (rewards-redeem.js laMusaPriceCents).
function canonicalReward(redemption, context) {
  if (!redemption) return { ok: true, reward: null };
  const map = identityMap(context);
  if (!map) return unverifiable('context_unusable');
  const resolve = (legacyKey) => {
    if (map.dish.has(legacyKey)) return { kind: 'dish', cid: map.dish.get(legacyKey) };
    if (map.extra.has(legacyKey)) return { kind: 'extra', cid: map.extra.get(legacyKey) };
    return null;
  };
  const free = Array.isArray(redemption.freeItems) ? redemption.freeItems : [];
  const freeItems = [];
  for (const fi of free) {
    const r = resolve(fi && fi.item_id);
    if (!r) return unverifiable(`unresolved_reward:${fi && fi.item_id}`);
    freeItems.push({ ...fi, item_id: ck(r.kind, r.cid) });
  }
  freeItems.sort(byKey('item_id'));
  const legacyCanon = redemption.canonical || null;
  let canonical = null;
  if (legacyCanon) {
    canonical = { ...legacyCanon, v: CANONICAL_VERSION };
    if (typeof legacyCanon.free_item_key === 'string') {
      const r = resolve(legacyCanon.free_item_key);
      if (!r) return unverifiable(`unresolved_reward:${legacyCanon.free_item_key}`);
      canonical.free_item_key = ck(r.kind, r.cid);
    }
    if (Array.isArray(legacyCanon.items)) {
      const items = [];
      for (const it of legacyCanon.items) {
        const r = resolve(it && it.free_item_key);
        if (!r) return unverifiable(`unresolved_reward:${it && it.free_item_key}`);
        items.push({ ...it, free_item_key: ck(r.kind, r.cid) });
      }
      canonical.items = items.sort(byKey('free_item_key'));
    }
  }
  return { ok: true, reward: { ...redemption, freeItems, canonical } };
}

// ── The canonical cart digest (§B.1; advisor Q1: the SAME cart AND reward the quote binds) ─────────────
function canonicalCartDigest(items, redemption, rid, context) {
  const cart = canonicalCartNorm(items, rid, context);
  if (!cart.ok) return cart;
  const rw = canonicalReward(redemption, context);
  if (!rw.ok) return rw;
  return { ok: true, fp: cartFingerprint(cart.norm, rw.reward, { v: CANONICAL_VERSION }), reward: rw.reward };
}
const canonicalQuoteFingerprint = canonicalCartDigest;

// ── §B.2 — the canonical redemption fingerprint (the same function, over the substituted canonical) ──────
function canonicalRedemptionFp(redemption, context) {
  const rw = canonicalReward(redemption, context);
  if (!rw.ok) return rw;
  return { ok: true, fp: rw.reward && rw.reward.canonical ? redemptionFingerprint(rw.reward.canonical) : '', reward: rw.reward };
}

// ── §B.3 — the order / payment fingerprint: orderFingerprint with items_text → the canonical cart digest ─
// `schedExtra` is the legacy scheduled extra; the reward part of `extra` is `rf:<canonical redemption fp>`.
function canonicalOrderFingerprint({ orderId, totalCents, items, redemption, rid, context, schedExtra = '' }) {
  const digest = canonicalCartDigest(items, redemption, rid, context);
  if (!digest.ok) return digest;
  const rf = digest.reward && digest.reward.canonical ? redemptionFingerprint(digest.reward.canonical) : '';
  const extra = [schedExtra || '', rf ? `rf:${rf}` : ''].filter(Boolean).join('|');
  return { ok: true, fp: orderFingerprint(orderId, totalCents, digest.fp, extra), reward: digest.reward };
}

// ── §B.4 — the reservation binding: the same bindingFp, over the canonical reward object and the order
// binding value EXACTLY as selected for this request (fmt-prefixed), never recomputed here.
/* 🔴 THE ONE CANONICAL RESERVATION SHAPE (advisor ruling B1-a). Every canonical reservation record — a fresh one
   for an order whose SELECTED binding is canonical, and the comparison against a stored canonical record — is
   produced by THIS function, and the D4-c writers are REQUIRED to reuse it, so the shape cannot drift between the
   release that reads it (D4-b) and the release that first writes it in production (D4-c). Pinned by a frozen shape
   golden (catalog/d4b-canonical-reservation.golden.json).
     fp_format:          "canonical"
     canonical:          the ck-substituted reward canonical (§B.2), carrying v:"c1"
     order_fingerprint:  the order binding AS SELECTED for this request ("c1:<canonical order fp>")
     fp:                 bindingFp({ canonical, orderFingerprint: order_fingerprint, configVersion })   (§B.4)
   A legacy order's record is never produced here: the reservation takes the format of its order. */
function canonicalReservationFields({ redemption, context, selectedOrderBinding, configVersion }) {
  const rw = canonicalReward(redemption, context);
  if (!rw.ok) return rw;
  const canonical = rw.reward.canonical;
  return { ok: true, fp_format: FORMAT_CANONICAL, canonical, order_fingerprint: selectedOrderBinding,
    fp: bindingFp({ canonical, orderFingerprint: selectedOrderBinding, configVersion }), reward: rw.reward };
}
// The comparison form: the same fields, read for their fp (kept for the existing callers).
function canonicalReservationBindingFp(args) { return canonicalReservationFields(args); }
// The order binding value selected for a request: legacy → the bare fp (today); canonical → "c1:<fp>".
const selectedOrderBinding = (format, fp) => (format === FORMAT_CANONICAL ? `${ORDER_BINDING_PREFIX}${fp}` : fp);

// ── §B.5 — a reorder recipe line with ONLY its key(s) substituted ─────────────────────────────────────
// la_musa shape {key, qty, options:[{id, qty}]}; x_pizza shape {key, qty, options:[{name, count}]}.
function canonicalRecipeLines(lines, context) {
  const map = identityMap(context);
  if (!map) return unverifiable('context_unusable');
  const out = [];
  for (const l of Array.isArray(lines) ? lines : []) {
    const cid = map.dish.get(l && l.key);
    if (!cid) return unverifiable(`unresolved_dish:${l && l.key}`);
    const line = { ...l, key: ck('dish', cid) };
    if (Array.isArray(l.options)) {
      const opts = [];
      for (const o of l.options) {
        const legacy = o && (o.id !== undefined ? o.id : o.name);
        const ecid = map.extra.get(legacy);
        if (!ecid) return unverifiable(`unresolved_extra:${legacy}`);
        opts.push(o.id !== undefined ? { ...o, id: ck('extra', ecid) } : { ...o, name: ck('extra', ecid) });
      }
      line.options = opts;
    }
    out.push(line);
  }
  return { ok: true, lines: out };
}

// Parse a ck string back to { kind, cid }, or null (a legacy key, or garbage).
function parseCk(s) {
  if (typeof s !== 'string' || s[0] !== '[') return null;
  try {
    const a = JSON.parse(s);
    if (Array.isArray(a) && a.length === 3 && a[0] === CANONICAL_VERSION && (a[1] === 'dish' || a[1] === 'extra') && typeof a[2] === 'string' && a[2]) return { kind: a[1], cid: a[2] };
  } catch (_) { /* not a ck */ }
  return null;
}

// The LABEL for a canonical identity from a usable context, or null. A ck/canonical id is NEVER rendered
// to a human (advisor Q5): no context, or no such object → null (today's "no free item" shape).
function labelFor(kind, cid, context) {
  if (!context || context.usableAsIdentity !== true || !Array.isArray(context.objects)) return null;
  const o = context.objects.find((x) => x && x.kind === kind && x.canonicalId === cid);
  return o && typeof o.label === 'string' && o.label ? o.label : null;
}

// ── §A.3 — one comparator for every payment-binding site (advisory pre-read, CAS, post-txn, classify) ──
// Compares a stored record's payment_fingerprint in THAT RECORD'S format, from the snapshot passed in. Returns
// null when nothing conflicts — including an ABSENT fingerprint (§A.4, today's `&&` guard) — else { reason }:
// 'mismatch' (today's conflict) | 'binding_format_invalid' | 'cart_unverifiable'. `canonical` is a LAZY thunk
// returning { ok, fp }: it runs only for a canonical-tagged record, so the legacy path does no extra work.
function paymentBindingConflict(record, legacyFp, canonical) {
  if (!record) return null;
  const fmt = formatOf(record, 'fp_format');
  if (!fmt.ok) return { reason: 'binding_format_invalid' };   // a malformed tag refuses with or without a fingerprint
  if (!record.payment_fingerprint) {
    // §A.4: an absent fingerprint is not compared. But a CANONICAL record's missing fingerprint can only be filled
    // in its own format (installFingerprint) — if that cannot be computed, refuse BEFORE any write rather than let
    // the recovery path stamp a legacy fingerprint into a canonical-tagged record. (No writer produces a canonical
    // record without its fingerprint; this keeps an anomalous one from becoming a mixed artifact.)
    if (fmt.format === FORMAT_CANONICAL) { const c = typeof canonical === 'function' ? canonical() : null; if (!c || !c.ok) return { reason: 'cart_unverifiable' }; }
    return null;
  }
  if (fmt.format === FORMAT_LEGACY) return record.payment_fingerprint !== legacyFp ? { reason: 'mismatch' } : null;
  const c = typeof canonical === 'function' ? canonical() : null;
  if (!c || !c.ok) return { reason: 'cart_unverifiable' };
  return record.payment_fingerprint !== c.fp ? { reason: 'mismatch' } : null;
}
// The fingerprint the recovery INSTALL path writes into a record that has none (`c.payment_fingerprint || …`): the
// legacy value for a legacy record (today's write, unchanged); the canonical value for a canonical-tagged record.
function installFingerprint(record, legacyFp, canonical) {
  const fmt = formatOf(record, 'fp_format');
  if (fmt.ok && fmt.format === FORMAT_CANONICAL) { const c = typeof canonical === 'function' ? canonical() : null; return c && c.ok ? c.fp : null; }
  return legacyFp;
}
// A legacy mismatch keeps today's exact result shape; anything else carries its typed reason.
const conflictOutcome = (d, base = {}) => (d.reason === 'mismatch' ? { ...base, outcome: 'conflict' } : { ...base, outcome: 'conflict', reason: d.reason });
// Memoize a thunk so a CAS retry loop computes the canonical fingerprint at most once.
function once(fn) { let done = false, v; return () => { if (!done) { v = typeof fn === 'function' ? fn() : null; done = true; } return v; }; }

// ── F "reward display" (advisor Q5): what a HUMAN sees for a canonical reward identity ─────────────────
// The label of the object a ck names, from a usable context; null otherwise (today's "no free item" shape).
// Anything that is not a valid ck also renders null — a canonical branch never shows a raw key or id.
function displayLabel(value, context) {
  const p = parseCk(value);
  return p ? labelFor(p.kind, p.cid, context) : null;
}
// buildRewardStamp's free-item rows in the canonical branch: label-only, rows without a label dropped.
function canonicalRewardRows(freeItems, freeKey, context) {
  const src = (Array.isArray(freeItems) && freeItems.length) ? freeItems.map((fi) => ({ id: fi && fi.item_id, qty: Number(fi && fi.qty) || 1 }))
    : (freeKey ? [{ id: freeKey, qty: 1 }] : []);
  return src.map((r) => ({ name: displayLabel(r.id, context), qty: r.qty })).filter((r) => r.name !== null);
}

module.exports = {
  displayLabel, canonicalRewardRows, installFingerprint,
  paymentBindingConflict, conflictOutcome, once,
  FORMAT_LEGACY, FORMAT_CANONICAL, CANONICAL_VERSION, ORDER_BINDING_PREFIX,
  formatOf, ck, parseCk, identityMap, canonicalCartNorm, canonicalReward, canonicalCartDigest, canonicalQuoteFingerprint,
  canonicalRedemptionFp, canonicalOrderFingerprint, canonicalReservationBindingFp, canonicalReservationFields, selectedOrderBinding,
  canonicalRecipeLines, labelFor,
};
