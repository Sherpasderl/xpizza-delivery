'use strict';
// S2-2 (D4c-grill/item-s1/S2-DESIGN.md §2 r1 F; advisor ruling 2026-11-10) — THE MOVE RULES, pure. The two catalog rules a
// category move can break, stated once for the save/publish preflight, so the merchant's drawer gets a TYPED, field-tagged
// refusal before the validator's untagged one:
//   COVERAGE  (validateSource, catalog/source-store.js «SUBCATEGORY COVERAGE»): a dish in a section that groups by subsections
//             needs one of its declared subsections; a dish in a section without subsections has none.
//   EMPTINESS (validateSource, its reverse-coverage block): a declared section, or a declared subsection, with no dish in it.
// The messages are the validator's own, byte for byte. source-store.js is pinned and stays untouched; the two are held equal by
// catalog/move-rules-parity.test.js, which runs the REAL validator over every single-product move of both real sources plus
// crafted cases, and enumerates the validator's coverage/emptiness reasons from its source so a new one turns it red.

// coverage of one dish → null | { reason, text } (text = the validator's message after «{rid}/{key} — »)
function coverageProblem(categories, item) {
  const d = item && item.display ? item.display : {};
  const c = (Array.isArray(categories) ? categories : []).find((x) => x && x.id === d.cat);
  const declared = c && Array.isArray(c.subcats) ? c.subcats : null;
  const sub = d.subcat;
  if (declared && declared.length) {
    if (sub == null) return { reason: 'subcat_missing', text: `category ${d.cat} groups by subcategory, so an item without a subcat would not render at all` };
    if (!declared.includes(sub)) return { reason: 'subcat_undeclared', text: `subcat ${sub} is not declared by category ${d.cat}, so the item would not render at all` };
  } else if (sub != null) {
    return { reason: 'subcat_none_declared', text: `declares subcat ${sub} but category ${d.cat} declares no subcategories` };
  }
  return null;
}

// emptiness of the declared sections → [{ reason, cat, sub?, text }] in the validator's order (text = after «{rid} — »)
function emptinessProblems(categories, items) {
  const out = [];
  const list = Array.isArray(items) ? items : [];
  const used = new Set(list.map((i) => i && i.display && i.display.cat));
  for (const c of Array.isArray(categories) ? categories : []) {
    if (!used.has(c.id)) out.push({ reason: 'section_empty', cat: c.id, text: `category ${c.id} is declared but no dish is in it (it would render an empty section)` });
    if (!Array.isArray(c.subcats)) continue;
    const usedSubs = new Set(list.filter((i) => i && i.display && i.display.cat === c.id).map((i) => i.display.subcat));
    for (const sc of c.subcats) {
      if (!usedSubs.has(sc)) out.push({ reason: 'subsection_empty', cat: c.id, sub: sc, text: `category ${c.id} declares subcategory ${sc} but no dish is in it (it would render an empty heading)` });
    }
  }
  return out;
}

// The validator's FIRST coverage/emptiness failure for a source, in its own order (coverage per dish, then emptiness), as the
// message it would throw — or null. The parity guard compares exactly this against validateSource.
function firstMoveFailure(rid, source) {
  const cats = source && source.structure && source.structure.categories;
  for (const it of (source && Array.isArray(source.items)) ? source.items : []) {
    const p = coverageProblem(cats, it);
    if (p) return { ...p, key: it.key, message: `${rid}/${it.key} — ${p.text}` };
  }
  const e = emptinessProblems(cats, source && source.items)[0];
  return e ? { ...e, message: `${rid} — ${e.text}` } : null;
}

module.exports = { coverageProblem, emptinessProblems, firstMoveFailure };
