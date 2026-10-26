# Plan 3: `formSignal`, a server-visible count of order-form cart blocks

**Status:** PLAN r1, awaiting the advisor gate. Its own Codex gate (a public endpoint) and a functions deploy plus a forms deploy.
**Goal:** measure how often customers are blocked at checkout by a cart conflict, per restaurant, per reason, per day. Today that is unmeasurable: the block only logs to the browser console. In both forms the two calls are `console.warn('cart_conflict_blocked_send', …)` and `console.warn('cart_conflict_blocked_submit', …)`, at la-musa-orders/index.html:2478 and :2486, and xpizza-orders/index.html:2135 and :2146.

## Why not reuse something
- **Not the order body.** The escape-hatch telemetry tried that. The fields persisted nowhere (create-order-build.js writes only known fields) and, because they were unclassified, they nulled PB-1's `chargeInputsFingerprint`. Both forms had to drop them. On top of that, this block fires before any order is sent, so there is no body to ride on.
- **No client-event sink exists.** No endpoint in index.js accepts client events, and no form uses `sendBeacon`.

## Design (brand-agnostic, counts only)
- **Endpoint:** `exports.formSignal = onRequest({ region: 'us-central1', cors: <order-site origins>, timeoutSeconds: 10, memory: '128MiB', maxInstances: 5 }, …)`.
  - The order-site origins are derived from `platform-manifest` exactly as `PUBLIC_MENU_ORIGINS` is. It gets its own derived constant, per the "its own origin list" rule at index.js:7003.
  - It accepts only `POST` with `text/plain`, which is what `navigator.sendBeacon(url, string)` sends. That is a simple request: no preflight and no custom headers.
- **Body:** `{ rid, event, reasons: [..] }`.
  - `event` is in the allowlist `{cart_conflict_blocked_send, cart_conflict_blocked_submit}`.
  - Each reason is in the allowlist `{removed, renamed, repriced, unavailable, option, choice, empty}`.
  - `rid` must pass the existing `resolveRestaurantId` (registry: code floor plus Firestore).
  - Anything else gets `204` and no write. It never echoes input and never errors loudly to a client.
- **Write:** an RTDB `form_signals/{rid}/{event}/{reason}/{YYYY-MM-DD}` per reason, as `ServerValue.increment(1)`, with the date in Honduras time via the existing `lib/hn-date.js`.
  - No PII, no cart contents, no dish names (a dish-level breakdown can come later if the owner wants it), no IP stored.
  - Rate limit: `checkRateLimit(db, 'form_signal', ip, …)` (index.js:697, fail-open). A counter that fails open loses at most a few counts.
- **RTDB rules** (`xpizza-reference/database.rules.json`): `form_signals` is `.read`: admin/owner only and `.write: false`, so only the Admin SDK writes it.
  - Run `npm run sync:rules` plus the rules emulator test.
  - Owner-readable counts for a later dashboard tile, which would be its own slice.
- **Client (both forms, shared code where possible):** `announceCartConflicts` calls `sendFormSignal(event, reasons)`.
  - The send is fire-and-forget `navigator.sendBeacon(FORMSIGNAL_URL, JSON.stringify(...))`, wrapped in try/catch, and never awaited, so it can never delay or alter the block UX.
  - `FORMSIGNAL_URL` sits next to `PUBLICMENU_URL`.
  - Neither form's netlify.toml declares a CSP `connect-src` (checked on 6fcd7ff2), so no header change is needed. If a CSP is added later, it must list the functions origin.

## Tests and guards
- **Unit test (no emulator):** the handler with a fake db proves:
  - allowlisted events and reasons increment the right paths;
  - an unknown event, reason or rid writes nothing and returns 204;
  - a non-POST or oversized body writes nothing;
  - the rate limit is consulted.
- **Emulator rules test:** client reads and writes on `form_signals` are denied.
- **Form tests:** a jsdom test drives a real repriced block in each form and asserts exactly one beacon with the right event and reasons, using the real `announceCartConflicts` path rather than a hand-built call ([[test-must-originate-from-real-writer]]).
- **Mutation entries** for the allowlist, the rid check and the no-write-on-invalid branch.
- **Census and guards:** endpoint census, egress (tests reach loopback only), census-map exemptions as needed, the R3 regen, and form-source-inventory for the form edits (client-form edits re-open the 2e pins: timer-bounds and applicability).

## Out of scope
Any change to the block UX (that's item 5). Any dashboard (a later slice).
