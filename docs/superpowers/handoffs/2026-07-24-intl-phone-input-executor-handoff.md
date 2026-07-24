# EXECUTOR HANDOFF — International phone input (country-code dropdown)

**You are the EXECUTOR. You build. You do NOT gate and you do NOT deploy.** The advisor runs codex-on-diff; Xavier deploys.

## Mission
Replace the +504-hardwired phone field on **both** order forms with a country-code dropdown (default +504) + local-number input, so customers can enter US (and other) numbers. Client-side only.

## Environment
- **Worktree (work here):** `/Users/xavierlacayo/Downloads/xpizza-padthai`
- **Branch:** `feature/intl-phone-input` (off `origin/main` fc87907; already checked out)
- **Files:** `xpizza-orders/index.html` + `la-musa-orders/index.html` (inline JS — **no test harness → manual browser verification**)

## Read first (in order)
1. Spec: `docs/superpowers/specs/2026-07-24-intl-phone-input-design.md`
2. Plan: `docs/superpowers/plans/2026-07-24-intl-phone-input.md` ← **execute Tasks 1–3 in order**, commit after each. Task 4 is the gate/deploy (advisor + Xavier — not you).

## How to build
Use **superpowers:subagent-driven-development** (or executing-plans). The plan's **Section A** holds the full component code (identical for both forms); Tasks 1 & 2 apply it at each form's exact anchors. Follow it.

## HARD RULES
1. **Do NOT deploy or merge to `main`.** When Tasks 1–3 are done + verified, `git push -u origin feature/intl-phone-input` and report the tip SHA.
2. **NO emoji** in the control (badge/dropdown/messages) — text + styling only ([[no-cheap-emoji-in-form-chrome]]).
3. **BOTH forms** get the identical component (`xpizza-orders` + `la-musa-orders`). Do not touch functions/server — `normalizePhone()` already handles full international numbers (no change).
4. **Preserve the Honduras flow** — default +504, local types 8 digits, formats `XXXX-XXXX` exactly as today; the change must be transparent for existing Honduras customers.
5. **Follow the plan's code + anchors.** Reused symbols (`initCardFormatting`, `#cphone`, `err`, `setV`, `v()`, `snap.fields`) are verified. Run the Task-3 JS syntax check on both files before pushing.
6. **No unrelated refactoring.**

## Definition of done → then hand to the advisor
- Tasks 1–3 committed; both forms manually verified (Honduras 8-digit → `+504`; US +1 10-digit → `+1`; wrong-length blocked; dropdown open/close/outside-click; country-switch clears; draft restore brings back country+number; no emoji).
- Both forms' inline scripts parse OK (Task 3 Step 1).
- Branch pushed: `feature/intl-phone-input` (NOT main).
- **Report the branch tip SHA to the advisor** for the **codex-on-diff gate** (focus: control always yields a valid full `customer_phone`; Honduras flow unchanged; paste/backspace/switch/restore edges; no XSS in the dropdown; both forms identical). Advisor gates → Xavier deploys **both** `orders.xpizza.hn` + `orders.lamusa.hn` (form-only git-CD).
