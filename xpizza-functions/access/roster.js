'use strict';
// PLAN-portal-membership r3 §5.1 + OWNER DECISIONS (2026-10-19) — the ONE membership writer.
//   ONE owner per brand (no co-owners). The owner is set by the cutover's bootstrap_owner and changed only by the platform's
//   transfer_owner — both CLI-only. The owner invites «Gerente de sucursal» users (one or more branches each; several managers
//   per branch allowed), revokes them, and toggles their «Puede editar el menú y los precios» (can_edit_menu on the grant).
// Every write (CLI, the team cores, invite acceptance) is ONE transaction on brand_members/{brandId}:
//   - the actor's authority is re-validated INSIDE the transaction (the brand's owner for team ops; the CLI operator trusted);
//   - an invite's application marker invite_applied/{inviteId} is read INSIDE every grant transaction: present → NO mutation
//     (already_applied), so a recovered invite never re-grants a manager who was revoked after it applied;
//   - exactly ONE owner after every operation.
// Target scope is checked BEFORE the transaction (brand record, each branch a current member); a retirement or identity change
// is an owner-run CLI never run concurrently with membership writes (PLAN §5.1). member_of (DISCOVERY ONLY) is updated AFTER
// commit, best effort; reconcile repairs it. A revoke is effective at commit.
// RTDB transactions may run first against a stale null: a denial or no-op on null proposes null (never aborts), so RTDB
// re-runs with the real value when one exists ([[rtdb-transaction-null-first-run]]).
const F1 = require('../brands/brand-model');
const { resolveLocation, isUid } = require('./membership');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const OPS = Object.freeze(['bootstrap_owner', 'transfer_owner', 'grant_manager', 'revoke_manager', 'set_manager_perms']);
// What the team cores (the portal) may ever ask for. bootstrap_owner / transfer_owner are platform CLI only and NOT here.
const CALLABLE_OPS = Object.freeze(['grant_manager', 'revoke_manager', 'set_manager_perms']);
const CLI_ONLY_OPS = Object.freeze(['bootstrap_owner', 'transfer_owner']);
const INVITE_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
const MAX_BRANCHES = 50;

const fail = (code) => ({ ok: false, code });

// Pre-transaction validation of the target scope (operation-specific).
async function validateTarget(db, brandId, op) {
  if (!F1.isBrandId(brandId)) return fail('bad_brand');
  if (!OPS.includes(op.type)) return fail('bad_op');
  if (!isUid(op.uid)) return fail('bad_uid');
  if (op.inviteId !== undefined && !INVITE_ID_RE.test(String(op.inviteId))) return fail('bad_invite');
  const rec = (await db.ref(`brands/${brandId}`).once('value')).val();
  if (!rec || !F1.validateBrand(brandId, rec).ok) return fail('brand_invalid');
  if (op.type === 'grant_manager') {
    if (!Array.isArray(op.rids) || !op.rids.length || op.rids.length > MAX_BRANCHES || new Set(op.rids).size !== op.rids.length) return fail('bad_rids');
    if (op.can_edit_menu !== undefined && typeof op.can_edit_menu !== 'boolean') return fail('bad_perms');
    for (const rid of op.rids) {
      const loc = await resolveLocation(db, rid);
      if (loc.brandId !== brandId || loc.state !== 'member') return fail('location_not_member');   // grant: CURRENT members
    }
  }
  if (op.type === 'revoke_manager' && op.rid !== undefined && !F1.isBrandId(op.rid)) return fail('bad_rid');   // works after retirement
  if (op.type === 'set_manager_perms' && typeof op.can_edit_menu !== 'boolean') return fail('bad_perms');
  return { ok: true };
}

