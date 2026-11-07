'use strict';
// S4 C′ (PLAN-capp-S4-r4 §2 / r5) — the REAL quoteOrder export against the RTDB + Firestore emulators.
//   A. schedule_only (app-scoped): a published member gets the schedule; the recorded DB calls are EXACTLY the schedule_ip
//      limiter transaction + the public/brands read + the identity read — NO Firestore call (no catalog / pricing), no
//      quote_ip, no issueQuote; an unpublished-but-known rid answers bytes identical to an unknown rid; grammar-invalid
//      hours → 503; the schedule_ip throttle trips at max+1 while quote_ip stays untouched.
//   C. WRITER → READER freshness (Codex S4 build r1 P2-2): warm schedule_only → change hours through the REAL E7
//      (portal updateBranchProfile, an owner ID token from the Auth emulator) → the next REAL schedule_only serves the NEW
//      hours, and validateScheduledFor's accept/refuse over them equals the decision over the hours intake reads.
//   B. PAIRED ordinary quotes: the same bodies through the BASE handler (index.js with the s4hours segment unapplied,
//      compiled in a child) and the CANDIDATE handler (the real index.js, another child) → byte-identical responses
//      (quote_token excepted: it carries a per-quote nonce; presence + length are compared).
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:s4-schedule-only
require('./_emulator-required')('database', 'firestore', 'auth');
if (!process.env.S4_CHILD && !process.env.FIREBASE_AUTH_EMULATOR_HOST) { console.error('🔴 REFUSED — FIREBASE_AUTH_EMULATOR_HOST not set (run via npm run test:s4-schedule-only)'); process.exit(2); }
const REAL_NOW = Date.now.bind(Date);
const assert = require('assert');
const http = require('http');
const path = require('path');
const fsys = require('fs');
const Module = require('module');
const { execFileSync } = require('child_process');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.MAKE_SECRET = process.env.MAKE_SECRET || 's4-secret';
process.env.PIXELPAY_RETURN_URL_LA_MUSA = process.env.PIXELPAY_RETURN_URL_LA_MUSA || 'https://lamusa.test';
const INDEX = path.join(__dirname, '..', 'index.js');

