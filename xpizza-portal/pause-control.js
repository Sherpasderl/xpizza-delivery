// «Pausar pedidos» moves inside «Sucursales» (PLAN-portal-pausar-in-sucursales-r0 §2.1): THE pause control, extracted VERBATIM from
// pausas.js (PORTAL-UI 1a S3), now on each branch's page (§2.2) — a branch's action («Pausar sucursal» / «Reanudar pedidos»), the
// #pausemodal confirm (Motivo + Hasta) and send → setBranchPause → the handheld/CLI pause writer, unmodified. The page that shows it
// passes three hooks: the branches it may act on (candidates), a repaint, and where a failure box goes (showError).
import { setBranchPause, getMyBranches } from './api.js';
import * as L from './branch-logic.js';
import { $, el, button, errBox, OFFLINE } from './ops-dom.js';
import { knownControl } from './control-state.js';   // THE known control states (one shared list)

// Codex backfill r2 (advisor 11-15): ONE pause state per page session, shared by EVERY view's controller (Inicio and Sucursales each make
// one): a branch's LOCK (a write or its recovery in flight — every view disables that branch's actions), the per-branch READ GENERATION
// (any write or re-read anywhere invalidates the older re-reads of that branch), and the views to repaint when a lock moves.
const STORE = { busy: new Set(), reads: new Map(), views: new Set() };
const nextRead = (rid) => { const g = (STORE.reads.get(rid) || 0) + 1; STORE.reads.set(rid, g); return g; };
// a NEW account / sign-in starts a new session: its locks and read generations never carry over (an in-flight recovery of the old
// context is abandoned — its continuation sees ctx.alive() false); the views' repaints stay registered (the views outlive a sign-in)
const hooked = new WeakSet();   // each document once (a page has one; a test harness swaps documents)
function hookAuth() {
  if (typeof document === 'undefined' || hooked.has(document)) return;
  hooked.add(document);
  document.addEventListener('portal:auth', () => { STORE.busy.clear(); STORE.reads.clear(); });
}
// test-only: a fresh page session (the suites share ONE module instance across cells; a real page starts with an empty store)
export function _resetPauseStore() { STORE.busy.clear(); STORE.reads.clear(); STORE.views.clear(); }
function lock(rid, on) {
  if (on) STORE.busy.add(rid); else STORE.busy.delete(rid);
  for (const repaint of STORE.views) { try { repaint(); } catch (_) { /* one view's repaint never blocks another's */ } }
}

// «Pausar pedidos» moves inside «Sucursales» (§2.4): where an old «pausas» entry lands — the branch's page when the selection is one
// branch (or the brand has one), the list for «Todas»; an explicit rid in scope wins. Wired when the nav entry goes (§2.3).
export function pauseLanding(sel, opts = {}) {
  const inScope = L.scopeBranches(sel);
  if (opts && typeof opts.rid === 'string' && inScope.some((b) => b.rid === opts.rid)) return { view: 'suc', rid: opts.rid };
  return { view: 'suc', rid: inScope.length === 1 ? inScope[0].rid : null };
}

