'use strict';
// ORCHESTRATION O1b (PLAN-orch-o1b r3) — the WRITER-level cells: T6 readiness propagation through the real activate writers.
// Logical time only (the wall clock is disabled for the whole file, as in branch-store.test.js).
// Run: node branches/o1b-store.test.js
const assert = require('assert');
const S = require('./branch-store');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');   // faithful Admin-SDK transaction semantics (cached-null first pass)
const { portalReaders } = require('./readiness-readers');
const P = require('./branch-ops');

Date.now = () => { throw new Error('o1b-store.test: Date.now() read — every lifecycle call here runs on logical time'); };
for (const k of ['createDraft', 'createBrandWithDraft', 'deleteBranchDraft', 'materializeBranch', 'resumeBranchOp', 'setBranchActive', 'activateBrand', 'deactivateBrand', 'updateBranchProfile']) {
  const f = S[k];
  S[k] = (db, o = {}) => f(db, Number.isFinite(o.now) && typeof o.clock !== 'function' ? { ...o, clock: () => o.now } : o);
}

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('o1b-store: FAILED — exited without completing'); process.exitCode = 1; } });

const NOW = 1_800_000_000_000;
const DAY = { open: true, start: '11:00', end: '22:00' };
const H7 = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };
const g = { granted_at: 1, granted_by: 'x' };
// tb_brand ON; tb_sur staged (paired handheld, owner present, menu published) — its identity is the knob
const SUR = { name: 'Third', brand_id: 'tb_brand', location_name: 'Sur', phone: '+50431234567', hours: H7, prep_default_min: 20, hub_lat: 15.6, hub_lng: -88.0,
  zone: { type: 'circle', radius_km: 5 }, delivery_radius_km: 5, active: false, active_changed_at: 1, version: 2 };
const world = (sur = SUR, brandState = 'on') => fakeRtdb({
  brands: { tb_brand: { name: 'Third', active: true, locations: { tb_sur: 'staged' }, activation: { state: brandState, since: 1 }, projection_gen: 1 } },
  restaurants: { tb_sur: { identity: sur, handhelds: { h1: { kind: 'handheld', last_seen: NOW - 1000 } } } },
  brand_members: { tb_brand: { owners: { ownerTB: g } } },
  menus: { tb_brand: { published: true } },
});

