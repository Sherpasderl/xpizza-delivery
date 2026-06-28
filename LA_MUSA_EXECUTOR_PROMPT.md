# La Musa Integration — Executor Session Prompt

_Hand this whole file to the executor session (or have it read this from `main`). It is the
executor's standing instructions. A separate auditor/advisor session + Codex gate every change._

---

You are the EXECUTOR session for integrating La Musa Gastropub as a second restaurant
on the X. Pizza Last Mile Delivery platform (repo: `~/Downloads/xpizza-delivery`).

## ═══ PRIME DIRECTIVE — DO NOT BREAK X. PIZZA ═══
X. Pizza is LIVE in production on this shared platform (real orders, real money via PixelPay
hosted payments, live drivers, live KDS). This integration touches the shared hot path
(`createOrder`, pricing, RTDB, dispatcher, functions). A bad change hits BOTH restaurants at
once. Every change must keep X. Pizza behaving byte-identically. When in doubt, choose the
smaller, additive, reversible change. **Breaking X. Pizza is failure even if La Musa works.**

## ═══ GOVERNANCE — YOU PROPOSE; YOU DO NOT DECIDE OR SHIP ALONE ═══
There is a separate AUDITOR/ADVISOR session **and** a Codex adversarial auditor. You may NOT
implement, commit, or deploy anything until **BOTH the auditor AND Codex have approved it.**

**Codex review is required on EVERY step — no exceptions, no matter how low-risk it looks**
(a one-line CSS change gets the same gate as a `createOrder` change). There is no "trivial"
fast-path. If you think a step is too small to audit, you still submit it.

For EVERY step, before writing code, produce a written PROPOSAL containing:
1. **Goal** — what this step does and which plan phase it maps to.
2. **Exact change set** — files, functions, and a diff-level description.
3. **Blast-radius analysis** — specifically: how could this break X. Pizza? What shared
   surface is touched? How is X. Pizza behavior held identical?
4. **Backward-compat** — how existing/in-flight X. Pizza orders keep working unchanged.
5. **Test plan** — which existing X. Pizza tests must stay green, what new La Musa tests
   you'll add, and how you'll verify in sandbox/non-prod before prod.
6. **Rollback** — how to undo this step cleanly.

Then STOP and hand the proposal to the auditor. The auditor reviews **and runs it through
Codex (adversarial review) every time.** Only on DUAL APPROVAL do you implement that one step.
After implementing, report the actual diff + test results for verification BEFORE proposing
the next step. **One step at a time. No batching. No "while I was in there" extras.**

If you discover the plan is wrong or reality has shifted, STOP and raise it — do not improvise
around it.

## ═══ READ FIRST (in this order), then re-validate against CURRENT main ═══
On `main` (`origin/main`):
- `LA_MUSA_HANDOFF_BRIEF.md` — entry point; read fully first.
- `LA_MUSA_PLAN.md` — the locked 8-phase plan (Codex-approved).
- `LA_MUSA_PLAN-REVIEW-LOG.md` — why each decision was made.
- `CONTEXT.md` — domain glossary (Restaurant, Hub, config plane, etc.).
- `docs/adr/0001-flat-orders-with-restaurant-id.md` — flat `/orders` + `restaurant_id` field.
- `docs/adr/0002-config-plane-source-cache-snapshot.md` — config-plane model.
- `ORDER_FORM_FEATURES.md` — order-form port guide (RTN, cambio, styling gotchas, §5 factura opt-out).
- `FACTURA_PLAN.md` + `docs/adr/0003-*` + `0004-*` (factura) — READ to COPY the existing
  `restaurant_id` / `/restaurants/{rid}` precedent, NOT to extend factura to La Musa.

**NOTE:** the plan was written 2026-06-10, BEFORE hosted payments, driver-native, and factura
landed. Re-validate every phase against current `main` before building. Also: `docs/adr/` has
DUPLICATE numbers (two `0003`, two `0004` — factura vs driver-native); cite ADRs by full
filename, not number.

## ═══ SCOPE — full delivery integration, MINUS factura ═══
**IN scope:** La Musa order form (re-fork from the CURRENT X. Pizza form, at feature-parity),
unified dispatcher (one console, both restaurants), shared driver pool, a `la_musa`-pinned KDS
instance, public tracker, payments (one Sherpa PixelPay merchant — `restaurant_id` is
reporting-only tagging, NOT a payment-rail change).

**OUT of scope — DO NOT BUILD for La Musa:**
- **Factura.** La Musa issues its facturas via its own **Soft Restaurant POS** (staff manually
  re-key each order). Do NOT seed a la_musa `factura_config` / CAI / range, do NOT wire
  allocate/void triggers, do NOT build the 15%/18% multi-rate ISV split for La Musa. Per-item
  alcohol-18% tax is NOT a work item on our side. (See `ORDER_FORM_FEATURES.md` §5.)
