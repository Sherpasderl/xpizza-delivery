'use strict';
// ---------------------------------------------------------------------------
// 1D add-product PHASE B (rev 6, UNIFORM) — the required-choice GROUP INDEX of one built catalog, for EVERY brand.
//
//   groupIndexFrom({ items, structure }) → { ok, launchers: Set<pricingKey>, parentOf: Map<variantKey, launcherKey> }
//
// A group is a LAUNCHER item plus N priced VARIANT items. The references live in the DISPLAY-ID namespace
// (`structure.variant_items` keys, `variantIds`, `display.variantOf`); what an order line carries is a PRICING KEY.
// This module is the one place the two are joined, so intake, redemption, availability and the KDS ask the same
// question the same way: "is this key a bare launcher?" and "which launcher is this variant's parent?".
//
// FAIL-CLOSED: `ok:false` whenever the map cannot be read as written (present but not an object, a launcher or
// variant id that resolves to no item, a variant listed by one launcher but pointing at another). Callers treat an
// unreadable map as an UNCLASSIFIABLE snapshot — never as "no launchers" (plan §0b.4).
// Pure: no I/O, no brand literal. ABSENT `variant_items` means "no groups" (ok:true, empty).
// ---------------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function groupIndexFrom(built) {
  const empty = { ok: true, launchers: new Set(), parentOf: new Map() };
  const items = built && Array.isArray(built.items) ? built.items : null;
  const st = built && isObj(built.structure) ? built.structure : null;
  if (!items || !st) return { ok: false, launchers: new Set(), parentOf: new Map() };
  if (!Object.prototype.hasOwnProperty.call(st, 'variant_items') || st.variant_items === undefined) return empty;
  const vi = st.variant_items;
  if (!isObj(vi)) return { ok: false, launchers: new Set(), parentOf: new Map() };

  const keyOfId = new Map();
  for (const it of items) {
    if (it && typeof it.key === 'string' && isObj(it.display) && it.display.id !== undefined && it.display.id !== null) {
      keyOfId.set(String(it.display.id), it.key);
    }
  }
  const launchers = new Set();
  const parentOf = new Map();
  for (const [launcherId, spec] of Object.entries(vi)) {
    const lKey = keyOfId.get(String(launcherId));
    if (!lKey || !isObj(spec) || !Array.isArray(spec.variantIds)) return { ok: false, launchers: new Set(), parentOf: new Map() };
    launchers.add(lKey);
    for (const vid of spec.variantIds) {
      const vKey = keyOfId.get(String(vid));
      if (!vKey) return { ok: false, launchers: new Set(), parentOf: new Map() };
      const vItem = items.find((it) => it && it.key === vKey);
      if (!vItem || !isObj(vItem.display) || String(vItem.display.variantOf) !== String(launcherId)) {
        return { ok: false, launchers: new Set(), parentOf: new Map() };
      }
      parentOf.set(vKey, lKey);
    }
  }
  return { ok: true, launchers, parentOf };
}

// The keys of an order's lines that are BARE launchers (never orderable, never redeemable — every brand).
function bareLauncherKeys(keys, index) {
  const out = [];
  for (const k of keys || []) if (typeof k === 'string' && index && index.launchers.has(k) && !out.includes(k)) out.push(k);
  return out;
}

module.exports = { groupIndexFrom, bareLauncherKeys };
