'use strict';
// ORCHESTRATION O1a (PLAN-multi-location-orchestration r3.1 §2.2, §2.3, §4, §5) — the branch-lifecycle WRITERS (RTDB, Admin SDK).
// ONE LIFECYCLE LOCK PER BRAND (Codex r2, advisor ruling): every lifecycle op — create_draft (createDraft / createBrandWithDraft),
// delete_draft, materialize, activate (setBranchActive → active), activate_brand, and resume — holds brand_ops/{brand} for its whole
// duration: a durable record {kind, op_id, inputs, step, plan, lease}. A second op on the same brand gets brand_busy; different
// brands run fully in parallel. Under the lock every step RE-READS and plans; nothing is decided from a pre-lock read (the only
// pre-lock read is the rid → brand routing, re-verified under the lock). The plan a resume needs is persisted on the record before
// the first write. FENCED (r1): renew / checkpoint, failure and cleanup act only while the record is THIS op and THIS caller holds
// the lease (fresh clock); a refusal RELEASES the lock (terminal), only a crash leaves it (→ brand_busy until `resume`).
// COMMIT-TIME CONDITIONS (r2/r3): records an op creates carry inc = the CALL holding the lease (draft, rid / name reservations,
// op-id mapping), re-stamped by a takeover as it re-enters — so an expired holder's rollback (inc === its own call) no-ops;
// every destructive write is a transaction that removes only the exact value observed under the lock, so an expired worker's
// late write lands only on the incarnation it saw. Materialize writes the identity and removes the draft in ONE transaction on
// restaurants/{rid}. Single-node writes (set-location, deactivate, enrich-legacy, version bump) stay a version CAS, unlocked.
// No Firestore write in any lifecycle op. A branch becomes `member` only at activation, after its identity exists and validates.
const crypto = require('crypto');
const { validateBrand } = require('../brands/brand-model');
const { ridCandidates, nameKey } = require('./rid-alloc');
const { boundDraft } = require('./drafts');   // O1b T1b
const P = require('./branch-ops');
const { HEAL_TERMINAL_STATUSES } = require('../sweep-pending');   // every terminal status incl. cancelled — anything else is live

const LEASE_MS = 10 * 60 * 1000;   // generous (Codex r3 #1 ruling): a holder must stall > 10 min mid-op to lose the brand
const DRAFT_KEYS = ['brand_id', 'location_name', 'phone', 'hours', 'prep_default_min'];
const lockPath = (brandId) => `brand_ops/${brandId}`;


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
const onlyStaged = (brand, rid) => isObj(brand) && isObj(brand.locations) && Object.keys(brand.locations).length === 1 && brand.locations[rid] === 'staged';
const same = (a, b) => stable(a === undefined ? null : a) === stable(b === undefined ? null : b);
const newCallId = (p) => `${p}_${crypto.randomUUID()}`;

// ── the brand lock (durable op record) ──────────────────────────────────────────────────────────────────────────────────────────

// a fresh clock (Codex r1 P2-1): an injected `clock`, else the call's `now` advanced by the real time elapsed since the call began
const clockOf = (now, clock) => { if (typeof clock === 'function') return clock; const t0 = Date.now(); return () => now + (Date.now() - t0); };

