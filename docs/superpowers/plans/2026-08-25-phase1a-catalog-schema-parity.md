> # ✅ CONVERGED — safe to build (banner cleared 2026-08-25, advisor)
> This executable plan has been **refreshed to the converged `PLAN.md`** (Codex adversarial review
> APPROVED round 3). All Act-1 grill + Act-2 Codex fixes are folded into the tasks below: transform
> round-trip is NOT the money proof (T2/T6); seed writes the profile **LAST** + **allowlists** profile
> fields (T4); `getRestaurantDocs` **validates every doc** + throws `catalog_empty` (T6); the drift case
> **renames a key** so it actually exercises reconcile (T6); **post-seed production verification** added
> (T8). Design rationale: `PLAN.md`; findings + adjudication: `PLAN-REVIEW-LOG.md`; ADR: `docs/adr/0005-firestore-catalog-under-restaurants.md`.
> **Phase-1b precondition recorded (do not inherit silently):** the profile-written-last seed is safe
> ONLY because nothing reads the catalog in 1a; once a live reader exists, a re-seed briefly deletes/rewrites
> underneath it → 1b needs versioned-publish (write a new version, flip a pointer) or a no-reads-during-seed window.

# Phase 1a — Catalog schema + seed + reader + parity (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax. **Governance:** built by the "Sherpa Last Mile Delivery app executor" session; audited + codex-grill-gated by the advisor session. **NOT deployed by the executor.**

**Goal:** Represent the two live Restaurants' menu/extras pricing as a **Firestore catalog** under `restaurants/{restaurant_id}` and prove — via the **emulator round-trip (Task 6): seed a real Firestore → read it back through real read code → byte-compare vs the live code tables** — that the catalog reproduces today's prices EXACTLY, both Restaurants. Purely additive: NO cutover, the live pricing path still uses `menu-pricing.js`. (Converged with `PLAN.md` + `PLAN-REVIEW-LOG.md`; ADR 0005.)

