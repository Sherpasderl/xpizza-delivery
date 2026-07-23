# EXECUTOR HANDOFF — X. Pizza 18" (NY) pizzas pickup-only

**You are the EXECUTOR. You build. You do NOT gate and you do NOT deploy.** The advisor runs a codex-on-diff gate; Xavier deploys.

## Mission
Make the 18-inch NY pizzas (`cat:'ny'`, ids 18–23) on the X. Pizza order form orderable **for pickup only** — a "Solo Pickup" badge, a gate blocking Delivery + 18", and a submit-time guard. Client-side only, single file.

## Environment
- **Worktree (work here):** `/Users/xavierlacayo/Downloads/xpizza-padthai`
- **Branch:** `feature/xpizza-18inch-pickup-only` (off `origin/main` 2902382; already checked out)
- **File:** `xpizza-orders/index.html` (inline JS — **no test harness → manual browser verification**)

## Read first (in order)
1. Spec: `docs/superpowers/specs/2026-07-23-xpizza-18inch-pickup-only-design.md`
2. Plan: `docs/superpowers/plans/2026-07-23-xpizza-18inch-pickup-only.md` ← **execute Tasks 1–6 in order**, commit after each. Task 7 is the gate/deploy (advisor + Xavier — not you).

## How to build
Use **superpowers:subagent-driven-development** (or executing-plans). The plan carries full code + exact line anchors + per-task manual verification. Follow it.

## HARD RULES
1. **Do NOT deploy or merge to `main`.** When Tasks 1–6 are done + verified, `git push -u origin feature/xpizza-18inch-pickup-only` (branch only) and report the tip SHA.
2. **NO cheap emoji** in any new chrome (badge / gate / note). Text + styling only — this is a standing rule ([[no-cheap-emoji-in-form-chrome]]). The plan's copy is exact; use it verbatim.
3. **X. Pizza ONLY** — `xpizza-orders/index.html`. Do not touch La Musa (`la-musa-orders`) or any functions.
4. **Client-side only** — no server/functions change. The rule is UX, not money.
5. **Follow the plan's code + anchors.** Reused symbols (`MENU`, `qty`, `chg`, `orderType`, `setOrderType`, `renderMenu`, `processPayment`, `err3`, `updateTotal`, `updateCart`, `refreshTimeSelector`) are verified to exist. Note the plan corrects the spec: the submit guard goes in `processPayment()` (~2224, `err3`), NOT `goToLocation`.
6. **No unrelated refactoring.** Every change is gated behind `isPickupOnlyItem`/`cartHasPickupOnly`; the 12" `individual` category and delivery/payment flows must stay byte-identical.

## Definition of done → then hand to the advisor
- Tasks 1–6 committed; every manual-verify in the plan passes (badge on NY tab+cards only; gate on 18"+Delivery; Cambiar-a-Pickup / Quitar actions; submit blocked on Delivery+18"; 12"-only order unaffected).
- Branch pushed: `feature/xpizza-18inch-pickup-only` (NOT main).
- **Report the branch tip SHA to the advisor** for the **codex-on-diff gate** (standing discipline — runs even though this is non-money; focus: gate un-bypassable, no stuck/stale UI states, XSS-safe copy, no 12"/delivery/payment regression). Advisor gates → Xavier deploys (form-only git-CD).
