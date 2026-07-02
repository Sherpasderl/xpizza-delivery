# Ready-Time Phase 0 — Codex adversarial review log

Proposal: `READY_TIME_PHASE0.md` — server-authoritative lifecycle event-log instrumentation (Phase 0 of the ready-time / food-prep-time predictor workstream). Auditor-drafted; EXECUTOR builds after sign-off. Codex read-only every round, run from the repo dir (see memory: codex-gate-invocation). Converged 2026-07-01.

## Round 1 — Codex: REVISE (8 findings, all accepted by arbiter)
- **HIGH #1/#7** — the `orders/{id}/timeline/*` mirror is NOT behavior-free: it fires every existing `onValueWritten('orders/{orderId}')` trigger (`autoAssignOnOrderCreate` :3133, `onOrderCancelled` :1884, `sendOrderStatusNotifications` :2365, materialize/factura). The "no existing path touched" claim was false; factura could do extra eligibility/sequence work. → **Fix:** move BOTH writes to top-level trees (`order_events`, `order_timelines`); nothing under `/orders`.
- **HIGH #2** — misgrounded `created_at`: `materialize.js:39` stamps `orders/{id}/materialized_at` at the `new` transition; `:104` `created_at` is under `order_tracking/{token}`. `orders.created_at` is pending-payment time for online orders. → **Fix:** define `new_at` solely from the instrumentation's own `new`-transition timestamp.
- **HIGH #3** — `prep_time` needs first-entry timestamps; the mirror overwrote on `ready→preparing→ready` bounces / overrides / no-op writes, corrupting labels. → **Fix:** no-op guard + first-entry-only transactional timeline; append log keeps full history.
- **MED #4** — `kitchen_load` off-by-one (includes self). → **Fix:** `kitchen_load_ahead` = other `{new,preparing}` excluding self.
- **MED #5** — not one indexed query (RTDB can't `IN`); `drivers.status` unindexed. → **Fix:** two `orderByChild('status')` reads + in-memory restaurant filter; add `.indexOn:["status"]` on `drivers`.
- **MED #6** — `drivers_available` ≠ `pickEligibleDriver` (:2862) logic (reachability/cooldown/stacking/active-count). → **Fix:** rename `drivers_online`, coarse proxy, eligibility-accurate deferred to Phase 0.1.
- **LOW #8** — rules incomplete. → **Fix:** explicit `order_events`/`order_timelines` `{".read":false,".write":false}`, drivers `.indexOn`, equality gate.

### Arbiter response (rev-2)
All 8 accepted. Verified the two load-bearing claims against code (materialize.js:39 vs :104; the three named triggers are `onValueWritten` on order paths; drivers has no `.indexOn`) before revising. Core architecture (server trigger + immutable event log) unchanged.

## Round 2 — Codex: REVISE (1 finding, accepted)
- Everything from rev-2 verified clean EXCEPT: the no-op guard used object equality `before === after`. In v2 RTDB triggers `before`/`after` are `DataSnapshot` objects → object equality never matches a same-value rewrite (existing pattern: `index.js:2371` uses `.val()`). → **Fix:** `before.val() === after.val()`.

### Arbiter response (rev-2 → rev-3)
Accepted; one-line fix to `.val()` comparison with the rationale + code reference inline.

## Round 3 — Codex: APPROVED
Single fix confirmed correct and complete; nothing else regressed.

## Outcome
**APPROVED (3 rounds).** What the review improved: (1) closed a real behavior-preservation hole (trigger fanout) — the prime directive; (2) corrected a factual grounding error (`new_at` source); (3) hardened the training-label integrity (first-entry + `.val()` no-op guard). Ready for the EXECUTOR to build (its own emulator + `npm test`/`check:rules`/`test:rules` pass required per the proof plan) as a SEPARATE follow-up deploy (prune 30→31), not bundled into the frozen S3 deploy.
