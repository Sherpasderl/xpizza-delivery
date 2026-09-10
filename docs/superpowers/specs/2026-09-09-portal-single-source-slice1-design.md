# Portal Single-Source — Initiative Overview (decomposed into 1A–1D)

**Status:** SUPERSEDED as a single slice. The codex design-grill (2026-09-09, 14 findings, BLOCK) showed this is a multi-part initiative, not one slice. It is now decomposed; this document is the initiative overview. Build order (each its own spec → grill → plan → build → money-gate → deploy; portal stays PAUSED for real edits until they ship):
- **1A — Catalog = complete, valid, safe display source** (schema + strict validation + reader + re-seed; pricing values byte-unchanged). Spec: `2026-09-09-portal-single-source-1a-catalog-display-schema-design.md`.
- **1B — Serve it safely** — `getPublicMenu` (dishes AND extras), form live-sources with async-init/fallback contract, safe DOM rendering, cache/CDN contract.
- **1C — Charge == confirmed NET quote** (hardest, hard money-gate) — both `createOrder` AND `chargeOnlineOrder`, net-not-gross, retry/idempotency-safe, checkout confirmation state machine, staged client migration.
- **1D — Compatibility** — KDS structural-change handling + generator/CI parity.

**Reframed core invariant** (grill finding 9): NOT "tile == charge per line, live" (caches + outage ladder make that false) but **"the customer is charged exactly the net total they confirmed"** — tiles are best-effort live display; the confirmed-quote gate (1C) is the money guarantee.

The original single-slice design text is retained below for history.

---

# (HISTORICAL) Slice 1: Customer Single-Source (form live-sources the catalog; charge == confirmed quote)

**Status:** DESIGN — awaiting owner review, then design-grill (codex), then plan → executor build → codex money-gate → owner deploy.
**Date:** 2026-09-09
**Depends on:** nothing from the unmerged 2b-2b portal-editor branch — Slice 1 touches the customer form + serving/pricing functions, not the portal editor. Buildable off `origin/main` (e202e62). (Slice 2, merchant draft governance, is a separate follow-up spec.)

## Goal
A merchant price edit that reaches the live catalog (via the already-deployed `publishEdited`) must reach **what the customer sees**, and the customer must **never be charged a price different from the one they confirmed**. Today the customer form displays a static bundle generated from the *code bootstrap*, not the live catalog, so a portal publish changes what the server charges but not what the form shows — the exact `340-shown / 350-charged` split found in the 2b-2b smoke.

## Non-goals (Slice 2, separate spec)
- Merchant-facing pending-changes indicator, navigate-away guard, and Discard.
- These do not affect customers once Slice 1 lands (a persisted draft only reaches customers via `publishEdited`, which is per-tenant and already gated).

## Root cause (verified from source)
- The form renders `const MENU = window.__FORM_MENU_BUNDLE__.dishes` — a bundle spliced into `xpizza-orders/index.html` by `tools/splice-form-bundle.js`, which regenerates from `catalogSnapshot(rid)` = the **in-memory code bootstrap** (`buildCatalogV2` / `form-menu-source.js`), *not* the live Firestore catalog. So the displayed price is frozen at the last code state, independent of `active_version`.
- The server charges from the live catalog: `createOrder`/`quoteOrder` → `resolvePricingTables(rid)` (catalog-authoritative, `active_version`) → `computeServerTotal`. `createOrder` "NEVER trusts body.total" (index.js:459) — it re-prices independently at order time.
- Consequence: display source (code bootstrap) and charge source (live catalog) are two different things that a portal publish desynchronizes.

## Architecture — one source, read by both display and charge

The **live catalog `active_version`** is the single source. Both the customer's displayed menu and the server's charge derive from it.

### Component 1 — `getPublicMenu(rid)` (new, public, cached)
A public (no-auth) `onRequest` function, `cors: ACCOUNT_ORIGINS` (the customer-form origins — same list as `quoteOrder`), that returns the live display menu:

