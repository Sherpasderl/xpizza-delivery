# Reward-led profile-claim card + itemized order summaries (follow-on to Track A) — build plan

_For the advisor plan-gate. Money path UNTOUCHED → code-gate + a codex pass on the earn-preview (rewards-domain → money-adjacent). Both brands, both capture screens (order-form success + tracker). Mockup: artifact `f9681eb8` — build EXACTLY to it. Branch `feat/reward-led-claim` STACKS on `feat/track-a-profile-claim` (`b9cdc65`) — it replaces Track A's claim card, so it merges after/with Track A._

## PLAN-GATE changes folded (cleared to build) + claimOrder now LIVE
- **(a) `summaryLines` MUST FOOT for redeemed orders** — takes the order-shaped input (items + `redemption`/discount cents) and adds a struck **GRATIS / Descuento** line so Σ lines === the DISCOUNTED total. (X. Pizza discount → a `−L<discount>` line; La Musa add_free → the added item as a `GRATIS` 0-cents line, total unchanged.)
- **(b) `earn_preview = { unit, delta, welcome, goal }`** — stamp `welcome` + `goal` too, so the TRACKER embeds ZERO reward constants (drift-proof). `welcome`/`goal` = display mirror of `REWARDS_CONFIG.welcome` + the redemption threshold (X. Pizza card_size 8 / La Musa first tier 300).
- **NEW — client `claimOrder` call + post-claim confirmation states** (claimOrder is LIVE, so the earn actually credits → the copy is honest). After a claim-context signup, call `claimOrder` with the new ID token (TOKENLESS for the success card / scheduled; token when the tracker deep-link has it), **fail-open (never block signup)**. Then a confirmation driven by the response `credited`: `credited:true` → **"¡Sumaste N puntos/sellos!"**; `credited:false` → **"Tus N se acreditan cuando entreguemos tu pedido."** (`N` = the number the card displayed). Build exactly to the mockup's Post-claim confirmation section.
- **Sequence:** functions (earn_preview+summary_lines+goldens) → success reward card → tracker card + itemized summary → client claimOrder call + confirmation states. Branch rebased onto main (`9b492aa` — Track A + claimOrder + the lazy-phoneHash deploy hotfix).

## Design (from the mockup — verbatim)

**The reward card (`.rw`)** replaces the current "Creá tu perfil" card on (a) the order-form success screen (`account.js renderSuccessRewards` guest branch — KEEP the Track A `env.claimPhone/claimName` soft-fill) and (b) the tracker guest claim card. Structure:
- `.rlabel` — mono uppercase gold-deep, gift line-icon + **"Tu recompensa"**.
- `h3` (serif, ink) — the state-dependent hook.
- `.math` (13px ink-soft, gold-deep bold numbers) — **"Este pedido suma `<b>N</b>` + `<b>W de bienvenida</b>` al crear tu perfil."** (`N` = pts/sellos this order earns; `W` = the welcome bonus).
- **Proof, per brand:**
  - **La Musa (points):** `.ptrow` — `.bignum` (serif gold-deep 38px) = `earned + welcome`, `.bigunit` "pts" — then `.bar` (fill %) + `.barcap` (`0` … `.goal`).
  - **X. Pizza (punch):** `.slots` — `card_size` circles: `earned+welcome` filled (`.slot.on`, gold gradient + check), rest empty, LAST is `.slot.goal` (dashed + gift icon); `.slotcap` **"`<b>F / 8</b>` — `K` pizzas más para tu pizza gratis."** (`F`=filled, `K`=8−F).
- `.rwcta` (gold-gradient button) — **"Crear mi perfil y reclamarlo"** (La Musa) / **"Crear mi perfil y guardar mis sellos"** (X. Pizza).
- `.rwsub` (11.5px centered ink-soft) — the convenience line (per-screen copy below).

