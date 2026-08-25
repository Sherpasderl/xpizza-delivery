---
status: accepted
date: 2026-08-25
---

# Catalog lives in Firestore, under `restaurants/{restaurant_id}`

The platform needs merchant menus and prices to become data rather than hand-synced code
(today a menu lives in three places: `menu-pricing.js`, each order form's `MENU` const, and
the POS `pos-menu.json`). We are introducing **Firestore** for the [[Catalog]] while RTDB
stays the real-time store for orders, dispatch, driver location and tracking — and the
Catalog's Firestore collection is named **`restaurants/{restaurant_id}`**, matching both
RTDB's existing `/restaurants/{id}` tree and the `Restaurant` term in `CONTEXT.md`.

## Considered options

**Store — Firestore vs. Postgres vs. staying in RTDB.** Catalog data is relational and
query-heavy (discovery, search, filter by cuisine/area/open-now), which is a poor fit for
RTDB's tree, and menu-in-code does not scale to N self-managed restaurants. Postgres was
rejected on operational grounds: Cloud Functions + Postgres brings serverless connection
pooling pain, and hosted Postgres (Supabase) was *already retired* from this project once —
reintroducing it would undo a deliberate simplification. Firestore adds zero new ops surface:
same Firebase project, Auth, rules and Functions the team has already hardened.
Accepted caveat: Firestore has weak native text search, so customer-facing discovery search
will need Algolia/Typesense later. The Phase-4 ledger store is a *separate* decision, deliberately
deferred — and the Catalog does not move for it.

**Collection name — `restaurants/` vs. `merchants/`.** The program docs had drifted into
calling a selling business a "merchant." `CONTEXT.md` defines **Merchant** as Sherpa S. de R.L.,
the single legal payment entity — the party that *receives* money. Naming the Catalog collection
`merchants/{x_pizza}` would have made `merchants/{id}/payouts` mean the opposite thing depending
on which glossary the reader had in mind, precisely at the money layer, and a Firestore collection
name is effectively permanent once it is seeded, referenced by security rules, and read by the
pricing path. `restaurants/` was chosen so one entity has one name across both databases.
`merchants/` stays reserved and unused; the external party the platform will remit to gets its
own deliberately non-colliding term when that concept actually arrives.

## Consequences

- Two databases, one project. Anyone reasoning about `/restaurants/{id}` must now ask *which*
  store — and the two have deliberately different security postures: RTDB's is auth-gated with
  `factura_config` pinned Admin-SDK-only, Firestore's Catalog is public-read on an enumerated
  set of subcollections. Firestore rules therefore enumerate `menu_items` and `extras`
  explicitly and use **no recursive wildcard**, so future subcollections (payouts, ledger) are
  denied by default rather than published by accident.
- The Firestore database's **location is permanent**. It must be created in Native mode at
  `us-central1` — matching every Cloud Function and RTDB — not the console's common `nam5`
  multi-region default. This cannot be changed after creation.
- Migration is expand-contract and gated per step: the Catalog is seeded and proven against the
  code tables before anything reads it, the pricing cutover is a separate phase with a runtime
  parity guard and fallback, and the code tables are retired only once the Catalog is stable.
