# User Profiles P0 — FRONTEND Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the optional customer login + account UI to both order forms (X. Pizza + La Musa), wired to the LIVE profiles backend (`requestOtp`/`verifyOtp`/`deleteAccount`), so returning customers can sign in via WhatsApp OTP and have their orders attributed — with guest checkout byte-identical and Firebase loaded ONLY on login interaction.

**Architecture:** A single self-contained module `account.js`, authored once and copied into each form folder with a per-form CONFIG block (brand palette + `restaurant_id`; `firebaseConfig` is shared). The Firebase JS SDK is **lazy-loaded via dynamic `import()` on the first login interaction** (H8) — guests never fetch it. A lightweight `localStorage` marker (`xpizza_acct = {uid,name,phone}`) renders the header chip's logged-in state WITHOUT the SDK; the real session lives in Firebase's own persistence and is restored lazily only when a token is actually needed (order submit) or the account sheet is opened. Attribution attaches an `X-Firebase-ID-Token` header to the existing order-intake POSTs; a missing/expired token silently falls back to guest and never blocks an order.

**Tech Stack:** Vanilla HTML/CSS/JS (matches the forms), Firebase Web SDK v10 modular (app + auth) from `www.gstatic.com`, the deployed `requestOtp`/`verifyOtp`/`deleteAccount` HTTPS functions, `signInWithCustomToken`, RTDB `user_profiles/{uid}/name` write.

**Backend contract (LIVE, verified from deployed source):**
- `POST https://requestotp-m7syoovdsa-uc.a.run.app` body `{phone, restaurant_id}` → always `{ok:true,cooldown:30}` (uniform; sends WhatsApp code). `restaurant_id` ∈ `{"x_pizza","la_musa"}`.
- `POST https://verifyotp-m7syoovdsa-uc.a.run.app` body `{phone, code}` (6 digits) → `{ok:true, token, is_new, name}` on success, else `{ok:false}`.
- `POST https://deleteaccount-m7syoovdsa-uc.a.run.app` header `x-firebase-id-token: <idToken>` → `{ok:true}` (verifies caller, tombstones + clears the account).
- `createOrder` / `chargeOnlineOrder` read an optional verified `X-Firebase-ID-Token` header for attribution; guest path is byte-identical.
- `firebaseConfig` (project `xpizza-delivery`, public web key — security is via rules + App Check, NOT key secrecy): `apiKey "AIzaSyDWFYrzHvaNnRZERbN8jIuAzkY85daFJXU"`, `authDomain "xpizza-delivery.firebaseapp.com"`, `databaseURL "https://xpizza-delivery-default-rtdb.firebaseio.com"`, `projectId "xpizza-delivery"`, `messagingSenderId "185867271616"`, `appId "1:185867271616:web:84bb37552b40c1d517dc25"`.

**Design source:** `docs/superpowers/specs/2026-07-24-user-profiles-p0-design.md` (H2 attribution, H8 lazy-load, H9 recycled-number disclosure, H10 deletion). Locked mockups: login (`scratchpad/xpizza-login-mockup.html`), account (`scratchpad/xpizza-account-mockup.html`) — port their markup/CSS verbatim, brand-recolored per form.

**Scope (P0 ONLY):** login (phone→OTP→name) · logged-in header chip with the elegant person icon · account sheet showing name + phone, **Mis direcciones / Mis pedidos as "Pronto"** (P2/P3), sign-out, delete-account · order attribution. **OUT of scope:** autofilling the order form's name/phone from the profile (P1), saved addresses (P2), order history + reorder (P3). No credit cards ever.

**Non-negotiables:**
1. **Guest byte-identical** — with no `xpizza_acct` marker, NOTHING changes: no SDK fetch, no new headers, the existing order POSTs are identical. Prove it (Task 11).
2. **Lazy SDK (H8)** — `import()` of Firebase fires only on a login tap or a logged-in submit, never on page load for a guest.
3. **Fail-open attribution** — any token error → proceed as guest; NEVER block/delay an order on account logic.
4. **No cheap emoji** in any chrome ([[no-cheap-emoji-in-form-chrome]]) — the person icon is the monochrome line SVG from the mockup, nothing else.
5. **No secrets added** — only the public web `apiKey`; `ORDER_SECRET` handling is untouched.
6. **Do NOT deploy or merge.** Build on a branch, push, report SHA for the advisor's codex gate; Xavier deploys (git-CD from main → both Netlify sites).

