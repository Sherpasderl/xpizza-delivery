# Deploy Runbook (S3) — pre-flip functions + rules deploy

_Operator-run (Xavier runs every prod command; the auditor + executor verify read-only). The second
batched deploy: **E1 + S1-server + S2-server + S3-server** — all Codex-APPROVED, all **behavior-
preserving for X. Pizza (test-proven, not literal byte-identical — see Gate 3.5)** / live-DARK.
Bundles the driver pickup-hub work behind the launch flip. Same gated
shape as `LA_MUSA_DEPLOY_RUNBOOK.md` (which took 2 corrections — re-apply its two earned landmines:
the function-prune gate and the untracked-rules equality gate). Highest risk is again the deploy
mechanics, not the code. Do the gates in order._

## What's being deployed (verified 2026-07-01; TARGET SHA `8e0d8a1`)
- **Bundle:** `645dd1c..8e0d8a1` on `feature/lamusa-integration`, **17 files in `xpizza-functions/`,
  +1453/−77** — E1 (whatsapp food-noun) + S1-server (assign-hub `ALLOWED_HUBS`/`isHubResolvable`,
  driver-ingest per-restaurant geofence, `syncDriverHub` trigger, restaurant_id on pickup tasks) +
  S2-server (same-hub-aware stacking) + S3-server (universal delivery-CAS in claim-delivery, the
  self-heal + OFFER sweeper in sweep-pending, index CAS/heal wiring) + **the gate-#4/#6 fix (heal skips
  terminal orders BEFORE strand-eval; driver-write rule regression tests)** + **the accepted-residual
  doc comment (`8e0d8a1`)**. **This SHA (`8e0d8a1`), not `9f36854`, is the deploy target — the #4
  heal-skip lives here, not in `9f36854`. Code behavior at `8e0d8a1` == verified `a23de67` (the delta
  is the residual comment + the S3d note only — no behavior change, arbiter-accepted, no code re-gate).**
- **Functions: 28 → 30** — two NEW: **`syncDriverHub`** (S1) + **`sweepPendingOrders`** (S3). All 28
  current functions are on this branch (nothing removed) → prune-safe by construction.
- **Rules: +1 additive line** — `drivers/$driver_id/current_hub_task_id` `.validate`
  (dispatcher-membership, mirrors the sibling `current_hub_*`; S1). New → this deploy includes rules.
- **NOT in this deploy** (separate Netlify/native builds): E2 tracker, E3 KDS, and the D/S2/S3
  **client** halves.

---

## GATE 1 — Prune safety / function-set completeness  ⚠️ THE landmine
`--only functions` PRUNES any live function absent from source. This batch **adds** 2 and removes 0,
so it's prune-safe **if** the branch is current and source ⊇ live.
1. **Branch currency vs REMOTE main:**
   ```
   git fetch origin
   git log --oneline feature/lamusa-integration..origin/main   # MUST be EMPTY (feature not behind)
   ```
   Anything printed → **STOP**, reconcile (`git merge origin/main`, re-run Gate 3), restart.
