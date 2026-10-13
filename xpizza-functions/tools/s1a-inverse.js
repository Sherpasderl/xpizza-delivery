'use strict';
// S1a (PLAN-S1 §3/§6) — the slice's index.js INVERSE. Every index.js-reversing wiring guard applies
// unapplyS1aIndex FIRST (newest-first, wrapping the read), then int7's extras inverse, etc., to reach 90fac9e
// and assert byte-for-byte. s1a-wiring.guard.test.js proves unapplyS1aIndex(index.js) === 90fac9e:index.js exactly.
//
// ONE source of truth: the scratch apply step applied was→now (applyS1aIndex) to the pristine 90fac9e:index.js to
// produce the committed index.js, so unapplyS1aIndex (now→was) reproduces 90fac9e byte-for-byte by construction.
// Each hunk's `was` occurs exactly once in 90fac9e and each `now` exactly once in the edited file.
const HUNKS = Object.freeze([
  // (a) requires — svc-assigner handle + the shared driver-callable hard-stop. Anchored on the VAPID comment that
  // FOLLOWS them (byte-identical in the live tree and in foldPortalSplit's output) — never on the lib/admin require,
  // which foldPortalSplit reverts to an inline initializeApp, so a hunk spanning it would miss in the fold guards.
  {
    was: "\n// VAPID config for Web Push (set via .env, deployed as runtime env vars)",
    now: "const { svcAssignerDb } = require('./lib/svc-assigner');   // S1a §3 — the narrowly-privileged ownership/shift writer handle"
       + "\nconst { assertDriverCallerActive } = require('./lib/driver-callable-guard');   // S1a §6 — the shared driver-callable hard-stop"
       + "\n\n// VAPID config for Web Push (set via .env, deployed as runtime env vars)",
  },
  // (b) callable hard-stop guards — one per driver callable, right after the uid check
  {
    was: "  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');\n  const token = String(request.data?.token || '').trim();\n",
    now: "  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');\n  await assertDriverCallerActive(uid, request.auth?.token, { db: getDatabase(), auth: getAuth(), HttpsError });   // S1a §6\n  const token = String(request.data?.token || '').trim();\n",
  },
  {
    was: "  const db = getDatabase();\n  await db.ref(`driver_push_tokens/${uid}`).remove();\n",
    now: "  await assertDriverCallerActive(uid, request.auth?.token, { db: getDatabase(), auth: getAuth(), HttpsError });   // S1a §6\n  const db = getDatabase();\n  await db.ref(`driver_push_tokens/${uid}`).remove();\n",
  },
  // startDriverShift: guard + the svc-assigner handle (shift-open is a §2(3) gated write)
  {
    was: "  const crypto = require('crypto');\n  const db = getDatabase();\n  const isNativeClient = request.data?.platform === 'native';\n",
    now: "  await assertDriverCallerActive(uid, request.auth?.token, { db: getDatabase(), auth: getAuth(), HttpsError });   // S1a §6\n  const crypto = require('crypto');\n  const db = getDatabase();\n  const svcDb = svcAssignerDb();   // S1a §3 — the shift-open write is rules-bound (new-shift transition gate)\n  const isNativeClient = request.data?.platform === 'native';\n",
  },
  {
    was: "  const db = getDatabase();\n  const hash = (await db.ref(`drivers/${uid}/ingest_token_hash`).once('value')).val();\n",
    now: "  await assertDriverCallerActive(uid, request.auth?.token, { db: getDatabase(), auth: getAuth(), HttpsError });   // S1a §6\n  const db = getDatabase();\n  const hash = (await db.ref(`drivers/${uid}/ingest_token_hash`).once('value')).val();\n",
  },
  // startDriverShift shift-open write → svc-assigner handle
  {
    was: "  await db.ref().update(updates);\n  console.log(`startDriverShift: ${uid} on shift ${shiftId} (source=${isNativeClient ? 'native' : 'pwa'})`);\n",
    now: "  await svcDb.ref().update(updates);   // S1a §3 — rules-bound shift-open (new-shift transition requires the target eligible)\n  console.log(`startDriverShift: ${uid} on shift ${shiftId} (source=${isNativeClient ? 'native' : 'pwa'})`);\n",
  },
  // (c) autoAssign — svc-assigner handle + claim + finalize
  {
    was: "    const db = getDatabase();\n    await sleep(GRACE_PERIOD_MS);\n",
    now: "    const db = getDatabase();\n    const svcDb = svcAssignerDb();   // S1a §3 — ownership-creating writes are rules-bound\n    await sleep(GRACE_PERIOD_MS);\n",
  },
  {
    was: "    // Only a genuine race (another writer already claimed) makes it back off instead of double-assigning.\n    const claim = await claimDelivery(db, orderId, chosen.driverId);\n",
    now: "    // Only a genuine race (another writer already claimed) makes it back off instead of double-assigning.\n    const claim = await claimDelivery(svcDb, orderId, chosen.driverId);   // S1a §3\n",
  },
  {
    was: "    const updates = buildAssignmentUpdates(orderId, chosen.driverId, 1, true, isStacked);\n    try {\n      await db.ref().update(updates);\n",
    now: "    const updates = buildAssignmentUpdates(orderId, chosen.driverId, 1, true, isStacked);\n    try {\n      await svcDb.ref().update(updates);   // S1a §3\n",
  },
  // (d) timeout-reassign — svc-assigner handle + claim + finalize
  {
    was: "    const db = getDatabase();\n    await sleep(ACCEPT_TIMEOUT_MS);\n",
    now: "    const db = getDatabase();\n    const svcDb = svcAssignerDb();   // S1a §3 — ownership-restoring writes are rules-bound\n    await sleep(ACCEPT_TIMEOUT_MS);\n",
  },
  {
    was: "    const claim = await claimDelivery(db, orderId, nextDriver.driverId, { expectCurrent: driverId });\n",
    now: "    const claim = await claimDelivery(svcDb, orderId, nextDriver.driverId, { expectCurrent: driverId });   // S1a §3\n",
  },
  {
    was: "    const reassignUpdates = buildAssignmentUpdates(orderId, nextDriver.driverId, attempts + 1, true);\n    try {\n      await db.ref().update(reassignUpdates);\n",
    now: "    const reassignUpdates = buildAssignmentUpdates(orderId, nextDriver.driverId, attempts + 1, true);\n    try {\n      await svcDb.ref().update(reassignUpdates);   // S1a §3\n",
  },
  // (e) sweeper — svc-assigner handle + claim + finalize
  {
    was: "    const db = getDatabase();\n    const now = Date.now();\n    // Read config + all data up front. The HEAL pass runs EVERY tick regardless of the flags (H1) — the\n",
    now: "    const db = getDatabase();\n    const svcDb = svcAssignerDb();   // S1a §3 — ownership-creating writes are rules-bound\n    const now = Date.now();\n    // Read config + all data up front. The HEAL pass runs EVERY tick regardless of the flags (H1) — the\n",
  },
  {
    was: "      // notifyDriverOnAssignment (fires on pickup only). NULL-claim: a pending order's delivery is null.\n      const claim = await claimDelivery(db, orderId, chosen.driverId);\n",
    now: "      // notifyDriverOnAssignment (fires on pickup only). NULL-claim: a pending order's delivery is null.\n      const claim = await claimDelivery(svcDb, orderId, chosen.driverId);   // S1a §3\n",
  },
  {
    was: "        updates[`tasks/${orderId}_delivery/retry_count`] = retryCount + 1;\n        updates[`tasks/${orderId}_delivery/last_swept`] = now;\n        await db.ref().update(updates);\n",
    now: "        updates[`tasks/${orderId}_delivery/retry_count`] = retryCount + 1;\n        updates[`tasks/${orderId}_delivery/last_swept`] = now;\n        await svcDb.ref().update(updates);   // S1a §3\n",
  },
]);

function applyHunks(src, dir) {   // dir: 'forward' = was→now, 'inverse' = now→was
  let out = src;
  for (const h of HUNKS) {
    const from = dir === 'forward' ? h.was : h.now;
    const to = dir === 'forward' ? h.now : h.was;
    const n = out.split(from).length - 1;
    if (n !== 1) throw new Error(`s1a-inverse(${dir}): a hunk ${dir === 'forward' ? 'was' : 'now'} occurs ${n}× (expected 1):\n${from.slice(0, 80)}…`);
    out = out.replace(from, () => to);
  }
  return out;
}
const applyS1aIndex = (src) => applyHunks(src, 'forward');
const unapplyS1aIndex = (src) => applyHunks(src, 'inverse');

module.exports = { HUNKS, applyS1aIndex, unapplyS1aIndex };
