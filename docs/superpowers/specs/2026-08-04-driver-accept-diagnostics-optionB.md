# SPEC — Driver accept-reassign incident logger (add-only, logging-only)

**Status:** DESIGN for gate (no code yet). **Sink:** HTTP (Option B), via a **NEW isolated function** — chosen after the Option-A gate REVISE (RTDB web SDK has no cross-session persistence → loses events on app-kill). **Supersedes** `2026-08-04-driver-accept-diagnostics.md` (Option A) and the earlier "extend `ingestDriverLocation`" draft. **Type:** purely additive diagnostic → advisor + codex gate before merge. **Logging-only — NO fix.**

## Owner constraint (LOCKED, verbatim intent)
**Do NOT disturb any already-working function or code. Add code that only serves to log incidents/events. The one goal: catch the problem we hit — an ACCEPTED order being reassigned. That's it.** Every line added is log-only and behavior-preserving; NOTHING in `acceptTask`, `monitorAssignmentTimeout`, `sweepPendingOrders`, `ingestDriverLocation`, `startDriverShift`, or any order/task write is modified.

## The incident to catch (proven — see the Option-A spec/handoff for the full timeline)
Order `PZX-260804-192831-HRSR7VGH`: driver Hermez swipe-accepted, UI looked normal, the 60s `monitorAssignmentTimeout` reassigned him because his accept **never reached the server** (authoritative status still `assigned` at timeout). Server behaved correctly. First occurrence in hundreds. Leading (unproven) hypothesis: RTDB WebSocket stalled while HTTP kept working → `acceptTask`'s write applied to local cache (optimistic UI advance via local listeners) but never server-acked. Two alternatives share the identical server footprint (swipe never crossed 85%; one-off app error) → only CLIENT logs can disambiguate.

## Why this is decisive WITHOUT touching the engine (source-verified)
- `acceptTask` (xpizza-delivery.js:400) ends in `await update(ref(db), updates)` — its last step; RTDB's `update()` promise resolves **only on server ack**.
- The swipe handler (index.html:2306) does `await XPD.acceptTask(...)` then `toast('Aceptado')`; `attachSlideConfirm` owns the error path (slider reset).
- ⇒ a stalled/never-acked write manifests as **`acceptTask` never resolving** — fully observable **from the call site**. We attach a fire-and-forget observer to the returned promise and keep the `await` byte-identical. No line goes inside `acceptTask`.

## Events (minimal set for THIS incident) — each `{uid, at: Date.now(), type, ...ctx}`
1. `rtdb_conn {connected}` — from a NEW `.info/connected` listener; emitted on every transition. The socket up/down signal; `false` bracketing an accept = stall.
2. `accept_swipe {taskId, connected}` — the swipe crossed 85% and `acceptTask` is about to be called, plus the current `.info/connected` value. Absence (when an order was reassigned) ⇒ gesture never fired.
3. `accept_result {taskId, latencyMs}` — the `acceptTask` promise resolved (write server-acked). **Absent (or huge `latencyMs`) while `accept_swipe` is present ⇒ the accept never reached the server — the incident, proven.**
4. `accept_err {taskId, err}` — the `acceptTask` promise rejected (e.g., the defensive "ya no está disponible" after a reassign).
5. `accept_pending {taskId}` *(optional watchdog)* — a bare `setTimeout(…,10000)` emits if the promise hasn't settled in 10s. Observation only — no `Promise.race`, no abort; the real `await` is untouched.

Reading a recurrence: `accept_swipe{connected:false}` + `rtdb_conn:false` around it + **no `accept_result`** = socket-stall, accepted-locally-never-synced. No `accept_swipe` = gesture never fired. `accept_result{normal latency}` yet reassigned = look elsewhere. Decisive for all three.

## Hard guardrails (non-negotiable)
1. **Engine frozen.** No edit to `acceptTask`/monitor/sweeper/`ingestDriverLocation`/any order-task write. The swipe handler gains only log emits + a promise observer; the `await XPD.acceptTask(...)` line and the success `toast` are byte-identical, so control flow (success→toast, error→`attachSlideConfirm` catch) is unchanged.
2. **Fire-and-forget.** Every emit and every HTTP flush is `try/catch`-wrapped, never `await`ed in the accept path. The promise observer is `p.then(onOk, onErr)` attached ALONGSIDE the existing `await p` (both consume `p`, so no unhandled rejection) and cannot alter the awaited outcome. The optional watchdog is a bare `setTimeout` that only emits.
3. **Dark by default.** Gated on `config/driver_diag_enabled` — **live-read/subscribed**, never cached once at startup; absent/false ⇒ fully inert (no listener writes, no buffering, no POSTs).
4. **Bounded.** Client buffer cap (~50 events); the new function caps events/request (≤50), validates each `{type, at}`, and inline-prunes that uid's `driver_events` (drop `>7d` or keep last ~200). No unbounded growth.
5. **Client timestamps.** `at: Date.now()` always. NEVER `serverTimestamp()` (a retried/late flush would misstamp).

