'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D3 — THE SERVER ASKS THE REGISTRY WHAT THE LINE'S KEY ACTUALLY MAPS TO.
//
// D2 put a platform id on every cart line. This reads it back — not to trust it, but to check it. A
// submitted id is evidence of nothing: it round-trips through a browser, so it can be stale, edited,
// from the other brand, or exchanged with another line's. The one shape no field-level validation can
// catch is a SWAP — two real objects' ids traded — and the only way to see it is to ask the registry
// what the legacy key maps to and compare. That is the reverse direction, and it is why this exists.
//
// 🔴 IT CANNOT AFFECT AN ORDER. Not the price, not the 86 gate, not the reward, not the factura, not
// the reservation, not dedup. It reports and nothing more. So it is built like the D1 overlay: it
// cannot throw, it cannot hang, and on any trouble at all it returns a clean "nothing found" rather
// than a verdict it is not entitled to. A diagnostic that can fail an order is worse than no
// diagnostic, and shadow is what makes that trade free.
//
// 🔴 READ FAILURE IS NOT A MISMATCH. This is the distinction the whole module turns on: if the
// registry cannot be read, the answer is "I do not know", never "these disagree". A validator that
// reported a swap because Firestore hiccuped would send staff chasing an anomaly that never happened,
// and worse, would teach them to ignore the alert.
// ---------------------------------------------------------------------------
const { lookupByLegacyKeys, classifyClaim } = require('./identity-registry');
const { keyOf } = require('./identity-overlay');

/* Bounded on its own clock. 🔴 THIS BOUNDS WHEN THE RESULT SETTLES — IT DOES NOT CANCEL THE READ.
   Firestore's .get() has no cancellation, so an outstanding read finishes whenever it finishes; it is
   read-only, has no side effects, and nothing reports on it afterwards. Saying "timeout" about a
   promise race and meaning "the query was cancelled" is a lie a future reader would act on, so the
   name and this note are deliberate. It is NOT a response wait — the response never waits (§6). */
const SHADOW_INTERNAL_TIMEOUT_MS = 1500;

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timedOut: true }), ms); });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/* Every occurrence a cart carries, flattened: dish lines and their nested extras, each with the legacy
   key the MONEY path would resolve it by. 🔴 KEYED THROUGH keyOf — the same resolver the D1 backfill
   minted with and the D1 overlay served with. Re-deriving it here (`extra.name || extra.id`, say)
   would produce a key the registry never wrote, and every line would come back `unregistered_key`:
   a validator manufacturing the anomaly it was built to detect. */
function occurrencesOf(rid, items) {
  const out = [];
  (Array.isArray(items) ? items : []).forEach((line, i) => {
    if (!line || typeof line !== 'object') return;
    out.push({ line: i, kind: 'dish', key: keyOf(rid, line), claimedId: line.dish_id });
    (Array.isArray(line.extras) ? line.extras : []).forEach((ex) => {
      if (!ex || typeof ex !== 'object') return;
      out.push({ line: i, kind: 'extra', key: keyOf(rid, ex), claimedId: ex.extra_id });
    });
  });
  return out;
}

/* 🔴 NEVER THROWS — but be precise about what that covers. Everything INSIDE this function is inside
   the try: building the occurrence list, the reads, the classification. It does NOT cover obtaining
   the Firestore handle, because the handle is obtained at the CALL SITE and passed in — a
   getFirestore() that throws would throw there, in the handler, before this function is ever entered.
   An earlier version of this comment claimed the try covered the handle too, which was false and
   dangerous precisely because it read as reassurance: the cash path was relying on it and was one
   synchronous throw away from failing an order that had already been written. startShadowCheck below
   is what actually closes that, and both call sites go through it. */
