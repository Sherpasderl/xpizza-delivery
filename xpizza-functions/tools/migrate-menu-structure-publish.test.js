'use strict';
// PLAN 4 §8.2 — the --publish mode of tools/migrate-menu-structure.js (PROPOSAL-plan4-migration-publish-path.md, advisor-approved
// 2026-11-02): LIVE + only the absent reviewed rows, published with an activeVersionId CAS. On the fake Firestore with the REAL seed
// sources, the REAL reviewed data file, the REAL publishVersion / previewVersion and the REAL served body (buildPublicMenu).
// Run: node tools/migrate-menu-structure-publish.test.js
const assert = require('assert');
const { makeDb } = require('../catalog/firestore-fake');
const CP = require('../catalog/catalog-publish');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { buildPublicMenu } = require('../catalog/public-menu');
const { getActiveVersionId } = require('../catalog/catalog-firestore');
const { premigrationGaps } = require('../catalog/menu-structure-rows');
const { canonicalize } = require('../catalog/source-store');
const { buildSourceFromCode } = require('./seed-source-store');
const { publishRestaurant, publishMenuStructure, assertOnlyAdded } = require('./migrate-menu-structure');
const DATA = require('./migrations/2026-10-26-menu-structure.json');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('migrate-menu-structure-publish: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (v) => JSON.parse(JSON.stringify(v));
const RIDS = ['la_musa', 'x_pizza'];
const KNOWN = new Set(RIDS);

// A PRODUCTION live version BEFORE the migration: the seed without the rows' fields, and one MERCHANT PRICE that differs from the
// code tables (prices must come from live, never code).
function preMigration(rid, s) {
  const r = DATA.restaurants[rid] || {};
  for (const f of Object.keys(r.structure || {})) delete s.structure[f];
  for (const [coll, list] of [['items', s.items], ['extras', s.extras]]) {
    for (const [key, row] of Object.entries(r[coll] || {})) { const rec = list.find((x) => x.key === key); for (const f of Object.keys(row.display)) delete rec.display[f]; }
  }
  return s;
}
const MERCHANT_KEY = { x_pizza: 'Nutella', la_musa: null };
async function publishSource(db, rid, source, expectedId) {
  const { inputs, built } = buildSourceCandidate(rid, source);
  return CP.publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'test' }, { expected: { activeVersionId: expectedId } });
}
async function liveDb(mut = {}) {
  const db = makeDb();
  for (const rid of RIDS) {
    const s = preMigration(rid, clone(buildSourceFromCode(rid)));
    if (MERCHANT_KEY[rid]) { const it = s.items.find((x) => x.key === MERCHANT_KEY[rid]); it.price += 7; if (it.display && it.display.price !== undefined) it.display.price = it.price; }
    if (mut[rid]) mut[rid](s);
    await publishSource(db, rid, s, null);
  }
  return db;
}
const pointerOf = async (db, rid) => (await db.collection('restaurants').doc(rid).collection('meta').doc('active_version').get()).data();
const served = async (db, rid) => (await buildPublicMenu(db, rid, { known: KNOWN, isActive: async () => true })).body;
const priceMap = async (db, rid) => { const v = await getActiveVersionId(db, rid); const p = await CP.previewVersion(db, rid, v); return JSON.stringify([p.items.map((i) => [i.key, i.price]), p.extras.map((e) => [e.key, e.price])]); };

