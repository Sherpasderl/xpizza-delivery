'use strict';
// ORCHESTRATION O1b T4 / T5 / T7 (PLAN-orch-o1b r3) — the portal lifecycle cores E6 / E7 / E8 / E10 over the FAITHFUL fake RTDB,
// a synthetic brand `tb_brand` (ON: tb_sur member + tb_este staged + a draft), a LEGACY brand `x_leg`, and a second brand `tb_otra`.
// Logical time only (the wall clock is disabled for the whole file).
// Run: node portal/branch-lifecycle-core.test.js
const assert = require('assert');
const C = require('./branch-lifecycle-core');
const S = require('../branches/branch-store');
const P = require('../branches/branch-ops');
const { fakeRtdb } = require('../test/_fake-rtdb-sdk');

Date.now = () => { throw new Error('branch-lifecycle-core.test: Date.now() read — every call here runs on logical time'); };

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('branch-lifecycle-core: FAILED — exited without completing'); process.exitCode = 1; } });

const NOW = 1_800_000_000_000;
const DAY = { open: true, start: '11:00', end: '22:00' };
const H7 = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };
const g = { granted_at: 1, granted_by: 'x' };
const ident = (brand, name, over = {}) => ({ name: 'Third', brand_id: brand, location_name: name, phone: '+50431234567', hours: H7, prep_default_min: 20, hub_lat: 15.6, hub_lng: -88.0,
  zone: { type: 'circle', radius_km: 5 }, delivery_radius_km: 5, whatsapp_instance: '', whatsapp_enabled: false, active: true, active_changed_at: 1, version: 3, ...over });
const DRAFT = { brand_id: 'tb_brand', location_name: 'Plaza', phone: '+50431234567', hours: H7, prep_default_min: 20, created_at: 1, created_by: 'ownerTB', op_id: 'opP', inc: 'c1' };
function world(over = {}) {
  return fakeRtdb({
    platform_config: { membership_writes_enabled: true, service_bounds: { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 } },
    brands: {
      tb_brand: { name: 'Third', active: true, locations: { tb_sur: 'member', tb_este: 'staged' }, activation: { state: 'on', since: 1 }, projection_gen: 2 },
      tb_otra: { name: 'Otra', active: true, locations: { tb_otra: 'member' }, activation: { state: 'on', since: 1 } },
      x_leg: { name: 'Leg', active: true, locations: { x_leg: 'member' }, activation: { state: 'legacy', since: 1 } },
    },
    restaurants: {
      tb_sur: { identity: ident('tb_brand', 'Sur'), handhelds: { h1: { kind: 'handheld', last_seen: NOW - 5 } } },
      tb_este: { identity: ident('tb_brand', 'Este', { active: false, version: 1 }), handhelds: { h2: { kind: 'handheld', last_seen: NOW - 5 } } },
      tb_brand_plaza: { draft: DRAFT },
      tb_otra: { identity: ident('tb_otra', 'Otra') },
      x_leg: { identity: ident('x_leg', 'Leg', { phone: '+50422223333' }) },
    },
    branch_op_ids: { tb_brand: { opP: { payload_hash: 'h', inc: 'c1', rid: 'tb_brand_plaza' } } },
    rid_reservations: { tb_brand_plaza: { op_id: 'opP', brand_id: 'tb_brand', inc: 'c1' } },
    brand_branch_names: { tb_brand: { plaza: { op_id: 'opP', inc: 'c1' } } },
    brand_members: {
      tb_brand: { owners: { ownerTB: g }, managers: { tb_sur: { mgrSur: g }, tb_este: { mgrEst: g } } },
      tb_otra: { owners: { ownerOT: g } },
      x_leg: { owners: { ownerLG: g } },
    },
    member_of: { ownerTB: { brands: { tb_brand: 'owner' } }, ownerOT: { brands: { tb_otra: 'owner' } }, ownerLG: { brands: { x_leg: 'owner' } },
      mgrSur: { locations: { tb_sur: 'manager' } }, mgrEst: { locations: { tb_este: 'manager' } } },
    dispatchers: { disp01: true },
    menus: { tb_brand: { published: true } },
    ...over,
  });
}
let t = 0;
const deps = (db, extra = {}) => ({ db, verifyIdToken: async (tok) => ({ uid: tok, ...(tok.endsWith('Cust') ? { customer: true } : {}) }), now: () => NOW + (++t), clock: () => NOW + t, log: { warn() {}, log() {} }, ...extra });
const req = (uid, body, method = 'POST') => ({ method, body, get: (h) => (h === 'authorization' && uid ? `Bearer ${uid}` : undefined) });
const snap = (db) => JSON.stringify(db.get(''));
const createBody = (over = {}) => ({ op_id: 'opN1', brand_id: 'tb_brand', location_name: 'Norte', phone: '+50471234567', hours: H7, prep_default_min: 25, ...over });

