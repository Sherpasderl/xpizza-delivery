# Deploy Runbook — batched La Musa server surface (ships DARK)

_Operator-run (you run every prod command; the executor verifies read-only). Deploys the full,
gated, X.-Pizza-byte-identical server surface. La Musa stays **dark** (`active:false`,
`whatsapp_enabled:false`) — this deploy changes **nothing** customers see. The highest risk here is
**not** the code (every slice was gated) — it's the **function-prune landmine**. Do the gates in
order; do not skip Gate 1._

## What's being deployed
Commits on `feature/lamusa-integration` ahead of main (server slices):
`A1 45aa6d5 · A2 15d2195 · A3 ac4bc4b · B1 32a9534 · B2-server 4eccec1 · C1 d815301 · C2 86bf9e4 ·
D1 340e386 · D2 645dd1c` (+ Finding-J, form, docs). **Functions** (all 28). **Rules: already live
since Phase 0 — idempotent re-apply, no effective change** (Gate 6.3).

---

## GATE 1 — Prune safety / function-set completeness  ⚠️ THE LANDMINE — do this first
`firebase deploy --only functions` **PRUNES** any live function absent from the deploy source. If the
branch is behind main (a parallel session landed driver/other work) or the source is missing a live
function, deploying **deletes live functions → drivers unassignable → breaks X. Pizza**. Worse than
any byte-identity bug.

1. **Branch currency vs the REMOTE main** (a parallel session may have pushed):
   ```
   git fetch origin
   git log --oneline origin/main..feature/lamusa-integration | wc -l   # feature ahead (expect >0)
   git log --oneline feature/lamusa-integration..origin/main           # feature BEHIND — MUST be EMPTY
   ```
   If the second command prints **anything**, feature is behind → **STOP**. Reconcile first
   (`git merge origin/main` into feature, resolve, re-run **all** of Gate 3), then restart Gate 1.
2. **Live function count = the deploy denominator:**
   ```
   firebase functions:list --project xpizza-delivery
   ```
   The deploy source exports **28** functions (the live count as of this runbook):
   `allocateFacturaOnSale, autoAssignOnOrderCreate, blockPublicSignup, cancelPaidOrder,
   chargeOnlineOrder, confirmOnlinePayment, createOrder, endDriverShift, healthz,
   ingestDriverLocation, materializeOnConfirm, monitorAssignmentTimeout, notifyDriverOnAssignment,
   notifyDriverOnCancellation, onDriverSubscriptionChange, onIncomingWhatsApp, onOrderCancelled,
   paymentStatus, pixelPayWebhook, reconcilePayments, refundReconciler, registerDriverPushToken,
   resolveManualReconciliation, sendOrderStatusNotifications, startDriverShift, sweepStalePending,
   unregisterDriverPushToken, voidFacturaOnCancel`.
   **PASS only if every live function from `functions:list` is in that set** (source ⊇ live).
   If `functions:list` shows **any function not in the 28**, or **more than 28** → **STOP** (deploying
   would prune it). Re-confirm 28 is still the live count — don't trust the stale number.
   (Cross-check the source count locally: `grep -cE "^exports\.[a-zA-Z]+ = (onRequest|onValueWritten|onSchedule|onCall|beforeUserCreated)" xpizza-functions/index.js` → 28.)

## GATE 2 — Right worktree · commit · env
- **Worktree:** deploy from **`/Users/xavierlacayo/xpizza-lamusa/xpizza-functions`** — NOT
  `~/Downloads/xpizza-delivery` (the earlier wrong-worktree scare). `pwd` to confirm.
- **Commit:** `git rev-parse HEAD` == the FF'd main head (Gate 6) / `645dd1c`.
- **Env (no placeholder ship):** `ls -la xpizza-functions/.env*` → **only `.env.example`** (no `.env`).
  `firebase.json` ignores `.env`/`.env.example`, and Gen2 **preserves the existing prod runtime env**
  — the deploy ships no secrets. Confirm there is **no `.env`** with placeholder values (the prior
  MAKE_SECRET scare). If a `.env` exists, inspect it; it must not contain placeholders.

## GATE 3 — Test gates (JDK / emulator-capable env)
From `xpizza-functions/`:
```
npm test                 # exit 0 — all unit/golden suites
npm run check:rules      # rules synced + restaurants-rules guard
npm run test:rules       # emulator: restaurants .read/.write invariants
```
Then the byte-identical **emulator-e2e** (one mode per `emulators:exec` for a cold getIdentity cache),
env `GCLOUD_PROJECT=demo-xpizza MAKE_SECRET=… CREATEORDER_URL=…`.

**⚠️ emu-seed CHAINING (surfaced during the live deploy).** Each `emulators:exec` starts a **FRESH**
emulator. The `cash`/`reject`/`pending` modes **do NOT self-seed** the x_pizza identity — they read a
pre-seeded `restaurants/x_pizza/identity`, so `node deploy/emu-seed.js <state>` **must be chained with
`&&` inside the same exec**, before the e2e drives. (`la_musa` self-seeds la_musa inside the e2e; it
needs no emu-seed.) Seed state per mode: cash/pending→`active`, reject 400→`inactive`, reject
503→`missing`.
```
firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/emu-seed.js active   && node deploy/emulator-e2e.js cash"
firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/emu-seed.js inactive && node deploy/emulator-e2e.js reject 400"
firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/emu-seed.js missing  && node deploy/emulator-e2e.js reject 503"
firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/emu-seed.js active   && node deploy/emulator-e2e.js pending"
firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/emulator-e2e.js la_musa"
```
All must print their `✓` lines and exit 0. Seeds are **emulator-only** — prod is untouched.

