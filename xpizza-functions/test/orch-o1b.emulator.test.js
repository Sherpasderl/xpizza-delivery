'use strict';
// ORCHESTRATION O1b (PLAN-orch-o1b r3 §4) — the slice-1b lifecycle endpoints THROUGH THE REAL EXPORTED HANDLERS
// (portal/ops-functions.js — the objects index.js re-exports), behind a real HTTP server, with EMULATOR-ISSUED ID tokens verified
// by the real Admin SDK, against the RTDB + Auth emulators. Fixtures come from the REAL writers: a NEW brand via O1a's
// createBrandWithDraft, its location via the Sherpa materializeBranch, its owner / managers via roster.mutateRoster and the REAL
// invite → accept path, devices via the REAL pairDevice core.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:orch-o1b
//
//   C1  the authority matrix (owner / manager / other-brand owner / dispatcher / customer / handheld × E6 / E7 / E8 / E10)
//   C2  a draft's life: E1 lists it (pending_location) → E7 edit (draft token) → rename_cli_only → E10 with a stale token →
//       Sherpa materializes → the draft screen's token is stale on E7 → E10 → not_a_draft
//   C3  a STAGED branch's team before opening: the owner invites a manager → the invitee ACCEPTS → the manager pairs a handheld →
//       lists it (getBranchDevices) → revokes it (revokeBranchDevice); location.pause stays refused
//   C4  E8: not_ready with identity_gaps (E1 shows the same) → fixed → activate (member, projection published) → deactivate
//       (consequences) → reactivate; R-LEGACY both directions → 409 legacy_branch, nothing written
//   C5  the write gate: flag off → 503 writes_disabled on E6 / E7 / E8 / E10, nothing written
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

require('./_emulator-required')('database', 'auth');   // BEFORE any Admin import — refuses a production target
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) { console.error('🔴 REFUSED — FIREBASE_AUTH_EMULATOR_HOST not set (run via npm run test:orch-o1b)'); process.exit(2); }
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const ORIGIN = 'https://sherpa-portal.netlify.app';

