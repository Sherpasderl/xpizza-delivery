# Plan 4: build notes (deviations and rulings during the build)

These notes sit beside the r3 plan, `2026-10-26-bake-from-published.md` (17d58d99). The plan text lives on the plan branch. This file records, on the build branch, what the build did differently and why. Each entry was raised with the advisor during the build.

## 1. The seed does not author `badge_priority` / `reward_icon` (r3 §2). Advisor: ACCEPTED

r3 §2 says `tools/seed-source-store.js` authors both from the bootstrap literals, "so the first publish after deploy carries them". §8.2 then replaced that route for production with the additive, edit-preserving migration ("never today's whole-source `seedSourceStore`").

Authoring the fields in the seed would also have moved:
- the bootstrap TEXT path (`buildCatalogV2` from the form);
- the goldens it feeds (`choice-badges-noop`, the formData-vs-text parity);
- the committed form bundles.

That is a regression before any data is published.

So:
- `badge_priority` is carried on the STORE path only (`carryStructure('badge_priority', () => undefined)`).
- `reward_icon` rides on the display record verbatim.
- Both fields reach the store by the §8.2 migration alone.

## 2. La Musa's reward-picker icons are in scope (flag 2). Advisor: RULED IN, icons only

r3 §1 inventoried X. Pizza's name-keyed `ICON` map. La Musa's `buildRedeemCatalog` also keys icons by literal, in two places:
- a category → `[section, icon]` `CAT` map;
- a hard-coded `'rice'` for the acompañamientos, which are EXTRAS.

The icons move to the same `reward_icon` field via the reviewed data file:
- on the dish;
- on the extra, for the acompañamientos (`EXTRA_RULES` gains `reward_icon`).

`star` (La Musa's house specials) is a row icon, so the closed set is the sprite minus `check` / `gift` only.

Deleting the literal icon mapping belongs to the GATED last commit. The category→section grouping stays. It is listed as a follow-up below.

## 3. The migration's revision check is a transaction with an explicit comparison (r3 §8.2, step 5)

r3 says "a `lastUpdateTime == revision` precondition, the edit-catalog-handler pattern". The migration replaces the whole document, so the precondition can't simply ride on the write:
- Firestore's `set()` silently ignores `lastUpdateTime`. This was measured against the emulator; see `tools/migrate-catalog-display.js` `upgradeDraftInPlace`.
- `update()` merges, so it can't replace the document.

The migration therefore uses the measured pattern from `upgradeDraftInPlace`: a transaction that re-reads the draft and compares its revision explicitly. A concurrent save produces the named refusal `migrate_menu_structure_moved`, and the CLI then re-reads and re-plans (3 tries). The semantics match r3: a concurrent edit makes the write fail, and nothing is replaced.

## Follow-ups (not in this plan)

- **Reward-picker eligibility and sections are still per-brand literals in `buildRedeemCatalog`:**
  - X. Pizza: `p.cat === 'individual'`.
  - La Musa: membership in `CAT`, the `beer_` exclusion, the section labels, and the `Acompañamientos` extra category.
  - Server-side redemption eligibility is already catalog data (`redeem_eligible_*`). The picker's own grouping is not.
