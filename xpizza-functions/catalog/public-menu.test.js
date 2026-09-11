'use strict';
// Portal 1B Task 1 — getPublicMenu CORE: the live 1A catalog, projected into the shape the forms
// already read.
//
// 🔴 THE PROJECTION IS THE GENERATOR'S, NOT A NEW ONE. The forms consume a bundle shape that
// generate-form-bundle already produces and that 1A's parity gates hold byte-identical to the
// committed artifacts. Inventing a second projection here would create exactly the drift this whole
// initiative exists to remove — two answers to "what does a dish look like", diverging silently the
// first time one is edited. So the body is the generator's output, and what this module adds is the
// fields the generator deliberately left in `structure` (the exposure maps and badge definitions,
// which nothing served until now).
//
// Everything here originates from the REAL writer: a version published through publishVersion and
// read back through the real 1A reader. A hand-built snapshot could differ from what the publisher
// emits and the test would agree with itself.
//
// Run: node catalog/public-menu.test.js
const assert = require('assert');
const { makeDb } = require('./firestore-fake');
const { publishVersion } = require('./catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { catalogSnapshot, generateFormBundle } = require('./generate-form-bundle');
const { getRestaurantMenu } = require('./catalog-menu');
const { buildPublicMenu, REPRESENTATION_VERSION, PUBLIC_MENU_BODY_FIELDS } = require('./public-menu');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('public-menu: FAILED — exited without completing'); process.exitCode = 1; } });

const BRANDS = ['x_pizza', 'la_musa'];
const known = new Set(BRANDS);
const active = { isActive: async () => true };

// A live catalog, published by the real publisher.
async function seeded(rid, over = {}) {
  const db = makeDb();
  const { input, expected } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: '1b' });
  const publishInput = over.items ? { ...input, items: over.items } : input;
  await publishVersion(db, rid, publishInput, { expected });
  return db;
}

