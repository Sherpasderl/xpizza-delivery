'use strict';
// ORCHESTRATION O1a — Codex r1 (203076e0) and r2 (b88978cb) on the lifecycle writers: each finding as a DETERMINISTIC interleaving
// of the REAL branch-store writers (test/_gated-db.js pauses one named ref call). Shared by branches/branch-races.test.js (in-memory
// fake) and test/branch-races.emulator.test.js (REAL RTDB) through runScenarios — same scenarios, same assertion markers, same
// deadlines. Every scenario uses its own brand ids, so one emulator database serves them all.
//   r1 F1  an expired worker must not erase / overwrite a NEWER op's recovery record
//   r1 F2  draft deletion is serialized with materialization; a brand is removed only with no other draft / materialized branch
//   r1 F3  a global rid reservation is owned by (brand_id, op_id), never op_id alone
//   r1 F4  activateBrand activates only by CAS on the identity version it observed
//   r2 1   a materialize that acquires AFTER a completed delete never creates an identity
//   r2 2   an expired delete worker never erases a RECREATED draft / reservation
//   r2 2b  …and one already past its draft step never removes the recreated incarnation's reservation / name / mapping
//   r2 3   a brand removal that cannot complete leaves a usable brand (nothing listed without a draft / identity; drafts creatable)
//   r2 3b  …a brand changed by any other writer during its removal is kept and nothing is deleted
//   r2 4   a delayed creator never re-opens a brand another op is removing (no sibling draft on a removed brand)
// The lock record lives at brand_ops/{brand} (r2: one lifecycle lock per brand); lockRec() also reads the r1 per-rid
// branch_ops/{rid}, so every scenario runs unchanged against the pre-fix writer (the RED proof).
const assert = require('assert');
const S = require('../branches/branch-store');
const { gated } = require('./_gated-db');
const { checkBrand } = require('../branches/branch-check');

const DAY = { open: true, start: '11:00', end: '22:00' };
const H7 = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };
const BOUNDS = { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 };
const LOC = { hub: { lat: 15.51, lng: -88.03 }, address_line: 'Blvd 1' };
const NOW = 1_800_000_000_000;
const LATER = NOW + S.LEASE_MS + 1000;   // past any lease taken at NOW
const input = (brandId, name) => ({ brand_id: brandId, location_name: name, phone: '+50499990000', hours: H7, prep_default_min: 20 });
const team = { teamCount: async () => 1 };
const reader = (db) => async (p) => (await db.ref(p).once('value')).val();
const lockRec = async (read, brandId, rid) => (await read(`brand_ops/${brandId}`)) || (rid ? await read(`branch_ops/${rid}`) : null);
const lockTxn = (brandId, rid) => (m, p) => m === 'transaction' && (p === `brand_ops/${brandId}` || p === `branch_ops/${rid}`);
// every rid a brand lists has a draft or an identity behind it
async function listedAreBacked(read, brandId) {
  const b = await read(`brands/${brandId}`);
  const bad = [];
  for (const rid of Object.keys((b && b.locations) || {})) if ((await read(`restaurants/${rid}/draft`)) == null && (await read(`restaurants/${rid}/identity`)) == null) bad.push(rid);
  return bad;
}

