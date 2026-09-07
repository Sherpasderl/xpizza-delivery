# Portal 2b-2a — Shell + Auth + Read-Only Menu Load — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This repo's governance: the **executor session builds LOCAL-ONLY**; the advisor source-audits + codex-gates each task; the **owner** runs all merges/deploys. Do NOT push or deploy.

**Goal:** Stand up a new multi-tenant `xpizza-portal/` static site where a merchant **owner** logs in (Firebase Auth), the portal resolves which restaurants they own, loads the live editable catalog for one via a new read function, and renders it **read-only** in the master-detail layout. No catalog writes in this slice.

**Architecture:** Static vanilla-JS + ES modules + Firebase Auth via CDN, no build step, git-CD Netlify (same mold as dashboard/dispatch/kitchen). Three new backend reads — `getMyRestaurants`, `getEditableCatalog`, and an owner→restaurants reverse index maintained at owner-grant time. Everything keyed off per-merchant config; zero brand literals.

**Tech Stack:** Firebase Cloud Functions (Node, `onRequest`), RTDB (owners + reverse index), Firestore (`meta/source`), Firebase Auth (web SDK via CDN), Netlify.

## Global Constraints

Copied verbatim from the spec (`docs/superpowers/specs/2026-09-07-portal-2b2-menu-editor-design.md`). Every task implicitly includes these.

- **BRAND-AGNOSTIC (HARD):** No `rid === 'x_pizza'` / `'la_musa'` (or equivalent) literal in any new code, unless it is a lookup keyed off per-merchant config. The `usesPlatformFactura(rid)` `Set` pattern (`factura/eligibility.js`) is the canonical model. Every task's gate asks: *"would this work, unchanged, for a brand-new third merchant with only config?"*
- **Auth is server-authoritative.** Firebase Auth → `getIdToken` → bearer on every call; the server (`authorizeCatalogEdit`) decides. UI gating is cosmetic. Reject `auth.token.customer === true` before any read. Read outage → **503**, never 403.
- **Read-only slice.** This slice writes NOTHING to the catalog. The only new writes are the owner→restaurants reverse-index (a grant-time convenience mirror) — never money/fiscal.
- **No-regression.** Existing 2a / 2b-1 / catalog / fiscal / rewards suites stay green. New functions are additive reads; no existing handler changes.
- **Governance:** LOCAL-ONLY, per-task hand-back, TDD, frequent commits. Flag any source surprise rather than forcing the plan.

**Test command (from `xpizza-functions/`):** `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test`

---

## File Structure

**Backend (`xpizza-functions/`):**
- Create `catalog/owner-index.js` — pure `ownerGrantPaths(rid, uid)` + `readOwnerRestaurants(db, uid)` helpers (reverse index).
- Create `catalog/portal-reads.js` — `getMyRestaurantsCore` + `getEditableCatalogCore` (the two read handlers, deps injected).
- Create `tools/seed-owner.js` — grant an owner (writes BOTH `restaurants/{rid}/owners/{uid}` and `owner_restaurants/{uid}/{rid}`), idempotent; used to backfill the existing owner.
- Modify `index.js` — wire `exports.getMyRestaurants`, `exports.getEditableCatalog` (mirror the `editCatalog` onRequest wiring at `index.js:5854`).
- Tests: `catalog/owner-index.test.js`, `catalog/portal-reads.test.js`.

**Portal (`xpizza-portal/` — new folder):**
- `index.html` — app shell + login screen + master-detail container (styles lifted from the approved mock, read-only trim).
- `firebase.js` — Firebase web init + auth exports (config copied from an existing staff app).
- `auth.js` — login / logout / `onAuthStateChanged` / `getIdToken`.
- `api.js` — `apiFetch(fnName, {rid, body})` bearer client + typed error mapping; `pure` header/URL builder.
- `render.js` — pure `groupByCategory(source)` + read-only DOM render of categories/items/extras.
- `app.js` — orchestration: auth → `getMyRestaurants` → switcher → `getEditableCatalog` → render.
- `netlify.toml` — publish dir + headers.
- `api.test.mjs`, `render.test.mjs` — node-run unit tests for the pure helpers.

---

## Task 1: Owner→restaurants reverse index (pure helpers + grant tool)

**Files:**
- Create: `xpizza-functions/catalog/owner-index.js`
- Test: `xpizza-functions/catalog/owner-index.test.js`
- Create: `xpizza-functions/tools/seed-owner.js`

