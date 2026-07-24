# User Profiles — Phase 0: auth + profile foundation (design)

_Date: 2026-07-24 · Branch: `feature/user-profiles-p0` (off `origin/main` fc87907) · Both forms + functions + rules · Restaurant: shared cross-brand (X. Pizza + La Musa)_

## Goal

Add an **optional** customer account to both order forms. Guest checkout is unchanged. A returning customer can log in via **WhatsApp OTP** and get a profile (name + phone now; saved addresses = P2; order history + reorder = P3). Phase 0 delivers the **secure foundation**: the OTP login, a Firebase-Auth session, an owner-only profile store, and order attribution — plus the login + account-shell UI at the locked "billion-bucks" design.

## Scope (P0 only)

**In:** WhatsApp-OTP login (2 Cloud Functions), custom-token Firebase Auth, `/user_profiles/{uid}` owner-only store, server-only `/otp` + `/phone_index`, order stamping (`customer_uid` + a `/user_orders` history index), the login modal + account chip + "Mi cuenta" shell UI (name/phone + "Pronto" sections + sign out) on both forms. **Out (later phases):** autofill (P1), saved addresses (P2), order history list + reorder (P3).

## Identity model (locked)

- **Guest** = today's anonymous flow (POST to `createOrder` with `ORDER_SECRET`), byte-identical.
- **Account** = one shared profile across both brands, keyed by a **server-issued stable `uid`** mapped from the customer's phone. Log in once → works on both forms.
- **Verification is mandatory** (no unverified phone lookup) — else anyone could pull another person's PII.

## Architecture

### 1. Cloud Functions (new, `xpizza-functions/`)

