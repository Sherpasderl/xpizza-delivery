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

## 4. Resolving an r3 gap: the committed bundle takes the PUBLISHED shape. Advisor: APPROVED (A)

r3 §3 boots every form consumer from `window.__FORM_MENU_BUNDLE__` and never from a literal. But the bundle each form COMMITS was the generator's output, which excludes the structure-carried `extras_by_category`, `extras_by_item`, `badges` and `badge_priority`. Every harness test, golden and local run boots that committed bundle, so they would have lost La Musa's option groups and badges.

Resolution: ONE composer, `composeServedMenu` in `catalog/public-menu.js` (the generator's bundle plus `CARRIED_FROM_STRUCTURE`).
- `buildPublicMenu` serves it.
- `generate-form-bundle.mjs`, `tools/splice-form-bundle.js` and the 1c gates compose the committed bundle with it.

Proofs:
- `buildPublicMenu`'s body is unchanged for every rid, before and after the extraction. Checked on the real published fixtures, both brands, with and without the migrated fields, comparing the body with the per-publish random identity tokens stripped.
- `catalog-form-bundle.test.js` §2b pins the composed fields VALUE-EQUAL to today's literals: La Musa's `EXTRAS_BY_*` and `TAG_BADGES`, and X. Pizza's every-category map. The generator's fields are unchanged.
- All 92 repo-root form tests in the npm chain, goldens included, pass on the reshaped committed forms.

## 5. Dispatcher copy for the rebuild alarms. Advisor: FOLLOW-UP + ACTIVATION PREREQUISITE

The `payment_form_rebake_{stuck,bad_hook,missing_hook}` alerts reach the desktop Torre through `paymentAlert`. With no case in `alertContent`, they render through the unknown-type fallback as «Alerta — form rebake stuck»: English, with no restaurant named and no action. This is not payment copy (category «otros»), but it is not acceptable dispatcher copy either.
- **Follow-up (the dispatch lane, owner mockup):** Spanish title and detail for the three types, naming the restaurant and giving the action.
- **ACTIVATION PREREQUISITE:** `FORM_BUILD_HOOKS` stays UNSET, so the feature stays dormant, until that dispatch copy ships.

## 6. The GATED commit moves the in-repo BOOTSTRAP to post-migration data. Advisor: APPROVED (G1)

Deleting the literal mappings alone left two real gaps:
1. The committed (pre-bake) forms carried no migration data. Nutella offered all 14 extras, and La Musa chose no badge.
2. `catalog/exposure-source.js` DERIVED the catalog's Nutella exclusion by scanning the form's `dish.name === 'Nutella'` check.

G1 closes both from ONE source, the reviewed data file:
- `catalog/menu-structure-rows.js` `applyBootstrapRows` is applied ADDITIVELY by buildCatalogV2's text path and by `seed-source-store`. A row naming a record the bootstrap lacks is `bootstrap_rows_drift`.
- La Musa's `badge_priority` arrives on the text path from the rows.
- The exposure's "no options" = dishes whose `extras_policy` is `'none'`. The exclusion travels with the dish: a rename keeps it, lifting the policy drops it. The guard now asserts the renderer compares NO dish name.
- No form literal duplicates the data.

Goldens and pins that moved, each for one reason (the bootstrap now carries the reviewed rows):
- `catalog/choice-badges-noop.golden.json`, re-captured HONESTLY:
  1. on the original tree (5b, `b1000b7a`, a throwaway worktree), a capture reproduces the committed golden byte for byte;
  2. on the GATED tree, the same five artifacts × both brands with ONLY the reviewed rows' fields stripped hash identically to that golden, so the rows are the whole delta;
  3. then the GATED tree is captured.
- The 1c parity pins compare against the literal plus the rows (`withBootstrapRows`, the same function):
  - `catalog-form-bundle` §1/§2/§2b;
  - `form-bundle-splice` §2;
  - `catalog-menu` §5;
  - `migration-parity` 6c / the deployed-records cell;
  - `form-data-path`.
- `catalog/source-store.test.js`: the seed's field contract gains `items[].display.{extras_policy,reward_icon}`, `extras[].display.reward_icon` and `structure.badge_priority[ ]`. The pinned counts become x_pizza 49/215/133 and la_musa 72/309/207. The "delete every badge definition" cell drops the priority with its definitions.
- `catalog/renderer-contract.test.js`: the badge-free fixture drops `badge_priority` with the badges.
- `catalog/plan4-display-fields.test.js`: the seed now carries the reviewed priority, pinned equal to the data file.
- Mutants: `task8-14` is RETIRED (the name-list missing-item check no longer exists by design) and replaced by fb-71 (the exclusion follows `extras_policy`); fb-72..74 added; fb-4/66/67 re-anchored.

The GATED commit lands ONLY after the owner's migration `--write`, the one publish, and the read-only verification.
