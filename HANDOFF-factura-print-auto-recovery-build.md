# EXECUTOR RELAY — Factura print auto-recovery (self-healing print agent)

**Type:** fiscal print-pipeline robustness (the Surface print agent). **NOT money-path** — reprints only the *identical already-issued* document (no número allocation, no change to what the factura asserts) → build on a branch → advisor + **light codex integrity** gate → owner deploys. Base: current `origin/main`.

## Read these (full detail lives here)
- **Spec:** `docs/superpowers/specs/2026-08-16-factura-print-auto-recovery-design.md`
- **Plan (4 TDD tasks, source-anchored):** `docs/superpowers/plans/2026-08-16-factura-print-auto-recovery.md`

## What / why
A factura strands (`printed:false` + `print_error`) whenever the printer is briefly down (paper-out / USB drop / power). Nothing re-fires the agent when the printer recovers — a paper refill isn't a write to the factura node — so today it needs a manual RTDB poke. **Confirmed live 2026-08-13** (factura `000-002-01-00000025`, Elisa Welchez). Make the agent **self-heal**, plus add a guarded CLI to force a reprint of a stranded factura.

## Build (branch off current origin/main; suggested `feat/factura-print-auto-recovery`)
Follow the plan 1→4, TDD the pure parts.
- **T1** pure `retryCandidate(record)` in new `xpizza-factura/src/print-recovery.js` (+ test) — present && !printed && !void.
- **T2** pure `reprintDecision(record)` in the same module (+ test) — `refuse` on `not_found`/`void`/`already_printed`, else `reprint`.
- **T3** wire into `xpizza-factura/print_agent.js`: a module-level `pendingRetry: Map`, made **authoritative in `handle()`** (delete on print-success / terminal-skip printed·void·absent; set on print-failure; keep on `claimed_by_other`), and a `setInterval(PRINT_RETRY_INTERVAL_MS default 60000)` that re-runs `handle(orderId, rec)` for each pending entry (fail-safe `.catch`, never crashes the service).
- **T4** `xpizza-factura/tools/reprint.js <orderId>` — reads the record, uses `reprintDecision`, **refuses `printed:true`/`void`**, else clears the print flags (`printed:false, printed_at:null, print_error:null, print_claim:null`) so the running agent re-fires. + a one-line SETUP.md note.

## Guardrails (non-negotiable)
- **Do NOT modify `decidePrintClaim`** (`src/print-claim.js`). It is the double-print guard — the retry only re-invokes the existing idempotent `handle()`. The transactional claim is what makes overlapping ticks safe.
- **Two files + one pure module only.** **No `xpizza-functions/index.js`, no `database.rules.json`, no renderer, no pricing/número/CAI.** No cloud/functions/rules deploy — this is the standalone Surface service.
- **`reprint.js` MUST refuse `printed:true`** (reprinting an issued+printed factura as a customer *copy* needs a fiscal COPIA decision — **out of scope**) and `void`. Only acts on `printed:false`/absent.
- **Retry-until-success, fail-safe:** retries continue until the record prints or is voided; the timer body is wrapped so a retry error never crashes the agent. 60s cadence, env `PRINT_RETRY_INTERVAL_MS`.
- **Rehydration is automatic** — startup `child_added` fires for every factura, so a stranded record re-enters after any crash/restart even though `pendingRetry` is in-memory. Don't add persistence.

## Source anchors (verified 2026-08-16; re-verify on base)
- `print_agent.js`: `handle(orderId, known)` ~67-94 (success `ref.update({printed:true,…})` ~85; failure `ref.update({print_error…})` ~88; skip return ~80); requires ~17-18; `start()` listeners ~96-103; `TTL`/`OWNER` ~23-24.
- `src/print-claim.js`: `decidePrintClaim` — skips `printed`/`void`/`claimed_by_other`, else `claim`. **Leave unchanged.**
- Record shape (from a live factura): `printed` (bool, build-record initialises false), `printed_at`, `print_error`, `print_claim`, `void`, `factura_number`, `order_id`. Node path `facturas/${RESTAURANT_ID}/{orderId}`.
- Tests run as plain node scripts (e.g. `node xpizza-factura/src/print-recovery.test.js`); the hardware-touching agent stays bench-tested, not unit-tested (existing convention).

## Definition of done
T1–T4 committed; `node xpizza-factura/src/print-recovery.test.js` green; `node --check` clean on `print_agent.js` + `tools/reprint.js`; bench notes per the plan (printer-detached → record queues + retries; reattach → prints within one interval + leaves the set; `printed:true` never reprints; `reprint.js` refuses printed/void). **NOT deployed.** Handback (branch @ SHA, files, test counts, bench results) → advisor + light codex integrity gate → owner deploys on the Surface (`git pull` + restart `XPizzaFacturaAgent` NSSM service — no cloud/rules deploy).

## Out of scope (separate fiscal decision — do NOT build)
Reprinting an already-printed factura as a customer **copy** (needs a renderer "REIMPRESIÓN/COPIA" marker + owner sign-off). The tool refuses it and says so.
