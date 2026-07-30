# Rewards — Redemption v2 — BUILD SPEC (executor)

> **Status:** DESIGN-LOCKED by owner (Xavier), 2026-07-30. MONEY-PATH → advisor **codex design-gate REQUIRED
> before build**, and advisor **codex code-gate** on the diff before merge. Supersedes the standalone
> `REWARDS_GOLDEN_TICKET_BUILD_HANDOFF.md` (the ticket is now built as part of this, over the final picker states).
>
> **THE MOCKUP IS THE CONTRACT.** Build the UI to match it **exactly** — the owner spent a long session
> dialing in every detail and will reject anything that drifts from it.
> - **Interactive reference (source of truth):** `rewards-v2-mockups/redeem-experience.html`
>   (published: https://claude.ai/code/artifact/d3a0b187-b2f0-442d-96b0-4864bddf8f7e )
> - **Icon system reference:** `rewards-v2-mockups/menu-icons.html`
>   (published: https://claude.ai/code/artifact/4ac2308e-e988-4a31-b4af-13a8bb0bf438 )
>
> Port the CSS + markup + SVG symbols from the mockup **verbatim** (adapting only the brand-neutral gold /
> CONFIG hooks noted below). Do not re-interpret, re-space, or re-style. When in doubt, match the mockup pixel-for-pixel.

---

## 0. Timing / safety
Redemption is still **gated OFF** (`config/redemption_enabled` !== true), **zero reservations ever stamped**.
So this model change is safe pre-flip: **no migration, no in-flight redemptions to invalidate.** Bump
`REDEMPTION_CONFIG_VERSION` 1 → 2. Deploy **functions-first, then forms.**

---

## 1. Redemption MODEL (server — `xpizza-functions/`)

### 1a. X. Pizza — one free 12″ pizza of the customer's choice (SINGLE, per punch card)
- Reward: customer picks **any 12″ `individual` pizza** and it is **added to the cart as a free (L0) line**.
  Was `discount_cheapest_pizza` (auto-freed the cheapest pizza already in cart) — **replace it.**
- **Eligibility = 12″ individual only. EXCLUDE the 18″ NY pies** (`cat:'ny'`, the L624–702 items). The eligible
  set MUST be **server-authoritative** — do NOT infer from the name string. Derive it from the same category
  source the X. Pizza form uses (`cat:'individual'`); the server owns the canonical eligible-pizza list.
- Cost: **8 punches** (unchanged, `REDEMPTION_CONFIG.x_pizza.cost`).
- Model/`canonical`: `{ restaurant_id:'x_pizza', model:'add_free', type:'free_pizza_choice',
  config_version:2, cost:8, discount_cents:0, free_item_key:<pizza menu key> }`. Order total unchanged
  (item added at 0); the summary shows "Ahorrás L<price>".
- **EARN RECONCILIATION (codex must-verify).** Today `rewards-core` `earnPreview` (~:41) applies a **`−1 punch`
  adjustment** because the freed pizza was a *paid* line that earned a punch. With **add-free**, the free pizza
  is a NEW L0 line that was never paid → it must **earn ZERO punches**, and the `−1` adjustment must be
  **dropped/reconciled** for this model, or a punch is minted/lost. `earnPreview` MUST equal `creditEarnForOrder`
  for the redeemed order (there is a parity CI test — keep it green). This is exactly the cross-module class of
  bug codex caught in B1; treat it as the #1 correctness item.

### 1b. La Musa — points WALLET, choose any non-alcohol dish, MULTIPLE per order (N-PER-ORDER)
- Reward: customer redeems **one or more** non-alcohol menu items; **each added as a free (L0) line**; the
  points balance decrements per item. Replaces the 5 curated tiers entirely.
- **Cost per item:** `cost_pts = round(price_L × 10 / 3)` → exactly **~10% value-back** (each point = **L0.30**),
  continuous with the retired tiers. Add a single rate constant (e.g. `REDEEM_POINTS_PER_LEMPIRA = 10/3`) in
  `rewards-redeem-config.js`; the calculator reads ONLY from there. Price resolved via `laMusaPriceCents`
  (MENU **and** EXTRAS namespaces).
- **Eligible set:** all `la_musa` MENU items **EXCEPT alcohol (`beer_*`)** (softs allowed), **PLUS** the standalone
  acompañamientos (`rice_white`, `rice_chinese`, `papas_fritas`). **EXCLUDE modifiers** (`sauce_*`, `protein_*`).
  Alcohol still **earns** points; it is only hidden from the redeem picker.
- **WALLET mechanics (THE money-gate centerpiece):**
  - The order carries a **multiset** of redeemed item ids (qty ≥ 1 each). Reserve the **SUM** of their
    `cost_pts`. The **sum reserved MUST be ≤ available balance, checked ATOMICALLY** at reserve time so two
    concurrent orders can't double-spend the same points.
  - Redemption spine goes from **one-per-order → N-per-order.** Decide the record shape (one reservation binding
    the full multiset, OR N reservations that atomically succeed/fail together) — either way: (a) atomic sum
    check, (b) `canonical`/`payment_fingerprint` binds the **entire redeemed set** (order-independent
    fingerprint), (c) clawback/reversal releases **all** reserved points, (d) the **"balance ≥ total reserved"
    invariant holds across N** (the B1 mint-bug invariant, generalized).
- **EARN:** each free item is a L0 line → contributes 0 to `subtotal_cents` → earns 0 points automatically.
  No adjustment needed (unlike X. Pizza). Verify.
- Model/`canonical` per item: `{ restaurant_id:'la_musa', model:'add_free', type:'points_ala_carte',
  config_version:2, cost:<cost_pts>, discount_cents:0, free_item_key:<item_id> }` bound into the order's set.

### 1c. Anti-abuse GUARD (BOTH brands)
- A reward (or any wallet item) applies **only if the cart has ≥1 OTHER PAID item** (paid `subtotal_cents > 0`
  excluding reward lines). The free item(s) can never be the whole order. **Server-enforced** at reserve/intake
  (authoritative); the picker also gates client-side (see UI). Reason code e.g. `needs_paid_item` → non-payable.

### 1d. Config / version
- `REDEMPTION_CONFIG_VERSION` → **2**. La Musa config becomes `{kind:'points', reward:'points_ala_carte',
  rate: 10/3, exclude:['beer_*','sauce_*','protein_*']}` (drop the `tiers` array). X. Pizza
  `{kind:'punch', cost:8, reward:'free_pizza_choice'}`. Keep the calculator/handlers reading ONLY from config.

### 1e. Codex design-gate — REQUIRED refinements (APPROVE-WITH-CHANGES, thread 019fb4fe) — BINDING
These are part of the approved design; build them in.
1. **`rewards-reserve.js` — ONE AGGREGATE reservation per order (not per-item / not an order-sensitive array).**
   La Musa: `reservations/{orderId}.cost = Σ(cost_pts × qty)`; `canonical` stores
   `{model:'add_free', type:'points_ala_carte', items:[{free_item_key,cost,qty,price_cents}], total_cost}`
   with items **sorted + coalesced by `free_item_key` before hashing** (reorder-/duplicate-stable). Do NOT
   create independent child reservations unless all children are created/consumed/released in the **same parent
   transaction**.
2. **Payment fingerprint must bind the full redeemed set.** Current `orderFingerprint(orderId,total,itemsText,extra)`
   is weak for v2 (La Musa total unchanged; `itemsText` is display text). Add a stable `redemptionFingerprint`
   (canonical-set hash) into the fingerprint input for **both** cash reserve binding and online
   `payment_fingerprint`. Never rely on client item names or UI order.
3. **`rewards-redeem-intake.js` — guard server-side BEFORE reserve.** Compute paid `subtotal_cents` from the
   server-priced submitted **paid** cart only (before appending reward lines); reject `<= 0` with `needs_paid_item`.
   Never count redeemed items, free lines, display summary lines, or client totals.
4. **`rewards-redeem.js` — multiset-aware (La Musa).** Accept only a **bounded** array/multiset of {id, qty};
   coalesce duplicates; validate integer `qty ≥ 1`; price each id server-side; `cost_pts = round(price_L×10/3)`
   per unit; reject if any id ineligible; return aggregate `cost` + canonical item set.
5. **`rewards-redeem-config.js` — authoritative eligible-set helpers; `REDEMPTION_CONFIG_VERSION = 2`.**
   X. Pizza: only `cat === 'individual'`, explicitly exclude `ny`. La Musa: menu ids except `beer_*`, plus
   `rice_white/rice_chinese/papas_fritas`; reject `sauce_*` / `protein_*`.
6. **`rewards-redeem-pricing.js` — add-free for BOTH brands + N free lines.** X. Pizza is no longer `discount`;
   it's `add_free/free_pizza_choice` (unchanged total, one L0 pizza). La Musa emits all redeemed free lines with
   qtys. No expensive/NY/modifier item ever priced free unless it passed server eligibility.
7. **`rewards-core.js` + `rewards-earn.js` — DROP the X. Pizza `model==='discount'` `−1` adjustment for v2.**
   Add-free L0 pizza is not a paid punch-earning line in `order.items`, so `earnPreview` === `computeEarn` ===
   `creditEarnForOrder`. **Update the parity test** to assert **no subtraction** for
   `model:'add_free', type:'free_pizza_choice'`.
8. **Clawback/reversal generalizes** (`releaseRedemption`/`consumeRedemption`/`reverseRedemptionForRefund`/sweeps/
   `reverseEarnForOrder`) **iff `rec.cost` is the full aggregate sum**; the B1 `balance ≥ reserved` invariant then
   holds across N because reserve+clawback transact on `user_rewards/{uid}/{rid}`.
9. **Config bump 1→2 while gated OFF is safe** (zero stamped reservations → no migration hazard). Functions-first deploy.
- **Smaller (do them):** `buildRewardStamp`/`summaryLines` render multiple add-free lines; quote response returns
  `free_items[]` + `total_cost`/`remaining`; add tests for concurrent La Musa reserves, duplicate-coalescing,
  reorder-stable fingerprints, NY exclusion, modifier/alcohol exclusion, the paid-item guard, cancel/refund
  releases, and earn-preview-vs-credit.

---

## 2. UI — BUILD TO `rewards-v2-mockups/redeem-experience.html` EXACTLY

Both `xpizza-orders/account.js` **and** `la-musa-orders/account.js`, **byte-identical past CONFIG** (parity
guard `rewards-parity.guard.test.js` — keep 4/4). The gold is **brand-neutral** (identical literals in both
files — this *strengthens* parity). Restyle scope = the `#acct-redeem` affordance: `renderRedeem` /
`renderRedeemOffer` (:354) / `renderRedeemItems` (:369) / `renderRedeemReview` (:397) / loading+error (:381/:387)
/ the `.acct-rd*` CSS (:413–:431).

**⚠️ FOOTGUN — `.acct-rd` is an OVERLOADED class** (also the account-menu labels at `:676`, `:1424`, `:1426`).
Scope every new selector under `#acct-redeem` **or** rename the redeem-affordance classes to a fresh prefix and
update all onclick hooks. Verify those two menu-row labels are visually unchanged.

### 2a. The golden ticket (redeem row) — port `.tk*` from the mockup
- Champagne-gold **foil face**: `linear-gradient(116deg,#e4cd8a 0%,#f3e5b2 22%,#dcc074 44%,#ecdb9e 64%,#e0c37c 100%)`;
  the inset-highlight + drop `box-shadow`; radius 11px; **single-row height** (`.tk-frame` `min-height:50px`) —
  **must not overpower the pago page.**
- `::before` **sheen** (radial spotlight + diagonal streak). **4 corner filigree** SVGs (`#corner` symbol).
- Inset **engraved keyline** frame (`.tk-frame`, 1px `--g-ink2`, inset white shadow).
- Content **center-aligned** (`.tk-tx` `flex:1;text-align:center`).
- Tear-off **stub** with dashed **perforation + side notches** (`.tk-perf`).
- **States:**
  - X. Pizza offer → eyebrow **"Tu premio"** + wordmark **"1 Pizza"** (centered) + **"Usar →"** stub.
  - La Musa offer → **"Tu premio"** + **"Canjeá tus puntos"** + **"Canjear"** stub.
  - Applied → **"Premio aplicado"** + item name (X. Pizza) / **"N premios"** (La Musa); **"Quitar"** on the stub.
  - **NO "gratis" anywhere** ("Tu premio" implies the gift); applied name is **not** struck-through.
- **Fonts (exact):** wordmark `.tk-h` = **Playfair** (`--display`), weight **600**, ~16px (softened, not bold);
  eyebrow `.tk-k` + stub `.tk-use` = the slab/serif per mockup; **`.tk-quitar` = the ticket's serif** (Playfair),
  NOT sans — match the rest of the ticket, **both forms**.
- Gold literals are **fixed** (NOT `CONFIG.accent`). GIFT/CHECK icons = gold ink.

### 2b. The reward PICKER SHEET — port `.sheet/.shd/.slist/.row/.sec/.qwrap*` from the mockup
Bottom sheet, slides up from the ticket (`slideup` keyframe). **No ✕ close button** — dismiss via scrim tap or
the Listo button.
- **Header = GOLD foil** (same gradient as the ticket, NOT cream). Flex layout: left = eyebrow **"Canjeá"**
  (DM Sans, uppercase micro-label) + title **"Elegí tus platos" / "Elegí tu pizza"** (DM Sans 800); right = the
  balance block (La Musa only) — big number in **Playfair** + label **"Tus puntos"** (sentence case, **NOT**
  all-caps). Header laid out so title and balance never collide.
- **Rows:** icon (fine-line, §3) + **dish name left in DM Sans** + right side in **Playfair** (points cost / the
  quantity number / the "−"). **Category headers title-case** ("Dim Sum", "Sopas y ensaladas") in DM Sans, muted
  gold — **NOT all-caps**; sticky, flush to the header with a hairline (no sliver of rows peeking between the
  category bar and the gold header).
- **X. Pizza picker:** list of the 12″ pizzas (name + chevron), **one tap picks** → sheet closes → ticket applied.
- **La Musa picker — quantity WALLET:**
  - Tap a dish → adds one; a **Playfair quantity number** appears on the right; tap again → 2, 3…
  - A **light, small round "−"** (hairline, muted gold, ~19–20px) removes one.
  - **Balance decrements instantly** (owner cut the count-up animation — **do NOT** add a per-frame JS tween;
    just set the value).
  - Dishes you can no longer afford **grey out** with **"te faltan X"** — via a **CSS `opacity` transition**
    (`.row{transition:opacity .28s}`), fade not snap.
  - **"te faltan X pts" toast** shows **centered in the middle of the sheet** (not the bottom).
  - **Update the sheet DOM IN PLACE** (toggle classes / edit text on existing rows) — do **NOT** rebuild the list
    innerHTML per tap (it kills transitions, resets scroll, and is heavier). Preserve scroll position.
- **PERF GUARDRAILS (owner, firm):** animations = **CSS `opacity`/`transform` only** (grey-out fade + qty pop OK);
  **no per-frame JS animation** as a nice-to-have; **NO `backdrop-filter`/blur anywhere** (scroll-jank on cheap
  Android); all of this is **lazy / picker-scoped** and must never run on or slow the normal checkout path.
  `transition:none` is the one-line kill switch. **Never sacrifice functionality for a nice-to-have.**

### 2c. Order summary (pago page)
- Redeemed items show as free lines with a small **"Premio"** chip and struck price → **L0**.
- Savings line (clean, two lines, right-aligned — **no cramming/wrapping**):
  - **`Ahorrás L<sum>`** (green, prominent)
  - La Musa only, muted second line: **`<used> pts usados · te quedan <remaining> pts`** where **"te quedan …
    pts" is GOLD** (positive-balance feel), the "usados" part muted grey.

### 2d. Wiring that MUST survive (verify each fires)
`Usar`/pizza pick → select+quote; La Musa add/remove → wallet update + quote; `Quitar` → clear + `env.onQuoted(null)`
+ re-render; apply → `renderStage2Summary`/total. Do NOT touch `redeemSelect`, the quote call, pricing, or the
cash-tendered submit guard.

**⚠️ v2 REQUEST CONTRACT — HARD REQUIREMENT (the §1 server now enforces `redeem.type`; caught at money re-gate).**
The picker MUST emit the **v2 redeem request shape** or the server returns `bad_request`:
- X. Pizza → `{ type: 'free_pizza_choice', item_id: <12″ pizza menu key> }`
- La Musa → `{ type: 'points_ala_carte', items: [ { id, qty }, … ] }` (multiset; qty ≥ 1)

The **old v1 shapes are now REJECTED**: `{}` (X. Pizza) and `{ type:'free_item', level, item_id, name }` (La Musa).
Replace them in `_redeemPending`/the redeem request builder in BOTH `account.js`. **Do NOT flip redemption ON until
BOTH functions AND forms are on v2** (functions-first deploy is safe only because redemption stays gated OFF until
the atomic flip, so the v1-client / v2-server window is inert).

---

## 3. Menu ICON system (separate, parallel display-only handoff) — `rewards-v2-mockups/menu-icons.html`
Replace **all** cheap dish emoji on **both** order forms' menu cards (the no-photo tile + detail modal) **and**
the redeem picker with the **fine-line monochrome** SVG icon set from the mockup. La Musa = per-category
(8 icons), X. Pizza = per-topping. Data-driven: swap each item's `emoji` field for an `icon` key; render an
inline SVG `<use>`. Cream-on-tile where the colored tile shows; photos still lead where present. This is
**display-only, no money-path** — its own build + parity/visual check; can proceed independently of §1/§2.

---

## 4. Files / tests / gate / flow
- **Server:** `rewards-redeem-config.js` (v2 config + rate + eligible/exclude), `rewards-redeem.js`
  (`computeXPizza` add-free choose-any; `computeLaMusa` à-la-carte + multiset), `rewards-core.js` (X. Pizza earn
  reconcile), `rewards-reserve.js` / intake (N-per-order atomic sum reserve + guard). Update `rewards-redeem.test.js`,
  `rewards-core.test.js`, `rewards-redeem-config.test.js`; keep the earn preview↔credit parity test green.
- **Client:** both `account.js` (§2), byte-identical past CONFIG; keep `rewards-parity.guard.test.js` 4/4.
- **Gate:** advisor **codex design-gate on the §1 money model** (done before build) → executor builds →
  **Netlify DRAFT both forms** (redemption gated OFF → **canary/force the offer visible** to preview every state
  against the mockup) → owner eyeballs vs the mockup → advisor **codex code-gate on the diff** → owner deploys
  **functions-first, then forms.**

Relates to memory: [[rewards-redemption-v2-design]], [[rewards-loyalty-program]], [[codex-gate-money-adjacent]].
