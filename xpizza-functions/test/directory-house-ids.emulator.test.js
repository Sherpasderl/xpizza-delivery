'use strict';
// S7a directory — HOUSE IDS END TO END (advisor, Codex directory r1 P2-2 follow-up): the REAL publisher mints the ids
// (publishVersion + backfillIdentities → the public menu's dish_id overlay) → the presentation writer stores them as `house`
// (tools/seed-presentation run, the shared shape validator) → the directory serves them UNCHANGED (the real makeDirectoryDeps
// readers: Firestore registry, getIdentity, loadSchedule, the presentation read). pricingView is the one injected stub (the
// delivery readers are wired in a later commit).
//   Both id routes, because they are keyed by rid (catalog/identity-registry GRANDFATHERED): x_pizza MINTS opaque uppercase
//   tokens; la_musa GRANDFATHERS its lowercase slugs. Synthetic emulator data under demo-xpizza, as add-product-groups does —
//   the code-sourced menus exist only for these two rids, so a tb_ rid cannot run the real publisher.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:directory-house-ids
require('./_emulator-required')('firestore', 'database');

const assert = require('assert');
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });
const db = admin.firestore();
const rtdb = admin.database();

const { publishVersion } = require('../catalog/catalog-publish');
const { sourceRefOf, canonicalize } = require('../catalog/source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildPublishCandidate } = require('../tools/publish-version');
const { getActivePointer } = require('../catalog/catalog-firestore');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { buildPublicMenu } = require('../catalog/public-menu');
const { createRestaurantRegistry, makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
const { presentationErrors } = require('../directory/presentation-shape');
const { makeDirectoryDeps } = require('../directory/directory-deps');
const { buildDirectory } = require('../directory/directory');
const SEED = require('../tools/seed-presentation');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('directory-house-ids(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const quiet = () => {};
const MINTED = /^[0-9A-HJKMNP-TV-Z]{10}$/;   // identity-registry ALPHABET (Crockford) × ID_LEN

async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe a non-emulator RTDB');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();
}
async function seedBrand(rid) {   // the same real publish path as add-product-groups.emulator.test.js
  await db.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
  await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'house-ids-seed' });
  await publishVersion(db, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(db, rid, catalogSnapshot(rid), { captured: await getActivePointer(db, rid) });
  // a routing-valid identity, so getIdentity serves it fresh (the directory lists only active, fresh-read stores)
  await rtdb.ref(`restaurants/${rid}/identity`).set({ name: `tb ${rid}`, active: true, version: 1, hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 5, phone: '+50400000000' });
}

(async () => {
  for (const [rid, route] of [['x_pizza', 'minted'], ['la_musa', 'grandfathered']]) {
    await wipe(); await seedBrand(rid);

    // 1. the PUBLISHER's ids, as the customer menu serves them
    const pm = await buildPublicMenu(db, rid, { known: new Set([rid]), isActive: async () => true });
    const served = pm.body.dishes.filter((d) => d && typeof d.dish_id === 'string');
    assert.ok(served.length >= 3, `DIRE-PUBLISHER-SERVES-IDS ${rid}: the public menu carries dish_id (got ${served.length})`);
    const house = served.slice(0, 3).map((d) => d.dish_id);
    if (route === 'minted') assert.ok(house.every((id) => MINTED.test(id)), `DIRE-MINTED-SHAPE ${rid}: ${JSON.stringify(house)}`);
    else assert.ok(house.every((id) => /[a-z]/.test(id) && !MINTED.test(id)), `DIRE-GRANDFATHERED-SHAPE ${rid}: ${JSON.stringify(house)}`);
    assert.deepStrictEqual(presentationErrors({ house }), [], `DIRE-SHAPE-ACCEPTS-PUBLISHER-IDS ${rid}`);

    // 2. the PRESENTATION WRITER stores them (real run(), against the emulator RTDB)
    const res = await SEED.run(rtdb, { [rid]: { house } }, { apply: true, force: false }, quiet);
    assert.deepStrictEqual(res[rid].write, ['house'], `DIRE-WRITER-WROTE-HOUSE ${rid}`);
    const stored = (await rtdb.ref(`restaurants/${rid}/presentation`).once('value')).val();
    assert.deepStrictEqual(stored.house, house, `DIRE-STORED-UNCHANGED ${rid} (order + case kept)`);

    // 3. the DIRECTORY serves them unchanged (real readers; registry floor empty so only this seeded brand is listed)
    const registry = createRestaurantRegistry({ listIds: makeFirestoreRegistryReader(db), floor: [] });
    const deps = makeDirectoryDeps({ rtdb, registry, pricingView: async () => ({ fee: { state: 'none' }, promo: null, coverage_km: null }) });
    const r = await buildDirectory(deps);
    assert.strictEqual(r.status, 200, `DIRE-DIRECTORY-200 ${rid}`);
    const entry = r.body.restaurants.find((e) => e.restaurant_id === rid);
    assert.ok(entry, `DIRE-LISTED ${rid}: ${JSON.stringify(r.body).slice(0, 300)}`);
    const wire = JSON.parse(JSON.stringify(r.body)).restaurants.find((e) => e.restaurant_id === rid);
    assert.deepStrictEqual(wire.house, house, `DIRE-HOUSE-SERVED-UNCHANGED ${rid}`);
    assert.ok(!entry.degraded.includes('house'), `DIRE-HOUSE-NOT-DEGRADED ${rid}`);

    // 4. every served house id resolves in the SAME restaurant's served menu (what the client MenuCache keeps)
    const menuIds = new Set(served.map((d) => d.dish_id));
    assert.ok(wire.house.every((id) => menuIds.has(id)), `DIRE-HOUSE-RESOLVES-IN-MENU ${rid}`);
    ok(`${rid} (${route}): publisher-minted dish ids → presentation writer → directory, served byte-for-byte; each resolves in the served menu`);
  }
  FINISHED = true;
  console.log(`directory-house-ids(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('directory-house-ids(emulator): FAILED —', e && e.stack || e); process.exit(1); });
