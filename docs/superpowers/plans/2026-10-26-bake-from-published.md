# Plan 4: Every form shows ONLY the published catalog (bake at build, rebuild on publish, reconcile)

**Status:** PLAN r3, APPROVED once the version-collision ruling (§8.1) is folded in; build only after 7f72757f is on main. r2 (§8) folded in Codex scoped r2: 1 P1, 3 P2, plus the owner's reward-icon ruling (a), 2026-10-26). r1 answered Codex plan r1 (3 P1, 4 P2, 1 P3). The advisor accepted all eight on 2026-10-26: the plan must be COMPLETE under the owner rule, with no deferral of display consumers. Codex FULL.
**Owner rule** (standing 2026-10-20, restated 2026-10-25): the merchant portal's published catalog is the ONE source of truth for every restaurant's menu, with no per-brand fallbacks.

## Problem (chronology corrected, P3)

The 2026-10-25 incident was bootstrap/published drift. Each form's committed baked menu is generated from the in-repo bootstrap: the form literals plus menu-pricing.js, via generate-form-bundle.mjs:36-42 → `catalogSnapshot` → `buildCatalogV2`. The catalog had been republished on 2026-09-16 and never synced back. Since 6fcd7ff2, every form build refuses to ship that drift (form-bundle-live-check).

Two gaps remain:
1. **A publish that lands after a deploy.** The deployed baked menu goes stale until someone redeploys. Nothing rebuilds the form.
2. **Display structures the forms still read from their own literals.** Below, inventoried; Codex reproduced P1-1 with an extra price.

## 1. Display-consumer inventory (both forms, main 6fcd7ff2) and the migration for each

| Consumer | La Musa today | X. Pizza today | Published field | Migration |
|---|---|---|---|---|
| dishes (`MENU`) | bundle, else `FALLBACK_MENU` (:2170) | bundle, else `FALLBACK_MENU` (:1712) | `dishes` | boot from the bake only (§3) |
| categories | bundle, else `FALLBACK_CATEGORIES` (:2171) | derived from dishes | `categories` | bake |
| variant groups | bundle, else `FALLBACK_VARIANT_ITEMS` (:2172) | bundle (:1717) | `variant_items` | bake |
| photos | bundle, else `FALLBACK_HAS_PHOTO` (:2173) | dish `img` | `has_photo` / `img` | bake |
| **options (`EXTRAS`), P1-1** | **literal (:2021)** | **literal (:1792)** | `extras` | **boot from the bake** |
| **option groups per category / per dish** | **literals `EXTRAS_BY_CATEGORY` (:2041), `EXTRAS_BY_ITEM` (:2076)** | **renderer: all categories of `EXTRAS` (:5576)** | `extras_by_category`, `extras_by_item` | **boot from the bake.** X. Pizza reads `extras_by_category`, which it publishes today. |
| **"no options" dishes** | — | **name check `dish.name === 'Nutella'` (:5575)** | dish `extras_policy: 'none'` (already supported, form-group-picker.js:89) | **owner data step:** set `extras_policy` to none on Nutella in the portal. Then delete the name check. The live check compares every dish field, so a deploy without the data step fails. |
| **badges** | **literal `TAG_BADGES` (:1931)** | — | `badges` | **boot from the bake** |
| **badge priority** | **literal `TAG_PRIORITY` (:1939)** | — | **none** (published `badges` arrive in canonical key order) | **catalog addition:** `structure.badge_priority` (an array of badge keys), seeded from today's `TAG_PRIORITY`, carried by public-menu.js `CARRIED_FROM_STRUCTURE` (:103), then baked |
| **pickup / weekend gates, P1-2** | — | bundle, else `FALLBACK_PICKUP_ONLY` / `FALLBACK_WEEKEND_ONLY` (:2598/:2604) | `pickup_only_cats`, `weekend_only_cats` | **bake keeps them.** The check is extended to compare them. |
| **reward-picker icons** | — | **name-keyed `ICON` map in `buildRedeemCatalog` (:3343), fallback `'slice'`** | **dish field `reward_icon` (OWNER RULING (a), 2026-10-26)** | migrated per §8; `buildRedeemCatalog` reads `p.reward_icon \|\| 'slice'`; the map is deleted once the published menu verifiably carries the field |
| branch hours (`HOURS`) | literal | literal | n/a | **out of scope.** Operating hours, not the menu; owned by Sherpa ops. |

