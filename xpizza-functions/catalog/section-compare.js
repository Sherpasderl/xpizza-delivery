'use strict';
// S4 (PLAN-structure-S4-r4 §1.1–1.7, R2.2/R3.1, R3.2, R3.7, R4.1) — THE structural judgment with the SECTIONS switch, innermost under
// choice-compare (S0-2: choice-compare.js calls this at both of its add-product edges; the four judgment sites are unchanged).
//   sections OFF → add-product.compareToActive(args): today's judgment, the same call, the same answer.
//   sections ON  → (1) the S4 delta is judged HERE: new categories (id, name, shape), no live category removed or otherwise changed,
//                  subcats (names, caps, renames at their index rewriting every member; never removed), the caps, the all-or-none
//                  names guard, and a new category in an AUTHORED map (R3.2); (2) today's compareToActive judges EVERYTHING ELSE on the
//                  draft with the S4 delta reverted to live: categories back to live's order / fields / subcats (live names kept — T1's
//                  rename rule still judges them), item_order back to «live order, new keys appended», the move-derived extras-map
//                  projection restored when exactly that (R4.1); with every DECLARED category authorized as renderable (R3.1).
// Throws AddProductError; returns compareToActive's { additions, removals }.
const AP = require('./add-product');

const CATEGORIES_MAX = 30; const SUBCATS_MAX = 12; const NAME_MAX = 40;
const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const NEW_FIELDS = new Set(['id', 'name', 'subcats']);
const AUTHORED_CATEGORY_LISTS = ['weekend_only_cats', 'pickup_only_cats', 'redeem_eligible_cats'];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const clone = (o) => JSON.parse(JSON.stringify(o));
const chars = (s) => [...String(s)].length;
const refuse = (code, detail, { status = 400, field = 'categories', key = null } = {}) => { throw new AP.AddProductError(code, detail, { status, field, key }); };
const catsOf = (b) => (isObj(b.structure) && Array.isArray(b.structure.categories) ? b.structure.categories : []);
const stagedOf = (b) => (isObj(b.structure) && Array.isArray(b.structure.staged_categories) ? b.structure.staged_categories : []);   // §1.2 (shape: staged-categories.js via validateSource)
const without = (o, ks) => { const c = JSON.parse(JSON.stringify(o)); for (const k of ks) delete c[k]; return c; };

function judgeCategories(A, D) {
  const ac = catsOf(A); const dc = catsOf(D);
  const aById = new Map(ac.map((c) => [c.id, c]));
  const dIds = new Set(dc.map((c) => c.id));
  for (const c of ac) if (!dIds.has(c.id)) refuse('structure_changed', `the section ${JSON.stringify(c.id)} cannot be removed`);
  const ds = stagedOf(D);
  if (dc.length + ds.length > CATEGORIES_MAX) refuse('structure_caps', `at most ${CATEGORIES_MAX} sections (staged ones included)`);
  const newIds = ds.map((e) => e.id);   // a staged category is never live
  const folded = new Set(ds.filter(isObj).map((e) => AP.normalizeName(e.name)));
  for (const c of dc) {
    if (!isObj(c)) refuse('structure_changed', 'a section is malformed');
    const live = aById.get(c.id);
    if (live) {
      // a live category: only its name (T1, judged by today's compare) and its subcats (below) may change
      if (!AP.sameJson(without(c, ['name', 'subcats']), without(live, ['name', 'subcats']))) refuse('structure_changed', `the section ${JSON.stringify(c.id)} cannot change that way`);
    } else {
      newIds.push(c.id);
      if (typeof c.id !== 'string' || !ID_RE.test(c.id)) refuse('category_id_invalid', `a new section's id ${JSON.stringify(c.id)} is not valid`, { key: String(c.id) });
      for (const k of Object.keys(c)) if (!NEW_FIELDS.has(k)) refuse('structure_changed', `a new section cannot carry ${JSON.stringify(k)}`, { key: c.id });
      const name = typeof c.name === 'string' ? AP.tidyName(c.name) : '';
      if (!name) refuse('category_name_required', 'a new section needs a name', { key: c.id, field: 'name' });
      if (chars(name) > NAME_MAX) refuse('category_name_too_long', `a section name is at most ${NAME_MAX} characters`, { key: c.id, field: 'name' });
    }
    if (typeof c.name === 'string' && c.name) {
      const f = AP.normalizeName(c.name);
      if (folded.has(f)) refuse('category_name_taken', `«${c.name}» is already a section`, { key: c.id, field: 'name' });
      folded.add(f);
    }
    judgeSubcats(A, D, c, live);
  }
  if (newIds.length && ac.some((c) => !(typeof c.name === 'string' && c.name))) {
    refuse('categories_unnamed', 'name your sections before adding a new one', { status: 409 });
  }
  return { newIds, declared: dc.map((c) => c.id) };
}

