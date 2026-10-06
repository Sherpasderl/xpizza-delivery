'use strict';

/**
 * KDS Phase 2b — End-of-business-day availability auto-reset (KDS_2B_AUTORESET_PLAN.md, Codex-APPROVED).
 *
 * A sold-out ("86'd") menu item is automatically returned to AVAILABLE at the end of each business day —
 * matching Square's default — so staff never re-enable yesterday's 86's. A scheduled server job clears the
 * sold-out flags per restaurant, while CLOSED, once per America/Tegucigalpa CALENDAR DATE (the marker date —
 * see "CALENDAR-DAY SEMANTICS" below; not once per closed period).
 *
 * ISOLATION (grep-provable): this module reads/writes ONLY two paths under /restaurants/{rid} —
 *   • item_availability          (the 86 flags — DELETE-only; sold-out → absent = available)
 *   • availability_reset_marker  (the per-restaurant per-day lease + "last reset date" record)
 * It NEVER touches orders / pricing / tasks / payments / timelines / availability_audit (the staff record).
 *
 * FAIL-SAFE — it can ONLY WIDEN availability (sold-out → available); it never sets available:false, never
 * touches available:true. A crashed partial run is recovered by a LATER SUCCESSFUL closed-hours tick on the
 * same local date (the marker finalizes to 'done' ONLY after a full clear; an 'in_progress' marker is resumed
 * with its ORIGINAL cutoff). Residual worst case is an item staying sold-out slightly longer (conservative) —
 * never a wrong widening, never a touched order.
 *
 * CALENDAR-DAY SEMANTICS (existing behaviour, documented — PLAN-availability-reset-fix rev 3 §6): "once per
 * day" means once per America/Tegucigalpa calendar date (localDateInTZ below). A same-date 30-min resume keeps
 * the original cutoff; the first closed tick after LOCAL MIDNIGHT claims the new date with a FRESH cutoff
 * (≈ 00:00) — even inside the same closed window — clears every 86 stamped before it, and marks the new date
 * 'done', so that evening's ticks are 'already_done' and that day's 86s are cleared by the NEXT local-midnight
 * run, still before opening. In steady state the reset effectively happens at local midnight.
 *
 * 🔴 THE COLD PROBE (the bug this revision fixes). An RTDB transaction's update function is first called with
 * the LOCALLY CACHED value — null when this client holds no cache for the path, which is every run here (the
 * function holds no listener). Returning undefined on that null ends the transaction uncommitted without the
 * server value ever being seen; returning a value lets the SDK re-run the function with the server value on a
 * stale assumption (firebase-admin 12.7.0 → @firebase/database-compat 1.0.8). So every update function below
 * answers the null probe with a VALUE (null / cur), never undefined, and re-checks every predicate on EVERY
 * invocation; outcomes are recorded per invocation and read only from the committing one.
 *
 * R4 (load-bearing clock rule): the cutoff is the RTDB server-time started_at (ServerValue.TIMESTAMP, read
 * back after the claim commits) — the SAME clock that stamps the staff write's updated_at — NEVER the Cloud
 * Function's Date.now() (which could run ahead of RTDB and wrongly clear a fresh staff 86). The closed-gate
 * and the marker date use a wall clock (deps.now), kept DISTINCT from that server-time cutoff and injectable.
 *
 * Deps-injected for testability: deps = { db, ServerValue, now, restaurants?, log?, hooks? } (hooks = a test-only
 * seam: afterSnapshot / beforeReadBack / beforeFinalize / traceClear; production passes none).
 */

const { isOpenAt, TZ_OFFSET_MS } = require('./scheduled-orders'); // the SINGLE hours/open-closed source

const DEFAULT_RESTAURANTS = ['x_pizza', 'la_musa'];

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

