# La Musa Phase 0 — status brief (executor catch-up)

_As of 2026-06-29. Distilled from the Claude project memory (`lamusa-integration-plan`) + the second-brain log. Read alongside the current task brief (KDS `la_musa` pinning)._

**What Phase 0 was:** make the X. Pizza platform **multi-restaurant-capable** (a config plane) and put X. Pizza on it, with **La Musa seeded but DARK**. The *foundation* — **not** the La Musa launch.

## ✅ LIVE IN PROD (deployed + verified 2026-06-29)
- **Config plane** `/restaurants/{rid}/identity` — RTDB rules (identity authed-read, `factura_config` Admin-only) + seed. `x_pizza` active+valid (hub `15.507489753573818 / -88.0398486953722`, radius 7, v1); **`la_musa` `active:false`, `whatsapp_enabled:false` (DARK)**.
- **Reader** `xpizza-functions/restaurant-config.js` — `getIdentity`: source → 30s warm cache (TTL+version) → **fail-closed 503**; `hubSnapshot` allowlist; `isRoutingValid` (exported, reused by the seed-readiness check).
- **Order intake** (`createOrder` / `chargeOnlineOrder` / `confirmOnlinePayment`) reads `getIdentity` → active-gate (400 if inactive) + delivery zone-check from `identity.delivery_radius_km` + **immutable per-order hub snapshot**. **X. Pizza byte-identical** (golden across 6 combos + full emulator e2e; cutover confirmed live — cash *and* online via PixelPay).
- **3c** confirm-time active-recheck/void (`voided_inactive`); **F3** factura allocator opts non-platform restaurants out → `external_pos` (La Musa carve-out; `x_pizza` exact no-op).
- **Rules** also carry `driver_cash` (additive sibling, driver workstream). **Functions deployed from `main`; all 28 functions, no prune** (driver-native + payment + Phase 0 + F3). Env preserved.
- _(Same day, separate workstream: auto-assign grace-recheck + Fix 1, deployed + smoke-tested green.)_

## 🔒 Locked architecture (the why)
- **ADR-0001:** flat `/orders` + a `restaurant_id` **field** (not nested) — trusted internal tablets.
- **ADR-0002:** config plane = `/restaurants/{id}/identity`; source → 30s cache → fail-closed; **immutable per-order hub snapshot**.
- One merchant (**Sherpa S. de R.L.**), one PixelPay / RTN / bank — per-restaurant P&L is reporting-only `restaurant_id` tagging, **not** a payment-rail split.
- **Factura:** X. Pizza uses the platform factura; **La Musa uses its own Soft Restaurant POS** (F3 carve-out) — we do NOT replicate factura for La Musa.
- Deploy was **seed-first, NO feature flag** (a `use_config_plane` kill-switch was proposed then **abandoned** — fail-open-on-deactivation flaw + adds two live-path mutations to guard a low, already-mitigated risk).

## ⚙️ How we work (governance — unchanged)
Executor proposes → **auditor + Codex gate EVERY step** on the real files → implement → verify read-only → land. **Prime directive: do not break X. Pizza** (byte-identical / no-op). Nothing deploys until gated; **the operator (Xavier) runs all prod commands**; the auditor session has no prod creds and verifies read-only.

## 🛠️ Deploy mechanics worth remembering
- **Deploy functions from `main`** (driver-native + payment + Phase 0 together) — or `firebase deploy --only functions` prunes live functions missing from source → drivers unassignable.
- **Env preserved by deploying from a no-`.env` worktree** (`~/xpizza-lamusa` has only `.env.example`) → Gen2 loads no `.env` → keeps prod secrets. Don't add a real `.env` unless intentionally changing env vars.
- **Rollback = Cloud Run revision revert** (`gcloud run services update-traffic <fn> --to-revisions=<rev>=100`); re-pin fresh revisions before each deploy (a deploy bumps them all).
- Emulator needs a real JDK (`brew install openjdk`, used via `JAVA_HOME=/opt/homebrew/opt/openjdk` + PATH). The emulator harness must use the function's RTDB namespace `xpizza-delivery-default-rtdb` (the function hardcodes that prod `databaseURL` at `index.js:97-98`; `FIREBASE_DATABASE_EMULATOR_HOST` redirects host→local but keeps the ns label).
- **Netlify** ([[netlify-deploy-mechanics]]): per-folder sites, npx-only CLI, repo linked to CATERING → **always pass explicit `--site`** (a wrong-`--site` deploy bit us once).

## 🧭 What's next (remaining before `la_musa.active`)
1. **Consumer phases:** KDS `la_musa` pinning **(CURRENT)** → unified dispatcher → tracker → per-restaurant auto-assign/hub → per-restaurant WhatsApp.
2. **La Musa order-form re-fork** (feature parity with the X. Pizza form; **must write `restaurant_id === 'la_musa'`** — that's what feeds the pinned KDS).
3. **Observability**, then the **`la_musa.active` flip = the actual La Musa launch**.

## ▶️ Current task: KDS `la_musa` pinning (consumer phase 1)
- Hostname pin in `xpizza-kitchen/xpizza-delivery.js`: `KDS_RESTAURANT_ID = location.hostname.includes('lamusakitchendisplay') ? 'la_musa' : 'x_pizza'` (fail-safe default `x_pizza`).
- `restaurant_id` filter in `filterLiveOrders` (the single `/orders` choke point): `x_pizza` legacy-inclusive (`=== 'x_pizza'` OR absent) / `la_musa` strict.
- New Netlify site `lamusakitchendisplay.netlify.app` from the same `xpizza-kitchen` source. **X. Pizza KDS = no-op.**
- Verify no other `/orders` read bypasses `filterLiveOrders` (archive/history views). Scope = KDS order display only (not dispatcher_alerts / dispatch / tracker — later phases).
