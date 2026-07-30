# Rewards — Golden-Ticket Redeem Row — BUILD HANDOFF (executor)

> **Design is LOCKED by the owner. Build to the mockup exactly.**
> **▶ APPROVED MOCKUP:** https://claude.ai/code/artifact/ddd9642f-f23a-4ef5-82d2-5abc8b4ad0dc
> Open it first. The "compact golden ticket stub" (champagne-gold foil + sheen, thin engraved keyline frame,
> small SVG corner flourish ×4, tear-off **Usar** stub with dashed perforation + side notches) is the target
> in **every state**. Match its proportions: **single-row height (~58px), same footprint as today's redeem
> row — it must NOT grow** (owner: don't overpower the pago page).

## What this is
A **visual restyle** of the checkout redeem affordance (`#acct-redeem` → `renderRedeem*`) into the golden-ticket
stub. **Display/markup + CSS only. Zero money-path change.** (The redemption *model* — cheapest-pizza vs
any-pizza, La Musa tiers vs à-la-carte — is a SEPARATE, later workstream; do not touch redemption logic here.)

## Files (BOTH, byte-identical past CONFIG — parity guard `rewards-parity.guard.test.js`, 4 cases)
- `xpizza-orders/account.js`
- `la-musa-orders/account.js`

## Touch ONLY these (current line anchors)
- `renderRedeemOffer` (:354) — punch offer + points tiers offer
- `renderRedeemItems` (:369) — La Musa per-tier item buttons
- `renderRedeemReview` (:397) — applied state
- loading (:381) / error (:387) innerHTML
- the `.acct-rd*` CSS block (:413–:431)

Do **NOT** change: `redeemSelect`, the quote call, `env.onQuoted`, `clearRedeem`, `renderRedeem` dispatch,
`_redeemPending`/`_redeemQuote` gating, or anything pricing. No functions/, no rules.

## ⚠️ FOOTGUN — `.acct-rd` is an OVERLOADED class name
`.acct-rd` is ALSO a plain text label in the account menu rows — DO NOT restyle those by accident:
- `:676`  `.acct-row .acct-rd{font-size:12.5px;color:#B3A594}`
- `:1424` `<span class="acct-rd">Tu progreso y recompensas</span>`
- `:1426` `<span class="acct-rd">Repetí un pedido anterior</span>`

**Required:** either **scope every ticket selector under `#acct-redeem`** (e.g. `#acct-redeem .acct-rd{…}`),
**or** rename the redeem-affordance classes to a fresh prefix (e.g. `.gt-*`) and update ALL the querySelector
onclick hooks accordingly. Prefer the rename for cleanliness. Verify the two menu-row labels are visually
unchanged after your edit.

## Wiring that MUST still fire (test each in the Netlify draft)
- Punch offer: `.acct-rd-btn`.onclick → `_redeemPending={}; redeemSelect(env)` (:358)
- Points tiers: `.acct-rd-tier:not(--off)`.onclick → `renderRedeemItems` (:364)
- Tier items: `.acct-rd-item`.onclick → `redeemSelect` (:375)
- Applied remove: `.acct-rd-x`.onclick → `clearRedeem()` + `env.onQuoted(null)` + re-render (:406)

## States to reproduce in the ticket idiom (all in the mockup)
1. **Offer — punch (X. Pizza):** eyebrow "Tu premio" + hero "Pizza gratis" + **Usar** stub. Keep the existing
   strings (`acct-rd-t` / `acct-rd-d`), just relayout into eyebrow + hero.
2. **Offer — points (La Musa):** eyebrow + "Elegí un nivel" + **Canjear** stub; tier chips
   (`${cost} pts`, disabled `--off`) BELOW the ticket; item buttons under a picked tier.
3. **Loading / error:** the single-line message inside a muted ticket face.
4. **Review (applied, `--on`):** "Premio aplicado" eyebrow + struck name + `GRATIS` / `−L {discount}`;
   **Quitar** on the stub; rotated **"Canjeado"** stamp (as in the mock).

## Color = fixed gold, NOT `CONFIG.accent`
The gold ticket is the brand-neutral rewards identity (same #A9791A gold family cross-surface). Replace the
current `CONFIG.palette.tint/line` + `CONFIG.accent` (icon + Usar button) with the **fixed gold literals from
the mockup — identical in both files** (this *strengthens* parity; no CONFIG divergence). GIFT_SVG icon → gold
ink, not accent. Tokens (light):
- face `linear-gradient(116deg,#e4cd8a 0%,#f3e5b2 22%,#dcc074 44%,#ecdb9e 64%,#e0c37c 100%)`
- ink `#5a3d0c`, ink2 `#7a5410`, keyline `#7a5410`, notch circles = page/screen bg
- sheen: `radial-gradient(120% 120% at 82% -20%,rgba(255,255,255,.6),transparent 45%)` + a diagonal white streak
- Dark-mode tokens: mirror the mockup's `@media (prefers-color-scheme:dark)` + `[data-theme]` handling.

## Font
Wordmark = **system serif stack** (Georgia) — NO new font load. (Self-hosted slab display face is a deferred,
owner-optional polish; not in this build.)

## Flow / gate
1. Build on a branch; **Netlify DRAFT preview both forms** (do not merge).
2. Redemption is **gated OFF pre-flip** (redemption_enabled OFF) → the offer won't render live. **Canary/force
   the offer visible** in the draft so the owner can eyeball every state.
3. **Advisor codex code-gate** (redemption-domain): confirms every onclick still bound+fires, quote/apply/clear/
   onQuoted untouched, the `.acct-row .acct-rd` labels unaffected, parity 4/4, no money-path edit.
4. Owner merges → **forms git-CD both brands, NO functions**.

Relates to: guided-step2 redeem-row relocation (already LIVE), rewards B2 go-live runbook.