(async () => {
  // ── T6: identity_gaps through the REAL setBranchActive (activate) writer ──
  {
    const db = world({ ...SUR, hub_lat: 95, prep_default_min: 2 });
    const r = await S.setBranchActive(db, { rid: 'tb_sur', active: true, expectedVersion: 2, now: NOW, readers: portalReaders(db, 'tb_brand') });
    assert.deepStrictEqual(r, { ok: false, error: 'not_ready', unmet: ['identity_invalid'], identity_gaps: ['location', 'prep'] }, 'WRITER-GAPS');
    assert.strictEqual(db.get('restaurants/tb_sur/identity/active'), false, 'nothing activated');
    const db2 = world({ ...SUR, active: 'broken' });
    assert.deepStrictEqual(await S.setBranchActive(db2, { rid: 'tb_sur', active: true, expectedVersion: 2, now: NOW, readers: portalReaders(db2, 'tb_brand') }),
      { ok: false, error: 'not_ready', unmet: ['identity_invalid'], identity_gaps: ['integrity'] }, 'WRITER-RAW-ACTIVE: a malformed active is refused, never activated');
    const db3 = world();
    assert.deepStrictEqual(await S.setBranchActive(db3, { rid: 'tb_sur', active: true, expectedVersion: 2, now: NOW, readers: portalReaders(db3, 'tb_brand') }), { ok: true, rid: 'tb_sur', state: 'active' }, 'a ready staged branch activates (team reader: the owner counts)');
    assert.strictEqual(db3.get('brands/tb_brand/locations/tb_sur'), 'member');
    ok('setBranchActive (real writer): identity_gaps propagate with unmet; a malformed active is identity_invalid + integrity; a ready branch activates with the portal team reader');
  }

  // ── T6: activateBrand reports gaps per rid; unmet holds only the six codes ──
  {
    const db = world({ ...SUR, zone: { type: 'circle', radius_km: 9 } }, 'off');
    const r = await S.activateBrand(db, { brandId: 'tb_brand', open: ['tb_sur'], now: NOW, readers: portalReaders(db, 'tb_brand') });
    assert.deepStrictEqual(r, { ok: false, error: 'not_ready', unmet: { tb_sur: ['identity_invalid'] }, identity_gaps: { tb_sur: ['zone'] } }, 'BRAND-GAPS');
    const codes = require('./branch-ops').READINESS_CODES;
    for (const u of Object.values(r.unmet)) for (const c of u) assert.ok(codes.includes(c), `UNMET-ONLY-CODES ${c}`);
    ok('activateBrand: per-rid unmet holds only the six codes, identity_gaps per rid');
  }

  // ── T3a: a retried create recognises its COMPLETED op before re-reserving the ORIGINAL name (Codex r1 #4) ──
  {
    const INPUT = { brand_id: 'tb_brand', location_name: 'Centro', phone: '+50431234567', hours: H7, prep_default_min: 20 };
    // a rename as a future slice / the CLI would leave it: the draft's name changed and its reservation MOVED (same value)
    const renameFixture = (db, rid, from, to, name) => {
      const v = db.get(`brand_branch_names/tb_brand/${from}`);
      db.root.brand_branch_names.tb_brand[to] = v; delete db.root.brand_branch_names.tb_brand[from];
      db.root.restaurants[rid].draft.location_name = name;
    };
    const db = world();
    assert.deepStrictEqual(await S.createDraft(db, { input: INPUT, opId: 'opC', callerUid: 'ownerTB', now: NOW }), { ok: true, rid: 'tb_brand_centro' });
    renameFixture(db, 'tb_brand_centro', 'centro', 'plaza', 'Plaza');
    assert.deepStrictEqual(await S.createDraft(db, { input: INPUT, opId: 'opC', callerUid: 'ownerTB', now: NOW + 1 }), { ok: true, rid: 'tb_brand_centro' }, 'REPLAY-COMPLETE the original create retried → ok, same rid');
    assert.deepStrictEqual(Object.keys(db.get('brand_branch_names/tb_brand')), ['plaza'], 'REPLAY-NO-OLD-NAME the old name is NOT re-reserved');
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid: 'tb_brand_centro', brandId: 'tb_brand', now: NOW + 2 }), { ok: true });
    assert.deepStrictEqual([db.get('brand_branch_names/tb_brand'), db.get('rid_reservations/tb_brand_centro'), db.get('branch_op_ids/tb_brand/opC')], [null, null, null], 'REPLAY-THEN-DELETE nothing of the branch remains');
    // the old name taken by ANOTHER create meanwhile → the original create's retry is still ok (never name_taken)
    const db2 = world();
    assert.deepStrictEqual(await S.createDraft(db2, { input: INPUT, opId: 'opC', callerUid: 'ownerTB', now: NOW }), { ok: true, rid: 'tb_brand_centro' });
    renameFixture(db2, 'tb_brand_centro', 'centro', 'plaza', 'Plaza');
    assert.deepStrictEqual(await S.createDraft(db2, { input: INPUT, opId: 'opD', callerUid: 'ownerTB', now: NOW + 1 }), { ok: true, rid: 'tb_brand_centro_2' }, 'another op takes the old name');
    assert.deepStrictEqual(await S.createDraft(db2, { input: INPUT, opId: 'opC', callerUid: 'ownerTB', now: NOW + 2 }), { ok: true, rid: 'tb_brand_centro' }, 'REPLAY-OLD-NAME-REUSED still ok, not name_taken');
    assert.strictEqual(db2.get('brand_branch_names/tb_brand/centro').op_id, 'opD', 'the other op keeps the name');
    // a different payload under the same op id is still op_conflict (payload-bound idempotency first)
    assert.deepStrictEqual(await S.createDraft(db2, { input: { ...INPUT, prep_default_min: 30 }, opId: 'opC', callerUid: 'ownerTB', now: NOW + 3 }), { ok: false, error: 'op_conflict' }, 'REPLAY-PAYLOAD-BOUND');
    ok('createDraft replay: a completed op (draft renamed, or the old name reused elsewhere) → ok with the same rid; the original name is never re-reserved; payload-bound conflict first');
  }

  // ── T3c + profile writer: ONE `version` token — integer for an identity, d.<op_id>.<inc>.<n> for a draft; never repeats ──
  {
    const INPUT = { brand_id: 'tb_brand', location_name: 'Centro', phone: '+50431234567', hours: H7, prep_default_min: 20 };
    const db = world();
    assert.deepStrictEqual(await S.createDraft(db, { input: INPUT, opId: 'opE', callerUid: 'ownerTB', now: NOW }), { ok: true, rid: 'tb_brand_centro' });
    const d0 = db.get('restaurants/tb_brand_centro/draft');
    const t0 = P.draftToken(d0);
    assert.strictEqual(t0, `d.opE.${d0.inc}.0`, 'TOKEN-DRAFT-SHAPE (absent version = 0)');
    // a draft edit under the brand lock: version + 1, token advances
    const e1 = await S.updateBranchProfile(db, { rid: 'tb_brand_centro', patch: { prep_default_min: 25 }, expected: t0, now: NOW + 1 });
    assert.deepStrictEqual(e1, { ok: true, lifecycle: 'draft', version: `d.opE.${d0.inc}.1` }, 'DRAFT-EDIT');
    assert.strictEqual(db.get('restaurants/tb_brand_centro/draft/prep_default_min'), 25);
    assert.deepStrictEqual(await S.updateBranchProfile(db, { rid: 'tb_brand_centro', patch: { prep_default_min: 30 }, expected: t0, now: NOW + 2 }), { ok: false, error: 'stale_branch' }, 'an old draft token is stale');
    assert.deepStrictEqual(await S.updateBranchProfile(db, { rid: 'tb_brand_centro', patch: { prep_default_min: 25 }, expected: e1.version, now: NOW + 3 }), { ok: false, error: 'noop' });
    assert.deepStrictEqual(await S.updateBranchProfile(db, { rid: 'tb_brand_centro', patch: { hub_lat: 1 }, expected: e1.version, now: NOW + 4 }), { ok: false, error: 'forbidden_field' });
    assert.deepStrictEqual(await S.updateBranchProfile(db, { rid: 'tb_brand_centro', patch: { location_name: 'Plaza' }, expected: e1.version, now: NOW + 5 }), { ok: false, error: 'rename_cli_only' }, 'WRITER-RENAME-CLI-ONLY');
    assert.deepStrictEqual(await S.updateBranchProfile(db, { rid: 'tb_brand_centro', patch: { prep_default_min: 40 }, expected: 1, now: NOW + 6 }), { ok: false, error: 'stale_branch' }, 'TOKEN-(c) an identity integer against a draft');
    // (a) Sherpa materializes the draft → the identity starts at version 1; the draft screen's token (…​.1) must NOT edit it
    db.root.platform_config = { service_bounds: { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 } };
    const m = await S.materializeBranch(db, { rid: 'tb_brand_centro', location: { hub: { lat: 15.51, lng: -88.03 }, address_line: 'Blvd 1' }, now: NOW + 7, callId: 'cm' });
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.strictEqual(db.get('restaurants/tb_brand_centro/identity/version'), 1);
    assert.strictEqual(db.get('restaurants/tb_brand_centro/identity/prep_default_min'), 25, 'materialize carried the edited draft');
    assert.ok(!('version' in (db.get('restaurants/tb_brand_centro/identity') || {})) || db.get('restaurants/tb_brand_centro/identity/version') === 1, 'the draft version never leaks into the identity version');
    assert.deepStrictEqual(await S.updateBranchProfile(db, { rid: 'tb_brand_centro', patch: { prep_default_min: 50 }, expected: e1.version, now: NOW + 8 }), { ok: false, error: 'stale_branch' }, 'TOKEN-(a) a stale DRAFT screen after materialize');
    assert.strictEqual(db.get('restaurants/tb_brand_centro/identity/prep_default_min'), 25, 'nothing written');
    // the identity path: an integer CAS
    assert.deepStrictEqual(await S.updateBranchProfile(db, { rid: 'tb_brand_centro', patch: { hours: { ...H7, mon: DAY } }, expected: 1, now: NOW + 9 }), { ok: true, lifecycle: 'identity', version: 2 }, 'IDENTITY-EDIT');
    assert.deepStrictEqual(await S.updateBranchProfile(db, { rid: 'tb_brand_centro', patch: { prep_default_min: 21 }, expected: 1, now: NOW + 10 }), { ok: false, error: 'stale_branch' });
    // (b) delete + recreate with the same name → the old screen's token is stale
    const db2 = world();
    await S.createDraft(db2, { input: INPUT, opId: 'opF', callerUid: 'ownerTB', now: NOW });
    const old = P.draftToken(db2.get('restaurants/tb_brand_centro/draft'));
    assert.deepStrictEqual(await S.deleteBranchDraft(db2, { rid: 'tb_brand_centro', brandId: 'tb_brand', now: NOW + 1, bind: true }), { ok: true });
    await S.createDraft(db2, { input: INPUT, opId: 'opG', callerUid: 'ownerTB', now: NOW + 2 });
    assert.strictEqual(db2.get('restaurants/tb_brand_centro/draft/op_id'), 'opG', 'the SAME rid was re-allocated');
    assert.deepStrictEqual(await S.updateBranchProfile(db2, { rid: 'tb_brand_centro', patch: { prep_default_min: 33 }, expected: old, now: NOW + 3 }), { ok: false, error: 'stale_branch' }, 'TOKEN-(b) a stale screen after delete + recreate');
    // a draft whose mapping points away is not editable (re-bound under the lock)
    db2.root.branch_op_ids.tb_brand.opG.rid = 'tb_elsewhere';
    assert.deepStrictEqual(await S.updateBranchProfile(db2, { rid: 'tb_brand_centro', patch: { prep_default_min: 33 }, expected: P.draftToken(db2.get('restaurants/tb_brand_centro/draft')), now: NOW + 4 }), { ok: false, error: 'not_a_draft' }, 'DRAFT-EDIT-REBIND');
    assert.deepStrictEqual(await S.updateBranchProfile(db2, { rid: 'tb_brand_centro', patch: { prep_default_min: 33 }, expected: true, now: NOW + 5 }), { ok: false, error: 'bad_version' });
    ok('updateBranchProfile: identity = integer version CAS; draft = d.<op>.<inc>.<n> under the lock (re-bound); stale after materialize / delete+recreate / wrong lifecycle; rename_cli_only; forbidden_field; noop');
  }

  FINISHED = true;
  console.log(`\no1b-store: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
