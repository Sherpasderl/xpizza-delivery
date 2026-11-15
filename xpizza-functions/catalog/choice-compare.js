'use strict';
// S3 (PLAN-structure-S3-r3 §0, §1, §2) — THE structural judgment with the required-choice switch. Every site that judges a draft calls
// THIS instead of add-product.compareToActive (save: edit-catalog-handler; publish: publish-edited-handler; the manager request:
// structure-gate; the portal's draft assessment: draft-assess), with the restaurant id in front.
//   choiceEdit OFF → add-product.compareToActive(args): today's judgment, the same call, the same answer.
//   choiceEdit ON  → (1) the S3 delta is judged HERE: an option's text («{dish} - {choice}», ≤ 60, unique choice per group) and its
//                    «Recomendada» mark, a group's label and membership, options added under an EXISTING dish, a plain dish gaining (D2)
//                    or losing (D3) its group; (2) today's compareToActive judges EVERYTHING ELSE, on the draft with the S3 delta taken
//                    back to the live values (an S3 field copied from live, an option new under an existing dish set aside, the live
//                    variant map restored) — a removed option still leaves only through the reviewed deletion claim, a price is today's
//                    edit, and any other change refuses exactly as today; (3) the activation classifier (choice-activation) on the pair.
//   Returns compareToActive's { additions, removals }, the set-aside options added back to `additions`.
const AP = require('./add-product');
const { groupIndexFrom } = require('./group-index');
const { choiceActivation, TAG } = require('./choice-activation');

const NAME_MAX = 60;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (o) => JSON.parse(JSON.stringify(o));
const refuse = (code, detail, key = null, field = 'choices') => { throw new AP.AddProductError(code, detail, { status: 400, field, key }); };
const withoutMark = (tags) => (Array.isArray(tags) ? tags.filter((t) => t !== TAG) : []);
const chars = (s) => [...String(s)].length;

function compareToActive(rid, args0) {
  const args = { ...args0, extraRenames: require('./extra-identity').extraIdentityCapabilities().mintExtras };   // S2b §0: an extra rename (the dark switch) at every judgment site
  if (!require('./platform-structure').structureCapabilities().choiceEdit) return AP.compareToActive(args);
  const A = args.activeBuilt; const D = args.draftBuilt;
  const ia = groupIndexFrom(A); const id = groupIndexFrom(D);
  if (!ia.ok || !id.ok) throw new AP.AddProductError('choice_index_invalid', 'the choice groups cannot be read', { status: 409, field: 'choices' });
  const aItems = new Map(A.items.map((i) => [i.key, i]));
  const dItems = new Map(D.items.map((i) => [i.key, i]));
  const inGroup = (k) => ia.launchers.has(k) || ia.parentOf.has(k) || id.launchers.has(k) || id.parentOf.has(k);

  // (1) the S3 text rules, on every option of the TARGET whose text is new or changed
  const seen = new Map();   // launcher → folded choices
  for (const [v, l] of id.parentOf) {
    const o = dItems.get(v); const lr = dItems.get(l); const was = aItems.get(v);
    const choice = String((o.display || {}).choice || '');
    const folded = AP.normalizeName(choice);
    const set = seen.get(l) || new Set(); seen.set(l, set);
    if (set.has(folded)) refuse('choice_duplicate', `"${choice}" appears twice in this group`, v, 'choice');
    set.add(folded);
    const name = `${lr.display.name} - ${choice}`;
    if (o.display.name !== name) refuse('choice_name_not_derived', `an option's name is derived ("${name}")`, v, 'name');
    if ((!was || (was.display || {}).name !== name) && chars(name) > NAME_MAX) refuse('option_name_too_long', `the option's full name "${name}" is over ${NAME_MAX} characters`, v, 'choice');
  }

  // (2) today's judgment on the draft minus the S3 delta
  const Dp = clone(D);
  const setAside = new Set();
  for (const [v, l] of id.parentOf) if (!aItems.has(v) && aItems.has(l)) setAside.add(v);   // a new option under an EXISTING dish
  Dp.items = Dp.items.filter((i) => !setAside.has(i.key));
  if (Dp.structure && Array.isArray(Dp.structure.item_order)) Dp.structure.item_order = Dp.structure.item_order.filter((k) => !setAside.has(k));
  for (const it of Dp.items) {
    const a = aItems.get(it.key);
    if (!a || !inGroup(it.key) || !isObj(it.display) || !isObj(a.display)) continue;
    if (AP.sameJson(withoutMark(it.display.tags), withoutMark(a.display.tags))) {
      if (a.display.tags === undefined) delete it.display.tags; else it.display.tags = clone(a.display.tags);
    }
    if (id.parentOf.has(it.key) && ia.parentOf.has(it.key)) {
      for (const f of ['choice', 'name']) { if (a.display[f] === undefined) delete it.display[f]; else it.display[f] = a.display[f]; }
    }
  }
  const avi = isObj(A.structure.variant_items) ? A.structure.variant_items : undefined;
  const dvi = isObj(D.structure.variant_items) ? D.structure.variant_items : {};
  const keyOfDraftId = new Map(D.items.map((i) => [String(i.display && i.display.id), i.key]));
  const restored = avi ? clone(avi) : {};
  for (const [lid, spec] of Object.entries(dvi)) if (!aItems.has(keyOfDraftId.get(String(lid)))) restored[lid] = clone(spec);   // a whole NEW group: today's rule
  if (avi || Object.keys(restored).length) Dp.structure.variant_items = restored; else delete Dp.structure.variant_items;
  const r = AP.compareToActive({ ...args, draftBuilt: Dp });

  // (3) the activation classifier on the real pair
  choiceActivation({ rid, baseline: A, target: D, choiceEdit: true });
  return { additions: [...r.additions, ...[...setAside].filter((k) => !r.additions.includes(k))], removals: r.removals };
}

