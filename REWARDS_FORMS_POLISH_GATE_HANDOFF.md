# Handoff to Advisor — `feat/rewards-forms-polish` gate

**Branch:** `feat/rewards-forms-polish` · **tip:** `d1d0c1e` · **base:** `main` · **17 commits** · all draft-previewed via Netlify, **nothing deployed to prod**.

This branch started as UI polish and grew into a full **rewards header/pane redesign + a La Musa tier-economics retune**. It now spans two gate types — please split accordingly.

---

## 1. Scope & which gate

| Part | Files | Gate |
|---|---|---|
| **Money-path config** — La Musa tier retune | `xpizza-functions/rewards-redeem-config.js` (authoritative) + 3 test files + `la-musa-orders/account.js` CONFIG mirror | **Money-gate** (heavier) |
| **Forms UI** — header hero + glass chip + Mis premios panes | `xpizza-orders/{index.html,account.js}` · `la-musa-orders/{index.html,account.js}` · 2 new `hero.jpg` | **codex-on-diff** |

---

## 2. Money-path change (the one needing real scrutiny)

**What:** La Musa redemption tier costs retuned, owner-approved, to fix a non-monotonic ~6% ladder where the top reward was the *worst* deal (L10,500 spend for a L624 dish).

`500 / 1000 / 1500 / 2500 / 3500` → **`300 / 850 / 1400 / 1650 / 2100`** — consistent ~10% value-back (earn is unchanged: 1 pt = L3 spend). Real cost to La Musa ~3% (food cost).

**Key safety calls to verify:**
- **`REDEMPTION_CONFIG_VERSION` deliberately stays `1`.** Redemption is inert (`redemption_enabled` OFF, **zero reservations ever stamped**), so this is pre-launch config *finalization*, not a live-config change — there is no mid-flight redemption to invalidate. Bumping it also (correctly) broke lifecycle-test fixtures that pass `configVersion:1`. Rationale is in the config comment + commit `116b6d5`. **Please confirm you agree with not bumping.**
- Changed **both** the authoritative server config **and** the form CONFIG mirror (they must match or the display drifts from server pricing).
- Earn side untouched; existing point balances unaffected (only redemption cost changed, and nothing has redeemed).

**Verification run:** full `npm test` green · rewards **emulator** suite green (reserve 34 / settle 18 / intake 23, asserting **"reserved 300"** for the new L1) · every hardcoded cost assertion updated (`rewards-redeem-config.test.js`, `rewards-redeem.test.js`, `test/rewards-redeem-intake.emulator.test.js`).

---

## 3. Forms UI (codex-on-diff)

- **Header:** faded per-brand hero photo (2 new committed `hero.jpg`, ~140/233KB) fading seamlessly into the menu; frosted-glass account chip **pinned on paso 1 only** (`body.s1-active` toggled by `showStage`, `z-index:150` above the sticky `.cat-tabs`), collapsing smoothly to a centered avatar on scroll; header-anchored (not viewport-fixed) elsewhere; header border + progress bar removed for the seamless fade.
- **Perf fix:** removed La Musa's sticky `.cat-tabs` `backdrop-filter` (nested-blur scroll jank; near-solid cream bg keeps the pinned cue at zero scroll cost).
- **Mis premios panes** (both brands): serif (Playfair `--display`) counter + intro copy from a new `CONFIG.rewards.paneIntro`; La Musa gets the equal-spaced milestone bar (fills to last reached reward, no slider thumb) + numbered tier list from `CONFIG.rewards.tiers` (added `name` / `desc` per tier).

**Invariants preserved:** `account.js` **byte-identical past CONFIG** (guard green) · `rewards-parity.guard.test.js` OK (4/4) · `<script>` tags balanced both forms · guest path unchanged (no `body.redeem`, no reads).

---

## 4. Deploy plan (owner-executed, post-gate)

**functions** (`rewards-redeem-config.js`) **+ forms** (git-CD). Ships **inert** — `redemption_enabled` stays OFF, so nothing changes for customers until the separate T7 go-live runbook. Redemption's earn side (live) is untouched.

---

## 5. Notes / open judgment calls

- Rewards interactive elements use the **brand accent** (La Musa red / X. Pizza gold), not the mockup's muted gold — owner's call; flag if you'd differ.
- X. Pizza gift cell stays **muted until card-complete** (owner's earlier Batch-B choice), differing from the mockup's always-gold gift.
- Hero images are committed binaries in each form folder (`xpizza-orders/hero.jpg`, `la-musa-orders/hero.jpg`), referenced by CSS `background:url('hero.jpg')`.

---

## 6. Commits (main..HEAD)

```
d1d0c1e space out the milestone bar + refine the tier list (elegant/airier)
0c0290c refine Mis premios tier list + drop the milestone slider thumb
116b6d5 retune La Musa tier ladder to ~10% value-back [MONEY-PATH CONFIG]
09d7558 elegant "Mis premios" pane both brands — serif counter + subtitle + tier list & equal bar
a404556 kill La Musa menu scroll jank (drop sticky cat-tabs backdrop-filter)
eefce7d seamless hero → menu (drop header border + progress bar)
9511103 center the collapsed avatar on the sticky category bar
be8564b smooth animated collapse of the pinned chip
ccf00b6 pinned chip collapses to the avatar circle when scrolled past the hero (paso 1)
1847db2 pinned chip floats above the sticky category bar (z-index 150)
36dfb73 pin account chip on paso 1 only + bigger/more-faded X. Pizza logo
ae51579 keep the account chip header-anchored (not viewport-fixed)
3ceff30 smooth hero fade, less-cropped pizza hero, bigger+faded logos
8d5792d faded hero photo header + frosted-glass account chip (Talkin Tacos style)
f06fa0c centered logo, chip pill in the row below it
c22d611 centered header stack
2b6116e Batch B round-2 tuning — compact chip, xpizza logo bump, slanted pizza glyph
```

**Nothing is merged or deployed** — `d1d0c1e` is ready for your gate. Executor will action any REVISE findings.
