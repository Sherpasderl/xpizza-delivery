'use strict';
// ORCHESTRATION O1a (PLAN-multi-location-orchestration r3.1 §2.2, §2.3, §4, §5) — the branch-lifecycle WRITERS (RTDB, Admin SDK).
// Each writer reads, calls a pure planner (branch-ops), and writes through transactions; nothing here is claimed atomic across nodes.
//   • createDraft — payload-bound op-id mapping branch_op_ids/{brand}/{op_id}; the name is reserved FIRST (a taken name never
//     strands a rid reservation), then the rid candidate is PERSISTED on the mapping BEFORE it is reserved, advanced only forward
//     from the persisted value, and the draft is written create-only. A crash anywhere resumes from the persisted candidate.
//   • multi-step ops (materialize, activate) run under branch_ops/{rid}: durable validated inputs + a 60 s lease; every step
//     succeeds if already matching (idempotent re-entry) and checkpoints `step`; resumeBranchOp finishes one from its inputs.
//   • single-node writes (set-location, deactivate, enrich-legacy) are a version CAS inside one identity transaction.
// No Firestore write in any lifecycle op. A branch becomes `member` only at activation, after its identity exists and validates.
const crypto = require('crypto');
const { validateBrand } = require('../brands/brand-model');
const { ridCandidates, nameKey } = require('./rid-alloc');
const P = require('./branch-ops');
const { HEAL_TERMINAL_STATUSES } = require('../sweep-pending');   // every terminal status incl. cancelled — anything else is live

const LEASE_MS = 60 * 1000;
const DRAFT_KEYS = ['brand_id', 'location_name', 'phone', 'hours', 'prep_default_min'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));
const hashOf = (v) => crypto.createHash('sha256').update(stable(v)).digest('hex');
const val = async (db, path) => (await db.ref(path).once('value')).val();

// a transaction whose update fn may stop with a reason: returns {committed, value, stop}
async function txn(db, path, fn) {
  let stop = null;
  const r = await db.ref(path).transaction((cur) => { stop = null; const out = fn(cur, (why) => { stop = why; }); return stop ? undefined : out; });
  return { committed: r.committed, value: r.snapshot.val(), stop };
}

async function liveOrders(db, rid) {
  const all = (await db.ref('orders').orderByChild('restaurant_id').equalTo(rid).once('value')).val() || {};
  return Object.values(all).filter((o) => isObj(o) && !HEAL_TERMINAL_STATUSES.has(o.status));
}

// ── draft creation (§2.2 ordering, §2.3 allocation) ──────────────────────────────────────────────────────────────────────────

