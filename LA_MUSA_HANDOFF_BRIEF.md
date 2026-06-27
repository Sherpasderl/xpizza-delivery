# La Musa → X Pizza Platform — Integration Handoff Brief

_For the session that builds La Musa Gastropub as a 2nd restaurant on the unified platform.
Prepared by the order-form / hosted-payment session, 2026-06-27._

**Start here, in one sentence:** the plan is locked and good, but it was written **2026-06-10, before
hosted payments, driver-native, and factura all landed on `main`** — so read **current `main` first**,
then re-validate the plan's phases against it. The `restaurant_id` field is already threaded through
production (via factura); the **config-plane + per-restaurant pricing/tax are the core remaining build.**

---

## 1. Read these first

### The locked plan (the design) — NOT in git
- `~/Downloads/xpizza-delivery/LA_MUSA_PLAN.md` — 8-phase plan, Codex-approved (5 rounds, 2026-06-10).
- `~/Downloads/xpizza-delivery/LA_MUSA_PLAN-REVIEW-LOG.md` — full review transcript.
- These are **untracked local files** in the main worktree — not on any branch. (Ask the owner to
  commit them to `main` if you want them in-repo; the order-form session offered to.)
- Backstop: Claude memory `lamusa-integration-plan` has the locked decisions distilled.

### Multi-restaurant foundation — on `main`, current
- `CONTEXT.md` — glossary / architecture vocabulary.
- `docs/adr/0001-flat-orders-with-restaurant-id.md` — flat `/orders` + a `restaurant_id` field (NOT nested).
- `docs/adr/0002-config-plane-source-cache-snapshot.md` — config plane = sole source → 30s TTL/version-bounded
  cache → immutable per-order hub snapshot.

### Working precedent — `restaurant_id` is already LIVE (landed AFTER the plan)
The factura integration threads `restaurant_id` through production today — copy its patterns:
- `docs/adr/0003-factura-allocation-lifecycle-and-fail-closed.md`
- `docs/adr/0004-facturas-nested-per-restaurant.md`
- `FACTURA_PLAN.md` + `FACTURA_HANDOFF_BRIEF.md`
- Live in `xpizza-functions/index.js`: `restaurant_id` on every order; `FACTURA_RESTAURANT_ID = 'x_pizza'`
  (commented *"single restaurant until the config-plane migration"* — **that migration is your job**);
  per-restaurant nested facturas.

---

## 2. Current platform state (what changed since the plan)

All live in production on `main` as of 2026-06-27:
- **Hosted card payments (PixelPay) are LIVE** — real charge + refund verified. The 3 server write paths
  the plan targets — `createOrder`, `chargeOnlineOrder`, `materialize` — plus the dispatcher
  `createOrderWithTasks` — are now the **live hosted-payment versions**. Your `restaurant_id` handling
  goes into *these as they stand*.
- **Pricing is still X-Pizza-only.** `MENU_PRICES` is a flat object, `computeServerTotal()` is single-menu,
  and tax is hardcoded `/1.15` (ISV 15% inclusive). → **The plan's #1 item — restaurant-keyed menu + tax —
  is still open.** (The review flagged this as the biggest miss; it's unchanged.)
- **factura is LIVE + restaurant-keyed** → La Musa orders need their own factura config (`restaurant_id`,
  its own CAI/config). Allocation/void are decoupled DB triggers keyed off order state — they'll cover
  La Musa automatically once its orders carry the right `restaurant_id` + config.
- **driver-native (FCM + GPS) is LIVE** — hubs are ~400m apart, so `last_hub` driver bias was dropped from scope.
- **Order form** (`xpizza-orders/index.html`) now carries: RTN-invoice block + cash-change picker (factura),
  plus retry-restore / cart-pill-on-Paso-2 / "Envío Gratis" promo (payment UX). A per-restaurant La Musa
  form inherits all of this.

---

## 3. The core remaining build (plan Phases 0–1)

- **Phase 0** — config plane (ADR-0002) + RTDB rules. The single source for per-restaurant menu/tax/hub/CAI,
  with the 30s-TTL cache + immutable per-order snapshot.
- **Phase 1** — restaurant-key the pricing and the write paths:
  - `MENU_PRICES` / `computeServerTotal()` → restaurant-keyed (else La Musa carts reject).
  - Tax (`/1.15`) → restaurant-keyed.
  - `restaurant_id` handling in all 3 server write paths + `createOrderWithTasks`.
  - Replace the `FACTURA_RESTAURANT_ID = 'x_pizza'` constant with per-order `restaurant_id` from the config plane.
- One merchant / one PixelPay account / one RTN+bank — both restaurants bill through it; per-restaurant
  P&L is **reporting-only `restaurant_id` tagging**, NOT a payment-rail change (locked decision).
- La Musa **never launched** → first-time launch, no parallel-run/cutover; treat blast radius as live.
- La Musa menu prices were finalized 2026-06-10 (source PDFs in `~/Downloads/LaMusa_Menu_Final*.pdf`).

---

## 4. Operational gotchas (you WILL hit these)

- **Firebase browser API key `…daFJXU`** has an HTTP-referrer allowlist — **every app origin must be in it.**
  A missing origin silently blocks only that app's auth (it locked us out of the dashboard for an hour). A new
  La Musa site/origin needs adding.
- **FicoPos gateway header** `x-gw-access-token` (env `PIXELPAY_GW_ACCESS_TOKEN`) is required on **every**
  outbound PixelPay call — their Cloudflare gateway 403s server-to-server requests without it.
- **Netlify**: per-folder sites, CLI is npx-only, repo is linked to *catering* — always pass an explicit
  `--site` (see memory `netlify-deploy-mechanics`).
- **`prod-functions-state`**: any `firebase deploy --only functions` deploys from one codebase and **prunes
  functions missing from source** — it MUST include driver + payment + factura code, or it deletes live
  functions (drivers go unassignable). 28 functions live today.
- **Three concurrent sessions touch `functions/index.js`** — coordinate before editing it (memory
  `parallel-session-file-coordination`); re-sync `main` before starting.

---

## 5. Recommended first move

1. Re-sync `main` (it's moved a lot).
2. Read the live `createOrder` / `chargeOnlineOrder` / `materialize` paths + `computeServerTotal`/`MENU_PRICES`
   + factura's `restaurant_id` usage in `xpizza-functions/index.js`.
3. Re-validate `LA_MUSA_PLAN.md`'s phases against that current reality (some assumptions shifted — e.g. the
   write paths are now hosted-payment-aware).
4. Then build Phase 0 → Phase 1.

The `restaurant_id` plumbing is half-done for you (factura threaded it); the config-plane + per-restaurant
pricing are the substance.
