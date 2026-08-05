# SPEC — Driver-accept diagnostic telemetry, **Option B (HTTP sink)** — read-only, dark-shipped

**Status:** DESIGN for gate (no code yet). **Sink:** **Option B (HTTP)** — owner decision 2026-08-04, superseding Option A after the advisor+codex gate REVISE'd A (RTDB web SDK has no cross-session persistence → A loses events on a mid-stall app-kill/WebView-death; this app is known to suffer OEM WebView death). **Supersedes** `2026-08-04-driver-accept-diagnostics.md` (Option A). **Type:** additive/diagnostic; touches a live driver function (`ingestDriverLocation`) → advisor + codex gate + emulator-not-needed (no rules change) before merge. Still **logging-only — NO accept-path fix** (the fix is deferred until telemetry proves the mechanism, its own later gate).

## Why B over A (settled at gate)
The incident's evidenced failure mode is **app-alive, RTDB WebSocket stalled** (continuous native HTTP location pings proved the app was alive throughout). B delivers each breadcrumb over **HTTP — the channel proven to keep working during the stall** — in ~real-time at emit, so events are captured even if the app/WebView dies seconds later. A's in-memory RTDB queue would lose exactly those events on a kill. B's cost is a functions deploy; that cost is **contained to a single-function, prune-safe deploy** (see Deploy safety).

## Incident recap (proven — see the Option-A spec + handoff for the full timeline)
Order `PZX-260804-192831-HRSR7VGH`: driver Hermez swipe-accepted, UI looked normal, the 60s `monitorAssignmentTimeout` reassigned because his accept **never reached the server** (authoritative status still `assigned` at timeout). Server behaved correctly. First occurrence in hundreds. Leading (unproven) hypothesis: RTDB socket stalled while HTTP kept working → `acceptTask` applied to local cache → optimistic "accepted" → never synced. Two alternatives share the identical server footprint (swipe never crossed 85%; one-off app error) → need CLIENT telemetry to disambiguate.

## Goal
Capture, with certainty and surviving an app-kill, the exact client-side mechanism whenever a driver's accept does not reach the server — so the NEXT occurrence is proven from data, not inferred. Observe first; do not touch working accept/assignment code.