**Interfaces:**
- Produces: `ownerGrantPaths(rid, uid) → { [path]: true }` (multi-path RTDB update object); `readOwnerRestaurants(db, uid) → Promise<string[]>` (rids).

- [ ] **Step 1: Write the failing test**

```js
// catalog/owner-index.test.js
const { ownerGrantPaths } = require('./owner-index');
test('ownerGrantPaths mirrors owner + reverse index, brand-agnostic', () => {
  expect(ownerGrantPaths('any_merchant_3', 'uidABC')).toEqual({
    'restaurants/any_merchant_3/owners/uidABC': true,
    'owner_restaurants/uidABC/any_merchant_3': true,
  });
});
test('ownerGrantPaths rejects bad ids', () => {
  expect(() => ownerGrantPaths('', 'u')).toThrow();
  expect(() => ownerGrantPaths('r', '')).toThrow();
});
```

- [ ] **Step 2: Run it, confirm it fails** — `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npx jest catalog/owner-index -t ownerGrantPaths` → FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// catalog/owner-index.js
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const UID_RE = /^[A-Za-z0-9]{6,128}$/;
function ownerGrantPaths(rid, uid) {
  if (!RID_RE.test(String(rid))) throw new Error('bad_rid');
  if (!UID_RE.test(String(uid))) throw new Error('bad_uid');
  return {
    [`restaurants/${rid}/owners/${uid}`]: true,
    [`owner_restaurants/${uid}/${rid}`]: true,
  };
}
async function readOwnerRestaurants(db, uid) {
  if (!UID_RE.test(String(uid))) return [];
  const snap = await db.ref(`owner_restaurants/${uid}`).get();
  const val = snap.val() || {};
  return Object.keys(val).filter((rid) => val[rid] === true && RID_RE.test(rid));
}
module.exports = { ownerGrantPaths, readOwnerRestaurants, RID_RE, UID_RE };
```

- [ ] **Step 4: Run it, confirm PASS.**

- [ ] **Step 5: Grant tool** — `tools/seed-owner.js`: reads `RID`/`UID` from argv, applies `ownerGrantPaths` via a single `db.ref().update(paths)` (atomic), prints the paths, idempotent. Use the same Admin-REST + `X-Goog-User-Project` pattern as the existing driver-onboarding runbook (firebase-admin fails under ADC here). Include a header comment: existing owners must be backfilled by running this once per `(rid, uid)`.

- [ ] **Step 6: RTDB rules-guard test** — the reverse index becomes load-bearing (it gates which catalogs the portal loads), so prove it is not client-writable. RTDB rules deny-by-default already (grill: no write stanza for `restaurants/{rid}/owners` nor `owner_restaurants` in `database.rules.json`). Add an emulator rules test (or extend the existing rules test) asserting an authenticated NON-owner, a customer, and a dispatcher token are ALL denied `set` on `restaurants/{rid}/owners/{uid}` AND `owner_restaurants/{uid}/{rid}`. Both paths are written only by the admin `seed-owner` tool (Admin SDK bypasses rules).

- [ ] **Step 7: Commit** — `git add catalog/owner-index.js catalog/owner-index.test.js tools/seed-owner.js && git commit -m "feat(portal): owner→restaurants reverse index + grant tool + rules guard"`

---

## Task 2: `getMyRestaurants` read function

**Files:**
- Create: `xpizza-functions/catalog/portal-reads.js` (add `getMyRestaurantsCore`)
- Modify: `xpizza-functions/index.js` (wire `exports.getMyRestaurants`)
- Test: `xpizza-functions/catalog/portal-reads.test.js`

**Interfaces:**
- Consumes: `readOwnerRestaurants` (Task 1).
- Produces: `getMyRestaurantsCore({ db, verifyIdToken }, req) → sends { restaurants: [{ rid, name }] }`. Resolves display name from restaurant config (brand-agnostic — read a config path, never a literal).

- [ ] **Step 1: Write the failing test**

```js
// catalog/portal-reads.test.js
const { getMyRestaurantsCore } = require('./portal-reads');
function mkRes() { const r = { code: 0, body: null }; r.status = (c) => (r.code = c, r); r.json = (b) => (r.body = b, r); r.set = () => r; return r; }
function mkDb(map) { return { ref: (p) => ({ get: async () => ({ val: () => map[p] }) }) }; }

