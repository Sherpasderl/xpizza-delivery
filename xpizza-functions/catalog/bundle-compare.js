'use strict';
// FORM BUNDLE ⇄ PUBLISHED MENU — THE COMPARATOR, as a pure library (PLAN 4 r3 §4). The form build's live check
// (tools/form-bundle-live-check.js) and the deployed-vs-published reconciler (catalog/form-rebake.js) ask the same question
// with the same code, and the deployed functions closure loads no CLI to do it (catalog/identity-public-contract.test.js
// accepts exactly one CLI-entrypoint guard in that closure). Moved verbatim from the live check, which re-exports it.
// FAIL (block-causing — the cart would refuse a line, or show a dish the server prices differently):
//   a dish / extra / variant group / category present in both whose any field differs, or one baked but absent from live.
// WARN (listed, not fatal): live-only additions — they appear when the live menu applies and cannot block a cart.
// IGNORED KEYS ARE THE CALLER'S: the live check passes the platform identity keys getPublicMenu overlays (the forms
// accept-and-ignore them); the reconciler reads the published menu WITHOUT the overlay, so it passes none — and this module, which
// sits in the deployed functions closure, names no identity field at all (catalog/identity-public-contract.test.js).

const sorted = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]))
  : Array.isArray(v) ? v.map(sorted) : v);
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
let IGNORED = new Set();   // set per compareBundle call (the comparison is synchronous)
const strip = (r) => Object.fromEntries(Object.entries(r || {}).filter(([k]) => !IGNORED.has(k)));

// Keyed collections compared record by record. `entries` turns a collection into [key, record] pairs.
function compareKeyed(label, bakedEntries, liveEntries, out) {
  const live = new Map(liveEntries);
  const baked = new Map(bakedEntries);
  for (const [k, b] of baked) {
    if (!live.has(k)) { out.fail.push(`${label} ${k}: baked but absent from the published menu`); continue; }
    const l = strip(live.get(k)), bb = strip(b);
    for (const f of new Set([...Object.keys(bb), ...Object.keys(l)])) {
      if (!same(bb[f], l[f])) out.fail.push(`${label} ${k}${b && b.name ? ` (${b.name})` : ''} ${f}: baked ${JSON.stringify(bb[f])} | published ${JSON.stringify(l[f])}`);
    }
  }
  for (const [k, l] of live) if (!baked.has(k)) out.warn.push(`${label} ${k}${l && l.name ? ` (${l.name})` : ''}: published only (appears once the live menu applies)`);
}
const byId = (arr) => (Array.isArray(arr) ? arr.map((r) => [String(r && r.id), r]) : []);
const byKey = (obj) => (obj && typeof obj === 'object' ? Object.entries(obj) : []);
const asSet = (arr) => (Array.isArray(arr) ? arr.map((id) => [String(id), true]) : []);

// Pure: the baked bundle against the published menu body. Returns { fail: [...], warn: [...] }.
function compareBundle(baked, published, { ignore = new Set() } = {}) {
  IGNORED = ignore;
  const out = { fail: [], warn: [] };
  if (!published || !Array.isArray(published.dishes)) { out.fail.push('published menu has no dishes'); return out; }
  compareKeyed('dish', byId(baked.dishes), byId(published.dishes), out);
  compareKeyed('extra', byId(baked.extras), byId(published.extras), out);
  compareKeyed('variant_group', byKey(baked.variant_items), byKey(published.variant_items), out);
  compareKeyed('category', byId(baked.categories), byId(published.categories), out);
  compareKeyed('has_photo', asSet(baked.has_photo), asSet(published.has_photo), out);
  // PLAN 4 r3 §3 — the display structures the forms now boot from the bake, under the same FAIL/WARN rules: a gate category,
  // an option-map entry or a badge baked but different / absent live FAILS; a published-only one WARNS. badge_priority is ONE
  // ordered value (its order IS the content), compared whole.
  compareKeyed('pickup_only', asSet(baked.pickup_only_cats), asSet(published.pickup_only_cats), out);
  compareKeyed('weekend_only', asSet(baked.weekend_only_cats), asSet(published.weekend_only_cats), out);
  compareKeyed('extras_by_category', byKey(baked.extras_by_category), byKey(published.extras_by_category), out);
  compareKeyed('extras_by_item', byKey(baked.extras_by_item), byKey(published.extras_by_item), out);
  compareKeyed('badge', byKey(baked.badges), byKey(published.badges), out);
  const whole = (v) => (v === undefined ? [] : [['order', { value: v }]]);
  compareKeyed('badge_priority', whole(baked.badge_priority), whole(published.badge_priority), out);
  return out;
}

module.exports = { compareBundle };
