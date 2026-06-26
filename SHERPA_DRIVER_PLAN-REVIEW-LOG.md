# Plan Review Log: Sherpa Driver App — Step 2 (native push + background location)
Act 1 (grill-with-docs) complete — plan locked, CONTEXT.md + ADR 0003/0004 updated. MAX_ROUNDS=5.
PLAN_FILE=SHERPA_DRIVER_PLAN.md  LOG_FILE=SHERPA_DRIVER_PLAN-REVIEW-LOG.md
Codex thread: 019eb38f-143b-7a00-84e4-dbedff6f77cc

## Round 1 — Codex (VERDICT: REVISE)

20 findings, all read against the actual repo:
1. `fcm_token`/location fields client-writable under `/drivers/{uid}` — need field-level owner rules.
2. `/drivers` is all-authenticated-readable — raw push tokens exposed; move to server-only path.
3. `notifyDriverOnCancellation` (`index.js:1756`) still web-push-only — native Drivers miss retractions.
4. VAPID-missing early-return (`index.js:1563`) would suppress FCM too if dual path sits below it.
5. "FCM else web" is pick-one → silent un-Reachable when FCM stale but web sub valid.
6. FCM token freshness under-specified: rotation, logout, reinstall, account-switch on one phone, endShift.
7. Reachable duplicated beyond the two I named — `renderDriverNode`, picker confirm, map marker, `getDotClass` (`xpizza-dispatch/index.html:2766, 3483, 3576`).
8. Auto-assign read-then-write TOCTOU: `pickupComplete`→`en_route` can race a stale picker snapshot and still stack (`index.js:2344, 2560`).
9. `pickupComplete` auto-completes ALL accepted pickups (`xpizza-delivery.js:743`) — no cross-Restaurant guard.
10. Two geofence authorities (PWA client + native server) can both write status during rollout.
11. `current_task_id` is a delivery task post-pickup and null on cancel/reassign — returning-to-Hub geofence may lack an Order snapshot.
12. Temp `restaurant_id → hub` map is a domain mismatch (Hub is per-Restaurant); require immutable Order Hub snapshot, fail-closed.
13. Offline-queue batch replay delivers old points after new → regresses pin/status; need timestamps + ordering + max-age.
14. Opaque token underspecified — hash it; bind to uid/shift/device/issued/expires/revoked.
15. `off_shift` rejection insufficient — validate `active===true`, `shift_id` match, reject post-`shift_ended_at` queued points.
16. No App Check/device attestation for the public ingest endpoint despite location-spoof being the new surface.
17. Observability too thin (FCM failures by code, fallback usage, ingest auth failures, dropped stale points, geofence decisions, hub-missing).
18. `curl` can't prove Step 3 refresh / FCM background / offline ordering — need a real-device matrix.
19. "Accepts either credential" doubles attack surface before the empirical choice.
20. Add tests around pickupComplete/pickEligibleDriver/manual picker/timeout reassignment rather than relying on six copy edits.

