'use strict';
// ORCHESTRATION O1a — Codex r1 on 203076e0 (4 × P2 in the lifecycle writers): each finding as a DETERMINISTIC interleaving of the
// REAL branch-store writers (test/_gated-db.js pauses one named ref call). Shared by branches/branch-races.test.js (in-memory
// fake) and test/branch-races.emulator.test.js (REAL RTDB) — same scenario, same assertion markers. Every scenario uses its own
// brand ids, so one emulator database serves them all.
//   F1  an expired worker must not erase / overwrite a NEWER op's recovery record (fenced renew / checkpoint / fail / cleanup)
//   F2  draft deletion is serialized with materialization; a brand is removed only with NO other draft and NO materialized branch
//   F3  a global rid reservation is owned by (brand_id, op_id), never op_id alone
//   F4  activateBrand activates only by CAS on the identity version it observed
const assert = require('assert');
const S = require('../branches/branch-store');
const { gated } = require('./_gated-db');

const DAY = { open: true, start: '11:00', end: '22:00' };
const H7 = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };
const BOUNDS = { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 };
const LOC = { hub: { lat: 15.51, lng: -88.03 }, address_line: 'Blvd 1' };
const NOW = 1_800_000_000_000;
const input = (brandId, name) => ({ brand_id: brandId, location_name: name, phone: '+50499990000', hours: H7, prep_default_min: 20 });
const team = { teamCount: async () => 1 };

