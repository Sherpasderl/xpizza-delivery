# La Musa — Pad Thai required protein choice (design)

_Date: 2026-07-21 · Branch: `feature/lamusa-padthai-protein` (off `origin/main` 6eac6c8) · Restaurant: **La Musa only**_

## Goal

Force a La Musa customer to open Pad Thai's detail modal and **choose exactly one protein — Sin Proteína / Pollo / Camarones — before it can be added to the cart**. The choice changes the price and prints on the kitchen ticket. Reuse the form's existing extras pipeline end-to-end; add only a thin, **generic, data-driven** "required single-select" layer so a *future* dish is a data-only edit. X. Pizza is untouched (no Pad Thai / noodles there).

## Pricing (locked)

| Choice | id | upcharge | line total (qty 1) |
|---|---|---|---|
| Sin Proteína | `padthai_sin` | +0 | **L307** (new base) |
| Pollo | `padthai_pollo` | +35 | L342 |
| Camarones | `padthai_camaron` | +107 | **L414** (= today's price — current shrimp customers unaffected) |

Pad Thai base reprices **414 → 307** (`noodle_01`). These three ids are **new and distinct** from the existing optional "Extra Pollo/Res/Camarón" add-ons (`protein_chicken:65 / protein_beef:155 / protein_shrimp:135`) — different prices, different semantics. Do **not** reuse those.

## Approach (locked): reuse the extras channel + a generic required-choice layer

The protein travels through the **existing extras machinery** — `extras[]` + `items_text` in the payload, `LA_MUSA_EXTRAS` server pricing + anti-tamper, and the KDS's existing extras rendering. The only new thing is a small config-driven "required, pick one" behavior that leaves every other item's optional-extras flow byte-identical.

### Generic mechanism

```js
// item id → its required single-select group. Rides the existing extras tables.
// Add another dish later = its choice ids in EXTRAS + LA_MUSA_EXTRAS, then ONE line here. No new code.
const REQUIRED_CHOICE = {
  noodle_01: { label: "Proteína", choiceIds: ["padthai_sin","padthai_pollo","padthai_camaron"] },
};
```

The choice definitions live as normal entries in the form `EXTRAS` array (name + price) and in server `LA_MUSA_EXTRAS` (price), but are given a **category not referenced by `EXTRAS_BY_CATEGORY`/`EXTRAS_BY_ITEM`** (e.g. `cat:"Proteína (base)"`) so they never leak into the optional-stepper lists. They are surfaced only via `REQUIRED_CHOICE[id].choiceIds`.

## File-by-file changes

### A. Customer order form — `la-musa-orders/index.html`

1. **Reprice Pad Thai** — `MENU` entry `noodle_01` (line ~1602): `price:414` → `price:307`. Update `desc` to drop the implied "camarones" if desired (optional copy tweak).
2. **Add the 3 choices to `EXTRAS`** (array ~1761-1776): `{id:"padthai_sin",cat:"Proteína (base)",name:"Sin Proteína",price:0}`, `{...padthai_pollo,name:"Pollo",price:35}`, `{...padthai_camaron,name:"Camarones",price:107}`. **Do not** add them to `EXTRAS_BY_CATEGORY`/`EXTRAS_BY_ITEM`.
3. **Add `REQUIRED_CHOICE`** map (near the `LA_MUSA_MODIFIERS` block) + a generic helper `itemHasRequiredChoice(item) => !!REQUIRED_CHOICE[item.id]`.
4. **Force the modal (guard #1)** — in `renderMenu()` (~1999-2034), the qty "+" overlay currently calls `chg(id,+1)` directly (~2011-2021). Wrap: if `itemHasRequiredChoice(item)` → `openDetailModal(id)` instead of `chg`. (Pad Thai already opens the modal on photo-tap; this closes the "+"-bypass.) No change for items without a required choice.
5. **Render the required group as radios (guard #2)** — in `renderDetailModal()` (~3346; extras render ~3405-3446): when the item has a `REQUIRED_CHOICE`, render its `choiceIds` as a **single-select radio group** (looking up name/price from `EXTRAS`) instead of qty steppers. Optional extras (Acompañamientos/Salsas) still render as steppers below it.
6. **Single-select write** — a `chgRequiredChoice(choiceId, itemId)` (sibling of `chgDetailExtra` ~3527-3538): set `pizzaExtras[itemId]` so **only** the chosen id in the group is present, qty 1 (clear the other group ids). Optional extras in `pizzaExtras[itemId]` are untouched.
7. **Gate the Add button (guard #3)** — in `updateDetailCta()` (~3455-3497, currently only disables on sold-out ~3475-3481): also disable + label "Elegí una proteína" when the item has a `REQUIRED_CHOICE` and none of its `choiceIds` is selected.
8. **Qty-scaling (guard #4)** — in `buildOrder()` (~2722-2790; extrasArr ~2735-2743): when emitting a required-choice extra, set its emitted `qty = qty[p.id]` (the dish qty), not the stored 1. So 2 Pad Thai → protein qty 2 → correct upcharge. It flows into `items_text` via the existing bracket builder (~2751-2761).

### B. Server pricing — `xpizza-functions/menu-pricing.js`

9. **Reprice** `LA_MUSA_MENU` `noodle_01` 414 → 307.
10. **Add the 3 ids** to `LA_MUSA_EXTRAS`: `padthai_sin:0, padthai_pollo:35, padthai_camaron:107`. `computeServerTotal(..,'la_musa')` already prices id-keyed extras as `extraPrices[eid]*eqty` with anti-tamper (unknown/dup/non-array/qty) — no other change needed to *price* it.
11. **Money-integrity enforcement (recommended, robust)** — add `LA_MUSA_REQUIRED_CHOICE = { noodle_01: ['padthai_sin','padthai_pollo','padthai_camaron'] }` and, in `computeServerTotal`, for a la_musa line whose item id is in that map, **require exactly one choice id present with `qty === line.qty`**, else `{ total: NaN, error: 'missing/invalid required choice' }`. This closes the only new money edge: a tampered payload sending dish qty 2 but protein qty 1 (2 shrimp dishes, pay for 1 shrimp). Hand-synced with the form's `REQUIRED_CHOICE`, same contract as the existing menu/extras tables. **This is the key line the money-gate scrutinizes.**

### C. KDS — `xpizza-kitchen/index.html` — **NO CHANGE**

The KDS parses `items_text` (~1750, regex ~1777) and already renders any bracketed modifier as an indented red `↳` sub-line under the item (~1826/1830, `--extra:#DC2626`). The protein arrives in that bracket, so it prints as e.g. `1× Pad Thai` / `↳ + Camarones` (or `↳ + Sin Proteína`) automatically. No KDS work. _(The literal text carries the existing `+` bracket prefix; dropping it for base proteins is an optional future polish that would touch the `items_text` builder — out of scope here.)_

## Data flow

modal radio pick → `pizzaExtras[noodle_01] = { padthai_camaron: 1 }` → `buildOrder` emits `extras:[{id:'padthai_camaron',name:'Camarones',price:107,qty:<dishQty>}]` + `items_text: "...Pad Thai (L307) [+ Camarones]"` → POST → server `computeServerTotal` reprices (base 307×qty + 107×qty) + enforces the required choice → KDS renders `↳ + Camarones`.

## Error handling / edge cases

- **No selection** → Add disabled (guard #3); order can't be built without a protein.
- **Sin Proteína** is an explicit price-0 choice → emitted + shown on the ticket (`↳ + Sin Proteína`); ensure `buildOrder` does **not** drop price-0 extras from `extrasArr`/`items_text`.
- **Qty > 1** → all Pad Thai in that line share the one chosen protein (form is one-config-per-item-id); protein qty scales (guard #4). Mixing two proteins in one order is not supported (matches the form's existing single-config model — acceptable, out of scope).
- **Back-compat** → other items unaffected; the four guards are all `itemHasRequiredChoice`-gated.
- **Fail-safe** → server rejects a tampered/missing choice (enforcement #11) rather than mispricing.

## Tests

- **Server (`menu-pricing` unit):** base reprice (noodle_01 = 307); each protein total (307/342/414); qty-scaling (2× camarones = 828); tamper — unknown protein id rejected, missing required choice rejected, protein qty ≠ dish qty rejected, duplicate/multiple choices rejected.
- **Form (pure helpers if extracted):** `itemHasRequiredChoice`; single-select (`chgRequiredChoice` clears siblings); `updateDetailCta` disabled until chosen; `buildOrder` emits protein with qty = dish qty and keeps price-0 Sin Proteína.
- **Manual:** Pad Thai "+" opens modal (no quick-add); Add disabled until pick; price updates; cart + KDS ticket show the protein; a second dish added via one `REQUIRED_CHOICE` line works with no code change (spot-check the generic path).

## Gate & rollout

- **Money-gate:** codex-on-diff on B (server reprice + 3 ids + required-choice enforcement) and the form's `buildOrder` qty-scaling — the price-affecting surface. Advisor runs it before build sign-off.
- **Build ownership:** executor builds on this branch; advisor gates the diff; **Xavier deploys** (functions deploy for `menu-pricing.js`; git-CD/Netlify for the form). Functions deploy follows the standing env/rules discipline (complete `.env`, reconcile `database.rules.json`, zero-prune).
- Form and server tables are **hand-synced** (existing contract) — the reprice + ids + required-choice map must match on both sides; the gate verifies parity.

## Out of scope

- Any second dish (mechanism is ready; not wired now).
- Dropping the `+` from the base-protein KDS line.
- Mixed proteins across multiple units of one line.
- Customer-facing success-receipt showing extras (pre-existing gap, unrelated).
- X. Pizza.
