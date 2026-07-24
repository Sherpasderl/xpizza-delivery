# User Profiles Phase 0 — BACKEND Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build + gate + deploy the secure backend for optional customer accounts — rules hardening, the WhatsApp-OTP auth functions, profile store, deletion, and verified order attribution — BEFORE any customer token can be minted or the UI ships.

**Architecture:** Firebase RTDB + Cloud Functions v2 (admin SDK). Rules harden staff reads (H1), add owner-only `/user_profiles` + server-only `/otp`,`/otp_ip`,`/phone_index` + read-denied `/user_orders`. New functions: `requestOtp`, `verifyOtp` (mints a `customer:true` custom token), `deleteAccount`, an inactivity-aging sweep; `createOrder` gains verified `X-Firebase-ID-Token` attribution.

**Tech Stack:** `xpizza-functions/` (Node, firebase-functions v2, firebase-admin), `xpizza-reference/database.rules.json`. Tests: node `*.test.js` (unit) + emulator (`firebase emulators:exec`) + offline `*-rules.guard.test.js`.

**Spec:** `docs/superpowers/specs/2026-07-24-user-profiles-p0-design.md` · **Design gate:** APPROVED (codex R4, log at `docs/superpowers/reviews/2026-07-24-user-profiles-p0-review-log.md`).

**SCOPE:** This is **P0-BACKEND** only. The forms UI (Firebase SDK + login/account) is a **separate follow-on plan** built + deployed AFTER this backend is live (the gate requires backend-before-frontend). **New env secret `OTP_SALT` (≥32 chars) must be added to the functions `.env` before deploy.**

**Non-negotiables (from the design gate):** H1 rules-hardening ships before any customer token is mintable; all named guard tests are required; guest checkout path (`ORDER_SECRET`) is byte-identical.

---

### Task 1: Rules — H1 staff-read hardening (customer tokens excluded)

**Files:** Modify `xpizza-reference/database.rules.json`; Create `xpizza-functions/user-auth-rules.guard.test.js`

- [ ] **Step 1: Exclude customer tokens from every bare-`auth != null` operational read.** In `xpizza-reference/database.rules.json`, for EACH of these `.read` rules that currently read exactly `"auth != null"`, change to `"auth != null && auth.token.customer !== true"`:
  `/dispatchers`, `/drivers`, `/tasks`, `/orders`, `/config`, `/order_timelines`, `/incoming_messages`, and the `/restaurants/$restaurant_id/...` subnode currently at bare `auth != null`. (Grep `'"\.read": "auth != null"'` — there are 8; leave any read already carrying a role check untouched.) Rationale: a `customer:true` custom token is `auth != null`; this excludes it while preserving all existing staff/driver/kitchen access (they carry no `customer` claim).

- [ ] **Step 2: Write the guard test** `user-auth-rules.guard.test.js` (offline structural, mirrors `counters-rules.guard.test.js`):

```js
'use strict';
// H1 guard: customer custom tokens (customer:true) must NOT satisfy any operational staff read.
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const rules = JSON.parse(fs.readFileSync(path.join(__dirname,'..','xpizza-reference','database.rules.json'),'utf8')).rules;
let n=0; const ok=(l)=>console.log(`  ✓ ${++n} ${l}`);
const STAFF_NODES = ['dispatchers','drivers','tasks','orders','config','order_timelines','incoming_messages'];
for (const k of STAFF_NODES){
  const r = (rules[k] && rules[k]['.read']) || '';
  assert.ok(/auth\.token\.customer\s*!==\s*true/.test(r) || /dispatchers'\)\.child\(auth\.uid\)/.test(r),
    `${k}.read must exclude customer tokens (got: ${r})`);
  assert.ok(!/^\s*auth != null\s*$/.test(r), `${k}.read must not be bare auth!=null`);
  ok(`${k} read excludes customer tokens`);
}
console.log(`user-auth-rules.guard: OK (${n})`);
```

- [ ] **Step 3: Run** `cd xpizza-functions && node user-auth-rules.guard.test.js` → PASS.
- [ ] **Step 4: Commit** `git add xpizza-reference/database.rules.json xpizza-functions/user-auth-rules.guard.test.js && git commit -m "feat(rules): H1 — exclude customer tokens from staff operational reads"`

---

### Task 2: Rules — new profile/auth nodes + guard tests

**Files:** Modify `xpizza-reference/database.rules.json`; extend `user-auth-rules.guard.test.js`