---

## File Structure

- **Create:** `xpizza-orders/account.js` — the entire auth/account module (CONFIG + lazy loader + chip + sheets + wiring). One responsibility: customer accounts. Loaded by the form via a normal `<script src="account.js">` (the script itself is tiny; it does the heavy `import()` only on interaction).
- **Create:** `la-musa-orders/account.js` — byte-identical logic, La Musa CONFIG block.
- **Modify:** `xpizza-orders/index.html` — (a) header chip mount point in `.header` (line ~1037); (b) `<script src="account.js">` tag; (c) inject `X-Firebase-ID-Token` in the two order-intake fetches (`CHARGEORDER_URL` ~2396, `CREATEORDER_URL` ~2615).
- **Modify:** `la-musa-orders/index.html` — same three edits (header ~1230, `processPayment` ~2696, intake fetches).

Keep ALL account logic in `account.js`; the only changes inside `index.html` are the mount point, the script tag, and the two-line header injection. This keeps the giant form files nearly untouched and the account feature reviewable in one file.

---

## Task 0 (BACKEND — ships + gates + deploys FIRST): online-order attribution

**Why first:** codex plan-gate confirmed `chargeOnlineOrder` does NOT read the ID-token header and the materialized order gets no `customer_uid`. Cash/pickup already attributes via `createOrder`; **card orders do not**. The frontend header (Task 7) is inert for card until this ships. This is a money-path change → **separate `codex-on-diff` gate, then a FULL `firebase deploy --only functions` under the established zero-prune discipline** (NOT a targeted single-function deploy): `materialize.js` is a shared module bundled into `index.js` — so `pixelPayWebhook` (the normal hosted-card confirm path), `confirmOnlinePayment`, the pending-sweep recovery, AND `scheduled-release-core.js` all use it. Redeploying only one function leaves webhook-confirmed card orders on old code (codex plan-gate R2 finding 3).

**Files:** Modify `xpizza-functions/index.js` (`chargeOnlineOrder` — token read + stamp pending) and `xpizza-functions/materialize.js` (`buildMaterializeUpdates` — the SHARED materialize builder; **NOT** `pixelpay-confirm.js`, which only calls it). Reuse `xpizza-functions/create-order-build.js` `attributionUid` for the token→uid decision on charge. **Do NOT call `attachCustomerAttribution` in materialize** — it assumes `updates['orders/{id}']` is a whole-order object, but `buildMaterializeUpdates` writes **field-level paths** (`orders/{id}/status`, …); calling it would throw and strand a PAID order (codex plan-gate R2 finding 1). Use field-level patch paths instead (Step 3).

- [ ] **Step 1 (chargeOnlineOrder reads the token, fail-open to guest):** mirror `createOrder`'s block (`index.js:534`). Before building `pendingOrderRecord` (~883): read `req.get('x-firebase-id-token')`; if present, `verifyIdToken` → require `decoded.customer === true && uid`; check the `deleted_uids/{uid}` tombstone (reuse the `attributionUid` helper); on success set `customer_uid`. A missing/malformed/expired/tombstoned token → `null` → guest (NEVER fail or delay the charge — same fail-open guarantee as `createOrder`).

- [ ] **Step 2 (persist on the pending order):** add `customer_uid` (when non-null) to `pendingOrderRecord` (`index.js:883`). This is the hidden pending order the materialize step reads.

- [ ] **Step 3 (materialize carries it — FIELD-LEVEL, in `materialize.js`):** `buildMaterializeUpdates({ orderId, order, ... })` receives the pending order snapshot as `order` (which now carries `customer_uid` from Step 2). When `order.customer_uid` is set, add **field-level patch paths** to `updates`, matching the existing `orders/${orderId}/status` style in that function:
```js
if (order.customer_uid) {
  updates[`orders/${orderId}/customer_uid`] = order.customer_uid;
  updates[`user_orders/${order.customer_uid}/${orderId}`] = {
    ts: now, total: order.total, order_type: order.order_type, items_text: order.items_text,
  };
}
```
This lands a card order in `/user_orders` identically to a cash order, without the whole-object helper. Because this builder is SHARED, scheduled-release online orders get attribution for free too — verify that's intended (it is: a scheduled card order is still the customer's).

