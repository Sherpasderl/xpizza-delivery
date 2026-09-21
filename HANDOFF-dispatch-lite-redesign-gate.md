# HANDOFF → ADVISOR + CODEX: Dispatch-lite UI overhaul + stuck-alert fix — gate before deploy

**REVISE round 1 closed — 2026-09-21.** Codex caught a **deploy-blocker the by-hand review and all 22 tests missed**: `applyTheme()` ran at module load and read `mapReady`, declared `let` further down the file. Temporal dead zone → `ReferenceError: Cannot access 'mapReady' before initialization` → module evaluation halts → `window.__startApp` never registers → **the PWA boots blank**. Confirmed by hand at `index.html:472` reading a binding declared at `:1297`. Fixed, plus the class of bug closed — see "Round 1 fixes" below. Ready to re-gate.

**Written:** 2026-09-21 (dispatch-lite executor). **Ask:** advisor read-only verify + **codex gate** on the diff → VERDICT APPROVED / REVISE. **NOT money-adjacent** — see the money-path statement below, which is the part to check first. **Not deployed.** **Uncommitted working tree** — owner has not asked for a commit yet; say the word and this splits into two commits along the two deploy paths.

## Gate this

- **Branch:** `spec/dispatch-redesign-A-D`, working tree dirty on top of `41c9586`.
- **Diff:**
  ```
  git -C ~/Downloads/xpizza-delivery diff -- xpizza-dispatch-mobile/ xpizza-functions/staff-push.js xpizza-functions/staff-push.test.js
  ```
- **5 files, +1152 / −906:**

  | File | Δ | Deploy path |
  |---|---|---|
  | `xpizza-dispatch-mobile/index.html` | +1999 (rewrite) | Netlify static |
  | `xpizza-dispatch-mobile/manifest.json` | 20 | Netlify static |
  | `xpizza-dispatch-mobile/sw.js` | 4 | Netlify static |
  | `xpizza-functions/staff-push.js` | 19 | **Firebase functions** |
  | `xpizza-functions/staff-push.test.js` | 16 | test only |

- **Product record:** `PRODUCT.md` (new, untracked) carries the confirmed product truth and every decision taken in this round, with reasoning. Not part of the gate; context for it.

## Money-path statement (check this first)

**No charge, refund, redemption, pricing, fiscal, factura or cash-reconciliation code is touched.** The evidence:

1. **The only money token in the whole diff is the order-total display**, and the expression is unchanged — it was hoisted into a variable before and is inlined now:
   ```
   -  const totalStr = Number(order.total || 0).toFixed(2);
   -  <div class="kv">…<span class="v">L ${escapeHtml(totalStr)}</span></div>
   +  <div class="fact"><s>Total</s><b class="num">L ${escapeHtml(Number(order.total || 0).toFixed(2))}</b></div>
   ```
   Same coercion, same rounding, same `L ` prefix. **Display only; nothing computes a total.**

2. **`readonly.test.mjs` still passes**, which mechanically proves the file performs exactly **two** mutations: 1× `XPD.assignOrderToDriver`, 1× `XPD.reassignOrder`, 1× `set(ref(getDb(), staff_push/<uid>))`, and **zero** other `set|update|remove(ref(…))` and zero `XPD.(set|update|remove|push|runTransaction|setOrderStatus|cancel)`.

3. **New read introduced:** the completed-order sort reads `order.delivered_at` / `order.completed_at` / `order.picked_up_at`. These are **order-level** fields, read-only, for sorting and display. Cuadre reads **task-level** `tasks/*/completed_at` (per the SDK comment at `xpizza-delivery.js:421`) — a different node. No write, no derivation.

4. **`driver-glide.js` untouched** — `parity.test.mjs` green, still byte-identical to the desktop copy.

**Ops-adjacency that still deserves the gate:** the two assignment writes are the app's only mutation and feed driver cash downstream through task completion. They are byte-identical call sites (same entrypoints, same argument order, same frozen `pickerFromDriver` CAS anchor captured at pick-open). Verify that, not the surrounding UI.

## What changed

### A. `index.html` — view-layer rewrite (the bulk of the diff)

Full replacement of markup + CSS + render layer. **The six pure modules are untouched.** Urgency is derived in the view from the existing `sectionForOrder` / `isUnassignedDelivery` / `agingBand` — no model changed, so the model tests still bound it.

