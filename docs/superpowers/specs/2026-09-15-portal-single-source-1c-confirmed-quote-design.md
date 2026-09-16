# Portal Single-Source 1C — Charge == Confirmed Net Quote (design)

**Goal:** make it impossible to charge a customer a number they did not confirm. The amount charged (cash collected / card charged) is the server's own live recompute, and it is only ever **≤ the net total the customer confirmed on screen** — never silently more. This closes the two displayed≠charged residuals 1B documented and deferred here: the checkout-hold (whole-flow cell 12) and the reward pricing-skew.

**Base:** origin/main `179c441` (1A + 1B live).

**Hard rule (owner, 2026-09-15):** customer experience is the priority — the platform must be **seamless and the flow frictionless**. The ONLY visible friction 1C may introduce is a re-confirm on a *genuine price increase* (never silently overcharge). Everything else — token issuance, expiry, refresh, quote outage, price *drop* — must be invisible.

**Why the signed token (not the raw tripwire):** for money-safety alone a raw `expected_total_cents` tripwire suffices even for an untrusted client, because the server always reprices and only ever charges its own recompute gated by the match (a malicious client cannot force an undercharge; a customer cannot be silently overcharged). The signed token is chosen deliberately as **platform infrastructure for scale** (many merchants): non-repudiable provenance (proof the server offered X and the customer accepted X, for multi-merchant settlement/chargebacks), expiry as a contract, cart+customer binding, and an explicit quote lifecycle object. 1C's gate therefore *is* the platform's quote primitive from day one — no rip-and-replace when the aggregator lands. The raw tripwire is retained, but only as the graceful-degradation floor beneath the token (see §7).

---

## 1. The confirmed net

The number protected is the **all-in net the customer sees as "Total" and agrees to pay**, for both paths:
- **Cash** (`createOrder`): the amount recorded for the driver to collect and the factura to show.
- **Card** (`chargeOnlineOrder`): the amount put on the card via PixelPay.

Composition: `items + extras − reward_discount + delivery + fiscal`.

**Delivery forward-compat (owner):** delivery is free today (one config, +0), but will become a **server-computed 2-tier distance-from-restaurant** charge (aggregator geo work). 1C reserves a **server-computed delivery slot** in the net from day one — the quote computes it (0 today), the token binds it, the charge re-verifies it. The gate then automatically guards delivery pricing (an address/pin change → distance tier → fee → net change is caught), and the future 2-tier delivery drops in with **zero 1C rework**. The client never guesses the delivery fee; it is always server-computed and carried in the quote.

---

## 2. The signed quote token

Stateless, server-signed, expiring — chosen over a stored quote record specifically to avoid a **database write per quote** (quotes fire on every cart change; a per-quote write would regress the RTDB egress we just fixed). The server verifies by signature; no lookup.

**Signed payload:**
- `rid` — restaurant/brand.
- `customer_id` (or a guest marker) — welds per-customer reward pricing to the token.
- `cart_fingerprint` — hash of the **server-normalized** cart (items + qtys + per-item extras + reward selection). The confirmation cannot be spent on a different cart.
- `net_total_cents` + `components` `{items, extras, reward_discount, delivery, fiscal}` — the confirmed all-in and its breakdown.
- `issued_at`, `expires_at`.
- `quote_id` — unique nonce, recorded on the order for provenance.

**Signature:** HMAC-SHA256 with a server-held secret (env-managed, same pattern as `PIXELPAY_WEBHOOK_SECRET`). Only the server issues and verifies; the client treats the token as opaque and echoes it.

**Issuance:** the **existing** quote responses carry it — no new round-trip. The endpoint that computes the net (after reward + delivery) signs and returns the token alongside the displayed total. The reward-adjusted net is known where the reward is applied, so issuance happens where the full net is computed (see §3).

---

## 3. One shared `computeServerNet` (the load-bearing consolidation)

