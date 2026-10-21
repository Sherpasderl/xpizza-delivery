'use strict';
// ORCHESTRATION O1a (PLAN-multi-location-orchestration r3.1 §2.2, §2.3, §4, §5) — the branch-lifecycle WRITERS over an in-memory RTDB
// (transactions with the Admin SDK's null-first pass, multi-path update, orderByChild/equalTo). Covers: payload-bound idempotency,
// the PERSISTED allocation candidate (incl. the exact Codex r3 interleaving and its variant), name reservation, draft delete cleanup,
// materialize with durable inputs + lease + match-existing steps + resume, set-location guard incl. live orders, activation
// (staged → member + identity, resumable) and deactivation consequences, legacy enrichment. Run: node branches/branch-store.test.js
const assert = require('assert');
const S = require('./branch-store');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');   // faithful Admin-SDK transaction semantics (cached-null first pass)

const DAY = { open: true, start: '11:00', end: '22:00' };
const H7 = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };
const INPUT = { brand_id: 'tb_brand', location_name: 'Centro', phone: '+50499990000', hours: H7, prep_default_min: 20 };
const BRAND = { name: 'Third', active: true, locations: { tb_norte: 'member' }, activation: { state: 'off', since: 1 } };
const NORTE = { name: 'Third', brand_id: 'tb_brand', location_name: 'Norte', phone: '+50499990001', hours: H7, prep_default_min: 20, hub_lat: 15.6,
  hub_lng: -88.0, address_line: 'Calle 1', zone: { type: 'circle', radius_km: 5 }, delivery_radius_km: 5, whatsapp_instance: '', whatsapp_enabled: false,
  active: true, active_changed_at: 1, version: 3 };
const BOUNDS = { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 };
const base = () => fakeRtdb({ brands: { tb_brand: BRAND }, restaurants: { tb_norte: { identity: NORTE } }, platform_config: { service_bounds: BOUNDS } });
const NOW = 1_800_000_000_000;

