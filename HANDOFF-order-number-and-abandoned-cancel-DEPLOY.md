# DEPLOY HAND-OFF — order-number obscuring + abandoned-cart cancel suppression

**Branch:** `fix/order-number-and-abandoned-cancel` @ **`1e0ec32`** (off origin/main `dc7d9f7` — clean fast-forward). **Both fixes codex-APPROVED.** Functions-only deploy; no forms/Netlify change.

## What ships
1. **Order display number → non-sequential 3-digit.** `#N` was `last+1` (leaked daily volume, "#2" = slow). Now a random 3-digit (100–999), collision-checked per restaurant-day, idempotent per order, fail-open on exhaustion. **Brand-agnostic** (both brands). On NEITHER factura number; nothing internal counts by it (gate-verified). Shows on the customer tracker + KDS/dispatch (all in sync).
2. **Abandoned-cart cancel suppression.** Discarding an abandoned cart (Descartar → `payment_status:'abandoned'`) no longer sends the customer "tu pedido fue cancelado". Every real cancellation still notifies.

## Pre-merge (owner)
- 🔴 Re-verify origin/main directly: `git ls-remote origin -h refs/heads/main` → expect `dc7d9f7` (if it moved, rebase this branch onto it first). [[verify-remote-git-state-directly]]
- Run the full suite green: `cd xpizza-functions && npm test`.
- Run the display-number emulator test (needs Java/Firebase emulator): `npm run test:display-number` — asserts the number is in-range/unique/idempotent (property-based now, not #1/#2).

## Merge + deploy (owner)
- Merge `1e0ec32` to main (push the branch first, then gh-api fast-forward — a local-only object 422s). Result: origin/main = `1e0ec32`.
- Deploy from a worktree with the COMPLETE prod functions `.env` (NOT the `xpizza-fixes` scratch worktree — it has no `.env`; a partial `.env` STRIPS live env — [[functions-env-management]]), checked out at the merged commit.
- `firebase deploy --only functions --project xpizza-delivery` (pin the project — ambient gcloud has drifted to xpizza-social; [[cutover-pin-gcp-project]]). Full functions deploy keeps driver-native + payment fns [[prod-functions-deployed-state]]. Changed triggers: `allocateDisplayNumberOnSale` (display counter) + `sendOrderStatusNotifications` (cancel notify).

## Post-deploy verify
- Place a real test order → the number on the tracker/KDS is a **3-digit** `#NNN` (not `#1/#2`), and the same number on all surfaces.
- Discard an abandoned cart from Reconciliación → the customer gets **NO** WhatsApp; a real cancel still sends "cancelado".

## Coordination note
Merging this moves origin/main `dc7d9f7`→`1e0ec32`. The D4-P1 branch (`feat/portal-1d-D4-P1a`) is off `dc7d9f7` and also edits `index.js` (different regions — catalog/identity vs the cancel trigger + display counter; likely conflict-free) → that work should rebase onto the new main and re-verify.

## HELD (not in this deploy)
`fix/paid-after-close-notify` @ **`bc5939a`** — the paid-after-close double-message fix (reliable single channel: finalize-path send hardened with an at-most-once claim + durable unresolved-marker, generic suppressed). Built + all local tests green, but its codex money-gate could NOT run (OpenAI usage limit, resets ~Sep 25 — shared with the D4-P1 gating). NOT self-approved (money-adjacent). Advisor re-runs the gate (`scratchpad/gate-pac2.txt`) when codex is back, then hands it over. It is off `1e0ec32`, so once this deploys, its remaining delta is just the paid-after-close commit.
