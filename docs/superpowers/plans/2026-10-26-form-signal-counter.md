# Plan 3: `formSignal`, a server-visible count of order-form cart blocks

**Status:** PLAN r1. It answers Codex plan r1 (1 P1, 6 P2, 1 P3). The advisor accepted all eight findings on 2026-10-26 and ruled that reads are admin-only.

**Delivery:**
- Its own Codex gate (a public endpoint).
- A functions deploy, then a forms deploy, in that order. The forms only send after the endpoint exists, and a beacon that fails is harmless.

**Goal:** count how often a customer is refused at checkout by a cart conflict, per restaurant, per refusal point, per reason, per day. Today the refusal only reaches the browser console:
- La Musa: `console.warn('cart_conflict_blocked_send' …)` and `('cart_conflict_blocked_submit' …)` at la-musa-orders/index.html:2478/:2486;
- X. Pizza: the same calls at xpizza-orders/index.html:2135/:2146.

## Why a new endpoint (corrected, P3)

- **Not the order body.** The escape-hatch telemetry rode on the order. It persisted nowhere, and its unclassified fields nulled PB-1's `chargeInputsFingerprint`. Also, a refusal happens before any order exists.
- **Not `reportClientVersion` either.** A public client sink already exists: `reportClientVersion`, index.js:7440, with handler and schema in client-version.js. But its schema is a version heartbeat, `{app, deployment, context, build, compat, instance, diag?}`. Every field must match a manifest combination, and the only `diag` value is `kitchen_floor_refusal` (client-version.js:34). Folding cart events into it would widen a heartbeat into an event stream and change its counters' meaning.
- **So: a separate endpoint that reuses its safeguards.**
  - a strict schema before any database work;
  - a dedicated limiter that FAILS CLOSED and drops the event;
  - one multi-path update;
  - a sweep with retention.

## Endpoint

```
exports.formSignal = onRequest(
  { region: 'us-central1', cors: FORM_SIGNAL_ORIGINS, timeoutSeconds: 10, memory: '128MiB', maxInstances: 5, concurrency: 40 },
  (req, res) => require('./form-signal').handleSignal(req, res, { db: getDatabase(), ServerValue, registry: restaurantRegistry(), now: Date.now }))
```

- `FORM_SIGNAL_ORIGINS` is derived from platform-manifest exactly as `PUBLIC_MENU_ORIGINS` is (the "its own origin list" rule, index.js:7003). It's the order sites, including any future one, through the manifest.
- **Request shape:** `POST` only, with a body of at most 512 bytes; anything larger gets a 413 before parsing.
  - The content type must be `text/plain`, with any charset parameter accepted. That's what `navigator.sendBeacon(url, string)` sends, and it is a CORS-simple request: no preflight and no custom headers.
  - Anything else gets a 204 with no write.
- **Order of work.** Each step that fails returns 204 and writes nothing. The response body is always empty and never echoes input.
  1. **Parse.** JSON object only (malformed → 204). The keys are exactly `{rid, event, reasons}`; unknown or missing keys → 204.
  2. **Validate, pure, before any database work:**
     - `rid` is a string matching `RID_RE` (catalog/restaurant-registry.js:30), and `registry.known()` (the warmed brand-agnostic registry, the same one `reportClientVersion` is handed) contains it. The live-order resolver `resolveRestaurantId` is NOT used: it defaults blank to `x_pizza` and coerces arrays (P2-3).
     - `event` is in `{restore, build, submit, send}` (below).
     - `reasons` is an array of 1 to 8 strings, each in `{removed, renamed, repriced, unavailable, option, choice, empty}`. Duplicates collapse to unique values (P2-4: two repriced lines count as one "repriced" for that refusal).
  3. **Rate limit**, with a dedicated limiter at `form_signal_limits/{ipKey}` (never the order buckets): 30 per 10 minutes per key.
     - It returns `{allowed, failed}` like the client-version limiter. `failed` gives 503 `{dropped: true}`; that's fail-CLOSED, and the event is dropped (P1). Not allowed gives 429.
     - **The ip key:** the RIGHTMOST `X-Forwarded-For` entry, which Google's front end appends, hashed with `rateLimitKey`. Never the leftmost or `req.ip`; those are client-spoofable under trust proxy (index.js:2695).
     - **Verify before the gate closes:** on a deploy preview, a request with a forged leftmost XFF must map to the same key as one without it. If the rightmost entry turns out not to be the trustworthy hop on this platform, the plan falls back to a per-rid global cap. That's a stated residual: these are untrusted observations, never authority.
  4. **Write: ONE atomic multi-path update**, with one server-derived Honduras day `D = hnDate(now())` (lib/hn-date.js):
     - `form_signals/{D}/{rid}/{event}/_count`: increment(1). That's refusals at this point.
     - `form_signals/{D}/{rid}/{event}/{reason}`: increment(1) for each unique reason.

     No PII and no IP. No dish names or cart contents.
- **Sweep:** `sweepFormSignals` is scheduled daily. It removes day keys older than 90 days (keys sort as strings) and expired limiter windows, in bounded batches, as `sweepClientVersions` does.