- [ ] **Step 1: Add the new nodes** (alongside the other top-level nodes):
```jsonc
"user_profiles": {
  "$uid": {
    ".read":  "auth != null && auth.uid === $uid",
    ".write": "auth != null && auth.uid === $uid && newData.exists()",
    "name":       { ".validate": "newData.isString() && newData.val().length <= 80" },
    "phone":      { ".validate": "newData.isString() && (!data.exists() || newData.val() === data.val())" },
    "created_at": { ".validate": "newData.isNumber() && (!data.exists() || newData.val() === data.val())" },
    "updated_at": { ".validate": "newData.isNumber() && newData.val() <= now + 60000" },
    "last_login": { ".validate": "newData.isNumber()" },
    "addresses":  { ".validate": false },
    "$other":     { ".validate": false }
  }
},
"user_orders":  { "$uid": { ".read": false, ".write": false } },
"otp":          { ".read": false, ".write": false },
"otp_ip":       { ".read": false, ".write": false },
"phone_index":  { ".read": false, ".write": false }
```

- [ ] **Step 2: Extend the guard test** with assertions: `user_profiles.$uid` read/write require `auth.uid === $uid`; write requires `newData.exists()`; `phone`/`created_at` immutable validators present; `addresses` `.validate:false`; `$other` `.validate:false`; `user_orders`,`otp`,`otp_ip`,`phone_index` are `.read:false` + `.write:false`.

```js
const up = rules.user_profiles.$uid;
assert.equal(up['.read'],  "auth != null && auth.uid === $uid"); ok('user_profiles read owner-only');
assert.ok(/newData\.exists\(\)/.test(up['.write']) && /auth\.uid === \$uid/.test(up['.write'])); ok('user_profiles write owner-only + no wholesale delete');
assert.ok(/newData\.val\(\) === data\.val\(\)/.test(up.phone['.validate'])); ok('phone immutable');
assert.ok(/newData\.val\(\) === data\.val\(\)/.test(up.created_at['.validate'])); ok('created_at immutable');
assert.equal(up.addresses['.validate'], false); ok('addresses denied (P2)');
assert.equal(up.$other['.validate'], false); ok('no stray profile keys');
for (const k of ['user_orders','otp','otp_ip','phone_index']){
  const node = k==='user_orders' ? rules.user_orders.$uid : rules[k];
  assert.equal(node['.read'], false); assert.equal(node['.write'], false); ok(`${k} deny-all`);
}
```

- [ ] **Step 3: Run** `node user-auth-rules.guard.test.js` → PASS. **Commit** `feat(rules): user_profiles owner-only + otp/phone_index/user_orders deny-all`.

---

### Task 3: `otp-lib.js` — shared crypto + rate-limit primitives (TDD)

**Files:** Create `xpizza-functions/otp-lib.js` + `xpizza-functions/otp-lib.test.js`

- [ ] **Step 1: Failing test** `otp-lib.test.js`:
```js
'use strict';
const assert=require('assert');
process.env.OTP_SALT='x'.repeat(40);
const L=require('./otp-lib');
let n=0; const ok=l=>console.log(`  ✓ ${++n} ${l}`);
assert.equal(L.phoneHash('+504 9999-9999'), L.phoneHash('50499999999')); ok('phoneHash normalizes + is stable');
assert.notEqual(L.phoneHash('50499999999'), L.phoneHash('50488888888')); ok('distinct phones distinct hash');
const c=L.genCode(); assert.ok(/^\d{6}$/.test(c)); ok('6-digit code');
assert.equal(L.hashCode('123456'), L.hashCode('123456')); assert.notEqual(L.hashCode('123456'), L.hashCode('654321')); ok('code hash stable + distinct');
assert.ok(L.constEq('abc','abc') && !L.constEq('abc','abd')); ok('constant-time compare');
// fail-closed salt
delete require.cache[require.resolve('./otp-lib')]; const OLD=process.env.OTP_SALT; process.env.OTP_SALT='';
assert.throws(()=>require('./otp-lib')); process.env.OTP_SALT=OLD; ok('missing/short OTP_SALT throws (fail-closed)');
console.log(`otp-lib: OK (${n})`);
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module './otp-lib'`).