// take brand_ops/{brand}: create it (a new op, with inputs), take over THIS op after its holder's lease expired (same kind + inputs,
// or a resume), else brand_busy (another op — live, or interrupted and waiting for `resume`)
async function acquire(db, brandId, { kind, inputs, at }, callId, clk) {
  const hash = hashOf(inputs);
  const now = clk();
  const lease = { call_id: callId, until: now + LEASE_MS };
  let holder = null; let takeover = false;
  const r = await txn(db, lockPath(brandId), (cur, stop) => {
    holder = null; takeover = false;
    if (cur == null) return inputs ? { kind, op_id: callId, brand_id: brandId, inputs, payload_hash: hash, at, lease, step: 'start', started_at: now, updated_at: now } : stop('no_op');
    // a record no op wrote (e.g. a manual console edit) fails CLOSED: never run, never overwritten — the brand stays busy for a human
    if (!validRecord(cur, brandId)) {
      if (!inputs) return stop('bad_op_record');
      holder = { kind: null, interrupted: true }; return stop('brand_busy');
    }
    const live = isObj(cur.lease) && cur.lease.call_id !== callId && Number.isFinite(cur.lease.until) && cur.lease.until > now;
    if (live || (inputs && (cur.kind !== kind || cur.payload_hash !== hash))) { holder = { kind: cur.kind, interrupted: !live }; return stop('brand_busy'); }
    takeover = true;   // re-entering an interrupted op: an earlier holder of it may still be alive
    return { ...cur, lease, updated_at: now };
  });
  if (r.stop === 'brand_busy') return { error: { ok: false, error: 'brand_busy', brand: brandId, holder: holder ? holder.kind : null, interrupted: !!(holder && holder.interrupted) } };
  if (r.stop === 'bad_op_record') return { error: { ok: false, error: 'bad_op_record', brand: brandId } };
  return r.stop ? { error: { ok: false, error: r.stop } } : { op: r.value, takeover };
}
// a COMPLETE durable record (Codex r3 #4), validated before any takeover: never run, never re-leased otherwise. RTDB prunes an
// empty list / map, so activate_brand / deactivate_brand legitimately have no inputs.
const isStr = (v) => typeof v === 'string' && v.length > 0;
// the SAME rules the public writers apply to a fresh call (Codex r4 #1): a record whose payload a fresh call would refuse never resumes
const OP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const validBrandName = (n) => typeof n === 'string' && n.length >= 1 && n.length <= 80 && n.trim() === n;
const INPUTS_OK = {
  create_draft: (i) => isObj(i) && isObj(i.draft) && P.draftErrors(i.draft).length === 0 && typeof i.op_id === 'string' && OP_ID_RE.test(i.op_id)
    && (i.brand_name == null || validBrandName(i.brand_name)),
  delete_draft: (i) => isObj(i) && isStr(i.rid),
  materialize: (i) => isObj(i) && isStr(i.rid) && isObj(i.location),
  activate: (i) => isObj(i) && isStr(i.rid) && Number.isFinite(i.expected_version),
  activate_brand: (i) => i == null || (isObj(i) && (i.open == null || (Array.isArray(i.open) && i.open.every(isStr)))),
  deactivate_brand: (i) => i == null || isObj(i),
};
function validRecord(cur, brandId) {
  if (!isObj(cur) || !isStr(cur.op_id) || cur.brand_id !== brandId || !isStr(cur.payload_hash) || !isStr(cur.step)) return false;
  if (!Object.prototype.hasOwnProperty.call(STEPS, cur.kind) || !Object.prototype.hasOwnProperty.call(INPUTS_OK, cur.kind)) return false;
  if (cur.kind === 'create_draft' && cur.inputs && cur.inputs.draft && cur.inputs.draft.brand_id !== brandId) return false;
  return INPUTS_OK[cur.kind](cur.inputs);
}
// the fence: the record is still THIS op (op_id) and THIS caller still holds its lease
const owns = (cur, op, callId) => isObj(cur) && cur.op_id === op.op_id && isObj(cur.lease) && cur.lease.call_id === callId;
const LOST = Object.freeze({ ok: false, error: 'lease_lost' });
// renew on a fresh clock, optionally checkpointing `step` and persisting `plan` — false when the fence is lost (nothing written)
async function renew(db, op, callId, clk, step, plan) {
  const r = await txn(db, lockPath(op.brand_id), (cur, stop) => {
    if (!owns(cur, op, callId)) return stop('lease_lost');
    const t = clk();
    return { ...cur, ...(step ? { step } : {}), ...(plan ? { plan } : {}), updated_at: t, lease: { call_id: callId, until: t + LEASE_MS } };
  });
  if (!r.stop) { if (step) op.step = step; if (plan) op.plan = plan; }
  return !r.stop;
}
// a refusal is terminal: release the lock (fenced) and report
async function fail(db, op, callId, error, extra = {}) {
  const r = await txn(db, lockPath(op.brand_id), (cur, stop) => (owns(cur, op, callId) ? null : stop('lease_lost')));
  return r.stop ? LOST : { ok: false, error, ...extra };
}
async function finish(db, op, callId) {
  const r = await txn(db, lockPath(op.brand_id), (cur, stop) => (owns(cur, op, callId) ? null : stop('lease_lost')));
  return !r.stop;
}
// remove a node only while it still holds EXACTLY the value observed under the lock (absent → nothing to do)
const removeIfSame = (db, path, observed) => txn(db, path, (cur) => (cur != null && same(cur, observed) ? null : undefined));
// remove a node only while it still belongs to this op (the predicate is checked at commit)
const removeOwned = (db, path, mine) => txn(db, path, (cur) => (cur != null && mine(cur) ? null : undefined));

async function runOp(db, brandId, spec, callId, now, clock, ctx = {}) {
  if (typeof brandId !== 'string' || !brandId) return { ok: false, error: 'not_a_branch' };
  const clk = clockOf(now, clock);
  const a = await acquire(db, brandId, spec, callId, clk);
  if (a.error) return a.error;
  return STEPS[a.op.kind](db, a.op, callId, clk, { ...ctx, takeover: a.takeover });
}

// rid → its brand (routing only; every step re-verifies under the lock)
async function brandOfRid(db, rid) {
  const d = await val(db, `restaurants/${rid}/draft`);
  if (isObj(d) && typeof d.brand_id === 'string') return d.brand_id;
  const b = await val(db, `restaurants/${rid}/identity/brand_id`);
  return typeof b === 'string' ? b : null;
}

