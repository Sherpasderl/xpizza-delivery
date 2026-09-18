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
const { stripIdentity } = require('../../xpizza-orders/form-identity-strip');
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

    /* THE GENERATOR'S OWN OUTPUT, field for field, over the same version — MINUS THE 1D IDENTITY.
       D1 lays dish_id/extra_id onto the served body after the projection, so a bare equality here
       would now fail for the one difference that is supposed to exist. Stripping identity and then
       demanding equality keeps the original guarantee intact and arguably sharpens it: the served body
       must differ from the generator's output in EXACTLY that one way and no other. A price, a name, an
       ordering or a missing record still fails, as before.
       The strip reuses the browser's own module rather than listing the fields again — one definition
       of "the identity fields", so a third one added at D2 cannot leave this comparison behind. */
    const viaGenerator = generateFormBundle(rid, await getRestaurantMenu(db, rid));
    const deIdent = (v) => (Array.isArray(v) ? stripIdentity(v) : v);
    for (const f of Object.keys(viaGenerator)) {
      assert.deepStrictEqual(deIdent(out.body[f]), deIdent(viaGenerator[f]),
        `🔴 ${rid}: body.${f} differs from the generator's ${f} by something OTHER than identity`);
    }
    /* 🔴 …AND IDENTITY REALLY IS THE DIFFERENCE. Without this the strip above would hide a regression
       in which the overlay silently stopped running: every comparison would pass, and the served menu
       would quietly lose the ids D1 exists to add. */
    assert.ok(out.body.dishes.every((d) => typeof d.dish_id === 'string' && d.dish_id),
      `🔴 ${rid}: the served dishes carry no dish_id — the overlay did not run`);
    assert.ok(out.body.extras.every((e) => typeof e.extra_id === 'string' && e.extra_id),
      `🔴 ${rid}: the served options carry no extra_id`);

    // ...and it equals what the committed artifact path produces, so the served menu is the menu.
    const viaBootstrap = generateFormBundle(rid, catalogSnapshot(rid));
    assert.deepStrictEqual(stripIdentity(out.body.dishes), viaBootstrap.dishes, `${rid}: served dishes == the committed bundle's`);
    assert.deepStrictEqual(stripIdentity(out.body.extras), viaBootstrap.extras, `${rid}: served options == the committed bundle's`);
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
      assert.match(e.message, /item_order is served but undeclared/);
      return true;
    }, '🔴 a field nobody declared reached the served body');
    // ...and the real generator still passes, so the guard is not simply refusing everything.
    assert.ok((await buildPublicMenu(db, 'x_pizza', { known, ...active })).body.dishes.length > 0);
    ok('the served-field declaration is enforced: a projection smuggling an extra field is refused whole');
  }

  {
    // 🔴 THE OTHER HALF OF THE SAME QUESTION. Checking that nothing UNDECLARED appears says nothing
    // about whether everything REQUIRED did: a projection returning a body with `extras` deleted
    // passed that check and produced a valid etag for a menu with no options — the "half-menu renders
    // as a menu" outcome this module's own comment warns about, reached by the guard that was
    // supposed to prevent it. Present-but-shouldn't-be and absent-but-must-be are one class, and I
    // had closed one side of it.
    const db = await seeded('x_pizza');
    const lmDb = await seeded('la_musa');
    const omit = (field) => (rid, menu) => { const b = generateFormBundle(rid, menu); delete b[field]; return b; };
    const blank = (field, value) => (rid, menu) => ({ ...generateFormBundle(rid, menu), [field]: value });

    const refusesBody = async (label, database, rid, generate, because) => {
      let returned = null;
      await assert.rejects(async () => { returned = await buildPublicMenu(database, rid, { known, ...active, generate }); }, (e) => {
        assert.strictEqual(e.code, 'public_menu_unavailable', `${label}: got ${e.code}`);
        assert.match(e.message, because, `${label}: wrong reason — ${e.message}`);
        return true;
      }, `🔴 ${label} was SERVED`);
      assert.strictEqual(returned, null, `🔴 ${label}: something was RETURNED`);
    };

    // the three every catalog has
    await refusesBody('a menu with no dishes collection', db, 'x_pizza', omit('dishes'), /dishes is missing/);
    await refusesBody('a menu with no options collection', db, 'x_pizza', omit('extras'), /extras is missing/);
    await refusesBody('a menu with no categories collection', db, 'x_pizza', omit('categories'), /categories is missing/);
    await refusesBody('a menu with ZERO dishes', db, 'x_pizza', blank('dishes', []), /dishes is empty/);
    await refusesBody('a menu with zero categories', db, 'x_pizza', blank('categories', []), /categories is empty/);
    await refusesBody('a dishes collection that is not a list', db, 'x_pizza', blank('dishes', { 0: 'x' }), /dishes is not an array/);
    // 🔴 SET-TO-UNDEFINED IS ABSENT, NOT MISTYPED. Both refuse, so the menu is safe either way — but
    // the REASON is the rule being tested, and without pinning it the by-key reading passes: the type
    // check catches undefined and reports "not an array", so the presence rule could be deleted and
    // nothing would notice. The same presence-by-value trap this programme has now hit five times,
    // and the same cure: assert which rule fired, not merely that one did.
    await refusesBody('a collection explicitly set to undefined', db, 'x_pizza', blank('extras', undefined), /extras is missing/);
    await refusesBody('a source-carried collection set to undefined', lmDb, 'la_musa', blank('variant_items', undefined), /variant_items is missing although the catalog carries it/);

    // ...and the ones required BECAUSE THE CATALOG CARRIES THEM. Not "optional": only la_musa has
    // variant launchers today, but the rule is about the source, not the brand — so it needs no brand
    // literal and still catches a generator quietly dropping every launcher from the form.
    await refusesBody('la_musa losing its variant launchers', lmDb, 'la_musa', omit('variant_items'), /variant_items is missing although the catalog carries it/);
    await refusesBody('la_musa losing its photo set', lmDb, 'la_musa', omit('has_photo'), /has_photo is missing although the catalog carries it/);
    await refusesBody('x_pizza losing its pickup gate', db, 'x_pizza', omit('pickup_only_cats'), /pickup_only_cats is missing although the catalog carries it/);
    await refusesBody('x_pizza losing its weekend gate', db, 'x_pizza', omit('weekend_only_cats'), /weekend_only_cats is missing although the catalog carries it/);
    await refusesBody('a variant map that is not a map', lmDb, 'la_musa', blank('variant_items', []), /variant_items is not an object/);

    // NON-VACUITY, and the reason the rule is source-conditional rather than universal: x_pizza has
    // no variant launchers at all, and a menu without them is a perfectly good menu.
    const xp = await buildPublicMenu(db, 'x_pizza', { known, ...active });
    assert.strictEqual(xp.body.variant_items, undefined, 'premise: x_pizza legitimately has no variant launchers');
    assert.strictEqual(xp.body.has_photo, undefined, '...and no photo set');
    const lm = await buildPublicMenu(lmDb, 'la_musa', { known, ...active });
    assert.strictEqual(lm.body.pickup_only_cats, undefined, 'premise: la_musa legitimately has no gate categories');
    ok('the body is whole in BOTH directions: 13 omissions/mistypes refused (set-to-undefined reported as ABSENT, not mistyped), while a brand that legitimately lacks a collection still serves');
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
    /* 🔴 THE PREMISE, MINUS IDENTITY — and the change is worth naming. Before D1 two restaurants with
       the same menu served byte-identical bodies, which is what made this cell's point sharp: the
       etags had to differ for a reason other than the content. They now differ in content too, because
       ids are per-merchant-unique by construction and each brand minted its own.
       That makes the etag separation MORE robust, not less, but it would be the wrong lesson to take
       from a green test — so the premise is asserted on the menus themselves, with identity stripped,
       and the per-merchant distinctness is asserted separately below rather than relied on. */
    assert.deepStrictEqual(
      { ...two.body, dishes: stripIdentity(two.body.dishes), extras: stripIdentity(two.body.extras) },
      { ...one.body, dishes: stripIdentity(one.body.dishes), extras: stripIdentity(one.body.extras) },
      'premise: the two restaurants really do serve an identical menu');
    assert.notDeepStrictEqual(two.body.dishes.map((d) => d.dish_id), one.body.dishes.map((d) => d.dish_id),
      '🔴 …and their identities are NOT shared — an id is per-merchant, so one brand can never resolve the other\'s object');
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

  {
    // 🔴 THE UNKNOWN BRANCH. Nothing in the endpoint can be made to throw an untyped error on demand,
    // so the path that decides what an unrecognised failure looks like would otherwise be the only
    // one never executed — and it is the one that runs on the day something genuinely unexpected
    // happens. Pure and here, so it can be.
    const { publicMenuErrorResponse } = require('./public-menu');
    const err = (code) => Object.assign(new Error('detail text'), code ? { code } : {});
    assert.deepStrictEqual(publicMenuErrorResponse(err('public_menu_bad_rid')),
      { status: 400, log: null, payload: { error: 'public_menu_bad_rid', detail: 'detail text' } });
    const un = publicMenuErrorResponse(err('public_menu_unavailable'));
    assert.strictEqual(un.status, 503);
    assert.strictEqual(un.payload.retryable, true, 'the client is told it is worth trying again');
    assert.ok(un.log, 'an outage is logged');
    assert.strictEqual(un.payload.detail, undefined, 'an outage leaks no internals to a customer');
    for (const [label, thrown] of [
      ['an untyped Error', err(null)],
      ['a foreign code', err('ECONNRESET')],
      ['a thrown string', 'boom'],
      ['a thrown null', null],
    ]) {
      const r = publicMenuErrorResponse(thrown);
      assert.strictEqual(r.status, 500, `${label}: an unrecognised failure is a 500`);
      assert.deepStrictEqual(r.payload, { error: 'error' }, `${label}: and says nothing else`);
      assert.ok(r.log, `${label}: but IS logged`);
    }
    ok('the error mapping covers all three classes — including the unrecognised one, which HTTP cannot reach');
  }

  FINISHED = true;
  console.log(`public-menu: OK (${n})`);
})().catch((e) => { console.error('public-menu FAILED:', (e && e.stack) || e); process.exit(1); });