**Architecture:** Pure, unit-tested transforms (`codeTablesToCatalogDocs` ⇄ `buildTablesFromDocs`) encode/decode the pricing tables losslessly (their in-memory round-trip is a transform-correctness guard, **NOT** the money proof — it's an identity that passes on an all-zero menu). **THE MONEY PROOF is the emulator round-trip (Task 6)** exercising the real seed-write, doc IDs, and read path. A DI'd reader (`catalog.js`) caches only on success + signals failure; the importable seed (`seed-catalog-core.js`) reconciles stale docs, allowlists profile fields, and writes the profile LAST; Firestore rules enumerate the public menu subcollections (no wildcard); `tools/verify-catalog.js` proves the real production seed landed.

**Tech Stack:** Firebase gen2 functions (Node 22), **Firestore** (new to this project — RTDB stays for real-time), node `assert` tests.

**Spec:** `docs/superpowers/specs/2026-08-25-phase1-data-driven-merchant-model-design.md`

## Global Constraints
- **MONEY-CRITICAL (pricing source of truth) → codex-grill gate.** Phase 1a is ADDITIVE ONLY: it must NOT change any price VALUE and MUST NOT touch the live pricing path (`computeServerTotal`, `menu-pricing.js` tables, `index.js` order intake). The parity test is the proof.
- **Two levels of check (grill Q2 fix — the in-memory round-trip is NOT the money proof):**
  1. **Transform-correctness unit test (Task 2, in-memory):** proves the pure transforms compose to identity. It **CANNOT** prove the catalog reproduces prices (the RHS is derived from the LHS — it passes even on an all-zero menu). Keep it as a cheap regression guard; do **NOT** call it "parity" or a money proof.
  2. **THE MONEY PROOF = the EMULATOR ROUND-TRIP (Task 6):** `seedCatalog(emulatorDb)` → the REAL `getRestaurantDocs(emulatorDb, rid)` (real Firestore reads) → `buildTablesFromDocs` must `deepStrictEqual` `MENU_BY_RESTAURANT[rid]` / `EXTRAS_BY_RESTAURANT[rid]`, **BOTH brands** — exercising the real seed-write, docId, and read path (the ONLY test that can fail on a real bug). Must be **FALSIFIABLE**: a mutated price/key AND a re-seed-drift case (rename a key, re-seed) must both be DETECTED (no stale doc survives).
- **Pricing key parity:** x_pizza tables are keyed by item NAME, la_musa by item ID. The transforms are **key-agnostic** — they carry whatever the table key is, verbatim — so both brands round-trip without special-casing. Do NOT change `itemPricingKey` (not in scope).
- **Price unit unchanged:** the catalog stores each table's value **exactly as-is** (whole lempiras, the current unit) — the transform is unit-agnostic; never convert.
- **Firestore doc-id safety:** item/extra doc IDs are a sanitized/deterministic id; the EXACT table key is stored in a `key` field that the reader uses. Never derive the pricing key from the doc id.
- **No client writes to the catalog** (server/admin only); menu is public-read.
- Do NOT deploy. Handback → advisor + codex grill → owner deploys.

## File Structure
- Create `xpizza-functions/catalog/catalog-transform.js` — pure `buildTablesFromDocs` + `codeTablesToCatalogDocs` (Task 1)
- Create `xpizza-functions/catalog/catalog-transform.test.js` — transform unit tests (Task 1) + transform round-trip test (Task 2)
- Create `xpizza-functions/catalog/catalog.js` — DI'd pure reader + cache (Task 3)
- Create `xpizza-functions/catalog/catalog.test.js` — reader test with a fake Firestore (Task 3)
- Create `xpizza-functions/catalog/seed-catalog-core.js` — importable `seedCatalog(db)` + `catalogDocsForRestaurant` + `docId` w/ stale-doc reconcile (Task 4)
- Create `xpizza-functions/catalog/seed-catalog-core.test.js` — pure doc-derivation test (Task 4)
- Create `xpizza-functions/tools/seed-catalog.js` — thin CLI wrapper over `seedCatalog` (Task 4)
- Create `xpizza-functions/firestore.rules` + modify `xpizza-functions/firebase.json` (add `firestore` w/ predeploy — the ONLY firebase.json; keys = database+functions, no hosting) + `test/catalog-rules.emulator.test.js` + `test:catalog-rules` script — catalog rules (Task 5)
- Create `xpizza-functions/catalog/catalog-firestore.js` — real `getRestaurantDocs(db, restaurantId)` read adapter (Task 6)
- Create `xpizza-functions/test/catalog-parity.emulator.test.js` + `package.json` `test:catalog-parity` script — THE emulator round-trip money proof (Task 6)

**Interfaces produced:**
- `buildTablesFromDocs(itemDocs, extraDocs) → { menu, extras }` (T1)
- `codeTablesToCatalogDocs(menuTable, extraTable) → { itemDocs, extraDocs }` (T1)
- `createCatalogReader({ getRestaurantDocs, cacheTtlMs, now }) → { getTables(restaurantId) }` (T3)
- `seedCatalog(db, restaurants) → Promise` (importable, DI'd db, reconciles stale docs) + `catalogDocsForRestaurant(menuTable, extraTable)` + `docId(key)` (T4)
- `getRestaurantDocs(db, restaurantId) → { itemDocs, extraDocs }` (real Firestore read adapter) (T6)

---

### Task 1: Pure catalog transforms (encode ⇄ decode the pricing tables)

**Files:** Create `xpizza-functions/catalog/catalog-transform.js` · Test `xpizza-functions/catalog/catalog-transform.test.js`

- [ ] **Step 1: Write the failing test**
```js
const assert = require('assert');
const { buildTablesFromDocs, codeTablesToCatalogDocs } = require('./catalog-transform');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// buildTablesFromDocs: docs (each {key, price}) → the {key: price} table shape
const items = [{ key: 'Margherita', price: 299 }, { key: 'Pepperoni', price: 307 }];
const extras = [{ key: 'Extra Cheese', price: 40 }];
const tables = buildTablesFromDocs(items, extras);
assert.deepStrictEqual(tables, { menu: { Margherita: 299, Pepperoni: 307 }, extras: { 'Extra Cheese': 40 } });
ok('buildTablesFromDocs → {key: price} tables');

// codeTablesToCatalogDocs: table → docs (the inverse)
const docs = codeTablesToCatalogDocs({ Margherita: 299, Pepperoni: 307 }, { 'Extra Cheese': 40 });
assert.deepStrictEqual(docs.itemDocs.sort((a,b)=>a.key<b.key?-1:1), [{ key: 'Margherita', price: 299 }, { key: 'Pepperoni', price: 307 }]);
assert.deepStrictEqual(docs.extraDocs, [{ key: 'Extra Cheese', price: 40 }]);
ok('codeTablesToCatalogDocs → docs');

// round-trip identity (id-keyed brand too: keys are opaque)
const laMenu = { dimsum_01: 223, dimsum_02: 248 };
const rt = buildTablesFromDocs(codeTablesToCatalogDocs(laMenu, {}).itemDocs, []);
assert.deepStrictEqual(rt.menu, laMenu);
ok('round-trip is identity (key-agnostic: works for id-keyed la_musa)');

// empty extras → empty object, not undefined
assert.deepStrictEqual(buildTablesFromDocs([], []), { menu: {}, extras: {} });
ok('empty → {menu:{}, extras:{}}');
console.log(`catalog-transform: OK (${n})`);
```
- [ ] **Step 2: Run — FAIL** — `node xpizza-functions/catalog/catalog-transform.test.js` → "Cannot find module"
- [ ] **Step 3: Implement** `xpizza-functions/catalog/catalog-transform.js`
```js
'use strict';
// PURE, dependency-free. Lossless encode/decode between a pricing TABLE ({key: price}) and Firestore
// DOCS ([{key, price}]). Key-agnostic: the key is whatever the table uses (x_pizza NAME / la_musa ID),
// carried verbatim. Price value is carried as-is (never unit-converted). This is the money-safety core:
// buildTablesFromDocs(codeTablesToCatalogDocs(T)) must equal T exactly.
function buildTablesFromDocs(itemDocs, extraDocs) {
  const toTable = (docs) => {
    const t = {};
    for (const d of (docs || [])) { if (d && typeof d.key === 'string') t[d.key] = d.price; }
    return t;
  };
  return { menu: toTable(itemDocs), extras: toTable(extraDocs) };
}
function codeTablesToCatalogDocs(menuTable, extraTable) {
  const toDocs = (table) => Object.entries(table || {}).map(([key, price]) => ({ key, price }));
  return { itemDocs: toDocs(menuTable), extraDocs: toDocs(extraTable) };
}
module.exports = { buildTablesFromDocs, codeTablesToCatalogDocs };
```
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(catalog): pure table<->docs transforms (lossless, key-agnostic)"`

---

### Task 2: Transform round-trip unit test (transform correctness — NOT the end-to-end money proof)

**Files:** Modify `xpizza-functions/catalog/catalog-transform.test.js` (append)

> ⚠️ **Grill Q2:** this test proves the pure transforms are mutual inverses. It is **NOT** the money proof — it passes even on an all-zero or wrong menu (RHS derived from LHS). The real proof that the catalog reproduces prices is the **emulator round-trip in Task 6**. Keep this as a cheap transform-regression guard only.

- [ ] **Step 1: Write the test** (append)
```js
// ── Transform correctness (NOT parity): the pure transforms are mutual inverses on the live tables. ──
// This does NOT prove the CATALOG reproduces prices (no Firestore here) — Task 6's emulator round-trip does.
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
for (const rid of ['x_pizza', 'la_musa']) {
  const menu = MENU_BY_RESTAURANT[rid];
  const extras = EXTRAS_BY_RESTAURANT[rid] || {};
  const back = buildTablesFromDocs(...Object.values(codeTablesToCatalogDocs(menu, extras)).length
    ? [codeTablesToCatalogDocs(menu, extras).itemDocs, codeTablesToCatalogDocs(menu, extras).extraDocs] : [[], []]);
  assert.deepStrictEqual(back.menu, menu, `${rid} menu transform round-trip`);
  assert.deepStrictEqual(back.extras, extras, `${rid} extras transform round-trip`);
  ok(`transform round-trip ${rid}: ${Object.keys(menu).length} items + ${Object.keys(extras).length} extras`);
}
```
- [ ] **Step 2: Run — green** (`node xpizza-functions/catalog/catalog-transform.test.js`). This confirms transform correctness only.
- [ ] **Step 3: Commit** — `git commit -m "test(catalog): transform round-trip unit test (transform correctness; NOT the money proof)"`

---

### Task 3: DI'd Firestore catalog reader (+ cache)

**Files:** Create `xpizza-functions/catalog/catalog.js` · Test `xpizza-functions/catalog/catalog.test.js`

**Interfaces:** Consumes `buildTablesFromDocs` (T1). Produces `createCatalogReader({ getRestaurantDocs, cacheTtlMs, now })` → `{ getTables(restaurantId) }`. `getRestaurantDocs(restaurantId)` is injected (returns `{ itemDocs, extraDocs }` read from Firestore) so the reader is pure-testable.

- [ ] **Step 1: Write the failing test**
```js
const assert = require('assert');
const { createCatalogReader } = require('./catalog');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

let calls = 0;
const fakeDocs = { x_pizza: { itemDocs: [{ key: 'Margherita', price: 299 }], extraDocs: [] } };
const getRestaurantDocs = async (rid) => { calls++; return fakeDocs[rid] || { itemDocs: [], extraDocs: [] }; };
let t = 1000;
const reader = createCatalogReader({ getRestaurantDocs, cacheTtlMs: 60000, now: () => t });

(async () => {
  const tables = await reader.getTables('x_pizza');
  assert.deepStrictEqual(tables, { menu: { Margherita: 299 }, extras: {} });
  ok('getTables → {menu, extras} from injected docs');
  await reader.getTables('x_pizza');
  assert.strictEqual(calls, 1, 'second read within TTL is cached (no extra fetch)');
  ok('cache hit within TTL');
  t += 60001;
  await reader.getTables('x_pizza');
  assert.strictEqual(calls, 2, 'read after TTL refetches');
  ok('cache expires after TTL');
  // grill Q5 — a failing source PROPAGATES and is NOT cached (1b needs a fail signal, not a cached empty)
  let boom = 0;
  const failReader = createCatalogReader({ getRestaurantDocs: async () => { boom++; throw new Error('firestore down'); }, cacheTtlMs: 60000, now: () => 9000 });
  await assert.rejects(() => failReader.getTables('x_pizza'), /firestore down/);
  await assert.rejects(() => failReader.getTables('x_pizza'), /firestore down/);
  assert.strictEqual(boom, 2, 'failure is NOT cached — each call re-invokes the source');
  ok('read failure propagates + is not cached (grill Q5)');
  console.log(`catalog reader: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
```
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** `xpizza-functions/catalog/catalog.js`
```js
'use strict';
const { buildTablesFromDocs } = require('./catalog-transform');
// Reads a restaurant's pricing tables from the (injected) Firestore doc source, shaped exactly like
// menu-pricing.js's MENU_BY_RESTAURANT[rid]/EXTRAS_BY_RESTAURANT[rid]. Bounded per-restaurant cache.
// CONTRACT (grill Q5): a read failure / not-found from getRestaurantDocs PROPAGATES (throws) and is
// NEVER cached — only SUCCESSFUL lookups are cached. So 1b can fall back to the code tables on failure
// instead of caching a plausible-empty non-answer (which would mislead as "unknown menu item" during a
// catalog outage and downgrade the "unknown restaurant" guard, since {} is truthy).
function createCatalogReader({ getRestaurantDocs, cacheTtlMs = 300000, now = Date.now }) {
  const cache = new Map(); // restaurantId -> { at, tables }
  async function getTables(restaurantId) {
    const hit = cache.get(restaurantId);
    if (hit && (now() - hit.at) < cacheTtlMs) return hit.tables;
    const { itemDocs, extraDocs } = await getRestaurantDocs(restaurantId); // throw propagates → NOT cached
    const tables = buildTablesFromDocs(itemDocs, extraDocs);
    cache.set(restaurantId, { at: now(), tables });                        // cache ONLY on success
    return tables;
  }
  return { getTables };
}
module.exports = { createCatalogReader };
```
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** — `git commit -m "feat(catalog): DI'd Firestore catalog reader with bounded cache"`

---

### Task 4: Seed — IMPORTABLE `seedCatalog(db)` core (+ thin CLI) with stale-doc RECONCILE

**Files:** Create `xpizza-functions/catalog/seed-catalog-core.js` (importable, DI'd db — so the Task 6 emulator test can call it) · Create `xpizza-functions/tools/seed-catalog.js` (thin CLI wrapper) · Test `xpizza-functions/catalog/seed-catalog-core.test.js` (pure derivation)

> ⚠️ **Grill Q2:** (a) the seed logic must be **importable** (the old top-level IIFE that calls `initializeApp`/`process.exit` can't be tested); (b) it must **RECONCILE stale docs** — a re-seed after a key rename/removal must DELETE the old doc, else the catalog returns an extra item at a stale price. Task 6 proves both.

- [ ] **Step 1: Failing test** (`seed-catalog-core.test.js`) — the pure doc derivation (the write I/O is proven in T6):
```js
const assert = require('assert');
const { catalogDocsForRestaurant, docId } = require('./seed-catalog-core');
let n=0; const ok=(l)=>console.log(`  ✓ ${++n} ${l}`);
const d = catalogDocsForRestaurant({ Margherita: 299 }, { 'Extra Cheese': 40 });
assert.deepStrictEqual(d.itemDocs, [{ id: docId('Margherita'), key: 'Margherita', price: 299 }]);
assert.deepStrictEqual(d.extraDocs, [{ id: docId('Extra Cheese'), key: 'Extra Cheese', price: 40 }]);
ok('catalogDocsForRestaurant → docs with deterministic id + exact key + price');
assert.strictEqual(docId('Cacio e Pepe'), docId('Cacio e Pepe'), 'docId deterministic'); ok('docId stable');
assert.notStrictEqual(docId('a'), docId('b')); ok('distinct keys → distinct ids');
console.log(`seed-core: OK (${n})`);
```
- [ ] **Step 2: Run — FAIL** · [ ] **Step 3: Implement** `xpizza-functions/catalog/seed-catalog-core.js`
```js
'use strict';
const crypto = require('crypto');
const { codeTablesToCatalogDocs } = require('./catalog-transform');
// Deterministic Firestore-safe doc id (item NAMEs contain spaces/&; hash avoids doc-id restrictions).
const docId = (key) => crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 20);
// Pure: code tables → the doc set (each doc carries its target id + the EXACT pricing key + price).
function catalogDocsForRestaurant(menuTable, extraTable) {
  const { itemDocs, extraDocs } = codeTablesToCatalogDocs(menuTable, extraTable || {});
  const withId = (docs) => docs.map((d) => ({ id: docId(d.key), key: d.key, price: d.price }));
  return { itemDocs: withId(itemDocs), extraDocs: withId(extraDocs) };
}
// Codex: the profile doc is PUBLIC-read + the Admin SDK BYPASSES Firestore rules → an allowlist here is
// the ONLY thing that keeps private/payout data off the public profile. Reject any non-allowlisted field.
const PROFILE_FIELDS = new Set(['name', 'tier', 'active', 'hours', 'branding', 'pricing_key_mode']);
// IMPORTABLE writer (DI'd Firestore db). RECONCILES stale docs (re-seed after a rename/removal deletes the
// old doc). Writes the PROFILE LAST — so on a FIRST seed, profile.exists ⇒ a COMPLETE seed (an interrupted
// seed leaves no profile → getRestaurantDocs throws restaurant_not_found, safe, never a plausible-empty).
async function seedCatalog(db, restaurants) {
  for (const [rid, meta] of Object.entries(restaurants)) {
    const bad = Object.keys(meta.profile || {}).filter((k) => !PROFILE_FIELDS.has(k));
    if (bad.length) throw new Error(`profile field not allowlisted for ${rid}: ${bad.join(',')}`);   // no private data on the public doc
    const { itemDocs, extraDocs } = catalogDocsForRestaurant(meta.menu, meta.extras);
    const rref = db.collection('restaurants').doc(rid);
    for (const [sub, docs] of [['menu_items', itemDocs], ['extras', extraDocs]]) {   // subcollections FIRST
      const col = rref.collection(sub);
      const wantIds = new Set(docs.map((d) => d.id));
      const existing = await col.get();
      const batch = db.batch();
      existing.forEach((snap) => { if (!wantIds.has(snap.id)) batch.delete(snap.ref); });   // reconcile stale
      for (const d of docs) batch.set(col.doc(d.id), { key: d.key, price: d.price });
      await batch.commit();
    }
    await rref.set(meta.profile, { merge: true });   // profile LAST — completeness marker on a first seed
  }
}
module.exports = { seedCatalog, catalogDocsForRestaurant, docId, PROFILE_FIELDS };
```
(Batch cap note: each `menu_items`/`extras` set is well under Firestore's 500-op batch limit for the 2 flagship brands; if a future restaurant exceeds it, chunk per-subcollection — out of scope now.)
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5:** Create the thin CLI `xpizza-functions/tools/seed-catalog.js`:
```js
'use strict';
// CLI wrapper — seeds the LIVE catalog from menu-pricing tables. ADDITIVE (nothing reads it yet).
// Run (controlled, owner/advisor post-gate): node tools/seed-catalog.js
require('dotenv').config();
const admin = require('firebase-admin');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { seedCatalog } = require('../catalog/seed-catalog-core');
const RESTAURANTS = {
  x_pizza: { profile: { name: 'X. Pizza', tier: 'flagship', pricing_key_mode: 'name', active: true }, menu: MENU_BY_RESTAURANT.x_pizza, extras: EXTRAS_BY_RESTAURANT.x_pizza },
  la_musa: { profile: { name: 'La Musa', tier: 'flagship', pricing_key_mode: 'id',   active: true }, menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa },
};
admin.initializeApp({ credential: admin.credential.applicationDefault() });
seedCatalog(admin.firestore(), RESTAURANTS)
  .then(() => { console.log('catalog seed complete (additive)'); process.exit(0); })
  .catch((e) => { console.error('seed failed:', e && e.message); process.exit(1); });
```
`node --check xpizza-functions/tools/seed-catalog.js` clean. **Do NOT run against prod** (controlled owner op post-gate).
- [ ] **Step 6: Commit** — `git commit -m "feat(catalog): importable seedCatalog(db) with stale-doc reconcile + thin CLI"`

---

### Task 5: Firestore rules — catalog public-read, deny client writes

**Files:** Create `firestore.rules` · Modify `firebase.json` (add firestore config if absent)

- [ ] **Step 1:** Create `firestore.rules` — **grill Q3a: ENUMERATE the public menu subcollections; NO recursive wildcard** (a `/{sub=**}` public-read would silently expose every future subcollection — e.g. Phase-4 `payouts`/`ledger` — to the internet). Also: the **profile doc carries PUBLIC fields only** (name/hours/branding/tier/active) — payout/private data must NEVER live on a public-read path (see spec note; it goes to a server-only path in Phase 4).
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Catalog — PUBLIC-READ menu display (profile + menu_items + extras); all writes SERVER/ADMIN ONLY
    // (Admin SDK bypasses rules). NO recursive wildcard: any OTHER subcollection under a restaurant
    // (Phase-4 payouts/ledger/private) is deny-by-default until a later phase opens it EXPLICITLY.
    match /restaurants/{restaurantId} {
      allow read: if true;                                              // profile: public fields ONLY
      allow write: if false;
      match /menu_items/{itemId} { allow read: if true; allow write: if false; }
      match /extras/{extraId}    { allow read: if true; allow write: if false; }
      // deliberately NO `match /{sub=**}` — unenumerated subpaths (payouts, ledger, private) → deny.
    }
    match /{document=**} { allow read, write: if false; }               // global default-deny
  }
}
```
- [ ] **Step 2:** Ensure **`xpizza-functions/firebase.json`** (grill Q3b — the ONLY firebase.json; it lives under `xpizza-functions/`, not the repo root; keys are `database` + `functions`, there is NO `hosting` key) has a `firestore` section with a **predeploy guard** (grill Q3c — mirror the existing `database.predeploy` `check:rules`; Firestore rules must not ship unverified):
```json
"firestore": { "rules": "firestore.rules", "predeploy": ["npm --prefix \"$RESOURCE_DIR\" run test:catalog-rules", "npm --prefix \"$RESOURCE_DIR\" run test:catalog-parity"] }
```
(Add `firestore.rules` at `xpizza-functions/firestore.rules` next to `database.rules.json`. Leave `database`/`functions` unchanged. This is consistent with T6, which also targets `xpizza-functions/firebase.json`.)
- [ ] **Step 3:** Rules test — add `xpizza-functions/test/catalog-rules.emulator.test.js` (`@firebase/rules-unit-testing`, mirror the existing RTDB emulator-rules-test pattern; header documents `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:catalog-rules`) asserting: (a) unauth `get` on `restaurants/x_pizza` ALLOWED; (b) unauth `get` on `restaurants/x_pizza/menu_items/x` ALLOWED; (c) client `set` on `restaurants/x_pizza` DENIED; (d) client `set` on `restaurants/x_pizza/menu_items/x` DENIED; **(e) grill Q3a regression guard — unauth `get` AND client `set` on `restaurants/x_pizza/payouts/2026-09` BOTH DENIED** (proves the money tree is server-only by default). Add the `test:catalog-rules` script to `package.json`: `firebase emulators:exec --only firestore --project demo-xpizza "node test/catalog-rules.emulator.test.js"`. **Do NOT deploy rules** — owner post-gate.
- [ ] **Step 4: Commit** — `git commit -m "feat(catalog): Firestore rules — enumerate public menu subcollections (no wildcard), payouts deny-by-default, predeploy guard + emulator test"`

---

### Task 6: EMULATOR ROUND-TRIP — the real money proof (seed → real read → deepStrictEqual live tables)

**Files:** Create `xpizza-functions/catalog/catalog-firestore.js` (real `getRestaurantDocs(db, restaurantId)`) · Create `xpizza-functions/test/catalog-parity.emulator.test.js` · Modify `xpizza-functions/package.json` (add `test:catalog-parity` script) · Modify `xpizza-functions/firebase.json` (add `firestore` emulator/rules if absent)

> This is the grill Q2 fix: the ONLY test that exercises the REAL seed-write + docId + Firestore-read path and can fail on a real bug. **Feasibility confirmed by advisor:** the repo already runs ~15 `firebase emulators:exec --only database` tests; openjdk is installed (`/opt/homebrew/opt/openjdk`, off-PATH — the team's known "needs openjdk PATH" setup); Task 5's rules test already stands up the Firestore emulator. Still **ADDITIVE** — `getRestaurantDocs` is called only by this test, nothing live.

- [ ] **Step 1:** Implement `xpizza-functions/catalog/catalog-firestore.js` (the real read adapter):
```js
'use strict';
// Real Firestore read adapter for the catalog. Returns the {itemDocs, extraDocs} shape the pure
// buildTablesFromDocs (catalog-transform.js) consumes. Wired into createCatalogReader in 1b (not yet live).
// The TRUST BOUNDARY (Codex): malformed data must NEVER read back as a plausible success. Distinguishes
// restaurant_not_found (no profile) from catalog_empty (profile but no items) from a genuine read; and
// VALIDATES every doc — non-string/missing key, duplicate key, and any price that isn't a non-negative
// INTEGER are rejected (a non-integer price would reach `total += menu[key]*qty` in 1b → {total:NaN, error:null}).
async function getRestaurantDocs(db, restaurantId) {
  const rref = db.collection('restaurants').doc(restaurantId);
  const [profile, items, extras] = await Promise.all([rref.get(), rref.collection('menu_items').get(), rref.collection('extras').get()]);
  if (!profile.exists) throw new Error(`restaurant_not_found: ${restaurantId}`);   // not-found ≠ empty
  if (items.empty) throw new Error(`catalog_empty: ${restaurantId}`);              // known restaurant, no menu items
  const map = (snap) => {
    const seen = new Set();
    return snap.docs.map((d) => {
      const v = d.data() || {};
      if (typeof v.key !== 'string' || !v.key) throw new Error(`catalog_bad_doc: ${restaurantId}/${d.id} — missing/non-string key`);
      if (!Number.isInteger(v.price) || v.price < 0) throw new Error(`catalog_bad_doc: ${restaurantId}/${v.key} — price not a non-negative integer`);
      if (seen.has(v.key)) throw new Error(`catalog_dup_key: ${restaurantId}/${v.key}`);
      seen.add(v.key);
      return { key: v.key, price: v.price };
    });
  };
  return { itemDocs: map(items), extraDocs: map(extras) };
}
module.exports = { getRestaurantDocs };
```
- [ ] **Step 2: Write the emulator test** `xpizza-functions/test/catalog-parity.emulator.test.js` (header documents the run cmd + openjdk-PATH note):
```js
'use strict';
// THE MONEY PROOF. Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:catalog-parity
// Seeds a REAL (emulated) Firestore from the live tables, reads it back via the REAL adapter, and asserts
// byte-identical to MENU_BY_RESTAURANT/EXTRAS_BY_RESTAURANT — both brands. Plus falsifiability + re-seed drift.
const assert = require('assert');
const admin = require('firebase-admin');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { seedCatalog } = require('../catalog/seed-catalog-core');
const { getRestaurantDocs } = require('../catalog/catalog-firestore');
const { buildTablesFromDocs } = require('../catalog/catalog-transform');

admin.initializeApp({ projectId: 'demo-xpizza' }); // FIRESTORE_EMULATOR_HOST set by emulators:exec
const db = admin.firestore();
const R = (over = {}) => ({
  x_pizza: { profile: { name: 'X. Pizza', tier: 'flagship' }, menu: over.x_pizza || MENU_BY_RESTAURANT.x_pizza, extras: EXTRAS_BY_RESTAURANT.x_pizza },
  la_musa: { profile: { name: 'La Musa', tier: 'flagship' }, menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa },
});
(async () => {
  let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
  // (1) THE PROOF — seed live tables, read via the real adapter, assert byte-identical both brands
  await seedCatalog(db, R());
  for (const rid of ['x_pizza', 'la_musa']) {
    const back = buildTablesFromDocs(...Object.values(await getRestaurantDocs(db, rid)));
    assert.deepStrictEqual(back.menu, MENU_BY_RESTAURANT[rid], `${rid} menu catalog==code`);
    assert.deepStrictEqual(back.extras, EXTRAS_BY_RESTAURANT[rid] || {}, `${rid} extras catalog==code`);
    ok(`PARITY(emulator) ${rid}: ${Object.keys(back.menu).length} items round-trip byte-identical`);
  }
  // (2) FALSIFIABILITY — a mutated PRICE must be detected (proves the parity assertion can fail on a value)
  const firstKey = Object.keys(MENU_BY_RESTAURANT.x_pizza)[0];
  await seedCatalog(db, R({ x_pizza: { ...MENU_BY_RESTAURANT.x_pizza, [firstKey]: 99999 } }));
  const mutated = buildTablesFromDocs(...Object.values(await getRestaurantDocs(db, 'x_pizza')));
  assert.notDeepStrictEqual(mutated.menu, MENU_BY_RESTAURANT.x_pizza, 'mutated price MUST be detected');
  assert.strictEqual(mutated.menu[firstKey], 99999, 'catalog reflects the mutation');
  ok('falsifiable: a mutated price is detected');
  // (3) RECONCILE — Codex: must RENAME a key, NOT mutate a price. A rename gives a NEW hashed doc id and
  //     ORPHANS the old one; a price mutation reuses the same id (overwrite, no orphan) and never exercises
  //     the batch.delete reconcile branch. Seed a rename → then a clean re-seed MUST delete the orphan.
  const renamed = { ...MENU_BY_RESTAURANT.x_pizza }; const val = renamed[firstKey];
  delete renamed[firstKey]; renamed[`${firstKey} (RENAMED)`] = val;
  await seedCatalog(db, R({ x_pizza: renamed }));                                    // creates the orphan (old id stale)
  await seedCatalog(db, R());                                                         // clean re-seed MUST reconcile it away
  const healed = buildTablesFromDocs(...Object.values(await getRestaurantDocs(db, 'x_pizza')));
  assert.deepStrictEqual(healed.menu, MENU_BY_RESTAURANT.x_pizza, 're-seed reconciles the orphan; byte-identical');
  assert.strictEqual(Object.keys(healed.menu).length, Object.keys(MENU_BY_RESTAURANT.x_pizza).length, 'no orphan survives — exact item count');
  ok('reconcile: a renamed-key orphan is DELETED on re-seed (actually exercises batch.delete)');
  // (4) NOT-FOUND ≠ empty (grill Q5): an unseeded restaurant THROWS, never returns a silent {}
  await assert.rejects(() => getRestaurantDocs(db, 'never_seeded'), /restaurant_not_found/);
  ok('not-found restaurant → throws (not a silent empty)');
  console.log(`catalog-parity(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('PARITY FAILED:', e && e.message); process.exit(1); });
```
- [ ] **Step 3:** Add to `xpizza-functions/package.json` scripts (mirror the existing `--only database` scripts, but `--only firestore`):
```json
"test:catalog-parity": "firebase emulators:exec --only firestore --project demo-xpizza \"node test/catalog-parity.emulator.test.js\""
```
Ensure `firebase.json` has `"firestore": { "rules": "firestore.rules" }` (from T5) so the emulator loads rules; the Admin SDK bypasses rules so the seed/read work regardless.
- [ ] **Step 4: Run — PASS** — `PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:catalog-parity` → all green (both-brand parity + falsifiable + re-seed-drift). **If the Firestore emulator does not start, STOP and report** (the one confirm-before-committing item) — do not fake it.
- [ ] **Step 5: Commit** — `git commit -m "test(catalog): emulator round-trip — THE money proof (seed->real read->byte-identical, both brands, falsifiable)"`

---

### Task 7: Wire the new tests into the ONLY gates (grill Q4 — no CI in this repo)

**Files:** Modify `xpizza-functions/package.json` (the `test` script + the `test:catalog-*` scripts)

> ⚠️ **Grill Q4:** there is NO CI (`.github/workflows` does not exist) — `npm test` is the ONLY automated gate, and the repo already wires guard/parity tests into it (`menu-parity.test.js`, `rewards-parity.guard.test.js`, `restaurants-rules.guard.test.js`). Un-wired tests prove the catalog was correct ONCE on a laptop, then silently rot. The emulator money proof is bound into `firestore.predeploy` (Task 5) so a deploy can't ship past a failing parity.

- [ ] **Step 1:** Append the three PURE catalog tests to the end of the `"test"` script chain in `package.json` (they need no emulator, so they belong in `npm test`):
```
 && node catalog/catalog-transform.test.js && node catalog/catalog.test.js && node catalog/seed-catalog-core.test.js
```
- [ ] **Step 2:** Confirm the emulator tests are BOTH bound into `firestore.predeploy` (Task 5) — `test:catalog-rules` AND `test:catalog-parity` — so `firebase deploy --only firestore` re-runs the rules + the money proof before shipping. (They stay separate `test:*` scripts, matching the existing `--only database` emulator scripts which are also not in the plain `npm test`.)
- [ ] **Step 3: Run** `npm test` → the three new pure tests run + pass with the existing suite. Commit — `git commit -m "test(catalog): wire pure catalog tests into npm test; bind emulator proof into firestore.predeploy (no-CI gate)"`

---

### Task 8: Post-seed PRODUCTION verification — `tools/verify-catalog.js` (REQUIRED gate step)

**Files:** Create `xpizza-functions/tools/verify-catalog.js`

> Codex: the emulator (T6) proves the CODE path; nothing proves that the seed the owner actually runs **against production** landed correctly. This read-only check reads the real Firestore catalog and byte-compares to the code tables — a **required** owner gate step, not optional.

- [ ] **Step 1:** Create `xpizza-functions/tools/verify-catalog.js`:
```js
'use strict';
// READ-ONLY post-seed PRODUCTION verification. After the owner runs the seed, this reads the real
// Firestore catalog back and compares counts/keys/prices to menu-pricing.js — prints a diff, exits
// NON-ZERO on any mismatch. The emulator proves the CODE; only this proves the PRODUCTION seed landed.
// Run (owner, post-seed, pre-rules-deploy): node tools/verify-catalog.js
require('dotenv').config();
const admin = require('firebase-admin');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { getRestaurantDocs } = require('../catalog/catalog-firestore');
const { buildTablesFromDocs } = require('../catalog/catalog-transform');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
(async () => {
  let bad = 0;
  for (const rid of ['x_pizza', 'la_musa']) {
    const back = buildTablesFromDocs(...Object.values(await getRestaurantDocs(db, rid)));
    for (const [label, got, want] of [['menu', back.menu, MENU_BY_RESTAURANT[rid]], ['extras', back.extras, EXTRAS_BY_RESTAURANT[rid] || {}]]) {
      for (const k of new Set([...Object.keys(got), ...Object.keys(want)])) {
        if (got[k] !== want[k]) { bad++; console.error(`MISMATCH ${rid}.${label}[${JSON.stringify(k)}]: catalog=${got[k]} code=${want[k]}`); }
      }
    }
    console.log(`${rid}: ${Object.keys(back.menu).length} items + ${Object.keys(back.extras).length} extras checked`);
  }
  if (bad) { console.error(`verify-catalog FAILED: ${bad} mismatch(es)`); process.exit(1); }
  console.log('verify-catalog: production catalog == code tables ✓'); process.exit(0);
})().catch((e) => { console.error('verify-catalog error:', e && e.message); process.exit(1); });
```
- [ ] **Step 2:** `node --check xpizza-functions/tools/verify-catalog.js` clean. (Runs against real Firestore — owner op post-seed, NOT the executor.)
- [ ] **Step 3: Commit** — `git commit -m "feat(catalog): read-only post-seed production verification (required gate step)"`

---

## Self-Review
- **Spec coverage:** schema + seed w/ reconcile + profile-LAST + field-allowlist (T4) · pure transforms + transform-correctness test (T1/T2) · pure reader w/ fail-signal contract (T3) · Firestore rules (T5) · **the real money proof = emulator round-trip w/ doc-validation + catalog_empty + RENAME-drift (T6)** · **wired into the only gates (T7)** · **post-seed prod verification (T8)** · NO cutover / additive (live pricing path untouched) — all mapped. ✅
- **No placeholders:** real transforms, real importable seed w/ stale-doc reconcile, real Firestore read adapter, real emulator round-trip that CAN fail (falsifiable + drift cases), real rules. ✅
- **Type consistency:** `buildTablesFromDocs`/`codeTablesToCatalogDocs`/`catalogDocsForRestaurant`/`seedCatalog`/`getRestaurantDocs` signatures + the `{key, price}` doc / `{menu, extras}` table shapes consistent across T1–T6. ✅
- **Money-safety (grill Q2):** the money proof is the EMULATOR round-trip (T6), NOT the in-memory transform test (T2, explicitly not called parity); additive only (real read code called by nothing live); live pricing path untouched; values verbatim; catalog client-write denied; re-seed reconciles stale docs. ✅

## Gate & deploy (post-build)
Handback (branch @ SHA, files, test counts, **the emulator round-trip result — both-brand parity + falsifiable + drift**) → advisor audit + **codex grill** (money-adjacent: confirm the emulator round-trip is the real proof + falsifiable, additive-only, no live-pricing-path change, rules deny client write, seed reconciles). Then OWNER: **enable Firestore — ⚠️ grill Q3d, IRREVERSIBLE:** create the Firestore database in **Native mode**, location **`us-central1`** (a single region — do NOT accept the console's common `nam5` multi-region default). The Firestore location is **PERMANENT and cannot be changed after creation**; functions + RTDB are all `us-central1`, so `nam5` would permanently split the catalog from the functions that read it on the 1b money path (cross-region latency + cost, unfixable without a data migration to a new project). Then → run the seed (controlled) → **run `node tools/verify-catalog.js` against production and confirm it is GREEN** (Task 8 — proves the real seed landed byte-identical; do NOT proceed on any mismatch) → deploy `firestore.rules` (predeploy re-runs `test:catalog-rules` + `test:catalog-parity`). NO functions/pricing cutover in 1a — that's Phase 1b.

## Out of scope (later sub-phases)
1b server pricing reads the catalog (money cutover, parity runtime-guard) · 1c forms source menu from catalog · 1d retire code tables + POS consolidation · merchant editing UI/onboarding/ledger (Phases 3–4).
