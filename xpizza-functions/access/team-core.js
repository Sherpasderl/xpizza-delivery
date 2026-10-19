'use strict';
// PLAN-portal-membership r3 §5 / §7.5 — the portal team operations ("Equipo"), as transport-free cores. EVERY write refuses
// unless platform_config/membership_writes_enabled === true (server-only flag, OFF until the owner's acceptance checkpoint).
// Grants happen ONLY through invite acceptance (a link the owner shares); a direct callable grant does not exist. Revokes are
// owner-only through mutateRoster (≥ 1 owner, actor re-validated in the transaction). The callables never reach
// bootstrap_owner: the op is built here from a fixed allowlist (CALLABLE_OPS). HTTP wiring lands with the portal UI slice.
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

const teamInvite = gated((deps, ctx, b) => createInvite(deps, ctx, { kind: b.kind, brandId: b.brandId, rid: b.rid }));
const teamCancelInvite = gated((deps, ctx, b) => cancelInvite(deps, ctx, b.inviteId));
const teamAcceptInvite = gated((deps, ctx, b) => acceptInvite(deps, ctx, b.inviteId));
const teamRevoke = gated(async (deps, ctx, b) => {
  const refused = refuseContext(ctx); if (refused) return refused;
  if (!isUid(ctx.uid)) return fail('forbidden');
  const type = b.kind === 'owner' ? 'revoke_owner' : b.kind === 'manager' ? 'revoke_manager' : null;
  if (!type || !CALLABLE_OPS.includes(type)) return fail('bad_kind');
  return mutateRoster(deps, b.brandId, { kind: 'owner', uid: ctx.uid }, { type, uid: b.uid, rid: b.rid });
});

// Read-only (not gated): an owner lists the brand's roster. Never the index, never another brand.
async function teamList(deps, ctx, body) {
  const { db } = deps;
  const refused = refuseContext(ctx); if (refused) return refused;
  const brandId = body && body.brandId;
  if (!F1.isBrandId(brandId)) return fail('bad_brand');
  try {
    const roster = (await val(db, `brand_members/${brandId}`)) || {};
    if (!isObj(roster.owners) || !isObj(roster.owners[ctx.uid])) return fail('forbidden');
    const managers = isObj(roster.managers) ? roster.managers : {};
    return {
      ok: true,
      owners: Object.keys(roster.owners).sort(),
      managers: Object.fromEntries(Object.keys(managers).sort().map((rid) => [rid, Object.keys(isObj(managers[rid]) ? managers[rid] : {}).sort()])),
    };
  } catch (_) { return fail('unavailable'); }
}

module.exports = { writesEnabled, teamInvite, teamCancelInvite, teamAcceptInvite, teamRevoke, teamList };
