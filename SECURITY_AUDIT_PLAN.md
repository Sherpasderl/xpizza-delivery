# Plan: Static security + reliability audit of the X Pizza delivery platform
_Locked via grill — by Claude + Xavier · revised after Codex Round 1_

## Goal

Produce a **prioritized remediation roadmap** for the X Pizza delivery platform: a ranked
list of security vulnerabilities, reliability weaknesses, and robustness/efficiency
opportunities, each with severity, blast radius, a concrete fix, and an effort estimate.
The audit is a **static code + config review** (no live requests, no code changes) of the
*whole platform*, with depth proportional to risk. Severity is calibrated to the real
operation: a single gastropub in San Pedro Sula running ~2 drivers at low order volume —
**but** low volume does NOT automatically mean low risk (see operational-abuse note below).
The user's motivation is "find our blindspots."

No code is written during this audit. After sign-off, top items become follow-up work.

> **Already-discovered headline finding (Round 1):** the `createOrder` shared secret
> (`MAKE_SECRET`) is hardcoded in the public order form (`xpizza-orders/index.html:1226`,
> `ORDER_SECRET = '3f9fb4bd…'`) and sent as a bearer token from the browser (:2220). The
> order-intake "secret" is therefore public — anyone can read it and POST arbitrary orders.
> This reframes the entire order-intake trust boundary and is expected to rank P0.

## Approach

Static review only — read source, security rules, and config; reason about exploitability
from the code. Never send a live request, create an order, trigger WhatsApp, or write to
Sheets. Each finding is "confirmed by code reading"; anything not statically provable is
marked `[SPECULATIVE]`, `[DESIGN-RISK]` (reasoned but needs a dynamic test), or pushed to
the out-of-repo checklist. **Static review cannot prove what is actually deployed** — for
security rules and IAM the repo file may diverge from production; every rules finding states
this assumption and feeds a deployed-config reconciliation step.

### 1. Build the authorization matrix (deepest surface)
- Read `xpizza-reference/database.rules.json` in full and derive a who-can-read/write-what
  matrix across **every** path: `dispatchers`, `drivers`, `tasks`, `orders`, `config`,
  `dispatcher_alerts`, **`order_tracking`**, **`incoming_messages`**, **`kitchen`**, and any
  path the functions/SDK write that has no rule.
- **Deployed-rules reconciliation:** `order_tracking` and `incoming_messages` are NOT in the
  repo rules file, yet the tracking app expects anonymous reads of `order_tracking/{token}`
  (`xpizza-track/index.html:641`) and functions/dispatch read/write `incoming_messages`.
  Identify the authoritative rules file + deploy path, and flag any intended-public-read vs
  repo-rule mismatch. Mark "what is actually deployed" as a verify-yourself item.
- **`/kitchen` role:** the SDK's `isKitchen(uid)` reads `/kitchen/{uid}`
  (`xpizza-dispatch/xpizza-delivery.js:132`) and kitchen can update order state — add
  `/kitchen` membership and all KDS status-update write paths to the matrix.
- Flag over-broad grants. Known: `orders`, `tasks`, `drivers` use `.read: "auth != null"` —
  any authenticated principal (any driver) can read **all** customer PII and all drivers' data.
- **Driver privilege escalation, field-level:** rules let a driver write an assigned task if
  `data.assigned_driver_id === auth.uid` OR `newData.assigned_driver_id === auth.uid`
  (`database.rules.json:27`) with weak child `.validate`. Enumerate exactly which task fields
  a driver can mutate — status, destination_lat/lng, linked_task_id, totals, assignment
  metadata — and whether any lets them corrupt workflow, reroute, or alter PII/payment.
- Check for self-promotion into `dispatchers`/`kitchen` and any path lacking a rule.

### 2. Cloud Functions — trace every trust boundary (deep)
`xpizza-functions/index.js` (8 functions), `whatsapp.js`, `whatsapp_inbound.js`. For each:
- **createOrder** (public): the bearer secret is **public** (see headline finding) — audit
  what an attacker can do with it (arbitrary order creation, WhatsApp triggering, dispatch
  spam), input-validation gaps, idempotency, delivery-radius enforcement, error leakage.
  The auth check at `index.js:182` is a **plain `!==`, not constant-time** — audit each
  secret comparison in the codebase independently (do NOT assume any are constant-time).
