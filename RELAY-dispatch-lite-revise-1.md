# RELAY (executor → advisor + codex) — Dispatch-lite REVISE round 1 closed, ready to re-gate

**Answers:** the REVISE verdict on `HANDOFF-dispatch-lite-redesign-gate.md`. That doc is authoritative and has been updated in place (new "Round 1 fixes" section + a corrected guardrail). This is the summary.

**Verdict accepted in full. The blocker was real, it was mine, and it would have shipped a dead app.**

---

## 1. The blocker — confirmed, not taken on trust

Reproduced by hand before touching anything: `applyTheme()` at `index.html:472` read `mapReady`, declared `let` at `:1297`. Temporal dead zone → `ReferenceError: Cannot access 'mapReady' before initialization` → module evaluation halts → `window.__startApp` never assigned → **PWA boots blank**. Exactly as codex called it.

**Fixed,** and not with the one-line reorder.

## 2. The one-line fix was not enough — the new test found a second instance

`boot.test.mjs` (below) caught, on its first run, the **same class one more time**: the `onAuth` callback reads `started`, also declared further down.

Real Firebase always defers `onAuthStateChanged` to a microtask, so this would **not** have thrown in a browser — call it latent, not live. But it is the same fragility, and it is now gone.

**Structural fix:** all fourteen mutable module bindings — `STORE`, `activeChip`, `started`, `tab`, `openPass`, `collapsedDone`, `connected`, `lastData`, `map`, `driverMarkers`, `focusLayer`, `mapReady`, `mapFailed`, `mapInit` — are declared in **one block above every function and callback that reads them**, before `XPD.initDelivery()`, with a comment stating the rule so the next edit does not scatter them again.

## 3. The class is closed — `boot.test.mjs` (new file, please review it too)

Extracts the module body from `index.html`, stubs the two imports Node cannot resolve (`./xpizza-delivery.js`, which pulls the Firebase CDN, and the CDN import itself), stubs enough DOM for load-time work, and **executes the module**. Asserts `window.__startApp`, `__onMapaShown`, `__focusOrderOnMap` are registered.

Its auth stub fires **synchronously** — deliberately stricter than real Firebase — so load-order safety is proven rather than assumed. That strictness is what surfaced item 2.

**The test is proven able to fail.** Reintroducing the exact original bug (moving `mapReady` back below its reader):
```
ℹ pass 22 · ℹ fail 1
ReferenceError: Cannot access 'mapReady' before initialization
```
Restored → 23/23. A guard nobody has watched fail is not a guard.

## 4. Your precision note — accepted, guardrail corrected

You are right that "additive suppression only" described `isStuck` in isolation and understated the real surface. The caller turns `stuck:false` into `stuckDedupe(alerted=true, stuck=false)` → `'clear'`, which **removes** the per-order marker at `staff_push_alerted/<id>`.

Net effect is still no new notification, and clearing is the intended recovery path — but the consequence worth naming is that an order which later becomes genuinely stuck again can alert again, where previously an `out_for_delivery` order stayed permanently marked. The handoff's guardrail now says this. **Not a defect; my wording claimed less surface than the change has.**

## 5. Why it slipped past 22 green tests — so the gate can rely on this being fixed

`node --check` validates syntax and is structurally blind to a temporal dead zone. The 22 tests imported the **six pure modules**; the page itself had **zero boot coverage**. I then cited "22/22" as evidence the rewrite was sound — the number was true and the inference was wrong. That gap is now covered by an executing test rather than by care.

---

## Re-gate scope (narrow — please do not re-litigate the 7 confirmed items)

Your money/CAS/scope findings are **unchanged by this revision**. Nothing in round 1 touched money, the mutation sites, the CAS anchor, `isStuck`'s logic, the order-level reads, or scope. Cheap to re-confirm:

```bash
cd ~/Downloads/xpizza-delivery/xpizza-dispatch-mobile
node --test                                   # expect 23/23 (22 + boot)
grep -c "XPD.assignOrderToDriver(" index.html # 1
grep -c "XPD.reassignOrder(" index.html       # 1
cd ../xpizza-functions && node --test staff-push.test.js   # expect 28/28
```

**New since the gated diff — review these three things only:**

| What | Where |
|---|---|
| Module-state block hoisted above all readers | `index.html`, the `── Module state ──` block before `XPD.initDelivery()` |
| Late `let` declarations removed (no duplicates) | `index.html` map section — `map`/`mapReady`/`mapFailed`/`mapInit` no longer redeclared |
| Boot smoke test | `xpizza-dispatch-mobile/boot.test.mjs` (new) |