After this plan, the literals (`FALLBACK_*`, `EXTRAS`, `EXTRAS_BY_*`, `TAG_BADGES`, `TAG_PRIORITY`, the `ICON` map if (a)) stay in each form file only as the **seed/test bootstrap**. `buildCatalogV2`'s `readLiteral` reads them by name, and the 1c parity gates and seed tests use them. **No runtime code path references them.** A new guard asserts that: it scans each form's runtime for references to these names outside the bootstrap block and fails on any.

## 2. Server additions (functions deploy BEFORE the forms)

- **public-menu.js:** `CARRIED_FROM_STRUCTURE` gains `badge_priority`, plus `reward_icon` if (a) is chosen.
- **Seed:** `tools/seed-source-store.js` authors `badge_priority` (and `reward_icon`) from the bootstrap literals, so the first publish after deploy carries them.
- The public projection is otherwise unchanged. There is still no new customer-facing endpoint or PII, and private catalog paths stay denied (firestore.rules:12).

## 3. Bake (`tools/bake-form-bundle.js --this-form`)

- **Selection:** the same `selectForms` as the live check. The form whose folder is the cwd, through the splice registry; an unregistered folder fails.
- **Fresh read (P2-4):** GET the form's own `PUBLICMENU_URL/menu/<rid>?_bake=<build-start-ms>` with `Cache-Control: no-cache`. `ridFromPath` ignores the query (index.js:7012), and the unique query defeats any intermediary cache. Transport goes through the existing `getJson` (one settle path, inactivity plus total deadline).
- **Envelope contract (P2-5).** Each item below is a named refusal, and a refusal means no file changes plus a non-zero exit, so the build fails and the previous deploy stays live.
  - `rid === <the selected rid>`. A wrong-brand body is refused.
  - `representation_version` is known.
  - `menu.dishes`: a non-empty array; unique, non-empty ids; non-empty names; prices are finite and > 0; each `cat` is in `categories` when the brand authors categories.
  - `variantOf` / `variant_items` reference existing dishes.
  - `extras`: an array, possibly empty; unique ids; finite prices > 0.
  - `extras_by_category` keys are known categories; `extras_by_item` keys are known dishes. Values are known option categories.
  - `pickup_only_cats` / `weekend_only_cats`: arrays of known categories.
  - `badges`: an object of `{cls, label}`. `badge_priority`: badge keys only.
  - These mirror the runtime's `liveMenuPrepare` checks (La Musa index.html:2582-2601), so a bake can never ship what the live apply would refuse.
- **Projection:** the published `menu` minus `identity_id` / `dish_id` / `extra_id`. Every other field is kept verbatim, including `cat`: the weekend gate for NY stays data-driven, as the advisor verified. Identity keys are dropped so pre-apply order payloads stay byte-identical to today; the live apply adds them exactly as now.
- **Splice:** into the build container's index.html via the fail-closed `spliceFormFile`.
- **Form boot (both forms):** every consumer in §1 reads `window.__FORM_MENU_BUNDLE__` before any renderer runs.
  - `EXTRAS`, `EXTRAS_BY_*`, `TAG_BADGES`, `TAG_PRIORITY`, the gates, and `ICON` if (a).
  - The same validated selectors as today's `_okDishes` / `_okCats` etc.
  - An invalid bundle is impossible after a bake, since the build refuses one. If it happens anyway, the form uses its existing `announceMenuBroken` path and waits for the live menu. It never falls back to a literal.