const SCENARIOS = [
  ['F1: a worker whose lease expired cannot overwrite or remove a NEWER op\'s recovery record', async (db) => {
    const read = async (p) => (await db.ref(p).once('value')).val();
    await db.ref('platform_config/service_bounds').set(BOUNDS);
    const { rid } = await S.createBrandWithDraft(db, { brandId: 'rc_one', brandName: 'Uno', input: input('rc_one', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    const g = gated(db);
    const atBrandA = g.pause('transaction', 'brands/rc_one');
    const A = S.materializeBranch(g.db, { rid, location: LOC, now: NOW, callId: 'cA' });   // stalls after its identity step…
    await atBrandA.reached;
    const B = await S.resumeBranchOp(db, { rid, now: NOW + S.LEASE_MS + 1000, callId: 'cB' });   // …past its lease: B takes over
    assert.deepStrictEqual(B, { ok: true, rid, state: 'staged' }, 'RACE-F1 premise: the resumer completes the materialization');
    await db.ref('brands/rc_one/activation').set({ state: 'on', since: 1 });
    await db.ref(`restaurants/${rid}/handhelds/h1`).set({ revoked: false, last_seen: 5 });
    await db.ref('menus/rc_one').set({ v: 1 });
    const atBrandC = g.pause('transaction', 'brands/rc_one');
    S.setBranchActive(g.db, { rid, active: true, expectedVersion: 1, now: NOW + S.LEASE_MS + 2000, callId: 'cC', readers: team });   // C persists its op, then "crashes"
    await atBrandC.reached;
    const recC = await read(`branch_ops/${rid}`);
    assert.deepStrictEqual([recC && recC.kind, recC && recC.op_id], ['activate', 'cC'], 'RACE-F1 premise: activation C holds the op record');
    atBrandA.release();
    const a = await A;
    const rec = await read(`branch_ops/${rid}`);
    assert.ok(rec != null, 'RACE-F1-FENCE the stale worker removed the newer op\'s recovery record');
    assert.deepStrictEqual([rec.kind, rec.op_id, rec.lease && rec.lease.call_id, rec.step], ['activate', 'cC', 'cC', 'start'], 'RACE-F1-FENCE the newer op\'s record is untouched (no stale checkpoint)');
    assert.deepStrictEqual(a, { ok: false, error: 'lease_lost' }, 'RACE-F1-FENCE the stale worker reports lease_lost');
  }],

  ['F2: delete racing materialize never orphans a materialized branch', async (db) => {
    const read = async (p) => (await db.ref(p).once('value')).val();
    await db.ref('platform_config/service_bounds').set(BOUNDS);
    const { rid } = await S.createBrandWithDraft(db, { brandId: 'rc_two', brandName: 'Dos', input: input('rc_two', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    const g = gated(db);
    const atRes = g.pause('once', `rid_reservations/${rid}`);
    const D = S.deleteBranchDraft(g.db, { rid, brandId: 'rc_two', now: NOW, callId: 'cD' });   // read the draft (and no op), then…
    await atRes.reached;
    const m = await S.materializeBranch(db, { rid, location: LOC, now: NOW, callId: 'cM' });   // …materialization runs in between
    atRes.release();
    const d = await D;
    assert.ok(!(m.ok && d.ok), `RACE-F2-SERIAL delete and materialize both succeeded (${JSON.stringify([m, d])})`);
    const [identity, brand, res] = [await read(`restaurants/${rid}/identity`), await read('brands/rc_two'), await read(`rid_reservations/${rid}`)];
    if (identity != null) {
      assert.ok(brand && brand.locations && ['staged', 'member'].includes(brand.locations[rid]), 'RACE-F2-SERIAL a materialized branch lost its brand');
      assert.ok(res != null, 'RACE-F2-SERIAL a materialized branch lost its rid reservation');
    } else {
      assert.strictEqual(await read(`restaurants/${rid}/draft`), null, 'RACE-F2-SERIAL neither materialized nor deleted');
    }
    assert.strictEqual(await read(`branch_ops/${rid}`), null, 'RACE-F2-SERIAL no op record left behind');
  }],

  ['F2: deleting the first draft keeps the brand while another draft exists; the last delete removes it; the brand id is reusable', async (db) => {
    const read = async (p) => (await db.ref(p).once('value')).val();
    const r1 = await S.createBrandWithDraft(db, { brandId: 'rc_three', brandName: 'Tres', input: input('rc_three', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    const r2 = await S.createDraft(db, { input: input('rc_three', 'Norte'), opId: 'o2', callerUid: 'own', now: NOW });
    assert.ok(r1.ok && r2.ok && r1.rid !== r2.rid, 'RACE-F2-SIBLING premise: two drafts');
    const d1 = await S.deleteBranchDraft(db, { rid: r1.rid, brandId: 'rc_three', now: NOW });
    assert.ok(await read('brands/rc_three') != null, 'RACE-F2-SIBLING the brand was removed while a sibling draft exists');
    assert.ok(await read(`restaurants/${r2.rid}/draft`) != null, 'RACE-F2-SIBLING the sibling draft survives');
    assert.deepStrictEqual(d1, { ok: false, error: 'brand_has_drafts' }, 'RACE-F2-SIBLING the first (listed) draft is not abandoned while a sibling exists');
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid: r2.rid, brandId: 'rc_three', now: NOW }), { ok: true }, 'RACE-F2-SIBLING the sibling deletes');
    assert.ok(await read('brands/rc_three') != null, 'RACE-F2-SIBLING deleting the unlisted sibling keeps the brand');
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid: r1.rid, brandId: 'rc_three', now: NOW }), { ok: true }, 'RACE-F2-SIBLING then the first draft deletes');
    assert.deepStrictEqual([await read('brands/rc_three'), await read(`restaurants/${r1.rid}/draft`), await read(`rid_reservations/${r1.rid}`)], [null, null, null], 'RACE-F2-SIBLING the never-opened brand is removed whole');
    assert.strictEqual(await read(`branch_ops/${r1.rid}`), null, 'RACE-F2-SIBLING no op record left behind');
    const again = await S.createBrandWithDraft(db, { brandId: 'rc_three', brandName: 'Tres', input: input('rc_three', 'Centro'), opId: 'o3', callerUid: 'own', now: NOW + 1 });
    assert.deepStrictEqual(again, { ok: true, rid: r1.rid }, 'RACE-F2-SIBLING a removed brand id can be created again');
  }],

  ['F2: a sibling draft created concurrently with the brand-removing delete never lands on a removed brand', async (db) => {
    const read = async (p) => (await db.ref(p).once('value')).val();
    const r1 = await S.createBrandWithDraft(db, { brandId: 'rc_four', brandName: 'Cuatro', input: input('rc_four', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    const g = gated(db);
    const atMap = g.pause('transaction', (p) => p.startsWith('branch_op_ids/rc_four'));
    const Sib = S.createDraft(g.db, { input: input('rc_four', 'Norte'), opId: 'o2', callerUid: 'own', now: NOW });   // saw the brand, then…
    await atMap.reached;
    const d = await S.deleteBranchDraft(db, { rid: r1.rid, brandId: 'rc_four', now: NOW });   // …the first draft's delete runs
    atMap.release();
    const s = await Sib;
    const brand = await read('brands/rc_four');
    if (s.ok) {
      assert.ok(brand != null, `RACE-F2-CLOSE a sibling draft was created on a removed brand (${JSON.stringify([d, s])})`);
    } else {
      assert.deepStrictEqual(s, { ok: false, error: 'brand_closed' }, 'RACE-F2-CLOSE the late sibling is refused');
      assert.deepStrictEqual(await read('branch_op_ids/rc_four/o2'), null, 'RACE-F2-CLOSE the refused sibling holds no mapping');
    }
  }],

  ['F3: two brands with the same long prefix and the same op id never share a rid', async (db) => {
    const read = async (p) => (await db.ref(p).once('value')).val();
    const A = 'abcdefghijklmnopqrst_a'; const B = 'abcdefghijklmnopqrst_b';
    for (const b of [A, B]) await db.ref(`brands/${b}`).set({ name: b, active: true, locations: { [`${b}_x`]: 'member' }, activation: { state: 'off', since: 1 } });
    const ra = await S.createDraft(db, { input: input(A, 'Centro'), opId: 'same_op', callerUid: 'own', now: NOW });
    const rb = await S.createDraft(db, { input: input(B, 'Centro'), opId: 'same_op', callerUid: 'own', now: NOW });
    assert.ok(ra.ok && rb.ok, `RACE-F3-OWNER premise: both drafts created (${JSON.stringify([ra, rb])})`);
    assert.notStrictEqual(rb.rid, ra.rid, 'RACE-F3-OWNER brand B was handed brand A\'s rid');
    assert.deepStrictEqual([(await read(`restaurants/${ra.rid}/draft`)).brand_id, (await read(`restaurants/${rb.rid}/draft`)).brand_id], [A, B], 'RACE-F3-OWNER each draft belongs to its own brand');
    assert.deepStrictEqual([await read(`rid_reservations/${ra.rid}`), await read(`rid_reservations/${rb.rid}`)], [{ op_id: 'same_op', brand_id: A }, { op_id: 'same_op', brand_id: B }], 'RACE-F3-OWNER each reservation names its brand');
    assert.deepStrictEqual(await S.createDraft(db, { input: input(B, 'Centro'), opId: 'same_op', callerUid: 'own', now: NOW + 1 }), rb, 'RACE-F3-OWNER the idempotent retry returns B\'s own rid');
  }],

  ['F4: a stale activateBrand never re-activates a branch deactivated concurrently', async (db) => {
    const read = async (p) => (await db.ref(p).once('value')).val();
    const rid = 'rc_five_centro';
    await db.ref('brands/rc_five').set({ name: 'Cinco', active: true, locations: { [rid]: 'member' }, activation: { state: 'on', since: 1 }, projection_gen: 1 });
    await db.ref(`restaurants/${rid}/identity`).set({ name: 'Cinco', brand_id: 'rc_five', location_name: 'Centro', phone: '+50499990000', hours: H7, prep_default_min: 20, hub_lat: 15.6,
      hub_lng: -88.0, address_line: 'Calle 1', zone: { type: 'circle', radius_km: 5 }, delivery_radius_km: 5, whatsapp_instance: '', whatsapp_enabled: false, active: true, active_changed_at: 1, version: 1 });
    const g = gated(db);
    const atBrand = g.pause('transaction', 'brands/rc_five');
    const A = S.activateBrand(g.db, { brandId: 'rc_five', open: [rid], now: NOW, readers: team });   // observed v1 active, then…
    await atBrand.reached;
    const off = await S.setBranchActive(db, { rid, active: false, expectedVersion: 1, now: NOW + 5, callId: 'cOff' });   // …deactivated at v2
    assert.strictEqual(off.ok, true, 'RACE-F4 premise: the concurrent deactivation commits');
    atBrand.release();
    const a = await A;
    const id = await read(`restaurants/${rid}/identity`);
    assert.deepStrictEqual([id.active, id.version, id.active_changed_at], [false, 2, NOW + 5], 'RACE-F4-CAS the stale activation re-activated the branch');
    assert.deepStrictEqual(a, { ok: false, error: 'stale_branch', rid }, 'RACE-F4-CAS the stale activation reports stale_branch');
  }],
];

module.exports = { SCENARIOS };
