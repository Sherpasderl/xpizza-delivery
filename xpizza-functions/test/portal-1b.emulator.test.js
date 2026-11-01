'use strict';
// PORTAL-UI 1b (PLAN-portal-ui-slice1b-sucursales r4 §6 «Emulator») — the PORTAL's own request builders (xpizza-portal/api.js:
// createBranchDraft / updateBranchProfile / setBranchActive / deleteBranchDraft / getMyBranches) driven against the REAL exported
// O1b handlers (portal/ops-functions.js) behind a real HTTP server, with EMULATOR-ISSUED ID tokens, on the RTDB + Auth emulators.
// Every request body is built by api.js (memory: test-must-originate-from-real-writer) — the fetch the portal calls is only
// re-pointed from the production base URL to the local server; method, headers and body pass through untouched. The token every
// write echoes is the one the last E1 returned (opaque). Fixtures through the REAL writers (createBrandWithDraft, mutateRoster,
// the invite → accept path, materializeBranch, activateBrand, pairDevice + heartbeat).
// Run (ask the advisor for the slot): PATH="/opt/homebrew/opt/openjdk/bin:$PATH" \
//   node tools/emulator-run.js --only database,auth --project demo-xpizza "node test/portal-1b.emulator.test.js"
//
//   P1  a draft's life from the portal: E1 lists it → E7 (draft token; a `location_name` handed to the builder never reaches the
//       wire) → E6 (exactly the six keys) → E1 lists the new draft → E10 with E1's token
//   P2  E8 from the portal: Sherpa materializes + opens the brand; readiness met → activate → deactivate → reactivate, each
//       +1 version on E1; the reply's consequences are not needed by the portal
//   P3  a manager's three-group patch (phone + hours + prep) → ONE 200, ONE version bump; a STAFF caller (a real read-only role)
//       through the same builder → 403 not_authorized, nothing written
//   P4  W off → every portal write builder → 503 writes_disabled, nothing written
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');

require('./_emulator-required')('database', 'auth');   // BEFORE any Admin import — refuses a production target
if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) { console.error('🔴 REFUSED — FIREBASE_AUTH_EMULATOR_HOST not set'); process.exit(2); }
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const ORIGIN = 'https://sherpa-portal.netlify.app';
const PROD_BASE = 'https://us-central1-xpizza-delivery.cloudfunctions.net/';

