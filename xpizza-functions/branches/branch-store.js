'use strict';
// ORCHESTRATION O1a (PLAN-multi-location-orchestration r3.1 §2.2, §2.3, §4, §5) — the branch-lifecycle WRITERS (RTDB, Admin SDK).
// Each writer reads, calls a pure planner (branch-ops), and writes through transactions; nothing here is claimed atomic across nodes.
//   • createDraft — payload-bound op-id mapping branch_op_ids/{brand}/{op_id}; the name is reserved FIRST (a taken name never
//     strands a rid reservation), then the rid candidate is PERSISTED on the mapping BEFORE it is reserved, advanced only forward
//     from the persisted value, and the draft is written create-only. A crash anywhere resumes from the persisted candidate.
//   • multi-step ops (materialize, activate, delete_draft) run under branch_ops/{rid}: durable validated inputs + a 60 s lease;
//     every step succeeds if already matching (idempotent re-entry) and checkpoints `step`; resumeBranchOp finishes one from its
//     inputs. FENCED (Codex r1 P2-1): renew / checkpoint, failure and cleanup act only while the record is THIS op and THIS caller
//     holds the lease (renewed on a fresh clock before and after every step) — a worker that lost its lease stops with lease_lost.
//   • single-node writes (set-location, deactivate, enrich-legacy) are a version CAS inside one identity transaction.
// No Firestore write in any lifecycle op. A branch becomes `member` only at activation, after its identity exists and validates.
const crypto = require('crypto');
const { validateBrand } = require('../brands/brand-model');
const { ridCandidates, nameKey } = require('./rid-alloc');
const P = require('./branch-ops');
const { HEAL_TERMINAL_STATUSES } = require('../sweep-pending');   // every terminal status incl. cancelled — anything else is live

const LEASE_MS = 60 * 1000;
const CLOSED = '~closed';   // branch_op_ids/{brand} tombstone: the brand was removed with its last draft ('~' is never in an op id)
const DRAFT_KEYS = ['brand_id', 'location_name', 'phone', 'hours', 'prep_default_min'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));
const hashOf = (v) => crypto.createHash('sha256').update(stable(v)).digest('hex');
const val = async (db, path) => (await db.ref(path).once('value')).val();

// a transaction whose update fn may stop with a reason: returns {committed, value, stop}. NULL-FIRST SAFE: the Admin SDK first
// runs fn on the CACHED value (null for an uncached node), and an undefined there aborts without consulting the server — so a
// stop / no-change on null answers null instead (null over null writes nothing; a non-null server value re-runs fn on it).
async function txn(db, path, fn) {
  let stop = null;
  const r = await db.ref(path).transaction((cur) => {
    stop = null;
    const out = fn(cur, (why) => { stop = why; });
    if (stop || out === undefined) return cur === null ? null : undefined;
    return out;
  });
  return { committed: r.committed, value: r.snapshot.val(), stop };
}

async function liveOrders(db, rid) {
  const all = (await db.ref('orders').orderByChild('restaurant_id').equalTo(rid).once('value')).val() || {};
  return Object.values(all).filter((o) => isObj(o) && !HEAL_TERMINAL_STATUSES.has(o.status));
}

// ── draft creation (§2.2 ordering, §2.3 allocation) ──────────────────────────────────────────────────────────────────────────

const createDraft = (db, args) => draftFlow(db, args, null);

// Sherpa admin (advisor ruling): a NEW brand is seeded TOGETHER with its first draft branch — ONE payload-bound op (the same
// mapping / name / persisted-candidate / reservation steps), then ONE create-only brand transaction {name, active, locations:
// {rid:'staged'}, activation off, projection_gen 1}, then the draft. The brand is never empty; a re-run resumes.
async function createBrandWithDraft(db, { brandId, brandName, input, opId, callerUid, now }) {
  if (typeof brandName !== 'string' || brandName.length < 1 || brandName.length > 80 || brandName.trim() !== brandName) return { ok: false, error: 'bad_brand_name' };
  return draftFlow(db, { input: { ...(isObj(input) ? input : {}), brand_id: brandId }, opId, callerUid, now }, { brandName });
}
const onlyStaged = (brand, rid) => isObj(brand) && isObj(brand.locations) && Object.keys(brand.locations).length === 1 && brand.locations[rid] === 'staged';

