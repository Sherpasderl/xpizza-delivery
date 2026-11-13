// «Quitar del menú» (PLAN-portal-remove-product r3, APPROVED 11-12): the slice's EXACT hunks, [now, was] per file, cut against
// RP_BASE (the base it is built on: train/portal-structure). Folded out FIRST by portalui-guards (the newest layer, above S2), so S2 and every older pin
// judge exactly what they judged before. Regenerated only from the change's diff (D4c-grill/review-portal/remove-product/gen_rp_fold.py);
// an edit outside these hunks, or inside one, fails.
export const RP_BASE = '8b16924f';
export const RP_FOLD = {
 "editor.js": [
  [
   "  dropDishUnit(draft.state, row);\n  return draft;\n}\n// ONE dish unit leaves the source: its row, its item_order entry and its photos entry — shared by removeAddition and removeProduct\n// («Quitar del menú») so the two cannot drift (PLAN-portal-remove-product r3 §4.1 step 3).\nfunction dropDishUnit(st, row) {\n  const id = rowId(row);\n  const items = rowsOf(st, 'item');\n",
   ""
  ],
  [
   "  dropFromOrder(st, id);\n",
   "  dropFromOrder(draft.state, id);\n"
  ],
  [
   "  const pm = st.photos && typeof st.photos === 'object' ? st.photos : null;\n  if (pm && Object.prototype.hasOwnProperty.call(pm, id)) { delete pm[id]; if (!Object.keys(pm).length) delete st.photos; }\n}\n\n// ── «Quitar del menú» (PLAN-portal-remove-product r3, APPROVED 11-12; MOCKUP-portal-remove-product.html) ──────────────────────────\n// The served live order (P-R9, 5f `liveOrder: { items, rewards }`), well-formed — without it nothing is removed or restored (Q-13:\n// never a guessed order).\nconst validLiveOrder = (lo) => !!(lo && Array.isArray(lo.items) && lo.items.every((k) => typeof k === 'string') && Array.isArray(lo.rewards)\n  && lo.rewards.every((k) => typeof k === 'string'));\n// §2 — the ONE predicate (the drawer's action and both writers ask it). ctx: { on (the server's productRemoval), baseReadable\n// (state.deletionBase), liveOrder (P-R9), savedAdditions (the server's unpublished additions) }. → { show, enabled, code }: rows 1–5\n// HIDE the action (U3); row 6 (no readable base / no live order) shows it disabled with the U2 line. app.js passes the two served\n// collections POSITIONALLY (`liveOrder`, `savedAdditions` — the portal-wiring rule: a state reference travels only as a ruled consumer's\n// argument, never inside a literal); they default to ctx's.\nexport function canRemoveProduct(draft, key, ctx = {}, liveOrder = ctx && ctx.liveOrder, savedAdditions = ctx && ctx.savedAdditions) {\n  const no = (code, show = false) => ({ show, enabled: false, code });\n  if (!ctx || ctx.on !== true) return no('off');\n  if (!draft || !canEditContent(draft)) return no('not_editable');\n  const row = rowsOf(draft.state, 'item').find((r) => r && rowId(r) === key);\n  if (!row) return no('unknown_item');\n  const saved = savedAdditions instanceof Set ? savedAdditions : new Set();\n  if (isTmp(row) || typeof row.key !== 'string' || saved.has(row.key)) return no('new_item');   // a «Nuevo» dish keeps «Descartar»\n  if (isOptionRow(row) || groupOfRow(draft.state, row)) return no('has_options');                // advisor ruling (b), until S3\n  const sid = row.display && row.display.identity_id;\n  if (typeof sid !== 'string' || !sid) return no('unstamped');                                   // the server would refuse a RESET\n  if (ctx.baseReadable !== true || !validLiveOrder(liveOrder)) return no('base_unreadable', true);\n  return { show: true, enabled: true, code: null };\n}\n// §4.2 / P-R9 — the ONE order rebuild: item_order = the live order filtered to what is present, THEN the draft's additions (keys the\n// live order does not hold) in their relative order — the server's rule (add-product.js: new products go at the end); rewards = the\n// live rewards filtered to what is present, then any other entry. Pure over the source; false (nothing written) without the live order.\nexport function rebuildOrders(st, liveOrder) {\n  if (!st || typeof st !== 'object' || !validLiveOrder(liveOrder)) return false;\n  const present = new Set(rowsOf(st, 'item').map(rowId).filter((k) => typeof k === 'string'));\n  st.structure = st.structure || {};\n  const liveItems = new Set(liveOrder.items);\n  const cur = Array.isArray(st.structure.item_order) ? st.structure.item_order : (st.structure.item_order = []);\n  const nextItems = [...liveOrder.items.filter((k) => present.has(k)), ...cur.filter((k) => !liveItems.has(k))];\n  cur.splice(0, cur.length, ...nextItems);\n  const rei = st.structure.redeem_eligible_items;\n  if (Array.isArray(rei) || liveOrder.rewards.length) {\n    const liveRewards = new Set(liveOrder.rewards);\n    const next = [...liveOrder.rewards.filter((k) => present.has(k)), ...(Array.isArray(rei) ? rei : []).filter((k) => !liveRewards.has(k))];\n    if (Array.isArray(rei)) rei.splice(0, rei.length, ...next); else st.structure.redeem_eligible_items = next;\n  }\n  return true;\n}\n// §4.1 — remove a PUBLISHED plain dish as one unit, all or nothing: its row, order entry and photo (dropDishUnit), its OWN entries\n// (P-R4, 5f d1309843: item_overrides[key], extras_by_item[key] — the map itself stays, B-3 — and its rewards entry), and its identity\n// stamp claimed (Ruling A). → { ok:true, snap } (P-R1's shape; the caller's stash, for «Deshacer») | { ok:false, code }.\nexport function removeProduct(draft, key, ctx = {}, liveOrder = ctx && ctx.liveOrder, savedAdditions = ctx && ctx.savedAdditions) {\n  const p = canRemoveProduct(draft, key, ctx, liveOrder, savedAdditions);\n  if (!p.enabled) return { ok: false, code: p.code };\n  const st = draft.state;\n  const row = rowsOf(st, 'item').find((r) => r && r.key === key);\n  const s = st.structure || {};\n  const ov = s.exposure && s.exposure.item_overrides && typeof s.exposure.item_overrides === 'object' ? s.exposure.item_overrides : null;\n  const ebi = s.extras_by_item && typeof s.extras_by_item === 'object' ? s.extras_by_item : null;\n  const rei = Array.isArray(s.redeem_eligible_items) ? s.redeem_eligible_items : null;\n  const order = Array.isArray(s.item_order) ? s.item_order : [];\n  const pm = st.photos && typeof st.photos === 'object' ? st.photos : null;\n  const j = order.indexOf(key), ri = rei ? rei.indexOf(key) : -1;\n  // `after` / `redeem_index` are kept in P-R1's shape but NEVER place anything: §4.2 rebuilds both orders from P-R9\n  const snap = clone({ key, identity_id: row.display.identity_id, row, after: j > 0 ? order[j - 1] : null, photo: pm && own(pm, key) ? pm[key] : null,\n    refs: { item_override: ov && own(ov, key) ? ov[key] : null, extras_by_item: ebi && own(ebi, key) ? ebi[key] : null, redeem_index: ri === -1 ? null : ri } });\n  dropDishUnit(st, row);\n  if (ov && own(ov, key)) delete ov[key];\n  if (ebi && own(ebi, key)) delete ebi[key];\n  if (ri !== -1) rei.splice(ri, 1);\n  mergeDeletionClaim(st, { add: [row.display.identity_id] });\n  rebuildOrders(st, liveOrder);\n  return { ok: true, snap };\n}\n// §4.2 — «Deshacer»: put the dish back from `snap` (the in-session stash: the row as it was just before the removal, D-2; or P-R1's\n// entry after a reload — row, photo, refs), withdraw its stamp, and rebuild both orders from the served live order (never from snap).\nexport function undoRemoveProduct(draft, key, snap, liveOrder) {\n  if (!draft || !canEditContent(draft)) return { ok: false, code: 'not_editable' };\n  if (!validLiveOrder(liveOrder)) return { ok: false, code: 'base_unreadable' };\n  if (!snap || !snap.row || snap.row.key !== key) return { ok: false, code: 'unknown_item' };\n  const st = draft.state;\n  if (!Array.isArray(st.items)) st.items = [];\n  if (st.items.some((r) => r && r.key === key)) return { ok: false, code: 'present' };\n  // the row goes where the live order puts it among the rows (canonical items follow item_order); additions stay after it\n  const rank = (k) => { const i = liveOrder.items.indexOf(k); return i === -1 ? Infinity : i; };\n  const at = rank(key);\n  const pos = st.items.findIndex((r) => rank(rowId(r)) > at);\n  st.items.splice(pos === -1 ? st.items.length : pos, 0, clone(snap.row));\n  if (snap.photo) { if (!st.photos || typeof st.photos !== 'object') st.photos = {}; st.photos[key] = clone(snap.photo); }\n  const refs = snap.refs || {};\n  st.structure = st.structure || {};\n  if (refs.item_override != null) {\n    st.structure.exposure = st.structure.exposure || {};\n    st.structure.exposure.item_overrides = st.structure.exposure.item_overrides || {};\n    st.structure.exposure.item_overrides[key] = clone(refs.item_override);\n  }\n  if (refs.extras_by_item != null) { st.structure.extras_by_item = st.structure.extras_by_item || {}; st.structure.extras_by_item[key] = clone(refs.extras_by_item); }\n  const sid = snap.row.display && snap.row.display.identity_id;\n  if (typeof sid === 'string' && sid) mergeDeletionClaim(st, { withdraw: [sid] });\n  rebuildOrders(st, liveOrder);\n  return { ok: true };\n}\n// ── the READ side app.js paints from (§3.3 / §9) — pure readers; every row they hand back is a COPY, so nothing the caller keeps\n// reaches the session's stash or the served list\n// The dishes pending removal, key → the snapshot «Deshacer» restores: the session's stash first (the row as it was just before the\n// removal, D-2), else the SAVED draft's P-R1 entry (`served`: the live row, its photo and refs). A key the draft holds again is not pending.\nexport function pendingRemovalsOf(draft, stash, served) {\n  const out = new Map();\n  if (!draft) return out;\n  const present = new Set(rowsOf(draft.state, 'item').map(rowId).filter((k) => typeof k === 'string'));\n  if (stash instanceof Map) for (const [k, snap] of stash) if (typeof k === 'string' && snap && snap.row && !present.has(k)) out.set(k, clone(snap));\n  for (const r of (Array.isArray(served) ? served : [])) if (r && typeof r.key === 'string' && r.row && !present.has(r.key) && !out.has(r.key)) out.set(r.key, clone(r));\n  return out;\n}\n// The list's DISPLAY projection, never sent: the source with each pending row back at its live place — the SAME rebuildOrders a restore\n// runs over P-R9's live order, so the list and «Deshacer» agree. The draft is not touched (its arrays are copied before the rebuild).\nexport function removalListSource(draft, pending, liveOrder) {\n  const src = draftSource(draft);\n  if (!(pending instanceof Map) || !pending.size || !validLiveOrder(liveOrder)) return src;\n  const st = src.structure || {};\n  const out = { ...src, items: [...(src.items || []), ...[...pending.values()].map((p) => clone(p.row))],\n    structure: { ...st, item_order: Array.isArray(st.item_order) ? [...st.item_order] : [], ...(Array.isArray(st.redeem_eligible_items) ? { redeem_eligible_items: [...st.redeem_eligible_items] } : {}) } };\n  rebuildOrders(out, liveOrder);\n  return out;\n}\n// A removed dish's row for the review's names and places: the pending snapshot's, else the LOADED draft's (orig) — a copy, or null\nexport function removedRowOf(draft, pending, key) {\n  const p = pending instanceof Map ? pending.get(key) : null;\n  if (p && p.row) return clone(p.row);\n  const r = rowsOf((draft && draft.orig) || {}, 'item').find((x) => x && x.key === key);\n  return r ? clone(r) : null;\n}\n// Every dish row a deletion list can name (U1 / U5): the loaded draft, the draft now and the pending snapshots — copies\nexport function removalDishRows(draft, pending) {\n  const rows = [...rowsOf((draft && draft.orig) || {}, 'item'), ...rowsOf((draft && draft.state) || {}, 'item'), ...(pending instanceof Map ? [...pending.values()].map((p) => p.row) : [])];\n  return rows.filter((r) => r && r.display).map(clone);\n",
   "  const pm = draft.state.photos && typeof draft.state.photos === 'object' ? draft.state.photos : null;\n  if (pm && Object.prototype.hasOwnProperty.call(pm, id)) { delete pm[id]; if (!Object.keys(pm).length) delete draft.state.photos; }\n  return draft;\n"
  ],
  [
   "  // { add: [ids] } («Quitar del menú»: a dish's identity stamp — the dish writer has no op results) is the same union as the op results;\n  // { withdraw: [ids] } («Deshacer»): drop exactly those ids, ONE sorted array; no claim ⇒ nothing written; [] stays []\n  if (results && typeof results === 'object' && !Array.isArray(results) && Array.isArray(results.add)) return mergeDeletionClaim(src, [{ deletedIds: results.add }]);\n  if (results && typeof results === 'object' && !Array.isArray(results)) {\n    const cur = src && src.deleted_ids;\n    if (cur === undefined || !Array.isArray(results.withdraw)) return src;\n    const have = Array.isArray(cur) ? cur : (cur && typeof cur === 'object' && Array.isArray(cur.ids) ? cur.ids : []);\n    const drop = new Set(results.withdraw.map(String));\n    src.deleted_ids = [...new Set(have.map(String))].filter((x) => !drop.has(x)).sort();\n    return src;\n  }\n",
   ""
  ],
  [
   "  // «Quitar del menú» (SBS 11-13, MOCKUP R3 «1 cambio»): a PUBLISHED dish no longer in the draft took its own entry with it — that is the\n  // removal (pendingChanges counts it once), never also a «dish» structure change\n  const gone = (k) => !docOrder.includes(k) && rowsOf(draft.orig || {}, 'item').some((r) => r && r.key === k);\n  for (const k of [...keys].sort((x, y) => docOrder.indexOf(x) - docOrder.indexOf(y))) if (!gone(k) && own2(oa[k]) !== own2(ob[k])) out.push({ kind: 'dish', key: k });\n",
   "  for (const k of [...keys].sort((x, y) => docOrder.indexOf(x) - docOrder.indexOf(y))) if (own2(oa[k]) !== own2(ob[k])) out.push({ kind: 'dish', key: k });\n"
  ]
 ],
 "extras-view.js": [
  [
   "// A small confirm on #xscrim (.modal.sm): X2 «¿Quitar …?», the discard confirm and the dish confirm («Quitar del menú», R2 / R5). Tab\n// stays inside; Escape and the backdrop take the cancel path; the cancel path returns focus to `returnTo`. `buttons`: [{ label, mods\n// (classes on top of .btn), sheetMods (on the phone sheet), act: 'cancel' | 'go', focus }] in DOM order. «Quitar del menú» adds:\n// `title` as parts (strings / nodes), `titleClass`, `line` (a node under the body) and `sheet` (≤ 560 px: the bottom sheet, R2 phone —\n// the SAME element, its class swapped while open and restored on close) and `over` (above the open drawer). Without them the DOM is today's, byte for byte (T14).\nexport function openXConfirm(o) {\n  const { title, titleClass = null, sub = null, body = null, line = null, buttons, sheet = false, over = false, returnTo = null } = o;\n  const scrim = document.getElementById('xscrim'), modal = scrim.querySelector('.modal, .mk-sheet');\n  const t = el('div', 'mt', Array.isArray(title) ? null : title); t.id = 'xcf-t';\n  if (Array.isArray(title)) t.append(...title);\n  if (titleClass) t.classList.add(titleClass);\n  const s = sub ? el('div', 'ms', sub) : null;\n  const p = body ? el('p', 'eqbody', body) : null; if (p) p.id = 'xcf-d';\n  const mf = el('div', sheet ? 'mk-sheeta' : 'mf');\n  let parts;\n  if (sheet) parts = [el('div', 'mk-handle'), t, ...(s ? [s] : []), ...(p ? [p] : []), ...(line ? [line] : []), mf];\n  else {\n    const mh = el('div', 'mh'); mh.append(t); if (s) mh.append(s);\n    parts = [mh];\n    if (p || line) { const mb = el('div', 'mb'); if (p) mb.append(p); if (line) mb.append(line); parts.push(mb); }\n    parts.push(mf);\n  }\n  if (sheet) parts[0].setAttribute('aria-hidden', 'true');\n  const modalClass = modal.className;\n",
   "// A small confirm on #xscrim (.modal.sm): X2 «¿Quitar …?» and the discard confirm. Tab stays inside; Escape and the backdrop take the\n// cancel path; the cancel path returns focus to `returnTo`. `buttons`: [{ label, mods (classes on top of .btn), act: 'cancel' | 'go', focus }] in DOM order.\nfunction openSmallConfirm(o) {\n  const { title, sub = null, body = null, buttons, returnTo = null } = o;\n  const scrim = document.getElementById('xscrim'), modal = scrim.querySelector('.modal');\n  const mh = el('div', 'mh'); const t = el('div', 'mt', title); t.id = 'xcf-t'; mh.append(t); if (sub) mh.append(el('div', 'ms', sub));\n  const parts = [mh];\n  if (body) { const mb = el('div', 'mb'); const p = el('p', 'eqbody', body); p.id = 'xcf-d'; mb.append(p); parts.push(mb); }\n  const mf = el('div', 'mf');\n  parts.push(mf);\n"
  ],
  [
   "    if (sheet) { scrim.classList.remove('mk-sheetscrim'); modal.className = modalClass; }\n    if (over) scrim.classList.remove('mk-over');\n",
   ""
  ],
  [
   "    const btnEl = el('button', 'btn', spec.label); btnEl.type = 'button'; btnEl.classList.add(...((sheet ? spec.sheetMods : null) || spec.mods));\n",
   "    const btnEl = el('button', 'btn', spec.label); btnEl.type = 'button'; btnEl.classList.add(...spec.mods);\n"
  ],
  [
   "  if (sheet) { scrim.classList.add('mk-sheetscrim'); modal.className = 'mk-sheet'; }\n  if (over) scrim.classList.add('mk-over');   // over the still-open drawer (26): the mockup's .mk-over\n",
   ""
  ],
  [
   "  openXConfirm({ title, sub, body, returnTo, onGo: onConfirm,\n",
   "  openSmallConfirm({ title, sub, body, returnTo, onGo: onConfirm,\n"
  ],
  [
   "  openXConfirm({ title: '¿Descartar los cambios?', returnTo, onGo: onDiscard, onCancel: onKeep,\n",
   "  openSmallConfirm({ title: '¿Descartar los cambios?', returnTo, onGo: onDiscard, onCancel: onKeep,\n"
  ],
  [
   "}\n\n// R2 / R5 «¿Quitar «{producto}» del menú?» (MOCKUP-portal-remove-product frames R2, R5, phone 390): the place under the title, the\n// approved body, the reward line when the dish is a reward (the SERVED rewardKeys, never derived here), «Volver» (focus) · «Quitar»\n// (quiet red); the bottom sheet at ≤ 560 px. The press writes nothing: onConfirm is the caller's removal.\nconst R2_BODY = 'Desaparece del menú al publicar. Tus pedidos pasados no cambian. Para volver a venderlo, crealo como un producto nuevo.';\nconst R5_LINE = 'Este producto se canjea con recompensas; al quitarlo deja de estar disponible como premio.';\nconst STAR = ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'];\nexport function openRemoveProductConfirm({ name, place, reward = false, onConfirm, onCancel = null, returnTo = null }) {\n  const sheet = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width:560px)').matches;\n  let line = null;\n  if (reward) { line = el('div', 'mk-sandline'); line.append(svg(STAR), el('span', null, R5_LINE)); }\n  openXConfirm({ title: [`¿Quitar «${name}» `, el('span', 'nw', 'del menú?')], titleClass: 'mk-cft', sub: place || null, body: R2_BODY, line, sheet, over: true, returnTo,\n    onGo: onConfirm, onCancel,\n    buttons: [{ label: 'Volver', mods: ['ghost'], sheetMods: [], act: 'cancel', focus: true }, { label: 'Quitar', mods: ['ghost', 'mk-quiet-danger'], sheetMods: ['danger'], act: 'go' }] });\n",
   ""
  ]
 ],
 "app.js": [
  [
   "export const state = { restaurants: [], currentRid: null, groups: [], extras: {}, selectedCat: null, renderedCategories: [], additionKeys: new Set(), settle: null, savedRenames: [], savedOther: false,\n  productRemoval: false, liveOrder: null, pendingRemovals: [], rewardKeys: new Set(), removalStash: new Map() };\n",
   "export const state = { restaurants: [], currentRid: null, groups: [], extras: {}, selectedCat: null, renderedCategories: [], additionKeys: new Set(), settle: null, savedRenames: [], savedOther: false };\n"
  ],
  [
   "import { renderExtrasPage, openRemoveConfirm, openDiscardConfirm, renderCreateGroup, renderAttachSheet, openDeletionsReview, enProductos, closeXConfirm, openRemoveProductConfirm } from './extras-view.js';\n",
   "import { renderExtrasPage, openRemoveConfirm, openDiscardConfirm, renderCreateGroup, renderAttachSheet, openDeletionsReview, enProductos, closeXConfirm } from './extras-view.js';\n"
  ],
  [
   "import { canRemoveProduct, removeProduct, undoRemoveProduct, pendingRemovalsOf, removalListSource, removedRowOf, removalDishRows } from './editor.js';   // «Quitar del menú» (PLAN-portal-remove-product r3)\n",
   ""
  ],
  [
   "  state.groups = groupByCategory(listSource())   // «Quitar del menú» (R3): a dish pending removal stays in its place until publish\n",
   "  state.groups = groupByCategory(src)\n"
  ],
  [
   "  // «Quitar del menú» (PLAN-portal-remove-product r3 §9; 5f P-R5 / P-R9 / P-R1 / P-R2): the switch, the ORIGINAL live order, the SAVED\n  // draft's removals and the reward dishes — strictly from the server, served only while the switch is on; absent ⇒ off / unreadable / none\n  state.productRemoval = !!(data && data.productRemoval === true);\n  const lo = state.productRemoval ? data.liveOrder : null;\n  state.liveOrder = lo && Array.isArray(lo.items) && lo.items.every((k) => typeof k === 'string') && Array.isArray(lo.rewards) && lo.rewards.every((k) => typeof k === 'string')\n    ? { items: [...lo.items], rewards: [...lo.rewards] } : null;\n  state.pendingRemovals = state.productRemoval && Array.isArray(data.pendingRemovals)\n    ? data.pendingRemovals.filter((r) => r && typeof r.key === 'string' && r.row && typeof r.row === 'object' && r.row.key === r.key) : [];\n  state.rewardKeys = new Set(state.productRemoval && Array.isArray(data.rewardKeys) ? data.rewardKeys.filter((k) => typeof k === 'string') : []);\n  state.removalStash = new Map();             // a new draft: this session's «Deshacer» snapshots end with the draft they came from\n",
   ""
  ],
  [
   "  const nTexts = n > 0 ? new Set([...textEditedKeys().keys(), ...pendingRemovalMap().keys()]).size : 0;   // «Quitar del menú»: a dish edited AND removed counts once\n",
   "  const nTexts = n > 0 ? textEditedKeys().size : 0;\n"
  ],
  [
   "  const pend = pendingRemovalMap();\n",
   ""
  ],
  [
   "    pendingOf: (it) => (pend.has(rowId(it)) ? { onUndo: bound(() => undoRemoval(rowId(it))) } : null),   // «Quitar del menú» (R3)\n",
   ""
  ],
  [
   "// ── «Quitar del menú» (PLAN-portal-remove-product r3 §3.3 / §4 / §9; MOCKUP-portal-remove-product frames R1–R5) ─────────────────\n// §2's switches (the server's, with the text-edit drawer; the readable baseline) — the served collections travel positionally\nconst removalOn = () => ({ on: state.productRemoval === true && state.textEditEnabled === true, baseReadable: state.deletionBase !== null });\n// The dishes pending removal, key → a COPY of what «Deshacer» restores (this session's snapshot first, else the saved draft's P-R1 entry)\nconst pendingRemovalMap = () => (state.productRemoval === true && state.draft ? pendingRemovalsOf(state.draft, state.removalStash, state.pendingRemovals) : new Map());\n// The list's DISPLAY projection (never sent): the pending rows back at their live places, by the same rebuild a restore runs\nconst listSource = () => removalListSource(state.draft, pendingRemovalMap(), state.liveOrder);\n// a removed dish's row (a copy) for the review's names and places\nconst removedRowFor = (k) => removedRowOf(state.draft, pendingRemovalMap(), k);\n// «{categoría} · {subcategoría}» (the category alone without a subcategory) — R2's place and U5's second column\nconst dishPlace = (row) => (row && row.display ? [row.display.cat == null ? null : categoryName(row.display.cat), typeof row.display.subcat === 'string' && row.display.subcat ? row.display.subcat : null].filter(Boolean).join(' \\u00b7 ') : '');\nfunction svgTrashIcon() {\n  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');\n  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6'); s.append(p);\n  return s;\n}\n// R2 / R5: the confirm (the served rewardKeys decide the reward line — P-R2, never derived here)\nfunction openRemoveProduct(key, from) {\n  const row = (draftSource(state.draft).items || []).find((r) => r && r.key === key);\n  if (!row) return;\n  const reward = state.rewardKeys.has(key);\n  openRemoveProductConfirm({ name: `${row.display.name}`, place: dishPlace(row), reward, returnTo: from,\n    onConfirm: bound(() => confirmRemoveProduct(key)) });\n}\n// «Quitar»: the removal (all or nothing), its snapshot stashed for «Deshacer», the dish's upload stopped, and the drawer closed — the\n// confirmed removal supersedes an uncommitted copy with no second confirm (D-3). Focus lands on the row's «Deshacer».\nfunction confirmRemoveProduct(key) {\n  const r = removeProduct(state.draft, key, removalOn(), state.liveOrder, state.additionKeys);\n  if (!r.ok) { if (state.drawerKey === key) renderDrawer(); return; }   // the predicate moved under the open confirm: nothing written\n  state.removalStash.set(key, r.snap);\n  if (uploader.jobOf(key)) uploader.cancel(key);\n  closeDrawer();\n  repaintFromDraft();\n  const u = [...document.querySelectorAll('#detail .irow.mk-pend .mk-undo')].find((b) => b.dataset.k === key);\n  if (u) u.focus();\n}\n// «Deshacer» (R3): the dish back from its snapshot, its stamp withdrawn, both orders rebuilt from the served live order (§4.2)\nfunction undoRemoval(key) {\n  const snap = pendingRemovalMap().get(key);\n  if (!snap) return;\n  const r = undoRemoveProduct(state.draft, key, snap, state.liveOrder);\n  if (!r.ok) return;\n  state.removalStash.delete(key);\n  repaintFromDraft();\n  const c = document.querySelector(`#detail .irow > [data-k=\"item::${CSS.escape(key)}\"]`);\n  const chev = c && c.parentNode.querySelector('.rowchev');\n  if (chev) chev.focus();\n}\n",
   ""
  ],
  [
   "  const structure = { nameOf: (k) => { const r = items.find((x) => x.key === k) || removedRowFor(k); return r && typeof r.display.name === 'string' && r.display.name.trim() ? `${r.display.name}` : String(k); },\n    categoryName, sectionOf: (k) => { const r = items.find((x) => x.key === k) || removedRowFor(k); return r ? { cat: r.display.cat == null ? null : `${r.display.cat}`, subcat: typeof r.display.subcat === 'string' ? `${r.display.subcat}` : null } : { cat: null, subcat: null }; } };\n",
   "  const structure = { nameOf: (k) => { const r = items.find((x) => x.key === k); return r && typeof r.display.name === 'string' && r.display.name.trim() ? `${r.display.name}` : String(k); },\n    categoryName, sectionOf: (k) => { const r = items.find((x) => x.key === k); return r ? { cat: r.display.cat == null ? null : `${r.display.cat}`, subcat: typeof r.display.subcat === 'string' ? `${r.display.subcat}` : null } : { cat: null, subcat: null }; } };\n"
  ],
  [
   "    extraGroup: (k) => extraGroups.get(k) || null, structure, productRemoval: state.productRemoval === true };   // «Quitar del menú» (R4): the served switch\n",
   "    extraGroup: (k) => extraGroups.get(k) || null, structure };\n"
  ],
  [
   "  const section = (k) => { const r = items.find((x) => x.key === k) || removedRowFor(k); return r ? { cat: r.display.cat == null ? null : `${r.display.cat}`, subcat: typeof r.display.subcat === 'string' ? `${r.display.subcat}` : null } : { cat: null, subcat: null }; };\n  return { nameOf: (k) => { const r = items.find((x) => x.key === k) || removedRowFor(k); return r && typeof r.display.name === 'string' && r.display.name.trim() ? `${r.display.name}` : String(k); },\n",
   "  const section = (k) => { const r = items.find((x) => x.key === k); return r ? { cat: r.display.cat == null ? null : `${r.display.cat}`, subcat: typeof r.display.subcat === 'string' ? `${r.display.subcat}` : null } : { cat: null, subcat: null }; };\n  return { nameOf: (k) => { const r = items.find((x) => x.key === k); return r && typeof r.display.name === 'string' && r.display.name.trim() ? `${r.display.name}` : String(k); },\n"
  ],
  [
   "  state.productRemoval = false;\n  state.liveOrder = null;\n  state.pendingRemovals = [];\n  state.rewardKeys = new Set();\n  state.removalStash = new Map();\n",
   ""
  ],
  [
   "  }\n  // «Quitar del menú» (R1 / R1b): the body's last child, under a hairline — only when §2's ONE predicate shows it; §2 row 6 (no readable\n  // baseline, or no served live order) draws it disabled with S2's approved line under it. The press writes nothing (R2 confirms).\n  const rp = canRemoveProduct(state.draft, key, removalOn(), state.liveOrder, state.additionKeys);\n  if (rp.show) {\n    const act = mk('div', 'mk-rmact');\n    const ieRemove = document.createElement('button'); ieRemove.className = 'btn ghost mk-quiet-danger'; ieRemove.type = 'button';\n    ieRemove.append(svgTrashIcon(), document.createTextNode('Quitar del menú'));\n    if (rp.enabled) ieRemove.addEventListener('click', bound(() => openRemoveProduct(key, ieRemove)));\n    else lockControl(ieRemove, true);\n    act.append(ieRemove);\n    if (!rp.enabled) act.append(mk('div', 'ferr mk-ferr', 'No pudimos leer el menú publicado. Recargá la página.'));\n    body.append(act);\n",
   ""
  ],
  [
   "  state.removalStash.clear();                           // «Quitar del menú»: the in-session removals went with the thrown-away edits\n",
   ""
  ],
  [
   "      extraName: productReviewCtx().extraName, fiscalAckRequired: res && res.fiscalAckRequired });   // P-R8: the SAVE's word, never re-derived   // S4: a group's options fold under its «Nombre en factura»\n",
   "      extraName: productReviewCtx().extraName });   // S4: a group's options fold under its «Nombre en factura»\n"
  ],
  [
   "// U1 / U5 — the dishes a deletion list can name, by identity id: the loaded draft, the draft now, P-R1 and this session's snapshots\nfunction removedDishes() {\n  const out = new Map();\n  for (const r of removalDishRows(state.draft, pendingRemovalMap())) {\n    const id = r.display.identity_id;\n    if (typeof id === 'string' && id && !out.has(id)) out.set(id, { name: typeof r.display.name === 'string' ? r.display.name : '', place: dishPlace(r) });\n  }\n  return out;\n}\n",
   ""
  ],
  [
   "    rows: deletionRows(state.draft, ids, removedDishes()),\n",
   "    rows: deletionRows(state.draft, ids),\n"
  ]
 ],
 "render.js": [
  [
   "  // «Quitar del menú» (MOCKUP-portal-remove-product frame R3) — a dish pending removal: { onUndo } from the caller, or null\n  const pendingOf = typeof opts.pendingOf === 'function' ? opts.pendingOf : () => null;\n",
   ""
  ],
  [
   "    const pend = editable ? pendingOf(it) : null;\n    const row = el('div', pend ? 'irow mk-pend' : 'irow');\n",
   "    const row = el('div', 'irow');\n"
  ],
  [
   "    const ttag = pend ? null : textTagOf(it);\n    if (pend) { nmEl.classList.add('mk-pendtxt'); nmEl.append(el('span', 'tag mk-sand', 'Se quita al publicar')); }\n",
   "    const ttag = textTagOf(it);\n"
  ],
  [
   "    if (typeof d.desc === 'string' && d.desc.trim()) info.append(el('div', pend ? 'idesc mk-pendtxt' : 'idesc', d.desc));\n",
   "    if (typeof d.desc === 'string' && d.desc.trim()) info.append(el('div', 'idesc', d.desc));\n"
  ],
  [
   "    if (pend) {\n      // R3: greyed in place — the thumb stays (no opener), no info click, no chevron; «Deshacer» takes the chevron's place\n      const ph = photoOf(it, { name: label, open: () => {}, upload: () => {} });\n      const thumb = ph && ph.thumb ? ph.thumb : el('div', 'thumb');\n      thumb.setAttribute('inert', ''); thumb.tabIndex = -1;\n      cells.push(thumb);\n      const undo = el('button', 'mk-lnk mk-undo', 'Deshacer');\n      undo.type = 'button';\n      undo.dataset.k = id;\n      undo.setAttribute('aria-label', `Deshacer: ${label} vuelve al menú`);\n      undo.addEventListener('click', () => pend.onUndo());\n      cells.push(undo);\n    } else if (editable && onOpen) {\n",
   "    if (editable && onOpen) {\n"
  ],
  [
   "      editable, locked: locked || !!pend, changed: pend ? false : changed('item', id), onInput: (v) => onPrice('item', id, v),\n",
   "      editable, locked, changed: changed('item', id), onInput: (v) => onPrice('item', id, v),\n"
  ]
 ],
 "review.js": [
  [
   "import { COPY as IE_COPY } from './item-edit-logic.js';   // «Quitar del menú» (Q-11): the approved «sección vacía» lines\n",
   ""
  ],
  [
   "  // «Quitar del menú» (MOCKUP-portal-remove-product frame R4): with the server's switch on (ctx.productRemoval, the caller's served fact)\n  // a DISH's removal is its «Productos» row («Quitado»), not ALSO a «Se eliminan» line — every server fact shown once (the notS2\n  // pattern). Switch off: today's «Se eliminan» exactly.\n  const removed0 = (Array.isArray(d.removed) ? d.removed : []).filter(notS2('removed'));\n  const dishOut = (x) => ctx && ctx.productRemoval === true && !!x && x.surface === 'item';\n  const removed = removed0.filter((x) => !dishOut(x));\n  for (const x of removed0.filter(dishOut)) {\n    const p = products.find((y) => y.key === x.key);\n    if (p) { p.removal = true; p.count += 1; } else products.push({ key: x.key, removal: true, lines: [], consequences: [], options: [], absorbed: [], sources: [], count: 1 });\n  }\n",
   "  const removed = (Array.isArray(d.removed) ? d.removed : []).filter(notS2('removed'));\n"
  ],
  [
   "      if (p.removal) {\n        // R4: the dish and its place, the approved «Quitado» chip and the plain-words line (frame F's idiom)\n        const row = el('div', 'prow mk-srow');\n        row.dataset.k = `item::${p.key}::removed`;\n        const main = el('div', 'pmain');\n        main.append(el('div', 'pname', nameOf(p.key)), el('div', 'psub', place(now.cat, now.subcat)));\n        const v = el('div', 'pval');\n        v.append(el('span', 'bchip rem', 'Quitado'), el('span', 'now plain', 'se quita del menú; tus pedidos pasados no cambian'));\n        row.append(main, v);\n        g.append(row);\n      }\n",
   ""
  ],
  [
   "  // P-R8 (Q-12 RULED; 5f 34f38bb8): the SAVE's own word that this publish needs no fiscalAck — literally `false`; absent (or anything\n  // else) ⇒ today's seal and fiscalAck, byte-identical. Never re-derived here.\n  const sealWaived = ctx.fiscalAckRequired === false;\n",
   ""
  ],
  [
   "    needsSeal: isFiscal && !hasNothing && !sealWaived,\n",
   "    needsSeal: isFiscal && !hasNothing,\n"
  ],
  [
   "    needsAck: !hasNothing && ((isFiscal && !sealWaived) || ackSet.length > 0),\n",
   "    needsAck: !hasNothing && (isFiscal || ackSet.length > 0),\n"
  ],
  [
   "    fiscalAck: isFiscal && !sealWaived,\n    sealWaived,\n",
   "    fiscalAck: isFiscal,\n"
  ],
  [
   "    fiscalAck: att.isFiscal === true && att.sealWaived !== true && review.acknowledged === true,\n",
   "    fiscalAck: att.isFiscal === true && review.acknowledged === true,\n"
  ],
  [
   "    // «Quitar del menú» (D-8 + Q-11 RULED): the last dish of a section / subsection — today's panel, titled with the approved line\n    if (code === 'section_emptied') base.title = IE_COPY.cat.section_empty;\n    if (code === 'subsection_emptied') base.title = IE_COPY.cat.subsection_empty;\n",
   ""
  ]
 ],
 "availability.js": [
  [
   "      // «Quitar del menú» (R3): a dish pending removal shows no pills — inert controls would stay in the tab order\n      if (row.classList.contains('mk-pend')) { if (prev) prev.remove(); continue; }\n",
   ""
  ]
 ],
 "extras-logic.js": [
  [
   "// «Quitar del menú» (U1 / U5): `dishes` (id → { name, place }, the caller's dish rows: the loaded draft, the draft, P-R1, the session's\n// snapshots) names a DISH id with «{categoría} · {subcategoría}»; a dish with no name is «Un producto que ya no está en el menú»; an id\n// neither lists keeps the extra string (the advisor's ruling: only an id the client cannot classify).\nexport function deletionRows(draft, ids, dishes = null) {\n",
   "export function deletionRows(draft, ids) {\n"
  ],
  [
   "  const dish = dishes instanceof Map ? dishes : new Map();\n  const dishRow = (id) => { const x = dish.get(id); const named = typeof x.name === 'string' && x.name.trim() !== ''; return { id, name: named ? x.name : 'Un producto que ya no está en el menú', group: x.place || null, gone: !named }; };\n  return [...new Set((Array.isArray(ids) ? ids : []).map(String))].sort().map((id) => (byId.has(id) ? { id, ...byId.get(id), gone: false } : dish.has(id) ? dishRow(id) : { id, name: 'Un extra que ya no está en el menú', group: null, gone: true }));\n",
   "  return [...new Set((Array.isArray(ids) ? ids : []).map(String))].sort().map((id) => (byId.has(id) ? { id, ...byId.get(id), gone: false } : { id, name: 'Un extra que ya no está en el menú', group: null, gone: true }));\n"
  ]
 ]
};
