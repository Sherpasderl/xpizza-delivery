// PLAN-portal-team-invites T-b — «Equipo de trabajo», the owner's team view, layered on the shell through registerView (§4.1):
// 3a makes NO shell edits. The view is HIDDEN unless the caller holds team.revoke AND the server's membership_writes_enabled is
// on (Q1); a direct goto then falls back to the default view (the shell decides). Copy is verbatim from prototype v3.1.
//
// PRIVACY / LIFECYCLE (Codex P1-5): a module generation is bumped on every portal:auth (sign-out or account change) and on
// unmount; a brand switch is a full reload. Every async continuation captures (generation, uid, brandId) at launch and drops its
// result when any of them changed — a stale invite never reaches sendInviteLink. On a bump, rows, open modals and any rendered
// name / email leave the DOM at once. Nothing is written to localStorage / sessionStorage; names and emails come only from
// memberList (owner-only on the server).
//
// DRAFT RETENTION (advisor, from the shell review): the shell never blocks a nav switch, so an open invite / edit modal and its
// fields are kept in module memory on unmount and restored on the next mount on the same page for the same uid + brand. A
// sign-out / account change clears them; a submit in flight at unmount drops the draft (its write may already have landed).
import { registerView, toast } from './shell.js';
import { token } from './auth.js';
import { getMyBranches, memberList, memberInvite, memberReissueInvite, memberCancelInvite, memberRevoke, memberUpdate } from './api.js';
import { sendInviteLink } from './invite-mail.js';
import { el, svg, icon, button, pill, topBlock, errBox, skeleton, OFFLINE } from './ops-dom.js';
import * as TL from './team-logic.js';

const ICON_D = 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21a8 8 0 0 1 16 0';
const S = {
  gen: 0, uid: null, sel: null, host: null, body: null, layer: null,
  status: 'idle', list: null, branches: [], inviteError: false, opError: false,
  modal: null,        // null | { kind: 'invite', draft } | { kind: 'remove', row }
  busy: null,         // the modal object whose write is in flight — the submission lock, held until THAT write settles (closing never frees it)
  resync: null,       // the open form's button-state refresh, re-run when the lock frees
  toasted: null,      // the text of the last toast team.js showed (it may name an email): cleared from the shared toast on wipe / unmount
  kept: null,         // { key, modal } — the retained draft between an unmount and the next mount
};
const keyOf = () => (S.uid && S.sel ? `${S.uid}|${S.sel.brandId}` : null);
const can = (cap) => !!(S.sel && S.sel.caps.includes(cap));
const factura = () => !!(S.list && S.list.uses_platform_factura === true);

// a launch snapshot; alive() = still the same generation, account and brand
function snap() {
  const g = { gen: S.gen, uid: S.uid, brandId: S.sel ? S.sel.brandId : null };
  g.alive = () => g.gen === S.gen && g.uid === S.uid && !!S.sel && g.brandId === S.sel.brandId;
  g.assertLive = () => { if (!g.alive()) throw Object.assign(new Error('obsolete'), { kind: 'obsolete' }); };
  return g;
}
const obsolete = (g, err) => !g.alive() || (err && err.kind === 'obsolete');

function bump() {
  S.gen += 1;
  S.busy = null;
}
// the shared toast, written through here so team.js knows which content is its own
function say(text) { S.toasted = text; toast(text); }
function clearToast() {
  const t = document.getElementById('opstoast');
  if (t && S.toasted !== null && t.textContent === S.toasted) { t.replaceChildren(); t.classList.remove('show'); }
  S.toasted = null;
}
// the lock frees only when the write that took it settles, and only if no later bump already freed it
function release(mine) { if (S.busy === mine) { S.busy = null; if (S.resync) S.resync(); } }
// remove every rendered row / modal / name / email from the DOM now (a generation bump that also ends the session)
function wipe() {
  S.list = null; S.branches = []; S.modal = null; S.kept = null; S.inviteError = false; S.opError = false; S.status = 'idle';
  if (S.layer) S.layer.replaceChildren();
  if (S.body) S.body.replaceChildren();
  clearToast();
}

document.addEventListener('portal:auth', (e) => {
  const uid = e && e.detail ? e.detail.uid : null;
  bump();
  if (uid !== S.uid) wipe();
  S.uid = uid;
});

