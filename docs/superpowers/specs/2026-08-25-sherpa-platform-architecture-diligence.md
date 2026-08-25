# SPEC — Sherpa Platform: Architecture & Scalability Diligence

**Date:** 2026-08-25 · **Type:** program-level architecture + scalability diligence (de-risk the roadmap BEFORE committing code — owner chose this over building first). **Not an implementation spec** — it maps the model, the reuse, the gaps, the open decisions, and a proposed phasing. Each workstream later gets its own spec → plan → gate. **Governance:** advisor designs + gates, executor builds, owner ships + owns business/legal/financial decisions.

## Vision
Take Sherpa to market as a **last-mile delivery platform** — a regional alternative to the incumbents — that external businesses join for delivery logistics only. The Capacitor customer app ([[live-driver-tracker-eta]] / `2026-08-25-sherpa-app-design.md`) becomes the demand-side of this platform, not a standalone product.

## ⚠️ Terminology (resolves a glossary collision — 2026-08-25, grill-caught)
CONTEXT.md **reserves "Merchant" for Sherpa S. de R.L.** — the single legal payment entity (one RTN/bank/PixelPay). **"Restaurant" = `restaurant_id`** (x_pizza, la_musa), the config layer below; RTDB already uses `/restaurants/{id}`. So in this platform:
- The **catalog / menu / config layer = `restaurants/{restaurant_id}`** (Firestore), matching CONTEXT.md + RTDB. Phase 1 uses this — NOT `merchants/`.
- The **external payee counterparty** introduced by the platform (Tier 2 business Sherpa remits to) needs a **deliberately-chosen, non-colliding term** picked in Phase 3/4 (candidate: **"partner"** or **"vendor"** — NOT "merchant", which would invert meaning at the Phase-4 ledger: `restaurants/{id}/payouts` vs a `merchants/{id}` that CONTEXT.md says is Sherpa). The `merchants/` collection name stays **reserved/unused** until then.
- Where this doc says "platform merchant / merchant onboarding / merchant handheld," read it as the **Tier-2 restaurant/partner** — a label to be finalized in Phase 3/4, never seeded as a `merchants/` collection for the restaurant layer.

## The head start (what already exists, battle-tested with real money)
Most delivery startups die building the **logistics engine**; Sherpa has it, live for ~1 month: dispatch/Torre de Control, driver fleet + native driver app + assignment + live tracking + cash reconciliation, order intake, PixelPay payment rails, WhatsApp comms. And the platform is **already multi-tenant in its bones** — `restaurant_id` routing, per-restaurant menus/pricing/hours/branding ([[la-musa-integration-plan]], [[platform-sot-supabase-retired]]). X. Pizza + La Musa are effectively restaurants #1 and #2 (Restaurant per CONTEXT.md). This initiative **generalizes a working system**, it does not start from zero.

## The two-tier merchant model (owner-scoped 2026-08-25)
- **Tier 1 — Flagship / owned (X. Pizza, La Musa):** the full deep stack — KDS, factura (Sherpa-issued, real CAI), rewards/loyalty, deep order lifecycle. Unchanged.
- **Tier 2 — Platform merchants (external):** Sherpa is **last-mile delivery only**. Integration surface = a **Sherpa-provided handheld device** running a lightweight merchant app: receive order → accept → **print an order/kitchen ticket** → prepare → hand to Sherpa driver. **Explicitly NOT:** no Sherpa-issued factura (merchant owns their own fiscal), no POS integration, no KDS, no menu-sync-from-POS.
- **Why this matters:** Tier 2 removes the two hardest multi-tenant problems up front — **per-merchant fiscal/CAI** (the [[fiscal-representation-owner-gate]] risk) and **POS integration**. The external tier is deliberately thin.

