# Slow-Connection Address-Autofill: Heal-on-Arrival — Design

**Date:** 2026-08-04
**Surface:** `la-musa-orders/account.js` + `xpizza-orders/account.js` (byte-identical past CONFIG)
**Type:** Additive customer-UX fix on the logged-in delivery autofill path. Not money-path; touches the checkout DOM, so it runs the order-form codex checkout-integrity gate before deploy.

---

## Problem

A logged-in customer with a complete profile + saved default address lands on the raw "Tus datos" delivery form (no prefill) on a slow connection. Waiting doesn't recover it — the raw form persists to checkout.

### Root cause (confirmed on live evidence, 2026-08-04)

`accountSnapshotStatus()` reads `user_profiles/<uid>` via a one-shot `get()` wrapped in `Promise.race([get, setTimeout(1500)])` (`account.js:1876`). On a slow connection the `get()` exceeds 1500ms → `status:'unavailable'` → `initDeliveryStep()` fail-opens to the raw fillable form (`account.js:2178`, the `if (status !== 'ok')` branch).

The existing checkout self-heal (`maybeRecoverDeliveryStep`, wired at `goToLocation`, `account.js:4015`) re-runs `initDeliveryStep()` **no-arg**, which performs **another** 1500ms timed read — so on a genuinely slow connection it times out **again** and never heals. The fast-path recovery only works when the re-read happens to land warm (<1500ms).

The reward chip (8/8) shows because it subscribes via `onValue` (`account.js:167`) — a **no-deadline** listener that fires whenever the data lands, even seconds later. The address form has no equivalent; it only ever does deadline-bounded `get()`s.

### Live confirmation (owner's phone, real account, bad 3G signal)

- `accountSnapshot()` → **`null`** (the timed read exceeded 1500ms — with the owner logged in, `null` can only mean the deadline won the race; guest/not-logged-in/no-profile paths are excluded).
- A **no-deadline** read on the identical connection returned: `complete: true`, `savedAddrs: 2`, `hasDefault: true`, `name: "Xavier Lacayo"`, `addrDirty: false`.
- Observed behavior: "premios weren't showing, Tus Datos blank; after a few seconds premios loaded." The chip's `onValue` healed on this exact connection while the address form's timed `get()` did not.

Conclusion: the profile is fully prefillable and unblocked; the **only** failure is the read not landing within 1500ms. Every alternative (dirty field, incomplete profile, wrong order type) is ruled out by the evidence.

---

## Constraints

**Owner's two hard constraints (verbatim):** *"as long as we do not break anything that is already working, as long as we don't slow down our own order form loading on a customer's phone."*

1. **Don't slow the load on a customer's phone.** The new listener is attached **only when a fail-open actually occurs** — never on the happy path. On any normal/fast connection the timed read lands `ok`, routes to reduced, and nothing new runs: the fast path is byte-identical to today. Zero added listeners, zero added work, zero added load cost on the warm path.
2. **Don't break anything working.** The timed read, the fail-open, the fast-load prefill, and the existing checkout re-run are all **untouched**. The new code is a pure addition on the fail-open branch that only ever **upgrades raw → reduced** for a **complete** profile, gated by the same `shouldRecoverDeliveryStep` invariants. Worst case if anything is off: it simply doesn't heal, leaving exactly today's behavior (raw form) — strictly no worse.

**Standing constraints preserved:**
- Fail-open invariant: an unavailable read NEVER hides a field or hides payment.
- R5 restore-race: a payment-retry restore (`_acctRestoring` / `_acctRestoreGen`) owns the DOM and is never clobbered.
- No-clobber: hand-entered `#address-details` (`rawDeliveryDirty`) is never overwritten.
- Both order forms byte-identical past CONFIG (parity guard).
- Driver/payment/money path untouched (no functions change; client-only).

---

## Design

### Overview

On a fail-open (and only then), attach a **one-shot `onValue`** subscription to `user_profiles/<uid>` — the same no-deadline mechanism the reward chip already uses. When the profile lands, if it's complete and the recovery state is still safe, render the reduced flow by calling the **existing** `initDeliveryStep(preSnap)` with the landed profile value (so it routes **without any re-read**). Then unsubscribe. One listener, fires once, self-detaches.

