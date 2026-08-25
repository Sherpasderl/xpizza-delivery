# Plan: Phase 1a — Catalog schema, seed, reader, and parity proof
_Locked via grill-with-docs — by Claude + Xavier. Terms per CONTEXT.md. ADR: docs/adr/0005-firestore-catalog-under-restaurants.md_

## Goal

Represent both Restaurants' menu and extras pricing as a Firestore [[Catalog]] under
`restaurants/{restaurant_id}`, and prove — by seeding a real Firestore, reading it back through
real read code, and comparing byte-for-byte against the live in-code price tables — that the
Catalog reproduces today's prices exactly for both Restaurants. Phase 1a is **purely additive**:
the live pricing path is untouched and nothing reads the Catalog. The pricing cutover is Phase 1b,
a separately gated plan.

## Approach

Eight TDD tasks on `feat/phase1a-catalog`, branched from `origin/main`.

1. **Pure transforms** — `catalog/catalog-transform.js`: `codeTablesToCatalogDocs` ⇄
   `buildTablesFromDocs`, lossless and [[Pricing key]]-agnostic (the key is carried verbatim,
   name for X. Pizza, id for La Musa). Price values carried as-is: whole lempiras, never converted.
2. **Transform round-trip unit test** — a cheap regression guard on task 1. Explicitly **not** the
   money proof: the assertion's right-hand side is derived from its left-hand side, so it passes
   even on an all-zero menu. Labelled as such in the plan so no gate mistakes it for parity.
3. **DI'd reader** — `catalog/catalog.js`: `createCatalogReader({ getRestaurantDocs, cacheTtlMs, now })`
   → `getTables(restaurantId)`, returning the same `{ menu, extras }` shapes the code tables expose,
   with a per-Restaurant cache. Caches **only on success**; a missing Catalog raises
   `restaurant_not_found` and real Firestore errors propagate uncached.
4. **Importable seed** — `catalog/seed-catalog-core.js`: `seedCatalog(db, restaurants)` with
   deterministic doc IDs (sanitized hash) and the exact Pricing key in a `key` field, plus
   **stale-doc reconcile** so a re-seed after a rename or removal deletes the old document.
   The profile document is written **last**, after both subcollections commit, so on a *first*
   seed a profile's existence implies a complete one. On a re-seed the profile already exists, so
   completeness there rests on the post-seed verification step (8), not on write order. Profile fields are **allowlisted** (name, tier, active,
   hours, branding) and any other field is rejected at write time — Admin SDK writes bypass
   Firestore rules, so this is the only enforcement that private data never lands on a
   public-read document. `tools/seed-catalog.js` is a thin CLI over it, logging per-Restaurant
   counts, the source git SHA, and a deterministic hash of the price tables.
5. **Firestore rules** — `xpizza-functions/firestore.rules`: `menu_items` and `extras` enumerated
   as public-read, client writes denied, **no recursive wildcard** so unenumerated subcollections
   are denied by default. Wired into `xpizza-functions/firebase.json` with a predeploy guard.
6. **Emulator round-trip — the money proof** — `catalog/catalog-firestore.js` implements the real
   `getRestaurantDocs(db, restaurantId)`, which is the trust boundary: it throws
   `restaurant_not_found` when the profile is absent, throws `catalog_empty` when a known
   Restaurant has no menu items, and **validates every document** — rejecting a missing or
   non-string `key`, a duplicate `key`, and any price that is not a non-negative integer — so
   malformed data can never read back as a plausible success. `test/catalog-parity.emulator.test.js`
   runs seed → real Firestore read → `deepStrictEqual` against the live tables, both Restaurants.
   Must be falsifiable, and the drift case must **rename** a Pricing key — not mutate a price —
   since a mutated price reuses the same hashed doc ID and never exercises the reconcile branch.
7. **Wire the tests into the gates** — the three pure tests into `npm test`; both emulator tests
   into `firestore.predeploy`, so a deploy cannot ship past a failing rules or parity proof.
8. **Post-seed production verification** — `tools/verify-catalog.js`, read-only: after the owner
   runs the seed, it reads the real Firestore Catalog and compares counts, keys and prices against
   `menu-pricing.js`, printing a diff and exiting non-zero on any mismatch. The emulator proves the
   *code*; only this proves the *production seed actually landed*. A required gate step, not optional.

Handback (branch @ SHA, files, test counts, the emulator round-trip result) → advisor audit +
Codex grill → owner enables Firestore, runs the seed, **runs `verify-catalog.js` against production
and confirms it is green**, then deploys the rules.

## Key decisions & tradeoffs

