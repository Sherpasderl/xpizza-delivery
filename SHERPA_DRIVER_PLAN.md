# Plan: Sherpa Driver App — Step 2 (native push + background location, Android, end-to-end)
_Locked via grill-with-docs — by Claude + Xavier. Terms per CONTEXT.md; see ADR 0003, 0004._
_Rev 5 — Codex-APPROVED at R4; item 15 relaxed post-approval (hub-snapshot dependency resolved for the pilot, see log)._

## Goal

Turn the bare Capacitor shell (`hn.sherpa.driver`, foreground GPS already validated on a real
phone) into a [[Native driver app]] that, on Android, lets a real Driver **receive an Order**
via native push **and** stream **continuous background location** to the unified dispatcher —
so a dispatcher is no longer blind to a moving Driver mid-delivery. Done when one real Driver
on one real Android phone, app backgrounded/locked, receives an Order and keeps a live pin on
dispatch through a full delivery. iOS, GitHub remote, and backlog cleanup are out of scope.

## Server-owned vs Driver-writable fields (foundational — Codex R2 #4, #7)

Several Step-2 fields are security/correctness-critical and must be **server-owned** (written
only by Cloud Functions; RTDB rules deny Driver self-write), because the current `/drivers/{uid}`
model allows broad self-writes:
- `location_source` (`native`|`pwa`), `current_hub_lat/lng`, `current_restaurant_id`,
  `current_shift_id`, `push_reachable` (materialized flag), and — for native Drivers — the
  location fields themselves (`lat/lng/accuracy/heading/speed/last_ping`, written via ingest).
- Direct client RTDB lat/lng writes are allowed **only when** the server-owned `location_source`
  is `pwa`. A native Driver cannot flip themselves to `pwa` to revive client writes.

