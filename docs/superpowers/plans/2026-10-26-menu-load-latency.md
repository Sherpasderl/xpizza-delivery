# Plan 2: Live-menu load latency, a warm `getPublicMenu` (every restaurant)

**Status:** PLAN r1. It answers Codex plan r1 (1 P1, 5 P2), per the advisor's rulings of 2026-10-26. It is a functions-only change with its own scoped gate and a functions deploy. The owner approved the sequencing on 2026-10-25 (DECISIONS.md).

**r1 changes:**
- **§2b dropped entirely.** That was the Netlify `/menu` proxy and edge cache. Dropping it closes P1 (the URL broke the build check), P2-4 (the consumer inventory) and P2-5 (edge freshness), and makes plan 4's P2-4 moot.
- **The OPTIONS max-age idea is dropped (P2-3).** The Firebase v2 wrapper runs `cors` before application code (firebase-functions/lib/v2/providers/https.js:83), and `cors` ends an OPTIONS request without calling the handler (cors/lib/index.js:173).
- **The diagnosis is corrected (P2-2).**
- **An exact measurement and a post-deploy smoke are added (P2-6).**

**Goal:** shorten W1, the time a form shows its baked menu before the live menu arrives. No UX change and no form change.

## Diagnosis (corrected; file:line on main 6fcd7ff2)

1. **No warm instance.** `exports.getPublicMenu` (xpizza-functions/index.js:7052) declares `{ region: 'us-central1', cors: PUBLIC_MENU_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 20 }`, with no `minInstances`. The cash order path keeps one warm (index.js:1420). A first visit after an idle period pays a cold start.
   - Samples on 2026-10-25: warm 200s took 0.58 to 0.86 s from the dev machine; one request took 3.6 s, which fits a cold instance. The advisor's prod sample: 200s have a median of 4.1 s and a p90 of 8.2 s.
2. **First loads are simple GETs, with no preflight.**
   - The menu request carries no `X-Client-*` headers. Those go only to the four identity endpoints (sherpa-client.js:44/:268), and pselfupdate-client.test.js:170 pins that.
   - The only script-added preflight trigger is `If-None-Match` on subsequent refreshes (form-live-menu.js:75), after a live apply. My r0 claim of a preflight on every load was wrong.
   - The browser's own HTTP cache and its automatic revalidation are separate from the script's ETag and are not disabled by it.
3. **A 304 is not cheaper server-side.** Both 200 and 304 run `buildPublicMenu` before the ETag comparison (index.js:7068). So status-specific medians do not isolate the cause; a cold start hits both.

The only change in this plan is (1). (2) needs no change. (3) is recorded for a later look, not changed here.

## Change

- **Code:** `getPublicMenu` options gain `minInstances: 1`. One line. Nothing else changes: not the projection, `maxInstances: 20`, the origin list, restaurant validation, the private catalog rules or pricing.
- **Test:** the assertion goes on the real exported function. cors-preflight.test.js already loads index.js with a synthetic third deployment, so it gains `assert.strictEqual(app.getPublicMenu.__endpoint.minInstances, 1)`. The existing per-origin preflight cases for getPublicMenu stay as they are: configured, synthetic and denied origins, `If-None-Match` allowed, the ETag exposed.
- **Mutation entry:** removing the option is killed by that assertion.
- **Regen and guards:** the R3 chain and form-source-inventory at the exact tip, plus a full `npm test` in the heavy slot.

## Measurement (the acceptance gate)

Two measurements: server-side, from logs (it isolates cold starts), and client-side, in a real browser (it is the actual goal).

**A. Server-side, from Cloud Logging.** The advisor runs this and confirms it matches the query behind the 4.1 s / 8.2 s baseline. If it doesn't, the baseline is re-pulled with this query, so before and after are comparable.

```
resource.type="cloud_run_revision"
resource.labels.service_name="getpublicmenu"
httpRequest.requestMethod="GET"
(httpRequest.referer=~"^https://orders\.lamusa\.hn" OR httpRequest.referer=~"^https://orders\.xpizza\.hn")
```

- **Sample:** every matching request, for 7 days before deploy versus the 7 days starting 24 h after deploy, split by brand (referer) and by status (200 / 304 / other), reporting `httpRequest.latency` median and p90 and the non-2xx/304 rate.
- **Pass:** the 200 median is ≤ 1.0 s and the p90 is ≤ 2.5 s for each brand, and the error rate is no higher than baseline.

**B. Client-side, navigation → live menu in real Chrome, both forms.**
- **Harness:** the same headless-Chrome DevTools driver used for the item 5 mockup, against the deployed sites, read-only. It records `window.__liveMenu.feed.state().lastAppliedAt − performance.timeOrigin` once `state().source === 'live'`. That's the moment the live menu is received and validated, whether or not it changed anything on screen.
- **Runs:** for each form, 10 runs with a fresh profile (cold browser cache) and 10 runs reusing one profile (warm browser cache), at 390 px.
- **Pass:** fresh-profile median ≤ 2.5 s, and no run > 6 s.
- **Caveat:** these are dev-machine numbers, not a Honduran mobile connection. They are a relative before/after measure, so they're also taken before deploy as the baseline.

**Post-deploy smoke (immediately after the deploy, by me, read-only):**
- `gcloud functions describe getPublicMenu --gen2 --project xpizza-delivery --region us-central1 --format='value(serviceConfig.minInstanceCount)'` prints `1` (codex plan r2).
- One B-run per form passes.
- Both forms' `form-bundle-live-check.js --this-form` stay green.

The week-later A comparison follows.

## Risks
- **Standing cost.** One warm 256 MiB instance, the same class the cash path already pays.
- **No change to failure behaviour.** The form still fails soft to its baked menu, and that path is untouched.
