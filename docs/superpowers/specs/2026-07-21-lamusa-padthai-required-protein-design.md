# La Musa — Pad Thai required protein choice (design)

_Date: 2026-07-21 · Branch: `feature/lamusa-padthai-protein` (off `origin/main` 6eac6c8) · Restaurant: **La Musa only**_

## Goal

A La Musa customer taps Pad Thai → a detail modal opens and **requires choosing one protein (Sin Proteína / Pollo / Camarones)**, plus any optional extras, then **Add → the item lands in the cart and the modal closes** (UberEats flow, per reference screenshots). Each protein is a **separate cart line**: one Pad Thai - Pollo and one Pad Thai - Camarones show as **two distinct items, never bundled**. Reuse the form's existing id-keyed cart/pricing/KDS end-to-end; keep it **generic** so a future dish is a data-only add. X. Pizza untouched.

## Approach (locked): protein variants as distinct menu ids

The cleanest way to get mixed-protein separate lines is the form's **existing id-keyed cart** — grid, cart, review, totals, `buildOrder`, and `items_text` are all keyed by `p.id` (verified: grid `MENU.filter(cat)` @2064; cart/review/order all `MENU.filter(qty[p.id]>0)` @2230/2318/2723; total/count `MENU.reduce` @2180/2195). So each protein becomes its own menu id → its own cart line for free. This **drops** the extras-channel plumbing, the qty-scaling, and the server required-choice enforcement from the earlier draft — the money model is just "three priced ids."

| Variant id | `name` (cart + KDS line) | radio label | price |
|---|---|---|---|
| `noodle_01_sin` | Pad Thai - Sin Proteína | Sin Proteína | 307 |
| `noodle_01_pollo` | Pad Thai - Pollo | Pollo (+L35) | 342 |
| `noodle_01_camaron` | Pad Thai - Camarones | Camarones (+L107) | 414 (= today's price) |

The visible `noodle_01` card becomes a **launcher** (never itself a cart line); the three variant ids live in `MENU` but are **hidden from the grid**.

### Generic mechanism

```js
// Launcher item id → its required single-select variants (each a real menu id → its own cart line).
// Add another dish later: add its variant entries to MENU + LA_MUSA_MENU, then ONE line here. No new code.
const VARIANT_ITEMS = {
  noodle_01: { label: "Proteína", basePrice: 307,
               variantIds: ["noodle_01_sin","noodle_01_pollo","noodle_01_camaron"] },
};
```

Variant `MENU` entries carry `variantOf:"noodle_01"` (marks them hidden-from-grid + links to the launcher) and a `choice` label for the radio.

## File-by-file changes

### A. Customer order form — `la-musa-orders/index.html`

1. **`MENU` — add 3 variant entries** (near `noodle_01` ~1602), each:
   `{ id:"noodle_01_camaron", cat:"noodles", name:"Pad Thai - Camarones", price:414, emoji:"🍜", color:"#8A7B6B", variantOf:"noodle_01", choice:"Camarones", desc:"Fideos wok, tamarindo, maní, brotes, huevo" }` (+ `_pollo` 342, `_sin` 307). Keep `noodle_01` as the **launcher** (repurpose; its `qty` stays 0 forever — it is never added). Optionally set its `desc`/price for the card ("desde L307").
2. **`VARIANT_ITEMS`** map + `itemIsLauncher(p) => !!VARIANT_ITEMS[p.id]` + `itemIsVariant(p) => !!p.variantOf`.
3. **Hide variants from the grid** — the category filter (`const items = MENU.filter(p => p.cat === c.id)` @2064): add `&& !p.variantOf`. Now only the launcher card shows in "Noodles".
4. **Launcher card render** — in `renderMenu()` `card` template (~2001-2035): for `itemIsLauncher(p)`, the qty-overlay "+" calls **`openDetailModal(p.id)`** instead of `chg(p.id,1)`, and the inline stepper/badge is suppressed (a launcher never shows a per-card count — qty lives per-variant in the cart, matching UberEats). Card price shows "desde L{basePrice}". Non-launcher cards render exactly as today.
5. **Modal = required single-select + optional extras, staged** — `openDetailModal`/`renderDetailModal` (~3195/3346): for a launcher, render its `variantIds` as a **radio group** ("Proteína — elegí una", Required, radios with `+Ldelta` from `basePrice`) above the item's normal optional extras (Acompañamientos/Salsas, from the existing `noodles` cat). The modal holds a **staged local selection** `{ variantId, extras:{} }` (not live-written to a fixed id, because the target variant isn't known until a protein is picked). Radio pick sets `variantId`; extra steppers mutate the staged `extras`; the CTA shows `Agregar · L{variant.price + extrasSum}`.
6. **Add → commit to the chosen variant + close** — a launcher CTA handler (replaces the `detailCtaTap` stays-open/two-tap path for launchers only): on Add (enabled only when a protein is chosen), `qty[stagedVariantId] += 1`, `pizzaExtras[stagedVariantId] = {...stagedExtras}`, then `closeDetailModal()`. Re-opening the launcher starts a fresh staged selection (so a 2nd add can be a different protein → a second line).
7. **Gate the Add button** — in the launcher modal, the CTA is disabled + labeled "Elegí una proteína" until a protein radio is selected.

