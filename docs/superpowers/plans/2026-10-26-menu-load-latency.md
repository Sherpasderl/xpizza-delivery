# Plan 2: Live-menu load latency (every restaurant)

**Status:** PLAN r1, awaiting the advisor gate. Its own Codex gate and deploy. Owner approved the sequencing on 2026-10-25 (DECISIONS.md).
**Goal:** shrink the window in which a form shows its baked menu (W1 in the menu-drift analysis), for every brand, with no UX change.
**Measured (advisor, prod logs, orders.lamusa.hn since 09-26):** full 200 responses have a median of 4.1 s and a p90 of 8.2 s, and 96 of 160 took over 3 s. 304 responses have a median of 0.5 s and a p90 of 4.6 s.
**Sampled 2026-10-25 from the dev machine:** warm 200s took 0.58 to 0.86 s; one 304 took 3.6 s, which fits a cold instance.

## What the request path costs today (file:line on main 6fcd7ff2)

1. **No warm instance.** `exports.getPublicMenu` (xpizza-functions/index.js:7052) declares `{ region, cors, timeoutSeconds: 20, memory: '256MiB', maxInstances: 20 }` and has no `minInstances`. The cash order path already keeps one warm (index.js:1420, `minInstances: 1`). A first visit after an idle period pays a cold start.
2. **A CORS preflight on every stamped load.** The forms fetch through `sherpaFetch` / `SherpaClient.fetch`. That wrapper adds `X-Client-App/-Deployment/-Build/-Compat` (la-musa-orders/sherpa-client.js:259), which makes the GET non-simple, so the browser sends an `OPTIONS` request first. The preflight response, verified live with curl, carries no `Access-Control-Max-Age`, so browsers re-preflight on almost every page load. That is two round trips to a possibly-cold function before the menu arrives.
3. **No shared cache.** `getPublicMenu` sends `cache-control: public, max-age=30, s-maxage=120`. The forms call the function URL directly (`PUBLICMENU_URL`, la-musa-orders/index.html:1785 and xpizza-orders/index.html:1603), and there is no Firebase Hosting in front of it: xpizza-functions/firebase.json has only database, firestore and functions. Nothing between the browser and the function can use `s-maxage`.
4. **The first fetch is never conditional.** The ETag lives only in memory after a live apply (form-live-menu.js:75), so a first visit always downloads the full body.

## Steps (each measured before the next; stop when the median is acceptable)

**2a. Functions only, two small option changes, its own gate and deploy.**
- Add `minInstances: 1` to `getPublicMenu`. The function is 256 MiB, so this is the same cost class the cash path already pays.
- Answer the preflight with `Access-Control-Max-Age: 7200`, which is Chrome's cap; Safari caps lower. The v2 `cors` option has no max-age, so the plan is a two-line `OPTIONS` pre-handler. It sets the header and lets the existing cors middleware answer. If Codex prefers it, the alternative is to drop the `X-Client-*` headers on this one public GET so it becomes a simple request with no preflight at all. Both are brand-agnostic.
- Tests: an emulator-free unit test drives the handler with an `OPTIONS` request and asserts the header, plus an assert that the declared options include `minInstances: 1`. Add a mutation entry for each.
- Measure: re-sample from prod logs a week later, using the same query the advisor used.

**2b. Optional: same-origin edge proxy (Netlify), only if 2a is not enough.**
- Each form's netlify.toml gets `[[redirects]] from = "/menu/*" to = "https://us-central1-xpizza-delivery.cloudfunctions.net/getPublicMenu/menu/:splat" status = 200`. `PUBLICMENU_URL` becomes the relative `/menu`. The request becomes same-origin, so no CORS and no preflight, and Netlify's CDN can honour `s-maxage`.
- **Must verify before building:** whether Netlify's edge actually caches proxied responses under these headers, and how the ETag and 304 behave through the proxy. Measure on a deploy preview.
- **Knock-on:** `form-bundle-live-check.js` reads `PUBLICMENU_URL` to find the endpoint. A relative URL needs the check to resolve it against the function origin. One function, tested.
- A publish is visible within `s-maxage` (120 s) at the edge. That is the same bound browsers already accept from `max-age=30`, plus the CDN layer.

## Out of scope
Changing the payload, which is about 11 KB and not the bottleneck. Changing the apply or defer policy, which is Plan 4 / item 5.

## Risks
`minInstances` has a small standing cost. A wrong preflight header could block the menu fetch entirely; the unit test plus a manual check on a deploy preview cover that. And the fetch already fails soft: the baked menu stays.