// ── load ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function load() {
  const g = snap();
  if (!S.list) { S.status = 'loading'; render(); }
  try {
    const [list, e1] = await Promise.all([
      memberList({ brandId: g.brandId, token, assertLive: g.assertLive }),
      getMyBranches({ token, assertLive: g.assertLive }),
    ]);
    if (!g.alive()) return;
    S.list = list;
    S.branches = (e1 && Array.isArray(e1.branches) ? e1.branches : []).filter((b) => b && b.brand_id === g.brandId && !b.degraded);
    S.status = 'ready';
    if (S.modal && S.layer && !S.layer.firstChild) paintModal(false);   // a restored draft: painted once its branch list is here
  } catch (err) {
    if (obsolete(g, err)) return;
    if (!S.list) S.status = 'error'; else S.opError = true;
  }
  render();
}

// ── main render (the table; the modal lives in its own layer so typing never re-renders under the caret) ────────────────
function render() {
  if (!S.body) return;
  const acts = can('team.invite') ? [inviteBtn()] : [];
  const { top } = topBlock('Equipo de trabajo', TL.TEAM_LEDE, acts);
  const out = [top];
  if (S.status === 'loading') out.push(skeleton());
  else if (S.status === 'error') out.push(errBox(OFFLINE[0], OFFLINE[1], () => load()));
  else if (S.status === 'ready') {
    if (S.opError) out.push(errBox(OFFLINE[0], OFFLINE[1], () => { S.opError = false; load(); }));
    if (TL.isEmpty(S.list)) out.push(emptyBlock());
    else {
      if (S.inviteError) {
        const box = errBox(TL.INVITE_ERROR[0], TL.INVITE_ERROR[1]);
        box.append(button('btn', 'Entendido', () => { S.inviteError = false; render(); }));
        out.push(box);
      }
      out.push(table(), el('div', 'quiet', TL.TEAM_QUIET));
    }
  }
  S.body.replaceChildren(...out);
}

function inviteBtn() {   // the prototype's top action: a plus icon + «Invitar gerente» — enabled once the team data is here
  const b = button('btn accent', null, openInvite);
  b.disabled = S.status !== 'ready';
  b.append(svg('M12 5v14M5 12h14'), document.createTextNode('Invitar gerente'));
  return b;
}

function emptyBlock() {
  const d = el('div', 'detail teamempty');
  const e = el('div', 'empty');
  e.append(el('b', null, TL.EMPTY[0]), el('span', null, TL.EMPTY[1]));
  if (can('team.invite')) e.append(button('btn accent', 'Invitar gerente', openInvite));
  d.append(e);
  return d;
}

function table() {
  const rows = TL.rowsFrom(S.list, S.branches, Date.now());
  const wrap = el('div', 'tbl');
  const head = el('div', 'dhead');
  const right = el('div', 'dright');
  right.append(el('span', 'pill off', TL.teamCount(rows)));
  head.append(el('div', 'dtitle', 'Personas'), right);
  const sc = el('div', 'sc');
  const t = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Persona', 'Rol', 'Sucursales', 'Menú y precios', 'Estado', '']) hr.append(el('th', null, h));
  thead.append(hr);
  const tb = el('tbody');
  for (const r of rows) tb.append(rowEl(r));
  t.append(thead, tb);
  sc.append(t);
  wrap.append(head, sc);
  return wrap;
}

function rowEl(r) {
  const tr = el('tr');
  const who = el('td');
  who.append(el('b', null, r.name), el('span', 'tsub', r.sub));
  const editP = el('td'); editP.append(pill(r.editCls, r.editLabel));
  const stP = el('td'); stP.append(pill(r.cls, r.state));
  const a = el('div', 'acts');
  if (r.pending) {
    if (can('team.invite')) a.append(busyBtn('btn sm', 'Reenviar', `re:${r.inviteId}`, () => resend(r)));
    if (can('team.revoke')) a.append(button('btn sm ghost danger', 'Cancelar invitación', () => openRemove(r)));
  }
  if (r.active) {
    if (can('team.invite')) a.append(button('btn sm', 'Editar', () => openEdit(r)));
    if (can('team.revoke')) a.append(button('btn sm ghost danger', 'Quitar acceso', () => openRemove(r)));
  }
  if (r.self) a.append(el('span', 'fnote', 'Sos vos'));
  const act = el('td'); act.append(a);
  tr.append(who, el('td', null, r.role), el('td', null, r.branches), editP, stP, act);
  return tr;
}

const busy = new Set();
function busyBtn(cls, label, key, fn) {
  const b = button(cls, label, async () => {
    if (busy.has(key)) return;
    busy.add(key); b.disabled = true;
    try { await fn(); } finally { busy.delete(key); b.disabled = false; }
  });
  if (busy.has(key)) b.disabled = true;
  return b;
}

