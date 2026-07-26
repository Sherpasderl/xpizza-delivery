# Logged-in Delivery UX Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Five polish fixes to the LIVE logged-in complete-profile delivery flow (spec: `docs/superpowers/specs/2026-07-26-loggedin-delivery-polish-design.md`, codex design-gate APPROVED R3). Guest byte-identical; money path untouched.

**Architecture:** All logic in `account.js`; NO structural index.html change (only reading existing DOM). `la-musa-orders/account.js` is source of truth; `xpizza-orders/account.js` mirrored byte-identical past the ~20-line CONFIG block in the final task.

**Tech Stack:** Vanilla `window.__ACCOUNT` classic script; Google Maps JS (already loaded) + Google Static Maps (thumbnail img); existing `saveAddress`/`profileComplete`/reduced-flow layer.

---

## Ground rules (every task)
- Edit `la-musa-orders/account.js` for Tasks 1–6; mirror to `xpizza-orders/account.js` in Task 7 (byte-identical past CONFIG — verify with a Node compare, shell `/dev/fd` diff may be sandbox-blocked).
- Do NOT change index.html structure/guest flow. Reading existing element ids/classes is fine; the Static Maps key is READ from the existing `maps.googleapis.com/maps/api/js?...key=` script src (per-form), never hardcoded.
- Money path untouched: no change to `processPayment`, `openFullscreenMap`/`fsMap`, `gmap`/`gmarker`/`lat`/`lng`/`__restorePos` handling (except the explicit Cambiar fresh-pin reset in Task 3), `_acctCreateProfileActive`/`deliverySubmitBlocked`, `reducedFlowInvariantOk`, PixelPay, R4/R5 restore guards.
- No cheap emoji. Guest byte-identical is the hard gate (Task 6 verify).
- Commit after each task.

---

## Task 1: Centralized chrome+label helper `setReducedDeliveryChromeVisible`

**Files:** Modify `la-musa-orders/account.js` — add near `hideRawAndAddrSection` (~L2159).

- [ ] **Step 1: Capture the original button text once + add the helper**

```js
  // Single source of truth for the reduced-flow chrome (codex F4/F5 + R2): the s2 editable map,
  // the "Mové el pin" zone banner, the #locinfo card, AND the #btn-continuar label. hide=true when
  // the complete-profile reduced flow is active; hide=false on every normal/guest/pickup/fail-open
  // exit. RESTORE is order-type-aware — delivery chrome comes back only for delivery (pickup keeps
  // it hidden, matching the host setOrderType('pickup')). The button label restores regardless.
  let _origContinuarText = null;
  function setReducedDeliveryChromeVisible(hide) {
    const btn = document.getElementById('btn-continuar');
    if (btn && _origContinuarText === null) _origContinuarText = btn.textContent;   // capture once
    const mapWrap = document.getElementById('map')?.parentElement || null;
    const zone = document.querySelector('#s2 .zone-notice') || null;
    const loc = document.getElementById('locinfo') || null;
    if (hide) {
      if (mapWrap) mapWrap.style.display = 'none';
      if (zone) zone.style.display = 'none';
      if (loc) loc.style.display = 'none';
      if (btn) btn.textContent = 'Continuar al pago';
    } else {
      const isDelivery = pageOrderType() === 'delivery';
      if (mapWrap) mapWrap.style.display = isDelivery ? '' : 'none';   // pickup keeps them hidden (R2)
      if (zone) zone.style.display = isDelivery ? '' : 'none';
      if (loc) loc.style.display = isDelivery ? '' : 'none';
      if (btn && _origContinuarText !== null) btn.textContent = _origContinuarText;   // label restores always
    }
  }
```

