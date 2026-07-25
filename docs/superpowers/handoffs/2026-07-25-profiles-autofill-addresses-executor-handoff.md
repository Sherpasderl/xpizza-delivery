# EXECUTOR HANDOFF — Logged-in Autofill + Saved Addresses

**You are the EXECUTOR. You build. You do NOT gate and you do NOT deploy.** The advisor runs `codex-on-diff` (this touches RTDB rules + PII + the order-submit path); Xavier deploys. The design already survived a **5-round codex design-gate** — follow the plan as written; do not re-litigate the rules.

## Mission
Make a logged-in customer never re-type name/phone or re-pin their location: the "Tus datos" step becomes a one-tap "Entregar a" confirm card backed by saved, labeled addresses. **Guest checkout stays byte-identical.** Nothing ships half-wired.

## Environment
- **Worktree:** `/Users/xavierlacayo/Downloads/xpizza-addresses` (created off `main` @ `500caab`).
- **Two phases, two branches** (separate deploy surfaces + gates; Phase A must be LIVE before Phase B ships):
  - **Phase A — branch `feat/profiles-addresses-rules`** (already checked out): the RTDB rules opening + tests (`xpizza-reference/database.rules.json`, `xpizza-functions/test/…`, `xpizza-functions/user-auth-rules.guard.test.js`).
  - **Phase B — branch `feat/profiles-addresses-frontend`** (you create it off the updated `main` AFTER Phase A rules are live): the forms (`xpizza-orders/`, `la-musa-orders/`).

## Read first (in order)
1. **Plan:** `docs/superpowers/plans/2026-07-25-profiles-autofill-addresses.md` — execute task-by-task (A1→A2, then B1→B9), commit after each. Read the **Non-negotiables** and **Self-review notes** first.
2. **Spec (codex-gated R5):** `docs/superpowers/specs/2026-07-25-profiles-autofill-addresses-design.md` — the WHY behind each rule; the rules text in the plan is exactly what the gate approved. Do not "improve" the rules.
3. **Locked mockup:** `docs/superpowers/mockups/xpizza-autofill-mockup.html` — port the confirm-card / label-picker / chip markup + CSS verbatim; brand-recolor for La Musa (muted rojo musa).

## How to build
Use **superpowers:subagent-driven-development**. The plan carries exact code for the security-critical parts (the rules JSON, the fail-open `accountSnapshot`, the atomic `saveAddress`/`deleteAddress`). Follow it exactly — rules + money-path-adjacent UI.

## PHASE A — rules (FIRST)
Build A1 (rules) + A2 (tests) on `feat/profiles-addresses-rules`.
- The `$uid` `.write` gains the `default_address` referential clause; the `addresses/$addrId` `.validate` combines `$addrId.matches` + `hasChildren([7 fields])` + per-field bounds + `$other:false`; NO child `.write` under addresses (parent guard governs). `addresses` stops being an `$other`/`.validate:false` leaf.
- **Non-negotiable:** do NOT weaken the H1 staff-read exclusion, the immutable `phone`/`created_at`/`last_login`, or the existing `hasChildren(['phone','phone_hash','created_at','last_login'])` guard — the referential clause is APPENDED.
- Tests: the full emulator list in A2 (owner-only, cross-uid deny, tombstone deny, out-of-range, over-length, stray key, 11th address, partial address, bad `$addrId`, default→nonexistent deny / null OK / **atomic create+set-default OK** / **delete-referenced-leaving-default DENY**, drop-server-field deny, H1 unchanged). Emulator needs Java (`/opt/homebrew/opt/openjdk`) + `npm install` + a copied gitignored `database.rules.json` to boot the DB emulator; if you can't run it, say so and the advisor runs it.
- **Done (Phase A):** `cd xpizza-functions && npm test` green + `npm run check:rules` green (+ emulator if you can); push `feat/profiles-addresses-rules`; **report the SHA to the advisor for `codex-on-diff` (rules).** Then STOP — Xavier deploys `--only database` (reconcile ← xpizza-reference, diff vs LIVE = only these additions, 0 stripped). Do NOT start Phase B until the addresses rules are LIVE.

## PHASE B — frontend (after Phase A live)
Create `feat/profiles-addresses-frontend` off the updated `main`, build B1→B9. NON-NEGOTIABLES:
1. **Guest byte-identical** — no marker → no confirm card, no address reads, ZERO Firebase/gstatic on load, intake POST unchanged. Prove it (B9 Step 1).
2. **Fail-open, timeboxed (~1.5s)** — `accountSnapshot()` + SDK init non-blocking; a miss/timeout → the normal empty form; NEVER wait on any account read/write before submit.
3. **Phone immutable** — the card SHOWS the account phone; a per-order contact goes to `cphone`→`createOrder` only, NEVER written to `user_profiles/phone` (a batched profile write that changes phone would REJECT).
4. **Autofill via the existing fields** — populate `cname`/`cphone`/`address-detected`/`address-details` + the map pin (via the `__restorePos={lat,lng}` mechanism, `index.html:2553`) so the existing submit is untouched; the picked address maps `detected→address_detected`, `details→address_details`.
5. **Save-on-order** — delivery-only, post-**confirmed** (online = materialized, NOT hosted-checkout), opt-in/dismissible.
6. **NO cheap emoji**; chip = seamless soft avatar (no pill, no ring); label chips = monochrome line icons.
7. La Musa `account.js` = byte-identical logic past CONFIG (muted rojo musa); verify its field IDs match.
- **Done (Phase B):** B1–B9 committed; guest byte-identical + fail-open verified on BOTH forms; push `feat/profiles-addresses-frontend`; **report the SHA to the advisor for `codex-on-diff`.** Advisor gates → Xavier deploys via **Netlify CLI per-folder** (`cd xpizza-orders && npx netlify deploy --prod --dir . --site 6f09559f-0697-48ef-b498-a6523f0370d3`; `la-musa-orders` → site `f8bac377-cea5-4688-ac3d-b4812c62360a`). The forms do NOT git-CD.

## Hard rules
- Do NOT deploy or merge to `main`. Push branches, report SHAs.
- Do NOT change the codex-gated rules text (Phase A) or weaken any P0 guard.
- Do NOT regress guest byte-identical, lazy-SDK (H8), or the existing cart/draft/PixelPay/intl-phone/map flows.
- Keep account logic in `account.js`; `index.html` edits are only the confirm-card mount, the field population hook, and the keyboard-lift.