**Dynamic copy (computed from the real earn + welcome):**
- **La Musa — `earned+welcome ≥ 300` (first tier):** h3 **"Tu primer premio ya te espera"** (success) / **"Este pedido ya te da tu primer premio"** (tracker); bar 100%; `.goal` = **"✓ Primer premio · 300 pts"**.
- **La Musa — below 300:** h3 **"Vas `<b>N+W</b>` pts, a solo `<b>300−(N+W)</b>` de tu primer premio"**; bar = `(N+W)/300`; `.goal` = **"faltan `300−(N+W)`"**.
- **X. Pizza (always slots):** h3 by fill — `F≥7` → "a 1 pizza", `F≈half` → **"Ya vas a mitad de tu pizza gratis"**, low → "casi"; `.slotcap` as above.
- `.rwsub`: success → **"Guardá tus puntos/sellos, direcciones e historial — reordená en un toque."** · tracker → **"Guardá tus puntos/sellos y reordená este pedido en un toque."**

**Colors** (gold family): `--gold #A9791A`, `--gold-hi #C9A24A`, `--gold-deep #7d580f`, `--gold-tint #FBF4E4`; card bg = the radial-gold + `linear-gradient(#fffdf8,#fbf4e4)`, border `rgba(169,121,26,.34)`. **Fonts = the app's** Playfair (serif hero/bignum) / DM Sans (body/CTA) / Special Elite (mono eyebrow). **No emoji in chrome — gold line-icons only** (gift, check).

**Itemized order summary** — rows `name · qty · line total` (tabular price, right) + a **Total** row: **bold, same ink as the line items, NO background fill** (`.sumtotal`/`.trktotal`). Applies to BOTH the success `.sumcard` (the A6 summary — align its Total if it differs) and the tracker (replace the run-on `#summary-items`).

## Backend (Task 1 — functions; the source of truth both screens read)

Two ADDITIVE fields on `order_tracking`, **stamped for ALL orders**, at BOTH write sites (same pattern as `has_profile`): the immediate `createOrder` path AND the shared `buildMaterializeUpdates()`.

1. **`earn_preview: { unit, delta }`** — from **`computeEarn({ items, subtotalCents, restaurantId })`** (rewards-core.js — the SAME function the authoritative `earnRewardsOnCompletion` uses, so the preview never disagrees with what credits). Import `computeEarn` into index.js (currently only `shouldEarnOnStatus` is imported). Inputs: `items` = the cart items (X. Pizza qty-count), `subtotalCents` = `priceBreakdown.subtotal_cents` (La Musa points). **Display preview only — writes NOTHING to balances; authoritative earn stays at `earnRewardsOnCompletion`.**
   - _Honesty note (guest-safe):_ `earnRewardsOnCompletion` subtracts 1 punch for an X. Pizza **discount** redemption. Redemption requires a verified uid, so a GUEST order (where the card shows) never has one → raw `computeEarn` == the credited amount there. Logged-in redeemed orders stamp the raw preview but DON'T show the card. Preview = raw `computeEarn` (documented).