The quote-issuer, `createOrder`, and `chargeOnlineOrder` MUST compute the net through a **single function** — the token is *issued* from it and *verified* against it. If the three ever diverge, the gate throws false mismatches or misses real ones.

Today the pieces are scattered: `computeServerTotal` (base), the reward path (discount), delivery = +0. 1C consolidates them into one `computeServerNet(cart, reward, deliveryContext, rid)` returning `{net_total_cents, components}`. This is the **highest-risk edit of 1C** — it touches both live money endpoints — and gets the hardest gate. A parity test proves the three callers produce byte-identical net for the same inputs.

---

## 4. The two gate points

Both money endpoints verify at the moment they set the charge:
- **`createOrder` (cash)** — verify token → recompute net → compare → record the confirmed net (collect-amount + factura).
- **`chargeOnlineOrder` (card)** — verify token **before creating the PixelPay hosted checkout** (where the amount is set). A resumed/reused hosted attempt reuses the already-gated amount — a customer returning from PixelPay is not re-gated against a moved price.

**Client side** attaches the token at the same two send points 1B established (immediately before each `fetch`, inside the cash-retry loop and on the online path — where `refuseConflictedSend` sits). The client's `refuseConflictedSend` remains **early UX**; the **server token-gate is the authoritative money backstop** — the same layering as 1B.

**Retry/idempotency (already coherent):**
- `createOrder`'s idempotent-return hands back an already-created, already-gated order → no re-charge, no re-gate. A content-changed retry fails both 1B's fingerprint and the token's `cart_fingerprint`.
- The cash retry loop re-sends with the token each attempt; a cart/reward gone stale during a backoff → fingerprint mismatch → refuse (consistent with 1B).
- `chargeOnlineOrder` gates at hosted-checkout creation only; resume reuses the gated amount.

---

## 5. The verification decision (the humane hybrid)

At each gate, after verifying signature + expiry + `cart_fingerprint`, compare the server's fresh recompute to the token's `net_total`:
- **Equal** → charge/record the server net (== confirmed).
- **Server net LOWER** (price dropped) → charge the lower silently. A price drop needs no consent.
- **Server net HIGHER** → refuse `409 price_increased`, return the new net → client renders the explicit re-confirm.

The invariant made true by construction: the charge is the server's own recompute, and it is **only ever ≤ what the customer confirmed**.

`quote_id` + the confirmed net are recorded on the order (the provenance trail).

---

## 6. Expiry — invisible plumbing

