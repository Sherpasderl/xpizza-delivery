// S4 (PLAN-structure-S4-r4 R3.5, R3.3/R4.2; advisor 11-13 rule 4: ONE source) — the two derivations the server and the portal must
// agree on for menu SECTIONS, in one module:
//   categorySlug(name, takenIds)        the id a NEW category gets: NFKD → strip marks → lowercase → runs outside [a-z0-9] → '_' →
//                                       trim '_'; empty → 'cat'; a digit-leading base → 'c_' + base; cut to 32 (trailing '_' trimmed);
//                                       on collision with takenIds: '_2', '_3', … with the base cut to 32 − len(suffix). Always ≤ 32.
//   allocateCategoryIds(names, taken)   several new categories in one save: in order, each against taken + the ids already allocated
//   promotedOrder(categories, promoted) where staged categories land in the save that moves their first dish: `categories` is the
//                                       candidate's order WITHOUT the ids promoted in this save; `promoted` = [{ id, after }] in the
//                                       stored staged-array order. Each lands right after its anchor's current position (+ r, its rank
//                                       among this save's promotions from the same anchor); a null anchor = first; an anchor not in the
//                                       list is appended at the end in staged order (defensive).
// The SERVER re-derives (edit-preflight, new ids only) and re-verifies (staged_promotion_mismatch) with these; the portal's S4 writer
// only previews with the byte copy written by tools/sync-client.js (catalog/section-transitions-sync.guard.test.js).
// UMD-lite (the choice-transitions.js pattern): CommonJS here, a global in the portal's classic script. Pure; never mutates its input.

(function (root) {
  const MAX = 32;
  const trimUnderscore = (s) => s.replace(/^_+|_+$/g, '');

  function baseSlug(name) {
    let b = String(name == null ? '' : name).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    b = trimUnderscore(b);
    if (!b) b = 'cat';
    if (/^[0-9]/.test(b)) b = `c_${b}`;
    return trimUnderscore(b.slice(0, MAX));
  }

  function categorySlug(name, takenIds) {
    const taken = new Set(takenIds || []);
    const base = baseSlug(name);
    if (!taken.has(base)) return base;
    for (let k = 2; ; k += 1) {
      const suffix = `_${k}`;
      const id = `${trimUnderscore(base.slice(0, MAX - suffix.length))}${suffix}`;
      if (!taken.has(id)) return id;
    }
  }

  function allocateCategoryIds(names, takenIds) {
    const taken = new Set(takenIds || []);
    const out = [];
    for (const name of names || []) { const id = categorySlug(name, taken); taken.add(id); out.push(id); }
    return out;
  }

  function promotedOrder(categories, promoted) {
    const list = Array.isArray(categories) ? categories.slice() : [];
    const present = new Set(list);
    const byAnchor = new Map(); const missing = [];
    for (const p of promoted || []) {
      const a = p.after == null ? null : p.after;
      if (a !== null && !present.has(a)) { missing.push(p.id); continue; }
      if (!byAnchor.has(a)) byAnchor.set(a, []);
      byAnchor.get(a).push(p.id);
    }
    const out = [...(byAnchor.get(null) || [])];
    for (const id of list) { out.push(id); if (byAnchor.has(id)) out.push(...byAnchor.get(id)); }
    return [...out, ...missing];
  }

  const api = { categorySlug, allocateCategoryIds, promotedOrder, MAX_ID: MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SectionTransitions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
