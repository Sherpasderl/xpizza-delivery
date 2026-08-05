# Slow-Connection Address-Autofill: Seamless Heal — Design

**Date:** 2026-08-04
**Surface:** `la-musa-orders/account.js` + `xpizza-orders/account.js` (byte-identical past CONFIG)
**Type:** Additive customer-UX fix on the logged-in **step-1 "Tus datos"** prefill. Not money-path, does not touch payment; touches the checkout-flow DOM, so it runs the order-form codex checkout-integrity gate before deploy.

---

## Problem

A logged-in customer with a complete profile + saved default address lands on the raw "Tus datos" fields (no prefill) in **step 1**, on a slow connection, and waiting doesn't recover it — the raw form persists.

### DOM context (verified in `index.html`)

- **`#s1` "Paso 1 de 3 — Tu pedido":** the `Tus datos` heading (line 1323) → `#acct-deliver` (reduced-summary mount, 1326) → `#raw-name-phone` (raw name/phone, 1327) → `#btn-continuar` (1362). **The prefill and its loading state live here, above Continuar.**
- **`#s2` "Entrega & Pago":** a separate step behind Continuar — map/confirm-ubicación, `#address-details`, `#acct-s2-summary`, `.pay-container` (payment). **Not adjacent to "Tus datos"; payment is untouched by this fix.**

When logged-in with a complete profile, `#acct-deliver` shows a compact "Entregar a … · Cambiar" summary and `#raw-name-phone` is hidden (the reduced flow). On a fail-open, `#acct-deliver` is empty and the raw name/phone fields show instead — the bug.

### Root cause (confirmed on live 3G evidence, 2026-08-04)

`accountSnapshotStatus()` reads `user_profiles/<uid>` via a one-shot `get()` in `Promise.race([get, setTimeout(1500)])` (`account.js:1876`). On a slow link the `get()` exceeds 1500ms → `status:'unavailable'` → `initDeliveryStep()` fail-opens to the raw fields (`account.js:2178`). The existing checkout self-heal (`maybeRecoverDeliveryStep` at `goToLocation`, `account.js:4015`) re-runs `initDeliveryStep()` **no-arg** → **another** 1500ms timed read → times out **again** on a genuinely slow link. The reward chip (8/8) escapes this because it subscribes via `onValue` (`account.js:167`) — a **no-deadline** listener.