export function pauseControl(ctx, hooks) {
  const { candidates, repaint, showError } = hooks;
  const clearError = typeof hooks.clearError === 'function' ? hooks.clearError : () => {};
  const V = { modal: null };
  STORE.views.add(repaint);
  hookAuth();
  const scrim = $('pausescrim');
  const modal = $('pausemodal');

  // the branch page's action (PLAN §2.2, MOCKUP-portal-pausar-in-sucursales F1/F2): «Pausar sucursal» on an OPEN branch, «Reanudar
  // pedidos» on a PAUSED one — today's card buttons; disabled while this branch's call is in flight. Closed / inactive: none.
  function actionFor(b, st) {
    const busy = STORE.busy.has(b.rid);
    if (st.state === 'open') { const p = button('btn danger', 'Pausar sucursal', () => openModal(b), { iconName: 'pause' }); p.disabled = busy; return p; }
    if (st.state === 'paused') { const r = button('btn accent', 'Reanudar pedidos', () => send(b, { op: 'resume' }, `${b.name} recibe pedidos otra vez`), { iconName: 'play' }); r.disabled = busy; return r; }
    return null;
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

  // a control the page can paint as a FACT: the server's enum only (control-state.js) — 'unknown', '' or 'bogus' never are
  const definite = knownControl;
  async function send(b, body, okText) {
    if (STORE.busy.has(b.rid)) return;
    const gen = ctx.gen();
    nextRead(b.rid);   // a write invalidates every older re-read of this branch, in every view
    lock(b.rid, true);
    ctx.setBusy(`pause-${b.rid}`, true);
    clearError(b.rid);
    repaint();
    // codex 1a r1 P1-1: released on EVERY settlement; an obsolete one (auth generation bumped) only skips the UI updates
    let out = null, err = null;
    try {
      out = await setBranchPause({ rid: b.rid, ...body, token: ctx.token });
    } catch (e) {
      err = e;   // judged below: an ambiguous transport failure, or a definite refusal (a panel, never a toast)
    }
    ctx.setBusy(`pause-${b.rid}`, false);
    if (!ctx.alive(gen)) { lock(b.rid, false); return; }
    // Codex backfill P1 (advisor 11-15, rule 17's spirit): an AMBIGUOUS outcome — the reply lost in transport (status 0), a malformed 200,
    // or the server's own control.state «unknown» — is UNKNOWN: no success toast, the neutral box, the actions kept disabled until the
    // AUTHORITATIVE control state is read back
    if (err ? (err.kind === 'Unavailable' && !err.status) : !(out && out.ok === true && definite(out.control))) { unconfirmed(b, gen); return; }
    lock(b.rid, false);
    if (!err) { ctx.patchBranch(b.rid, { control: out.control }); ctx.toast(okText); return; }
    repaint();
    const box = (err.status === 409)
      ? errBox('Otra persona cambió el estado.', 'Recargá para ver cómo quedó.', () => window.location.reload())
      : (err.kind === 'Unavailable') ? errBox(OFFLINE[0], OFFLINE[1]) : errBox('No se pudo cambiar el estado', 'Volvé a intentar; si sigue igual, escribinos por WhatsApp.');
    showError(box, b.rid);   // Codex backfill P2: the box belongs to the branch it was SUBMITTED for
  }
  // the authoritative re-read (getMyBranches), the newest per branch wins: the state AS READ, then the actions; a failed / unknown read
  // leaves the box and keeps the actions disabled (advisor 11-15). Copy: two approved strings (review.js + the Pausar 409 body), (a).
  async function unconfirmed(b, gen) {
    showError(errBox('No pudimos confirmar el resultado', 'Recargá para ver cómo quedó.'), b.rid);
    const seq = nextRead(b.rid);   // the newest re-read of this branch, across every view
    let e1 = null;
    try {
      e1 = await getMyBranches({ token: ctx.token });
    } catch (_) {
      e1 = null;   // the re-read failed: still unknown
    }
    if (!ctx.alive(gen) || STORE.reads.get(b.rid) !== seq) return;   // a newer write / re-read (in any view) or another context decides
    const row = e1 && Array.isArray(e1.branches) ? e1.branches.find((x) => x && x.rid === b.rid) : null;
    if (!row || !definite(row.control)) { repaint(); return; }   // still unknown: the box stays, the actions stay disabled
    lock(b.rid, false);
    clearError(b.rid);
    ctx.patchBranch(b.rid, { control: row.control });
  }

  // INICIO (PLAN-portal-inicio-r0 ann 3): «Reanudar» acts in place from the home — the SAME request, toast and failure boxes as the
  // branch page's «Reanudar pedidos»; busy(rid) lets that row disable itself while its call is in flight
  const resume = (b) => send(b, { op: 'resume' }, `${b.name} recibe pedidos otra vez`);
  const busy = (rid) => STORE.busy.has(rid);
  return { actionFor, resume, busy };
}
