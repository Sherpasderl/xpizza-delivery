'use strict';
// ---------------------------------------------------------------------------
// The nightly sold-out reset against the REAL RTDB emulator + the REAL runAvailabilityReset
// (PLAN-availability-reset-fix rev 3, §Tests 1–7b; codex B2: the fake in availability-reset.test.js calls the
// updater once with stored data and cannot see SDK transaction semantics).
//
//   npm run test:availability-reset          (tools/emulator-run.js --only database)
//
// TWO+ Admin apps: a SEED/RACING app, and a WORKER app per run with NO listeners on the availability or marker
// paths (fresh per run, so every run starts cold, exactly like production). Case 4 adds a WARM app (a listener
// on ONE item path) — the only deterministic way to make the updater see the eligible object first and then
// null at the UPDATER level.
// Each case runs independently and is reported ✓/✗, so the run against the unfixed base module
// (RESET_MODULE=<path>) shows SEPARATE failures for removal (1) and finalize (2) — the plan's non-vacuity.
// OWNER RULE cells (P1–P5) prove the working behaviours this touches are preserved: the KDS toggles (fixtures
// ORIGINATE from the real KDS writer), the server availability gate, the forms' sold-out display (the forms'
// reducer copy), the marker paths' shape, and isolation of everything else.
// ---------------------------------------------------------------------------
require('./_emulator-required')('database');   // 🔴 prod-wipe guard FIRST — before any app is created (index.js is never required here)

const assert = require('assert');
const path = require('path');
const admin = require('firebase-admin');
const { ServerValue } = require('firebase-admin/database');

const RESET_MODULE = process.env.RESET_MODULE ? path.resolve(process.env.RESET_MODULE) : path.join(__dirname, '..', 'availability-reset');
const AR = require(RESET_MODULE);
const { checkItemAvailability } = require('../availability-gate');
const formsReducer = require('../../xpizza-orders/availability-reducer');   // the FORMS' copy (byte-identical to the server's — asserted in P3)

const NS = 'demo-xpizza';
const URL = `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${NS}`;
const seedApp = admin.initializeApp({ databaseURL: URL, projectId: NS }, 'seed');
const seed = seedApp.database();
let appSeq = 0;
const freshApp = () => admin.initializeApp({ databaseURL: URL, projectId: NS }, `worker-${++appSeq}`);

const CLOSED = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { open: false }]));
const OPEN = Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((d) => [d, { open: true, start: '00:00', end: '24:00' }]));
const DAY = 86400000;
const L = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h + 6, mi);   // a Tegucigalpa wall-clock instant
const RID = 'x_pizza';                                                  // a real restaurant id (the gate keys x_pizza lines by name)
const MARKER = `restaurants/${RID}/availability_reset_marker`;
const AVAIL = `restaurants/${RID}/item_availability`;