- **onIncomingWhatsApp** (public + query-string secret): secret-in-URL exposure (logs,
  referer, history), constant-time check, the full `orders.once('value')` scan on every
  inbound message (reads ALL orders — cost/latency/DoS amplification), auto-reply loop risk,
  unauthenticated abuse, `incoming_messages` write spam.
- **healthz** (public, no auth): info disclosure, abuse.
- **DB triggers** (notifyDriverOnAssignment, notifyDriverOnCancellation, onOrderCancelled,
  sendOrderStatusNotifications, autoAssignOnOrderCreate, monitorAssignmentTimeout):
  re-entrancy / infinite-trigger loops, double-fire, races in auto-assign stacking and
  timeout reassignment (`index.js:1406`, `:1525`), unawaited promises, error handling that
  could wedge order state. **Mark all race/concurrency findings `[DESIGN-RISK]`** — reasoned
  statically but not proven without an emulator test; collect these into a dynamic-test
  follow-up checklist rather than asserting them as confirmed.
- **Sheets sync:** the in-repo function only writes the status `Cancelado` (low injection
  surface). The path that writes **full order data** into the KDS Sheet appears external/
  legacy (Make.com / Apps Script) — **split repo-confirmed Sheets writes from out-of-repo
  ingestion**; the formula/CSV-injection risk (`=`,`+`,`-`,`@` prefixes on customer-controlled
  fields) goes on the out-of-repo checklist to verify against the actual ingestion path.
- Cross-cutting: secrets read from env, fail-open vs fail-closed on missing config, PII in
  `console.log`, function timeouts/memory, retry-storm behavior on UltraMsg 5xx.

### 3. Auth model (deep)
- How dispatchers, drivers, and kitchen authenticate (Firebase Auth), how role membership is
  established (`/dispatchers/$uid`, `/drivers/$uid`, `/kitchen/$uid`), how a UID maps to a
  person, how accounts are provisioned/revoked, session/token handling in the client apps.

### 4. Customer order intake + tracking-token model (deep)
- `index.html` + `xpizza-orders/`: the embedded order secret (headline), client-side
  validation vs server enforcement, what the browser can tamper with (price/total, delivery
  radius, items), how the order is posted.
- Tracking token: entropy (12 chars / 54-char alphabet), what `order_tracking/{token}`
  exposes publicly, whether full PII leaks via the public tracking record, and whether the
  deployed rule actually scopes anonymous reads to a single token.

### 4a. Payment flow + PCI (deep — added Round 2)
The order form collects **full cardholder data in the browser** — card number
(`xpizza-orders/index.html:1120`), name, expiry, and **CVV** (`:1136`) — behind a PixelPay
panel that is currently a **placeholder/demo** (`PIXELPAY_KEY`/`PIXELPAY_ENDPOINT =
'YOUR_…_HERE'`, `:1227-1228`). Audit:
- **Client-set payment state:** `payment_status` (`:2104`) and `payment_method` (`:2101`) are
  set in the browser and posted to `createOrder`. Determine whether dispatch/drivers/KDS
  treat `payment_method`/`payment_status` as **proof of payment** — i.e. can a customer mark
  an order "paid online" without paying, and would a driver hand over food on that basis?
- **Cardholder-data handling / PCI scope:** where do `card-number`/`card-cvv` values go? Are
  they ever placed in the order payload, logged (`console.log`), stored in RTDB, or sent to a
  backend? Collecting PAN+CVV in your own form puts you in PCI scope; confirm whether a real
  processor endpoint exists or whether this is dead demo code shipped to production.
- **Backend endpoint presence/absence:** is there a real `/api/pixelpay-charge` (Netlify
  function) or only the placeholder? A non-existent endpoint means "online payment" silently
  fails or is faked; a real one needs its own review (out-of-repo if not in this repo).