**Server-mediated write paths these fields force (Codex R3 #1, #2):**
- **`startShift`/`endShift` become server-mediated** (callable/HTTPS). `startShift` atomically
  sets `active/status/current_shift_id`, stamps `location_source`, and mints the enabled ingest
  credential; `endShift` revokes the credential and clears shift/hub fields. The current SDK
  direct-write `startShift()` is replaced by this call (PWA Drivers use the same callable — they
  just get no ingest token and keep `location_source: pwa`); direct client writes to these fields
  fail cleanly under rules.
- **`push_reachable` is maintained server-side for BOTH transports.** A DB trigger on
  `/drivers/{uid}/push_subscription` (PWA web-sub, still a direct client write) and the
  `registerDriverPushToken`/cleanup paths (FCM) recompute `push_reachable` — so a PWA Driver who
  subscribes/unsubscribes never silently regresses to un-Reachable now that Reachable reads the flag.

**Migration / backfill (Codex R3 #4):** existing Driver records have none of these fields.
A backfill seeds `location_source: "pwa"` and a computed `push_reachable` (from existing
`push_subscription`) for all current Drivers. To remove the deploy-ordering footgun, the
Step-2a assignment gate (`pickEligibleDriver`) **falls back to a real web subscription when
`push_reachable` is absent** — so existing PWA Drivers stay assignable even if the backfill
hasn't run; the backfill just makes the server flag canonical. (Step 2b's `location_source`
write-gating still wants the backfill before it goes live — sequence it there.)

## Approach

Build order: **FCM → ingest+geofence → license+Transistorsoft.** The native shell today is a
*regression* (Web Push is dead in the WebView), so push is fixed first; the Transistorsoft
license is spent last, after the risky integration points are proven by `curl`.

### Step 2a — Native push (FCM), no license needed
1. Add `@capacitor/push-notifications`; configure the FCM sender in the existing Firebase
   project; add `google-services.json`.
2. **Token registration via a server endpoint, not a client write (Codex R2 #1).** On native,
   the app calls a `registerDriverPushToken` **callable** that verifies the Firebase ID token
   and writes the **server-only** `/driver_push_tokens/{uid}` (`{ token, owner_uid, platform,
   app_build, last_seen }`) — the client never writes that path. The function also maintains a
   **non-sensitive materialized flag** `/drivers/{uid}/push_reachable` so dispatch can read
   reachability without seeing tokens (Codex R2 #2).
3. **Web-subscription disposition (resolve the contradiction — Codex R2 #3):** existing PWA
   `push_subscription` **stays under `/drivers`** (pre-existing, lower-sensitivity — a web sub
   is unusable without the private VAPID key; moving it is out-of-scope churn). Only raw **FCM**
   tokens move server-only. `push_reachable` reflects *either* transport. ADR 0003 updated to
   say exactly this.
4. **One shared `sendDriverPush(uid, payload)` helper** for *every* Driver push trigger —
   assignment **and** `notifyDriverOnCancellation` (`index.js:1756`) and any future ones
   (Codex R1 #3). It reads `/driver_push_tokens/{uid}` + `/drivers/{uid}/push_subscription` and
   is **try-FCM-then-fallback**: attempt FCM if a token exists; **fall back to web-push on ANY
   FCM send exception** (transient included), and **clear the FCM token + recompute
   `push_reachable` only on terminal token errors** (`registration-token-not-registered`) —
   mirroring the 404/410 web-push cleanup (Codex R1 #5, R2 #11).
5. **FCM is not gated on VAPID** — the missing-VAPID early-return (`index.js:1563`) gates
   web-push only (Codex R1 #4).
6. **Token lifecycle:** `registerDriverPushToken` is idempotent on refresh; verify `owner_uid`
   matches the signed-in uid before sending (shared-phone account-switch); clear on logout. Keep
   the token across `endShift` (rely on Shift/Reachable gating) (Codex R1 #6).
7. **Reachable, centralized, reads the materialized flag.** Add `hasPushReachability(d)` →
   `d.push_reachable === true`, and replace every `!!d.push_subscription` site:
   `pickEligibleDriver` (`index.js`), dispatch `renderDriverNode` / picker-confirm /
   `getDotClass` (`xpizza-dispatch/index.html:2766, 3483, 3576`), and dashboard (Codex R1 #7).
8. **Field-level RTDB rules** for the server-owned set above; `/driver_push_tokens` denies all
   client read/write (Codex R1 #1, #2).
9. **Validate:** native Driver, app backgrounded **and force-killed**, receives a real new-Order
   push that wakes the phone and deep-links to the Order; a cancellation retraction also arrives
   natively. Web-push still works for PWA Drivers (live rollback).

### Step 2b — Ingest endpoint + geofence move + pickup fix, no license needed
10. **`pickupComplete` sets `en_route_delivery`** in its existing atomic write (ADR 0004),
    **filtered to same-`restaurant_id` stacked pickups** so a Driver carrying X. Pizza + La Musa
    isn't auto-completed across Restaurants (Codex R1 #9). Land in all six SDK copies, **with tests**.
11. **Close the auto-assign over-stack race (Codex R1 #8, R2 #8).** Beyond re-reading the chosen
    Driver's status/count right before the write, **guard the assignment write with an RTDB
    transaction / per-Driver capacity check** so two concurrent new-Order triggers can't both
    read the same capacity and over-stack. _Tier:_ re-read+conditional-write-with-retry is
    sufficient for the 3-Driver pilot; a per-Driver capacity lease is the **harden-before-scale**
    form (noted, not pilot-blocking).
12. Build **`ingestDriverLocation`** (`onRequest`): resolve uid from the per-request credential
    (Auth below) → **batch validation (Codex R1 #13, R2 #5, #10):** each point carries a
    **plugin-recorded timestamp**; track `last_location_ts` (device time, with a bounded
    skew/max-age window) **separately** from `last_ping` (server-received time); **drop points
    older than `last_location_ts` or beyond max-age**; **run the geofence state machine over
    accepted points in timestamp order**, then persist the final location — so offline-queue
    replay neither regresses the pin nor misses an enter/exit transition. Range-check lat/lng.
13. **Server-side geofence (native Drivers only)** ported from `checkGeofenceTransition`, reading
    the **hub snapshot persisted on the Driver record** (`current_hub_lat/lng/current_restaurant_id`)
    — not `current_task_id` (null on cancel/reassign, a delivery task post-pickup). The snapshot
    derives from the Order's immutable `hub_lat/hub_lng` (ADR 0002), not the config plane (Codex R1 #11).
14. **Hub-snapshot lifecycle (Codex R2 #9) — define every transition:** set `current_hub_*` on
    **assignment** (from the Order); keep through **pickup**; on **reassign** replace; on **cancel
    / completeTask (last delivery) / endShift** clear. `arriveAtRestaurant` manual override does
    not change it.
15. **Hub source — the snapshot is NOT live yet** (verified 2026-06-10: no `hub_lat/hub_lng` and
    no `/restaurants` node in `index.js`; hub is a single hardcoded constant `RESTAURANT_LAT/LNG`
    at `index.js:2256-2257`, and the platform is genuinely single-Restaurant — Orders carry no
    `restaurant_id`). So Step 2b does **not** wait on the (separate, unbuilt) La Musa hub-snapshot
    work. The server geofence reads the **same single authoritative hub constant** the rest of the
    system already trusts (`createOrder` delivery-radius + `pickEligibleDriver` distance sort) —
    this is the one true hub, NOT a per-`restaurant_id` literal map (the drift Codex R1 #12
    rejected). **Fail-closed guard:** the server geofence refuses and logs the moment an Order
    carries a `restaurant_id` other than `x_pizza`, forcing the hub-snapshot dependency (ADR 0002)
    to be resolved before La Musa goes live. Trade-off accepted: native geofence is correct only
    while single-Restaurant — true today and until the La Musa build ships.
16. **Single geofence authority** via the server-owned `location_source` flag: native Drivers
    never call client `updateDriverLocation`; the server geofence acts only for `native` Drivers
    (Codex R1 #10).
17. **Validate via `curl`/Postman (unit gate only):** location writes, geofence transitions,
    stale/out-of-order/future-timestamp point rejection, auth rejection of bad/missing/expired
    tokens (Codex R1 #18).

### Step 2c — License + Transistorsoft integration
18. Get Transistorsoft's 3 written confirmations → buy STARTER ($399) → register `hn.sherpa.driver`.
19. Add `@transistorsoft/capacitor-background-geolocation`; add `FOREGROUND_SERVICE`,
    `FOREGROUND_SERVICE_LOCATION`, `ACCESS_BACKGROUND_LOCATION` + the persistent foreground-service
    notification. **Disable `startGpsStream`/`watchPosition` on native**; server sets
    `location_source = native`. Transistorsoft is the sole location source (ADR 0003). Configure
    plugin-recorded per-location timestamps in the payload.
20. Point Transistorsoft's uploader at `ingestDriverLocation` with the enabled credential (Step 3).
21. **Validate on a real-device matrix (not curl):** Doze, force-killed app, token refresh across
    the >60-min boundary, logout/account-switch, offline-then-replay ordering, cancellation push —
    on actual low-end fleet hardware (Xiaomi/Samsung/generic), confirming OEM battery-killer
    allow-listing. Pin stays live through a full delivery (Codex R1 #18).

### Ingest auth (ADR 0003 Open question — credential decided empirically in Step 3)
- **Both candidates are server-minted, shift-bound ingest tokens** carrying `uid/shift_id/device_id`
  — NOT raw Firebase ID tokens (which carry no `shift_id`) (Codex R2 #6). Exactly **one path is
  enabled at a time** behind a config flag; the other default-denied (Codex R1 #19).
- **`current_shift_id` is added to the shift schema (Codex R2 #7):** `startShift` atomically
  creates a shift id; the ingest token is minted against it; `endShift`/logout revoke it.
- **Candidate A — natively-refreshed session token:** at shift start an endpoint mints a
  short-lived ingest JWT (`uid/shift_id/device_id`); Transistorsoft's `authorization`/JWT strategy
  refreshes it **natively** via `refreshIngestToken` (returns clean `{access_token, refresh_token,
  expires_in}`; `expires` set to refresh before expiry). Survives deep backgrounding.
- **Candidate B — opaque per-shift token:** **stored hashed** at `/driver_tokens/{hash}` with
  `{ uid, shift_id, device_id, issued_at, expires_at, revoked_at }`; compared by hash server-side;
  minted at shift start, no refresh, revoked at `endShift`/logout (Codex R1 #14).
- **Freshness on every ingest:** `drivers/{uid}.active === true` **and** token
  `shift_id === current_shift_id`; reject queued points timestamped after `shift_ended_at`. (Codex R1 #15).
- **Abuse controls now:** per-uid rate limits + structured anomaly logging; TLS-only. **App Check /
  Play Integrity device attestation is a pre-fleet-rollout gate** (before scaling past the 3 pilot
  Drivers), named not silently deferred (Codex R1 #16).

### Observability (Codex R1 #17, R2 #12)
Structured logs + alertable counters keyed by `uid`/`order_id`/`restaurant_id`/`platform`:
FCM send failures by error code, web-push fallback usage, **"push send accepted but no app
ack/open within N seconds"** (requires a native ack event — the real "did it land" signal, not
send-success), ingest auth failures, stale/out-of-order/future points dropped, geofence transition
decisions, and "hub snapshot missing / fail-closed" events.

### Tests (Codex R1 #20)
Automated coverage for `pickupComplete` (sets `en_route`, same-Restaurant guard),
`pickEligibleDriver` (race re-read + transaction guard, Reachable via `push_reachable`), the
manual dispatcher picker (Reachable/full guards), timeout reassignment, and ingest batch ordering
(stale/future-point rejection) — not reliance on six hand-edited SDK copies.

## Key decisions & tradeoffs

- **Location leaves the device natively, never via the WebView** — [[0003-native-location-ingest-bypasses-webview]].
- **Push tokens registered + materialized server-side; dispatch reads a `push_reachable` flag** — tokens never world-readable, yet Reachable stays computable.
- **Ingest tokens are server-minted + shift-bound; one credential path live at a time** — credential chosen empirically in Step 3.
- **`en_route_delivery` driven by the pickup action** — [[0004-en-route-transition-driven-by-pickup-action]]; plus a transaction-guarded auto-assign to close the over-stack race.
- **Security/correctness fields are server-owned** — `location_source`, hub snapshot, shift id, native location; no client self-flip.
- **Single geofence authority per Driver; geofence runs per-point in timestamp order** — no split-brain, no missed transitions on replay.
- **Hub resolved from a persisted snapshot, fail-closed; no hardcoded hub map** — per ADR 0002.
- **License spent last.**

## Risks / open questions

- **Ingest credential (Step 3 gate)** — does Transistorsoft's native refresh fire reliably on cheap dozing hardware? If not, opaque per-shift token (hashed, shift/device-bound).
- **Hub snapshot dependency** — RESOLVED for the pilot (item 15): snapshot is not live, so the geofence uses the single authoritative hub constant with a fail-closed `restaurant_id !== x_pizza` guard. The ADR-0002 snapshot must land before La Musa goes multi-Restaurant.
- **Clock skew / device timestamps** — `last_location_ts` uses plugin time with a bounded skew window; a pathological device clock could still drop/accept points — monitored via the dropped-points counter. _Harden-before-scale._
- **Concurrent over-stack** — re-read+conditional write for the pilot; per-Driver capacity lease before scale.
- **OEM battery-killers** — verify per-vendor allow-listing on actual fleet hardware.
- **FCM payload shape** — must wake a backgrounded/killed app and deep-link to the Order.
- **SDK duplicated ×6** — covered by tests, not copy discipline alone.

## Out of scope

iOS; Play Store submission; GitHub remote for `sherpa-driver-app`; deleting the orphaned root
`index.html`; version-comment bump; auth-recovery Cloud Function; Firebase API-key referrer
hardening (App Check/Play Integrity named above as a pre-fleet-rollout gate, not built in Step 2);
moving the existing PWA `push_subscription` off `/drivers` (FCM tokens only are server-only); the
broader La Musa multi-restaurant build (consumed only as the `hub_lat/hub_lng` snapshot dependency).