Expiry is a safety/provenance bound, engineered to never be visibly hit:
- **Generous window** (long enough that no real active checkout reaches it; money-safety does not depend on a short window because the server reprices regardless).
- **Silent background refresh** — the client renews the token quietly before it can expire: on cart change (already, from 1B's quote flow), on entering the checkout step, and on a pre-expiry timer. A fresh token is **always** in hand at pay-tap.
- The customer never sees an "expired"/re-login/lost-cart state. If a stale token is somehow reached at pay-tap, the client silently re-quotes and, if the total is unchanged or lower, proceeds automatically; only a genuine increase surfaces the re-confirm.

**Client confirm state machine at pay-tap:**
- **Ready** (valid token for the current cart+reward) → send with it.
- **Stale** (expired / cart changed / quote not yet landed) → brief "Actualizando…", re-quote, block the send until fresh; then unchanged/lower → auto-proceed, higher → re-confirm sheet.

---

## 7. Quote outage — degrade, never fail closed

If the quote *endpoint* is unavailable (rare — same Cloud Functions infra as the charge), the flow must not fail closed and lose the sale. The client sends its displayed number as an **unsigned `expected_net_cents`**; the server does the **raw comparison + hybrid** against its own recompute. Still `charged == confirmed` (the server reprices, so no under/overcharge is possible); only the signed provenance is absent, and the confirmation is logged as degraded. Money-safe even for an untrusted client (an unsigned `expected_net` cannot force an undercharge — mismatch → 409).

Server acceptance matrix:
- **signed token** → full gate (money + provenance).
- **unsigned `expected_net`** → raw gate (money, no provenance) — the availability floor.
- **neither** → refuse (post-enforce only; pre-1C tabs, which the grace window ages out).

---

## 8. Rollout — grace → enforce (reversible, both-flag)

Server config flag `token_enforce` (RTDB config, no-redeploy toggle — the `redemption_live` pattern). Per [[redemption-flip-two-flags]], go-live needs **both** server and client ready.

1. **Deploy server** (additive): quote responses issue tokens; endpoints verify when present but **accept-but-log** no-token orders (charge server-repriced = pre-1C). Nothing breaks.
2. **Deploy both forms** (additive): issue/attach tokens + silent-refresh. New forms fully gated; old cached tabs grace-accepted + logged.
3. **Monitor** the no-token rate → ~0 as old tabs age out (bounded ~payment-stash TTL / a day), plus degraded-mode and 409-increase rates.
4. **Flip `token_enforce=true`** (instant) once no-token → ~0: signed → full gate; unsigned `expected_net` → raw floor; neither → refuse. Smoke a fresh order per brand post-flip.
5. **Rollback** = flip `token_enforce` off (instant) → grace/accept-all; token code stays (harmless). No redeploy to retreat.

Optionally canary the enforce flip one brand first.

---

## 9. Testing / gate plan

- **Invariant, both endpoints, both brands, from the real serializer** (1B charge-boundary discipline): equal → server net; lower → charge the lower; higher → `409` + new net. A tampered client total/price/**delivery**/reward can never move the charge.
- **`computeServerNet` parity:** quote-issuer, `createOrder`, `chargeOnlineOrder` produce identical net for identical inputs (guards the consolidation).
- **Token mechanics:** bad signature → reject; expired → silent-refresh (no visible wait when unchanged); `cart_fingerprint` mismatch → reject; `quote_id` + net recorded on the order (provenance asserted).
- **Degraded mode:** quote-outage → unsigned `expected_net` → raw gate holds; neither post-enforce → refuse.
- **Retry/idempotency:** idempotent-return does not re-charge/re-gate; cash-retry stale-during-backoff → refuse; hosted-attempt resume reuses the gated amount.
- **Seamless (the hard rule, as tests):** a near-expiry token silently refreshes → pay-tap has a fresh token → no visible wait; expiry never blocks; a price drop is silent; no new visible step appears in the normal path.
- **Whole-flow payoff:** the 1B matrix's **cell 12 (checkout-hold)** and the **reward-skew cell** flip from documented-residual to **asserted-closed** (they were written in 1B as 1C's regression targets).
- **Gate:** the hardest codex money-gate of the initiative (both live money endpoints + the net consolidation) + the whole-flow gate; grace→enforce verified; the seamless hard-rule verified.

---

## 10. Non-goals / out of scope

- **Publish-timing policy** (apply merchant catalog changes at a boundary / next-day / while-closed) — recorded as a *deferred idea*, not part of 1C. Complementary (would shrink the price-change wall toward zero) but not a replacement for the gate; its own product decision later, if designed at all.
- **The delivery-pricing feature** (compute the 2-tier distance fee) — 1C only *reserves the server-computed delivery slot*; computing the fee from distance is separate (aggregator geo work).
- **1D** (stable-key migration + KDS structural change + generator/offline-CI parity + server-side stable-id 86) — after 1C.
- **Asymmetric/third-party-verifiable token signatures** — HMAC is sufficient while the server is the only issuer/verifier; revisit if an external party must verify.

---

## Governance

Standing loop: advisor design → codex design-grill → relay → executor builds local-only → advisor source-audit → codex money-gate (money-adjacent, never self-approve) → owner deploys. `git ls-remote origin` to confirm the real base before any deploy; pin `--project xpizza-delivery`. See [[portal-single-source-initiative]], [[seamless-customer-ux-priority]], [[redemption-flip-two-flags]], [[verify-remote-git-state-directly]], [[codex-gate-money-adjacent]].
