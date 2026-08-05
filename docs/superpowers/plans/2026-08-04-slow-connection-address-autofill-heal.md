# Slow-Connection Address-Autofill: Seamless Heal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A logged-in customer on a slow connection sees their preloaded delivery address at checkout — never the raw "Tus datos" form — with a clean "Cargando tu dirección…" hold that resolves to their address, and a bounded fallback to the raw form so no one is ever trapped.

**Architecture:** Purely additive on the *fail-open path only*. When the 1500ms profile read times out for a logged-in user, show a loading hold instead of the raw form, attach a one-shot no-deadline `onValue` (the reward chip's pattern), and route the landed profile through the existing `initDeliveryStep(preSnap)` with no re-read. A ~5s timer falls back to the raw form if the profile never lands. Guest, fast, and pickup paths are byte-identical to today.

**Tech Stack:** Vanilla ES (browser IIFE) in `account.js`; Firebase modular SDK (`ensureFirebase` → `dbMod.onValue`/`get`); Node `assert` wiring-guard tests run via `xpizza-functions` `npm test`.

## Global Constraints

- **BOTH forms, identical edit:** every source change applies verbatim to `la-musa-orders/account.js` AND `xpizza-orders/account.js`. They are byte-identical past the CONFIG block; the test suite loops both, so an edit to one only fails until both match. Never let them drift.
- **Fast path untouched:** nothing new runs when the read lands `ok` (fast connection). No new listeners, timers, or DOM work on the warm path. Form load and first paint are unchanged.
- **Never trap the customer:** every failure mode must degrade to the raw fillable fields (fail-open). The bounded fallback guarantees this.
- **Payment and step 2 are untouched:** the prefill and its loading state are entirely on step 1 (`#acct-deliver` / `#raw-name-phone`, above the Continuar button); payment lives on the separate step-2 screen behind the map-confirm step. Do NOT call `setPaymentVisible`, add a submit gate, or alter `.pay-container`.
- **Preserve invariants:** R5 restore-race (`_acctRestoring`/`_acctRestoreGen`), no-clobber of `#address-details`, guest byte-identical, pickup out of scope.
- **No emoji in form chrome:** the loading line uses the existing `PERSON_SVG` + `.acct-fine` copy idiom (clean, monochrome).
- **Client-only:** no functions deploy, no rules change. Owner deploys the two order forms (Netlify per-folder, explicit `--site`) after the order-form codex checkout-integrity gate.
- **Money/checkout-adjacent:** the delivery step determines the order's address → codex-gate before merge/deploy; advisor does not self-approve.

---

## File Structure

- **Modify:** `la-musa-orders/account.js` — all source changes (state, helpers, fail-open branch split, logout teardown).
- **Modify:** `xpizza-orders/account.js` — identical changes (parity).
- **Modify:** `xpizza-functions/address-autofill-recheckout.test.js` — extend the existing both-forms wiring-guard test with the seamless-heal assertions. (The pure `shouldRecoverDeliveryStep` truth table already there is reused unchanged — the heal callback gates on that same function.)

Anchors (origin/main line numbers, la-musa; xpizza differs by a few lines — match by symbol, not number):
- `_acct*` module state block: ~2132
- `initDeliveryStep(preSnap)`: 2158; fail-open branch: 2178
- `maybeRecoverDeliveryStep`: 2247 (inline state object ~2248)
- `rewardsReset`: 172; `injectDeliverStyles`: 2005; `renderS1CompactSummary` (shell reference): 3678; `revertToNormalFillable`: 3770. Step-1 mounts: `#acct-deliver` (index.html:1326), `#raw-name-phone` (1327). Payment (`#s2`) is NOT touched.

---

## Testing note

`account.js` is a browser-only IIFE with no jsdom harness in this repo. Per the established pattern in `address-autofill-recheckout.test.js`, the new impure (DOM/SDK) pieces are verified by **source wiring guards** (regex/`includes` over the shipped source of both forms — proves presence + correct wiring + parity, no drift), while the **pure decision** (`shouldRecoverDeliveryStep`) keeps its full truth table. Runtime behavior is verified by the on-device checklist in Task 4 and the codex gate. This is honest: the tests guard structure and parity; behavior is verified on-device.

Run one test: `cd xpizza-functions && node address-autofill-recheckout.test.js`
Run full suite: `cd xpizza-functions && npm test`

---

### Task 1: DRY refactor — extract `deliveryRecoveryState()` and `failOpenToRaw()` (behavior-preserving)

Extract the recovery-state object (so the heal callback and `maybeRecoverDeliveryStep` share one builder) and the fail-open body (so the guest path and the bounded fallback share one reversion). No behavior change.

**Files:**
- Modify: `la-musa-orders/account.js` (`maybeRecoverDeliveryStep` ~2247; fail-open branch ~2178)
- Modify: `xpizza-orders/account.js` (same symbols)
- Test: `xpizza-functions/address-autofill-recheckout.test.js`

**Interfaces:**
- Produces: `deliveryRecoveryState()` → `{loggedIn, orderType, restoring, reducedActive, editMode, createProfileActive, confirmedIncomplete, rawDeliveryDirty}` (same object `maybeRecoverDeliveryStep` built inline). `failOpenToRaw()` → void (the current fail-open reversion).

- [ ] **Step 1: Add the failing wiring assertions.** In `address-autofill-recheckout.test.js`, inside the `for (const form of [...])` loop, after the existing wiring `ok(...)` block, add:

```js
  // ── Task 1: DRY extraction (deliveryRecoveryState + failOpenToRaw) ──
  assert.ok(/function deliveryRecoveryState\(\)/.test(src), `${form}: deliveryRecoveryState() not found`);
  assert.ok(src.includes('const state = deliveryRecoveryState();'), `${form}: maybeRecoverDeliveryStep must consume deliveryRecoveryState()`);
  assert.ok(/rawDeliveryDirty: String\(\(\(\$\('address-details'\)/.test(src), `${form}: deliveryRecoveryState must read #address-details for rawDeliveryDirty`);
  assert.ok(/function failOpenToRaw\(\)/.test(src), `${form}: failOpenToRaw() not found`);
  ok(`${form}: Task 1 — deliveryRecoveryState() + failOpenToRaw() extracted`);
```

- [ ] **Step 2: Run the test, verify it fails.**

Run: `cd xpizza-functions && node address-autofill-recheckout.test.js`
Expected: FAIL — `deliveryRecoveryState() not found`.

- [ ] **Step 3: Extract `deliveryRecoveryState()`** in BOTH forms. Add this function immediately above `maybeRecoverDeliveryStep`:

```js
  // Recovery-state snapshot shared by maybeRecoverDeliveryStep (checkout re-run) and the heal
  // callback — one builder so the invariant matrix can't drift. Pure read of live module state + DOM.
  function deliveryRecoveryState() {
    return {
      loggedIn: !!marker(),
      orderType: pageOrderType(),
      restoring: _acctRestoring,
      reducedActive: _acctReducedActive,
      editMode: _acctEditMode,
      createProfileActive: _acctCreateProfileActive,
      confirmedIncomplete: _acctProfileConfirmedIncomplete,
      // the ONLY user-typed delivery-address signal (#address-details is hand-entry only here —
      // reducedActive=false means WE never populated it). Name/phone re-derive from the profile.
      rawDeliveryDirty: String((($('address-details') || {}).value) || '').trim().length > 0,
    };
  }
```

Then replace the inline `const state = { ... };` block inside `maybeRecoverDeliveryStep` with:

```js
    const state = deliveryRecoveryState();
```

(Leave the rest of `maybeRecoverDeliveryStep` — the `if (!$('acct-deliver')) return;` guard, the `if (!shouldRecoverDeliveryStep(state)) return;` gate, and `initDeliveryStep().catch(() => {});` — unchanged.)

- [ ] **Step 4: Extract `failOpenToRaw()`** in BOTH forms. Add this function immediately above `initDeliveryStep` (or adjacent to `revertToNormalFillable`):

```js
  // The logged-out/guest + bounded-fallback fail-open reversion: guest-identical fillable DOM,
  // no confirmed-incomplete arming. (setPaymentVisible(true) is already ensured by the caller /
  // initDeliveryStep's top-of-function reveal, so payment shows.) Behavior-identical to the
  // inline body it replaced.
  function failOpenToRaw() {
    _acctData = null;
    _acctProfileConfirmedIncomplete = false;
    revertToNormalFillable();
    refreshSaveToggle();
  }
```

Then, in `initDeliveryStep`'s fail-open branch, replace the inline body with a call — but keep the guest/loading split for Task 3; for NOW (behavior-preserving) just call `failOpenToRaw()`:

```js
    if (status !== 'ok') { failOpenToRaw(); return; }
```

- [ ] **Step 5: Run the test, verify it passes.**

Run: `cd xpizza-functions && node address-autofill-recheckout.test.js`
Expected: PASS — including the pre-existing truth-table + wiring cases (behavior unchanged).

- [ ] **Step 6: Commit.**

```bash
git add la-musa-orders/account.js xpizza-orders/account.js xpizza-functions/address-autofill-recheckout.test.js
git commit -m "refactor(order-form): extract deliveryRecoveryState + failOpenToRaw (no behavior change)"
```

---

### Task 2: Add the seamless-heal machinery (additive, unwired)

Add the module state and all helper functions. None is wired into the fail-open branch yet (Task 3 activates them), so this task changes NO runtime behavior — it only adds dead-but-tested code.

**Files:**
- Modify: `la-musa-orders/account.js` + `xpizza-orders/account.js` (state block ~2132; helpers near `initDeliveryStep`)
- Test: `xpizza-functions/address-autofill-recheckout.test.js`

**Interfaces:**
- Consumes: `deliveryRecoveryState()`, `shouldRecoverDeliveryStep(state)`, `initDeliveryStep(preSnap)`, `ensureFirebase()`, `marker()`, `injectDeliverStyles()`, `PERSON_SVG`, `$`.
- Produces: `_healUnsub`, `_healTimer`, `_acctDeliveryLoading` (state); `detachHeal()`, `clearDeliveryLoading()`, `deliveryHealReset()`, `showDeliveryLoading()`, `startHealFallback()`, `armDeliveryHeal()`.

- [ ] **Step 1: Add the failing wiring assertions.** Append inside the both-forms loop:

```js
  // ── Task 2: heal machinery present (unwired) ──
  assert.ok(/let _healUnsub = null;/.test(src), `${form}: _healUnsub state missing`);
  assert.ok(/let _healTimer = null;/.test(src), `${form}: _healTimer state missing`);
  assert.ok(/let _acctDeliveryLoading = false;/.test(src), `${form}: _acctDeliveryLoading state missing`);
  assert.ok(/function detachHeal\(\)/.test(src), `${form}: detachHeal() not found`);
  assert.ok(/function clearDeliveryLoading\(\)/.test(src), `${form}: clearDeliveryLoading() not found`);
  assert.ok(/function deliveryHealReset\(\)/.test(src), `${form}: deliveryHealReset() not found`);
  assert.ok(/function showDeliveryLoading\(\)/.test(src), `${form}: showDeliveryLoading() not found`);
  assert.ok(src.includes('Cargando tu dirección'), `${form}: loading copy missing`);
  assert.ok(/function startHealFallback\(\)/.test(src), `${form}: startHealFallback() not found`);
  assert.ok(/function armDeliveryHeal\(\)/.test(src), `${form}: armDeliveryHeal() not found`);
  assert.ok(src.includes("'user_profiles/' + uid"), `${form}: heal must subscribe user_profiles/<uid>`);
  assert.ok(src.includes('dbMod.onValue('), `${form}: heal must use onValue (no-deadline)`);
  assert.ok(src.includes('initDeliveryStep(val)'), `${form}: heal must route via initDeliveryStep(val) — preSnap, no re-read`);
  assert.ok(src.includes('if (!shouldRecoverDeliveryStep(state)) return;'), `${form}: heal callback must gate on shouldRecoverDeliveryStep(state)`);
  ok(`${form}: Task 2 — heal machinery present`);
```

- [ ] **Step 2: Run the test, verify it fails.**

Run: `cd xpizza-functions && node address-autofill-recheckout.test.js`
Expected: FAIL — `_healUnsub state missing`.

- [ ] **Step 3: Add module state** in BOTH forms, in the `_acct*` declaration block (near `_acctRestoreGen`, ~2132):

```js
  let _healUnsub = null;             // active heal-on-arrival onValue handle (user_profiles/<uid>), or null. At most one.
  let _healTimer = null;             // bounded fail-open fallback timer handle, or null.
  let _acctDeliveryLoading = false;  // true while "Cargando tu dirección…" occupies the step-1 #acct-deliver slot.
```

- [ ] **Step 4: Add the teardown utilities** in BOTH forms (place near `revertToNormalFillable`):

```js
  // Drop the heal listener + fallback timer (one-shot cleanup).
  function detachHeal() {
    if (_healUnsub) { try { _healUnsub(); } catch (_) {} _healUnsub = null; }
    if (_healTimer) { try { clearTimeout(_healTimer); } catch (_) {} _healTimer = null; }
  }

  // Exit the loading hold — just the flag. Payment is on the separate step-2 screen and is never
  // touched by this fix; the subsequent render (reduced via initDeliveryStep(val), or raw via
  // failOpenToRaw) owns the #acct-deliver mount.
  function clearDeliveryLoading() {
    _acctDeliveryLoading = false;
  }

  // Session-end teardown — called from rewardsReset (all sign-out paths).
  function deliveryHealReset() {
    detachHeal();
    clearDeliveryLoading();
  }
```

- [ ] **Step 5: Add `showDeliveryLoading()` + `startHealFallback()`** in BOTH forms (near the above):

```js
  // Logged-in fail-open hold (STEP 1 only): a clean "Cargando tu dirección…" line in the SAME
  // #acct-deliver mount the reduced summary will use (minimal layout shift on resolve), with the
  // step-1 raw name/phone fields hidden so they don't flash. Never touches payment or step 2, never
  // advances a stage. Reuses the acct-eyebrow/acct-compact shell + PERSON_SVG so loading→summary is
  // on-brand and monochrome (no emoji).
  function showDeliveryLoading() {
    _acctDeliveryLoading = true;
    injectDeliverStyles();
    const mount = $('acct-deliver');
    if (mount) {
      mount.innerHTML = `
<div class="acct-eyebrow">Entregar a</div>
<div class="acct-compact">
  <span class="acct-cav">${PERSON_SVG}</span>
  <span class="acct-ctxt acct-fine">Cargando tu dirección…</span>
</div>`;
    }
    const rawWrap = $('raw-name-phone'); if (rawWrap) rawWrap.style.display = 'none';   // hide step-1 raw fields
  }

  // Bounded fail-open fallback: if the profile hasn't resolved the loading hold within ~5s, reveal
  // the raw step-1 fields so the customer can fill them in and proceed (never trapped). LEAVE
  // _healUnsub armed — a late arrival still upgrades raw→summary via the heal callback (gated by
  // shouldRecoverDeliveryStep → skips if the user has since typed).
  function startHealFallback() {
    if (_healTimer) return;
    _healTimer = setTimeout(function () {
      _healTimer = null;
      if (!_acctDeliveryLoading) return;   // already resolved by the heal
      clearDeliveryLoading();
      failOpenToRaw();
    }, 5000);
  }
```

- [ ] **Step 6: Add `armDeliveryHeal()` + the heal callback** in BOTH forms (near the above). This mirrors `rewardsSubscribe()`'s acquisition exactly:

```js
  // One-shot no-deadline listener on the profile (the reward chip's pattern) — armed ONLY on a
  // logged-in fail-open. When the profile lands it detaches, and if the recovery state is still safe
  // it routes through initDeliveryStep(val) (preSnap → no re-read) to the reduced/create/raw flow.
  // Fail-silent throughout; the bounded fallback guarantees raw regardless.
  function armDeliveryHeal() {
    if (_healUnsub) return;             // at most one at a time (idempotent across repeated fail-opens)
    if (!marker()) return;             // guests never subscribe (belt; guest never reaches this branch)
    (async () => {
      try {
        const m = marker(); if (!m || !m.uid) return;
        const { auth, db, dbMod } = await ensureFirebase();
        await auth.authStateReady();
        const uid = auth.currentUser && auth.currentUser.uid;
        if (!uid) return;
        if (_healUnsub) return;         // re-check after the await — no double-sub
        const r = dbMod.ref(db, 'user_profiles/' + uid);
        _healUnsub = dbMod.onValue(r, (snap) => {
          const val = snap.exists() ? snap.val() : null;
          detachHeal();                 // one-shot: drop listener + fallback timer
          const state = deliveryRecoveryState();
          if (!shouldRecoverDeliveryStep(state)) return;   // user acted / not a heal state → leave as-is (no clobber)
          clearDeliveryLoading();
          initDeliveryStep(val).catch(() => {});           // routes reduced / create-profile / raw from the landed value
        }, () => {
          // onError: the listener is dead → tear down fully AND reveal raw now (no late upgrade possible).
          if (_healUnsub) { try { _healUnsub(); } catch (_) {} _healUnsub = null; }
          if (_healTimer) { try { clearTimeout(_healTimer); } catch (_) {} _healTimer = null; }
          if (_acctDeliveryLoading) { clearDeliveryLoading(); failOpenToRaw(); }
        });
      } catch (_) { /* fail-silent — the bounded fallback still guarantees raw */ }
    })();
  }
```

- [ ] **Step 7: Run the test, verify it passes.**

Run: `cd xpizza-functions && node address-autofill-recheckout.test.js`
Expected: PASS. (No runtime behavior changed — these functions are not yet called.)

- [ ] **Step 8: Commit.**

```bash
git add la-musa-orders/account.js xpizza-orders/account.js xpizza-functions/address-autofill-recheckout.test.js
git commit -m "feat(order-form): add seamless-heal machinery for slow-load autofill (unwired)"
```

---

### Task 3: Activate — fail-open branch split + logout teardown

The behavior-changing task (the codex gate's focus). Wire the machinery: logged-in fail-open → loading hold + heal + fallback; guest → raw immediately. Tear down on logout. (No submit/payment change — the prefill is step-1; payment is a separate step behind Continuar.)

**Files:**
- Modify: `la-musa-orders/account.js` + `xpizza-orders/account.js` (fail-open branch ~2178; `rewardsReset` ~172)
- Test: `xpizza-functions/address-autofill-recheckout.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–2.

- [ ] **Step 1: Add the failing wiring assertions.** Append inside the both-forms loop:

```js
  // ── Task 3: activation (branch split + logout teardown) ──
  assert.ok(src.includes('if (marker()) { showDeliveryLoading(); armDeliveryHeal(); startHealFallback(); }'),
    `${form}: fail-open branch must split logged-in→loading+heal vs guest→raw`);
  assert.ok(/if \(status !== 'ok'\) \{\s*\n\s*if \(marker\(\)\)/.test(src),
    `${form}: the split must be the status!=='ok' fail-open branch`);
  assert.ok(src.includes('deliveryHealReset();'), `${form}: rewardsReset must call deliveryHealReset() (logout teardown)`);
  ok(`${form}: Task 3 — activated: branch split, logout teardown`);
```

- [ ] **Step 2: Run the test, verify it fails.**

Run: `cd xpizza-functions && node address-autofill-recheckout.test.js`
Expected: FAIL — branch-split assertion.

- [ ] **Step 3: Split the fail-open branch** in BOTH forms. Replace the Task-1 line `if (status !== 'ok') { failOpenToRaw(); return; }` with:

```js
    // UNAVAILABLE (timeout / SDK error). Logged-in: hold the step-1 "Tus datos" slot with
    // "Cargando tu dirección…" + arm the no-deadline heal + a bounded raw fallback, so a registered
    // user sees their address (not the raw fields) when it lands, and is never trapped. Payment
    // (step 2) is untouched — the shipped "never hide payment on an unconfirmed read" invariant holds.
    // Guest: raw immediately (byte-identical to today).
    if (status !== 'ok') {
      if (marker()) { showDeliveryLoading(); armDeliveryHeal(); startHealFallback(); }
      else { failOpenToRaw(); }
      return;
    }
```

- [ ] **Step 4: Wire logout teardown** in BOTH forms. In `rewardsReset()`, add as the last statement of the function body:

```js
    deliveryHealReset();   // session end → drop the address-heal listener/timer + clear the loading hold
```

- [ ] **Step 5: Run the test, verify it passes.**

Run: `cd xpizza-functions && node address-autofill-recheckout.test.js`
Expected: PASS — all Task 1–3 assertions + the pre-existing truth table.

- [ ] **Step 6: Run the FULL suite** (guard against collateral breakage):

Run: `cd xpizza-functions && npm test`
Expected: PASS (all existing tests + this one).

- [ ] **Step 7: Commit.**

```bash
git add la-musa-orders/account.js xpizza-orders/account.js xpizza-functions/address-autofill-recheckout.test.js
git commit -m "feat(order-form): seamless address heal on slow load — step-1 loading hold, onValue resolve, bounded raw fallback"
```

---

### Task 4: Parity verification + on-device verification handoff

Final integrity checks and the manual verification checklist for the owner (behavior can only be confirmed on a real throttled device).

**Files:** none modified (verification only).

- [ ] **Step 1: Confirm both forms are byte-identical past CONFIG.**

The source carries an explicit parity sentinel — the comment `parity guard: byte-identical past CONFIG` (≈line 114 in both forms). Diff from it:
```bash
cd /Users/xavierlacayo/Downloads/xpizza-delivery
diff \
  <(sed -n '/byte-identical past CONFIG/,$p' la-musa-orders/account.js) \
  <(sed -n '/byte-identical past CONFIG/,$p' xpizza-orders/account.js) \
  && echo "PARITY OK past CONFIG"
```
Expected: no output before `PARITY OK past CONFIG` — every change past the CONFIG block is identical across both forms. (The only legitimate differences are inside CONFIG, above this sentinel: `restaurant_id`, `brand`, `accent`, `MARKER`, `palette`, `rewards`.)

- [ ] **Step 2: Confirm the full test suite is green.**

Run: `cd xpizza-functions && npm test`
Expected: PASS.

- [ ] **Step 3: On-device verification checklist** (owner, real phone, throttled/slow connection). Record pass/fail for each:
  1. Logged in, slow link, load + **immediate** checkout → **no raw flash**; "Cargando tu dirección…" then the reduced address card when the profile lands.
  2. Normal flow (browse menu, build cart, then checkout) on slow link → address already there, loading line never seen.
  3. **Fast connection** → reduced card on load exactly as today; no perceptible change.
  4. After a fallback-to-raw, type into the address field before the profile lands → the late heal must NOT clobber the typed text.
  5. Dead/killed connection at checkout → "Cargando…" ~5s → raw fillable + payment; an order can still be completed (never stuck).
  6. Switch to pickup during the loading window → no heal fires; pickup behaves as today.

- [ ] **Step 4: Hand off for the gate.** Do NOT merge/deploy. The advisor runs the order-form codex checkout-integrity gate (read-only) on this branch; the owner merges + deploys the two order forms after APPROVED. (Governance: advisor gates, owner executes prod/money merges & deploys.)

---

## Self-Review (completed by plan author)

- **Spec coverage:** step-1 loading hold (Task 2–3), one-shot `onValue` heal via `initDeliveryStep(preSnap)` (Task 2), bounded raw fallback (Task 2–3), guest/fast untouched (branch split, Task 3), logout teardown (Task 2–3), DRY extraction (Task 1), parity (every task, both forms + Task 4 diff). Payment/step-2 explicitly untouched. All spec sections map to a task.
- **Placeholder scan:** none — every code step has real code; every test step has a runnable command + expected result.
- **Type/name consistency:** `deliveryRecoveryState`, `failOpenToRaw`, `detachHeal`, `clearDeliveryLoading`, `deliveryHealReset`, `showDeliveryLoading`, `startHealFallback`, `armDeliveryHeal`, `_healUnsub`, `_healTimer`, `_acctDeliveryLoading` are used identically across the impl steps and the test assertions.
