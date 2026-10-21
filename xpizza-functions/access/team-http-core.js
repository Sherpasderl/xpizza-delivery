'use strict';
// PLAN-portal-membership r3 + OWNER DECISIONS (codex build r1 P1-1) — the team operations as HTTP endpoints. Transport-free
// core: handle(name, deps, req) → { status, body }; access/team-http.js wraps each in onRequest (CORS = the portal origins).
//   memberInvite · memberCancelInvite · memberReissueInvite · memberRevoke · memberSetMenuPermission · memberUpdate · memberList  (the OWNER)
//   memberAcceptInvite                                                                               (the invitee)
// Order, every endpoint: method → Bearer → verifyIdToken (an unverifiable token is never a caller) → verified context
// (customer / handheld refused) → the brand (from the body, or the invite record) → can(<capability>) at the brand's member
// branches through the ONE resolver (team.invite / team.revoke = the brand's owner) → the team core, whose WRITES refuse
// unless platform_config/membership_writes_enabled === true (OFF until the owner's acceptance checkpoint).
const F1 = require('../brands/brand-model');
const { resolveAccess, can, refuseContext } = require('./membership');
const T = require('./team-core');
const { writesEnabled } = require('./writes-flag');
const { INVITE_ID_RE } = require('./roster');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const reply = (status, body) => ({ status, body });
const val = async (db, p) => (await db.ref(p).once('value')).val();

const ROUTES = Object.freeze({
  memberInvite:            { method: 'POST', cap: 'team.invite', brand: 'body', fn: T.teamInvite },
  memberCancelInvite:      { method: 'POST', cap: 'team.revoke', brand: 'invite', fn: T.teamCancelInvite },   // cleanup
  memberReissueInvite:     { method: 'POST', cap: 'team.invite', brand: 'invite', fn: T.teamReissueInvite },
  memberRevoke:            { method: 'POST', cap: 'team.revoke', brand: 'body', fn: T.teamRevoke },
  memberSetMenuPermission: { method: 'POST', cap: 'team.invite', brand: 'body', fn: T.teamSetMenuPermission },
  memberUpdate:            { method: 'POST', cap: 'team.invite', brand: 'body', fn: T.teamUpdateManager },     // «Editar»: branches + permiso, one txn
  memberList:              { method: 'POST', cap: 'team.revoke', brand: 'body', fn: T.teamList },             // cleanup needs the list
  memberAcceptInvite:      { method: 'POST', cap: null, brand: null, fn: T.teamAcceptInvite },   // the invitee: bound to their verified email
  memberPasswordSet:       { method: 'POST', cap: null, brand: null, fn: T.teamPasswordSet },     // /aceptar A2 done: the caller's own flag
  // «Enviar al dueño para publicar» (PLAN-portal-team-invites G3): its own facts check (manager + menu permission on a factura
  // brand) inside the core, which answers {status, body} itself. A WRITE, so it is DARK behind the shared membership write flag
  // like every other team write (codex build r1 P1).
  catalogRequestPublish:   { method: 'POST', cap: null, brand: null, raw: true, fn: async (deps, ctx, body) => ((await writesEnabled(deps.db))
    ? require('../catalog/publish-request').requestPublishCore(deps, ctx, body) : { status: 503, body: { error: 'writes_disabled' } }) },
});

const CODE_STATUS = {
  unauthenticated: 401, forbidden: 403, inviter_not_authorized: 403, email_mismatch: 403, email_unverified: 403,
  not_found: 404, writes_disabled: 503, unavailable: 503,
  superseded: 409, already_used: 409, cancelled: 409, expired: 409, pending: 409, consumed: 409, last_owner: 409, owner_count: 409,
  roster_not_empty: 409, not_a_manager: 409, location_not_member: 409, brand_invalid: 409, invalid: 409,
};
const statusOf = (code) => CODE_STATUS[code] || (/^(bad_|not_open|not_reissuable)/.test(String(code)) ? (String(code).startsWith('bad_') ? 400 : 409) : 400);

// can(cap) for this caller at ANY listed branch of the brand, member OR retired (codex build r2 P2-2): team.invite is granted
// only at a member branch; team.revoke (revoke / cancel / list — the cleanup) also at a retired one, so an owner whose last
// location retired can still remove its managers and invites.
async function canAtBrand(db, ctx, brandId, cap) {
  if (!F1.isBrandId(brandId)) return { ok: false, status: 400, error: 'bad_brand' };
  const rec = await val(db, `brands/${brandId}`);
  if (!rec || !isObj(rec.locations)) return { ok: false, status: 403, error: 'forbidden' };
  for (const rid of Object.keys(rec.locations).sort()) {
    if (rec.locations[rid] !== 'member' && rec.locations[rid] !== 'retired') continue;
    const a = await resolveAccess({ db }, ctx, rid);
    if (!a.ok) return a.code === 'unavailable' ? { ok: false, status: 503, error: 'unavailable' } : { ok: false, status: 403, error: 'forbidden' };
    if (a.brandId === brandId && can(a, cap)) return { ok: true };
  }
  return { ok: false, status: 403, error: 'forbidden' };
}

async function handle(name, deps, req) {
  const route = ROUTES[name];
  if (!route) return reply(404, { error: 'not_found' });
  const { db, verifyIdToken } = deps;
  if (!req || req.method !== route.method) return reply(405, { error: 'method_not_allowed' });
  const header = (typeof req.get === 'function' && req.get('authorization')) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return reply(401, { error: 'missing_bearer_token' });
  let decoded;
  try { decoded = await verifyIdToken(token); } catch (_) { return reply(401, { error: 'invalid_credentials' }); }
  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) return reply(401, { error: 'invalid_credentials' });
  const ctx = { uid: decoded.uid, token: decoded };
  const refused = refuseContext(ctx);
  if (refused) return reply(statusOf(refused.code), { error: refused.code });
  const body = isObj(req.body) ? req.body : {};
  try {
    if (route.cap) {
      let brandId = body.brandId;
      if (route.brand === 'invite') {
        if (!INVITE_ID_RE.test(String(body.inviteId))) return reply(400, { error: 'bad_invite' });
        const inv = await val(db, `member_invites/${body.inviteId}`);
        if (!isObj(inv)) return reply(404, { error: 'not_found' });
        brandId = inv.brandId;
      }
      const g = await canAtBrand(db, ctx, brandId, route.cap);
      if (!g.ok) return reply(g.status, { error: g.error });
    }
    if (route.raw) return await route.fn(deps, ctx, body);
    const r = await route.fn(deps, ctx, body);
    if (r && r.ok) { const { ok, ...rest } = r; return reply(200, { ok: true, ...rest }); }
    return reply(statusOf(r && r.code), { error: (r && r.code) || 'error' });
  } catch (_) {
    return reply(503, { error: 'unavailable' });
  }
}

module.exports = { handle, ROUTES, statusOf, canAtBrand };
