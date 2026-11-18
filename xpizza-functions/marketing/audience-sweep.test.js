'use strict';
// offer-audience BUILD T9 (PLAN-5f-offer-audience r4.1 §5, BRIEF §5) — the two BOUNDED, RESUMABLE sweeps:
//   expireMarkers: per brand, the flat month index customer_seen_m/{brand}/{YYYY-MM}_{h} below the 24-month cutoff, oldest first, ≤ N
//     entries per run in total: a marker is deleted only if its m still equals that entry's month (a refreshed customer survives).
//   expireIds: audience_ids_by_day/{YYYY-MM-DD}_{orderId} older than 30 days, oldest first, ≤ N per run, WHATEVER the order's status:
//     an audience-'new' order first gets the create-if-absent decision 'sherpa'/'ids_expired' (BRIEF §5), then its codes + entry go.
// Markers and orders by the REAL chain (test/_audience-seed.js + the real writer).
// Run: node marketing/audience-sweep.test.js
const assert = require('assert');
const S = require('../test/_audience-seed');
const { HOUR, T0, quiet, profile, aworld, placeOrder, status, codes, KEY, RID } = S;
const OTP = require('../otp-lib');
const AWR = require('./audience-writer');
const ASW = require('./audience-sweep');
const OW = require('./offer-wire');
const BO = require('./brand-of');

let n = 0; let FINISHED = false; const fails = [];
async function cell(label, fn) { OW._resetCaches(); BO._reset(); try { await fn(label); console.log(`  ✓ ${++n} ${label}`); } catch (e) { fails.push(label); console.log(`  ✗ ${label}: ${e.message}`); } }
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ audience-sweep: exited without completing\n'); process.exitCode = 1; } });
const DAY = 86400000;
const P2 = '+504 9999-1111', P3 = '+504 7777-2222';
const hm = (y, mo) => Date.UTC(y, mo - 1, 10, 18);   // mid-month, HN noon

