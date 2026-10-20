'use strict';
// PLAN-portal-membership r3 §5 / §7.5 + OWNER DECISIONS (2026-10-19) — the portal team operations ("Equipo"), as transport-free
// cores. EVERY write refuses unless platform_config/membership_writes_enabled === true (server-only flag, OFF until the owner's
// acceptance checkpoint). Only the brand's ONE owner acts: invites «Gerente de sucursal» (a WhatsApp link — grants happen ONLY
// through invite acceptance), revokes them, toggles «Puede editar el menú y los precios». Ops come from a fixed allowlist
// (CALLABLE_OPS) — the owner ops (bootstrap / transfer) are platform CLI only. HTTP wiring lands with the portal UI slice.
const F1 = require('../brands/brand-model');
const { refuseContext, isUid } = require('./membership');
const { mutateRoster, CALLABLE_OPS } = require('./roster');
const { createInvite, cancelInvite, acceptInvite } = require('./invites');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (code) => ({ ok: false, code });
const val = async (db, p) => (await db.ref(p).once('value')).val();

async function writesEnabled(db) {
  try { return (await val(db, 'platform_config/membership_writes_enabled')) === true; } catch (_) { return false; }
}
const gated = (fn) => async (deps, ctx, body) => ((await writesEnabled(deps.db)) ? fn(deps, ctx, body || {}) : fail('writes_disabled'));

const teamInvite = gated((deps, ctx, b) => createInvite(deps, ctx, { brandId: b.brandId, rids: b.rids, email: b.email, can_edit_menu: b.can_edit_menu === undefined ? false : b.can_edit_menu }));
const teamCancelInvite = gated((deps, ctx, b) => cancelInvite(deps, ctx, b.inviteId));
const teamAcceptInvite = gated((deps, ctx, b) => acceptInvite(deps, ctx, b.inviteId));
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

// Read-only (not gated): the brand's owner lists the roster. Never the index, never another brand.
async function teamList(deps, ctx, body) {
  const { db } = deps;
  const refused = refuseContext(ctx); if (refused) return refused;
  const brandId = body && body.brandId;
  if (!F1.isBrandId(brandId)) return fail('bad_brand');
  try {
    const roster = (await val(db, `brand_members/${brandId}`)) || {};
    if (!isObj(roster.owners) || !isObj(roster.owners[ctx.uid])) return fail('forbidden');
    const managers = {};
    const m = isObj(roster.managers) ? roster.managers : {};
    for (const rid of Object.keys(m).sort()) {
      for (const uid of Object.keys(isObj(m[rid]) ? m[rid] : {}).sort()) {
        managers[uid] = managers[uid] || { rids: [], can_edit_menu: false };
        managers[uid].rids.push(rid);
        if (m[rid][uid] && m[rid][uid].can_edit_menu === true) managers[uid].can_edit_menu = true;
      }
    }
    return { ok: true, owner: Object.keys(roster.owners)[0], managers };
  } catch (_) { return fail('unavailable'); }
}

module.exports = { writesEnabled, teamInvite, teamCancelInvite, teamAcceptInvite, teamRevoke, teamSetMenuPermission, teamList };
