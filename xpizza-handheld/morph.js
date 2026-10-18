// H1b (codex H1b r1 P2-10) — patch the screen instead of rebuilding it: the 1 s heartbeat must not destroy scroll positions, focus
// or running CSS animations (sheet / banner / undo drain). morph(target, html) parses the new markup once and walks it against the
// live DOM POSITIONALLY: same node type + tag → keep the node, sync its attributes and text, recurse; otherwise replace that node.
// An <input>'s live value is never touched (typing survives). The caller skips the call entirely when the markup is unchanged.
export function morph(target, html) {
  const t = target.ownerDocument.createElement('template');
  t.innerHTML = html;
  patchChildren(target, t.content);
}

function same(a, b) {
  return a.nodeType === b.nodeType && (a.nodeType !== 1 || a.nodeName === b.nodeName);
}

function patchAttrs(a, b) {
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name) && name !== 'value') a.removeAttribute(name);
  for (const { name, value } of [...b.attributes]) {
    if (a.nodeName === 'INPUT' && name === 'value') continue;
    if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  }
}

function patchChildren(a, b) {
  const have = [...a.childNodes]; const want = [...b.childNodes];
  for (let i = 0; i < want.length; i++) {
    const x = have[i]; const y = want[i];
    if (!x) a.appendChild(y.cloneNode(true));
    else if (!same(x, y)) a.replaceChild(y.cloneNode(true), x);
    else if (x.nodeType === 1) { patchAttrs(x, y); patchChildren(x, y); }
    else if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue;
  }
  for (let i = want.length; i < have.length; i++) a.removeChild(have[i]);
}