**Live confirmation (owner's phone, real account, bad 3G):** `accountSnapshot()` → `null` (timed read >1500ms); a no-deadline read on the same connection → `complete:true, savedAddrs:2, hasDefault:true, addrDirty:false`; "premios blank, then loaded after a few seconds" = the chip's `onValue` healing while the address `get()` did not. The profile is fully prefillable and unblocked; the only failure is the read not landing within 1500ms.

---

## Constraints (owner's three tenets)

*"Don't lose speed, functionality, or aesthetic"*, plus *"a logged-in user tapping checkout should see their preloaded address, never the raw Tus-datos form."*

- **Speed:** everything new runs on the **fail-open path only**. On a fast connection the read lands in ~80ms → reduced summary renders directly, byte-identical to today. Step-1 load and first paint are unchanged. The `onValue` is the reward chip's proven, non-blocking pattern; zero added listeners on the warm path.
- **Functionality:** small and contained; gated strictly to the *logged-in* fail-open; **never traps** the customer (bounded fallback to the raw fields); guest + fast + pickup paths byte-identical across both forms. **Payment and the step-2 flow are not touched at all.** Codex gates it.
- **Aesthetic:** a registered user never sees the raw name/phone fields flash. The `Tus datos` slot shows a clean, monochrome **"Cargando tu dirección…"** line (reusing the existing `acct-eyebrow`/`acct-compact` shell + `PERSON_SVG` + `.acct-fine`, no emoji), which resolves into their "Entregar a" summary. In the normal browse-then-checkout flow it isn't seen at all.

**Standing invariants preserved:** fail-open (never permanently stuck), R5 restore-race (`_acctRestoring`/`_acctRestoreGen`), no-clobber of hand-entered `#address-details`, both forms byte-identical past CONFIG, driver/payment/money path untouched (client-only, no functions deploy).

---

## Design

### Why it feels seamless in practice

The `onValue` arms at the **load-time** fail-open, so the profile resolves *while the customer browses the menu and builds their cart* (2–4s on 3G). By the time a real customer reaches the `Tus datos` slot and taps Continuar — many seconds into the session — it has long since landed and they see their "Entregar a" summary. The "Cargando tu dirección…" line is only ever seen in the narrow race the owner hit in testing: an *immediate* checkout on a cold slow load.

### State machine — logged-in step-1 "Tus datos"

| Read outcome | `#acct-deliver` shows |
|---|---|
| Fast read, complete + in-zone | "Entregar a …" reduced summary *(unchanged)* |
| Fast read, incomplete | Creá-tu-perfil block *(unchanged)* |
| Fast read, complete but zone/invariant fails now | Raw name/phone fields, fail-open *(unchanged)* |
| **Slow read (unavailable), logged-in + delivery** | **NEW: "Cargando tu dirección…" → resolves via heal, or bounded fallback to raw fields** |
| Slow read (unavailable), **guest OR pickup** | Raw fields, immediately *(unchanged — the loading hold is delivery-only; the fail-open branch itself must exclude pickup since the pickup gate is downstream in the resolved path)* |

### Components

**1. New module state (near the other `_acct*` state, `account.js:~2132`)**
```
let _healUnsub = null;             // active heal-on-arrival onValue handle, or null. At most one.
let _healTimer = null;             // bounded fallback timer handle, or null.
let _acctDeliveryLoading = false;  // true while the "Cargando tu dirección…" line occupies #acct-deliver.
```

**2. `failOpenToRaw()` — extracted from the current fail-open branch (behavior-preserving)**
The exact body of today's fail-open (`_acctData = null; _acctProfileConfirmedIncomplete = false; revertToNormalFillable(); refreshSaveToggle();`) extracted verbatim. Called by (a) the guest fail-open (immediate) and (b) the bounded fallback. Shows the raw fields exactly as today.

**3. `showDeliveryLoading()` — the logged-in fail-open hold (step-1 only)**
- `_acctDeliveryLoading = true`.
- Inject **both** `injectDeliverStyles()` and `injectCompactSummaryStyles()` — the `.acct-compact/.acct-cav/.acct-ctxt` classes live in the latter, which `renderS1CompactSummary` normally calls but which never ran on the fail-open path; without it the loading line is unstyled.
- Render a minimal, clean loading line into `#acct-deliver`: an "Entregar a" eyebrow + `PERSON_SVG` + **"Cargando tu dirección…"** (`.acct-fine`), reusing the same `acct-eyebrow`/`acct-compact` shell as the reduced summary so the loading→summary swap is a minimal layout shift.
- Hide the raw name/phone (`#raw-name-phone`) so the fields don't flash.
- **Does not touch payment or step 2.** Payment is a separate step behind Continuar + the map-confirm step; by the time a customer navigates there, the profile has landed (or the existing step-2 fail-open + validation apply). No submit gate is needed.

**4. `armDeliveryHeal()` — one-shot no-deadline listener (the reward chip's pattern)**
- `if (_healUnsub) return;` — at most one at a time (idempotent across repeated fail-opens).
- `if (!marker()) return;` — guests never subscribe.
- Mirror `rewardsSubscribe()` acquisition: `await ensureFirebase()` → `await auth.authStateReady()` → resolve `uid` → re-check `if (_healUnsub) return;` after the await → `_healUnsub = dbMod.onValue(ref('user_profiles/'+uid), cb, onError)`.
- `onError`: tear down (`detachHeal()`) and, if still loading, reveal raw (`clearDeliveryLoading(); failOpenToRaw();`).
- Whole thing `try/catch` → fail-silent.

**5. The heal callback — resolve through the normal router**
1. `val = snap.exists() ? snap.val() : null`.
2. `detachHeal()` — one-shot (drops `_healUnsub` + `_healTimer`).
3. Build `deliveryRecoveryState()` (see #7). **Guard:** `if (!shouldRecoverDeliveryStep(state))` → abandon. But because `detachHeal()` in step 2 already cleared the fallback timer, a plain `return` here would leave "Cargando…" stuck with nothing to rescue it. So on abandon, **if still holding, reveal raw** (`if (_acctDeliveryLoading) { clearDeliveryLoading(); if (!_acctRestoring) failOpenToRaw(); }`) — never trap. The `!_acctRestoring` guard preserves R5 (don't touch the DOM a restore owns). This covers the customer who typed (`rawDeliveryDirty`) before the profile landed. (Post-fallback late arrival is already safe — `_acctDeliveryLoading` is false, so this is a no-op and raw stays.)
4. `clearDeliveryLoading()` (just clears `_acctDeliveryLoading`) then `initDeliveryStep(val).catch(()=>{})`. Passing `val` as `preSnap` means `initDeliveryStep` treats it as a resolved (`status:'ok'`) read and does **no re-read** — the crux that works on a slow link. It routes normally: complete+in-zone → "Entregar a" summary; incomplete → Creá-tu-perfil; complete-but-zone-fails → raw. From a loading line (not raw), any resolution is coherent and non-jarring.
5. `initDeliveryStep` carries its own `_acctRestoring`/`_acctRestoreGen` R5 guards.

**6. Bounded fallback (never trap)**
- When `showDeliveryLoading()` mounts, start `_healTimer = setTimeout(fallback, ~5000)`.
- `fallback()`: if still loading and unresolved → `clearDeliveryLoading()` + `failOpenToRaw()` (raw fields shown, so the customer can fill them in and proceed). **Leave `_healUnsub` armed** — so if the profile lands *after* the fallback, the heal callback still upgrades raw → summary, gated by `shouldRecoverDeliveryStep` (skips if the user has since typed — no clobber).

**7. `deliveryRecoveryState()` — extracted shared state builder (DRY)**
The recovery-state object built inline in `maybeRecoverDeliveryStep` (`account.js:2248`) extracted verbatim into a pure `deliveryRecoveryState()` consumed by both `maybeRecoverDeliveryStep` and the heal callback — same fields (`loggedIn`, `orderType`, `restoring`, `reducedActive`, `editMode`, `createProfileActive`, `confirmedIncomplete`, `rawDeliveryDirty`), no behavior change, so the two can't drift.

**8. The fail-open hook (in `initDeliveryStep`, `account.js:2178`)**
Split the fail-open on login state:
```
if (status !== 'ok') {
  if (marker() && pageOrderType() === 'delivery') { showDeliveryLoading(); armDeliveryHeal(); startHealFallback(); }
  else { failOpenToRaw(); }        // guest OR pickup — raw immediately, unchanged
  return;
}
```
The ONLY path that arms the heal/loading — fires exclusively on a timed-out/errored read for a logged-in **delivery** user. Pickup is excluded here because its gate (`revertToNormalFillable` on `pageOrderType() !== 'delivery'`) is only in the resolved-read path below, so the fail-open branch must exclude it itself. When `initDeliveryStep` is called WITH a `preSnap` (`status` forced `ok`), this branch is never reached → the heal's own `initDeliveryStep(val)` can never re-arm (no loop).

**9. Teardown helpers**
- `detachHeal()`: `if (_healUnsub) { _healUnsub(); _healUnsub = null; } if (_healTimer) { clearTimeout(_healTimer); _healTimer = null; }`.
- `clearDeliveryLoading()`: `_acctDeliveryLoading = false;` (no payment side effects).
- `deliveryHealReset()`: `detachHeal(); clearDeliveryLoading();` — called from `rewardsReset()` (all sign-out paths, `account.js:172`), so a logout drops the listener/timer and clears the hold.

### What is explicitly NOT changed
- `accountSnapshot()` / `accountSnapshotStatus()` — the 1500ms timed read stays; fast-path unchanged.
- `initDeliveryStep` routing — unchanged except the fail-open branch split (#8).
- `maybeRecoverDeliveryStep` / `goToLocation` wrapper — unchanged except consuming `deliveryRecoveryState()` (identical object).
- `shouldRecoverDeliveryStep`, reduced-flow renderers, **`setPaymentVisible`, `deliverySubmitBlocked`, the step-2 map/address/payment flow** — all untouched.
- Driver / payment / factura / rewards / functions — untouched (client-only, no functions deploy).

### Data flow
```
Fast:  load → initDeliveryStep() → get <1500ms → "Entregar a" summary in #acct-deliver.
       [no heal, no loading, no timer — byte-identical to today]

Slow:  load → initDeliveryStep() → get >1500ms → logged-in
            → showDeliveryLoading() ("Cargando tu dirección…" in #acct-deliver, raw fields hidden)
            + armDeliveryHeal() (onValue on user_profiles/<uid>) + startHealFallback(~5s)
       ...profile lands (usually 2–4s, before real checkout)...
            → cb: detach; shouldRecover? yes → clearLoading → initDeliveryStep(val)
            → "Entregar a" summary.  [no re-read]
       ...OR fallback fires first (dead link)...
            → raw fields (customer can fill + proceed; never trapped); onValue stays armed
            → if the address lands later & user hasn't typed → upgrade raw→summary.

Guest slow: → failOpenToRaw() immediately (unchanged).
```

---

## Error handling
- SDK/auth failure in `armDeliveryHeal` → caught, fail-silent; the bounded fallback still reveals raw.
- `onValue` onError → tear down + reveal raw.
- Landed profile incomplete/empty → router shows Creá-tu-perfil / raw as appropriate (from loading, coherent).
- Customer acted before arrival → `shouldRecoverDeliveryStep` false → no heal, no clobber.
- Restore in flight → `_acctRestoring` short-circuits both `shouldRecoverDeliveryStep` and `initDeliveryStep`'s top guard.
- Mid-loading pickup↔delivery toggle → `refreshDeliveryUI` reverts to fillable (fail-open); the armed `onValue` re-upgrades when it lands. Acceptable edge.

Every failure mode degrades to today's behavior (raw fields) — never worse, never trapped.

---

## Testing

**Unit (pure, no DOM/network) — the existing `shouldRecoverDeliveryStep` truth table is reused unchanged** (the heal callback gates on that same function).

**Wiring guards (source-string, both forms — extend `address-autofill-recheckout.test.js`):**
- `deliveryRecoveryState()` exists in both forms; `maybeRecoverDeliveryStep` consumes it; `rawDeliveryDirty` still reads `#address-details`.
- `failOpenToRaw`, `showDeliveryLoading` (+ "Cargando tu dirección" copy), `armDeliveryHeal`, `detachHeal`, `startHealFallback`, `deliveryHealReset` present in both.
- Heal subscribes `user_profiles/<uid>` via `onValue`; resolves via `initDeliveryStep(val)`; gated by `shouldRecoverDeliveryStep(state)`.
- Fail-open branch splits logged-in→loading vs guest→raw.
- `rewardsReset` calls `deliveryHealReset()`.

**On-device (owner, throttled/slow connection — the reproduction):**
1. Logged in, slow link, load + immediate checkout → **no raw-field flash**; "Cargando tu dirección…" then the "Entregar a" summary when it lands.
2. Normal flow (browse, build cart, then checkout) on slow link → summary already there, no loading line seen.
3. Fast connection → summary on load exactly as today; confirm no heal listener / timer created on the warm path.
4. After a fallback-to-raw, type into the fields before the profile lands → heal must NOT clobber.
5. Dead/killed connection → "Cargando…" ~5s → raw fields (can complete an order); never stuck.

**Parity:** diff both forms' `account.js` past the CONFIG sentinel → identical.

---

## Scope & process
- **Files:** both order forms' `account.js` (identical edit; parity verified) + the wiring-guard test.
- **Gate:** order-form codex checkout-integrity gate (read-only) — focus: fail-open never traps; no-clobber; R5 intact; guest/fast/pickup byte-identical; **payment/step-2 untouched**; both forms parity.
- **Deploy:** owner executes, order forms only (Netlify per-folder, explicit `--site`), both together. No functions deploy.
- **Not in scope:** timeout tuning (rejected), pickup autofill, cached-address instant render (rejected — stale-address correctness risk), any payment/submit-gate change (unnecessary — the prefill is step-1, payment is a separate step behind Continuar).