- [ ] **Step 4 (tests):** unit-test that (a) a valid `customer:true` token on charge stamps `customer_uid` on the pending record; (b) a tombstoned/absent/guest token → no `customer_uid`, charge unaffected; (c) `buildMaterializeUpdates` on a pending order WITH `customer_uid` emits the two field-level paths (`orders/{id}/customer_uid` + `user_orders/{uid}/{id}`) and does NOT throw; (d) guest online order → `buildMaterializeUpdates` emits NO attribution paths (byte-identical to today); (e) **regression guard:** assert the materialize update has **NO whole-object `orders/{id}` key** when attribution is present — only `orders/{id}/customer_uid` + `user_orders/{uid}/{id}` (this is the exact defect that would strand a paid order). Run the existing `materialize-snapshot`, `pixelpay-confirm`, `pixelpay-hosted-webhook` money-path tests green.

- [ ] **Step 5:** Commit; **hand to advisor for `codex-on-diff` (money-path)** → Xavier deploys via a **FULL `firebase deploy --only functions`** (zero-prune gate, complete `.env`) so every consumer of the changed `materialize.js` (`pixelPayWebhook`, `confirmOnlinePayment`, sweep, scheduled release) runs the new code. Only AFTER this is live does the frontend attribution (Task 7) attribute card orders. Do NOT deploy/merge yourself.

---

## Task 1: `account.js` — CONFIG + lazy Firebase loader

**Files:** Create `xpizza-orders/account.js`

- [ ] **Step 1: Write the CONFIG + `ensureFirebase()` lazy loader**

```js
/* account.js — User Profiles P0 (customer accounts). Self-contained; guest path never touches this
   beyond reading the localStorage marker. Firebase SDK is imported ONLY on login interaction (H8). */
(function () {
  'use strict';
  const CONFIG = {
    restaurant_id: 'x_pizza',                 // 'x_pizza' | 'la_musa'
    brand: 'X. Pizza',
    accent: '#A9791A',                        // gold (La Musa: rojo musa)
    OTP_URL:    'https://requestotp-m7syoovdsa-uc.a.run.app',
    VERIFY_URL: 'https://verifyotp-m7syoovdsa-uc.a.run.app',
    DELETE_URL: 'https://deleteaccount-m7syoovdsa-uc.a.run.app',
    fb: { apiKey:'AIzaSyDWFYrzHvaNnRZERbN8jIuAzkY85daFJXU', authDomain:'xpizza-delivery.firebaseapp.com',
          databaseURL:'https://xpizza-delivery-default-rtdb.firebaseio.com', projectId:'xpizza-delivery',
          messagingSenderId:'185867271616', appId:'1:185867271616:web:84bb37552b40c1d517dc25' },
    MARKER: 'xpizza_acct',                    // localStorage key (La Musa: 'lamusa_acct')
  };

  // Lazy Firebase — imported on first use only. Returns { auth, db-helpers } cached after first load.
  let _fb = null;
  async function ensureFirebase() {
    if (_fb) return _fb;
    const V = 'https://www.gstatic.com/firebasejs/10.12.2';
    const [{ initializeApp }, authMod, dbMod] = await Promise.all([
      import(`${V}/firebase-app.js`),
      import(`${V}/firebase-auth.js`),
      import(`${V}/firebase-database.js`),
    ]);
    const app = initializeApp(CONFIG.fb);
    const auth = authMod.getAuth(app);
    await authMod.setPersistence(auth, authMod.browserLocalPersistence);
    _fb = { app, auth, authMod, db: dbMod.getDatabase(app), dbMod };
    return _fb;
  }

  window.__ACCOUNT = { CONFIG, ensureFirebase };   // internal handle for later tasks/tests
})();
```