// "today" as YYYY-MM-DD in America/Tegucigalpa (UTC−6, no DST). Shift the instant back by the offset, THEN
// read UTC components — so an evening reset can't roll the marker to tomorrow's raw-UTC date and suppress
// the real next reset. (NOT a raw `new Date(now).toISOString()` slice — that would be UTC, off by 6h.)
function localDateInTZ(nowMs) {
  const d = new Date(nowMs - TZ_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Per-key conditional DELETE (CAS). Removes the 86 flag ONLY if the node is STILL {available:false} with the
// SAME updated_at we saw in the snapshot AND that updated_at <= the server-time cutoff. So available:true is
// never touched, an already-absent node is a no-op, and a staff 86 stamped after the cutoff (updated_at >
// started_at) is preserved — even across a crash-resume, because started_at is the stable original cutoff.
//
// REMOVAL ACCOUNTING: `removed` is reset at the START of every invocation and set only immediately before
// returning null for an entry that satisfied every predicate; the key is reported cleared iff the transaction
// COMMITTED and the committing invocation removed it (the claim-delivery.js releaseDeliveryFromDriver pattern).
// `res.snapshot.val() === null` is NOT used: an absent→absent commit (the cold probe, or a node deleted by
// someone else) also leaves null, and would be counted as a clear this run never made.
async function clearKeyIfStale(db, path, expectedUpdatedAt, startedAt, trace = null) {
  let removed = false;
  const res = await db.ref(path).transaction((cur) => {
    removed = false;                                            // reset on EVERY invocation
    if (trace) trace(path, cur);
    if (cur === null) return null;                              // cold probe / absent → absent stays absent (SDK re-runs on a stale assumption)
    if (cur.available !== false) return;                        // never touch available:true → abort
    if (!(isNum(cur.updated_at) && cur.updated_at === expectedUpdatedAt && cur.updated_at <= startedAt)) return;
    removed = true;
    return null;                                                // STILL a stale 86 → remove the flag
  });
  return res.committed && removed;
}

// Reset one restaurant. Self-gates on CLOSED + not-already-done-today, claims a resumable lease, clears
// stale 86's under the server-time cutoff, then finalizes the lease. Returns a structured result (no throw
// on the normal skip paths). Errors bubble to the per-restaurant try/catch in runAvailabilityReset.
async function resetRestaurant(deps, rid) {
  const { db, ServerValue, now } = deps;
  const log = deps.log || console;
  // TEST SEAM ONLY (the emulator suite's deterministic barriers + updater trace). Production passes none.
  const hooks = deps.hooks || {};

  // (a) Gate: proceed ONLY while the restaurant is CLOSED per the reused hours source (never during service).
  const hours = (await db.ref(`restaurants/${rid}/identity/hours`).once('value')).val() || null;
  if (isOpenAt(hours, now)) return { rid, skipped: true, reason: 'open' };

  // (b) Gate: proceed ONLY if we haven't already fully reset today (date computed in Tegucigalpa).
  const today = localDateInTZ(now);
  const markerRef = db.ref(`restaurants/${rid}/availability_reset_marker`);

  // Structured claim (transaction): abort iff date==today && status=='done' (already done today). Else claim
  // 'in_progress' — a FRESH start (absent marker / prior day) stamps started_at = ServerValue.TIMESTAMP; a
  // same-day 'in_progress' RESUME PRESERVES the original started_at (never overwrites it → stable cutoff).
  // A marker for a NEWER local date belongs to a later invocation (a delayed older run must never replace it):
  // abort with its OWN outcome. The abort reason is recorded per invocation (reset each time) and read from
  // the final one — the same pattern as `removed`.
  let claimOutcome = null;
  const claim = await markerRef.transaction((cur) => {
    claimOutcome = null;                                                             // reset on EVERY invocation
    if (cur && typeof cur.date === 'string' && cur.date > today) { claimOutcome = 'newer_marker'; return; }   // abort — a newer day owns it
    if (cur && cur.date === today && cur.status === 'done') { claimOutcome = 'already_done'; return; }      // abort — already done today
    if (cur && cur.date === today && cur.status === 'in_progress') {
      return { date: today, status: 'in_progress', started_at: cur.started_at, completed_at: null }; // resume
    }
    return { date: today, status: 'in_progress', started_at: ServerValue.TIMESTAMP, completed_at: null }; // fresh (incl. the cold probe)
  });
  if (!claim.committed) return { rid, skipped: true, reason: claimOutcome || 'claim_aborted' };

  if (hooks.beforeReadBack) await hooks.beforeReadBack(rid);
  // READ THE MARKER BACK to obtain the RESOLVED server-time started_at (the §4 cutoff on the RTDB clock) — and
  // clear ONLY if it is still THIS day's in_progress claim. A marker superseded between the claim commit and
  // this read (a newer day's claim, or a same-day 'done') owns the cutoff; this run clears nothing.
  const marker = (await markerRef.once('value')).val();
  const startedAt = marker && marker.started_at;
  const notOurs = !marker ? 'marker_absent'
    : marker.date !== today ? 'marker_date'
      : marker.status !== 'in_progress' ? 'marker_status'
        : !isNum(startedAt) ? 'no_started_at' : null;
  if (notOurs) {
    log.error(`resetItemAvailability: ${rid} skipped:${notOurs} — the marker read back is not this day's in_progress claim; clearing nothing`);
    return { rid, skipped: true, reason: `skipped:${notOurs}` };
  }

  // (§4) Snapshot item_availability; delete ONLY {available:false, updated_at <= startedAt}, each via the
  // per-key CAS above. Idempotent — an already-absent / changed / after-cutoff entry is left untouched.
  const snap = (await db.ref(`restaurants/${rid}/item_availability`).once('value')).val() || {};
  if (hooks.afterSnapshot) await hooks.afterSnapshot(rid, snap);
  const cleared = [];
  for (const key of Object.keys(snap)) {
    const e = snap[key];
    if (!e || e.available !== false || !isNum(e.updated_at) || e.updated_at > startedAt) continue;
    if (await clearKeyIfStale(db, `restaurants/${rid}/item_availability/${key}`, e.updated_at, startedAt, hooks.traceClear || null)) {
      cleared.push(key);
    }
  }
  if (hooks.beforeFinalize) await hooks.beforeFinalize(rid);

  // Finalize the lease to 'done' ONLY after a full clear (a crash mid-clear leaves 'in_progress' → the next
  // 30-min tick, still closed, re-claims + completes). CONDITIONAL finalize (transaction): set 'done' ONLY if
  // the marker is STILL this claim's — same date, still 'in_progress', same started_at. A stale/superseded
  // invocation (e.g. one that claimed 'in_progress' before midnight and resumed after a NEWER day's claim
  // already stamped a fresh marker) must NOT clobber the newer marker to 'done'. Else abort. date/started_at kept.
  await markerRef.transaction((cur) => {
    if (!cur) return cur;                                                                   // cold probe → value (null), never undefined: the SDK re-runs with the server value
    if (cur.date !== today || cur.status !== 'in_progress' || cur.started_at !== startedAt) return; // superseded → abort (unchanged)
    return { date: today, status: 'done', started_at: startedAt, completed_at: ServerValue.TIMESTAMP };
  });

  // Traceability → Cloud Logging (NOT availability_audit/{key} — that is the staff latest-state record).
  log.info(`resetItemAvailability: ${rid} cleared ${cleared.length}${cleared.length ? ' [' + cleared.join(', ') + ']' : ''}`);
  return { rid, cleared, count: cleared.length, started_at: startedAt };
}

// Loop the restaurants with INDEPENDENT per-restaurant try/catch — any error is logged + swallowed so it
// never fails the other restaurant or throws out of the scheduled handler.
async function runAvailabilityReset(deps) {
  const log = deps.log || console;
  const restaurants = Array.isArray(deps.restaurants) && deps.restaurants.length ? deps.restaurants : DEFAULT_RESTAURANTS;
  const results = [];
  for (const rid of restaurants) {
    try {
      results.push(await resetRestaurant({ ...deps, log }, rid));
    } catch (e) {
      log.error(`resetItemAvailability: ${rid} failed`, e && e.message);
      results.push({ rid, skipped: true, reason: 'error', error: e && e.message });
    }
  }
  return results;
}

// One structured log line per restaurant per tick (PLAN rev 3 §Fix 5) — including already_done, newer_marker,
// open and skipped:<reason> — so a prod verification can read every outcome. The scheduled wrapper used to
// discard runAvailabilityReset's result. Pure (no I/O): the wrapper prints what this returns.
function outcomeLogLines(results) {
  return (Array.isArray(results) ? results : []).map((r) => {
    const outcome = !r ? 'error' : r.skipped ? (r.reason || 'skipped') : 'cleared';
    const o = { rid: r && r.rid, outcome };
    if (r && !r.skipped) { o.count = r.count; o.started_at = r.started_at; }
    if (r && r.error) o.error = String(r.error).slice(0, 160);
    return `resetItemAvailability_outcome ${JSON.stringify(o)}`;
  });
}

module.exports = { runAvailabilityReset, resetRestaurant, clearKeyIfStale, localDateInTZ, outcomeLogLines, DEFAULT_RESTAURANTS, TZ_OFFSET_MS };