2. **Compare NAME-SETS, not counts** (#5 — a count match can hide a simultaneous add+prune):
   ```
   firebase functions:list --project xpizza-delivery | awk 'NR>1{print $1}' | grep -vE '^$|^─' | sort -u > /tmp/live.txt
   grep -oE "^exports\.[a-zA-Z0-9_]+" xpizza-functions/index.js | sed 's/exports\.//' | sort -u > /tmp/src.txt
   comm -23 /tmp/live.txt /tmp/src.txt   # live-not-in-source = WOULD BE PRUNED — MUST be empty
   comm -13 /tmp/live.txt /tmp/src.txt   # source-not-live = ADDED — expect exactly syncDriverHub + sweepPendingOrders
   ```
   (Sanity-check the `functions:list` name extraction against its actual columns before trusting it.)
   **PASS only if** `comm -23` (the prune set) is **EMPTY** and `comm -13` (the add set) is **exactly**
   `syncDriverHub` + `sweepPendingOrders`. Any other delta → **STOP**. Post-deploy (Gate 6) re-runs the
   same set compare (post = 30, prune set empty).

## GATE 2 — Worktree · commit · env
- **Worktree:** deploy from **`/Users/xavierlacayo/xpizza-lamusa/xpizza-functions`** (NOT
  `~/Downloads/xpizza-delivery`). `pwd`.
- **Commit:** FF target is HEAD **`8e0d8a1`** — contains the gate-#4/#6 fix (the heal terminal-skip;
  `9f36854` does NOT — deploying `9f36854` would ship without the #4 fix) + the accepted-residual doc
  comment. `git rev-parse HEAD` must be **`8e0d8a1`** (or a later docs-only commit whose
  `xpizza-functions/` tree equals `8e0d8a1` — verify `git diff 8e0d8a1 HEAD -- xpizza-functions/` is
  empty). Working tree otherwise has **untracked docs artifacts only**
  (`DRIVER_PICKUP_HUB_*`, `COMMIT_MSG_S3.txt`, the runbooks) — no tracked `M`.
  The working tree has **untracked docs artifacts only** (`DRIVER_PICKUP_HUB_*`, `COMMIT_MSG_S3.txt`)
  — harmless; firebase ignores non-source. No tracked `M` files.
- **Env:** from the `xpizza-functions/` worktree (the Gate-2 cwd), `ls -la .env*` → **only
  `.env.example`**; `firebase.json` ignores `.env`/`.env.example` → Gen2 preserves prod runtime env
  (same as the 2026-06-30 deploy).

## GATE 3 — Emulator gate (Java/emulator env; auditor runs)
From `xpizza-functions/`:
```
npm test              # exit 0 — 16 suites incl. sweep-pending (22) + claim-delivery + assign-hub S1 pins
npm run check:rules   # rules synced (functions-dir == reference) + restaurants-rules guard
npm run test:rules    # emulator: restaurants .read/.write invariants
```
**emu-seed CHAINING** (from the 2026-06-30 gate-3b fix — each `emulators:exec` is a fresh emulator;
cash/reject/pending need `emu-seed.js` chained; la_musa self-seeds):
```
# REQUIRED env (emulator-e2e.js POSTs to createOrder; omit → "Failed to parse URL from undefined").
# createOrder reads process.env.MAKE_SECRET (index.js:391) — the SAME shell var is sent as the bearer,
# so any matching value works. Functions emulator default port 5001, region us-central1.
export JAVA_HOME=/opt/homebrew/opt/openjdk PATH=$JAVA_HOME/bin:$PATH
export GCLOUD_PROJECT=demo-xpizza MAKE_SECRET=emu-test-secret
export CREATEORDER_URL=http://127.0.0.1:5001/demo-xpizza/us-central1/createOrder
firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/emu-seed.js active   && node deploy/emulator-e2e.js cash"
firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/emu-seed.js inactive && node deploy/emulator-e2e.js reject 400"
firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/emu-seed.js missing  && node deploy/emulator-e2e.js reject 503"
firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/emu-seed.js active   && node deploy/emulator-e2e.js pending"
firebase emulators:exec --only functions,database --project demo-xpizza "node deploy/emulator-e2e.js la_musa"
```
**S3-specific** — the `casAssign` (6/6) + `release` (3/3) emulator passes already ran; the sweeper
e2e is an AUDITOR-RUN artifact (`/tmp/sweeper-scenario-emu.js`, 9/9 on 2026-07-02) — kept OUT of the
functions tree so the deploy target `8e0d8a1` stays byte-identical (like the other authority tests):
```
cd xpizza-functions && export GCLOUD_PROJECT=demo-xpizza JAVA_HOME=/opt/homebrew/opt/openjdk PATH=$JAVA_HOME/bin:$PATH
firebase emulators:exec --only functions,database --project demo-xpizza "node /tmp/sweeper-scenario-emu.js"
```
with `config/sweep_pending_enabled=false`, the OFFER pass makes **no re-offers** (but the seeded
order IS offer-eligible — proven, so the skip is the gate not ineligibility); the **heal** nulls a
seeded stranded half-claim **but leaves a seeded terminal (delivered) mismatch untouched** (gate-#4); `autoAssign`/`timeout` with the universal CAS are **behavior-equivalent
uncontended (same observable outcome)** as today.

## GATE 3.5 — Live-DARK safety (must all be true — state, then verify in Gate 6)
**Behavior-preserving, NOT literal byte-identical (#3).** Unlike the prior deploy, this batch has
**live behavior deltas** that are *test-proven to preserve X. Pizza's observable outcomes* but are not
byte-for-byte no-ops. Enumerated so we don't overclaim:
- the **universal delivery-CAS** — a transaction now guards the claim; **same result uncontended**
  (emulator-proven casAssign 6/6), diverges only under a genuine concurrent double-claim (correctly).
- **`syncDriverHub`** hub-writes (`driver.current_hub_*`/`current_hub_task_id`) — the **OLD driver
  client (no D shipped) ignores them → inert for x_pizza**; this IS the S1 server-first-before-client
  ordering. **(Optional verify, #5)** confirm no active driver is already on the D native build:
  `firebase database:get /drivers --project xpizza-delivery` → no driver has a `location_source` /
  client-version indicating the new build (which would consume `current_hub_*`). Expect all on the
  current client → the inert claim holds.
- the **shift-clear** on endShift + the **per-restaurant geofence-guard** path — x_pizza resolves to
  its own hub, outcome unchanged.
Prime-directive recalibration: "don't change X. Pizza's observable behavior" (proven by tests + the
Gate-6 smoke), not "identical bytes."

Also:
- **The HEAL runs LIVE by design** — it protects the live `autoAssign`/`timeout` claims from stranded
  half-claims. **#4 fix applied:** it now skips **terminal** orders (cancelled/**delivered/completed**),
  not just cancelled. Gate 3.6 dry-run confirms no pre-existing ACTIVE-order strand exists; Gate 6 smoke
  confirms it does **not** false-fire.
- **The OFFER pass MUST stay OFF — PRE-DEPLOY ABORT GATE (#1):** before deploying,
  `firebase database:get /config/sweep_pending_enabled --project xpizza-delivery` **MUST** be `null`
  or `false`. If it is `true`, the OFFER pass would go live the moment `sweepPendingOrders` deploys →
  **ABORT**. (Re-verified post-deploy in Gate 6.)
- **SCOPE BOUNDARIES — this deploy does NOT:** flip `sweep_pending_enabled`; ship the driver native
  build; touch `active:true` / `whatsapp_enabled:true`.

## GATE 3.6 — Heal-safety prod dry-run (#4, read-only, BEFORE deploy)
The heal is live (it protects the live claims). Before turning it loose on prod data, confirm prod has
**no pre-existing anomaly it would act on** — a historical `pickup≠delivery` `assigned_driver_id`
mismatch on an ACTIVE order, or a stray `half_claim_since`. (The #4 fix makes it skip terminal orders,
so delivered/cancelled mismatches are already safe — this scan is for ACTIVE ones.)
```
firebase database:get /tasks --project xpizza-delivery > /tmp/tasks.json
firebase database:get /orders --project xpizza-delivery > /tmp/orders.json   # for status (active vs terminal)
node -e '
  const t = require("/tmp/tasks.json") || {}, o = require("/tmp/orders.json") || {};
  const TERM = new Set(["cancelled","delivered","completed"]);
  const ids = new Set(Object.keys(t).map(k => k.replace(/_(pickup|delivery)$/, "")));
  let active = 0, stray = 0;
  for (const id of ids) {
    const p = t[id+"_pickup"], d = t[id+"_delivery"];
    const status = (o[id]||{}).status;
    // stray marker lives on the DELIVERY task — check independently of pickup existence so an
    // orphan-delivery task (no paired pickup) with a stray marker still blocks (Codex #2 fix).
    if (d && d.half_claim_since != null) { console.log("STRAY MARKER", id, status, d.half_claim_since); stray++; }
    if (!p || !d) continue;   // mismatch check needs BOTH tasks
    const mismatch = (p.assigned_driver_id||null) !== (d.assigned_driver_id||null);
    if (mismatch && !TERM.has(status)) { console.log("ACTIVE MISMATCH", id, status, p.assigned_driver_id, "vs", d.assigned_driver_id); active++; }
  }
  console.log(active ? `\n✗ ${active} ACTIVE-order mismatch(es) — RESOLVE before deploy (heal would unassign them on the first sweep)` : "\n✓ no ACTIVE pickup≠delivery mismatch");
  console.log(stray ? `✗ ${stray} stray half_claim_since marker(s) — inspect/clear before deploy` : "✓ no stray half_claim_since marker");
  console.log(`\nGATE: ${active === 0 && stray === 0 ? "PASS" : "FAIL"} (active=${active}, stray=${stray})`);
'
```
**PASS only if `active === 0 && stray === 0`.** (Prior run 2026-07-01 with the earlier scan: **133 orders,
0/0** — but that scan skipped orphan-delivery stray markers; **re-run the corrected scan above at deploy**
and confirm 0/0 fresh.) Paste the output to the auditor to verify clean before
deploying. (If any ACTIVE mismatch exists, resolve it — reassign both tasks to one driver, or clear —
before deploy.)

## GATE 4 — Prod seed state (read-only)
`firebase database:get /restaurants/la_musa/identity` → `active:false`, `whatsapp_enabled:false`
(unchanged since Phase 0). `.../x_pizza/identity` → `active:true`. **No re-seed** — verify only.

## GATE 5 — Rollback prep (capture BEFORE deploy)
Per-function Cloud Run serving-revision manifest, saved to **`~/lamusa-rollback-2026-07-01.txt`**:
```
gcloud run services list --project xpizza-delivery --region us-central1 \
  --format="table(metadata.name, status.traffic[0].revisionName)" | tee ~/lamusa-rollback-2026-07-01.txt
```
**Full rollback = THREE parts (#2 — pinned-revision redeploy alone does NOT undo this batch):**
- **(a)** redeploy the pinned prior revisions for the **28 EXISTING** functions:
  `gcloud run services update-traffic <fn> --region us-central1 --to-revisions=<PINNED>=100 --project xpizza-delivery`.
- **(b)** **DELETE the 2 NEW functions** — they have no prior revision, so pinning can't remove them
  (noninteractive so a rollback can't stall on a prompt):
  `firebase functions:delete sweepPendingOrders syncDriverHub --region us-central1 --force --project xpizza-delivery`
  (sweepPendingOrders is a scheduler job, syncDriverHub an eventarc trigger — both must be explicitly deleted).
- **(c)** **revert the rules** — the +1 `current_hub_task_id` `.validate` is new this batch:
  `git checkout <pre-batch> -- xpizza-reference/database.rules.json && npm run deploy:rules --prefix xpizza-functions`
  (or restore the prior rules in the console). Additive, so leaving it is harmless, but full rollback reverts it.
- **Post-rollback verify (#6):** `firebase functions:list` (the 2 new are GONE, count back to 28) ·
  `git diff` the deployed rules vs the pre-batch file · re-check `/config/*` flags unchanged.

## GATE 6 — FF → deploy → rules → verify
1. **FF main** (re-check Gate 1 behind-test if time passed): `git checkout main && git merge --ff-only feature/lamusa-integration && git push origin main` (ref-push to **`8e0d8a1`** or the branch tip, matching the 2026-06-30 pattern). **Confirm `git diff 8e0d8a1 origin/main -- xpizza-functions/` is empty** (main's functions tree == the verified target).
2. **Deploy functions** (from `xpizza-functions/`): `firebase deploy --only functions --project xpizza-delivery`. **Assert:** all "Successful update", **ZERO** prune/delete lines, and **re-run the Gate-1 name-set diff** (not just the count — #5):
   ```
   grep -oE "^exports\.[a-zA-Z0-9_]+" index.js | sed 's/exports\.//' | sort -u > /tmp/src2.txt   # cwd=xpizza-functions/ (where firebase.json lives) → read index.js, NOT xpizza-functions/index.js. Same file as Gate-1, REGENERATED post-FF (don't reuse /tmp/src.txt)
   firebase functions:list --project xpizza-delivery | awk 'NR>1{print $1}' | grep -vE '^$|^─' | sort -u > /tmp/live2.txt
   comm -23 /tmp/src2.txt /tmp/live2.txt   # source-not-deployed — MUST be empty (nothing failed to deploy)
   comm -13 /tmp/src2.txt /tmp/live2.txt   # deployed-not-source — MUST be empty (nothing stale left behind)
   wc -l /tmp/live2.txt                    # == 30; syncDriverHub + sweepPendingOrders present, all ACTIVE
   ```
3. **Deploy rules** (the +1 additive `current_hub_task_id` line — NEW this batch). **Untracked-file
   equality gate FIRST** (the 2026-06-30 landmine — `firebase.json` deploys the gitignored
   `xpizza-functions/database.rules.json`; audited source is `xpizza-reference/database.rules.json`):
   ```
   diff xpizza-functions/database.rules.json xpizza-reference/database.rules.json   # MUST be empty — else ABORT
   npm run deploy:rules --prefix xpizza-functions                                    # predeploy check:rules guards; additive
   ```
4. **Config check (the dark-safety flags):**
   ```
   firebase database:get /config/sweep_pending_enabled --project xpizza-delivery    # ABSENT or false — OFFER pass stays OFF
   firebase database:get /config/auto_assign_enabled   --project xpizza-delivery    # unchanged from before
   ```
5. **Smoke (the prime directive):** place a clean **X. Pizza cash** order end-to-end → KDS + dispatch
   + auto-assign + WhatsApp + tracker behave **exactly as before**. Watch the live order set for
   **~5 min**: the HEAL must **not** false-fire (no spurious `assigned_driver_id` nulls on healthy
   claims) — this is the live confirmation of Gate 3.6.
6. **Secret preservation (#7 — the cash smoke does NOT exercise these):** Gen2 preserves env across
   deploys, but the cash path touches neither PixelPay nor (in a byte-identical send) the payment
   secrets. Verify the **online + WhatsApp** secrets survived:
   - place a real **X. Pizza ONLINE (PixelPay hosted)** test order → checkout opens, callback
     materializes → confirms `PIXELPAY_*` + `PIXELPAY_WEBHOOK_SECRET` + `MAKE_SECRET` intact;
   - confirm an **outbound WhatsApp** actually sends (order-received) → confirms `ULTRAMSG_INSTANCE_ID`
     + `ULTRAMSG_TOKEN` intact.
   (Or inspect the Cloud Run service env for `createOrder`/`chargeOnlineOrder`/`sendOrderStatusNotifications`.)

## ABORT criteria
feature behind origin/main · the prune set (`comm -23` live-not-in-source) non-empty, or the add set
≠ exactly {syncDriverHub, sweepPendingOrders}, or any prune line at deploy · wrong worktree ·
placeholder `.env` · `xpizza-functions/database.rules.json` ≠ `xpizza-reference/…` · any Gate-3 test
red · **`sweep_pending_enabled` truthy in prod (pre-deploy)** · **Gate-3.6 not `active === 0 && stray
=== 0`** (any ACTIVE pickup≠delivery mismatch OR any stray `half_claim_since`) · la_musa identity
missing/active · heal false-fires on the smoke order.

## After this deploy
E1 (WhatsApp copy) + the S1/S2/S3 server is live-dark. Still separate: E2/E3 + client halves (Netlify
/ native), the driver native build, ops/config env, and the `active:true` + `whatsapp_enabled:true`
flips (+ `sweep_pending_enabled` if/when the OFFER pass is wanted — a later, separate decision).