const STEPS = {
  // ── draft creation (§2.2 ordering, §2.3 allocation), under the brand lock ──
  // payload-bound op-id mapping branch_op_ids/{brand}/{op_id}; the name is reserved FIRST (a taken name never strands a rid
  // reservation), then the rid candidate is PERSISTED on the mapping BEFORE it is reserved, advanced only forward from the
  // persisted value; a NEW brand's record is created OFF listing this first branch; the draft is written create-only.
  async create_draft(db, op, callId, clk, ctx) {
    // inc = THIS call (the lease holder). A TAKEOVER of an interrupted op re-stamps every record the op owns with it, so the expired
    // earlier holder's rollback — which removes only inc === its own call — no-ops on what a later holder completed (Codex r3 #1).
    // A fresh re-run of a completed op re-stamps nothing (no earlier holder of it can still be running).
    const brandId = op.brand_id; const inc = callId;
    const { draft, op_id: opId, brand_name: brandName, caller_uid: callerUid } = op.inputs || {};
    const newBrand = brandName != null;
    const hash = hashOf(newBrand ? { ...draft, brand_name: brandName } : draft);
    const mapPath = `branch_op_ids/${brandId}/${opId}`;
    const guard = () => renew(db, op, callId, clk);   // renew-and-verify IMMEDIATELY before every write (lease_lost → no write)
    const restamp = (cur) => (!ctx.takeover || cur.inc === inc ? undefined : { ...cur, inc });
    if (!(await guard())) return LOST;
    const [brand0, m0] = [await val(db, `brands/${brandId}`), await val(db, mapPath)];
    if (isObj(m0) && m0.payload_hash !== hash) return fail(db, op, callId, 'op_conflict');
    if (!newBrand && !isObj(brand0)) return fail(db, op, callId, 'brand_not_found');
    if (newBrand && brand0 != null && !(isObj(m0) && m0.rid && onlyStaged(brand0, m0.rid))) return fail(db, op, callId, 'brand_exists');

    // (1) the op-id mapping, create-only and payload-bound
    if (!(await guard())) return LOST;
    const m = await txn(db, mapPath, (cur, stop) => (cur == null ? { payload_hash: hash, inc } : (cur.payload_hash === hash ? restamp(cur) : stop('op_conflict'))));
    if (m.stop) return fail(db, op, callId, m.stop);
    let mapping = m.value || {};

    // (2) the name, reserved before any rid (owned when op_id matches)
    const nk = nameKey(draft.location_name);
    if (!(await guard())) return LOST;
    const nm = await txn(db, `brand_branch_names/${brandId}/${nk}`, (cur, stop) => (cur == null ? { op_id: opId, inc } : (cur.op_id === opId ? restamp(cur) : stop('name_taken'))));
    if (nm.stop) {
      if (!mapping.candidate) {   // release a candidate-less mapping (a retry may reuse the op id) — only while still ours
        if (!(await guard())) return LOST;
        await removeOwned(db, mapPath, (v) => v.payload_hash === hash && v.inc === inc && !v.candidate);
      }
      return fail(db, op, callId, 'name_taken');
    }

    // (3) persist the candidate, then reserve exactly it; advance only forward from the persisted value. A reservation is owned by
    // (brand_id, op_id) — op ids are per brand (Codex r1 P2-3).
    const seq = ridCandidates(brandId, draft.location_name);
    let rid = mapping.rid || null;
    if (rid && ctx.takeover) {   // taking over a completed allocation: re-stamp the reservation this op owns
      if (!(await guard())) return LOST;
      await txn(db, `rid_reservations/${rid}`, (cur) => (cur != null && cur.op_id === opId && cur.brand_id === brandId ? restamp(cur) : undefined));
    }
    for (let tries = 0; !rid; tries += 1) {
      if (tries > seq.length) return fail(db, op, callId, 'rid_exhausted');   // fail closed: the walk only ever moves forward
      if (!(await guard())) return LOST;
      const pc = await txn(db, mapPath, (cur, stop) => (cur == null || cur.payload_hash !== hash ? stop('op_lost') : (cur.candidate ? undefined : { ...cur, candidate: seq[0] })));
      if (pc.stop) return fail(db, op, callId, pc.stop);
      mapping = pc.value; const cand = mapping.candidate;
      let owned = false;
      const held = await val(db, `rid_reservations/${cand}`);
      if (held && held.op_id === opId && held.brand_id === brandId) {
        if (!(await guard())) return LOST;
        await txn(db, `rid_reservations/${cand}`, (cur) => (cur != null && cur.op_id === opId && cur.brand_id === brandId ? restamp(cur) : undefined));
        owned = true;
      } else if (!held && (await val(db, `restaurants/${cand}/identity`)) == null && (await val(db, `brands/${cand}`)) == null) {
        if (!(await guard())) return LOST;
        const rv = await txn(db, `rid_reservations/${cand}`, (cur, stop) => (cur == null ? { op_id: opId, brand_id: brandId, inc } : (cur.op_id === opId && cur.brand_id === brandId ? restamp(cur) : stop('taken'))));
        owned = !rv.stop;
      }
      if (owned) { rid = cand; break; }
      const i = seq.indexOf(cand);
      if (i < 0 || i + 1 >= seq.length) return fail(db, op, callId, 'rid_exhausted');
      if (!(await guard())) return LOST;
      const adv = await txn(db, mapPath, (cur, stop) => (cur && cur.payload_hash === hash ? (cur.candidate === cand ? { ...cur, candidate: seq[i + 1] } : undefined) : stop('op_lost')));
      if (adv.stop) return fail(db, op, callId, adv.stop);
    }

    // (4) the mapping's rid (set if absent, keep if equal)
    if (!(await guard())) return LOST;
    const sr = await txn(db, mapPath, (cur, stop) => (cur && cur.payload_hash === hash ? (cur.rid == null ? { ...cur, rid } : (cur.rid === rid ? undefined : stop('op_lost'))) : stop('op_lost')));
    if (sr.stop) return fail(db, op, callId, sr.stop);
    if (!(await renew(db, op, callId, clk, 'reserved'))) return LOST;

    // (4b) a NEW brand: its record, create-only, born OFF and listing this first branch (already matching → done)
    if (newBrand) {
      const rec = { name: brandName, active: true, locations: { [rid]: 'staged' }, activation: { state: 'off', since: op.at }, projection_gen: 1 };
      if (!validateBrand(brandId, rec).ok) return fail(db, op, callId, 'brand_invalid');
      if (!(await guard())) return LOST;
      const b = await txn(db, `brands/${brandId}`, (cur, stop) => (cur == null ? rec : (onlyStaged(cur, rid) ? undefined : stop('brand_exists'))));
      if (b.stop) {   // the brand id is taken: release exactly what THIS call holds (inc), each delete right after a renewal, then refuse
        for (const [path, mine] of [[`rid_reservations/${rid}`, (v) => v.op_id === opId && v.brand_id === brandId && v.inc === inc],
          [`brand_branch_names/${brandId}/${nk}`, (v) => v.op_id === opId && v.inc === inc], [mapPath, (v) => v.payload_hash === hash && v.inc === inc]]) {
          if (!(await guard())) return LOST;
          await removeOwned(db, path, mine);
        }
        return fail(db, op, callId, b.stop);
      }
    }

    // (5) the draft, create-only; an already-materialized branch of this op is done — ownership verified (this brand's identity / this
    // (brand, op)'s draft) before ok
    const idNow = await val(db, `restaurants/${rid}/identity`);
    if (idNow != null) {
      if (!(isObj(idNow) && idNow.brand_id === brandId)) return fail(db, op, callId, 'rid_conflict');
      return (await finish(db, op, callId)) ? { ok: true, rid } : LOST;
    }
    if (!(await guard())) return LOST;   // RIGHT before the create (Codex r3 #1: a stale creator never resurrects a deleted draft)
    const dw = await txn(db, `restaurants/${rid}/draft`, (cur, stop) => (cur == null ? { ...draft, created_at: op.at, created_by: callerUid, op_id: opId, inc } : (cur.op_id === opId && cur.brand_id === brandId ? restamp(cur) : stop('draft_conflict'))));
    if (dw.stop) return fail(db, op, callId, dw.stop);
    return (await finish(db, op, callId)) ? { ok: true, rid } : LOST;
  },

  // ── abandoned-draft cleanup, under the brand lock ──
  // the draft + its rid / name reservations + the op-id mapping, each removed only as observed. A NEW brand's first, listed draft
  // also removes the never-opened brand — only when no other draft / materialized branch exists (decided under the lock: a sibling
  // op counts when its rid has a draft or an identity); with one it is refused (brand_has_drafts — a brand may not list nothing).
  // Order: the brand first (record == observed; a changed brand stops BEFORE anything is deleted — a usable state), then the draft
  // (== observed, no identity; a recreated draft stops the op), then the reservations and the mapping. A draft its brand still LISTS
  // otherwise is refused (brand_lists_draft).
  async delete_draft(db, op, callId, clk) {
    const brandId = op.brand_id; const { rid } = op.inputs || {};
    if (!(await renew(db, op, callId, clk))) return LOST;
    let plan = op.plan;
    if (!plan) {
      const d = await val(db, `restaurants/${rid}/draft`);
      if (!isObj(d) || d.brand_id !== brandId) return fail(db, op, callId, 'not_a_draft');
      if ((await val(db, `restaurants/${rid}/identity`)) != null) return fail(db, op, callId, 'not_a_draft');
      const nk = nameKey(d.location_name);
      const res = await val(db, `rid_reservations/${rid}`);
      const nm = await val(db, `brand_branch_names/${brandId}/${nk}`);
      const maps = (await val(db, `branch_op_ids/${brandId}`)) || {};
      // O1b T1b: a PORTAL delete (inputs.bind) re-binds under the lock — the brand's op-id mapping for this draft's op must point
      // back to this rid. The Sherpa CLI (no bind) keeps O1a's behaviour so it can still remove an orphan draft `check` reports.
      if (op.inputs.bind === true && !boundDraft(brandId, rid, d, null, typeof d.op_id === 'string' ? maps[d.op_id] : null)) return fail(db, op, callId, 'not_a_draft');
      const brand = await val(db, `brands/${brandId}`);
      const closing = onlyStaged(brand, rid) && isObj(brand.activation) && brand.activation.state === 'off';
      // a draft its brand LISTS goes only together with that listing (Codex r3 #3): the never-opened single-staged OFF brand is
      // removed whole; any other listing (an ON brand, or other locations) would be left dangling → refused
      if (!closing && isObj(brand) && isObj(brand.locations) && rid in brand.locations) return fail(db, op, callId, 'brand_lists_draft');
      if (closing) {
        for (const [k, mp] of Object.entries(maps)) {
          if (k === d.op_id || !isObj(mp) || typeof mp.rid !== 'string') continue;
          if ((await val(db, `restaurants/${mp.rid}/draft`)) != null || (await val(db, `restaurants/${mp.rid}/identity`)) != null) return fail(db, op, callId, 'brand_has_drafts');
        }
      }
      plan = { draft: d, nk, closing, brand: closing ? brand : null,
        res: res && res.op_id === d.op_id && res.brand_id === brandId ? res : null,
        name: nm && nm.op_id === d.op_id ? nm : null,
        mapping: typeof d.op_id === 'string' && isObj(maps[d.op_id]) ? { op_id: d.op_id, value: maps[d.op_id] } : null };
      if (!(await renew(db, op, callId, clk, 'planned', plan))) return LOST;
    }
    if (plan.closing) {
      const b = await txn(db, `brands/${brandId}`, (cur, stop) => (cur == null ? undefined : (same(cur, plan.brand) ? null : stop('brand_changed'))));
      if (b.stop) return fail(db, op, callId, b.stop);
      if (!(await renew(db, op, callId, clk, 'brand_removed'))) return LOST;
    }
    const dr = await txn(db, `restaurants/${rid}`, (cur, stop) => {
      if (!isObj(cur) || cur.draft == null) return undefined;   // already removed (a resumed delete)
      if (!same(cur.draft, plan.draft) || cur.identity != null) return stop('draft_changed');
      const next = { ...cur }; delete next.draft;
      return Object.keys(next).length ? next : null;
    });
    if (dr.stop) return fail(db, op, callId, dr.stop);
    if (!(await renew(db, op, callId, clk, 'draft_removed'))) return LOST;
    for (const [path, observed] of [[`rid_reservations/${rid}`, plan.res], [`brand_branch_names/${brandId}/${plan.nk}`, plan.name],
      [plan.mapping && `branch_op_ids/${brandId}/${plan.mapping.op_id}`, plan.mapping && plan.mapping.value]]) {
      if (!observed) continue;
      if (!(await renew(db, op, callId, clk))) return LOST;   // renew-and-verify right before each destructive write
      await removeIfSame(db, path, observed);
    }
    return (await finish(db, op, callId)) ? { ok: true } : LOST;
  },

  // ── Sherpa admin: materialize a draft with its location (§4), under the brand lock ──
  // re-validates the draft and its allocation under the lock (Codex r2 #1), plans the identity there, then ONE transaction on
  // restaurants/{rid} writes the identity and removes the draft (draft == observed), then the brand lists it `staged`
  async materialize(db, op, callId, clk) {
    const brandId = op.brand_id; const { rid, location } = op.inputs || {};
    if (!(await renew(db, op, callId, clk))) return LOST;
    let plan = op.plan;
    if (!plan) {
      const [draft, identity, brand] = [await val(db, `restaurants/${rid}/draft`), await val(db, `restaurants/${rid}/identity`), await val(db, `brands/${brandId}`)];
      if (!isObj(draft)) {
        const st = isObj(identity) && identity.brand_id === brandId && isObj(brand) && isObj(brand.locations) ? brand.locations[rid] : undefined;
        if (st === 'staged' || st === 'member') return (await finish(db, op, callId)) ? { ok: true, rid, state: st } : LOST;
        return fail(db, op, callId, 'not_a_draft');
      }
      if (draft.brand_id !== brandId) return fail(db, op, callId, 'not_a_draft');
      if (!isObj(brand)) return fail(db, op, callId, 'brand_not_found');
      const p = P.planMaterialize({ draft, location, brandName: brand.name, bounds: await val(db, 'platform_config/service_bounds'), now: op.at });
      if (!p.ok) return fail(db, op, callId, 'bad_location', { errors: p.errors });
      const res = await val(db, `rid_reservations/${rid}`);
      if (!(isObj(res) && res.op_id === draft.op_id && res.brand_id === brandId)) return fail(db, op, callId, 'allocation_lost');
      plan = { draft, identity: p.identity };
      if (!(await renew(db, op, callId, clk, 'planned', plan))) return LOST;
    }
    const w = await txn(db, `restaurants/${rid}`, (cur, stop) => {
      const c = isObj(cur) ? cur : {};
      if (c.identity != null) {
        if (!same(c.identity, plan.identity)) return stop('identity_conflict');
        return c.draft == null ? undefined : (same(c.draft, plan.draft) ? (() => { const n = { ...c }; delete n.draft; return n; })() : stop('draft_changed'));
      }
      if (!same(c.draft, plan.draft)) return stop('draft_changed');
      const n = { ...c, identity: plan.identity }; delete n.draft;
      return n;
    });
    if (w.stop === 'identity_conflict') {
      if (!(await renew(db, op, callId, clk))) return LOST;   // a worker that lost its lease raises no alert
      await db.ref(`dispatcher_alerts/branch_identity_conflict_${rid}`).transaction((cur) => (cur == null ? { type: 'branch_identity_conflict', rid, created_at: clk() } : undefined));
      return fail(db, op, callId, 'identity_conflict');
    }
    if (w.stop) return fail(db, op, callId, w.stop);
    if (!(await renew(db, op, callId, clk, 'identity'))) return LOST;
    const b = await txn(db, `brands/${brandId}`, (cur, stop) => {
      if (!isObj(cur)) return stop('brand_not_found');
      const st = isObj(cur.locations) ? cur.locations[rid] : undefined;
      if (st === 'staged' || st === 'member') return undefined;
      if (st !== undefined) return stop('membership_conflict');
      const next = { ...cur, locations: { ...cur.locations, [rid]: 'staged' }, projection_gen: (cur.projection_gen || 0) + 1 };
      return validateBrand(brandId, next).ok ? next : stop('brand_invalid');
    });
    if (b.stop) return fail(db, op, callId, b.stop);
    if (!(await renew(db, op, callId, clk, 'staged'))) return LOST;
    return (await finish(db, op, callId)) ? { ok: true, rid, state: 'staged' } : LOST;
  },

  // ── one branch's activation (readiness §5, staged → member), under the brand lock ──
  async activate(db, op, callId, clk, ctx) {
    const brandId = op.brand_id; const { rid, expected_version: ev } = op.inputs || {};
    if (!(await renew(db, op, callId, clk))) return LOST;
    let plan = op.plan;
    if (!plan) {
      if (!ctx.live) return fail(db, op, callId, 'interrupted');   // a resume before any write: nothing to finish — run it again
      const identity = await val(db, `restaurants/${rid}/identity`);
      if (!isObj(identity) || identity.brand_id !== brandId) return fail(db, op, callId, 'not_a_branch');
      const [brand, handhelds] = [await val(db, `brands/${brandId}`), await val(db, `restaurants/${rid}/handhelds`)];
      const facts = await readinessFacts(db, rid, brandId, brand, unrevoked(handhelds), ctx.readers || {});
      const p = P.planSetActive({ identity, active: true, facts, now: op.at, expectedVersion: ev });
      if (!p.ok) return fail(db, op, callId, p.error, p.unmet ? { unmet: p.unmet } : {});
      plan = { patch: p.patch, membership_to: p.membershipTo || 'none' };
      if (!(await renew(db, op, callId, clk, 'planned', plan))) return LOST;
    }
    if (plan.membership_to === 'member') {
      const b = await txn(db, `brands/${brandId}`, (cur, stop) => {
        const st = isObj(cur) && isObj(cur.locations) ? cur.locations[rid] : undefined;
        if (st === 'member') return undefined;
        if (st !== 'staged') return stop('membership_conflict');
        const next = { ...cur, locations: { ...cur.locations, [rid]: 'member' }, projection_gen: (cur.projection_gen || 0) + 1 };
        return validateBrand(brandId, next).ok ? next : stop('brand_invalid');
      });
      if (b.stop) return fail(db, op, callId, b.stop);
      if (!(await renew(db, op, callId, clk, 'member'))) return LOST;
    }
    const id = await txn(db, `restaurants/${rid}/identity`, (cur, stop) => {
      if (!isObj(cur)) return stop('identity_missing');
      if (cur.version === plan.patch.version && cur.active === plan.patch.active) return undefined;
      return cur.version === ev ? { ...cur, ...plan.patch } : stop('stale_branch');
    });
    if (id.stop) return fail(db, op, callId, id.stop);
    return (await finish(db, op, callId)) ? { ok: true, rid, state: 'active' } : LOST;
  },

  // ── Sherpa admin: brand activation (§3 for a NEW brand: off → on; the LEGACY cutover is O3), under the brand lock ──
  // One brand transaction (state + the chosen staged → member + projection_gen + 1, re-validated), then each opened branch's identity
  // active:true (+ version + 1) by CAS on the version observed under the lock (Codex r1 P2-4): a branch changed since → stale_branch.
  async activate_brand(db, op, callId, clk, ctx) {
    const brandId = op.brand_id; const now = op.at;
    const open = Array.isArray(op.inputs && op.inputs.open) ? op.inputs.open : [];   // RTDB stores an empty list as nothing
    if (!(await renew(db, op, callId, clk))) return LOST;
    let plan = op.plan;
    if (!plan) {
      if (!ctx.live) return fail(db, op, callId, 'interrupted');
      const r = await activationReadiness(db, brandId, open, now, ctx.readers || {});
      if (!r.ok) return fail(db, op, callId, r.error, r.extra || {});
      plan = { seen: r.seen, gen: r.gen };   // gen (always a number) keeps the plan non-empty — RTDB drops an empty seen map
      if (!(await renew(db, op, callId, clk, 'ready', plan))) return LOST;
    }
    if (!(await renew(db, op, callId, clk))) return LOST;   // renew-and-verify right before the write
    // committed only on the projection_gen observed under the lock (Codex r3 #2) — or recognised as this op's own completed write —
    // so a stale activation can never undo a later deactivation (stale_brand)
    const b = await txn(db, `brands/${brandId}`, (cur, stop) => {
      if (!isObj(cur)) return stop('brand_not_found');
      if (isObj(cur.activation) && cur.activation.state === 'legacy') return stop('legacy_cutover_is_o3');
      const g = cur.projection_gen || 0;
      if (g !== plan.gen) {
        const done = g === plan.gen + 1 && isObj(cur.activation) && cur.activation.state === 'on' && open.every((rid) => isObj(cur.locations) && cur.locations[rid] === 'member');
        return done ? undefined : stop('stale_brand');
      }
      const next = { ...cur, locations: { ...cur.locations } }; let changed = false;
      if (!(isObj(cur.activation) && cur.activation.state === 'on')) { next.activation = { state: 'on', since: now }; changed = true; }
      for (const rid of open) {
        if (next.locations[rid] === 'staged') { next.locations[rid] = 'member'; changed = true; } else if (next.locations[rid] !== 'member') return stop('not_staged');
      }
      if (!changed) return undefined;
      next.projection_gen = (cur.projection_gen || 0) + 1;
      return validateBrand(brandId, next).ok ? next : stop('brand_invalid');
    });
    if (b.stop) return fail(db, op, callId, b.stop);
    if (!(await renew(db, op, callId, clk, 'brand_on'))) return LOST;
    for (const rid of open) {
      if (!(await renew(db, op, callId, clk))) return LOST;
      const id = await txn(db, `restaurants/${rid}/identity`, (cur, stop) => {
        if (!isObj(cur) || !Number.isFinite(cur.version)) return stop('identity_invalid');
        const seen = (plan.seen || {})[rid];
        if (cur.active === true && cur.version === seen + 1 && cur.active_changed_at === now) return undefined;   // this op's own write (resumed)
        if (cur.version !== seen) return stop('stale_branch');
        if (cur.active === true) return undefined;
        return { ...cur, active: true, active_changed_at: now, version: cur.version + 1 };
      });
      if (id.stop) return fail(db, op, callId, id.stop, { rid });
    }
    return (await finish(db, op, callId)) ? { ok: true, opened: open } : LOST;
  },

  // ── Sherpa admin: brand deactivation (on → off), under the brand lock like every lifecycle op (Codex r3 #2) ──
  async deactivate_brand(db, op, callId, clk) {
    const brandId = op.brand_id; const now = op.at;
    if (!(await renew(db, op, callId, clk))) return LOST;
    let plan = op.plan;
    if (!plan) {
      const brand = await val(db, `brands/${brandId}`);
      if (!isObj(brand)) return fail(db, op, callId, 'brand_not_found');
      if (!(isObj(brand.activation) && brand.activation.state === 'on')) return fail(db, op, callId, 'not_on');
      plan = { gen: brand.projection_gen || 0 };
      if (!(await renew(db, op, callId, clk, 'planned', plan))) return LOST;
    }
    if (!(await renew(db, op, callId, clk))) return LOST;
    const b = await txn(db, `brands/${brandId}`, (cur, stop) => {
      if (!isObj(cur)) return stop('brand_not_found');
      const g = cur.projection_gen || 0;
      if (g !== plan.gen) {   // only this op's own completed write is accepted; anything else changed the brand meanwhile
        return g === plan.gen + 1 && isObj(cur.activation) && cur.activation.state === 'off' && cur.activation.since === now ? undefined : stop('stale_brand');
      }
      if (!(isObj(cur.activation) && cur.activation.state === 'on')) return stop('not_on');
      const next = { ...cur, activation: { state: 'off', since: now }, projection_gen: g + 1 };
      return validateBrand(brandId, next).ok ? next : stop('brand_invalid');
    });
    if (b.stop) return fail(db, op, callId, b.stop);
    return (await finish(db, op, callId)) ? { ok: true } : LOST;
  },
};