Both are `onRequest` (CORS for the form origins), admin-SDK, **no `ORDER_SECRET`** (they're their own auth). Rate-limited. Phone identity = `normalizePhone()` (reuse from whatsapp.js) → full international digits; **`phoneHash = sha256(phoneDigits + OTP_SALT)`** (server env secret) is the key for the server-only nodes (no raw-PII as keys).

**`requestOtp`** — body `{ phone, restaurantId }`:
1. Normalize + validate the phone (10–15 digits). 
2. **Rate-limit** at `/otp/{phoneHash}`: reject if last send < **30s** ago or ≥ **3 sends / 10 min**; plus a per-IP cap (`/otp_ip/{ipHash}`, e.g. ≤ 10/hour). 
3. Generate a **6-digit code**; store `{ code_hash: sha256(code+OTP_SALT), expires_at: now+5min, attempts: 0, send_count, last_sent }` at `/otp/{phoneHash}` (server-only). 
4. Send via WhatsApp: `sendMessage(phone, "Tu código de {Brand} es {code}. Vence en 5 minutos. No lo compartas.", restaurantId)`. 
5. Respond **uniformly** `{ ok: true, cooldown: 30 }` regardless of whether the phone is "known" (no enumeration). Never returns the code.

**`verifyOtp`** — body `{ phone, code }`:
1. Load `/otp/{phoneHash}`; if absent/expired/`attempts ≥ 5` → increment attempts, return `{ ok:false }` (generic). 
2. Compare `sha256(code+OTP_SALT)` to `code_hash` (constant-time). On mismatch → `attempts++`, generic fail. 
3. On match: resolve the **uid** — read `/phone_index/{phoneHash}`; if absent, generate `uid = 'u_' + 24 hex` and write it (server-only). 
4. Ensure `/user_profiles/{uid}` exists (create `{ phone, created_at }` on first login). 
5. **Mint** `admin.auth().createCustomToken(uid, { customer: true })`. 
6. **Delete** `/otp/{phoneHash}` (one-time use). 
7. Respond `{ ok:true, token }`.

### 2. RTDB nodes + rules (`xpizza-reference/database.rules.json`)

```jsonc
"user_profiles": {
  "$uid": {
    ".read":  "auth != null && auth.uid === $uid",
    ".write": "auth != null && auth.uid === $uid",
    "name":  { ".validate": "newData.isString() && newData.val().length <= 80" },
    "phone": { ".validate": "newData.isString() && (!data.exists() || newData.val() === data.val())" },       // write-once (server sets)
    "created_at": { ".validate": "newData.isNumber() && (!data.exists() || newData.val() === data.val())" },  // immutable
    "updated_at": { ".validate": "newData.isNumber() && newData.val() <= now + 60000" },
    "addresses": { ".validate": false },     // DENIED until P2 ships a strict schema (H5)
    "$other": { ".validate": false }         // no unexpected keys (PII discipline)
  }
},
"user_orders": {                             // P3 history index; server-written, owner-read
  "$uid": { ".read": "auth != null && auth.uid === $uid", ".write": false }
},
"otp":        { ".read": false, ".write": false },   // server-only (admin bypasses)
"otp_ip":     { ".read": false, ".write": false },
"phone_index":{ ".read": false, ".write": false }
```

Deploy discipline (per [[functions-env-management]]): reconcile the deploy `database.rules.json` ← `xpizza-reference`, add these as a diff, re-diff vs LIVE (0 stripped), guard-test the new deny nodes.

### 3. Firebase SDK on both forms (new)

Add Firebase **app + auth + database** (same pattern + `firebaseConfig` as `xpizza-track`, project `xpizza-delivery`; the web `apiKey` is public — security is via rules + App-Check-monitor). Auth uses **local persistence** → session survives reloads (auto-logged-in on return). This is the only new client dependency; it's isolated to the account feature and does not touch the guest order path.

### 4. Login + account UI (both forms — guest untouched)

Exactly the locked mockups (login `e6b19959…`, account `a8b5328b…`):
- **Entry:** a subtle "Iniciar sesión" affordance in the form header; once logged in it becomes the **account chip** (person line-icon + name + ▾).
- **Login modal:** phone (country-code selector) → `requestOtp` → 6-box OTP (auto-advance) + resend countdown → `verifyOtp` → `signInWithCustomToken` → if new/no name, a name step → done.
- **Mi cuenta shell (P0):** person avatar + "Hola, {name}" + phone; "Direcciones" and "Pedidos" rows shown but tagged **"Pronto"** (P2/P3); "Cerrar sesión" (`signOut`).
- Design rules: near-black actions, gold used sparingly, **no emoji** (monochrome line icons only — [[no-cheap-emoji-in-form-chrome]]).

### 5. Order attribution

When a **logged-in** customer submits, the client attaches its Firebase **ID token**; `createOrder` verifies it server-side (`admin.auth().verifyIdToken`) and derives **`customer_uid = decoded.uid`** — a client-supplied uid without a valid token is ignored, so attribution cannot be forged (H2). The intake writes `order.customer_uid` + a **server-only** `/user_orders/{uid}/{orderId} = { ts, total, order_type, items_text }` index to seed P3. **Guests send no token; the order path is otherwise unchanged.**

## Data flow

phone → `requestOtp` (rate-limited, WhatsApp code) → user enters code → `verifyOtp` (verify → uid via `phone_index` → custom token) → client `signInWithCustomToken` → Firebase Auth session (`auth.uid`) → reads/writes `/user_profiles/{uid}` (owner-only rules) → on order submit, `customer_uid` stamped on the order + `/user_orders`.

## Security (the critical surface — codex gate focus)

- **Custom-token minting** happens only server-side, only after a verified OTP. A bug that mints a token without verification = full account takeover → the verify path (hash compare, expiry, attempt cap, one-time delete) is the crown jewel.
- **Owner-only profile rules** (`auth.uid === $uid`) + `$other: false` — a wrong `.read` would leak all customer PII. Guard-tested.
- **OTP abuse:** per-phone (30s / 3-per-10min) **and** per-IP rate limits prevent WhatsApp-bombing (harassment + cost) and brute-force (≤5 attempts, 5-min expiry). Primary defense is rate-limiting; **App Check = monitor-only** (not enforce) to avoid blocking real logins on flaky Honduras networks (per [[order-intake-secret-p0]]).
- **No enumeration:** `requestOtp`/`verifyOtp` return uniform responses.
- **Hashed at rest:** OTP codes hashed; phone used only as a salted hash for server-node keys; raw phone stored only inside the owner-only profile.
- **`OTP_SALT`** is a new functions env secret (gcloud-managed; see [[functions-env-management]] — the deploy `.env` must include it or the OTP hashing breaks).
- Guest intake (`ORDER_SECRET`) and the deferred App-Check surface are unchanged (not reopened here).

## Error handling / edge cases

- Wrong/expired code → generic "Código inválido o vencido"; attempts capped → must re-request.
- WhatsApp send fails → `requestOtp` still returns `{ ok:true }` (no leak); user can resend after cooldown. (Consider a soft "no llegó?" path.)
- Rate-limited → friendly "Esperá unos segundos / demasiados intentos".
- Token sign-in fails (clock skew, network) → retry; never blocks guest checkout.
- Logged-in but profile has no name → prompt name once.
- Cross-brand: same phone on either form → same uid/profile.
- Firebase SDK fails to load → the account UI degrades gracefully (hidden); **guest checkout must still work** (hard requirement).

## Testing

- **Functions (unit):** phoneHash/code hashing; rate-limit windows (30s / 3-per-10min / per-IP); verify success/expiry/attempt-cap/mismatch; uid create-or-reuse (same phone → same uid); token minted only on success; one-time OTP deletion; no-enumeration uniform responses. (Emulator for the RTDB nodes.)
- **Rules (guard tests):** `/user_profiles/{uid}` readable/writable only by `auth.uid===uid`, denied for other/anon; `$other:false`; `/otp`,`/otp_ip`,`/phone_index` deny all client access; `/user_orders/{uid}` owner-read/no-client-write.
- **Manual (both forms):** guest order unchanged; log in end-to-end (phone→WhatsApp code→name→chip); reload stays logged in; sign out; a logged-in order carries `customer_uid`; wrong code / resend / rate-limit messaging; no emoji.

## Security hardening (resolves codex design-review R1)

**H1 — Customer auth must NOT satisfy staff reads (BLOCKING pre-req).** Minting customer custom tokens makes customers `auth != null`, which today grants read of every node gated by bare `auth != null` (`/orders`, `/tasks`, `/order_timelines`, `/config`, `/drivers`, restaurant identity) — a mass PII/operational leak. **Before any customer token is minted**, audit every rule and replace bare-`auth != null` operational reads with a **positive staff-role check** (`root.child('dispatchers').child(auth.uid).exists()` / driver / kitchen membership). Customer tokens carry a `customer:true` claim and are never a staff role. This rules-hardening pass is **part of P0 and ships (functions+rules) before the login UI**. Guard tests: a `customer:true` token is DENIED on `/orders`, `/tasks`, `/order_timelines`, `/config`, `/drivers`, etc.; existing staff/driver access is unchanged.

**H2 — Attribution via verified ID token, not client uid.** `createOrder` accepts an optional Firebase **ID token**, `verifyIdToken`s it, and derives `customer_uid = decoded.uid`; a client-supplied uid is ignored. `/user_orders/{uid}` is written server-side only from the verified uid. (Inline above.)

**H3 — Atomic OTP verify + rate-limit (no races).** `verifyOtp` does check-expiry/attempts/code **+ consume in ONE RTDB transaction** (CAS): failure → atomic `attempts++`; success → atomic mark-consumed BEFORE minting, so parallel verifies can't exceed 5 attempts or mint twice. `requestOtp` **reserves the send-slot in an atomic transaction** (30s + 3-per-10min window) BEFORE generating/sending, reconciling send-state after UltraMsg returns.

**H4 — Per-phone limit GLOBAL across brands; per-IP secondary.** The per-phone rate-limit is keyed by `phoneHash` **shared across X. Pizza + La Musa** (not per-brand — else a victim gets 2× the messages). Per-IP uses the platform-trusted client IP (Cloud Run), treated as secondary since XFF is client-spoofable (`index.js:421`); per-phone + an App-Check risk signal are primary. Add a **global send budget** + abuse **monitoring/alerting**; App Check can flip monitor→enforce once telemetry shows safe coverage.

**H5 — Profile rules: server-truth fields immutable.** `phone`/`created_at` are write-once (validated `!data.exists() || newData===data`); `updated_at` bounded to ~now; `addresses` **denied** until P2's strict schema. Owner-only `.read/.write` unchanged. (Inline in the rules block.)

**H6 — Hard CORS allowlist on token endpoints.** `requestOtp`/`verifyOtp` (and the ID-token path on `createOrder`) use an **exact origin allowlist** (`https://orders.xpizza.hn`, `https://orders.lamusa.hn`, Netlify preview domains) — NOT `cors:true`. Unknown origins rejected; responses generic.

**H7 — `OTP_SALT` fail-closed.** Functions assert a present, sufficiently-long `OTP_SALT` at init and **fail-closed (500)** if missing/weak — never hash with an empty/default salt.

**H8 — Guest isolation by design.** Firebase app/auth/database is **lazy-loaded only on first login interaction** (not at page load); all account init is wrapped in isolated `try/catch`; the guest submit path keeps its inline-globals + `fetch`, zero Firebase dependency. **Required test:** block the Firebase SDK at the network layer and confirm a guest order still submits.

**H9 — Recycled-number handling.** Phone-as-identity means a reassigned number could inherit the prior owner's record. P0 exposes only a name (low harm), but **before P2/P3** (addresses/history) this is mitigated: **stale-profile re-confirm** (profile inactive > ~6 months → next login treats it as fresh / requires re-entering name before showing durable data) + an ops redaction path. **Blocking pre-req for P2.**

**H10 — Minimum privacy for launch.** A P0 **"Eliminar mi cuenta"** path (clears `/user_profiles/{uid}` + `/phone_index/{phoneHash}` + `/user_orders/{uid}`) and **disclosure copy** that the account is shared across X. Pizza + La Musa. Full data-export + automated recycled-number recovery tooling tracked for a later privacy pass.

## Gate & rollout

- **Design gate:** this spec → **codex design-review** (auth + PII + custom tokens) BEFORE build.
- **Build gate:** executor builds → advisor **codex-on-diff** on the money/security surface (`requestOtp`/`verifyOtp`, rules, order-stamping) — the highest-stakes diff yet.
- **Deploy (Xavier):** functions (incl. new `OTP_SALT` in the complete `.env`, zero-prune) + **database rules** (reconcile ← xpizza-reference, 0 stripped) + both forms (git-CD, both origins). Functions/rules FIRST, then forms (so the login backend exists before the UI ships).

## Out of scope (later phases)

- P1 autofill name/phone into the order fields + edit profile.
- P2 saved addresses (home/work/parents) reusing the address+map+reference capture.
- P3 order history list + one-tap reorder (reads `/user_orders`).
- Multi-device merge, email, social login, account deletion/export UI (privacy — consider before scale).