const val = async (p) => (await seed.ref(p).once('value')).val();
// RTDB never stores a null-valued child, so the stored form of a value written with `completed_at: null` lacks it.
const stored = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === null && k !== '' ? undefined : v)));
async function serverNow() { await seed.ref('_probe/t').set(ServerValue.TIMESTAMP); return val('_probe/t'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let KDS;   // the real-writer capture (ESM), loaded in main()

// Apply the REAL KDS writer's payload (serverTimestamp sentinel → the server clock).
async function kdsToggle(rawKey, available, uid = 'kds-uid') {
  const payload = await KDS.captureSetItemAvailability(RID, rawKey, available, uid);
  const resolved = {};
  for (const [p, v] of Object.entries(payload)) resolved[p] = JSON.parse(JSON.stringify(v), (k, x) => (x && x.__serverTimestamp ? ServerValue.TIMESTAMP : x));
  await seed.ref().update(resolved);
  return KDS.availKey(rawKey);
}

async function freshRestaurant(hours = CLOSED) {
  await seed.ref(`restaurants/${RID}`).set({ identity: { hours } });
}

// One run on a FRESH, listener-free worker app. Returns { results, logs, trace }.
async function run({ now = Date.now(), hooks = {}, app = null } = {}) {
  const a = app || freshApp();
  const logs = [];
  const log = { info: (...x) => logs.push(['info', x.join(' ')]), error: (...x) => logs.push(['error', x.join(' ')]) };
  const trace = [];
  const userTrace = hooks.traceClear;
  try {
    const results = await AR.runAvailabilityReset({ db: a.database(), ServerValue, now, restaurants: [RID], log, hooks: { ...hooks, traceClear: (p, cur) => { trace.push({ p, cur: cur === null ? null : JSON.parse(JSON.stringify(cur)) }); if (userTrace) userTrace(p, cur); } } });
    return { results, r: results[0], logs, trace };
  } finally { if (!app) await a.delete(); }
}

// ── the case runner: every case runs; failures are collected and reported separately ─────────────────────
const cases = [];
const caseOf = (name, fn) => cases.push({ name, fn });
let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 suite exited before finishing'); process.exit(1); } });

// 1. Stale 86 (from the REAL KDS writer, before the cutoff) while CLOSED → removed; cleared lists exactly it;
//    marker done; the NEXT tick → already_done with state unchanged. Callback trace: the worker's FIRST
//    invocation sees null (cold), a later one sees the server data.
caseOf('1 stale 86 removed on a cold worker; marker done; next tick already_done', async () => {
  await freshRestaurant();
  const k = await kdsToggle('Margherita', false);
  const { r, trace } = await run();
  assert.deepStrictEqual(r.cleared, [k], `cleared ${JSON.stringify(r && r.cleared)} (removal)`);
  assert.strictEqual(await val(`${AVAIL}/${k}`), null, 'the stale 86 is gone (removal)');
  const t = trace.filter((x) => x.p.endsWith(`/${k}`));
  assert.strictEqual(t[0] && t[0].cur, null, 'non-vacuity: the FIRST updater invocation saw null (the cold probe)');
  assert(t.some((x) => x.cur && x.cur.available === false), 'a later invocation saw the SERVER value');
  const m = await val(MARKER);
  assert.strictEqual(m.status, 'done', 'marker finalized'); assert(Number.isFinite(m.completed_at));
  const before = JSON.stringify(await val(`restaurants/${RID}`));
  const again = await run();
  assert.strictEqual(again.r.reason, 'already_done');
  assert.strictEqual(JSON.stringify(await val(`restaurants/${RID}`)), before, 'next tick changes nothing');
});

// 2. EMPTY availability → marker done (finalize proven on its own).
caseOf('2 empty availability → marker done (finalize on its own)', async () => {
  await freshRestaurant();
  const { r } = await run();
  assert.deepStrictEqual(r.cleared, []);
  const m = await val(MARKER);
  assert.strictEqual(m && m.status, 'done', `marker ${JSON.stringify(m)} (finalize)`);
});

// 3. Barriers AFTER the snapshot and BEFORE the CAS (racing app) → kept, NOT counted.
for (const [label, mutate, expect] of [
  ['changed to available:true', (k) => seed.ref(`${AVAIL}/${k}`).set({ available: true, updated_at: ServerValue.TIMESTAMP }), (v) => v && v.available === true],
  ['updated_at moved past the cutoff', (k) => seed.ref(`${AVAIL}/${k}`).set({ available: false, updated_at: ServerValue.TIMESTAMP }), (v) => v && v.available === false],
  ['a different updated_at still below the cutoff', async (k) => { const v = await val(`${AVAIL}/${k}`); await seed.ref(`${AVAIL}/${k}`).set({ available: false, updated_at: v.updated_at - 1 }); }, (v) => v && v.available === false],
  ['deleted', (k) => seed.ref(`${AVAIL}/${k}`).remove(), (v) => v === null],
]) {
  caseOf(`3 barrier: ${label} → kept, not counted`, async () => {
    await freshRestaurant();
    const k = await kdsToggle('Pepperoni', false);
    await sleep(5);
    const { r } = await run({ hooks: { afterSnapshot: async () => { await sleep(5); await mutate(k); } } });
    assert.deepStrictEqual(r.cleared, [], `counted ${JSON.stringify(r.cleared)}`);
    assert(expect(await val(`${AVAIL}/${k}`)), 'the racer\'s state stands');
    assert.strictEqual((await val(MARKER)).status, 'done');
  });
}

// 4. Retry accounting at the UPDATER level: one invocation receives the ELIGIBLE object (flag → true), the
//    racing app deletes it, the next invocation receives NULL (flag reset → false), then committed:true →
//    NOT counted. (A warm app — a listener on that one item — makes the eligible-first order deterministic:
//    it goes offline after the snapshot, the racer deletes on the server, and it comes back online.)
caseOf('4 retry accounting: eligible then null at the updater → committed but NOT counted', async () => {
  await freshRestaurant();
  const k = await kdsToggle('Calzone', false);
  const warm = freshApp();
  const wdb = warm.database();
  wdb.ref(`${AVAIL}/${k}`).on('value', () => {});
  await sleep(200);
  let raced = false;
  try {
    const { r, trace } = await run({ app: warm, hooks: {
      afterSnapshot: async () => { wdb.goOffline(); },
      traceClear: (p, cur) => {
        if (!raced && cur && cur.available === false) {
          raced = true;
          setTimeout(async () => { await seed.ref(`${AVAIL}/${k}`).remove(); wdb.goOnline(); }, 0);
        }
      },
    } });
    const seq = trace.filter((x) => x.p.endsWith(`/${k}`)).map((x) => (x.cur === null ? 'null' : 'eligible'));
    assert.deepStrictEqual(seq.slice(0, 2), ['eligible', 'null'], `updater saw ${JSON.stringify(seq)}`);
    assert.strictEqual(seq[seq.length - 1], 'null', 'the committing invocation saw null');
    assert.deepStrictEqual(r.cleared, [], `a key the racer deleted was COUNTED ${JSON.stringify(r.cleared)} — the per-invocation reset of \`removed\` is missing`);
  } finally { wdb.ref(`${AVAIL}/${k}`).off(); await warm.delete(); }
});

// 5. Boundaries: updated_at == cutoff → removed; malformed updated_at (string, missing) → kept.
caseOf('5 boundaries: == cutoff removed; malformed updated_at kept', async () => {
  await freshRestaurant();
  await seed.ref(`${AVAIL}/bad_str`).set({ available: false, updated_at: 'yesterday' });
  await seed.ref(`${AVAIL}/bad_missing`).set({ available: false });
  const { r } = await run({ hooks: { beforeReadBack: async () => {
    const s = (await val(MARKER)).started_at;
    await seed.ref(`${AVAIL}/at_cutoff`).set({ available: false, updated_at: s });
  } } });
  assert.deepStrictEqual(r.cleared, ['at_cutoff']);
  assert.strictEqual(await val(`${AVAIL}/at_cutoff`), null);
  assert.deepStrictEqual(await val(`${AVAIL}/bad_str`), { available: false, updated_at: 'yesterday' });
  assert.deepStrictEqual(await val(`${AVAIL}/bad_missing`), { available: false });
});

// 6. While OPEN → skipped, nothing touched.
caseOf('6 open → skipped, nothing touched', async () => {
  await freshRestaurant(OPEN);
  await kdsToggle('Margherita', false);
  const before = JSON.stringify(await val('/'));
  const { r } = await run();
  assert.strictEqual(r.reason, 'open');
  assert.strictEqual(JSON.stringify(await val('/')), before);
});

// 7a. A NEWER-day marker at claim → newer_marker (returned AND logged), marker and availability unchanged.
caseOf('7a newer-day marker at claim → newer_marker; nothing changed', async () => {
  await freshRestaurant();
  const k = await kdsToggle('Margherita', false);
  const now = Date.now();
  const newer = { date: AR.localDateInTZ(now + DAY), status: 'in_progress', started_at: 123, completed_at: null };
  await seed.ref(MARKER).set(newer);
  const before = JSON.stringify(await val(`restaurants/${RID}`));
  const { r, results } = await run({ now });
  assert.strictEqual(r.reason, 'newer_marker');
  assert(AR.outcomeLogLines ? AR.outcomeLogLines(results).some((l) => /"outcome":"newer_marker"/.test(l)) : false, 'logged as newer_marker');
  assert.strictEqual(JSON.stringify(await val(`restaurants/${RID}`)), before);
  assert(await val(`${AVAIL}/${k}`));
});

// 7b-1/2. Supersession AFTER the claim commits and BEFORE the read-back → skipped:<reason>, availability
//         unchanged, the ENTIRE replacement marker unchanged.
for (const [label, replacement, reason] of [
  ['a newer-date in_progress marker', (now) => ({ date: AR.localDateInTZ(now + DAY), status: 'in_progress', started_at: 999, completed_at: null }), 'skipped:marker_date'],
  ['a same-date done marker', (now) => ({ date: AR.localDateInTZ(now), status: 'done', started_at: 999, completed_at: 1000 }), 'skipped:marker_status'],
]) {
  caseOf(`7 supersession before read-back (${label}) → ${reason}`, async () => {
    await freshRestaurant();
    const k = await kdsToggle('Margherita', false);
    const now = Date.now();
    const rep = replacement(now);
    const { r } = await run({ now, hooks: { beforeReadBack: async () => { await seed.ref(MARKER).set(rep); } } });
    assert.strictEqual(r.reason, reason);
    assert.deepStrictEqual(await val(MARKER), stored(rep), 'the ENTIRE replacement marker unchanged');
    assert(await val(`${AVAIL}/${k}`), 'availability unchanged');
  });
}

// 7c. Supersession between read-back and finalize → the replacement marker's ENTIRE value unchanged.
caseOf('7 supersession before finalize → replacement marker unchanged', async () => {
  await freshRestaurant();
  const now = Date.now();
  const rep = { date: AR.localDateInTZ(now), status: 'in_progress', started_at: 42, completed_at: null };
  await run({ now, hooks: { beforeFinalize: async () => { await seed.ref(MARKER).set(rep); } } });
  assert.deepStrictEqual(await val(MARKER), stored(rep), 'the ENTIRE replacement marker unchanged');
});

// 7d. A resume keeps the original started_at (cutoff); an 86 stamped AFTER it survives (P1: a fresh KDS 86).
caseOf('7 resume keeps the original cutoff; a later KDS 86 survives', async () => {
  await freshRestaurant();
  const now = Date.now();
  const kOld = await kdsToggle('Margherita', false);
  await sleep(20);
  const S = await serverNow();
  await seed.ref(MARKER).set({ date: AR.localDateInTZ(now), status: 'in_progress', started_at: S, completed_at: null });
  await sleep(20);
  const kNew = await kdsToggle('Pepperoni', false);   // stamped AFTER the original cutoff
  const { r } = await run({ now });
  assert.deepStrictEqual(r.cleared, [kOld]);
  assert(await val(`${AVAIL}/${kNew}`), 'the post-cutoff 86 survives');
  const m = await val(MARKER);
  assert.strictEqual(m.started_at, S, 'cutoff preserved'); assert.strictEqual(m.status, 'done');
});

// 7b. Calendar-day ticks (fake WALL clock; the cutoff is the real server clock).
caseOf('7b same-date resume keeps the cutoff; local-midnight rollover takes a fresh one', async () => {
  await freshRestaurant();
  const D = L(2026, 10, 5, 23, 0), D2 = L(2026, 10, 6, 0, 10);   // tick 2 at D + 20 min = 23:20, still the 5th
  // tick 1 on date D crashes before finalize → in_progress with cutoff S1
  await run({ now: D, hooks: { beforeFinalize: async () => { throw new Error('crash'); } } });
  const S1 = (await val(MARKER)).started_at;
  await sleep(20);
  const kBetween = await kdsToggle('Margherita', false);   // stamped between the old cutoff and the next day's
  // tick 2, SAME date D → resume with S1: the 86 (after S1) survives the old day's run
  const t2 = await run({ now: D + 20 * 60000 });
  assert.deepStrictEqual(t2.r.cleared, []); assert.strictEqual((await val(MARKER)).started_at, S1, 'same-date resume keeps the cutoff');
  assert(await val(`${AVAIL}/${kBetween}`), 'survives the old day\'s run');
  // tick 3, after LOCAL MIDNIGHT → fresh claim, fresh cutoff → cleared
  await sleep(20);
  const t3 = await run({ now: D2 });
  assert.deepStrictEqual(t3.r.cleared, [kBetween], 'the new day\'s run clears it');
  const m = await val(MARKER);
  assert.strictEqual(m.date, '2026-10-06'); assert(m.started_at > S1, 'fresh cutoff'); assert.strictEqual(m.status, 'done');
});
caseOf('7b a DELAYED older invocation meets the newer marker → newer_marker', async () => {
  await freshRestaurant();
  await run({ now: L(2026, 10, 6, 0, 10) });                      // the new day's run completed
  const after = await val(MARKER);
  const { r } = await run({ now: L(2026, 10, 5, 23, 50) });       // a delayed run still on the old date
  assert.strictEqual(r.reason, 'newer_marker');
  assert.deepStrictEqual(await val(MARKER), after);
});
caseOf('7b dates are America/Tegucigalpa (an evening tick is NOT the next UTC date)', async () => {
  await freshRestaurant();
  await run({ now: L(2026, 10, 5, 2, 0) });                       // date 2026-10-05 done
  const after = await val(MARKER);
  const { r } = await run({ now: L(2026, 10, 5, 19, 0) });        // 19:00 local = 01:00 UTC on the 6th
  assert.strictEqual(r.reason, 'already_done', 'a UTC-date implementation would claim 2026-10-06 here');
  assert.deepStrictEqual(await val(MARKER), after);
});

// ── OWNER RULE: preserved working behaviours ────────────────────────────────────────────────────────────
// P1. KDS sold-out toggles: fixtures from the REAL writer; the reset never touches the private audit trail or
//     an item the KDS re-enabled (available:true), and only deletes (never writes) item_availability.
caseOf('P1 KDS toggles preserved: audit untouched, re-enabled item untouched, delete-only', async () => {
  await freshRestaurant();
  const k86 = await kdsToggle('Margherita', false, 'staff-1');
  const kOn = await kdsToggle('Pepperoni', true, 'staff-2');
  const auditBefore = JSON.stringify(await val(`restaurants/${RID}/availability_audit`));
  const onBefore = await val(`${AVAIL}/${kOn}`);
  const { r } = await run();
  assert.deepStrictEqual(r.cleared, [k86]);
  assert.strictEqual(JSON.stringify(await val(`restaurants/${RID}/availability_audit`)), auditBefore, 'availability_audit byte-identical');
  assert.deepStrictEqual(await val(`${AVAIL}/${kOn}`), onBefore, 'the KDS available:true entry byte-identical');
  // and a KDS toggle after the reset still writes and reads exactly as before
  const k2 = await kdsToggle('Margherita', false, 'staff-3');
  const v = await val(`${AVAIL}/${k2}`);
  assert.deepStrictEqual(Object.keys(v).sort(), ['available', 'updated_at']); assert.strictEqual(v.available, false);
});

// P2. Server availability gate (the real checkItemAvailability): blocked before, open after; a post-cutoff
//     86 stays blocked.
caseOf('P2 server availability gate: cleared item sells again; a fresh 86 still blocks', async () => {
  await freshRestaurant();
  await kdsToggle('Margherita', false);
  assert.deepStrictEqual((await checkItemAvailability(seed, [{ name: 'Margherita' }], RID)).blocked, ['Margherita'], 'premise: blocked before');
  const now = Date.now();
  await run({ now, hooks: { afterSnapshot: async () => { await sleep(5); await kdsToggle('Pepperoni', false); } } });
  assert.deepStrictEqual((await checkItemAvailability(seed, [{ name: 'Margherita' }], RID)).blocked, [], 'cleared → available at intake');
  assert.deepStrictEqual((await checkItemAvailability(seed, [{ name: 'Pepperoni' }], RID)).blocked, ['Pepperoni'], 'a post-cutoff 86 still blocks');
});

// P3. Forms' sold-out display: the forms' own reducer copy (byte-identical to the server's) reads the
//     post-reset node exactly as before: absent → available; a surviving 86 → sold out.
caseOf('P3 forms\' sold-out display reads the post-reset node correctly', async () => {
  const fs = require('fs');
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-orders', 'availability-reducer.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'availability-reducer.js'), 'utf8'), 'forms and server share the byte-identical reducer');
  await freshRestaurant();
  const k = await kdsToggle('Margherita', false);
  const node0 = await val(AVAIL);
  assert.strictEqual(formsReducer.decide([node0[k]], 'any_false'), true, 'premise: sold out before');
  await run({ hooks: { afterSnapshot: async () => { await sleep(5); await kdsToggle('Pepperoni', false); } } });
  const node = (await val(AVAIL)) || {};
  assert.strictEqual(formsReducer.decide([node[k]], 'any_false'), false, 'cleared → shown available');
  assert.strictEqual(formsReducer.decide([node[KDS.availKey('Pepperoni')]], 'any_false'), true, 'a fresh 86 → still shown sold out');
});

