'use strict';
// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5 §8) — the five branch-ops endpoints THROUGH THE REAL EXPORTED HANDLERS
// (portal/ops-functions.js, the same objects index.js re-exports), behind a real HTTP server with the cors middleware, with
// real (emulator-format) ID tokens verified by the real Admin SDK, against the Firestore + RTDB emulators.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:branch-ops
//
// Fixtures come from the REAL writers wherever one exists:
//   identities   seed_identity.js's IDENTITIES + assertIdentityShape (the seed's own validate-then-set), and fixture
//                identities for the synthetic brands checked with brand-model.validateBranchIdentity;
//   brands       brand-store planSeedLegacy/applySeedLegacy for the legacy singletons; the synthetic multi-branch brand has
//                NO writer yet (5f lane) — its record is validated with validateBrand before the write;
//   membership   access/roster.mutateRoster (bootstrap_owner from the CLI actor, grant_manager from the owner);
//   menus        catalog-publish.publishVersion with tools/publish-version's real candidates.
// The synthetic brand «tencha» (two branches with DIFFERENT published keys + one retired branch) and the single-branch «solo»
// are the brand-agnostic proof (no code path names a real brand).
const assert = require('assert');
const path = require('path');
const http = require('http');

require('./_emulator-required')('firestore', 'database');   // BEFORE any Admin import — refuses a production target
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const PROJECT = process.env.GCLOUD_PROJECT;
const ORIGIN = 'https://sherpa-portal.netlify.app';

const OWNER = 'uOpsOwner0001';        // x_pizza + la_musa (legacy singletons)
const OWNER_T = 'uOpsOwnerT001';      // tencha (two branches + one retired)
const OWNER_S = 'uOpsOwnerS001';      // solo (synthetic singleton) + ghost (no identity)
const MGR = 'uOpsManager01';          // manager of tencha_norte, no menu permission
const MGR_MENU = 'uOpsManager02';     // manager of tencha_centro, WITH menu permission
const DISP = 'uOpsDispatch1';
const STAFF = 'uOpsStaff0001';
const STRANGER = 'uOpsStranger1';
const USERS = new Set([OWNER, OWNER_T, OWNER_S, MGR, MGR_MENU, DISP, STAFF, STRANGER]);