(async () => {
  // ── E6: the WHOLE-request allowlist, Q10, the gate, brand.locations ──
  {
    for (const extra of [{ hub: { lat: 1, lng: 2 } }, { delivery_fee: 50 }, { rid: 'tb_x' }, { address_line: 'x' }]) {
      const db = world(); const before = snap(db);
      const r = await C.createBranchDraftCore(deps(db), req('ownerTB', createBody(extra)));
      assert.deepStrictEqual(r, { status: 403, body: { error: 'forbidden_field' } }, `E6-ALLOWLIST ${Object.keys(extra)[0]}`);
      assert.strictEqual(snap(db), before, 'E6-ALLOWLIST nothing written: reservations, names, mappings, the lock, drafts byte-identical');
    }
    const db0 = world(); const b = createBody(); delete b.hours;
    assert.strictEqual((await C.createBranchDraftCore(deps(db0), req('ownerTB', b))).status, 400, 'a missing key');
    for (const [phone, good] of [['+50431234567', true], ['+50471234567', true], ['+50481234567', true], ['+50491234567', true], ['+50421234567', false], ['+5043123456', false],
      ['+504312345678', false], ['50431234567', false], [' +50431234567', false], ['+504 3123 4567', false], ['+15551234567', false], [50431234567, false]]) {
      const db = world(); const r = await C.createBranchDraftCore(deps(db), req('ownerTB', createBody({ phone, op_id: `op${String(phone).replace(/\W/g, '')}`, location_name: `N${String(phone).replace(/\W/g, '').slice(-4)}` })));
      if (good) assert.strictEqual(r.status, 200, `Q10-ACCEPT ${phone} ${JSON.stringify(r.body)}`); else assert.deepStrictEqual(r, { status: 400, body: { error: 'bad_phone' } }, `Q10-REFUSE ${JSON.stringify(phone)}`);
    }
    for (const who of ['mgrSur', 'ownerOT', 'disp01', 'ownerTBCust']) {
      const db = world(); const before = snap(db);
      assert.deepStrictEqual((await C.createBranchDraftCore(deps(db), req(who, createBody()))).status, 403, `E6-AUTH ${who}`); assert.strictEqual(snap(db), before);
    }
    const db = world();
    const r = await C.createBranchDraftCore(deps(db), req('ownerTB', createBody()));
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.rid, 'tb_brand_norte'); assert.strictEqual(r.body.state, 'draft');
    assert.strictEqual(r.body.version, P.draftToken(db.get('restaurants/tb_brand_norte/draft')), 'E6 returns the draft token');
    assert.deepStrictEqual((await C.createBranchDraftCore(deps(db), req('ownerTB', createBody({ op_id: 'opN2' })))).body, { error: 'name_taken' });
    assert.deepStrictEqual((await C.createBranchDraftCore(deps(db), req('ownerTB', createBody({ op_id: 'opN3', location_name: 'Otro', hours: { ...H7, fri: { open: true, start: '22:00', end: '02:00' } } })))).status, 400, 'bad_hours');
    ok('E6: exactly six keys (hub / fee / rid / address → 403, NOTHING written); Q10 HN mobile as sent; owner only; draft token returned; name_taken; bad_hours');
  }

  // ── the write gate: missing / false / read failure → 503 writes_disabled, zero writes, on all four endpoints ──
  {
    const calls = [
      (d, db) => C.createBranchDraftCore(d, req('ownerTB', createBody())),
      (d, db) => C.updateBranchProfileCore(d, req('ownerTB', { rid: 'tb_sur', expectedVersion: 3, patch: { prep_default_min: 30 } })),
      (d, db) => C.setBranchActiveCore(d, req('ownerTB', { rid: 'tb_sur', expectedVersion: 3, active: false })),
      (d, db) => C.deleteBranchDraftCore(d, req('ownerTB', { rid: 'tb_brand_plaza', expectedVersion: P.draftToken(DRAFT) })),
    ];
    for (const [label, mk] of [['missing', () => { const db = world(); db.root.platform_config = { service_bounds: {} }; return db; }], ['false', () => { const db = world(); db.root.platform_config.membership_writes_enabled = false; return db; }],
      ['read failure', () => { const db = world(); const ref = db.ref; db.ref = (p) => (p === 'platform_config/membership_writes_enabled' ? { once: async () => { throw new Error('down'); } } : ref(p)); return db; }]]) {
      for (const call of calls) {
        const db = mk(); const before = snap(db);
        assert.deepStrictEqual(await call(deps(db), db), { status: 503, body: { error: 'writes_disabled' } }, `GATE ${label}`);
        assert.strictEqual(snap(db), before, `GATE ${label}: zero writes`);
      }
    }
    ok('write gate: flag missing / false / read failure → 503 writes_disabled with zero writes on E6 / E7 / E8 / E10');
  }

  // ── E7: rename_cli_only, field groups (mixed patches), drafts owner-only, Q10, tokens ──
  {
    for (const [who, rid, ver, patch] of [['ownerTB', 'tb_sur', 3, { location_name: 'Sur 2' }], ['ownerTB', 'tb_sur', 3, { location_name: 'Sur', hours: H7 }], ['mgrSur', 'tb_sur', 3, { location_name: 'X' }],
      ['ownerTB', 'tb_brand_plaza', P.draftToken(DRAFT), { location_name: 'Plaza 2' }]]) {
      const db = world(); const before = snap(db);
      assert.deepStrictEqual(await C.updateBranchProfileCore(deps(db), req(who, { rid, expectedVersion: ver, patch })), { status: 409, body: { error: 'rename_cli_only' } }, `RENAME-CLI-ONLY ${who} ${Object.keys(patch)}`);
      assert.strictEqual(snap(db), before, 'RENAME-CLI-ONLY nothing written');
    }
    const e7 = (db, who, rid, ver, patch, extra) => C.updateBranchProfileCore(deps(db, extra), req(who, { rid, expectedVersion: ver, patch }));
    let db = world(); let before = snap(db);
    assert.deepStrictEqual(await e7(db, 'mgrSur', 'tb_sur', 3, { hours: H7, hub_lat: 1 }), { status: 403, body: { error: 'forbidden_field' } }, 'GROUP manager {hours, hub}');
    assert.strictEqual(snap(db), before);
    assert.deepStrictEqual(await e7(db, 'mgrSur', 'tb_otra', 3, { hours: H7 }), { status: 403, body: { error: 'not_authorized' } }, 'a manager on another brand\'s branch');
    assert.deepStrictEqual(await e7(db, 'ownerOT', 'tb_sur', 3, { prep_default_min: 30 }), { status: 403, body: { error: 'not_authorized' } }, 'an owner of A on B');
    assert.deepStrictEqual(await e7(db, 'mgrSur', 'tb_sur', 3, { phone: '+50421234567' }), { status: 400, body: { error: 'bad_phone' } }, 'Q10 on E7');
    assert.strictEqual(snap(db), before);
    const r1 = await e7(db, 'mgrSur', 'tb_sur', 3, { phone: '+50481234567' });
    assert.deepStrictEqual(r1, { status: 200, body: { version: 4, lifecycle: 'identity', projection: 'published' } }, 'R-PHONE a manager edits the phone (location.contact); the member projection publishes');
    assert.strictEqual(db.get('public/brands/tb_brand/locations/tb_sur/location_name'), 'Sur', 'the projection exists');
    assert.deepStrictEqual(await e7(db, 'mgrSur', 'tb_sur', 3, { prep_default_min: 30 }), { status: 409, body: { error: 'stale_branch' } }, 'stale');
    assert.deepStrictEqual(await e7(db, 'mgrSur', 'tb_sur', 4, { phone: '+50481234567' }), { status: 200, body: { noop: true } }, 'noop');
    // a legacy landline identity can still edit its hours (no phone in the patch → the stored phone is never validated)
    const r2 = await e7(db, 'ownerLG', 'x_leg', 3, { hours: { ...H7, mon: DAY } });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
    // drafts: owner-only, by brand.locations
    db = world();
    assert.deepStrictEqual(await e7(db, 'mgrSur', 'tb_brand_plaza', P.draftToken(DRAFT), { prep_default_min: 30 }), { status: 403, body: { error: 'not_authorized' } }, 'DRAFT a manager');
    assert.deepStrictEqual(await e7(db, 'ownerOT', 'tb_brand_plaza', P.draftToken(DRAFT), { prep_default_min: 30 }), { status: 403, body: { error: 'not_authorized' } }, 'DRAFT another brand\'s owner');
    const r3 = await e7(db, 'ownerTB', 'tb_brand_plaza', P.draftToken(DRAFT), { prep_default_min: 30 });
    assert.deepStrictEqual(r3, { status: 200, body: { version: 'd.opP.c1.1', lifecycle: 'draft' } }, 'DRAFT the owner (no projection for a draft)');
    assert.deepStrictEqual(await e7(db, 'ownerTB', 'tb_brand_plaza', 3, { prep_default_min: 31 }), { status: 409, body: { error: 'stale_branch' } }, 'an identity token against a draft');
    ok('E7: rename_cli_only before anything; every group authorized first (manager {hours, hub} refused); R-PHONE; Q10; stale / noop; drafts owner-only with their token; projection published for a member');
  }

  // ── E8: R-LEGACY both directions; OFF / ON brands; readiness with gaps; owner only ──
  {
    let db = world(); let before = snap(db);
    const e8 = (db, who, rid, ver, active) => C.setBranchActiveCore(deps(db), req(who, { rid, expectedVersion: ver, active }));
    assert.deepStrictEqual(await e8(db, 'ownerLG', 'x_leg', 3, false), { status: 409, body: { error: 'legacy_branch' } }, 'LEGACY deactivate');
    assert.deepStrictEqual(await e8(db, 'ownerLG', 'x_leg', 3, true), { status: 409, body: { error: 'legacy_branch' } }, 'LEGACY reactivate (already active)');
    db.root.restaurants.x_leg.identity.active = false; before = snap(db);
    assert.deepStrictEqual(await e8(db, 'ownerLG', 'x_leg', 3, true), { status: 409, body: { error: 'legacy_branch' } }, 'LEGACY reactivate a CLI-deactivated one');
    assert.strictEqual(snap(db), before, 'LEGACY nothing written (identity, brand, projection)');
    assert.deepStrictEqual(await e8(db, 'mgrSur', 'tb_sur', 3, false), { status: 403, body: { error: 'not_authorized' } }, 'a manager never deactivates');
    // ON brand: deactivate → activate round trip (reversible), version + 1 each, published each time
    db = world();
    const off = await e8(db, 'ownerTB', 'tb_sur', 3, false);
    assert.deepStrictEqual(off, { status: 200, body: { ok: true, state: 'inactive', consequences: { live_orders: 0, scheduled_bound: 0, devices: 1 }, projection: 'published' } }, 'ON deactivate');
    assert.strictEqual(db.get('public/brands/tb_brand/locations/tb_sur/active'), false);
    const on = await e8(db, 'ownerTB', 'tb_sur', 4, true);
    assert.deepStrictEqual(on, { status: 200, body: { ok: true, state: 'active', projection: 'published' } }, 'ON reactivate (reversible)');
    assert.deepStrictEqual([db.get('restaurants/tb_sur/identity/version'), db.get('public/brands/tb_brand/locations/tb_sur/active')], [5, true]);
    assert.deepStrictEqual(await e8(db, 'ownerTB', 'tb_sur', 5, true), { status: 200, body: { noop: true } }, 'noop');
    // a staged branch with gaps → not_ready + identity_gaps; fixed → activates and becomes a member
    db = world(); db.root.restaurants.tb_este.identity.prep_default_min = 2;
    assert.deepStrictEqual(await e8(db, 'ownerTB', 'tb_este', 1, true), { status: 409, body: { error: 'not_ready', unmet: ['identity_invalid'], identity_gaps: ['prep'] } }, 'E8-GAPS');
    db.root.restaurants.tb_este.identity.prep_default_min = 20;
    assert.deepStrictEqual((await e8(db, 'ownerTB', 'tb_este', 1, true)).body, { ok: true, state: 'active', projection: 'published' });
    assert.strictEqual(db.get('brands/tb_brand/locations/tb_este'), 'member');
    // OFF brand's staged branch → not_ready brand_not_on; deactivating an inactive one → noop
    db = world(); db.root.brands.tb_brand.activation.state = 'off';
    assert.deepStrictEqual(await e8(db, 'ownerTB', 'tb_este', 1, true), { status: 409, body: { error: 'not_ready', unmet: ['brand_not_on'] } }, 'OFF brand');
    assert.deepStrictEqual(await e8(db, 'ownerTB', 'tb_este', 1, false), { status: 200, body: { noop: true } });
    ok('E8: legacy refused both ways before any write; ON round trip reversible + published; not_ready with identity_gaps; OFF brand → brand_not_on; owner only');
  }

  // ── E10: owner-only, re-bound, token under the lock ──
  {
    let db = world();
    const e10 = (db, who, rid, ver) => C.deleteBranchDraftCore(deps(db), req(who, { rid, expectedVersion: ver }));
    assert.deepStrictEqual(await e10(db, 'mgrSur', 'tb_brand_plaza', P.draftToken(DRAFT)), { status: 403, body: { error: 'not_authorized' } });
    assert.deepStrictEqual(await e10(db, 'ownerOT', 'tb_brand_plaza', P.draftToken(DRAFT)), { status: 403, body: { error: 'not_authorized' } });
    await C.updateBranchProfileCore(deps(db), req('ownerTB', { rid: 'tb_brand_plaza', expectedVersion: P.draftToken(DRAFT), patch: { prep_default_min: 40 } }));
    assert.deepStrictEqual(await e10(db, 'ownerTB', 'tb_brand_plaza', P.draftToken(DRAFT)), { status: 409, body: { error: 'stale_branch' } }, 'E10-STALE an edit since the screen was drawn');
    assert.ok(db.get('restaurants/tb_brand_plaza/draft'));
    assert.deepStrictEqual(await e10(db, 'ownerTB', 'tb_brand_plaza', 'd.opP.c1.1'), { status: 200, body: { ok: true } });
    assert.deepStrictEqual([db.get('restaurants/tb_brand_plaza'), db.get('rid_reservations/tb_brand_plaza'), db.get('brand_branch_names/tb_brand')], [null, null, null]);
    db = world(); db.root.branch_op_ids.tb_brand.opP.rid = 'tb_elsewhere';
    assert.deepStrictEqual(await e10(db, 'ownerTB', 'tb_brand_plaza', P.draftToken(DRAFT)), { status: 409, body: { error: 'not_a_draft' } }, 'E10-REBIND');
    assert.deepStrictEqual(await e10(db, 'ownerTB', 'tb_sur', 'd.x.y.0'), { status: 409, body: { error: 'not_a_draft' } }, 'an identity is not a draft');
    ok('E10: owner only; the token is checked under the lock (an intervening edit → stale_branch); re-bound; deletes the draft + its reservations');
  }

  // ── publishAfterCommit: refusal / exception / timeout → the mutation stands, `deferred`, ONE alert (count) ──
  {
    const alert = (db) => db.get('dispatcher_alerts/projection_stale_tb_brand');
    // refusal: a sibling member with a malformed identity makes the publish refuse
    let db = world(); db.root.brands.tb_brand.locations.tb_mal = 'member'; db.root.restaurants.tb_mal = { identity: ident('tb_brand', 'Mal', { zone: 'x' }) };
    let r = await C.updateBranchProfileCore(deps(db), req('ownerTB', { rid: 'tb_sur', expectedVersion: 3, patch: { prep_default_min: 30 } }));
    assert.deepStrictEqual(r.body, { version: 4, lifecycle: 'identity', projection: 'deferred' }, 'PUBLISH-REFUSED the mutation stands');
    assert.strictEqual(db.get('restaurants/tb_sur/identity/prep_default_min'), 30);
    assert.deepStrictEqual([alert(db).reason, alert(db).count, alert(db).rid], ['refused', 1, 'tb_sur']);
    r = await C.updateBranchProfileCore(deps(db), req('ownerTB', { rid: 'tb_sur', expectedVersion: 4, patch: { prep_default_min: 31 } }));
    assert.strictEqual(alert(db).count, 2, 'a second failure → still ONE record, count 2');
    // exception
    db = world(); const ref = db.ref; db.ref = (p) => (String(p).startsWith('public/') ? { once: async () => { throw new Error('boom'); }, transaction: async () => { throw new Error('boom'); } } : ref(p));
    r = await C.updateBranchProfileCore(deps(db), req('ownerTB', { rid: 'tb_sur', expectedVersion: 3, patch: { prep_default_min: 30 } }));
    assert.ok(alert(db), 'PUBLISH-EXCEPTION an exception writes the alert');
    assert.deepStrictEqual([r.status, r.body.projection, alert(db).reason], [200, 'deferred', 'exception'], 'PUBLISH-EXCEPTION');
    // timeout: the publish transaction hangs
    db = world(); db.hooks['public/brands/tb_brand'] = () => new Promise(() => {});
    r = await C.updateBranchProfileCore(deps(db, { publishTimeoutMs: 30 }), req('ownerTB', { rid: 'tb_sur', expectedVersion: 3, patch: { prep_default_min: 30 } }));
    assert.ok(alert(db), 'PUBLISH-TIMEOUT a timeout writes the alert');
    assert.deepStrictEqual([r.status, r.body.projection, alert(db).reason], [200, 'deferred', 'timeout'], 'PUBLISH-TIMEOUT');
    // concurrent mutations: both commit, fencing keeps the newer source
    db = world();
    const [a, b] = await Promise.all([
      C.updateBranchProfileCore(deps(db), req('ownerTB', { rid: 'tb_sur', expectedVersion: 3, patch: { prep_default_min: 30 } })),
      C.setBranchActiveCore(deps(db), req('ownerTB', { rid: 'tb_este', expectedVersion: 1, active: true })),
    ]);
    assert.deepStrictEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
    assert.deepStrictEqual(db.get('public/brands/tb_brand/source/versions'), { tb_sur: 4, tb_este: 2 }, 'the stored projection carries the NEWEST versions of both');
    assert.strictEqual(alert(db), null);
    ok('publishAfterCommit: refusal / exception / timeout → the mutation stands, reply `deferred`, ONE projection_stale record (count); concurrent publishers → the newest source wins');
  }

  // ── Codex build r1: #1 committed deactivation + failing consequence reads; #3 a stalled ALERT write; #4 E6 replay after
  //    materialize; #5 an UNENRICHED legacy singleton ──
  {
    // #1
    let db = world(); const ref1 = db.ref;
    db.ref = (p) => (p === 'restaurants/tb_sur/handhelds' ? { once: async () => { throw new Error('reads down'); } } : ref1(p));
    let r = await C.setBranchActiveCore(deps(db), req('ownerTB', { rid: 'tb_sur', expectedVersion: 3, active: false }));
    assert.deepStrictEqual(r, { status: 200, body: { ok: true, state: 'inactive', consequences: null, projection: 'published' } }, 'R1-COMMITTED-PUBLISHED a failed consequence read keeps the committed outcome and still publishes');
    assert.deepStrictEqual([db.get('restaurants/tb_sur/identity/active'), db.get('public/brands/tb_brand/locations/tb_sur/active')], [false, false], 'identity AND projection inactive');
    // #3: the publish refuses (a malformed sibling member) AND the alert transaction stalls → the reply still comes, deferred
    db = world(); db.root.brands.tb_brand.locations.tb_mal = 'member'; db.root.restaurants.tb_mal = { identity: ident('tb_brand', 'Mal', { zone: 'x' }) };
    db.hooks['dispatcher_alerts/projection_stale_tb_brand'] = () => new Promise(() => {});
    const t3 = Promise.race([C.updateBranchProfileCore(deps(db, { publishTimeoutMs: 30 }), req('ownerTB', { rid: 'tb_sur', expectedVersion: 3, patch: { prep_default_min: 30 } })),
      new Promise((resolve) => setTimeout(() => resolve('HUNG'), 1000))]);
    r = await t3;
    assert.notStrictEqual(r, 'HUNG', 'R3-ALERT-BOUNDED a stalled alert transaction never holds the reply');
    assert.deepStrictEqual(r.body, { version: 4, lifecycle: 'identity', projection: 'deferred' });
    // #4: create → Sherpa materializes → the IDENTICAL create replayed
    db = world(); db.root.platform_config.service_bounds = { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 };
    const c1 = await C.createBranchDraftCore(deps(db), req('ownerTB', createBody()));
    assert.strictEqual(c1.body.state, 'draft');
    const m = await S.materializeBranch(db, { rid: c1.body.rid, location: { hub: { lat: 15.51, lng: -88.03 }, address_line: 'Blvd 1' }, now: NOW + 500, clock: () => NOW + 500 });
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    r = await C.createBranchDraftCore(deps(db), req('ownerTB', createBody()));
    assert.deepStrictEqual(r, { status: 200, body: { rid: c1.body.rid, state: 'staged', version: 1 } }, 'R4-REPLAY-MATERIALIZED the current lifecycle + the identity token');
    // #5: an UNENRICHED legacy singleton (no identity.brand_id; resolved through brands/{rid})
    db = world(); delete db.root.restaurants.x_leg.identity.brand_id; db.root.restaurants.x_leg.identity.location_name = undefined; delete db.root.restaurants.x_leg.identity.location_name;
    const before = snap(db);
    for (const active of [false, true]) {
      assert.deepStrictEqual(await C.setBranchActiveCore(deps(db), req('ownerLG', { rid: 'x_leg', expectedVersion: 3, active })), { status: 409, body: { error: 'legacy_branch' } }, `R5-LEGACY-UNENRICHED active:${active}`);
    }
    assert.strictEqual(snap(db), before, 'nothing written');
    ok('Codex build r1: a committed deactivation survives failed consequence reads (null counts, published); a stalled alert write never holds the reply; an E6 replay after materialize returns the staged identity token; an UNENRICHED legacy singleton → legacy_branch both ways');
  }

  FINISHED = true;
  console.log(`\nbranch-lifecycle-core: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
