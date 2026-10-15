'use strict';
// ---------------------------------------------------------------------------
// PLAN-A §A8 / A8a step 1 — THE TEXT-VERSION PROVENANCE OF A PAYMENT BINDING (the rollback floor).
//
// A stored binding (orders/{id}.payment_fingerprint, or a reward reservation's order_fingerprint) was computed over
// ONE composition of the paid text:
//   · legacy (marker ABSENT): sanitize(paid).slice(0, 1500) + exactly one reward append — int10's composition;
//   · 'a8'   (marker 'a8')  : the untruncated sanitized paid text + the same append.
// The marker is server-owned and lives beside the fingerprint it describes (the order: payment_fingerprint_text_version;
// the reservation: text_version). Exactly ONE candidate is compared per stored binding, chosen by that marker — never by
// the text's length, never by trying both (codex A-r4).
//
// A-1 never writes a marker on a FRESH binding: the request write mode is hard-wired LEGACY (no flag reader). A marker
// is carried only from an existing 'a8' artifact (a retained reservation), so with no such artifact every path is
// byte-identical to int10.
//
// A present marker that is not 'a8' fails CLOSED (binding_format_invalid), exactly like a malformed fp_format.
// ---------------------------------------------------------------------------

const ORDER_FIELD = 'payment_fingerprint_text_version';
const RESERVATION_FIELD = 'text_version';
const TEXT_LEGACY = 'legacy';
const TEXT_A8 = 'a8';
const LEGACY_PAID_TEXT_MAX = 1500;            // int10's slice (index.js sanitizeText(body.items_text, 1500))
const WRITE_MODE = TEXT_LEGACY;               // A-1: hard-wired; the flag reader arrives in A-4

function textVersionOf(artifact, field = ORDER_FIELD) {
  if (!artifact || typeof artifact !== 'object' || !Object.prototype.hasOwnProperty.call(artifact, field) || artifact[field] === undefined) {
    return { ok: true, version: TEXT_LEGACY };
  }
  if (artifact[field] === TEXT_A8) return { ok: true, version: TEXT_A8 };
  return { ok: false, reason: 'binding_format_invalid' };
}

// The paid text of a candidate, from the untruncated sanitized paid text. legacy === int10's fields.items_text exactly
// (sanitizeText trims BEFORE it slices, so slicing the full sanitized text afterwards is byte-identical).
function paidTextFor(version, paidTextFull) {
  const s = paidTextFull == null ? '' : String(paidTextFull);
  return version === TEXT_A8 ? s : (s.length > LEGACY_PAID_TEXT_MAX ? s.slice(0, LEGACY_PAID_TEXT_MAX) : s);
}

// The marker fields a record composed in `version` carries: presence for 'a8', NOTHING for legacy (never a default).
function markerFields(version, field = ORDER_FIELD) {
  return version === TEXT_A8 ? { [field]: TEXT_A8 } : {};
}

module.exports = { ORDER_FIELD, RESERVATION_FIELD, TEXT_LEGACY, TEXT_A8, LEGACY_PAID_TEXT_MAX, WRITE_MODE,
  textVersionOf, paidTextFor, markerFields };
