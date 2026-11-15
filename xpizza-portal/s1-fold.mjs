// STRUCTURE S1 (PLAN-portal-structure-S1-ui r3, APPROVED 2026-11-11; MOCKUP-portal-structure-edit v2 frame A): the slice's EXACT
// hunks, [now, was] per file, cut against S1_BASE (origin/main it is built on). Folded out FIRST by portalui-guards (the newest layer),
// so every older pin judges exactly what it judged before. Regenerated only from the change's diff
// (D4c-grill/review-portal/structure-s1/gen_s1_fold.py); an edit outside these hunks, or inside one, fails.
export const S1_BASE = '9269859d';
export const S1_FOLD = {
 "app.js": [
  [
   "  // STRUCTURE S1 (R5): the server's per-product extras switch; absent ⇒ OFF — the checklist and «Sin extras» stay dark\n  state.extrasAuthoring = !!(data && data.extrasAuthoring === true);\n  // advisor Q8 (11-11): whether the server serves the Extras page (getEditableCatalog extrasCatalog); absent ⇒ OFF — S1's «Opciones» line\n  state.extrasCatalog = !!(data && data.extrasCatalog === true);\n",
   ""
  ],
  [
   "  // STRUCTURE S1 (advisor 11-12): the server's checklist lines name extras by key — their display names, from the draft\n  const extraNames = new Map((draftSource(state.draft).extras || []).filter((x) => x && typeof x.key === 'string' && x.display).map((x) => [x.key, x.display.name]));\n  return { optionParent: (k) => parent.get(k) || null, optionIndex: (k) => (index.has(k) ? index.get(k) : 0), extraName: (k) => extraNames.get(k) || null };\n",
   "  return { optionParent: (k) => parent.get(k) || null, optionIndex: (k) => (index.has(k) ? index.get(k) : 0) };\n"
  ],
  [
   "  state.extrasAuthoring = false;\n  state.extrasCatalog = false;\n",
   ""
  ],
  [
   "// STRUCTURE S1 — the «Opciones» copy (MOCKUP-portal-structure-edit v2, table H) and the cards' fold state (view-only, per drawer\n// session: never part of the copy, never dirty)\nconst OPC_COPY = Object.freeze({\n  noneOff: 'Apagalo si este producto no lleva extras', noneOn: 'Este producto no ofrece ningún extra',\n  req: 'Elección requerida · el cliente elige 1', ext: 'Extras · opcionales',\n  allOn: 'Todos activos en este producto', markAll: 'Marcar todos', none: 'Ninguno', appOnly: 'Solo en la app Sherpa',\n  gap: 'No pudimos cargar los extras.',\n});\n// table H (Codex build r1 #9): «En el menú cada opción se llama «{producto} - {opción}», «… - {opción}»: el nombre se arma solo.» — the\n// recommended option first (the mockup's «Mediana»), else the first; then the one after it\nfunction opcNameLine(options, g) {\n  const opts = Array.isArray(options) ? options : [];\n  if (!opts.length) return '';\n  const rec = (k) => { const row = g && g.options.find((x) => x.key === k); return !!(row && row.display && Array.isArray(row.display.tags) && row.display.tags.includes('recommended')); };\n  const i = Math.max(0, opts.findIndex((o) => rec(o.key)));\n  const a = opts[i], b = opts.length > 1 ? opts[(i + 1) % opts.length] : null;\n  return `En el menú cada opción se llama «${a.fullName}»${b ? `, «… - ${b.choice}»` : ''}: el nombre se arma solo.`;\n}\nconst opcFolded = new Set();\nconst opcN = (n) => `${n} ${n === 1 ? 'opción' : 'opciones'}`;\nconst opcProducts = (n) => `en ${n} ${n === 1 ? 'producto' : 'productos'}`;\n// an extras card's header line: open → the group's reach; folded (A3) → also how many are active here, or how many there are\nfunction opcExtSub(c, open) {\n  if (open) return `${OPC_COPY.ext} · ${opcProducts(c.usedBy)}`;\n  return `${OPC_COPY.ext} · ${c.active < c.size ? `${c.active} de ${c.size} activos` : opcN(c.size)} · ${opcProducts(c.usedBy)}`;\n}\n",
   ""
  ],
  [
   "    editSess = IE.open(state.draft, key, state.reservedNames, { extrasAuthoring: state.extrasAuthoring === true });\n",
   "    editSess = IE.open(state.draft, key, state.reservedNames);\n"
  ],
  [
   "  // a plain product: its price, as today (a product with a required choice prices its options, in «Opciones» below)\n  if (!v0.options) {\n",
   "  // a product with a required choice (F): the derived option names, each with its counter and — kept (advisor Q1) — its price\n  if (v0.options) {\n    const g = choiceGroup(state.draft, key);\n    const fOpt = mk('div', 'fld');\n    const lr3 = mk('div', 'mk-lrow');\n    R.optCnt = mk('span', 'mk-cnt', 'precio por opción');\n    lr3.append(mk('label', null, 'Opciones'), R.optCnt);\n    const block = mk('div', 'modblock');\n    const mh = mk('div', 'modh', `${(g && typeof g.label === 'string' && g.label.trim()) ? g.label : 'Elección'} · elección requerida`);\n    mh.append(mk('span', 'mk-modhr', 'Se mueve con su producto'));\n    block.append(mh);\n    R.opts = [];\n    for (const o of v0.options) {\n      const row = mk('div', 'mk-dopt');\n      const dn = mk('span', 'mk-dn');\n      const base = document.createTextNode('');\n      dn.append(base, mk('span', null, ` - ${o.choice}`));\n      const cnt = mk('span', 'mk-cnt');\n      const dp = mk('span', 'dp');\n      const pr = mk('span', 'mopr');\n      const ieOptPrice = document.createElement('input');\n      ieOptPrice.type = 'text'; ieOptPrice.inputMode = 'numeric'; ieOptPrice.placeholder = 'Sin precio'; ieOptPrice.value = o.price;\n      ieOptPrice.setAttribute('aria-label', `Precio de ${o.choice}`);\n      ieOptPrice.addEventListener('input', bound(() => { IE.set(s, 'optionPrice', { key: o.key, raw: ieOptPrice.value }); syncEdit(); }));\n      focusKey(ieOptPrice, `ie-opt::${o.key}`);\n      pr.append(mk('span', 'mc', 'L'), ieOptPrice);\n      dp.append(pr);\n      row.append(dn, cnt, dp);\n      block.append(row);\n      R.opts.push({ key: o.key, row, base, cnt, pi: ieOptPrice });\n    }\n    const lab = mk('label', 'mgflag mgflag-same');\n    const ieSame = document.createElement('input'); ieSame.type = 'checkbox';\n    ieSame.addEventListener('change', bound(() => { IE.set(s, 'samePrice', ieSame.checked); syncEdit(); }));\n    focusKey(ieSame, 'ie-same');\n    lab.append(ieSame, document.createTextNode('Mismo precio para todas'));\n    R.same = ieSame;\n    fOpt.append(lr3, block, lab, mk('div', 'mk-sub', 'El nombre de cada opción se arma solo: nombre del producto + opción. Cambia junto con el producto.'));\n    errSlot(fOpt, 'options'); R.ctl.options = R.opts.map((o) => o.pi);\n    R.optBlock = block;\n    body.append(fOpt);\n  } else {\n"
  ],
  [
   "  // STRUCTURE S1 — «Opciones» (MOCKUP-portal-structure-edit v2 frame A / A2 / A3): «Sin extras», the required choice (R1: today's\n  // option-price inputs kept inside its card until S3), one card per extras group the dish offers, with the per-dish checklist\n  // (R4: today's editable prices until S2). Each card folds on its own (view-only). No grip (R2); no pencil, «Editar en Extras»,\n  // «Quitar de este producto» or dish actions until S2 / S3 — no dead control.\n  const ex = v0.extras;\n  if (v0.options || ex.show) {\n    const fOpc = mk('div', 'fld');\n    const lrO = mk('div', 'mk-lrow');\n    lrO.append(mk('label', null, 'Opciones'), mk('span', 'mk-cnt', state.extrasCatalog === true ? 'El orden de los grupos se define en Extras' : 'en el orden que las ve el cliente'));   // mockup v3 (owner 11-11): the order is set on the Extras page — once that page exists\n    const box = mk('div', `mk-opc${ex.none ? ' mk-off' : ''}`);\n    const folded = (id) => opcFolded.has(`${s.id}|${id}`);\n    const fold = (id) => { const k = `${s.id}|${id}`; if (opcFolded.has(k)) opcFolded.delete(k); else opcFolded.add(k); relayout(); refocus([`ie-fold::${id}`]); };\n    const header = (id, name, sub, subCls, open) => {\n      const gh = mk('div', 'mk-gh');\n      const ieFoldName = document.createElement('button'); ieFoldName.type = 'button'; ieFoldName.className = 'mk-gt';\n      ieFoldName.setAttribute('aria-expanded', String(open));\n      const st = mk('span', subCls, sub);\n      ieFoldName.append(mk('b', 'mk-gtn', name), st);\n      ieFoldName.addEventListener('click', bound(() => fold(id)));\n      focusKey(ieFoldName, `ie-fold::${id}`);\n      const act = mk('div', 'mk-gact');\n      const ieFoldChev = document.createElement('button'); ieFoldChev.type = 'button'; ieFoldChev.className = 'mk-ib mk-chev';\n      ieFoldChev.setAttribute('aria-label', `${open ? 'Ocultar' : 'Mostrar'} ${name}`); ieFoldChev.setAttribute('aria-expanded', String(open));\n      ieFoldChev.append(svgChevron());\n      ieFoldChev.addEventListener('click', bound(() => fold(id)));\n      act.append(ieFoldChev);\n      gh.append(ieFoldName, act);\n      return { gh, st };\n    };\n    R.opc = { cards: [] };\n    if (ex.gap) box.append(mk('p', 'mk-opcgap', OPC_COPY.gap));   // Codex build r1 #8: said, never a silent absence\n    else if (ex.show) {\n      const sw = mk('div', 'mk-opcsw');\n      const lbl = mk('div', 'mk-opcl');\n      lbl.append(mk('b', 'mk-opcb', 'Sin extras'), mk('span', 'mk-opcs', ex.none ? OPC_COPY.noneOn : OPC_COPY.noneOff));\n      const ieNoExtras = document.createElement('button'); ieNoExtras.type = 'button'; ieNoExtras.className = 'tog';\n      if (!ex.none) ieNoExtras.classList.add('off');\n      ieNoExtras.setAttribute('role', 'switch'); ieNoExtras.setAttribute('aria-checked', String(ex.none)); ieNoExtras.setAttribute('aria-label', 'Sin extras');\n      ieNoExtras.append(document.createElement('i'));\n      lockControl(ieNoExtras, !ex.authoring);   // R5: shown, inert, until the server's switch is on (locked: setDrawerInert keeps it off)\n      ieNoExtras.addEventListener('click', bound(() => { IE.set(s, 'extrasNone', !s.work.extrasNone); relayout(); refocus(['ie-sinextras']); }));\n      focusKey(ieNoExtras, 'ie-sinextras');\n      sw.append(lbl, ieNoExtras);\n      box.append(sw);\n    }\n    if (v0.options) {\n      const g = choiceGroup(state.draft, key);\n      const label = (g && typeof g.label === 'string' && g.label.trim()) ? g.label : 'Elección';\n      const open = !folded('req');\n      const card = mk('div', `mk-grp mk-req${open ? ' mk-open' : ''}`);\n      const h = header('req', label, `${OPC_COPY.req}${open ? '' : ` · ${opcN(v0.options.length)}`}`, 'mk-gts mk-greq', open);\n      card.append(h.gh);\n      R.opts = [];\n      R.optCnt = mk('span', 'mk-cnt');   // the F2 line's counter class (kept for syncEdit's red), not drawn\n      if (open) {\n        const block = mk('div', 'mk-gb');\n        for (const o of v0.options) {\n          const row = mk('div', 'mk-dopt');\n          // advisor 11-12 (S1 SBS, mockup v3): the row names the CHOICE; the full name lives in the helper line (and the counter)\n          const dn = mk('span', 'mk-dn', o.choice);\n          const opRow = g && g.options.find((x) => x.key === o.key);\n          if (opRow && opRow.display && Array.isArray(opRow.display.tags) && opRow.display.tags.includes('recommended')) dn.append(mk('span', 'mk-rec', 'Recomendada'));\n          const cnt = mk('span', 'mk-cnt');\n          const dp = mk('span', 'dp');\n          const pr = mk('span', 'mopr');\n          const ieOptPrice = document.createElement('input');\n          ieOptPrice.type = 'text'; ieOptPrice.inputMode = 'numeric'; ieOptPrice.placeholder = 'Sin precio'; ieOptPrice.value = o.price;\n          ieOptPrice.setAttribute('aria-label', `Precio de ${o.choice}`);\n          ieOptPrice.addEventListener('input', bound(() => { IE.set(s, 'optionPrice', { key: o.key, raw: ieOptPrice.value }); syncEdit(); }));\n          focusKey(ieOptPrice, `ie-opt::${o.key}`);\n          pr.append(mk('span', 'mc', 'L'), ieOptPrice);\n          dp.append(pr);\n          row.append(dn, cnt, dp);\n          block.append(row);\n          R.opts.push({ key: o.key, row, cnt, pi: ieOptPrice });\n        }\n        const lab = mk('label', 'mgflag mgflag-same mk-gsame');\n        const ieSame = document.createElement('input'); ieSame.type = 'checkbox';\n        ieSame.addEventListener('change', bound(() => { IE.set(s, 'samePrice', ieSame.checked); syncEdit(); }));\n        focusKey(ieSame, 'ie-same');\n        lab.append(ieSame, document.createTextNode('Mismo precio para todas'));\n        R.same = ieSame;\n        R.gsub = mk('div', 'mk-gsub', opcNameLine(v0.options, g));\n        block.append(lab, R.gsub);\n        card.append(block);\n        R.ctl.options = R.opts.map((x) => x.pi);\n      }\n      R.optBlock = card;\n      errSlot(card, 'options');\n      box.append(card);\n    }\n    for (const c of ex.cards) {\n      const id = `x::${c.cat}`;\n      const open = !folded(id);\n      const card = mk('div', `mk-grp mk-ext${open ? ' mk-open' : ''}`);\n      const h = header(id, c.cat, opcExtSub(c, open), 'mk-gts', open);\n      card.append(h.gh);\n      const ref = { cat: c.cat, open, st: h.st, rows: [] };\n      if (open) {\n        const gb = mk('div', 'mk-gb');\n        const sum = mk('div', 'mk-gsum');\n        ref.sum = mk('span', 'mk-gsumt');\n        ref.app = mk('span', 'mk-apponly');\n        ref.app.append(mk('span', 'mk-apdot'), document.createTextNode(OPC_COPY.appOnly));\n        ref.sum.append(document.createTextNode(''), ref.app);\n        const ieAllExtras = document.createElement('button'); ieAllExtras.type = 'button'; ieAllExtras.className = 'mk-lnk';\n        ref.lnk = ieAllExtras;\n        lockControl(ieAllExtras, c.disabled);   // dark (R5) or under «Sin extras» (A2) — locked, so an un-inert never re-enables it\n        ieAllExtras.addEventListener('click', bound(() => {\n          const cur = IE.view(state.draft, s).extras.cards.find((x) => x.cat === c.cat);\n          IE.set(s, 'extraGroupOn', { cat: c.cat, on: !cur || cur.active !== cur.size }); syncEdit();\n        }));\n        focusKey(ieAllExtras, `ie-all::${c.cat}`);\n        sum.append(ref.sum, ieAllExtras);\n        gb.append(sum);\n        for (const r of c.rows) {\n          const row = mk('div', 'mopt mk-xopt');\n          const lab = mk('label', 'mk-xchk');\n          const ieExtraOn = document.createElement('input'); ieExtraOn.type = 'checkbox'; ieExtraOn.checked = r.on; lockControl(ieExtraOn, c.disabled);\n          ieExtraOn.addEventListener('change', bound(() => { IE.set(s, 'extraOn', { key: r.key, on: ieExtraOn.checked }); syncEdit(); }));\n          focusKey(ieExtraOn, `ie-x::${r.key}`);\n          lab.append(ieExtraOn, mk('span', 'mk-xnm', r.name));\n          // R4: the group's price, editable as today (it is the group's, not the dish's — shown for an unchecked extra too)\n          const pr = mk('span', 'mopr');\n          const ieExtraPrice = document.createElement('input');\n          ieExtraPrice.type = 'text'; ieExtraPrice.inputMode = 'numeric'; ieExtraPrice.placeholder = 'Sin precio'; ieExtraPrice.value = r.price || '';\n          ieExtraPrice.setAttribute('aria-label', `Precio de ${r.name}`);\n          ieExtraPrice.addEventListener('input', bound(() => { IE.set(s, 'extraPrice', { key: r.key, raw: ieExtraPrice.value }); syncEdit(); }));\n          focusKey(ieExtraPrice, `ie-xp::${r.key}`);\n          pr.append(mk('span', 'mc', 'L'), ieExtraPrice);\n          row.append(lab, pr);\n          gb.append(row);\n          ref.rows.push({ key: r.key, row, cb: ieExtraOn, pi: ieExtraPrice });\n        }\n        card.append(gb);\n      }\n      R.opc.cards.push(ref);\n      box.append(card);\n    }\n    fOpc.append(lrO, box);\n    body.append(fOpc);\n  }\n",
   "  // the extras groups, as today — their prices through the copy (advisor Q2)\n  for (const g of optionGroups(state.draft)) body.append(groupBlock(g, s));\n"
  ],
  [
   "    // STRUCTURE S1 (Codex build r1 #2): a FOLDED required-choice card draws no option rows — only the ones drawn are synced\n    v.options.forEach((o) => {\n      const r = R.opts.find((x) => x.key === o.key);\n      if (!r) return;\n",
   "    v.options.forEach((o, i) => {\n      const r = R.opts[i];\n      r.base.textContent = o.fullName.slice(0, o.fullName.length - ` - ${o.choice}`.length);\n"
  ],
  [
   "      r.cnt.hidden = !(o.nearLimit || o.tooLong);   // an inline warning only near / past the limit\n",
   ""
  ],
  [
   "    if (R.same) R.same.checked = v.same === true;\n    if (R.gsub) R.gsub.textContent = opcNameLine(v.options, choiceGroup(state.draft, s.key));\n  }\n  // STRUCTURE S1 — the extras cards follow the copy in place (counts, the summary, the link, each row's check and price)\n  if (R.opc) {\n    for (const ref of R.opc.cards) {\n      const c = v.extras.cards.find((x) => x.cat === ref.cat);\n      if (!c) continue;\n      ref.st.textContent = opcExtSub(c, ref.open);\n      if (!ref.open) continue;\n      const custom = c.active < c.size;\n      ref.sum.firstChild.textContent = custom ? `${c.active} de ${c.size} activos en este producto` : OPC_COPY.allOn;\n      ref.app.hidden = !custom;\n      ref.lnk.textContent = custom ? OPC_COPY.markAll : OPC_COPY.none;\n      for (const r of ref.rows) {\n        const row = c.rows.find((x) => x.key === r.key);\n        if (!row) continue;\n        r.cb.checked = row.on;\n        r.row.classList.toggle('mk-xoff', !row.on);\n        if (r.pi.value !== (row.price || '') && document.activeElement !== r.pi) r.pi.value = row.price || '';\n      }\n    }\n",
   "    R.same.checked = v.same === true;\n"
  ],
  [
   "    const att = attestationModel(diff, { usesPlatformFactura: state.usesPlatformFactura, legacy: photo.legacy, optionParent: productReviewCtx().optionParent,\n      extraName: productReviewCtx().extraName });   // S4: a group's options fold under its «Nombre en factura»\n",
   "    const att = attestationModel(diff, { usesPlatformFactura: state.usesPlatformFactura, legacy: photo.legacy, optionParent: productReviewCtx().optionParent });   // S4: a group's options fold under its «Nombre en factura»\n"
  ]
 ],
 "editor.js": [
  [
   "// STRUCTURE S1 — and so is a dish's extras checklist or «Sin extras» (Codex S1 plan r1 #1): a SAVED one is pending work after the\n// drawer closed, so the reload / branch-switch / self-update guard (portalReloadFacts) still holds it.\n",
   ""
  ],
  [
   "  + pendingTexts(draft).reduce((n, t) => n + t.fields.length, 0) + pendingDishExtras(draft).reduce((n, t) => n + t.sentences, 0);\n",
   "  + pendingTexts(draft).reduce((n, t) => n + t.fields.length, 0);\n"
  ],
  [
   "export function editItem(draft, key, edit = {}, { reserved = null, extrasAuthoring = false } = {}) {\n",
   "export function editItem(draft, key, edit = {}, { reserved = null } = {}) {\n"
  ],
  [
   "  // STRUCTURE S1 (PLAN-per-product-extras §2 / §3 / §8): the dish's typed, key-only exclusions and «Sin extras». Only with the\n  // server's authoring switch ON; never on an option (existingRow refuses one: the launcher's list governs the group); every\n  // key an existing extra; a key the merchant ADDS must be in the dish's baseline AFTER this edit's move (a kept key outside\n  // it is preserved untouched — it excludes nothing there).\n  const denyEdit = own(e, 'denyExtras'), policyEdit = own(e, 'extrasPolicy');\n  if ((denyEdit || policyEdit) && extrasAuthoring !== true) return false;\n  if (policyEdit && !(e.extrasPolicy === 'none' || e.extrasPolicy === null)) return false;\n  let denyList = null;\n  if (denyEdit) {\n    const list = e.denyExtras;\n    if (!Array.isArray(list) || list.some((k) => typeof k !== 'string') || new Set(list).size !== list.length) return false;\n    const order = rowsOf(draft.state, 'extra').map((x) => x && x.key);\n    if (list.some((k) => !order.includes(k))) return false;\n    const expo = draft.state.structure && draft.state.structure.exposure;\n    if (!expo || typeof expo !== 'object') return false;\n    const kept = new Set(denyExtrasOf(draft.state, key));\n    const base = extrasBaseline(draft.state, key, moving ? { cat, subcat } : null);\n    if (!base) return false;\n    const inBase = new Set(base.groups.flatMap((g) => g.keys));\n    if (list.some((k) => !kept.has(k) && !inBase.has(k))) return false;\n    denyList = list.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));\n  }\n",
   ""
  ],
  [
   "  if (denyList) {\n    const expo = draft.state.structure.exposure;\n    if (!expo.item_overrides || typeof expo.item_overrides !== 'object') expo.item_overrides = {};\n    const io = expo.item_overrides;\n    // the validator refuses an empty list and an empty override (source-store.js:462-463, :473): [] DELETES them\n    if (denyList.length) io[key] = { ...(io[key] || {}), deny_extras: denyList };\n    else if (io[key]) { delete io[key].deny_extras; if (!Object.keys(io[key]).length) delete io[key]; }\n  }\n  // one extras_policy per group: the launcher AND every option (source-store.js:596-598)\n  if (policyEdit) for (const r of [row, ...opts]) { if (e.extrasPolicy === 'none') r.display.extras_policy = 'none'; else delete r.display.extras_policy; }\n",
   ""
  ],
  [
   "}\n\n// ── STRUCTURE S1 — A DISH'S EXTRAS (PLAN-portal-structure-S1-ui r3; PLAN-per-product-extras rev 2.2 §2 / §3 / §12.3) ─────────\n// The dish's typed exclusions: item_overrides[key].deny_extras (keys only), [] when absent.\nfunction denyExtrasOf(src, key) {\n  const io = src && src.structure && src.structure.exposure && src.structure.exposure.item_overrides;\n  const o = io && typeof io === 'object' ? io[key] : null;\n  return o && Array.isArray(o.deny_extras) ? o.deny_extras.slice() : [];\n}\nexport const dishDenyExtras = (draft, key) => denyExtrasOf(draft && draft.state, key);\n// The checklist's universe (§12.3): what the dish would offer WITHOUT its own exclusions and «Sin extras» — its section's\n// extras ∪ its `add`, legacy rules still applied — grouped by extra-category in THE ONE rule's order (the page's\n// ExtrasEligibility, the server's byte copy). `move` = the section this edit moves it to (the prospective dish). null when the\n// evaluator is absent (nothing about extras is ever guessed).\nexport function extrasBaseline(src, key, move = null) {\n  const E = globalThis.ExtrasEligibility;\n  if (!E || typeof E.projectEligibility !== 'function' || typeof E.eligibleExtras !== 'function') return null;\n  const s = clone(src);\n  const r = rowsOf(s, 'item').find((x) => x && x.key === key);\n  if (!r || !r.display || isOptionRow(r)) return { groups: [] };\n  const g = groupOfRow(s, r);\n  const members = [r, ...(g ? g.options : [])];\n  for (const m of members) {\n    if (move) { m.display.cat = move.cat; if (move.subcat == null) delete m.display.subcat; else m.display.subcat = move.subcat; }\n    delete m.display.extras_policy;\n  }\n  const io = s.structure && s.structure.exposure && s.structure.exposure.item_overrides;\n  if (io && io[key]) { delete io[key].deny_extras; if (!Object.keys(io[key]).length) delete io[key]; }\n  let keys;\n  try { const proj = E.projectEligibility(s); keys = E.eligibleExtras(proj, key).map((k) => [k, proj.extraCat[k]]); } catch (_) { return null; }\n  const groups = [];\n  for (const [k, c] of keys) { const last = groups[groups.length - 1]; if (last && last.cat === c) last.keys.push(k); else groups.push({ cat: c, keys: [k] }); }\n  return { groups };\n}\n// Existing products whose checklist or «Sin extras» differs from what was loaded — [{ key, fields: ['denyExtras' | 'extrasPolicy'] }],\n// in document order; the list compares as a SET (order-free, absent ≡ empty), the policy as 'none' vs absent.\nexport function pendingDishExtras(draft) {\n  const out = [];\n  for (const row of rowsOf(draft.state, 'item')) {\n    if (!row || isTmp(row) || isOptionRow(row) || typeof row.key !== 'string') continue;\n    const was = existingRow(draft.orig, row.key);\n    if (!was || !was.display || !row.display) continue;\n    const a = new Set(denyExtrasOf(draft.orig, row.key)), b = new Set(denyExtrasOf(draft.state, row.key));\n    const fields = [];\n    if (a.size !== b.size || [...a].some((k) => !b.has(k))) fields.push('denyExtras');\n    if ((was.display.extras_policy === 'none') !== (row.display.extras_policy === 'none')) fields.push('extrasPolicy');\n    // the bar counts what the review will SAY (Codex S1 follow-up r1 P2): an untick and a re-tick in one list are two sentences\n    const sentences = (b.size > 0 && [...b].some((k) => !a.has(k)) ? 1 : 0) + (a.size > 0 && [...a].some((k) => !b.has(k)) ? 1 : 0) + (fields.includes('extrasPolicy') ? 1 : 0);\n    if (fields.length) out.push({ key: row.key, fields, sentences });\n  }\n  return out;\n",
   ""
  ]
 ],
 "item-edit-logic.js": [
  [
   "  draftPhotos, ITEM_NAME_MAX, ITEM_DESC_MAX, extrasBaseline, dishDenyExtras,\n",
   "  draftPhotos, ITEM_NAME_MAX, ITEM_DESC_MAX,\n"
  ],
  [
   "// an option's full derived name «{producto} - {opción}» shows its counter from here on (10 short of the limit) — a warning only;\n// the limit itself (ITEM_NAME_MAX, the server's) is unchanged\nexport const OPTION_NAME_NEAR = ITEM_NAME_MAX - 10;\n",
   ""
  ],
  [
   "// `opts.extrasAuthoring`: the server's per-product extras switch (getEditableCatalog); absent ⇒ OFF — the checklist and «Sin\n// extras» are shown but inert (STRUCTURE S1, ruling R5); the prices keep working as today (R1 / R4).\nexport function open(draft, key, reservedNames = null, opts = {}) {\n",
   "export function open(draft, key, reservedNames = null) {\n"
  ],
  [
   "    // STRUCTURE S1: the dish's typed exclusions (source.extras order) and «Sin extras» are part of the copy too\n    denyExtras: dishDenyExtras(draft, key),\n    extrasNone: d.extras_policy === 'none',\n",
   ""
  ],
  [
   "    photoTouched: false, upload: null, closed: false, reserved, same: null, serverError: null,\n    extrasAuthoring: !!(opts && opts.extrasAuthoring === true) };\n",
   "    photoTouched: false, upload: null, closed: false, reserved, same: null, serverError: null };\n"
  ],
  [
   "  // STRUCTURE S1 — the checklist (only the keys the PROSPECTIVE dish shows; a kept key outside it is preserved) and «Sin extras».\n  // Inert while the server switch is off; the checklist is inert while «Sin extras» is on (A2).\n  else if ((field === 'extraOn' || field === 'extraGroupOn') && s.extrasAuthoring && !w.extrasNone && value && typeof value === 'object') {\n    const b = prospectBaseline(s);\n    const shown = b ? b.groups.flatMap((g) => g.keys) : [];\n    const keys = field === 'extraOn' ? (shown.includes(value.key) ? [value.key] : []) : ((b && b.groups.find((g) => g.cat === value.cat)) || { keys: [] }).keys;\n    const deny = new Set(w.denyExtras);\n    for (const k of keys) { if (value.on === false) deny.add(k); else deny.delete(k); }\n    const order = (draftSource(s.draft).extras || []).map((x) => x && x.key);\n    w.denyExtras = [...deny].sort((a, b2) => order.indexOf(a) - order.indexOf(b2));\n  } else if (field === 'extrasNone' && s.extrasAuthoring) w.extrasNone = value === true;\n",
   ""
  ],
  [
   "  const was = new Set(b.denyExtras);\n  if (w.denyExtras.length !== was.size || w.denyExtras.some((k) => !was.has(k))) out.push('denyExtras');\n  if (w.extrasNone !== b.extrasNone) out.push('extrasNone');\n",
   ""
  ],
  [
   "}\n\n// STRUCTURE S1 (Codex S1 plan r1 #2): the checklist's universe is the dish AS THIS COPY WOULD SAVE IT — its section after the\n// copy's move — recomputed on every read (the draft is mutable: no memo by object identity). null: the evaluator is absent.\n// ONE prospect (Codex build r1 #4): the draft with this copy's section, checklist and «Sin extras» applied to the dish and its options\n// — the cards, the move consequences and the reach all read it, so they never disagree.\nfunction prospectSource(draft, s) {\n  const after = JSON.parse(JSON.stringify(draftSource(draft)));\n  const g = choiceGroup(draft, s.key);\n  const members = new Set([s.key, ...(g ? g.options.map((o) => o.key) : [])]);\n  for (const r of after.items || []) {\n    if (!r || !members.has(r.key) || !r.display) continue;\n    if (catChanged(s)) { r.display.cat = s.work.cat; if (s.work.subcat == null) delete r.display.subcat; else r.display.subcat = s.work.subcat; }\n    if (s.work.extrasNone) r.display.extras_policy = 'none'; else delete r.display.extras_policy;\n  }\n  const expo = after.structure && after.structure.exposure;\n  if (expo && typeof expo === 'object') {\n    if (!expo.item_overrides || typeof expo.item_overrides !== 'object') expo.item_overrides = {};\n    const io = expo.item_overrides;\n    if (s.work.denyExtras.length) io[s.key] = { ...(io[s.key] || {}), deny_extras: s.work.denyExtras.slice() };\n    else if (io[s.key]) { delete io[s.key].deny_extras; if (!Object.keys(io[s.key]).length) delete io[s.key]; }\n  }\n  return after;\n}\nconst prospectBaseline = (s) => extrasBaseline(prospectSource(s.draft, s), s.key, null);\n// «en N productos»: the dishes (not options) whose own baseline offers the group — every dish's exclusions and «Sin extras»\n// set aside, legacy rules kept; one clone + one projection per read\nfunction extrasGroupReach(src0) {\n  const E = globalThis.ExtrasEligibility;\n  const src = JSON.parse(JSON.stringify(src0));\n  const io = src.structure && src.structure.exposure && src.structure.exposure.item_overrides;\n  if (io) for (const k of Object.keys(io)) { delete io[k].deny_extras; if (!Object.keys(io[k]).length) delete io[k]; }\n  for (const r of src.items || []) if (r && r.display) delete r.display.extras_policy;\n  const proj = E.projectEligibility(src);\n  const used = new Map();\n  for (const r of src.items || []) {\n    if (!r || typeof r.key !== 'string' || !r.display || r.display.variantOf != null) continue;\n    const cats = new Set(E.eligibleExtras(proj, r.key).map((k) => proj.extraCat[k]));\n    for (const c of cats) used.set(c, (used.get(c) || 0) + 1);\n  }\n  return used;\n}\n// The «Opciones» extras cards (frame A / A2 / A3), from the copy.\nfunction extrasCards(draft, s) {\n  const w = s.work;\n  const b = prospectBaseline(s);\n  // Codex build r1 #8: the evaluator missing is SAID (the block stays, «No pudimos cargar los extras.»), never a silent absence\n  if (!b) return { authoring: s.extrasAuthoring, none: w.extrasNone, cards: [], gap: true, show: true };\n  let used;\n  try { used = extrasGroupReach(prospectSource(draft, s)); } catch (_) { return { authoring: s.extrasAuthoring, none: w.extrasNone, cards: [], gap: true, show: true }; }\n  const deny = new Set(w.denyExtras);\n  const byKey = new Map((draftSource(draft).extras || []).map((x) => [x && x.key, x]));\n  const cards = b.groups.map((g) => {\n    const rows = g.keys.map((k) => { const x = byKey.get(k); const nm = x && x.display && typeof x.display.name === 'string' && x.display.name.trim() ? x.display.name : k;\n      return { key: k, name: nm, price: w.extraPrices[k], on: !deny.has(k) }; });\n    return { cat: g.cat, rows, size: rows.length, active: rows.filter((r) => r.on).length, usedBy: used.get(g.cat) || 0, disabled: w.extrasNone || !s.extrasAuthoring };\n  });\n  // R6: «Sin extras» is offered when the dish has something to switch off, or is already off\n  return { authoring: s.extrasAuthoring, none: w.extrasNone, cards, gap: false, show: cards.length > 0 || w.extrasNone };\n",
   ""
  ],
  [
   "  // STRUCTURE S1 (Codex build r1 #4): the move's consequences come from THE prospect — section, checklist and «Sin extras» of this copy\n  const after = prospectSource(draft, s);\n",
   "  const after = JSON.parse(JSON.stringify(src));\n"
  ],
  [
   "  const members = [s.key, ...(g ? g.options.map((o) => o.key) : [])];\n",
   "  const members = [s.key, ...(g ? g.options.map((o) => o.key) : [])];\n  for (const r of after.items || []) {\n    if (!r || !members.includes(r.key) || !r.display) continue;\n    r.display.cat = s.work.cat;\n    if (s.work.subcat == null) delete r.display.subcat; else r.display.subcat = s.work.subcat;\n  }\n"
  ],
  [
   "  // advisor 11-12 (S1 SBS): the row names the choice; its full name's counter is an inline warning from OPTION_NAME_NEAR on\n  const options = g ? g.options.map((o) => { const fullName = `${tidy} - ${o.display.choice}`; return { key: o.key, choice: o.display.choice, fullName, counter: `${chars(fullName)}/${ITEM_NAME_MAX}`, tooLong: chars(fullName) > ITEM_NAME_MAX, nearLimit: chars(fullName) >= OPTION_NAME_NEAR, price: w.optionPrices[o.key] }; }) : null;\n",
   "  const options = g ? g.options.map((o) => { const fullName = `${tidy} - ${o.display.choice}`; return { key: o.key, choice: o.display.choice, fullName, counter: `${chars(fullName)}/${ITEM_NAME_MAX}`, tooLong: chars(fullName) > ITEM_NAME_MAX, price: w.optionPrices[o.key] }; }) : null;\n"
  ],
  [
   "  const extras = extrasCards(draft, s);\n  const extrasGap = (ch.includes('denyExtras') || ch.includes('extrasNone')) && extras.gap;\n  if (!title && extrasGap) title = COPY.save.none;\n  const blocked = !ch.length || nameP || descP || catP || errors.price || badOption || badExtra || uploading || !!se || consequenceGap || extrasGap;\n",
   "  const blocked = !ch.length || nameP || descP || catP || errors.price || badOption || badExtra || uploading || !!se || consequenceGap;\n"
  ],
  [
   "    extras,\n",
   ""
  ],
  [
   "  // STRUCTURE S1 (Codex S1 plan r1 #1): serialized explicitly — the FULL final list (kept keys outside the baseline included),\n  // and «Sin extras» as the server's field; absent = untouched\n  if (ch.includes('denyExtras')) e.denyExtras = w.denyExtras.slice();\n  if (ch.includes('extrasNone')) e.extrasPolicy = w.extrasNone ? 'none' : null;\n  if (!editItem(draft, s.key, e, { reserved: s.reserved, extrasAuthoring: s.extrasAuthoring })) return { ok: false, error: 'invalid' };\n",
   "  if (!editItem(draft, s.key, e, { reserved: s.reserved })) return { ok: false, error: 'invalid' };\n"
  ]
 ],
 "review.js": [
  [
   "// STRUCTURE S1 (advisor 11-12; 5f 98ba304f): a dish's checklist and «Sin extras» are the SERVER's token-bound lines —\n// { field:'deny_extras', old:[keys], new:[keys] } and { field:'extras_policy', old, new } — read here as the product's sentences\nconst DISH_EXTRAS = ['deny_extras', 'extras_policy'];\nconst dishExtrasLines = (c, extraName) => {\n  const nm = (k) => { const n = typeof extraName === 'function' ? extraName(k) : null; return typeof n === 'string' && n ? n : String(k); };\n  if (c.field === 'extras_policy') return c.new === 'none' ? ['Sin extras'] : (c.old === 'none' ? ['Vuelve a ofrecer extras'] : []);\n  const was = Array.isArray(c.old) ? c.old.map(String) : [], now = Array.isArray(c.new) ? c.new.map(String) : [];\n  const denied = now.filter((k) => !was.includes(k)), restored = was.filter((k) => !now.includes(k));\n  return [...(denied.length ? [`Sin ${denied.map(nm).join(', ')} (solo en la app Sherpa)`] : []), ...(restored.length ? [`Vuelve a ofrecer ${restored.map(nm).join(', ')}`] : [])];\n};\nconst isProductLine = (c) => !!c && c.surface === 'item' && (TEXT_FIELDS.includes(c.field) || GATES.some(([f]) => f === c.field) || DISH_EXTRAS.includes(c.field));\nfunction productsOf(lines, optionParent, optionIndex, extraName) {\n",
   "const isProductLine = (c) => !!c && c.surface === 'item' && (TEXT_FIELDS.includes(c.field) || GATES.some(([f]) => f === c.field));\nfunction productsOf(lines, optionParent, optionIndex) {\n"
  ],
  [
   "    // `count` = the change SENTENCES this product renders (Codex S1 follow-up r1 P2: every count is the rendered, folded list)\n    if (!byKey.has(key)) byKey.set(key, { key, lines: [], consequences: [], options: [], absorbed: [], sources: [], count: 0 });\n",
   "    if (!byKey.has(key)) byKey.set(key, { key, lines: [], consequences: [], options: [], absorbed: [], sources: [] });\n"
  ],
  [
   "      if (c.field === 'name') { o.was = c.old; o.now = c.new; p.count += 1; continue; }   // the option's derived name: one sentence\n      if (own.some((x) => x.key === parent && x.field === c.field && same(x.old, c.old) && same(x.new, c.new))) { p.absorbed.push(c); continue; }   // folded: no sentence\n",
   "      if (c.field === 'name') { o.was = c.old; o.now = c.new; continue; }\n      if (own.some((x) => x.key === parent && x.field === c.field && same(x.old, c.old) && same(x.new, c.new))) { p.absorbed.push(c); continue; }\n"
  ],
  [
   "      p.count += 1;\n",
   ""
  ],
  [
   "    if (c.field === 'name' || c.field === 'desc') { p.lines.push({ kind: c.field, was: c.old, now: c.new }); p.count += 1; }\n",
   "    if (c.field === 'name' || c.field === 'desc') p.lines.push({ kind: c.field, was: c.old, now: c.new });\n"
  ],
  [
   "      if (!l) { l = { kind: 'cat', cat: null, subcat: null }; p.lines.push(l); p.count += 1; }   // section + subsection: ONE sentence\n",
   "      if (!l) { l = { kind: 'cat', cat: null, subcat: null }; p.lines.push(l); }\n"
  ],
  [
   "    } else if (DISH_EXTRAS.includes(c.field)) { const ss = dishExtrasLines(c, extraName); p.consequences.push(...ss); p.count += ss.length; }\n    else {\n",
   "    } else {\n"
  ],
  [
   "      p.gates = (p.gates || 0) + 1;   // counted below: a gate EXPLAINING the product's own section move is not a change of its own\n",
   ""
  ],
  [
   "    // approved frame E: «Productos 3» for name + description + section, its gate sentences under the section line uncounted\n    if (!p.lines.some((l) => l.kind === 'cat')) p.count += p.gates || 0;\n    delete p.gates;\n",
   ""
  ],
  [
   "    // the gates in their order; the dish's extras sentences after them (their own order kept)\n    const rank = (x) => { const i = GATES.findIndex((g) => g.includes(x)); return i < 0 ? GATES.length : i; };\n    p.consequences.sort((a, b) => rank(a) - rank(b));\n",
   "    p.consequences.sort((a, b) => GATES.findIndex((g) => g.includes(a)) - GATES.findIndex((g) => g.includes(b)));\n"
  ],
  [
   "  const products = productsOf(productLines, ctx && ctx.optionParent, ctx && ctx.optionIndex, ctx && ctx.extraName);\n",
   "  const products = productsOf(productLines, ctx && ctx.optionParent, ctx && ctx.optionIndex);\n"
  ],
  [
   "    if (!p) { p = { key: c.key, lines: [], consequences: [], options: [], absorbed: [], sources: [], count: 0 }; products.push(p); }\n",
   "    if (!p) { p = { key: c.key, lines: [], consequences: [], options: [], absorbed: [], sources: [] }; products.push(p); }\n"
  ],
  [
   "    // every product sentence once, as rendered (an option's identical line folded, a checklist swap = two sentences); a move's\n    // «Acepta / Deja de aceptar» explanations (diff.consequences) describe a counted change, they are not changes of their own\n    total: rows.length + sections.length + products.reduce((n, p) => n + p.count, 0) + added.length + removed.length + renamed.length + photos.length,\n",
   "    total: rows.length + sections.length + productLines.length + added.length + removed.length + renamed.length + photos.length,\n"
  ],
  [
   "    g.append(groupHead('Productos', products.reduce((n, p) => n + (p.count || 0), 0)));\n",
   "    g.append(groupHead('Productos', products.reduce((n, p) => n + p.lines.length, 0)));\n"
  ],
  [
   "  const hasNothing = reviewModel(diff, ctx).total === 0;\n",
   "  const hasNothing = reviewModel(diff).total === 0;\n"
  ],
  [
   "  const m = reviewModel(diff, ctx);\n",
   "  const m = reviewModel(diff);\n"
  ],
  [
   "  // STRUCTURE S1 (PLAN-portal-structure-S1-ui r3 §7, Codex build r1 #7): a dish's extras while the platform switch is off, and a\n  // new product's options whose reference did not resolve\n  extras_not_supported_yet: { icon: 'info', title: 'Todavía no se pueden cambiar los extras de un producto',\n    detail: 'Tus otros cambios siguen acá.',\n    action: { id: PUBLISH_ACTIONS.FIX, label: 'Entendido' } },\n  // deterministic for this draft (an unresolved new-product reference): a retry would be refused forever, so the way out is the\n  // published menu (the review guard's rule for deterministic refusals)\n  exposure_ref_mismatch: { icon: 'warn', title: 'No pudimos guardar las opciones de un producto nuevo',\n    detail: 'Volvé al menú publicado y aplicá tus cambios de nuevo; si sigue igual, escribinos.',\n    action: { id: PUBLISH_ACTIONS.RESET, label: 'Volver al menú publicado' } },\n",
   ""
  ]
 ]
};