- [ ] **Step 2: Verify it parses and does NOT import Firebase on load**

Run: `node --check xpizza-orders/account.js`
Expected: no output (valid JS). Manual: open the form, confirm the Network tab shows **no** `gstatic.com/firebasejs` request until an interaction (proven in Task 11).

- [ ] **Step 3: Commit**
```bash
git add xpizza-orders/account.js
git commit -m "feat(account): lazy Firebase loader + config scaffold (P0 frontend)"
```

---

## Task 2: Header chip (logged-out + logged-in) rendered from the marker (no SDK)

**Files:** Modify `xpizza-orders/index.html` (`.header` ~1037, add script tag near other scripts ~1310); extend `xpizza-orders/account.js`

- [ ] **Step 1: Add the mount point + script tag in `index.html`**

In `.header` (after the brand-lockup `<img>`/`.brand-sub`), add an absolutely/flex-positioned mount:
```html
<div id="acct-chip" class="acct-chip-mount"></div>
```
Near the other `<script src>` tags (~line 1310), add:
```html
<script src="account.js"></script>
```

- [ ] **Step 2: Render the chip from the localStorage marker in `account.js`**

Append to `account.js` (inside the IIFE, before the `window.__ACCOUNT` line):
```js
  const $ = (id) => document.getElementById(id);
  const marker = () => { try { return JSON.parse(localStorage.getItem(CONFIG.MARKER) || 'null'); } catch (_) { return null; } };
  const PERSON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.2" r="3.7"/><path d="M5.5 19.5c0-3.5 2.9-5.6 6.5-5.6s6.5 2.1 6.5 5.6"/></svg>';

  function renderChip() {
    const el = $('acct-chip'); if (!el) return;
    const m = marker();
    if (m && m.name) {
      el.innerHTML = `<button class="acct-chip" type="button" aria-label="Mi cuenta">
        <span class="acct-av">${PERSON_SVG}</span><span class="acct-nm">${escapeHtml(firstName(m.name))}</span><span class="acct-cv">▾</span></button>`;
      el.querySelector('button').onclick = openAccountSheet;      // defined Task 6
    } else {
      el.innerHTML = `<button class="acct-chip acct-chip--out" type="button" aria-label="Entrar a mi cuenta">
        <span class="acct-av">${PERSON_SVG}</span><span class="acct-nm">Entrar</span></button>`;
      el.querySelector('button').onclick = openLoginSheet;        // defined Task 3
    }
  }
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  document.addEventListener('DOMContentLoaded', renderChip);
```

- [ ] **Step 3: Add the chip CSS** (port from `xpizza-account-mockup.html` `.chip`/`.av`/`.nm`/`.cv`, brand-recolored). Place in the form's `<style>` or a `<style>` block appended by `account.js`. Logged-out variant uses a subtler treatment; both use `PERSON_SVG` only — no emoji.

- [ ] **Step 4: Verify** — load the form with no marker → chip reads "Entrar" with the person icon. `localStorage.setItem('xpizza_acct', JSON.stringify({uid:'u_x',name:'Xavier'}))` + reload → chip reads "Xavier ▾". No `gstatic` request in either case.

- [ ] **Step 5: Commit** `feat(account): header chip rendered from marker (no SDK on load)`

---

## Task 3: Login sheet — phone pane (UI + open/close)

**Files:** Modify `xpizza-orders/account.js`

- [ ] **Step 1:** Port the login sheet markup from `xpizza-login-mockup.html` (the `.screen` with `#pane-phone`, `#pane-otp`, `#pane-account`) into a string injected by `account.js` into a `<div id="acct-overlay">` appended to `<body>` on first open (created lazily, once). Include the phone pane: title *"Entrá a tu cuenta"*, the CC button + phone input, *Continuar* CTA, the WhatsApp fine print, and the **"Prefiero seguir como invitado"** button that just closes the overlay (guest flow unchanged).

- [ ] **Step 2:** Reuse the phone input UX from the mockup (`fmt()` — digits only, `NNNN-NNNN`, enable CTA at 8 digits). For P0 default the CC to **+504**; wire the existing form's `PHONE_COUNTRIES` dropdown is OPTIONAL (keep the login CC as a static +504 button for P0 — the login phone is almost always the local WhatsApp number; a US customer can still order as guest). Note this simplification explicitly.

