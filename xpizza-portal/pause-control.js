// «Pausar pedidos» moves inside «Sucursales» (PLAN-portal-pausar-in-sucursales-r0 §2.1): THE pause control, extracted VERBATIM from
// pausas.js (PORTAL-UI 1a S3) — a branch's action («Pausar sucursal» / «Reanudar pedidos», or its closed / inactive note), the
// #pausemodal confirm (Motivo + Hasta) and send → setBranchPause → the handheld/CLI pause writer, unmodified. The page that shows it
// passes three hooks: the branches it may act on (candidates), a repaint, and where a failure box goes (showError).
import { setBranchPause } from './api.js';
import * as L from './branch-logic.js';
import { $, el, button, errBox, OFFLINE } from './ops-dom.js';

// «Pausar pedidos» moves inside «Sucursales» (§2.4): where an old «pausas» entry lands — the branch's page when the selection is one
// branch (or the brand has one), the list for «Todas»; an explicit rid in scope wins. Wired when the nav entry goes (§2.3).
export function pauseLanding(sel, opts = {}) {
  const inScope = L.scopeBranches(sel);
  if (opts && typeof opts.rid === 'string' && inScope.some((b) => b.rid === opts.rid)) return { view: 'suc', rid: opts.rid };
  return { view: 'suc', rid: inScope.length === 1 ? inScope[0].rid : null };
}

export function pauseControl(ctx, { candidates, repaint, showError }) {
  const V = { modal: null, busy: new Set() };
  const scrim = $('pausescrim');
  const modal = $('pausemodal');

  // the action under a branch's status, by its state (st = L.stateModel(b, now))
  function actionsFor(b, st) {
    const out = [];
    const busy = V.busy.has(b.rid);
    if (st.state === 'open') {
      const a = el('div', 'topact cact');
      const p = button('btn danger', 'Pausar sucursal', () => openModal(b), { iconName: 'pause' });
      p.disabled = busy;
      a.append(p);
      out.push(a);
    } else if (st.state === 'paused') {
      const a = el('div', 'topact cact');
      const r = button('btn accent', 'Reanudar pedidos', () => send(b, { op: 'resume' }, `${b.name} recibe pedidos otra vez`), { iconName: 'play' });
      r.disabled = busy;
      a.append(r);
      out.push(a);
    } else if (st.state === 'closed') {
      out.push(el('p', 'fnote cnote', 'Abre según su horario.'));
    } else if (st.state === 'inactive') {
      out.push(el('p', 'fnote cnote', 'Para activarla, escribinos.'));
    }
    return out;
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
      const b = candidates().find((x) => x.rid === m.rid);
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
    repaint();
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
      repaint();
      const box = (e && e.status === 409)
        ? errBox('Otra persona cambió el estado.', 'Recargá para ver cómo quedó.', () => window.location.reload())
        : (e && e.kind === 'Unavailable') ? errBox(OFFLINE[0], OFFLINE[1]) : errBox('No se pudo cambiar el estado', 'Volvé a intentar; si sigue igual, escribinos por WhatsApp.');
      showError(box);
    }
  }

  return { actionsFor };
}