- [ ] **Step 2: Reason-check** — `pageOrderType()` exists and returns 'delivery'/'pickup' (it's used throughout account.js). The helper is idempotent and does not fight the host `setOrderType('delivery')` (which natively restores the same elements). No guest code runs it yet (wired in Tasks 2/5).

- [ ] **Step 3: Commit**
```bash
git add la-musa-orders/account.js && git commit -m "feat(uxpolish): centralized reduced-delivery chrome+label helper (order-type-aware restore)"
```

---

## Task 2: Wire the helper into the reduced-flow hide + every restore exit

**Files:** Modify `la-musa-orders/account.js`.

- [ ] **Step 1: HIDE — in the reduced-flow success branch of `refreshDeliveryUI`** (~L2239, right where `hideRawAndAddrSection()` is called), add `setReducedDeliveryChromeVisible(true);` immediately after it. Do the SAME in `initDeliveryStep`'s reduced-flow success branch if it hides raw/addr separately (grep for the other `hideRawAndAddrSection()` call site and add the helper call alongside).

- [ ] **Step 2: RESTORE — add `setReducedDeliveryChromeVisible(false);` to EVERY branch that restores `#raw-name-phone`/addr section:**
  - `revertToNormalFillable()` (~L2198) — after it restores raw/addr.
  - `hidePickupDeliverySummary()` (~L2252) — after it restores raw. (Helper keeps chrome hidden for pickup via the order-type check — correct.)
  - The sign-out/delete revert (~L1827, `revertToGuestForm` or equivalent) — after raw restore.
  - `refreshDeliveryUI`'s fail-open/guest early-return branch (~L2218, the `!_acctData` path that ISN'T the create-profile arm) and the invariant-failure fall-through (before/at `applyCreateProfileFlow(_acctData)` ~L2245).

- [ ] **Step 3: Reason-check restore coverage** — enumerate: page-load complete→hidden; delivery→pickup toggle→pickup keeps hidden; pickup→delivery→restored; sign-out (in delivery)→restored; sign-out (in pickup)→stays hidden; fail-open (timeout)→restored (delivery) so the guest-identical editable map shows; "otro pedido" reset→restored. No path leaves the chrome hidden for a user who needs the editable map.

- [ ] **Step 4: Commit**
```bash
git add la-musa-orders/account.js && git commit -m "feat(uxpolish): hide s2 delivery map in reduced flow + restore on every exit (button label too)"
```

---

## Task 3: Cambiar new-address fresh-pin policy

**Files:** Modify `la-musa-orders/account.js` — the "usar una dirección nueva" path reachable from `openCambiarPanel()` (~L2272) → `enterEditMode(true)` (~L1071).

- [ ] **Step 1: In the new-address branch** (where the user chooses to enter a brand-new address rather than pick a saved one), BEFORE the map is used:
  1. Reveal the map: `setReducedDeliveryChromeVisible(false)` (order type is delivery here) or explicitly un-hide `document.getElementById('map')?.parentElement`.
  2. Reset the pin so no stale coordinate carries over:
```js
     try { lat = null; lng = null; } catch (_) {}
     try { if (gmarker) { gmarker.setMap(null); gmarker = null; } } catch (_) {}
     try { __restorePos = null; } catch (_) {}
```
  3. Establish a fresh pin via the existing init/geolocate path (`initMap()` already runs on entering s2), then AFTER reveal trigger a resize+recenter so tiles render:
