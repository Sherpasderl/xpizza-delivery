# Contract note: category `name` and `photos` on the public menu

**Date:** 2026-10-24
**Status:** PLAN-public-menu-display r2, Codex-approved.
**Consumer:** the new customer app.
**Served by:** `getPublicMenu` (`/menu/<rid>`), from representation `1d.2`.

Both fields are **additive**, and both form files are byte-identical. What the two live order forms do with them:
- **`photos`:** both forms ignore it.
- **Category `name`:** x_pizza's form ignores it.
- **La Musa's form renders category names** in its tabs and section headings. So a La Musa rename **does** change its live page: the new label shows. That is the intended effect of a rename.

`public-menu-display-noop.test.mjs` proves page-level that adding `photos` (both forms) and adding x_pizza's names changes nothing. La Musa's names are already present and unchanged in that test, so it does not prove a no-op for a La Musa rename.

## `menu.categories[].name`: the category's display name
- **What it is:** a non-empty string authored in the catalog.
- **Who edits it:** the merchant edits it in the portal. Only `name` may change on an existing category; the id, the order, the count and every other field stay frozen (`compareToActive`, `catalog/add-product.js`).
- **Rename rules:**
  - A rename is published on its own: a draft that renames may change nothing else (`rename_not_alone`).
  - The reviewed diff shows it as a `category` line.
  - An x_pizza rename needs the owner's fiscal acknowledgement, like every other x_pizza menu edit.
- **Guarantee: QUALIFIED until the backfill.**
  - Names are *required* where the brand's renderer prints them (la_musa today). Where they are optional (x_pizza today), they are *all-or-nothing*.
  - "Every served category carries a `name`" becomes universal only after (i) the owner names x_pizza's categories and (ii) the follow-up required-name gate lands.
  - **Until then a consumer must tolerate a category without `name`.** It shows no label, never the raw id.
- **Enforced at write and publish, never at serve.** A serve-time requirement would take the live forms down over a label they don't render.

## `menu.photos`: absolute dish photo URLs
- **Shape:** `{ "<String(dish.id)>": { "card": "<https URL>", "hero": "<https URL>" } }`.
  - It is keyed by the served dish `id` as a string. That id is unique per brand, and the client already holds it.
  - Only dishes with a photo appear.
- **A separate top-level field, never on a dish record.** The forms' cart serializes whole dish records into the order and its fingerprints, so the dish records are untouched.
- **One rule, keyed on catalog data rather than the restaurant** (`catalog/public-photos.js`):
  - a plain relative `display.img` gives `card = hero = base + img`;
  - otherwise `has_photo` gives `base + images/<key>-card.webp` and `-hero.webp`;
  - otherwise the dish is absent;
  - an `img` that is not a plain relative path is skipped, never emitted.
- **The base** is the brand's order-site origin + `/`, taken from the platform manifest (`platform/sites.json`): the one `orders` deployment for the restaurant, with its one exact https origin.
- **Optional and degrade-only.** With no base, an ambiguous manifest or any error, the field is **absent** and the rest of the body is identical. A consumer must tolerate its absence, and a dish missing from it, by showing its colour tile.
- **In the etag.** A change of photos or base changes the cache key.
- **Residual:** the photos live on the order sites. Before an order deployment is retired, its photos must move. That is a server-only change to where the base comes from, with no client release.

## Enforcement
- **Category rename:**
  - `catalog/category-rename.test.js`: the comparison, the validator and the diff/token;
  - `catalog/category-rename-flow.test.js`: save → diff/token → publish → served, plus the stale-token, `catalog.publish` and fiscal-gate refusals.
- **Photos:** `catalog/public-photos.test.js` covers:
  - the base;
  - the rule;
  - degrade-only serving;
  - the etag;
  - the `1d.2` marker;
  - a census that every emitted URL is a committed file on its brand's order site.
- **The live forms:** `public-menu-display-noop.test.mjs` serves each real form page the body with and without both fields. The committed globals, the painted page, the createOrder/quote bodies and the quote fingerprint must be identical, a renamed dish must move them, and the form files must be byte-identical.