## GATE 4 — Prod seed state (read-only, no re-seed)
Confirm la_musa config exists + is dark (Phase 0 already seeded it), so `getRestaurantIdentity('la_musa')`
resolves but the active-gate rejects:
```
firebase database:get /restaurants/la_musa/identity --project xpizza-delivery
```
Expect `active:false`, `whatsapp_enabled:false`, valid hub/name/phone/radius. Also confirm x_pizza:
`firebase database:get /restaurants/x_pizza/identity` → `active:true`. **Do NOT re-seed** — verify only.

## GATE 5 — Rollback prep (capture BEFORE deploy)
Gen2 functions are Cloud Run services. Capture the current serving revision per function so you can
instantly revert:
```
gcloud run services list --project xpizza-delivery --region us-central1 \
  --format="table(metadata.name, status.traffic[0].revisionName)"   # save this output
```
Rollback (if post-deploy smoke fails), per affected function:
```
gcloud run services update-traffic <fn> --region us-central1 --to-revisions=<PINNED_REV>=100 --project xpizza-delivery
```
(Same mechanism as the Phase 0 rollback precedent.)

## GATE 6 — FF → deploy → verify
1. **FF to main** (no content change; main == feature after this):
   ```
   git checkout main && git merge --ff-only feature/lamusa-integration && git push origin main
   ```
   (Re-run Gate 1's behind-check if any time passed since.)
2. **Deploy functions** (prune-safe per Gate 1), from `xpizza-functions/`:
   ```
   firebase deploy --only functions --project xpizza-delivery
   ```
3. **Rules — already LIVE since Phase 0; this is an idempotent re-apply (expect NO effective diff).**
   The tracked rules (`xpizza-reference/database.rules.json`) last changed at the **Phase 0** commits
   (`4155909`/`a1777d3`) — **already on `origin/main` and deployed to prod in the Phase 0 cutover**
   (additive restaurants/identity grants; the invariant gate fired then). So **vs current prod the
   rules are UNCHANGED.** You may **verify-and-skip** or re-apply — both safe; re-applying identical
   rules is a no-op. (D2's `order_tracking.restaurant_id` needs no rule — that node has no `.validate`.)

   **⚠️ Equality gate — the untracked-deploy landmine (same class as worktree/.env):**
   `firebase.json` deploys **`xpizza-functions/database.rules.json`**, which is **gitignored/untracked**.
   The **audited** rules (every `restaurants-rules.guard` / `check:rules` test in this project) are
   **`xpizza-reference/database.rules.json`**. They are identical now, but the untracked copy can drift
   silently and git won't flag it. **Before any rules deploy, what-deploys MUST equal what-was-audited:**
   ```
   diff xpizza-functions/database.rules.json xpizza-reference/database.rules.json   # MUST be empty — else ABORT
   ```
   (`check:rules`/`sync:rules` copy reference → functions-dir and assert this; run the bare `diff` as
   an explicit gate anyway.) To re-apply: `npm run deploy:rules --prefix xpizza-functions` (predeploy
   `check:rules` guards). To skip: confirm the Firebase console RTDB Rules tab already matches the file.
4. **Post-deploy verification (the prime directive):**
   ```
   firebase functions:list --project xpizza-delivery     # 28, all ACTIVE/healthy — nothing pruned
   ```
   - **Smoke-test a real X. Pizza order** end-to-end (cash + online) — it MUST behave exactly as
     before (the whole point). Confirm an x_pizza WhatsApp + tracker link still work.
   - Confirm **la_musa is still dark**: a la_musa order (if forced) is rejected at the active-gate;
     no la_musa traffic flows.

## After this deploy — la_musa is LIVE-DARK
Nothing customer-facing changed. The remaining **launch** gates (separate, later — a small deploy +
ops, before `active:true`): `createOrderWithTasks` restaurant-awareness (if a dispatcher order path is
added), the la_musa **copy/assets** slice (WhatsApp food-noun map + tracker palette/logo — HARD before
`whatsapp_enabled:true`), `PIXELPAY_RETURN_URL_LA_MUSA` + `ULTRAMSG_*_LA_MUSA` + `TRACKING_BASE_LA_MUSA`
env, the la_musa Netlify order-form + KDS sites, `PREVIEW_MODE=false`, then the `active:true` /
`whatsapp_enabled:true` flips.

## ABORT criteria (stop, don't deploy)
Any of: feature behind origin/main · `functions:list` has a function not in the 28 (or >28) · wrong
worktree · a `.env` with placeholders · **`xpizza-functions/database.rules.json` ≠
`xpizza-reference/database.rules.json`** (untracked-deploy drift) · any Gate-3 test red · la_musa
identity missing/active in prod.