async function shadowValidateIds(fs, rid, items, { internalTimeoutMs = SHADOW_INTERNAL_TIMEOUT_MS } = {}) {
  const empty = { mismatches: [], checked: 0, resolved: 0, absent: 0, status: 'ok' };
  /* 🔴 HOISTED SO A FAILURE CAN STILL REPORT WHAT IT WAS TRYING TO CHECK. The liveness signal for a
     broken validator is `checked > 0` with `resolved == 0` — that is exactly the shape the
     wrong-handle bug produces, and it is what makes it distinguishable from a genuinely clean run.
     Returning `checked: 0` from the catch would erase that distinction and make a validator reading
     the wrong database look identical to a cart that carried no ids. */
  let checked = 0;
  let absentCount = 0;
  try {
    const occ = occurrencesOf(rid, items);

    /* Occurrences with no id are ABSENT: skipped, counted, and NEVER read for. A menu served before
       the backfill — or during a D1 overlay failure, which serves id-less by design — produces a cart
       full of these, and they are not anomalies. Counting them is what lets the heartbeat tell "no
       mismatches because everything matched" apart from "no mismatches because nothing had an id". */
    const carrying = occ.filter((o) => classifyClaim({ actual: null, claimedId: o.claimedId }).reason !== 'absent');
    absentCount = occ.length - carrying.length;
    checked = carrying.length;
    if (!carrying.length) return { ...empty, absent: absentCount };

    /* One batched read per kind over the DISTINCT keys — the dedup is the cost control, since a cart
       with four of the same dish must not become four reads. A key that could not be resolved to a
       string is left out of the read and classified from a null below, exactly as an unregistered one
       would be. */
    const distinct = (kind) => [...new Set(carrying.filter((o) => o.kind === kind && typeof o.key === 'string' && o.key).map((o) => o.key))];
    const dishKeys = distinct('dish');
    const extraKeys = distinct('extra');

    const race = await withTimeout(Promise.all([
      dishKeys.length ? lookupByLegacyKeys(fs, { rid, kind: 'dish', legacyKeys: dishKeys }) : new Map(),
      extraKeys.length ? lookupByLegacyKeys(fs, { rid, kind: 'extra', legacyKeys: extraKeys }) : new Map(),
    ]), internalTimeoutMs);

    if (race && race.__timedOut) return { ...empty, checked, absent: absentCount, status: 'timed_out' };
    const [dishMap, extraMap] = race;

    /* Classified PER OCCURRENCE, not per distinct key. Two lines of the same dish claiming different
       ids is a real and catchable shape — one of them is wrong — and a per-key classification would
       collapse them and see nothing. The read is deduped; the verdict is not. */
    const mismatches = [];
    let resolved = 0;
    for (const o of carrying) {
      const map = o.kind === 'dish' ? dishMap : extraMap;
      const actual = (typeof o.key === 'string' && o.key && map.has(o.key)) ? map.get(o.key) : null;
      if (actual !== null) resolved += 1;
      const { reason } = classifyClaim({ actual, claimedId: o.claimedId });
      if (reason === 'swapped' || reason === 'unregistered_key') {
        mismatches.push({ line: o.line, kind: o.kind, id: o.claimedId, expected_legacy_key: o.key, registry_id: actual, reason });
      }
    }
    return { mismatches, checked, resolved, absent: absentCount, status: 'ok' };
  } catch (_e) {
    /* 🔴 A READ ERROR YIELDS ZERO MISMATCHES. lookupByLegacyKeys rejects on a failed read rather than
       fabricating an empty map, which is what makes this honest: the catch turns a Firestore problem
       into "I could not check", never into "these disagree". `resolved: 0` alongside `checked > 0` is
       the shape that tells the heartbeat the validator is broken — the wrong-handle bug reads exactly
       like this, and that is deliberate. */
    return { mismatches: [], checked, resolved: 0, absent: absentCount, status: 'read_error' };
  }
}

/* ── CONTRACT B — THE RESPONSE NEVER WAITS ────────────────────────────────────────────────────
   🔴 THE WHOLE LATENCY GUARANTEE IS THIS FUNCTION. The check is kicked off early so it overlaps I/O
   the handler already awaits, and at the response boundary the handler takes its result ONLY IF it has
   already settled. There is no dedicated wait anywhere — not a budget, not a short race, not "usually
   fast". A sample that has not landed by the boundary is DROPPED and the customer's response goes out.
   Coverage is best-effort by design; latency is not negotiable.
   The flag is set from a .then/.catch attached at kickoff, so `isSettled()` at the boundary is a plain
   synchronous read — asking a promise whether it is settled is otherwise impossible without awaiting
   it, which is exactly what must not happen here. */
function trackSettled(promise) {
  const state = { settled: false, value: null };
  const tracked = Promise.resolve(promise).then(
    (v) => { state.settled = true; state.value = v; return v; },
    /* A rejection still counts as SETTLED — the helper does not throw, so this is belt and braces, but
       treating a rejection as "still outstanding" would hang the sample in a state the boundary can
       never resolve and quietly turn every such order into a drop. */
    (_e) => { state.settled = true; state.value = null; return null; },
  );
  tracked.catch(() => {});                       // never an unhandled rejection in an order handler
  return { promise: tracked, isSettled: () => state.settled, value: () => state.value };
}