// ── row actions ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function resend(row) {
  const g = snap();
  let r;
  try { r = await memberReissueInvite({ inviteId: row.inviteId, token, assertLive: g.assertLive }); } catch (err) {
    if (obsolete(g, err)) return;
    if (TL.isStale(err && err.code)) { load(); return; }
    S.opError = true; render(); return;
  }
  if (!g.alive()) return;   // 🔴 a reissue that answers after the account / view changed is never mailed
  try { await sendInviteLink(r.email, r.inviteId); } catch (err) {
    if (obsolete(g, err)) return;
    S.inviteError = true; load(); return;
  }
  if (!g.alive()) return;
  say(`Nuevo enlace enviado a ${r.email} · el anterior ya no sirve`);
  load();
}

// ── modals ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function openInvite() { if (can('team.invite')) { S.modal = { kind: 'invite', draft: TL.newDraft() }; paintModal(true); } }
function openEdit(row) { if (can('team.invite')) { S.modal = { kind: 'invite', draft: TL.editDraft(row) }; paintModal(true); } }
function openRemove(row) { if (can('team.revoke')) { S.modal = { kind: 'remove', row }; paintModal(true); } }
function closeModal() { S.modal = null; S.resync = null; if (S.layer) S.layer.replaceChildren(); }

function shell(titleId, small) {
  const scrim = el('div', 'scrim show');
  const m = el('div', small ? 'modal sm' : 'modal');
  m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', titleId);
  scrim.append(m);
  return { scrim, m };
}