const OWNER = 'uP1bOwner0001';
const MGR = 'uP1bManager01';
const STAFF = 'uP1bKitchen01';
const AUTH_HOST = () => process.env.FIREBASE_AUTH_EMULATOR_HOST;
const TOK = new Map();
async function tokenOf(uid) {
  if (!TOK.has(uid)) {
    const { getAuth } = require('firebase-admin/auth');
    const custom = await getAuth().createCustomToken(uid);
    const r = await fetch(`http://${AUTH_HOST()}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-key`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
    const j = await r.json();
    assert.ok(r.ok && j.idToken, `the Auth emulator signs ${uid} in (${r.status})`);
    TOK.set(uid, j.idToken);
  }
  return TOK.get(uid);
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
  const { mutateRoster } = require('../access/roster');
  const I = require('../access/invites');
  const D = require('../merchant/merchant-devices');
  const PIO = require('../merchant/merchant-push-io');
  const { resolveBrand } = require('../merchant/merchant-brand');
  const val = async (p) => (await db.ref(p).get()).val();
  const snap = async () => JSON.stringify((await db.ref('/').get()).val());
  await db.ref('/').set(null);

  // ── the portal's api.js, its fetch re-pointed at the real handlers (nothing else changes) ──
  const realFetch = globalThis.fetch;
  const wire = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith(PROD_BASE)) return realFetch(url, opts);
    const fnName = u.slice(PROD_BASE.length).split('?')[0];
    const handler = ops[fnName];
    assert.ok(typeof handler === 'function', `the portal calls an exported handler (${fnName})`);
    wire.push({ fn: fnName, body: opts.body ? JSON.parse(opts.body) : null });
    const express = require('express');
    const srv = http.createServer((req, res) => { const a = express(); a.use(express.json()); a.all('*', (rq, rs) => handler(rq, rs)); a(req, res); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const q = u.includes('?') ? u.slice(u.indexOf('?')) : '';
      const r = await realFetch(`http://127.0.0.1:${srv.address().port}/${q}`, { method: opts.method, headers: { ...opts.headers, Origin: ORIGIN }, body: opts.body });
      const text = await r.text();
      return { ok: r.ok, status: r.status, json: async () => (text ? JSON.parse(text) : null), text: async () => text, headers: r.headers };
    } finally { await new Promise((r) => srv.close(r)); }
  };
  const api = await import(pathToFileURL(path.join(__dirname, '../../xpizza-portal/api.js')).href);
  const as = (uid) => () => tokenOf(uid);
  const e1Of = async (uid) => api.getMyBranches({ token: as(uid) });
  const refused = async (p) => { try { await p; return null; } catch (e) { return { status: e.status, code: e.code }; } };

  // ── seed through the real writers ──
  await db.ref('platform_config').set({ membership_writes_enabled: true, handheld_pairing_enabled: true, service_bounds: { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 } });
  assert.deepStrictEqual(await S.createBrandWithDraft(db, { brandId: 'marca_s', brandName: 'Marca S', input: { location_name: 'Centro', phone: '+50431234567', hours: H7, prep_default_min: 20 }, opId: 'create_marca_s', callerUid: 'sherpa', now: Date.now() }), { ok: true, rid: 'marca_s_centro' });
  const cli = { kind: 'cli', operator: 'portal-1b-test' };
  assert.ok((await mutateRoster({ db }, 'marca_s', cli, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Dueña S', email: 'duena@p1b.test' } })).ok);
  ok('seeded through the real writers: a NEW brand + its first draft (createBrandWithDraft), the owner (mutateRoster)');

  // ── P1 a draft's life from the portal ──
  {
    let e1 = await e1Of(OWNER);
    const b = e1.brands.find((x) => x.brand_id === 'marca_s');
    assert.deepStrictEqual([b.caps, b.drafts.map((d) => d.rid)], [['brand.locations'], ['marca_s_centro']], 'E1: the draft-only brand + its draft');
    const tok = b.drafts[0].version;
    const r7 = await api.updateBranchProfile({ rid: 'marca_s_centro', expectedVersion: tok, patch: { prep_default_min: 25, location_name: 'Plaza', hub: { lat: 1, lng: 1 } }, token: as(OWNER) });
    assert.strictEqual(r7.lifecycle, 'draft');
    const sent7 = wire.filter((w) => w.fn === 'updateBranchProfile').pop().body;
    assert.deepStrictEqual(sent7, { rid: 'marca_s_centro', expectedVersion: tok, patch: { prep_default_min: 25 } }, 'the builder never puts location_name / hub on the wire');
    const r6 = await api.createBranchDraft({ opId: 'p1bNorte01', brandId: 'marca_s', locationName: 'Norte', phone: '+50471234567', hours: H7, prepDefaultMin: 20, token: as(OWNER) });
    assert.strictEqual(r6.state, 'draft');
    assert.deepStrictEqual(Object.keys(wire.filter((w) => w.fn === 'createBranchDraft').pop().body).sort(), [...api.E6_KEYS].sort());
    e1 = await e1Of(OWNER);
    const nd = e1.brands.find((x) => x.brand_id === 'marca_s').drafts.find((d) => d.rid === r6.rid);
    assert.ok(nd && typeof nd.version === 'string', 'E1 lists the new draft with its token');
    assert.deepStrictEqual(await api.deleteBranchDraft({ rid: r6.rid, expectedVersion: nd.version, token: as(OWNER) }), { ok: true });
    assert.strictEqual(await val(`restaurants/${r6.rid}/draft`), null);
    ok('P1 the portal builders: E1 draft → E7 (draft token; location_name / hub never on the wire) → E6 (exactly E6_KEYS) → E1 → E10 with E1\'s token');
  }

  // ── P2 E8 from the portal ──
  {
    assert.strictEqual((await S.materializeBranch(db, { rid: 'marca_s_centro', location: { hub: { lat: 15.51, lng: -88.03 }, address_line: 'Blvd 1' }, now: Date.now(), callId: 'materialize_p1b' })).ok, true);
    await db.ref('menus/marca_s').set({ published: true });
    assert.ok((await S.activateBrand(db, { brandId: 'marca_s', open: [], now: Date.now(), readers: {} })).ok);
    class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
    const hdeps = () => ({ db, adminAuth: getAuth(), resolveBrand, HttpsError, now: () => Date.now(), timestamp: () => ServerValue.TIMESTAMP,
      newOpId: () => `oc_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`, randomId: () => crypto.randomBytes(6).toString('hex'), newClaim: PIO.newClaim });
    await db.ref('restaurants/marca_s_centro/order_surface').set('handheld');
    const dev = (await D.pairDevice(hdeps(), { uid: OWNER, token: {} }, { rid: 'marca_s_centro', label: 'Equipo 1' })).uid;
    await D.heartbeat(hdeps(), { uid: dev, token: { handheld: true, rid: 'marca_s_centro' } }, { rid: 'marca_s_centro' });
    let row = (await e1Of(OWNER)).branches.find((r) => r.rid === 'marca_s_centro');
    assert.deepStrictEqual([row.lifecycle, row.readiness], ['staged', { unmet: [] }], 'E1: staged and ready');
    const v0 = row.version;
    for (const [active, life] of [[true, 'active'], [false, 'inactive'], [true, 'active']]) {
      const r = await api.setBranchActive({ rid: 'marca_s_centro', expectedVersion: row.version, active, token: as(OWNER) });
      assert.strictEqual(r.ok, true);
      const next = (await e1Of(OWNER)).branches.find((x) => x.rid === 'marca_s_centro');
      assert.deepStrictEqual([next.lifecycle, next.version], [life, row.version + 1], `${life}: E1 shows it, version +1`);
      row = next;
    }
    assert.strictEqual(row.version, v0 + 3);
    ok('P2 E8 through the portal builder with E1\'s integer token: activate → deactivate → reactivate, each +1 version on E1');
  }

  // ── P3 a manager's three-group patch; a STAFF caller refused ──
  {
    const inv = await I.createInvite({ db, randomToken: () => crypto.randomBytes(24).toString('base64url') }, { uid: OWNER, token: {} }, { brandId: 'marca_s', rids: ['marca_s_centro'], email: 'gerente@p1b.test', name: 'Gerente S' });
    assert.strictEqual(inv.ok, true, JSON.stringify(inv));
    assert.deepStrictEqual(await I.acceptInvite({ db }, { uid: MGR, token: { email: 'gerente@p1b.test', email_verified: true } }, inv.inviteId), { ok: true, outcome: 'granted' });
    const row = (await e1Of(MGR)).branches.find((r) => r.rid === 'marca_s_centro');
    const H2 = { ...H7, mon: DAY };
    await api.updateBranchProfile({ rid: 'marca_s_centro', expectedVersion: row.version, patch: { phone: '+50433905521', hours: H2, prep_default_min: 30 }, token: as(MGR) });
    const id = await val('restaurants/marca_s_centro/identity');
    assert.deepStrictEqual([id.phone, id.hours.mon, id.prep_default_min, id.version], ['+50433905521', DAY, 30, row.version + 1], 'ONE write, ONE version bump');
    await db.ref(`restaurants/marca_s_centro/kitchen_staff/${STAFF}`).set(true);
    const before = await snap();
    assert.deepStrictEqual(await refused(api.updateBranchProfile({ rid: 'marca_s_centro', expectedVersion: id.version, patch: { prep_default_min: 35 }, token: as(STAFF) })), { status: 403, code: 'not_authorized' });
    assert.strictEqual(await snap(), before, 'nothing written');
    ok('P3 a manager\'s phone + hours + prep through ONE E7 → one version bump; a STAFF caller through the same builder → 403 not_authorized, nothing written');
  }

  // ── P4 W off ──
  {
    await db.ref('platform_config/membership_writes_enabled').set(false);
    const e1 = await e1Of(OWNER);
    assert.strictEqual(e1.membership_writes_enabled, false, 'E1 tells the portal W is off');
    const row = e1.branches.find((r) => r.rid === 'marca_s_centro');
    const before = await snap();
    for (const go of [   // one call at a time: each request is made only when it is awaited (no unhandled rejection)
      () => api.createBranchDraft({ opId: 'p1bGate01', brandId: 'marca_s', locationName: 'Gate', phone: '+50431234567', hours: H7, prepDefaultMin: 20, token: as(OWNER) }),
      () => api.updateBranchProfile({ rid: 'marca_s_centro', expectedVersion: row.version, patch: { prep_default_min: 22 }, token: as(OWNER) }),
      () => api.setBranchActive({ rid: 'marca_s_centro', expectedVersion: row.version, active: false, token: as(OWNER) }),
      () => api.deleteBranchDraft({ rid: 'marca_s_centro', expectedVersion: 'd.x.y.0', token: as(OWNER) }),
    ]) assert.deepStrictEqual(await refused(go()), { status: 503, code: 'writes_disabled' });
    assert.strictEqual(await snap(), before, 'nothing written');
    ok('P4 W off → every portal write builder → 503 writes_disabled (the UI hides them, §3.0), nothing written');
  }

  console.log(`\nportal-1b(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