// ── the shared request helper (one express shim per call, loopback, a fixed client ip) ──────────────────────────────
function post(handler, body, ip = '198.51.100.7') {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
        const t = await res.text();
        s.close(() => resolve({ status: res.status, text: t, retryAfter: res.headers.get('retry-after') }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const norm = (r) => { let j = null; try { j = JSON.parse(r.text); } catch (_) { return r; } if (j && typeof j.quote_token === 'string') j.quote_token = `<token len=${j.quote_token.length}>`; return { status: r.status, body: j }; };

// ── CHILD mode: load BASE or CANDIDATE index.js, answer every body, print the normalised responses ─────────────────
if (process.env.S4_CHILD) {
  (async () => {
    let app;
    if (process.env.S4_CHILD === 'base') {
      const { unapplyS4HoursIndex } = require('../tools/s4hours-inverse');
      const m = new Module(INDEX, module); m.filename = INDEX; m.paths = Module._nodeModulePaths(path.dirname(INDEX));
      m._compile(unapplyS4HoursIndex(fsys.readFileSync(INDEX, 'utf8')), INDEX);
      app = m.exports;
    } else app = require('../index.js');
    const bodies = JSON.parse(process.env.S4_BODIES);
    const out = [];
    for (const b of bodies) out.push(norm(await post(app.quoteOrder, b, '198.51.100.8')));
    process.stdout.write(`S4RESULT:${JSON.stringify(out)}\n`);
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
  return;
}

// ── PARENT ────────────────────────────────────────────────────────────────────────────────────────────────────────
const qi = require.resolve('../quote-issue');
const realQI = require('../quote-issue');
let ISSUE_CALLS = 0;
require.cache[qi] = { id: qi, filename: qi, loaded: true, children: [], paths: [], exports: { ...realQI, issueQuote: (...a) => { ISSUE_CALLS++; return realQI.issueQuote(...a); } } };
const app = require('../index.js');
const admin = require('firebase-admin');
const fs = admin.firestore();
const rtdb = admin.database();
const { buildPublishCandidate } = require('../tools/publish-version');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { publishVersion } = require('../catalog/catalog-publish');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { resolveRestaurantId } = require('../restaurant-id');
const SCHED = require('../scheduled-orders');
const SO = require('../schedule/schedule-only');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s4-schedule-only(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

// the recorder (RTDB + Firestore prototypes, the d4b-trace recipe, minimal)
let REC = null;
const rel = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/^\//, ''); } catch (_) { return String(u); } };
function patchChain(obj, names, describe) {
  const done = new Set();
  for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const nm of names) {
      if (done.has(nm) || !Object.prototype.hasOwnProperty.call(p, nm) || typeof p[nm] !== 'function') continue;
      done.add(nm); const orig = p[nm];
      p[nm] = function (...a) { if (REC) REC.push(describe(this, nm)); return orig.apply(this, a); };
    }
  }
}
patchChain(rtdb.ref('x'), ['get', 'once', 'set', 'update', 'remove', 'transaction', 'push'], (self, nm) => ({ db: 'rtdb', op: nm, path: rel((self.ref || self).toString()) }));
patchChain(fs.doc('a/b'), ['get', 'set', 'update', 'create', 'delete'], (self, nm) => ({ db: 'fs', op: nm, path: self.path }));
patchChain(fs.collection('a').where('x', '==', 1), ['get'], (self, nm) => ({ db: 'fs', op: nm }));
patchChain(fs.collection('a'), ['get', 'add'], (self, nm) => ({ db: 'fs', op: nm }));

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const H7 = Object.fromEntries(DAYS.map((d) => [d, d === 'mon' ? { open: false } : { open: true, start: '11:00', end: '21:30' }]));
const identity = (name, hours) => ({ name, phone: '+50400000000', active: true, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 6, version: 1, hours });
const PUB = 'tb_s4pub', UNPUB = 'tb_s4unpub', BADH = 'tb_s4badhours', GHOST = 'tb_s4ghost';

async function seedCatalog(rid) {
  await sourceRefOf(fs, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: `s4-${rid}` });
  await publishVersion(fs, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(fs, rid, catalogSnapshot(rid), { captured: await getActivePointer(fs, rid) });
}
const cartFor = (rid) => {
  const s = catalogSnapshot(rid);
  const it = s.items.find((i) => (rid === 'x_pizza' ? i.key === 'Carnivora' : i.key === 'dimsum_01'));
  return rid === 'x_pizza' ? [{ name: it.display.name, qty: 2, price: it.price, extras: [] }] : [{ id: it.key, name: it.display.name, cat: it.display.cat, qty: 1, price: it.price, extras: [] }];
};

(async () => {
  // fixtures: the registry learns the tb_ rids from Firestore restaurants/*; RTDB identities + the public projection
  // section C's LEG ('tb_s4leg') is seeded HERE too: the registry learns rids from Firestore with a 5-min TTL, so a doc created after
  // the first registry read (section C) is never learned in time — S4E-LEG-WARM failed exactly that way (heavy run 2026-10-27)
  for (const rid of [PUB, UNPUB, BADH, 'tb_s4leg']) await fs.collection('restaurants').doc(rid).set({ name: rid });
  await rtdb.ref().update({
    [`restaurants/${PUB}/identity`]: identity(PUB, H7),
    [`restaurants/${UNPUB}/identity`]: identity(UNPUB, H7),
    [`restaurants/${BADH}/identity`]: identity(BADH, { ...H7, fri: { open: true, start: '22:00', end: '02:00' } }),
    'public/brands/tb_s4brand': { name: 'TB S4', locations: { [PUB]: { location_name: 'Centro' }, [BADH]: { location_name: 'Norte' } } },
  });
  for (const rid of ['x_pizza', 'la_musa']) await seedCatalog(rid);
  // warm the registry (it learns asynchronously): retry until the published tb_ rid is known
  const APP = (rid) => ({ schedule_only: true, entry_mode: 'app', restaurant_id: rid });
  let warm = null;
  for (let i = 0; i < 40; i++) { warm = await post(app.quoteOrder, APP(PUB), '203.0.113.200'); if (warm.status !== 400) break; await new Promise((r) => setTimeout(r, 250)); }
  assert.strictEqual(warm.status, 200, `S4E-REGISTRY-WARM (last ${warm.status} ${warm.text})`);
  await rtdb.ref('rate_limits').remove();

  // A1 — published member: the schedule, and EXACTLY the expected DB calls
  {
    ISSUE_CALLS = 0; REC = [];
    const r = await post(app.quoteOrder, APP(PUB));
    const calls = REC; REC = null;
    const c = SCHED.resolveCfg();
    assert.strictEqual(r.status, 200, `S4E-PUB-200 ${r.text}`);
    assert.deepStrictEqual(JSON.parse(r.text), { ok: true, schedule: { tz_offset_min: -360, slot_min: c.slotMin, lead_min: { pickup: SO.minLeadFor('pickup', c), delivery: SO.minLeadFor('delivery', c) }, horizon_h: c.maxHorizonHours, hours: H7 } }, 'S4E-PUB-BODY');
    const shape = calls.map((x) => `${x.db}:${x.op}:${(x.path || '').replace(/^rate_limits\/schedule_ip\/.*/, 'rate_limits/schedule_ip/<key>')}`);
    assert.ok(!calls.some((x) => x.db === 'fs'), `S4E-NO-FIRESTORE (no catalog / pricing): ${shape.join(' | ')}`);
    assert.ok(!calls.some((x) => /quote_ip/.test(x.path || '')), 'S4E-NO-QUOTE-IP');
    assert.ok(shape.includes('rtdb:transaction:rate_limits/schedule_ip/<key>'), `S4E-SCHEDULE-BUCKET ${shape.join(' | ')}`);
    assert.ok(shape.includes(`rtdb:once:restaurants/${PUB}/identity`), `S4E-IDENTITY-READ ${shape.join(' | ')}`);
    assert.ok(calls.every((x) => x.db === 'rtdb' && (['once', 'get'].includes(x.op) || (x.op === 'transaction' && /^rate_limits\/schedule_ip\//.test(x.path)))), `S4E-ONLY-BOOKKEEPING-WRITES ${shape.join(' | ')}`);
    assert.strictEqual(ISSUE_CALLS, 0, 'S4E-NO-ISSUEQUOTE');
    ok(`published member → 200 schedule; DB calls = [${[...new Set(shape)].join(', ')}]; no Firestore (catalog/pricing), no quote_ip, no issueQuote`);
  }
  // A2 — unpublished-but-known rid → bytes identical to an unknown rid
  {
    const a = await post(app.quoteOrder, APP(UNPUB));
    const unknownBody = JSON.stringify({ ok: false, error: 'bad_request', detail: resolveRestaurantId(UNPUB, new Set()).error });
    assert.strictEqual(a.status, 400, `S4E-UNPUB-400 ${a.text}`);
    assert.strictEqual(a.text, unknownBody, 'S4E-UNPUB-BYTES');
    const g = await post(app.quoteOrder, APP(GHOST));
    assert.strictEqual(g.status, 400); assert.strictEqual(JSON.parse(g.text).detail, resolveRestaurantId(GHOST, new Set()).error, 'S4E-GHOST-IS-UNKNOWN');
    assert.strictEqual(a.text.replace(UNPUB, '<rid>'), g.text.replace(GHOST, '<rid>'), 'S4E-UNPUB-EQUALS-UNKNOWN-SHAPE');
    ok('an unpublished-but-known rid answers the unknown-restaurant 400, byte-for-byte (modulo the rid itself)');
  }
  // A3 — grammar-invalid published identity → 503
  {
    const r = await post(app.quoteOrder, APP(BADH));
    assert.strictEqual(r.status, 503, `S4E-INVALID-503 ${r.text}`);
    assert.deepStrictEqual(JSON.parse(r.text), { ok: false, error: 'schedule_unavailable', retryable: true });
    ok('grammar-invalid published hours → 503 schedule_unavailable');
  }
  // A4 — throttle: schedule_ip trips at max+1; quote_ip untouched
  {
    await rtdb.ref('rate_limits').remove();
    const max = SO.SCHEDULE_IP_BUCKET.max;
    for (let i = 0; i < max; i++) { const r = await post(app.quoteOrder, APP(PUB), '203.0.113.50'); assert.notStrictEqual(r.status, 429, `S4E-THROTTLE-EARLY at ${i + 1}`); }
    const over = await post(app.quoteOrder, APP(PUB), '203.0.113.50');
    assert.strictEqual(over.status, 429, 'S4E-THROTTLE-MAX+1'); assert.ok(Number(over.retryAfter) >= 1, 'S4E-RETRY-AFTER');
    assert.strictEqual((await rtdb.ref('rate_limits/quote_ip').get()).exists(), false, 'S4E-QUOTE-IP-UNTOUCHED');
    ok(`schedule_ip throttles at ${max + 1} (429 + Retry-After); rate_limits/quote_ip never written by schedule reads`);
  }
  // C — WRITER → READER: the real E7 hours writer, then the real schedule_only reader, then the real validator
  {
    const ops = require('../portal/ops-functions');
    const { mutateRoster } = require('../access/roster');
    const { validateBrand, validateBranchIdentity } = require('../brands/brand-model');
    const OWNER = 'uS4LegOwner01', LEG = 'tb_s4leg';
    const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    const tokenOf = async (uid) => {
      const { getAuth } = require('firebase-admin/auth');
      const custom = await getAuth().createCustomToken(uid);
      const r = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo-key`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
      const j = await r.json(); assert.ok(r.ok && j.idToken, `S4E-AUTH-EMULATOR signs ${uid} in`); return j.idToken;
    };
    const callOps = (fn, body, uid) => new Promise((resolve, reject) => {
      const w = express(); w.use(express.json()); w.all('*', (rq, rs) => fn(rq, rs));
      const srv = http.createServer(w).listen(0, '127.0.0.1', async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${srv.address().port}/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://sherpa-portal.netlify.app', Authorization: `Bearer ${await tokenOf(uid)}` }, body: JSON.stringify(body) });
          const t = await r.text(); srv.close(() => resolve({ status: r.status, text: t }));
        } catch (e) { srv.close(() => reject(e)); }
      });
    });
    const DAY = { open: true, start: '11:00', end: '21:30' };
    const H_OLD = { sun: DAY, mon: { open: false }, tue: DAY, wed: DAY, thu: DAY, fri: DAY, sat: DAY };
    const H_NEW = { ...H_OLD, mon: { open: true, start: '10:00', end: '14:00' }, tue: { open: false } };
    const legId = { name: 'S4 Leg', brand_id: LEG, location_name: 'Leg', phone: '+50422223333', hours: H_OLD, prep_default_min: 20, hub_lat: 14.1, hub_lng: -87.2,
      zone: { type: 'circle', radius_km: 5 }, delivery_radius_km: 5, whatsapp_instance: '', whatsapp_enabled: false, active: true, version: 3 };
    assert.ok(validateBranchIdentity(LEG, legId, LEG).ok, 'S4E-LEG-FIXTURE-VALID');
    const legBrand = { name: 'S4 Leg', active: true, locations: { [LEG]: 'member' }, activation: { state: 'legacy', since: 1 } };
    assert.ok(validateBrand(LEG, legBrand).ok, 'S4E-LEG-BRAND-VALID');
    await rtdb.ref('platform_config').update({ membership_writes_enabled: true, service_bounds: { min_lat: 13, max_lat: 17, min_lng: -90, max_lng: -83 } });
    await rtdb.ref(`restaurants/${LEG}/identity`).set(legId); await rtdb.ref(`brands/${LEG}`).set(legBrand);
    await rtdb.ref(`public/brands/${LEG}`).set({ name: 'S4 Leg', locations: { [LEG]: { location_name: 'Leg' } } });
    assert.ok((await mutateRoster({ db: rtdb }, LEG, { kind: 'cli', operator: 's4-schedule-only-test' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Dueña', email: 'leg@s4.test' } })).ok, 'S4E-OWNER-BOOTSTRAP');
    await fs.collection('restaurants').doc(LEG).set({ name: LEG });
    SO._resetListedCache();
    let w = null;
    for (let i = 0; i < 40; i++) { w = await post(app.quoteOrder, APP(LEG), '203.0.113.201'); if (w.status !== 400) break; await new Promise((r) => setTimeout(r, 250)); }
    assert.strictEqual(w.status, 200, `S4E-LEG-WARM ${w.text}`);
    assert.deepStrictEqual(JSON.parse(w.text).schedule.hours, H_OLD, 'S4E-FRESHNESS-BEFORE (the warm read serves the old hours)');
    const e7 = await callOps(ops.updateBranchProfile, { rid: LEG, expectedVersion: 3, patch: { hours: H_NEW } }, OWNER);
    assert.strictEqual(e7.status, 200, `S4E-E7-WRITE ${e7.text}`);
    assert.deepStrictEqual((await rtdb.ref(`restaurants/${LEG}/identity/hours`).get()).val(), H_NEW, 'S4E-E7-WROTE-HOURS');
    const after = await post(app.quoteOrder, APP(LEG), '203.0.113.201');
    assert.strictEqual(after.status, 200);
    const served = JSON.parse(after.text).schedule.hours;
    assert.deepStrictEqual(served, H_NEW, 'S4E-FRESHNESS-AFTER (the next real schedule_only serves the E7-written hours)');
    // the validator's decisions over the SERVED hours == over the hours intake reads (the identity) — and they moved with E7
    const { getIdentity } = require('../restaurant-config');
    const intakeHours = (await getIdentity(rtdb, LEG)).hours;
    const slotMs = SCHED.resolveCfg().slotMin * 60000;
    const now = Math.ceil(REAL_NOW() / slotMs) * slotMs;
    let moved = 0;
    for (let k = 4; k < 7 * 24 * 4; k += 3) {   // every 45 min across the week, from 1 h out
      const slot = now + k * slotMs;
      const a = SCHED.validateScheduledFor(served, slot, now, 'pickup'); const b = SCHED.validateScheduledFor(intakeHours, slot, now, 'pickup');
      assert.deepStrictEqual(a, b, `S4E-VALIDATOR-AGREES at +${k * 15} min`);
      if (a.valid !== SCHED.validateScheduledFor(H_OLD, slot, now, 'pickup').valid) moved++;
    }
    assert.ok(moved > 0, 'non-vacuity: some slot decisions changed with the E7 write');
    ok(`WRITER→READER: warm schedule_only (old hours) → real E7 updateBranchProfile → next real schedule_only serves the new hours; validateScheduledFor agrees with intake's identity over a week of slots (${moved} decisions moved)`);
  }
  // B — PAIRED ordinary quotes: base handler vs candidate handler, byte-identical (quote_token normalised)
  {
    await rtdb.ref('rate_limits').remove();
    const bodies = [];
    for (const rid of ['x_pizza', 'la_musa']) {
      const items = cartFor(rid);
      bodies.push({ restaurant_id: rid, items });                                                   // the forms' plain quote
      bodies.push({ restaurant_id: rid, items, schedule_only: false });
      bodies.push({ restaurant_id: rid, items, schedule_only: true });                               // not app-scoped → ordinary
      bodies.push({ restaurant_id: rid, items, schedule_only: true, entry_mode: 'form' });
      bodies.push({ restaurant_id: rid, items: [{ name: 'NOT A PIZZA', qty: 1 }] });                 // bad cart
    }
    bodies.push({ restaurant_id: GHOST, items: [] });                                                 // unknown rid
    const runChild = (which) => {
      const out = execFileSync(process.execPath, [__filename], { env: { ...process.env, S4_CHILD: which, S4_BODIES: JSON.stringify(bodies) }, encoding: 'utf8', maxBuffer: 1 << 26 });
      const line = out.split('\n').find((l) => l.startsWith('S4RESULT:'));
      assert.ok(line, `S4E-CHILD-${which} produced no result:\n${out.slice(-2000)}`);
      return JSON.parse(line.slice('S4RESULT:'.length));
    };
    const base = runChild('base');
    await rtdb.ref('rate_limits').remove();
    const cand = runChild('cand');
    assert.strictEqual(base.length, bodies.length);
    base.forEach((b, i) => assert.deepStrictEqual(cand[i], b, `S4E-PAIRED-QUOTE #${i} ${JSON.stringify(bodies[i]).slice(0, 120)}`));
    assert.ok(base.filter((b) => b.body && b.body.ok === true).length >= 6, 'non-vacuity: the paired carts actually priced');
    ok(`PAIRED: ${bodies.length} ordinary quote bodies (plain, schedule_only false / true-without-app / form, bad cart, unknown rid; both brands) → base == candidate responses`);
  }
  FINISHED = true;
  console.log(`\ns4-schedule-only(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