const OWNER = 'uO1bOwner0001';      // owner of the NEW brand tb_nuevo
const OWNER_L = 'uO1bOwnerLeg1';    // owner of the legacy singleton tb_leg
const MGR = 'uO1bManager01';        // invited + accepted manager of tb_nuevo's staged branch
const DISP = 'uO1bDispatch1';
const STRANGER = 'uO1bStranger1';
const AUTH_HOST = () => process.env.FIREBASE_AUTH_EMULATOR_HOST;
const TOK = new Map();
async function tokenOf(uid, claims = {}) {
  const k = `${uid}|${JSON.stringify(claims)}`;
  if (!TOK.has(k)) {
    const { getAuth } = require('firebase-admin/auth');
    const custom = await getAuth().createCustomToken(uid, Object.keys(claims).length ? claims : undefined);
    const r = await fetch(`http://${AUTH_HOST()}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-key`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
    const j = await r.json();
    assert.ok(r.ok && j.idToken, `the Auth emulator signs ${uid} in (${r.status})`);
    TOK.set(k, j.idToken);
  }
  return TOK.get(k);
}
async function call(fn, { method = 'POST', query = '', body, uid, claims } = {}) {
  const express = require('express');
  const srv = http.createServer((req, res) => { const a = express(); a.use(express.json()); a.all('*', (rq, rs) => fn(rq, rs)); a(req, res); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const h = { Origin: ORIGIN };
    if (uid) h.Authorization = `Bearer ${await tokenOf(uid, claims)}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/${query}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) { /* empty */ }
    return { status: r.status, json, text };
  } finally { await new Promise((r) => srv.close(r)); }
}

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const DAY = { open: true, start: '11:00', end: '22:00' };
const H7 = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };

(async () => {
  require('../lib/admin');
  const { getDatabase, ServerValue } = require('firebase-admin/database');
  const { getAuth } = require('firebase-admin/auth');
  const db = getDatabase();
  const ops = require('../portal/ops-functions');
  const S = require('../branches/branch-store');
  const P = require('../branches/branch-ops');
  const { mutateRoster } = require('../access/roster');
  const I = require('../access/invites');
  const D = require('../merchant/merchant-devices');
  const PIO = require('../merchant/merchant-push-io');
  const { resolveBrand } = require('../merchant/merchant-brand');
  const { validateBrand, validateBranchIdentity } = require('../brands/brand-model');
  const val = async (p) => (await db.ref(p).get()).val();
  const snap = async () => JSON.stringify((await db.ref('/').get()).val());
  await db.ref('/').set(null);

  // ── seed through the real writers ──
  await db.ref('platform_config').set({ membership_writes_enabled: true, handheld_pairing_enabled: true, service_bounds: { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 } });
  const cb = await S.createBrandWithDraft(db, { brandId: 'tb_nuevo', brandName: 'Nuevo', input: { location_name: 'Centro', phone: '+50431234567', hours: H7, prep_default_min: 20 }, opId: 'create_tb_nuevo', callerUid: 'sherpa', now: Date.now() });
  assert.deepStrictEqual(cb, { ok: true, rid: 'tb_nuevo_centro' });
  const cli = { kind: 'cli', operator: 'orch-o1b-test' };   // the roster's CLI actor shape (as test/portal-ops.emulator.test.js)
  assert.ok((await mutateRoster({ db }, 'tb_nuevo', cli, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Dueña Nueva', email: 'duena@o1b.test' } })).ok);
  // a legacy singleton (as seed-legacy + enrich-legacy leave it)
  const legId = { name: 'Leg', brand_id: 'tb_leg', location_name: 'Leg', phone: '+50422223333', hours: H7, prep_default_min: 20, hub_lat: 15.5, hub_lng: -88.0,
    zone: { type: 'circle', radius_km: 5 }, delivery_radius_km: 5, whatsapp_instance: '', whatsapp_enabled: false, active: true, version: 3 };
  assert.ok(validateBranchIdentity('tb_leg', legId, 'tb_leg').ok);
  const legBrand = { name: 'Leg', active: true, locations: { tb_leg: 'member' }, activation: { state: 'legacy', since: 1 } };
  assert.ok(validateBrand('tb_leg', legBrand).ok);
  await db.ref('restaurants/tb_leg/identity').set(legId); await db.ref('brands/tb_leg').set(legBrand);
  assert.ok((await mutateRoster({ db }, 'tb_leg', cli, { type: 'bootstrap_owner', uid: OWNER_L, profile: { name: 'Dueño Leg', email: 'leg@o1b.test' } })).ok);
  await db.ref(`dispatchers/${DISP}`).set(true);
  ok('seeded through the real writers: a NEW brand + its first draft (createBrandWithDraft), owners (mutateRoster), a legacy singleton');

  // ── C2 a draft's life ──
  {
    let e1 = await call(ops.getMyBranches, { method: 'GET', uid: OWNER });
    assert.strictEqual(e1.status, 200, e1.text);
    const b = e1.json.brands.find((x) => x.brand_id === 'tb_nuevo');
    assert.deepStrictEqual([b.caps, b.activation, b.drafts.map((d) => [d.rid, d.pending_location])], [['brand.locations'], 'off', [['tb_nuevo_centro', true]]], 'E1 lists the draft-only brand + its draft');
    const t0 = b.drafts[0].version;
    const e7 = await call(ops.updateBranchProfile, { uid: OWNER, body: { rid: 'tb_nuevo_centro', expectedVersion: t0, patch: { prep_default_min: 25 } } });
    assert.strictEqual(e7.status, 200, e7.text); assert.strictEqual(e7.json.lifecycle, 'draft');
    assert.deepStrictEqual((await call(ops.updateBranchProfile, { uid: OWNER, body: { rid: 'tb_nuevo_centro', expectedVersion: e7.json.version, patch: { location_name: 'Plaza' } } })).json, { error: 'rename_cli_only' });
    assert.deepStrictEqual((await call(ops.deleteBranchDraft, { uid: OWNER, body: { rid: 'tb_nuevo_centro', expectedVersion: t0 } })).json, { error: 'stale_branch' }, 'E10 with the pre-edit token');
    // E6: a second draft; the allowlist refuses a location field with nothing written
    const before = await snap();
    assert.deepStrictEqual((await call(ops.createBranchDraft, { uid: OWNER, body: { op_id: 'opNorte01', brand_id: 'tb_nuevo', location_name: 'Norte', phone: '+50471234567', hours: H7, prep_default_min: 20, hub: { lat: 1, lng: 1 } } })).json, { error: 'forbidden_field' });
    assert.strictEqual(await snap(), before, 'E6-ALLOWLIST nothing written (emulator)');
    const e6 = await call(ops.createBranchDraft, { uid: OWNER, body: { op_id: 'opNorte01', brand_id: 'tb_nuevo', location_name: 'Norte', phone: '+50471234567', hours: H7, prep_default_min: 20 } });
    assert.strictEqual(e6.status, 200, e6.text); assert.strictEqual(e6.json.rid, 'tb_nuevo_norte');
    assert.deepStrictEqual((await call(ops.deleteBranchDraft, { uid: OWNER, body: { rid: 'tb_nuevo_norte', expectedVersion: e6.json.version } })).json, { ok: true });
    // Sherpa materializes the first draft → the draft screen's token is stale
    const m = await S.materializeBranch(db, { rid: 'tb_nuevo_centro', location: { hub: { lat: 15.51, lng: -88.03 }, address_line: 'Blvd 1' }, now: Date.now(), callId: 'materialize_o1b_test' });   // O1a: the CLI always passes a callId
    assert.strictEqual(m.ok, true, JSON.stringify(m));
    assert.deepStrictEqual((await call(ops.updateBranchProfile, { uid: OWNER, body: { rid: 'tb_nuevo_centro', expectedVersion: e7.json.version, patch: { prep_default_min: 30 } } })).json, { error: 'stale_branch' }, 'a stale DRAFT screen after materialize');
    assert.deepStrictEqual((await call(ops.deleteBranchDraft, { uid: OWNER, body: { rid: 'tb_nuevo_centro', expectedVersion: e7.json.version } })).json, { error: 'not_a_draft' });
    assert.strictEqual(await val('restaurants/tb_nuevo_centro/identity/prep_default_min'), 25, 'materialize carried the edited draft');
    ok('C2 a draft\'s life through the real handlers: E1 lists it, E7 draft token, rename_cli_only, stale E10, E6 allowlist (nothing written), Sherpa materialize → stale draft token');
  }

  // ── C3 a STAGED branch's team before opening: invite → accept → pair → list → revoke ──
  {
    const inv = await I.createInvite({ db, randomToken: () => crypto.randomBytes(24).toString('base64url') }, { uid: OWNER, token: {} }, { brandId: 'tb_nuevo', rids: ['tb_nuevo_centro'], email: 'gerente@o1b.test', name: 'Gerente Prueba' });
    assert.strictEqual(inv.ok, true, `STAGED-INVITE ${JSON.stringify(inv)}`);
    const acc = await I.acceptInvite({ db }, { uid: MGR, token: { email: 'gerente@o1b.test', email_verified: true } }, inv.inviteId);
    assert.deepStrictEqual(acc, { ok: true, outcome: 'granted' }, 'the invitee accepts → a manager of the STAGED branch');
    class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
    const hdeps = () => ({ db, adminAuth: getAuth(), resolveBrand, HttpsError, now: () => Date.now(), timestamp: () => ServerValue.TIMESTAMP,
      newOpId: () => `oc_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`, randomId: () => crypto.randomBytes(6).toString('hex'), newClaim: PIO.newClaim });
    await db.ref('restaurants/tb_nuevo_centro/order_surface').set('handheld');
    const dev = (await D.pairDevice(hdeps(), { uid: MGR, token: {} }, { rid: 'tb_nuevo_centro', label: 'Equipo de la sucursal' })).uid;
    assert.ok(dev, 'the manager pairs a handheld on the staged branch');
    const list = await call(ops.getBranchDevices, { method: 'GET', query: '?restaurantId=tb_nuevo_centro', uid: MGR });
    assert.strictEqual(list.status, 200, `the manager LISTS it: ${list.text}`);
    assert.deepStrictEqual(list.json.branches[0].devices.map((d) => d.uid), [dev], 'the manager LISTS it');
    const rv = await call(ops.revokeBranchDevice, { uid: MGR, body: { rid: 'tb_nuevo_centro', uid: dev } });
    assert.strictEqual(rv.status, 200, `the manager REVOKES it: ${rv.text}`);
    assert.strictEqual((await call(ops.setBranchPause, { uid: MGR, body: { rid: 'tb_nuevo_centro', op: 'pause', dur_min: 30, reason: 'Otro' } })).status, 403, 'location.pause stays refused on staged');
    // pair again for readiness, with a heartbeat
    const dev2 = (await D.pairDevice(hdeps(), { uid: MGR, token: {} }, { rid: 'tb_nuevo_centro', label: 'Equipo 2' })).uid;
    await D.heartbeat(hdeps(), { uid: dev2, token: { handheld: true, rid: 'tb_nuevo_centro' } }, { rid: 'tb_nuevo_centro' });
    ok('C3 a staged branch: the owner invites → the invitee accepts → the manager pairs, LISTS and REVOKES a handheld (real cores + handlers); pause refused');
  }

  // ── C4 E8: gaps → fixed → activate → deactivate → reactivate; R-LEGACY ──
  {
    await db.ref('menus/tb_nuevo').set({ published: true });
    assert.ok((await S.activateBrand(db, { brandId: 'tb_nuevo', open: [], now: Date.now(), readers: {} })).ok, 'Sherpa takes the NEW brand off → on (no branch opened)');
    await db.ref('restaurants/tb_nuevo_centro/identity/prep_default_min').set(3);
    const v = await val('restaurants/tb_nuevo_centro/identity/version');
    const e1row = (await call(ops.getMyBranches, { method: 'GET', uid: OWNER })).json.branches.find((r) => r.rid === 'tb_nuevo_centro');
    const nr = await call(ops.setBranchActive, { uid: OWNER, body: { rid: 'tb_nuevo_centro', expectedVersion: v, active: true } });
    assert.deepStrictEqual(nr.json, { error: 'not_ready', unmet: ['identity_invalid'], identity_gaps: ['prep'] }, 'E8 not_ready with the gap');
    assert.deepStrictEqual(e1row.readiness, { unmet: ['identity_invalid'], identity_gaps: ['prep'] }, 'E1 shows the SAME readiness');
    const fix = await call(ops.updateBranchProfile, { uid: MGR, body: { rid: 'tb_nuevo_centro', expectedVersion: v, patch: { prep_default_min: 20 } } });
    assert.strictEqual(fix.status, 200, fix.text);
    const on = await call(ops.setBranchActive, { uid: OWNER, body: { rid: 'tb_nuevo_centro', expectedVersion: fix.json.version, active: true } });
    assert.deepStrictEqual(on.json, { ok: true, state: 'active', projection: 'published' }, on.text);
    assert.strictEqual(await val('brands/tb_nuevo/locations/tb_nuevo_centro'), 'member');
    assert.strictEqual(await val('public/brands/tb_nuevo/locations/tb_nuevo_centro/active'), true);
    const off = await call(ops.setBranchActive, { uid: OWNER, body: { rid: 'tb_nuevo_centro', expectedVersion: fix.json.version + 1, active: false } });
    assert.deepStrictEqual([off.json.ok, off.json.state, off.json.consequences.devices, off.json.projection], [true, 'inactive', 1, 'published']);
    const re = await call(ops.setBranchActive, { uid: OWNER, body: { rid: 'tb_nuevo_centro', expectedVersion: fix.json.version + 2, active: true } });
    assert.deepStrictEqual(re.json, { ok: true, state: 'active', projection: 'published' }, 'reversible');
    const before = await snap();
    assert.deepStrictEqual((await call(ops.setBranchActive, { uid: OWNER_L, body: { rid: 'tb_leg', expectedVersion: 3, active: false } })).json, { error: 'legacy_branch' });
    assert.deepStrictEqual((await call(ops.setBranchActive, { uid: OWNER_L, body: { rid: 'tb_leg', expectedVersion: 3, active: true } })).json, { error: 'legacy_branch' });
    assert.strictEqual(await snap(), before, 'R-LEGACY nothing written');
    ok('C4 E8 through the real handlers: not_ready + identity_gaps (== E1) → a manager fixes prep → activate (member, projection) → deactivate → reactivate; legacy refused both ways, nothing written');
  }

  // ── C1 the authority matrix ──
  {
    const v = await val('restaurants/tb_nuevo_centro/identity/version');
    const calls = {
      E6: (uid, claims) => call(ops.createBranchDraft, { uid, claims, body: { op_id: 'opMatrix1', brand_id: 'tb_nuevo', location_name: 'Matriz', phone: '+50431234567', hours: H7, prep_default_min: 20 } }),
      E7: (uid, claims) => call(ops.updateBranchProfile, { uid, claims, body: { rid: 'tb_nuevo_centro', expectedVersion: v, patch: { hours: H7, prep_default_min: 21 } } }),
      E8: (uid, claims) => call(ops.setBranchActive, { uid, claims, body: { rid: 'tb_nuevo_centro', expectedVersion: v, active: false } }),
      E10: (uid, claims) => call(ops.deleteBranchDraft, { uid, claims, body: { rid: 'tb_nuevo_centro', expectedVersion: 'd.x.y.0' } }),
    };
    const before = await snap();
    for (const [who, claims] of [[MGR, {}], [OWNER_L, {}], [DISP, {}], [STRANGER, {}], [OWNER, { customer: true }], [OWNER, { handheld: true, rid: 'tb_nuevo_centro' }]]) {
      for (const [ep, fn] of Object.entries(calls)) {
        if (ep === 'E7' && who === MGR && !Object.keys(claims).length) continue;   // a manager MAY edit hours / prep (asserted in C4)
        const r = await fn(who, claims);
        assert.ok([403, 409].includes(r.status) && r.status !== 200, `MATRIX ${ep} ${who} ${JSON.stringify(claims)} → ${r.status} ${r.text}`);
      }
    }
    assert.strictEqual(await snap(), before, 'MATRIX nothing written by any refused caller');
    ok('C1 the authority matrix: manager / other-brand owner / dispatcher / stranger / customer / handheld × E6 / E7 / E8 / E10 → refused, nothing written');
  }

  // ── C5 the write gate ──
  {
    await db.ref('platform_config/membership_writes_enabled').set(false);
    const before = await snap();
    const v = await val('restaurants/tb_nuevo_centro/identity/version');
    for (const r of [
      await call(ops.createBranchDraft, { uid: OWNER, body: { op_id: 'opGate001', brand_id: 'tb_nuevo', location_name: 'Gate', phone: '+50431234567', hours: H7, prep_default_min: 20 } }),
      await call(ops.updateBranchProfile, { uid: OWNER, body: { rid: 'tb_nuevo_centro', expectedVersion: v, patch: { prep_default_min: 22 } } }),
      await call(ops.setBranchActive, { uid: OWNER, body: { rid: 'tb_nuevo_centro', expectedVersion: v, active: false } }),
      await call(ops.deleteBranchDraft, { uid: OWNER, body: { rid: 'tb_nuevo_centro', expectedVersion: 'd.x.y.0' } }),
    ]) assert.deepStrictEqual([r.status, r.json], [503, { error: 'writes_disabled' }]);
    assert.strictEqual(await snap(), before, 'GATE nothing written');
    ok('C5 the write gate off → 503 writes_disabled on E6 / E7 / E8 / E10, nothing written');
  }

  console.log(`\norch-o1b(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
