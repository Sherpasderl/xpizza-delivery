'use strict';

// ── availability-gate — server intake "86" fail-safe (KDS Phase 2b · Slice 4 · KDS_2B_PLAN.md §6–9) ──
//
//   checkItemAvailability(db, items, restaurantId) → { blocked: [labels] }
//
// ONE read of /restaurants/{rid}/item_availability (a single `.once` — NOT N per-item reads). For each
// order line, resolve its raw key EXACTLY as the pricing does (itemPricingKey from menu-pricing.js —
// x_pizza→item.name, la_musa→item.id), encode via the canonical availKey(), and block the line IFF
// node[availKey]?.available === false.
//
// FAIL-OPEN, ABSOLUTE (plan §8): a line is blocked ONLY on a successful read returning an explicit
// boolean `available === false`. Absent key / null / undefined / non-object entry / non-boolean
// `available` ⇒ AVAILABLE. The read is wrapped in try/catch — on ANY read failure we log + return
// { blocked: [] } (allow every line). A Firebase hiccup must NEVER 500 the intake or block a sale.
//
// `blocked` carries human LABELS (the line's display name where present, else its raw pricing key) for
// the structured { error:'item_unavailable', blocked } response the two intake callers return (HTTP 400).
//
// This module NEVER writes and is called ONLY from the two intake paths (createOrder / chargeOnlineOrder,
// fresh-URL branch). materializeOnConfirm + scheduled-release deliberately do NOT re-check (plan §4/§7).

const { availKey } = require('./avail-key');
const { itemPricingKey } = require('./menu-pricing');

async function checkItemAvailability(db, items, restaurantId) {
  if (!Array.isArray(items) || items.length === 0) return { blocked: [] };

  let node;
  try {
    node = (await db.ref(`restaurants/${restaurantId}/item_availability`).once('value')).val();
  } catch (e) {
    // Fail-open: a transient RTDB error must never block a sale.
    console.error(`checkItemAvailability: read failed for ${restaurantId} (failing open)`, e && e.message);
    return { blocked: [] };
  }
  // Absent / malformed node ⇒ every line available (fail-open).
  if (!node || typeof node !== 'object') return { blocked: [] };

  const blocked = [];
  const seen = new Set();
  for (const it of items) {
    const raw = itemPricingKey(it, restaurantId);
    if (raw == null || raw === '') continue;            // unkeyed line ⇒ can't be 86'd ⇒ available
    const entry = node[availKey(raw)];
    // Block ONLY on an explicit boolean false. Anything else (absent/null/non-object/non-boolean) ⇒ available.
    if (entry && typeof entry === 'object' && entry.available === false) {
      const label = (it && it.name != null && it.name !== '') ? String(it.name) : String(raw);
      if (!seen.has(label)) { seen.add(label); blocked.push(label); }
    }
  }
  return { blocked };
}

module.exports = { checkItemAvailability };
