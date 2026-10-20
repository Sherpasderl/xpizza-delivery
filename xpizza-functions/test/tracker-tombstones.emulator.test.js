'use strict';
// TRACKER FIXES T6 — sweepTrackerTombstones on the RTDB emulator (Admin SDK). Run: npm run test:tracker-tombstones
//  (1) deletes ONLY expired tombstones of terminal orders (claims + owner hints); keeps live grants, young tombstones, non-terminal
//      and missing orders
//  (2) a tombstone re-written (newer seq) after the scan is NOT deleted (transaction re-check), and a re-grant is never deleted
//  (3) pure updater: null → null (cold cache), same tombstone → delete, anything else → abort
require('./_emulator-required')('database');
const assert = require('assert');
const admin = require('firebase-admin');
const { sweepTrackerTombstones, deleteIfSameTombstone, validateLiveClaims, TOMBSTONE_TTL_MS } = require('../tracking/tombstones');
const { tagOf } = require('../tracking/tag');

const app = admin.initializeApp({ projectId: 'demo-tracker-tombstones', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-tracker-tombstones` }, 'tt');
const db = app.database();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const v = async (p) => (await db.ref(p).once('value')).val();
const NOW = 10 * TOMBSTONE_TTL_MS, OLD = NOW - TOMBSTONE_TTL_MS - 1, YOUNG = NOW - TOMBSTONE_TTL_MS + 1000;

(async () => {
  const watchdog = setTimeout(() => { console.error('tracker-tombstones: FAIL — timed out'); process.exit(1); }, 120000);
  // (3)
  const up = deleteIfSameTombstone(4, NOW - TOMBSTONE_TTL_MS);
  assert.strictEqual(up(null), null);
  assert.strictEqual(up({ seq: 4, gone: true, at: OLD }), null);
  assert.strictEqual(up({ seq: 5, gone: true, at: OLD }), undefined, 'newer seq → abort');
  assert.strictEqual(up({ seq: 4, gone: false, at: OLD }), undefined, 're-granted → abort');
  assert.strictEqual(up({ seq: 4, gone: true, at: YOUNG }), undefined, 'not expired → abort');
  ok('updater: cold cache → null; the exact expired tombstone → delete; newer seq / re-grant / young → abort');

  // (1)
  await db.ref('/').set(null);
  await db.ref().update({
    'orders/T1/status': 'delivered', 'orders/T2/status': 'cancelled', 'orders/L1/status': 'out_for_delivery',
    'tracker_claims/u1/T1': { seq: 4, gone: true, at: OLD },     // delete
    'tracker_claims/u2/T1': { seq: 4, gone: true, at: YOUNG },   // keep: young
    'tracker_claims/u1/T2': { seq: 2, gone: false, at: OLD },    // a LIVE grant on a CANCELLED order → validation tombstones it (2.5, young → not deleted yet)
    'tracker_claims/u3/L1': { seq: 3, gone: true, at: OLD },     // keep: order not terminal
    'tracker_claims/u3/GONE': { seq: 3, gone: true, at: OLD },   // keep: order missing (fail closed)
    'tracker_claims_owner/T1': { seq: 4, uid: null, gone: true, at: OLD },   // delete
    'tracker_claims_owner/T2': { seq: 2, uid: 'u1', gone: false, at: OLD },  // keep: live hint
    'tracker_claims_owner/L1': { seq: 3, uid: null, gone: true, at: OLD },   // keep: not terminal
  });
  const r = await sweepTrackerTombstones(db, NOW);
  assert.deepStrictEqual({ scanned: r.scanned, deleted: r.deleted, kept: r.kept }, { scanned: 5, deleted: 2, kept: 3 });
  assert.deepStrictEqual([r.validated.live, r.validated.staled], [1, 1], 'the one LIVE claim (on a cancelled order) is validated stale');
  assert.deepStrictEqual(await v('tracker_claims/u1/T2'), { seq: 2.5, gone: true, at: NOW }, 'tombstoned at seq + 0.5, young (deleted by a later sweep)');
  assert.strictEqual(await v('tracker_claims/u1/T1'), null); assert.strictEqual(await v('tracker_claims_owner/T1'), null);
  assert.ok(await v('tracker_claims/u2/T1')); assert.ok(await v('tracker_claims/u1/T2')); assert.ok(await v('tracker_claims/u3/L1'));
  assert.ok(await v('tracker_claims/u3/GONE')); assert.ok(await v('tracker_claims_owner/T2')); assert.ok(await v('tracker_claims_owner/L1'));
  assert.strictEqual((await v('orders/T1')).status, 'delivered', 'orders untouched');
  ok('deletes only expired tombstones of terminal orders (claim + owner hint); keeps young tombstones, live hints, non-terminal and missing orders; a LIVE grant on a terminal order is validated stale → tombstoned at seq + 0.5');

  // (2) a newer write lands between the scan and the delete
  await db.ref('/').set(null);
  await db.ref().update({ 'orders/T1/status': 'delivered', 'tracker_claims/u1/T1': { seq: 4, gone: true, at: OLD } });
  const realRef = db.ref.bind(db);
  const racing = { ref: (p) => {
    const ref = realRef(p);
    if (p !== 'tracker_claims/u1/T1') return ref;
    return { once: (...a) => ref.once(...a), transaction: async (f) => { await realRef(p).set({ seq: 9, gone: true, at: NOW }); return ref.transaction(f); } };
  } };
  const r2 = await sweepTrackerTombstones(racing, NOW);
  assert.deepStrictEqual({ scanned: r2.scanned, deleted: r2.deleted, kept: r2.kept }, { scanned: 1, deleted: 0, kept: 1 });
  assert.deepStrictEqual(await v('tracker_claims/u1/T1'), { seq: 9, gone: true, at: NOW }, 'the newer tombstone stands');
  ok('a tombstone re-written with a newer seq between the scan and the delete is NOT deleted (transaction re-check)');

  // (4) LIVE-claim VALIDATION (codex build r1 P1-1 ruling): every LIVE claim is checked against committed truth; stale ones are
  // tombstoned on the EXACT claim (same seq, still live) at seq + 0.5; legitimate ones and newer grants are never touched
  await db.ref('/').set(null);
  const SEC = 'val-secret', T = (u) => tagOf(SEC, u);
  const node = (mode, owner) => ({ order_id: 'x', status: 'out_for_delivery', mx: { seq: 9, mode, owner_tag: owner ? T(owner) : 'none', epoch: 1 } });
  const ord = (st, tok) => ({ status: st, tracking_token: tok });
  await db.ref().update({
    'orders/V1': ord('delivered', 'TV1'), 'order_tracking/TV1': node('terminal'), 'tasks/V1_delivery/assigned_driver_id': 'uB',              // terminal → stale
    'orders/V2': ord('out_for_delivery', 'TV2'), 'order_tracking/TV2': node('live', 'uC'), 'tasks/V2_delivery/assigned_driver_id': 'uC',      // owned by C → B stale
    'orders/V3': ord('out_for_delivery', 'TV3'), 'order_tracking/TV3': node('live', 'uB'), 'tasks/V3_delivery/assigned_driver_id': 'uC',      // B not the assignee → stale
    'orders/V4': ord('out_for_delivery', 'TV4'), 'order_tracking/TV4': node('live', 'uB'), 'tasks/V4_delivery/assigned_driver_id': 'uB',      // legit → kept
    'orders/V5': ord('out_for_delivery', 'TV5'), 'order_tracking/TV5': node('waiting', 'uB'), 'tasks/V5_delivery/assigned_driver_id': 'uB',   // legit waiting → kept
    'tracker_claims/uB/V1': { seq: 3, gone: false, at: 1 }, 'tracker_claims/uB/V2': { seq: 3, gone: false, at: 1 }, 'tracker_claims/uB/V3': { seq: 3, gone: false, at: 1 },
    'tracker_claims/uB/V4': { seq: 9, gone: false, at: 1 }, 'tracker_claims/uB/V5': { seq: 9, gone: false, at: 1 },
    'tracker_claims/uB/V6': { seq: 1, gone: false, at: 1 },                                                                                       // order missing → stale
    'orders/V9': ord('out_for_delivery', 'TV9'), 'order_tracking/TV9': node('live', 'uC'), 'tasks/V9_delivery/assigned_driver_id': 'uB',      // node owned by C, B still the assignee → ONLY the owner rule fires
    'tracker_claims/uB/V9': { seq: 3, gone: false, at: 1 },
    'orders/V10': ord('delivered', 'TV10'), 'order_tracking/TV10': node('live', 'uB'), 'tasks/V10_delivery/assigned_driver_id': 'uB',  // order delivered, node not recomputed yet → ONLY the order-terminal rule fires
    'tracker_claims/uB/V10': { seq: 3, gone: false, at: 1 },
  });
  const val = await validateLiveClaims(db, await v('tracker_claims'), NOW, { secret: SEC });
  assert.deepStrictEqual([val.live, val.staled, val.kept], [8, 6, 2], JSON.stringify(val));
  for (const o of ['V1', 'V2', 'V3', 'V9', 'V10']) assert.deepStrictEqual(await v(`tracker_claims/uB/${o}`), { seq: 3.5, gone: true, at: NOW }, `${o} tombstoned at 3.5`);
  assert.deepStrictEqual(await v('tracker_claims/uB/V6'), { seq: 1.5, gone: true, at: NOW });
  assert.deepStrictEqual(await v('tracker_claims/uB/V4'), { seq: 9, gone: false, at: 1 }, 'a legit LIVE claim is kept');
  assert.deepStrictEqual(await v('tracker_claims/uB/V5'), { seq: 9, gone: false, at: 1 }, 'a legit WAITING claim is kept');
  ok('validation: LIVE claims on a terminal order / a node owned by another driver (incl. B still the assignee: the owner rule alone) / an order already delivered whose node is not yet recomputed (the order rule alone) / a non-assignee / a missing order → tombstoned at seq + 0.5; legit live and waiting claims kept');

  // (5) exact-seq: a NEWER legitimate grant landing between the scan and the claim transaction is NEVER touched
  await db.ref('/').set(null);
  await db.ref().update({ 'orders/V7': ord('delivered', 'TV7'), 'order_tracking/TV7': node('terminal'), 'tracker_claims/uB/V7': { seq: 3, gone: false, at: 1 } });
  const scanned = await v('tracker_claims');
  await db.ref('tracker_claims/uB/V7').set({ seq: 12, gone: false, at: 2 });   // a newer grant lands after the scan
  const val2 = await validateLiveClaims(db, scanned, NOW, { secret: SEC });
  assert.deepStrictEqual([val2.staled, val2.kept], [0, 1]);
  assert.deepStrictEqual(await v('tracker_claims/uB/V7'), { seq: 12, gone: false, at: 2 }, 'the newer grant is untouched (exact-seq condition)');
  ok('validation is exact-seq: a newer grant landing after the scan is never tombstoned');

  // (6) one sweep = validation + deletion: the stale claim is tombstoned now and DELETED by the exact-seq deletion 24 h later
  await db.ref('/').set(null);
  await db.ref().update({ 'orders/V8': ord('cancelled', 'TV8'), 'order_tracking/TV8': node('terminal'), 'tracker_claims/uB/V8': { seq: 5, gone: false, at: 1 } });
  const s1 = await sweepTrackerTombstones(db, NOW, { secret: SEC });
  assert.strictEqual(s1.validated.staled, 1); assert.strictEqual((await v('tracker_claims/uB/V8')).seq, 5.5);
  const s2 = await sweepTrackerTombstones(db, NOW + TOMBSTONE_TTL_MS + 1, { secret: SEC });
  assert.strictEqual(s2.deleted, 1); assert.strictEqual(await v('tracker_claims/uB/V8'), null, 'deleted by the exact-seq deletion (seq 5.5)');
  ok('a stale LIVE claim is tombstoned by one sweep and deleted by the sweep after 24 h (the fractional seq matches the exact-seq delete)');

  clearTimeout(watchdog);
  await app.delete();
  console.log(`tracker-tombstones: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('tracker-tombstones: FAIL\n', e); process.exit(1); });