## Sink — a NEW isolated function (nothing existing redeployed)
### Server — `xpizza-functions/index.js`: add `exports.driverDiagIngest` (HTTP `onRequest`, us-central1)
- Authed by the SAME per-shift opaque bearer token as `ingestDriverLocation`, by **importing the existing pure validator from `./driver-ingest` read-only** (the validator is NOT modified). Token → `uid`.
- Body `{ events: [{type, at, ...ctx}] }`; validate + cap (≤50), then **admin-write** each to `driver_events/{uid}/{pushId}` and inline-prune. A soft per-uid rate guard (mirror `ingestDriverLocation`'s). All in `try/catch` — a bad payload just 400s, never affects anything else.
- **It is a brand-new export → deploying it redeploys NONE of the working functions** (see Deploy).

### Client — `xpizza-driver` (add-only)
- New `emitDiag(evt)` helper (gated on the live flag): push `{...evt, at: Date.now()}` to a bounded buffer, then **immediately** fire-and-forget `fetch(DIAG_URL, { method:'POST', headers:{Authorization:'Bearer '+ingestToken}, body: JSON.stringify({events: buffer}) })`; on 2xx clear flushed, else keep for a ~10s retry flush. Immediate (not debounced) so the swipe/result burst lands before any app-kill. The `ingestToken` is already held in the WebView JS (`native-location.js` ← `startDriverShift`).
- New `.info/connected` listener on app start → `rtdb_conn` + a `lastConnState` module var (read by `accept_swipe`).
- In the `btn-accept` swipe handler (index.html:2306), ADD: an `accept_swipe` emit, then attach `p.then(res-emit, err-emit)` to the `acceptTask` promise while keeping `await p` unchanged, plus the optional 10s watchdog.

### Rules — NONE
The function admin-writes `driver_events` (bypasses rules); the owner reads it via the **Firebase admin console** after a recurrence. No rules change, no rules deploy, no emulator step. *(A dispatcher `.read` for a dashboard view is a deferred, separate change.)*

## Surfaces touched (all add-only)
- `xpizza-functions/index.js` — NEW `driverDiagIngest` export (+ a pure validate/prune helper in `./driver-ingest`, unit-tested). Existing code untouched.
- `xpizza-driver/xpizza-delivery.js` — NEW `emitDiag` + buffer/flush + `.info/connected` listener.
- `xpizza-driver/index.html` — log emits + promise observer in the `btn-accept` handler (behavior byte-identical).
- **No rules file. No existing function modified.**

## Deploy safety (locked)
1. **Reconcile `.env` → live** first ([[functions-env-management]]).
2. Deploy the new function ONLY: `firebase deploy --only functions:driverDiagIngest`. A scoped deploy **creates just this function and deletes/redeploys nothing** — the driver-native, payment, `ingestDriverLocation`, and every other live function are untouched, so the prune footgun ([[prod-functions-deployed-state]]) cannot fire.
3. **Verify:** deploy log shows only `driverDiagIngest` created, **zero deletions/updates elsewhere**; `gcloud functions list … --filter='state!=ACTIVE'` empty; `ingestDriverLocation` still ingests a test ping.

## Rollout
1. Build in the driver-app repo behind the live `config/driver_diag_enabled` (dark); add `driverDiagIngest`.
2. Reconcile `.env` → deploy `--only functions:driverDiagIngest` → verify (above).
3. Ship the driver app version; flip `driver_diag_enabled=true`.
4. Controlled repro (block the RTDB socket, keep HTTP up, swipe accept) and/or wait for the next live recurrence.
5. Read `driver_events` (admin) → confirm or kill the hypothesis → THEN design the actual accept-path fix as a separate, gated change.

## Gate (this design)
Advisor + **codex** review of the built diff (driver-path; a new function). No emulator (no rules). Verify: engine byte-identical (the `await XPD.acceptTask` line + success toast unchanged); fire-and-forget on emits/flush/observer/watchdog; new function is isolated + fail-safe; dark + live flag; bounded (client + server caps + inline prune) + client `at`; decisive for the accept-reassign incident; deploy safety (single NEW-function `--only` target, `.env` reconciled, zero collateral). Not money-adjacent. Do not self-merge; owner deploys.

## Out of scope (separate, acknowledged)
(a) lite-app map-freeze/berserk-on-pin-tap stability bug; (b) latent `acceptTask` CAS race (real, did NOT cause this incident); (c) the eventual accept-path fix (deferred until telemetry proves the mechanism).