// ── public writers (each one lifecycle op under its brand's lock) ─────────────────────────────────────────────────────────────

function draftInputs(input, opId) {
  const errors = P.draftErrors(input);
  if (errors.length) return { error: { ok: false, error: 'bad_draft', errors } };
  if (typeof opId !== 'string' || !OP_ID_RE.test(opId)) return { error: { ok: false, error: 'bad_op_id' } };
  const draft = {}; for (const k of DRAFT_KEYS) draft[k] = input[k];
  return { draft };
}
async function createDraft(db, { input, opId, callerUid, now, callId = newCallId('create'), clock }) {
  const v = draftInputs(input, opId);
  if (v.error) return v.error;
  return runOp(db, v.draft.brand_id, { kind: 'create_draft', inputs: { draft: v.draft, op_id: opId, brand_name: null, caller_uid: callerUid }, at: now }, callId, now, clock, { live: true });
}
// Sherpa admin (advisor ruling): a NEW brand is seeded TOGETHER with its first draft branch — ONE payload-bound op (the same
// mapping / name / persisted-candidate / reservation steps), then ONE create-only brand transaction {name, active, locations:
// {rid:'staged'}, activation off, projection_gen 1}, then the draft. The brand is never empty; a re-run resumes.
async function createBrandWithDraft(db, { brandId, brandName, input, opId, callerUid, now, callId = newCallId('create'), clock }) {
  if (!validBrandName(brandName)) return { ok: false, error: 'bad_brand_name' };
  const v = draftInputs({ ...(isObj(input) ? input : {}), brand_id: brandId }, opId);
  if (v.error) return v.error;
  return runOp(db, brandId, { kind: 'create_draft', inputs: { draft: v.draft, op_id: opId, brand_name: brandName, caller_uid: callerUid }, at: now }, callId, now, clock, { live: true });
}

