'use strict';
// PLAN-portal-membership r3 §5.2 + OWNER DECISIONS (2026-10-19) — one-time invite LINKS the OWNER sends by WhatsApp (email
// later, once there is a domain). Only «Gerente de sucursal» is invited (one or more branches; the owner's «Puede editar el
// menú y los precios» toggle rides on the invite). There are no owner invites: ONE owner per brand, changed by CLI only.
//   member_invites/{inviteId} = { kind: 'manager', brandId, rids: [rid…], can_edit_menu, email, invited_by, created_at, expires_at,
//                                 state: 'open'|'consuming'|'consumed'|'cancelled'|'expired', consuming?: { by, at } }
// DELIVERY (owner change 2026-10-19): by EMAIL through Firebase Auth's built-in mailer — the owner's portal calls the client
// SDK's sendSignInLinkToEmail(invitee, { url: …/aceptar?invite=<inviteId>, handleCodeInApp: true }). RECIPIENT BINDING: the
// acceptor's VERIFIED token must carry email === invite.email and email_verified === true (email-link sign-in sets both), so a
// forwarded link is useless to any other account; a mismatch leaves the invite open (PLAN-portal-membership delta).
// inviteId is a 128-bit random token: the link IS the secret. Deny-all in rules (Admin only).
//
// ACCEPT:
//   1. a transaction on the invite: open + unexpired → consuming {by: uid, at}. consumed by the same uid → done.
//   2. mutateRoster with actor = the INVITER, re-validated NOW, and the inviteId: the roster transaction reads the
//      application marker INSIDE the transaction, so overlapping recoveries produce at most one grant and an
//      applied-then-revoked member is never re-granted. Inviter no longer authorized / location no longer a member → the
//      invite is cancelled.
//   3. the invite becomes consumed.
// RECOVERY (a crash between steps): a retry by the same uid of a `consuming` invite — inside the in-flight window
// (< INFLIGHT_MS since consuming.at) → explicit `pending`; otherwise the marker decides: present → consumed, no roster
// touch; absent → expiry re-checked, then step 2.
const F1 = require('../brands/brand-model');
const { refuseContext, isUid, resolveLocation } = require('./membership');
const { mutateRoster, INVITE_ID_RE, MAX_BRANCHES } = require('./roster');

const TTL_MS = 72 * 3600 * 1000;
const INFLIGHT_MS = 30 * 1000;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const normEmail = (e) => (typeof e === 'string' ? e.trim().toLowerCase() : '');
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s.]{2,}$/;
// the acceptor's verified email, or null — never a claim the client could write itself (Firebase sets both from the email link)
const verifiedEmail = (ctx) => (ctx && ctx.token && ctx.token.email_verified === true && typeof ctx.token.email === 'string' ? normEmail(ctx.token.email) : null);
const fail = (code) => ({ ok: false, code });
const val = async (db, p) => (await db.ref(p).once('value')).val();

async function isOwner(db, brandId, uid) { return isObj(await val(db, `brand_members/${brandId}/owners/${uid}`)); }

async function createInvite(deps, ctx, { brandId, rids, can_edit_menu = false, email }) {
  const { db, now = () => Date.now(), randomToken } = deps;
  const refused = refuseContext(ctx); if (refused) return refused;
  if (!isUid(ctx.uid)) return fail('forbidden');
  if (!F1.isBrandId(brandId)) return fail('bad_brand');
  if (!Array.isArray(rids) || !rids.length || rids.length > MAX_BRANCHES || new Set(rids).size !== rids.length) return fail('bad_rids');
  if (typeof can_edit_menu !== 'boolean') return fail('bad_perms');
  const to = normEmail(email);
  if (!EMAIL_RE.test(to) || to.length > 254) return fail('bad_email');
  try {
    const rec = await val(db, `brands/${brandId}`);
    if (!rec || !F1.validateBrand(brandId, rec).ok) return fail('brand_invalid');
    if (!(await isOwner(db, brandId, ctx.uid))) return fail('forbidden');   // only the owner invites
    for (const rid of rids) {
      const loc = await resolveLocation(db, rid);
      if (loc.brandId !== brandId || loc.state !== 'member') return fail('location_not_member');
    }
    const id = randomToken();
    if (!INVITE_ID_RE.test(id)) return fail('unavailable');
    const at = now();
    const inv = { kind: 'manager', brandId, rids: [...rids].sort(), can_edit_menu, email: to, invited_by: ctx.uid, created_at: at, expires_at: at + TTL_MS, state: 'open' };
    await db.ref(`member_invites/${id}`).set(inv);
    return { ok: true, inviteId: id, expires_at: inv.expires_at, email: to };
  } catch (_) { return fail('unavailable'); }
}