test('returns owner restaurants with display names (brand-agnostic)', async () => {
  const db = mkDb({
    'owner_restaurants/uid1': { merch_a: true, merch_b: true },
    'restaurants/merch_a/identity': { name: 'Merchant A' },
    'restaurants/merch_b/identity': { name: 'Merchant B' },
  });
  const req = { method: 'GET', headers: { authorization: 'Bearer t' } };
  const res = mkRes();
  await getMyRestaurantsCore({ db, verifyIdToken: async () => ({ uid: 'uid1' }) }, req, res);
  expect(res.body.restaurants).toEqual([
    { rid: 'merch_a', name: 'Merchant A' }, { rid: 'merch_b', name: 'Merchant B' },
  ]);
});
test('rejects customer token 403', async () => {
  const res = mkRes();
  await getMyRestaurantsCore({ db: mkDb({}), verifyIdToken: async () => ({ uid: 'u', customer: true }) },
    { method: 'GET', headers: { authorization: 'Bearer t' } }, res);
  expect(res.code).toBe(403);
});
test('read outage → 503', async () => {
  const db = { ref: () => ({ get: async () => { throw new Error('rtdb down'); } }) };
  const res = mkRes();
  await getMyRestaurantsCore({ db, verifyIdToken: async () => ({ uid: 'u' }) },
    { method: 'GET', headers: { authorization: 'Bearer t' } }, res);
  expect(res.code).toBe(503);
});
```

- [ ] **Step 2: Run it, confirm FAIL.**

- [ ] **Step 3: Implement** `getMyRestaurantsCore` in `portal-reads.js`:
  - Require `Authorization: Bearer <idToken>` → `verifyIdToken` → else 401.
  - `if (decoded.customer === true) return 403`.
  - `readOwnerRestaurants(db, decoded.uid)`; for each rid read `restaurants/{rid}/identity` → `{ rid, name: identity?.name || rid }` (the REAL identity path — grill confirmed via `restaurant-config.js`; `config/display` does not exist).
  - Wrap all reads in try/catch → any failure returns **503** (`{ error: 'read_unavailable' }`), never 403.
  - Sort by rid for determinism.

- [ ] **Step 4: Run it, confirm PASS.**

- [ ] **Step 5: Wire `exports.getMyRestaurants`** in `index.js` mirroring the `editCatalog` onRequest block (`index.js:5854`): inject `db = getDatabase()`, `verifyIdToken = getAuth().verifyIdToken`, GET only, CORS as the other staff endpoints.

- [ ] **Step 6: Commit** — `git commit -m "feat(portal): getMyRestaurants read (owner→restaurants)"`

---

## Task 3: `getEditableCatalog` read function

**Files:**
- Modify: `xpizza-functions/catalog/portal-reads.js` (add `getEditableCatalogCore`)
- Modify: `xpizza-functions/index.js` (wire `exports.getEditableCatalog`)
- Test: `xpizza-functions/catalog/portal-reads.test.js`

**Interfaces:**
- Consumes: `authorizeCatalogEdit` (`catalog/catalog-edit-auth.js`) — reused, but the portal read is **owner-only** (see Step 3); `sourceRefOf` (`catalog/source-store.js:31`) — the exact `restaurants/{rid}/meta/source` doc ref `editCatalog` CAS-writes; `validateSource` (`catalog/source-store.js`); the EXISTING `encodeUpdateTime` (export it from `edit-catalog-handler.js` if not already exported — do NOT create a new codec module, grill: churn risk).
- Produces: `getEditableCatalogCore({ db, fsdb, authorize, readActiveVersionId }, req) → { source, sourceUpdateTime, activeVersionId }`. `db` = RTDB (for `authorize`'s owner lookups); `fsdb` = Firestore (for the source doc).

- [ ] **Step 1: Write the failing test** — assert: (a) authorized OWNER gets `{ source, sourceUpdateTime, activeVersionId }`, `sourceUpdateTime` byte-identical to `editCatalog`'s `baseSourceUpdateTime` (`"seconds.nanoseconds"`, ns padded to 9); (b) authorize non-ok → its status (403/503); (c) **`role !== 'owner'` (e.g. a dispatcher grant) → 403 `not_owner`** — portal reads are owner-only; (d) **malformed source → fail-CLOSED 503** (not a normal load); (e) source read throw → 503.

```js
test('getEditableCatalog returns source + CAS-baseline updateTime for OWNER', async () => {
  const authorize = async () => ({ ok: true, rid: 'merch_a', uid: 'u', role: 'owner' });
  const source = { restaurant_id: 'merch_a', items: [], extras: [], structure: { categories: [], item_order: [] } };
  const sourceRef = { get: async () => ({ exists: true, data: () => source, updateTime: { seconds: 1788754374, nanoseconds: 634000000 } }) };
  const res = mkRes();
  await getEditableCatalogCore({
    db: {}, fsdb: {}, authorize, readActiveVersionId: async () => 'v-1788754374634',
    _sourceRefOf: () => sourceRef, _validateSource: () => {}, // inject or spy the real ones
  }, { method: 'GET', query: { restaurantId: 'merch_a' }, headers: {} }, res);
  expect(res.body.sourceUpdateTime).toBe('1788754374.634000000');
  expect(res.body.activeVersionId).toBe('v-1788754374634');
  expect(res.body.source).toEqual(source);
});
test('dispatcher (role !== owner) is rejected 403', async () => {
  const res = mkRes();
  await getEditableCatalogCore({ db:{}, fsdb:{}, authorize: async () => ({ ok:true, rid:'merch_a', uid:'u', role:'dispatcher' }),
    readActiveVersionId: async () => 'v', _sourceRefOf: () => ({ get: async () => ({}) }), _validateSource: () => {} },
    { method:'GET', query:{ restaurantId:'merch_a' }, headers:{} }, res);
  expect(res.code).toBe(403);
});
test('malformed source fails CLOSED 503, never a normal load', async () => {
  const res = mkRes();
  await getEditableCatalogCore({ db:{}, fsdb:{}, authorize: async () => ({ ok:true, rid:'merch_a', uid:'u', role:'owner' }),
    readActiveVersionId: async () => 'v',
    _sourceRefOf: () => ({ get: async () => ({ exists:true, data:()=>({bad:1}), updateTime:{seconds:1,nanoseconds:0} }) }),
    _validateSource: () => { throw new Error('source_invalid'); } },
    { method:'GET', query:{ restaurantId:'merch_a' }, headers:{} }, res);
  expect(res.code).toBe(503);
});
```

- [ ] **Step 2: Run it, confirm FAIL.**

- [ ] **Step 3: Implement** `getEditableCatalogCore` — order matters:
  - `const auth = await authorize(req, rid)` (reuses `authorizeCatalogEdit`: RID_RE, rejects `customer===true`, owner-tier for fiscal brands, **503 on membership-read outage**). On `!auth.ok` → return its status.
  - **Owner-only:** `if (auth.role !== 'owner') return 403 not_owner`. (Grill #1: `authorizeCatalogEdit` grants dispatchers ANY rid — a merchant portal read must not accept that cross-tenant path.)
  - `const ref = sourceRefOf(fsdb, rid)` → `const doc = await ref.get()`. If `!doc.exists` → 404 `source_absent`.
  - `const source = doc.data(); validateSource(source, rid)` — **on throw, fail CLOSED → 503** `source_unavailable` (Grill #10: never render malformed money data as an editable baseline). Do NOT return an unvalidated source.
  - `sourceUpdateTime = encodeUpdateTime(doc.updateTime)` (the EXISTING codec, imported — Grill #6).
  - `activeVersionId = await readActiveVersionId(fsdb, rid)`.
  - Return `{ source, sourceUpdateTime, activeVersionId }`. Any Firestore read throw → 503. **No writes.**

- [ ] **Step 4: Run it, confirm PASS.**

- [ ] **Step 5: Export the codec, no refactor** (Grill #6) — if `encodeUpdateTime` is module-local in `edit-catalog-handler.js`, add it to that file's `module.exports` and import it in `portal-reads.js`. Do NOT create a new module. Run the 2b-1 suite to prove no CAS regression: `npx jest edit-catalog publish-edited`.

- [ ] **Step 6: Wire `exports.getEditableCatalog`** in `index.js` (mirror `editCatalog` at `index.js:5854`): inject `db = getDatabase()` (RTDB — for `authorize`'s owner lookups; Grill #4, NOT getFirestore), `fsdb = getFirestore()` (source doc), `authorize = authorizeCatalogEdit({ db: getDatabase(), verifyIdToken: getAuth().verifyIdToken })`, `readActiveVersionId`. GET only.

- [ ] **Step 7: Commit** — `git commit -m "feat(portal): getEditableCatalog read (owner-only, validated, real source ref)"`

---

## Task 4: Portal scaffold + Firebase Auth login

**Files:**
- Create: `xpizza-portal/index.html`, `xpizza-portal/firebase.js`, `xpizza-portal/auth.js`

- [ ] **Step 1: Scaffold `index.html`** — lift the shell + styles from the approved mock at `docs/superpowers/assets/2026-09-07-portal-editor-mock.html` (in-repo), stripped to: the login screen (email + password + submit + error line) and the empty app container (`#view-menu` with rail + detail). Keep the sober palette, day/night tokens, Hanken. Remove ALL edit handlers/write UI and the mock's inline seed data (read-only, data comes from `getEditableCatalog`).

