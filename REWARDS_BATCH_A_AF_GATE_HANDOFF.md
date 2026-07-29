# Handoff to Advisor — Batch A · A-F (factura comp representation) MONEY-GATE

**Branch:** `feat/rewards-batch-a` · **tip:** `7489968` · **base:** `main` (`f6cfee0`) · **1 commit** · nothing merged/deployed.
**Gate type: MONEY-GATE** (factura money-math). Plan reference: `docs/rewards-batch-a-plan` @ `598a50c` (R7 · APPROVED), section **A-F**.

This is the first Batch A task. A1 (the other money-gated task) is **not built yet** — gate A-F on its own, or hold for A1 and gate together, your call.

## What A-F changes
Redeemed **X. Pizza** platform facturas now show **FULL-VALUE line items + an explicit "Desc. y Reb. Otorg" (`desc_rebaja_cents`)** for the comped base unit — instead of the old 0-price split lines. Fully-comped → **0/0/0 and still issues**. **La Musa unchanged** (`factura_items:null`, Soft Restaurant POS owns its fiscal doc).

## Representation (the money-math to scrutinize)
Menu prices are tax-inclusive; factura line PRECIO = `base_cents` (net). A-F keeps the **money spine = the DISCOUNTED (paid) breakdown** (`total/subtotal/tax` unchanged, so **`subtotal + tax === total` is preserved**) and represents the comp as:
- **`factura_items` = the full-price cart lines, UNCHANGED** — Σ`line_gross` === the FULL, pre-discount total.
- **`desc_rebaja_cents` = FULL net − PAID net** (an exact integer residual, so it foots — not `round(discount/1.15)`, which could drift a centavo).
- **build-record** reconciles the full-value bases to `fullNet = subtotal_cents + rebaja`; `gravado_15 = subtotal_cents` (paid net); emits the rebaja.
- Receipt foots by construction: **Σ item base − rebaja === gravado === subtotal**, and **subtotal + ISV === total**.

Worked example (Margherita×2+Mozzarella comped + Anchovies, full 1066 / comp 299 / paid 767): items foot to full net 926.96; DESC.Y REB 260.00; GRAVADO = SUB TOTAL 666.96; ISV 100.04; TOTAL 767.00. Fully-comped (Nutella 251): item 251 at full value, rebaja = full net, GRAVADO/ISV/TOTAL 0/0/0, issues.

## Files (6)
- `xpizza-functions/rewards-redeem-pricing.js` — `applyXPizza`: full lines + `desc_rebaja_cents`; new fail-closed invariants (`reconcile_mismatch` Σgross===full total, `discount_reconcile` full−paid===comped gross, `rebaja_invariant` ≥0, `base_invariant` bases foot to full net). Dropped the split + unused x_pizza `free_line`.
- `xpizza-functions/index.js` — stamps `desc_rebaja_cents` onto the order in BOTH write paths (createOrder via `...priceBreakdown` incl. scheduled `buildScheduledOrderRecord`; pending via `effBreakdown` + explicit spread). **Absent when not redeemed → byte-identical.**
- `xpizza-functions/factura/build-record.js` + `xpizza-factura/src/build-record.js` (runtime duplicate) — identical change: read `order.desc_rebaja_cents || 0`, reconcile to `fullNet`, emit rebaja. **rebaja 0 → fullNet===subtotal → byte-identical.**
- **Renderer: no change** (`xpizza-factura/src/renderer.js` already prints `base_cents` + `desc_rebaja_cents`).
- Tests: `rewards-redeem-pricing.test.js` (rewritten, 24 assertions, relational) + `xpizza-factura/test/build-record.test.js` (+1 redeemed case).

## Verification
- `rewards-redeem-pricing.test.js` **24/24** · `xpizza-factura` suite **91/91** · full `xpizza-functions` `npm test` **green (exit 0)** · `rewards-parity.guard` 4/4.
- Non-redeem factura **byte-identical** both producers (verified by the unchanged existing goldens).
- **RTDB emulator (intake/settle) NOT run** — the DB emulator repeatedly TIMEOUT'd on port 9000 (60s startup) this session, an environment issue, not a failure. A-F is pure factura math fully covered by the unit goldens; the intake emulator test asserts only La Musa (unaffected) + display-name sanitization. Re-runnable post-restart.

## Open judgment calls for the gate
1. **Rebaja is a single factura-level line** (net), not per-item labels — the comped item is not marked "(Recompensa)" on the line (avoids the Q>1 / extras labeling ambiguity; the reward identity lives in `order.redemption` + the rewards ledger). Flag if you'd prefer a per-line marker.
2. **`desc_rebaja` defined as the exact net residual** (FULL net − PAID net) so the receipt foots to the centavo; it can differ by ≤1 centavo from the naive net of the gross comp. Confirm that's the right definition.

Executor will action any REVISE findings. Nothing merged or deployed.
