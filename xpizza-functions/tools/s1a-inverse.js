'use strict';
// S1a (PLAN-S1 §3/§6) — the slice's index.js INVERSE. Every index.js-reversing wiring guard applies
// unapplyS1aIndex FIRST (newest-first, wrapping the read), then H0's inverse, then int10's serial3 inverse, then
// extras, etc., to reach c83f2f9 and assert byte-for-byte. s1a-wiring.guard.test.js proves unapplyS1aIndex(index.js) === c83f2f9:index.js exactly.
//
// ONE source of truth: the scratch apply step applied was→now (applyS1aIndex) to the pristine c83f2f9:index.js to
// produce the committed index.js, so unapplyS1aIndex (now→was) reproduces c83f2f9 byte-for-byte by construction.
// (Rebased int7 90fac9e → int10 8f1e017 → H0 438a6c6 → G2 34d935f → S2 c83f2f9; serial3's and H0's index.js deltas are
// disjoint from every S1a hunk, and H0/G2/S2 did not touch index.js, so the hunks are unchanged and remain byte-exact against the new base.)
// Each hunk's `was` occurs exactly once in c83f2f9 and each `now` exactly once in the edited file.
const HUNKS = Object.freeze([
  // (a) requires — svc-assigner handle + the shared driver-callable hard-stop. Anchored on the VAPID comment that
  // FOLLOWS them (byte-identical in the live tree and in foldPortalSplit's output) — never on the lib/admin require,
  // which foldPortalSplit reverts to an inline initializeApp, so a hunk spanning it would miss in the fold guards.
  {
    was: "\n// VAPID config for Web Push (set via .env, deployed as runtime env vars)",
    now: "const { pickHandle, svcWriteOrFallback, isExpectedEligibilityDenial } = require('./lib/svc-handle');   // S1a §3 — flag-gated ownership/shift writer handle + tolerant-mode fallback"
       + "\nconst { assertDriverCallerActive } = require('./lib/driver-callable-guard');   // S1a §6 — the shared driver-callable hard-stop"
       + "\n\n// VAPID config for Web Push (set via .env, deployed as runtime env vars)",
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
    now: "  await assertDriverCallerActive(uid, request.auth?.token, { db: getDatabase(), auth: getAuth(), HttpsError });   // S1a §6\n  const crypto = require('crypto');\n  const db = getDatabase();\n  const svcDb = await pickHandle(db);   // S1a §3 — the shift-open write is rules-bound (new-shift transition gate)\n  const isNativeClient = request.data?.platform === 'native';\n",
  },
  {
    was: "  const db = getDatabase();\n  const hash = (await db.ref(`drivers/${uid}/ingest_token_hash`).once('value')).val();\n",
    now: "  await assertDriverCallerActive(uid, request.auth?.token, { db: getDatabase(), auth: getAuth(), HttpsError });   // S1a §6\n  const db = getDatabase();\n  const hash = (await db.ref(`drivers/${uid}/ingest_token_hash`).once('value')).val();\n",
  },
  // startDriverShift shift-open write → svc-assigner handle
  {
    was: "  await db.ref().update(updates);\n  console.log(`startDriverShift: ${uid} on shift ${shiftId} (source=${isNativeClient ? 'native' : 'pwa'})`);\n",
    now: "  await svcWriteOrFallback(db, svcDb, (h) => h.ref().update(updates), { site: 'startDriverShift', target: uid });   // S1a §3 — rules-bound shift-open (new-shift transition requires the target eligible)\n  console.log(`startDriverShift: ${uid} on shift ${shiftId} (source=${isNativeClient ? 'native' : 'pwa'})`);\n",
  },
  // (c) autoAssign — svc-assigner handle + claim + finalize
  {
    was: "    const db = getDatabase();\n    await sleep(GRACE_PERIOD_MS);\n",
    now: "    const db = getDatabase();\n    const svcDb = await pickHandle(db);   // S1a §3 — ownership-creating writes are rules-bound\n    await sleep(GRACE_PERIOD_MS);\n",
  },
  {
    was: "    // Only a genuine race (another writer already claimed) makes it back off instead of double-assigning.\n    const claim = await claimDelivery(db, orderId, chosen.driverId);\n",
    now: "    // Only a genuine race (another writer already claimed) makes it back off instead of double-assigning.\n    let claim;\n    try { claim = await svcWriteOrFallback(db, svcDb, (h) => claimDelivery(h, orderId, chosen.driverId), { site: 'autoAssign.claim', target: chosen.driverId }); }   // S1a §3\n    catch (e) { if (await expectedIneligibleOrMain(e, db, svcDb, chosen.driverId, 'autoAssign')) { console.warn(`autoAssign: ${orderId} — ${chosen.driverId} not eligible at claim (${e && (e.code || e.message)}); leaving unassigned`); return; } throw e; }\n",
  },
  {
    was: "    const updates = buildAssignmentUpdates(orderId, chosen.driverId, 1, true, isStacked);\n    try {\n      await db.ref().update(updates);\n",
    now: "    const updates = buildAssignmentUpdates(orderId, chosen.driverId, 1, true, isStacked);\n    try {\n      await svcWriteOrFallback(db, svcDb, (h) => h.ref().update(updates), { site: 'autoAssign.finalize', target: chosen.driverId });   // S1a §3\n",
  },
  // (d) timeout-reassign — svc-assigner handle + claim + finalize
  {
    was: "    const db = getDatabase();\n    await sleep(ACCEPT_TIMEOUT_MS);\n",
    now: "    const db = getDatabase();\n    await sleep(ACCEPT_TIMEOUT_MS);\n",
  },
  {
    was: "    const claim = await claimDelivery(db, orderId, nextDriver.driverId, { expectCurrent: driverId });\n",
    now: "    const svcDb = await pickHandle(db);   // S1a §3 (codex r2 P1-2) — re-select the handle AFTER the 60s wait\n    let claim;\n    try { claim = await svcWriteOrFallback(db, svcDb, (h) => claimDelivery(h, orderId, nextDriver.driverId, { expectCurrent: driverId }), { site: 'timeout.claim', target: nextDriver.driverId }); }   // S1a §3\n    catch (e) { if (await expectedIneligibleOrMain(e, db, svcDb, nextDriver.driverId, 'timeout-monitor')) { console.warn(`timeout-monitor: ${orderId} — ${nextDriver.driverId} not eligible at reassign claim; releasing to SIN ASIGNAR`); await releaseAndAlert(db, orderId, driverId); return; } throw e; }\n",
  },
  {
    was: "    const reassignUpdates = buildAssignmentUpdates(orderId, nextDriver.driverId, attempts + 1, true);\n    try {\n      await db.ref().update(reassignUpdates);\n",
    now: "    const reassignUpdates = buildAssignmentUpdates(orderId, nextDriver.driverId, attempts + 1, true);\n    try {\n      await svcWriteOrFallback(db, svcDb, (h) => h.ref().update(reassignUpdates), { site: 'timeout.finalize', target: nextDriver.driverId });   // S1a §3\n",
  },
  // (e) sweeper — svc-assigner handle + claim + finalize
  {
    was: "    const db = getDatabase();\n    const now = Date.now();\n    // Read config + all data up front. The HEAL pass runs EVERY tick regardless of the flags (H1) — the\n",
    now: "    const db = getDatabase();\n    const svcDb = await pickHandle(db);   // S1a §3 — ownership-creating writes are rules-bound\n    const now = Date.now();\n    // Read config + all data up front. The HEAL pass runs EVERY tick regardless of the flags (H1) — the\n",
  },
  {
    was: "      // notifyDriverOnAssignment (fires on pickup only). NULL-claim: a pending order's delivery is null.\n      const claim = await claimDelivery(db, orderId, chosen.driverId);\n",
    now: "      // notifyDriverOnAssignment (fires on pickup only). NULL-claim: a pending order's delivery is null.\n      let claim;\n      try { claim = await svcWriteOrFallback(db, svcDb, (h) => claimDelivery(h, orderId, chosen.driverId), { site: 'sweeper.claim', target: chosen.driverId }); }   // S1a §3\n      catch (e) { if (await expectedIneligibleOrMain(e, db, svcDb, chosen.driverId, 'sweepPending')) { console.warn(`sweepPending: ${orderId} — ${chosen.driverId} not eligible at claim (${e && (e.code || e.message)}); skipping`); continue; } throw e; }\n",
  },
  {
    was: "        updates[`tasks/${orderId}_delivery/retry_count`] = retryCount + 1;\n        updates[`tasks/${orderId}_delivery/last_swept`] = now;\n        await db.ref().update(updates);\n",
    now: "        updates[`tasks/${orderId}_delivery/retry_count`] = retryCount + 1;\n        updates[`tasks/${orderId}_delivery/last_swept`] = now;\n        await svcWriteOrFallback(db, svcDb, (h) => h.ref().update(updates), { site: 'sweeper.finalize', target: chosen.driverId });   // S1a §3\n",
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
       + "        const monCanon = (a) => (a ? JSON.stringify([a.driver_name || null, [...(a.order_ids || [])].sort(), !!a.open_shift, a.shift_id || null]) : null);\n"
       + "        const monPrior = monExisting[`driver_deactivated_${monUid}`];\n"
       + "        const monNext = { type: 'driver_deactivated', driver_uid: monUid, driver_name: monV.driver_name, order_ids: monV.order_ids, open_shift: monV.open_shift, shift_id: monV.shift_id };\n"
       + "        if (monPrior && monCanon(monPrior) === monCanon(monNext)) continue;   // codex r2 P2 — unchanged violation: no write, preserve timestamps\n"
       + "        monUpdates[`dispatcher_alerts/driver_deactivated_${monUid}`] = Object.assign(monNext, { created_at: (monPrior && monPrior.created_at) || now, updated_at: now });\n"
       + "        console.warn(`sweepPending: driver_deactivated violation uid=${monUid} orders=${monV.order_ids.join(',')} open_shift=${monV.open_shift}`);\n"
       + "      }\n"
       + "      if (Object.keys(monUpdates).length) await db.ref().update(monUpdates);\n"
       + "    } catch (e) { console.error('sweepPending: deactivated monitor failed', e && e.message); }\n"
       + "    // ---- OFFER PASS (gated, S3a kill-switch) ----\n",
  },
  // (h) expectedIneligibleOrMain + releaseAndAlert helpers (§3 — codex r3 P1-2 + r4 P1): expectedIneligibleOrMain is the
  // ONLY gate that makes the writers diverge from main — true ONLY when the flag is on (svcDb!==db) AND a FRESH account
  // read POSITIVELY establishes ineligibility; flag-off and any classification THROW both fall back to main (never swallow
  // the original denial into the classify error). releaseAndAlert CAS-releases an order off a driver to SIN ASIGNAR and,
  // only on a REAL release, raises the dispatcher alert releaseToSinAsignar itself never pushes. Anchored on the (pristine)
  // releaseToSinAsignar def.
  {
    was: "async function releaseToSinAsignar(db, orderId, driverId) {",
    now: "async function expectedIneligibleOrMain(e, db, svcDb, target, ctx) {   // S1a §3 (codex r3 P1-1 + r4 P1 + r6 P2-1)\n"
       + "  if (svcDb === db) return false;   // flag-off: exactly main's error path (no read, no divergence)\n"
       + "  let ineligible;\n"
       + "  try { ineligible = await isExpectedEligibilityDenial(e, db, target); }\n"
       + "  catch (ce) { console.error(`${ctx}: eligibility classification unavailable (read=account, ${(ce && ce.message) || ce}, mode=${(e && e.svcMode) || 'unread'}); original denial ${(e && (e.code || e.message)) || e} — falling back to main's rollback`); return false; }\n"
       + "  if (e && e.svcReadTimeout) console.error(`${ctx}: classify_timeout carried — a denial-path ${e.svcReadTimeout.read} read timed out (mode=${e.svcReadTimeout.mode}); original denial ${(e && (e.code || e.message)) || e} — ${ineligible ? 'release (positively ineligible)' : 'main rollback'}`);\n"
       + "  return ineligible;\n"
       + "}\n"
       + "async function releaseAndAlert(db, orderId, driverId) {   // S1a §3 (codex r3 P1-2)\n"
       + "  if (!(await releaseToSinAsignar(db, orderId, driverId))) return false;   // not ours to release (already null / re-owned) — no alert\n"
       + "  const o = (await db.ref(`orders/${orderId}`).once('value')).val() || {};\n"
       + "  await db.ref('dispatcher_alerts').push({ type: 'no_drivers_available', order_id: orderId, customer_name: o.recipient_name || 'Cliente', total: o.total || null, created_at: ServerValue.TIMESTAMP });\n"
       + "  return true;\n"
       + "}\n"
       + "async function releaseToSinAsignar(db, orderId, driverId) {",
  },
  // (i) timeout finalize catch (§3 — codex r3 P1-2): a target that becomes INELIGIBLE between the successful claim and
  // the finalize must NOT be rolled back onto the expired owner (that strands both legs on an expired/ineligible driver,
  // arms no new timer, and evades mismatch healing) — release to SIN ASIGNAR + alert; ordinary rollback for other faults.
  {
    was: "    } catch (e) {\n      console.error(`timeout-monitor: reassignment write failed for ${orderId}`, e);\n      await rollbackOrAlert(db, claim, orderId, 'timeout-reassign');  // restore timed-out driver (alert on double-fault)\n    }",
    now: "    } catch (e) {\n      if (await expectedIneligibleOrMain(e, db, svcDb, nextDriver.driverId, 'timeout-monitor')) {   // S1a §3 (codex r3 P1-2 + r4 P1) — POSITIVELY ineligible between claim and finalize: release, never restore the expired owner\n        console.warn(`timeout-monitor: ${orderId} — ${nextDriver.driverId} became ineligible between claim and finalize; releasing to SIN ASIGNAR`);\n        await releaseAndAlert(db, orderId, nextDriver.driverId); return;\n      }\n      console.error(`timeout-monitor: reassignment write failed for ${orderId}`, e);\n      await rollbackOrAlert(db, claim, orderId, 'timeout-reassign');  // restore timed-out driver (alert on double-fault; also the fall-back when eligibility can't be established — codex r4 P1)\n    }",
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