2. **`summary_lines: [{ name, qty, cents }]`** — server-priced (cents = source of truth). New pure fn **`summaryLines(items, restaurantId)`** in `menu-pricing.js`: per line, `cents` from the menu map via `itemPricingKey` (+ extras), `qty` from the item, `name` = the display string (X. Pizza: the menu key = `it.name`; La Musa: `it.name` from the client — **La Musa's menu is id→price only, no server name**; sanitized, display-only, exactly as `items_text` already sources names, with server-authoritative cents). Reuse `pricedLineItems` internals where possible; brand-aware like `computeServerTotal`.
   - At createOrder: `items` = `body.items`; at materialize: the order carries the cart? — **VERIFY at build**: `order_tracking` at materialize is built from `order` (the pending record). If per-item cart isn't on the pending order, stamp `summary_lines` at createOrder/charge time onto the pending order (like `reorder_items`) and copy it at materialize. Resolve in the A1-code-gate read.

**Goldens:** stamping for ALL orders means **guest `order_tracking` is NO LONGER byte-identical** — update `materialize-snapshot.test.js` + `create-order-build`/attribution goldens (the byte-identical invariant was Track-A-scoped; this supersedes it). **No new PII** (`items_text` + `total` are already public; `earn_preview`/`summary_lines` are derived from them).

## Task 2 — success reward card (`account.js renderSuccessRewards` guest branch, byte-identical past CONFIG)

Replace the guest branch's `.acct-sx-claim` markup with the `.rw` reward card. Compute `earned` client-side from the cart (`rwCartEarnLabel` logic — punch = `pizzaCount·earnPerPizza`, points = `floor(subtotalCents/perCents)·ptsPer` — it already mirrors `computeEarn`), + `welcome` + `card_size`/`tiers[0].cost` from `CONFIG.rewards`. **Add `welcome` to `CONFIG.rewards`** (X. Pizza `welcome:2`, La Musa `welcome:100`) — a client mirror of `REWARDS_CONFIG.welcome` (rewards-core.js), hand-synced like the tier costs (note it). CTA `onclick` KEEPS `openLoginSheet({phone: env.claimPhone, name: env.claimName})` (Track A soft-fill). Card CSS injected via the existing `injectSuccessStyles()`. Logged-in success (earn badge) unchanged. Both brands from CONFIG only → parity byte-identical.

## Task 3 — tracker reward card + itemized summary (`xpizza-track/index.html`, shared, brand-mapped)

- **Reward card** (replaces the Track A guest claim card): same `.rw` structure. Reads `data.earn_preview.{unit,delta}` (stamped) + brand `welcome`/`goal`/`card_size` constants embedded per brand in a small `REWARD_DISPLAY` map (the tracker has no CONFIG.rewards; welcome/goal are stable constants — note the sync with rewards-core). Guest-only (`data.has_profile !== true`) + hidden on `cancelled` (Track A rules preserved). Brand-aware deep-link unchanged (fragment token). **Fail-open: if `earn_preview` is absent (pre-deploy), hide the card's number/proof and keep the plain claim CTA** (functions deploy first).
- **Itemized summary:** replace `#summary-items ← items_text` (`:569`) with rows rendered from `data.summary_lines` ({name, qty, cents}) + a Total row (bold, ink, no bg). **Fail-open: if `summary_lines` absent → fall back to the current `items_text` run-on** (owner deploys functions-first).
- Total styling aligned across success + tracker per the mockup (`.trktotal`/`.sumtotal`).

## Invariants / verification
- Money path UNTOUCHED (no pricing/redemption/factura/cash change). `earn_preview` writes nothing to balances; `computeEarn` reused verbatim (a codex earn-preview pass confirms preview==authoritative for the guest case).
- `account.js` byte-identical past CONFIG (parity 4/4) — card logic is CONFIG-driven; `welcome` added to both CONFIGs.
- Exact-to-mockup (fonts/spacing/gold/copy/icons); no emoji in chrome; honest copy ("…al crear tu perfil"; credits on delivered/completed).
- Tests: `summaryLines` unit (both brands, extras, redeemed); `computeEarn` unchanged; `materialize-snapshot`/attribution goldens updated (earn_preview + summary_lines present, guest no longer byte-identical — assert the exact new shape); parity guard; tracker + forms syntax; emulator green.

## Sequence (each SHA → advisor gate; owner deploys FUNCTIONS-FIRST — trackers/forms fail-open to items_text)
1. **Functions** — `earn_preview` + `summary_lines` (+ `summaryLines()` + `computeEarn` import) on `order_tracking` at both write sites + goldens.
2. **account.js** — success reward card (both brands, parity-green) + `CONFIG.rewards.welcome`.
3. **Tracker** — reward card + itemized summary + Total styling.

## Open questions for the gate
1. **`summary_lines` at the materialize path** — confirm the pending order carries per-item cart (else stamp at charge-time + copy, like `reorder_items`). Flagged for the A1-style read at build.
2. **Welcome/goal constants duplicated** in the tracker (no CONFIG there) + `CONFIG.rewards.welcome` (client) mirroring `REWARDS_CONFIG.welcome` (server) — accept the hand-sync (like tier costs), or thread welcome/goal INTO `earn_preview` so the tracker is dumb? (I lean: keep `earn_preview={unit,delta}` per your spec + embed the stable brand constants, documented.)
3. **X. Pizza "reward-ready"** never triggers on welcome alone (welcome 2 < card 8) — the mockup's X. Pizza copy is always the slots/proximity variant. Confirm that's intended (no "ready" state for X. Pizza first-order).
