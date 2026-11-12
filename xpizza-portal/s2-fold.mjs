// STRUCTURE S2 (PLAN-portal-structure-S2-ui r3, APPROVED 2026-11-11): the slice's EXACT hunks, [now, was] per file, cut against
// S2_BASE (S1 99477204 + 5f's S2-core, the merge it is built on). Folded out FIRST by portalui-guards (the newest layer, above S1),
// so S1 and every older pin judge exactly what they judged before. Regenerated only from the change's diff
// (D4c-grill/review-portal/structure-s2/gen_s2_fold.py); an edit outside these hunks, or inside one, fails.
export const S2_BASE = '88474830';
export const S2_FOLD = {
 "app.js": [
  [
   "  // STRUCTURE S2 (§3.2): «Guardar» swaps in the composed document (the writer returns a new one), so the list is re-derived from\n  // the draft — never painted from row objects the swap replaced\n  repaintFromDraft();\n",
   "  paint(); refreshBar();\n"
  ]
 ],
 "editor.js": [
  [
   "const rowMatches = (r, id) => (id && typeof id === 'object'\n  ? (typeof id.key === 'string' ? r.key === id.key : (typeof id.ref === 'string' && typeof r.key !== 'string' && r.ref === id.ref))\n  : r.key === id);\n",
   ""
  ],
  [
   "  const row = rowsOf(draft.state, surface).find((r) => r && rowMatches(r, key));\n",
   "  const row = rowsOf(draft.state, surface).find((r) => r && r.key === key);\n"
  ],
  [
   "// STRUCTURE S2 (PLAN-portal-structure-S2-ui r3 §3.3): an extra by its key (a string, S1's callers, or { key }) OR — a new one the\n// server has not allocated yet — by { ref }, which matches ONLY a keyless row (the writer's own predicate, exposure-transitions.js\n// extra.remove); a new row never gets a key, id or stamp here\nexport const setExtraPrice = (draft, id, raw) => setPrice(draft, 'extra', id, raw);\n",
   "export const setExtraPrice = (draft, key, raw) => setPrice(draft, 'extra', key, raw);\n"
  ],
  [
   "  + pendingTexts(draft).reduce((n, t) => n + t.fields.length, 0) + pendingDishExtras(draft).reduce((n, t) => n + t.fields.length, 0)\n  + pendingStructure(draft).length;\n",
   "  + pendingTexts(draft).reduce((n, t) => n + t.fields.length, 0) + pendingDishExtras(draft).reduce((n, t) => n + t.fields.length, 0);\n"
  ],
  [
   "// The section an edit moves a product to (a section change without a subsection clears it), and the move itself: the product\n// and every option move together. One rule for editItem and the drawer's composition (S2 §3.2).\nfunction resolveMove(d, e) {\n  const moving = own(e, 'cat') || own(e, 'subcat');\n  const cat = own(e, 'cat') ? e.cat : d.cat;\n  const subcat = own(e, 'subcat') ? (e.subcat == null || e.subcat === '' ? null : String(e.subcat)) : (own(e, 'cat') && String(e.cat) !== String(d.cat) ? null : (d.subcat == null ? null : d.subcat));\n  return { moving, cat, subcat };\n}\nfunction writeMove(members, cat, subcat) {\n  for (const r of members) { r.display.cat = cat; if (subcat == null) delete r.display.subcat; else r.display.subcat = subcat; }\n}\n",
   ""
  ],
  [
   "  const { moving, cat, subcat } = resolveMove(d, e);\n",
   "  const moving = own(e, 'cat') || own(e, 'subcat');\n  const cat = own(e, 'cat') ? e.cat : d.cat;\n  const subcat = own(e, 'subcat') ? (e.subcat == null || e.subcat === '' ? null : String(e.subcat)) : (own(e, 'cat') && String(e.cat) !== String(d.cat) ? null : (d.subcat == null ? null : d.subcat));\n"
  ],
  [
   "  if (moving) writeMove([row, ...opts], cat, subcat);\n",
   "  if (moving) {\n    for (const r of [row, ...opts]) { r.display.cat = cat; if (subcat == null) delete r.display.subcat; else r.display.subcat = subcat; }\n  }\n"
  ],
  [
   "\n// ── STRUCTURE S2 — THE EXTRAS PAGE'S WRITES (PLAN-portal-structure-S2-ui r3, APPROVED 2026-11-11) ───────────────────────────\n// ONE writer: 5f's catalog/exposure-transitions.js, byte-copied to xpizza-portal/exposure-transitions.js (tools/sync-client.js) and\n// loaded as a classic script after extras-eligibility.js (the ExposureTransitions global). Nothing below edits exposure, the group\n// order or the extras rows by hand.\nconst writer = () => globalThis.ExposureTransitions;\nconst refusedBy = (err) => ({ ok: false, code: (err && err.code) || 'unknown_op', ...((err && err.detail) || {}) });\n// §3.1 — the one mutator: an ORDERED op list folded through the writer on ONE copy; any refusal leaves the draft untouched (no\n// half-applied list); success replaces the draft's document. Only with the server's switch (getEditableCatalog extrasCatalog).\n// The removal claim (§3.4, bound to the served baseline) lands with that step, after the advisor's ruling on portal-wiring\n// RULING A; until then nothing here reads the writer's removal output.\nexport function applyExposureOps(draft, ops, { extrasCatalog = false } = {}) {\n  if (extrasCatalog !== true) return { ok: false, code: 'extras_catalog_off' };\n  if (!canEditContent(draft)) return { ok: false, code: 'not_editable' };\n  if (!writer() || typeof writer().apply !== 'function') return { ok: false, code: 'writer_unavailable' };\n  if (!Array.isArray(ops) || !ops.length) return { ok: false, code: 'unknown_op' };\n  let cur = draft.state;\n  try { for (const op of ops) cur = writer().apply(cur, op).source; }\n  catch (err) { return refusedBy(err); }\n  draft.state = cur;\n  return { ok: true };\n}\n// §3.2 — the drawer's ONE composition, for the preview (strict: false — what the copy WOULD save, a move not yet valid included)\n// and the commit (strict: true — every field judged by the editor's rules). Never writes `draft`:\n//   1. «Sin extras» OFF first (an attach needs a dish that offers extras);\n//   2. the prospective MOVE (section / subsection) — before any exposure op (Codex S2 plan r2 #4);\n//   3. the copy's attach / detach ops, in order, through the writer, on the moved copy;\n//   4. the rest (text, price, photo, the checklist, «Sin extras» ON) through editItem, the checklist judged against THAT prospect.\n// → { ok: true, source } | { ok: false, code, … }. (attach / detach never remove an extra.)\nexport function composeDish(draft, key, edit = {}, ops = [], { reserved = null, extrasAuthoring = false, extrasCatalog = false, strict = true } = {}) {\n  if (strict && !canEditContent(draft)) return { ok: false, code: 'not_editable' };\n  if (!Array.isArray(ops) || ops.some((o) => !o || (o.op !== 'attach.item' && o.op !== 'detach.item'))) return { ok: false, code: 'unknown_op' };\n  if (ops.length && extrasCatalog !== true) return { ok: false, code: 'extras_catalog_off' };\n  if (ops.length && (!writer() || typeof writer().apply !== 'function')) return { ok: false, code: 'writer_unavailable' };\n  const row = existingRow(draft.state, key);\n  if (!row || !row.display) return { ok: false, code: 'unknown_item' };\n  const e = { ...(edit && typeof edit === 'object' ? edit : {}) };\n  // a scratch draft: the commit judges names against what was loaded; the preview has no rename to hold\n  const scratch = createDraft(clone(draft.state));\n  scratch.orig = clone(strict ? draft.orig : draft.state);\n  if (own(e, 'extrasPolicy') && e.extrasPolicy === null) {\n    if (!editItem(scratch, key, { extrasPolicy: null }, { extrasAuthoring })) return { ok: false, code: 'invalid', field: 'extrasPolicy' };\n    delete e.extrasPolicy;\n  }\n  const mv = resolveMove(row.display, e);\n  if (mv.moving) {\n    if (strict && itemCategoryProblem(draft, key, { cat: mv.cat, subcat: mv.subcat }) !== null) return { ok: false, code: 'invalid', field: 'cat' };\n    const sr = existingRow(scratch.state, key);\n    writeMove([sr, ...membersOf(scratch.state, sr)], mv.cat, mv.subcat);\n    delete e.cat; delete e.subcat;\n  }\n  if (ops.length) {\n    let cur = scratch.state;\n    try { for (const op of ops) cur = writer().apply(cur, { op: op.op, item: key, group: op.group }).source; }\n    catch (err) { return refusedBy(err); }\n    scratch.state = cur;\n  }\n  if (Object.keys(e).length && !editItem(scratch, key, e, { reserved, extrasAuthoring })) return { ok: false, code: 'invalid' };\n  return { ok: true, source: scratch.state };\n}\n// «Guardar» on the drawer: the strict composition, swapped in ONCE (all or nothing).\nexport function commitDish(draft, key, edit, ops, opts = {}) {\n  const r = composeDish(draft, key, edit, ops, { ...opts, strict: true });\n  if (!r.ok) return r;\n  draft.state = r.source;\n  return { ok: true };\n}\n// §3.6 — the exposure and order work this draft holds against what it loaded: the group ORDER (the same groups, another order;\n// a new or removed group is its extras rows' pending work), each section's offered groups, each dish's own add / deny (its\n// checklist and «Sin extras» are S1's lines, never counted twice). → [{ kind: 'order' } | { kind: 'category', cat } |\n// { kind: 'dish', key }].\nexport function pendingStructure(draft) {\n  const out = [];\n  const st = (src) => (src && src.structure) || {};\n  const a = st(draft.orig), b = st(draft.state);\n  const ga = Array.isArray(a.extra_categories) ? a.extra_categories : [], gb = Array.isArray(b.extra_categories) ? b.extra_categories : [];\n  if (ga.length === gb.length && ga.every((g) => gb.includes(g)) && ga.some((g, i) => g !== gb[i])) out.push({ kind: 'order' });\n  const xa = a.exposure || {}, xb = b.exposure || {};\n  const ca = xa.category_allow || {}, cb = xb.category_allow || {};\n  for (const c of [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort()) if (JSON.stringify(ca[c] || []) !== JSON.stringify(cb[c] || [])) out.push({ kind: 'category', cat: c });\n  const oa = xa.item_overrides || {}, ob = xb.item_overrides || {};\n  const own2 = (o) => { if (!o || typeof o !== 'object') return '{}'; const r = {}; for (const k of Object.keys(o).sort()) if (k !== 'deny_extras') r[k] = o[k]; return JSON.stringify(r); };\n  const keys = new Set([...Object.keys(oa), ...Object.keys(ob)]);\n  const docOrder = rowsOf(draft.state, 'item').map((r) => r && r.key);\n  for (const k of [...keys].sort((x, y) => docOrder.indexOf(x) - docOrder.indexOf(y))) if (own2(oa[k]) !== own2(ob[k])) out.push({ kind: 'dish', key: k });\n  return out;\n}\n// §2 item 5b — may a NEW group be offered there? Decided by the WRITER itself: a dry run of group.create with that destination on\n// a copy (attach.cat runs the option-override check on every launcher of the section; attach.item the «Sin extras» / deny-all\n// check). → null (allowed) | { code } | { code, reason: 'none' | 'deny_all' | 'option_override' | 'unsaved' } for the row's line.\nconst PROBE_GROUP = '\\u0000probe';\nexport function attachRefusal(src, attach) {\n  if (!writer() || typeof writer().apply !== 'function') return { code: 'writer_unavailable' };\n  try { writer().apply(src, { op: 'group.create', group: PROBE_GROUP, extras: [{ ref: 'tmp:probe', name: 'probe', price: 1 }], attach }); return null; }\n  catch (err) {\n    const code = (err && err.code) || 'unknown_op', d = (err && err.detail) || {};\n    if (code === 'exposure_dish_no_extras') { const r = existingRow(src, d.item); return { code, reason: r && r.display && r.display.extras_policy === 'none' ? 'none' : 'deny_all' }; }\n    if (code === 'exposure_option_override') return { code, reason: 'option_override' };\n    if (code === 'unknown_item' && rowsOf(src, 'item').some((r) => r && isTmp(r) && r.ref === d.item)) return { code, reason: 'unsaved' };\n    return { code };\n  }\n}\n",
   ""
  ]
 ],
 "item-edit-logic.js": [
  [
   "  draftPhotos, ITEM_NAME_MAX, ITEM_DESC_MAX, extrasBaseline, dishDenyExtras, composeDish, commitDish,\n",
   "  draftPhotos, ITEM_NAME_MAX, ITEM_DESC_MAX, extrasBaseline, dishDenyExtras,\n"
  ],
  [
   "    extrasAuthoring: !!(opts && opts.extrasAuthoring === true),\n    // STRUCTURE S2 (§3.2): the Extras page's switch, and this copy's attach / detach ops IN CLICK ORDER (replayed as such)\n    extrasCatalog: !!(opts && opts.extrasCatalog === true), ops: [] };\n",
   "    extrasAuthoring: !!(opts && opts.extrasAuthoring === true) };\n"
  ],
  [
   "// STRUCTURE S2 (§3.2, Codex S2 plan r2 #4) — attach / detach a group on THIS dish in the copy («Agregar grupo de extras» /\n// «Quitar de este producto»). The op is recorded in order, and the copy's checklist follows it exactly as the writer will: the\n// group's extras leave the exclusions (attach = all ticked; detach = the group is gone), so the composition never replays an untick\n// from before a reattach. Dark without the server's extrasCatalog switch.\nexport function setGroupAttached(s, group, attached) {\n  if (!s || s.closed || !s.extrasCatalog || typeof group !== 'string') return s;\n  s.ops.push({ op: attached ? 'attach.item' : 'detach.item', group });\n  const inGroup = new Set((draftSource(s.draft).extras || []).filter((x) => x && x.display && x.display.cat === group).map((x) => x.key));\n  s.work.denyExtras = s.work.denyExtras.filter((k) => !inGroup.has(k));\n  return s;\n}\n\n",
   ""
  ],
  [
   "  if (s.ops.length) out.push('ops');\n",
   ""
  ],
  [
   "// STRUCTURE S2 (§3.2): the prospect IS the drawer's composition (editor.js composeDish) in preview mode — the same function\n// «Guardar» commits, so the preview and the commit never disagree. null when the copy cannot compose (nothing is guessed).\nfunction structuralEdit(s) {\n  const ch = changed(s), w = s.work, e = {};\n  if (ch.includes('cat') || ch.includes('subcat')) { e.cat = w.cat; e.subcat = w.subcat; }\n  if (ch.includes('denyExtras')) e.denyExtras = w.denyExtras.slice();\n  if (ch.includes('extrasNone')) e.extrasPolicy = w.extrasNone ? 'none' : null;\n  return e;\n}\n",
   ""
  ],
  [
   "  const r = composeDish(draft, s.key, structuralEdit(s), s.ops, { extrasAuthoring: s.extrasAuthoring, extrasCatalog: s.extrasCatalog, strict: false });\n  return r.ok ? r.source : null;\n",
   "  const after = JSON.parse(JSON.stringify(draftSource(draft)));\n  const g = choiceGroup(draft, s.key);\n  const members = new Set([s.key, ...(g ? g.options.map((o) => o.key) : [])]);\n  for (const r of after.items || []) {\n    if (!r || !members.has(r.key) || !r.display) continue;\n    if (catChanged(s)) { r.display.cat = s.work.cat; if (s.work.subcat == null) delete r.display.subcat; else r.display.subcat = s.work.subcat; }\n    if (s.work.extrasNone) r.display.extras_policy = 'none'; else delete r.display.extras_policy;\n  }\n  const expo = after.structure && after.structure.exposure;\n  if (expo && typeof expo === 'object') {\n    if (!expo.item_overrides || typeof expo.item_overrides !== 'object') expo.item_overrides = {};\n    const io = expo.item_overrides;\n    if (s.work.denyExtras.length) io[s.key] = { ...(io[s.key] || {}), deny_extras: s.work.denyExtras.slice() };\n    else if (io[s.key]) { delete io[s.key].deny_extras; if (!Object.keys(io[s.key]).length) delete io[s.key]; }\n  }\n  return after;\n"
  ],
  [
   "const prospectBaseline = (s) => { const p = prospectSource(s.draft, s); return p ? extrasBaseline(p, s.key, null) : null; };\n",
   "const prospectBaseline = (s) => extrasBaseline(prospectSource(s.draft, s), s.key, null);\n"
  ],
  [
   "  try { const p = prospectSource(draft, s); if (!p) throw new Error('no prospect'); used = extrasGroupReach(p); } catch (_) { return { authoring: s.extrasAuthoring, none: w.extrasNone, cards: [], gap: true, show: true }; }\n",
   "  try { used = extrasGroupReach(prospectSource(draft, s)); } catch (_) { return { authoring: s.extrasAuthoring, none: w.extrasNone, cards: [], gap: true, show: true }; }\n"
  ],
  [
   "  if (!after) return null;\n",
   ""
  ],
  [
   "  const extrasGap = (ch.includes('denyExtras') || ch.includes('extrasNone') || ch.includes('ops')) && extras.gap;\n",
   "  const extrasGap = (ch.includes('denyExtras') || ch.includes('extrasNone')) && extras.gap;\n"
  ],
  [
   "  // STRUCTURE S2 (§3.2): ONE composition — «Sin extras» off, the move, the copy's ops, then the rest — swapped in once\n  if (!commitDish(draft, s.key, e, s.ops, { reserved: s.reserved, extrasAuthoring: s.extrasAuthoring, extrasCatalog: s.extrasCatalog }).ok) return { ok: false, error: 'invalid' };\n",
   "  if (!editItem(draft, s.key, e, { reserved: s.reserved, extrasAuthoring: s.extrasAuthoring })) return { ok: false, error: 'invalid' };\n"
  ]
 ]
};
