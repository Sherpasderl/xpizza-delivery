# resolveManualReconciliation — atomic claim + honest contract (PLAN rev-5)

_Server money-path fix; fast-follow to the dispatch Reconciliación panel (`9a8f6a1`). Executor build for
the auditor + Codex gate. **rev-5 folds the final R4 pre-claim-window finding on top of R3's 4 + R2 + rev-2's 15.**
Propose-first. Touches LIVE payment automation (X. Pizza + La Musa). Codex thread 019f2e15._

## Meta-principles (why the design settled here)
- **R3:** the paid-evidence check is **ATOMIC with the terminal write** (a claim-id + `paid_during_resolve` CAS),
  never a separate re-read; `abandoned`/`cancelled` must STILL catch a late paid callback; no terminal is written
  on absence-of-evidence (no-UUID refund ≠ "refunded").
- **🔴 R4 (the architectural one):** `isClosedToPaymentAutomation` conflated **two** concerns — "don't
  re-flag/sweep this order" (correct for `manual_reconciliation`/`resolving_*`) vs. "ignore incoming paid money
  evidence" (**NEVER** correct). **Paid callbacks must persist evidence in EVERY state**; the predicate gates
  ONLY status-changing automation, never evidence-capture. The last uncovered window was a paid callback while
  the order sits in `manual_reconciliation` *before* any dispatcher claims — skipped → UUID lost → a later abandon
  closes a paid order with no trace.

## The bug
`index.js:1296–1300` reads `payment_status`, guards `=== 'manual_reconciliation'`, THEN mutates (1307+) —
non-atomic → two resolvers interleave → refunded-but-live, or materialized-then-voided.

## Money state machine (rev-3 — the spine)
```
manual_reconciliation
   │  claim tx (whole node): payment_status=resolving_<action>, resolving_claim_id, resolving_claimed_at, resolving_phase='claimed'
   ▼
resolving_<action>  [phase: claimed]           ← pre-money: releaseClaim/revert is SAFE
   │  resolver RE-READS for paid evidence (payment_uuid / paid_during_resolve)   [R2-#1]
   │  stamp resolving_phase='side_effect_started', side_effect_started_at   BEFORE any PixelPay call   [R2-#2]
   ▼
resolving_<action>  [phase: side_effect_started] ← post-money: NEVER revert; converge terminal or refund_pending
   ▼
terminal: abandoned | refunded | confirmed(materialized)   (or durable refund_pending / manual_review)
   │
   └─ [R3-#2] a LATE paid callback on abandoned/cancelled → record evidence + → refund_pending/manual_review + alert
              (abandoned is NOT absorbing against paid evidence — money was taken, must refund)
```
Two invariants rev-4 enforces: **(i)** a terminal money write is a CAS that atomically re-checks paid-evidence +
claim-id (no read-then-write gap); **(ii)** a paid callback is honored no matter WHEN it lands — during
`resolving_*` OR after the order already reached `abandoned`/`cancelled`.