/* The save's allocation of options NEW under an EXISTING dish (option.add, D2): add-product's group preparation owns only whole NEW
   groups, so these rows are prepared here, IN PLACE on the allocator's working copy, BEFORE allocation (an option's key derives from
   its full name) — the same derived fields and the same text rules: the choice (tidied, required, the validator's sinks), the full
   name «{dish} - {choice}», the dish's section / subsection / extras setting, and a group label that is required and safe. Returns the
   Set of their refs; add-product's group preparation skips exactly those. Called only with choiceEdit ON. */
function prepareExistingGroups(source, { fieldProblem = () => null } = {}) {
  const out = new Set();
  const st = isObj(source.structure) ? source.structure : {};
  const vi = isObj(st.variant_items) ? st.variant_items : {};
  const items = Array.isArray(source.items) ? source.items : [];
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  for (const [lid, spec] of Object.entries(vi)) {
    const l = items.find((it) => isObj(it) && !has(it, 'ref') && isObj(it.display) && String(it.display.id) === String(lid));
    if (!l || !isObj(spec) || !Array.isArray(spec.variantIds)) continue;   // a whole NEW group (tmp launcher) is add-product's
    const fresh = spec.variantIds.filter((v) => typeof v === 'string' && AP.TMP_RE.test(v));
    if (!fresh.length) continue;
    const label = typeof spec.label === 'string' ? AP.tidyName(spec.label) : '';
    if (!label) refuse('label_required', 'a choice group needs a name (e.g. "Tamaño")', l.key, 'label');
    const lWhy = fieldProblem('label', label);
    if (lWhy) refuse('text_unsafe', `the group name ${lWhy}`, l.key, 'label');
    spec.label = label;
    const policy = has(l.display, 'extras_policy') ? l.display.extras_policy : undefined;
    for (const ref of fresh) {
      const v = items.find((it) => isObj(it) && it.ref === ref);
      if (!v || !isObj(v.display) || String(v.display.variantOf) !== String(lid)) refuse('addition_malformed', `option ${JSON.stringify(ref)} is not a new option of this group`, l.key);
      const choice = typeof v.display.choice === 'string' ? AP.tidyName(v.display.choice) : '';
      if (!choice) refuse('choice_label_required', 'every option needs a name', ref, 'choice');
      const cWhy = fieldProblem('choice', choice);
      if (cWhy) refuse('text_unsafe', `the option ${cWhy}`, ref, 'choice');
      const name = AP.optionName(AP.tidyName(l.display.name), choice);
      const nWhy = fieldProblem('name', name);
      if (nWhy) refuse('text_unsafe', `the option's full name "${name}" ${nWhy}`, ref, 'choice');
      const rest = { ...v.display }; for (const f of ['name', 'cat', 'subcat', 'extras_policy', 'choice']) delete rest[f];
      v.display = { ...rest, name, cat: l.display.cat, ...(has(l.display, 'subcat') ? { subcat: l.display.subcat } : {}), ...(policy !== undefined ? { extras_policy: policy } : {}), choice };
      out.add(ref);
    }
  }
  return out;
}

module.exports = { compareToActive, prepareExistingGroups };
