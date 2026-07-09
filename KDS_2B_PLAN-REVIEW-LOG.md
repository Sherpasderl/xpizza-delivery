# Plan Review Log: KDS Phase 2b — Item Availability
Started 2026-07-08 (session). MAX_ROUNDS=3. Codex thread `019f44c1`.

## Round 1 — Codex (VERDICT: REVISE)
1. **Pay-after-86 via hosted checkout URL** — customer gets a PixelPay hosted URL, item 86'd, customer pays the live URL → materialize proceeds (no recheck). The online *commitment point* is URL creation, not the charge.
2. **Manifest drift** — "can't drift" is false: owner-run publish derived from forms, not tied to server pricing (the gate keys). Forms/pricing could diverge → KDS toggles a key the server never checks.
3. **x_pizza key encoding collision** — strip/replace forbidden chars can collide (`A/B` vs `AB`). Use a reversible encoding shared across 3 surfaces + fixtures.
4. **RTDB rules have no per-restaurant kitchen auth** — flat `/kitchen/{uid}`; any kitchen user could write either restaurant's availability.
5. **§4 broadens the KDS write surface** — contract says "writes ONLY /orders/{id}/status"; adding availability writes silently widens it. Needs an explicit carve-out.
6. **Online gate too vague for chargeOnlineOrder branches** (fresh/reuse/rotate) — a reuse could return a payable URL for a now-86'd cart without re-gating.
7. **Form qty controls when 86'd mid-cart** — disabling add-to-cart doesn't stop increments on an item already at qty>0.

### Claude's response
Accepted all 7 — revised the plan. Key dispositions: (1)+(6) gate at hosted-URL creation on ALL payable-URL branches; **accept** the narrow post-issue race (kitchen backstop) rather than build late-payment voids — consistent with the intake-only decision and appropriate pre-launch. (2) manifest keys golden-checked against `MENU_BY_RESTAURANT` (the gate keys) — build fails if stale. (3) reversible percent-encoding via one shared `availKey()` helper, fixture-tested KDS/form/server. (4) rules bind availability writes to per-restaurant kitchen membership (`/restaurants/{rid}/kitchen_staff/{uid}`); flagged the auth-model dependency. (5) explicit contract carve-out: KDS writes `/orders/{id}/status` + exactly `/restaurants/{rid}/item_availability/{key}`; write-spy updated. (7) freeze qty increments for 86'd keys + graceful submit-rejection; existing cart preserved.

## Round 2 — Codex (VERDICT: REVISE) — read the actual PixelPay + form code
1. Gate placement can strand a pending order: availability check after `acquireHostedAttempt` writes `orders/{id}`+`payment_attempts/{id}` as `creating`, then a retry hits fingerprint/conflict. → gate BEFORE any CAS/write.
2. Reuse guarantee overclaims: a URL issued while available stays payable until TTL regardless of refusing to redisplay it. → state the real guarantee.
3. Percent-encoding not reversible unless `%` escaped (`A/B` vs `A%2FB` collide). → `encodeURIComponent`+escape `.`.
4. Public read of `item_availability` leaks `updated_by` (staff UID/email). → public node `{available, updated_at}`; audit to a private path.
5. "Surfaces rejection clearly" underspecified — current forms show generic "Revisá los datos" 4xx. → structured `{error:'item_unavailable',blocked}` + explicit both-form handling.

### Claude's response
Accepted all 5. (1) online gate runs FIRST, before `acquireHostedAttempt` CAS / any `orders`/`payment_attempts` write → a blocked fresh attempt writes NOTHING; golden asserts it. (2) honest guarantee: no FRESH URL for a blocked cart; already-issued URLs stay payable until TTL (accepted race). (3) `availKey = encodeURIComponent(raw).replace(/\./g,'%2E')`, reverse decodeURIComponent — escapes `.`/`%`/all forbidden; collision+round-trip fixtures. (4) public node `{available,updated_at}` only; `updated_by` → private `availability_audit/{key}` (staff-read); a golden asserts the public node has no `updated_by`. (5) structured `{error:'item_unavailable',blocked}` + explicit handling in both cash + online form paths.

## Round 3 — Codex (VERDICT: APPROVED)
"No material blockers remain. The plan preserves the payload/pricing contract, gates fresh online attempts before any hosted-payment state write, honestly accepts the already-issued-URL race, keeps paid/scheduled orders from being re-rejected, fixes key collisions, removes public staff-identity leakage, and requires structured unavailable-item handling in both forms."
Two non-blocking implementation nits folded in: cash idempotent retries run ahead of the availability gate; the "no writes on blocked fresh online attempt" emulator assertion is STRICT (zero writes to orders + payment_attempts).

Round-3 APPROVED on the plan text. Xavier asked for another round → a code-grounded red-team.

## Round 4 — Codex code-grounded red-team (VERDICT: REVISE) — traced the real functions
1. **Terminal-state bypass:** `acquireHostedAttempt` classifies `already_paid`/`closed`/`reuse`/`conflict`. "Gate first" would re-reject an already-PAID order as item_unavailable → violates "never reject paid" + regresses the form's "Already paid" success path. → read-only classify first; terminal paid/closed bypass availability.
2. **Rate-limit quota burn:** `checkRateLimit` increments `/rate_limits` before the order write; a blocked 86 attempt burns the phone/IP quota → 429s a legit retry after the customer removes the item. → availability before the rate-limit increment; assert no `rate_limits` write on a blocked attempt.
3. **Auth migration mandatory:** auth is flat `/kitchen/{uid}` today; the per-rid rule without seeding `kitchen_staff` denies real staff the toggle. → required, sequenced seed→verify→tighten migration for both restaurants.
**Verified sound by tracing:** validateOrderPayload has exactly 2 callers; materializeOnConfirm skips scheduled/releasing; scheduled-release materializes without recheck; both forms' 4xx handling is generic today (need the structured item_unavailable).

### Claude's response
Accepted all 3. (1) online: read-only classifier first, terminal paid/closed bypass availability, only fresh/rotate/URL-issue branches gated before any write. (2) availability before `checkRateLimit`'s increment; strict test = no orders/payment_attempts/rate_limits on a blocked attempt. (3) per-rid `kitchen_staff` seed→verify→tighten made a required sequenced step, not an open dependency.

## Round 5 — Codex (VERDICT: APPROVED, code-grounded)
Re-verified the 3 red-team fixes against real code (chargeOnlineOrder/acquireHostedAttempt classifier-before-availability; availability-before-checkRateLimit in both intake fns with zero-write tests; mandatory sequenced kitchen_staff migration matching flat /kitchen reality). Also re-checked validateOrderPayload + both callers, materializeOnConfirm, confirmAndMaterialize, scheduled release, RTDB rules shape, both form submit/error paths. Structured item_unavailable handling is additive + covers today's generic 4xx. "No remaining material money-path or existing-behavior blocker found."

**OUTCOME: APPROVED after 5 rounds (15 findings total, all incorporated), final approval code-grounded. Implementation-ready.**