async function createDraft(db, { input, opId, callerUid, now }) {
  const errors = P.draftErrors(input);
  if (errors.length) return { ok: false, error: 'bad_draft', errors };
  if (typeof opId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(opId)) return { ok: false, error: 'bad_op_id' };
  const draft = {}; for (const k of DRAFT_KEYS) draft[k] = input[k];
  const brandId = draft.brand_id;
  if (!isObj(await val(db, `brands/${brandId}`))) return { ok: false, error: 'brand_not_found' };
  const hash = hashOf(draft);
  const mapPath = `branch_op_ids/${brandId}/${opId}`;

  // (1) the op-id mapping, create-only and payload-bound
  const m = await txn(db, mapPath, (cur, stop) => (cur == null ? { payload_hash: hash } : (cur.payload_hash === hash ? undefined : stop('op_conflict'))));
  if (m.stop) return { ok: false, error: m.stop };
  let mapping = m.value || {};

  // (2) the name, reserved before any rid (owned when op_id matches)
  const nk = nameKey(draft.location_name);
  const nm = await txn(db, `brand_branch_names/${brandId}/${nk}`, (cur, stop) => (cur == null ? { op_id: opId } : (cur.op_id === opId ? undefined : stop('name_taken'))));
  if (nm.stop) {
    if (!mapping.candidate) await txn(db, mapPath, (cur) => (cur && cur.payload_hash === hash && !cur.candidate ? null : undefined));
    return { ok: false, error: 'name_taken' };
  }

  // (3) persist the candidate, then reserve exactly it; advance only forward from the persisted value
  const seq = ridCandidates(brandId, draft.location_name);
  let rid = mapping.rid || null;
  for (let guard = 0; !rid; guard += 1) {
    if (guard > seq.length) return { ok: false, error: 'rid_exhausted' };   // fail closed: the walk only ever moves forward
    const pc = await txn(db, mapPath, (cur, stop) => (cur == null || cur.payload_hash !== hash ? stop('op_lost') : (cur.candidate ? undefined : { ...cur, candidate: seq[0] })));
    if (pc.stop) return { ok: false, error: pc.stop };
    mapping = pc.value; const cand = mapping.candidate;
    let owned = false;
    const held = await val(db, `rid_reservations/${cand}`);
    if (held && held.op_id === opId) owned = true;
    else if (!held && (await val(db, `restaurants/${cand}/identity`)) == null && (await val(db, `brands/${cand}`)) == null) {
      const rv = await txn(db, `rid_reservations/${cand}`, (cur, stop) => (cur == null ? { op_id: opId, brand_id: brandId } : (cur.op_id === opId ? undefined : stop('taken'))));
      owned = !rv.stop;
    }
    if (owned) { rid = cand; break; }
    const i = seq.indexOf(cand);
    if (i < 0 || i + 1 >= seq.length) return { ok: false, error: 'rid_exhausted' };
    const adv = await txn(db, mapPath, (cur, stop) => (cur && cur.payload_hash === hash ? (cur.candidate === cand ? { ...cur, candidate: seq[i + 1] } : undefined) : stop('op_lost')));
    if (adv.stop) return { ok: false, error: adv.stop };
  }

  // (4) the mapping's rid (set if absent, keep if equal)
  const sr = await txn(db, mapPath, (cur, stop) => (cur && cur.payload_hash === hash ? (cur.rid == null ? { ...cur, rid } : (cur.rid === rid ? undefined : stop('op_lost'))) : stop('op_lost')));
  if (sr.stop) return { ok: false, error: sr.stop };

  // (5) the draft, create-only; an already-materialized branch of this op is done
  if ((await val(db, `restaurants/${rid}/identity`)) != null) return { ok: true, rid };
  const dw = await txn(db, `restaurants/${rid}/draft`, (cur, stop) => (cur == null ? { ...draft, created_at: now, created_by: callerUid, op_id: opId } : (cur.op_id === opId ? undefined : stop('draft_conflict'))));
  if (dw.stop) return { ok: false, error: dw.stop };
  return { ok: true, rid };
}

// abandoned-draft cleanup: the draft + its rid / name reservations + the op-id mapping (only those this draft's op owns)
async function deleteBranchDraft(db, { rid, brandId }) {
  const d = await val(db, `restaurants/${rid}/draft`);
  if (!isObj(d) || d.brand_id !== brandId) return { ok: false, error: 'not_a_draft' };
  if ((await val(db, `branch_ops/${rid}`)) != null) return { ok: false, error: 'op_in_progress' };
  const nk = nameKey(d.location_name);
  const [res, nm] = await Promise.all([val(db, `rid_reservations/${rid}`), val(db, `brand_branch_names/${brandId}/${nk}`)]);
  const u = { [`restaurants/${rid}/draft`]: null };
  if (res && res.op_id === d.op_id) u[`rid_reservations/${rid}`] = null;
  if (nm && nm.op_id === d.op_id) u[`brand_branch_names/${brandId}/${nk}`] = null;
  if (typeof d.op_id === 'string') u[`branch_op_ids/${brandId}/${d.op_id}`] = null;
  await db.ref().update(u);
  return { ok: true };
}

// ── durable op runner (§2.2) ─────────────────────────────────────────────────────────────────────────────────────────────────

async function acquire(db, rid, { kind, inputs }, callId, now) {
  const hash = hashOf(inputs);
  const lease = { call_id: callId, until: now + LEASE_MS };
  const r = await txn(db, `branch_ops/${rid}`, (cur, stop) => {
    if (cur == null) return inputs ? { kind, op_id: callId, inputs, payload_hash: hash, lease, step: 'start', rid, started_at: now, updated_at: now } : stop('no_op');
    const held = isObj(cur.lease) && cur.lease.call_id !== callId && Number.isFinite(cur.lease.until) && cur.lease.until > now;
    if (held || (kind && cur.kind !== kind)) return stop('op_in_progress');
    if (inputs && cur.payload_hash !== hash) return stop('op_conflict');
    const next = { ...cur, lease, updated_at: now }; delete next.error;
    return next;
  });
  return r.stop ? { error: r.stop } : { op: r.value };
}
const checkpoint = (db, rid, step, callId, now) => db.ref(`branch_ops/${rid}`).update({ step, updated_at: now, lease: { call_id: callId, until: now + LEASE_MS } });
const fail = async (db, rid, error, now) => { await db.ref(`branch_ops/${rid}`).update({ error, lease: null, updated_at: now }); return { ok: false, error }; };

