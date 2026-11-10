"use strict";
// ── form-serial-order — THE ORDER AN ORDER'S LINES ARE SERIALIZED IN, shared by every order form (PLAN-menu-ordering §3) ──
//
// An order's charge must never depend on where the merchant put a dish on the menu. The forms used to serialize cart lines
// in MENU order, and that order reaches `items` and `items_text` — which the legacy orderFingerprint and charge_inputs_fp
// bind — so a reorder published between a quote and the charge (or between a payment and its retry) turned an identical
// cart into a different fingerprint: a 409 `cart`, or a lost reward reuse. So:
//
//   • a FRESH order serializes in CART INSERTION ORDER (form-cart.js keeps it: a quantity change keeps a line's place, a
//     removal and re-add moves it to the end, snapshot/hydrate preserve it) — the menu plays no part;
//   • a PENDING order keeps its FIRST serialization for its whole life: when the form mints (or resumes) an order_id, the
//     line order it serialized is pinned beside it, and every later quote and submit for that order applies the pin. A
//     same-page retry that removed and re-added a line identically still sends [A, B], never [B, A];
//   • a REPLACEMENT order (the cart changed, so a NEW order_id will be minted) is a fresh order: the form passes
//     `live = false` while its cart no longer signs as the pending order, so its quote AND its submit both serialize in
//     the cart's own insertion order, and the mint pins exactly that (codex serialization r1 P2);
//   • a RESUMED order (payment return) pins the order of the payload it was first sent with (its stash's order.items),
//     matched line by line on the fields that payload carries — so a stash written by an older, menu-ordered client
//     resumes byte-identically;
//   • a line the pin does not hold (a genuine cart change) follows the pinned ones in insertion order — and that change
//     mismatches at the server, as it should.
// The pin clears when the order completes. No request field is added and the server is unchanged.
//   • S3 (D4c-grill/item-s1/S3-DESIGN.md, advisor Q3 ruling): beside its order, the pin keeps each pinned line's `item_key` AS FIRST
//     SENT — the map's value at the mint, or exactly what the stashed item carried on a resume (present, or absent → null) — so a
//     retried or resumed order resends its first body byte-identically whatever the live map says now.
//
// Brand-agnostic: lines are the cart's resolved lines ({ key, record, added }); a stashed item is matched on every identity
// field it carries (name always; dish_id and id when present), whichever brand wrote it.
//
// Same bytes load as a classic browser script AND a Node module (no ESM), like the other shared form modules.

function serialItemMatches(line, item) {
  if (!line || !item || typeof item !== "object") return false;
  const rec = line.record || {};
  const added = line.added || {};
  const name = item.name;
  if (typeof name !== "string" || !(name === rec.name || name === added.name)) return false;
  if (item.dish_id != null && rec.dish_id != null && String(item.dish_id) !== String(rec.dish_id)) return false;
  if (item.id != null && !(String(item.id) === String(line.key) || (rec.id != null && String(item.id) === String(rec.id)))) return false;
  return true;
}

function createSerialOrder() {
  let pin = null;   // line keys, in the order this pending order first serialized them; null = no pending order
  let iks = null;   // S3: line key → the item_key that line was first sent with (null = none); null = nothing recorded
  // the lines in serialization order: pinned keys first (in pin order), then every other line in insertion order.
  // `live` is the form's answer to "is the pinned order still the one being sent?" — false → insertion order
  function order(lines, live = true) {
    const list = Array.isArray(lines) ? lines.slice() : [];
    if (!pin || !live) return list;
    const at = new Map(pin.map((k, i) => [k, i]));
    return list.map((l, i) => ({ l, r: at.has(String(l.key)) ? at.get(String(l.key)) : pin.length + i }))
      .sort((a, b) => a.r - b.r).map((x) => x.l);
  }
  // a NEW order_id: pin the cart's insertion order — what its quote already serialized (the form's pin was not live
  // for a cart that mints), so quote and submit cannot disagree
  function mint(lines, itemKeyOf) {
    const list = Array.isArray(lines) ? lines : [];
    pin = list.map((l) => String(l.key));
    iks = typeof itemKeyOf === "function" ? new Map(list.map((l) => [String(l.key), itemKeyOf(l) || null])) : null;
  }
  // a RESUMED order_id: pin the order of the payload it was first sent with
  function resume(lines, items) {
    const list = Array.isArray(lines) ? lines : [];
    if (!Array.isArray(items)) return false;
    const used = new Set();
    const keys = [];
    const sent = new Map();
    for (const it of items) {
      const hit = list.find((l) => !used.has(String(l.key)) && serialItemMatches(l, it));
      if (hit) {
        used.add(String(hit.key)); keys.push(String(hit.key));
        sent.set(String(hit.key), Object.prototype.hasOwnProperty.call(it, "item_key") && typeof it.item_key === "string" && it.item_key ? it.item_key : null);
      }
    }
    pin = keys;
    iks = sent;
    return true;
  }
  function clear() { pin = null; iks = null; }
  function current() { return pin ? pin.slice() : null; }
  // S3: the item_key a pinned line was first sent with — a string, or null (sent without one); undefined when the pin does not
  // hold that line or is not live (the caller then reads the live map)
  function itemKey(key, live = true) { return pin && live && iks && iks.has(String(key)) ? iks.get(String(key)) : undefined; }
  return { order, mint, resume, clear, current, itemKey };
}

if (typeof module !== "undefined" && module.exports) module.exports = { createSerialOrder, serialItemMatches };
if (typeof window !== "undefined") { window.createSerialOrder = createSerialOrder; window.serialItemMatches = serialItemMatches; }