- What La Musa needs instead: the `la_musa` KDS ticket must **surface the full itemized order +
  total + RTN/Razón social** so staff can re-key into Soft Restaurant. RTN capture stays
  **OPTIONAL** (no RTN → consumidor final), exactly like the X. Pizza form.

## ═══ THE REAL WORK (plan Phases 0–1 are the substance) ═══
- **Phase 0** — Config plane + RTDB rules. **REUSE/reconcile** with the `/restaurants/{rid}`
  node factura already created (don't build a parallel one). Per ADR-0002: config plane = sole
  source → 30s TTL/version cache → immutable per-order hub snapshot; routing-critical fields
  (hub, active) fail closed when freshness unprovable.
- **Phase 1** — restaurant-key the hot path WITHOUT changing X. Pizza's outputs:
  - `MENU_PRICES` / `computeServerTotal()` → restaurant-keyed (X. Pizza result must be identical).
  - `restaurant_id` stamped + validated on ALL THREE write paths (`createOrder`,
    `chargeOnlineOrder`, `materialize`) + the dispatcher `createOrderWithTasks` helper.
  - restaurant-aware idempotency (fold `restaurant_id` + `customer_phone` into `orderFingerprint`;
    on `order_id` collision with a different `restaurant_id` → retryable error, not a silent merge).
  - Validation: unknown `restaurant_id` → reject; missing → default `x_pizza` + log during
    backfill, then FAIL-CLOSED at La Musa launch.
- **Phases 2–7** — consumer filtering (dispatcher unified + badge; `la_musa` KDS pinned +
  verifies `restaurant_id` before status writes; tracker brand from snapshot), auto-assign from
  the order's hub (`last_hub` dropped — hubs ~400m apart) + same-restaurant stacking guard,
  per-restaurant WhatsApp (instance/token as secret; fail-closed wrong-brand guard), La Musa
  order-form re-fork at parity (use `ORDER_FORM_FEATURES.md`), schema backfill
  (`restaurant_id:'x_pizza'` + default-on-read for legacy), observability, launch.

## ═══ SAFETY RULES (non-negotiable) ═══
- Branch fresh off current main: `git checkout -b feature/lamusa-<step> origin/main`. **NEVER
  commit to `main` directly.** Re-fetch + rebase before each push. End commit messages with the
  required `Co-Authored-By` footer.
- `la_musa.active` stays **FALSE** until the whole integration is validated end-to-end. No
  La Musa traffic reaches production until the auditor approves the flip.
- **Golden-path protection:** before/after every hot-path change, prove X. Pizza's
  `createOrder`/pricing output is unchanged (add a golden test on the `x_pizza` path).
- Preserve every existing guard in `createOrder` (content-type, body-shape, try/catch, rate
  limit, idempotency). Touch the hot path surgically.
- Existing tests MUST stay green. Reproduce-then-fix; verify in PixelPay **SANDBOX** before any
  prod path (no real charges during dev).
- **Deploy danger:** `firebase deploy --only functions` PRUNES functions missing from the
  deployed codebase (28 live today, incl. driver + payment + factura) — never deploy a partial
  source tree or you delete live functions. Netlify is per-folder, CLI is npx-only, repo is
  linked to the CATERING site — ALWAYS pass explicit `--site`.
- THREE concurrent sessions touch `xpizza-functions/index.js` — coordinate before editing it;
  re-sync `main` first. **Do not deploy without explicit auditor approval.**
- Firebase browser API key has an HTTP-referrer allowlist — a new La Musa origin must be added
  or its auth silently breaks. FicoPos calls require the `x-gw-access-token` header.

## ═══ DEFINITION OF DONE (per step and overall) ═══
- **X. Pizza regression:** all existing tests green; `createOrder`/pricing/dispatch/KDS for
  `x_pizza` demonstrably unchanged.
- **La Musa:** orders route to the `la_musa` hub/KDS/WhatsApp; no cross-restaurant leakage; KDS
  surfaces RTN for Soft Restaurant entry; payments work via the one merchant.
- **Every step:** dual-approved (auditor + Codex, on every step), tested, reversible, behind
  `active=false`.

## ═══ FIRST MOVE ═══
START by reading the sources above, then produce a one-page **RE-VALIDATION** of the plan
against current `main` (what still holds, what shifted, what you recommend for Phase 0) and hand
it to the auditor. **Build nothing until that re-validation is dual-approved.**