// abandoned-draft cleanup (resumable)
async function deleteBranchDraft(db, { rid, brandId, now = Date.now(), callId = newCallId('delete'), clock, bind = false }) {
  return runOp(db, brandId, { kind: 'delete_draft', inputs: bind === true ? { rid, bind: true } : { rid }, at: now }, callId, now, clock, { live: true });
}

// Sherpa admin: materialize a draft with its location (§4)
async function materializeBranch(db, { rid, location, now, callId, clock }) {
  const brandId = await brandOfRid(db, rid);
  if (!brandId) return { ok: false, error: 'not_a_draft' };
  return runOp(db, brandId, { kind: 'materialize', inputs: { rid, location }, at: now }, callId, now, clock, { live: true });
}

// finish an interrupted op from its durable record (any later call, or the admin `resume <brand|rid>`)
async function resumeBranchOp(db, { brandId, rid, now, callId, clock }) {
  const b = brandId || (rid ? await brandOfRid(db, rid) : null);
  if (!b) return { ok: false, error: 'no_op' };
  return runOp(db, b, { kind: null, inputs: null }, callId, now, clock, { live: false });
}
// the brand whose lock record an admin `resume <id>` means: the id itself (a brand) or a rid's brand
async function opBrandOf(db, id) {
  if ((await val(db, lockPath(id))) != null) return id;
  const b = await brandOfRid(db, id);
  return b && (await val(db, lockPath(b))) != null ? b : null;
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
  if (active === true) {
    if (typeof identity.brand_id !== 'string') return { ok: false, error: 'not_a_branch' };
    return runOp(db, identity.brand_id, { kind: 'activate', inputs: { rid, expected_version: expectedVersion }, at: now }, callId, now, clock, { live: true, readers });
  }
  // deactivation: a single-node version CAS (no lifecycle lock) + consequence counts
  const plan = P.planSetActive({ identity, active, facts: {}, now, expectedVersion });
  if (!plan.ok) return { ok: false, error: plan.error };
  const w = await casIdentity(db, rid, expectedVersion, plan.patch);
  if (!w.ok) return w;
  const devices = unrevoked(await val(db, `restaurants/${rid}/handhelds`));
  const live = await liveOrders(db, rid);
  return { ok: true, state: 'inactive', consequences: { live_orders: live.length, scheduled_bound: live.filter((o) => o.status === 'scheduled').length, devices: devices.length } };
}