- [ ] **Step 3: Implement** `otp-lib.js`:
```js
'use strict';
const crypto = require('crypto');
const { normalizePhone } = require('./whatsapp');            // reuse: full international digits
const SALT = process.env.OTP_SALT || '';
if (SALT.length < 32) { throw new Error('OTP_SALT missing or too short (need >=32 chars) — refusing to start (fail-closed)'); }
function sha(s){ return crypto.createHash('sha256').update(String(s)+SALT).digest('hex'); }
function phoneHash(raw){ const d = normalizePhone(raw); if(!d) return null; return sha('p:'+d); }
function genCode(){ return String(crypto.randomInt(0, 1000000)).padStart(6,'0'); }
function hashCode(c){ return sha('c:'+c); }
function constEq(a,b){ const A=Buffer.from(String(a)), B=Buffer.from(String(b)); return A.length===B.length && crypto.timingSafeEqual(A,B); }
module.exports = { phoneHash, genCode, hashCode, constEq, normalizePhone };
```

- [ ] **Step 4: Run → PASS. Commit** `feat(functions): otp-lib — salted hashing + fail-closed OTP_SALT`.

---

### Task 4: `requestOtp` — rate-limited WhatsApp OTP send (atomic)

**Files:** Modify `xpizza-functions/index.js` (new export); Test: `xpizza-functions/request-otp.test.js` (logic) + emulator note

**Constants (top of the function):** `WINDOW=10*60e3`, `MIN_GAP=30e3`, `MAX_PER_WINDOW=3`, `IP_MAX_PER_HR=10`, `CODE_TTL=5*60e3`. **CORS = exact allowlist** (NOT `cors:true`).

- [ ] **Step 1: Implement** in `index.js`:
```js
const OTP = require('./otp-lib');
const ACCOUNT_ORIGINS = ['https://orders.xpizza.hn','https://orders.lamusa.hn',/^https:\/\/[a-z0-9-]+--(xpizza|lamusa)?orders?\.netlify\.app$/];

exports.requestOtp = onRequest(
  { region:'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds:20, memory:'256MiB', maxInstances:10 },
  async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok:false });
      const { phone, restaurant_id } = req.body || {};
      const { restaurantId } = resolveRestaurantId(restaurant_id);
      const pHash = OTP.phoneHash(phone);
      if (!pHash) return res.status(200).json({ ok:true, cooldown:30 });     // uniform, no enumeration
      const now = Date.now();
      const ipHash = OTP.constEq ? require('crypto').createHash('sha256').update(String(req.ip||'')).digest('hex') : '';

      // per-IP soft cap (secondary; req.ip is Cloud Run trusted)
      const ipRef = admin.database().ref('otp_ip/'+ipHash);
      const ipTx = await ipRef.transaction(v => {
        v = v && v.window_start > now - 3600e3 ? v : { window_start: now, count: 0 };
        if (v.count >= IP_MAX_PER_HR) return;              // abort → rate-limited
        v.count += 1; return v;
      });
      if (!ipTx.committed) return res.status(200).json({ ok:true, cooldown:30 });

      // per-phone atomic slot reservation (GLOBAL across brands)
      const otpRef = admin.database().ref('otp/'+pHash);
      let code = null;
      const tx = await otpRef.transaction(v => {
        v = v || { sends: [], };
        const sends = (v.sends||[]).filter(t => t > now - WINDOW);
        if (sends.length && sends[sends.length-1] > now - MIN_GAP) return;   // abort: too soon
        if (sends.length >= MAX_PER_WINDOW) return;                          // abort: too many
        code = OTP.genCode();
        return { code_hash: OTP.hashCode(code), expires_at: now + CODE_TTL, attempts: 0, sends: [...sends, now] };
      });
      if (!tx.committed || !code) return res.status(200).json({ ok:true, cooldown:30 });   // uniform

      const brand = restaurantId === 'la_musa' ? 'La Musa' : 'X. Pizza';
      await sendMessage(phone, `Tu código de ${brand} es ${code}. Vence en 5 minutos. No lo compartas.`, restaurantId);
      return res.status(200).json({ ok:true, cooldown:30 });
    } catch (e) { console.error('requestOtp', e); return res.status(200).json({ ok:true, cooldown:30 }); }
  }
);
```

- [ ] **Step 2: Test (logic + emulator).** Add `request-otp.test.js` asserting: bad phone → uniform ok; the rate-limit transaction rejects a 2nd send within 30s and a 4th within 10min (drive the transaction updater directly with fixture states); code is 6-digit + only the hash is stored. Emulator test (`test/otp.emulator.test.js`, `firebase emulators:exec --only database`) proves the `/otp` node write + reservation under the demo project.