## Reuse vs. new (the honest map)
**Reused as-is (the engine):** dispatch/Torre, driver app + fleet + assignment + live tracking, order intake + rate-limit/dedup, PixelPay payment rails, customer live-tracker + ETA, WhatsApp.
**New subsystems required to be a platform:**
1. **Data-driven merchant model** — merchant config + menu/pricing/hours/branding become **database records**, not hand-synced code (today: "menu = 3 hand-synced sources"). Adding a merchant becomes **data, not an engineering task.** *Foundational — everything else depends on it.* (Bonus: retires existing hand-sync tech debt for Tier 1 too.)
2. **Merchant onboarding** — register → details/location/hours/menu/payout info → verify/approve → go-live. Concierge-assisted first, self-serve later.
3. **Merchant handheld app (Tier 2)** — order receipt + accept/reject + ticket print. Likely Capacitor (reuse driver-app toolchain) on a Sherpa-standardized device ([[driver-oem-power-and-fleet-device]] fleet-device playbook). Simpler than the KDS.
4. **Marketplace payments & payouts** — OPEN DECISION (below). Per-merchant settlement + commission/take-rate.
5. **Marketplace customer app** — the Capacitor app expands from a 2-item picker to real discovery (many restaurants, search, categories, later ratings).
6. **Platform admin/ops** — approve merchants, monitor, support, disputes, merchant/menu management console.

## Scalability & infra review (honest, with verification flags)
- **Today:** Firebase RTDB + Cloud Functions + menu/config in code. Correct for 2 low-volume restaurants; the real-time pieces (orders, dispatch, driver GPS, tracking) are exactly what RTDB is good at.
- **Concern at platform scale:** (a) **merchant/menu/catalog data is relational + queryable** (discovery, search, filtering by cuisine/area/open-now) — a poor fit for RTDB's tree; (b) RTDB has real **concurrency/structure/fan-out limits**; (c) menu-in-code doesn't scale to N self-managed merchants.
- **Proposed direction (the key architectural call to de-risk):** a **split data model** — keep **RTDB for real-time** (orders in flight, dispatch, driver location, tracking — where it shines) and move **merchant/menu/catalog + onboarding + relational/queryable data to Firestore or Postgres**. This isolates the scaling-sensitive, query-heavy data from the real-time hot path.
- **✅ DATA-STORE SPIKE RESOLVED 2026-08-25 (advisor): FIRESTORE for the catalog; RTDB stays real-time.** Rationale (Sherpa-specific): zero new ops surface (native Firebase — same project/Auth/rules/Functions the team has hardened); Cloud Functions+Postgres has the serverless-connection-pooling pain vs Functions+Firestore native; **Supabase already retired** ([[platform-sot-supabase-retired]]) — don't reintroduce hosted Postgres; catalog maps cleanly to Firestore docs; discovery queries via composite indexes. Caveats (not blockers): Firestore weak native text-search → add Algolia/Typesense for customer discovery search LATER; the **Phase-4 LEDGER store decision is DEFERRED to Phase 4** (default Firestore-with-transactions; Postgres ONLY for the ledger if reconciliation/reporting demands — never move the catalog for it). Still open (later, non-blocking): RTDB concurrency load-test + cost modeling at 10×/50×.