async function draftFlow(db, { input, opId, callerUid, now }, newBrand) {
  const errors = P.draftErrors(input);
  if (errors.length) return { ok: false, error: 'bad_draft', errors };
  if (typeof opId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(opId)) return { ok: false, error: 'bad_op_id' };
  const draft = {}; for (const k of DRAFT_KEYS) draft[k] = input[k];
  const brandId = draft.brand_id;
  const hash = hashOf(newBrand ? { ...draft, brand_name: newBrand.brandName } : draft);
  const mapPath = `branch_op_ids/${brandId}/${opId}`;
  const brand0 = await val(db, `brands/${brandId}`);
  if (!newBrand && !isObj(brand0)) return { ok: false, error: 'brand_not_found' };
  if (newBrand && brand0 != null) {
    const m0 = await val(db, mapPath);
    if (isObj(m0) && m0.payload_hash !== hash) return { ok: false, error: 'op_conflict' };
    if (!(isObj(m0) && m0.rid && onlyStaged(brand0, m0.rid))) return { ok: false, error: 'brand_exists' };
  }

  // (1) the op-id mapping, create-only and payload-bound — written through the brand's PARENT node branch_op_ids/{brand}, so it is
  // linearized with a brand-removing draft delete (Codex r1 P2-2): a closed brand refuses it; a NEW brand (absent) clears the tombstone
  const m = await txn(db, `branch_op_ids/${brandId}`, (cur, stop) => {
    const map = isObj(cur) ? cur : {};
    const own = map[opId];
    if (own != null) return isObj(own) && own.payload_hash === hash ? undefined : stop('op_conflict');
    if (map[CLOSED] != null && !(newBrand && brand0 == null)) return stop('brand_closed');
    const next = { ...map, [opId]: { payload_hash: hash } }; delete next[CLOSED];
    return next;
  });
  if (m.stop) return { ok: false, error: m.stop };
  let mapping = (isObj(m.value) && m.value[opId]) || {};

  // (2) the name, reserved before any rid (owned when op_id matches)
  const nk = nameKey(draft.location_name);
  const nm = await txn(db, `brand_branch_names/${brandId}/${nk}`, (cur, stop) => (cur == null ? { op_id: opId } : (cur.op_id === opId ? undefined : stop('name_taken'))));
  if (nm.stop) {
    if (!mapping.candidate) await txn(db, mapPath, (cur) => (cur && cur.payload_hash === hash && !cur.candidate ? null : undefined));   // release a candidate-less mapping
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
    if (held && held.op_id === opId && held.brand_id === brandId) owned = true;   // (brand, op) — op ids are per brand (Codex r1 P2-3)
    else if (!held && (await val(db, `restaurants/${cand}/identity`)) == null && (await val(db, `brands/${cand}`)) == null) {
      const rv = await txn(db, `rid_reservations/${cand}`, (cur, stop) => (cur == null ? { op_id: opId, brand_id: brandId } : (cur.op_id === opId && cur.brand_id === brandId ? undefined : stop('taken'))));
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

  // (4b) a NEW brand: its record, create-only, born OFF and listing this first branch (already matching → done)
  if (newBrand) {
    const rec = { name: newBrand.brandName, active: true, locations: { [rid]: 'staged' }, activation: { state: 'off', since: now }, projection_gen: 1 };
    if (!validateBrand(brandId, rec).ok) return { ok: false, error: 'brand_invalid' };
    const b = await txn(db, `brands/${brandId}`, (cur, stop) => (cur == null ? rec : (onlyStaged(cur, rid) ? undefined : stop('brand_exists'))));
    if (b.stop) {   // lost the brand id to another op: release what this op holds, then refuse
      await txn(db, `rid_reservations/${rid}`, (cur) => (cur && cur.op_id === opId && cur.brand_id === brandId ? null : undefined));
      await txn(db, `brand_branch_names/${brandId}/${nk}`, (cur) => (cur && cur.op_id === opId ? null : undefined));
      await txn(db, mapPath, (cur) => (cur && cur.payload_hash === hash ? null : undefined));
      return { ok: false, error: b.stop };
    }
  }

  // (5) the draft, create-only; an already-materialized branch of this op is done — ownership verified (this brand's identity / this
  // (brand, op)'s draft) before ok
  const idNow = await val(db, `restaurants/${rid}/identity`);
  if (idNow != null) return isObj(idNow) && idNow.brand_id === brandId ? { ok: true, rid } : { ok: false, error: 'rid_conflict' };
  const dw = await txn(db, `restaurants/${rid}/draft`, (cur, stop) => (cur == null ? { ...draft, created_at: now, created_by: callerUid, op_id: opId } : (cur.op_id === opId && cur.brand_id === brandId ? undefined : stop('draft_conflict'))));
  if (dw.stop) return { ok: false, error: dw.stop };
  return { ok: true, rid };
}

// abandoned-draft cleanup — a durable op (STEPS.delete_draft) under branch_ops/{rid}, so it is serialized with materialization and
// a crashed delete resumes (resumeBranchOp)
const deleteBranchDraft = (db, { rid, brandId, now = Date.now(), callId = `delete_${crypto.randomUUID()}`, clock }) =>
  runOp(db, rid, { kind: 'delete_draft', inputs: { brand_id: brandId } }, callId, now, clock);

// ── durable op runner (§2.2) ─────────────────────────────────────────────────────────────────────────────────────────────────

// a fresh clock (Codex r1 P2-1): an injected `clock`, else the call's `now` advanced by the real time elapsed since the call began
const clockOf = (now, clock) => { if (typeof clock === 'function') return clock; const t0 = Date.now(); return () => now + (Date.now() - t0); };

async function acquire(db, rid, { kind, inputs }, callId, clk) {
  const hash = hashOf(inputs);
  const now = clk();
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
// the fence: the record is still THIS op (op_id) and THIS caller still holds its lease
const owns = (cur, op, callId) => isObj(cur) && cur.op_id === op.op_id && isObj(cur.lease) && cur.lease.call_id === callId;
const LOST = Object.freeze({ ok: false, error: 'lease_lost' });
// renew (optionally checkpointing `step`) on a fresh clock — false when the fence is lost (nothing written)
async function renew(db, op, callId, clk, step) {
  const r = await txn(db, `branch_ops/${op.rid}`, (cur, stop) => {
    if (!owns(cur, op, callId)) return stop('lease_lost');
    const t = clk();
    return { ...cur, ...(step ? { step } : {}), updated_at: t, lease: { call_id: callId, until: t + LEASE_MS } };
  });
  return !r.stop;
}
async function fail(db, op, callId, clk, error) {
  const r = await txn(db, `branch_ops/${op.rid}`, (cur, stop) => (owns(cur, op, callId) ? { ...cur, error, lease: null, updated_at: clk() } : stop('lease_lost')));
  return r.stop ? LOST : { ok: false, error };
}
async function finish(db, op, callId) {
  const r = await txn(db, `branch_ops/${op.rid}`, (cur, stop) => (owns(cur, op, callId) ? null : stop('lease_lost')));
  return !r.stop;
}

const STEPS = {
  async materialize(db, op, callId, clk) {
    const { rid } = op; const { brand_id: brandId, identity } = op.inputs;
    if (!(await renew(db, op, callId, clk))) return LOST;
    const id = await txn(db, `restaurants/${rid}/identity`, (cur, stop) => (cur == null ? identity : (stable(cur) === stable(identity) ? undefined : stop('identity_conflict'))));
    if (id.stop) {
      if (!(await renew(db, op, callId, clk))) return LOST;   // a worker that lost its lease raises no alert
      await db.ref(`dispatcher_alerts/branch_identity_conflict_${rid}`).transaction((cur) => (cur == null ? { type: 'branch_identity_conflict', rid, created_at: clk() } : undefined));
      return fail(db, op, callId, clk, 'identity_conflict');
    }
    if (!(await renew(db, op, callId, clk, 'identity'))) return LOST;
    const b = await txn(db, `brands/${brandId}`, (cur, stop) => {
      if (!isObj(cur)) return stop('brand_not_found');
      const st = isObj(cur.locations) ? cur.locations[rid] : undefined;
      if (st === 'staged' || st === 'member') return undefined;
      if (st !== undefined) return stop('membership_conflict');
      const next = { ...cur, locations: { ...cur.locations, [rid]: 'staged' }, projection_gen: (cur.projection_gen || 0) + 1 };
      return validateBrand(brandId, next).ok ? next : stop('brand_invalid');
    });
    if (b.stop) return fail(db, op, callId, clk, b.stop);
    if (!(await renew(db, op, callId, clk, 'staged'))) return LOST;
    await db.ref(`restaurants/${rid}/draft`).remove();
    if (!(await finish(db, op, callId))) return LOST;
    return { ok: true, rid, state: 'staged' };
  },
  async activate(db, op, callId, clk) {
    const { rid } = op; const { brand_id: brandId, membership_to: to, patch, expected_version: ev } = op.inputs;
    if (!(await renew(db, op, callId, clk))) return LOST;
    if (to === 'member') {
      const b = await txn(db, `brands/${brandId}`, (cur, stop) => {
        const st = isObj(cur) && isObj(cur.locations) ? cur.locations[rid] : undefined;
        if (st === 'member') return undefined;
        if (st !== 'staged') return stop('membership_conflict');
        const next = { ...cur, locations: { ...cur.locations, [rid]: 'member' }, projection_gen: (cur.projection_gen || 0) + 1 };
        return validateBrand(brandId, next).ok ? next : stop('brand_invalid');
      });
      if (b.stop) return fail(db, op, callId, clk, b.stop);
      if (!(await renew(db, op, callId, clk, 'member'))) return LOST;
    }
    const id = await txn(db, `restaurants/${rid}/identity`, (cur, stop) => {
      if (!isObj(cur)) return stop('identity_missing');
      if (cur.version === patch.version && cur.active === patch.active) return undefined;
      return cur.version === ev ? { ...cur, ...patch } : stop('stale_branch');
    });
    if (id.stop) return fail(db, op, callId, clk, id.stop);
    if (!(await finish(db, op, callId))) return LOST;
    return { ok: true, rid, state: 'active' };
  },
  // abandoned-draft cleanup UNDER the rid's op (Codex r1 P2-2: serialized with materialize — the draft is re-read under the lease):
  // the draft + its rid / name reservations + the op-id mapping (only those this draft's (brand, op) owns). A NEW brand's first,
  // listed draft also removes the never-opened brand — only when NO other draft mapping exists (the brand CLOSE on
  // branch_op_ids/{brand}, linearized with every createDraft's mapping step); with a sibling draft it is refused (brand_has_drafts).
  async delete_draft(db, op, callId, clk) {
    const { rid } = op; const brandId = op.inputs.brand_id;
    if (!(await renew(db, op, callId, clk))) return LOST;
    const d = await val(db, `restaurants/${rid}/draft`);
    if (!isObj(d) || d.brand_id !== brandId) {
      if (!(await finish(db, op, callId))) return LOST;
      return op.step === 'start' ? { ok: false, error: 'not_a_draft' } : { ok: true };   // a resumed delete already removed it
    }
    const nk = nameKey(d.location_name);
    const [res, nm] = await Promise.all([val(db, `rid_reservations/${rid}`), val(db, `brand_branch_names/${brandId}/${nk}`)]);
    const brand = await val(db, `brands/${brandId}`);
    const closing = brand == null ? op.step === 'closed' : onlyStaged(brand, rid) && isObj(brand.activation) && brand.activation.state === 'off';
    const opId = typeof d.op_id === 'string' ? d.op_id : null;
    if (!(await renew(db, op, callId, clk))) return LOST;
    const c = await txn(db, `branch_op_ids/${brandId}`, (cur, stop) => {
      const map = isObj(cur) ? { ...cur } : {};
      if (opId) delete map[opId];
      if (closing) {
        if (Object.keys(map).some((k) => k !== CLOSED)) return stop('brand_has_drafts');
        return map[CLOSED] != null && !(opId && isObj(cur) && opId in cur) ? undefined : { [CLOSED]: clk() };
      }
      if (!(opId && isObj(cur) && opId in cur)) return undefined;
      return Object.keys(map).length ? map : null;
    });
    if (c.stop) return fail(db, op, callId, clk, c.stop);
    if (closing) {
      if (!(await renew(db, op, callId, clk, 'closed'))) return LOST;
      const b = await txn(db, `brands/${brandId}`, (cur, stop) => {
        if (cur == null) return undefined;
        return onlyStaged(cur, rid) && isObj(cur.activation) && cur.activation.state === 'off' ? null : stop('brand_changed');
      });
      if (b.stop) return fail(db, op, callId, clk, b.stop);
    }
    if (!(await renew(db, op, callId, clk, 'cleanup'))) return LOST;
    const u = { [`restaurants/${rid}/draft`]: null };
    if (res && res.op_id === d.op_id && res.brand_id === brandId) u[`rid_reservations/${rid}`] = null;
    if (nm && nm.op_id === d.op_id) u[`brand_branch_names/${brandId}/${nk}`] = null;
    await db.ref().update(u);
    if (!(await finish(db, op, callId))) return LOST;
    return { ok: true };
  },
};

async function runOp(db, rid, spec, callId, now, clock) {
  const clk = clockOf(now, clock);
  const a = await acquire(db, rid, spec, callId, clk);
  if (a.error) return { ok: false, error: a.error };
  return STEPS[a.op.kind](db, a.op, callId, clk);
}

// finish an unfinished op from its durable inputs (any later call, or the admin `resume <rid>`)
const resumeBranchOp = (db, { rid, now, callId, clock }) => runOp(db, rid, { kind: null, inputs: null }, callId, now, clock);

// ── Sherpa admin: materialize a draft with its location (§4) ─────────────────────────────────────────────────────────────────

async function materializeBranch(db, { rid, location, now, callId, clock }) {
  const op = await val(db, `branch_ops/${rid}`);
  if (isObj(op)) return op.kind === 'materialize' ? runOp(db, rid, { kind: 'materialize', inputs: null }, callId, now, clock) : { ok: false, error: 'op_in_progress' };
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
  return runOp(db, rid, { kind: 'materialize', inputs: { brand_id: draft.brand_id, location, identity: plan.identity } }, callId, now, clock);
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

async function readinessFacts(db, rid, brandId, brand, devices, readers) {
  const teamCount = typeof readers.teamCount === 'function' ? await readers.teamCount(rid) : 0;
  const menuPublished = typeof readers.menuPublished === 'function' ? (await readers.menuPublished(brandId)) === true : (await val(db, `menus/${brandId}`)) != null;
  return {
    membership: isObj(brand) && isObj(brand.locations) ? brand.locations[rid] : undefined,
    brandState: isObj(brand) && isObj(brand.activation) ? brand.activation.state : undefined,
    handheldSeen: devices.some((h) => Number.isFinite(h.last_seen)), teamCount, menuPublished,
  };
}
const unrevoked = (handhelds) => Object.values(isObj(handhelds) ? handhelds : {}).filter((h) => isObj(h) && h.revoked !== true);

async function setBranchActive(db, { rid, active, expectedVersion, now, callId, clock, readers = {} }) {
  const identity = await val(db, `restaurants/${rid}/identity`);
  if (!isObj(identity)) return { ok: false, error: 'not_a_branch' };
  const brandId = identity.brand_id;
  const [brand, handhelds] = [await val(db, `brands/${brandId}`), await val(db, `restaurants/${rid}/handhelds`)];
  const devices = unrevoked(handhelds);
  const facts = active === true ? await readinessFacts(db, rid, brandId, brand, devices, readers) : {};
  const plan = P.planSetActive({ identity, active, facts, now, expectedVersion });
  if (!plan.ok) return plan.unmet ? { ok: false, error: plan.error, unmet: plan.unmet } : { ok: false, error: plan.error };
  if (active === true) {
    return runOp(db, rid, { kind: 'activate', inputs: { brand_id: brandId, membership_to: plan.membershipTo || 'none', patch: plan.patch, expected_version: expectedVersion } }, callId, now, clock);
  }
  const w = await casIdentity(db, rid, expectedVersion, plan.patch);
  if (!w.ok) return w;
  const live = await liveOrders(db, rid);
  return { ok: true, state: 'inactive', consequences: { live_orders: live.length, scheduled_bound: live.filter((o) => o.status === 'scheduled').length, devices: devices.length } };
}

// ── Sherpa admin: brand activation (§3 for a NEW brand: off → on; the LEGACY cutover is O3) / deactivation (on → off) ──────────
// One brand transaction (state + the chosen staged → member + projection_gen + 1, re-validated), then each opened branch's identity
// active:true (+ version + 1) — by CAS on the identity version THIS call observed (Codex r1 P2-4): a branch changed since (e.g.
// deactivated concurrently) is never re-activated → stale_branch; a re-run re-observes, so a crashed activation resumes from state.
async function activateBrand(db, { brandId, open = [], now, readers = {}, checkOnly = false }) {
  const brand = await val(db, `brands/${brandId}`);
  if (!isObj(brand)) return { ok: false, error: 'brand_not_found' };
  if (isObj(brand.activation) && brand.activation.state === 'legacy') return { ok: false, error: 'legacy_cutover_is_o3' };
  const locs = isObj(brand.locations) ? brand.locations : {};
  const bad = open.filter((rid) => locs[rid] !== 'staged' && locs[rid] !== 'member');
  if (bad.length) return { ok: false, error: 'not_staged', rids: bad };
  const unmet = {}; const seen = {};
  for (const rid of open) {
    const identity = await val(db, `restaurants/${rid}/identity`);
    seen[rid] = isObj(identity) ? identity.version : undefined;
    if (isObj(identity) && identity.active === true) continue;
    const facts = await readinessFacts(db, rid, brandId, brand, unrevoked(await val(db, `restaurants/${rid}/handhelds`)), readers);
    const plan = P.planSetActive({ identity, active: true, facts: { ...facts, brandState: 'on' }, now, expectedVersion: isObj(identity) ? identity.version : undefined });
    if (!plan.ok) unmet[rid] = plan.unmet || [plan.error];
  }
  if (Object.keys(unmet).length) return { ok: false, error: 'not_ready', unmet };
  if (checkOnly) return { ok: true, ready: open };   // the CLI's dry run: every check, no write
  const b = await txn(db, `brands/${brandId}`, (cur, stop) => {
    if (!isObj(cur)) return stop('brand_not_found');
    if (isObj(cur.activation) && cur.activation.state === 'legacy') return stop('legacy_cutover_is_o3');
    const next = { ...cur, locations: { ...cur.locations } }; let changed = false;
    if (!(isObj(cur.activation) && cur.activation.state === 'on')) { next.activation = { state: 'on', since: now }; changed = true; }
    for (const rid of open) {
      if (next.locations[rid] === 'staged') { next.locations[rid] = 'member'; changed = true; } else if (next.locations[rid] !== 'member') return stop('not_staged');
    }
    if (!changed) return undefined;
    next.projection_gen = (cur.projection_gen || 0) + 1;
    return validateBrand(brandId, next).ok ? next : stop('brand_invalid');
  });
  if (b.stop) return { ok: false, error: b.stop };
  for (const rid of open) {
    const id = await txn(db, `restaurants/${rid}/identity`, (cur, stop) => {
      if (!isObj(cur) || !Number.isFinite(cur.version)) return stop('identity_invalid');
      if (cur.version !== seen[rid]) return stop('stale_branch');
      if (cur.active === true) return undefined;
      return { ...cur, active: true, active_changed_at: now, version: cur.version + 1 };
    });
    if (id.stop) return { ok: false, error: id.stop, rid };
  }
  return { ok: true, opened: open };
}

async function deactivateBrand(db, { brandId, now }) {
  const b = await txn(db, `brands/${brandId}`, (cur, stop) => {
    if (!isObj(cur)) return stop('brand_not_found');
    if (!(isObj(cur.activation) && cur.activation.state === 'on')) return stop('not_on');
    const next = { ...cur, activation: { state: 'off', since: now }, projection_gen: (cur.projection_gen || 0) + 1 };
    return validateBrand(brandId, next).ok ? next : stop('brand_invalid');
  });
  return b.stop ? { ok: false, error: b.stop } : { ok: true };
}

// projection resync (advisor ruling): a version-only identity bump, so the fenced publish carries an unversioned earlier write
const bumpIdentityVersion = (db, { rid, expectedVersion }) => casIdentity(db, rid, expectedVersion, { version: expectedVersion + 1 });

module.exports = { createBrandWithDraft, liveOrders, activateBrand, deactivateBrand, bumpIdentityVersion, createDraft, deleteBranchDraft, materializeBranch, resumeBranchOp, setBranchLocation, setBranchActive, enrichLegacyIdentity, LEASE_MS };