const STEPS = {
  async materialize(db, op, callId, now) {
    const { rid } = op; const { brand_id: brandId, identity } = op.inputs;
    const id = await txn(db, `restaurants/${rid}/identity`, (cur, stop) => (cur == null ? identity : (stable(cur) === stable(identity) ? undefined : stop('identity_conflict'))));
    if (id.stop) {
      await db.ref(`dispatcher_alerts/branch_identity_conflict_${rid}`).transaction((cur) => (cur == null ? { type: 'branch_identity_conflict', rid, created_at: now } : undefined));
      return fail(db, rid, 'identity_conflict', now);
    }
    await checkpoint(db, rid, 'identity', callId, now);
    const b = await txn(db, `brands/${brandId}`, (cur, stop) => {
      if (!isObj(cur)) return stop('brand_not_found');
      const st = isObj(cur.locations) ? cur.locations[rid] : undefined;
      if (st === 'staged' || st === 'member') return undefined;
      if (st !== undefined) return stop('membership_conflict');
      const next = { ...cur, locations: { ...cur.locations, [rid]: 'staged' } };
      return validateBrand(brandId, next).ok ? next : stop('brand_invalid');
    });
    if (b.stop) return fail(db, rid, b.stop, now);
    await checkpoint(db, rid, 'staged', callId, now);
    await db.ref(`restaurants/${rid}/draft`).remove();
    await db.ref(`branch_ops/${rid}`).remove();
    return { ok: true, rid, state: 'staged' };
  },
  async activate(db, op, callId, now) {
    const { rid } = op; const { brand_id: brandId, membership_to: to, patch, expected_version: ev } = op.inputs;
    if (to === 'member') {
      const b = await txn(db, `brands/${brandId}`, (cur, stop) => {
        const st = isObj(cur) && isObj(cur.locations) ? cur.locations[rid] : undefined;
        if (st === 'member') return undefined;
        if (st !== 'staged') return stop('membership_conflict');
        const next = { ...cur, locations: { ...cur.locations, [rid]: 'member' } };
        return validateBrand(brandId, next).ok ? next : stop('brand_invalid');
      });
      if (b.stop) return fail(db, rid, b.stop, now);
      await checkpoint(db, rid, 'member', callId, now);
    }
    const id = await txn(db, `restaurants/${rid}/identity`, (cur, stop) => {
      if (!isObj(cur)) return stop('identity_missing');
      if (cur.version === patch.version && cur.active === patch.active) return undefined;
      return cur.version === ev ? { ...cur, ...patch } : stop('stale_branch');
    });
    if (id.stop) return fail(db, rid, id.stop, now);
    await db.ref(`branch_ops/${rid}`).remove();
    return { ok: true, rid, state: 'active' };
  },
};

async function runOp(db, rid, spec, callId, now) {
  const a = await acquire(db, rid, spec, callId, now);
  if (a.error) return { ok: false, error: a.error };
  return STEPS[a.op.kind](db, a.op, callId, now);
}

// finish an unfinished op from its durable inputs (any later call, or the admin `resume <rid>`)
const resumeBranchOp = (db, { rid, now, callId }) => runOp(db, rid, { kind: null, inputs: null }, callId, now);

// ── Sherpa admin: materialize a draft with its location (§4) ─────────────────────────────────────────────────────────────────

async function materializeBranch(db, { rid, location, now, callId }) {
  const op = await val(db, `branch_ops/${rid}`);
  if (isObj(op)) return op.kind === 'materialize' ? runOp(db, rid, { kind: 'materialize', inputs: null }, callId, now) : { ok: false, error: 'op_in_progress' };
  const draft = await val(db, `restaurants/${rid}/draft`);
  if (!isObj(draft)) {
    const [id, brands] = [await val(db, `restaurants/${rid}/identity`), await val(db, 'brands')];
    const st = isObj(id) && isObj(brands) && isObj(brands[id.brand_id]) && isObj(brands[id.brand_id].locations) ? brands[id.brand_id].locations[rid] : undefined;
    return st === 'staged' || st === 'member' ? { ok: true, rid, state: st } : { ok: false, error: 'not_a_draft' };
  }
  const [brand, bounds] = [await val(db, `brands/${draft.brand_id}`), await val(db, 'platform_config/service_bounds')];
  if (!isObj(brand)) return { ok: false, error: 'brand_not_found' };
  const plan = P.planMaterialize({ draft, location, brandName: brand.name, bounds, now });
  if (!plan.ok) return { ok: false, error: 'bad_location', errors: plan.errors };
  return runOp(db, rid, { kind: 'materialize', inputs: { brand_id: draft.brand_id, location, identity: plan.identity } }, callId, now);
}

