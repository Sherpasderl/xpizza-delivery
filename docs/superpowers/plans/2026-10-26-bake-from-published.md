# Plan 4: the form's baked menu comes from the published catalog (bake at build, rebuild on publish)

**Status:** PLAN r1, awaiting the advisor gate. Codex FULL (it touches every form's build and adds a trigger). Owner rule (standing 2026-10-20, restated 2026-10-25): the portal's published catalog is the ONE menu source, with no per-brand fallbacks.

**Problem it closes:** the deployed baked menu is generated from the in-repo bootstrap.
- The chain is generate-form-bundle.mjs:36-42 → `catalogSnapshot` (catalog/generate-form-bundle.js:32-48) → `buildCatalogV2` (catalog/form-menu-source.js:146), which reads the form MENU literal plus menu-pricing.js.
- Since 6fcd7ff2, a build refuses to ship that bootstrap if it drifts (form-bundle-live-check). But a publish that lands AFTER a deploy still leaves the live site stale until a human redeploys. That window caused the 2026-10-25 incident.

## Design

### A. Bake at build time, from the published catalog (every form, via the splice registry)
- **New tool `xpizza-functions/tools/bake-form-bundle.js --this-form`.**
  - It finds the form whose folder is the cwd. That is the same `selectForms` as form-bundle-live-check, which keeps the registry rule and fails on an unregistered folder.
  - It GETs that form's own `PUBLICMENU_URL + /menu/<rid>`, reusing `getJson`: one settle path, inactivity plus total deadline, rejections on truncation or abort.
  - It splices into the build container's `index.html` with the existing fail-closed `spliceFormFile`, which round-trips before it writes. Node built-ins only, as today.
- **Projection:** published `body.menu` → exactly today's bundle key set `{dishes, extras, categories, variant_items, has_photo}`.
  - Identity keys (`identity_id`, `dish_id`, `extra_id`) are DROPPED, so the baked shape and every order payload built before the live menu applies stay byte-identical to today.
  - Once live applies, identity keys arrive exactly as they do now. Gate question: carry them baked instead? That would change pre-apply order payloads, so I recommend no.
- **Build command, for each registered form:** `node ../xpizza-functions/tools/bake-form-bundle.js --this-form && node ../platform/stamp-version.js && node ../xpizza-functions/tools/form-bundle-live-check.js --this-form`.
  - **Bake runs BEFORE the stamp**, so the stamp's build hash covers the bytes actually served.
  - **The check stays last**, as self-verification: it fails only if a publish lands in the seconds between bake and check, and the rebuild trigger re-runs anyway.
  - **Fetch failure:** bake fails → the build fails → the previous deploy stays live. That's the same policy the owner approved for the check.
- **The committed bundle and the bootstrap are relabelled SEED/TEST-ONLY.**
  - `menu-bundle.generated.json`, the committed splice and the form MENU/EXTRAS literals stay for the seed (`tools/seed-source-store`), the 1c parity gates (catalog-form-bundle.test.js:56-62, form-bundle-splice.test.js:21/:117) and the jsdom suites. They are never served once A lands.
  - Header comments in generate-form-bundle.mjs and form-menu-source.js, plus the runbook, say so. The 1c gates stay byte-unchanged, so there is no gate rework.
- **Test pin:** form-bundle-live-check.test.js currently pins the exact command; it moves to the new command. A unit test drives `bake-form-bundle` against a loopback server serving a real published-shape body built from the committed bundle plus identity keys, then asserts:
  - the spliced bundle equals the projection;
  - identity keys are dropped;
  - extra live-only top-level keys are ignored;
  - a malformed or partial body refuses and writes nothing.

  Mutation entries for the projection and each refusal.

### B. Rebuild on publish (closes the post-deploy window, for every brand)
- **New trigger `rebakeFormOnMirror`:** `onValueWritten({ ref: '/catalog_snapshot/{rid}' })`. That's the mirror every publish and rollback writes, the same event `writeCatalogContextOnMirror` uses (index.js:2808). It's its own function, with no platform retry and `maxInstances: 2`.
  - It POSTs the rid's Netlify build hook, so the form rebuilds and re-bakes, and the deployed menu trails a publish by about a build (~1 min).
- **Config, not code:** the hooks live in `FORM_BUILD_HOOKS`, a JSON `{rid: url}` in the functions env (prod env from plain .env, per functions-env-management). The owner creates one hook per form site in the Netlify UI.
  - A rid with no hook logs and raises an alarm `form_rebake_no_hook`, so a new brand without one is visible, not silent.
  - A failed POST raises an alarm `form_rebake_failed` and never throws.
- **Tests:** a unit test with an injected HTTP client proves the POST goes to the rid's hook and to nothing else, that a missing hook raises the alarm, and that a failure is swallowed and alarmed. Mutation entries for each.

## Not covered / follow-ups
- **Phase B, other structures.** The form also reads other display structures from its own literals (`EXTRAS_BY_CATEGORY`/`EXTRAS_BY_ITEM`, `TAG_BADGES`, `PICKUP_ONLY_CATS`/`WEEKEND_ONLY_CATS`). The live apply already replaces some of them (`LIVE_MENU_GLOBALS`). Baking them too completes the one-source rule; that's a separate plan, because it changes what the form reads at boot.
- **x_pizza NY Plain Slice.** After A, the published NY product is baked in, and its weekend-only display then depends on Phase B (the gate literals). Owner question still open: is NY Plain Slice weekend-only?
- **Mid-session publishes (W4).** A publish landing while the customer already has a cart is not addressed by any baking scheme. That's covered by the cart backstop plus the item 5 copy.

## Sequencing
A first; it alone shrinks the window to "since the last build". Then B (functions deploy plus an owner step to create the hooks). Then Phase B as its own plan.