- Wallet-style pass deck (80px peek, negative margins from measured heights) replacing the status-section list.
- New pastel token layer, light + dark, every text pairing ≥ 4.5:1 in both.
- Detail sheet: stage pipeline, facts, itemised contents (`renderOrderItems` ported verbatim), customer + `tel:`, driver, assign.

### B. Owner decisions taken this round (all recorded in `PRODUCT.md`)

1. **Aging thresholds unified to the desktop.** The phone no longer passes `{amber:480, red:900}`; both surfaces now call `agingBand(secs)` **bare**, so `dispatch-aging.js`'s default (5 min / 10 min) is the single source of truth and the two cannot drift again.
   **Consequence to review:** because the clock is total age from `created_at`, 10-min red would have painted every in-flight delivery. Heat is therefore gated to `nuevos`/`preparacion` **or** unassigned-at-any-stage — restoring the guard the original file had (`heats = section === 'nuevos' || section === 'preparacion'`) and extending it so a *ready* order with no driver still escalates.
2. **Picker excludes off-shift drivers.** `driverPickList` ranks by hub distance alone, which surfaced a driver who had gone home but parked near the restaurant as the top recommendation for the app's only mutation. On-shift only now, grouped Disponibles / En entrega. The empty state stopped lying (it said "no hay repartidores **en turno**" while listing off-shift drivers).
3. **Pickup is called "Pickup"** everywhere — replaces four competing names. Delivery stays "Entrega".
4. **Completados capped to the current Tegucigalpa day**, sorted by completion time newest-first.

### C. Bugs fixed (both owner-reported, both pre-existing)

1. **Map lost all driver markers.** `showTab('mapa')` and `__focusDriverOnMap()` both called `__onMapaShown()`; both raced past `mapReady` and constructed a **second `google.maps.Map` on the same div**. Markers stayed bound to the detached first instance, and `renderDrivers()` only `setIcon()`s markers it already holds, so they never came back. Fixed with a single-flight init promise, a `getMap() !== map` re-attach guard, and `driverMarkers = {}` on init. Map failure is now retryable instead of permanent.
2. **Completados appeared unsorted.** It was using `orderCompare()` — the *live board* comparator, whose first rule is "delivery before pickup", so finished orders interleaved by type; its second rule is `created_at` **ascending**, the wrong field and the wrong direction for a history list. Now sorts by completion time, descending. `orderCompare()` itself is untouched.

### D. `xpizza-functions/staff-push.js` — the stuck-alert bug

**Owner report:** "⚠️ Pedido #N — lleva N min sin completar" fires on orders that are in process or already en route.

**Root cause (verified from source):** `isStuck()`'s aging branch was `if (ageMs > thresholds.agingMs)` with no status or driver condition, so any live order past the threshold alerted — including one a driver was actively delivering. The `unassigned` branch above it is correctly scoped; the aging branch was not.

**Fix:** suppress aging when `isDelivery && hasDriver && order.status === 'out_for_delivery'`. Everything else past the threshold still alerts: an order the kitchen has not finished, a pickup nobody collected, and — deliberately kept — a `ready` order whose assigned driver never showed.

**Copy changed:** `sin completar` → **`sin salir`**, because the alert now only fires for orders that have not left. Verified no desync: the desktop has no parallel stuck-alert string (`grep "sin completar" xpizza-dispatch/index.html` → only the unrelated 24h-refund alert at `:2779`); this wording lives only in OS notification text.

## Guardrails to verify (all should hold in the diff)

- `readonly.test.mjs` green → exactly 2 mutation sites, unchanged entrypoints.
- `parity.test.mjs` green → `driver-glide.js` byte-identical to the desktop.
- **No file under `xpizza-functions/` other than `staff-push.js` + its test.** No rules, no SDK, no money functions.
- **`xpizza-delivery.js` untouched** — the shared SDK carries every data contract.
- The six pure modules stay DOM-free; all urgency logic lives in the view.
- `pickerFromDriver` is still frozen at pick-open and passed as `reassignOrder`'s third argument (the CAS anchor). A stale view must still abort rather than clobber.
- `isStuck()` change is **additive suppression only** — it can only return `stuck:false` where it previously returned `true`, and it never newly alerts. **Precision, per the auditor:** the caller's dedupe state machine turns that into `stuckDedupe(alerted=true, stuck=false)` → `'clear'`, which *removes* the per-order marker at `staff_push_alerted/<id>`. So the change does have a write side effect beyond "decides whether to send". That is the intended recovery path (an order that stops being stuck should clear), and the consequence is that an order which later becomes genuinely stuck again can alert again rather than being permanently suppressed. No new notification is emitted by the change itself.

