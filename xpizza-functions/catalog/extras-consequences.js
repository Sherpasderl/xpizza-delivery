'use strict';
// S2-6 (D4c-grill/item-s1/S2-DESIGN.md §1.3 + §2 r1 D; advisor rulings G2/G3, Codex r2 #1) — THE REVIEW'S EXTRAS CONSEQUENCES.
// What a saved edit changes about which extra GROUPS each existing product accepts, judged by the ONE shared evaluator
// (catalog/extras-eligibility.js — the same bytes the portal's drawer runs) on the live and the draft BUILT records:
//   · a record accepts group X iff the evaluator lets it take at least one extra of category X;
//   · one entry per plain product or GROUP, on the LAUNCHER only (options inherit; every product is accounted once);
//   · the entry is the UNION of every member's OWN deltas — launcher and each option, each with its own overrides — so an
//     option that loses X is reported even when its launcher accepted nothing, and X is «lost» when any member loses it;
//   · a product with no live counterpart (an addition) reports nothing; entries by key, lists sorted; nothing ⇒ [].
// Inputs are the RECORDS ({ items, extras: extra records, structure }), never the numeric price tables.
const { projectEligibility, eligibleExtras } = require('./extras-eligibility');

function extrasConsequences({ live, draft }) {
  const pL = projectEligibility(live); const pD = projectEligibility(draft);
  const groupsOf = (p, key) => new Set(eligibleExtras(p, key).map((k) => p.extraCat[k]));
  const items = (draft && Array.isArray(draft.items) ? draft.items : []).filter((it) => it && typeof it.key === 'string' && it.display);
  const liveKeys = new Set(((live && live.items) || []).map((it) => it && it.key));
  const out = [];
  for (const head of items) {
    if (head.display.variantOf != null) continue;   // options are judged inside their launcher's entry
    const members = [head, ...items.filter((m) => m.display.variantOf != null && String(m.display.variantOf) === String(head.display.id))];
    const gained = new Set(); const lost = new Set();
    for (const m of members) {
      if (!liveKeys.has(m.key)) continue;
      const before = groupsOf(pL, m.key); const after = groupsOf(pD, m.key);
      for (const g of after) if (!before.has(g)) gained.add(g);
      for (const g of before) if (!after.has(g)) lost.add(g);
    }
    if (gained.size || lost.size) out.push({ key: head.key, kind: 'extras', gained: [...gained].sort(), lost: [...lost].sort() });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

module.exports = { extrasConsequences };
