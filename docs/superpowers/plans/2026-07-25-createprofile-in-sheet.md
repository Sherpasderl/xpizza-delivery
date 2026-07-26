# Creá tu perfil in the login sheet + account-scoped fullscreen map twin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After OTP verify, an incomplete-profile customer lands on a full "Creá tu perfil" screen INSIDE the login sheet (name + address), using an account-scoped twin of the checkout fullscreen center-pin map — so their next order is cart → pay. Guest byte-identical; the account map never writes the checkout's live delivery pin.

**Architecture:** All logic lives in `account.js` (the marker-gated, lazily-loaded account layer). `index.html` is NOT edited at all — the fullscreen map overlay DOM + styles are injected from `account.js` on demand. `la-musa-orders/account.js` is the source of truth; `xpizza-orders/account.js` is byte-identical past the 16-line CONFIG block and is mirrored in the final task.

**Tech Stack:** Vanilla ES module-ish classic script (`window.__ACCOUNT`), Firebase RTDB (`dbMod.update`/`get`), Google Maps JS API (already loaded by the host page), the existing `saveAddress`/`profileComplete`/`accountSnapshot` layer.

**Spec:** `docs/superpowers/specs/2026-07-25-createprofile-in-sheet-design.md` (codex design-gate APPROVED R2). Read it first — this plan implements it; the spec's Gate-focus points are the acceptance bar for the codex-on-diff.

---

## Ground rules (apply to EVERY task)

- **Edit `la-musa-orders/account.js` only** during Tasks 1–8; mirror to `xpizza-orders/account.js` in Task 9. The two files differ ONLY in the top `const CONFIG = {…}` block (~lines 5–20: `brand`, `accent`, `VERIFY_URL`, `MARKER`, `fb`). Every change below is BELOW that block and must land identically in both.
- **Do NOT edit either `index.html`.** No new map DOM, no new globals, no guest-visible markup. If you think you need an index.html edit, stop — the design forbids it (guest byte-identical).
- **Isolation firewall (hard):** nothing you add may read-then-write or assign the checkout globals `lat`, `lng`, `gmap`, `gmarker`, `fsMap`, `__restorePos`, or call `openFullscreenMap` / `closeFullscreenMap` / `setFullscreenMapType` / `reverseGeocodeFS`, or touch `#map-fullscreen*` / `#fs-*` ids. The account map writes ONLY `_nadLat` / `_nadLng` / `_nadDetected` / `_nadPinTouched`. Reading `lat`/`lng` ONCE as a center hint is the only permitted contact (read-only).
- **No cheap emoji** — reuse the existing `ICON_*` constants (`ICON_HOUSE`, `ICON_WORK`, `ICON_TAG`, `ICON_CHECK_BIG`, the person/check SVGs already in the file).
- **Verification is manual** (no unit harness for the order form): each task ends with an `agent-browser` and/or reasoning check. Full live flows need a real OTP (Xavier, on-device) — those are called out as owner checks, not executor gates.

---

## File Structure

- **Modify:** `la-musa-orders/account.js` — all new functions + the `verifyCode()` routing change (Tasks 1–8).
- **Modify:** `xpizza-orders/account.js` — byte-identical mirror past CONFIG (Task 9).
- **Unchanged:** both `index.html`, `database.rules.json`, all functions. No rules change (name via `update`, addresses via existing `saveAddress`).

New symbols added to `account.js` (all `function`/`let` inside the IIFE, none on `window`):
- `accountSnapshotStatus()` — tri-state read.
- `_acctFsMap`, `_acctFsMarkerless` state; `_acctFsEpoch`; `ensureAcctFsOverlay()`, `injectAcctFsStyles()`, `openAcctFullscreenMap(previewId)`, `closeAcctFullscreenMap(commit)`, `setAcctFsMapType(type)`, `reverseGeocodeAcctFs(la,ln,epoch)`, `renderAcctMapPreview(containerId)`, `initAcctPreviewMap(containerId)`.
- `renderCreateProfilePane()`, `wireCreateProfilePane()`, `validateCreateProfile()`, `refreshCreateProfileCta()`, `saveCreateProfile()`; pane `#acct-pane-createprofile`; state `_acctCP*` as needed.

---

## Task 1: Tri-state snapshot reader (`accountSnapshotStatus`)

**Files:**
- Modify: `la-musa-orders/account.js` — add immediately AFTER `accountSnapshot()` (~L607).