// subcats: names ≤ 40, unique case-folded within the category, ≤ 12; a live subcat never disappears — a rename is a new name with EVERY
// member that stayed in the category rewritten to it, paired by members (subcatRenames; Q3 name-as-identity, Q6 no deletes)
function judgeSubcats(A, D, c, live) {
  const ds = Array.isArray(c.subcats) ? c.subcats : [];
  const ls = live && Array.isArray(live.subcats) ? live.subcats : [];
  if (ds.length > SUBCATS_MAX) refuse('structure_caps', `at most ${SUBCATS_MAX} subsections in a section`, { key: c.id, field: 'subcats' });
  const seen = new Set();
  for (const s of ds) {
    if (!ls.includes(s) && chars(String(s).trim()) > NAME_MAX) refuse('subcat_name_too_long', `a subsection name is at most ${NAME_MAX} characters`, { key: c.id, field: 'subcats' });
    const f = AP.normalizeName(String(s));
    if (seen.has(f)) refuse('subcat_name_taken', `«${s}» is already a subsection here`, { key: c.id, field: 'subcats' });
    seen.add(f);
  }
  const renames = subcatRenames(A, D, c.id, ls, ds);
  for (const x of ls) if (!ds.includes(x) && !renames.has(x)) refuse('subcat_removed', `the subsection «${x}» cannot be removed`, { key: c.id, field: 'subcats' });
}

/* The ONE subsection-rename pairing (section-compare, review-diff, structure-budget): Map(old name → new name) for a category whose live
   subcats `ls` became `ds`. A live name x that left `ds` is RENAMED to y when every live member of x that stayed in the category now
   carries y, a name new to the category (Q3 name-as-identity, members rewritten) — paired by MEMBERS, so a rename may also move. Two live
   names claiming one y is ambiguous: neither is paired. A live name with NO member left in the category keeps the index rule (ds[idx], when
   new and unclaimed). Unpaired ⇒ removed (the judgment refuses subcat_removed). */
function subcatRenames(A, D, catId, ls, ds) {
  const dItems = new Map((D.items || []).map((i) => [i.key, i]));
  const fresh = ds.filter((y) => !ls.includes(y));
  const claims = new Map(); const vacuous = [];
  ls.forEach((x, idx) => {
    if (ds.includes(x)) return;
    const stayed = (A.items || []).filter((i) => i.display && i.display.cat === catId && i.display.subcat === x)
      .map((i) => dItems.get(i.key)).filter((d) => d && d.display && d.display.cat === catId);
    if (!stayed.length) { vacuous.push([x, idx]); return; }
    const y = stayed[0].display.subcat;
    if (fresh.includes(y) && stayed.every((d) => d.display.subcat === y)) claims.set(y, [...(claims.get(y) || []), x]);
  });
  const out = new Map();
  for (const [y, xs] of claims) if (xs.length === 1) out.set(xs[0], y);
  const taken = new Set([...claims.keys()]);
  for (const [x, idx] of vacuous) { const y = ds[idx]; if (typeof y === 'string' && fresh.includes(y) && !taken.has(y)) { out.set(x, y); taken.add(y); } }
  return out;
}

// R3.2: a NEW (non-live) category may enter no AUTHORED category reference; the derived extras maps are not guarded here (S2's claim)
function judgeAuthoredRefs(D, newIds) {
  if (!newIds.length) return;
  const st = D.structure || {}; const fresh = new Set(newIds);
  const allow = isObj(st.exposure) && isObj(st.exposure.category_allow) ? Object.keys(st.exposure.category_allow) : [];
  const hit = (list) => list.find((id) => fresh.has(id));
  if (hit(allow)) refuse('section_not_attachable_yet', 'a new section cannot take extras yet', { status: 409, field: 'exposure', key: hit(allow) });
  for (const f of AUTHORED_CATEGORY_LISTS) {
    const l = Array.isArray(st[f]) ? st[f] : [];
    if (hit(l)) refuse('section_not_attachable_yet', 'a new section cannot carry that setting yet', { status: 409, field: f, key: hit(l) });
  }
}

