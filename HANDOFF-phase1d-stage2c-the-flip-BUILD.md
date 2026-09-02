# BUILD RELAY — Phase 1d Stage 2c: THE FLIP — catalog becomes authoritative, code net retires

**To:** executor session · **From:** advisor. **Program:** Sherpa platform 1d (spec `2026-08-31-phase1d-...-design.md`, R4-SOUND). This is the **irreversible money-critical cutover**: the resolver serves the catalog UNCONDITIONALLY (drop `tablesEqual`), the fallback becomes the 2b `snapshotFor` ladder (not the code tables), and — the careful part — the order paths must **REJECT CLEANLY** when the ladder fail-closes, because **there is no longer a code net to proceed on**. All the scaffolding (1a value guard, 1b snapshot+mirror, 2b-pre seq, 2b ladder warming in prod, 2a displayed==charged) is LIVE. This is the last step before the portal.

## 🔴🔴 Type: MONEY-CRITICAL + FISCAL-adjacent + IRREVERSIBLE. Heaviest codex money+fiscal grill. On a FROZEN menu. Owner deploys. **Deploy-gated (do NOT deploy until):** (a) the la_musa `pricing_catalog_hit` heartbeat is observed live, (b) deployed RTDB rules == reference (`/catalog_snapshot` server-only), (c) records-landing proof (below). Build LOCAL-ONLY.

## Base
Fresh worktree off the latest `origin/main` (2a landed @ d14c013 + any deploys). Branch `feat/phase1d-stage2c-the-flip`. Build LOCAL-ONLY; do NOT push/deploy — the owner deploys after the preconditions clear.

## The four changes

### 1. Resolver: serve the catalog unconditionally + fall to the ladder (pricing-tables.js `getPricingTables`)
Today: read catalog + `codeFor`; success+`tablesEqual` → serve catalog; else → `codeResult` (code). Flip to:
- Read catalog (bounded, unchanged deadline). **On success → serve it (+ heartbeat + `recordGood`). NO `tablesEqual` gate** — the catalog is authoritative; divergence from the snapshot is EXPECTED after a portal edit and must NOT suppress the edit. **Remove the `tablesEqual` branch + the `catalog_parity_mismatch` alarm + `codeFor`/`codeResult` entirely.**
- **On catalog read-failure/timeout → `return await ladder.snapshotFor(rid)`** (the 2b ladder: in-mem last-good → RTDB mirror version-checked/K → fail-closed THROW). Keep the distinct `catalog_read_failed`/`catalog_read_timeout` alarm. `snapshotFor` CAN throw (`snapshot_fallback_unavailable`) — let it propagate.
- `recordActive`/`recordGood` hooks stay (the ladder must keep warming). `requireTables`/PIN B (restaurant-tagged) unchanged.

