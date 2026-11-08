// F-2 (owner-approved mockup ENrjdkJmw3mzy9PkFCy4D1) — the EXACT hunks this slice adds to the frozen portal files app.js / review.js,
// as [now, was] pairs: folding each `now` (which occurs exactly once) back to `was` gives the F-2 base (the «Marca» commit, which
// left both files untouched — i.e. main 51dc55ab) byte-for-byte (portalui-guards.test.mjs). The NEWEST layer, folded out FIRST, so
// every older registry and pin keeps judging exactly what it judged before. Generated from the slice diff and then pinned.
export const PP_FOLD = {
 "app.js": [
  [
   "    rev.disabled = owned || state.menuLoading === true || !state.draft || !valid || uploader.busy() || state.platformPending === true;\n    rev.title = state.platformPending === true ? PLATFORM_COPY.bar : ((state.draft && !valid) ? 'Hay un precio sin valor válido' : '');\n",
   "    rev.disabled = owned || state.menuLoading === true || !state.draft || !valid || uploader.busy();\n    rev.title = (state.draft && !valid) ? 'Hay un precio sin valor válido' : '';\n"
  ],
  [
   "  state.platformPending = false;              // F-2 — per-load server fact (platform_changes_pending): today's path until it arrives;\n  paintPlatformLock();                        //   the shared header lock line goes back NOW, at the transition (a failed load never paints)\n",
   ""
  ],
  [
   "    { canEdit: () => editLockHolder === null && state.platformPending !== true, held: savedHold });\n",
   "    { canEdit: () => editLockHolder === null, held: savedHold });\n"
  ],
  [
   "  // F-2 (owner-approved mockup ENrjdkJmw3mzy9PkFCy4D1) — Sherpa wrote fields into this draft that live does not carry yet: the menu is\n  // READ-ONLY with the calm notice, and «Volver al menú publicado» is never offered (resetDraftToLive refuses it anyway; the server decides)\n  state.platformPending = !!(data && data.platform_changes_pending && typeof data.platform_changes_pending === 'object');\n",
   ""
  ],
  [
   "  const enabled = photo.enabled && state.platformPending !== true;   // F-2: a photo is content like a price — read-only while Sherpa updates\n  if (!enabled && !(v.kind === 'photo' && (v.url || v.neutral))) return null;\n  return { thumb: rowThumb({ view: v, name, enabled, onOpen: open, onUpload: upload, onImgError: onPhotoImgError }), tag: rowTag(v) };\n",
   "  if (!photo.enabled && !(v.kind === 'photo' && (v.url || v.neutral))) return null;\n  return { thumb: rowThumb({ view: v, name, enabled: photo.enabled, onOpen: open, onUpload: upload, onImgError: onPhotoImgError }), tag: rowTag(v) };\n"
  ],
  [
   "  if (!renamesPending() && state.platformPending !== true) return;   // F-2: the same hold while Sherpa updates the menu\n",
   "  if (!renamesPending()) return;\n"
  ],
  [
   "  // F-2 (mockup N2) — the server refused because Sherpa is updating this menu: the designed panel, and the screen behind it\n  // becomes the read-only notice (a stale page that still showed the reset offer)\n  if (failed && failed.code === 'platform_changes_pending') {\n    state.platformPending = true;\n    paint(); refreshBar();\n    showOutcome(outcomeFor(failed, 'edit'));\n    $('scrim').classList.add('show');\n    syncUi();\n    return;\n  }\n",
   ""
  ],
  [
   "// F-2 (owner-approved mockup ENrjdkJmw3mzy9PkFCy4D1, N1 / P1) — the portal's own quiet callout, no button: nothing for the merchant to do\nexport const PLATFORM_COPY = Object.freeze({\n  title: 'Sherpa está actualizando tu menú',\n  body: 'Estamos actualizando cómo se ve tu menú. Mientras tanto podés verlo, pero no guardar ni publicar cambios. Si necesitás cambiar un precio ya, escribinos.',\n  bar: 'Publicar se habilita cuando Sherpa termine.',\n  lock: 'Solo lectura mientras Sherpa actualiza',\n});\nfunction offerPlatformNotice(host) {\n  const c = document.createElement('div');\n  c.className = 'callout calloutquiet1b';\n  c.setAttribute('role', 'status');\n  const ns = 'http://www.w3.org/2000/svg';\n  const v = document.createElementNS(ns, 'svg'); v.setAttribute('viewBox', '0 0 24 24'); v.setAttribute('aria-hidden', 'true');\n  const ci = document.createElementNS(ns, 'circle'); ci.setAttribute('cx', '12'); ci.setAttribute('cy', '12'); ci.setAttribute('r', '9');\n  const pa = document.createElementNS(ns, 'path'); pa.setAttribute('d', 'M12 11v5M12 8h.01');\n  v.append(ci, pa);\n  const t = document.createElement('div');\n  const b = document.createElement('b'); b.textContent = `${PLATFORM_COPY.title}.`;\n  t.append(b, document.createTextNode(` ${PLATFORM_COPY.body}`));\n  c.append(v, t);\n  host.prepend(c);\n}\n// the header lock the read-only menu already uses (#menulock), with this state's own line; restored when the state ends\nlet menulockText = null;\nfunction paintPlatformLock() {\n  const lock = $('menulock');\n  const label = lock && lock.querySelector('.lock');\n  if (!label) return;\n  const text = Array.from(label.childNodes).find((n) => n.nodeType === 3);\n  if (state.platformPending) {\n    if (menulockText === null) menulockText = text ? text.nodeValue : '';\n    if (text) text.nodeValue = PLATFORM_COPY.lock; else label.append(document.createTextNode(PLATFORM_COPY.lock));\n    lock.classList.remove('hidden');\n  } else if (menulockText !== null) {\n    if (text) text.nodeValue = menulockText;\n    menulockText = null;\n    lock.classList.add('hidden');\n  }\n}\n\n",
   ""
  ],
  [
   "  if (state.platformPending === true) { $('rbtxt').textContent = PLATFORM_COPY.bar; $('discard').classList.add('hidden'); }   // F-2: the reason, said where the action is\n",
   ""
  ],
  [
   "    locked: nameHold || state.platformPending === true,   // F-2: Sherpa is updating the menu — prices and «Agregar producto» read-only\n",
   "    locked: nameHold,\n"
  ],
  [
   "  // F-2 — a Sherpa-written draft gets the calm notice INSTEAD of the reset offer; a merchant's own unpublishable draft keeps today's\n  if (state.platformPending) offerPlatformNotice($('detail'));\n  else if (state.draftUnpublishable && state.draftRid) offerResetToLive($('detail'), state.draftRid, state.sourceUpdateTime);\n  paintPlatformLock();\n",
   "  if (state.draftUnpublishable && state.draftRid) offerResetToLive($('detail'), state.draftRid, state.sourceUpdateTime);\n"
  ],
  [
   "  if (state.platformPending === true) return;   // F-2 r2 (Codex r1 P2-2): Sherpa is updating the menu — no save, no review, at ADMISSION (each flow owns its own)\n",
   ""
  ],
  [
   "  state.draft = createDraft(withPhotos(fresh.source, fresh), { canEdit: () => editLockHolder === null && state.platformPending !== true, held: savedHold });\n",
   "  state.draft = createDraft(withPhotos(fresh.source, fresh), { canEdit: () => editLockHolder === null, held: savedHold });\n"
  ],
  [
   "  if (state.platformPending === true) return;   // F-2 r2 (Codex r1 P2-2): the same admission refusal for «Enviar al dueño»\n",
   ""
  ]
 ],
 "review.js": [
  [
   "  // F-2 (owner-approved mockup ENrjdkJmw3mzy9PkFCy4D1, N2) — Sherpa wrote fields into this draft that live does not carry yet; the\n  // server refuses the reset. Nothing went wrong on the merchant's side (info, not warn); «Entendido» only closes (FIX, no target).\n  platform_changes_pending: { icon: 'info', title: 'Sherpa está actualizando tu menú',\n    detail: 'No se guardó ni se publicó nada. Cuando Sherpa termine vas a poder publicar de nuevo; tus cambios de precio podés hacerlos después.',\n    action: { id: PUBLISH_ACTIONS.FIX, label: 'Entendido' } },\n",
   ""
  ],
  [
   "    // F-2 (mockup N2) — likewise: «No se guardó ni se publicó nada» is the literal truth of a refused reset, in the approved words\n    if (code === 'platform_changes_pending') return base;\n",
   ""
  ]
 ]
};
