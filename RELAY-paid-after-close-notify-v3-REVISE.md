# RELAY → executor: paid-after-close notification — REVISE (v3)

**From:** advisor/auditor. **Base:** `fix/paid-after-close-notify` @ `bc5939a` (off the already-LIVE `1e0ec32`). **Gate:** codex money-gate on `bc5939a` (2026-09-21) → **DEFECTS, not approved.** Build the fixes below LOCAL-ONLY; advisor re-gates before owner deploys. Money-adjacent — do NOT self-approve.

## What's confirmed GOOD (keep it)
- **Money-inert** — `materialize-guard.js` byte-identical to base; no charge/refund/void/state/audit/reward write changed.
- The **normal-case double-message is fixed** (the owner's reported bug): in the non-race path the guard writes `status:'cancelled' + blocked_reason:'refunded_paid_after_close'` atomically, the trigger reads the marker and suppresses the generic → one dedicated refund message.
- The prior "missing status edge" defect is closed (the send is on the finalize path, not the status edge).
- `cancelNotify` selector exact-value correct (`abandoned` | `refunded_paid_after_close` only; look-alikes/garbage → notify).

## Defects to fix

### 🔴 D1 — zero-message on a crash after refund (HARMFUL; the priority)
Both finalize paths (`materialize-guard.js:87`, `index.js` recovery `finalize_refunded` ~:2936) persist the terminal refunded state **before** calling `sendPaidAfterCloseRefund`. A crash in that interval leaves NO notification marker; guard re-entry skips terminal orders and the recovery sweep **excludes already-refunded orders** (`index.js:~2928`) → the customer is refunded but told **nothing**. This is WORSE than pre-change, because suppressing the generic removed the fallback message that used to at least fire.

**Fix direction — make the refund notification a recovery-backed OBLIGATION, not a fire-and-forget:**
- Stamp a durable **notify-intent** (e.g. `paid_after_close_refund_notify_pending: true`, or reuse the absence of `paid_after_close_refund_notified_at`) **atomically in the same terminal-state update** that writes `refunded_paid_after_close` — so it survives a crash after the terminal write.
- Extend the existing paid-after-close **recovery sweep** to ALSO drive the notification: for any `refunded_paid_after_close` order whose notify is unfulfilled (no `notified_at`), send `sendPaidAfterCloseRefund` (idempotent via the at-most-once claim). i.e. the sweep must INCLUDE already-refunded orders for the notification step, not exclude them.
- Net: exactly-one message becomes a recovery-guaranteed at-least-once + at-most-once (the claim dedupes), so a crash self-heals on the next sweep instead of dropping the message.

### 🔴 D2 — best-effort failure marker (makes recovery unreliable)
`index.js:~1977` swallows a failure of the `paid_after_close_refund_send_unresolved_at` write (empty catch), and a claim-transaction failure (`~:1969`) returns with no durable outcome — the log says "marked" while nothing persisted. With D1's recovery-backed model this largely dissolves (the sweep re-drives on unfulfilled intent), but ensure the notify-intent/claim state is the durable source of truth and not a best-effort side write.

### 🟡 D3 — rare redundant double under a concurrent manual cancel (LOW-HARM)
If a dispatcher **manually** cancels at the same instant the auto-refund fires, the status→cancelled edge can read a marker-less snapshot and send the generic, then the guard sends the dedicated → both messages. Rare (needs a concurrent manual cancel racing the auto-refund), both messages are TRUE, money is safe.
**🔴 OWNER DECISION PENDING (advisor recommends ACCEPT as a documented limitation):** accept D3 as a rare/low-harm residual, OR make it airtight. Do NOT build the airtight path until the owner rules — the airtight version is materially more complex (coordinating two independent writers around a fire-and-forget trigger) for a rare³, both-true, money-safe edge. Advisor lean: accept + document.

## Tests to add (the gate flagged coverage gaps)
- The composition is under-tested: `H` proves concurrent guard passes with a STUB sender (not the real notification transaction); recovery tests exercise the decision function, not the actual sweep sender. Add coverage that exercises the REAL sender through the finalize + recovery paths, incl. the crash-then-recover path (D1) and the at-most-once claim under a re-drive. Every kill names its assertion.

## Then
Advisor re-runs the codex money-gate on the v3 diff → owner deploys (functions-only, off `1e0ec32`). Confirm D3's disposition with the owner before finalizing scope.