### 2. Fail-closed wiring: `resolvePricingTables` returns null on a genuine failure (index.js:326) — RETIRE the code-shaped catch
Today the catch returns `{ menu: MENU_BY_RESTAURANT[rid], ... }` so a failure PROCEEDS on code. Post-flip there is no code net: a resolver/ladder failure must become an **order reject**, not a code-serve. Change the catch to fire `pricing_resolver_failed` and **return `null`** (or a sentinel `{restaurantId, menu:null, extras:null}` — pick one and make requireTables/validateOrderPayload treat it as fail-closed). 🔒 **CRITICAL (the 317-323 comment's warning):** a null here WAS a latent order-DROP — the cash path throws inside `computeIncomingFingerprint` BEFORE its own try, escaping the handler (unhandled → 500/crash, not a clean reject), and redemption's `requireTables` throws. **So this change is INSEPARABLE from #3.**

### 3. The order paths must REJECT CLEANLY on fail-closed (the money-critical audit — DESIGN-GRILLED)
There are **exactly 4** direct `resolvePricingTables` call sites: createOrder:564, chargeOnlineOrder:1040, quoteOrder:5622, quoteRedemption:5661. The guard must be the **FIRST statement after each resolver call** — placed IMMEDIATELY, before the result reaches ANY other consumer. Critical because `validateOrderPayload` → `computeServerTotal(null)` **silently falls back to the RETIRED code tables** (menu-pricing.js:127-128); a late guard lets non-redemption orders price on code that is no longer the source of truth.
- **createOrder (index.js:564):** `if (!pricingTables) return <typed 503>` as the FIRST line after the resolver — before `validateOrderPayload` and before `computeIncomingFingerprint`. 🔒 The top guard is what makes the pre-try throw-seams safe: guarding `computeIncomingFingerprint` ALONE is INSUFFICIENT (grill) — `resolveRedemptionForOrder` (rewards-redeem-intake.js:91) AND `prepareRedemption` (rewards-redeem-intake.js:47) also call `requireTables` before their try and would escape the handler. One guard at the top rejects before any of them run; do NOT guard each seam.
- **chargeOnlineOrder (index.js:1040):** the null-check sits IMMEDIATELY after :1040, before :1041 — ahead of pending-order assembly, availability reads, rate-limit writes, reward reserve, `acquireHostedAttempt` (:1275/:1402) and `createHostedCharge` (:1488). Placed there, NO money moves and NO pending is stranded; a late guard could reach PixelPay on retired code prices.
- **quoteOrder / quoteRedemption:** null → the existing fail-soft `ok:false` (confirm quoteRedemption fail-softs on null, not throws).
- **The typed reject (both intake handlers):** `res.status(503).json({ error: 'pricing_unavailable', retryable: true })` — a DISTINCT retryable response (not a generic 400/500); the client copy (#4) tells checkout to RETRY, never edit-cart or proceed on the stale client total.
- **FISCAL barrier:** `pricedLineItems`/factura is reached from createOrder:820 + chargeOnlineOrder:1261, and fiscal's `resolvePriceTables(null)` falls back to CODE (menu-pricing.js:128) — so the ONLY thing preventing a code-priced factura is the upstream reject. The top guard IS that barrier; ADD A TEST proving no factura path is reachable after a null/fail-closed.
- State in the handback, PER call site: exact guard placement + money-moved=none + no-factura-after-null.

### 3b. Replace the lost `catalog_parity_mismatch` signal with a serve-path TRIPWIRE (grill HOLE #5)
Dropping `tablesEqual` also drops `catalog_parity_mismatch` (pricing-tables.js:127), which today catches a **wrong-but-VALID** price/key divergence (the 1a value-guard only catches zero/neg/non-integer). Post-flip a valid-but-wrong catalog serves SILENTLY as authoritative. Add a **sampled serve-path tripwire**: on a catalog serve, throttled per-restaurant like the heartbeat, log a fingerprint — served active `version` + menu-hash + key-count (`catalog_serve_fingerprint`) — so an UNEXPECTED active version / menu-hash during the FREEZE window is visible + alertable. NOT a gate (catalog is authoritative) — just the observability the parity alarm gave.

### 4. Retire `codeFor` from the resolver + fold the two carried items
- Remove the `codeFor` arg from the `createPricingResolver` call (index.js:302). `MENU_BY_RESTAURANT`/`EXTRAS_BY_RESTAURANT` stay in `menu-pricing.js` for now as `computeServerTotal`'s deep `tables==null` last-resort (menu-pricing.js:128) — which is now DEAD behind `requireTables` (a null seam rejects first). **Do NOT delete the code tables in 2c** (minimize the irreversible diff); a follow-up cleanup removes them once the flip is proven.
- **Records-landing proof (2b carry-forward):** the ladder must be provably WARM in prod before the flip is load-bearing. Add a check that records actually LAND (not just that the ladder is injected): e.g. a sampled `pricing_ladder_warm` log/heartbeat when `recordGood` populates `lastGood`, so prod can confirm the ladder has real state; OR make the recorder `catch` LOUDER (log on failure) so a silently-unfed ladder is visible. The owner verifies this heartbeat before deploying #1-3.
- **Deferred pixelpay-amount card fix (from 2a):** in `applyRedeemQuoteToTotals` (both forms, non-redeem branch, ~:1863) prefer the server order-quote over `calcTotal()` so the CARD in-form amount matches the server total post-flip (consistent with the summary + cash tender + the PixelPay page). Byte-identical in both forms (parity block).
- **Typed pricing-unavailable client copy (grill HOLE #8):** both forms already special-case availability/weekend/redemption/conflict/free-order-stale/rate-limit errors then fall back to generic copy. Add a distinct handler for the new `503 { error:'pricing_unavailable', retryable:true }` — a clear "el precio no está disponible ahora mismo, reintentá" that prompts a RETRY of the same cart, NOT an edit or proceeding on the stale client total. Byte-identical in both forms (parity block).

## 🔒 Guards / invariants
- **FROZEN MENU during the flip** — no catalog edit until the flip is proven; the catalog == the snapshot == code at flip time (parity still holds), so the flip is behavior-identical on current data and only CHANGES behavior once a portal edit later diverges the catalog.
- **Never a wrong/zero/uncertain charge:** catalog-served (authoritative, 1a-value-guarded) OR ladder (vouched/bounded/value-guarded) OR **fail-closed reject**. No path charges a price the system can't vouch for.
- **Displayed==charged holds** (2a): the customer sees the server total (catalog) before pay.
- **Fiscal:** the factura values whatever the order was charged (catalog-authoritative); a fail-closed order never reaches the factura (rejected upstream).
- **INERT on the frozen menu** at flip time (catalog==snapshot==code): prove order/factura pricing byte-identical the instant after the flip.

## Tests
- **Flip behavior:** catalog success → served WITHOUT `tablesEqual` (a deliberately-divergent catalog is now SERVED, not code-fallback — the opposite of today's parity test; assert the served price == the catalog, + heartbeat).
- **Fail-closed → clean TYPED reject at all 4 sites:** catalog read-fails AND the ladder fail-closes → createOrder and chargeOnlineOrder each return `503 pricing_unavailable retryable`, NO order written, NO money moved, NO crash. Assert the guard rejects BEFORE `computeIncomingFingerprint` / `resolveRedemptionForOrder` / `prepareRedemption` (none throw out of the handler) AND before chargeOnlineOrder's pending/hold/`acquireHostedAttempt`/`createHostedCharge`. quoteOrder/quoteRedemption fail-soft `ok:false`. (Emulator + unit.)
- **No factura after null (grill #4):** a fail-closed order NEVER reaches `pricedLineItems`/the factura path — assert the reject is upstream of createOrder:820 + chargeOnlineOrder:1261, so no code-priced factura can be generated.
- **Serve-path tripwire:** a catalog serve emits the sampled `catalog_serve_fingerprint` (version + menu-hash + key-count), throttled per-restaurant.
- **Ladder-served path:** catalog fails, ladder serves (in-mem or mirror) → the order prices on the ladder's tables (value-guarded).
- **INERT-at-flip:** on catalog==snapshot==code, order + factura + redemption price byte-identical before/after the flip.
- **Records-landing:** a happy serve populates `lastGood` AND emits the warm signal.
- **pixelpay-amount:** the card in-form amount now tracks the server quote; parity guard green.
- Full `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test` green; new tests wired.

## Gate & deploy
- LOCAL-ONLY → advisor source-audit + **heaviest codex money+FISCAL gate** (the flip serves catalog unconditionally; fail-closed → clean reject on EVERY consumer with no crash/drop/wrong-charge/stranded-pending; `computeIncomingFingerprint` guarded; INERT at flip; records-landing; fiscal never sees null; pixelpay parity).
- **Deploy (owner) ONLY AFTER the 4 preconditions** (grill-confirmed): (a) la_musa `pricing_catalog_hit` heartbeat observed live; (b) deployed RTDB rules == reference (`/catalog_snapshot` server-only); (c) records-landing warm signal seen in prod (the ladder is actually being fed); (d) **the RTDB mirror backfill is PRESENT + fresh for BOTH brands** (`/catalog_snapshot/{rid}` with valid `seq` — the grill's ladder-at-flip note: a cold post-deploy instance during a Firestore outage falls to the mirror; if it's absent it fail-closes, which is stricter than the old code net — acceptable, but the mirror MUST be verified present first). Full `--only functions` (expect the 429 quota → targeted re-run for stragglers, or deploy the money subset) + git-CD both forms. Prove-in-prod on the FROZEN menu: real cash + card orders price identically, factura correct, a `pricing_catalog_hit` for BOTH brands. THEN (separately, later) a controlled portal-style edit to ONE price proves the catalog is authoritative (the edit takes effect without a bundle redeploy) — the whole point of 1d.

## Handback DoD
Branch@SHA; the `getPricingTables` flip diff (tablesEqual+codeFor removed, snapshotFor wired); the `resolvePricingTables` fail-closed change; the PER-CONSUMER clean-reject audit (createOrder/chargeOnlineOrder/computeIncomingFingerprint/fiscal — money-moved=none each); the records-landing signal; the pixelpay-amount parity diff; the flip-behavior + fail-closed-reject + INERT-at-flip + ladder-served tests with output; full suite green.

## Context
After 2c proves in prod, the catalog is AUTHORITATIVE — a portal edit takes effect. Follow-ups (separate, non-blocking): delete the now-dead code tables; broaden the exec-test top-level-throw assertion (1c-b3 note). Then the PORTAL UI build begins (the owner's goal), on the versioned-publish + authoritative-catalog foundation this arc built.

---
*Relay artifact (advisor→executor). Stage 2c — THE FLIP. Irreversible, money+fiscal-critical, frozen menu, deploy-gated on the heartbeat + rules + records-landing. The last plumbing before the portal.*
