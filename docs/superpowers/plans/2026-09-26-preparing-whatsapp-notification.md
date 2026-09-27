# Proactive "preparing" WhatsApp — Implementation Plan (Fix A) · REV 2 (post codex + advisor stale-tree catch)

> **For the executor:** build task-by-task, LOCAL-ONLY, **in the `bcf5ff0` build worktree `~/Downloads/xpizza-preparing`** — NOT `/Users/xavierlacayo/xpizza-lamusa` (that's the factura branch @ `0830a6a`, ~600 lines stale; verifying/building there was the REV-1 error). **Base (code) = `bcf5ff0`.** Each task ends green + a commit. Advisor re-gates REV-2, then gates the built diff. Spec: `docs/superpowers/specs/2026-09-26-preparing-whatsapp-notification-design.md`.

**Goal:** one WhatsApp on the `preparing` transition ("preparando — estará listo en ~X min"), both brands, both order types — closing the silent prep window. New trigger; the money sender stays byte-unchanged.

## Global constraints
- **`sendOrderStatusNotifications` (index.js:4090) BYTE-UNCHANGED** vs `bcf5ff0` (diff-prove).
- **Marker `db.ref('preparing_notifications/' + orderId)`** — interpolated, top-level, NOT under `/orders` (can't re-fire the SIX order-node watchers: materialize 2634 / facturaAlloc 2673 / displayNumber 2740 / facturaVoid 2864 / staffNotify 3257 / autoAssign 5264).
- **Never throws** — wrap init/template/config-read; only writes are marker-only.
- **Brand-agnostic ETA:** `restaurants/<rid>/prep_eta_min`; single neutral fallback `25`; NO per-brand literal (test asserts absence). Both brands parity.
- **Confirm sends via `whatsapp.isSendConfirmed(result)`** (whatsapp.js:161, exported :338) — the tested helper (accepts `sent:true`/`"true"` OR a real `id`, rejects error-body/bare-`{}`). NOT `result != null` (pickup's lax bar, index.js:4468), NOT a hand-rolled `result && result.id` (false-negatives a legit `sent:true`).
- **Stale-status guard:** suppress if the loaded order's *current* `status !== 'preparing'` (silent-terminal writers exist, e.g. `close_fulfilled`→`completed`, resolve-manual.js:159→222).

---

### Task 1 — `tplPreparing` template + pure `resolvePrepEtaMin` (TDD)

**Files:** modify `whatsapp.js`; new `preparing-notify.test.js`.

- **Step 1 (RED):** `preparing-notify.test.js`:
  - `tplPreparing(pickup)` → "preparando", "estará listo para recoger en ~20 min", brand emoji, tracking URL when token present / omitted when absent — golden for BOTH x_pizza + la_musa.
  - `tplPreparing(delivery, eta 20)` → "estará listo en ~20 min" + "Te avisamos apenas salga en camino" (readiness wording; NOT "sale hacia vos", no arrival/dispatch promise).
  - `resolvePrepEtaMin(v)`: finite>0 → v; absent/NaN/≤0 → `DEFAULT_PREP_ETA_MIN` (one constant). Assert fallback is not per-brand.
- **Step 2:** run → fail.
- **Step 3 (GREEN):** add `tplPreparing` (copy-by-order_type, readiness) + `resolvePrepEtaMin` + `DEFAULT_PREP_ETA_MIN = 25` to whatsapp.js; export. `resolvePrepEtaMin` is PURE (takes a value; the DB read is caught in the trigger, Task 2).
- **Step 4:** pass. Assert whatsapp.js has no x_pizza/la_musa prep-eta literal.
- **Step 5:** commit — `feat(whatsapp): tplPreparing readiness template + pure prep-ETA resolver`.

### Task 2 — `notifyPreparing` trigger (mirror `notifyPickupReady`, with the REV-1 guards)

**Files:** modify `index.js` (new export only; existing triggers untouched).

- **Step 1:** add `exports.notifyPreparing = onValueWritten({ ref:'/orders/{orderId}/status', region:'us-central1' }, …)`:
  - guard `after !== 'preparing' || before === after` → return.
  - `notifRef = db.ref('preparing_notifications/' + orderId)` (interpolated); guarded `stamp`/`skip` diagnostics (abort if `claimed_at`/`sent_at` already present).
  - load order once; read-error → `read_error_at` + return; missing → `skip('order_missing')`.
  - eligibility skip-stamps: no phone → `skip('no_phone')`; `restaurant_id ∉ SUPPORTED_WHATSAPP_RESTAURANTS` → `skip`; `!isEnabledForRestaurant` → `skip('whatsapp_disabled')`. **No `order_type` gate.**
  - **STALE-STATUS GUARD:** `if (order.status !== 'preparing') return skip('stale_status');`
  - claim `claimed_at` (transaction) → `!committed` → return (no auto-reclaim).
  - await `send_started_at` set; throw → return (no send).
  - **ETA (caught read):** `try { v = (await db.ref('restaurants/'+rid+'/prep_eta_min').once('value')).val(); } catch { v = null; }` → `eta = resolvePrepEtaMin(v)`.
  - `body = tplPreparing({ customerName, etaMinutes: eta, orderType: order.order_type, trackingToken: order.tracking_token, restaurantId: rid })` (wrapped).
  - send; `whatsapp.isSendConfirmed(result)` → `sent_at`; else `send_unresolved_at`. Never rethrow. Wrap init/template/unexpected so the handler always resolves.
- **Step 2:** `node --check index.js`; **diff-prove `sendOrderStatusNotifications` byte-unchanged** vs `bcf5ff0`.
- **Step 3 (real tests, codex pt 6):** `test/preparing-ready.emulator.test.js` modeled on `test/pickup-ready.emulator.test.js`:
  - two concurrent/redelivered `→preparing` events → exactly one `result.id`-confirmed send + distinct per-order markers;
  - each failure exit (missing order, no phone, unsupported rid, disabled, claim lost, `send_started_at` fail, **ETA-read rejection → fallback 25**, **stale-status → suppressed**);
  - provider classification via `isSendConfirmed`: `{}` / `null` / thrown / `{error}` → `send_unresolved_at`; `{sent:true}` and `{id}` → `sent_at`;
  - **zero `/orders` writes** (only `/preparing_notifications/<id>` touched).
- **Step 4:** commit — `feat(functions): notifyPreparing trigger (stale-status guard, id-confirmed, fail-open)`.

### Task 3 — seed config + wire tests + full suite

**Files:** `package.json`; config-seed note.

- **Step 1:** wire `preparing-notify.test.js` into the npm `test` chain (after `whatsapp-config.test.js`); wire `test/preparing-ready.emulator.test.js` into the emulator test script alongside `test/pickup-ready.emulator.test.js` (NOT the plain `node` chain — it needs the DB emulator).
- **Step 2:** config seed (owner applies at deploy): `restaurants/x_pizza/prep_eta_min = 20`, `restaurants/la_musa/prep_eta_min = 30` (fallback 25 makes it safe pre-seed).
- **Step 3:** `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test` → EXIT 0; run the emulator test via its script → pass.
- **Step 4:** commit — `test(functions): wire preparing-notify + emulator tests; prep_eta_min seed note`.

---

## Handback DoD
- Branch@SHA off `bcf5ff0`; `sendOrderStatusNotifications` byte-unchanged (diff-proven); new trigger + template + pure resolver only.
- Emulator handler tests green (concurrency/failure/stale-status/zero-/orders-writes); pure goldens both brands; config-driven (no per-brand literal — asserted); full suite EXIT 0.
- Confirm sends via `isSendConfirmed(result)`; stale-status guard; fail-open/never-throws; marker isolated in `/preparing_notifications/`.
- Deploy = `firebase deploy --only functions:notifyPreparing` + seed `prep_eta_min` both brands + smoke: real `new→preparing` (Empezar) → one "preparando ~X min"; verify money sender's messages (recibido/va en camino/entregado) unchanged; verify a delayed/stale `preparing` on an already-advanced order does NOT send.

## Codex re-gate framing (advisor)
*Re-verify REV-2 (anchors now from `bcf5ff0`, not the stale factura tree): stale-status guard closes the late-event mis-send; ETA read is caught (never-throws holds incl. template/init/config); confirmation via `isSendConfirmed(result)` (not `!= null`, not hand-rolled id); marker interpolated + isolated from the SIX order-node watchers; `sendOrderStatusNotifications` (index.js:4090) byte-unchanged; emulator tests exercise concurrency/failure/zero-/orders-writes; brand-agnostic + both brands.*