// R4.1: the draft's extras maps differ from live's ONLY as the projection of a membership change → restored to live's in the judged copy
function claimMoveProjection(A, D, Dp) {
  const as = A.structure || {}; const ds = D.structure || {};
  const maps = ['extras_by_category', 'extras_by_item'];
  if (maps.every((f) => AP.sameJson(ds[f], as[f]))) return;
  if (!AP.sameJson(ds.exposure, as.exposure)) return;   // (1) no authored attachment changed
  const { projectExtrasMaps } = require('./extras-projection');
  const pa = projectExtrasMaps({ items: A.items, extras: A.extras, structure: as });
  const pd = projectExtrasMaps({ items: D.items, extras: D.extras, structure: ds });
  const eq = (s, p) => AP.sameJson(s.extras_by_category || {}, p.byCategory) && AP.sameJson(s.extras_by_item || {}, p.byItem);
  if (!eq(as, pa) || !eq(ds, pd)) return;   // (2) live's and (3) the draft's maps ARE the real projector's
  for (const f of maps) { if (has(as, f)) Dp.structure[f] = clone(as[f]); else delete Dp.structure[f]; }
}

function compareToActive(args) {
  if (!require('./platform-structure').structureCapabilities().sections) {
    // Codex #231 P2: OFF, add-product's residual accounting skips a structure field the draft does not author, so a stored draft that
    // DROPS the staged_categories a sections-ON publish left live escaped every comparison (200, an empty review diff). The gap is the
    // key's ABSENCE only — a draft that keeps the key is judged below (a changed value: structure_unexplained, STG-OFF-VALUE) — so
    // ONE check: the active version carries the key and the draft does not ⇒ the same structure_changed a normal save's deletion
    // gets (assertSameAuthoredFields). Active without the key: today's path, unchanged.
    if (has(args.activeBuilt && args.activeBuilt.structure, 'staged_categories') && !has(args.draftBuilt && args.draftBuilt.structure, 'staged_categories')) {
      refuse('structure_changed', "the menu's staged_categories cannot be removed while sections are off", { field: 'staged_categories' });
    }
    return AP.compareToActive(args);
  }
  const A = args.activeBuilt; const D = args.draftBuilt;
  const { newIds, declared } = judgeCategories(A, D);
  judgeAuthoredRefs(D, newIds);
  // Q8: a LIVE rename publishes alone. The reverted copy below hides the S4 delta from today's rename_not_alone, so it is judged here, with
  // the ONE definition of an S4 op the review uses (review-diff s4OpPresent)
  const dNames = new Map(catsOf(D).map((c) => [c.id, c.name === undefined ? null : c.name]));
  const renamedLive = catsOf(A).some((c) => dNames.has(c.id) && (c.name === undefined ? null : c.name) !== dNames.get(c.id));
  if (renamedLive && require('./review-diff').s4OpPresent(A, D)) refuse('rename_not_alone', 'a section rename must be published on its own, with no other change');

  const Dp = clone(D);
  const dById = new Map(catsOf(D).map((c) => [c.id, c]));
  Dp.structure.categories = catsOf(A).map((c) => {
    const out = clone(c); const d = dById.get(c.id);
    if (d && has(d, 'name')) out.name = d.name; else delete out.name;
    return out;
  });
  const aOrder = (A.structure && A.structure.item_order) || [];
  const dKeys = new Set(D.items.map((i) => i.key));
  const aKeys = new Set(aOrder);
  Dp.structure.item_order = [...aOrder.filter((k) => dKeys.has(k)), ...((D.structure && D.structure.item_order) || []).filter((k) => !aKeys.has(k))];
  claimMoveProjection(A, D, Dp);
  if (has(A.structure, 'staged_categories')) Dp.structure.staged_categories = clone(A.structure.staged_categories); else delete Dp.structure.staged_categories;   // judged above
  const renderedCategories = [...new Set([...(args.renderedCategories || []), ...declared])];
  return AP.compareToActive({ ...args, draftBuilt: Dp, renderedCategories });
}

module.exports = { compareToActive, subcatRenames, CATEGORIES_MAX, SUBCATS_MAX, NAME_MAX, ID_RE };