- [ ] **Step 2: `firebase.js`** — copy the **exact** Firebase web config (`apiKey`, `authDomain`, `projectId`, `databaseURL`, etc.) from an existing staff app that uses Firebase Auth (`xpizza-kitchen/index.html` Firebase init block — the source of truth). Import the modular SDK from the same CDN the staff apps use. Export `auth`.

- [ ] **Step 3: `auth.js`** — `login(email, pass)` (`signInWithEmailAndPassword`), `logout()`, `watchAuth(cb)` (`onAuthStateChanged`), `token()` (`getIdToken`). No logic beyond wrapping the SDK.

- [ ] **Step 4: Wire login** — submit → `login()`; on success show `#view-menu`, hide login; on `onAuthStateChanged(null)` show login. Map auth errors (`auth/invalid-credential` → "correo o contraseña incorrectos").

- [ ] **Step 5: Manual verification** — serve `xpizza-portal/` locally (`npx http-server` or Netlify dev), log in with the seeded owner account → login screen dismisses; wrong password → error line; reload keeps the session.

- [ ] **Step 6: Commit** — `git commit -m "feat(portal): scaffold + Firebase Auth login"`

---

## Task 5: API client + restaurant resolution

**Files:**
- Create: `xpizza-portal/api.js`, `xpizza-portal/app.js`
- Test: `xpizza-portal/api.test.mjs`