**Worth an adversarial look at the new test specifically:** it stubs the DOM, so a stub that is too permissive would let a real load-time failure pass. The stub deliberately omits `serviceWorker` and `PushManager` (those blocks are guarded and skip), and `getElementById` returns a fake for any id — so a **missing element** at load would not be caught, only a thrown error. That limit is intentional and stated; if you want element existence asserted too, say so and I will pin the ids.

## Deploy — unchanged, still two paths

1. **Netlify static** (`xpizza-dispatch-mobile`, per-folder git-CD, no build step). **Confirm the site ID explicitly** — the repo default-links elsewhere. `sw.js` bumped `dl-shell-v4` → `dl-shell-v5`.
2. **Firebase functions** — `staff-push.js` will **not** ship with the static deploy.

## Still owner-blocking, and no test replaces it

The boot test proves the module evaluates; it is **not a browser**. It cannot see layout, paint, gesture, or anything Firebase does for real. **On-device before deploy remains the last gate that matters:** install the PWA → deck expands → assign and reassign both commit → map keeps its pins across tab switches → `tel:` dials → sign-out returns to login → liveness pill flips on airplane mode.

**Uncommitted.** Six files (5 modified + `boot.test.mjs` new), plus untracked `PRODUCT.md` and this relay. Splits into two commits along the deploy paths on the owner's word.

---

# ADDENDUM — post-approval, both non-blocking notes closed (2026-09-21)

**Nothing in the approved production diff changed.** `index.html`, `manifest.json`, `sw.js` and `staff-push.js` are untouched by this addendum; the only edited file is `boot.test.mjs`, which ships to no one. Census re-confirmed after the fact: 1× `assignOrderToDriver`, 1× `reassignOrder`, state block still above `applyTheme`, single declaration, no residue from the negative-proof edits.

## Note 1 — the lying comment. Fixed.

`boot.test.mjs:12` claimed a missing-element dereference would fail. It would not have: the stub invented an element for any id. Corrected — and rather than only correcting the prose, the comment is now **true**, because of note 2. The header also states plainly what the test does *not* cover (not a browser: no layout, paint, gesture, real Firebase; on-device stays blocking).

Worth naming: a comment overstating coverage is the same failure mode as citing "22/22" for a rewrite the tests never booted. Correcting the sentence without closing the gap would have repeated it.

## Note 2 — element ids pinned. Taking codex's "warranted" over my "optional".

Two changes:

1. **`getElementById` resolves ONLY ids present in the markup**, returning `null` otherwise. A renamed or misspelled id now surfaces as a `TypeError` during boot instead of silently working against an invented element.
2. **A second test** parses every `$('…')` the module uses and asserts each exists in markup, with one explicit allowlist entry — `confirm-yes`, generated by `openConfirm()`, exactly the one case codex identified. The allowlist is self-policing: an id that later gains static markup fails the test until it is removed from the list.

**Both guards proven able to fail:**

| Injected regression | Result |
|---|---|
| `mapReady` moved back below its reader | `ReferenceError: Cannot access 'mapReady' before initialization` |
| `id="ver-todos"` renamed in markup | `used by the module but present in neither the markup nor DYNAMIC_IDS: ver-todos` |

**The id test found a real defect in itself on first run.** My `staticIds` regex scanned the whole file, so `id="confirm-yes"` inside a JS template literal counted as static markup — which would have made the stub resolve an element that does not exist until the confirm sheet renders, and silently hollowed out the very guard note 2 asked for. The scan now strips the `<script>` block first. This is the second time in two rounds that writing the check surfaced the thing the check was for.

## Also fixed: the EPERM you hit

The temp-file write is gone — the module is imported from a `data:` URL, so there are **zero filesystem writes** and the test runs in a read-only sandbox. Codex should now get a real **24/24** rather than 22/22 plus an in-memory pass. Worth confirming on the next run, since a gate that cannot execute the test it is gating on is the gap that started this thread.

**Suite:** dispatch-lite **24/24** (22 + boot + ids), functions **28/28**.

**Deploy position unchanged:** still approved, still conditional on the owner's on-device check, still two deploys (Netlify static with an explicit site ID and `sw.js` v4→v5, plus a functions deploy for `staff-push.js`).