function paintModal(focus) {
  if (!S.layer) return;
  S.resync = null;
  if (!S.modal) { S.layer.replaceChildren(); return; }
  if (S.modal.kind === 'remove') return paintRemove();
  const d = S.modal.draft;
  const v = TL.inviteView(d, S.branches, factura());
  const { scrim, m } = shell('in-t', false);
  const mh = el('div', 'mh');
  const title = el('div', 'mt', v.title); title.id = 'in-t';
  mh.append(title, el('div', 'ms', v.sub));
  const mb = el('div', 'mb');
  const mf = el('div', 'mf');
  const foot = el('span', 'left', v.foot);
  if (v.showForm) {
    const refs = {};
    if (v.isNew) {
      const row = el('div', 'frow');
      const fn = el('div', 'fld');
      const ln = el('label', null, 'Nombre'); ln.htmlFor = 'in-name';
      const iname = el('input'); iname.id = 'in-name'; iname.type = 'text'; iname.placeholder = 'Nombre y apellido'; iname.value = d.name; iname.maxLength = TL.NAME_MAX; iname.className = 'tin';
      iname.autocomplete = 'off';
      iname.addEventListener('input', () => { d.name = iname.value; sync(); });
      fn.append(ln, iname);
      const fe = el('div', 'fld');
      const le = el('label', null, 'Correo'); le.htmlFor = 'in-mail';
      const imail = el('input'); imail.id = 'in-mail'; imail.type = 'email'; imail.placeholder = 'nombre@correo.com'; imail.value = d.email; imail.autocomplete = 'off'; imail.className = 'tin';
      const bad = el('span', 'fnote ferr', 'Escribí un correo válido.');
      imail.addEventListener('input', () => { d.email = imail.value.trim(); sync(); });
      fe.append(le, imail, bad);
      row.append(fn, fe);
      mb.append(row);
      Object.assign(refs, { iname, fe, bad });
    }
    const role = el('div', 'fld');
    const opt = el('div', 'topt sel');   // the one role: shown selected, not a control
    const rb = el('span', 'tradio'); rb.append(el('i', 'tdot'));
    const og = el('span', 'tname', 'Gerente de sucursal'); og.append(el('span', 'tnsub', TL.ROLE_SUB));
    opt.append(rb, og);
    role.append(el('span', 'lab', 'Rol'), opt);
    const brs = el('div', 'fld');
    brs.append(el('span', 'lab', 'Sucursales'));
    const brBtns = [];
    for (const b of S.branches.filter((x) => x.state === 'member')) {
      const btn = el('button', 'topt tpick'); btn.type = 'button';
      const cb = el('span', 'tcb');
      btn.append(cb, el('span', 'tname', b.name));
      btn.addEventListener('click', () => { d.rids = d.rids.includes(b.rid) ? d.rids.filter((x) => x !== b.rid) : d.rids.concat(b.rid); sync(); });
      brBtns.push({ btn, cb, rid: b.rid });
      brs.append(btn);
    }
    // Editar: an EXISTING assignment at a branch that is no longer a member stays visible so it can be removed; it is never offered
    // as a new grant, so a removed one does not come back
    const member = new Set(S.branches.filter((x) => x.state === 'member').map((x) => x.rid));
    for (const rid of (d.held || []).filter((x) => !member.has(x) && d.rids.includes(x))) {
      const btn = el('button', 'topt tpick sel'); btn.type = 'button'; btn.setAttribute('aria-pressed', 'true');
      const cb = el('span', 'tcb tcbon'); cb.append(icon('check'));
      const nm = el('span', 'tname', TL.brNames([rid], S.branches)); nm.append(el('span', 'tnsub', TL.RETIRED_SUB));
      btn.append(cb, nm);
      btn.addEventListener('click', () => { d.rids = d.rids.filter((x) => x !== rid); btn.remove(); sync(); });
      brs.append(btn);
    }
    const perm = el('div', 'fld');
    const tr = el('div', 'togrow');
    const bt = el('div', 'bt'); bt.append(el('b', null, 'Puede editar el menú y los precios'), el('span', null, v.canEditNote));
    const tog = el('button', 'tog'); tog.type = 'button'; tog.setAttribute('aria-label', 'Puede editar el menú y los precios'); tog.append(el('i'));
    tog.addEventListener('click', () => { d.canEdit = !d.canEdit; sync(); });
    tr.append(bt, tog);
    perm.append(el('span', 'lab', 'Permiso'), tr);
    const err = el('div');   // a non-stale write failure, inside the modal so the draft stays
    mb.append(role, brs, perm, err);
    const cancel = button('btn ghost', 'Cancelar', closeModal);
    const submit = button('btn accent', v.cta, () => submitInvite(submit, err));
    mf.append(foot, cancel, submit);
    function sync() {
      const w = TL.inviteView(d, S.branches, factura());
      foot.textContent = w.foot;
      submit.disabled = w.disabled || S.busy !== null;
      if (refs.fe) { refs.fe.classList.toggle('err', w.emailBad); refs.bad.classList.toggle('hidden', !w.emailBad); }
      for (const x of brBtns) {
        const on = d.rids.includes(x.rid);
        x.btn.classList.toggle('sel', on); x.btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        x.cb.classList.toggle('tcbon', on); x.cb.replaceChildren(...(on ? [icon('check')] : []));
      }
      tog.classList.toggle('off', !d.canEdit); tog.setAttribute('aria-pressed', d.canEdit ? 'true' : 'false');
    }
    sync();
    S.resync = sync;
    m.append(mh, mb, mf);
    S.layer.replaceChildren(scrim);
    if (focus) { const f = refs.iname || (brBtns[0] && brBtns[0].btn); if (f && f.focus) f.focus(); }
    return;
  }
  // sent: the confirmation (prototype showLink)
  const call = el('div', 'tsent');
  const txt = el('div');
  txt.append(el('b', null, 'Invitación enviada.'), document.createTextNode(' Le enviamos un correo a '), el('b', null, d.email),
    document.createTextNode(' con un enlace para crear su acceso. Sirve una sola vez y vence en 7 días.'));
  call.append(icon('check'), txt);
  mb.append(call, el('span', 'fnote', `Al abrirlo, ${d.name} crea su contraseña y entra con ${v.brText}${v.permText}. Si no le llega, usá «Reenviar» en la lista: manda un enlace nuevo y anula el anterior.`));
  const done = button('btn accent', 'Listo', closeModal);
  mf.append(foot, done);
  m.append(mh, mb, mf);
  S.layer.replaceChildren(scrim);
  if (focus && done.focus) done.focus();
}