// The pure roster mutation, run inside the transaction. → { next | undefined, outcome, code, touched }
function applyOp(cur, actor, op, now) {
  const r = isObj(cur) ? clone(cur) : {};
  const owners = isObj(r.owners) ? r.owners : {};
  const managers = isObj(r.managers) ? r.managers : {};
  if (actor.kind !== 'owner' && actor.kind !== 'cli') return { code: 'forbidden' };
  if (actor.kind === 'owner' && !isObj(owners[actor.uid])) return { code: 'forbidden' };
  if (actor.kind !== 'cli' && CLI_ONLY_OPS.includes(op.type)) return { code: 'forbidden' };
  if (op.inviteId && isObj(r.invite_applied) && r.invite_applied[op.inviteId]) return { outcome: 'already_applied' };
  const by = actor.kind === 'cli' ? `cli:${actor.operator}` : actor.uid;
  let changed = false; const touched = { added: [], removed: [], prevOwner: null };
  switch (op.type) {
    case 'bootstrap_owner': {
      const cur0 = Object.keys(owners);
      if (cur0.length) return cur0.length === 1 && cur0[0] === op.uid ? { outcome: 'noop' } : { code: 'roster_not_empty' };
      owners[op.uid] = { granted_at: now, granted_by: by }; changed = true; break;
    }
    case 'transfer_owner': {
      const cur0 = Object.keys(owners);
      if (cur0.length === 1 && cur0[0] === op.uid) return { outcome: 'noop' };
      touched.prevOwner = cur0.length === 1 ? cur0[0] : null;
      for (const k of cur0) delete owners[k];
      owners[op.uid] = { granted_at: now, granted_by: by }; changed = true; break;
    }
    case 'grant_manager':
      for (const rid of op.rids) {
        const m = isObj(managers[rid]) ? managers[rid] : {};
        const want = { granted_at: now, granted_by: by, can_edit_menu: op.can_edit_menu === true };
        if (!isObj(m[op.uid])) { m[op.uid] = want; managers[rid] = m; touched.added.push(rid); changed = true; }
      }
      break;
    case 'revoke_manager':
      for (const rid of Object.keys(managers)) {
        if (op.rid !== undefined && rid !== op.rid) continue;
        const m = isObj(managers[rid]) ? managers[rid] : {};
        if (isObj(m[op.uid])) { delete m[op.uid]; touched.removed.push(rid); changed = true; if (Object.keys(m).length) managers[rid] = m; else delete managers[rid]; }
      }
      break;
    case 'set_manager_perms': {
      let any = false;
      for (const rid of Object.keys(managers)) {
        const g = isObj(managers[rid]) ? managers[rid][op.uid] : undefined;
        if (!isObj(g)) continue;
        any = true;
        if (g.can_edit_menu !== op.can_edit_menu) { g.can_edit_menu = op.can_edit_menu; changed = true; }
      }
      if (!any) return { code: 'not_a_manager' };
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
  if (Object.keys(owners).length !== 1) return { code: 'owner_count' };   // exactly ONE owner, always
  r.owners = owners;
  if (Object.keys(managers).length) r.managers = managers; else delete r.managers;
  return { next: r, outcome: 'applied', touched };
}

function indexUpdate(brandId, op, touched) {
  const u = {}; const id = op.uid;
  if (op.type === 'bootstrap_owner' || op.type === 'transfer_owner') {
    u[`member_of/${id}/brands/${brandId}`] = 'owner';
    if (touched.prevOwner && touched.prevOwner !== id) u[`member_of/${touched.prevOwner}/brands/${brandId}`] = null;
  }
  for (const rid of touched.added) u[`member_of/${id}/locations/${rid}`] = 'manager';
  for (const rid of touched.removed) u[`member_of/${id}/locations/${rid}`] = null;
  return Object.keys(u).length ? u : null;
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
  if (res.outcome === 'applied') {
    const idx = indexUpdate(brandId, op, res.touched);
    if (idx) { try { await db.ref().update(idx); } catch (_) { log('member_of_update_failed', { brandId, type: op.type }); } }   // reconcile repairs
  }
  return { ok: true, outcome: res.outcome };
}

module.exports = { mutateRoster, applyOp, validateTarget, indexUpdate, OPS, CALLABLE_OPS, CLI_ONLY_OPS, INVITE_ID_RE, MAX_BRANCHES };
