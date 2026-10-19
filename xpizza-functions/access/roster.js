'use strict';
// PLAN-portal-membership r3 §5.1 — the ONE membership writer. Every grant / revoke (callables, the membership-admin CLI, invite
// acceptance) goes through mutateRoster, which runs a SINGLE transaction on brand_members/{brandId} (owners + managers of the
// brand in one node), so concurrent writers serialize:
//   - the actor's authority is re-validated INSIDE the transaction (an owner for team ops; the CLI operator is trusted);
//   - an invite's application marker invite_applied/{inviteId} is read INSIDE every grant transaction: present → NO mutation
//     (already_applied), so a recovered invite never re-grants a member who was revoked after it applied (r3 P1);
//   - ≥ 1 owner is enforced after every operation (two concurrent last-owner revokes → one succeeds);
//   - bootstrap_owner (CLI only) is the one exception to actor authority: only into a roster with ZERO owners (r2 P2-5).
// Target scope is checked BEFORE the transaction from values outside the roster node (brand record, location roster); a
// retirement or identity brand_id change is an owner-run CLI never run concurrently with membership writes (PLAN §5.1).
// member_of (DISCOVERY ONLY) is updated AFTER commit, best effort; reconcile repairs it. A revoke is effective at commit.
//
// RTDB transactions may run first against a stale null: a denial or no-op on null proposes null (never aborts), so RTDB
// re-runs with the real value when one exists ([[rtdb-transaction-null-first-run]]).
const F1 = require('../brands/brand-model');
const { resolveLocation, isUid } = require('./membership');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const OPS = Object.freeze(['grant_owner', 'revoke_owner', 'grant_manager', 'revoke_manager', 'bootstrap_owner']);
// What a callable (portal) may ever ask for. bootstrap_owner is CLI-only and is NOT here.
const CALLABLE_OPS = Object.freeze(['grant_owner', 'revoke_owner', 'grant_manager', 'revoke_manager']);
const INVITE_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

const fail = (code) => ({ ok: false, code });

// Pre-transaction validation of the target scope (operation-specific, PLAN r2 §5.1).
async function validateTarget(db, brandId, op) {
  if (!F1.isBrandId(brandId)) return fail('bad_brand');
  if (!OPS.includes(op.type)) return fail('bad_op');
  if (!isUid(op.uid)) return fail('bad_uid');
  if (op.inviteId !== undefined && !INVITE_ID_RE.test(String(op.inviteId))) return fail('bad_invite');
  const rec = (await db.ref(`brands/${brandId}`).once('value')).val();
  if (!rec || !F1.validateBrand(brandId, rec).ok) return fail('brand_invalid');
  if (op.type === 'grant_manager') {
    const loc = await resolveLocation(db, op.rid);
    if (loc.brandId !== brandId || loc.state !== 'member') return fail('location_not_member');   // grant: a CURRENT member
  }
  if (op.type === 'revoke_manager' && !F1.isBrandId(op.rid)) return fail('bad_rid');          // revoke: works after retirement
  return { ok: true };
}

// The pure roster mutation, run inside the transaction. → { next | undefined, outcome, code }
function applyOp(cur, actor, op, now) {
  const r = isObj(cur) ? clone(cur) : {};
  const owners = isObj(r.owners) ? r.owners : {};
  const managers = isObj(r.managers) ? r.managers : {};
  if (actor.kind === 'owner' && !isObj(owners[actor.uid])) return { code: 'forbidden' };
  if (actor.kind !== 'owner' && actor.kind !== 'cli') return { code: 'forbidden' };
  if (op.inviteId && isObj(r.invite_applied) && r.invite_applied[op.inviteId]) return { outcome: 'already_applied' };
  const grant = { granted_at: now, granted_by: actor.kind === 'cli' ? `cli:${actor.operator}` : actor.uid };
  let changed = false;
  switch (op.type) {
    case 'bootstrap_owner':
      if (actor.kind !== 'cli') return { code: 'forbidden' };
      if (Object.keys(owners).length) return isObj(owners[op.uid]) ? { outcome: 'noop' } : { code: 'roster_not_empty' };
      owners[op.uid] = grant; changed = true; break;
    case 'grant_owner':
      if (!isObj(owners[op.uid])) { owners[op.uid] = grant; changed = true; }
      break;
    case 'revoke_owner':
      if (isObj(owners[op.uid])) {
        if (Object.keys(owners).length <= 1) return { code: 'last_owner' };
        delete owners[op.uid]; changed = true;
      }
      break;
    case 'grant_manager': {
      const m = isObj(managers[op.rid]) ? managers[op.rid] : {};
      if (!isObj(m[op.uid])) { m[op.uid] = grant; managers[op.rid] = m; changed = true; }
      break;
    }
    case 'revoke_manager': {
      const m = isObj(managers[op.rid]) ? managers[op.rid] : {};
      if (isObj(m[op.uid])) { delete m[op.uid]; if (Object.keys(m).length) managers[op.rid] = m; else delete managers[op.rid]; changed = true; }
      break;
    }
    default: return { code: 'bad_op' };
  }
  if (op.inviteId) {   // the application marker lands in the SAME transaction as the grant (kept forever)
    r.invite_applied = isObj(r.invite_applied) ? r.invite_applied : {};
    r.invite_applied[op.inviteId] = { uid: op.uid, at: now };
    changed = true;
  }
  if (!changed) return { outcome: 'noop' };
  r.owners = owners;
  if (Object.keys(managers).length) r.managers = managers; else delete r.managers;
  return { next: r, outcome: 'applied' };
}

function indexUpdate(brandId, op) {
  const u = op.uid;
  switch (op.type) {
    case 'bootstrap_owner': case 'grant_owner': return { [`member_of/${u}/brands/${brandId}`]: 'owner' };
    case 'revoke_owner': return { [`member_of/${u}/brands/${brandId}`]: null };
    case 'grant_manager': return { [`member_of/${u}/locations/${op.rid}`]: 'manager' };
    case 'revoke_manager': return { [`member_of/${u}/locations/${op.rid}`]: null };
    default: return null;
  }
}

// → { ok: true, outcome: 'applied'|'noop'|'already_applied' } | { ok: false, code }
async function mutateRoster(deps, brandId, actor, op) {
  const { db, now = () => Date.now(), log = () => {} } = deps;
  if (!actor || (actor.kind === 'owner' && !isUid(actor.uid)) || (actor.kind === 'cli' && !actor.operator)) return fail('forbidden');
  let v;
  try { v = await validateTarget(db, brandId, op); } catch (_) { return fail('unavailable'); }
  if (!v.ok) return v;
  const at = now();
  let res = null;
  let tx;
  try {
    tx = await db.ref(`brand_members/${brandId}`).transaction((cur) => {
      res = applyOp(cur, actor, op, at);
      if (res.next) return res.next;
      return cur === null ? null : undefined;   // never abort on a (possibly stale) null — propose null, RTDB re-runs if needed
    });
  } catch (_) { return fail('unavailable'); }
  if (!res) return fail('unavailable');
  if (res.code) return fail(res.code);
  if (res.next && !(tx && tx.committed)) return fail('unavailable');
  if (res.outcome === 'applied' && op.type !== undefined) {
    const idx = indexUpdate(brandId, op);
    if (idx) { try { await db.ref().update(idx); } catch (_) { log('member_of_update_failed', { brandId, type: op.type }); } }   // reconcile repairs
  }
  return { ok: true, outcome: res.outcome };
}

module.exports = { mutateRoster, applyOp, validateTarget, indexUpdate, OPS, CALLABLE_OPS, INVITE_ID_RE };