- [ ] **Step 3:** `openLoginSheet()` builds/show the overlay, focuses the phone input, shows `#pane-phone`. `closeSheet()` hides it. Back button on OTP pane → phone pane.

- [ ] **Step 4: Verify** — tap "Entrar" → sheet slides in, phone pane focused, typing 8 digits enables *Continuar*, "seguir como invitado" closes it. (Still no network — `import()` happens on *Continuar*, Task 4.)

- [ ] **Step 5: Commit** `feat(account): login sheet phone pane (ported from locked mockup)`

---

## Task 4: Wire `requestOtp` (Continuar → send code)

**Files:** Modify `xpizza-orders/account.js`

- [ ] **Step 1:** On *Continuar*: disable the CTA, build the full phone (`+504` + 8 digits → `50499998888` digits form the backend normalizes), and `POST CONFIG.OTP_URL` with `{phone, restaurant_id: CONFIG.restaurant_id}`. The response is always `{ok:true,cooldown:30}` — on any `ok` (or even network hiccup), advance to the OTP pane and start the 0:29 resend countdown (uniform, matches the backend's no-enumeration design). Store the entered `phone` in a closure var for verify/resend.

```js
async function sendCode(phone) {
  try {
    await fetch(CONFIG.OTP_URL, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ phone, restaurant_id: CONFIG.restaurant_id }) });
  } catch (_) { /* uniform UX regardless — never reveal rate-limit/enumeration */ }
  showPane('otp'); startResendCountdown();
}
```

- [ ] **Step 2:** This is the first interaction that may need Firebase — but `requestOtp` is a plain fetch, so DON'T load the SDK yet. (SDK loads at verify, Task 5, where `signInWithCustomToken` needs it.) Keep the guest-with-SDK-blocked property: a user who abandons at the OTP pane never loaded Firebase.

- [ ] **Step 3: Verify (against LIVE)** — real phone → *Continuar* → WhatsApp code arrives, OTP pane shown, countdown runs, *Reenviar* re-POSTs after 0:00.

- [ ] **Step 4: Commit** `feat(account): wire requestOtp (WhatsApp code send + resend)`

---

## Task 5: Wire `verifyOtp` + `signInWithCustomToken` + persist marker + name capture

**Files:** Modify `xpizza-orders/account.js`

- [ ] **Step 1:** Port the 6-box OTP input from the mockup (auto-advance, backspace, enable *Verificar* when all 6 filled). On *Verificar*, `POST CONFIG.VERIFY_URL {phone, code}`.

- [ ] **Step 2:** On `{ok:true, token, is_new, name}`: **now** `await ensureFirebase()`, then `signInWithCustomToken(auth, token)`. On success, write the marker:
```js
localStorage.setItem(CONFIG.MARKER, JSON.stringify({ uid: auth.currentUser.uid, name: name || '', phone }));
```
On `{ok:false}`: shake the boxes, clear, show a generic *"Código incorrecto o vencido"* (no specifics).

- [ ] **Step 3:** If `is_new` OR no `name`: show the **name pane** (*"¿Cómo te llamás?"* → *Guardar*). On save, write `user_profiles/{uid}/name` via the SDK (`ref(db,'user_profiles/'+uid)` `update({name})`) — allowed by the rules (owner, complete profile). **Client-validate the name (trim, non-empty, ≤80 chars) to match the rule's `.validate` (`length <= 80`) — a longer value is REJECTED by RTDB and would otherwise wedge the post-OTP flow (codex plan-gate finding 6).** Wrap the write in try/catch: the account already exists after the token mint, so a name-write failure must NOT trap the user — on failure, keep the marker's `name` empty, proceed to the account sheet, and surface a soft *"No pudimos guardar tu nombre, podés intentarlo luego"* (never a dead end).

```js
async function saveName(rawName) {
  const name = String(rawName || '').trim().slice(0, 80);        // enforce the rule's length cap client-side
  if (!name) return;
  try {
    const { auth, db, dbMod } = await ensureFirebase();
    await dbMod.update(dbMod.ref(db, 'user_profiles/' + auth.currentUser.uid), { name });
    const m = marker(); m.name = name; localStorage.setItem(CONFIG.MARKER, JSON.stringify(m));
    renderChip();
  } catch (_) {
    // account is already live (token minted); a failed name write must not wedge the flow
    toast('No pudimos guardar tu nombre, podés intentarlo luego');
  }
}
```

- [ ] **Step 4:** Close the sheet on completion; the chip now shows the first name.

- [ ] **Step 5: Verify (LIVE)** — full round-trip: code → *Verificar* → (new) name → *Guardar* → chip shows name; reload → chip still shows name (marker persists); confirm `user_profiles/{uid}/name` is set in RTDB. Wrong code → generic error, no mint.

- [ ] **Step 6: Commit** `feat(account): verifyOtp + custom-token sign-in + name capture`

---

## Task 6: Account sheet (logged-in) — name/phone, Pronto rows, sign-out, delete

**Files:** Modify `xpizza-orders/account.js`

- [ ] **Step 1:** Port the account view from the mockups: profile header (avatar person-icon + *"Hola, {name}"* + phone), and the two **"Pronto"** rows — *Mis direcciones* (P2) and *Mis pedidos* (P3) — shown disabled with the `Pronto` tag. Render name/phone from the marker (no SDK needed to display). **EVERY user-controlled value (name, phone) written into `innerHTML` MUST be escaped** — use `escapeHtml()` or assign via `textContent`, at every render point (the `Hola, {name}` heading, the phone line, and any future row). `name`/`phone` come from `localStorage` and are user-controlled; an unescaped `innerHTML` sink is an XSS hole (codex plan-gate finding 5). Prefer building the header with `textContent` assignments over interpolating into a template string.

- [ ] **Step 2:** `openAccountSheet()` shows this view in the overlay. Include a small H9 disclosure line in fine print (the phone-account model): e.g. *"Tu cuenta está ligada a tu número de WhatsApp."*

- [ ] **Step 3: Sign out** — `await ensureFirebase(); await signOut(auth);` then `localStorage.removeItem(CONFIG.MARKER); renderChip(); closeSheet();`.

- [ ] **Step 4: Delete account (H10)** — a subtle *"Eliminar mi cuenta"* link → confirm dialog (*"Esto borra tu cuenta y tus datos. No se puede deshacer."*) → `ensureFirebase()`, `const idTok = await auth.currentUser.getIdToken()`, `POST CONFIG.DELETE_URL` with header `x-firebase-id-token: idTok`. On `{ok:true}`: `await signOut(auth)`, clear the marker, re-render (back to "Entrar"), toast *"Cuenta eliminada"*.

- [ ] **Step 5: Verify (LIVE)** — open account → name/phone correct, Pronto rows present/disabled; sign-out → chip "Entrar", marker gone; delete on a throwaway account → `{ok:true}`, chip resets, and (backend) `deleted_uids/{uid}` set + profile gone.

- [ ] **Step 6: Commit** `feat(account): logged-in sheet — sign-out + delete-account (H10)`

---

## Task 7: Order attribution — attach `X-Firebase-ID-Token` (guest byte-identical)

**Files:** Modify `xpizza-orders/account.js` (helper) + `xpizza-orders/index.html` (the two intake fetches)

- [ ] **Step 1:** Export a fail-open token helper on `window.__ACCOUNT`. It must (a) return `null` instantly for a guest with NO SDK load, and (b) for a logged-in user, **wait once for auth-state restoration** (`auth.currentUser` is `null` until persistence restores — codex plan-gate finding 4) before deciding the session is dead:
```js
async function customerIdToken() {
  if (!marker()) return null;                        // GUEST — no SDK, no header, byte-identical
  try {
    const { auth } = await ensureFirebase();
    await auth.authStateReady();                      // v10: resolves once persistence restore completes
    if (auth.currentUser) return await auth.currentUser.getIdToken();
    heal();                                           // marker present but session truly gone → self-heal to guest (Task 8)
    return null;
  } catch (_) { return null; }                        // fail-open — never block the order
}
window.__ACCOUNT.customerIdToken = customerIdToken;
```

- [ ] **Step 2:** In `index.html`, at the `CHARGEORDER_URL` fetch (~2396) and the `CREATEORDER_URL` fetch (~2615), just before each `fetch`, compute the token and conditionally add the header — leaving the guest request identical. The call-site guard must be **hardened** so a partially-initialized or throwing `account.js` can NEVER abort or delay the order (codex plan-gate findings 2 + 3):
```js
// Robust guard: window.__ACCOUNT may exist but be partially initialized (finding 2) → check the fn.
// Timeout race: a logged-in submit must not stall on a slow gstatic SDK import (finding 3) → cap at 1.5s,
// proceed as guest on timeout. Any throw → guest. GUEST path returns null with zero SDK/network cost.
let __idTok = null;
try {
  if (window.__ACCOUNT && typeof window.__ACCOUNT.customerIdToken === 'function') {
    __idTok = await Promise.race([
      window.__ACCOUNT.customerIdToken(),
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ]);
  }
} catch (_) { __idTok = null; }   // never block the order on account logic
// headers object:
headers: Object.assign(
  { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ORDER_SECRET },
  __idTok ? { 'X-Firebase-ID-Token': __idTok } : {}
),
```
(Both call sites are already inside `async` functions — `await` is safe. Confirm the enclosing function is `async` before editing; both `processPayment`→charge and the cash/pickup submit are.)

- [ ] **Step 3: Online-order attribution is wired by Task 0 (backend).** With Task 0 deployed, `chargeOnlineOrder` consumes the same `X-Firebase-ID-Token` header and stamps `customer_uid` onto the pending order, and materialization carries it. So the header on **both** intake fetches (Step 2) now attributes cash/pickup (`createOrder`) AND card (`chargeOnlineOrder`) orders. **Task 0 must be deployed before this frontend attribution ships** — otherwise the card header is silently ignored.

- [ ] **Step 4: Verify (LIVE, guest byte-identical)** — place a GUEST order: DevTools Network shows the intake POST has NO `X-Firebase-ID-Token` and NO `gstatic` load. Place a LOGGED-IN order: the header is present and the resulting order carries `customer_uid`.

- [ ] **Step 5: Commit** `feat(account): attribute logged-in orders via X-Firebase-ID-Token (guest identical)`

---

## Task 8: Session robustness (marker/SDK reconciliation)

**Files:** Modify `xpizza-orders/account.js`

- [ ] **Step 1:** Define the shared `heal()` used by `customerIdToken()` and the account sheet. It must ONLY declare the session dead **after** auth-state restoration has completed (finding 4) — never clear a valid marker just because `currentUser` hasn't populated yet:
```js
function heal() { try { localStorage.removeItem(CONFIG.MARKER); } catch (_) {} renderChip(); }
// Callers MUST have already awaited auth.authStateReady() before concluding currentUser === null.
```
When the account sheet or a submit lazily loads the SDK, `await auth.authStateReady()`, and only if `auth.currentUser` is STILL null → `heal()` (marker gone, chip back to "Entrar"), quietly, so a returning user with a genuinely dead session sees guest state and their order still submits as guest.

- [ ] **Step 2:** Ensure the marker is the ONLY thing gating the guest fast-path — never call `ensureFirebase()` from `renderChip()` or `DOMContentLoaded`.

- [ ] **Step 3: Verify** — set a marker but clear IndexedDB (kill the Firebase session) → open account → chip self-heals to "Entrar", no crash, a subsequent order is a clean guest order.

- [ ] **Step 4: Commit** `feat(account): self-heal marker vs dead Firebase session → guest`

---

## Task 9: La Musa parity (copy + brand config)

**Files:** Create `la-musa-orders/account.js`; Modify `la-musa-orders/index.html`

- [ ] **Step 1:** Copy `xpizza-orders/account.js` → `la-musa-orders/account.js`; change the CONFIG block ONLY: `restaurant_id:'la_musa'`, `brand:'La Musa'`, `accent:` La Musa rojo musa, `MARKER:'lamusa_acct'`. Logic byte-identical.

- [ ] **Step 2:** Apply the same three `index.html` edits to `la-musa-orders/index.html` (chip mount in `.header` ~1230, `<script src="account.js">`, header injection at the La Musa intake fetches — `processPayment` ~2696 + its charge/create fetches). Recolor the ported sheet/chip CSS to the La Musa palette.

- [ ] **Step 3: Verify (LIVE)** — repeat Task 5 + Task 7 checks on La Musa: OTP via La Musa's UltraMsg (message says *"La Musa"*), attribution header present, guest identical, palette correct.

- [ ] **Step 4: Commit** `feat(account): La Musa parity (rojo musa config)`

---

## Task 10: CSP / SDK endpoints + no-emoji audit

**Files:** Inspect both `index.html`; adjust any CSP `<meta>` / Netlify headers if present

- [ ] **Step 1:** Check each form (and `netlify.toml`/`_headers` if any) for a Content-Security-Policy. If present, ensure `script-src` allows `https://www.gstatic.com`, and `connect-src` allows `https://*.googleapis.com https://xpizza-delivery-default-rtdb.firebaseio.com https://*.a.run.app https://securetoken.googleapis.com https://identitytoolkit.googleapis.com`. If NO CSP exists (the forms already load `maps.googleapis.com` unrestricted), note that and skip.

- [ ] **Step 2:** Grep both `account.js` + the new markup for emoji; confirm ONLY the monochrome person-icon SVG is used in chrome ([[no-cheap-emoji-in-form-chrome]]).

- [ ] **Step 3: Commit** (if any change) `chore(account): CSP endpoints for Firebase SDK`

---

## Task 11: End-to-end verification (both forms) — the guarantees

**Files:** none (verification); use `agent-browser` against a local serve or the deploy preview

- [ ] **Step 1 — Guest byte-identical + H8:** load each form fresh (no marker). Confirm via Network tab: ZERO `gstatic.com/firebasejs` requests; place a guest order and capture the intake POST headers — identical to pre-change (no `X-Firebase-ID-Token`). **This is the gate-critical property.**
- [ ] **Step 2 — Login E2E:** Entrar → real phone → WhatsApp code → Verificar → name → chip shows name → reload persists.
- [ ] **Step 3 — Attribution:** logged-in order → intake POST carries `X-Firebase-ID-Token`; confirm the created order has `customer_uid`.
- [ ] **Step 4 — Delete + sign-out:** both reset the chip and clear the marker; delete tombstones the backend account.
- [ ] **Step 5 — Self-heal:** dead session + marker → guest, no crash.
- [ ] **Step 6:** Report results + push the branch; hand to advisor for the codex gate. Do NOT deploy/merge.

---

## Self-review notes
- **Spec coverage:** H2 (Task 0 backend + Task 7 header), H8 (Tasks 1/4/11 lazy-load + guest-no-SDK), H9 (Task 6 disclosure line), H10 (Task 6 delete). Guest-identical is Task 1/7/11.
- **Type consistency:** `marker()`, `ensureFirebase()`, `heal()`, `CONFIG.MARKER`, `customerIdToken()`, `renderChip()`, `openLoginSheet()`, `openAccountSheet()`, `showPane()`, `sendCode()`, `saveName()`, `toast()` used consistently across tasks.
- **codex plan-gate R1 (REVISE → folded in):** (1) online attribution wired server-side = **Task 0** (backend, gates+deploys first); (2) call-site guard hardened to `typeof …==='function'` + try/catch (Task 7 Step 2); (3) 1.5s timeout race so a logged-in submit never stalls on the SDK import (Task 7 Step 2); (4) `await auth.authStateReady()` before declaring a session dead (Task 7 Step 1, Task 8 `heal()`); (5) explicit `escapeHtml`/`textContent` for every name/phone render (Task 6); (6) name ≤80 client-validation + write-failure recovery (Task 5).
- **Build/deploy order:** Task 0 (backend attribution) gates + deploys FIRST; then the frontend (Tasks 1–11) builds, gates via `codex-on-diff`, and ships (git-CD from main → both Netlify sites). The frontend's card-attribution only works once Task 0 is live.
