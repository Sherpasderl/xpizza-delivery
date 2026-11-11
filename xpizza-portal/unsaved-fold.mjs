// UNSAVED EDITS (MOCKUP-portal-item-edit-unsaved.html, owner-approved 2026-11-11): the addendum's EXACT hunks, [now, was] per file,
// cut against UNSAVED_BASE (the ITE tip it is built on). Folded out FIRST by portalui-guards (the newest layer), so every older pin
// judges exactly what it judged before. Regenerated only from the change's diff (D4c-grill/ite/drawer-fold/gen_unsaved_fold.py);
// an edit outside these hunks, or inside one, fails.
export const UNSAVED_BASE = 'b0e0a56c';
export const UNSAVED_FOLD = {
 "app.js": [
  [
   "    rev.disabled = owned || state.menuLoading === true || !state.draft || !valid || uploader.busy() || state.platformPending === true || copyDirty();\n    rev.title = state.platformPending === true ? PLATFORM_COPY.bar : (copyDirty() ? UNSAVED_HINT : ((state.draft && !valid) ? 'Hay un precio sin valor válido' : ''));\n",
   "    rev.disabled = owned || state.menuLoading === true || !state.draft || !valid || uploader.busy() || state.platformPending === true;\n    rev.title = state.platformPending === true ? PLATFORM_COPY.bar : ((state.draft && !valid) ? 'Hay un precio sin valor válido' : '');\n"
  ],
  [
   "  // unsaved edits (frame 1): the WHOLE bar waits while the open product has unsaved edits — «Descartar» too — with one hint\n  const dirty = copyDirty();\n  const dis = $('discard');\n  if (dis) { dis.disabled = dirty; if (dirty) dis.title = UNSAVED_HINT; else dis.removeAttribute('title'); }\n  const sp = $('rbar') && $('rbar').querySelector('.rb-sp');\n  let hint = sp && sp.querySelector('.mk-rbhint');\n  if (sp && !hint && dirty) { hint = document.createElement('span'); hint.className = 'mk-rbhint'; hint.textContent = UNSAVED_HINT; sp.prepend(hint); }\n  if (hint) hint.hidden = !dirty;\n",
   ""
  ],
  [
   "    onClose: bound(() => requestClose(() => { state.drawerKey = null; endEditSession(); uploader.cancel(key); d.classList.remove('show'); d.replaceChildren(); })),\n",
   "    onClose: bound(() => { state.drawerKey = null; endEditSession(); uploader.cancel(key); d.classList.remove('show'); d.replaceChildren(); }),\n"
  ],
  [
   "  resetBtn.addEventListener('click', bound(() => requestClose(() => resetToLive(rid, rev))));   // unsaved edits: ask first\n",
   "  resetBtn.addEventListener('click', bound(() => resetToLive(rid, rev)));\n"
  ],
  [
   "  if (editSess && editSess.key !== key && copyDirty()) { requestClose(() => openDrawer(key)); return; }   // unsaved edits: ask first\n",
   ""
  ],
  [
   "  dismissConfirm();   // a redraw (e.g. an upload landing) while the confirm is open = «Seguir editando»: the copy stays, the page is live\n",
   ""
  ],
  [
   "// the open unsaved-edits confirm, if any: its ONE cleanup (card, inert background, key trap) is owned here, not by its closure, so\n// every path that replaces the drawer or ends the world tears it down (Codex drawer r2 #3)\nlet activeConfirm = null;\nfunction dismissConfirm() { const c = activeConfirm; activeConfirm = null; if (c) c(); }\n// read-only seam for the tests: the open copy itself (identity of the session, its work / base / upload binding)\nexport const _openCopy = () => editSess;\n",
   ""
  ],
  [
   "// UNSAVED EDITS (MOCKUP-portal-item-edit-unsaved.html, owner-approved 2026-11-11): the open copy's unsaved work is never thrown\n// away without asking. One predicate; the bar, the reload guard and every exit that would drop the copy read it.\nconst UNSAVED_HINT = 'Guardá o cancelá los cambios del producto abierto';\nconst copyDirty = () => !!editSess && !editSess.closed && IE.isDirty(editSess);\n// Frame 2 — an in-page confirm anchored to the drawer (its scrim covers the drawer only; the page gets no backdrop). «Seguir\n// editando» is the primary and holds focus; Enter, or Esc ANYWHERE, keeps the work and returns the caret (and its selection) to the\n// last edited field. Tab / Shift+Tab stay inside the card, and everything behind it is inert while it is open. «Descartar» drops the\n// copy, then runs `next` (close, reload, reset, or open the other product). Clean → `next` at once: nothing asks twice.\nfunction requestClose(next) {\n  if (!copyDirty()) return next();   // clean: the exit itself (its promise, for an async one)\n  const d = $('drawer');\n  if (d.querySelector('.mk-cfscrim')) return;\n  // the last edited field (it keeps its own selection while the close button has focus; focusing it again restores the caret)\n  const lastEl = editRefs && editRefs.lastEdit && editRefs.lastEdit.el.isConnected ? editRefs.lastEdit.el : document.activeElement;\n  const mkEl = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };\n  const scrim = mkEl('div', 'mk-cfscrim');\n  const cfCard = mkEl('div', 'mk-cf');\n  cfCard.setAttribute('role', 'dialog'); cfCard.setAttribute('aria-modal', 'true');\n  cfCard.setAttribute('aria-labelledby', 'mk-cf-t'); cfCard.setAttribute('aria-describedby', 'mk-cf-d');\n  const h = mkEl('h3', null, '¿Descartar los cambios?'); h.id = 'mk-cf-t';\n  const p = mkEl('p', null, 'Tenés cambios sin guardar en este producto.'); p.id = 'mk-cf-d';\n  const acts = mkEl('div', 'mk-cfa');\n  const cfDrop = document.createElement('button'); cfDrop.className = 'btn ghost mk-quiet-danger'; cfDrop.type = 'button'; cfDrop.textContent = 'Descartar';\n  const cfKeep = document.createElement('button'); cfKeep.className = 'btn accent'; cfKeep.type = 'button'; cfKeep.textContent = 'Seguir editando';\n  // the background, inert while the card is open (restored exactly: an element already inert stays inert)\n  const inerted = [];\n  for (const el of [...d.children, ...document.body.children]) {\n    if (el === d || el.hasAttribute('inert')) continue;\n    el.setAttribute('inert', ''); inerted.push(el);\n  }\n  const close = () => {\n    if (activeConfirm === close) activeConfirm = null;\n    scrim.remove();\n    for (const el of inerted) el.removeAttribute('inert');\n    document.removeEventListener('keydown', onDocKey, true);\n  };\n  const dismiss = () => {\n    close();\n    if (lastEl && lastEl.isConnected && typeof lastEl.focus === 'function') lastEl.focus();\n  };\n  const onDocKey = bound((e) => {\n    if (e.key === 'Escape') { e.preventDefault(); dismiss(); return; }\n    if (e.key === 'Tab') {   // contained: the card's two buttons, in order\n      e.preventDefault();\n      const order = [cfDrop, cfKeep];\n      const at = order.indexOf(document.activeElement);\n      const to = e.shiftKey ? (at <= 0 ? order.length - 1 : at - 1) : (at === order.length - 1 ? 0 : at + 1);\n      order[to].focus();\n    }\n  });\n  cfKeep.addEventListener('click', bound(() => dismiss()));\n  cfDrop.addEventListener('click', bound(() => { close(); endEditSession(); next(); syncUi(); }));   // the bar is live again (frame 3)\n  acts.append(cfDrop, cfKeep);\n  cfCard.append(h, p, acts);\n  scrim.append(cfCard);\n  d.append(scrim);\n  document.addEventListener('keydown', onDocKey, true);\n  activeConfirm = close;\n  cfKeep.focus();\n}\n",
   ""
  ],
  [
   "  dismissConfirm();   // the copy's confirm goes with it — every world-ending path (closeDrawer, resetEditFacts / invalidateReview, auth) passes here\n",
   ""
  ],
  [
   "  head.append(mk('span', 'dwt', s.base.name || key), closeIcon(bound(() => requestClose(() => closeDrawer()))));   // the published name until the draft is saved (B)\n",
   "  head.append(mk('span', 'dwt', s.base.name || key), closeIcon(bound(() => closeDrawer())));   // the published name until the draft is saved (B)\n"
  ],
  [
   "  ieCancel.addEventListener('click', bound(() => { closeDrawer(); syncUi(); }));   // the bar is live again once the copy is gone\n",
   "  ieCancel.addEventListener('click', bound(() => closeDrawer()));\n"
  ],
  [
   "  R.dirty = mk('span', 'mk-dirty', 'Cambios sin guardar');   // frame 1: the quiet mark beside «Guardar»\n  R.dirty.hidden = true;\n  foot.append(ieCancel, mk('span', 'mk-sp'), R.dirty, ieSave);\n",
   "  foot.append(ieCancel, mk('span', 'mk-sp'), ieSave);\n"
  ],
  [
   "  R.body = body;\n",
   ""
  ],
  [
   "  const dirty = IE.isDirty(s);\n  R.dirty.hidden = !dirty;\n  // the field the merchant is editing, with its selection — where «Seguir editando» returns the caret\n  const ae = document.activeElement;\n  if (R.body && ae && R.body.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) R.lastEdit = { el: ae };\n  // the bar waits while the copy is dirty — repainted by syncUi (the one derivation) only when that changes: syncUi → setDrawerInert →\n  // syncEdit would otherwise loop\n  if (R.lastDirty !== dirty) { R.lastDirty = dirty; syncUi(); }\n",
   ""
  ],
  [
   "  if (copyDirty()) return;   // unsaved edits: the whole bar waits (frame 1)\n",
   ""
  ],
  [
   "  if (copyDirty()) return;   // unsaved edits: never review around an open, dirty copy (the bar is inert; this is the admission)\n",
   ""
  ],
  [
   "      // the DRAFT moved under us: refetch it and start over — after asking, if an open product holds unsaved edits\n      await requestClose(async () => { $('scrim').classList.remove('show'); await loadMenu(state.currentRid); });\n",
   "      // the DRAFT moved under us: refetch it and start over\n      $('scrim').classList.remove('show');\n      await loadMenu(state.currentRid);\n"
  ],
  [
   "      await requestClose(async () => { $('scrim').classList.remove('show'); clearReview(); await resetToLive(state.draftRid, state.sourceUpdateTime); });   // unsaved edits: ask first\n",
   "      $('scrim').classList.remove('show');\n      clearReview();\n      await resetToLive(state.draftRid, state.sourceUpdateTime);\n"
  ],
  [
   "    pendingCount: (state.draft ? pendingCount(state.draft, state.additionKeys) + pendingRenames(state.draft).length : 0) + (copyDirty() ? 1 : 0), focusedTag: a ? a.tagName : null };   // + an unsaved open copy (addendum note)\n",
   "    pendingCount: state.draft ? pendingCount(state.draft, state.additionKeys) + pendingRenames(state.draft).length : 0, focusedTag: a ? a.tagName : null };\n"
  ]
 ],
 "item-edit-logic.js": [
  [
   "// Unsaved work in the copy (the unsaved-edits addendum): any changed field, a photo in the copy, or an upload on its way — the\n// same facts view() reports as «Guardar»'s reasons. A closed copy (or none) is never dirty.\nexport function isDirty(s) {\n  if (!s || s.closed) return false;\n  return changed(s).length > 0 || !!(s.upload && s.upload.state === 'busy');\n}\n\n",
   ""
  ]
 ]
};
