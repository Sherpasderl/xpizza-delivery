// Portal «Marketing» — keyboard focus for screens that redraw whole subtrees (marketing-builder.js, marketing-detail.js). Codex r1 P2
// (0596ebae9..1df9351c0): a rerender dropped focus to BODY, and the sheets neither took, trapped nor gave focus back.
//   focusKey(root) / refocus(root, key) — the focused control before a redraw → the same control after it (its place in the tree,
//                                         checked against its signature; else the first control with that signature)
//   layered(state, root, levels, top)   — one call after each redraw: a NEW layer (sheet / calendar) takes focus; a CLOSED one gives
//                                         it back to the control that opened it; otherwise focus stays where it was
//   trapTab(e, dialog)                  — Tab / Shift+Tab cycle inside the topmost dialog
const TABBABLE = 'button, input, select, textarea, a[href], [tabindex]';   // filtered in tabbable(): not disabled, not tabindex -1
const tabbable = (n) => !n.disabled && n.getAttribute('tabindex') !== '-1';

// what makes a control «the same» across a redraw: never its state classes (a chip turns on, a row opens) — its words and its place
function sigOf(n) {
  const row = n.closest ? n.closest('[data-row]') : null;
  const data = n.dataset ? Object.entries(n.dataset).map(([k, v]) => `${k}=${v}`).join(',') : '';
  return [n.tagName, n.getAttribute('role') || '', n.getAttribute('aria-label') || '', data, row ? row.dataset.row : '', (n.textContent || '').trim().slice(0, 60)].join('|');
}
export function focusKey(root) {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!root || !a || a === document.body || !root.contains(a)) return null;
  const path = [];
  for (let n = a; n && n !== root; n = n.parentNode) path.unshift([...n.parentNode.children].indexOf(n));
  return { path, sig: sigOf(a) };
}
export function refocus(root, key) {
  if (!root || !key) return false;
  let n = root;
  for (const i of key.path) n = n && n.children ? n.children[i] : null;
  if (!n || sigOf(n) !== key.sig) n = [...root.querySelectorAll(TABBABLE)].filter(tabbable).find((x) => sigOf(x) === key.sig) || null;
  if (n && typeof n.focus === 'function') { n.focus(); return document.activeElement === n; }
  return false;
}
export function focusables(dialog) { return dialog ? [...dialog.querySelectorAll(TABBABLE)].filter(tabbable) : []; }
export function focusFirst(dialog) {
  const f = focusables(dialog);
  if (f.length) { f[0].focus(); return; }
  if (dialog) { dialog.tabIndex = -1; dialog.focus(); }
}
// state: { levels: [], stack: [] } owned by the caller · levels: the open layers now, bottom first · top(): the topmost dialog node
export function layered(state, root, key, levels, top) {
  const before = state.levels || [];
  if (levels.length > before.length) { state.stack.push(key); focusFirst(top()); }
  else if (levels.length < before.length) { const k = state.stack.pop(); if (!refocus(root, k)) refocus(root, key) || focusFirst(top()); }
  else if (key && !refocus(root, key)) focusFirst(top());
  state.levels = levels;
}
export function trapTab(e, dialog) {
  if (e.key !== 'Tab' || !dialog) return;
  const f = focusables(dialog);
  if (!f.length) { e.preventDefault(); return; }
  const i = f.indexOf(document.activeElement);
  if (e.shiftKey ? i <= 0 : i < 0 || i === f.length - 1) { e.preventDefault(); (e.shiftKey ? f[f.length - 1] : f[0]).focus(); }
}
