# RELAY (advisor → executor) — Portal 2b-2a: shell + auth + READ-ONLY menu load

**Authoritative docs (build to them):**
- Spec: `docs/superpowers/specs/2026-09-07-portal-2b2-menu-editor-design.md`
- Plan: `docs/superpowers/plans/2026-09-07-portal-2b2a-shell-auth-read.md` (7 tasks, TDD, exact code/tests)
- Mock (UX reference for the read-only render): the Sherpa Merchant Portal artifact — advisor will hand over `portal-editor-v3.html` from the session scratchpad for the shell markup/styles.

**Base:** branch off `origin/main` (confirm the current head with the advisor first — `git fetch` + compare). TDD, task-by-task, **LOCAL-ONLY**. Do NOT push/deploy.

**What it is:** the FIRST portal slice — a new multi-tenant `xpizza-portal/` static site where a merchant **owner** logs in (Firebase Auth), the portal resolves their restaurants, loads the live catalog via new **read-only** functions, and renders it. **No catalog writes in this slice.** The editor + publish + instant-86 are later slices (2b-2b/c/d).

**Design status:** spec + plan codex design-grilled → **REVISE** (no blockers) → all 10 findings folded. The corrections below are already in the plan — build them as written, they are the grill's fixes:

**🔒 Non-negotiable invariants (the grill's findings — diff-prove each):**
1. **`getEditableCatalog` is OWNER-ONLY.** Reuse `authorizeCatalogEdit`, then **reject `auth.role !== 'owner'` → 403 `not_owner`**. `authorizeCatalogEdit` grants dispatchers ANY rid (cross-tenant internal staff); a merchant portal read must not accept that path. (Grill #1.)
2. **Read the REAL source doc.** Use `sourceRefOf(fsdb, rid)` (`catalog/source-store.js:31`) = `restaurants/{rid}/meta/source` — the exact doc `editCatalog` CAS-writes (`edit-catalog-handler.js:69,88`). NOT `catalog/meta/source`. (Grill #5.)
3. **Validate on read, fail CLOSED.** Run `validateSource(source, rid)` before returning; on throw → **503**, never render malformed money data as an editable baseline. (Grill #10.)
4. **Correct auth wiring.** `authorizeCatalogEdit` reads owners from **RTDB** → inject `getDatabase()` for `authorize`; use `getFirestore()` only for the source doc. (Grill #4.)
5. **Import the existing `encodeUpdateTime`** from `edit-catalog-handler.js` (export it if module-local) — do NOT create a new codec module. `sourceUpdateTime` must be byte-identical to `editCatalog`'s `baseSourceUpdateTime` (`"seconds.nanoseconds"`, ns padded to 9) so 2b-2c can pass it straight back through the CAS. (Grill #6.)
6. **Restaurant display name is at `restaurants/{rid}/identity`** (`identity.name`), NOT `config/display`. (Grill #3.)
7. **Reverse-index rules guard.** `restaurants/{rid}/owners/{uid}` and `owner_restaurants/{uid}/{rid}` are deny-by-default in `database.rules.json` and written ONLY by the admin `seed-owner` tool. Add the emulator rules test proving customer/non-owner/dispatcher clients are all denied `set` on both. (Grill #2.)
8. **BRAND-AGNOSTIC (HARD).** No `x_pizza`/`la_musa` literal in new code unless it's a config/capability-flag lookup. Tests use `merch_a`/`merch_b`/`any_merchant_3`. Task 7 smoke proves a third config-only merchant renders identically.
9. **Fail modes:** customer token → 403; any read outage → **503**, never 403. Read-only slice — the ONLY new writes are the reverse-index (admin tool) — never money/fiscal.

**Known prerequisite (NOT this slice, do not attempt):** item key-strategy is still hardcoded `rid === 'la_musa' ? id : name` (`form-menu-source.js:109`). Read-only 2b-2a is unaffected. It must move to per-merchant config BEFORE the write slices (2b-2b+) — its own spec/plan later (§9.6).

**Gate (post-build, per task):** advisor source-audit + codex gate (this slice: auth-correctness, tenant isolation, read-only safety, brand-agnostic proof — lighter than the publish slice). Existing 2a/2b-1/catalog/fiscal/rewards suites stay green. → owner deploys (new Netlify site is an owner action; hand back the exact commands, do not run).

**Build TDD, LOCAL-ONLY. Hand back per task. Flag any current-source surprise (as the grill did on the source-ref path / auth tier / identity path) rather than forcing the plan.**
