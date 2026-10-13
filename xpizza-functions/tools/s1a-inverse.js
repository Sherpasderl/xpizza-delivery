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
  // (a2) isEligibilityDenial helper (§3 denial classification — codex r1 P1-4), before buildAssignmentUpdates
  {
    was: "function buildAssignmentUpdates(orderId, driverId, attempts, isAutoAssigned, isStacked = false) {",
    now: "function isEligibilityDenial(e) {   // S1a §3 (codex r1 P1-4) — an EXPECTED §2 eligibility denial surfaces as a permission-denied rejection from the svc-assigner write; classify it so callers handle it (next candidate / leave unassigned / continue the sweep) instead of crashing.\n  return /permission[_ ]denied/i.test(String((e && (e.code || e.message)) || e));\n}\nfunction buildAssignmentUpdates(orderId, driverId, attempts, isAutoAssigned, isStacked = false) {",
  },
  // (a3) native ingest deactivation gate (§8 — codex r1 P1-1), after resolving the opaque token
  {
    was: "  const uid = tokenRec.uid;\n\n  // Per-uid rate limit",
    now: "  const uid = tokenRec.uid;\n\n  // S1a §8 (codex r1 P1-1) — a DEACTIVATED driver's opaque token is immediately dead (Auth revoke does not invalidate it);\n  // a SUSPENDED driver (enabled:false, not deactivated) keeps ingesting to finish held work.\n  if ((await db.ref(`driver_accounts/${uid}/deactivated`).once('value')).val() === true) {\n    return res.status(403).json({ error: 'deactivated' });\n  }\n\n  // Per-uid rate limit",
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
    now: "    // Only a genuine race (another writer already claimed) makes it back off instead of double-assigning.\n    let claim;\n    try { claim = await claimDelivery(svcDb, orderId, chosen.driverId); }   // S1a §3\n    catch (e) { if (isEligibilityDenial(e)) { console.warn(`autoAssign: ${orderId} — ${chosen.driverId} not eligible at claim (${e && (e.code || e.message)}); leaving unassigned`); return; } throw e; }\n",
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
    now: "    let claim;\n    try { claim = await claimDelivery(svcDb, orderId, nextDriver.driverId, { expectCurrent: driverId }); }   // S1a §3\n    catch (e) { if (isEligibilityDenial(e)) { console.warn(`timeout-monitor: ${orderId} — ${nextDriver.driverId} not eligible at reassign claim (${e && (e.code || e.message)}); leaving on ${driverId}`); return; } throw e; }\n",
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
    now: "      // notifyDriverOnAssignment (fires on pickup only). NULL-claim: a pending order's delivery is null.\n      let claim;\n      try { claim = await claimDelivery(svcDb, orderId, chosen.driverId); }   // S1a §3\n      catch (e) { if (isEligibilityDenial(e)) { console.warn(`sweepPending: ${orderId} — ${chosen.driverId} not eligible at claim (${e && (e.code || e.message)}); skipping`); continue; } throw e; }\n",
  },
  {
    was: "        updates[`tasks/${orderId}_delivery/retry_count`] = retryCount + 1;\n        updates[`tasks/${orderId}_delivery/last_swept`] = now;\n        await db.ref().update(updates);\n",
    now: "        updates[`tasks/${orderId}_delivery/retry_count`] = retryCount + 1;\n        updates[`tasks/${orderId}_delivery/last_swept`] = now;\n        await svcDb.ref().update(updates);   // S1a §3\n",
  },
  // (f) notify-on-assignment account check (§14.2) — never push an assignment to a deactivated driver
  {
    was: "    const db = getDatabase();\n\n    // Look up the order for the notification body",
    now: "    const db = getDatabase();\n\n    // S1a §14.2 — never push an assignment to a DEACTIVATED driver (a backstop; §2 blocks the assignment itself when closed).\n    if ((await db.ref(`driver_accounts/${newDriverId}/deactivated`).once('value')).val() === true) {\n      console.warn(`notifyDriverOnAssignment: target ${newDriverId} is deactivated — no push`);\n      return;\n    }\n\n    // Look up the order for the notification body",
  },
  // (g) monitoring backstop (§5 + §14.2 payload, codex r1 P1-5/P1-8) — read-only; ALWAYS runs (anchored BEFORE the
  // offer-switch gate so it is never skipped when the offer pass is off). Fresh reads; detects deactivated
  // task-owners AND deactivated open shifts; reconciles one actionable alert per violation (cleared when resolved).
  {
    was: "    // ---- OFFER PASS (gated, S3a kill-switch) ----\n",
    now: "    // S1a §5 (codex r1 P1-5) — monitoring backstop (read-only, ALWAYS runs; BEFORE the offer-switch gate so it is\n"
       + "    // never skipped when the offer pass is off). Detects a DEACTIVATED driver that still owns a nonterminal task OR\n"
       + "    // holds an open shift, and reconciles ONE actionable dispatcher alert per such driver against the CURRENT state\n"
       + "    // (fresh reads; cleared when the violation resolves; content refreshed when the affected work changes). Keyed\n"
       + "    // strictly on deactivated===true; NO mutation of task/order/shift. Inert until S1b deactivates anyone.\n"
       + "    try {\n"
       + "      const [monTasksSnap, monDriversSnap, monAlertsSnap] = await Promise.all([\n"
       + "        db.ref('tasks').once('value'), db.ref('drivers').once('value'), db.ref('dispatcher_alerts').once('value')\n"
       + "      ]);\n"
       + "      const monTasks = monTasksSnap.val() || {}; const monDrivers = monDriversSnap.val() || {};\n"
       + "      const monOwnerOrders = {};\n"
       + "      for (const [monTid, monT] of Object.entries(monTasks)) {\n"
       + "        if (monT && monT.assigned_driver_id && monT.status !== 'completed' && monT.status !== 'cancelled') {\n"
       + "          (monOwnerOrders[monT.assigned_driver_id] = monOwnerOrders[monT.assigned_driver_id] || new Set()).add(monT.order_id || monTid);\n"
       + "        }\n"
       + "      }\n"
       + "      const monCandidates = new Set(Object.keys(monOwnerOrders));\n"
       + "      for (const [monUid, monD] of Object.entries(monDrivers)) {\n"
       + "        if (monD && (monD.active === true || (monD.current_shift_id !== undefined && monD.current_shift_id !== null))) monCandidates.add(monUid);\n"
       + "      }\n"
       + "      const monViolations = {};\n"
       + "      for (const monUid of monCandidates) {\n"
       + "        if ((await db.ref(`driver_accounts/${monUid}/deactivated`).once('value')).val() !== true) continue;\n"
       + "        const monD = monDrivers[monUid] || {};\n"
       + "        monViolations[monUid] = { order_ids: monOwnerOrders[monUid] ? [...monOwnerOrders[monUid]] : [], open_shift: monD.active === true || (monD.current_shift_id !== undefined && monD.current_shift_id !== null), shift_id: monD.current_shift_id || null, driver_name: monD.name || null };\n"
       + "      }\n"
       + "      const monExisting = monAlertsSnap.val() || {}; const monUpdates = {};\n"
       + "      for (const [monAid, monA] of Object.entries(monExisting)) {\n"
       + "        if (monA && monA.type === 'driver_deactivated' && monA.driver_uid && !monViolations[monA.driver_uid]) monUpdates[`dispatcher_alerts/${monAid}`] = null;\n"
       + "      }\n"
       + "      for (const [monUid, monV] of Object.entries(monViolations)) {\n"
       + "        const monPrior = monExisting[`driver_deactivated_${monUid}`];\n"
       + "        monUpdates[`dispatcher_alerts/driver_deactivated_${monUid}`] = { type: 'driver_deactivated', driver_uid: monUid, driver_name: monV.driver_name, order_ids: monV.order_ids, open_shift: monV.open_shift, shift_id: monV.shift_id, created_at: (monPrior && monPrior.created_at) || now, updated_at: now };\n"
       + "        console.warn(`sweepPending: driver_deactivated violation uid=${monUid} orders=${monV.order_ids.join(',')} open_shift=${monV.open_shift}`);\n"
       + "      }\n"
       + "      if (Object.keys(monUpdates).length) await db.ref().update(monUpdates);\n"
       + "    } catch (e) { console.error('sweepPending: deactivated monitor failed', e && e.message); }\n"
       + "    // ---- OFFER PASS (gated, S3a kill-switch) ----\n",
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
