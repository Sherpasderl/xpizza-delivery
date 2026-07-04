# Phase 1 · Step 2 — v0 KDS overdue nudge (propose-first design)

_Status: PROPOSED · **rev-3** — folds the 4 Codex R2 blockers. For advisor read-only + Codex Round-3 (thread 019f2d61) BEFORE any code._

### rev-3 changelog (the 4 R2 folds)
R1. **ID mismatch fixed (raw vs mapped).** Raw orders have `o.order_id`, not `o.id` (`mapFirebaseOrderToCard` creates `id: o.order_id`, `:1390`). The controller normalizes each raw order to `id = o.order_id || key` and uses THAT for `#card-${id}` and the `order_timelines/{id}` subscription — otherwise every lookup was `undefined`.
R2. **🔴 Fault-isolated hook (live-surface rule).** Optional chaining only guards the controller being *absent*, not `onOrders` *throwing*. The hook is placed **after** the existing `render()`/`checkForNewOrders()` work and wrapped: `try { window.__readyNudge?.onOrders(ordersById) } catch (e) { console.warn(...) }`. A nudge bug can never take down the live KDS render.
R3. **Teardown at EVERY unsubscribe site.** Not just the signout button (`:1845`) — also the `!user` auth-state teardown (`:1854`) and the restart inside `startOrdersSubscription` (`:1297`). `window.__readyNudge?.teardown?.()` is called anywhere `firebaseUnsubscribe()` is invoked or replaced (all three sites).
R4. **Real x_pizza KDS host pinned + verified.** The repo conflicts — README says `xpizzakitchendisplay.netlify.app`, tests say `xpizzakitchen.netlify.app` — and there's no `.netlify/state.json` (repo linked to CATERING), so the live host can't be resolved from the repo. A wrong allowlist silently disables the nudge on the MAIN KDS (fail-closed cuts the wrong way). The allowlist host is pinned as a build constant and the advisor **independently verifies both live hosts at the build-gate**.


_Sequenced under `PHASE1_READY_TIME_PREDICTOR.md` (rev-3) Step 2. Phase 0 + Step 1 substrate LIVE._
_Prime directive: **the FIRST live client surface** in Phase 1 (deploys to Netlify) on the SHARED `xpizza-kitchen/` folder serving BOTH restaurants. HARD CONSTRAINT: **purely additive; rendering/behavior byte-identical for both restaurants except the beep/flash.** Eligibility from **canonical Firebase status + `order_timelines` stamps ONLY** — never rendered class / column / `localState` / `estado`._