```js
     try { if (gmap) { google.maps.event.trigger(gmap, 'resize'); if (lat && lng) gmap.setCenter({lat, lng}); } } catch (_) {}
```
  (If `lat/lng` are null after reset, the geolocate/GPS path or a user pin-drop sets them; `processPayment`'s lat/lng + zone checks are the backstop that blocks submit until a real pin exists.)

- [ ] **Step 2: Reason-check** — after choosing "usar una dirección nueva", the map is visible, shows NO stale pin, and the order cannot submit until a fresh pin is placed. Picking a SAVED address (the other Cambiar action) is unaffected (it sets order fields from that address, no map needed). `lat`/`lng`/`gmarker`/`__restorePos` are the checkout globals — this is the ONLY task permitted to reset them, and only on the explicit new-address gesture.

- [ ] **Step 3: `agent-browser`/reason verification** — can't fully exercise offline; reason-verify the reset ordering (reveal → reset → resize) and that no saved-address path hits this reset. Confirm `initMap`/`gmap` reference names match the file.

- [ ] **Step 4: Commit**
```bash
git add la-musa-orders/account.js && git commit -m "feat(uxpolish): Cambiar new-address resets stale pin + reveals/resizes map (fresh pin required)"
```

---

## Task 4: Real Static Maps thumbnail on the saved-address card (fail-closed)

**Files:** Modify `la-musa-orders/account.js` — `deliverCardHtml()` (~L989) + a key getter + the load logic.

- [ ] **Step 1: Add a per-form Maps key getter (read from the page, cached)**
```js
  let _mapsKeyCache;
  function mapsApiKey() {
    if (_mapsKeyCache !== undefined) return _mapsKeyCache;
    _mapsKeyCache = null;
    try {
      const s = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
      if (s) { const m = s.src.match(/[?&]key=([^&]+)/); if (m) _mapsKeyCache = decodeURIComponent(m[1]); }
    } catch (_) {}
    return _mapsKeyCache;
  }
```

- [ ] **Step 2: Replace the fake `.acct-map` block in `deliverCardHtml`** — render the card in NO-MAP layout by default; the map container starts hidden. Give it a unique id per render so the loader can target it.
```js
  // was: <div class="acct-map">…fake road-lines + .acct-pin…</div>
  // now: a hidden container the loader reveals only on a successful, timely image load (codex F2)
  //   (place a unique id; deliverCardHtml is called for s1-legacy + s2 mounts)
  const _mid = 'acct-cardmap-' + Math.random().toString(36).slice(2,8);   // NOTE: Math.random is fine in the BROWSER (not the workflow sandbox)
  // header slot:
  `<div class="acct-cardmap" id="${_mid}" style="display:none"></div>`
```
Keep the rest of the card (`.acct-drow`, `.acct-addr`, etc.) unchanged. Add CSS for `.acct-cardmap{height:84px;overflow:hidden;border-bottom:1px solid #EDE5D9}` and `.acct-cardmap img{width:100%;height:84px;object-fit:cover;display:block}` in `injectDeliverStyles`. Remove/retire the now-unused `.acct-map`/`.acct-mh*`/`.acct-mv*`/`.acct-blk`/`.acct-pin`/`.acct-pindot` rules IF nothing else references them (grep first — the account fullscreen twin may reuse `.acct-pin`; if so leave those and only drop the `.acct-map` fake-map rules).

- [ ] **Step 3: After the card HTML is inserted, kick the fail-closed loader** — in BOTH callers (`renderConfirmCard` and `renderS2RichSummary`), after `mount.innerHTML = …`, call `loadCardMap(_mid, addr)`. Simplest: have `deliverCardHtml` return the id, or recompute the selector. Add:
```js
  function loadCardMap(containerId, addr) {
    const el = document.getElementById(containerId); if (!el) return;
    const key = mapsApiKey();
    const la = Number(addr && addr.lat), ln = Number(addr && addr.lng);
    if (!key || !isFinite(la) || !isFinite(ln)) return;   // no key / bad coords → stay no-map (clean)
    const w = Math.max(320, Math.round((el.clientWidth || 320)));
    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${la},${ln}&zoom=16&size=${w}x84&scale=2`
      + `&markers=color:0x1E1B18%7C${la},${ln}&key=${encodeURIComponent(key)}`;
    let done = false;
    const img = new Image();
    const timer = setTimeout(() => { if (!done) { done = true; img.onload = img.onerror = null; } }, 4000);   // hang → stay hidden
    img.onload = () => { if (done) return; done = true; clearTimeout(timer); el.appendChild(img); el.style.display = ''; };
    img.onerror = () => { if (done) return; done = true; clearTimeout(timer); /* stay hidden — clean card */ };
    img.alt = '';
    img.src = url;
  }