// ── Sherpa admin: brand activation / deactivation ────────────────────────────────────────────────────────────────────────────
// readiness for every branch being opened (an already-active one needs none); the observed identity versions are the CAS basis
async function activationReadiness(db, brandId, open, now, readers) {
  const brand = await val(db, `brands/${brandId}`);
  if (!isObj(brand)) return { ok: false, error: 'brand_not_found' };
  if (isObj(brand.activation) && brand.activation.state === 'legacy') return { ok: false, error: 'legacy_cutover_is_o3' };
  const locs = isObj(brand.locations) ? brand.locations : {};
  const bad = open.filter((rid) => locs[rid] !== 'staged' && locs[rid] !== 'member');
  if (bad.length) return { ok: false, error: 'not_staged', extra: { rids: bad } };
  const unmet = {}; const seen = {};
  for (const rid of open) {
    const identity = await val(db, `restaurants/${rid}/identity`);
    seen[rid] = isObj(identity) ? identity.version : null;
    if (isObj(identity) && identity.active === true) continue;
    const facts = await readinessFacts(db, rid, brandId, brand, unrevoked(await val(db, `restaurants/${rid}/handhelds`)), readers);
    const plan = P.planSetActive({ identity, active: true, facts: { ...facts, brandState: 'on' }, now, expectedVersion: isObj(identity) ? identity.version : undefined });
    if (!plan.ok) unmet[rid] = plan.unmet || [plan.error];
  }
  if (Object.keys(unmet).length) return { ok: false, error: 'not_ready', extra: { unmet } };
  return { ok: true, seen, gen: brand.projection_gen || 0 };
}

