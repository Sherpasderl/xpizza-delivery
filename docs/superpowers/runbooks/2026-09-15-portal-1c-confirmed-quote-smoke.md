# Runbook — Portal 1C confirmed quote: grace → enforce

**Status:** not deployed. Every step below is the owner's; the executor pushes nothing.

## What 1C changes, in one line

The server refuses to charge more than the number it showed. It already never took a price *from* the
client (1B); 1C adds the other half — the charge is the server's own recompute, and a figure above what
the customer confirmed is refused instead of charged.

## The two flags, and why the order matters

| flag | where | effect |
|---|---|---|
| `QUOTE_TOKEN_SECRET` | functions env | absent ⇒ every quote issues **token-less**. Not an error — the client falls to the unsigned ceiling or to grace. |
| `config/token_enforce` | RTDB, top-level | absent/false ⇒ **grace**: an order carrying no proof at all behaves exactly as it does today. `true` ⇒ an order carrying **neither** proof is refused. |

**What enforce actually refuses, precisely.** It is not "orders without a token". An order may state
what it showed in two ways, and either is answerable under enforcement:

- a **signed token** — the server verifies it, checks the cart fingerprint, and charges its own
  recompute up to that ceiling;
- an **unsigned `expected_net_cents`** — no proof of issuance, but still a stated ceiling; the server
  charges its own recompute up to it. An unsigned ceiling equal to the server's net is accepted under
  enforcement, not refused.

Enforce refuses only an order that states **neither** — nothing to compare the charge against. An
**expired** token is not a refusal on its own either: expiry is ordinary (a customer left checkout
open, a clock is off), so the order falls back to its stated ceiling exactly as a token-less one does.
A **forged** signature is different and refuses in both modes; that is the one signal of tampering.

`token_enforce` fails safe to **grace** on any read error, so a config outage degrades to pre-1C
behaviour rather than refusing orders in both restaurants.

## Sequence

1. **Provision `QUOTE_TOKEN_SECRET`** in the functions environment.
   Without it the deploy is still safe — it simply issues nothing to verify, and every order takes the
   unsigned floor. Do this first so step 2 starts producing signed quotes immediately.

2. **Deploy functions** — `--project xpizza-delivery` pinned explicitly (the ambient gcloud default
   drifts; a deploy to the wrong project is the failure this pin exists for).
   `token_enforce` is unset at this point, so the server is byte-identical to today for any client that
   sends no token.

3. **Deploy both Netlify forms**, each with an explicit `--site`. Two sites, two deploys — a single
   deploy silently updates one brand and leaves the other on the old bundle.

4. **Watch, do not flip.** The functions log emits `quote_gate_confirmed` per accepted order with
   `confirmation: signed | unsigned | none`, and `quote_gate_price_increased` on a refusal.
   - `none` is the number that must fall to ~0. It counts orders arriving with **neither** proof —
     clients that have not picked up step 3, in-flight checkouts from before it, and (until this ships)
     any order whose token had expired with no ceiling behind it. These are exactly the orders
     enforcement would refuse, which is why the flip waits on this number and not on a date.
   - `unsigned` settling above ~0 means quotes are issuing token-less: check `QUOTE_TOKEN_SECRET`.
   - `price_increased` is expected to be rare and is not a fault: it is a customer being asked to
     confirm a genuine increase. A sustained rate means the catalog is moving during checkouts.

   Give it at least one full business cycle per brand — weekend pricing differs, and x_pizza's 18"
   weekend gate means a whole class of order only appears then.

5. **Flip `config/token_enforce = true`** (owner, RTDB). Both flags must be live first: server (steps
   1-2) *and* client (step 3). Flipping before the client ships refuses real orders.
   Then **smoke one fresh order per brand**:
   - put a real item in the cart, reach checkout, confirm the total on screen;
   - complete a **cash** order and a **card** order;
   - check the amount charged equals the amount shown, on the order record and on the PixelPay side;
   - for card, confirm the checkout page opens at that same amount.

6. **Rollback** is the flag, not a redeploy: set `config/token_enforce` back to `false`. Instant, and
   no function or form redeploy is needed.

   Be precise about what it restores: it makes a **neither-proof** order eligible to charge again, as
   it does today. It does **not** disable the gates. A signed token is still verified, a stated ceiling
   is still honoured, and a charge above either is still refused in grace — that is the whole point of
   deploying in grace first. Rollback widens what is accepted; it does not switch off the protection.

## The money check

One number, checked in three places for the same order: **what the screen said**, **what
`orders/<id>/total_cents` stores**, and **what PixelPay charged**. The order record also carries
`orders/<id>/quote` with `confirmed_net_cents`, `charged_net_cents`, and `confirmation`
(`signed`/`unsigned`) — the ceiling the customer accepted, the amount actually charged, and which kind
of proof backed it. On a price drop those two numbers legitimately differ: charged is lower. Charged
**above** confirmed is the thing that must never appear.

## Cautions carried from earlier phases

- **Verify remote state directly** before and after: `git ls-remote origin refs/heads/main`. What a
  local branch believes about the remote has been wrong before.
- **Pin the project on every prod op**: `--project xpizza-delivery`.
- **Netlify: one deploy per site, `--site` explicit.** Both forms changed in 1C.
- The emulator test runs locally and must be GREEN before the functions deploy:
  `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:public-menu`.

## What is NOT covered here

Delivery pricing. When it lands, the recorded `priceBreakdown` must gain the delivery component
alongside `computeServerNet`, or the approved==recorded guard will refuse every delivery order. This is
documented, not fixed.
