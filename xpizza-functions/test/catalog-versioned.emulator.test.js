'use strict';
// Phase 1c-b2 — VERSIONED PUBLISH money-proof + lease/concurrency/crash + completeness + pointer-absent-vs-
// error + fail-safe + cache + rollback + preview + retention, against a REAL (emulated) Firestore.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:catalog-versioned
const assert = require('assert');
const admin = require('firebase-admin');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { buildCatalogV2 } = require('../catalog/form-menu-source');
const { seedCatalog } = require('../catalog/seed-catalog-core');
const { buildTablesFromDocs } = require('../catalog/catalog-transform');
const { getRestaurantDocs, getActiveVersionId, readVersionDocs } = require('../catalog/catalog-firestore');
const { getRestaurantMenu } = require('../catalog/catalog-menu');
const { createCatalogReader } = require('../catalog/catalog');
const { createPricingResolver } = require('../catalog/pricing-tables');
const {
  publishVersion, rollbackVersion, previewVersion, pruneRetention,
  acquireLease, flipPointer, releaseLease, serverNow, writeVersion,
} = require('../catalog/catalog-publish');

admin.initializeApp({ projectId: 'demo-xpizza' });   // FIRESTORE_EMULATOR_HOST set by emulators:exec
const db = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const versionsCol = (rid) => db.collection('restaurants').doc(rid).collection('versions');
const pointerRef = (rid) => db.collection('restaurants').doc(rid).collection('meta').doc('active_version');
const lockRef = (rid) => db.collection('restaurants').doc(rid).collection('meta').doc('publish_lock');
const read = async (rid) => { const d = await getRestaurantDocs(db, rid); return buildTablesFromDocs(d.itemDocs, d.extraDocs); };
// A synthetic version (no display) — exercises the PRICING path (getRestaurantDocs) + structure bijection.
const mkVersion = (menu, extras = {}) => {
  const items = Object.entries(menu).map(([key, price]) => ({ key, price }));
  return { items, structure: { schema_version: 2, item_order: items.map((i) => i.key) }, extras, source_sha: 'test' };
};
// The REAL guarded resolver over the REAL version-aware reader — exactly index.js's wiring.
const buildReader = (codeMap = null) => {
  const alarms = [];
  const resolver = createPricingResolver({
    reader: createCatalogReader({
      getRestaurantDocs: (rid) => getRestaurantDocs(db, rid),
      getActiveVersionId: (rid) => getActiveVersionId(db, rid),
    }),
    codeFor: (rid) => (codeMap && codeMap[rid]) || { menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] },
    alarm: (k, d) => alarms.push([k, d]),
  });
  return { resolver, alarms };
};