async function submitInvite(btn, errHost) {
  const mine = S.modal && S.modal.kind === 'invite' ? S.modal : null;
  const d = mine ? mine.draft : null;
  if (!d || S.busy !== null) return;
  if (TL.inviteView(d, S.branches, factura()).disabled) return;
  const g = snap();
  S.busy = mine; btn.disabled = true; errHost.replaceChildren();
  // every completion touches the modal only if it is still the one that sent the write (Cancelar → a new draft is never replaced)
  const open = () => S.modal === mine;
  const fail = () => { release(mine); if (open()) errHost.replaceChildren(errBox(OFFLINE[0], OFFLINE[1])); };
  if (d.mode === 'edit') {
    try { await memberUpdate({ brandId: g.brandId, uid: d.uid, rids: d.rids.slice(), canEditMenu: d.canEdit, token, assertLive: g.assertLive }); } catch (err) {
      if (obsolete(g, err)) return;
      if (TL.isStale(err && err.code)) { release(mine); if (open()) closeModal(); load(); return; }
      fail(); return;
    }
    if (!g.alive()) return;
    release(mine);
    if (open()) closeModal();
    say('Cambios guardados'); load();
    return;
  }
  let r;
  try { r = await memberInvite({ brandId: g.brandId, name: d.name.trim(), email: d.email, rids: d.rids.slice(), canEditMenu: d.canEdit, token, assertLive: g.assertLive }); } catch (err) {
    if (obsolete(g, err)) return;
    fail(); return;
  }
  if (!g.alive()) return;   // 🔴 a stale invite never reaches the mail send
  try { await sendInviteLink(r.email, r.inviteId); } catch (err) {
    if (obsolete(g, err)) return;
    release(mine);
    if (open()) closeModal();
    S.inviteError = true; load(); return;   // the invite stays pending: the prototype errbox + «Reenviar»
  }
  if (!g.alive()) return;
  release(mine);
  if (open()) {
    S.modal = { kind: 'invite', draft: { ...d, mode: 'sent', email: r.email, name: r.name || d.name } };
    paintModal(true);
  }
  load();
}

function paintRemove() {
  const row = S.modal.row;
  const v = TL.removeView(row, S.branches);
  const { scrim, m } = shell('rm-t', true);
  const mh = el('div', 'mh');
  const title = el('div', 'mt', v.title); title.id = 'rm-t';
  mh.append(title, el('div', 'ms', v.email));
  const mb = el('div', 'mb');
  const err = el('div');
  mb.append(el('p', 'rmbody', v.body), err);
  const mf = el('div', 'mf');
  const cancel = button('btn ghost', 'Cancelar', closeModal);
  const mine = S.modal;
  const ok = button('btn danger solid', v.cta, async () => {
    if (S.busy !== null) return;
    const g = snap();
    S.busy = mine; ok.disabled = true; err.replaceChildren();
    try {
      if (row.kind === 'pending') await memberCancelInvite({ inviteId: row.inviteId, token, assertLive: g.assertLive });
      else await memberRevoke({ brandId: g.brandId, uid: row.uid, token, assertLive: g.assertLive });
    } catch (e) {
      if (obsolete(g, e)) return;
      release(mine);
      if (TL.isStale(e && e.code)) { if (S.modal === mine) closeModal(); load(); return; }
      if (S.modal === mine) err.replaceChildren(errBox(OFFLINE[0], OFFLINE[1])); return;
    }
    if (!g.alive()) return;
    release(mine);
    if (S.modal === mine) closeModal();
    say(v.done); load();
  });
  ok.disabled = S.busy !== null;
  S.resync = () => { ok.disabled = S.busy !== null; };
  mf.append(cancel, ok);
  m.append(mh, mb, mf);
  S.layer.replaceChildren(scrim);
  if (cancel.focus) cancel.focus();
}

// ── the registration (module top level, before the nav is first drawn) ───────────────────────────────────────────────────
registerView({
  id: 'equipo',
  group: 'Negocio',
  label: 'Equipo de trabajo',
  icon: ICON_D,
  visible: (sel) => !!sel && sel.caps.includes('team.revoke') && sel.membership_writes_enabled === true,
  mount(host, sel) {
    S.sel = sel;
    S.host = host;
    const wrap = el('div', 'teamv');
    S.body = el('div');
    S.layer = el('div');   // the modal layer: a sibling of the body, so a list re-render never touches an open form
    wrap.append(S.body, S.layer);
    host.replaceChildren(wrap);
    S.status = 'idle'; S.list = null; S.inviteError = false; S.opError = false; S.modal = null;
    const key = keyOf();
    if (S.kept && S.kept.key === key) { S.modal = S.kept.modal; }
    S.kept = null;
    render();
    load();
  },
  unmount() {
    // keep an in-progress invite / edit for this uid + brand; never a remove confirmation, never one whose submit was in flight
    S.kept = S.modal && S.modal.kind === 'invite' && S.modal.draft.mode !== 'sent' && S.busy !== S.modal ? { key: keyOf(), modal: S.modal } : null;
    bump();
    clearToast();
    S.modal = null; S.resync = null;
    if (S.layer) S.layer.replaceChildren();
    if (S.body) S.body.replaceChildren();
    S.list = null; S.branches = [];
    S.host = null; S.body = null; S.layer = null;
  },
  canLeave: () => true,
});

// test-only view of the module state (never read by the page)
export const _teamState = S;
