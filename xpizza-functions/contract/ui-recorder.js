'use strict';
/* R3 P1-b — the PAGE UI-EVENT RECORDER (contract-owned; journeys install it, never re-implement it). Installed in a
 * page's beforeScripts (before ANY page script runs), it records every user-action event that reaches the document in
 * the CAPTURE phase, with the target's ancestor PATH: per element its id, classes, data-* attribute NAMES and its
 * onclick source. scenario-state's `no-ui:<page>:<kind>=<value>` context is decided over this record: a handler wired
 * to a control can only run if an event reached that control. The sink is COMPLETE only when installed before the
 * page's scripts (installedAt === 'beforeScripts'); anything else → unknown → the exclusion does not apply. */
const TYPES = Object.freeze(['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'keydown', 'keyup', 'input', 'change', 'submit']);

function describe(el) {
  const path = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const attrs = []; for (const a of n.attributes || []) if (/^data-/.test(a.name)) attrs.push(a.name);
    path.push({ tag: n.tagName.toLowerCase(), id: n.id || '', cls: [...(n.classList || [])], attrs, onclick: n.getAttribute('onclick') || '' });
  }
  return path;
}
// install on a page window; returns the sink { installedAt, events[] }
function installUiRecorder(win, installedAt = 'beforeScripts') {
  const sink = { installedAt, events: [] };
  for (const t of TYPES) win.document.addEventListener(t, (e) => { const el = e.target && e.target.nodeType === 1 ? e.target : null; sink.events.push({ type: t, path: el ? describe(el) : [] }); }, true);
  return sink;
}
// does a recorded event's path match kind=value?
function matches(ev, kind, value) {
  return (ev.path || []).some((n) => (kind === 'attr' ? n.attrs.includes(value) : kind === 'class' ? n.cls.includes(value) : kind === 'id' ? n.id === value : kind === 'onclick' ? n.onclick.includes(value) : false));
}
module.exports = { TYPES, installUiRecorder, matches, describe };