(async () => {
  // ══ 1. THE BODY IS THE FORM-BUNDLE SHAPE, FROM THE GENERATOR ══════════════════════════════════
  for (const rid of BRANDS) {
    const db = await seeded(rid);
    const out = await buildPublicMenu(db, rid, { known, ...active });

    assert.strictEqual(out.rid, rid, 'the payload names the restaurant it is for');
    assert.strictEqual(out.representation_version, REPRESENTATION_VERSION);
    assert.ok(Number.isInteger(out.seq), 'the version ordinal rides alongside the body');
    // seq is deliberately NOT in the body: it changes on every publish, including ones that change
    // nothing a customer sees, and a body that carries it would defeat its own etag.
    assert.strictEqual(out.body.seq, undefined, '🔴 seq must not be in the body — it would break etag stability');

    // THE GENERATOR'S OWN OUTPUT, field for field, over the same version.
    const viaGenerator = generateFormBundle(rid, await getRestaurantMenu(db, rid));
    for (const f of Object.keys(viaGenerator)) {
      assert.deepStrictEqual(out.body[f], viaGenerator[f], `🔴 ${rid}: body.${f} is not the generator's ${f}`);
    }
    // ...and it equals what the committed artifact path produces, so the served menu is the menu.
    const viaBootstrap = generateFormBundle(rid, catalogSnapshot(rid));
    assert.deepStrictEqual(out.body.dishes, viaBootstrap.dishes, `${rid}: served dishes == the committed bundle's`);
    assert.deepStrictEqual(out.body.extras, viaBootstrap.extras, `${rid}: served options == the committed bundle's`);
    ok(`${rid}: the body is the generator's output over the live version (${out.body.dishes.length} dishes, ${out.body.extras.length} options)`);
  }

  // ══ 2. ...PLUS WHAT THE GENERATOR LEFT IN THE STRUCTURE ═══════════════════════════════════════
  {
    // The forms read EXTRAS_BY_CATEGORY / EXTRAS_BY_ITEM / TAG_BADGES as literals today. Nothing
    // served them, so 1A carried them in `structure` and kept them out of the committed bundle. 1B is
    // what serves them, so they join the body here — carried, never re-derived.
    const lm = await buildPublicMenu(await seeded('la_musa'), 'la_musa', { known, ...active });
    const menu = await getRestaurantMenu(await seeded('la_musa'), 'la_musa');
    assert.deepStrictEqual(lm.body.extras_by_category, menu.structure.extras_by_category, 'the category exposure map is served');
    assert.deepStrictEqual(lm.body.extras_by_item, menu.structure.extras_by_item, 'the per-item exposure map is served');
    assert.deepStrictEqual(lm.body.badges, menu.structure.badges, 'the badge definitions are served');
    assert.ok(lm.body.variant_items && lm.body.variant_items.noodle_01, 'la_musa variant launchers are served');
    assert.ok(lm.body.categories.some((c) => Array.isArray(c.subcats)), 'la_musa subcats are served');

    const xp = await buildPublicMenu(await seeded('x_pizza'), 'x_pizza', { known, ...active });
    assert.deepStrictEqual(xp.body.pickup_only_cats, ['ny'], 'x_pizza pickup gate is served');
    assert.deepStrictEqual(xp.body.weekend_only_cats, ['ny'], 'x_pizza weekend gate is served');

    // EVERY served field is declared. A field that appears in the body without being listed is one
    // nobody decided to serve — and the etag would start moving for reasons no one chose.
    for (const brand of [xp, lm]) {
      const undeclared = Object.keys(brand.body).filter((f) => !PUBLIC_MENU_BODY_FIELDS.includes(f));
      assert.deepStrictEqual(undeclared, [], `🔴 ${brand.rid}: undeclared served fields: ${undeclared.join(', ')}`);
    }
    ok('the exposure maps, badges, variants, subcats and gate cats are served; every body field is declared');
  }

  // ══ 3. A BAD rid NEVER DEFAULTS A BRAND ═══════════════════════════════════════════════════════
  {
    const db = await seeded('x_pizza');
    // 🔴 THE ORDER-INTAKE DEFAULT IS NOT INHERITED. resolveRestaurantId() sends a blank rid to
    // x_pizza, which is right for a form that has always posted none and wrong for a public endpoint
    // where the rid IS the request: defaulting would serve one brand's menu to whoever asked badly.
    const { DEFAULT_RESTAURANT_ID } = require('../restaurant-id');
    assert.strictEqual(DEFAULT_RESTAURANT_ID, 'x_pizza', 'premise: order-intake really does default to a brand');

    const refuses = async (label, rid, deps = {}) => assert.rejects(
      () => buildPublicMenu(db, rid, { known, ...active, ...deps }),
      (e) => { assert.strictEqual(e.code, 'public_menu_bad_rid', `${label}: got ${e.code}`); return true; },
      `🔴 ${label} was SERVED`);

    await refuses('an absent rid', undefined);
    await refuses('a null rid', null);
    await refuses('a blank rid', '   ');
    await refuses('a DUPLICATED rid (an array, as a query string yields)', ['x_pizza', 'la_musa']);
    await refuses('a malformed rid', 'X Pizza!');
    await refuses('an over-long rid', 'a'.repeat(200));
    await refuses('an unknown rid', 'not_a_restaurant');
    await refuses('a known but INACTIVE restaurant', 'x_pizza', { isActive: async () => false });
    await refuses('a restaurant whose activity cannot be determined', 'x_pizza', { isActive: async () => { throw new Error('rtdb down'); } });
    ok('bad rid: 9 shapes refused as public_menu_bad_rid — absent, blank, duplicated, malformed, unknown, inactive — never a default brand');
  }

  // ══ 4. AN UNSERVABLE CATALOG IS A TYPED FAILURE, NEVER A PARTIAL BODY ═════════════════════════
  {
    const cases = {
      'no version published at all': async () => makeDb(),
      'a version the reader refuses (an option stripped of its display record)': async () => {
        const db = await seeded('x_pizza');
        const vid = (await db.collection('restaurants').doc('x_pizza').collection('meta').doc('active_version').get()).data().version;
        const d = (await db.collection('restaurants').doc('x_pizza').collection('versions').doc(vid).collection('extras').get()).docs[0];
        await d.ref.set({ key: d.data().key, price: d.data().price });
        return db;
      },
      'a version whose content hash no longer matches': async () => {
        const db = await seeded('x_pizza');
        const vid = (await db.collection('restaurants').doc('x_pizza').collection('meta').doc('active_version').get()).data().version;
        const r = await db.collection('restaurants').doc('x_pizza').collection('versions').doc(vid).get();
        await r.ref.set({ ...r.data(), content_hash: 'f'.repeat(64) });
        return db;
      },
    };
    for (const [what, mk] of Object.entries(cases)) {
      const db = await mk();
      await assert.rejects(() => buildPublicMenu(db, 'x_pizza', { known, ...active }), (e) => {
        assert.strictEqual(e.code, 'public_menu_unavailable', `${what}: got ${e.code} — ${e.message}`);
        assert.strictEqual(e.body, undefined, '🔴 a failure must carry no partial body');
        return true;
      }, `🔴 ${what} produced a menu`);
    }
    ok(`unservable: ${Object.keys(cases).length} states each throw public_menu_unavailable with no partial body`);
  }
  {
    // 🔴 A TRANSFORM FAILURE THROWS — it does not return whatever it managed to build. The reader
    // already guarantees everything rebuildFormMenu needs, so no real version reaches this path
    // today; injecting the failure is the only way to prove the path exists, and a guard with no
    // reachable test is a guard nobody has seen work. A half-menu is worse than no menu because it
    // RENDERS: the customer sees a shop with four dishes and no way to know six are missing.
    const db = await seeded('x_pizza');
    let returned = null;
    await assert.rejects(async () => {
      returned = await buildPublicMenu(db, 'x_pizza', {
        known, ...active, generate: () => { throw new Error('structure incoherent for the transform'); },
      });
    }, (e) => {
      assert.strictEqual(e.code, 'public_menu_unavailable', `got ${e.code}`);
      assert.match(e.message, /does not project to a servable menu/);
      return true;
    }, '🔴 a projection that cannot complete produced a menu anyway');
    assert.strictEqual(returned, null, '🔴 nothing may be RETURNED when the projection failed');
    ok('a projection that throws is refused whole — no partial body is ever returned');
  }

  {
    // 🔴 THE DECLARATION IS ENFORCED, not merely written down. Nothing in the tree produces an
    // undeclared field today, so without injecting a generator that does, this guard would be a
    // comment: it would pass forever and fail the day it mattered, which is the shape of every
    // structural check this programme has had to replace.
    const db = await seeded('x_pizza');
    const smuggler = (rid, menu) => ({ ...generateFormBundle(rid, menu), item_order: menu.structure.item_order });
    await assert.rejects(() => buildPublicMenu(db, 'x_pizza', { known, ...active, generate: smuggler }), (e) => {
      assert.strictEqual(e.code, 'public_menu_unavailable', `got ${e.code}`);
      assert.match(e.message, /undeclared fields \(item_order\)/);
      return true;
    }, '🔴 a field nobody declared reached the served body');
    // ...and the real generator still passes, so the guard is not simply refusing everything.
    assert.ok((await buildPublicMenu(db, 'x_pizza', { known, ...active })).body.dishes.length > 0);
    ok('the served-field declaration is enforced: a projection smuggling an extra field is refused whole');
  }

  // ══ 5. THE ETAG IDENTIFIES THE REPRESENTATION ═════════════════════════════════════════════════
  {
    const rid = 'la_musa';
    const a = await buildPublicMenu(await seeded(rid), rid, { known, ...active });
    const b = await buildPublicMenu(await seeded(rid), rid, { known, ...active });
    assert.strictEqual(a.etag, b.etag, '🔴 the same menu must etag identically across builds');
    assert.match(a.etag, /^"[0-9a-f]{64}"$/, 'a quoted full sha256, as an ETag header wants');

    // A DISPLAY-ONLY change moves it. Two versions differing in one dish name, nothing else.
    const snap = catalogSnapshot(rid);
    const renamed = snap.items.map((i, x) => (x === 0 ? { ...i, display: { ...i.display, name: `${i.display.name} de la casa` } } : i));
    const db2 = await seeded(rid, { items: renamed });
    const c = await buildPublicMenu(db2, rid, { known, ...active });
    assert.notStrictEqual(c.etag, a.etag, '🔴 a renamed dish must change the etag — it is a different representation');
    assert.notDeepStrictEqual(c.body.dishes, a.body.dishes, 'premise: the bodies really differ');

    // The rid is IN the etag. Comparing x_pizza against la_musa proves nothing — their bodies differ
    // wholesale, so the hash would differ with or without the rid. The rid only carries weight when
    // two restaurants have the SAME menu, which is not hypothetical: a second X. Pizza location
    // seeded from the same catalog is exactly that. Identical bodies, and the etags must still differ.
    // PUBLISHED under its own id, not copied: 1A's content hash covers the rid, so a version record
    // naming one restaurant cannot be read under another — the reader refuses it outright. (Found by
    // trying the lazy version of this fixture, which is the identity check doing its job.)
    const twinDb = makeDb();
    const CLONE = 'x_pizza_two';
    const { input } = buildPublishCandidate('x_pizza', { activeVersionId: null }, { source_sha: '1b' });
    await publishVersion(twinDb, 'x_pizza', input, { expected: { activeVersionId: null } });
    await publishVersion(twinDb, CLONE, input, { expected: { activeVersionId: null } });

    const one = await buildPublicMenu(twinDb, 'x_pizza', { known, ...active });
    const two = await buildPublicMenu(twinDb, CLONE, { known: new Set([...known, CLONE]), ...active });
    assert.deepStrictEqual(two.body, one.body, 'premise: the two restaurants really do serve an identical menu');
    assert.notStrictEqual(two.etag, one.etag,
      '🔴 two restaurants with the same menu share an etag — anything keyed by etag alone would serve one brand the other\'s menu');
    ok(`etag: stable across builds, moves on a display-only change, and separates two restaurants serving an IDENTICAL menu (${a.etag.slice(1, 13)}…)`);
  }
  {
    // 🔴 THE ETAG COVERS THE REPRESENTATION, NOT JUST 1A's CONTENT HASH. Those are different claims:
    // content_hash identifies the VERSION, while what is cached here is this module's PROJECTION of
    // it. Change the projection — add a field, reorder one, bump the version — and every cache in the
    // world is still holding the old body under the old key unless the etag moved too.
    const rid = 'x_pizza';
    const db = await seeded(rid);
    const real = await buildPublicMenu(db, rid, { known, ...active });
    const shifted = await buildPublicMenu(db, rid, { known, ...active, representationVersion: `${REPRESENTATION_VERSION}-next` });
    assert.notStrictEqual(shifted.etag, real.etag,
      '🔴 a projection-version change must move the etag, or a redeploy serves stale bodies from cache forever');
    ok('etag covers the PROJECTION too: bumping the representation version changes it, even with an identical catalog');
  }

  FINISHED = true;
  console.log(`public-menu: OK (${n})`);
})().catch((e) => { console.error('public-menu FAILED:', (e && e.stack) || e); process.exit(1); });