function startAuthStandIn() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.method === 'POST' && /\/accounts:lookup$/.test(req.url)) {
          const ids = (JSON.parse(raw || '{}').localId) || [];
          const users = ids.filter((u) => USERS.has(u)).map((u) => ({ localId: u, email: `${u}@example.test`, disabled: false, providerUserInfo: [] }));
          res.writeHead(users.length ? 200 : 400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(users.length ? { kind: 'identitytoolkit#GetAccountInfoResponse', users } : { error: { code: 400, message: 'USER_NOT_FOUND' } }));
        }
        res.writeHead(404); res.end();
      });
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (uid, claims = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, auth_time: now, user_id: uid, sub: uid, iat: now, exp: now + 3600, email: `${uid}@example.test`, firebase: { identities: {}, sign_in_provider: 'password' }, ...claims })}.`;
};
async function call(fn, { method = 'GET', query = '', body, uid, claims, origin = ORIGIN } = {}) {
  const express = require('express');
  const srv = http.createServer((req, res) => { const a = express(); a.use(express.json()); a.all('*', (rq, rs) => fn(rq, rs)); a(req, res); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const h = {};
    if (origin) h.Origin = origin;
    if (uid) h.Authorization = `Bearer ${idToken(uid, claims)}`;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/${query}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) { /* empty */ }
    return { status: r.status, json, text };
  } finally { await new Promise((r) => srv.close(r)); }
}

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (v) => JSON.parse(JSON.stringify(v));

(async () => {
  const authSrv = await startAuthStandIn();
  process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${authSrv.address().port}`;
  const ops = require('../portal/ops-functions');
  const { getFirestore } = require('firebase-admin/firestore');
  const { getDatabase, ServerValue } = require('firebase-admin/database');
  const fs = getFirestore();
  const db = getDatabase();
  await db.ref('/').set(null);
  const wipe = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
  assert.ok(wipe.ok, 'firestore emulator wiped');

  // ── seeds (real writers) ──────────────────────────────────────────────────────────────────────────────────────────────
  const { IDENTITIES, assertIdentityShape } = require('../seed_identity');
  for (const rid of ['x_pizza', 'la_musa']) { const id = clone(IDENTITIES[rid]); id.whatsapp_instance = id.whatsapp_instance || ''; assertIdentityShape(rid, id); await db.ref(`restaurants/${rid}/identity`).set(id); }
  const BS = require('../brands/brand-store');
  for (const rid of ['x_pizza', 'la_musa']) {
    const plan = BS.planSeedLegacy({ rid, identity: (await db.ref(`restaurants/${rid}/identity`).get()).val(), existing: null, nowMs: 1 });
    assert.ok(plan.ok, JSON.stringify(plan));
    assert.ok((await BS.applySeedLegacy(db, plan)).ok);
  }
  const F1 = require('../brands/brand-model');
  const hours = clone(IDENTITIES.x_pizza.hours);
  const synth = (rid, brand, name, extra = {}) => ({ name, hub_lat: 15.51, hub_lng: -88.02, phone: '+50400000000', whatsapp_instance: '', whatsapp_enabled: false,
    delivery_radius_km: 3.5, zone: { type: 'circle', radius_km: 3.5 }, hours, active: true, version: 4, brand_id: brand, location_name: name, ...extra });
  const tencha = { name: 'Marca de Prueba', active: true, locations: { tencha_centro: 'member', tencha_norte: 'member', tencha_viejo: 'retired' }, activation: { state: 'on', since: 1 } };
  assert.ok(F1.validateBrand('tencha', tencha).ok, 'the synthetic brand record validates');
  const tIds = {
    tencha_centro: synth('tencha_centro', 'tencha', 'Centro', { prep_default_min: 20, uses_platform_factura: false }),
    tencha_norte: synth('tencha_norte', 'tencha', 'Norte'),
    tencha_viejo: synth('tencha_viejo', 'tencha', 'Viejo'),
  };
  for (const [rid, id] of Object.entries(tIds)) {
    const { uses_platform_factura, ...f1 } = id; void uses_platform_factura;
    assert.ok(F1.validateBranchIdentity(rid, { ...f1, prep_default_min: f1.prep_default_min || 20 }, 'tencha').ok, `${rid} fixture identity validates`);
    await db.ref(`restaurants/${rid}/identity`).set(id);
  }
  await db.ref('brands/tencha').set(tencha);
  const soloId = synth('solo', undefined, 'Solo Local'); delete soloId.brand_id; delete soloId.zone; delete soloId.location_name;
  await db.ref('restaurants/solo/identity').set(soloId);
  for (const rid of ['solo']) {
    const plan = BS.planSeedLegacy({ rid, identity: soloId, existing: null, nowMs: 1 });
    assert.ok(plan.ok, JSON.stringify(plan)); assert.ok((await BS.applySeedLegacy(db, plan)).ok);
  }
  await db.ref('brands/ghost').set({ name: 'ghost', active: true, locations: { ghost: 'member' }, activation: { state: 'legacy', since: 1 } });   // a brand with NO identity
  const { mutateRoster } = require('../access/roster');
  const cli = { kind: 'cli', operator: 'portal-ops-test' };
  for (const [b, uid] of [['x_pizza', OWNER], ['la_musa', OWNER], ['tencha', OWNER_T], ['solo', OWNER_S], ['ghost', OWNER_S]]) {
    const r = await mutateRoster({ db }, b, cli, { type: 'bootstrap_owner', uid });
    assert.ok(r.ok, `bootstrap ${b}: ${JSON.stringify(r)}`);
  }
  assert.ok((await mutateRoster({ db }, 'tencha', { kind: 'owner', uid: OWNER_T }, { type: 'grant_manager', uid: MGR, rids: ['tencha_norte'], can_edit_menu: false })).ok);
  assert.ok((await mutateRoster({ db }, 'tencha', { kind: 'owner', uid: OWNER_T }, { type: 'grant_manager', uid: MGR_MENU, rids: ['tencha_centro'], can_edit_menu: true })).ok);
  await db.ref(`dispatchers/${DISP}`).set(true);
  await db.ref(`restaurants/x_pizza/kitchen_staff/${STAFF}`).set(true);
  // menus: the real publisher. tencha_centro serves the la_musa candidate and tencha_norte the x_pizza one → different keys.
  const { publishVersion } = require('../catalog/catalog-publish');
  const { buildPublishCandidate } = require('../tools/publish-version');
  const published = {};
  // A non-legacy rid is NAME-keyed, so both synthetic branches publish the x_pizza candidate; tencha_norte renames one item
  // (its key + display name, everywhere the key appears) so the two branches publish DIFFERENT keys.
  const renamed = (input) => {
    const json = JSON.stringify(input.structure);
    const it = input.items.find((x) => json.split(JSON.stringify(x.key)).length === 2);   // a key named only once (item_order)
    assert.ok(it, 'premise: an item referenced only by item_order');
    const to = `${it.key} Norte`;
    const out = clone(input);
    out.structure = JSON.parse(json.split(JSON.stringify(it.key)).join(JSON.stringify(to)));
    const o = out.items.find((x) => x.key === it.key); o.key = to; o.display.name = to;
    if (o.display.id === it.key) o.display.id = to;
    return out;
  };
  for (const [rid, from, tweak] of [['x_pizza', 'x_pizza', null], ['tencha_centro', 'x_pizza', null], ['tencha_norte', 'x_pizza', renamed]]) {
    let { input } = buildPublishCandidate(from, { activeVersionId: null }, { source_sha: `seed-${rid}` });
    if (tweak) input = tweak(input);
    await publishVersion(fs, rid, input, { expected: { activeVersionId: null } });
    published[rid] = input.items.map((it) => it.key);
  }
  assert.ok(published.tencha_centro.some((k) => !published.tencha_norte.includes(k)), 'premise: the two tencha branches publish different keys');
  ok('seeded through the real writers: 2 legacy identities + brands (seed_identity, brand-store), 1 synthetic two-branch brand + retired branch, 1 synthetic singleton, 1 brand without identity; owners via mutateRoster bootstrap_owner, 2 managers via grant_manager; 3 menus via publishVersion');

  // ── E1 getMyBranches ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const { hnDateISO } = require('../lib/hn-date');
    await db.ref(`counters/order_display_seq/x_pizza/${hnDateISO(Date.now())}`).set({ last: 417, by_order: { o1: 417 } });
    await db.ref('restaurants/x_pizza/handhelds').set({ hh_x_pizza_a: { label: 'a' }, hh_x_pizza_b: { label: 'b' } });
    const r = await call(ops.getMyBranches, { uid: OWNER });
    assert.strictEqual(r.status, 200, r.text);
    const by = Object.fromEntries(r.json.branches.map((b) => [b.rid, b]));
    assert.deepStrictEqual(Object.keys(by).sort(), ['la_musa', 'x_pizza']);
    const x = by.x_pizza;
    assert.strictEqual(x.role, 'owner'); assert.ok(x.caps.includes('location.prep') && x.caps.includes('availability.set'));
    assert.strictEqual(x.identity_version, 1); assert.deepStrictEqual(x.editable, { prep_default_min: null });
    assert.strictEqual(x.readonly.radius_km, 7); assert.strictEqual(x.readonly.phone, IDENTITIES.x_pizza.phone); assert.deepStrictEqual(x.readonly.hours, IDENTITIES.x_pizza.hours);
    const { isOpenAt } = require('../scheduled-orders');
    assert.strictEqual(x.control.state, isOpenAt(IDENTITIES.x_pizza.hours, Date.now()) ? 'open' : 'closed', 'an ABSENT order_control node = open (subject to hours)');
    assert.strictEqual(x.devices, 2); assert.strictEqual(x.last_order_today, 417);
    assert.strictEqual(by.la_musa.control.state, 'inactive', 'active === false → inactive (precedence over hours)');
    assert.strictEqual(by.la_musa.readonly.radius_km, 9.66, 'the radius is returned raw (lossless)');
    assert.strictEqual(by.la_musa.last_order_today, null);
    assert.deepStrictEqual(r.json.brands.map((b) => b.brand_id), ['la_musa', 'x_pizza']);
    await db.ref('order_control/x_pizza/current').set({ paused: 'yes' });
    assert.strictEqual(Object.fromEntries((await call(ops.getMyBranches, { uid: OWNER })).json.branches.map((b) => [b.rid, b])).x_pizza.control.state, 'unknown', 'a MALFORMED control node → unknown');
    await db.ref('order_control/x_pizza').remove();
    const t = await call(ops.getMyBranches, { uid: OWNER_T });
    const tb = Object.fromEntries(t.json.branches.map((b) => [b.rid, b]));
    assert.deepStrictEqual(Object.keys(tb).sort(), ['tencha_centro', 'tencha_norte', 'tencha_viejo']);
    assert.ok(tb.tencha_viejo.caps.includes('stats.read') && !['location.prep', 'location.pause', 'availability.set'].some((c) => tb.tencha_viejo.caps.includes(c)), `a retired branch: stats.read, no operational capability (${tb.tencha_viejo.caps})`);
    assert.ok(!('control' in tb.tencha_viejo) && !('editable' in tb.tencha_viejo) && !('readonly' in tb.tencha_viejo), 'a stats-only branch carries NO operational fields');
    assert.strictEqual(tb.tencha_centro.editable.prep_default_min, 20);
    assert.deepStrictEqual(t.json.brands, [{ brand_id: 'tencha', name: 'Marca de Prueba' }]);
    const m = await call(ops.getMyBranches, { uid: MGR });
    assert.deepStrictEqual(m.json.branches.map((b) => [b.rid, b.role]), [['tencha_norte', 'manager']], 'a manager sees only their branch');
    assert.ok(m.json.branches[0].caps.includes('location.pause') && !m.json.branches[0].caps.includes('catalog.read_editor'));
    const mm = await call(ops.getMyBranches, { uid: MGR_MENU });
    assert.ok(mm.json.branches[0].caps.includes('catalog.read_editor'), 'the menu-permitted manager carries catalog.read_editor');
    assert.deepStrictEqual((await call(ops.getMyBranches, { uid: STRANGER })).json, { brands: [], branches: [], membership_writes_enabled: false });
    // membership_writes_enabled: the REAL access/writes-flag over the emulator — strict true only, else false
    assert.strictEqual((await db.ref('platform_config/membership_writes_enabled').get()).val(), null, 'precondition: the flag is absent');
    assert.strictEqual(t.json.membership_writes_enabled, false, 'absent → false');
    await db.ref('platform_config/membership_writes_enabled').set('true');
    assert.strictEqual((await call(ops.getMyBranches, { uid: OWNER_T })).json.membership_writes_enabled, false, "the string 'true' → false");
    await db.ref('platform_config/membership_writes_enabled').set(true);
    assert.strictEqual((await call(ops.getMyBranches, { uid: OWNER_T })).json.membership_writes_enabled, true, 'strict true → true');
    await db.ref('platform_config/membership_writes_enabled').remove();
    assert.deepStrictEqual((await call(ops.getMyBranches, { uid: DISP })).json.branches, [], 'a dispatcher alone discovers no branch');
    assert.strictEqual((await call(ops.getMyBranches, {})).status, 401);
    assert.strictEqual((await call(ops.getMyBranches, { uid: OWNER, claims: { customer: true } })).status, 403);
    assert.strictEqual((await call(ops.getMyBranches, { uid: OWNER, claims: { handheld: true, rid: 'x_pizza' } })).status, 403, 'a handheld token whose uid holds human roles → 403');
    assert.strictEqual((await call(ops.getMyBranches, { uid: OWNER, method: 'POST', body: {} })).status, 405);
    ok('E1: owner / multi-branch owner / manager / menu manager / stranger / dispatcher / customer / handheld; absent control = open, malformed = unknown, inactive precedence; raw radius 9.66; stats-only branch without operational fields; devices + last_order_today');
  }

  // ── E2 updateBranch ──────────────────────────────────────────────────────────────────────────────────────────────────
  const logs = [];
  const capture = async (fn) => { const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); }; try { return await fn(); } finally { console.log = orig; } };
  const evts = () => logs.filter((l) => l.includes('"evt":"branch_update"'));
  {
    const before = (await db.ref('restaurants/x_pizza/identity').get()).val();
    const r = await capture(() => call(ops.updateBranch, { method: 'POST', uid: OWNER, body: { rid: 'x_pizza', expectedVersion: 1, patch: { prep_default_min: 25 } } }));
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json, { identity_version: 2, editable: { prep_default_min: 25 } }, 'the committed snapshot is returned');
    const after = (await db.ref('restaurants/x_pizza/identity').get()).val();
    const { prep_default_min, version, ...rest } = after;
    assert.strictEqual(prep_default_min, 25); assert.strictEqual(version, 2);
    const { version: v0, ...rest0 } = before;
    assert.deepStrictEqual(rest, rest0, 'every other child of the LEGACY identity is byte-identical');
    assert.strictEqual(v0, 1);
    assert.strictEqual(evts().length, 1, 'one log line for one real write');
    // the real readers on the edited identity
    const { isRoutingValid, getIdentity } = require('../restaurant-config');
    assert.ok(isRoutingValid(after));
    assert.strictEqual((await getIdentity(db, 'x_pizza')).prep_default_min, 25, 'getIdentity serves the new prep');
    const V = require('../merchant/merchant-validate');
    assert.strictEqual(V.vPrepBase((await db.ref('restaurants/x_pizza/identity/prep_default_min').get()).val()), 25, 'the pairing / orderState reader accepts it');
    // la_musa (inactive legacy) saves too
    const lm = await call(ops.updateBranch, { method: 'POST', uid: OWNER, body: { rid: 'la_musa', expectedVersion: 1, patch: { prep_default_min: 30 } } });
    assert.strictEqual(lm.status, 200, lm.text);
    // the synthetic branch carrying a server-owned flag: preserved
    const tb = (await db.ref('restaurants/tencha_centro/identity').get()).val();
    const t = await call(ops.updateBranch, { method: 'POST', uid: OWNER_T, body: { rid: 'tencha_centro', expectedVersion: 4, patch: { prep_default_min: 35 } } });
    assert.strictEqual(t.status, 200, t.text);
    const ta = (await db.ref('restaurants/tencha_centro/identity').get()).val();
    assert.deepStrictEqual({ ...ta, prep_default_min: tb.prep_default_min, version: tb.version }, tb, 'brand_id / zone / location_name / uses_platform_factura and every other child unchanged');
    assert.strictEqual(ta.uses_platform_factura, false);
    // noop
    logs.length = 0;
    const noop = await capture(() => call(ops.updateBranch, { method: 'POST', uid: OWNER, body: { rid: 'x_pizza', expectedVersion: 2, patch: { prep_default_min: 25 } } }));
    assert.deepStrictEqual(noop.json, { noop: true, identity_version: 2, editable: { prep_default_min: 25 } });
    assert.strictEqual((await db.ref('restaurants/x_pizza/identity/version').get()).val(), 2, 'noop: no version bump');
    assert.strictEqual(evts().length, 0, 'noop: no log line');
    // stale
    const st = await capture(() => call(ops.updateBranch, { method: 'POST', uid: OWNER, body: { rid: 'x_pizza', expectedVersion: 1, patch: { prep_default_min: 40 } } }));
    assert.strictEqual(st.status, 409); assert.deepStrictEqual(st.json, { error: 'stale_branch', identity_version: 2, editable: { prep_default_min: 25 } });
    assert.strictEqual(evts().length, 0, 'stale: no log line');
    // rejections — nothing written
    const snap0 = (await db.ref('restaurants/x_pizza/identity').get()).val();
    const rej = [
      [{ rid: 'x_pizza', expectedVersion: 2, patch: { prep_default_min: '20' } }, 400, 'bad_prep'],
      [{ rid: 'x_pizza', expectedVersion: 2, patch: { prep_default_min: 20.5 } }, 400, 'bad_prep'],
      [{ rid: 'x_pizza', expectedVersion: 2, patch: { prep_default_min: 4 } }, 400, 'bad_prep'],
      [{ rid: 'x_pizza', expectedVersion: 2, patch: { prep_default_min: 121 } }, 400, 'bad_prep'],
      [{ rid: 'x_pizza', expectedVersion: 2, patch: { phone: '+50411112222' } }, 400, 'bad_patch'],
      [{ rid: 'x_pizza', expectedVersion: 2, patch: { prep_default_min: 20, hours: {} } }, 400, 'bad_patch'],
      [{ rid: 'x_pizza', expectedVersion: -1, patch: { prep_default_min: 20 } }, 400, 'bad_version'],
      [{ rid: 'x_pizza', expectedVersion: 1.5, patch: { prep_default_min: 20 } }, 400, 'bad_version'],
      [{ rid: 'x_pizza', expectedVersion: 1e15, patch: { prep_default_min: 20 } }, 400, 'bad_version'],
      [{ rid: 'x_pizza', expectedVersion: 2 ** 53 - 1, patch: { prep_default_min: 20 } }, 400, 'bad_version'],
      [{ rid: '../x', expectedVersion: 2, patch: { prep_default_min: 20 } }, 400, 'bad_rid'],
    ];
    for (const [body, status, error] of rej) {
      const x = await call(ops.updateBranch, { method: 'POST', uid: OWNER, body });
      assert.deepStrictEqual([x.status, x.json && x.json.error], [status, error], JSON.stringify(body));
    }
    for (const uid of [DISP, STAFF, STRANGER, MGR]) {
      const x = await call(ops.updateBranch, { method: 'POST', uid, body: { rid: 'x_pizza', expectedVersion: 2, patch: { prep_default_min: 20 } } });
      assert.strictEqual(x.status, 403, `${uid}: 403`);
    }
    assert.strictEqual((await call(ops.updateBranch, { method: 'POST', uid: OWNER, claims: { handheld: true }, body: { rid: 'x_pizza', expectedVersion: 2, patch: { prep_default_min: 20 } } })).status, 403);
    assert.deepStrictEqual((await db.ref('restaurants/x_pizza/identity').get()).val(), snap0, 'every rejection wrote nothing');
    // the manager of tencha_norte CAN set its prep
    assert.strictEqual((await call(ops.updateBranch, { method: 'POST', uid: MGR, body: { rid: 'tencha_norte', expectedVersion: 4, patch: { prep_default_min: 15 } } })).status, 200);
    ok('E2: legacy x_pizza + la_musa save prep (every other child byte-identical; real readers accept it); synthetic flag preserved; noop / stale (409 + current) / 11 input rejections / 5 auth refusals — nothing written, log only on a real write; a manager sets their branch');
  }
  {
    // missing identity → 404 (the absent→absent COMMITTED transaction must not reach 200)
    const g = await call(ops.updateBranch, { method: 'POST', uid: OWNER_S, body: { rid: 'ghost', expectedVersion: 1, patch: { prep_default_min: 20 } } });
    assert.deepStrictEqual([g.status, g.json.error], [404, 'identity_missing'], g.text);
    assert.strictEqual((await db.ref('restaurants/ghost/identity').get()).exists(), false);
    // malformed (isRoutingValid false) → 409, untouched
    const bad = { ...soloId }; delete bad.hub_lat;
    await db.ref('restaurants/solo/identity').set(bad);
    const ms = await call(ops.updateBranch, { method: 'POST', uid: OWNER_S, body: { rid: 'solo', expectedVersion: 4, patch: { prep_default_min: 20 } } });
    assert.deepStrictEqual([ms.status, ms.json.error], [409, 'identity_malformed']);
    assert.deepStrictEqual((await db.ref('restaurants/solo/identity').get()).val(), bad, 'malformed: untouched');
    // version boundaries
    const setV = (v) => db.ref('restaurants/solo/identity').set({ ...soloId, version: v });
    await setV(1e15 - 1);
    const okb = await call(ops.updateBranch, { method: 'POST', uid: OWNER_S, body: { rid: 'solo', expectedVersion: 1e15 - 1, patch: { prep_default_min: 20 } } });
    assert.deepStrictEqual([okb.status, okb.json.identity_version], [200, null], 'the last increment (10^15−1 → 10^15) succeeds; the result is no longer incrementable, so it is not offered as a CAS baseline');
    assert.strictEqual((await db.ref('restaurants/solo/identity/version').get()).val(), 1e15);
    for (const stored of [1e15, 2 ** 52 - 1, 2 ** 53 - 1, 2 ** 53]) {
      await setV(stored);
      const o = await call(ops.updateBranch, { method: 'POST', uid: OWNER_S, body: { rid: 'solo', expectedVersion: 5, patch: { prep_default_min: 21 } } });
      assert.deepStrictEqual([o.status, o.json.error], [409, 'version_overflow'], `stored ${stored} with an admissible expected → version_overflow (before stale)`);
      assert.strictEqual((await db.ref('restaurants/solo/identity/version').get()).val(), stored, 'untouched');
    }
    await setV(4);
    // two concurrent saves → exactly one commits
    const [a, b] = await Promise.all([25, 26].map((p) => call(ops.updateBranch, { method: 'POST', uid: OWNER_S, body: { rid: 'solo', expectedVersion: 4, patch: { prep_default_min: p } } })));
    assert.deepStrictEqual([a.status, b.status].sort(), [200, 409], `concurrent: one 200, one 409 (${a.status}/${b.status})`);
    assert.strictEqual((await db.ref('restaurants/solo/identity/version').get()).val(), 5);
    ok('E2: missing → 404 (absent→absent commit), malformed → 409 untouched, 10^15−1 → 10^15 OK, stored 10^15 / 2^52−1 / 2^53−1 / 2^53 → version_overflow untouched, concurrent saves → one 200 + one 409');
  }
  {
    // a concurrent write from an INDEPENDENT Admin app instance, between E2's read and its commit, survives
    const { initializeApp } = require('firebase-admin/app');
    const other = getDatabase(initializeApp({ projectId: PROJECT, databaseURL: db.app.options.databaseURL }, 'portal-ops-other'));
    const C = require('../portal/ops-core');
    // codex 1a r1 P2-8: the competing write must land AFTER E2's first callback has OBSERVED identity, so the first commit is
    // rejected and the callback reruns on the new value. Deterministic: on that first non-null callback this app goes
    // OFFLINE (its transaction stays queued), the independent app writes, and only then does this app reconnect.
    const pre = (await db.ref('restaurants/tencha_norte/identity').get()).val();
    assert.ok(pre && pre.uses_platform_factura !== true && !(pre.hours && pre.hours.sun && pre.hours.sun.open === false), 'precondition: neither concurrent value is there yet');
    const seen = [];
    let competing = null;
    const proxied = { ref: (p) => { const r = db.ref(p); if (!p.endsWith('/identity')) return r;
      return new Proxy(r, { get: (t, k) => (k === 'transaction' ? (fn, ...rest) => t.transaction((cur) => {
        if (cur !== null) {
          seen.push(cur.uses_platform_factura === true);
          if (seen.length === 1) {
            db.goOffline();
            competing = (async () => {
              try { await other.ref(`${p}/uses_platform_factura`).set(true); await other.ref(`${p}/hours/sun`).set({ open: false }); } finally { db.goOnline(); }
            })();
          }
        }
        return fn(cur);
      }, ...rest) : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) }); }, };
    const req = { method: 'POST', body: { rid: 'tencha_norte', expectedVersion: 5, patch: { prep_default_min: 45 } }, get: (h) => (h === 'authorization' ? `Bearer ${idToken(OWNER_T)}` : undefined) };
    const { getAuth } = require('firebase-admin/auth');
    const out = await C.updateBranchCore({ db: proxied, verifyIdToken: (t) => getAuth().verifyIdToken(t), log: { log() {}, warn() {} } }, req);
    assert.strictEqual(out.status, 200, JSON.stringify(out));
    await competing;
    assert.ok(seen.length >= 2, `the callback RERAN after the competing write (${seen.length} non-null callbacks)`);
    assert.deepStrictEqual([seen[0], seen[seen.length - 1]], [false, true], 'first callback saw the pre-write identity, the committing one saw the concurrent write');
    const s = (await db.ref('restaurants/tencha_norte/identity').get()).val();
    assert.strictEqual(s.prep_default_min, 45); assert.strictEqual(s.uses_platform_factura, true, 'the concurrent flag write survives');
    assert.deepStrictEqual(s.hours.sun, { open: false }, 'the concurrent hours write survives');
    ok('E2: a write to uses_platform_factura + hours from an independent Admin app between read and commit survives the prep save');
  }

  // ── E3 setBranchPause ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    await db.ref('order_control/x_pizza/busy').set({ add_min: 10, until: Date.now() + 60000, since: Date.now(), by: 'handheld:x' });
    const busy0 = (await db.ref('order_control/x_pizza/busy').get()).val();
    const p = await call(ops.setBranchPause, { method: 'POST', uid: OWNER, body: { rid: 'x_pizza', op: 'pause', dur_min: 30, reason: 'Cocina llena' } });
    assert.strictEqual(p.status, 200, p.text);
    const node = (await db.ref('order_control/x_pizza').get()).val();
    assert.strictEqual(node.current.paused, true); assert.ok(node.current.until > Date.now());
    assert.strictEqual(node.current.reason, 'Cocina llena'); assert.strictEqual(node.current.by, `portal:${OWNER}`);
    assert.strictEqual(p.json.control.state, 'paused'); assert.strictEqual(p.json.control.pause_reason, 'Cocina llena');
    assert.deepStrictEqual(node.busy, busy0, 'busy byte-identical');
    const ev = Object.values(node.events || {});
    assert.strictEqual(ev.length, 1); assert.strictEqual(ev[0].reason, 'Cocina llena');
    const OC = require('../order-control');
    OC._resetForTests();
    const d = await OC.orderControlFor(db, 'x_pizza');
    assert.strictEqual(d, 'paused', 'the REAL intake reader sees the portal pause');
    const { REFUSALS } = require('../order-control-state');
    assert.strictEqual(REFUSALS.paused.status, 423, 'createOrder refuses with 423');
    const S = require('../order-control-state');
    const D = await import(path.join(__dirname, '..', '..', 'xpizza-dispatch', 'dispatch-order-control.js'));
    const banner = D.pauseBannerModel({ status: 'ok', nodes: { x_pizza: node }, names: { x_pizza: 'X' }, now: Date.now(), S });
    assert.deepStrictEqual(banner.paused.map((x) => [x.rid, x.reason]), [['x_pizza', 'Cocina llena']], 'the dispatch banner model reads it');
    const r = await call(ops.setBranchPause, { method: 'POST', uid: OWNER, body: { rid: 'x_pizza', op: 'resume', reason: 'ignored extra' } });
    assert.strictEqual(r.status, 200, r.text);
    const node2 = (await db.ref('order_control/x_pizza').get()).val();
    assert.strictEqual(node2.current.paused, false);
    const evs = Object.values(node2.events).sort((x, y) => x.version - y.version);
    assert.strictEqual(evs[evs.length - 1].reason, 'reanudar', 'resume carries the handheld adapter\'s reason, never the request\'s');
    assert.deepStrictEqual(node2.busy, busy0, 'busy byte-identical after resume');
    const again = await call(ops.setBranchPause, { method: 'POST', uid: OWNER, body: { rid: 'x_pizza', op: 'resume' } });
    assert.strictEqual(again.status, 200); assert.strictEqual(again.json.noop, true, 'resume when open → noop');
    for (const body of [{ rid: 'x_pizza', op: 'pause', reason: 'Cocina llena' }, { rid: 'x_pizza', op: 'pause', dur_min: 45, reason: 'Cocina llena' },
      { rid: 'x_pizza', op: 'pause', dur_min: 30, reason: 'Falta de personal' }, { rid: 'x_pizza', op: 'stop' }]) {
      const x = await call(ops.setBranchPause, { method: 'POST', uid: OWNER, body });
      assert.deepStrictEqual([x.status, x.json.error], [400, 'bad_pause'], JSON.stringify(body));
    }
    assert.strictEqual((await call(ops.setBranchPause, { method: 'POST', uid: MGR, body: { rid: 'x_pizza', op: 'pause', dur_min: null, reason: 'Otro' } })).status, 403);
    assert.strictEqual((await call(ops.setBranchPause, { method: 'POST', uid: DISP, body: { rid: 'x_pizza', op: 'pause', dur_min: null, reason: 'Otro' } })).status, 403);
    assert.strictEqual((await call(ops.setBranchPause, { method: 'POST', uid: MGR, body: { rid: 'tencha_norte', op: 'pause', dur_min: null, reason: 'Otro' } })).status, 200, 'a manager pauses their branch');
    // superseded: a concurrent CLI-shaped write (version bump) between writePause's read and its transaction
    const C = require('../portal/ops-core');
    const { getAuth } = require('firebase-admin/auth');
    const proxied = { ref: (p) => { const r = db.ref(p); if (p !== 'order_control/solo') return r;
      return new Proxy(r, { get: (t, k) => (k === 'transaction' ? async (...args) => {
        await db.ref('order_control/solo/current').set({ paused: true, since: Date.now(), by: 'cli:op', principal: 'cli', reason: 'cli', version: 9, op_id: 'cli_1' });
        return t.transaction(...args);
      } : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) }); }, };
    await db.ref('restaurants/solo/identity').set({ ...soloId, version: 6 });
    const sup = await C.setBranchPauseCore({ db: proxied, verifyIdToken: (t) => getAuth().verifyIdToken(t), now: () => Date.now(), timestamp: () => ServerValue.TIMESTAMP, newOpId: () => 'oc_test_1' },
      { method: 'POST', body: { rid: 'solo', op: 'pause', dur_min: 30, reason: 'Otro' }, get: (h) => (h === 'authorization' ? `Bearer ${idToken(OWNER_S)}` : undefined) });
    assert.deepStrictEqual([sup.status, sup.body.error], [409, 'superseded'], JSON.stringify(sup));
    assert.strictEqual((await db.ref('order_control/solo/current/op_id').get()).val(), 'cli_1', 'the concurrent writer\'s state stands');
    ok('E3: pause → current + events (busy byte-identical), read by the REAL orderControlFor (→ 423) and the dispatch banner; resume → reason reanudar; noop; 4 bad_pause; auth refusals; manager on own branch; a concurrent CLI write → 409 superseded');
  }

  // ── E4 / E5 availability ─────────────────────────────────────────────────────────────────────────────────────────────
  {
    const a = await call(ops.getBranchAvailability, { uid: OWNER_T, query: '?brandId=tencha' });
    assert.strictEqual(a.status, 200, a.text);
    const by = Object.fromEntries(a.json.branches.map((b) => [b.rid, b]));
    assert.deepStrictEqual(Object.keys(by).sort(), ['tencha_centro', 'tencha_norte'], 'the retired branch is not an availability target');
    assert.deepStrictEqual(by.tencha_centro.items.map((i) => i.key), published.tencha_centro);
    assert.deepStrictEqual(by.tencha_norte.items.map((i) => i.key), published.tencha_norte);
    const it0 = by.tencha_centro.items[0];
    assert.deepStrictEqual(Object.keys(it0).sort(), ['category_id', 'category_name', 'description', 'key', 'name', 'price']);
    assert.ok(it0.name && typeof it0.price === 'number' && it0.category_id, 'the projection carries display fields from the REAL published version');
    assert.strictEqual(it0.category_name, null, 'a structure without category names projects null (the client falls back to the id, as the editor does)');
    assert.strictEqual(by.tencha_centro.resets_daily, false);
    const xp = await call(ops.getBranchAvailability, { uid: OWNER, query: '?restaurantId=x_pizza' });
    assert.strictEqual(xp.json.branches[0].resets_daily, true, 'the reset job\'s default list covers x_pizza');
    const solo = await call(ops.getBranchAvailability, { uid: OWNER_S, query: '?restaurantId=solo' });
    assert.deepStrictEqual([solo.status, solo.json.branches[0].published], [200, false], 'no published menu → published:false');
    assert.strictEqual((await call(ops.getBranchAvailability, { uid: MGR, query: '?brandId=tencha' })).json.branches.length, 1, 'a manager: only their branch');
    assert.strictEqual((await call(ops.getBranchAvailability, { uid: MGR, query: '?restaurantId=tencha_centro' })).status, 403);
    assert.strictEqual((await call(ops.getBranchAvailability, { uid: OWNER, query: '?restaurantId=x_pizza&brandId=x_pizza' })).status, 400);

    // E5
    const keyA = published.tencha_centro.find((k) => !published.tencha_norte.includes(k));
    const keyBoth = published.tencha_norte[0];
    const snap = async () => [(await db.ref('restaurants/tencha_centro/item_availability').get()).val(), (await db.ref('restaurants/tencha_norte/item_availability').get()).val(),
      (await db.ref('restaurants/tencha_centro/availability_audit').get()).val(), (await db.ref('restaurants/tencha_norte/availability_audit').get()).val()];
    const s0 = await snap();
    const u1 = await call(ops.setBranchAvailability, { method: 'POST', uid: OWNER_T, body: { rids: ['tencha_centro', 'tencha_norte'], key: keyA, available: false } });
    assert.deepStrictEqual([u1.status, u1.json.error], [400, 'unknown_item'], 'a key published in A but not in B → 400');
    const u2 = await call(ops.setBranchAvailability, { method: 'POST', uid: MGR, body: { rids: ['tencha_norte', 'tencha_centro'], key: keyBoth, available: false } });
    assert.strictEqual(u2.status, 403, 'a denied rid in the set → 403');
    const u3 = await call(ops.setBranchAvailability, { method: 'POST', uid: OWNER_T, body: { rids: ['tencha_norte'], key: 'tmp:nope', available: false } });
    assert.deepStrictEqual([u3.status, u3.json.error], [400, 'unknown_item'], 'a draft-only / unknown key → 400');
    for (const body of [{ rids: [], key: keyBoth, available: false }, { rids: ['tencha_norte', 'tencha_norte'], key: keyBoth, available: false }, { rids: ['tencha_norte'], key: keyBoth, available: 'no' }, { rids: ['tencha_norte'], key: '', available: false }]) {
      assert.strictEqual((await call(ops.setBranchAvailability, { method: 'POST', uid: OWNER_T, body })).status, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(await snap(), s0, 'every refusal wrote NOTHING in either branch (availability or audit)');
    const xk = published.x_pizza[0];
    const u4 = await call(ops.setBranchAvailability, { method: 'POST', uid: OWNER, body: { rids: ['x_pizza'], key: xk, available: false } });
    assert.strictEqual(u4.status, 200, u4.text);
    const { availKey } = require('../avail-key');
    const rec = (await db.ref(`restaurants/x_pizza/item_availability/${availKey(xk)}`).get()).val();
    const aud = (await db.ref(`restaurants/x_pizza/availability_audit/${availKey(xk)}`).get()).val();
    assert.strictEqual(rec.available, false); assert.ok(Number.isFinite(rec.updated_at)); assert.deepStrictEqual(Object.keys(rec).sort(), ['available', 'updated_at']);
    assert.strictEqual(aud.updated_by, `portal:${OWNER}`); assert.strictEqual(aud.updated_at, rec.updated_at);
    const { checkItemAvailability } = require('../availability-gate');
    const xpItem = (await call(ops.getBranchAvailability, { uid: OWNER, query: '?restaurantId=x_pizza' })).json.branches[0];
    assert.deepStrictEqual(xpItem.unavailable, [xk], 'E4 reads it back');
    const gate = await checkItemAvailability(db, [{ name: xk }], 'x_pizza');
    assert.deepStrictEqual(gate.blocked, [xk], 'the REAL intake gate blocks the sold-out item');
    const u5 = await call(ops.setBranchAvailability, { method: 'POST', uid: OWNER_T, body: { rids: ['tencha_centro', 'tencha_norte'].filter((r) => published[r].includes(keyBoth)), key: keyBoth, available: false } });
    assert.strictEqual(u5.status, 200, u5.text);
    ok('E4: per-branch published menus (different keys), the real projection, resets_daily from the job list, unpublished → published:false, manager scope; E5: A-not-B / denied rid / unknown key / 4 bad inputs write NOTHING anywhere; a write is read by E4 and blocked by the REAL checkItemAvailability');
  }
  {
    // E4 per-rid failure isolation: corrupt tencha_norte's ACTIVE version in four ways, one at a time; tencha_centro stays intact
    const { getActiveVersionId } = require('../catalog/catalog-firestore');
    const vid = await getActiveVersionId(fs, 'tencha_norte');
    const vref = fs.collection('restaurants').doc('tencha_norte').collection('versions').doc(vid);
    const items = await vref.collection('menu_items').get();
    const saved = items.docs.map((d) => [d.id, d.data()]);
    const restore = async () => { for (const [id, data] of saved) await vref.collection('menu_items').doc(id).set(data); };
    const check = async (label, expectUnavail = true) => {
      const r = await capture(() => call(ops.getBranchAvailability, { uid: OWNER_T, query: '?brandId=tencha' }));
      assert.strictEqual(r.status, 200, `${label}: ${r.text}`);
      const by = Object.fromEntries(r.json.branches.map((b) => [b.rid, b]));
      assert.strictEqual(by.tencha_centro.published, true, `${label}: the other branch is intact`);
      if (expectUnavail) {
        assert.deepStrictEqual([by.tencha_norte.published, by.tencha_norte.error, by.tencha_norte.items.length], [null, 'menu_unavailable', 0], `${label}: menu_unavailable`);
        assert.ok(!JSON.stringify(r.json).includes('menu_structure_bad') && !JSON.stringify(r.json).includes('catalog_'), `${label}: the diagnostic code never reaches the client`);
      }
    };
    await vref.collection('menu_items').doc(saved[0][0]).delete();
    await check('a deleted menu_items doc (menu_structure_bad)');
    await restore();
    for (const [id] of saved) await vref.collection('menu_items').doc(id).delete();
    await check('an emptied version (catalog_empty)');
    await restore();
    await vref.collection('menu_items').doc(saved[0][0]).set({ ...saved[0][1], display: { ...saved[0][1].display, name: `${saved[0][1].display.name} (cambiado)` } });
    await check('a tampered display field (catalog_content_mismatch)');
    await restore();
    await check('restored', false);
    // pointer read failure (stubbed throw) for one rid, through the core
    const C = require('../portal/ops-core');
    const { getAuth } = require('firebase-admin/auth');
    const fsProxy = { collection: (c) => { const col = fs.collection(c); return new Proxy(col, { get: (t, k) => (k === 'doc' ? (id) => { if (id === 'tencha_norte') throw new Error('pointer read failed'); return t.doc(id); } : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) }); } };
    const out = await C.getBranchAvailabilityCore({ db, fs: fsProxy, verifyIdToken: (t) => getAuth().verifyIdToken(t), log: { warn() {}, log() {} } },
      { method: 'GET', query: { brandId: 'tencha' }, get: (h) => (h === 'authorization' ? `Bearer ${idToken(OWNER_T)}` : undefined) });
    assert.strictEqual(out.status, 200);
    const ob = Object.fromEntries(out.body.branches.map((b) => [b.rid, b]));
    assert.strictEqual(ob.tencha_norte.error, 'menu_unavailable'); assert.strictEqual(ob.tencha_centro.published, true);
    const allFail = await C.getBranchAvailabilityCore({ db, fs: { collection: () => { throw new Error('down'); } }, verifyIdToken: (t) => getAuth().verifyIdToken(t), log: { warn() {}, log() {} } },
      { method: 'GET', query: { brandId: 'tencha' }, get: (h) => (h === 'authorization' ? `Bearer ${idToken(OWNER_T)}` : undefined) });
    assert.strictEqual(allFail.status, 503, 'every rid failing → 503');
    ok('E4: a deleted item doc, an emptied version, a tampered display field and a pointer failure each fail ONLY that branch (menu_unavailable, code logged not sent); all failing → 503');
  }

  // ── speed (§5.3): warm E1 vs warm getMyRestaurants for the same owner, through the real handlers ───────────────────
  {
    const portal = require('../portal/functions');
    const med = (xs) => { const v = [...xs].sort((p, q) => p - q); return v[Math.floor(v.length / 2)]; };
    const time = async (fn) => { const t = []; for (let i = 0; i < 30; i++) { const t0 = process.hrtime.bigint(); const r = await call(fn, { uid: OWNER }); assert.strictEqual(r.status, 200); t.push(Number(process.hrtime.bigint() - t0) / 1e6); } return t; };
    await time(ops.getMyBranches); await time(portal.getMyRestaurants);   // warm both
    const a = await time(ops.getMyBranches), b = await time(portal.getMyRestaurants);
    console.log(`SPEED warm median (emulator, 30 calls each): getMyBranches ${med(a).toFixed(1)} ms · getMyRestaurants ${med(b).toFixed(1)} ms · delta ${(med(a) - med(b)).toFixed(1)} ms`);
    assert.ok(med(a) <= med(b) + 150, `E1 warm median ${med(a).toFixed(1)} ms > getMyRestaurants ${med(b).toFixed(1)} ms + 150`);
    ok(`SPEED: E1 warm median ${med(a).toFixed(1)} ms ≤ getMyRestaurants ${med(b).toFixed(1)} ms + 150 (emulator; production is the owner-run probe after deploy)`);
  }

  // ── isolated load mode smoke: the same answer through FUNCTION_TARGET=getMyBranches ──────────────────────────────
  {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, ['-e', `
      process.env.FUNCTION_TARGET = 'getMyBranches';
      const m = require(${JSON.stringify(path.join(__dirname, '..', 'index.js'))});
      console.log('KEYS ' + JSON.stringify(Object.keys(m).sort()));`], { env: process.env, encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 0, r.stderr.slice(-400));
    assert.ok(r.stdout.includes('portal_ops_entry getMyBranches'));
    assert.deepStrictEqual(JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('KEYS ')).slice(5)), ['getBranchAvailability', 'getMyBranches', 'setBranchAvailability', 'setBranchPause', 'updateBranch']);
    ok('isolated load: FUNCTION_TARGET=getMyBranches loads only the ops group (marker printed) under the emulator env');
  }

  console.log(`\nportal-ops(emulator): OK (${n})`);
  authSrv.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
