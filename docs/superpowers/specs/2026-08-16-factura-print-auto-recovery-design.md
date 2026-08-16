# SPEC — Factura print auto-recovery (self-healing print agent)

**Date:** 2026-08-16 · **Surface:** `xpizza-factura/print_agent.js` (the always-on NSSM service on the Surface Pro) + a small `xpizza-factura/tools/reprint.js`. **Type:** fiscal print-pipeline robustness. **NOT money-path** (reprints only the *identical already-issued* document — no number allocation, no change to what the factura asserts) → advisor + light codex integrity glance. Applies to X. Pizza (and any brand that later adds a print agent). See [[factura-integration]].

## Problem
When the printer is briefly unavailable (paper-out, USB drop, power blip), the agent's print attempt fails, the factura record is left `printed:false` + `print_error`, and **nothing re-fires the agent when the printer recovers** — a paper refill is not a write to the factura node. Today the only recovery is a manual RTDB poke (clear the print flags) or restarting the service. Confirmed live 2026-08-13 (factura `000-002-01-00000025`, Elisa Welchez — `print_error: "printer not found"`, stranded until a manual `database:update`). This will recur.

## Goal
The agent **self-heals**: once the printer is back, any factura that failed to print reprints automatically, with no manual step. Plus a small guarded CLI for deliberate reprints of a *stranded* factura.

## Key facts (verified from source)
- The agent watches `/facturas/{RID}` via `child_added` (fires for **every existing child on startup**) + `child_changed`, and calls `handle(orderId, snapshot)`.
- `handle()` runs a transaction gated by the pure `decidePrintClaim(record,…)`: **skips** `printed`/`void`/live-claim-by-other; otherwise **claims → prints → sets `printed:true`** (or on failure sets `print_error` + clears the claim). It is **idempotent and safe to re-run** — the transactional claim prevents any double-print.
- A record that FAILED to print stays `printed:false` (build-record initialises `printed:false`; a successful print sets `true`). So "records needing a print" == `printed:false && !void && unclaimed` — exactly what `decidePrintClaim` already returns `claim` for.
- **Therefore restarting the agent already reprints all stranded facturas** (startup `child_added` re-runs `handle` on each). The only missing piece is a periodic re-attempt while the service keeps running.

## Design

### 1. In-memory retry set (no rules change, no extra query)
Track the facturas the agent has seen as *not-yet-printed* and re-attempt them on a timer:
- Maintain `pendingRetry: Map<orderId, lastKnownRecord>`.
- In `handle()`: on a **print failure** (the `catch` that sets `print_error`), `pendingRetry.set(orderId, record)`. On a **successful print** (or any observation of `printed:true`/`void`), `pendingRetry.delete(orderId)`.
- Also seed it from the events the agent already receives: if a `child_added`/`child_changed` snapshot has `printed` falsy && `!void`, it's a retry candidate (it will be handled immediately anyway; if that attempt fails it lands in `pendingRetry` via the failure path).
- A `setInterval` every `PRINT_RETRY_INTERVAL_MS` (default **60000**) iterates `pendingRetry` and calls `handle(orderId, lastKnownRecord)` for each. `handle`'s existing `inFlight` guard + transactional claim make concurrent/overlapping ticks safe.
- **Rehydration on restart is automatic:** startup `child_added` fires for every factura, so any `printed:false` record re-enters the flow after a crash/restart — nothing is permanently lost even though the Map is in-memory.
- **Retry-until-success semantics:** a factura MUST eventually print, so retries continue indefinitely (bounded only by the record printing or being voided). Each failed tick just rewrites `print_error` and logs — no hammering (60s cadence). When the printer returns, the next tick prints it and it leaves the set.

*(Alternative considered — an indexed `orderByChild('printed').equalTo(false)` query — rejected for this phase: it needs a `.indexOn` rules change + emulator step for marginal benefit, since the in-memory set + startup rehydration already gives complete coverage at far lower blast radius.)*

### 2. Guarded manual reprint tool — `xpizza-factura/tools/reprint.js <orderId>`
For a deliberate reprint of a **stranded** factura (e.g. staff wants to force it without waiting for the tick, or a jam mid-print):
- Reads `/facturas/{RID}/{orderId}`. **Refuses** (clear message, non-zero exit) if the record is `void`, or if `printed === true` — an already-printed factura is the fiscal-copy case, **out of scope** (see below). Only acts on `printed:false`/absent.
- If eligible, clears the print flags (`printed:false, printed_at:null, print_error:null, print_claim:null`) — the write re-fires the running agent, which prints. Prints a confirmation with the `factura_number`.
- Same admin credentials/env as the agent. Documented in SETUP.md.

### 3. Out of scope (explicit — needs a fiscal decision, not built here)
Reprinting an **already-printed** (`printed:true`) factura as a **customer copy**. Under SAR a duplicate of an issued número should arguably carry a **"REIMPRESIÓN/COPIA"** marker rather than emit a second unmarked original — that changes what the paper asserts, so it is an [[fiscal-representation-owner-gate]] decision. The reprint tool deliberately **refuses** this case and points to it. If wanted later, it's its own spec (renderer COPIA banner + owner sign-off).

## Blast radius / safety
- Touches **only** `print_agent.js` + a new `tools/reprint.js`. **No `xpizza-functions/index.js`, no order/money path, no renderer, no rules.** The agent is a standalone service redeployed by git-pull + NSSM restart on the Surface.
- Double-print is prevented by the **unchanged** transactional `decidePrintClaim` — the retry only re-invokes the existing, idempotent `handle()`.
- The agent stays fail-safe: the timer body is wrapped so a retry error never crashes the service (mirrors the existing per-record try/catch).

## Testing
- **Pure/unit:** extract the retry-membership decision as a pure helper `retryCandidate(record) → bool` (`printed` falsy && `!void`) and test it (printed true → false; void → false; fresh/failed → true). `decidePrintClaim` idempotency is already covered by `print-claim.test.js`.
- **Agent (manual/bench):** simulate a failed print (printer detached) → record lands in `pendingRetry`; reattach printer → within one interval the record prints and leaves the set; confirm no double-print of already-`printed:true` records across ticks; confirm a restart rehydrates a stranded record.
- **Tool:** `reprint.js` on a `printed:false` record → clears flags + agent prints; on a `printed:true` or `void` record → refuses with a clear message, no write.

## Gate & deploy
- **Gate:** advisor + light **codex integrity** glance (retry is idempotent/claim-guarded/fail-safe; tool refuses the fiscal-copy case; no money/assert change). Not money-adjacent.
- **Deploy:** on the Surface — `git pull` the agent branch + restart the `XPizzaFacturaAgent` NSSM service (no functions deploy, no rules deploy). Verify: kill paper mid-order → refill → factura prints within ~1 min unattended; and `printed:true` records are never re-printed.

## Config
- `PRINT_RETRY_INTERVAL_MS` (default 60000) — retry cadence, env-tunable in the agent `.env`.

## Copy
None (no customer/staff-facing UI text; CLI messages only).