### rev-2 changelog (Codex R1 resolutions)
1. **`order_timelines` client read APPROVED (owner, finding #7 / §8-Q1).** Relax `order_timelines/{orderId}` `.read = "auth != null"` (read-only; `.write` stays `false`) so the KDS reads `preparing_at`. Folded into `xpizza-reference/database.rules.json` + the functions mirror, `check:rules` mirror-equal. This is now a **hard dependency**, not an option.
2. **`created_at` DROPPED as an eligibility anchor (finding #3).** The nudge anchor is `preparing_at` **only**; when `preparing_at` is absent the nudge **fail-closes (no nudge)** — there is no `created_at` fallback path anymore. So the nudge depends entirely on the §1 read.
3. **Deploy governance — the rules relaxation is a security-posture prod mutation.** It is built + committed here (gated via `check:rules` + mirror-equality) but **Xavier runs the actual `deploy:rules` himself**, as a **separate gated step, NOT bundled** with the KDS Netlify deploy.
4. **#1 — no second `/orders` subscription.** The nudge controller is fed the existing canonical `ordersById` snapshot via a single additive hook line in the current `subscribeToOrders` callback — not a second full subscription (which would double bandwidth/snapshots).
5. **#2 — bounded timelines read.** No root `order_timelines` subscription. The controller subscribes **per active order-id** (`order_timelines/{id}`), unsubscribing when a card leaves — bounding reads to on-screen orders (which also confines the cross-restaurant read to the KDS's own orders).
6. **#4 — DOM-miss must not consume the beep.** A missing `#card-${id}` (archived / not-yet-rendered / replaced) skips the toggle **and does not mark the order beeped**, so it beeps correctly when the card later appears.
7. **#5 — re-apply post-render.** `render()` replaces column `innerHTML` wholesale (`:1242`), dropping `.nudge-overdue`. A `MutationObserver`/rAF re-applies the class immediately (idempotent, no beep); the 1 s tick only drives time-boundary transitions. Additive — `render()` is not edited.
8. **#6 — lifecycle teardown.** The controller exposes `teardown()` (clears interval, disconnects observer, unsubscribes all per-id timeline + threshold listeners), called wherever `firebaseUnsubscribe` is torn down (signout / failed kitchen-role / restart, `~:1845`).
9. **#8 — host fail-closed.** `kdsRestaurantFromHost` defaults unknown/custom hosts to `x_pizza` (fine for filtering, wrong for a threshold). The nudge adds a strict `isKnownKdsHost(host)` allowlist gate — an unrecognized host **disables the nudge** (never applies x_pizza's threshold to an unknown host). la_musa host coverage is a launch check.
10. **#9 — beep hardening.** Resume the `AudioContext` on the first user gesture (a passive KDS may start suspended); **suppress the first-load storm** (seed already-eligible orders as beeped at load; beep only on eligibility that becomes true AFTER load); at most one beep per tick + a cooldown.
11. **#10 — idempotent apply + stronger no-op test.** `applyNudges` only mutates `classList` when the desired state differs from the current; the golden/DOM test asserts **zero class mutations** when eligibility is unchanged (catches a churning toggle racing re-render), not merely the final class value.

---

## 0. What Step 2 is

A kitchen-facing nudge: **beep + flash a card that is canonically `preparing`, not yet `ready`, and past a per-restaurant prep threshold** — so a forgotten order gets re-surfaced, sustaining the "Listo"-tap habit the whole predictor depends on. v0 = a **constant per-restaurant threshold**; it graduates to `predictReadyAt` only after Step 4 beats baseline. No customer-facing surface, no driver effect, no write to `/orders`.

## 1. Where it plugs in — grounded in the code (and what it must NOT touch)

- The canonical raw order reaches the KDS via `XPD.subscribeToOrders` → `mapFirebaseOrderToCard(o)` (`index.html:1351`), which still has the raw **`o.status` / `o.created_at` / `o.order_id`** before the Spanish display mapping.
- `renderCard` (`index.html:1110`) computes its column/class from **`localState[order.id] || order.estado`** (`:1111`) and the catch-all `else → 'listo'` (`:1122-1125`) — **display state**. The Step-1 finding stands: these are unsafe as logic inputs. The nudge **must not** read them.
- **Design consequence — the nudge is a near-isolated post-render decoration.** It does NOT modify the *logic* of `renderCard`, `render`, `mapFirebaseOrderToCard`, or `effectiveStatus`. It is a self-contained controller module that toggles a **new CSS class** on the already-rendered `#card-${order_id}` elements and edge-beeps. The only edits to existing code are **guarded additive hook lines** (§5): a try/caught `window.__readyNudge?.onOrders(ordersById)` hook at the end of the `subscribeToOrders` callback (feeding the controller the existing canonical snapshot instead of a second subscription, #1/R2) and a `window.__readyNudge?.teardown?.()` call at each of the **three** `firebaseUnsubscribe` sites (restart `:1297`, signout `:1845`, `!user` `:1854` — #6/R3) — all optional-chained (and the `onOrders` hook additionally try/caught) so existing behavior is unchanged whether the controller is absent OR throwing. Byte-identity is proven by the diff surface (see §6).

## 2. Canonical eligibility — `nudgeEligibility(order, timeline, thresholdMin, nowMs)` (pure, node-testable)

Mirrors the `order-filter.js` pattern (dependency-free, `.test.mjs`-golden). Returns `{ nudge: boolean, reason }`.

- **Canonical status gate:** `order.status === 'preparing'` (raw Firebase status — the single source of truth). Any other status ⇒ no nudge. This alone subsumes "not yet ready" for the normal path (status flips to `ready` the moment the tap lands).
- **Ready cross-check (defense-in-depth):** if `timeline?.ready_at` is a number ⇒ no nudge (guards a race where status still reads `preparing` but `ready_at` was already stamped).
- **Age anchor — `preparing_at` ONLY (no `created_at` fallback; finding #3):** `anchor = timeline?.preparing_at`. **`preparing_at` is the correct anchor** — a prep-overdue nudge must measure time *cooking*, not time *since order placed*; `created_at` includes the `new`/queue wait, so a card that sat 25 min in queue then just entered prep would false-nudge immediately. **`created_at` is NOT used** (dropped in R1): if `preparing_at` is not a number ⇒ **no nudge** (fail-closed — never nudge on an uncomputable/queue-contaminated age). The nudge therefore depends entirely on the §3 `order_timelines` read; `order.created_at` is no longer an input.
- **Threshold:** `nudge = (nowMs − anchor) ≥ resolveThreshold(thresholdMin) × 60000`.
- `resolveThreshold(v) = (typeof v === 'number' && isFinite(v) && v > 0) ? v : DEFAULT_PREP_THRESHOLD_MIN` (**fail-closed default = 25 min**) — a missing/misread config yields a conservative threshold, never nudge-spam.

## 3. The `order_timelines` read — APPROVED rules relaxation (hard dependency)

`preparing_at` / `ready_at` live ONLY in `order_timelines` (Phase-0). That tree is admin-only today — `database.rules.json:88` `order_timelines: {".read": false, ".write": false}` — so the KDS client cannot read it. **OWNER-APPROVED (finding #7):** relax it so the KDS reads `preparing_at`:

- **Exact change (both `xpizza-reference/database.rules.json` and the functions mirror, `check:rules` mirror-equal):**
  `"order_timelines": { ".read": "auth != null", ".write": false }` — authenticated-only read; **no public read; write stays `false`**. Timing stamps only (no PII, no money); mirrors the `config` tree's own `.read: "auth != null"` (`:68`).
- **Bounded per-active-card read (#2):** the KDS does **not** subscribe to the `order_timelines` root. It subscribes **per active order-id** — `order_timelines/{id}` — adding a listener when a card appears and unsubscribing when it leaves. This bounds bandwidth to on-screen orders and, in practice, **confines the read to the KDS's own restaurant's orders** (the active set is already restaurant-filtered), mitigating the cross-restaurant exposure below.
- **Scoping caveat (accepted):** the rule itself carries no `restaurant_id` (timeline nodes have none), so `.read: "auth != null"` is not restaurant-scoped at the rules layer — a la_musa KDS *could* read an x_pizza node if it asked. Timing-only, both Sherpa-operated → accepted at the gate; the per-active-card read (above) means the KDS only ever *asks* for its own orders.
- **No fallback:** with `created_at` dropped (§2, finding #3), the nudge has **no path without this read** — if `preparing_at` is absent it fail-closes. So this rules relaxation is a **hard dependency** of Step 2, not optional.
- **Deploy governance (finding: security-posture prod mutation):** the rule change is **built + committed here** (gated via `check:rules` + mirror byte-equality) but the actual **prod `deploy:rules` is run by Xavier himself**, as a **separate gated step**, NOT bundled with the KDS Netlify deploy. The KDS code can ship before or after, but the nudge is inert (fail-closed, no reads succeed) until the rules deploy lands.

## 4. Per-restaurant threshold config (mandatory, fail-closed, both hosts)

- Read from **`config/ready_time/${KDS_RESTAURANT_ID}/prep_threshold_min`** — under the existing `config` tree (`.read: "auth != null"`, `:67-69`), so **no rules change** for the threshold itself; `KDS_RESTAURANT_ID` = `kdsRestaurantFromHost(host)` (`order-filter.js:21`).
- New additive `XPD` export `subscribeReadyTimeThreshold(restaurantId, cb)` (mirrors the existing `config/auto_assign_enabled` `onValue` reader, `xpizza-delivery.js:588`).
- **Host fail-closed (#8) + pinned host (R4):** `kdsRestaurantFromHost` fails *safe* to `x_pizza` for filtering, but applying x_pizza's **threshold** to an unrecognized/custom host is wrong. The nudge adds a strict **`isKnownKdsHost(host)` allowlist** → the restaurant, matching each real host **and its Netlify preview form** (`host === H || host.endsWith('--'+H)`, mirroring `kdsRestaurantFromHost`). An **unknown host disables the nudge entirely** (no toggle, no beep) — never borrows x_pizza's threshold.
  - **Pinned hosts (R4, confirmed live via Netlify API):** x_pizza KDS = **`xpizzakitchendisplay.netlify.app`**, la_musa KDS = `lamusakitchendisplay.netlify.app`. ⚠ The allowlist constant + its test **must use `xpizzakitchendisplay.netlify.app` explicitly** and must NOT inherit `order-filter.test.mjs`'s stale `xpizzakitchen.netlify.app` (that stale value is exactly the R4 trap). A wrong value silently disables the nudge on the main KDS. The advisor re-confirms both live hosts at the build-gate.
- **Fail-closed threshold:** unset/misread ⇒ `DEFAULT_PREP_THRESHOLD_MIN` (25). Owner/ops-tunable per restaurant. Ops item: optionally seed `config/ready_time/{x_pizza,la_musa}/prep_threshold_min`.
- **Both host mappings tested:** known `x_pizza` host → `config/ready_time/x_pizza/…`; `lamusakitchendisplay.netlify.app` → `config/ready_time/la_musa/…`; **unknown host → nudge disabled**.

## 5. Additive integration (the only diff surface)

1. **New pure module** `xpizza-kitchen/ready-nudge.js` (dependency-free, node-testable): `nudgeEligibility`, `resolveThreshold`, `DEFAULT_PREP_THRESHOLD_MIN`, `isKnownKdsHost`.
2. **New CSS** — a single `.nudge-overdue` class (@keyframes pulse + box-shadow/border) that is a **visual overlay only** (no reflow, no layout change) so nothing else shifts.
3. **New nudge-controller `<script>` in `index.html`** — self-contained module with an explicit lifecycle:
   - **Data in (no new /orders subscription, #1; fault-isolated, R2):** fed the existing canonical `ordersById` via a hook appended to the current `subscribeToOrders` callback **after** its `render()`/`checkForNewOrders()` work, wrapped in try/catch: `try { window.__readyNudge?.onOrders(ordersById) } catch (e) { console.warn('nudge onOrders failed', e); }`. Optional chaining guards the controller being absent; the try/catch guards it **throwing** — a nudge bug can never break the live render. `onOrders` normalizes each raw order to **`id = o.order_id || key`** (R1 — raw orders have `order_id`, not the mapped `id`), and that `id` keys both the DOM lookup and the timeline subscription.
   - **Timelines (bounded, #2):** maintains a map of **per-order-id** `XPD.subscribeToOrderTimeline(id, cb)` listeners keyed by the normalized `id` — adds one when an order enters the active set, unsubscribes when it leaves. The sole `preparing_at`/`ready_at` source.
   - **Threshold + host gate:** `XPD.subscribeReadyTimeThreshold(rid, cb)`; the controller **no-ops entirely if `!isKnownKdsHost(host)`** (#8).
   - **`applyNudges()` — idempotent class application (#10):** for each active order (keyed by normalized `id`), `nudge = nudgeEligibility(o, timelines[id], thresholdMin, Date.now())`; look up `#card-${id}`; **only mutate when desired ≠ current** (`el.classList.contains('nudge-overdue') !== nudge`). No beep here. Runs on: a **`MutationObserver`** watching the three `col-body` containers (re-applies within a frame after `render()` wipes `innerHTML`, #5) **and** the 1 s tick (time-boundary transitions).
   - **`maybeBeep()` — edge-triggered (#4, #9):** an order beeps only when it **transitions** to eligible AND its `#card-${id}` element **exists** — a DOM miss neither beeps nor marks it beeped, so it beeps when the card later renders. First-load storm suppressed: on the first post-data pass, already-eligible orders are seeded into `beepedIds` **without** beeping. At most **one beep per tick** + a cooldown; `AudioContext` created lazily and `resume()`d on the first user gesture (KDS may start suspended).
   - **`teardown()` — at EVERY unsubscribe site (#6, R3):** clears the tick interval, disconnects the `MutationObserver`, and unsubscribes every per-id timeline listener + the threshold listener. `window.__readyNudge?.teardown?.()` is called at all three `firebaseUnsubscribe` sites — the restart in `startOrdersSubscription` (`:1297`), the signout button (`:1845`), and the `!user` auth-state teardown (`:1854`) — so nothing runs post-signout or across a restart.
   - **Inert until rules land:** before Xavier's `deploy:rules`, `subscribeToOrderTimeline` reads are denied → `timelines` empty → `preparing_at` absent → **every order fail-closes**. The KDS ships dark and lights up only when the rule deploys.
4. **New additive `XPD` exports** in `xpizza-delivery.js`: `subscribeToOrderTimeline(orderId, cb)` (single-node, returns unsubscribe) + `subscribeReadyTimeThreshold(restaurantId, cb)`.

**Existing render pipeline — proven byte-identical (functions unchanged):** `renderCard`, `render`, `mapFirebaseOrderToCard`, `effectiveStatus`, `moveOrder`, `filterLiveOrders`, `kdsRestaurantFromHost`. **The real diff surface:** one **try/caught** `window.__readyNudge?.onOrders(ordersById)` hook at the end of the `subscribeToOrders` callback, plus a guarded `window.__readyNudge?.teardown?.()` at each of the **three** `firebaseUnsubscribe` sites (`:1297`/`:1845`/`:1854`) — all optional-chained (and the `onOrders` hook try/caught) so existing behavior is unchanged whether the controller is absent or throwing.

## 6. Byte-identity + the golden/no-op gate harness (what the gate runs)

For a client DOM change there is no emulator side-effect proof, so the gate is **byte-identity + canonical-source + additive-only**:

- **Pure golden test** `ready-nudge.test.mjs` (node, like `order-filter.test.mjs`): every `nudgeEligibility` branch — non-`preparing` status → no nudge; `ready_at` set → no nudge; **`preparing_at` absent → NO nudge (fail-closed, no `created_at` fallback — #3)**; `preparing_at` present + past threshold → nudge; a queued-then-just-preparing order (old `created_at`, recent `preparing_at`) does NOT nudge (pins that queue time is excluded); threshold boundary; `resolveThreshold` fail-closed default (25); assert `order.created_at` is never read. Plus **`isKnownKdsHost` (#8):** the two real hosts → true; unknown/custom host → false (→ nudge disabled); and per-restaurant threshold path resolution for both known hosts.
- **Structural byte-identity:** `git diff` shows the existing render pipeline functions (§5) **unchanged** except the **guarded additive hook lines** — the try/caught `onOrders` hook (end of the `subscribeToOrders` callback) and the `teardown()` call at each of the three `firebaseUnsubscribe` sites (`:1297`/`:1845`/`:1854`). The gate greps the diff to confirm no other edits inside those functions, that the `onOrders` hook is **try/caught** (R2 — a throw can't break render), and that every added line is optional-chained/guarded (inert when the controller is absent).
- **ID normalization (R1):** a unit test that `onOrders` maps a raw order `{order_id:'A',status:'preparing'}` to the `id` used for `#card-A` and `order_timelines/A` — never the absent `o.id`.
- **Idempotent-apply / zero-mutation no-op (#10):** with a spy on `classList.add/remove/toggle`, assert `applyNudges` performs **zero** class mutations when eligibility state is unchanged across calls (not merely that the final class is absent) — catches a churning toggle racing the `MutationObserver`/re-render. And: no eligible order ⇒ no `.nudge-overdue` anywhere ⇒ DOM equals pre-nudge.
- **Beep discipline (#9):** on first load with an already-eligible order, **no beep** (seeded into `beepedIds`); a *transition* to eligible with the card present → exactly one beep; eligible with `#card-${id}` missing → no beep and not marked beeped (beeps when it later appears, #4); at most one beep/tick + cooldown honored.
- **Both-restaurant equivalence:** the only per-restaurant difference is the threshold value (per host config path) and thus WHEN the flash/beep fire — the base render is identical. Host-mapping test pins `x_pizza` vs `la_musa` config paths (and unknown → disabled).

## 7. Deploy plan (after gate)

Commit → advisor gate (read-only byte-identity + golden test + Codex) → **two independent, separately-gated deploys, order-independent** (the KDS is inert until the rules land, so either can go first):
- **KDS code** — a per-folder Netlify deploy with **explicit `--site` for EACH KDS site** (both serve `xpizza-kitchen/`; the repo is linked to a different site, so `--site` is mandatory — see `netlify-deploy-mechanics`).
- **`order_timelines` `.read` relaxation** — a **`deploy:rules` run by Xavier himself** (security-posture prod mutation), gated via `check:rules` + mirror byte-equality, **NOT bundled** with the Netlify deploy. The nudge stays fail-closed/inert until this lands.

Latent gotcha (from memory): `kdsRestaurantFromHost` matches the literal `lamusakitchendisplay.netlify.app` host — a **custom domain** on the la_musa KDS would break the mapping (→ x_pizza threshold). Flagged; both sites currently on `*.netlify.app`.

## 8. Open questions / sign-off
1. ~~`order_timelines` client read~~ — **RESOLVED (R1 #7): owner approved `.read = "auth != null"`; Xavier deploys the rule (§3, §7).**
2. **`DEFAULT_PREP_THRESHOLD_MIN` = 25 min** and whether to seed per-restaurant `prep_threshold_min` now.
3. **Beep behavior RESOLVED (#9):** one edge-beep per eligibility transition, first-load storm suppressed, one/tick + cooldown, `AudioContext` resumed on gesture. Remaining: confirm the tone is distinct from the new-order sound.
4. ~~The exact x_pizza KDS host~~ — **RESOLVED (R4): `xpizzakitchendisplay.netlify.app` (confirmed live via Netlify API)**; advisor re-confirms both hosts at the build-gate.
5. Confirm v0 stays a constant threshold; `predictReadyAt` wiring is Step 3+.

## 9. Gate flow
Executor propose-first (this doc, rev-3) → advisor read-only verify (byte-identity of the untouched pipeline; canonical-source-only; both host mappings; **independently verifies the two live KDS hosts**, R4) + runs `ready-nudge.test.mjs` → Codex Round-3 (thread 019f2d61) → build (commit, NO deploy) → build-gate → per-folder Netlify deploy (explicit `--site` each), and the `order_timelines` rules deploy on **Xavier's hand**, separately gated.
