# Slow-Connection Address-Autofill: Seamless Heal — Design

**Date:** 2026-08-04
**Surface:** `la-musa-orders/account.js` + `xpizza-orders/account.js` (byte-identical past CONFIG)
**Type:** Additive customer-UX fix on the logged-in delivery autofill path. Not money-path; touches the checkout DOM + submit gate, so it runs the order-form codex checkout-integrity gate before deploy.

---

## Problem

A logged-in customer with a complete profile + saved default address lands on the raw "Tus datos" delivery form (no prefill) on a slow connection, and waiting doesn't recover it — the raw form persists to checkout.

### Root cause (confirmed on live 3G evidence, 2026-08-04)

`accountSnapshotStatus()` reads `user_profiles/<uid>` via a one-shot `get()` wrapped in `Promise.race([get, setTimeout(1500)])` (`account.js:1876`). On a slow connection the `get()` exceeds 1500ms → `status:'unavailable'` → `initDeliveryStep()` fail-opens to the raw fillable form (`account.js:2178`).

The existing checkout self-heal (`maybeRecoverDeliveryStep`, wired at `goToLocation`, `account.js:4015`) re-runs `initDeliveryStep()` **no-arg**, which does **another** 1500ms timed read — so on a genuinely slow link it times out **again** and never heals. Fast-path recovery only works when the re-read lands warm (<1500ms).

The reward chip (8/8) shows because it subscribes via `onValue` (`account.js:167`) — a **no-deadline** listener that fires whenever the data lands. The address form has no equivalent; it only ever does deadline-bounded `get()`s.