## Hard guardrails (non-negotiable)
1. **No accept behavior change.** The `acceptTask` `get()`/`update()` calls and their result-handling stay byte-identical; the assignment engine, monitor, sweeper, and every order/task write are untouched. Breadcrumbs are interleaved observation only. *(Fence correction from the gate: "no behavior/logic/control-flow change" — NOT "zero lines in `acceptTask`"; capturing `accept_read`/`accept_write_*` necessarily adds emit lines inside `acceptTask`.)*
2. **Fire-and-forget, never awaited.** Every emit + every HTTP flush is `try/catch`-wrapped and never `await`ed in the accept critical path. The `accept_write_ack` latency timing observes the existing `update()` promise only; the 10s `accept_write_timeout` watchdog is a bare `setTimeout` — **no `Promise.race`, no abort, no retry, no UI gate, no rejection path** that could throw into accept. The emit helper's own construction cannot throw outside its wrapper.
3. **Server telemetry path cannot break location ingestion.** In `ingestDriverLocation`, the events[] handling runs in its own `try/catch` **after** the location-processing side effects, so a malformed/oversized events payload can never fail or delay the location write (the function's primary, critical job).
4. **Dark by default.** Gated on `config/driver_diag_enabled` — **live-read/subscribed** (or checked fresh at emit time), never cached once at startup, so a flip to false takes effect with no app restart. Absent/false ⇒ fully inert (no buffering, no POSTs).
5. **Bounded.** Client caps the buffer (~50 events); server inline-prunes per-uid on write (drop `> 7 days` or keep last ~200). No unbounded growth. Server also caps events accepted per request (≤50) and validates each `{type, at}` + bounded ctx.
6. **Client timestamps.** Every event carries `at: Date.now()` (client). NEVER `serverTimestamp()` — a late/retried flush would misstamp at delivery time.

## Events to capture (unchanged from A) — each `{uid, at, type, ...ctx}`
1. `rtdb_conn` — `.info/connected` transition `{connected}`. **Key signal**; `false` bracketing the accept window = stall proven.
2. `accept_swipe` — swipe crossed the 85% threshold, `onConfirm` about to run `{taskId}`. Presence rules OUT "incomplete swipe."
3. `accept_conn` — `.info/connected` value at the instant of accept `{connected}`.
4. `accept_read` — `acceptTask` `get()` resolved `{taskId, status_seen, fromCache}` (or `accept_read_err {taskId, err}`).
5. `accept_write_start` — about to call `update()` `{taskId}`.
6. `accept_write_ack` — `update()` resolved `{taskId, latencyMs}`. Absent or `latencyMs ≥ 60000` ⇒ the stall, proven.
7. `accept_write_err` — `update()` rejected `{taskId, err}`.
8. `accept_write_timeout` — 10s watchdog `{taskId}`, observation only.

## Sink — Option B (HTTP), extend `ingestDriverLocation`

### Server (`xpizza-functions/index.js` + `./driver-ingest` if pure logic is added)
`ingestDriverLocation` is an HTTP `onRequest` (us-central1) authed by the per-shift opaque **bearer token**; today it takes `{ locations: [...] }`. **Additive change:**
- Accept an **optional** `events` array in the JSON body: `{ locations?: [...], events?: [{type, at, ...ctx}] }`. If `events` is absent → byte-identical to today. Make `locations` tolerated-absent too (an events-only POST processes events and skips the location path).
- **After** the existing token validation (which yields `uid`) **and after** the location side effects, in a **separate `try/catch`**: validate + cap `events` (≤50/request, each has `type` + numeric `at`, ctx size-bounded), then **admin-write** each to `driver_events/{uid}/{pushId}` (admin bypasses rules). Inline-prune that uid's `driver_events` (drop `> 7d` or trim to last ~200) in the same path.
- The existing rate-limit (120/min/uid) already covers this; event flushes stay well under it (see client).
- A failure anywhere in the events block is swallowed (logged, not thrown) — **location ingestion is never affected**.

### Client (`xpizza-driver` WebView JS — `xpizza-delivery.js` + `index.html`)
The WebView JS already holds the shift `ingest_token` (via `native-location.js` ← `startDriverShift`) and the endpoint `INGEST_URL` (`native-location.js:102`). So breadcrumbs POST directly over WebView HTTP — the RTDB socket stall doesn't affect `fetch()`:
- `emitDiag(evt)` (gated on the live `driver_diag_enabled` flag): push `{...evt, at: Date.now()}` to a bounded in-memory buffer, then schedule a **debounced (~750ms) fire-and-forget `fetch(INGEST_URL, {method:'POST', headers:{Authorization: 'Bearer '+token}, body: JSON.stringify({events: buffer})})`**. On 2xx → clear the flushed events; on failure → keep them for the next flush. Batches an accept burst into ~1 POST while still delivering in ~real-time. **Never `await`ed in accept.**
- **Retry flush:** a lightweight timer (~every 10s, or on the next accept event) re-attempts any events left in the buffer, so a transient `fetch` failure doesn't strand them.
- Wire the emits: `.info/connected` listener on app start (`accept_conn` reads its latest value); `accept_swipe` at the 85%-threshold fire in `attachSlideConfirm`; `accept_read`/`accept_write_start`/`accept_write_ack`(+latency)/`accept_write_err`/`accept_write_timeout` interleaved around `acceptTask`'s existing `get()`/`update()` (observation only, guardrail #1/#2).

### Rules — **NONE required**
The server admin-writes `driver_events` (bypasses rules) and the owner reads it via the **Firebase admin console** (or an admin script) after a recurrence. So **no rules change, no rules deploy, no emulator step** for this ship. *(Optional, deferred: a `driver_events/$uid` `.read` for `dispatchers` + `.indexOn ["at"]` if a dispatch-dashboard view is later wanted — its own rules-emulator'd change.)*

## Surfaces touched
- `xpizza-functions/index.js` — additive `events[]` handling in `ingestDriverLocation` (+ pure validate/prune helper in `./driver-ingest`, unit-tested).
- `xpizza-driver/xpizza-delivery.js` — `emitDiag` + buffer/flush; `.info/connected` listener; breadcrumbs around `acceptTask`.
- `xpizza-driver/index.html` — `accept_swipe` at the slide-confirm fire; init the conn-listener.
- **No rules file. No new function export.**

## Deploy safety — THE hard constraint (locked)
Modifying `ingestDriverLocation` requires a functions deploy. To avoid the prune footgun ([[prod-functions-deployed-state]]: a partial full-deploy prunes live functions → **drivers unassignable**) and the env-strip footgun ([[functions-env-management]]: gitignored `.env` strips live runtime env):
1. **Reconcile `.env` to live** first (from `xpizza-reference/` / gcloud), per [[functions-env-management]].
2. Deploy **only the one function**: `firebase deploy --only functions:ingestDriverLocation`. Scoping to the single function **updates only it and deletes nothing** — it cannot prune the driver-native or payment functions.
3. **Verify:** `gcloud functions list … --filter='state!=ACTIVE'` is empty; confirm the deploy log shows only `ingestDriverLocation` updated and **zero deletions**; smoke a location ping still ingests.

## How this delivers certainty on recurrence (now app-kill-resilient)
Read `driver_events/{driver}` (admin) after the next incident:
- `rtdb_conn:false @ T1 … true @ T2` bracketing accept → **socket was down. Proven.**
- `accept_swipe` + `accept_conn:false` + `accept_read.fromCache:true` + `accept_write_start` with `accept_write_ack` absent/late → **optimistic-accept-over-dead-socket. Proven.**
- No `accept_swipe` → **gesture never fired. Proven.**
Because each breadcrumb was HTTP-POSTed at emit, the record survives a subsequent app-kill/WebView-death (A's failure mode). Only THEN design the fix (confirm-before-success / connectivity gate) as a separate gated change.

## Rollout
1. Build in the driver-app repo behind the live `config/driver_diag_enabled` (dark) + the additive `ingestDriverLocation` change.
2. **Reconcile `.env` → deploy `--only functions:ingestDriverLocation` → verify no prune / env intact / location still ingests.**
3. Ship the driver app version; flip `driver_diag_enabled=true`.
4. Controlled repro: block the RTDB socket, keep HTTP up, swipe accept → confirm `driver_events` captured it; and/or the next live recurrence.
5. Read `driver_events` → confirm or kill the hypothesis → design the fix with certainty.

## Gate (fresh — this is Option B, its own gate)
Advisor review + **codex glance** of the built diff (driver-path + touches a live function). Emulator not needed (no rules change). **Verify at gate:** (1) fence — accept behavior byte-identical; (2) fire-and-forget on both client emit and server events block, watchdog pure; (3) server events-block failure can't break location ingestion; (4) dark + live-flag; (5) bounded (client cap + server cap + inline prune) + client `at`; (6) decisive for the three buckets; (7) **deploy safety** — single-function `--only` target, `.env` reconciled, zero deletions. Not money-adjacent. Do not self-merge; owner deploys.

## Out of scope (separate, acknowledged)
(a) lite-app map-freeze/berserk-on-pin-tap stability bug; (b) latent `acceptTask` CAS race (real, code-confirmed, did NOT cause this incident) — proactive hardening; (c) the eventual accept-path fix (deferred until telemetry proves the mechanism).