// P4. Marker paths: the marker keeps EXACTLY its existing shape (the rules deny clients on this path; the
//     Admin function writes it).
caseOf('P4 marker shape unchanged: {date, status, started_at, completed_at}', async () => {
  await freshRestaurant();
  await run();
  const m = await val(MARKER);
  assert.deepStrictEqual(Object.keys(m).sort(), ['completed_at', 'date', 'started_at', 'status']);
  assert(typeof m.date === 'string' && m.status === 'done' && Number.isFinite(m.started_at) && Number.isFinite(m.completed_at));
});

// P5. Isolation: a full run changes NOTHING outside item_availability deletions and the marker.
caseOf('P5 isolation: everything outside the two paths is byte-identical', async () => {
  await freshRestaurant();
  await seed.ref('orders/O1').set({ status: 'new', restaurant_id: RID, total_cents: 100 });
  await seed.ref(`restaurants/${RID}/identity/name`).set('X');
  await kdsToggle('Margherita', false);
  const strip = (t) => { const c = JSON.parse(JSON.stringify(t || {})); if (c.restaurants && c.restaurants[RID]) { delete c.restaurants[RID].item_availability; delete c.restaurants[RID].availability_reset_marker; } delete c._probe; return JSON.stringify(c); };
  const before = strip(await val('/'));
  await run();
  assert.strictEqual(strip(await val('/')), before);
});

(async () => {
  KDS = await import('./kds-writer-capture.mjs');
  console.log(`module under test: ${path.relative(process.cwd(), RESET_MODULE) || RESET_MODULE}`);
  const failures = [];
  let passed = 0;
  for (const c of cases) {
    try { await seed.ref('/').set(null); await c.fn(); passed++; console.log(`  ✓ ${passed} ${c.name}`); }
    catch (e) { failures.push(c.name); console.log(`  ✗ ${c.name}\n      ${String(e && e.message).split("\n").slice(0, 6).join(" ")}`); }
  }
  console.log(`\navailability-reset.emulator: ${passed}/${cases.length} cases passed${failures.length ? ` — FAILED: ${failures.join(' | ')}` : ''}`);
  __finished = true;
  await seedApp.delete();
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