- **Firestore for the Catalog; `restaurants/{restaurant_id}` as the collection.** Recorded in
  [ADR 0005](docs/adr/0005-firestore-catalog-under-restaurants.md). The naming resolves a live
  glossary collision: `CONTEXT.md` defines **Merchant** as Sherpa S. de R.L., the entity that
  *receives* money, so `merchants/{x_pizza}/payouts` would have inverted meaning at the Phase-4
  ledger. `merchants/` stays reserved.
- **The money proof is the emulator round-trip, not the in-memory transform test.** The in-memory
  invariant is `Object.fromEntries(Object.entries(T))` — an identity, unfalsifiable. Only the
  emulator test exercises seed-write, doc IDs, Firestore reads and number coercion, and only it
  can fail on a real bug. This also moves the first execution of real Firestore read code into
  Phase 1a's no-money gate rather than Phase 1b's cutover, which is the point of the 1a/1b split.
- **Rules enumerate rather than wildcard.** `match /{sub=**} { allow read: if true }` would have
  published every future subcollection under `restaurants/{id}` — including the Phase-4 ledger and
  payouts — the moment it was written, with no rules change and no review. A regression assertion
  locks it: `restaurants/x_pizza/payouts/x` must be read- and write-denied.
- **Rules cannot protect the profile document from the seed.** Admin SDK writes bypass Firestore
  rules entirely, so "payout fields must never live on the public-read profile" is unenforceable by
  rules alone. The seed allowlists profile fields and a test locks it — enforcement lives where the
  writes actually happen.
- **The reader signals failure rather than returning empty.** `computeServerTotal` already fails
  closed on unknown keys, so an empty Catalog rejects orders rather than mispricing them — this is
  a diagnosability and availability fix, not a money fix. But `{}` is truthy, so a plausible-empty
  return would cache a non-answer for the full TTL, surface as `unknown menu item: <item>` during
  a Catalog outage, and silently downgrade the existing `unknown restaurant` guard after cutover.
- **The tests are wired into the only gates that exist.** This repo has no CI; `npm test` and
  predeploy hooks are the entire automated surface. An unwired parity proof would establish the
  Catalog was correct once and then decay silently.

## Risks / open questions

- **The Firestore database location is permanent.** It must be created in Native mode at
  `us-central1`, matching all Cloud Functions and RTDB — not the console's common `nam5`
  multi-region default. Unfixable after creation without migrating to a new database. Owner step,
  flagged as irreversible before clicking.
- **The Firestore emulator has never run in this repo.** Tooling is verified present (openjdk 26 at
  `/opt/homebrew/opt/openjdk`, `firebase` CLI, `@firebase/rules-unit-testing@^4`) and ~15
  `emulators:exec --only database` scripts establish the pattern, but `--only firestore` is new.
  **Executor stop-condition: if the emulator will not start, stop and report — do not fake it.**
- **Phase 1b's surface is four consumers, not one:** `computeServerTotal`, `summaryLines`, factura
  `pricedLineItems` (`index.js:695`, `:1100`), and `rewards-redeem-pricing.js` (where a divergence
  hard-rejects already-issued reward canonicals with `discount_mismatch`). The factura consumer
  prints prices on a Void-only SAR document, so **Phase 1b trips the fiscal owner gate**, not only
  the money gate. Recorded in the Phase 1 spec; 1b's runtime parity guard must cover all four.
- **The Catalog schema is currently `{key, price}` only.** Sufficient for 1a and 1b, but Phase 1c
  (forms sourced from the Catalog) will need display name, category, and availability. The seed is
  re-runnable and reconciling, so this is additive later rather than a migration — noted, not blocking.
- **The unversioned seed order is Phase-1a-only.** Writing the profile last is a safe bridge
  *because nothing reads the Catalog yet*. Once a live reader exists, a re-seed briefly deletes
  and rewrites documents underneath it. **Phase 1b precondition:** either no live Catalog reads
  during a seed, or introduce versioned publish semantics (write a new version, flip a pointer).
  Recorded here so 1b cannot inherit this assumption silently.
- **Owner tracks still open, non-blocking:** accountant on the delivery-fee fiscal treatment, and a
  rough commission take-rate for the Phase-4 ledger.

## Out of scope

Phase 1b (server pricing reads the Catalog — the money cutover, runtime parity guard, fallback) ·
1c (forms source their menu from the Catalog) · 1d (retire the code tables, consolidate POS) ·
Restaurant self-serve editing, onboarding, admin console (Phase 3) · ledger and payouts (Phase 4) ·
deploying anything, and running the seed against production — both are controlled owner operations
after the gate.
