// PLAN-portal-team-invites T-b — the pure half of «Equipo de trabajo»: rows from memberList, the invite / edit / remove modal
// copy, validation and relative time. No DOM, no network, no clock of its own (`now` is passed in) — so every string the owner
// reads is decided in one tested place. Copy is verbatim from the owner-approved prototype v3.1 (sEquipo, mInvite, mRemove).

// the SAME grammar the server enforces (access/invites.js EMAIL_RE): a value the client accepts is one the server accepts
export const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s.]{2,}$/;
export const NAME_MAX = 80;   // access/roster.js NAME_MAX

export const emailOk = (email) => typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
export const nameOk = (name) => typeof name === 'string' && name.trim().length > 0 && name.trim().length <= NAME_MAX;

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
// «ahora» · «hace 12 min» · «hace 3 h» · «hace 1 día» / «hace 4 días» (a future or missing time reads «ahora»)
export function relTime(at, now) {
  const d = Number.isFinite(at) && Number.isFinite(now) ? now - at : 0;
  if (d < MIN) return 'ahora';
  if (d < HOUR) return `hace ${Math.floor(d / MIN)} min`;
  if (d < DAY) return `hace ${Math.floor(d / HOUR)} h`;
  const n = Math.floor(d / DAY);
  return `hace ${n} ${n === 1 ? 'día' : 'días'}`;
}

// names for a list of rids, in the given branch order; an unknown rid falls back to the rid itself (never dropped silently)
export function brNames(rids, branches) {
  const byRid = new Map((branches || []).map((b) => [b.rid, b.name]));
  return (Array.isArray(rids) ? rids : []).map((r) => byRid.get(r) || r).join(', ');
}

export function editLabel(canEdit, factura) {
  return canEdit ? (factura ? 'Edita · el dueño publica' : 'Edita y publica') : 'Solo agotados';
}

// pill classes: tok (green) · twarn (amber) · off — the prototype's ok / warn / off, under names no other portal rule uses
// memberList → table rows: the owner («Sos vos»), managers, then the pending invites (the server's order within each)
export function rowsFrom(list, branches, now) {
  if (!list || typeof list !== 'object') return [];
  const factura = list.uses_platform_factura === true;
  const rows = [];
  const o = list.owner || {};
  rows.push({ key: `o:${o.uid || ''}`, kind: 'owner', name: o.name || o.email || 'Vos', sub: o.email || '', role: 'Dueño', branches: 'Todas',
    editCls: 'tok', editLabel: 'Edita y publica', cls: 'tok', state: 'Activo', self: true, active: false, pending: false });
  for (const m of Array.isArray(list.managers) ? list.managers : []) {
    rows.push({ key: `m:${m.uid}`, kind: 'manager', uid: m.uid, name: m.name || m.email || 'Gerente', sub: m.email || '', email: m.email || '',
      role: 'Gerente de sucursal', branches: brNames(m.rids, branches), rids: Array.isArray(m.rids) ? m.rids.slice() : [], canEdit: m.can_edit_menu === true,
      editCls: m.can_edit_menu === true ? 'tok' : 'off', editLabel: editLabel(m.can_edit_menu === true, factura), cls: 'tok', state: 'Activo',
      self: false, active: true, pending: false });
  }
  for (const p of Array.isArray(list.pending) ? list.pending : []) {
    rows.push({ key: `p:${p.inviteId}`, kind: 'pending', inviteId: p.inviteId, name: p.name || p.email, email: p.email,
      sub: `Invitación enviada a ${p.email} · ${relTime(p.created_at, now)} · sin usar`, role: 'Gerente de sucursal',
      branches: brNames(p.rids, branches), rids: Array.isArray(p.rids) ? p.rids.slice() : [], canEdit: p.can_edit_menu === true,
      editCls: p.can_edit_menu === true ? 'tok' : 'off', editLabel: editLabel(p.can_edit_menu === true, factura), cls: 'twarn', state: 'Invitación pendiente',
      self: false, active: false, pending: true });
  }
  return rows;
}

export const teamCount = (rows) => `${rows.length} persona` + '(s)';   // split so no scanner reads «persona(» as a call
export const isEmpty = (list) => !!list && !(Array.isArray(list.managers) && list.managers.length) && !(Array.isArray(list.pending) && list.pending.length);

