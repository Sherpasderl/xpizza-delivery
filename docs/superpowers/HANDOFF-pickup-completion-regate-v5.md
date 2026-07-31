# HANDOFF → AUDITOR: pickup-completion v5 — codex DESIGN re-gate (FINAL CONFIRM)

**Written:** 2026-07-31 (executor). v4-regate REVISE found 3 more (`queryPaymentStatus`, SDK live-filter, `claim-order`) — all in the **status Set/list-membership** class my equality-only greps had missed. v5 ran BOTH grep classes across every surface and bucketed the complete set. **Action:** codex re-gate v5 as the **final confirmation** — prove completeness or find the (unlikely) next one. **VERDICT: APPROVED / REVISE.** Money-adjacent (rewards hole) — but money/delivery have verified sound 4× ; this pass is primarily completeness.

## ⚠ RUN ON THIS BASE
- **Branch `feat/pickup-completion`** (off `origin/main` `c09fe12`). **Spec:** `docs/superpowers/specs/2026-07-31-pickup-order-completion-design.md` (commit `574d39d`).
- Sanity-gate: `git rev-parse --short HEAD` ≥ `574d39d`; `grep -c settleRedemptionAtConfirm xpizza-functions/index.js` > 0. Line numbers main-accurate; verify by logic.
- `~/.npm-global/bin/codex exec -c sandbox_mode="read-only" "$PROMPT" </dev/null` from repo root.

## Design (unchanged since v4): KDS Completar on `order_type==='pickup'` → `setOrderStatus(id,'completed')`; wire `completed` into every terminal/active consumer; earn+consume already wired; delivery/driver byte-untouched; `delivered` stays delivery-only.

## THE JOB — completeness confirmation (this is why v1–v4 kept finding more; v5 claims closure)

**1. Run BOTH grep classes independently and reconcile against spec §3.** The recurring misses came from only one class being run. Do both, over `xpizza-functions/*`, `xpizza-dispatch`/`-dashboard`/`-kitchen`/`-track`, `xpizza-orders`/`la-musa-orders`, and `xpizza-delivery.js`/`order-filter.js`:
   - **(a) Equality branches:** `=== 'delivered'`, `!== 'delivered'`, `=== 'cancelled'`, status ternaries/switches (`statusBucket`, `orderStatusPill`, estado map, tracker steps, detail pills, close labels).
   - **(b) Set/array/`includes()` membership:** `new Set([… 'delivered' …])`, `['delivered','cancelled'].includes(o.status)`, `*_STATUSES`, `TERMINAL`/`ACTIVE`/`done`/paid-status lists, `NON_LIVE_ORDER_STATUSES`.
   Every hit must land in exactly one §3 bucket (FIX §3A / LEAVE §3B / ALREADY-HANDLES §3C). **Any unbucketed consumer → REVISE. If none → state explicitly: the matrix is complete.**

**2. Confirm the v5 additions:**
   - **F2** (`queryPaymentStatus` :1569): adding `'completed'` to the paid-list correctly makes a `completed` order (esp. **cash**, where `payment_status !== 'confirmed'`) read `state:'paid'` — and is a no-op / safe for online orders. Confirm nothing else in `queryPaymentStatus` mis-handles `completed`.
   - **SDK LEAVE decision** (`NON_LIVE_ORDER_STATUSES`): confirm `completed` staying **live** (like `delivered`) is correct — i.e. keeping `completed` orders in `allOrders` is REQUIRED by the display consumers (dispatch closed-list DI1, dashboard stats D3–D6), and no "live order" path treats a live `completed` order as active/needing-action after the §3A fixes. Confirm the 5-copy byte-identical SDK is genuinely untouched.
   - **claim-order.js** correctly ALREADY-HANDLES via `shouldEarnOnStatus`.

**3. Spot-confirm the load-bearing §3A fixes** (right site/edit): D1 [money] cancel-gate, K2 estado→Archivado, DI2 closed count, T1–T3 tracker, A1/A2 pill, F1 inbound filter. Confirm **F1+F2 are the ONLY functions logic changes**.

**4. Money & delivery (quick re-confirm — sound 4×):** `completed` reaches earn+consume for a driverless pickup, idempotent (`earn_${orderId}` + state-machine consume + `sweepConsumeRecovery`) under re-tap AND backfill; cancel/reversal blocks `completed`; delivery/driver SDK byte-untouched; §3C already-handles claims hold.

## OUTPUT
VERDICT APPROVED/REVISE + findings. **#1 priority: is §3 the COMPLETE set** (run BOTH grep classes; name any unbucketed consumer, else confirm complete). If APPROVED → writing-plans → build (15 client sites + F1/F2 + backfill) → codex-on-diff money-gate → deploy (KDS ×2, dashboard, track, orders ×2, functions), folded into the rewards launch.
