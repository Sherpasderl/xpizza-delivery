'use strict';
// PLAN-portal-membership r3 §5 / §7.5 + OWNER DECISIONS (2026-10-19) — the portal team operations ("Equipo"), as transport-free
// cores. EVERY write refuses unless platform_config/membership_writes_enabled === true (server-only flag, OFF until the owner's
// acceptance checkpoint). Only the brand's ONE owner acts: invites «Gerente de sucursal» (a WhatsApp link — grants happen ONLY
// through invite acceptance), revokes them, toggles «Puede editar el menú y los precios». Ops come from a fixed allowlist
// (CALLABLE_OPS) — the owner ops (bootstrap / transfer) are platform CLI only. HTTP wiring lands with the portal UI slice.
const F1 = require('../brands/brand-model');
const { refuseContext, isUid } = require('./membership');
const { mutateRoster, CALLABLE_OPS, INVITE_ID_RE } = require('./roster');
const { createInvite, cancelInvite, reissueInvite, acceptInvite, invitePreview } = require('./invites');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (code) => ({ ok: false, code });
const val = async (db, p) => (await db.ref(p).once('value')).val();

const { writesEnabled } = require('./writes-flag');
const { usesPlatformFactura } = require('../factura/eligibility');   // T-b: the server-owned fiscal fact (never a brand literal)
const PA = require('./portal-account');   // re-exported below (behaviour unchanged)
const gated = (fn) => async (deps, ctx, body) => ((await writesEnabled(deps.db)) ? fn(deps, ctx, body || {}) : fail('writes_disabled'));

const teamInvite = gated((deps, ctx, b) => createInvite(deps, ctx, { brandId: b.brandId, rids: b.rids, email: b.email, name: b.name, can_edit_menu: b.can_edit_menu === undefined ? false : b.can_edit_menu }));
const teamCancelInvite = gated((deps, ctx, b) => cancelInvite(deps, ctx, b.inviteId));
const teamReissueInvite = gated((deps, ctx, b) => reissueInvite(deps, ctx, b.inviteId));   // a fresh link; the old one is superseded
// acceptance also reports whether the account has created its portal password (A2 is skipped only when it has)
const teamAcceptInvite = gated(async (deps, ctx, b) => {
  const r = await acceptInvite(deps, ctx, b.inviteId);
  if (!r.ok) return r;
  let password_set = false;
  try { password_set = await PA.passwordSet(deps.db, ctx.uid); } catch (_) { password_set = false; }   // unknown → ask (harmless)
  // T-c (advisor ruling): what the /aceptar A2 stage shows — the brand's identity name and the CALLER's own profile (name, email),
  // only when the page asks for it (want_display: true), so every other caller's response is unchanged
  if (!(b && b.want_display === true)) return { ...r, password_set };
  let brand_name = null; let member = null;
  try {
    const inv = await val(deps.db, `member_invites/${b.inviteId}`);
    if (isObj(inv) && F1.isBrandId(inv.brandId)) {
      const n = await val(deps.db, `restaurants/${inv.brandId}/identity/name`);
      brand_name = typeof n === 'string' && n.trim() ? n.trim() : null;
      const p = await val(deps.db, `brand_members/${inv.brandId}/profiles/${ctx.uid}`);
      if (isObj(p) && typeof p.name === 'string' && typeof p.email === 'string') member = { name: p.name, email: p.email };
    }
  } catch (_) { /* display only: absent on a failed read */ }
  return { ...r, password_set, brand_name, member };
});
// the /aceptar page BEFORE sign-in: unauthenticated, read-only, uniform not-found; DARK (the same not-found) while the flag is off
const teamInvitePreview = async (deps, _ctx, b) => ((await writesEnabled(deps.db)) ? invitePreview(deps, b && b.inviteId) : fail('not_found'));
// the /aceptar A2 stage completed: record it for the CALLER only (no parameters; a verified, non-device account)
const teamPasswordSet = gated(async (deps, ctx) => {
  const refused = refuseContext(ctx); if (refused) return refused;
  if (!isUid(ctx.uid) || !(ctx.token && ctx.token.email_verified === true)) return fail('forbidden');
  try { await PA.markPasswordSet(deps.db, ctx.uid, (deps.now || Date.now)()); } catch (_) { return fail('unavailable'); }
  return { ok: true, password_set: true };
});
const asOwner = (fn) => gated(async (deps, ctx, b) => {
  const refused = refuseContext(ctx); if (refused) return refused;
  if (!isUid(ctx.uid)) return fail('forbidden');
  const op = fn(b);
  if (!op || !CALLABLE_OPS.includes(op.type)) return fail('bad_op');
  return mutateRoster(deps, b.brandId, { kind: 'owner', uid: ctx.uid }, op);
});
// revoke a manager from ONE branch (rid) or from all of the brand's branches (no rid)
const teamRevoke = asOwner((b) => ({ type: 'revoke_manager', uid: b.uid, ...(b.rid !== undefined ? { rid: b.rid } : {}) }));
// «Puede editar el menú y los precios» on/off for a manager (all their branches)
const teamSetMenuPermission = asOwner((b) => ({ type: 'set_manager_perms', uid: b.uid, can_edit_menu: b.can_edit_menu }));
// the owner's «Editar» (PLAN-portal-team-invites G2): the FULL new branch set + the menu permission in ONE transaction
const teamUpdateManager = asOwner((b) => ({ type: 'update_manager', uid: b.uid, rids: b.rids, can_edit_menu: b.can_edit_menu }));