## Round 1 fixes (new in this revision)

1. **The blocker.** All mutable module state — `STORE`, `activeChip`, `started`, `tab`, `openPass`, `collapsedDone`, `connected`, `lastData`, `map`, `driverMarkers`, `focusLayer`, `mapReady`, `mapFailed`, `mapInit` — is now declared in **one block above every function and callback that reads it**, before `XPD.initDelivery()`. Commented so the next edit doesn't scatter state again.
2. **A second instance of the same class, found by the new test.** The `onAuth` callback reads `started`, which was also declared below it. Real Firebase always defers `onAuthStateChanged` to a microtask so it would not have thrown in the browser — but the fragility was real and is now gone.
3. **The class is closed: `boot.test.mjs`.** It extracts the module body from `index.html`, stubs the two imports Node cannot resolve (the shared SDK and the Firebase CDN) plus enough DOM for load-time work, and **executes it**, asserting `window.__startApp`, `__onMapaShown` and `__focusOrderOnMap` are registered. Its auth stub fires **synchronously**, deliberately stricter than real Firebase, so load-order safety is proven rather than assumed.
   **Verified the test can fail:** reintroducing the exact original bug (moving `mapReady` back below its reader) produces `1 fail` with `ReferenceError: Cannot access 'mapReady' before initialization`; restoring gives 23/23.

**Why this slipped through, stated plainly:** `node --check` validates syntax and cannot see a temporal dead zone, and the 22 tests imported the six pure modules — never the page. There was no coverage of "does this file actually boot". That gap is why the codex gate earned its keep, and it is now closed by an executing test rather than by care.

## Tests

- **Dispatch-lite:** `node --test` in `xpizza-dispatch-mobile/` → **23/23** (22 + the new boot test). Inline `<script type="module">` extracted + `node --check` → syntax OK.
- **Functions:** `node --test staff-push.test.js` → **28/28** (was 25). Three new regression tests, one per reported case:
  - `out_for_delivery` **with** a driver, 99 min old → **not stuck** (the reported bug).
  - `out_for_delivery` with **no** driver, 99 min old → still `aging` (nobody is moving it).
  - `ready` with a driver who never showed, 99 min old → still `aging`.
  - Existing `formatStuck` copy assertion updated `sin completar` → `sin salir`.
- **Detector:** 1 residual finding, `dark-glow` on `#281950` — a **cross-theme false positive**: that value is `rgba(40,25,80)` in the *light* shadow tokens, which every dark block overrides to neutral black. Static analysis can't resolve which theme renders. The genuine dark-glow hits were real and were fixed by routing accent elevation through `--lift-accent`.
- **Not yet done — owner on-device:** install the PWA and verify the deck expands, assign + reassign both commit, the map keeps its pins across tab switches, `tel:` dials, sign-out returns to login, and the liveness pill flips on airplane mode.

## If APPROVED → deploy (owner) — **two separate deploys**

1. **Dispatch-lite static** — the `xpizza-dispatch-mobile` per-folder Netlify site (`netlify.toml`, `publish = "."`, no build step). **Confirm the site ID explicitly before deploying** — this repo default-links elsewhere (see the `netlify-deploy-mechanics` note in the stalled-reassign handoff). `sw.js` cache bumped `dl-shell-v4` → `dl-shell-v5`; with `skipWaiting()` + `clients.claim()` already in place, installed phones take the new shell on next load without a re-install.
2. **Firebase functions** — `staff-push.js` is server-side and will **not** ship with the static deploy. The alert fix requires a functions deploy. No rules change.

## Still open (not in this diff)

- Whether the phone's "Entrega" / "Pickup" pairing should become Delivery/Pickup or Entrega/Recoger.
- Whether `agingBaselineMs` should become time-in-stage rather than total age from `created_at` — that would change the meaning of the number on every card and belongs in its own round.
- CSP: still none shipped on this site, matching sibling surfaces.