// ── single-node identity CAS writes ──────────────────────────────────────────────────────────────────────────────────────────

const refusal = (errors) => (errors.length === 1 && errors[0] === 'stale_branch' ? { ok: false, error: 'stale_branch' } : { ok: false, error: 'refused', errors });

async function casIdentity(db, rid, expectedVersion, patch) {
  const r = await txn(db, `restaurants/${rid}/identity`, (cur, stop) => {
    if (!isObj(cur) || cur.version !== expectedVersion) return stop('stale_branch');
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v; }
    return next;
  });
  return r.stop ? { ok: false, error: r.stop } : { ok: true, version: patch.version };
}

// Sherpa admin: move pin / address (OFF ≥ 10 min, zero live orders) or change the radius
async function setBranchLocation(db, { rid, input, expectedVersion, now }) {
  const identity = await val(db, `restaurants/${rid}/identity`);
  if (!isObj(identity)) return { ok: false, error: 'not_a_branch' };
  const [bounds, live] = [await val(db, 'platform_config/service_bounds'), await liveOrders(db, rid)];
  const plan = P.planSetLocation({ identity, input, bounds, liveOrders: live.length, now, expectedVersion });
  if (!plan.ok) return refusal(plan.errors);
  return casIdentity(db, rid, expectedVersion, plan.patch);
}

// Sherpa admin, before a legacy brand's cutover: additive branch fields on the legacy branch's own identity
async function enrichLegacyIdentity(db, { rid, input, expectedVersion }) {
  const [identity, brand] = [await val(db, `restaurants/${rid}/identity`), await val(db, `brands/${rid}`)];
  if (!isObj(identity)) return { ok: false, error: 'not_a_branch' };
  const plan = P.planEnrichLegacy({ rid, identity, brand, input, expectedVersion });
  if (!plan.ok) return refusal(plan.errors);
  return casIdentity(db, rid, expectedVersion, plan.patch);
}

// ── activate (readiness §5, staged → member) / deactivate (consequence counts) ──────────────────────────────────────────────
// readers: { teamCount(rid) → number, menuPublished(brandId) → boolean } — the team store arrives with O1b (membership); an
// absent teamCount reader fails closed (no_owner_or_manager). menuPublished defaults to the brand menu node menus/{brand_id}.

async function setBranchActive(db, { rid, active, expectedVersion, now, callId, readers = {} }) {
  const identity = await val(db, `restaurants/${rid}/identity`);
  if (!isObj(identity)) return { ok: false, error: 'not_a_branch' };
  const brandId = identity.brand_id;
  const [brand, handhelds] = [await val(db, `brands/${brandId}`), await val(db, `restaurants/${rid}/handhelds`)];
  const devices = Object.values(isObj(handhelds) ? handhelds : {}).filter((h) => isObj(h) && h.revoked !== true);
  let facts = {};
  if (active === true) {
    const teamCount = typeof readers.teamCount === 'function' ? await readers.teamCount(rid) : 0;
    const menuPublished = typeof readers.menuPublished === 'function' ? (await readers.menuPublished(brandId)) === true : (await val(db, `menus/${brandId}`)) != null;
    facts = {
      membership: isObj(brand) && isObj(brand.locations) ? brand.locations[rid] : undefined,
      brandState: isObj(brand) && isObj(brand.activation) ? brand.activation.state : undefined,
      handheldSeen: devices.some((h) => Number.isFinite(h.last_seen)), teamCount, menuPublished,
    };
  }
  const plan = P.planSetActive({ identity, active, facts, now, expectedVersion });
  if (!plan.ok) return plan.unmet ? { ok: false, error: plan.error, unmet: plan.unmet } : { ok: false, error: plan.error };
  if (active === true) {
    return runOp(db, rid, { kind: 'activate', inputs: { brand_id: brandId, membership_to: plan.membershipTo || 'none', patch: plan.patch, expected_version: expectedVersion } }, callId, now);
  }
  const w = await casIdentity(db, rid, expectedVersion, plan.patch);
  if (!w.ok) return w;
  const live = await liveOrders(db, rid);
  return { ok: true, state: 'inactive', consequences: { live_orders: live.length, scheduled_bound: live.filter((o) => o.status === 'scheduled').length, devices: devices.length } };
}

module.exports = { createDraft, deleteBranchDraft, materializeBranch, resumeBranchOp, setBranchLocation, setBranchActive, enrichLegacyIdentity, LEASE_MS };