- Classify the verdict as a likely **high-severity** finding (payment-status spoofing) plus a
  **PCI/compliance** flag (card collection), calibrated to a real shop taking card payments.

### 5. Frontend apps — risk-targeted, no longer "skim"
- **Read/diff every copy of `xpizza-delivery.js`** (dispatch, driver, dashboard, kitchen,
  reference). These contain privileged write helpers (`assignOrderToDriver`, `cancelOrder`,
  `createOrderWithTasks`); **map every exported write helper to the Firebase rule that is
  supposed to constrain it**, and flag drift between copies.
- **Systematic source-to-sink XSS review** across all apps: trace every untrusted field
  (DB/customer data) rendered into `innerHTML`, URLs, `tel:`, `wa.me`, maps links, and
  SVG/chart markup. Note where `escapeHtml` is used vs missing — do not stop at "obvious"
  injection.
- `xpizza-kitchen/`, `xpizza-track/`, `xpizza-catering/`, `xpizza-dashboard/`: embedded
  credentials, public data exposure, injection in rendered order data, service-worker
  (`sw.js`) scope, push-subscription handling.

### 6. Secret management & config (broadened)
- **Full working-tree scan** for secrets — including **ignored and untracked files and
  helper scripts**, not just committed/history. **Git reconciliation done (2026-06-07):**
  local `main` == `origin/main` (`a75fc6f`), 0 ahead/0 behind, single branch — the audited
  code matches GitHub. Distinguish exposure surface per file:
  - `ORDER_SECRET` (== `MAKE_SECRET`) is **committed/tracked** in `xpizza-orders/index.html`
    → public in GitHub AND shipped to every browser. **Top-priority rotation.**
  - `.env` and `run_patches.sh` are **untracked / local-only (NOT in GitHub)** → exposure is
    local-disk, not a repo leak. Still rotate `VAPID_PRIVATE_KEY`, `ULTRAMSG_TOKEN`,
    `WHATSAPP_WEBHOOK_SECRET`, `KDS_SHEET_ID` if the machine/script is shared, but rank below
    the committed-secret item.
  - Check `.gitignore` correctness, `.env.example` hygiene, and whether any secret ever
    reached git history.