- **Build command** (every registered form): `bake --this-form && stamp && check --this-form`.
  - Bake runs before the stamp, so the build hash covers the bytes actually served.
  - The check is extended to compare `pickup_only_cats`, `weekend_only_cats`, `extras_by_category`, `extras_by_item`, `badges` and `badge_priority`, with the same FAIL/WARN rules.

## 4. Rebuild on publish, and reconcile against what is DEPLOYED (P1-3)

- **Fast path:** `rebakeFormOnMirror` is an `onValueWritten('/catalog_snapshot/{rid}')` trigger, the same event `writeCatalogContextOnMirror` uses (index.js:2808), with no platform retry and `maxInstances: 2`. It POSTs that rid's build hook. It's best-effort, because a successful publish does not guarantee a mirror write (catalog-publish.js:100/:1601).
- **Recovery:** `reconcileFormBundles` is scheduled every 10 minutes with `maxInstances: 1`, the same shape as `reconcileCatalogContexts` (index.js:2819). For every rid in the brand-agnostic registry that has a registered form:
  1. Read the published menu (fresh read, as in §3).
  2. Read the DEPLOYED form: GET each order site's origin from platform-manifest and extract the bundle with `extractBundle`.
  3. Compare them with the extended `compareBundle`.
  4. If they differ and no hook was triggered for that rid in the last 15 minutes, POST its hook and record `{at, attempt}` at `form_rebake/{rid}`.
  5. After three attempts without convergence, raise `form_rebake_stuck {rid, attempts}` and stop retrying until the published version changes. That covers a wrong-branch or wrong-site hook, a failed build, and a failed hook alike.

  It's one mechanism for a missing mirror event, a failed hook, a hook accepted whose build failed, and a duplicate event (the cooldown plus Netlify's build queue). It sits off the publish and money paths: it reads public endpoints and the static site, and writes only its own bookkeeping.
- **Operator repair:** the runbook's form-deploy section adds:
  - read `form_rebake/{rid}`;
  - re-run `form-bundle-live-check.js` against the deployed site;
  - trigger the hook by hand or "Retry deploy" in Netlify;
  - verify the alarm clears.

## 5. Hooks are credentials (P2-6)

- **Config:** `FORM_BUILD_HOOKS` holds JSON `{rid: url}` in the functions env (plain .env, per functions-env-management). It's validated at load:
  - the host must be exactly `api.netlify.com`;
  - the path must be `/build_hooks/<24-hex id>`;
  - anything else is refused with an alarm `form_rebake_bad_hook {rid}`, with no URL in the payload.
- **Requests:**
  - POST with no `trigger_branch`, so the hook's configured branch is used.
  - The owner creates each hook on `main`. The runbook records that, and the reconciler's convergence check proves it end to end.
  - 10 s total deadline. Non-2xx responses are classified as `hook_rejected`; network failures as `hook_unreachable`.
  - URLs are never logged or alarmed; errors carry only the rid and the class.
- **Scrub:** `FORM_BUILD_HOOKS` is added to the credential scrub list (tools/secret-env.js:14), so inherited credentials are removed in tests even without a local .env.
- **Tests:** an injected HTTP client only. The egress guard keeps tests on loopback, and a test asserts zero real hook calls.

## 6. Tests and guards (P2-5, P2-7)

- **Bake unit tests:** loopback server, published-shape bodies built from a REAL catalog build (`buildCatalogV2` + `buildPublicMenu`) plus published-only changes (an added dish, a removed dish, a repriced option, a gate change, a badge priority).
  - Each named refusal in §3 refuses, leaves files byte-unchanged, and exits non-zero. That includes wrong rid, missing collections, duplicate ids, bad prices, dangling category/variant/option references, and malformed gates and badges.
