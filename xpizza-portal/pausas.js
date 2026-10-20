// PORTAL-UI 1a — S3 «Pausar pedidos»: one card per in-scope branch holding location.pause. Pause (motivo + hasta) and resume
// go through setBranchPause → the handheld/CLI pause writer, unmodified. There is no Ocupado in 1a (nothing reads it yet).
import { setBranchPause } from './api.js';
import * as L from './branch-logic.js';
import { $, el, icon, button, pill, topBlock, errBox, emptyState, OFFLINE } from './ops-dom.js';

export function mountPausas(root, ctx) {
  const V = { modal: null, busy: new Set() };
  const scrim = $('pausescrim');
  const modal = $('pausemodal');

  const cardsFor = () => L.scopeBranches(ctx.sel).filter((b) => L.can(b, 'location.pause'));

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
    const busy = V.busy.has(b.rid);
    if (st.state === 'open') {
      const a = el('div', 'topact cact');
      const p = button('btn danger', 'Pausar sucursal', () => openModal(b), { iconName: 'pause' });
      p.disabled = busy;
      a.append(p);
      c.append(a);
    } else if (st.state === 'paused') {
      const a = el('div', 'topact cact');
      const r = button('btn accent', 'Reanudar pedidos', () => send(b, { op: 'resume' }, `${b.name} recibe pedidos otra vez`), { iconName: 'play' });
      r.disabled = busy;
      a.append(r);
      c.append(a);
    } else if (st.state === 'closed') {
      c.append(el('p', 'fnote cnote', 'Abre según su horario.'));
    } else if (st.state === 'inactive') {
      c.append(el('p', 'fnote cnote', 'Para activarla, escribinos.'));
    }
    return c;
  }

  // ── the modal ──
  function openModal(b) {
    V.modal = { rid: b.rid, name: b.name, reason: 0, dur: 0 };
    paintModal();
    scrim.classList.add('show');
    const first = modal.querySelector('button.pchip');
    if (first && first.focus) first.focus();
  }
  function closeModal() { V.modal = null; scrim.classList.remove('show'); modal.replaceChildren(); }
  function chips(list, cur, pick, label) {
    const f = el('div', 'fld');
    f.append(el('span', 'plab', label));
    const row = el('div', 'chips');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', label);
    list.forEach((x, i) => {
      const ch = button(`pchip${i === cur ? ' pchipon' : ''}`, x, () => { pick(i); paintModal(); });
      ch.setAttribute('role', 'radio');
      ch.setAttribute('aria-checked', i === cur ? 'true' : 'false');
      row.append(ch);
    });
    f.append(row);
    return f;
  }
  function paintModal() {
    const m = V.modal;
    if (!m) return;
    const mh = el('div', 'mh');
    const title = el('div', 'mt', `Pausar ${m.name}`); title.id = 'pausetitle';
    mh.append(title, el('div', 'ms', 'Mientras esté pausada no recibe pedidos nuevos.'));
    const mb = el('div', 'mb');
    mb.append(chips(L.PAUSE_REASONS, m.reason, (i) => { m.reason = i; }, 'Motivo'),
      chips(L.PAUSE_DURS.map((d) => d.label), m.dur, (i) => { m.dur = i; }, 'Hasta'));
    const mf = el('div', 'mf');
    const go = button('btn danger solid', 'Pausar', () => {
      const b = cardsFor().find((x) => x.rid === m.rid);
      if (!b) { closeModal(); return; }
      const reason = L.PAUSE_REASONS[m.reason];
      const dur = L.PAUSE_DURS[m.dur].dur_min;
      closeModal();
      send(b, { op: 'pause', reason, dur_min: dur }, `${b.name} pausada`);
    });
    mf.append(button('btn ghost', 'Cancelar', closeModal), go);
    modal.replaceChildren(mh, mb, mf);
  }
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && V.modal) closeModal(); });

  async function send(b, body, okText) {
    if (V.busy.has(b.rid)) return;
    const gen = ctx.gen();
    V.busy.add(b.rid);
    ctx.setBusy(`pause-${b.rid}`, true);
    render();
    // codex 1a r1 P1-1: released on EVERY settlement; an obsolete one (auth generation bumped) only skips the UI updates
    try {
      const out = await setBranchPause({ rid: b.rid, ...body, token: ctx.token });
      V.busy.delete(b.rid);
      ctx.setBusy(`pause-${b.rid}`, false);
      if (!ctx.alive(gen)) return;
      if (out && out.control) ctx.patchBranch(b.rid, { control: out.control });
      ctx.toast(okText);
    } catch (e) {
      V.busy.delete(b.rid);
      ctx.setBusy(`pause-${b.rid}`, false);
      if (!ctx.alive(gen)) return;
      render();
      const box = (e && e.status === 409)
        ? errBox('Otra persona cambió el estado.', 'Recargá para ver cómo quedó.', () => window.location.reload())
        : (e && e.kind === 'Unavailable') ? errBox(OFFLINE[0], OFFLINE[1]) : errBox('No se pudo cambiar el estado', 'Volvé a intentar; si sigue igual, escribinos por WhatsApp.');
      root.insertBefore(box, root.children[1] || null);
    }
  }

  return { render, show() { render(); } };
}