(async () => {
  await cell('SW-IDS: past 30 days, ANY status — the codes + entry go; a nuevos order first gets sherpa/ids_expired; a 20-day order is untouched', async (L) => {
    const w = await aworld(); profile(w, 'u1'); profile(w, 'u2', P2);
    const a = await placeOrder(w, 'u1'); const b = await placeOrder(w, 'u2'); const c = await placeOrder(w, 'u1', { at: T0 + 20 * DAY });
    await w.db.ref(`orders/${b}/status`).set('preparing');   // a stuck, non-terminal order
    const r = await ASW.expireIds(w.db, { nowMs: T0 + 31 * DAY, limit: 50, log: quiet });
    for (const o of [a, b]) {
      assert.deepStrictEqual([w.fake.get(`orders/${o}/audience_ids`), w.fake.get(`audience_ids_by_day/2026-11-16_${o}`)], [null, null], `🔴 ${L}: ${o} swept`);
      assert.deepStrictEqual(w.fake.get(`orders/${o}/offer_reconcile`), { funded_by: 'sherpa', reason: 'ids_expired', at: T0 + 31 * DAY }, `🔴 ${L}: ${o} decided Sherpa BEFORE the purge`);
    }
    assert.ok(w.fake.get(`orders/${c}/audience_ids`), `🔴 ${L}: the 20-day order keeps its codes`);
    assert.deepStrictEqual([r.deleted, r.decided], [2, 2], `${L}: counts (${JSON.stringify(r)})`);
  });
  await cell('SW-IDS-KEEP: an existing decision is NEVER overwritten (a writer that decided restaurant, then died before purging)', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const o = await placeOrder(w, 'u1');
    const failing = { ref: (p) => { const r = w.db.ref(p); return p.startsWith('customer_seen/') ? { ...r, transaction: async () => { throw new Error('injected'); } } : r; } };
    await w.db.ref(`orders/${o}/status`).set('delivered');
    await assert.rejects(AWR.onOrderStatus(failing, { orderId: o, status: 'delivered', eventTime: T0 + HOUR, nowMs: T0 + HOUR, key: KEY, log: quiet }), /injected/);
    assert.strictEqual(w.fake.get(`orders/${o}/offer_reconcile/funded_by`), 'restaurant', 'premise: decided, codes left');
    await ASW.expireIds(w.db, { nowMs: T0 + 31 * DAY, limit: 50, log: quiet });
    assert.deepStrictEqual([w.fake.get(`orders/${o}/offer_reconcile/funded_by`), w.fake.get(`orders/${o}/audience_ids`)], ['restaurant', null], `🔴 ${L}`);
  });
  await cell('SW-IDS-RESUME: ≤ N per run, oldest first; a later run continues where it stopped', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const os = []; for (let i = 0; i < 5; i += 1) os.push(await placeOrder(w, 'u1', { at: T0 + i * DAY }));
    const now = T0 + 40 * DAY; const left = () => os.filter((o) => w.fake.get(`orders/${o}/audience_ids`)).length;
    assert.strictEqual((await ASW.expireIds(w.db, { nowMs: now, limit: 2, log: quiet })).deleted, 2, `${L}: run 1`);
    assert.deepStrictEqual(os.map((o) => !!w.fake.get(`orders/${o}/audience_ids`)), [false, false, true, true, true], `🔴 ${L}: the OLDEST two first`);
    await ASW.expireIds(w.db, { nowMs: now, limit: 2, log: quiet }); await ASW.expireIds(w.db, { nowMs: now, limit: 2, log: quiet });
    assert.strictEqual(left(), 0, `🔴 ${L}: three runs clear five`);
    assert.deepStrictEqual(Object.keys(w.fake.get('audience_ids_by_day') || {}), [], `${L}: the index is empty (the fake keeps an empty parent; RTDB drops it)`);
  });
  await cell('SW-IDS-LATE: a fulfilment AFTER the deadline marks from the member\'s current profile; the funder stays Sherpa (ids_expired)', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const o = await placeOrder(w, 'u1');
    await ASW.expireIds(w.db, { nowMs: T0 + 31 * DAY, limit: 50, log: quiet });
    await status(w, o, 'delivered', T0 + 32 * DAY);
    assert.deepStrictEqual(w.fake.get(`orders/${o}/offer_reconcile/funded_by`), 'sherpa', `🔴 ${L}: stable`);
    assert.deepStrictEqual(w.fake.get(`customer_seen/tb/${codes().p}`), { m: '2026-12' }, `🔴 ${L}: marked from the current profile`);
  });
  await cell('SW-MARKERS: every overdue month, oldest first, ≤ N per run across runs; a marker still in the window stays', async (L) => {
    const w = await aworld(); const P4 = '+504 6666-3333';
    profile(w, 'u1'); profile(w, 'u2', P2); profile(w, 'u3', P3); profile(w, 'u4', P4);
    // four customers marked by the REAL writer in Aug / Sep / Oct / Dec 2024 (each run judged at its own time: in the window then)
    for (const [uid, at] of [['u1', hm(2024, 8)], ['u2', hm(2024, 9)], ['u3', hm(2024, 10)], ['u4', hm(2024, 12)]]) { const o = await placeOrder(w, uid); await status(w, o, 'delivered', at); }
    const h = (p) => codes('x', p).p; const now = T0;   // Nov 2026: cutoff 2024-11 ⇒ Aug + Sep + Oct overdue, Dec kept
    assert.ok(w.fake.get(`customer_seen/tb/${h(S.PHONE)}`) && w.fake.get(`customer_seen_m/tb/2024-08_${h(S.PHONE)}`), 'premise: the real writer marked + indexed');
    assert.strictEqual((await ASW.expireMarkers(w.db, { nowMs: now, limit: 1, log: quiet })).deleted, 1, `${L}: run 1 (N = 1)`);
    assert.deepStrictEqual([w.fake.get(`customer_seen/tb/${h(S.PHONE)}`), w.fake.get(`customer_seen/tb/${h(P2)}`)], [null, { m: '2024-09' }], `🔴 ${L}: the OLDEST month first, and only N`);
    assert.strictEqual((await ASW.expireMarkers(w.db, { nowMs: now, limit: 50, log: quiet })).deleted, 2, `🔴 ${L}: run 2 clears EVERY remaining overdue month (Sep + Oct), not one bucket`);
    assert.deepStrictEqual([w.fake.get(`customer_seen/tb/${h(P2)}`), w.fake.get(`customer_seen/tb/${h(P3)}`)], [null, null], `🔴 ${L}: Sep + Oct gone`);
    assert.strictEqual((await ASW.expireMarkers(w.db, { nowMs: now, limit: 50, log: quiet })).deleted, 0, `${L}: run 3: nothing overdue`);
    assert.deepStrictEqual([w.fake.get(`customer_seen/tb/${h(P4)}`), w.fake.get(`customer_seen_m/tb/2024-12_${h(P4)}`)], [{ m: '2024-12' }, true], `🔴 ${L}: Dec 2024 kept`);
    assert.strictEqual(w.fake.get(`customer_seen_m/tb/2024-08_${h(S.PHONE)}`), null, `${L}: the index entry went with it`);
  });
  await cell('SW-REFRESHED: an overdue index entry whose marker has since moved FORWARD only loses the entry — the marker survives', async (L) => {
    const w = await aworld(); profile(w, 'u1');
    const a = await placeOrder(w, 'u1'); await status(w, a, 'delivered', T0 + HOUR);   // m = 2026-11
    // a writer run for an old month that died after its index-first write (the month index entry exists, the marker did not move back)
    const failing = { ref: (p) => { const r = w.db.ref(p); return p.startsWith('customer_seen/') ? { ...r, transaction: async () => { throw new Error('injected'); } } : r; } };
    const b = await placeOrder(w, 'u1'); await w.db.ref(`orders/${b}/status`).set('delivered');
    await assert.rejects(AWR.onOrderStatus(failing, { orderId: b, status: 'delivered', eventTime: hm(2024, 10), nowMs: hm(2024, 10), key: KEY, log: quiet }), /injected/);
    assert.ok(w.fake.get(`customer_seen_m/tb/2024-10_${codes().p}`), 'premise: a stale overdue entry');
    await ASW.expireMarkers(w.db, { nowMs: T0, limit: 50, log: quiet });
    assert.deepStrictEqual([w.fake.get(`customer_seen/tb/${codes().p}`), w.fake.get(`customer_seen_m/tb/2024-10_${codes().p}`)], [{ m: '2026-11' }, null], `🔴 ${L}`);
  });
  await cell('SW-NOPII: the sweeps log counts only', async (L) => {
    const w = await aworld(); profile(w, 'u1'); await placeOrder(w, 'u1');
    const lines = []; const log = { warn: (...a) => lines.push(a.join(' ')), log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
    await ASW.expireIds(w.db, { nowMs: T0 + 31 * DAY, limit: 50, log }); await ASW.expireMarkers(w.db, { nowMs: T0, limit: 50, log });
    assert.ok(lines.length >= 1, 'premise: logged');
    const all = lines.join('\n'); for (const bad of ['u1', '8888', OTP.phoneHash(S.PHONE), codes().p, 'ord']) assert.ok(!all.includes(bad), `🔴 ${L}: ${bad} in ${all}`);
  });
  FINISHED = true;
  if (fails.length) { console.log(`audience-sweep: ${fails.length} FAILED`); process.exit(1); }
  console.log(`audience-sweep: OK (${n})`);
})();