async function activateBrand(db, { brandId, open = [], now, readers = {}, checkOnly = false, callId = newCallId('activate'), clock }) {
  if (checkOnly) {   // the CLI's dry run: every check, no write, no lock
    const r = await activationReadiness(db, brandId, open, now, readers);
    return r.ok ? { ok: true, ready: open } : { ok: false, error: r.error, ...(r.extra || {}) };
  }
  return runOp(db, brandId, { kind: 'activate_brand', inputs: { open }, at: now }, callId, now, clock, { live: true, readers });
}

async function deactivateBrand(db, { brandId, now, callId = newCallId('deactivate'), clock }) {
  return runOp(db, brandId, { kind: 'deactivate_brand', inputs: {}, at: now }, callId, now, clock, { live: true });
}

// projection resync (advisor ruling): a version-only identity bump, so the fenced publish carries an unversioned earlier write
const bumpIdentityVersion = (db, { rid, expectedVersion }) => casIdentity(db, rid, expectedVersion, { version: expectedVersion + 1 });

module.exports = { createBrandWithDraft, liveOrders, activateBrand, deactivateBrand, bumpIdentityVersion, createDraft, deleteBranchDraft, materializeBranch, resumeBranchOp, setBranchLocation, setBranchActive, enrichLegacyIdentity, LEASE_MS, opBrandOf };
