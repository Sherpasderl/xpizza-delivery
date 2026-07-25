# EXECUTOR HANDOFF — User Profiles P0 FRONTEND (+ online-order attribution backend)

**You are the EXECUTOR. You build. You do NOT gate and you do NOT deploy.** The advisor runs `codex-on-diff` (the order/payment forms + a money-path backend change); Xavier deploys. The plan already survived a 3-round codex plan-gate — follow it as written.

## Mission
Add optional customer login + account UI to BOTH order forms (X. Pizza + La Musa), wired to the LIVE, already-gated profiles backend (`requestOtp`/`verifyOtp`/`deleteAccount` — verified working, token mints with `customer:true`). Guest checkout must stay **byte-identical**; Firebase SDK loads **only on login interaction**. Plus a small backend change so **card** orders attribute too.

## Environment
- **Worktree:** `/Users/xavierlacayo/Downloads/xpizza-profiles-frontend` (already created off `main` @ `77cdda3`).
- **Two phases, two branches** (deploy surfaces + gates are separate):
  - **Phase A — branch `feat/online-order-attribution`** (already checked out): the BACKEND attribution (Plan **Task 0**) — `xpizza-functions/`.
  - **Phase B — branch `feature/user-profiles-p0-frontend`** (you create it off `main` AFTER Phase A is deployed): the frontend UI (Plan **Tasks 1–11**) — `xpizza-orders/`, `la-musa-orders/`.

## Read first (in order)
1. **Plan:** `docs/superpowers/plans/2026-07-24-user-profiles-p0-frontend.md` — execute task-by-task, commit after each. **Read the "Self-review notes" at the bottom first** — it lists the 6 codex-gate fixes already baked into the tasks (do not regress them).
2. **Locked mockups** (port markup/CSS verbatim, brand-recolored): `scratchpad/xpizza-login-mockup.html`, `scratchpad/xpizza-account-mockup.html` (NOTE: these live in the session scratchpad, not the repo — the advisor will paste them if you can't reach them).
3. The deployed backend contract is in the plan header (exact `requestOtp`/`verifyOtp`/`deleteAccount` URLs + shapes + `firebaseConfig`).

## How to build
Use **superpowers:subagent-driven-development**. The plan carries full code for the security-critical parts (the lazy loader, the `customerIdToken` helper with its hardened guard + timeout + `authStateReady`, the field-level materialize attribution). Follow it exactly — this touches the LIVE order-submit and money path.

## PHASE A — Task 0 (backend), FIRST
Build Task 0 only. Key correctness points (the codex plan-gate caught these — do not deviate):
1. `chargeOnlineOrder` reads the OPTIONAL `x-firebase-id-token` and derives `customer_uid` ONLY from a verified `customer:true`, non-tombstoned token (reuse `attributionUid`) — mirror `createOrder`'s fail-open block. Missing/bad/tombstoned/guest → `null` → the charge is UNAFFECTED (never fail or delay a payment).
2. Stamp `customer_uid` (when set) onto `pendingOrderRecord`.
3. In **`materialize.js`** `buildMaterializeUpdates` (the SHARED builder — NOT `pixelpay-confirm.js`), when `order.customer_uid` is set, add **FIELD-LEVEL** paths: `updates['orders/'+orderId+'/customer_uid']` and `updates['user_orders/'+order.customer_uid+'/'+orderId] = {...}`. **Do NOT call `attachCustomerAttribution`** (whole-object → throws here → would strand a PAID order). Test (e) must assert NO whole-object `orders/{id}` key appears.
4. Guest online orders must materialize byte-identically (no attribution paths).
- **Definition of done (Phase A):** Task 0 committed; `cd xpizza-functions && npm test` green (incl. the new tests + `materialize-snapshot`/`pixelpay-confirm`/`pixelpay-hosted-webhook`); push `feat/online-order-attribution`; **report the SHA to the advisor for `codex-on-diff` (money-path).** Then STOP — Xavier deploys a **FULL `firebase deploy --only functions`** (zero-prune, complete `.env`) because `materialize.js` is bundled into `pixelPayWebhook`/`confirmOnlinePayment`/sweep/scheduled-release. Do NOT start Phase B until Task 0 is live.

## PHASE B — Tasks 1–11 (frontend), after Task 0 is deployed
Create `feature/user-profiles-p0-frontend` off the updated `main`, then build Tasks 1–11. NON-NEGOTIABLES (from the gate):
1. **Guest byte-identical** — no `xpizza_acct`/`lamusa_acct` marker → ZERO Firebase/gstatic fetch, ZERO new headers, order POST unchanged. Prove it (Task 11 Step 1).
2. **Lazy SDK (H8)** — `import()` fires only on a login tap / logged-in submit / account open. Never from `renderChip()` or `DOMContentLoaded`.
3. **Fail-open attribution** — the call-site guard is `window.__ACCOUNT && typeof window.__ACCOUNT.customerIdToken === 'function'`, inside try/catch, with a **1.5s `Promise.race` timeout**. A logged-in submit must NEVER stall or fail on account logic → proceed as guest.
4. **`await auth.authStateReady()`** before ever concluding a session is dead (else you drop attribution / self-heal a valid session).
5. **Escape ALL user values** (`name`, `phone`) into `innerHTML` via `escapeHtml`/`textContent` — every render point (chip + account sheet).
6. **NO cheap emoji** ([[no-cheap-emoji-in-form-chrome]]) — the monochrome person-icon SVG only.
7. La Musa `account.js` = byte-identical logic, CONFIG-only diff (rojo musa, `restaurant_id:'la_musa'`, `MARKER:'lamusa_acct'`).
- **Definition of done (Phase B):** Tasks 1–11 committed; guest-identical + H8 verified on BOTH forms; push `feature/user-profiles-p0-frontend`; **report the SHA to the advisor for `codex-on-diff`.** Advisor gates → Xavier git-CD deploys from `main` to both Netlify sites (orders.xpizza.hn / orders.lamusa.hn).

## Hard rules
- Do NOT deploy or merge to `main`. Push branches, report SHAs.
- Do NOT touch `ORDER_SECRET` handling or add any secret beyond the public web `apiKey`.
- Do NOT regress the 6 baked-in gate fixes (Self-review notes).
- Keep ALL account logic in `account.js`; the only `index.html` edits are the chip mount, the `<script src>` tag, and the hardened header injection at the two intake fetches.
