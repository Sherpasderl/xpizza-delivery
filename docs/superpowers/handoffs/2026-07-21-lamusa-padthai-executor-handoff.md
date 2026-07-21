# EXECUTOR HANDOFF — La Musa Pad Thai required protein

**You are the EXECUTOR session. You build. You do NOT gate and you do NOT deploy.**
The advisor session runs the codex money-gate; Xavier deploys. Your job: implement the plan, keep tests green, push the branch, hand the money diff back for the gate.

## Mission (one line)
Make Pad Thai require a protein choice (Sin Proteína / Pollo / Camarones) in a launcher modal, where each protein is its own menu id so mixed proteins land as **separate cart lines**.

## Environment (already set up)
- **Worktree (work here only):** `/Users/xavierlacayo/Downloads/xpizza-padthai`
- **Branch:** `feature/lamusa-padthai-protein` (off `origin/main` `6eac6c8`)
- **Current tip:** `5434917` (spec + plan + this handoff committed; no code yet)
- Do NOT touch other worktrees or the shared checkout `~/Downloads/xpizza-delivery`. Work only in this worktree.

## Read first (in order)
1. Spec: `docs/superpowers/specs/2026-07-21-lamusa-padthai-required-protein-design.md`
2. Plan: `docs/superpowers/plans/2026-07-21-lamusa-padthai-required-protein.md` ← **execute this task-by-task**

## How to build
Use **superpowers:subagent-driven-development** (or superpowers:executing-plans). Execute plan **Tasks 1 → 6** in order, committing after each task as the plan specifies. Task 7 is the gate/deploy handoff — **that is Xavier + the advisor, not you.**

## Test commands
- Server unit tests: `cd xpizza-functions && node menu-pricing.test.js`
- Form↔server parity: `cd xpizza-functions && node menu-parity.test.js` (green only AFTER Task 2)
- Full functions suite (Task 6): `cd xpizza-functions && npm test`
- Form manual verify: open `la-musa-orders/index.html` in a browser (it's a self-contained page).

## HARD RULES (do not violate)
1. **Do NOT deploy. Do NOT merge to `main`.** When done, `git push -u origin feature/lamusa-padthai-protein` (the branch only). Xavier deploys after the gate.
2. **Money code is gated.** `xpizza-functions/menu-pricing.js` (+ `menu-parity.test.js`, + the form MENU prices) is the price-affecting surface. After Tasks 1–6 pass, **STOP and hand the Task 1–2 diff to the advisor for codex-on-diff** before anything ships.
3. **Keep `menu-parity.test.js` green.** It asserts EXACT id-set + price parity between the form `MENU`/`EXTRAS` and the server tables, with counts (MENU now **43**, EXTRAS still **14**). Both sides must carry `noodle_01_sin/pollo/camaron` at 307/342/414, and **`noodle_01` must be 307 on BOTH form and server** (parity checks its price too). Don't touch EXTRAS.
4. **La Musa ONLY.** Do not modify `xpizza-orders/index.html` (X. Pizza) or the `X_PIZZA_*` tables. X. Pizza has no Pad Thai.
5. **Reuse, don't disturb.** Every change is gated behind `itemIsLauncher`/`variantOf`; all other menu items and the existing pure-XP modal must stay byte-identical. Do not refactor unrelated code.
6. **Follow the plan's code.** The plan carries full, verified code for each step (config, helpers, `renderLauncherModal`, the CTA/commit branches, the grid filter). Reused symbols (`chg`, `qty`, `pizzaExtras`, `EXTRAS`, `extrasCatsForItem`, `escapeHtml`, `HAS_PHOTO`, `updateDetailModal`, `updateDetailCta`, `closeDetailModal`) are confirmed to exist.

## Prices (reference)
base **307** · Pollo +35 = **342** · Camarones +107 = **414** (= today's Pad Thai price).

## Definition of done → then ping the advisor
- All plan Tasks 1–6 committed; every manual-verify in the plan passes.
- `node menu-pricing.test.js`, `node menu-parity.test.js`, and `npm test` all PASS.
- Mixed proteins = separate cart lines; same protein stacks qty; KDS `items_text` shows two separate `1x Pad Thai - <protein>` lines.
- Branch pushed: `feature/lamusa-padthai-protein` (NOT main).
- **Report back to the advisor** with: the branch tip SHA + "ready for codex money-gate (Tasks 1–2 diff)". The advisor gates; Xavier deploys.