**Everything else is reused unchanged:** `chg`, the cart/review/count/total render, `buildOrder` (emits each variant as its own line: `id/name/qty/price/extras`), and `items_text` (`${qty}x Pad Thai - Camarones …`). Variant lines flow through because they're normal `MENU` ids with `qty>0`.

### B. Server pricing — `xpizza-functions/menu-pricing.js`

8. **`LA_MUSA_MENU` — add the 3 variant ids**: `noodle_01_sin:307, noodle_01_pollo:342, noodle_01_camaron:414`. `noodle_01` (launcher) may stay priced (harmless; never ordered) or be removed. `computeServerTotal(..,'la_musa')` matches by `item.id` (@88 `itemPricingKey`) → prices each variant line correctly; unknown id already rejected as tamper.
9. **No extras changes for protein** (protein is a menu id now, not an extra). **No required-choice enforcement needed** — a bare `noodle_01` is not a purchasable line; only the priced variants are. This is simpler and closes the tamper edge structurally (you cannot order Pad Thai without landing on a priced variant id).
10. Optional sauces/sides still ride the existing extras channel on the variant line (server prices any valid `LA_MUSA_EXTRAS` id sent) — unchanged.

### C. KDS — `xpizza-kitchen/index.html` — **NO CHANGE**

`items_text` carries each variant as its own line → the KDS prints `1× Pad Thai - Camarones` / `1× Pad Thai - Pollo` as **separate tickets/lines**, protein in the name. Optional extras still render as the existing red `↳` sub-line under their line. No KDS work.

## Data flow

launcher tap → modal (staged `{variantId, extras}`) → Add → `qty[noodle_01_camaron]=1`, `pizzaExtras[noodle_01_camaron]={…}` → existing cart shows a **Pad Thai - Camarones** line (separate from any Pollo line) → `buildOrder` emits it as a line + `items_text` → server prices by id (414 + extras) → KDS prints `1× Pad Thai - Camarones`.

## Error handling / edge cases

- **No protein picked** → Add disabled (§A#7); can't add.
- **Same protein added twice** → one line, qty 2 (existing `qty[id]` stacking). **Different proteins** → separate lines (distinct ids). ✅ the locked requirement.
- **Launcher never a cart line** — `qty[noodle_01]` stays 0; excluded from total/count/order naturally.
- **Optional extras** attach to the chosen variant's `pizzaExtras[variantId]`, so they ride the correct line.
- **Variant cart display** — variant entries carry `emoji`/`color` so cart/review rows render (no `-card.webp` needed; they're never in the grid). Not in `HAS_PHOTO` → emoji fallback.
- **Back-compat** — every change is gated by `itemIsLauncher`/`variantOf`; all other items and the existing live-write modal are byte-identical.

## Tests

- **Server (`menu-pricing` unit):** each variant prices (307/342/414); a variant + optional extra sums correctly; unknown/removed id rejected.
- **Form (pure helpers where extractable):** `itemIsLauncher`/`itemIsVariant`; grid excludes `variantOf`; staged Add commits `qty[variantId]` + `pizzaExtras[variantId]`; Add disabled until protein chosen; two different proteins → two lines; same protein twice → one line qty 2.
- **Manual:** Pad Thai card opens modal (no quick-add); pick Pollo + sauce → Add → modal closes, cart shows "Pad Thai - Pollo"; add Camarones → second line; KDS shows two separate lines; totals correct.

## Gate & rollout

- **Money-gate:** codex-on-diff on B (3 variant prices + reprice) and the form's launcher Add-commit (the price-affecting surface). Smaller/simpler diff than the extras approach. Advisor runs it before build sign-off.
- **Build ownership:** executor builds on this branch; advisor gates; **Xavier deploys** — functions deploy for `menu-pricing.js` (standing env/rules/zero-prune discipline); git-CD/Netlify for the form.
- Form `MENU` variant prices and server `LA_MUSA_MENU` are **hand-synced** (existing contract); the gate verifies parity.

## Out of scope

- Any second dish (mechanism ready, not wired).
- UberEats-style "Proteína: X" cart sub-label (we use the variant name "Pad Thai - Camarones"; sub-label is optional later polish).
- Per-line launcher qty badge / aggregation on the card (launcher is a pure opener).
- Customer success-receipt showing extras (pre-existing gap).
- X. Pizza.
