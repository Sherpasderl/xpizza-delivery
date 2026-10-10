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
// BOTH DIRECTIONS (codex PB-1 r1 P1-2): every map entry's choices point back at it, AND every item that declares a
// `variantOf` is listed by exactly that launcher's entry. Contradictory group evidence — choices with no map (absent or
// {}), a choice no entry lists, one listed twice — is ok:false (UNCLASSIFIABLE → menu_updating), never "no launchers".
// Pure: no I/O, no brand literal. ABSENT `variant_items` with NO item declaring `variantOf` means "no groups".
// ---------------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function groupIndexFrom(built) {
  const empty = { ok: true, launchers: new Set(), parentOf: new Map() };
  const items = built && Array.isArray(built.items) ? built.items : null;
  const st = built && isObj(built.structure) ? built.structure : null;
  if (!items || !st) return { ok: false, launchers: new Set(), parentOf: new Map() };
  const bad = { ok: false, launchers: new Set(), parentOf: new Map() };
  const declaresParent = (it) => it && isObj(it.display) && it.display.variantOf !== undefined && it.display.variantOf !== null;
  const choices = items.filter(declaresParent);
  if (!Object.prototype.hasOwnProperty.call(st, 'variant_items') || st.variant_items === undefined) return choices.length ? bad : empty;
  const vi = st.variant_items;
  if (!isObj(vi)) return bad;

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
      if (parentOf.has(vKey)) return bad;                     // one choice listed twice (or by two launchers)
      parentOf.set(vKey, lKey);
    }
  }
  // the reverse direction: every item that names a parent is a listed choice of exactly that parent
  for (const it of choices) if (!parentOf.has(it.key)) return bad;
  return { ok: true, launchers, parentOf };
}

// The keys of an order's lines that are BARE launchers (never orderable, never redeemable — every brand).
function bareLauncherKeys(keys, index) {
  const out = [];
  for (const k of keys || []) if (typeof k === 'string' && index && index.launchers.has(k) && !out.includes(k)) out.push(k);
  return out;
}

module.exports = { groupIndexFrom, bareLauncherKeys };