- Reads the live catalog via the existing display reader `getRestaurantMenu(db, rid)` (catalog-menu.js:80 — the pointer-based reader over `active_version`).
- Produces the **exact bundle shape the form already consumes** by running the existing `generateFormBundle(rid, snapshot)` against that *live* snapshot (not the code bootstrap). Shape: `{ dishes:[{id,cat,name,price,emoji,color,desc,img}], categories, pickup_only_cats, weekend_only_cats }` — byte-shape-identical to today's `__FORM_MENU_BUNDLE__`.
- **Caching:** sets `Cache-Control` for a short edge TTL (proposed 60s) so customer loads hit the CDN, not Firestore per request. A publish is reflected within one TTL. (Menu loads are bounded by customer traffic; this is not the RTDB-egress-scan pattern — it's a single cached read.)
- **Fail behavior:** on live-read failure/timeout, returns a typed error (never a partial/guessed menu). The form treats any non-2xx / network failure as "use the fail-safe" (Component 2). The function itself must never emit a menu it cannot vouch for (same rule as the pricing resolver).

### Component 2 — Form live-sources; embedded bundle demoted to fail-safe
`xpizza-orders/index.html` (and `la-musa-orders/index.html`):
- At load, `fetch(getPublicMenu?rid=…)`; on success, `MENU` is built from the fetched bundle. This mirrors the form's existing live fetches (it already fetches `item_availability` from RTDB and calls `quoteOrder`).
- On failure, **fall back to the embedded `__FORM_MENU_BUNDLE__`** so the menu always renders — never empty, never a spinner-stuck screen.
- The embedded fail-safe bundle is regenerated **from the live catalog** at deploy time (see Component 4), so the fallback is a recent snapshot, not the frozen code bootstrap.
- Availability (86) stays its own instant RTDB channel — unchanged, separate concern.

### Component 3 — `createOrder`: charge == the confirmed quote (the money invariant)
Today `quoteOrder` and `createOrder` each re-price from the live catalog. Within a session they agree unless a publish lands between the customer's confirmed quote and `createOrder` — then `createOrder` would silently charge the new price. Harden:
- The form sends, with the order, the **total the customer last confirmed** (the `quoteOrder` result they saw and accepted) as `confirmed_total` (lempiras, integer).
- `createOrder` still recomputes authoritatively via `computeServerTotal` (never trusts a client price for the *value*), but then **compares its recompute to `confirmed_total`**. If they differ, it **rejects with `price_changed`** and returns the new quote — it does **not** charge. The form re-quotes, shows the customer the new price, and requires an explicit re-confirm before another attempt.
- Net invariant: **the amount charged always equals the amount the customer last saw and confirmed.** A price that moved mid-checkout produces a re-confirm, never a silent divergence. (Applies to the card/charge path in particular; cash orders carry no upfront charge but get the same re-confirm so the printed/stated total matches.)
- Scope note: verify the current `quoteOrder`→`createOrder`→PixelPay amount flow end-to-end and confirm exactly one place computes the charged amount; `confirmed_total` is a gate, not a new pricing source.

### Component 4 — Fix the bundle generator to snapshot the live catalog
`tools/splice-form-bundle.js` currently regenerates from `catalogSnapshot(rid)` (code bootstrap). Change the **deploy-time** bundle generation to snapshot from the live catalog (`generateFormBundle` already supports a `getRestaurantMenu(db, rid)` source per its header). This makes the embedded fail-safe bundle track the live catalog at each form deploy, so display and the fail-safe agree. (This is the fail-safe path; the primary display is the live `getPublicMenu` fetch.)

## Data flow
1. Customer opens form → `fetch(getPublicMenu)` → renders tiles/prices from live `active_version` (or embedded fail-safe on failure).
2. Customer builds cart → form calls `quoteOrder` (re-prices from live catalog) → shows the total; customer confirms.
3. Customer pays → `createOrder` with `confirmed_total` → recomputes from live catalog → **charges iff recompute == confirmed_total**, else `price_changed` → form re-confirms.
4. Tile price, quote, and charge all derive from `active_version` → equal by construction; the confirmed-quote gate closes the mid-session-publish window.

## Error handling
- `getPublicMenu` live-read fails → typed error → form uses embedded fail-safe (menu still renders).
- `getPublicMenu` must never return a price it cannot vouch for (no partial/stale-beyond-guarantee data).
- `createOrder` recompute ≠ `confirmed_total` → `price_changed` + new quote; never a silent charge.
- Missing/malformed `confirmed_total` → treat as no confirmation → require a quote/confirm before charging (fail-closed).

## Testing
- **Display == charge (integration):** a menu built from `getPublicMenu` and the total from `computeServerTotal` for the same cart, against the same `active_version`, produce equal per-item prices — proven by originating both from one seeded catalog version (not hand-built fixtures). Move-the-fact: change a catalog price, re-read both, both follow.
- **Live-source + fail-safe:** `getPublicMenu` success → form renders live prices; simulated fetch failure → form renders the embedded bundle, never empty.
- **Confirmed-quote invariant:** quote at price N, publish N→N+1, `createOrder` with `confirmed_total=N` → `price_changed` (no charge); re-quote → confirm N+1 → charges N+1. And N==N (no change) → charges normally.
- **`getPublicMenu` surface (money-gate):** public read exposes display data only — no write, no auth-bearing data, no draft/`meta/source`, no owner info; CORS is `ACCOUNT_ORIGINS`; caching headers don't leak per-user data.
- **Generator reads live:** the deploy-time bundle regenerated from a seeded live catalog equals what `getPublicMenu` returns for that version.
- **No-regression:** existing `quoteOrder`/`createOrder`/serving-resolver/`publishEdited` behavior unchanged except the additive `confirmed_total` gate; availability channel untouched.

## Money-gate focus (for the closing codex gate)
- `getPublicMenu` is a new public surface — confirm read-only, display-only, no auth/write/draft leakage.
- The `confirmed_total` gate must not become a way to *lower* the charge (client can't send a smaller `confirmed_total` to underpay — the server still recomputes authoritatively and only uses `confirmed_total` to REJECT on mismatch, never to set the price).
- Display==charge holds under a mid-session publish (the re-confirm window).
- Two-brands: no `rid==='x_pizza'` literals in the new paths; both brands read their own `active_version`.

## Open question for review
- **Cache TTL for `getPublicMenu`** (proposed 60s edge TTL). Shorter = fresher display after a publish, more reads; longer = cheaper, staler tiles (charge is still correct via the confirmed-quote gate). 60s means a publish shows on tiles within a minute while the charge is always correct immediately.