## Open decisions (business / legal / regulatory — gate the engineering, owner-owned)
1. **Payments & payouts model — ✅ OWNER DECISION 2026-08-25: OPTION A (Sherpa collects, remits merchants).** Customer pays the full amount (food + delivery) to Sherpa via existing PixelPay rails; Sherpa remits the merchant (food − commission) on a payout cycle and keeps delivery fee + commission. The real-platform model (DoorDash-style): one seamless customer payment, commission captured at source, Sherpa owns the customer relationship. (Rejected: (B) merchant-collects/Sherpa-bills-delivery — simpler regulatory but fragmented UX + weak commission capture; not the platform we're building.)
   **Option A puts three things on the critical path:**
   - **(i) Money subsystem [engineering, heaviest gate]:** a per-merchant **ledger** (each order credits merchant = food − commission; clawback on refund/cancel) + **batch payouts** (transfer balances to merchant banks on a cycle) + **reconciliation** (money-in via PixelPay = payouts + Sherpa revenue, must foot exactly). Strictest codex money gate + full fiscal care.
   - **(ii) PixelPay capability [verifiable — advisor spike]:** does PixelPay offer **marketplace / split-payment / sub-merchant settlement** (routes each merchant's share automatically → much less to build), OR must Sherpa build the ledger + bank payouts itself (collect into one account, track balances, pay out via transfer)? *Verification spike — the #1 technical de-risk.*
   - **(iii) Regulatory — ✅ RESOLVED (owner, 2026-08-25):** Sherpa is categorized as a **SERVICES entity, NOT a financial-services entity** in Honduras; collecting/remitting merchant funds does **not** change that. The money-transmitter/licensing concern **does not apply** — this is not a blocker. (Owner-authoritative on jurisdiction/business categorization.)
   - **(iv) Fiscal — ✅ CONFIRMED (owner, 2026-08-25):** Sherpa issues a **factura for the COMMISSION** collected from each merchant — it is **Sherpa's taxable revenue**. (Tier-2 merchant still owns their own food-receipt fiscal; Sherpa issues no food factura for them.) Minor remaining nuance for the accountant: fiscal treatment of the **customer-facing delivery fee** (also Sherpa service revenue → likely a Sherpa factura). [[fiscal-representation-owner-gate]] applies to any change in what a factura ASSERTS.
   - **(v) PixelPay capability — ✅ RESEARCHED 2026-08-25 (advisor, from PixelPay's SDK service list):** PixelPay is a **single-merchant gateway ONLY** — its entire API is sale/auth/capture/void/status + card tokenization. **NO marketplace, split-payment, sub-merchant, settlement, or payout/disbursement capability.** ⇒ **Sherpa builds the ledger + payouts itself.** Resulting architecture: money IN unchanged (customer → Sherpa's existing PixelPay account); **the LEDGER** (per-merchant balance = Σ(food − commission), clawback on refund/cancel; money-in reconciles to payouts + Sherpa revenue) is the money-critical engineering (strictest codex gate + fiscal care); **money OUT = bank transfers** (PixelPay does no disbursement) which **can start as a MANUAL/BATCH process** (ledger → weekly per-merchant payout report → Sherpa makes transfers → mark paid), with automated payouts (bank API / payout provider) as a LATER enhancement, not a v1 blocker. Standard early-marketplace pattern: gated ledger + manual payouts first. (Sources: docs.pixelpay.com SDK / pub.dev pixelpay_sdk service list.)
2. **Commission / take-rate + merchant contracts.**
3. **Regulatory:** holding/remitting merchant funds (model A) may trigger financial-services obligations in Honduras — legal review.
4. **Per-merchant fiscal:** confirmed — Tier 2 merchants own their own fiscal; Sherpa issues no factura for them (device prints an order ticket, not a fiscal doc). Confirm this holds for the customer's payment receipt too (who is the customer's fiscal counterpart when Sherpa collects? — ties into decision #1).
5. **Driver supply scaling** — recruiting/onboarding drivers for platform volume/geography (existing runbook [[driver-onboarding-runbook]] scales the mechanics; supply strategy is a business item).

## Proposed phasing (sequence TBD with owner after this doc)
- **Phase 0 (this doc):** architecture + scalability diligence + the open decisions resolved (esp. payments model + data-store direction). Includes the verification items above.
- **Phase 1 — Data-driven merchant model:** extract merchant config + menu/pricing/hours/branding from code into the chosen catalog store; server reads it per-merchant. Foundational; also retires Tier-1 hand-sync debt. Money-adjacent (pricing source) → codex-gated.
- **Phase 2 — Merchant handheld app (Tier 2):** Capacitor order-receipt + ticket-print device app.
- **Phase 3 — Onboarding + merchant/admin console:** register → verify → go-live + menu management.
- **Phase 4 — Marketplace payments/payouts:** per the resolved model (gated by legal/PixelPay).
- **Phase 5 — Customer marketplace app:** expand the Capacitor app to real discovery.
- (Phases 2/5 can parallelize once Phase 1 lands; 4 is gated on the business decision.)

## Non-goals / out of scope
- Rewriting the flagship (Tier 1) stack — it stays as-is; the platform generalizes around it.
- POS integration or Sherpa-issued factura for Tier 2 merchants (explicitly excluded).
- Fully-native app rewrite (Capacitor stands — `2026-08-25-sherpa-app-design.md` rationale).
- Building marketplace payments before the business/regulatory decision is made.

## Immediate next actions
1. Owner: direction on the **payments/payouts model** (A vs B vs B-then-A) — unblocks Phase 4 planning and shapes Phase 1's merchant record (payout fields).
2. Advisor: verification spikes — **PixelPay marketplace/split capability**, **RTDB-vs-Firestore/Postgres** for the catalog (small diligence spike, no prod change).
3. On those: pick the Phase-1 data store + write the Phase-1 (data-driven merchant model) spec → plan → gate.