(async () => {
  // premise: the live bodies are PRE-migration (the bake refuses them)
  {
    const db = await liveDb();
    for (const rid of RIDS) assert.ok(premigrationGaps(rid, await served(db, rid)).length > 0, `${rid}: premise — the live body has gaps`);
    ok('premise: a pre-migration live version → premigrationGaps non-empty for both brands (the bake would refuse)');
  }
  // 1 DRY: plans, publishes nothing
  {
    const db = await liveDb();
    const before = { x: await pointerOf(db, 'x_pizza'), l: await pointerOf(db, 'la_musa') };
    const rep = await publishMenuStructure(db, DATA, { apply: false });
    const by = Object.fromEntries(rep.map((r) => [r.rid, r]));
    assert.strictEqual(by.x_pizza.outcome, 'dry_run'); assert.strictEqual(by.la_musa.outcome, 'dry_run');
    assert.strictEqual(by.x_pizza.added.length, 18, 'x_pizza: 17 reward_icon + Nutella extras_policy');
    assert.strictEqual(by.la_musa.added.length, 40, 'la_musa: badge_priority + 36 dish + 3 extra reward_icon');
    assert.deepStrictEqual({ x: await pointerOf(db, 'x_pizza'), l: await pointerOf(db, 'la_musa') }, before, 'DRY moved no pointer');
    ok('DRY (default): x_pizza 18 / la_musa 40 planned (= the owner\'s --write counts); no pointer moved, nothing published');
  }
  // 2 APPLY: only absent fields; prices / keys / order = live; the bake gate is satisfied
  {
    const db = await liveDb();
    const priceBefore = { x_pizza: await priceMap(db, 'x_pizza'), la_musa: await priceMap(db, 'la_musa') };
    const rep = await publishMenuStructure(db, DATA, { apply: true });
    for (const r of rep) {
      assert.strictEqual(r.outcome, 'published'); assert.notStrictEqual(r.published, r.liveVersion);
      assert.strictEqual(await getActiveVersionId(db, r.rid), r.published, `${r.rid}: the pointer names the new version`);
      assert.strictEqual(await priceMap(db, r.rid), priceBefore[r.rid], `${r.rid}: every price / key / order byte-identical to LIVE`);
      assert.deepStrictEqual(premigrationGaps(r.rid, await served(db, r.rid)), [], `${r.rid}: the served body satisfies the bake gate`);
    }
    const nut = (await served(db, 'x_pizza')).dishes.find((d) => d.name === 'Nutella');
    assert.strictEqual(nut.extras_policy, 'none');
    const xp = buildSourceFromCode('x_pizza').items.find((x) => x.key === 'Nutella').price;
    assert.strictEqual(nut.price, xp + 7, 'the MERCHANT price (live), not the code price');
    ok('APPLY: both brands published; prices / keys / order byte-identical to live (the merchant\'s Nutella price kept, not code\'s); premigrationGaps(served) === [] for both');
    // 3 IDEMPOTENT: a second run adds nothing and publishes nothing (no version, no fence advance)
    const p0 = { x: await pointerOf(db, 'x_pizza'), l: await pointerOf(db, 'la_musa') };
    const again = await publishMenuStructure(db, DATA, { apply: true });
    assert.deepStrictEqual(again.map((r) => r.outcome), ['already_current', 'already_current']);
    assert.deepStrictEqual({ x: await pointerOf(db, 'x_pizza'), l: await pointerOf(db, 'la_musa') }, p0, 'no pointer / generation change');
    ok('IDEMPOTENT: a second --apply → already_current for both; pointer and generation unchanged (no fence advance)');
  }
  // 4 CAS: a publish that lands between the capture and the flip refuses this one; ours writes nothing
  {
    const db = await liveDb();
    const realPreview = CP.previewVersion; let raced = false; let racer = null;
    CP.previewVersion = async (d, rid, v) => {
      const p = await realPreview(d, rid, v);
      if (!raced && rid === 'x_pizza') {
        raced = true; const s = preMigration('x_pizza', clone(buildSourceFromCode('x_pizza'))); const it0 = s.items[0]; it0.price += 1; if (it0.display && it0.display.price !== undefined) it0.display.price = it0.price;
        await publishSource(d, 'x_pizza', s, v);
        racer = { pointer: await pointerOf(d, 'x_pizza'), body: JSON.stringify(await served(d, 'x_pizza')) };
      }
      return p;
    };
    let threw = null;
    try { await publishRestaurant(db, 'x_pizza', DATA.restaurants.x_pizza, { apply: true }); } catch (e) { threw = e; } finally { CP.previewVersion = realPreview; }
    assert.ok(raced, 'the racing publish ran');
    assert.ok(threw && /flip_cas_stale/.test(threw.message), `a stale activeVersionId must refuse with the CAS (got ${threw && threw.message})`);
    // Codex r1 P2: publishVersion persists the candidate BEFORE the CAS, so a refusal may leave an INACTIVE orphan version
    // (acceptable: never pointed to, never served). What must hold: the racing version stays ACTIVE, and the pointer (version +
    // generation fence) and the served snapshot are exactly the racer's.
    assert.deepStrictEqual(await pointerOf(db, 'x_pizza'), racer.pointer, 'the pointer / generation fence are the racer\'s, unchanged by ours');
    assert.strictEqual(JSON.stringify(await served(db, 'x_pizza')), racer.body, 'the served snapshot is the racer\'s');
    ok(`CAS: a concurrent publish between capture and flip → refused (${String(threw.message).slice(0, 60)}…); the racing version stays active, pointer / fence / served snapshot unchanged (an inactive orphan candidate version is acceptable)`);
  }
  // 5 a LIVE value that differs from the data file is a merchant edit: preserved, reported, published as-is
  {
    const db = await liveDb({ x_pizza: (s) => { s.items.find((x) => x.key === 'Nutella').display.extras_policy = 'none'; const c = s.items.find((x) => x.key !== 'Nutella' && DATA.restaurants.x_pizza.items[x.key] && DATA.restaurants.x_pizza.items[x.key].display.reward_icon); c.display.reward_icon = DATA.restaurants.x_pizza.items[c.key].display.reward_icon === 'star' ? 'leaf' : 'star'; } });
    let r;
    try { r = await publishRestaurant(db, 'x_pizza', DATA.restaurants.x_pizza, { apply: true }); } catch (e) { r = { err: e.message }; }
    if (r.err) {
      // the swapped icon is outside the closed set → validateSource refuses: also a correct, fail-closed outcome — but the cell needs a VALID merchant value
      throw new Error(`cell 5 needs a valid alternative reward_icon: ${r.err}`);
    }
    assert.strictEqual(r.preserved.length, 1, 'one merchant value preserved'); assert.strictEqual(r.added.length, 16, '17 rows − Nutella (already set) − the preserved one');
    const kept = (await served(db, 'x_pizza')).dishes.find((d) => d.reward_icon === r.preserved[0].have);
    assert.ok(kept, 'the merchant value is what is served');
    ok(`MERCHANT VALUE: a live ${r.preserved[0].path} = ${JSON.stringify(r.preserved[0].have)} survives (reported, not overwritten); 16 added`);
  }
  // 6 an INVALID result refuses before any write
  {
    const db = await liveDb();
    const bad = clone(DATA.restaurants.la_musa); bad.structure.badge_priority = ['ghost_badge'];
    const p0 = await pointerOf(db, 'la_musa');
    await assert.rejects(() => publishRestaurant(db, 'la_musa', bad, { apply: true }), /ghost_badge|badge_priority/);
    assert.deepStrictEqual(await pointerOf(db, 'la_musa'), p0);
    ok('INVALID: a badge_priority naming no badge → validateSource refuses; nothing published');
  }
  // R1 (Codex r1 P1, its exact repro): a live La Musa with a pickup_only_cats gate and an extra's has_photo — adding badge_priority
  // must NOT lose either (the candidate is the captured live payload, never a rebuild)
  {
    const db = makeDb(); const rid = 'la_musa';
    const { inputs, built } = buildSourceCandidate(rid, buildSourceFromCode(rid));
    delete built.structure.badge_priority;
    built.structure.pickup_only_cats = [built.structure.categories[0].id];
    built.extras[0].has_photo = true;
    const first = await CP.publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 'review-fixture' }, { expected: { activeVersionId: null } });
    const before = await CP.previewVersion(db, rid, first.versionId);
    const r = await publishRestaurant(db, rid, DATA.restaurants[rid], { apply: true });
    const after = await CP.previewVersion(db, rid, r.published);
    assert.strictEqual(r.outcome, 'published');
    assert.deepStrictEqual(after.structure.pickup_only_cats, before.structure.pickup_only_cats, 'the pickup_only_cats gate survives');
    assert.strictEqual(after.extras[0].has_photo, true, 'the extra\'s has_photo survives');
    // canonical (key-order-free, as Firestore maps are) — the same comparison the tool's guard makes
    const strip = (v) => { const c = clone(v); delete c.structure.badge_priority; return JSON.stringify(canonicalize([c.items, c.extras, c.structure])); };
    assert.strictEqual(strip(after), strip(before), 'apart from the added badge_priority, the new version IS the live payload');
    ok('REGRESSION (Codex r1 repro): live pickup_only_cats ["' + before.structure.pickup_only_cats.join('","') + '"] + an extra has_photo:true → both survive; the new version = live + badge_priority, nothing else');
  }
  // R2 the guard: a candidate that LOSES a live field (identical on a rebuilt pair, different from the captured payload) refuses
  {
    const live = { items: [{ key: 'a', price: 1, display: { name: 'A' } }], structure: { item_order: ['a'], pickup_only_cats: ['c1'] }, extras: { e: 5 }, extraRecords: [{ key: 'e', price: 5, display: { name: 'E' }, has_photo: true }], source_sha: 's' };
    const next = clone(live); next.structure.badge_priority = ['b'];
    assertOnlyAdded('x', live, next, ['structure.badge_priority']);
    const lostGate = clone(next); delete lostGate.structure.pickup_only_cats;
    assert.throws(() => assertOnlyAdded('x', live, lostGate, ['structure.badge_priority']), /publish_refused_unexpected_delta/);
    const lostPhoto = clone(next); delete lostPhoto.extraRecords[0].has_photo;
    assert.throws(() => assertOnlyAdded('x', live, lostPhoto, ['structure.badge_priority']), /publish_refused_unexpected_delta/);
    ok('GUARD vs the captured payload: a lost pickup_only_cats or a lost extra has_photo → publish_refused_unexpected_delta');
  }
  // 7 photos: a live photo map would be dropped → refuse
  {
    const db = await liveDb();
    const v = await getActiveVersionId(db, 'x_pizza');
    await db.collection('restaurants').doc('x_pizza').collection('versions').doc(v).collection('meta').doc('photos').set({ Nutella: { pid: 'p1' } });
    await assert.rejects(() => publishRestaurant(db, 'x_pizza', DATA.restaurants.x_pizza, { apply: true }), /publish_refused_active_photos/);
    ok('PHOTOS: a live version carrying a photo map → publish_refused_active_photos (this path would drop it)');
  }
  // 8 the delta guard: a candidate that differs from live beyond the added fields refuses
  {
    const live = { items: [{ key: 'a', price: 1, display: { name: 'A' } }], structure: { item_order: ['a'] }, extras: {}, extraRecords: [], source_sha: 's' };
    const next = clone(live); next.items[0].display.reward_icon = 'cake';
    assertOnlyAdded('x', live, next, ['item[a].display.reward_icon']);
    const tampered = clone(next); tampered.items[0].price = 2;
    assert.throws(() => assertOnlyAdded('x', live, tampered, ['item[a].display.reward_icon']), /publish_refused_unexpected_delta/);
    ok('DELTA GUARD: added-fields-only passes; a price change riding along → publish_refused_unexpected_delta');
  }
  // 9 MUTANT: drop one reviewed row → the published body keeps a gap, so the bake gate still refuses (the proof is sensitive)
  {
    const db = await liveDb();
    const dropped = clone(DATA.restaurants.x_pizza); delete dropped.items.Nutella;
    await publishRestaurant(db, 'x_pizza', dropped, { apply: true });
    const gaps = premigrationGaps('x_pizza', await served(db, 'x_pizza'));
    assert.ok(gaps.includes('dishes[Nutella].extras_policy') && gaps.length >= 1, `the dropped row stays a gap (${gaps.join(',')})`);
    ok(`MUTANT: the Nutella row dropped → premigrationGaps = [${gaps.join(', ')}] (the bake still refuses)`);
  }
  FINISHED = true;
  console.log(`\nmigrate-menu-structure-publish: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
