# HANDOFF → order-form executor — Cash/online payment widgets stale on cart edit

**Branch:** `fix/cash-total-sync` (off live `main` `fd99e1b`). Check out fresh. **Both** `xpizza-orders/index.html` + `la-musa-orders/index.html` (same structural edit, different line anchors below).

**Owner-reported bug (reproduced + root-caused from source):** In Paso 2 (Entrega y Pago), after selecting **Efectivo al entregar**, if you then edit the cart (open the cart pill → a menu item → add extras), the cart total updates but the **"Pago exacto" chip + the cash box** keep the OLD total — tapping "Pago exacto" fills the stale amount. Toggling to **Pagar en línea** and back to **Efectivo** refreshes it. The online **PixelPay amount** has the identical staleness (set only when the method is selected).

## Root cause (verified — do not re-derive)
- `renderChangeChips()` reads `calcTotal()` and builds the chips (including **"Pago exacto" = current total** as each chip's `data-amt`). It is called **only** from `selectPay('cash')`.
- The PixelPay amount (`#pixelpay-amount`) is set **only** in `selectPay('online')`.
- Every cart mutation funnels through **`updateTotal()`** (called by `chg()` and by the extras-commit path `renderMenu(); updateCart(); updateTotal();`). `updateTotal()` refreshes only the total display + cart — it **never re-syncs the payment widgets**. So they go stale after any cart edit made *after* a method was chosen. Re-selecting the method re-runs `selectPay` → refreshes (the owner's workaround).

## Money-safety (why this is a DISPLAY bug, not a money bug — keep it that way)
At submit: `if(selectedPayment==='cash'){ const ct=parseFloat(...cash-tendered...); if(isFinite(ct) && ct>=total) currentOrder.cash_tendered = ct; }`. A stale-low "exact" (`ct < new total`) FAILS the `ct>=total` guard → server falls back to exact/no-change. The order total is server-authoritative (`computeServerTotal`). **DO NOT touch `processPayment` / the `cash_tendered` submit guard / any pricing.** This fix is front-end display-sync ONLY.

## The fix (both forms)

### Edit 1 — add an "exact mode" flag next to `selectedPayment`
Where `selectedPayment` is declared — **xpizza `:1585`** (`let selectedPayment=null, currentOrder=null;`), **la_musa `:2005`** — add a module-level flag:
```js
let cashExactMode=false;   // true while the cash "pay-with" equals the exact total (Pago exacto)
```

### Edit 2 — maintain the flag in `onCashTenderedInput()`
`onCashTenderedInput()` — **xpizza `:2246`**, **la_musa `:3146`**. It already computes `const total=calcTotal();` and `const v=parseFloat(...cash-tendered...value)`. Right after those two lines (BEFORE the `if(!isFinite(v)||v<=0)` early return), add:
```js
cashExactMode = isFinite(v) && v>0 && Math.abs(v-total) < 0.005;   // on "Pago exacto" → follow future total changes
```
(Invalid/empty input → `false`, which is correct.)

### Edit 3 — re-sync the payment widgets in `updateTotal()` (the single funnel)
`updateTotal()` — **xpizza `:1730`**, **la_musa `:2222`**. Currently a one-liner:
```js
function updateTotal(){ const el=document.getElementById('total-display'); if(el) el.textContent='L '+calcTotal().toFixed(2); updateCart(); }
```
Replace with:
```js
function updateTotal(){
  const el=document.getElementById('total-display'); if(el) el.textContent='L '+calcTotal().toFixed(2);
  updateCart();
  // Payment widgets are captured on selectPay(); re-sync them to the LIVE cart total after any edit,
  // otherwise "Pago exacto" / the cash box / the PixelPay amount go stale (owner-reported).
  if(selectedPayment==='cash' && document.getElementById('cash-change-panel') && document.getElementById('cash-change-panel').style.display!=='none'){
    renderChangeChips();                              // Pago exacto + round-ups now reflect the new total
    if(cashExactMode) setCashTendered(calcTotal());   // they were on Pago exacto → box follows the new total
    else onCashTenderedInput();                       // custom amount → just re-validate + re-highlight vs new total
  } else if(selectedPayment==='online'){
    const pa=document.getElementById('pixelpay-amount'); if(pa) pa.textContent='L '+calcTotal().toFixed(2);
  }
}
```
Notes:
- Order matters: `renderChangeChips()` rebuilds the chip row (which clears `.active`); the following `setCashTendered()`/`onCashTenderedInput()` re-applies the highlight + the "Tu cambio" hint. Keep that order.
- At page init `updateTotal()` runs with `selectedPayment===null` → both branches are skipped (no side effects). Confirm.
- `setCashTendered(calcTotal())` mirrors exactly what tapping the "Pago exacto" chip does (its `val` is `calcTotal()`), so exact-mode stays consistent.

## Non-negotiables
- **No change to any money/submit path** — `processPayment`, the `cash_tendered` guard, pricing, server calls all untouched. Diff must be display-sync only.
- **Both forms** get the identical structural edit (only the line anchors differ). The cash/pay logic is structurally the same past CONFIG — keep them in lockstep.
- No cheap emoji, no new UI chrome. Reuse existing functions only.
- `node --check` both `index.html`? (it's HTML) → instead sanity-check the inline JS by loading each form in agent-browser and running the QA below.

## QA (manual — mirror the owner's repro, BOTH forms, BOTH methods)
1. **Cash / Pago exacto follow:** add items → Paso 2 → **Efectivo** → tap **Pago exacto** (box = total, "Tu cambio: L0.00") → go back, open cart pill → a pizza → **add an extra** → return to Paso 2. **Expect:** Pago exacto chip AND the cash box now show the NEW total; "Tu cambio" recomputes; no toggle needed.
2. **Cash / custom amount preserved:** Efectivo → type a custom "pay-with" (e.g. L500) → edit cart to raise the total above 500 → **Expect:** the 500 stays in the box, hint turns red "El monto debe ser mayor o igual al total (L…)". (custom amount not clobbered; just re-validated.)
3. **Online amount:** select **Pagar en línea** (PixelPay panel shows amount) → edit cart → **Expect:** the PixelPay amount updates to the new total live.
4. **Regression:** first-load (no method selected) → editing cart still just updates the total normally (no console errors, no cash panel appearing).

## Handoff back
Advisor is NOT editing these files — you are sole editor on `fix/cash-total-sync`. Push, report the SHA + the 4 QA results (agent-browser screenshots welcome). Advisor runs a light codex-on-diff (money-path-untouched + both-forms parity) → owner deploys via **`git push origin main`** (both forms are git-CD from main; no manual Netlify CLI — that's the wrong-site footgun).