## A. The claim (atomic, crash-recoverable, null-safe, landed-verified)
- **[#3]** One transaction on the WHOLE `orders/{id}` node: when `payment_status === 'manual_reconciliation'`,
  stamp `payment_status=resolving_<action>` + `resolving_action` + `resolving_claimed_at` + `resolving_claim_id`
  (uuid) + `resolving_phase='claimed'`.
- **[#1]** Null-first-safe: `if (cur === null) return null;` (force server read; don't abort-on-null).
- **[R2-#4] Verify the claim LANDED** — a deleted/missing order commits a `null` no-op with `tx.committed === true`
  but nothing claimed. After the tx REQUIRE
  `tx.snapshot.val()?.resolving_claim_id === claimId && payment_status === 'resolving_'+action` → else **409/404**.
- Loser (cur ≠ manual_reconciliation) → abort → **409**. `keep` = no claim.

## B. `resolving_*` consumers — the ONE predicate, but webhooks RECORD money evidence (not just skip)
- **[#2/#12/#13 + 🔴 R4] The predicate gates STATUS-CHANGING automation ONLY — never evidence capture.**
  `isStatusChangeClosedToAutomation(ps)` (true for `resolving_*` + terminals + `manual_reconciliation`) is applied in
  `sweepStalePending`, `confirmOnlinePayment` (:33), `cancelPaidOrder`, `reconcilePayments` breach-checks → they
  **skip/409** (don't re-flag/sweep/auto-transition). **Paid-evidence capture (the webhooks) is a SEPARATE path that
  runs in EVERY state** — see below. (R4 fixed the conflation: the predicate must not suppress incoming money evidence.)
- **[🔴 R2-#1] Both PixelPay webhooks are the EXCEPTION.** A **paid** callback arriving during `resolving_*` is
  **money evidence**, not noise — skipping it lets `resolving_abandon` close a PAID order or `resolving_refund`
  lose the UUID. On a **paid** callback while `resolving_*`: durably persist the evidence (below) — do NOT run the
  normal materialize (the resolver owns/converges). Non-paid callback during `resolving_*` → skip.
- **[🔴 R3-#4] Evidence write is ONE atomic multi-location update** (a crash between two writes must not strand
  UUID-without-flag or vice-versa):
  ```js
  await db.ref().update({                                   // after verifying attempt↔order binding
    [`payment_attempts/${aid}/payment_uuid`]: uuid,
    [`payment_attempts/${aid}/capture_verified`]: true,
    [`orders/${orderId}/paid_during_resolve`]: true,
  });                                                        // return 2xx only after this commits
  ```
- **[🔴 R3-#2] A paid callback on an ALREADY-`abandoned`/`cancelled` manual-resolve order MUST NOT be skipped**
  (the R2 predicate would drop it as "closed" → paid-but-abandoned, money kept, no trace). Instead: record the
  same atomic evidence + **converge `abandoned`/`cancelled` → `refund_pending`/`manual_review` + paymentAlert**
  (the customer paid; we must refund). `abandoned` is not absorbing against paid evidence.
- **[🔴 R4] A paid callback while the order is in `manual_reconciliation` (pre-claim) MUST NOT be skipped either.**
  Persist the same atomic evidence (`payment_uuid` + `capture_verified` + `paid_during_resolve`) **without changing
  `payment_status`** (it stays in the reconciliation queue), 2xx only after commit. The resolver's claim paths then
  treat this pre-existing evidence exactly like `paid_during_resolve` (abort abandon; refund uses the UUID).
- **Net rule:** on a **paid** callback, persist evidence atomically in ANY state; only the `payment_status`
  transition varies — normal→materialize, `resolving_*`→resolver-owns, `manual_reconciliation`→unchanged (queued),
  `abandoned`/`cancelled`→converge to refund_pending. A **non-paid** callback follows the predicate (skip if closed).

## C. Resolver side effects — re-read, phase-stamp, never-revert-after-money
- **[🔴 R3-#1] Abandon terminal write is a CAS, not a read-then-write.** The `abandoned`/`cancelled` write is a
  transaction on `orders/{id}` requiring `resolving_claim_id === claimId` **AND** `payment_status === 'resolving_abandon'`
  **AND** `paid_during_resolve !== true`, with a final paid-evidence check immediately before it. If the CAS aborts →
  re-read: paid evidence present → releaseClaim → **409** `"Se detectó un pago — usá Reembolsar"`; else (claim lost)
  → 409. A paid callback landing in ANY gap now fails the CAS instead of abandoning a paid order.
- **[🔴 R3-#3] Refund never marks `refunded` on ABSENCE of a UUID.** Stamp `resolving_phase='side_effect_started'`
  + `side_effect_started_at`, then **re-read the UUID after the stamp**. Real UUID → void it (a genuine
  `voided:true` → `refunded`). **No UUID** → do NOT call a no-op void that returns `voided:true` (that would falsely
  mark a paid order refunded) → `manual_review` / **409** `"No se encontró el cargo — revisar en PixelPay"`. Only a
  real void of a real UUID yields `refunded`.
- **[#4] releaseClaim = CAS on `(resolving_<action>, resolving_claim_id)`** — never blind `.set()`.
- **[#5 + R2-#2] Phase split.** Release/revert ONLY while `phase='claimed'` (pre-money). After
  `phase='side_effect_started'` (money issued) NEVER revert: converge to `refunded`/`refund_pending`/`confirmed`;
  if a follow-up DB/audit write then fails → **paymentAlert**, never roll back.
- **[#7] Materialize keeps the claim** — `confirmAndMaterializeFromManualClaim(deps,{orderId,attemptId,claimId})`
  transitions `resolving_materialize → confirmed` atomically on the claim_id; **no transient `pending`**.
- **[#8] Materialize non-final** → CAS back to `manual_reconciliation`/`review` (pre-side-effect, safe), not `pending`.

## D. Stale recovery — PHASE-AWARE (the double-refund hole)
- **[#6/#14 + R2-#2]** In the 5-min `sweepStalePending`: stale `resolving_*` (`resolving_claimed_at` older than a
  threshold **> function timeout**, e.g. 10 min), CAS on `resolving_claim_id`:
  - `phase='claimed'` (**pre**-side-effect) → revert to `manual_reconciliation` (safe — no money moved).
  - `phase='side_effect_started'` (**post**-side-effect) → converge to `refund_pending` / `manual_review` + **alert**;
    **NEVER** back to re-resolvable `manual_reconciliation` (that lets a 2nd resolver re-issue the void/refund).
  Daily `reconcilePayments` = alert-only backstop for long-stuck claims.

## E. Audit + honest status contract
- **[#9] `refund_pending` → 409** (non-2xx). **Client tweak** (not zero-client-change): `resolveReconciliation`'s
  error path surfaces `data.outcome` so the panel shows `refund_pending — revisar`. 2xx only for
  `{abandoned, refunded, materialized, confirmed, already_confirmed}`.
- **[#10/#11] Idempotent audits** keyed by `orderId + resolving_claim_id + action` (deterministic path / check-before-push);
  dedupe `keep`.

## ⚠️ [R2-#3] PixelPay idempotency — PROVE it, don't assume (recovery safety depends on it)
Our probes found a **2nd `doCapture` on a captured uuid → 412** (NOT a safe no-op). So before relying on
retry-safety: **sandbox-prove** duplicate `void` and `capture` behavior. Code **duplicate / unknown PixelPay
responses as durable `refund_pending` / `manual_review`** — never assume harmless idempotency. This gates D's
post-side-effect convergence and any recovery-then-retry path.

## F. Emulator proof matrix [#15 + R2]
Assert **exactly one terminal state + one terminal audit per claim** across:
1. resolver vs 2nd resolver → one 200, one 409.
2. resolver vs sweepStalePending / confirmOnlinePayment / cancelPaidOrder.
3. **[R2-#1] paid webhook DURING `resolving_abandon`** → evidence persisted, abandon aborts, order not lost.
4. **[R2-#1] paid webhook DURING `resolving_refund`** → refund uses the persisted UUID.
5. audit-fails-after-terminal → alert, no rollback, no double-action.
6. null-first uncached claim; **[R2-#4] deleted-order null no-op → 409/404 (not "claimed")**.
7. **[R2-#2] recovery: pre-side-effect stale → revert; post-side-effect stale → refund_pending+alert (never manual_reconciliation)**.
8. **[R2-#3] duplicate PixelPay void/capture (sandbox) → durable refund_pending/manual_review**, not a fake success.
9. `refund_pending` → 409 HTTP + client renders `revisar`.
10. **[R3-#1] paid callback in the abandon read→CAS gap** → the CAS fails → abandon aborts (409), order NOT abandoned.
11. **[R3-#2] paid callback AFTER `abandoned` commits** → not skipped → evidence recorded + `abandoned → refund_pending` + alert.
12. **[R3-#3] refund with NO persisted UUID** → `manual_review`/409, NEVER a false `refunded`.
13. **[R3-#4] crash between the two evidence writes** → single atomic update means no partial strand; test both
    partial-state reads resolve correctly.
14. **[R4] paid callback while in `manual_reconciliation` (pre-claim)** → evidence persisted, `payment_status`
    unchanged (stays queued); a subsequent **abandon aborts** (409) and **refund uses the persisted UUID** — the
    pre-claim evidence is treated identically to `paid_during_resolve`.
Plus `npm test` + `check:rules` green.

## Scope / safety / deploy
- Files: `index.js` (resolver + the consumers + phase-aware sweep recovery + confirmAndMaterializeFromManualClaim +
  the webhook paid-evidence branch), a shared predicate module (golden-tested), the PixelPay client (idempotency
  handling), + a small `xpizza-dispatch` client tweak for [#9] (own re-gate/deploy).
- X. Pizza safety: single-resolver happy path behavior-preserved; new observable = transient `resolving_*` + the
  phase fields + honest non-2xx. `payment_status` not client-writable → no rules change. **Server 31→31 zero-prune.**

## Settled OQs (rev-1) + rev-3 stances
- refund_pending = **409** (+ client tweak). Recovery = **5-min sweep, claim_id-CAS, phase-aware, threshold > timeout**;
  daily = alert-only. **PixelPay duplicate-op behavior must be sandbox-proven before merge** (blocks D).

## Sequence
rev-3 PLAN → auditor + Codex re-gate (019f2e15) → on APPROVED: sandbox-prove PixelPay idempotency → implement +
the F matrix (emulator) + golden units → commit → gated 31→31 server deploy + the small client tweak.