(async () => {
  // ── createDraft: allocation + idempotency ──
  {
    const db = base();
    const r = await S.createDraft(db, { input: INPUT, opId: 'op1', callerUid: 'own1', now: NOW });
    assert.deepStrictEqual(r, { ok: true, rid: 'tb_brand_centro' });
    assert.deepStrictEqual(db.get('restaurants/tb_brand_centro/draft'), { ...INPUT, created_at: NOW, created_by: 'own1', op_id: 'op1' });
    assert.deepStrictEqual(db.get('rid_reservations/tb_brand_centro'), { op_id: 'op1', brand_id: 'tb_brand' });
    assert.strictEqual(db.get('branch_op_ids/tb_brand/op1').rid, 'tb_brand_centro');
    assert.deepStrictEqual(await S.createDraft(db, { input: INPUT, opId: 'op1', callerUid: 'own1', now: NOW + 5 }), { ok: true, rid: 'tb_brand_centro' }, 'same op_id + payload → the SAME rid');
    assert.strictEqual(db.get('restaurants/tb_brand_centro/draft').created_at, NOW, 'resume never rewrites the draft');
    assert.deepStrictEqual(await S.createDraft(db, { input: { ...INPUT, phone: '+50499990009' }, opId: 'op1', callerUid: 'own1', now: NOW }), { ok: false, error: 'op_conflict' });
    assert.deepStrictEqual(await S.createDraft(db, { input: { ...INPUT, location_name: ' CENTRO' }, opId: 'op2', callerUid: 'own1', now: NOW }), { ok: false, error: 'bad_draft', errors: ['bad_name'] });
    assert.deepStrictEqual(await S.createDraft(db, { input: { ...INPUT, location_name: 'CENTRO' }, opId: 'op2', callerUid: 'own1', now: NOW }), { ok: false, error: 'name_taken' }, 'name unique within the brand (case-insensitive)');
    assert.strictEqual(db.get('rid_reservations/tb_brand_centro_2'), null, 'a taken NAME leaves no rid reservation behind (name reserved first)');
    assert.strictEqual(db.get('branch_op_ids/tb_brand/op2'), null, 'and no op-id mapping (a retry with a corrected name may reuse op2)');
    const r2 = await S.createDraft(db, { input: { ...INPUT, location_name: 'Centro Sur' }, opId: 'op3', callerUid: 'own1', now: NOW });
    assert.deepStrictEqual(r2, { ok: true, rid: 'tb_brand_centro_sur' });
    assert.deepStrictEqual(await S.createDraft(db, { input: { ...INPUT, brand_id: 'tb_none' }, opId: 'op4', callerUid: 'own1', now: NOW }), { ok: false, error: 'brand_not_found' });
  }
  ok('createDraft: rid allocated + reserved + draft written; same op_id resumes the SAME rid; changed payload → op_conflict; name unique (no orphan rid); unknown brand refused');

  // ── a candidate already used by an identity / brand id is TAKEN even without a reservation ──
  {
    const db = fakeRtdb({ brands: { tb_brand: BRAND, tb_brand_norte: { name: 'L', active: true, locations: { tb_brand_norte: 'member' }, activation: { state: 'legacy', since: 1 } } },
      restaurants: { tb_brand_norte: { identity: NORTE } }, platform_config: { service_bounds: BOUNDS } });
    const r = await S.createDraft(db, { input: { ...INPUT, location_name: 'Norte' }, opId: 'op1', callerUid: 'own1', now: NOW });
    assert.deepStrictEqual(r, { ok: true, rid: 'tb_brand_norte_2' }, 'an existing identity / brand at the first candidate → next');
  }
  ok('a candidate already holding an identity or a /brands record is taken (no reservation needed)');

  // ── the exact Codex r3 interleaving + its variant ──
  {
    const db = base();
    assert.deepStrictEqual(await S.createDraft(db, { input: { ...INPUT, location_name: 'Plaza Comercial Norte' }, opId: 'A', callerUid: 'own1', now: NOW }), { ok: true, rid: 'tb_brand_plaza_comercial' });
    // B (a different name with the SAME 15-char slug) persists candidate=…_2, reserves it, then crashes before recording its rid
    db.failAfter['rid_reservations/tb_brand_plaza_comercial_2'] = true;
    await assert.rejects(S.createDraft(db, { input: { ...INPUT, location_name: 'Plaza Comercial Sur' }, opId: 'B', callerUid: 'own1', now: NOW }), /crash after rid_reservations\/tb_brand_plaza_comercial_2/,
      'B must skip A\'s reservation and crash right after reserving the NEXT candidate');
    assert.strictEqual(db.get('branch_op_ids/tb_brand/B').candidate, 'tb_brand_plaza_comercial_2', 'B persisted its candidate BEFORE reserving it');
    assert.strictEqual(db.get('branch_op_ids/tb_brand/B').rid, undefined);
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid: 'tb_brand_plaza_comercial', brandId: 'tb_brand' }), { ok: true }, 'A deletes its draft (frees the base rid)');
    assert.strictEqual(db.get('rid_reservations/tb_brand_plaza_comercial'), null);
    const rb = await S.createDraft(db, { input: { ...INPUT, location_name: 'Plaza Comercial Sur' }, opId: 'B', callerUid: 'own1', now: NOW });
    assert.deepStrictEqual(rb, { ok: true, rid: 'tb_brand_plaza_comercial_2' }, 'B resumes on its PERSISTED candidate — never the freed base');
    const owned = Object.entries(db.get('rid_reservations')).filter(([, v]) => v.op_id === 'B').map(([k]) => k);
    assert.deepStrictEqual(owned, ['tb_brand_plaza_comercial_2'], 'B holds exactly ONE reservation');
    assert.strictEqual(db.get('restaurants/tb_brand_plaza_comercial_2/draft').location_name, 'Plaza Comercial Sur');
  }
  {
    // variant: B crashes right after PERSISTING the candidate (the mapping's 2nd write), before reserving it; C takes that exact
    // candidate → B resumes from its persisted value and advances FORWARD from it
    const db = base();
    db.failAfter['branch_op_ids/tb_brand/B'] = 2;
    await assert.rejects(S.createDraft(db, { input: { ...INPUT, location_name: 'Plaza' }, opId: 'B', callerUid: 'own1', now: NOW }), /crash after branch_op_ids/);
    assert.strictEqual(db.get('branch_op_ids/tb_brand/B').candidate, 'tb_brand_plaza');
    assert.strictEqual(db.get('rid_reservations/tb_brand_plaza'), null, 'not reserved yet');
    db.root.rid_reservations = { tb_brand_plaza: { op_id: 'C', brand_id: 'tb_brand' } };
    const rb = await S.createDraft(db, { input: { ...INPUT, location_name: 'Plaza' }, opId: 'B', callerUid: 'own1', now: NOW });
    assert.deepStrictEqual(rb, { ok: true, rid: 'tb_brand_plaza_2' }, 'B advanced forward from its persisted candidate');
    assert.deepStrictEqual(db.get('rid_reservations/tb_brand_plaza'), { op_id: 'C', brand_id: 'tb_brand' }, 'C keeps its reservation');
    assert.strictEqual(db.get('branch_op_ids/tb_brand/B').candidate, 'tb_brand_plaza_2');
  }
  ok('Codex r3 interleaving: B persists base_2, reserves, crashes; A frees base; B resumes on base_2 with exactly ONE reservation; variant: a taken persisted candidate → advance forward');

  // ── deleteBranchDraft cleans every reservation of the draft ──
  {
    const db = base();
    await S.createDraft(db, { input: INPUT, opId: 'op1', callerUid: 'own1', now: NOW });
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid: 'tb_brand_centro', brandId: 'tb_brand' }), { ok: true });
    for (const p of ['restaurants/tb_brand_centro', 'rid_reservations/tb_brand_centro', 'branch_op_ids/tb_brand/op1']) assert.strictEqual(db.get(p), null, `${p} removed`);
    assert.deepStrictEqual(db.get('brand_branch_names/tb_brand'), null, 'name reservation released');
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid: 'tb_norte', brandId: 'tb_brand' }), { ok: false, error: 'not_a_draft' });
    await S.createDraft(db, { input: { ...INPUT, location_name: 'Este' }, opId: 'op5', callerUid: 'own1', now: NOW });
    db.root.rid_reservations.tb_brand_este = { op_id: 'other', brand_id: 'tb_brand' };   // a reservation this draft's op does not own
    db.root.brand_branch_names.tb_brand.este = { op_id: 'other' };
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid: 'tb_brand_este', brandId: 'tb_brand' }), { ok: true });
    assert.deepStrictEqual([db.get('rid_reservations/tb_brand_este'), db.get('brand_branch_names/tb_brand/este')], [{ op_id: 'other', brand_id: 'tb_brand' }, { op_id: 'other' }], 'never frees a reservation another op owns');
    assert.deepStrictEqual(await S.deleteBranchDraft(db, { rid: 'tb_brand_centro', brandId: 'other' }), { ok: false, error: 'not_a_draft' });
  }
  ok('deleteBranchDraft: removes the draft + its rid / name reservations + op-id mapping; refuses a non-draft or another brand; never frees a reservation another op owns');

  // ── materialize: durable inputs, lease, match-existing steps, resume, identity_conflict ──
  const LOC = { hub: { lat: 15.51, lng: -88.03 }, address_line: 'Blvd 1' };
  {
    const db = base();
    await S.createDraft(db, { input: INPUT, opId: 'op1', callerUid: 'own1', now: NOW });
    db.failAfter['brands/tb_brand'] = true;   // crash after identity + the staged entry, before the draft delete
    await assert.rejects(S.materializeBranch(db, { rid: 'tb_brand_centro', location: LOC, now: NOW, callId: 'c1' }));
    const rec = db.get('branch_ops/tb_brand_centro');
    assert.deepStrictEqual([rec.kind, rec.inputs.location], ['materialize', LOC], 'durable inputs recorded');
    assert.ok(db.get('restaurants/tb_brand_centro/identity'), 'identity committed before the crash');
    const busy = await S.materializeBranch(db, { rid: 'tb_brand_centro', location: LOC, now: NOW + 1000, callId: 'c2' });
    assert.deepStrictEqual(busy, { ok: false, error: 'op_in_progress' }, 'another call cannot take an unexpired lease');
    const resumed = await S.resumeBranchOp(db, { rid: 'tb_brand_centro', now: NOW + 61_000, callId: 'c3' });   // lease expired
    assert.deepStrictEqual(resumed, { ok: true, rid: 'tb_brand_centro', state: 'staged' }, 'resume from durable inputs (no request needed)');
    assert.strictEqual(db.get('brands/tb_brand/locations/tb_brand_centro'), 'staged');
    assert.strictEqual(db.get('brands/tb_brand/projection_gen'), 1, 'the membership change bumps projection_gen (once, across the crash + resume)');
    assert.strictEqual(db.get('restaurants/tb_brand_centro/draft'), null, 'draft deleted');
    assert.strictEqual(db.get('restaurants/tb_brand_centro/identity').active, false);
    assert.strictEqual(db.get('branch_ops/tb_brand_centro'), null, 'finished op record cleared');
    assert.deepStrictEqual(await S.materializeBranch(db, { rid: 'tb_brand_centro', location: LOC, now: NOW, callId: 'c4' }), { ok: true, rid: 'tb_brand_centro', state: 'staged' }, 'a repeat is a no-op success (already matching)');
  }
  {
    const db = base();
    await S.createDraft(db, { input: INPUT, opId: 'op1', callerUid: 'own1', now: NOW });
    db.root.restaurants.tb_brand_centro.identity = { ...NORTE, location_name: 'Otro' };   // a foreign identity appeared
    const r = await S.materializeBranch(db, { rid: 'tb_brand_centro', location: LOC, now: NOW, callId: 'c1' });
    assert.deepStrictEqual(r, { ok: false, error: 'identity_conflict' }, 'never overwrites a different identity');
    assert.strictEqual(db.get('restaurants/tb_brand_centro/identity').location_name, 'Otro');
    assert.deepStrictEqual(db.get('dispatcher_alerts/branch_identity_conflict_tb_brand_centro'), { type: 'branch_identity_conflict', rid: 'tb_brand_centro', created_at: NOW });
    assert.deepStrictEqual(await S.materializeBranch(db, { rid: 'tb_brand_centro', location: LOC, now: NOW + 5, callId: 'c9' }), { ok: false, error: 'identity_conflict' });
    assert.strictEqual(db.get('dispatcher_alerts/branch_identity_conflict_tb_brand_centro').created_at, NOW, 'alert is create-only');
    assert.deepStrictEqual(await S.materializeBranch(db, { rid: 'tb_nothing', location: LOC, now: NOW, callId: 'c1' }), { ok: false, error: 'not_a_draft' });
    const bad = await S.materializeBranch(fakeRtdb({ brands: { tb_brand: BRAND }, restaurants: { x: { draft: { ...INPUT, op_id: 'o' } } } }), { rid: 'x', location: LOC, now: NOW, callId: 'c1' });
    assert.deepStrictEqual(bad, { ok: false, error: 'bad_location', errors: ['service_bounds_unset'] }, 'no service bounds → refused');
  }
  ok('materialize: durable inputs + lease (op_in_progress); crash after identity → resume from the record → staged + draft deleted; repeat = no-op; identity_conflict never overwrites; bounds unset refused');

  // ── setBranchLocation: inactive ≥ 10 min, zero non-terminal orders (indexed by restaurant_id) ──
  {
    const off = { ...NORTE, active: false, active_changed_at: NOW - 11 * 60_000 };
    const db = fakeRtdb({ brands: { tb_brand: BRAND }, restaurants: { tb_norte: { identity: off } }, platform_config: { service_bounds: BOUNDS },
      orders: { o1: { restaurant_id: 'tb_norte', status: 'delivered' }, o2: { restaurant_id: 'tb_otro', status: 'new' } } });
    const r = await S.setBranchLocation(db, { rid: 'tb_norte', input: { hub: { lat: 15.62, lng: -88.01 } }, expectedVersion: 3, now: NOW });
    assert.deepStrictEqual(r, { ok: true, version: 4 });
    assert.deepStrictEqual([db.get('restaurants/tb_norte/identity/hub_lat'), db.get('restaurants/tb_norte/identity/hub_lng')], [15.62, -88.01]);
    db.root.orders.o3 = { restaurant_id: 'tb_norte', status: 'pending_payment' };
    const r2 = await S.setBranchLocation(db, { rid: 'tb_norte', input: { hub: { lat: 15.63, lng: -88.01 } }, expectedVersion: 4, now: NOW });
    assert.deepStrictEqual(r2, { ok: false, error: 'refused', errors: ['branch_has_live_orders'] }, 'a pending-payment card order is live');
    db.root.orders.o3.status = 'scheduled';
    assert.deepStrictEqual((await S.setBranchLocation(db, { rid: 'tb_norte', input: { hub: { lat: 15.63, lng: -88.01 } }, expectedVersion: 4, now: NOW })).errors, ['branch_has_live_orders'], 'a scheduled order is live');
    // CAS inside the transaction: a concurrent version bump between read and write → stale_branch
    db.root.orders.o3.status = 'cancelled';
    db.hooks['restaurants/tb_norte/identity'] = async () => { db.root.restaurants.tb_norte.identity.version = 9; };
    assert.deepStrictEqual(await S.setBranchLocation(db, { rid: 'tb_norte', input: { hub: { lat: 15.64, lng: -88.01 } }, expectedVersion: 4, now: NOW }), { ok: false, error: 'stale_branch' });
  }
  ok('setBranchLocation: moves an OFF, drained branch (CAS); a pending-payment or scheduled order blocks; a concurrent version change → stale_branch');

  // ── setBranchActive: staged → member + active (resumable), deactivate consequences ──
  {
    const off = { ...NORTE, active: false, version: 3 };
    const db = fakeRtdb({ brands: { tb_brand: { ...BRAND, activation: { state: 'on', since: 2 }, locations: { tb_norte: 'staged' } } },
      restaurants: { tb_norte: { identity: off, handhelds: { h1: { revoked: false, last_seen: 5 }, h2: { revoked: true, last_seen: 9 } } } }, menus: { tb_brand: { v: 1 } },
      orders: { o1: { restaurant_id: 'tb_norte', status: 'preparing' }, o2: { restaurant_id: 'tb_norte', status: 'scheduled' }, o3: { restaurant_id: 'tb_norte', status: 'delivered' } } });
    db.failAfter['brands/tb_brand'] = true;   // crash after the brand step (staged → member), before the identity CAS
    const readers = { teamCount: async (rid) => (rid === 'tb_norte' ? 1 : 0) };
    await assert.rejects(S.setBranchActive(db, { rid: 'tb_norte', active: true, expectedVersion: 3, now: NOW, callId: 'c1', readers }));
    assert.strictEqual(db.get('brands/tb_brand/locations/tb_norte'), 'member');
    assert.strictEqual(db.get('brands/tb_brand/projection_gen'), 1, 'staged → member bumps projection_gen');
    assert.strictEqual(db.get('restaurants/tb_norte/identity/active'), false, 'identity not yet active');
    const res = await S.resumeBranchOp(db, { rid: 'tb_norte', now: NOW + 61_000, callId: 'c2' });
    assert.deepStrictEqual(res, { ok: true, rid: 'tb_norte', state: 'active' });
    assert.deepStrictEqual([db.get('restaurants/tb_norte/identity/active'), db.get('restaurants/tb_norte/identity/version')], [true, 4]);
    assert.strictEqual(db.get('brands/tb_brand/projection_gen'), 1, 'the resumed brand step is a no-op (no second bump)');
    const d = await S.setBranchActive(db, { rid: 'tb_norte', active: false, expectedVersion: 4, now: NOW + 70_000, callId: 'c3' });
    assert.deepStrictEqual(d, { ok: true, state: 'inactive', consequences: { live_orders: 2, scheduled_bound: 1, devices: 1 } }, 'deactivate: counts for the portal');
    assert.strictEqual(db.get('brands/tb_brand/locations/tb_norte'), 'member', 'stays member');
    assert.deepStrictEqual([db.get('restaurants/tb_norte/identity/active'), db.get('restaurants/tb_norte/identity/version')], [false, 5], 'deactivate bumps version by exactly 1');
    const nr = await S.setBranchActive(fakeRtdb({ brands: { tb_brand: { ...BRAND, locations: { tb_norte: 'staged' } } }, restaurants: { tb_norte: { identity: off } } }),
      { rid: 'tb_norte', active: true, expectedVersion: 3, now: NOW, callId: 'c1' });
    assert.deepStrictEqual(nr, { ok: false, error: 'not_ready', unmet: ['brand_not_on', 'no_handheld_online', 'no_owner_or_manager', 'menu_not_published'] }, 'no team reader → fail closed');
  }
  ok('setBranchActive: activate = brand txn (staged→member) then identity CAS, resumable after a crash; deactivate keeps member + returns {live_orders, scheduled_bound, devices (unrevoked)}; readiness refusal lists every unmet check (no team reader → fail closed)');

  // ── enrichLegacyIdentity ──
  {
    const legId = { ...NORTE, brand_id: undefined, location_name: undefined, zone: undefined, prep_default_min: undefined, display_name: 'X', uses_platform_factura: true, version: 1 };
    const db = fakeRtdb({ brands: { tb_leg: { name: 'L', active: true, locations: { tb_leg: 'member' }, activation: { state: 'legacy', since: 1 } } }, restaurants: { tb_leg: { identity: clone(legId) } } });
    const r = await S.enrichLegacyIdentity(db, { rid: 'tb_leg', input: { location_name: 'Centro', prep_default_min: 20 }, expectedVersion: 1 });
    assert.deepStrictEqual(r, { ok: true, version: 2 });
    const id = db.get('restaurants/tb_leg/identity');
    assert.deepStrictEqual([id.brand_id, id.location_name, id.zone, id.prep_default_min, id.uses_platform_factura, id.display_name], ['tb_leg', 'Centro', { type: 'circle', radius_km: 5 }, 20, true, 'X'], 'additive; existing fields kept');
    assert.deepStrictEqual(await S.enrichLegacyIdentity(db, { rid: 'tb_leg', input: { location_name: 'Centro', prep_default_min: 20 }, expectedVersion: 2 }), { ok: false, error: 'refused', errors: ['already_enriched'] });
  }
  ok('enrichLegacyIdentity: additive CAS write on the legacy branch (foreign fields kept); a second run refused');

  // ── brand activation (off → on, chosen staged → member + identity active) / deactivation (on → off) / version-only bump ──
  {
    const off = { ...NORTE, active: false, version: 3 };
    const init = () => fakeRtdb({ brands: { tb_brand: { ...BRAND, activation: { state: 'off', since: 1 }, locations: { tb_norte: 'staged' } } },
      restaurants: { tb_norte: { identity: off, handhelds: { h1: { revoked: false, last_seen: 5 } } } }, menus: { tb_brand: { v: 1 } } });
    const readers = { teamCount: async () => 1 };
    let db = init();
    assert.deepStrictEqual(await S.activateBrand(db, { brandId: 'tb_brand', open: ['tb_norte'], now: NOW }), { ok: false, error: 'not_ready', unmet: { tb_norte: ['no_owner_or_manager'] } }, 'no team reader → fail closed, nothing written');
    assert.deepStrictEqual(db.writes, []);
    assert.deepStrictEqual(await S.activateBrand(db, { brandId: 'tb_brand', open: ['tb_otro'], now: NOW, readers }), { ok: false, error: 'not_staged', rids: ['tb_otro'] });
    db.failAfter['brands/tb_brand'] = true;   // crash after the brand transaction
    await assert.rejects(S.activateBrand(db, { brandId: 'tb_brand', open: ['tb_norte'], now: NOW, readers }));
    assert.deepStrictEqual([db.get('brands/tb_brand/activation'), db.get('brands/tb_brand/locations/tb_norte'), db.get('brands/tb_brand/projection_gen')], [{ state: 'on', since: NOW }, 'member', 1]);
    assert.strictEqual(db.get('restaurants/tb_norte/identity/active'), false);
    const again = await S.activateBrand(db, { brandId: 'tb_brand', open: ['tb_norte'], now: NOW + 9, readers });
    assert.deepStrictEqual(again, { ok: true, opened: ['tb_norte'] }, 're-run resumes: brand step already matching, identity CAS completes');
    assert.deepStrictEqual([db.get('brands/tb_brand/activation/since'), db.get('brands/tb_brand/projection_gen')], [NOW, 1], 'no second brand write');
    assert.deepStrictEqual([db.get('restaurants/tb_norte/identity/active'), db.get('restaurants/tb_norte/identity/version')], [true, 4]);
    const n0 = db.writes.length;
    assert.deepStrictEqual(await S.activateBrand(db, { brandId: 'tb_brand', open: ['tb_norte'], now: NOW + 20, readers }), { ok: true, opened: ['tb_norte'] }, 'a third run is a no-op');
    assert.strictEqual(db.writes.length, n0, 'and writes nothing');
    assert.deepStrictEqual(await S.deactivateBrand(db, { brandId: 'tb_brand', now: NOW + 30 }), { ok: true });
    assert.deepStrictEqual([db.get('brands/tb_brand/activation'), db.get('brands/tb_brand/projection_gen'), db.get('brands/tb_brand/locations/tb_norte')], [{ state: 'off', since: NOW + 30 }, 2, 'member']);
    assert.deepStrictEqual(await S.deactivateBrand(db, { brandId: 'tb_brand', now: NOW + 40 }), { ok: false, error: 'not_on' });
    db = fakeRtdb({ brands: { tb_leg: { name: 'L', active: true, locations: { tb_leg: 'member', tb_leg_2: 'staged' }, activation: { state: 'legacy', since: 1 } } } });
    assert.deepStrictEqual(await S.activateBrand(db, { brandId: 'tb_leg', open: ['tb_leg_2'], now: NOW, readers }), { ok: false, error: 'legacy_cutover_is_o3' }, 'the legacy cutover is O3 (plan phasing)');
    assert.deepStrictEqual(await S.activateBrand(db, { brandId: 'tb_none', open: [], now: NOW }), { ok: false, error: 'brand_not_found' });
  }
  ok('activateBrand: off → on + chosen staged → member (one brand txn, projection_gen +1) then identity CAS per branch; readiness per branch (no team reader → fail closed, nothing written); resumable + idempotent; deactivateBrand on → off; legacy cutover refused (O3)');
  {
    const db = fakeRtdb({ restaurants: { tb_norte: { identity: { ...NORTE } } } });
    assert.deepStrictEqual(await S.bumpIdentityVersion(db, { rid: 'tb_norte', expectedVersion: 3 }), { ok: true, version: 4 });
    const { version, ...rest } = db.get('restaurants/tb_norte/identity'); const { version: v0, ...rest0 } = NORTE;
    assert.deepStrictEqual([version, rest], [4, rest0], 'only version changes');
    assert.deepStrictEqual(await S.bumpIdentityVersion(db, { rid: 'tb_norte', expectedVersion: 3 }), { ok: false, error: 'stale_branch' });
    assert.deepStrictEqual(await S.bumpIdentityVersion(db, { rid: 'tb_none', expectedVersion: 1 }), { ok: false, error: 'stale_branch' });
  }
  ok('bumpIdentityVersion (projection resync): version + 1 only, CAS on the expected version; absent identity refused');

  console.log(`\nbranch-store: OK (${n})`);
})().catch((e) => { console.error('branch-store FAILED:', e); process.exit(1); });