// Read-only (not gated): the brand's owner lists the roster. Never the index, never another brand.
// Read-only (not gated): the brand's owner lists the team — PLAN-portal-team-invites G1:
//   owner   {uid, name, email}   the CALLER (the list is owner-only); name / email from the caller's verified token
//   managers [{uid, name, email, rids, can_edit_menu}]   name / email from the profile written at acceptance (null if none)
//   pending  [{inviteId, name, email, rids, can_edit_menu, created_at, expires_at}]   each CURRENT invite that is still open and
//            unexpired, read by id through invites_current (never a scan of member_invites)
//   uses_platform_factura  boolean: any of the brand's listed locations issues facturas through the platform (T-b: the
//            «Puede editar el menú» note and the «Edita · el dueño publica» label; the client never guesses from a name)
// Any read failure → unavailable (never a partial list).
async function teamList(deps, ctx, body) {
  const { db, now = () => Date.now() } = deps;
  const refused = refuseContext(ctx); if (refused) return refused;
  const brandId = body && body.brandId;
  if (!F1.isBrandId(brandId)) return fail('bad_brand');
  try {
    const roster = (await val(db, `brand_members/${brandId}`)) || {};
    if (!isObj(roster.owners) || !isObj(roster.owners[ctx.uid])) return fail('forbidden');
    const brandRec = await val(db, `brands/${brandId}`);
    const locs = isObj(brandRec) && isObj(brandRec.locations) ? brandRec.locations : {};
    const usesFactura = Object.keys(locs).some((rid) => (locs[rid] === 'member' || locs[rid] === 'retired') && usesPlatformFactura(rid));
    const tok = (ctx && ctx.token) || {};
    // the owner row: the SERVER profile (owner ruling 2026-10-20: the name is required, set by the CLI); the token only as a fallback
    const op = isObj(roster.profiles) && isObj(roster.profiles[ctx.uid]) ? roster.profiles[ctx.uid] : {};
    const owner = { uid: ctx.uid, name: typeof op.name === 'string' ? op.name : (typeof tok.name === 'string' && tok.name ? tok.name : null),
      email: typeof op.email === 'string' ? op.email : (typeof tok.email === 'string' && tok.email ? tok.email : null) };
    const m = isObj(roster.managers) ? roster.managers : {};
    const perms = isObj(roster.manager_perms) ? roster.manager_perms : {};
    const profiles = isObj(roster.profiles) ? roster.profiles : {};
    const byUid = {};
    for (const rid of Object.keys(m).sort()) {
      for (const uid of Object.keys(isObj(m[rid]) ? m[rid] : {}).sort()) {
        const p = isObj(profiles[uid]) ? profiles[uid] : {};
        // the ONE per-manager setting (codex build r1 P2-3) — never an OR over branch grants
        byUid[uid] = byUid[uid] || { uid, name: typeof p.name === 'string' ? p.name : null, email: typeof p.email === 'string' ? p.email : null,
          rids: [], can_edit_menu: isObj(perms[uid]) && perms[uid].can_edit_menu === true };
        byUid[uid].rids.push(rid);
      }
    }
    const managers = Object.values(byUid).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es') || a.uid.localeCompare(b.uid));
    const cur = isObj(roster.invites_current) ? roster.invites_current : {};
    const t = now();
    const pending = [];
    for (const key of Object.keys(cur).sort()) {
      const id = cur[key];
      if (typeof id !== 'string' || !INVITE_ID_RE.test(id)) continue;
      const inv = await val(db, `member_invites/${id}`);
      if (!isObj(inv) || inv.brandId !== brandId || inv.state !== 'open' || !(inv.expires_at > t)) continue;
      pending.push({ inviteId: id, name: typeof inv.name === 'string' ? inv.name : null, email: inv.email, rids: Array.isArray(inv.rids) ? inv.rids : [],
        can_edit_menu: inv.can_edit_menu === true, created_at: inv.created_at, expires_at: inv.expires_at });
    }
    pending.sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || a.inviteId.localeCompare(b.inviteId));
    return { ok: true, owner, managers, pending, uses_platform_factura: usesFactura };
  } catch (_) { return fail('unavailable'); }
}

module.exports = { writesEnabled, teamInvite, teamCancelInvite, teamReissueInvite, teamAcceptInvite, teamRevoke, teamSetMenuPermission, teamUpdateManager, teamPasswordSet, teamInvitePreview, teamList };
