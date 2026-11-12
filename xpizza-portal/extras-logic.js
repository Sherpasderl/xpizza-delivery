// STRUCTURE S2 — the «Extras» page's MODEL (PLAN-portal-structure-S2-ui r3 §2 items 2–3; MOCKUP-portal-structure-edit frame X). Pure:
// a reader of the draft, never a writer (every Extras-page write goes through editor.js applyExposureOps / setExtraPrice).
//   rail    every group in the ONE order (structure.extra_categories), its extras count, «en N productos» = the SERVER's reach rule
//           (catalog/review-diff.js: the launchers whose EFFECTIVE groups include it — 5f's writer's effectiveGroups over THE ONE
//           eligibility projection, the portal's byte copies)
//   detail  the selected group's rows — a published extra by { key }, a new (keyless) one by { ref } with «Nuevo», a changed price
//           marked, an extra removed in this draft still listed (greyed, «Se quita al publicar») — its count, reach and shared warning
// Names are TEXT in S2-core (renames come with S2b).
import { draftSource } from './editor.js';

const groupsOf = (src) => (src && src.structure && Array.isArray(src.structure.extra_categories) ? src.structure.extra_categories.map(String) : []);
const extrasOf = (src) => (src && Array.isArray(src.extras) ? src.extras.filter((e) => e && e.display) : []);
const idOf = (e) => (typeof e.key === 'string' ? { key: e.key } : { ref: e.ref });

// group → the number of launchers it is offered on (null when the shared evaluator / writer is not loaded: nothing is guessed)
function reachOf(src) {
  const E = globalThis.ExtrasEligibility, X = globalThis.ExposureTransitions;
  if (!E || typeof E.projectEligibility !== 'function' || !X || typeof X.effectiveGroups !== 'function') return null;
  try {
    const P = E.projectEligibility(src), eff = X.effectiveGroups(P), out = new Map();
    for (const [k, gs] of Object.entries(eff)) {
      if (P.items[k].launcherKey || !Array.isArray(gs)) continue;
      for (const g of gs) out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  } catch (_) { return null; }
}

export function extrasPageModel(draft, { group = null } = {}) {
  const src = draftSource(draft), orig = draft && draft.orig;
  const groups = groupsOf(src);
  const reach = reachOf(src);
  const xs = extrasOf(src);
  const rail = groups.map((g) => ({ group: g, count: xs.filter((e) => String(e.display.cat) === g).length, reach: reach ? (reach.get(g) || 0) : null }));
  const selected = groups.includes(group) ? group : (groups[0] || null);
  let detail = null;
  if (selected !== null) {
    const was = new Map(extrasOf(orig).filter((e) => typeof e.key === 'string').map((e) => [e.key, e]));
    const rows = xs.filter((e) => String(e.display.cat) === selected).map((e) => {
      const isNew = typeof e.key !== 'string';
      const before = isNew ? null : was.get(e.key);
      return { id: idOf(e), name: e.display.name, price: e.price, isNew, priceChanged: !!before && before.price !== e.price, removed: false };
    });
    const present = new Set(xs.filter((e) => typeof e.key === 'string').map((e) => e.key));
    for (const e of was.values()) {
      if (String(e.display.cat) !== selected || present.has(e.key)) continue;
      rows.push({ id: { key: e.key }, name: e.display.name, price: e.price, isNew: false, priceChanged: false, removed: true });
    }
    const n = reach ? (reach.get(selected) || 0) : null;
    detail = { group: selected, rows, count: rows.filter((r) => !r.removed).length, reach: n, shared: n !== null && n > 1 };
  }
  return { rail, selected, detail };
}