const SCENARIOS = [
  ['r1 F1: a worker whose lease expired cannot overwrite or remove a NEWER op\'s recovery record', async (db) => {
    const read = reader(db);
    await db.ref('platform_config/service_bounds').set(BOUNDS);
    const { rid } = await S.createBrandWithDraft(db, { brandId: 'rc_one', brandName: 'Uno', input: input('rc_one', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    const g = gated(db);
    const atBrandA = g.pause('transaction', 'brands/rc_one');
    const A = S.materializeBranch(g.db, { rid, location: LOC, now: NOW, callId: 'cA' });   // stalls after its identity step…
    await atBrandA.reached;
    const B = await S.resumeBranchOp(db, { rid, brandId: 'rc_one', now: LATER, callId: 'cB' });   // …past its lease: B takes over
    assert.deepStrictEqual(B, { ok: true, rid, state: 'staged' }, 'RACE-F1 premise: the resumer completes the materialization');
    await db.ref('brands/rc_one/activation').set({ state: 'on', since: 1 });
    await db.ref(`restaurants/${rid}/handhelds/h1`).set({ revoked: false, last_seen: 5 });
    await db.ref('menus/rc_one').set({ v: 1 });
    const atBrandC = g.pause('transaction', 'brands/rc_one');
    S.setBranchActive(g.db, { rid, active: true, expectedVersion: 1, now: LATER + 1000, callId: 'cC', readers: team });   // C holds the op, then "crashes"
    await atBrandC.reached;
    const recC = await lockRec(read, 'rc_one', rid);
    assert.deepStrictEqual([recC && recC.kind, recC && recC.op_id], ['activate', 'cC'], 'RACE-F1 premise: activation C holds the op record');
    atBrandA.release();
    const a = await A;
    const rec = await lockRec(read, 'rc_one', rid);
    assert.ok(rec != null, 'RACE-F1-FENCE the stale worker removed the newer op\'s recovery record');
    assert.deepStrictEqual(rec, recC, 'RACE-F1-FENCE the newer op\'s record is untouched (no stale checkpoint)');
    assert.deepStrictEqual(a, { ok: false, error: 'lease_lost' }, 'RACE-F1-FENCE the stale worker reports lease_lost');
  }],

  ['r1 F2: delete racing materialize never orphans a materialized branch', async (db) => {
    const read = reader(db);
    await db.ref('platform_config/service_bounds').set(BOUNDS);
    const { rid } = await S.createBrandWithDraft(db, { brandId: 'rc_two', brandName: 'Dos', input: input('rc_two', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    const g = gated(db);
    const atRes = g.pause('once', `rid_reservations/${rid}`);
    const D = S.deleteBranchDraft(g.db, { rid, brandId: 'rc_two', now: NOW, callId: 'cD' });   // read the draft, then…
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
    assert.strictEqual(await lockRec(read, 'rc_two', rid), null, 'RACE-F2-SERIAL no op record left behind');
  }],

  ['r1 F2: deleting the first draft keeps the brand while another draft exists; the last delete removes it; the brand id is reusable', async (db) => {
    const read = reader(db);
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
    assert.strictEqual(await lockRec(read, 'rc_three', r1.rid), null, 'RACE-F2-SIBLING no op record left behind');
    const again = await S.createBrandWithDraft(db, { brandId: 'rc_three', brandName: 'Tres', input: input('rc_three', 'Centro'), opId: 'o3', callerUid: 'own', now: NOW + 1 });
    assert.deepStrictEqual(again, { ok: true, rid: r1.rid }, 'RACE-F2-SIBLING a removed brand id can be created again');
  }],

  ['r1 F2: a sibling draft created concurrently with the brand-removing delete never lands on a removed brand', async (db) => {
    const read = reader(db);
    const r1 = await S.createBrandWithDraft(db, { brandId: 'rc_four', brandName: 'Cuatro', input: input('rc_four', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    const g = gated(db);
    const atMap = g.pause('transaction', (p) => p === 'brand_ops/rc_four' || p.startsWith('branch_op_ids/rc_four'));
    const Sib = S.createDraft(g.db, { input: input('rc_four', 'Norte'), opId: 'o2', callerUid: 'own', now: NOW });   // in flight, then…
    await atMap.reached;
    const d = await S.deleteBranchDraft(db, { rid: r1.rid, brandId: 'rc_four', now: NOW });   // …the first draft's delete runs
    atMap.release();
    const s = await Sib;
    const brand = await read('brands/rc_four');
    if (s.ok) {
      assert.ok(brand != null, `RACE-F2-CLOSE a sibling draft was created on a removed brand (${JSON.stringify([d, s])})`);
    } else {
      assert.strictEqual(brand, null, `RACE-F2-CLOSE premise: the late sibling was refused because the brand is gone (${JSON.stringify([d, s])})`);
      assert.deepStrictEqual(await read('branch_op_ids/rc_four/o2'), null, 'RACE-F2-CLOSE the refused sibling holds no mapping');
      assert.deepStrictEqual(await read('restaurants/rc_four_norte/draft'), null, 'RACE-F2-CLOSE the refused sibling wrote no draft');
    }
  }],

  ['r1 F3: two brands with the same long prefix and the same op id never share a rid', async (db) => {
    const read = reader(db);
    const A = 'abcdefghijklmnopqrst_a'; const B = 'abcdefghijklmnopqrst_b';
    for (const b of [A, B]) await db.ref(`brands/${b}`).set({ name: b, active: true, locations: { [`${b}_x`]: 'member' }, activation: { state: 'off', since: 1 } });
    const ra = await S.createDraft(db, { input: input(A, 'Centro'), opId: 'same_op', callerUid: 'own', now: NOW });
    const rb = await S.createDraft(db, { input: input(B, 'Centro'), opId: 'same_op', callerUid: 'own', now: NOW });
    assert.ok(ra.ok && rb.ok, `RACE-F3-OWNER premise: both drafts created (${JSON.stringify([ra, rb])})`);
    assert.notStrictEqual(rb.rid, ra.rid, 'RACE-F3-OWNER brand B was handed brand A\'s rid');
    assert.deepStrictEqual([(await read(`restaurants/${ra.rid}/draft`)).brand_id, (await read(`restaurants/${rb.rid}/draft`)).brand_id], [A, B], 'RACE-F3-OWNER each draft belongs to its own brand');
    const [resA, resB] = [await read(`rid_reservations/${ra.rid}`), await read(`rid_reservations/${rb.rid}`)];
    assert.deepStrictEqual([resA.op_id, resA.brand_id, resB.op_id, resB.brand_id], ['same_op', A, 'same_op', B], 'RACE-F3-OWNER each reservation names its brand');
    assert.deepStrictEqual(await S.createDraft(db, { input: input(B, 'Centro'), opId: 'same_op', callerUid: 'own', now: NOW + 1 }), rb, 'RACE-F3-OWNER the idempotent retry returns B\'s own rid');
  }],

  ['r1 F4: a stale activateBrand never re-activates a branch deactivated concurrently', async (db) => {
    const read = reader(db);
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

  ['r2 1: a materialize that acquires after a completed delete never creates an identity', async (db) => {
    const read = reader(db);
    await db.ref('platform_config/service_bounds').set(BOUNDS);
    const { rid } = await S.createBrandWithDraft(db, { brandId: 'rc_six', brandName: 'Seis', input: input('rc_six', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    const g = gated(db);
    const atLock = g.pause(lockTxn('rc_six', rid), () => true);
    const M = S.materializeBranch(g.db, { rid, location: LOC, now: NOW, callId: 'cM' });   // paused right before taking its op…
    await atLock.reached;
    const d = await S.deleteBranchDraft(db, { rid, brandId: 'rc_six', now: NOW, callId: 'cD' });   // …the delete completes
    assert.deepStrictEqual(d, { ok: true }, 'RACE-R2-1 premise: the delete completes');
    atLock.release();
    const m = await M;
    assert.strictEqual(await read(`restaurants/${rid}/identity`), null, `RACE-R2-1 materialize created an identity after its draft was deleted (${JSON.stringify(m)})`);
    assert.strictEqual(m.ok, false, 'RACE-R2-1 materialize of a deleted draft is refused');
    assert.strictEqual(await lockRec(read, 'rc_six', rid), null, 'RACE-R2-1 no stranded op record');
  }],

  ['r2 2: an expired delete worker never erases a RECREATED draft or reservation', async (db) => {
    const read = reader(db);
    const { rid } = await S.createBrandWithDraft(db, { brandId: 'rc_seven', brandName: 'Siete', input: input('rc_seven', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    const g = gated(db);
    // the delete's FIRST destructive write: r1's root multi-path update, or r2's draft transaction on restaurants/{rid}
    const atWrite = g.pause((m, p) => (m === 'update' && p === '') || (m === 'transaction' && p === `restaurants/${rid}`), () => true);
    const A = S.deleteBranchDraft(g.db, { rid, brandId: 'rc_seven', now: NOW, callId: 'cA' });
    await atWrite.reached;
    const b = await S.resumeBranchOp(db, { rid, brandId: 'rc_seven', now: LATER, callId: 'cB' });   // A's lease expired: B finishes the delete
    assert.strictEqual(b.ok, true, `RACE-R2-2 premise: the resumer completes the delete (${JSON.stringify(b)})`);
    const c = await S.createBrandWithDraft(db, { brandId: 'rc_seven', brandName: 'Siete', input: input('rc_seven', 'Centro'), opId: 'o9', callerUid: 'own', now: LATER + 5 });
    assert.deepStrictEqual(c, { ok: true, rid }, 'RACE-R2-2 premise: the brand is recreated, reusing the freed rid');
    const before = { draft: await read(`restaurants/${rid}/draft`), res: await read(`rid_reservations/${rid}`), map: await read('branch_op_ids/rc_seven/o9'), brand: await read('brands/rc_seven') };
    atWrite.release();
    await A;
    const after = { draft: await read(`restaurants/${rid}/draft`), res: await read(`rid_reservations/${rid}`), map: await read('branch_op_ids/rc_seven/o9'), brand: await read('brands/rc_seven') };
    assert.deepStrictEqual(after, before, 'RACE-R2-2 the expired delete erased the recreated draft / reservation / mapping / brand');
  }],

  ['r2 2b: an expired delete worker past its draft step never removes the RECREATED reservation', async (db) => {
    const read = reader(db);
    await db.ref('brands/rc_seven_b').set({ name: 'SieteB', active: true, locations: { rc_seven_b_x: 'member' }, activation: { state: 'on', since: 1 } });
    const r1 = await S.createDraft(db, { input: input('rc_seven_b', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    const g = gated(db);
    const atRes = g.pause('transaction', `rid_reservations/${r1.rid}`);
    const A = S.deleteBranchDraft(g.db, { rid: r1.rid, brandId: 'rc_seven_b', now: NOW, callId: 'cA' });   // past its draft step, about to free the rid…
    await atRes.reached;
    const b = await S.resumeBranchOp(db, { brandId: 'rc_seven_b', now: LATER, callId: 'cB' });   // …its lease expired: B finishes the delete
    assert.strictEqual(b.ok, true, `RACE-R2-2B premise: the resumer completes the delete (${JSON.stringify(b)})`);
    const c = await S.createDraft(db, { input: input('rc_seven_b', 'Centro'), opId: 'o1', callerUid: 'own', now: LATER + 5 });   // the SAME op id recreates it
    assert.deepStrictEqual(c, { ok: true, rid: r1.rid }, 'RACE-R2-2B premise: recreated on the freed rid with the same op id');
    const before = { res: await read(`rid_reservations/${r1.rid}`), name: await read('brand_branch_names/rc_seven_b'), map: await read('branch_op_ids/rc_seven_b/o1') };
    atRes.release();
    await A;
    const after = { res: await read(`rid_reservations/${r1.rid}`), name: await read('brand_branch_names/rc_seven_b'), map: await read('branch_op_ids/rc_seven_b/o1') };
    assert.deepStrictEqual(after, before, 'RACE-R2-2B the expired delete removed the recreated incarnation\'s reservation / name / mapping');
  }],

  ['r2 3: a brand removal that cannot complete leaves a usable brand', async (db) => {
    const read = reader(db);
    const { rid } = await S.createBrandWithDraft(db, { brandId: 'rc_eight', brandName: 'Ocho', input: input('rc_eight', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    const g = gated(db);
    const atBrand = g.pause('transaction', 'brands/rc_eight');
    const D = S.deleteBranchDraft(g.db, { rid, brandId: 'rc_eight', now: NOW, callId: 'cD' });   // about to remove the brand…
    await atBrand.reached;
    await S.activateBrand(db, { brandId: 'rc_eight', open: [], now: NOW + 1, readers: team });   // …while the brand is switched on
    atBrand.release();
    await D;
    await S.resumeBranchOp(db, { rid, brandId: 'rc_eight', now: LATER, callId: 'cR' });
    if (await read('brands/rc_eight') != null) {
      assert.deepStrictEqual(await listedAreBacked(read, 'rc_eight'), [], 'RACE-R2-3-USABLE the live brand lists a branch with neither draft nor identity');
      const sib = await S.createDraft(db, { input: input('rc_eight', 'Norte'), opId: 'o2', callerUid: 'own', now: LATER + 5 });
      assert.strictEqual(sib.ok, true, `RACE-R2-3-USABLE the live brand refuses new drafts (${JSON.stringify(sib)})`);
    } else {
      const again = await S.createBrandWithDraft(db, { brandId: 'rc_eight', brandName: 'Ocho', input: input('rc_eight', 'Centro'), opId: 'o3', callerUid: 'own', now: LATER + 5 });
      assert.strictEqual(again.ok, true, `RACE-R2-3-USABLE a removed brand id cannot be created again (${JSON.stringify(again)})`);
    }
  }],

  ['r2 3b: a brand changed by ANY other writer during its removal is kept, and nothing is deleted', async (db) => {
    const read = reader(db);
    const { rid } = await S.createBrandWithDraft(db, { brandId: 'rc_eight_b', brandName: 'OchoB', input: input('rc_eight_b', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    const g = gated(db);
    const atBrand = g.pause('transaction', 'brands/rc_eight_b');
    const D = S.deleteBranchDraft(g.db, { rid, brandId: 'rc_eight_b', now: NOW, callId: 'cD' });   // planned the removal, then…
    await atBrand.reached;
    await db.ref('brands/rc_eight_b/name').set('Ocho Renombrada');   // …a writer outside the lifecycle lock changes the brand
    atBrand.release();
    const d = await D;
    assert.deepStrictEqual(d, { ok: false, error: 'brand_changed' }, 'RACE-R2-3B the delete removed a brand that changed since it observed it');
    assert.deepStrictEqual([(await read('brands/rc_eight_b')).name, (await read(`restaurants/${rid}/draft`)) != null], ['Ocho Renombrada', true], 'RACE-R2-3B the brand and its draft are both kept');
    assert.deepStrictEqual(await listedAreBacked(read, 'rc_eight_b'), [], 'RACE-R2-3B nothing listed without a draft');
    assert.strictEqual(await lockRec(read, 'rc_eight_b', rid), null, 'RACE-R2-3B the refusal released the lock');
  }],

  ['r2 4: a delayed creator never re-opens a brand another op is removing', async (db) => {
    const read = reader(db);
    const g = gated(db);
    const atA = g.pause((m, p) => m === 'transaction' && (p === 'brand_ops/rc_nine' || p === 'branch_op_ids/rc_nine'), () => true);
    const A = S.createBrandWithDraft(g.db, { brandId: 'rc_nine', brandName: 'Nueve', input: input('rc_nine', 'Norte'), opId: 'a1', callerUid: 'own', now: NOW });   // saw no brand, then…
    await atA.reached;
    const s = await S.createBrandWithDraft(db, { brandId: 'rc_nine', brandName: 'Nueve', input: input('rc_nine', 'Centro'), opId: 's1', callerUid: 'own', now: NOW + 1 });   // …another creator seeds it
    assert.strictEqual(s.ok, true, 'RACE-R2-4 premise: the brand is seeded');
    const atBrand = g.pause('transaction', 'brands/rc_nine');
    const D = S.deleteBranchDraft(g.db, { rid: s.rid, brandId: 'rc_nine', now: NOW + 2, callId: 'cD' });   // its delete is about to remove the brand
    await atBrand.reached;
    atA.release();
    await A;
    const sib = await S.createDraft(db, { input: input('rc_nine', 'Sur'), opId: 'x1', callerUid: 'own', now: NOW + 3 });
    atBrand.release();
    await D;
    if (sib.ok) {
      assert.ok(await read('brands/rc_nine') != null, `RACE-R2-4 a sibling draft was created on a brand that was then removed (${JSON.stringify(sib)})`);
    } else {
      assert.strictEqual(await read(`restaurants/rc_nine_sur/draft`), null, 'RACE-R2-4 a refused sibling wrote no draft');
    }
    for (const r of Object.keys((await read('rid_reservations')) || {}).filter((k) => k.startsWith('rc_nine'))) {
      assert.ok(await read(`restaurants/${r}/draft`) != null || await read(`restaurants/${r}/identity`) != null || await read('brands/rc_nine') != null,
        `RACE-R2-4 a reservation ${r} outlives its brand and draft`);
    }
  }],

  ['r3 1a: an expired creator\'s late rollback never removes a completed branch\'s allocation', async (db) => {
    const read = reader(db);
    await db.ref('platform_config/service_bounds').set(BOUNDS);
    const g = gated(db);
    const atBrand = g.pause('transaction', 'brands/rc_ten');
    const A = S.createBrandWithDraft(g.db, { brandId: 'rc_ten', brandName: 'Diez', input: input('rc_ten', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW, callId: 'cA' });   // reserved, then stalls…
    await atBrand.reached;
    const b = await S.resumeBranchOp(db, { brandId: 'rc_ten', now: LATER, callId: 'cB' });   // …past its lease: B completes the creation
    assert.strictEqual(b.ok, true, `RACE-R3-1A premise: the resumer completes the creation (${JSON.stringify(b)})`);
    const m = await S.materializeBranch(db, { rid: b.rid, location: LOC, now: LATER + 1, callId: 'cM' });
    await db.ref(`restaurants/${b.rid}/handhelds/h1`).set({ revoked: false, last_seen: 5 });
    await db.ref('menus/rc_ten').set({ v: 1 });
    const act = await S.activateBrand(db, { brandId: 'rc_ten', open: [b.rid], now: LATER + 2, readers: team });
    assert.ok(m.ok && act.ok, `RACE-R3-1A premise: materialized and activated (${JSON.stringify([m, act])})`);
    const before = { res: await read(`rid_reservations/${b.rid}`), names: await read('brand_branch_names/rc_ten'), map: await read('branch_op_ids/rc_ten/o1') };
    atBrand.release();
    const a = await A;
    const after = { res: await read(`rid_reservations/${b.rid}`), names: await read('brand_branch_names/rc_ten'), map: await read('branch_op_ids/rc_ten/o1') };
    assert.deepStrictEqual(after, before, 'RACE-R3-1A the expired creator\'s rollback removed the live branch\'s reservation / name / mapping');
    assert.strictEqual(a.ok, false, 'RACE-R3-1A the expired creator does not succeed');
    assert.deepStrictEqual((await checkBrand(db, 'rc_ten', { now: LATER + 3 })).findings, [], 'RACE-R3-1A the brand is consistent');
  }],

  ['r3 1b: an expired creator never resurrects a draft a later delete removed', async (db) => {
    const read = reader(db);
    const rid = 'rc_eleven_centro';
    const g = gated(db);
    const atRead = g.pause('once', `restaurants/${rid}/identity`, { nth: 2 });   // the read right before the draft write (the 1st is the allocation check)
    const A = S.createBrandWithDraft(g.db, { brandId: 'rc_eleven', brandName: 'Once', input: input('rc_eleven', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW, callId: 'cA' });
    await atRead.reached;
    const b = await S.resumeBranchOp(db, { brandId: 'rc_eleven', now: LATER, callId: 'cB' });   // B completes the creation…
    assert.deepStrictEqual(b, { ok: true, rid }, 'RACE-R3-1B premise: the resumer completes the creation');
    const d = await S.deleteBranchDraft(db, { rid, brandId: 'rc_eleven', now: LATER + 1, callId: 'cD' });   // …then the draft (and the never-opened brand) is deleted
    assert.deepStrictEqual(d, { ok: true }, 'RACE-R3-1B premise: the delete completes');
    atRead.release();
    const a = await A;
    assert.strictEqual(await read(`restaurants/${rid}/draft`), null, `RACE-R3-1B the expired creator resurrected the deleted draft (${JSON.stringify(a)})`);
    assert.strictEqual(await read('brands/rc_eleven'), null, 'RACE-R3-1B no brand resurrected');
    assert.deepStrictEqual((await checkBrand(db, 'rc_eleven', { now: LATER + 2 })).findings, [], 'RACE-R3-1B nothing left inconsistent');
  }],

  ['r3 1r: the stated residual — a creator stalled AFTER its last renewal lands one create, and `check` reports it', async (db) => {
    const rid = 'rc_eleven_r_centro';
    const g = gated(db);
    const atWrite = g.pause('transaction', `restaurants/${rid}/draft`);   // past the renewal, AT the write
    const A = S.createBrandWithDraft(g.db, { brandId: 'rc_eleven_r', brandName: 'OnceR', input: input('rc_eleven_r', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW, callId: 'cA' });
    await atWrite.reached;
    assert.deepStrictEqual(await S.resumeBranchOp(db, { brandId: 'rc_eleven_r', now: LATER, callId: 'cB' }), { ok: true, rid }, 'RACE-R3-1R premise: the resumer completes');
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid, brandId: 'rc_eleven_r', now: LATER + 1, callId: 'cD' }), { ok: true }, 'RACE-R3-1R premise: the delete completes');
    atWrite.release();
    await A;
    const r = await checkBrand(db, 'rc_eleven_r', { now: LATER + 2 });
    const landed = (await (reader(db))(`restaurants/${rid}/draft`)) != null;
    if (landed) assert.ok(r.findings.some((f) => f.code === 'draft_without_brand' && f.rid === rid), 'RACE-R3-1R the residual write is DETECTED by check');
    else assert.deepStrictEqual(r.findings, [], 'RACE-R3-1R nothing landed and nothing is inconsistent');
  }],

  ['r3 2: deactivateBrand and an in-flight activation never interleave', async (db) => {
    const read = reader(db);
    await db.ref('brands/rc_twelve').set({ name: 'Doce', active: true, locations: { rc_twelve_c: 'member' }, activation: { state: 'on', since: 1 }, projection_gen: 1 });
    const g = gated(db);
    const atBrand = g.pause('transaction', 'brands/rc_twelve');
    const A = S.activateBrand(g.db, { brandId: 'rc_twelve', open: [], now: NOW, readers: team, callId: 'cA' });
    await atBrand.reached;
    const d = await S.deactivateBrand(db, { brandId: 'rc_twelve', now: NOW + 1 });
    atBrand.release();
    const a = await A;
    const st = (await read('brands/rc_twelve')).activation.state;
    if (d.ok) assert.strictEqual(st, 'off', `RACE-R3-2 a deactivation that reported ok was undone by the in-flight activation (${JSON.stringify([d, a])})`);
    else assert.strictEqual(d.error, 'brand_busy', 'RACE-R3-2 the deactivation waits for the brand lock');
  }],

  ['r3 2b: a stale activation never undoes a later deactivation', async (db) => {
    const read = reader(db);
    await db.ref('brands/rc_thirteen').set({ name: 'Trece', active: true, locations: { rc_thirteen_c: 'member' }, activation: { state: 'off', since: 1 }, projection_gen: 1 });
    const g = gated(db);
    const atBrand = g.pause('transaction', 'brands/rc_thirteen');
    const A = S.activateBrand(g.db, { brandId: 'rc_thirteen', open: [], now: NOW, readers: team, callId: 'cA' });   // planned, then stalls…
    await atBrand.reached;
    const b = await S.resumeBranchOp(db, { brandId: 'rc_thirteen', now: LATER, callId: 'cB' });   // …B finishes the activation
    assert.strictEqual(b.ok, true, `RACE-R3-2B premise: the resumer finishes the activation (${JSON.stringify(b)})`);
    const d = await S.deactivateBrand(db, { brandId: 'rc_thirteen', now: LATER + 1 });
    assert.strictEqual(d.ok, true, `RACE-R3-2B premise: a later deactivation (${JSON.stringify(d)})`);
    atBrand.release();
    await A;
    assert.deepStrictEqual((await read('brands/rc_thirteen')).activation, { state: 'off', since: LATER + 1 }, 'RACE-R3-2B the stale activation switched the brand back on');
  }],

  ['r3 3: deleting a draft the brand LISTS never leaves a dangling listing', async (db) => {
    const read = reader(db);
    const { rid } = await S.createBrandWithDraft(db, { brandId: 'rc_fourteen', brandName: 'Catorce', input: input('rc_fourteen', 'Centro'), opId: 'o1', callerUid: 'own', now: NOW });
    assert.strictEqual((await S.activateBrand(db, { brandId: 'rc_fourteen', open: [], now: NOW + 1, readers: team })).ok, true, 'RACE-R3-3 premise: the brand is on');
    const d = await S.deleteBranchDraft(db, { rid, brandId: 'rc_fourteen', now: NOW + 2 });
    assert.deepStrictEqual(await listedAreBacked(read, 'rc_fourteen'), [], `RACE-R3-3 the on brand lists a branch with neither draft nor identity (${JSON.stringify(d)})`);
    assert.deepStrictEqual(d, { ok: false, error: 'brand_lists_draft' }, 'RACE-R3-3 a listed draft of an on brand is refused');
    assert.deepStrictEqual((await checkBrand(db, 'rc_fourteen', { now: NOW + 3 })).findings, [], 'RACE-R3-3 the brand is consistent');
  }],
];

// the shared runner: per-scenario deadline (a timer — the process cannot end silently while one is pending), exact completion count
async function runScenarios(makeDb, { perScenarioMs = 20000, log = console.log } = {}) {
  let done = 0; const failed = [];
  for (const [label, run] of SCENARIOS) {
    let timer;
    const deadline = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`SCENARIO-TIMEOUT did not finish within ${perScenarioMs} ms`)), perScenarioMs); });
    try { await Promise.race([run(await makeDb()), deadline]); log(`  ✓ ${done + failed.length + 1} ${label}`); done += 1; } catch (e) { failed.push(label); log(`  ✗ ${label}\n      ${e && e.message}`); } finally { clearTimeout(timer); }
  }
  assert.strictEqual(done + failed.length, SCENARIOS.length, `RACE-RUNNER not every scenario completed (${done + failed.length}/${SCENARIOS.length})`);
  return { done, failed, total: SCENARIOS.length };
}

module.exports = { SCENARIOS, runScenarios };