### Components

**1. New module state (near the other `_acct*` state, `account.js:~2132`)**
```
let _healUnsub = null;   // active heal-on-arrival onValue handle, or null. At most one at a time.
```

**2. New `armDeliveryHeal()` — attaches the one-shot listener**
- Guard `if (_healUnsub) return;` — at most one heal listener at a time (idempotent across repeated fail-opens, e.g. a load fail-open followed by a pickup→delivery toggle fail-open).
- Guard `if (!marker()) return;` — guests never subscribe (belt; a guest never reaches the fail-open branch anyway, since `accountSnapshotStatus` fast-paths guests to `status:'ok'`).
- Mirror the chip's `rewardsSubscribe()` acquisition exactly: `await ensureFirebase()` → `await auth.authStateReady()` → resolve `uid` → re-check `if (_healUnsub) return;` after the await (no double-sub) → `_healUnsub = dbMod.onValue(ref('user_profiles/'+uid), cb, onError)`.
- `onError`: detach and clear `_healUnsub` (give up silently — the display/heal is non-critical, fail-open stays).
- Wrapped in `try/catch` → fail-silent (never throws into the form).

**3. The heal callback (the `onValue` cb) — upgrade-only, gated, one-shot**
1. Compute `val = snap.exists() ? snap.val() : null`.
2. **Detach immediately** (`_healUnsub()` then `_healUnsub = null`) — one-shot on first fire.
3. **Upgrade-only guard:** `if (!val || !profileComplete(val)) return;` — heal ONLY promotes raw → reduced for a **complete** profile. It NEVER introduces a new payment-hiding (create-profile-block) transition from a background listener. An incomplete/empty profile leaves the fail-open raw form exactly as-is (matches today; strictly no worse).
4. Build the recovery state via the shared `deliveryRecoveryState()` helper (see #4) and `if (!shouldRecoverDeliveryStep(state)) return;` — abandons the heal if the customer has since acted (typed an address → `rawDeliveryDirty`; switched to pickup; opened edit; a restore started; reduced already active). Never clobbers.
5. `initDeliveryStep(val).catch(() => {});` — routes to the reduced flow using the landed value as `preSnap`. Because `preSnap` is provided, `initDeliveryStep` treats it as a resolved (`status:'ok'`) read and does **no re-read** — the crux that makes this work on a slow connection where the no-arg re-run times out. `initDeliveryStep` carries its own `_acctRestoring`/`_acctRestoreGen` R5 guards; the reduced render here is byte-identical to what a fast load performs.

**4. `deliveryRecoveryState()` — extracted shared state builder (DRY)**
The recovery-state object currently built inline inside `maybeRecoverDeliveryStep` (`account.js:2248`) is extracted verbatim into a pure `deliveryRecoveryState()` helper and consumed by BOTH `maybeRecoverDeliveryStep` and the heal callback. Same fields, same values (`loggedIn`, `orderType`, `restoring`, `reducedActive`, `editMode`, `createProfileActive`, `confirmedIncomplete`, `rawDeliveryDirty`) — a pure refactor, no behavior change, so the two consumers can't drift.

**5. The fail-open hook (one line added)**
In `initDeliveryStep`, the fail-open branch (`account.js:2178`) gains a single call before its `return`:
```
if (status !== 'ok') { _acctData = null; _acctProfileConfirmedIncomplete = false; revertToNormalFillable(); refreshSaveToggle(); armDeliveryHeal(); return; }
```
This is the ONLY reachable path that arms the heal — it fires exclusively on a timed-out/errored read. It covers both entry points that fail-open: the load-time / login-outcome calls AND the existing `goToLocation` checkout re-run (if that re-read also times out). When `initDeliveryStep` is called WITH a `preSnap` (`status` forced `ok`), this branch is never reached → the heal callback's own `initDeliveryStep(val)` can never re-arm (no loop).

**6. Logout hygiene**
`armDeliveryHeal`'s listener is detached in the existing sign-out/reset path alongside the chip's `rewardsReset()` detach — `if (_healUnsub) { _healUnsub(); _healUnsub = null; }`. (The listener is also self-cleaning: it detaches on first fire, and a logout-before-fire makes the callback's `marker()`/`shouldRecoverDeliveryStep` checks no-op — but explicit detach keeps it tidy and prevents a lingering listener if the read never lands.)

### What is explicitly NOT changed

- `accountSnapshot()` / `accountSnapshotStatus()` — the 1500ms timed read stays. Fail-open behavior unchanged.
- `initDeliveryStep`'s routing logic — unchanged except the single `armDeliveryHeal()` call in the fail-open branch.
- `maybeRecoverDeliveryStep` / the `goToLocation` wrapper — unchanged except consuming the extracted `deliveryRecoveryState()` (identical object).
- `shouldRecoverDeliveryStep` — unchanged (reused as-is).
- Driver / payment / factura / rewards / functions — untouched (client-only, no functions deploy).

### Data flow

```
Fast connection:  load → initDeliveryStep() → timed get lands <1500ms → status ok
                       → reduced flow prefilled.  [no heal armed — byte-identical to today]

Slow connection:  load → initDeliveryStep() → timed get > 1500ms → status unavailable
                       → fail-open to raw form (unchanged) + armDeliveryHeal()
                       → onValue attached to user_profiles/<uid>
                  ...seconds later, profile lands...
                       → cb: detach; complete? yes; shouldRecover? yes
                       → initDeliveryStep(landedVal) → reduced flow renders (no re-read)
                  [if user typed an address / switched to pickup meanwhile → cb no-ops, raw stays]
```

---

## Error handling

- SDK/auth acquisition failure in `armDeliveryHeal` → caught, fail-silent, no listener (fail-open raw stays).
- `onValue` onError → detach, fail-silent (fail-open raw stays).
- Landed profile null/incomplete → no heal, raw stays (matches today).
- Customer acted before arrival → `shouldRecoverDeliveryStep` false → no heal, no clobber.
- Restore in flight → `_acctRestoring` short-circuits both `shouldRecoverDeliveryStep` (via `restoring`) and `initDeliveryStep`'s own top guard.

Every failure mode degrades to **exactly today's behavior** (raw fillable form), never worse.

---

## Testing

**Unit (pure, no DOM/network) — extend the existing `shouldRecoverDeliveryStep` suite:**
- `deliveryRecoveryState()` returns the same object shape the inline builder produced (snapshot equality against a fixture) — proves the DRY extraction is behavior-preserving.
- Heal-callback decision matrix (test the gating predicate composition, not the DOM): complete + safe-state → heal; incomplete → no heal; each deliberate state (`rawDeliveryDirty`, `reducedActive`, `editMode`, `createProfileActive`, `confirmedIncomplete`, `restoring`, pickup) → no heal.
- Idempotency: a second `armDeliveryHeal()` while `_healUnsub` is set does not attach a second listener.

**On-device (owner, throttled/slow connection — the reproduction that started this):**
1. Logged in, slow connection, load form, advance to checkout quickly → previously raw; now: raw appears immediately, then upgrades to the reduced "Entregar a Casa" flow when the profile lands. Fail-open still shows instantly (no blocking).
2. Fast connection → reduced flow prefills on load exactly as today; confirm (via a temporary log or the `_healUnsub` value) that **no** heal listener was attached on the warm path.
3. Slow connection, then type into the raw address field before the profile lands → the heal must NOT clobber the typed text (`rawDeliveryDirty` gate).
4. Slow connection, switch to pickup before arrival → no heal fires.

**Parity:** after applying to both forms, diff `la-musa-orders/account.js` vs `xpizza-orders/account.js` past the CONFIG block → identical.

---

## Scope & process

- **Files:** `la-musa-orders/account.js` and `xpizza-orders/account.js` (identical edit, applied to both; parity verified).
- **Gate:** order-form codex checkout-integrity gate (read-only) — focus: fail-open preserved, no-clobber, R5 restore-race intact, upgrade-only (no new payment-hiding transition), one-shot/no-leak, fast path unchanged, both forms parity.
- **Deploy:** owner executes, order forms only (Netlify per-folder sites, explicit `--site`), both forms together. No functions deploy.
- **Not in scope:** timeout tuning (rejected — doesn't fix a genuinely slow link), pickup autofill, the warm-only fast-path re-run (kept as the cheap first line; heal-on-arrival is the slow-path backstop).
