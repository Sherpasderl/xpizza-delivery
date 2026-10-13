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
//   • a RESUMED order (payment return) pins the order of the payload it was first sent with (its stash's order.items),
//     matched line by line on the fields that payload carries — so a stash written by an older, menu-ordered client
//     resumes byte-identically;
//   • a line the pin does not hold (a genuine cart change) follows the pinned ones in insertion order — and that change
//     mismatches at the server, as it should.
// The pin clears when the order completes. No request field is added and the server is unchanged.
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
  // the lines in serialization order: pinned keys first (in pin order), then every other line in insertion order
  function order(lines) {
    const list = Array.isArray(lines) ? lines.slice() : [];
    if (!pin) return list;
    const at = new Map(pin.map((k, i) => [k, i]));
    return list.map((l, i) => ({ l, r: at.has(String(l.key)) ? at.get(String(l.key)) : pin.length + i }))
      .sort((a, b) => a.r - b.r).map((x) => x.l);
  }
  // a NEW order_id: pin what it serializes now (through any pin already held, so quote and submit cannot disagree)
  function mint(lines) { pin = order(lines).map((l) => String(l.key)); }
  // a RESUMED order_id: pin the order of the payload it was first sent with
  function resume(lines, items) {
    const list = Array.isArray(lines) ? lines : [];
    if (!Array.isArray(items)) return false;
    const used = new Set();
    const keys = [];
    for (const it of items) {
      const hit = list.find((l) => !used.has(String(l.key)) && serialItemMatches(l, it));
      if (hit) { used.add(String(hit.key)); keys.push(String(hit.key)); }
    }
    pin = keys;
    return true;
  }
  function clear() { pin = null; }
  function current() { return pin ? pin.slice() : null; }
  return { order, mint, resume, clear, current };
}

if (typeof module !== "undefined" && module.exports) module.exports = { createSerialOrder, serialItemMatches };
if (typeof window !== "undefined") { window.createSerialOrder = createSerialOrder; window.serialItemMatches = serialItemMatches; }