- **Post-bake artifact tests** run in jsdom on the BAKED index.html with the live fetch delayed, then unavailable. They cover both forms and a synthetic third: a temp copy of a form registered under `synthetic_3` in a test-local registry.
  - **Boot:** a repriced dish and a repriced option show the published price before any live fetch (Codex's 162/173 case).
  - **Contents:** an added dish appears; a removed one is absent.
  - **Options and choices:** option groups and "no options" follow the bake; required choices work.
  - **Gates:** pickup and weekend gates apply (NY weekend-only); an 86 still applies from the availability feed.
  - **Checkout:** a reward redemption quotes, and identity/signature behaviour is unchanged.
  - **Later live apply:** a subsequent live apply still upgrades.
  - **Ordering:** bake → stamp → check order, and a changed published menu changes the stamp's build hash.
- **Runtime-literal guard:** no runtime reference to the bootstrap literal names (§1).
- **Trigger and reconciler unit tests** (fake db, injected HTTP, fake clock):
  - a mirror write triggers the hook;
  - no mirror (a publish whose mirror failed) is caught by the reconciler;
  - a failed hook is retried after the cooldown;
  - a hook accepted while the deployed bundle stays stale gives three attempts, then `form_rebake_stuck`, then silence until the version changes;
  - duplicate mirror events trigger one POST per cooldown;
  - a missing hook or bad config raises its alarm and makes no request;
  - URLs never appear in logs or alarms.
- **index.js additions:** the trigger, the reconciler and the export go in ONE delimited block. Its exact inverse, `tools/formbake-inverse.js`, is proven by `formbake-wiring.guard` and reversed FIRST in every index.js chain and fold (the same 25 guard files and 33 entries plan 2 updated). The whole-file pins (identity-record-guards :45) keep their hashes. Each block's inverse restores the bytes; nothing is re-pinned.
- **public-menu.js / seed changes:** their existing pins and inverses get the same treatment, and the money-path pins stay byte-unchanged.
- **Also:** form-source-inventory regen, plus the 2e pins client-form edits re-open; mutation entries for every refusal, the reconciler branches and the runtime-literal guard; the R3 regen, mutation-anchors, and a full `npm test` in the heavy slot.

## 8. r2 additions (Codex scoped r2 and the owner ruling)

**8.1 Register the new fields everywhere a body is checked (P1).** `badge_priority` (structure) and `reward_icon` (dish display field) are added to:
- **the public body contract:** `BODY_CONTRACT` (catalog/public-menu.js:60), so `assertWholeBody` (:81) never 500s the public menu on them. `badge_priority` is an optional string array of badge keys; `reward_icon` is an optional string from a closed set.
- **the representation version (r3 ruling: version collision):** the held public-menu display change 7f72757f (photos + category rename) already claims `'1d.2'`, and it lands FIRST in the next train.
  - Plan 4 is built only after it is on main, rebased onto the integrated main.
  - It advances `REPRESENTATION_VERSION` `'1d.2'` → `'1d.3'`.
  - It MERGES `BODY_CONTRACT`: it keeps 7f72757f's optional photo fields and category-rename validation, and adds `badge_priority` and `reward_icon`.
  - During rollout every consumer accepts `'1d.1'`, `'1d.2'` and `'1d.3'`: the forms' live-menu adapter, the bake contract (§3) and form-bundle-live-check.
  - A combined-body test drives one body carrying photos, a renamed category, `badge_priority` and `reward_icon` through all three paths: serve (`buildPublicMenu` + `assertWholeBody`), bake (§3 contract + splice) and live-apply (`liveMenuPrepare`/commit). Each must accept it, and each field must reach its consumer.
- **the source schema:** `validateSource` (catalog/source-store.js: the structure field list at :51 and the carried fields at :745) gains `badge_priority`; `badge_priority` entries must name declared badges. The dish display schema gains `reward_icon`.
- **tests:** the public-menu body-contract test, the source-store schema tests, and the existing representation-version tests. The money and fingerprint pins stay byte-unchanged, because display fields are not pricing inputs. An existing test already proves that; it gets extended to the new fields.

**8.2 Additive, edit-preserving migration (P2), never today's whole-source `seedSourceStore`.**
- **New CLI `tools/migrate-menu-structure.js`, driven by a reviewed data file** `tools/migrations/2026-10-26-menu-structure.json`. The file is generated from the bootstrap literals by a committed script, then reviewed:
  - `la_musa.structure.badge_priority` = today's `TAG_PRIORITY`;
  - `x_pizza.items[<key>].display.reward_icon` = today's `ICON` map;
  - `x_pizza.items['Nutella'].display.extras_policy = 'none'`.
- **For each rid**, the CLI:
  1. reads `{ source, revision }` with `readSource` (source-store.js:764);
  2. adds ONLY fields that are absent;
  3. treats a field that is present with a DIFFERENT value as a merchant edit: it is preserved and reported, never overwritten;
  4. validates the result with `validateSource`;
  5. writes with a `lastUpdateTime == revision` precondition, the edit-catalog-handler pattern (catalog/edit-catalog-handler.js:14-28). A concurrent edit makes the write fail, and the CLI re-reads and re-plans.
- Its default is a dry-run diff. `--write` is run by the owner, or by the advisor with the owner's approval; never by an executor.
- **Unit tests** (fake Firestore):
  - only absent fields are added;
  - a merchant-edited value survives untouched;
  - a stale revision refuses and writes nothing;
  - a second run is a no-op;
  - an invalid result refuses.
- **Then:** the owner publishes once through the portal. Then verify that `getPublicMenu` for each rid carries `badge_priority`, every mapped `reward_icon`, and Nutella's `extras_policy: 'none'` (a read-only GET plus a script, logged in the hand-back). **Only after that verification** does the forms commit delete the Nutella name check (:5575), the `ICON` map and the runtime use of `TAG_PRIORITY`. The extended form-bundle-live-check makes a deploy before the data is published fail rather than regress.

**8.3 Option maps accept BOTH namespaces (P2).** The bake validator and the extended check accept an `extras_by_category` / `extras_by_item` value that is EITHER a declared option category OR an individual extra key, exactly as source-store's `legalExposureValue` does (source-store.js:415). Both forms' option renderers handle both value kinds; X. Pizza's switches from "all categories of EXTRAS" (:5576) to the published map. Tests render a category-valued entry and an extra-key-valued entry in each form.

**8.4 Live apply covers the newly migrated globals (P2).**
- **Coverage:** `LIVE_MENU_GLOBALS` and the prepare / capture / commit / restore transaction (form apply) extend to `TAG_BADGES` + `TAG_PRIORITY` (La Musa), `EXTRAS_BY_CATEGORY` / `EXTRAS_BY_ITEM` (X. Pizza, which today lists only MENU / EXTRAS / gates / VARIANT_ITEMS, :2197) and the reward icons, which ride on `MENU` as a dish field. `liveMenuPrepare` validates each one with the bake's contract.
- **Tests:**
  - a later publish that changes badges, badge priority, an option map or a reward icon applies live without a reload;
  - a malformed value refuses and rolls back to the last good menu (the existing recovery path);
  - pre-apply, the baked values are shown.

## 7. Rollout order

1. Functions deploy (§2 projection fields, §4 trigger and reconciler, still with no hooks configured).
2. The owner runs (or approves) the §8.2 migration `--write`, publishes once, and the published fields are verified by a read-only check.
3. Forms deploy: the bake and the boot changes, with the extended check.
4. The owner creates the hooks on `main`, and `FORM_BUILD_HOOKS` is set.
5. Verify: publish a harmless change, and within about 2 minutes the deployed bundle equals published. The reconciler stays quiet.

## Owner rulings

Reward-picker icons: (a), a catalog dish field `reward_icon` (DECISIONS.md 2026-10-26).