**Live confirmation (owner's phone, real account, bad 3G):** `accountSnapshot()` → `null` (timed read exceeded 1500ms); a no-deadline read on the same connection returned `complete:true, savedAddrs:2, hasDefault:true, addrDirty:false`; observed "premios blank, then loaded after a few seconds" — the chip's `onValue` healing while the address form's timed `get()` did not. The profile is fully prefillable and unblocked; the only failure is the read not landing within 1500ms.

---

## Constraints (owner's three tenets)

*"I want the form to not lose speed, functionality and aesthetic."* Plus the earlier two: *"do not break anything already working"* and *"do not slow down loading on a customer's phone."* And the seamless-UX requirement: **a registered user, logged in, tapping checkout should see their preloaded address — never the raw Tus-datos form.**

- **Speed:** every new behavior lives on the slow **fail-open path only**. On a fast connection the read lands in ~80ms → reduced flow renders directly, byte-identical to today. Form load, first paint, and the warm path are unchanged. The `onValue` is the reward chip's proven, non-blocking pattern. Zero added listeners on the happy path.
- **Functionality:** the new state is small, contained, gated strictly to the *logged-in* fail-open; it reuses the form's existing submit gate; it **never traps** the customer (bounded fallback to the raw form); guest + fast + pickup paths stay byte-identical across both forms; codex gates it.
- **Aesthetic:** a registered user never sees the raw form flash. The fail-open window shows a clean, monochrome **"Cargando tu dirección…"** line (no emoji, no raw fields), which resolves into their address card. In the normal browse-then-checkout flow it isn't seen at all.

**Standing invariants preserved:** fail-open (never permanently stuck without a way to order/pay), R5 restore-race (`_acctRestoring`/`_acctRestoreGen`), no-clobber of hand-entered `#address-details`, both forms byte-identical past CONFIG, driver/payment/money path untouched (client-only, no functions deploy).

---

## Design

### Why it feels seamless in practice

The `onValue` arms at the **load-time** fail-open, so the profile resolves *while the customer browses the menu and builds their cart* (2–4s on 3G). By the time a real customer taps checkout — 20+ seconds into the session — it has long since landed and the delivery step is already the reduced address card. The "Cargando tu dirección…" line is only ever seen in the narrow race the owner hit in testing: an *immediate* checkout on a cold slow load.

### State machine — logged-in delivery step

| Read outcome | Behavior |
|---|---|
| Fast read, complete + in-zone | Reduced address card *(unchanged)* |
| Fast read, incomplete | Creá-tu-perfil block *(unchanged)* |
| Fast read, complete but zone/invariant fails now | Raw fillable, fail-open *(unchanged)* |
| **Slow read (unavailable), logged-in** | **NEW: loading state → resolves via heal, or bounded fallback to raw** |
| Slow read (unavailable), **guest** | Raw fillable, immediately *(unchanged — guests never wait)* |

### Components

**1. New module state (near the other `_acct*` state, `account.js:~2132`)**
```
let _healUnsub  = null;   // active heal-on-arrival onValue handle, or null. At most one.
let _healTimer  = null;   // bounded fallback timer handle, or null.
let _acctDeliveryLoading = false;   // true while the "Cargando tu dirección…" hold is on screen.
```

**2. `failOpenToRaw()` — extracted from the current fail-open branch (behavior-preserving)**
The exact body of today's fail-open (`_acctData = null; _acctProfileConfirmedIncomplete = false; revertToNormalFillable(); refreshSaveToggle();`) is extracted verbatim into `failOpenToRaw()`. Called by (a) the guest fail-open (immediate) and (b) the bounded fallback. `setPaymentVisible(true)` is already ensured by `initDeliveryStep`'s top-of-function reveal, so raw+payment show exactly as today.

**3. `showDeliveryLoading()` — the logged-in fail-open hold**
- Set `_acctDeliveryLoading = true`.
- Render a minimal, clean loading line into the `#acct-deliver` mount: an "Entregar a" eyebrow + a monochrome spinner + **"Cargando tu dirección…"** (no raw fields, no emoji, reuses the existing `injectDeliverStyles()` look).
- Hide the raw fields + address section (`hideRawAndAddrSection()`), same as the reduced flow.
- **Hold payment WITHOUT `setPaymentVisible(false)`** (which would set `_acctCreateProfileActive=true` and thereby block the heal via `shouldRecoverDeliveryStep`, and pop the wrong "Guardá tu perfil" error). Instead a dedicated `holdPaymentForLoading(true)` toggles `#acct-pay-label` + `.pay-container` display directly, touching no flags. `holdPaymentForLoading(false)` restores them.
- Does **not** advance any stage; only paints the (usually still-hidden s2) delivery mount.

**4. `armDeliveryHeal()` — one-shot no-deadline listener (the reward chip's pattern)**
- `if (_healUnsub) return;` — at most one at a time (idempotent across repeated fail-opens).
- `if (!marker()) return;` — guests never subscribe (belt; a guest never reaches this branch).
- Mirror `rewardsSubscribe()` acquisition exactly: `await ensureFirebase()` → `await auth.authStateReady()` → resolve `uid` → re-check `if (_healUnsub) return;` after the await → `_healUnsub = dbMod.onValue(ref('user_profiles/'+uid), cb, onError)`.
- `onError`: `detachHeal()`, fail-silent (the bounded fallback still guarantees raw).
- Whole thing `try/catch` → fail-silent (never throws into the form).

**5. The heal callback — resolve the loading state through the normal router**
1. `val = snap.exists() ? snap.val() : null`.
2. `detachHeal()` — one-shot on first fire (clears `_healUnsub`; the fallback timer is cleared here too when the resolve is authoritative).
3. Build `deliveryRecoveryState()` (see #7). **Guard:** `if (!shouldRecoverDeliveryStep(state)) return;` — abandons if the customer acted meanwhile (typed → `rawDeliveryDirty`; switched to pickup; opened edit; a restore started; reduced already active). Never clobbers.
4. `clearDeliveryLoading()` (clears `_acctDeliveryLoading`, restores payment via `holdPaymentForLoading(false)`) then `initDeliveryStep(val).catch(()=>{})`. Passing `val` as `preSnap` means `initDeliveryStep` treats it as a resolved (`status:'ok'`) read and does **no re-read** — the crux that works on a slow link. It then routes normally: complete+in-zone → reduced card; incomplete → Creá-tu-perfil; complete-but-zone-fails → raw. From a loading state (not raw), any of these resolutions is coherent and non-jarring, so the router runs unrestricted (no "upgrade-only" limitation needed here).
5. `initDeliveryStep` carries its own `_acctRestoring`/`_acctRestoreGen` R5 guards.

**6. Bounded fallback (never trap)**
- When `showDeliveryLoading()` mounts, start `_healTimer = setTimeout(fallback, ~5000)`.
- `fallback()`: if still loading and not yet resolved → `clearDeliveryLoading()` + `failOpenToRaw()` (raw + payment shown). **Leave `_healUnsub` armed** — so if the profile lands *after* the fallback, the heal callback still upgrades raw → reduced, gated by `shouldRecoverDeliveryStep` (skips if the user has since typed — no clobber). Seamless when the link cooperates; graceful raw fallback when it doesn't; auto-upgrade if it lands late.
- After the fallback has revealed raw, the heal callback's late fire is the ORIGINAL upgrade path (raw→reduced only if safe).

**7. `deliveryRecoveryState()` — extracted shared state builder (DRY)**
The recovery-state object built inline in `maybeRecoverDeliveryStep` (`account.js:2248`) is extracted verbatim into a pure `deliveryRecoveryState()` and consumed by both `maybeRecoverDeliveryStep` and the heal callback — same fields (`loggedIn`, `orderType`, `restoring`, `reducedActive`, `editMode`, `createProfileActive`, `confirmedIncomplete`, `rawDeliveryDirty`), no behavior change, so the two can't drift.

**8. The fail-open hook (in `initDeliveryStep`, `account.js:2178`)**
Replace the inline fail-open body with a split on login state:
```
if (status !== 'ok') {
  if (marker()) { showDeliveryLoading(); armDeliveryHeal(); startHealFallback(); }
  else { failOpenToRaw(); }        // guest — raw immediately, unchanged
  return;
}
```
This is the ONLY path that arms the heal/loading — it fires exclusively on a timed-out/errored read for a logged-in user. When `initDeliveryStep` is called WITH a `preSnap` (`status` forced `ok`), this branch is never reached → the heal's own `initDeliveryStep(val)` can never re-arm (no loop).

**9. Submit gate (defense-in-depth)**
`deliverySubmitBlocked()` (`account.js:3752`, called from `processPayment`) also returns `true` while `_acctDeliveryLoading` is set — so even if the held payment DOM were reachable, a submit during the loading window is blocked. Guest/complete/pickup/raw-fallback all clear the flag → proceed (fail-open intact).

**10. Logout hygiene**
Alongside the chip's `rewardsReset()` detach, tear down the heal: `detachHeal()` (`_healUnsub` + `_healTimer`) + `clearDeliveryLoading()`. The listener is also self-cleaning (one-shot on fire; a logout-before-fire makes the callback's `marker()`/`shouldRecoverDeliveryStep` no-op), but explicit teardown prevents a lingering listener if the read never lands.

### What is explicitly NOT changed
- `accountSnapshot()` / `accountSnapshotStatus()` — the 1500ms timed read stays; fast-path unchanged.
- `initDeliveryStep` routing — unchanged except the fail-open branch split (#8).
- `maybeRecoverDeliveryStep` / `goToLocation` wrapper — unchanged except consuming `deliveryRecoveryState()` (identical object).
- `shouldRecoverDeliveryStep`, reduced-flow renderers, `setPaymentVisible`, create-profile flow — unchanged.
- Driver / payment / factura / rewards / functions — untouched (client-only, no functions deploy).

### Data flow
```
Fast:  load → initDeliveryStep() → get lands <1500ms → reduced card prefilled.
       [no heal, no loading, no timer — byte-identical to today]

Slow:  load → initDeliveryStep() → get >1500ms → logged-in
            → showDeliveryLoading() ("Cargando tu dirección…", raw+payment held)
            + armDeliveryHeal() (onValue on user_profiles/<uid>)
            + startHealFallback(~5s)
       ...profile lands (usually 2–4s, before real checkout)...
            → cb: detach; shouldRecover? yes → clearLoading → initDeliveryStep(val)
            → reduced card (their address).  [no re-read]
       ...OR fallback fires first (dead link)...
            → raw fillable + payment (never trapped); onValue stays armed
            → if address lands later & user hasn't typed → upgrade raw→reduced.

Guest slow: → failOpenToRaw() immediately (unchanged).
```

---

## Error handling
- SDK/auth failure in `armDeliveryHeal` → caught, fail-silent; the bounded fallback still reveals raw.
- `onValue` onError → `detachHeal()`; fallback reveals raw.
- Landed profile incomplete/empty → router shows Creá-tu-perfil / raw as appropriate (from loading, coherent).
- Customer acted before arrival → `shouldRecoverDeliveryStep` false → no heal, no clobber.
- Restore in flight → `_acctRestoring` short-circuits both `shouldRecoverDeliveryStep` and `initDeliveryStep`'s top guard.
- Mid-loading pickup↔delivery toggle → `refreshDeliveryUI` reverts to fillable (fail-open); the armed `onValue` re-upgrades when it lands. Acceptable edge.

Every failure mode degrades to today's behavior (raw fillable) — never worse, never trapped.

---

## Testing

**Unit (pure, no DOM/network) — extend the existing `shouldRecoverDeliveryStep` suite:**
- `deliveryRecoveryState()` returns the same object the inline builder produced (fixture equality) — proves the DRY extraction is behavior-preserving.
- Heal-callback gating matrix: complete+safe → route; each deliberate state (`rawDeliveryDirty`, `reducedActive`, `editMode`, `createProfileActive`, `confirmedIncomplete`, `restoring`, pickup) → no heal.
- Idempotency: a second `armDeliveryHeal()` while `_healUnsub` set attaches no second listener.
- `deliverySubmitBlocked()` returns true while `_acctDeliveryLoading` is set; false once cleared.

**On-device (owner, throttled/slow connection — the reproduction):**
1. Logged in, slow link, load + immediate checkout → **no raw flash**; "Cargando tu dirección…" then the reduced address card when it lands.
2. Normal flow (browse, build cart, then checkout) on slow link → address already there, no loading line seen.
3. Fast connection → reduced card on load exactly as today; confirm no heal listener / timer was created on the warm path.
4. Type into the raw field after a fallback-to-raw, before the profile lands → heal must NOT clobber the typed text.
5. Dead/killed connection at checkout → "Cargando…" for ~5s → raw fillable + payment (can complete an order); never stuck.

**Parity:** diff `la-musa-orders/account.js` vs `xpizza-orders/account.js` past CONFIG → identical.

---

## Scope & process
- **Files:** both order forms' `account.js` (identical edit; parity verified).
- **Gate:** order-form codex checkout-integrity gate (read-only) — focus: fail-open never traps; loading holds payment WITHOUT `_acctCreateProfileActive` (heal not blocked); no-clobber; R5 intact; submit gated during loading; guest/fast/pickup byte-identical; both forms parity.
- **Deploy:** owner executes, order forms only (Netlify per-folder sites, explicit `--site`), both forms together. No functions deploy.
- **Not in scope:** timeout tuning (rejected — doesn't fix a genuinely slow link), pickup autofill, cached-address instant render (rejected — stale-address correctness risk on a money/logistics-adjacent field).