```

- [ ] **Step 4: Reason-check fail-closed** — default is no-map (container `display:none`, empty). The strip appears ONLY when the image loads within 4s. 403 (key/API) → `onerror` → stays hidden. Offline/timeout/hang → timer fires → stays hidden. No broken-image, no empty strip, no layout gap. Key is read per-form (X.Pizza uses its own). Bad/missing coords → no URL emitted.

- [ ] **Step 5: Commit**
```bash
git add la-musa-orders/account.js && git commit -m "feat(uxpolish): real Static Maps thumbnail on saved-address card (fail-closed, black marker, per-form key)"
```

---

## Task 5: Chip size (logged-in only) + s1 "Entregar a" alignment

**Files:** Modify `la-musa-orders/account.js` — chip CSS (~L54–56) + card/eyebrow CSS (~L776/794).

- [ ] **Step 1: Chip — logged-in-only bump (codex F3).** In `injectChipStyles`, ADD logged-in-scoped overrides WITHOUT changing the base `.acct-chip .acct-nm`/`.acct-av` (which the guest `.acct-chip--out` also uses). First CONFIRM the guest chip class by grepping `renderChip` for the guest/logged-out variant (expected `.acct-chip--out`). Then add:
```css
.acct-chip:not(.acct-chip--out) .acct-nm{font-size:15px}
.acct-chip:not(.acct-chip--out) .acct-av{width:31px;height:31px}
```
Verify the guest "Entrar" chip (`.acct-chip--out`) renders byte-identical (13.5px name / 28px avatar) after the change.

- [ ] **Step 2: Alignment.** Compact line `.acct-compact` — set `align-items:center` so the avatar centers against the single line of text. Full card `.acct-drow` — keep `align-items:flex-start` but verify the eyebrow (`.acct-eyebrow`) left inset matches the card content inset (both should share the mount's padding; if the eyebrow sits flush-left while the card is inset, add matching left padding to the eyebrow or wrap). Purely CSS.

- [ ] **Step 3: Reason-check** — guest chip unchanged (`:not(.acct-chip--out)` excludes it); logged-in name reads larger; s1 card avatar vertically centered; no overlap with the brand mark at 360/390/414px.

- [ ] **Step 4: Commit**
```bash
git add la-musa-orders/account.js && git commit -m "feat(uxpolish): logged-in-only chip size bump + s1 Entregar-a alignment"
```

---

## Task 6: Guest byte-identical verification (the hard gate)

**Files:** none (verification).

- [ ] **Step 1: Serve + guest load** (`export PATH="/Users/xavierlacayo/.npm-global/bin:$PATH"`):
```bash
cd la-musa-orders && python3 -m http.server 8893 >/dev/null 2>&1 &
agent-browser --allow-file-access batch "open http://localhost:8893/" "wait 1500" "screenshot"
agent-browser network requests --status 2xx | grep -iE "firebase|gstatic|firebaseio" && echo "SDK LEAK" || echo "clean guest load"
```
- [ ] **Step 2: Confirm** on guest load: no Firebase SDK, the guest "Entrar" chip is unchanged (13.5px/28px), the guest 3-step flow + editable s2 map all present (nothing hidden for guests), no `staticmap` request fired (guest has no saved-address card). File parses (`node --check account.js`).

- [ ] **Step 3: Commit** (if any doc/notes) — else proceed.

---

## Task 7: Mirror to `xpizza-orders/account.js`

**Files:** Modify `xpizza-orders/account.js`.

- [ ] **Step 1: Confirm parity BEFORE** — `node -e` compare of the two files past the CONFIG boundary (identical today).
- [ ] **Step 2: Port every Task 1–5 change** below the CONFIG block. The Static Maps key is read per-form (no hardcode) so this ports verbatim; the black marker color is literal `0x1E1B18` (brand-neutral, matches both forms' main map). Re-run the parity compare — ONLY the CONFIG block may differ.
- [ ] **Step 3: Guest-safety check on xpizza-orders** (port 8894), same as Task 6.
- [ ] **Step 4: Commit**
```bash
git add xpizza-orders/account.js && git commit -m "feat(uxpolish): X. Pizza parity (byte-identical past CONFIG)"
```

---

## Task 8: Self-review + push for codex-on-diff

- [ ] **Step 1: Isolation/parity greps** — no unexpected writes to checkout globals except Task 3's explicit new-address reset; `git diff --stat 2b56d21..HEAD -- '*index.html'` empty (no structural index.html change); both account.js identical past CONFIG.
- [ ] **Step 2: Push + report SHA** (no deploy/merge):
```bash
git push -u origin feat/loggedin-delivery-polish && git rev-parse --short HEAD
```

---

## Self-Review (author, pre-handoff)
- **Spec coverage:** helper (T1) + hide/restore wiring (T2) + Cambiar fresh-pin (T3) + thumbnail (T4) + chip/alignment (T5) + guest gate (T6) + mirror (T7). All 5 changes + all 5 codex findings covered.
- **Watch:** the `.acct-pin` CSS may be shared with the account fullscreen twin — grep before deleting fake-map rules (T4 S2). The two `hideRawAndAddrSection()` call sites (refreshDeliveryUI + initDeliveryStep) must BOTH get the helper (T2 S1).
- **Placeholder scan:** none — every step has concrete code/commands.