The existing `accountSnapshot()` returns `null` for BOTH "resolved: no account" and "timed out / errored" (codex R1 #1). The create-flow routing must distinguish them. Add a sibling that returns a status.

- [ ] **Step 1: Add `accountSnapshotStatus()`**

```js
  // Tri-state variant of accountSnapshot() (codex R1 #1): distinguishes a RESOLVED read
  // (status:'ok', snap may be null/partial = a real profile state) from an UNAVAILABLE read
  // (timeout / SDK error / dead session). Callers that must NOT misclassify a slow read as
  // "incomplete profile" use this; the plain accountSnapshot() (fail-open-to-null) stays for
  // the checkout autofill path. Guest fast-path preserved: no marker → resolved ok/null instantly.
  async function accountSnapshotStatus() {
    if (!marker()) return { status: 'ok', snap: null };            // guest — resolved, no account
    const TIMEOUT = Symbol('timeout');
    try {
      const out = await Promise.race([
        (async () => {
          const { auth, db, dbMod } = await ensureFirebase();
          await auth.authStateReady();
          if (!auth.currentUser) { heal(); return null; }
          const snap = await dbMod.get(dbMod.ref(db, 'user_profiles/' + auth.currentUser.uid));
          return snap.exists() ? snap.val() : null;
        })(),
        new Promise((r) => setTimeout(() => r(TIMEOUT), 1500)),
      ]);
      if (out === TIMEOUT) return { status: 'unavailable' };
      return { status: 'ok', snap: out };
    } catch (_) {
      return { status: 'unavailable' };
    }
  }
```

- [ ] **Step 2: Sanity check** — reasoning only: confirm a guest (no marker) resolves `{status:'ok',snap:null}` with zero SDK load (fast-path parity with `accountSnapshot`), a completed read returns `{status:'ok',snap:<val|null>}`, and both timeout and thrown error return `{status:'unavailable'}`. No `agent-browser` needed.

- [ ] **Step 3: Commit**

```bash
git add la-musa-orders/account.js
git commit -m "feat(createprofile): tri-state accountSnapshotStatus (resolved vs unavailable)"
```

---

## Task 2: Account-scoped fullscreen map twin — styles + lazy overlay scaffold

**Files:**
- Modify: `la-musa-orders/account.js` — add near the other `inject*Styles` helpers (`injectNewAddrStyles` ~L1280).

Port the checkout fullscreen map's LOOK (index.html `.map-fullscreen-overlay` CSS ~L813–855 and the overlay markup ~L4090–4112) into account-scoped, lazily-injected equivalents. The overlay is created ONCE, on first open, appended to `document.body`, with account-only ids.

- [ ] **Step 1: Add `injectAcctFsStyles()`** (idempotent, mirrors `injectNewAddrStyles`)

```js
  let _acctFsStylesDone = false;
  function injectAcctFsStyles() {
    if (_acctFsStylesDone) return; _acctFsStylesDone = true;
    const st = document.createElement('style');
    st.textContent = `
.acct-fs-overlay{position:fixed;inset:0;z-index:1200;display:none;flex-direction:column;background:#E4DAC7}
.acct-fs-overlay.open{display:flex}
.acct-fs-map{flex:1;width:100%}
.acct-fs-toggle{position:absolute;top:14px;right:14px;display:flex;gap:6px;z-index:4}
.acct-fs-toggle button{padding:7px 12px;font-size:12px;font-weight:700;border:none;border-radius:8px;font-family:inherit;cursor:pointer;box-shadow:0 2px 7px -2px rgba(40,28,12,.35)}
.acct-fs-bar{background:#fff;padding:13px 16px calc(13px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:12px;border-top:1px solid #EDE5D9}
.acct-fs-bar .a{flex:1;min-width:0}
.acct-fs-bar .a .l{font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#B3A594}
.acct-fs-bar .a b{display:block;font-size:14px;font-weight:600;color:#17130F;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acct-fs-done{flex:none;background:#17130F;color:#fff;border:none;border-radius:12px;padding:13px 20px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.acct-fs-pin{position:absolute;left:calc(50% - 15px);top:calc(50% - 36px);width:30px;height:30px;z-index:3;pointer-events:none;filter:drop-shadow(0 8px 7px rgba(40,28,12,.34))}
.acct-fs-pindot{position:absolute;left:calc(50% - 6px);top:calc(50% - 4px);width:12px;height:6px;border-radius:50%;background:rgba(40,28,12,.28);filter:blur(1.5px);z-index:2;pointer-events:none}
.acct-map-preview{height:150px;border-radius:15px;overflow:hidden;border:1px solid #E2D8C8;position:relative;cursor:pointer;background:#E4DAC7}
.acct-map-preview .pv{position:absolute;inset:0;pointer-events:none}
.acct-map-preview .hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.acct-map-preview .hint span{background:rgba(24,18,12,.6);color:#fff;font-size:12.5px;font-weight:650;padding:8px 15px;border-radius:20px;backdrop-filter:blur(2px)}`;
    document.head.appendChild(st);
  }
```

- [ ] **Step 2: Add `ensureAcctFsOverlay()`** — builds the overlay DOM once, appends to body, wires the toggle + Listo. The centered pin is a CSS-fixed SVG (accent-colored) over the map; the map is dragged under it.

```js
  let _acctFsBuilt = false;
  function ensureAcctFsOverlay() {
    injectAcctFsStyles();
    if (_acctFsBuilt) return;
    const ov = document.createElement('div');
    ov.className = 'acct-fs-overlay'; ov.id = 'acct-fs-overlay';
    ov.innerHTML = `
<div class="acct-fs-map" id="acct-fs-map"></div>
<div class="acct-fs-toggle">
  <button type="button" id="acct-fs-road">Mapa</button>
  <button type="button" id="acct-fs-sat">Satélite</button>
</div>
<div class="acct-fs-pindot"></div>
<svg class="acct-fs-pin" viewBox="0 0 24 24" fill="${CONFIG.accent}" stroke="#fff" stroke-width="1.4"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/><circle cx="12" cy="9" r="2.6" fill="#fff" stroke="none"/></svg>
<div class="acct-fs-bar">
  <div class="a"><div class="l">Tu ubicación</div><b id="acct-fs-addr">Detectando…</b></div>
  <button type="button" class="acct-fs-done" id="acct-fs-done">${ICON_CHECK_BIG} Listo</button>
</div>`;
    document.body.appendChild(ov);
    ov.querySelector('#acct-fs-road').onclick = () => setAcctFsMapType('roadmap');
    ov.querySelector('#acct-fs-sat').onclick = () => setAcctFsMapType('satellite');
    ov.querySelector('#acct-fs-done').onclick = () => closeAcctFullscreenMap(true);
    _acctFsBuilt = true;
  }

  function setAcctFsMapType(type) {
    if (_acctFsMap) _acctFsMap.setMapTypeId(type);
    const road = document.getElementById('acct-fs-road'), sat = document.getElementById('acct-fs-sat');
    if (road) { road.style.background = type === 'roadmap' ? '#17130F' : '#fff'; road.style.color = type === 'roadmap' ? '#fff' : '#333'; }
    if (sat)  { sat.style.background  = type === 'satellite' ? '#17130F' : '#fff'; sat.style.color  = type === 'satellite' ? '#fff' : '#333'; }
  }
```

- [ ] **Step 3: Reason-check** — the overlay is created lazily (first open), lives on `document.body` (above the sheet at z-1200), uses only `#acct-fs-*` ids (no `#fs-*` collision), and the pin is a static centered SVG (center-pin paradigm). No map instance yet (Task 3). Confirm no `index.html` edit was made.

- [ ] **Step 4: Commit**

```bash
git add la-musa-orders/account.js
git commit -m "feat(createprofile): account-scoped fullscreen map overlay scaffold (lazy, isolated ids)"
```

---

## Task 3: The account map logic (center-pin, isolation, epoch-guarded)

**Files:**
- Modify: `la-musa-orders/account.js` — add after Task 2's functions.

State + open/close/geocode. The map commits to `_nadLat/_nadLng/_nadDetected` ONLY; `_nadPinTouched` flips ONLY on a genuine user drag. A monotonic `_acctFsEpoch` invalidates late geocode callbacks after teardown (codex R1 #5).

- [ ] **Step 1: Declare state** (near the existing `_nad*` declarations)

```js
  let _acctFsMap = null;            // the fullscreen google.maps.Map (account-scoped twin of checkout fsMap)
  let _acctFsGeocoder = null;
  let _acctFsEpoch = 0;             // bumped on every open; late async callbacks compare against it
  let _acctFsPreviewId = null;      // which preview to refresh on Listo
```

- [ ] **Step 2: `openAcctFullscreenMap(previewId)`** — blow out to fullscreen, center on the current `_nad*` (or checkout `lat/lng` hint, read-only, or restaurant fallback). Commit lat/lng on user drag only.

```js
  function openAcctFullscreenMap(previewId) {
    ensureAcctFsOverlay();
    if (!window.google || !window.google.maps) { setTimeout(() => openAcctFullscreenMap(previewId), 250); return; }
    _acctFsPreviewId = previewId || null;
    const ov = document.getElementById('acct-fs-overlay');
    ov.classList.add('open');
    // suppress background scroll; remember prior value so close restores it (sheet may still need lock)
    _acctFsPrevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const epoch = ++_acctFsEpoch;

    // starting center: current account pin → else checkout lat/lng (READ-ONLY hint) → else restaurant
    let start = null;
    if (typeof _nadLat === 'number' && typeof _nadLng === 'number') start = { lat: _nadLat, lng: _nadLng };
    if (!start) { try { if (typeof lat === 'number' && typeof lng === 'number') start = { lat, lng }; } catch (_) {} }
    if (!start) { let f = { lat: 15.5003, lng: -88.025 }; try { if (typeof RESTAURANT_LAT === 'number' && typeof RESTAURANT_LNG === 'number') f = { lat: RESTAURANT_LAT, lng: RESTAURANT_LNG }; } catch (_) {} start = f; }

    const el = document.getElementById('acct-fs-map');
    if (!_acctFsMap) {
      _acctFsMap = new google.maps.Map(el, { center: start, zoom: 17, mapTypeId: 'roadmap', disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy' });
      setAcctFsMapType('roadmap');
      // center-pin: reverse-geocode on any center change (display only) …
      _acctFsMap.addListener('center_changed', () => {
        const c = _acctFsMap.getCenter(); reverseGeocodeAcctFs(c.lat(), c.lng(), _acctFsEpoch);
      });
      // … but only a USER drag commits lat/lng + marks the pin as user-placed (codex R1 #3)
      _acctFsMap.addListener('dragend', () => {
        const c = _acctFsMap.getCenter();
        _nadLat = c.lat(); _nadLng = c.lng(); _nadPinTouched = true;
        reverseGeocodeAcctFs(_nadLat, _nadLng, _acctFsEpoch);
      });
    } else {
      _acctFsMap.setCenter(start);
    }
    reverseGeocodeAcctFs(start.lat, start.lng, epoch);
    // If we have no user pin yet, offer geolocation as a starting VIEW (never marks touched)
    if (!_nadPinTouched && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => { if (_acctFsEpoch === epoch && _acctFsMap) _acctFsMap.setCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
        () => {}, { timeout: 8000, enableHighAccuracy: true, maximumAge: 0 }
      );
    }
  }
```
(Add `let _acctFsPrevOverflow = '';` with the other state declarations.)

- [ ] **Step 3: `reverseGeocodeAcctFs(la, ln, epoch)`** — epoch-guarded; ignores stale callbacks.

```js
  function reverseGeocodeAcctFs(la, ln, epoch) {
    if (!window.google || !window.google.maps) return;
    if (!_acctFsGeocoder) _acctFsGeocoder = new google.maps.Geocoder();
    _acctFsGeocoder.geocode({ location: { lat: la, lng: ln } }, (results, status) => {
      if (epoch !== _acctFsEpoch) return;                         // stale — pane/map torn down; ignore (codex R1 #5)
      const detected = (status === 'OK' && results[0]) ? results[0].formatted_address
                     : ('Lat: ' + la.toFixed(5) + ', Lng: ' + ln.toFixed(5));
      _nadDetected = detected;
      const addrEl = document.getElementById('acct-fs-addr'); if (addrEl) addrEl.textContent = detected;
    });
  }
```

- [ ] **Step 4: `closeAcctFullscreenMap(commit)`** — hide overlay, restore scroll, refresh the pane preview. On `commit`, the current `_nad*` already holds the chosen point (set by drag / center). Does NOT touch checkout globals.

```js
  function closeAcctFullscreenMap(commit) {
    const ov = document.getElementById('acct-fs-overlay'); if (ov) ov.classList.remove('open');
    document.body.style.overflow = _acctFsPrevOverflow || '';
    // If the user never dragged but did move the map to a place and tapped Listo, treat the
    // resting center as their placement (matches checkout's "close commits center").
    if (commit && _acctFsMap) {
      const c = _acctFsMap.getCenter();
      _nadLat = c.lat(); _nadLng = c.lng(); _nadPinTouched = true;
    }
    if (_acctFsPreviewId) renderAcctMapPreview(_acctFsPreviewId);   // reflect the chosen pin + address
  }
```
NOTE: `closeAcctFullscreenMap(false)` (an abort path, if ever wired to a back button) restores scroll WITHOUT committing. The Listo button calls `(true)`.

- [ ] **Step 5: `renderAcctMapPreview(containerId)` + `initAcctPreviewMap`** — the small tappable preview inside a pane. A lightweight live map (pointer-events:none), pin overlay, "Toca para ajustar" hint; the wrapper's click opens fullscreen. Reflects `_nad*` when set.

```js
  function renderAcctMapPreview(containerId) {
    const host = document.getElementById(containerId); if (!host) return;
    host.className = 'acct-map-preview';
    const placed = (typeof _nadLat === 'number' && typeof _nadLng === 'number');
    host.innerHTML = `<div class="pv" id="${containerId}-pv"></div>
<svg class="acct-fs-pin" style="filter:drop-shadow(0 6px 5px rgba(40,28,12,.3))" viewBox="0 0 24 24" fill="${CONFIG.accent}" stroke="#fff" stroke-width="1.4"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/><circle cx="12" cy="9" r="2.6" fill="#fff" stroke="none"/></svg>
<div class="acct-fs-pindot"></div>
<div class="hint"><span>${placed ? 'Toca para ajustar' : 'Toca para marcar tu ubicación'}</span></div>`;
    host.onclick = () => openAcctFullscreenMap(containerId);
    initAcctPreviewMap(containerId);
  }

  function initAcctPreviewMap(containerId) {
    if (!window.google || !window.google.maps) { setTimeout(() => initAcctPreviewMap(containerId), 300); return; }
    const el = document.getElementById(containerId + '-pv'); if (!el) return;
    let c = null;
    if (typeof _nadLat === 'number' && typeof _nadLng === 'number') c = { lat: _nadLat, lng: _nadLng };
    if (!c) { try { if (typeof lat === 'number' && typeof lng === 'number') c = { lat, lng }; } catch (_) {} }
    if (!c) { c = { lat: 15.5003, lng: -88.025 }; try { if (typeof RESTAURANT_LAT === 'number' && typeof RESTAURANT_LNG === 'number') c = { lat: RESTAURANT_LAT, lng: RESTAURANT_LNG }; } catch (_) {} }
    const pv = new google.maps.Map(el, { center: c, zoom: 16, disableDefaultUI: true, gestureHandling: 'none', keyboardShortcuts: false, clickableIcons: false });
    // preview is display-only; the tappable wrapper opens fullscreen
  }
```

- [ ] **Step 6: Isolation audit (reason-check, REQUIRED before commit)** — grep your additions: no assignment to `lat`/`lng`/`gmap`/`gmarker`/`fsMap`/`__restorePos`; no call to `openFullscreenMap`/`closeFullscreenMap`/`reverseGeocodeFS`/`setFullscreenMapType`; no `#fs-`/`#map-fullscreen` id. The ONLY read of checkout `lat`/`lng` is the center hint (guarded try/typeof, never written back). Confirm.

- [ ] **Step 7: Commit**

```bash
git add la-musa-orders/account.js
git commit -m "feat(createprofile): account map — center-pin, user-only touch, epoch-guarded geocode, isolated sink"
```

---

## Task 4: Point "+ Agregar" at the new map twin (replace inline `_nad*` marker map)

**Files:**
- Modify: `la-musa-orders/account.js` — `renderNewAddressPane()` (~L1306) and remove/retire `initNewAddrMap`/`placeNewAddrPin` usage.

The existing Nueva-dirección pane uses the inline draggable-marker map (`initNewAddrMap`). Swap its map block for the preview+fullscreen twin. The `_nad*` validation in `saveNewAddressFromPane()` is UNCHANGED (it already reads `_nadLat/_nadLng/_nadDetected/_nadPinTouched`).

- [ ] **Step 1: In `renderNewAddressPane()`**, replace the `<div id="acct-nad-map" class="acct-nad-map"></div>` + `<p class="acct-nad-hint">…</p>` block with a preview host:

```html
<div class="acct-eyebrow">Ubicación en el mapa</div>
<div id="acct-nad-preview"></div>
```
and replace the `initNewAddrMap();` call at the end of the function with:
```js
    showPane('newaddr');
    renderAcctMapPreview('acct-nad-preview');
```
Delete the now-unused `initNewAddrMap` and `placeNewAddrPin` functions (and the `_nadMap`/`_nadMarker` declarations) — the twin replaces them. Keep `_nadLat/_nadLng/_nadDetected/_nadPinTouched` (still the sink) and `_nadGeocoder` may be removed if unreferenced.

- [ ] **Step 2: In `closeNewAddressPane()`** (~L1410), keep the `_nad*` reset; ALSO bump the epoch so any in-flight preview/fullscreen geocode is invalidated:

```js
  function closeNewAddressPane() {
    _acctFsEpoch++;                    // invalidate any late geocode from this pane's map
    _nadLat = null; _nadLng = null; _nadDetected = ''; _nadPinTouched = false;
    showPane('account');
  }
```
(Drop the old `_nadMarker.setMap(null)` / `_nadMap = null` lines — those instances no longer exist.)

- [ ] **Step 3: `agent-browser` check** — open the account sheet on the deployed-locally file isn't possible offline, so reason-verify: "+ Agregar" now renders `#acct-nad-preview`, tapping it opens `#acct-fs-overlay`, dragging commits `_nad*`, Listo returns to the pane showing the pin, and `saveNewAddressFromPane`'s existing guards (touched, numeric lat/lng, details≥3, label) still gate the save. The mid-checkout case (a live order `lat/lng` exists) reads it only as a center hint.

- [ ] **Step 4: Commit**

```bash
git add la-musa-orders/account.js
git commit -m "feat(createprofile): + Agregar uses the fullscreen map twin (retire inline marker map)"
```

---

## Task 5: The "Creá tu perfil" pane (`renderCreateProfilePane`)

**Files:**
- Modify: `la-musa-orders/account.js` — add a new pane section to the overlay template (near `#acct-pane-newaddr`, ~L208) and a render function.

- [ ] **Step 1: Add the empty pane** to the overlay HTML in `buildOverlay()` (alongside `acct-pane-newaddr`):

```html
    <section class="acct-pane" id="acct-pane-createprofile">
      <!-- built by renderCreateProfilePane() -->
    </section>
```

- [ ] **Step 2: Add `renderCreateProfilePane(prefillName)`** — phone-verified row + Nombre/Apellido + map preview + referencia + label chips + disabled CTA. Reuses `injectDeliverStyles`/`injectNewAddrStyles` for shared classes. Phone comes from `_loginPhone` or `marker().phone`.

```js
  function renderCreateProfilePane(prefillName) {
    injectDeliverStyles(); injectNewAddrStyles(); injectAcctFsStyles();
    const pane = $('acct-pane-createprofile'); if (!pane) return;
    _nadLat = null; _nadLng = null; _nadDetected = ''; _nadPinTouched = false;   // fresh address entry
    const phone = (_loginPhone || (marker() && marker().phone) || '').toString();
    const nm = String(prefillName || '').trim();
    const parts = nm.split(/\s+/).filter(Boolean);
    const firstV = parts.length ? parts[0] : '';
    const lastV = parts.length > 1 ? parts.slice(1).join(' ') : '';
    pane.innerHTML = `
<h1 class="acct-h1">Creá tu perfil</h1>
<p class="acct-sub">Guardá tu nombre y dirección — la próxima vez pedís en dos toques.</p>
<div class="acct-mlabel">Teléfono <span style="color:#B3A594;font-weight:600">· ya verificado</span></div>
<div class="acct-verified-ro"><span class="v">+504 ${phone}</span><span class="ok">${ICON_CHECK_SMALL} WhatsApp</span></div>
<div class="acct-mlabel" style="margin-top:16px">Nombre y apellido</div>
<div class="acct-two">
  <input type="text" id="acct-cp-first" class="acct-inp" placeholder="Nombre" maxlength="40" value="${escapeAttr(firstV)}">
  <input type="text" id="acct-cp-last" class="acct-inp" placeholder="Apellido" maxlength="40" value="${escapeAttr(lastV)}">
</div>
<div class="acct-mlabel" style="margin-top:16px">¿A dónde te lo llevamos?</div>
<div id="acct-cp-preview"></div>
<textarea id="acct-cp-details" class="acct-nad-textarea" rows="2" placeholder="Referencia: portón, color, piso…" maxlength="200" style="margin-top:9px"></textarea>
<div class="acct-mlabel">Guardar como</div>
<div class="acct-lchips" id="acct-cp-lchips">
  <button type="button" class="acct-lchip acct-on" data-label="Casa">${ICON_HOUSE}Casa</button>
  <button type="button" class="acct-lchip" data-label="Trabajo">${ICON_WORK}Trabajo</button>
  <button type="button" class="acct-lchip" data-label="">${ICON_TAG}Otra</button>
</div>
<input type="text" id="acct-cp-label" class="acct-label-custom-inp" placeholder="Ponle un nombre…" maxlength="40" style="margin-top:10px;display:none"/>
<p class="acct-field-hint" id="acct-cp-err" style="display:none;color:#B23B3B"></p>
<button type="button" class="acct-cta" id="acct-cp-save" disabled>Guardar perfil</button>`;
    // default label = Casa (a valid preset chosen)
    _acctCpLabel = 'Casa';
    showPane('createprofile');
    wireCreateProfilePane();
    renderAcctMapPreview('acct-cp-preview');
    refreshCreateProfileCta();
  }
```
Add small helpers if not already present: `escapeAttr(s)` (HTML-attr-escape for the name prefill — reuse the file's existing escape if one exists, else add `function escapeAttr(s){return String(s).replace(/[&"<>]/g,c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c]));}`), and reuse an existing `ICON_CHECK_SMALL` (or the small check SVG already used in the OTP "verificado" contexts; if none, inline the same 14px check used in the mockup). Add CSS for `.acct-verified-ro` / `.acct-two` in `injectNewAddrStyles` (mirror the mockup's `.ro`/`.two`).

- [ ] **Step 3: `wireCreateProfilePane()`** — label chips (Otra reveals custom input), live CTA refresh on every input, Save handler.

```js
  let _acctCpLabel = 'Casa';
  function wireCreateProfilePane() {
    const chips = $('acct-cp-lchips');
    if (chips) chips.querySelectorAll('.acct-lchip').forEach((chip) => {
      chip.onclick = () => {
        chips.querySelectorAll('.acct-lchip').forEach((c) => c.classList.remove('acct-on'));
        chip.classList.add('acct-on');
        const custom = $('acct-cp-label'); const val = chip.getAttribute('data-label');
        if (val) { _acctCpLabel = val; if (custom) custom.style.display = 'none'; }
        else { if (custom) { custom.style.display = ''; custom.value = ''; custom.focus(); } _acctCpLabel = ''; }
        refreshCreateProfileCta();
      };
    });
    ['acct-cp-first','acct-cp-last','acct-cp-details','acct-cp-label'].forEach((id) => {
      const el = $(id); if (el) el.addEventListener('input', () => { if (id === 'acct-cp-label') _acctCpLabel = el.value.trim(); refreshCreateProfileCta(); });
    });
    const save = $('acct-cp-save'); if (save) save.onclick = saveCreateProfile;
  }
```

- [ ] **Step 4: Commit**

```bash
git add la-musa-orders/account.js
git commit -m "feat(createprofile): Creá tu perfil pane (name + verified phone + map preview + label)"
```

---

## Task 6: No-skip validation + live CTA gating

**Files:**
- Modify: `la-musa-orders/account.js` — add `validateCreateProfile()` + `refreshCreateProfileCta()`.

- [ ] **Step 1: Add the shared validator** (used by both the CTA-enable and the submit-time re-check, codex R1 #3):

```js
  // Returns {ok:true} or {ok:false, msg, focus}. Pure read of the pane — no side effects.
  function validateCreateProfile() {
    const first = (($('acct-cp-first') || {}).value || '').trim();
    const last  = (($('acct-cp-last')  || {}).value || '').trim();
    const details = (($('acct-cp-details') || {}).value || '').trim();
    const label = _acctCpLabel;
    if (!first) return { ok: false, msg: 'Agregá tu nombre.', focus: 'acct-cp-first' };
    if (!last)  return { ok: false, msg: 'Agregá tu apellido.', focus: 'acct-cp-last' };
    if (typeof _nadLat !== 'number' || typeof _nadLng !== 'number' || !isFinite(_nadLat) || !isFinite(_nadLng) || !_nadDetected || !_nadPinTouched)
      return { ok: false, msg: 'Marcá tu ubicación en el mapa (tocá el mapa y ajustá el pin).' };
    if (details.length < 3) return { ok: false, msg: 'Agregá una referencia — portón, color, piso…', focus: 'acct-cp-details' };
    if (!label) return { ok: false, msg: 'Elegí cómo guardar la dirección.', focus: 'acct-cp-label' };
    return { ok: true, first, last, details, label };
  }

  function refreshCreateProfileCta() {
    const btn = $('acct-cp-save'); if (!btn) return;
    btn.disabled = !validateCreateProfile().ok;
  }
```

- [ ] **Step 2: Wire the preview→CTA refresh** — after `closeAcctFullscreenMap` refreshes the preview, also refresh the CTA if the create pane is active. Simplest: at the end of `closeAcctFullscreenMap`, add `if ($('acct-pane-createprofile') && $('acct-pane-createprofile').classList.contains('acct-on')) refreshCreateProfileCta();` (and likewise a no-op for the newaddr pane which has its own save button).

- [ ] **Step 3: Reason-check** — CTA is disabled until first+last+touched-pin+details≥3+label all pass; picking a map point (Listo) re-enables it. Paste/autofill fire `input` → refresh. Enter inside a field cannot submit (the CTA is a `type=button`, no form wrapping submit).

- [ ] **Step 4: Commit**

```bash
git add la-musa-orders/account.js
git commit -m "feat(createprofile): no-skip validator + live CTA gating"
```

---

## Task 7: Save handler — throwing name write, address save, re-confirm

**Files:**
- Modify: `la-musa-orders/account.js` — add `saveCreateProfile()`.

Mirrors the checkout create's throwing-name pattern (L1637–1655) + the codex R1 #7 re-confirm.

- [ ] **Step 1: Add `saveCreateProfile()`**

```js
  async function saveCreateProfile() {
    const errEl = $('acct-cp-err'); if (errEl) errEl.style.display = 'none';
    const v = validateCreateProfile();                          // submit-time re-validate ALL (codex R1 #3)
    if (!v.ok) { if (errEl) { errEl.style.display = 'block'; errEl.textContent = v.msg; } const f = v.focus && $(v.focus); if (f) f.focus(); return; }
    const btn = $('acct-cp-save'); if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
    const fullName = (v.first + ' ' + v.last).trim().slice(0, 80);

    // 1) name — THROWING write (never saveName(), which swallows failures — codex R1 #2)
    try {
      const { auth, db, dbMod } = await ensureFirebase();
      await auth.authStateReady();
      if (!auth.currentUser) { heal(); throw new Error('no-session'); }
      await dbMod.update(dbMod.ref(db, 'user_profiles/' + auth.currentUser.uid), { name: fullName });
      const m = marker(); if (m) { m.name = fullName; try { localStorage.setItem(CONFIG.MARKER, JSON.stringify(m)); } catch (_) {} }
    } catch (_) {
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'No pudimos guardar tu nombre. Intentá de nuevo.'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar perfil'; }
      return;
    }

    // 2) address — the hardened writer (rejects empty label/details<3/empty detected/non-numeric)
    const res = await saveAddress({ label: v.label, detected: _nadDetected, details: v.details, lat: _nadLat, lng: _nadLng, makeDefault: true });
    if (!res.ok) {
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = res.message || 'No pudimos guardar la dirección. Intentá de nuevo.'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar perfil'; }
      return;
    }

    // 3) re-confirm the LIVE predicate before declaring success (codex R1 #7)
    const st = await accountSnapshotStatus();
    if (st.status === 'ok' && profileComplete(st.snap)) {
      _acctData = st.snap;
      renderChip();
      toast('Perfil creado');
      closeSheet();
      try { wrapPageHooks(); initDeliveryStep().catch(() => {}); } catch (_) {}   // reflect completeness THIS load
      return;
    }
    // writes persisted but re-read is unavailable or still-incomplete → do NOT claim success;
    // fail-open to Mi Cuenta (checkout re-enforces complete-before-pay).
    _acctData = (st.status === 'ok') ? st.snap : _acctData;
    renderAccountPane(); showPane('account');
    if (st.status === 'unavailable') toast('Guardado. Verificá tu conexión.');
  }
```

- [ ] **Step 2: Reason-check partial-writes** — name-throw → abort before address (no partial that reads complete). Address-fail after name-ok → still-incomplete (no address) → re-prompted. Success declared ONLY when a fresh `accountSnapshotStatus` confirms `profileComplete`. No false-complete path exists.

- [ ] **Step 3: Commit**

```bash
git add la-musa-orders/account.js
git commit -m "feat(createprofile): save — throwing name write + saveAddress + live re-confirm before success"
```

---

## Task 8: Post-OTP routing (tri-state) in `verifyCode()`

**Files:**
- Modify: `la-musa-orders/account.js` — the success branch of `verifyCode()` (~L425–437).

- [ ] **Step 1: Replace the `if (data.is_new || !data.name) { showPane('name') … } else { … }` block** with the tri-state completeness router:

```js
    // Completeness-routed (not is_new): confirm the LIVE profile before deciding.
    const st = await accountSnapshotStatus();
    if (st.status === 'ok' && profileComplete(st.snap)) {
      _acctData = st.snap;
      renderChip();
      closeSheet();
      try { wrapPageHooks(); initDeliveryStep().catch(() => {}); } catch (_) {}   // returning complete user — unchanged
    } else if (st.status === 'ok') {
      // positively-confirmed INCOMPLETE → the full Creá tu perfil in the sheet
      _acctData = st.snap;
      renderCreateProfilePane((st.snap && st.snap.name) || data.name || '');
    } else {
      // read UNAVAILABLE (timeout/error) — never show create on an unconfirmed read; fail-open to Mi Cuenta
      renderChip();
      renderAccountPane(); showPane('account');
    }
```
The old `#acct-pane-name` (`¿Cómo te llamás?`) pane and `saveName()` may be left in place (dead) OR removed if nothing else references them — check `showPane('name')` / `save-name-btn` references first; if the only caller was this block, delete the pane markup + `saveName` + its wiring to keep the file clean. (Deletion is preferred but must be a separate, verified step — do it only after grep confirms zero other callers.)

- [ ] **Step 2: `agent-browser` guest-safety check** (the one hard executor gate) — serve `la-musa-orders/` and confirm guest load is byte-identical: no Firebase/gstatic network on load, no account panes shown, the guest 3-step order flow + submit unchanged. (Guests never hit `verifyCode`, so this should be trivially green — but verify the file still parses and the guest path is untouched.)

```bash
cd la-musa-orders && python3 -m http.server 8891 >/dev/null 2>&1 &
agent-browser --allow-file-access batch "open http://localhost:8891/" "wait 1500" "screenshot"
agent-browser network requests --status 2xx | grep -iE "firebase|gstatic|googleapis" && echo "LEAK" || echo "clean guest load"
```

- [ ] **Step 3: Commit**

```bash
git add la-musa-orders/account.js
git commit -m "feat(createprofile): post-OTP tri-state routing — complete/incomplete(create)/unavailable(fail-open)"
```

---

## Task 9: Mirror to `xpizza-orders/account.js` (byte-identical past CONFIG)

**Files:**
- Modify: `xpizza-orders/account.js`.

- [ ] **Step 1: Diff the two files to confirm ONLY CONFIG differs today**

```bash
diff <(sed '1,20d' la-musa-orders/account.js) <(sed '1,20d' xpizza-orders/account.js) | head
```
(Adjust the `1,20d` line count to exactly the CONFIG block boundary. Expect: identical below CONFIG before your changes were mirrored — if not, STOP and reconcile.)

- [ ] **Step 2: Port every change from Tasks 1–8** into `xpizza-orders/account.js` below its CONFIG block. The accent color comes from `CONFIG.accent` (already referenced in your code — do NOT hardcode gold/rojo). Re-run the diff; the ONLY differences must be the CONFIG block.

```bash
diff <(tail -n +21 la-musa-orders/account.js) <(tail -n +21 xpizza-orders/account.js)
# expected: NO output (identical past CONFIG)
```

- [ ] **Step 3: `agent-browser` guest-safety check on xpizza-orders** (same as Task 8 Step 2, port 8892).

- [ ] **Step 4: Commit**

```bash
git add xpizza-orders/account.js
git commit -m "feat(createprofile): X. Pizza parity (byte-identical past CONFIG)"
```

---

## Task 10: Self-review pass + hand back to advisor for codex-on-diff

- [ ] **Step 1: Isolation grep (both files)** — `grep -nE "(^|[^_.])\\b(lat|lng|gmap|gmarker|fsMap|__restorePos)\\b\\s*=" account.js` in your new functions must show ZERO writes to checkout globals; `grep -n "openFullscreenMap\|closeFullscreenMap\|reverseGeocodeFS\|setFullscreenMapType\|#fs-\|map-fullscreen" ` in your additions must be ZERO.
- [ ] **Step 2: No index.html edits** — `git diff --stat 0febe4f..HEAD -- '*index.html'` must be empty.
- [ ] **Step 3: Confirm** both guest-safety checks were clean, the create pane renders, and the map opens/commits/closes.
- [ ] **Step 4: Push the branch and report the tip SHA** for the advisor's codex-on-diff (do NOT deploy/merge):

```bash
git push -u origin feat/createprofile-in-sheet
git rev-parse --short HEAD
```

---

## Self-Review (author, pre-handoff)

- **Spec coverage:** A1 (Task 8), A2 (Task 5), A3 (Task 6), A4 (Task 7), Part C incl. isolation/epoch/user-touch/lazy-DOM/z-stack (Tasks 2–4), guest byte-identical (index.html untouched + Task 8/9 checks), coexistence (checkout create untouched; shared predicate/saveAddress). Covered.
- **The one thing to watch:** the `_nad*` sink is shared by "+ Agregar" AND the create pane. Only one pane is ever visible at a time, and every pane-exit resets `_nad*` + bumps `_acctFsEpoch` — verify no path leaves stale `_nad*` for the next pane (Task 4 Step 2 for newaddr; the create pane resets `_nad*` at render top in Task 5 Step 2; add the same epoch-bump on any create-pane dismiss/back).
- **Placeholder scan:** none — every step has concrete code or an exact command.
