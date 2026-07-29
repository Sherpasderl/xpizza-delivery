# Handoff to Advisor — Batch A code-gate (A4 + #6 + A2 + A3 + A5 + A6)

**Branch:** `feat/rewards-batch-a` · **tip:** `41aaf30` · **base:** `main` (`f6cfee0`) · nothing merged/deployed.
**Gate type: code-gate** (display / money-adjacent). The two MONEY-gated tasks (A-F `7489968`, A1 `7856c75`+`d0558aa`) are already **APPROVED**. This handoff covers the remaining six.

## Commits
| Task | SHA | Gate |
|---|---|---|
| A4 — items_text reward line | `b57cdb3` | code (money-adjacent) |
| #6 + A2 + A3 | `d277abe` | code (display + `paymentStatus` server summary) |
| A5 — earn badge | `65869c6` | code (display) |
| A6 — Stage-2 summary | `41aaf30` | code (display) |

## What each does
- **A4** (`rewards-redeem-intake.js`): the X. Pizza comped cheapest pizza read full-price in KDS/driver/WhatsApp. Added a `discount`-branch `\n1x <pizza> (Recompensa)` line — SAME `\n`-prefixed format La Musa ships live. **Verified every consumer splits `items_text` on `' | '` or `','`, never `\n`** (xpizza-kitchen/driver/dispatch), so it rides as annotation, never a phantom make-item. Emulator: intake 24/24 (+A4 assertion) + settle 18/18.
- **#6** (online-return persistence): `paymentStatus` (index.js) now returns a **poll-token-gated safe summary** (`total_cents` + a minimal `redemption {discount_cents, free_item, model}`) on confirmed/scheduled_paid — the customer's own order money/reward, no PII. Forms: stash the server total before the redirect (`redeem_total_cents`, fallback) + on return stamp the server-confirmed `j.total_cents`/`j.redemption` onto `currentOrder` (server wins over stale client values). Detection is now `o.redemption || o.redeem`.
- **A2** (`showSuccess`): the receipt Total = `successTotalCents(o)` — server-authoritative (`o.total_cents` online / live quote same-session cash / stash fallback / full non-redeem). X. Pizza discount shows a green "Recompensa −L…" line; La Musa (added item, total unchanged) + non-redeem unchanged.
- **A3** (cash): change chips, "Tu cambio" validation, Pago-exacto resync, AND the `cash_tendered` submit guard all route through `redeemAdjustedTotal()` (discounted) instead of `calcTotal()` (full). Server still re-validates `cash_tendered ≥ server total`.
- **A5** (`renderSuccessRewards`, account.js): redeemed X. Pizza (punch) badge drops one pizza (`max(0, pizzaCount-1)`) — mirrors the server's `earnDelta = max(0, delta-1)` (rewards-earn.js). La Musa (points) unchanged.
- **A6** (`renderStage2Summary`, index.html + `getRedeemQuote` in account.js): dedicated Stage-2 "Resumen del pedido" — items + Envío + a struck reward GRATIS line + the server discounted total. Reuses `.review-item`; sources reward+total from the server quote. **Cart pillbox / `updateCartReviewBody` left untouched.**

## Invariants held
- **Server-authoritative money everywhere** — every displayed discount/total comes from the server quote (live `getRedeemQuoteTotalCents` / `getRedeemQuote`) or the persisted server total (`o.total_cents`), never a client-computed discount.
- **`account.js` byte-identical past CONFIG** (235962 chars) — A5 + `getRedeemQuote` mirrored.
- **`//__REWARDS_PARITY__` block byte-identical** (4023 chars) — `successTotalCents` + the A6 quote wiring live there.
- **Guest / non-redeem byte-identical** — every new path is `redeemed`-gated; `:empty{display:none}` hides the A6 summary when empty.
- Forms edits **mirrored across both brands** (verified by diff); inline JS syntax-valid both forms.

## Verification
- `rewards-parity.guard` 4/4 after every commit.
- Emulator (A4): `rewards-redeem-intake` 24/24, `rewards-redeem-settle` 18/18.
- Inline JS of both `index.html` parses clean; both `account.js` `node --check` clean.
- **Not on-device-verifiable until the re-canary** (login + redemption live; drafts can't log in per ACCOUNT_ORIGINS CORS, and `redemption_enabled` is OFF). Server is the money backstop throughout.

## Open judgment calls
1. **`paymentStatus` summary has no dedicated handler unit test** (it's an HTTP `onRequest`); the change is additive fields, verified at this gate + the re-canary online-return. Flag if you want an emulator test added.
2. **A6 reward line shows `<s>name</s> · Recompensa … GRATIS`** for both models (X. Pizza comped pizza also appears in the item rows at full price; the GRATIS line + discounted total explain the gap). Confirm the double-listing reads acceptably, or I'll switch X. Pizza to a "−L…" discount line instead.

## Re-canary note (not a defect)
Per the A-F gate: the factura shows the comped item + rebaja at **net/base** figures (~L260 for a comped L299), ISV totaled at the bottom — intended, matches every existing line.

Executor will action any REVISE findings. Nothing merged or deployed.