(async () => {
  const V2 = { x_pizza: buildCatalogV2('x_pizza'), la_musa: buildCatalogV2('la_musa') };

  // ── (1) MONEY-PROOF (PIN-E extension) — publish v1 from code → the REAL reader resolves the pointer →
  //        byte-identical to code, both brands; identity-proven it came from Firestore; zero alarms ──
  for (const rid of ['x_pizza', 'la_musa']) {
    const r = await publishVersion(db, rid, { items: V2[rid].items, structure: V2[rid].structure, extras: EXTRAS_BY_RESTAURANT[rid], source_sha: 'v1' });
    assert.ok(r.versionId && r.item_count === Object.keys(MENU_BY_RESTAURANT[rid]).length, 'publish returns versionId + counts');
    const { resolver, alarms } = buildReader();
    const t = await resolver.getPricingTables(rid);
    assert.deepStrictEqual(t.menu, MENU_BY_RESTAURANT[rid], `${rid} version menu == code`);
    assert.deepStrictEqual(t.extras, EXTRAS_BY_RESTAURANT[rid], `${rid} version extras == code`);
    assert.notStrictEqual(t.menu, MENU_BY_RESTAURANT[rid], `${rid}: served menu is the FIRESTORE-read version, not the in-code singleton`);
    assert.deepStrictEqual(alarms, [], `${rid}: zero alarms — parity holds through the pointer`);
    ok(`MONEY-PROOF ${rid}: publishVersion v1 → reader resolves pointer → byte-identical to code (identity-proven), zero alarms`);
  }

  // ── (2) MONEY-PROOF FALSIFIABILITY — a diverged VERSION → the 1b guard serves CODE + parity alarm ──
  {
    const firstKey = Object.keys(MENU_BY_RESTAURANT.x_pizza)[0];
    const mutated = V2.x_pizza.items.map((i) => (i.key === firstKey ? { ...i, price: 99999 } : i));
    await publishVersion(db, 'x_pizza', { items: mutated, structure: V2.x_pizza.structure, extras: EXTRAS_BY_RESTAURANT.x_pizza, source_sha: 'bad' });
    const { resolver, alarms } = buildReader();
    const t = await resolver.getPricingTables('x_pizza');
    assert.strictEqual(t.menu[firstKey], MENU_BY_RESTAURANT.x_pizza[firstKey], 'CODE price serves, never the diverged version price');
    assert.strictEqual(t.menu, MENU_BY_RESTAURANT.x_pizza, 'on mismatch the returned menu IS the in-code table');
    assert.strictEqual(alarms[0][0], 'catalog_parity_mismatch');
    ok('FALSIFIABLE: a diverged published version → CODE tables + catalog_parity_mismatch (customer never mispriced)');
    // restore x_pizza to the good version for later
    await publishVersion(db, 'x_pizza', { items: V2.x_pizza.items, structure: V2.x_pizza.structure, extras: EXTRAS_BY_RESTAURANT.x_pizza, source_sha: 'v-restore' });
  }

  // ── (3) DISPLAY reader via the pointer — the version's items + structure round-trip ──
  {
    const snap = await getRestaurantMenu(db, 'la_musa');   // resolves the pointer → the version subtree
    assert.strictEqual(snap.items.length, V2.la_musa.items.length, 'display reader returns every item via the pointer');
    assert.ok(snap.items[0].display && snap.items[0].display.name, 'display records carried on the version');
    ok('DISPLAY reader resolves the pointer → the version menu + structure (bijection intact)');
  }

  // ── (4) ATOMIC FLIP — docs written BEFORE the flip; a mid-publish reader sees the OLD version ──
  {
    const rid = 'flip_shop';
    const v1 = (await publishVersion(db, rid, mkVersion({ A: 10 }))).versionId;
    const tok = await acquireLease(db, rid);
    const { versionId: v2 } = await writeVersion(db, rid, mkVersion({ A: 20 }), await serverNow(db, rid));   // written, NOT flipped
    assert.strictEqual((await read(rid)).menu.A, 10, 'mid-publish reader sees the OLD version (v2 docs written, pointer not flipped)');
    assert.strictEqual(await getActiveVersionId(db, rid), v1, 'pointer still v1 before the flip');
    await flipPointer(db, rid, tok, v2);
    await releaseLease(db, rid, tok);
    assert.strictEqual((await read(rid)).menu.A, 20, 'after the atomic flip the reader sees the NEW version');
    ok('ATOMIC FLIP: version docs written before the flip; reader sees OLD until the pointer moves, NEW after');
  }

  // ── (5) COMPLETENESS-ON-READ — torn menu / torn extras / tampered price each THROW (separate hashes) ──
  {
    const rid = 'complete_shop';
    await publishVersion(db, rid, mkVersion({ A: 10, B: 20 }, { X: 5 }));
    const active = await getActiveVersionId(db, rid);
    const vref = versionsCol(rid).doc(active);
    const items = await vref.collection('menu_items').get();
    const itemRef = items.docs[0].ref; const itemData = items.docs[0].data();
    await itemRef.set({ ...itemData, price: itemData.price + 1 });                                    // tampered menu price
    await assert.rejects(() => readVersionDocs(db, rid, active), /catalog_incomplete_menu_hash/);
    await itemRef.set(itemData);
    await itemRef.delete();                                                                            // torn menu read
    await assert.rejects(() => readVersionDocs(db, rid, active), /catalog_incomplete_item_count/);
    await itemRef.set(itemData);
    const extras = await vref.collection('extras').get();
    const exRef = extras.docs[0].ref; const exData = extras.docs[0].data();
    await exRef.delete();                                                                              // torn extras read
    await assert.rejects(() => readVersionDocs(db, rid, active), /catalog_incomplete_extra_count/);
    await exRef.set(exData);
    await exRef.set({ ...exData, price: exData.price + 1 });                                           // tampered extras price
    await assert.rejects(() => readVersionDocs(db, rid, active), /catalog_incomplete_extras_hash/);
    await exRef.set(exData);
    ok('COMPLETENESS: torn menu (count) / tampered menu (hash) / torn extras (count) / tampered extras (hash) ALL throw — each side caught');
  }

  // ── (6) POINTER-ABSENT vs ERROR — the split, never conflated ──
  {
    // (a) clean pointer-absent + flat PRESENT → serves the FLAT catalog
    await seedCatalog(db, { flat_shop: { profile: { name: 'F', tier: 'flagship' }, menu: { A: 10 }, extras: {} } });
    assert.strictEqual((await read('flat_shop')).menu.A, 10, 'clean pointer-absent + flat present → flat served (zero-window migration)');
    ok('POINTER-ABSENT (a): clean not-found + flat present → serves the FLAT layout');
    // (b) clean pointer-absent + flat ABSENT → throw restaurant_not_found
    await assert.rejects(() => getRestaurantDocs(db, 'never_shop'), /restaurant_not_found/);
    ok('POINTER-ABSENT (b): clean not-found + flat absent → THROW restaurant_not_found (post-contract)');
    // (c) MALFORMED pointer → THROW (a fault, NOT flat)
    await pointerRef('malformed_shop').set({ oops: true });
    await assert.rejects(() => getRestaurantDocs(db, 'malformed_shop'), /active_version_malformed/);
    ok('ERROR (c): malformed pointer (no version field) → THROW (never silently falls to flat)');
    // (c') pointer → MISSING version → THROW
    await pointerRef('dangling_shop').set({ version: 'ghost', at: FieldValue.serverTimestamp() });
    await assert.rejects(() => getRestaurantDocs(db, 'dangling_shop'), /version_missing/);
    ok('ERROR (c\'): pointer to a missing version → THROW version_missing');
  }

  // ── (7) FAIL-SAFE NEVER-DROP — an ERROR state through the 1b guard serves CODE + alarm (byte-same as a
  //        catalog-fault today). A completeness fault must NOT drop or plausible-empty ──
  {
    const CODE = { failsafe_shop: { menu: { A: 10 }, extras: {} } };
    await publishVersion(db, 'failsafe_shop', mkVersion({ A: 10 }));
    const active = await getActiveVersionId(db, 'failsafe_shop');
    const vitems = await versionsCol('failsafe_shop').doc(active).collection('menu_items').get();
    await vitems.docs[0].ref.delete();                                     // torn read on the ACTIVE version
    const { resolver, alarms } = buildReader(CODE);
    const t = await resolver.getPricingTables('failsafe_shop');
    assert.deepStrictEqual(t.menu, { A: 10 }, 'completeness fault → CODE tables (never a drop, never a plausible-empty)');
    assert.strictEqual(alarms[0][0], 'catalog_read_failed', 'the throw fail-safes to code + catalog_read_failed');
    ok('FAIL-SAFE never-drop: a torn ACTIVE version → the 1b guard serves CODE + catalog_read_failed (no drop/empty)');
  }

  // ── (8) LEASE mutual exclusion (deterministic) — a live lease refuses a second acquirer; free → acquired ──
  {
    const rid = 'mutex_shop';
    const a = await acquireLease(db, rid);
    await assert.rejects(() => acquireLease(db, rid), /publish_locked/);   // held + unexpired (server time) → refused
    await releaseLease(db, rid, a);
    const b = await acquireLease(db, rid);                                  // now free → acquired
    assert.ok(b && b !== a, 'a fresh lease token after release');
    await releaseLease(db, rid, b);
    ok('LEASE: a live lease refuses a second acquirer (CAS, publish_locked); released → re-acquirable');
  }

  // ── (9) STALE-LEASE-CANNOT-FLIP (server time) — an EXPIRED lease cannot flip even though it OWNS the token ──
  {
    const rid = 'stale_shop';
    const t1 = await acquireLease(db, rid);
    const nowS = await serverNow(db, rid);
    await lockRef(rid).set({ owner_token: t1, acquired_at: nowS, expires_at: Timestamp.fromMillis(nowS.toMillis() - 60000) });   // force-expire by SERVER time
    await assert.rejects(() => flipPointer(db, rid, t1, 'anything'), /lease_expired/);
    ok('STALE-LEASE: an expired lease (server time) CANNOT flip even though owner_token matches — no client-clock bypass');
  }

  // ── (10) NO STALE-SNAPSHOT REVERT — after a reclaim, the OLD publisher (whose wall clock may think its
  //         lease is live) cannot flip: the reclaimer changed owner_token ──
  {
    const rid = 'reclaim_shop';
    const t1 = await acquireLease(db, rid);
    const nowS = await serverNow(db, rid);
    await lockRef(rid).set({ owner_token: t1, acquired_at: nowS, expires_at: Timestamp.fromMillis(nowS.toMillis() - 60000) });   // t1's lease expired
    const t2 = await acquireLease(db, rid);                                 // reclaim (expired) → new token
    assert.notStrictEqual(t1, t2, 'reclaim allocates a FRESH owner_token');
    const { versionId: vNew } = await writeVersion(db, rid, mkVersion({ A: 99 }), await serverNow(db, rid));
    await flipPointer(db, rid, t2, vNew);                                   // t2 flips → the newer version is live
    await assert.rejects(() => flipPointer(db, rid, t1, 'v_old'), /lease_lost|lease_expired/);   // stale t1 cannot revert
    assert.strictEqual((await read(rid)).menu.A, 99, 'the reclaimer\'s version stays live — no stale revert');
    await releaseLease(db, rid, t2);
    ok('NO REVERT: after a reclaim, the stale publisher\'s flip is rejected (owner_token changed) — no stale-snapshot revert');
  }

  // ── (11) CRASH RECOVERY — a publisher that acquired the lease + wrote docs then "died" → the lease
  //         expires → a later publisher reclaims + completes with a FRESH id; the orphan is never pointed to ──
  {
    const rid = 'crash_shop';
    const t1 = await acquireLease(db, rid);
    const { versionId: orphan } = await writeVersion(db, rid, mkVersion({ A: 1 }), await serverNow(db, rid));   // wrote docs, then crash (no flip, no release)
    const nowS = await serverNow(db, rid);
    await lockRef(rid).set({ owner_token: t1, acquired_at: nowS, expires_at: Timestamp.fromMillis(nowS.toMillis() - 1) });        // lease expires
    const res = await publishVersion(db, rid, mkVersion({ A: 2 }));         // reclaim + complete, fresh id
    assert.notStrictEqual(res.versionId, orphan, 'the recovering publish uses a FRESH id');
    assert.strictEqual(await getActiveVersionId(db, rid), res.versionId, 'the pointer points to the recovered version');
    assert.strictEqual((await read(rid)).menu.A, 2, 'the recovered version is live; the orphan was never pointed to');
    assert.ok((await versionsCol(rid).doc(orphan).get()).exists, 'the orphan docs still exist unpointed (retention-cleaned later)');
    ok('CRASH RECOVERY: expired lease → reclaim + fresh id; orphan pre-flip docs are unpointed; no deadlock');
  }

  // ── (12) CONCURRENT PUBLISH — two racing publishes never corrupt: the active version is always fully
  //         written + verified (the lease serializes the flip; create-not-exists guards the namespace) ──
  {
    const rid = 'concurrent_shop';
    const results = await Promise.allSettled([
      publishVersion(db, rid, mkVersion({ A: 1 })),
      publishVersion(db, rid, mkVersion({ A: 2 })),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.ok(fulfilled.length >= 1, 'at least one concurrent publish succeeds');
    const active = await getActiveVersionId(db, rid);
    await readVersionDocs(db, rid, active);                                 // throws if the active version were incomplete/overwritten
    ok(`CONCURRENT: two racing publishes (${fulfilled.length}/2 fulfilled) → the active version is fully-written + verified, never torn`);
  }
  {
    // create-not-exists fails loud on a re-used version id (nothing overwrites an immutable version)
    const ref = versionsCol('createonce_shop').doc('v-fixed');
    await ref.create({ x: 1 });
    await assert.rejects(() => ref.create({ x: 2 }), /already exists|ALREADY_EXISTS/i);
    ok('IMMUTABILITY: create-not-exists rejects a re-used version id (no blind overwrite of a version)');
  }

  // ── (13) VERSION-AWARE CACHE (emulator) — after a flip the reader serves the NEW version within the
  //         pointer TTL, not a stale one; a warm read hits the version cache ──
  {
    const rid = 'cache_shop';
    let clock = 1000;
    const reader = createCatalogReader({
      getRestaurantDocs: (r) => getRestaurantDocs(db, r),
      getActiveVersionId: (r) => getActiveVersionId(db, r),
      pointerTtlMs: 1000, now: () => clock,
    });
    await publishVersion(db, rid, mkVersion({ A: 10 }));
    assert.strictEqual((await reader.getTables(rid)).menu.A, 10, 'serves v1');
    await publishVersion(db, rid, mkVersion({ A: 20 }));                    // flip to v2
    assert.strictEqual((await reader.getTables(rid)).menu.A, 10, 'within the pointer TTL still v1 (bounded staleness)');
    clock += 1001;
    assert.strictEqual((await reader.getTables(rid)).menu.A, 20, 'after the pointer TTL the flip is picked up → v2');
    ok('CACHE: a flip is served within the pointer TTL, never stale beyond it (version-keyed, bounded)');
  }

  // ── (14) ROLLBACK — a single atomic flip to a retained prior version; target verified first ──
  {
    const rid = 'rollback_shop';
    const v1 = (await publishVersion(db, rid, mkVersion({ A: 10 }))).versionId;
    await publishVersion(db, rid, mkVersion({ A: 20 }));
    assert.strictEqual((await read(rid)).menu.A, 20, 'active is v2');
    await rollbackVersion(db, rid, v1);
    assert.strictEqual((await read(rid)).menu.A, 10, 'rollback flips the pointer back to v1');
    await assert.rejects(() => rollbackVersion(db, rid, 'nope'), /version_missing/);   // verify-before-flip
    ok('ROLLBACK: atomic pointer flip to a retained prior version; a missing target is rejected before any flip');
  }

  // ── (15) PREVIEW — read a NON-active version's snapshot; writes nothing, pointer unchanged ──
  {
    const rid = 'preview_shop';
    const v1 = (await publishVersion(db, rid, mkVersion({ A: 10 }))).versionId;
    const v2 = (await publishVersion(db, rid, mkVersion({ A: 20 }))).versionId;
    const before = await getActiveVersionId(db, rid);
    const snap = await previewVersion(db, rid, v1);
    assert.strictEqual(snap.items.find((i) => i.key === 'A').price, 10, 'preview reads the staged (non-active) v1');
    assert.strictEqual(await getActiveVersionId(db, rid), before, 'active_version UNCHANGED by preview');
    assert.strictEqual(before, v2, 'the live pointer still points at v2');
    assert.strictEqual((await read(rid)).menu.A, 20, 'the live reader still serves the active v2');
    ok('PREVIEW: generates from a non-active version; writes NOTHING to active_version');
  }

  // ── (16) RETENTION — keep ≥10 (or 30d, whichever larger); never the active/protected ──
  {
    const rid = 'retention_shop';
    for (let i = 0; i < 12; i++) await publishVersion(db, rid, mkVersion({ A: i }));
    assert.strictEqual((await versionsCol(rid).get()).size, 12, '12 versions exist (all within 30d → nothing pruned on publish)');
    // protect the active + prune with a clock 40 days ahead so the 30-day rule keeps nothing → newest-10 by count
    const active = await getActiveVersionId(db, rid);
    const future = () => Date.now() + 40 * 86400000;
    const { pruned } = await pruneRetention(db, rid, { protect: [active], now: future });
    assert.strictEqual((await versionsCol(rid).get()).size, 10, 'exactly the newest 10 retained');
    assert.strictEqual(pruned, 2, 'the 2 oldest pruned');
    assert.ok((await versionsCol(rid).doc(active).get()).exists, 'the active version is retained');
    // protect-the-active even when it is the OLDEST: rollback to the oldest survivor, prune → it survives
    const all = (await versionsCol(rid).get()).docs.map((d) => ({ id: d.id, c: d.data().created_at.toMillis() })).sort((a, b) => a.c - b.c);
    const oldest = all[0].id;
    await rollbackVersion(db, rid, oldest);
    await pruneRetention(db, rid, { protect: [oldest], now: future });
    assert.ok((await versionsCol(rid).doc(oldest).get()).exists, 'the active (now oldest) version is PROTECTED from prune');
    assert.strictEqual(await getActiveVersionId(db, rid), oldest, 'still active after prune');
    ok('RETENTION: keeps the newest ≥10; the active/protected version is never pruned even when oldest');
  }

  console.log(`catalog-versioned(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('VERSIONED FAILED:', e && e.stack || e); process.exit(1); });
