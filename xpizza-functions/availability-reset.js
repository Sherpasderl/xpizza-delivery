'use strict';

/**
 * KDS Phase 2b — End-of-business-day availability auto-reset (KDS_2B_AUTORESET_PLAN.md, Codex-APPROVED).
 *
 * A sold-out ("86'd") menu item is automatically returned to AVAILABLE at the end of each business day —
 * matching Square's default — so staff never re-enable yesterday's 86's. A scheduled server job clears the
 * sold-out flags per restaurant, while CLOSED, once per business day.
 *
 * ISOLATION (grep-provable): this module reads/writes ONLY two paths under /restaurants/{rid} —
 *   • item_availability          (the 86 flags — DELETE-only; sold-out → absent = available)
 *   • availability_reset_marker  (the per-restaurant per-day lease + "last reset date" record)
 * It NEVER touches orders / pricing / tasks / payments / timelines / availability_audit (the staff record).
 *
 * FAIL-SAFE — it can ONLY WIDEN availability (sold-out → available); it never sets available:false, never
 * touches available:true, and reliably completes each closed-period (a crashed partial run resumes on the
 * next 30-min tick because the marker finalizes to 'done' ONLY after a full clear). Residual worst case is
 * an item staying sold-out slightly longer (conservative) — never a wrong widening, never a touched order.
 *
 * R4 (load-bearing clock rule): the cutoff is the RTDB server-time started_at (ServerValue.TIMESTAMP, read
 * back after the claim commits) — the SAME clock that stamps the staff write's updated_at — NEVER the Cloud
 * Function's Date.now() (which could run ahead of RTDB and wrongly clear a fresh staff 86). The closed-gate
 * and the marker date use a wall clock (deps.now), kept DISTINCT from that server-time cutoff and injectable.
 *
 * Deps-injected for unit-testability (no emulator): deps = { db, ServerValue, now, restaurants?, log? }.
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
async function clearKeyIfStale(db, path, expectedUpdatedAt, startedAt) {
  const res = await db.ref(path).transaction((cur) => {
    if (cur === null) return;                                   // already absent → abort (no write)
    if (cur.available !== false) return;                        // never touch available:true → abort
    if (!(isNum(cur.updated_at) && cur.updated_at === expectedUpdatedAt && cur.updated_at <= startedAt)) return;
    return null;                                                // STILL a stale 86 → remove the flag
  });
  return res.committed && res.snapshot.val() === null;
}

// Reset one restaurant. Self-gates on CLOSED + not-already-done-today, claims a resumable lease, clears
// stale 86's under the server-time cutoff, then finalizes the lease. Returns a structured result (no throw
// on the normal skip paths). Errors bubble to the per-restaurant try/catch in runAvailabilityReset.
async function resetRestaurant(deps, rid) {
  const { db, ServerValue, now } = deps;
  const log = deps.log || console;

  // (a) Gate: proceed ONLY while the restaurant is CLOSED per the reused hours source (never during service).
  const hours = (await db.ref(`restaurants/${rid}/identity/hours`).once('value')).val() || null;
  if (isOpenAt(hours, now)) return { rid, skipped: true, reason: 'open' };

  // (b) Gate: proceed ONLY if we haven't already fully reset today (date computed in Tegucigalpa).
  const today = localDateInTZ(now);
  const markerRef = db.ref(`restaurants/${rid}/availability_reset_marker`);

  // Structured claim (transaction): abort iff date==today && status=='done' (already done today). Else claim
  // 'in_progress' — a FRESH start (absent marker / prior day) stamps started_at = ServerValue.TIMESTAMP; a
  // same-day 'in_progress' RESUME PRESERVES the original started_at (never overwrites it → stable cutoff).
  const claim = await markerRef.transaction((cur) => {
    if (cur && cur.date === today && cur.status === 'done') return;                 // abort — already done today
    if (cur && cur.date === today && cur.status === 'in_progress') {
      return { date: today, status: 'in_progress', started_at: cur.started_at, completed_at: null }; // resume
    }
    return { date: today, status: 'in_progress', started_at: ServerValue.TIMESTAMP, completed_at: null }; // fresh
  });
  if (!claim.committed) return { rid, skipped: true, reason: 'already_done' };

  // READ THE MARKER BACK to obtain the RESOLVED server-time started_at (the §4 cutoff on the RTDB clock).
  const marker = (await markerRef.once('value')).val();
  const startedAt = marker && marker.started_at;
  if (!isNum(startedAt)) {
    // Should not happen (a committed claim always has a numeric started_at); bail SAFE without clearing.
    log.error(`resetItemAvailability: ${rid} marker missing numeric started_at — skipping clear`);
    return { rid, skipped: true, reason: 'no_started_at' };
  }

  // (§4) Snapshot item_availability; delete ONLY {available:false, updated_at <= startedAt}, each via the
  // per-key CAS above. Idempotent — an already-absent / changed / after-cutoff entry is left untouched.
  const snap = (await db.ref(`restaurants/${rid}/item_availability`).once('value')).val() || {};
  const cleared = [];
  for (const key of Object.keys(snap)) {
    const e = snap[key];
    if (!e || e.available !== false || !isNum(e.updated_at) || e.updated_at > startedAt) continue;
    if (await clearKeyIfStale(db, `restaurants/${rid}/item_availability/${key}`, e.updated_at, startedAt)) {
      cleared.push(key);
    }
  }

  // Finalize the lease to 'done' ONLY after a full clear (a crash mid-clear leaves 'in_progress' → the next
  // 30-min tick, still closed, re-claims + completes). CONDITIONAL finalize (transaction): set 'done' ONLY if
  // the marker is STILL this claim's — same date, still 'in_progress', same started_at. A stale/superseded
  // invocation (e.g. one that claimed 'in_progress' before midnight and resumed after a NEWER day's claim
  // already stamped a fresh marker) must NOT clobber the newer marker to 'done'. Else abort. date/started_at kept.
  await markerRef.transaction((cur) => {
    if (!cur || cur.date !== today || cur.status !== 'in_progress' || cur.started_at !== startedAt) return; // superseded → abort
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

module.exports = { runAvailabilityReset, resetRestaurant, clearKeyIfStale, localDateInTZ, DEFAULT_RESTAURANTS, TZ_OFFSET_MS };
