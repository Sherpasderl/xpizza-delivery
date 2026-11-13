// PORTAL-UI 1a — S3 «Pausar pedidos»: one card per in-scope branch holding location.pause. Pause (motivo + hasta) and resume
// go through the ONE pause control (pause-control.js → the handheld/CLI pause writer, unmodified). There is no
// Ocupado in 1a (nothing reads it yet).
import * as L from './branch-logic.js';
import { el, pill, topBlock, emptyState } from './ops-dom.js';
import { pauseControl } from './pause-control.js';

export function mountPausas(root, ctx) {
  const cardsFor = () => L.scopeBranches(ctx.sel).filter((b) => L.can(b, 'location.pause'));
  const pc = pauseControl(ctx, { candidates: cardsFor, repaint: () => render(), showError: (box) => root.insertBefore(box, root.children[1] || null) });

  function render() {
    if (!ctx.sel) return;
    const now = Date.now();
    const clock = el('span', 'pill off', `Ahora: ${L.hhmm(now)}`);
    const { top } = topBlock('Pausar pedidos', 'Pausa detiene los pedidos nuevos de la sucursal hasta que la reanudés o venza el tiempo.', [clock]);
    root.replaceChildren(top);
    const list = cardsFor();
    if (!list.length) { root.append(emptyState('Sin sucursales activas', 'Sherpa te ayuda a agregar la primera.')); return; }
    const cards = el('div', 'cards');
    for (const b of list) cards.append(card(b, now));
    root.append(cards);
  }

  function card(b, now) {
    const st = L.stateModel(b, now);
    const c = el('div', 'card');
    const head = el('div', 'chead');
    head.append(el('div', 'ctitle', b.name), pill(st.pillCls, st.label));
    const status = el('div', `status ${st.state === 'paused' ? 'stpaused' : st.state === 'open' ? 'stopen' : ''}`);
    const t = el('div');
    t.append(el('b', null, st.line1));
    if (st.line2) t.append(el('span', 'sub', st.line2));
    status.append(t);
    c.append(head, status);
    c.append(...pc.actionsFor(b, st));
    return c;
  }

  return { render, show() { render(); } };
}