- VAPID public key in client (expected-safe; confirm the private key isn't also present),
  `firebase.json`, `netlify.toml` per app, hardcoded IDs/tokens/URLs.
- **Public third-party API-key restriction review:** the Google Maps/Places key is public in
  the order form (`xpizza-orders/index.html:1210`) — by design for a browser key, but it must
  be **restricted** (HTTP-referrer allowlist, only the APIs it needs enabled, quotas + a
  billing cap) or it's an open billing-abuse target. Review every browser-embedded API key
  the same way. Actual restriction settings live in the Google Cloud console → verify-yourself.

### 7. Dependencies / supply chain
- Run a **dated `npm audit`** (and/or OSV query) for `xpizza-functions`. If network/advisory
  data is unavailable, **explicitly mark dependency-vulnerability status as unverified**
  rather than implying a clean bill from reading `package-lock.json` alone. Note versions of
  `web-push`, `googleapis`, `express`, `firebase-*`.

### 8. Out-of-repo "verify-yourself" checklist (cannot confirm statically)
GCP IAM roles on the function service account (least privilege?), Cloud Function
public-invoker IAM, **deployed Firebase security rules vs the repo file**, Netlify env-var
storage, Google Sheet sharing ACL + the **external/legacy full-order ingestion path** (Make/
Apps Script) and its formula-injection exposure, UltraMsg account/webhook config, Firebase
project members, whether `.env`/`run_patches.sh` secrets ever leaked, and a **dynamic-test
checklist** for the `[DESIGN-RISK]` race conditions.

### 9. Synthesize the roadmap
Rank findings P0–P3 (severity calibrated to actual volume, but counting operational-abuse —
see below). For each: title, surface, blast radius, demonstrable / `[SPECULATIVE]` /
`[DESIGN-RISK]`, concrete fix, effort. Then a **remediation sequence** (P0s → low-effort
quick wins → the rest), the out-of-repo checklist, and a short **"already verified positives"**
section (only claims checked against the code — e.g. idempotency, server-side radius
enforcement, unguessable tracking token; NOT constant-time compare, which is false for
createOrder).

### Pre-launch calibration note (updated 2026-06-07)
**The platform is not live yet** — test orders only, no real customers/money, go-live ~2-3
days out pending PixelPay integration. So findings are bucketed **must-fix-before-go-live** vs
**post-launch hardening**, not active incidents. Severity reflects impact *at launch*, not
today. Two launch-blockers already confirmed in triage: public `MAKE_SECRET`/`ORDER_SECRET`
(rotate + rate-limit/bot-protect before real traffic) and the PixelPay integration (must use
tokenization/hosted fields so PAN+CVV never touch own code; drop the demo
`payment_status='confirmed'` shortcut). Operational-abuse still matters because the
`createOrder` endpoint + real UltraMsg number are live now, but with no customers it's
low-urgency until launch.

## Key decisions & tradeoffs

1. **Deliverable = prioritized roadmap, no code during audit.** Tradeoff: nothing is fixed
   at the end; remediation is follow-up work behind a human gate.
2. **Severity lens = security + reliability first**, efficiency/cost/maintainability lower —
   but operational-abuse (enabled by the public secret) is treated as a security issue, not
   dismissed for low volume.
3. **Method = static + config review only**, zero live requests. Tradeoff: exploitability is
   *argued*, not *proven*; uncertain items marked `[SPECULATIVE]`/`[DESIGN-RISK]`, and
   "what's actually deployed" (rules/IAM) is a verify-yourself item, not an assertion.
4. **Scope = whole platform, depth by risk**, plus dated npm/OSV check and out-of-repo
   checklist. SDK copies are now **fully read**, not skimmed.
5. **Confidence bar = demonstrable + reasoned hardening, severity calibrated to ~2-driver
   volume.** Speculative/design-risk flagged, not hidden.

## Risks / open questions

- **Static-only means exploitability is reasoned, not proven.** Each finding states the
  assumption it rests on; race conditions are `[DESIGN-RISK]` pending an emulator test.
- **Repo rules ≠ deployed rules.** `order_tracking`/`incoming_messages`/`kitchen` behavior
  can't be proven from the repo file; the true authz posture is a verify-yourself item.
- **Biggest real risk is the public `createOrder` secret** (confirmed) plus the broad
  `auth != null` read scope — net effect depends on how many accounts exist and how driver/
  kitchen accounts are provisioned (out-of-repo facts to confirm).
- **The full-order Sheets ingestion path is likely external** (Make/Apps Script) — its
  injection exposure can only be flagged, not confirmed, from this repo.
- **Payment surface is half-built:** card data is collected in-browser but PixelPay is a
  placeholder and `payment_status` is client-set. Real impact (payment spoofing, PCI scope)
  depends on whether downstream actors trust that state and whether a real charge endpoint
  exists — partly an out-of-repo fact.
- **Dependency CVE status may be unverifiable offline** — will be marked as such if so.
- **Local vs deployed (reconciled 2026-06-07):** audited tree == GitHub `origin/main` except
  one uncommitted local line — `createOrder` is `cors: true` locally vs `cors: false` on
  GitHub. Netlify frontends auto-deploy from `main` (≈ what's audited), but **Cloud Functions
  deploy manually**, so the live functions may match neither local nor GitHub. Treat all
  function-level findings as "as-written in repo"; confirm the deployed revision separately.

## Out of scope

- Live exploitation, penetration testing, or any request that mutates production state.
- Writing or applying code fixes (this audit produces the roadmap only).
- Confirming infrastructure not visible in the repo (GCP IAM, deployed rules, Netlify env,
  Sheet ACL + external ingestion, UltraMsg dashboard, Firebase membership) — verify-yourself.
- Business-logic correctness unrelated to security/reliability (pricing accuracy, menu data,
  catering UX, marketing copy, visual design).
- Performance load-testing or profiling under real traffic.