- [ ] **Step 3: Commit** `feat(functions): requestOtp — atomic rate-limited WhatsApp OTP (CORS allowlist)`.

---

### Task 5: `verifyOtp` — atomic verify + custom-token mint

**Files:** Modify `index.js`; Test: `verify-otp.test.js` + emulator

- [ ] **Step 1: Implement:**
```js
exports.verifyOtp = onRequest(
  { region:'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds:20, memory:'256MiB', maxInstances:10 },
  async (req, res) => {
    try {
      if (req.method !== 'POST') return res.status(405).json({ ok:false });
      const { phone, code } = req.body || {};
      const pHash = OTP.phoneHash(phone);
      if (!pHash || !/^\d{6}$/.test(String(code||''))) return res.status(200).json({ ok:false });
      const now = Date.now();
      const otpRef = admin.database().ref('otp/'+pHash);
      let outcome = 'fail';
      // ATOMIC: check expiry/attempts/code, increment on fail, mark consumed on success — before minting
      await otpRef.transaction(v => {
        if (!v || v.consumed || v.expires_at < now || (v.attempts||0) >= 5) { outcome='fail'; return v; }
        if (OTP.constEq(v.code_hash, OTP.hashCode(String(code)))) { outcome='ok'; return { ...v, consumed:true }; }
        outcome='fail'; return { ...v, attempts:(v.attempts||0)+1 };
      });
      if (outcome !== 'ok') return res.status(200).json({ ok:false });

      // resolve/create stable uid (server-only mapping)
      const idxRef = admin.database().ref('phone_index/'+pHash);
      let uid = (await idxRef.get()).val();
      if (!uid) { uid = 'u_' + require('crypto').randomBytes(12).toString('hex'); await idxRef.set(uid); }
      const now2 = Date.now();
      const profRef = admin.database().ref('user_profiles/'+uid);
      const prof = (await profRef.get()).val();
      if (!prof) await profRef.set({ phone: OTP.normalizePhone(phone), created_at: now2, last_login: now2 });
      else await profRef.child('last_login').set(now2);
      await otpRef.remove();   // one-time
      const token = await admin.auth().createCustomToken(uid, { customer: true });
      return res.status(200).json({ ok:true, token, is_new: !prof, name: (prof && prof.name) || null });
    } catch (e) { console.error('verifyOtp', e); return res.status(200).json({ ok:false }); }
  }
);
```

