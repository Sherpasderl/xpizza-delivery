// H1b (codex H1b r1 P2-10, r2 P2-4) — patch the screen instead of rebuilding it: the 1 s heartbeat and state changes must not destroy
// scroll positions, focus, typed text or running CSS animations. morph(target, html) parses the new markup once and walks it against
// the live DOM:
//   - KEYED nodes (an `id` or a `data-key`) are matched by key among their siblings — wherever they moved — so an inserted banner
//     never replaces the list body below it (scroll kept) or a sheet's input (typing and focus kept);
//   - unkeyed nodes are matched by position: same node type + tag → keep, sync attributes and text, recurse; otherwise replace.
// An <input>'s live value is never touched. The caller skips the call entirely when the markup is unchanged.
export function morph(target, html) {
  const t = target.ownerDocument.createElement('template');
  t.innerHTML = html;
  patchChildren(target, t.content);
}

const keyOf = (n) => (n.nodeType === 1 ? (n.getAttribute('id') || n.getAttribute('data-key') || null) : null);
const same = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || a.nodeName === b.nodeName);

function patchAttrs(a, b) {
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name) && name !== 'value') a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) {
    if (a.nodeName === 'INPUT' && name === 'value') continue;
    if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  }
}

function patchNode(x, y) {
  if (x.nodeType === 1) { patchAttrs(x, y); patchChildren(x, y); } else if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue;
}

function patchChildren(a, b) {
  const want = [...b.childNodes];
  const wanted = new Set(want.map(keyOf).filter(Boolean));
  const byKey = new Map();
  for (const c of a.childNodes) { const k = keyOf(c); if (k) byKey.set(k, c); }
  for (let i = 0; i < want.length; i++) {
    // a keyed node that is no longer wanted (e.g. a banner going away) is REMOVED in place, so the wanted nodes after it slide into
    // position without being moved — a DOM move would reset a scroll container's scrollTop
    while (a.childNodes[i] && keyOf(a.childNodes[i]) && !wanted.has(keyOf(a.childNodes[i]))) a.removeChild(a.childNodes[i]);
    const y = want[i]; const x = a.childNodes[i] || null; const k = keyOf(y);
    if (k) {
      const m = byKey.get(k);
      if (m && same(m, y)) {
        // bring m to position i WITHOUT moving it whenever possible: drop the nodes before it that are unkeyed (re-created later if
        // still wanted) or keyed-but-unwanted. Only a wanted keyed node in between forces a real move (a move can reset scroll).
        let cur = a.childNodes[i];
        while (cur && cur !== m && (!keyOf(cur) || !wanted.has(keyOf(cur)))) { const nx = cur.nextSibling; a.removeChild(cur); cur = nx; }
        if (a.childNodes[i] !== m) a.insertBefore(m, a.childNodes[i] || null);
        byKey.delete(k); patchNode(m, y);
      } else a.insertBefore(y.cloneNode(true), x);
      continue;
    }
    if (!x) a.appendChild(y.cloneNode(true));
    else if (keyOf(x) || !same(x, y)) a.insertBefore(y.cloneNode(true), x);   // never reuse a keyed node for unkeyed content
    else patchNode(x, y);
  }
  while (a.childNodes.length > want.length) a.removeChild(a.lastChild);
}