## RTDB rules (`xpizza-reference/database.rules.json`)

`form_signals` and `form_signal_limits` are `.read: false, .write: false`, so they're Admin SDK only. Reads are admin-only for now, per the ruling: the advisor reads them via the CLI. Owner-facing reads, defined against brand membership, would be a later slice. Then `npm run sync:rules` plus the rules emulator test (client read and write denied on both paths).

## Client: one hook per refusal point, separate from the announcer (P2-2)

A new `sendFormSignal(event, reasons)` lives in each form, next to `PUBLICMENU_URL`.
- It's fire-and-forget: `try { if (navigator.sendBeacon) navigator.sendBeacon(FORMSIGNAL_URL, JSON.stringify({ rid: <the form's own restaurant id>, event, reasons })) } catch (_) {}`.
- It's never awaited. Its result is never read, it never touches the DOM, the cart or any order state, and it can never change a refusal.
- **Restaurant id:** each form's existing identity, `RESTAURANT_ID` in La Musa and `AVAIL_RID` in X. Pizza, the same value `liveMenuRid()` returns. No new literal.

| event | where (La Musa / X. Pizza) | reasons |
|---|---|---|
| `restore` | restoreOrderForm's launcher refusal, index.html:2376 / :2032 | from the blocked lines |
| `build` | buildOrder, :4741 / :4358 | from the blocked lines |
| `submit` | submitOrder, :5208 / :4843 | from the blocked lines |
| `send` | the final gate refuseConflictedSend, :2480 / :2137, AND its empty-cart branch, :2472 / :2129 | from the blocked lines, or `['empty']` |

- **Reasons per line:** the line's `unresolved` value, or `option` when only an option is blocked. That's the same mapping the existing `cart_conflict_blocked_submit` log uses.
- **No double count:** each call site sends exactly once per refusal. `announceCartConflicts` stays the message-only path, and its console logs stay byte-identical.

## Tests

- **Unit tests** (form-signal.test.js, fake db and clock, no emulator):
  - valid signals write exactly the expected paths in ONE update call;
  - duplicates are unique-ified;
  - each refusal writes nothing and returns 204: an unknown key, event or reason; a blank, array, unregistered or ill-formed rid; malformed JSON; text/plain with a charset (accepted); a body over 512 bytes (413);
  - a non-POST writes nothing;
  - a limiter `failed` gives 503 with zero writes, and not allowed gives 429 with zero writes;
  - the ip key is the rightmost XFF entry, and a forged leftmost entry is ignored;
  - a synthetic third rid that's present in the registry is accepted, and the same rid absent from it is refused.
- **Real export:** cors-preflight.test.js gains `formSignal`. The listed order origins, including the synthetic third, are allowed, an evil origin is denied, and the test asserts the exported options.
- **Rules (emulator):** client read and write are denied on `form_signals` and `form_signal_limits`.
- **Form jsdom tests, both forms, through the REAL refusal paths** (no hand-built calls):
  - a repriced line refused at `send` emits exactly one beacon `{rid, event: 'send', reasons: ['repriced']}`;
  - an empty-cart refusal emits `reasons: ['empty']`;
  - `build`, `submit` and `restore` each emit their event.
- **Failure injection (P2-6):** with `navigator.sendBeacon` absent, throwing, or returning `false`, these are identical to the no-beacon baseline:
  - the refusal result;
  - the message text;
  - the cart contents;
  - `orderSubmitting` / `__paySubmitting`;
  - the stash.

  Clean cash and clean card paths send normally and emit no beacon. A test-only wrapper counts beacon calls, and the count is zero on clean paths.
- **Mutation entries:** the allowlists, the rid check, fail-closed, the rightmost-XFF choice, the no-write branches, and each form's call site.

## Guard closure (P2-7)

- **New index.js bytes go in one delimited block**, `/* formsignal:begin */ … /* formsignal:end */`, holding the export, its origin constant and the sweep. Its exact inverse is `tools/formsignal-inverse.js`, proven by a new formsignal-wiring.guard.test.js, which byte-pins the block, catches a missing or extra delimiter, and survives a byte outside the block.
- **That inverse is reversed FIRST (newest first)** in every guard that rebuilds an index.js base: the 25 files and 33 call sites that today start with `unapplyPortalUiIndex(…)`. They are a1, addproduct(-b), brand-server, catalog/identity-record-guards, d12b, dlite-push, extras, h0, h1, h1c, membership, order-control, portal/portal-split (:411), portalui, release-race, s1a, s1b, s5, serial3, signup, stacked-tracker, tracker-fixes, unassign and wacancel. Each guard's sensitivity tests stay.
- **The new module** client-version-style form-signal.js: census-map dispositions as the census guard demands, egress (tests reach loopback only), endpoint census and app-suites registration.
- **The form edits:** form-source-inventory, plus the 2e pins that client-form edits re-open (timer-bounds and applicability), as their own 2e chore if the inventory says so.
- **At the exact tip:** the R3 regen, mutation-anchors, and a full `npm test` in the heavy slot.

## Out of scope
Any change to the refusal UX (that's item 5). Any dashboard. Dish-level breakdowns.