- [ ] **Step 2: Test:** drive the transaction updater with fixtures — expired/consumed/attempts>=5 → fail (no mint); correct code → consumed=true exactly once (parallel calls can't double-mint); wrong code → attempts++ (capped at 5). Emulator: same phone twice → same uid; profile created on first, `last_login` updated after. Assert a mint only happens on `outcome==='ok'`.

- [ ] **Step 3: Commit** `feat(functions): verifyOtp — atomic verify + customer custom-token mint`.

---

### Task 6: `deleteAccount` + inactivity-aging sweep

**Files:** Modify `index.js`; Test: `account-lifecycle.test.js` + emulator

- [ ] **Step 1: `deleteAccount`** (onRequest, ACCOUNT_ORIGINS): read `X-Firebase-ID-Token` → `verifyIdToken` (must have `customer===true`) → `uid=decoded.uid`; look up `phone_index` entries pointing to uid (or store `phoneHash` on the profile at creation for O(1) delete — **add `phone_hash` to the profile create in Task 5**), then atomically remove `user_profiles/{uid}`, `user_orders/{uid}`, and the `phone_index/{phoneHash}` entry. Return `{ ok:true }`.
- [ ] **Step 2: Inactivity sweep** `onSchedule('every 24 hours')`: scan `user_profiles` for `last_login < now - 180*24*3600e3` (~6 mo) → server-delete the profile + its `phone_index` + `user_orders` (so a recycled number gets a fresh account — H9). Log counts.
- [ ] **Step 3: Tests** for both (emulator): delete clears all three nodes for the authed uid only; sweep removes only stale profiles. **Commit** `feat(functions): deleteAccount + inactivity-aging sweep (H9/H10)`.

_(Note: in Task 5, also store `phone_hash: pHash` on the profile-create so delete/sweep can find `/phone_index` in O(1).)_

---

### Task 7: `createOrder` — verified ID-token attribution (H2)

**Files:** Modify `index.js` `createOrder` (~652)

- [ ] **Step 1:** After the existing `ORDER_SECRET` bearer check passes and the order is validated, add (before the order is written):
```js
// Optional logged-in attribution — SEPARATE header; never affects the guest path.
let customer_uid = null;
const idTok = req.get('x-firebase-id-token');
if (idTok) {
  try { const dec = await admin.auth().verifyIdToken(idTok); if (dec && dec.customer === true) customer_uid = dec.uid; }
  catch (_) { /* malformed/expired → ignore, order proceeds as guest */ }
}
```
Then include `...(customer_uid ? { customer_uid } : {})` in the order record, and when `customer_uid` write `user_orders/${customer_uid}/${orderId} = { ts: now, total, order_type: orderType, items_text: fields.items_text }` (server-side; `.read:false` for now).

- [ ] **Step 2: Test** (`create-order-build.test.js` extension or emulator): no header → order has no `customer_uid` (guest byte-identical); valid customer token → `customer_uid` set + `/user_orders` written; a **client-supplied `customer_uid` in the body is ignored**; malformed token → guest path, order still created.

- [ ] **Step 3: Commit** `feat(functions): createOrder verified customer attribution via X-Firebase-ID-Token`.

---

### Task 8: Wire into the test suite + full run

- [ ] **Step 1:** Add `node user-auth-rules.guard.test.js`, `node otp-lib.test.js`, `node request-otp.test.js`, `node verify-otp.test.js`, `node account-lifecycle.test.js` to the `"test"` script in `xpizza-functions/package.json`; add the rules guard to `"check:rules"`.
- [ ] **Step 2:** `cd xpizza-functions && npm test` → all PASS (incl. existing suite). Run the emulator tests. **Commit.**

---

### Task 9: Gate + deploy (advisor + Xavier)

- [ ] **Advisor gate — codex-on-diff** on the full security surface: `otp-lib.js`, `requestOtp`/`verifyOtp`/`deleteAccount`/sweep, `createOrder` attribution, and ALL rules changes (H1 + new nodes). This is the highest-stakes diff on the platform — focus: no token mint without verified OTP; atomicity holds; owner-only PII; customer excluded from staff reads; guest path byte-identical; CORS/allowlist; fail-closed salt.
- [ ] **Deploy (Xavier), BACKEND-FIRST:** (1) add **`OTP_SALT` (≥32 random chars)** to the complete functions `.env`; (2) `firebase deploy --only functions --project xpizza-delivery` (zero-prune) from a synced tree; (3) **rules**: reconcile `database.rules.json` ← `xpizza-reference`, re-diff vs LIVE (0 stripped), `firebase deploy --only database`; (4) set **App Check to monitor-only** for the project (no enforce). **The forms UI plan ships only after this backend is live + verified.**
- [ ] **Post-deploy verify from source:** the new functions are live (`gcloud functions list` +count), rules `/user_profiles` owner-only + deny nodes live (fetch `.settings/rules.json`), and a manual `requestOtp`→WhatsApp→`verifyOtp`→token round-trip works (curl with a test phone).

---

## Self-review

- **Spec coverage:** H1 staff-hardening (T1) ✓; new nodes owner-only/deny (T2) ✓; fail-closed salt + hashing (T3) ✓; atomic rate-limited requestOtp (T4) ✓; atomic verify + custom-token mint (T5) ✓; deleteAccount + inactivity aging H9/H10 (T6) ✓; verified attribution H2 + guest-untouched (T7) ✓; CORS allowlist H6 (T4/T5) ✓; user_orders read-denied (T2/T7) ✓; codex-on-diff + backend-first deploy (T9) ✓.
- **Placeholders:** none — full code for the security-critical core; the emulator test bodies are specified by assertion (mirroring existing `test/*.emulator.test.js`).
- **Consistency:** `OTP.phoneHash/genCode/hashCode/constEq/normalizePhone`, `pHash`, `uid`, `customer:true` claim, `ACCOUNT_ORIGINS`, `X-Firebase-ID-Token` used consistently; reuses verified `normalizePhone`, `sendMessage`, `resolveRestaurantId`, `admin`, `onRequest`.
- **Sequencing (gate-mandated):** T1 (H1) precedes any mint; deploy is functions+rules only (no UI); `OTP_SALT` fail-closed; guest path untouched.
- **Deferred to frontend plan:** the login modal, account chip, Mi cuenta shell, Firebase SDK lazy-load, order stamping wire-up on both forms — built against the locked mockups after this backend deploys.