/* ── REPORTING — SYNCHRONOUS LOGS, DETACHED ALERT ─────────────────────────────────────────────
   Kept out of the validator so the verdict stays testable without spying on a database.

   🔴 THE LOG IS THE RECORD; THE ALERT IS A CONVENIENCE. Under contract B nothing is awaited past the
   point the order exists, so on the card path a detached .set() may not land before the instance
   freezes. That is acceptable ONLY because the structured log is emitted synchronously and is the
   authoritative trail — and it is why the alert may never be promoted to the record without also
   changing the waiting discipline. A mismatch is a rare anomaly; a rare missed alert still lives in
   the log. */
function reportIdentityShadow(db, { rid, orderId, attemptId = null, outcome, result = null }) {
  const r = result || { mismatches: [], checked: 0, resolved: 0, absent: 0 };
  const mismatches = Array.isArray(r.mismatches) ? r.mismatches : [];

  /* EXACTLY ONE HEARTBEAT PER ELIGIBLE ISSUANCE, synchronous, always. Without it "zero mismatches"
     is unreadable: a validator pointed at the wrong database reports zero, and so does a starved one
     that drops every sample. The counts and the outcome are what make a clean run distinguishable
     from a broken one, and that distinction IS the D4-go signal. */
  try {
    console.log('order_identity_shadow_checked', JSON.stringify({
      rid, order_id: orderId, attempt_id: attemptId,
      checked: r.checked || 0, resolved: r.resolved || 0, absent: r.absent || 0,
      mismatches: mismatches.length, outcome,
    }));
  } catch (_) { /* observability must never break an order */ }

  // absent is SILENT by design and never reaches here: shadowValidateIds never returns it as a
  // mismatch. Only swapped/unregistered_key are reportable.
  if (!mismatches.length) return;

  for (const m of mismatches) {
    try {
      console.warn('order_identity_shadow_mismatch', JSON.stringify({
        rid, order_id: orderId, line: m.line, kind: m.kind, id: m.id,
        expected_legacy_key: m.expected_legacy_key, registry_id: m.registry_id, reason: m.reason,
      }));
    } catch (_) { /* as above */ }
  }

  /* ONE KEYED ROW PER ORDER, detached. 🔴 order_id sits INSIDE `detail` because alert-prune scans
     `alert.detail` for order ids — placed anywhere else the row is an orphan that never prunes.
     Keyed by order so a rotation's later mismatch overwrites rather than accumulating cards. */
  try {
    const worst = mismatches.some((m) => m.reason === 'swapped') ? 'swapped' : 'unregistered_key';
    const write = db.ref(`dispatcher_alerts/identity_mismatch_${orderId}`).set({
      type: 'identity_shadow_mismatch', order_id: orderId, restaurant_id: rid, worst,
      detail: { order_id: orderId, mismatches }, at: Date.now(),
    });
    if (write && typeof write.catch === 'function') write.catch(() => {});   // detached, never awaited
  } catch (_) { /* a broken alert must never fail an order that is already written */ }
}

/* ── KICKOFF, GUARDED — THE ONE PLACE THE HANDLE IS OBTAINED ──────────────────────────────────
   🔴 THIS EXISTS BECAUSE A DIAGNOSTIC NEARLY FAILED A PAID ORDER. The cash path called
   `trackSettled(shadowValidateIds(getFirestore(), ...))` directly in the handler body — AFTER the order
   was written and OUTSIDE the try that guarded the write. getFirestore() is synchronous and can throw;
   there is no error middleware for it, only a JSON-parse one. So a cold instance where the handle had
   not yet been built could have thrown there and failed the response for an order that already
   existed, and the customer would have been told their order failed when it had not.
   The reassuring argument — "pricing already touched Firestore this request" — does not hold: the
   resolver and its handle live in a cross-request SINGLETON (index.js:292), so a cold request need
   never have called getFirestore() before this point.
   Taking the GETTER rather than the handle is what makes the guarantee real: the call that can throw
   happens inside this try, not at the call site. A throw becomes a dropped sample and nothing else.
   Both writers go through here, so the two paths cannot drift on the one thing that matters most. */
function startShadowCheck(getFs, rid, items, opts) {
  try {
    return trackSettled(shadowValidateIds(getFs(), rid, items, opts));
  } catch (_e) {
    /* The handle getter threw. The order exists and is unaffected; the sample is simply dropped, and
       the caller's collect-if-settled treats null exactly as it treats an unsettled check — so this
       surfaces as a `dropped` heartbeat rather than as silence. */
    return null;
  }
}

module.exports = { shadowValidateIds, occurrencesOf, trackSettled, startShadowCheck, reportIdentityShadow, SHADOW_INTERNAL_TIMEOUT_MS };