### Claude's response (Rev 2)
ACCEPTED 18 of 20 outright into the plan + ADR 0003:
- Push (#1–#7): server-only `/driver_push_tokens/{uid}`, one `sendDriverPush()` helper across assignment AND cancellation, try-then-fallback (not pick-one), FCM independent of the VAPID guard, full token lifecycle inc. account-switch, centralized `hasPushReachability()` across all dispatch/dashboard call sites, field-level owner rules.
- Ingest/geofence (#10–#13): batch timestamps + reject-older-than-`last_ping` + ordering, hub snapshot persisted on the Driver record (covers null `current_task_id`), no hardcoded hub map (gate/fail-closed), `location_source` flag = single geofence authority per Driver.
- Race (#8): re-read chosen Driver status/count immediately before the assignment write.
- Auth (#14, #15): hashed opaque tokens bound to shift/device; freshness = active + shift_id + reject post-endShift.
- Ops (#17, #18, #20): added Observability and Tests sections; `curl` = unit gate, real-device matrix required.

ADAPTED 2 (accepted the security point, kept Xavier's locked choices):
- #19 (dual credential) — Xavier chose "endpoint accepts either, decide empirically in Step 3." Kept that, but gated behind a config flag so **only one path is live at a time** (other default-denied) — surface not doubled.
- #16 (App Check) — App Check/Play Integrity stays out of the Step 2 *build* (project-wide hardening), BUT added per-uid rate-limits + anomaly logging now, and named App Check/Play Integrity as an explicit **pre-fleet-rollout gate** rather than a silent deferral.

REJECTED outright: none.

## Round 2 — Codex (VERDICT: REVISE)

12 second-order findings (mostly contradictions my Rev 2 introduced):
1. `/driver_push_tokens` "server-only" but client writes it → impossible; need a registration endpoint.
2. `hasPushReachability` reads `/drivers` but tokens moved out → materialize a `push_reachable` flag.
3. Web `push_subscription` stays under `/drivers` while ADR says all tokens server-only → contradiction.
4. `location_source` writable under broad self-write → Driver could flip to `pwa` and revive client geofence.
5. Freshness compares device ts to `last_ping` (server ts) → clock-skew; need `last_location_ts`.
6. Firebase ID tokens carry no `shift_id` → shift binding impossible for raw-ID-token candidate.
7. `current_shift_id` not in schema; startShift/endShift only write timestamps/status.
8. Re-read fix doesn't stop two concurrent assigns reading the same capacity → transaction/lease.
9. Hub-snapshot lifecycle under-specified (cancel/reassign/complete/endShift/manual).
10. Geofence per-point vs final-only on batch replay → final-only misses enter/exit.
11. Transient FCM failures suppress web fallback → fall back on ANY FCM exception; clear token only on terminal.
12. "Token registered but no push delivered" not observable from send success → needs a native ack event.

### Claude's response (Rev 3)
ACCEPTED all 12. Structural changes:
- Added a "Server-owned vs Driver-writable fields" section (#4, #7): `location_source`, hub snapshot, `current_shift_id`, `push_reachable`, native location — all server-written; client lat/lng only when source=`pwa`.
- `registerDriverPushToken` callable + materialized `push_reachable` flag (#1, #2); resolved web-sub contradiction explicitly — only FCM tokens move server-only, web subs stay, reachability via the flag (#3).
- Reshaped BOTH ingest candidates to server-minted shift-bound tokens carrying `uid/shift_id/device_id` (#6); added `current_shift_id` to the shift schema with mint/revoke lifecycle (#7).
- Ingest: `last_location_ts` (plugin time + skew window) separate from `last_ping` (#5); geofence runs per-point in timestamp order then persists final (#10).
- Hub-snapshot lifecycle defined across assignment/pickup/reassign/cancel/complete/endShift (#9).
- Push fallback on ANY FCM exception; clear token only on terminal error (#11).
- Observability metric renamed to "send accepted but no app ack within N s" + native ack event (#12).

TIERED (accepted, prioritized — arbiter call for a 3-Driver pilot):
- #8 concurrent over-stack: re-read+conditional-write for the pilot; per-Driver capacity lease = harden-before-scale.
- #5 clock skew: bounded skew window for pilot, monitored via dropped-points counter; deeper handling before scale.

## Round 3 — Codex (VERDICT: REVISE)

4 findings — all migration/consistency consequences of Rev 3's server-owned fields:
1. PWA `push_subscription` is a direct client write but `push_reachable` is server-owned → nothing recomputes the flag for web subs → PWA can regress to un-Reachable.
2. `startShift` is still a direct client write, but `current_shift_id` is server-owned + ingest token minted at shift start → needs a server-mediated startShift.
3. ADR 0003 still said `verifyIdToken → uid` candidate and `last_ping` ordering — stale vs Rev 3.
4. No backfill for `location_source`/`push_reachable` on existing Driver records → they'd render unreachable / be blocked after gates flip.

### Claude's response (Rev 4)
ACCEPTED all 4:
- Added server-mediated `startShift`/`endShift` (callable): atomically set active/status/current_shift_id, stamp location_source, mint/revoke ingest credential; PWA uses the same callable (no token, source=pwa); direct writes fail under rules (#2).
- Added a DB trigger on `/drivers/{uid}/push_subscription` + the FCM register/cleanup paths to recompute `push_reachable` for BOTH transports (#1).
- Added an explicit backfill (`location_source:"pwa"` + computed `push_reachable`) before flipping gates (#4).
- Finished the ADR 0003 sync: identity bullet now says server-minted shift-bound token (not verifyIdToken); freshness uses `last_location_ts` not `last_ping` (#3).

## Round 4 — Codex (VERDICT: APPROVED)

"Rev 4 is coherent. Prior blockers resolved: push_reachable has a server-maintained path for both
FCM and PWA web subs; startShift/endShift are server-mediated and shift-token-aware; backfill is
ordered before gates flip; ADR 0003 matches the plan (server-minted shift-bound tokens + last_location_ts).
Remaining risks (clock skew, concurrent-assign hardening, OEM battery, App Check/Play Integrity)
appropriately classified as harden-before-scale, not blocking. For a 3-Driver pilot, the ingest auth,
reachability model, and geofence authority split are internally consistent."

CONVERGED at Round 4 of 5. Act 1 (grill-with-docs) + Act 2 (Codex) complete.

## Post-approval revision (Rev 5) — hub-snapshot dependency resolved

Verified 2026-06-10 that the ADR-0002 per-Order hub snapshot is NOT live: no `hub_lat/hub_lng`
or `/restaurants` node in `index.js`; hub is a single hardcoded constant (`RESTAURANT_LAT/LNG`,
`index.js:2256-2257`); Orders carry no `restaurant_id` (platform is single-Restaurant today).

Item 15 RELAXED (does not touch the Codex-approved security/identity model, so no new Codex round):
the server geofence reuses the single authoritative hub constant the rest of the system already
trusts (NOT a per-restaurant_id literal map — the drift Codex R1 #12 rejected), with a fail-closed
guard that refuses any Order with `restaurant_id !== x_pizza`. This converts the hub-snapshot
dependency from a Step-2b blocker into a guard that fires when La Musa goes multi-Restaurant. Step 2b
no longer waits on the separate, unbuilt La Musa config-plane work.
