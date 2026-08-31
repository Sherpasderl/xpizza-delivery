/**
 * Behavioral suite for the Firestore CATALOG rules (Phase 1a, Task 5).
 *
 * Run against the Firestore emulator:
 *   PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:catalog-rules
 *     = firebase emulators:exec --only firestore --project demo-xpizza \
 *         "node test/catalog-rules.emulator.test.js"
 *
 * Asserts: the catalog is publicly READABLE (menu display) and NOT client-writable, and — the
 * grill Q3a regression guard — that an UNENUMERATED subcollection under a restaurant (the
 * Phase-4 payouts/ledger tree) is denied by default, because the rules deliberately contain no
 * recursive `match /{sub=**}` wildcard.
 *
 * Includes Codex F6: doc ids are sha1 hashes, so a real client can never `get` a menu item by id —
 * it MUST `list`/query the collection. Rules are therefore asserted for LIST, not only GET.
 *
 * Plain-node style (no jest) to match the repo's existing `node *.test.js` tests.
 */
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, collection, getDocs } = require('firebase/firestore');

const RULES = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-xpizza',
    firestore: { rules: RULES, host: '127.0.0.1', port: 8080 },
  });

  // Seed via the rules-bypassing admin context so there is something real to read back.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'restaurants/x_pizza'), { name: 'X. Pizza', tier: 'flagship', active: true });
    await setDoc(doc(db, 'restaurants/x_pizza/menu_items/abc123'), { key: 'Margherita', price: 299 });
    await setDoc(doc(db, 'restaurants/x_pizza/extras/def456'), { key: 'Mozzarella', price: 50 });
    await setDoc(doc(db, 'restaurants/x_pizza/payouts/2026-09'), { amount_hnl: 125000, bank: 'REDACTED' });
    // 1c-b2 versioned-publish server-only paths
    await setDoc(doc(db, 'restaurants/x_pizza/versions/v-1/menu_items/abc123'), { key: 'Margherita', price: 299 });
    await setDoc(doc(db, 'restaurants/x_pizza/versions/v-1'), { version: 'v-1', item_count: 1 });
    await setDoc(doc(db, 'restaurants/x_pizza/meta/active_version'), { version: 'v-1' });
    await setDoc(doc(db, 'restaurants/x_pizza/meta/publish_lock'), { owner_token: 't' });
  });

  const anon = env.unauthenticatedContext().firestore();

  // ── PUBLIC READ: the menu must be readable by an unauthenticated client ──
  await assertSucceeds(getDoc(doc(anon, 'restaurants/x_pizza')));
  ok('unauth GET restaurants/x_pizza (profile) ALLOWED');
  await assertSucceeds(getDoc(doc(anon, 'restaurants/x_pizza/menu_items/abc123')));
  ok('unauth GET a menu_item ALLOWED');
  // Codex F6 — hashed doc ids mean real clients LIST rather than GET-by-id.
  await assertSucceeds(getDocs(collection(anon, 'restaurants/x_pizza/menu_items')));
  ok('unauth LIST menu_items ALLOWED (required: doc ids are hashes, clients cannot guess them)');
  await assertSucceeds(getDocs(collection(anon, 'restaurants/x_pizza/extras')));
  ok('unauth LIST extras ALLOWED');

  // ── CLIENT WRITES DENIED everywhere in the catalog ──
  await assertFails(setDoc(doc(anon, 'restaurants/x_pizza'), { name: 'pwned' }));
  ok('client SET on the profile DENIED');
  await assertFails(setDoc(doc(anon, 'restaurants/x_pizza/menu_items/abc123'), { key: 'Margherita', price: 1 }));
  ok('client SET on a menu_item DENIED (a price cannot be rewritten from a browser)');
  await assertFails(setDoc(doc(anon, 'restaurants/x_pizza/extras/def456'), { key: 'Mozzarella', price: 1 }));
  ok('client SET on an extra DENIED');

  // ── grill Q3a REGRESSION GUARD: the money tree is deny-by-default (no recursive wildcard) ──
  await assertFails(getDoc(doc(anon, 'restaurants/x_pizza/payouts/2026-09')));
  ok('unauth GET restaurants/x_pizza/payouts/* DENIED (Phase-4 money tree stays private)');
  await assertFails(getDocs(collection(anon, 'restaurants/x_pizza/payouts')));
  ok('unauth LIST restaurants/x_pizza/payouts DENIED');
  await assertFails(setDoc(doc(anon, 'restaurants/x_pizza/payouts/2026-09'), { amount_hnl: 0 }));
  ok('client SET restaurants/x_pizza/payouts/* DENIED');
  await assertFails(getDoc(doc(anon, 'restaurants/x_pizza/ledger/entry1')));
  ok('unauth GET an arbitrary future subcollection DENIED (deny-by-default holds)');

  // ── 1c-b2 REGRESSION GUARD: the VERSIONED catalog is server-only (no public-read wildcard) ──
  await assertFails(getDoc(doc(anon, 'restaurants/x_pizza/versions/v-1')));
  ok('unauth GET a version-record DENIED (versions/** is server-only)');
  await assertFails(getDocs(collection(anon, 'restaurants/x_pizza/versions')));
  ok('unauth LIST versions DENIED');
  await assertFails(getDoc(doc(anon, 'restaurants/x_pizza/versions/v-1/menu_items/abc123')));
  ok('unauth GET a version menu_item DENIED (no versions/{v}/{sub=**} public wildcard — the 1a Q3a lesson)');
  await assertFails(getDoc(doc(anon, 'restaurants/x_pizza/meta/active_version')));
  ok('unauth GET meta/active_version (the pointer) DENIED');
  await assertFails(getDoc(doc(anon, 'restaurants/x_pizza/meta/publish_lock')));
  ok('unauth GET meta/publish_lock DENIED (readers never touch the lock)');
  await assertFails(setDoc(doc(anon, 'restaurants/x_pizza/meta/active_version'), { version: 'pwned' }));
  ok('client SET meta/active_version DENIED (only the Admin SDK flips the pointer)');

  // ── global default-deny outside the catalog ──
  await assertFails(getDoc(doc(anon, 'anything_else/x')));
  ok('unauth GET outside /restaurants DENIED (global default-deny)');

  await env.cleanup();
  console.log(`catalog-rules(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('RULES TEST FAILED:', e && e.message); process.exit(1); });