// a fresh invite draft / an edit draft for a manager row
export const newDraft = () => ({ mode: 'invite', name: '', email: '', rids: [], canEdit: false });
// held: the assignment as it was when Editar opened — a retired branch in it is shown (removable), never offered as a new grant
export const editDraft = (row) => ({ mode: 'edit', uid: row.uid, name: row.name, email: row.email, rids: row.rids.slice(), held: row.rids.slice(), canEdit: row.canEdit === true });
export const RETIRED_SUB = 'Ya no está activa';

// the invite / edit modal's copy and gating (prototype mInvite)
export function inviteView(draft, branches, factura) {
  const d = draft || newDraft();
  const edit = d.mode === 'edit', sent = d.mode === 'sent';
  const email = String(d.email || '');
  const bad = !!email && !emailOk(email);
  const one = d.rids.length === 1 ? (branches || []).find((b) => b.rid === d.rids[0]) : null;
  return {
    isNew: !edit, showForm: !sent, showLink: sent,
    title: sent ? 'Invitación enviada' : (edit ? `Editar a ${d.name}` : 'Invitar gerente'),
    sub: sent ? 'Ya puede crear su acceso desde el correo.' : (edit ? 'Cambiá sus sucursales o su permiso de menú.' : 'Le llega un correo con un enlace de un solo uso para crear su acceso.'),
    emailBad: bad,
    brText: d.rids.length === 1 ? (one ? one.name : d.rids[0]) : `${d.rids.length} sucursales`,
    permText: d.canEdit ? ' y permiso para editar el menú' : '',
    canEditNote: factura
      ? 'Edita productos y precios de toda la marca. Como esta marca factura por la plataforma, sus cambios te llegan y los publicás vos con la autorización fiscal.'
      : 'Edita productos y precios de toda la marca y los publica directo, igual que vos. Apagado: solo marca agotados.',
    disabled: (!edit && (!nameOk(d.name) || !emailOk(email))) || d.rids.length === 0,
    cta: edit ? 'Guardar' : 'Enviar invitación',
    foot: sent ? 'Un solo uso · vence en 7 días' : (d.rids.length ? `${d.rids.length} sucursal` + '(es)' : 'Elegí al menos una sucursal'),
  };
}

// the remove / cancel confirmation (prototype mRemove)
export function removeView(row, branches) {
  const pending = row.kind === 'pending';
  return {
    title: pending ? `¿Cancelar la invitación de ${row.name}?` : `¿Quitar el acceso a ${row.name}?`,
    email: row.email || '',
    body: pending ? 'El enlace del correo deja de funcionar en el momento. Podés invitar de nuevo cuando querás.'
      : `Deja de entrar al portal y al handheld de ${brNames(row.rids, branches) || 'sus sucursales'} en el momento. Los equipos que vinculó siguen funcionando.`,
    cta: pending ? 'Cancelar invitación' : 'Quitar acceso',
    done: pending ? 'Invitación cancelada' : 'Acceso quitado',
  };
}

// a write that lost a race (the target changed under the owner): reload the list quietly instead of an error
const STALE = new Set(['not_found', 'superseded', 'cancelled', 'already_used', 'expired', 'consumed', 'not_a_manager', 'not_open']);
export const isStale = (code) => typeof code === 'string' && (STALE.has(code) || code.startsWith('not_reissuable'));

export const TEAM_LEDE = 'Quién entra al portal y al handheld. Hay un solo dueño por marca; los gerentes ven solo sus sucursales, y vos decidís si pueden editar el menú y los precios.';
export const TEAM_QUIET = 'El gerente puede: aceptar pedidos en el handheld, marcar agotados, poner Ocupado o Pausa, ver ventas de su sucursal, vincular y desvincular equipos. Si le activás «Puede editar el menú y los precios», también edita productos y precios de toda la marca. Nunca puede: invitar gente, editar la marca ni ver otras sucursales.';
export const ROLE_SUB = 'Pedidos, agotados, Ocupado/Pausa, equipos y ventas de sus sucursales. Hay un solo dueño por marca: sos vos.';
export const INVITE_ERROR = ['No pudimos enviar la invitación', 'Quedó pendiente en la lista. Revisá que el correo esté bien escrito y usá «Reenviar»; si sigue igual, escribinos por WhatsApp.'];
export const EMPTY = ['Solo estás vos', 'Invitá a un gerente por sucursal para que maneje pedidos y pausas sin tu cuenta.'];
