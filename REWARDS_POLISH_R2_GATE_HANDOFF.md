# Handoff to Advisor — `feat/rewards-polish-r2` gate

**Branch:** `feat/rewards-polish-r2` · **tip:** `cade6ec` · **base:** `main` (`51ccad7`) · **3 commits** · draft-previewed, **owner signed off both brands on-device**.

**Gate type: codex-on-diff only** — forms-only (both `account.js`, byte-identical past CONFIG). **No money-path change** this round (the La Musa tier retune was in the prior, already-gated branch `feat/rewards-forms-polish`).

## Scope (5 requested items + 2 chip fixes)

1. **[perf bug]** Dropped `backdrop-filter:blur(13px)` on the `position:fixed` pinned chip → solid `rgba(255,255,255,.9)` pill (kept border/shadow). This was the last per-frame viewport-blur re-sample after the cat-tabs one was already removed. **Owner confirmed La Musa scrolls smoothly up + down on-device.** Applied to both brands.
2. **[La Musa · Mis premios]** Reached tier-list number badge: `CONFIG.accent` (La Musa red) → shared warm gold `#A9791A` (La Musa-only render; shared hex keeps parity byte-identical).
3. **[La Musa · Mis premios]** Milestone bar breathing room: `.acct-rw-bar-wrap` padding `38px 12px 34px → 48px 12px 44px`.
4. **[X. Pizza · chip]** Counter now an equal peer to the name: `.acct-chip .acct-rw` `13→14px` (= `.acct-nm`), gift svg `13→15px`.
5. **[X. Pizza · Mis premios]** Static golden glow on the gift cell: `.acct-rw-slot--gift` `box-shadow:0 0 12px rgba(169,121,26,.5)` (no animation; differentiates the reward cell; X. Pizza-only render).

**Chip collapse fix (both brands):** the scroll-collapsed mini chip rendered as a tall oval, then (first attempt) a clipped circle — root cause was `*{box-sizing:border-box}` (global) making a `height:` the *total* box, so `height:29px` left ~21px of content and clipped the 29px avatar. Corrected: `height:37px` (avatar 29 + 6 padding + 2 border; guest avatar 27 → 35px) so the avatar fits exactly with no top/bottom clip; pinned-collapse `top` 6→5px to sit vertically centered on the ~46px category bar. Clean centered circle, smooth horizontal shrink preserved. Owner-confirmed both brands.

## Verification

- `account.js` **byte-identical past CONFIG** (`rewards-parity.guard.test.js` OK, 4/4).
- `node --check` clean both forms.
- Guest path + money path untouched (chip CSS only; no `body.redeem`, no config, no functions).

## Commits (main..HEAD)

```
cade6ec collapsed chip circle — correct border-box height (was clipping the avatar)
cb3d8e3 collapsed pinned chip renders a clean circle (was a tall oval)
fae233a polish r2 — kill pinned-chip blur (scroll perf) + 4 visual tweaks
```

**Nothing merged or deployed** — `cade6ec` is ready for the codex-on-diff gate. Executor will action any REVISE findings.
