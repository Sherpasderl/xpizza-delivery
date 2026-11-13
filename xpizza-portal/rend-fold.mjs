// «Rendimiento» (P-1 nav, owner 11-13 map Q4): the change's EXACT hunks, [now, was] per file, cut against
// REND_BASE (the P-1 branch's base: 5ffix 7c0774c7). Folded out FIRST by portalui-guards (the newest layer, above RP), so RP and every older pin
// judge exactly what they judged before. Regenerated only from the change's diff (D4c-grill/review-portal/p1/gen_rend_fold.py);
// an edit outside these hunks, or inside one, fails.
export const REND_BASE = '7c0774c7';
export const REND_FOLD = {
 "ventas.js": [
  [
   "  tab: 'ventas',       // «Rendimiento»'s open tab (Ventas by default)\n",
   ""
  ],
  [
   "// ── «Rendimiento» (owner 11-13, map Q4): today's Ventas page under ONE entry with text tabs (MOCKUP-portal-map.html s-rend). Ventas\n// is the first tab and the default; another tab registers its pane (Calificaciones when its approved view lands). At most three tabs.\nconst REND_MAX = 3;\nconst REND_TABS = [];\nexport function registerRendTab({ id, label, mount, unmount } = {}) {\n  if (typeof id !== 'string' || !id || id === 'ventas' || REND_TABS.some((t) => t.id === id)) throw new Error('registerRendTab: bad or duplicate id');\n  if (typeof label !== 'string' || !label || typeof mount !== 'function') throw new Error('registerRendTab: a label and mount() are required');\n  if (REND_TABS.length + 1 >= REND_MAX) throw new Error('registerRendTab: at most three tabs');\n  REND_TABS.push({ id, label, mount, unmount: typeof unmount === 'function' ? unmount : () => {} });\n}\nconst tabOf = (id) => REND_TABS.find((t) => t.id === id) || null;\n// shell.js goto('calificaciones' | 'rendimiento' | 'ventas') names the tab first; an unknown or unregistered tab is Ventas\nlet wantTab = null;\ndocument.addEventListener('portal:rend-tab', (e) => { wantTab = e && e.detail ? e.detail.tab : null; });\n\n",
   ""
  ],
  [
   "  if (S.tab !== 'ventas' && tabOf(S.tab)) tabOf(S.tab).unmount();\n  S.tab = view === 'ventas' && wantTab && tabOf(wantTab) ? wantTab : 'ventas';\n  wantTab = null;\n",
   ""
  ],
  [
   "  if (v) { buildPage(); if (S.tab === 'ventas') load(); else showTab(S.tab); }\n}\nfunction showTab(id) {\n  if (!refs || !refs.tabs) return;\n  const prev = S.tab;\n  if (prev !== id && prev !== 'ventas' && tabOf(prev)) tabOf(prev).unmount();\n  S.tab = tabOf(id) ? id : 'ventas';\n  for (const [tid, b] of refs.tabs) {\n    const on = tid === S.tab;\n    b.classList.toggle('on', on);\n    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');\n  }\n  const sales = S.tab === 'ventas';\n  for (const n of [refs.acts, refs.note, refs.period, refs.body]) n.classList.toggle('hidden', !sales);\n  refs.pane.classList.toggle('hidden', sales);\n  refs.pane.replaceChildren();\n  if (sales) { if (prev !== 'ventas') load(); }\n  else tabOf(S.tab).mount(refs.pane);\n",
   "  if (v) { buildPage(); load(); }\n"
  ],
  [
   "  const h1 = el('h1', null, 'Rendimiento');\n",
   "  const h1 = el('h1', null, 'Ventas');\n"
  ],
  [
   "  const lede = el('p', 'lede', 'Cómo le va a tu restaurante: ventas y lo que dicen tus clientes.');\n",
   "  const lede = el('p', 'lede');\n"
  ],
  [
   "  const tabbar = el('nav', 'ttabs');\n  tabbar.setAttribute('aria-label', 'Secciones de Rendimiento');\n  const tabs = new Map();\n  for (const t of [{ id: 'ventas', label: 'Ventas' }, ...REND_TABS]) {\n    const b = el('button', 'ttab', t.label);\n    b.type = 'button';\n    b.addEventListener('click', () => { if (S.tab !== t.id) showTab(t.id); });\n    tabs.set(t.id, b);\n    tabbar.append(b);\n  }\n",
   ""
  ],
  [
   "  const pane = el('div', 'hidden');   // another tab's pane (its own classes); empty and hidden on Ventas\n  main.replaceChildren(head, tabbar, note, period, body, pane);\n  refs = { lede, daily, orders, note, presetBtns, rl, custom, from, to, cerr, sel, body, acts, period, tabs, pane };\n  for (const [tid, b] of tabs) { const on = tid === S.tab; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); }\n  if (S.tab !== 'ventas') { for (const n of [acts, note, period, body]) n.classList.add('hidden'); pane.classList.remove('hidden'); }\n",
   "  main.replaceChildren(head, note, period, body);\n  refs = { lede, daily, orders, note, presetBtns, rl, custom, from, to, cerr, sel, body };\n"
  ],
  [
   "  if (!refs) return;\n  const range = currentRange();\n",
   "  if (!refs) return;\n  const range = currentRange();\n  const name = ($('shopname') && $('shopname').textContent) || '';\n  refs.lede.textContent = `Cómo se está vendiendo ${name && name !== '—' ? name : 'tu local'} en el período que elijas.`;\n"
  ]
 ]
};