**Interfaces:**
- Produces: `buildRequest(fnName, { rid, body, tokenStr })` (pure) → `{ url, options }`; `apiFetch(fnName, opts)` (awaits `token()`, fetches, maps errors).

- [ ] **Step 1: Write the failing test** (node, run with `node --test api.test.mjs`)

```js
import { buildRequest } from './api.js';
import { test } from 'node:test'; import assert from 'node:assert';
test('buildRequest attaches bearer + rid, correct base', () => {
  const { url, options } = buildRequest('getEditableCatalog', { rid: 'merch_a', tokenStr: 'TK' });
  assert.match(url, /getEditableCatalog\?restaurantId=merch_a$/);
  assert.equal(options.headers.Authorization, 'Bearer TK');
});
```

- [ ] **Step 2: Run it, confirm FAIL** (`node --test xpizza-portal/api.test.mjs`).

- [ ] **Step 3: Implement `buildRequest` + `apiFetch`** — base URL = the functions region host the staff apps use (copy from `xpizza-kitchen`). `apiFetch` awaits `token()`, calls `buildRequest`, `fetch`, and maps status→typed error (`403 → NotAuthorized`, `503 → Unavailable`, `409 → Conflict`, else generic). Never throws raw.

- [ ] **Step 4: Run it, confirm PASS.**

- [ ] **Step 5: Restaurant resolution in `app.js`** — on auth: `getMyRestaurants` → render the sidebar switcher; select first (or `localStorage` remembered rid) → store as `currentRid`. If zero restaurants → an empty-state ("tu cuenta no administra ningún local todavía").

- [ ] **Step 6: Commit** — `git commit -m "feat(portal): api client + restaurant resolution"`

---

## Task 6: Render read-only master-detail menu

**Files:**
- Create: `xpizza-portal/render.js`
- Modify: `xpizza-portal/app.js`
- Test: `xpizza-portal/render.test.mjs`

**Interfaces:**
- Produces: `groupByCategory(source) → [{ category:{id,name}, items:[...] }]` (respects `structure.categories` order and `structure.item_order`); `renderMenu(rootEl, grouped, extras)`.

- [ ] **Step 1: Write the failing test**