async function cancelInvite(deps, ctx, inviteId) {
  const { db } = deps;
  const refused = refuseContext(ctx); if (refused) return refused;
  if (!INVITE_ID_RE.test(String(inviteId))) return fail('bad_invite');
  try {
    const inv = await val(db, `member_invites/${inviteId}`);
    if (!isObj(inv)) return fail('not_found');
    if (!(await isOwner(db, inv.brandId, ctx.uid))) return fail('forbidden');
    let st = null;
    await db.ref(`member_invites/${inviteId}/state`).transaction((cur) => { st = cur; if (cur === 'open') return 'cancelled'; return cur === null ? null : undefined; });
    return st === 'open' ? { ok: true } : fail(`not_open:${st}`);
  } catch (_) { return fail('unavailable'); }
}

async function setState(db, inviteId, from, to) {
  await db.ref(`member_invites/${inviteId}`).transaction((cur) => {
    if (cur === null) return null;
    if (!isObj(cur) || !from.includes(cur.state)) return undefined;
    return { ...cur, state: to };
  });
}

async function acceptInvite(deps, ctx, inviteId) {
  const { db, now = () => Date.now(), log = () => {} } = deps;
  const refused = refuseContext(ctx); if (refused) return refused;
  if (!isUid(ctx.uid)) return fail('forbidden');
  if (!INVITE_ID_RE.test(String(inviteId))) return fail('bad_invite');
  const uid = ctx.uid;
  const mail = verifiedEmail(ctx);
  if (!mail) return fail('email_unverified');
  const at = now();
  let step = null; let inv = null;
  try {
    await db.ref(`member_invites/${inviteId}`).transaction((cur) => {
      inv = cur; step = null;
      if (cur === null) return null;   // null-first: never abort on a possibly stale null
      if (!isObj(cur)) { step = 'invalid'; return undefined; }
      if (cur.email !== mail) { step = 'email_mismatch'; return undefined; }   // the recipient binding — the invite stays as it is
      if (cur.state === 'consumed') { step = cur.consuming && cur.consuming.by === uid ? 'done' : 'used'; return undefined; }
      if (cur.state === 'consuming') {
        if (!cur.consuming || cur.consuming.by !== uid) { step = 'used'; return undefined; }
        step = at - cur.consuming.at < INFLIGHT_MS ? 'pending' : 'recover';
        return undefined;
      }
      if (cur.state !== 'open') { step = cur.state || 'invalid'; return undefined; }
      if (!(cur.expires_at > at)) { step = 'expired'; return { ...cur, state: 'expired' }; }
      step = 'start';
      return { ...cur, state: 'consuming', consuming: { by: uid, at } };
    });
  } catch (_) { return fail('unavailable'); }
  if (inv === null || step === null) return fail('not_found');
  if (step === 'done') return { ok: true, outcome: 'consumed' };
  if (step === 'pending') return { ok: false, code: 'pending' };
  if (step !== 'start' && step !== 'recover') return fail(step === 'used' ? 'already_used' : step);
  try {
    if (step === 'recover') {
      // the marker decides FIRST: applied (even if since revoked) → finish, never touch the roster
      if (await val(db, `brand_members/${inv.brandId}/invite_applied/${inviteId}`)) {
        await setState(db, inviteId, ['consuming'], 'consumed');
        return { ok: true, outcome: 'consumed' };
      }
      if (!(inv.expires_at > at)) { await setState(db, inviteId, ['consuming'], 'expired'); return fail('expired'); }
    }
    if (inv.kind !== 'manager' || !Array.isArray(inv.rids)) { await setState(db, inviteId, ['consuming'], 'cancelled'); return fail('invalid'); }
    const r = await mutateRoster({ db, now, log }, inv.brandId, { kind: 'owner', uid: inv.invited_by },
      { type: 'grant_manager', uid, rids: inv.rids, can_edit_menu: inv.can_edit_menu === true, inviteId });
    if (!r.ok) {
      if (r.code === 'forbidden' || r.code === 'location_not_member' || r.code === 'brand_invalid') {
        await setState(db, inviteId, ['consuming'], 'cancelled');   // the inviter lost authority / scope gone: the invite dies
        return fail(r.code === 'forbidden' ? 'inviter_not_authorized' : r.code);
      }
      return fail(r.code);   // unavailable etc.: left consuming → a later retry recovers via the marker
    }
    await setState(db, inviteId, ['consuming'], 'consumed');
    return { ok: true, outcome: r.outcome === 'already_applied' ? 'consumed' : 'granted' };
  } catch (_) { return fail('unavailable'); }
}

module.exports = { createInvite, cancelInvite, acceptInvite, TTL_MS, INFLIGHT_MS };
