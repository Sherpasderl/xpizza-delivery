// The «Agregar extra» reward-group layer (MOCKUP-portal-extras-reward-group R1, owner-approved 2026-11-18) on RGUI_BASE (31f05c8a4, asm11
// main): app.js reads getEditableCatalog rewardGroups (5f feat/reward-groups-5f) and hands the Extras page a .has() predicate;
// extras-logic.js marks the detail `reward`; extras-view.js hides «Agregar extra» there and draws the ONE neutral line — and nothing else,
// [now, was] per file. Folded out FIRST by portalui-guards (the newest layer, above RGB), so RGB, REND and every older pin judge exactly
// what they judged before. Regenerated only from the change's diff; an edit outside these hunks, or inside one, fails.
export const RGUI_BASE = '31f05c8a4';
export const RGUI_FOLD = {
 "app.js": [
  [
   "export const state = { restaurants: [], currentRid: null, groups: [], extras: {}, selectedCat: null, renderedCategories: [], additionKeys: new Set(), settle: null, savedRenames: [], savedOther: false,\n  productRemoval: false, liveOrder: null, pendingRemovals: [], rewardKeys: new Set(), removalStash: new Map(), rewardGroups: new Set() };\n\n",
   "export const state = { restaurants: [], currentRid: null, groups: [], extras: {}, selectedCat: null, renderedCategories: [], additionKeys: new Set(), settle: null, savedRenames: [], savedOther: false,\n  productRemoval: false, liveOrder: null, pendingRemovals: [], rewardKeys: new Set(), removalStash: new Map() };\n\n"
  ],
  [
   "  state.extrasCatalog = !!(data && data.extrasCatalog === true);\n  // «Agregar extra» R1 (MOCKUP-portal-extras-reward-group, 5f getEditableCatalog rewardGroups): the groups whose NEW extra the save refuses\n  // (reward_group_add_blocked) — strictly the server's; absent ⇒ none (an older server: the button stays and the save's refusal decides)\n  state.rewardGroups = new Set(data && Array.isArray(data.rewardGroups) ? data.rewardGroups.filter((g) => typeof g === 'string') : []);\n  // STRUCTURE S2 (§3.4, P-1): the deletion baseline the save checks a removal claim against — served verbatim, null when unreadable\n",
   "  state.extrasCatalog = !!(data && data.extrasCatalog === true);\n  // STRUCTURE S2 (§3.4, P-1): the deletion baseline the save checks a removal claim against — served verbatim, null when unreadable\n"
  ],
  [
   "  if (!onXpage) return;\n  const model = extrasPageModel(state.draft, { group: extrasGroup, isReward: (g) => state.rewardGroups.has(g) });\n  extrasGroup = model.selected;\n",
   "  if (!onXpage) return;\n  const model = extrasPageModel(state.draft, { group: extrasGroup });\n  extrasGroup = model.selected;\n"
  ],
  [
   "  state.rewardKeys = new Set();\n  state.rewardGroups = new Set();\n  state.removalStash = new Map();\n",
   "  state.rewardKeys = new Set();\n  state.removalStash = new Map();\n"
  ]
 ],
 "extras-logic.js": [
  [
   "//           marked, an extra removed in this draft still listed (greyed, «Se quita al publicar») — its count, reach and shared warning\n//           — and `reward` (the server's rewardGroups: no «Agregar extra», one line why; MOCKUP-portal-extras-reward-group R1)\n// Names are TEXT in S2-core (renames come with S2b).\n",
   "//           marked, an extra removed in this draft still listed (greyed, «Se quita al publicar») — its count, reach and shared warning\n// Names are TEXT in S2-core (renames come with S2b).\n"
  ],
  [
   "\nexport function extrasPageModel(draft, { group = null, isReward = null } = {}) {\n  const src = draftSource(draft), orig = draft && draft.orig;\n",
   "\nexport function extrasPageModel(draft, { group = null } = {}) {\n  const src = draftSource(draft), orig = draft && draft.orig;\n"
  ],
  [
   "    const n = reach ? (reach.get(selected) || 0) : null;\n    // reward: the SERVER names the group as one a new extra cannot join (getEditableCatalog rewardGroups) — never derived here\n    detail = { group: selected, rows, count: rows.filter((r) => !r.removed).length, reach: n, shared: n !== null && n > 1, reward: !!(isReward && isReward(selected)) };\n  }\n",
   "    const n = reach ? (reach.get(selected) || 0) : null;\n    detail = { group: selected, rows, count: rows.filter((r) => !r.removed).length, reach: n, shared: n !== null && n > 1 };\n  }\n"
  ]
 ],
 "extras-view.js": [
  [
   "const WARN = ['M12 3l9 16H3z', 'M12 10v4', 'M12 17.5v.01'];\nconst RG_LINE = 'Este grupo se usa para recompensas, así que por ahora no podés agregarle extras nuevos. Podés cambiar sus precios o quitar';\n// the mockup's info mark (R1): a circle and the «i»\nconst info = () => { const s = svg(['M12 11v5M12 8h.01']); const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '9'); s.prepend(c); return s; };\nconst fieldLine = (id, text) => { const p = el('div', 'ferr mk-ferr', text); p.id = id; p.setAttribute('role', 'alert'); return p; };\n",
   "const WARN = ['M12 3l9 16H3z', 'M12 10v4', 'M12 17.5v.01'];\nconst fieldLine = (id, text) => { const p = el('div', 'ferr mk-ferr', text); p.id = id; p.setAttribute('role', 'alert'); return p; };\n"
  ],
  [
   "  head.append(el('div', 'dtitle', d.group), el('span', 'dcount', countLine));\n  if (on.addOpen && !d.reward) {   // «Agregar extra» (frame X: .dright > .btn); not offered in a reward group (R1)\n    const right = el('span', 'dright'); const addEx = el('button', 'btn'); addEx.type = 'button'; addEx.disabled = !canEdit;\n",
   "  head.append(el('div', 'dtitle', d.group), el('span', 'dcount', countLine));\n  if (on.addOpen) {   // «Agregar extra» (frame X: .dright > .btn)\n    const right = el('span', 'dright'); const addEx = el('button', 'btn'); addEx.type = 'button'; addEx.disabled = !canEdit;\n"
  ],
  [
   "    w.append(s); detailHost.append(w);\n  }\n  if (d.reward) {   // MOCKUP-portal-extras-reward-group R1: the ONE neutral line under the shared line (owner-approved words)\n    const w = el('div', 'mk-xwarn'); w.dataset.note = 'reward'; const s = el('div', 'mgshared mk-sand'); const t = el('span', null, `${RG_LINE} `);\n    t.append(el('span', 'nb', 'un extra.'));\n    s.append(info(), t); w.append(s); detailHost.append(w);\n  }\n",
   "    w.append(s); detailHost.append(w);\n  }\n"
  ]
 ]
};