```js
import { groupByCategory } from './render.js';
import { test } from 'node:test'; import assert from 'node:assert';
test('groups items by category, honoring category + item order', () => {
  const source = {
    items: [
      { key:'b', price:20, display:{ id:'b', cat:'c1', name:'B' } },
      { key:'a', price:10, display:{ id:'a', cat:'c1', name:'A' } },
      { key:'z', price:30, display:{ id:'z', cat:'c2', name:'Z' } },
    ],
    structure: { categories:[{id:'c1',name:'Uno'},{id:'c2',name:'Dos'}], item_order:['a','b','z'] },
  };
  const g = groupByCategory(source);
  assert.deepEqual(g.map(x=>x.category.name), ['Uno','Dos']);
  assert.deepEqual(g[0].items.map(i=>i.display.name), ['A','B']); // item_order, not array order
});
```

- [ ] **Step 2: Run it, confirm FAIL.**

- [ ] **Step 3: Implement** `groupByCategory` (order items by `item_order` index, bucket by `display.cat`, iterate `structure.categories` in array order) + `renderMenu` (read-only DOM: category cards, item rows with name/price/desc; an Opcionales list from `source.extras`). Use the mock's markup/classes, no edit handlers.

- [ ] **Step 4: Run it, confirm PASS.**

- [ ] **Step 5: Wire in `app.js`** — after `getEditableCatalog(currentRid)` → `renderMenu(...)`. Switching restaurant in the switcher re-fetches + re-renders. Handle `Unavailable`/`NotAuthorized` with a banner (read-only degrade, never a false editor).

- [ ] **Step 6: Commit** — `git commit -m "feat(portal): read-only master-detail menu render"`

---

## Task 7: Netlify config + deploy wiring + smoke

**Files:**
- Create: `xpizza-portal/netlify.toml`

- [ ] **Step 1: `netlify.toml`** — `publish = "xpizza-portal"`, security headers (CSP allowing the Firebase + functions hosts only), SPA fallback to `index.html`.

- [ ] **Step 2: Deploy wiring** — this is a **new** Netlify site (per `netlify-deploy-mechanics`: per-folder sites; always pass explicit `--site`; the repo links to CATERING by default). Document the new site id in the toml/README. Deploy is git-CD once linked, but the FIRST link/site-create is an **owner action** — hand back with the exact commands, do not run.

- [ ] **Step 3: Smoke checklist** (owner-run after deploy):
  - Seeded owner logs in → sees their live menu, read-only, correct prices/categories/extras.
  - The switcher lists exactly the owner's restaurants (backfilled via `seed-owner`).
  - Unauthenticated → login gate. Customer account → `getMyRestaurants` empty / `getEditableCatalog` 403.
  - Second (config-only) merchant, if seeded, renders identically — **brand-agnostic proof**.

- [ ] **Step 4: Commit** — `git commit -m "chore(portal): netlify config + deploy wiring"`

---

## Self-Review

- **Spec coverage:** §7 slice 2b-2a (shell+auth+read + `getEditableCatalog`) → Tasks 2–7; the spec's "read endpoint does not exist yet" gap → Task 3; multi-tenant restaurant resolution → Tasks 1–2, 5. Availability/editor/publish are later slices (2b-2b/c/d), out of this plan by design.
- **Brand-agnostic:** Tasks 1–3 tests use `merch_a`/`merch_b`/`any_merchant_3` — no `x_pizza`/`la_musa` literal anywhere; Task 7 smoke includes the third-merchant proof.
- **Placeholder scan:** none — every step has concrete code or a concrete command/verification.
- **Type consistency:** `sourceUpdateTime` is the `"seconds.nanoseconds"` string in Task 3, matching `editCatalog`'s `baseSourceUpdateTime` (2b-1) so 2b-2c can pass it straight back through the CAS. `ownerGrantPaths`/`readOwnerRestaurants` (Task 1) are the exact names consumed in Task 2.
- **Open item for the executor to confirm from source (flag if wrong):** the exact Firestore path of the editable source doc (`restaurants/{rid}/catalog/meta/source` vs whatever `edit-catalog-handler.js` actually CAS-writes) and the current-active-version read helper — Task 3 must read the SAME doc `editCatalog` writes, verbatim.

---

## Execution Handoff

Per governance, this plan is built by the **owner's executor session**, not advisor subagents. Next step: the advisor relays this plan (+ the spec + the mock file) to the executor; the executor builds task-by-task LOCAL-ONLY, handing back per task for advisor source-audit + codex gate; the owner deploys. Heaviest gate lands later at 2b-2c (publish); this slice's gate is auth-correctness + read-only safety + the brand-agnostic proof.
