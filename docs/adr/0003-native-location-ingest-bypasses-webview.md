# Driver background location leaves the device by a native HTTP ingest, not the WebView

**Status:** accepted (2026-06-10)

## Context

The PWA driver app cannot keep a Driver's location fresh on the dispatch map when the app
is backgrounded, screen-locked, or the Driver is navigating. This is a hard web-platform
limit, not a bug: `watchPosition` freezes when the page is suspended and service workers
are denied geolocation. The app already pulls every foreground lever (Wake Lock,
`visibilitychange` re-acquire, throttled high-accuracy `watchPosition`). The only path to
continuous background tracking is a [[Native driver app]] (Capacitor) with a native
background-geolocation plugin.

The trap inside that fix: even with a native plugin acquiring fresh GPS, if the *write*
still goes through the Firebase RTDB JS SDK running in the Capacitor WebView, Android
throttles WebView-originated requests after ~5 minutes backgrounded — reproducing the exact
staleness bug with a longer fuse. The location write itself must leave the device by a
native HTTP path.

Today the write is `updateDriverLocation()` → direct client RTDB write to `/drivers/{uid}`,
secured by Firebase Auth UID + RTDB rules (`auth.uid === $driver_id`). A native HTTP POST
to a Cloud Function throws that security model away and must rebuild Driver identity on a
raw endpoint — and the existing shared `MAKE_SECRET` bearer is unfit (one secret ⇒ any
Driver can spoof any other's location).

## Decision

Background location travels: **Transistorsoft native HTTP uploader → `ingestDriverLocation`
Cloud Function (`onRequest`) → write `/drivers/{uid}`** — never through WebView JavaScript.

- **Transistorsoft is the sole location source on native.** When `Capacitor.isNativePlatform()`,
  the app disables `startGpsStream`/`watchPosition` entirely; all location (foreground and
  background) flows through the native uploader. The PWA path is left untouched.
- **The plugin is Transistorsoft** specifically because it has a *native* HTTP uploader
  (bypasses the WebView throttle) plus an on-device SQLite offline queue (survives no
  signal). Free community plugins acquire location natively but hand the write back to JS —
  landing back in the throttle. The decisive failure modes (throttle, OEM battery-killers,
  lost offline locations) are production-only and hardware-specific on mixed low-end Android,
  so "try free first" doesn't surface them in a quick test.
- **Identity is NOT a shared secret.** `ingestDriverLocation` resolves the Driver from a
  per-request credential and only ever writes *that* Driver's own location fields — the same
  blast radius the Driver already has via RTDB rules. The credential is a **server-minted,
  shift-bound ingest token** carrying `uid/shift_id/device_id`, minted by a server-mediated
  `startShift` (NOT a raw Firebase ID token — that carries no `shift_id`). Two refresh
  mechanisms are under empirical test (see Open question), but **only one path is enabled at a
  time** behind a config flag (the other default-denied) so the live attack surface is never
  doubled. The opaque variant is **stored hashed** (`/driver_tokens/{hash}`, server-only, with
  `uid/shift_id/device_id/issued_at/expires_at/revoked_at`) so a DB-read leak yields no usable
  bearer.
- **Every ingest is freshness-checked**, not just `off_shift`-rejected: require
  `drivers/{uid}.active === true` and `token.shift_id === driver.current_shift_id`, drop queued
  points timestamped after `shift_ended_at`, and **reject points older than `last_location_ts`**
  (plugin-recorded device time with a skew window, tracked separately from server-received
  `last_ping`) processed out of order (offline-queue replay must not regress the pin or re-fire geofence
  backwards). Raw **FCM** tokens are registered via a server endpoint and live on a **server-only
path** (`/driver_push_tokens/{uid}`), never world-readable; dispatch reads a materialized
`push_reachable` flag instead. The existing PWA web `push_subscription` stays under `/drivers`
(pre-existing, unusable without the private VAPID key — moving it is out of scope).
- **The geofence state machine runs here, server-side**, for native Drivers (see
  [[0002-config-plane-source-cache-snapshot]] for hub coordinates — the function reads the
  Order's denormalized `hub_lat/hub_lng` snapshot, it does not re-read the config plane).

## Open question (decide empirically in Step 3)

Both candidates are **server-minted, shift-bound ingest tokens** carrying `uid/shift_id/device_id`
(a raw Firebase ID token carries no `shift_id`, so it can't enforce per-Shift freshness).
**Candidate A:** a short-lived ingest JWT refreshed *natively* by Transistorsoft's
`authorization`/JWT strategy (`refreshUrl` → `refreshIngestToken` returning clean `{access_token,
refresh_token, expires_in}`; survives deep backgrounding because the refresh is native, not
WebView JS). **Candidate B:** an opaque per-shift token, stored hashed, no refresh for the whole
shift. Gate: background a phone past token expiry (>60 min) in Doze and confirm ingest keeps
returning 200s and dispatch stays live. If native refresh proves flaky on cheap dozing hardware,
fall back to B; only one path is enabled at a time (config flag). A minted Firebase
*custom* token does NOT help — it still exchanges to a 1-hour ID token with the same refresh
problem.

## Consequences

- Two integrations, not one: background geolocation **and** native push (FCM), because
  browser Web Push is also dead inside the WebView. A native Driver with no FCM token can
  track perfectly yet be un-[[Reachable]] (unassignable) — so FCM lands before Transistorsoft.
- `ingestDriverLocation` becomes a security-sensitive surface: per-uid rate-limit, validate
  lat/lng ranges, freshness checks (above), TLS-only, `/driver_tokens` denies all client
  access, structured anomaly logging. Full device attestation (App Check / Play Integrity) is
  a **pre-fleet-rollout gate** — before scaling past the 3 pilot Drivers — not a Step 2 build item.
- The Transistorsoft license ($399 STARTER, registered to `hn.sherpa.driver`) is on the
  critical path *last* — FCM and the ingest endpoint are built and proven (via `curl`)
  before the license is spent.
- **The ingest token rides in a custom header `X-Driver-Token`, NOT `Authorization: Bearer`**
  (caught by the curl gate, 2026-06-11): Cloud Functions gen2 reserves `Authorization` for
  Google IAM and rejects an opaque bearer at the infra layer (HTML 400) before it reaches the
  function. Transistorsoft's uploader sends custom headers, so this works for the native path.
  Also: hit the function's `run.app` URL, not the `cloudfunctions.net` alias (the alias 400s
  for gen2 after an update).
