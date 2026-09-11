'use strict';
// Portal 1A Task 8 — THE MIGRATION MUST NOT MOVE ONE CHARGED OR SERVED VALUE.
//
// This is the hardest claim in the slice, and the only way to make it is to price REAL CARTS through
// the REAL calculator, before and after, against a capture whose prices deliberately DISAGREE with
// the code tables. Agreement with code proves nothing here: the whole point of a provenance merge is
// the case where a merchant has published a price the code no longer knows about, and a migration
// that quietly rebuilds from code passes every count, every hash and every structural check while
// reverting that merchant's edit.
//
// Run: node catalog/migration-parity.test.js
const assert = require('assert');
const { makeDb } = require('./firestore-fake');
const { buildCatalogV2, formSource, readLiteral } = require('./form-menu-source');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT, computeServerTotal } = require('../menu-pricing');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { sourceRefOf, validateSource, canonicalize } = require('./source-store');
const { extrasKeyOf } = require('./form-menu-source');
const { publishVersion } = require('./catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { getRestaurantMenu } = require('./catalog-menu');
const { resolveExposure } = require('./extras-exposure');
const { docId } = require('./seed-catalog-core');
const { exposureCtx } = require('./exposure-source');
const {
  deployedArtifact, upgradeDocument, buildMigrationCandidate, captureActiveVersion, upgradeDraftInPlace,
} = require('../tools/migrate-catalog-display');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('migration-parity: FAILED — exited without completing'); process.exitCode = 1; } });

const BRANDS = ['x_pizza', 'la_musa'];
const ART = { x_pizza: deployedArtifact('x_pizza'), la_musa: deployedArtifact('la_musa') };

// ── A PRE-1A CAPTURE, reconstructed rather than invented ─────────────────────────────────────────
// What is live today: items carry their display record (1c-a persisted it), EXTRAS ARE PRICE-ONLY,
// and the structure predates every field this slice added — including an AUTHORED basePrice, which
// Task 7's validator now refuses outright. Derived from the real build so it cannot drift from what
// the code actually produced when those versions were written.
function preOneACapture(rid, { versionId = 'v-live-1', mutate = null } = {}) {
  const built = buildCatalogV2(rid);
  const structure = JSON.parse(JSON.stringify(built.structure));
  for (const f of ['extra_order', 'extra_categories', 'badges', 'exposure', 'extras_by_category', 'extras_by_item']) delete structure[f];
  if (structure.variant_items) {
    // the authored "desde" as it sits in every live version today
    const authored = readLiteral(formSource(rid), 'VARIANT_ITEMS', '{', '}') || {};
    for (const [k, spec] of Object.entries(structure.variant_items)) {
      if (authored[k] && authored[k].basePrice !== undefined) structure.variant_items[k] = { ...spec, basePrice: authored[k].basePrice };
    }
  }
  const capture = {
    versionId,
    items: built.items.map((i) => ({ key: i.key, price: i.price, display: i.display, ...(i.has_photo !== undefined ? { has_photo: i.has_photo } : {}) })),
    // 🔴 IN FIRESTORE'S OWN ORDER, not the menu's. A real capture reads a collection back in DOC-ID
    // order and the ids are content hashes, so the sequence is effectively random. Sorting the
    // fixture the same way is what makes "the migration restores the deployed order" a claim this
    // suite can actually test — in the capture's own order the two agreed by accident.
    extras: Object.entries(EXTRAS_BY_RESTAURANT[rid])
      .map(([key, price]) => ({ key, price }))
      .sort((a, b) => (docId(a.key) < docId(b.key) ? -1 : 1)),   // price-only, as persisted
    structure,
  };
  if (mutate) mutate(capture);
  return capture;
}

// The carts the gate names, in each brand's own line shape — x_pizza keys by NAME, la_musa by id,
// and the same asymmetry runs through extras. Getting it wrong prices nothing and the test passes
// for the wrong reason, so every cart is asserted to price non-trivially before it is compared.
const CARTS = {
  x_pizza: [
    { name: 'Carnivora', qty: 3, extras: [{ name: 'Pepperoni' }, { name: 'Pepperoni' }, { name: 'Mozzarella' }] },   // repeated occurrences
    { name: 'Margherita', qty: 2, extras: [{ name: 'Prosciutto' }] },
    { name: 'Nutella', qty: 1, extras: [] },                                                                        // the excluded dish, still orderable
    { name: 'Carnivora NY', qty: 1, extras: [] },
  ],
  la_musa: [
    { id: 'rice_03', qty: 2, extras: [{ id: 'protein_chicken', qty: 3 }] },                                          // qty extras
    { id: 'noodle_01_pollo', qty: 1, extras: [] },
    { id: 'dimsum_01', qty: 4, extras: [{ id: 'rice_white', qty: 1 }] },
  ],
};

const tablesOf = (rid, menu) => {
  const t = { restaurantId: rid, menu: {}, extras: {} };
  for (const i of menu.items) t.menu[i.key] = i.price;
  for (const e of menu.extras) t.extras[e.key] = e.price;
  return t;
};

(async () => {
  // ══ 1. THE MIGRATION IS A NO-OP ON WHAT IS CHARGED — including where live ≠ code ═══════════════
  for (const rid of BRANDS) {
    // A live price the code no longer knows about. This is the case the whole task exists for.
    const EDITED = rid === 'x_pizza' ? 'Carnivora' : 'dimsum_01';
    const codePrice = MENU_BY_RESTAURANT[rid][EDITED];
    const livePrice = codePrice + 7;
    // ...and a live EXTRA price too. That half matters separately: an extra's display record comes
    // from the ARTIFACT, which carries the price the form was SHIPPED with — exactly the value a live
    // edit has moved on from. Copying it across unchanged is how a migration leaves a dish advertising
    // a price it no longer costs, with every count and hash still agreeing.
    const EDITED_EXTRA = Object.keys(EXTRAS_BY_RESTAURANT[rid])[0];
    const codeExtra = EXTRAS_BY_RESTAURANT[rid][EDITED_EXTRA];
    const liveExtra = codeExtra + 11;
    const capture = preOneACapture(rid, { mutate: (c) => {
      const it = c.items.find((i) => i.key === EDITED);
      it.price = livePrice; it.display = { ...it.display, price: livePrice };
      c.extras.find((e) => e.key === EDITED_EXTRA).price = liveExtra;
    } });
    assert.notStrictEqual(livePrice, codePrice, 'premise: the live price really differs from code');
    assert.notStrictEqual(readLiteral(formSource(rid), 'EXTRAS').find((e) => e.name === EDITED_EXTRA || e.id === EDITED_EXTRA).price, liveExtra,
      'premise: the DEPLOYED artifact still shows the old option price');

    const { input, expected, source } = buildMigrationCandidate(rid, capture, ART[rid]);
    assert.strictEqual(expected.activeVersionId, capture.versionId, 'the candidate is bound to the version it captured');

    const db = makeDb();
    await publishVersion(db, rid, input, { expected: { activeVersionId: null } });
    const served = await getRestaurantMenu(db, rid);

    // (a) every charged value survives the merge
    const after = tablesOf(rid, served);
    const beforeMenu = {}; for (const i of capture.items) beforeMenu[i.key] = i.price;
    const beforeExtras = {}; for (const e of capture.extras) beforeExtras[e.key] = e.price;
    assert.deepStrictEqual(after.menu, beforeMenu, `🔴 ${rid}: an item price moved through the migration`);
    assert.deepStrictEqual(after.extras, beforeExtras, `🔴 ${rid}: an extra price moved through the migration`);
    assert.strictEqual(after.menu[EDITED], livePrice, `🔴 ${rid}: THE LIVE EDIT WAS REVERTED — ${livePrice} became ${after.menu[EDITED]}`);
    assert.notStrictEqual(after.menu[EDITED], codePrice, '...and specifically not back to the code price');
    assert.strictEqual(after.extras[EDITED_EXTRA], liveExtra, `🔴 ${rid}: the live OPTION price was reverted`);
    const shownExtra = served.extras.find((e) => e.key === EDITED_EXTRA).display.price;
    assert.strictEqual(shownExtra, liveExtra,
      `🔴 ${rid}/${EDITED_EXTRA}: the artifact's shipped price ${codeExtra} was carried into the display record over the live ${liveExtra}`);

    // (b) SERIALIZED CARTS, through the real calculator, before and after
    const beforeTables = { restaurantId: rid, menu: beforeMenu, extras: beforeExtras };
    const priced = computeServerTotal(CARTS[rid], rid, beforeTables);
    assert.ok(Number.isFinite(priced.total) && priced.total > 0, `premise: the ${rid} cart prices at all (${JSON.stringify(priced)})`);
    assert.deepStrictEqual(computeServerTotal(CARTS[rid], rid, after), priced,
      `🔴 ${rid}: a real cart prices differently after the migration`);
    // and the shown price follows the charged one, so no dish advertises what it no longer costs
    for (const i of served.items) assert.strictEqual(i.display.price, i.price, `🔴 ${rid}/${i.key}: shown ≠ charged after the merge`);
    for (const e of served.extras) assert.strictEqual(e.display.price, e.price, `🔴 ${rid}/${e.key}: shown ≠ charged after the merge`);

    ok(`${rid}: migration is byte-identical on price — a live ${EDITED} at L ${livePrice} (code says ${codePrice}) survives, and a ${CARTS[rid].length}-line cart prices at L ${priced.total} before and after`);
    void source;
  }

  {
    // 🔴 AN ITEM DESCRIBED ONLY BY THE ARTIFACT, whose live price has since moved. Items normally
    // carry their display record in the capture (1c-a persisted it), so the artifact half of the
    // shown-price correction never fires on a healthy capture — and a capture from before that, or
    // one with a gap, is exactly where it would matter. The artifact carries the price the form was
    // SHIPPED with; the live price is what the customer pays.
    const rid = 'x_pizza';
    const KEY = 'Margherita';
    const livePrice = MENU_BY_RESTAURANT[rid][KEY] + 13;
    const capture = preOneACapture(rid, { mutate: (c) => {
      const it = c.items.find((i) => i.key === KEY);
      it.price = livePrice;
      delete it.display;                      // described nowhere but the deployed form
    } });
    const artifactPrice = readLiteral(formSource(rid), 'MENU').find((d) => d.name === KEY).price;
    assert.notStrictEqual(artifactPrice, livePrice, 'premise: the deployed form still shows the old price');

    const { source, provenance } = buildMigrationCandidate(rid, capture, ART[rid]);
    const migrated = source.items.find((i) => i.key === KEY);
    assert.strictEqual(provenance[`items.${KEY}.display`], 'artifact', 'premise: the description really came from the artifact');
    assert.strictEqual(migrated.price, livePrice, 'the charged price is the live one');
    assert.strictEqual(migrated.display.price, livePrice,
      `🔴 the artifact's shipped price ${artifactPrice} was carried into the display record over the live ${livePrice} — the dish would advertise what it no longer costs`);
    ok(`a dish described only by the deployed form is migrated with its LIVE price shown (L ${livePrice}), not the form's L ${artifactPrice}`);
  }

  // ══ 2. THE DISPLAY DATASET THE CATALOG NEVER HAD, now complete ════════════════════════════════
  for (const rid of BRANDS) {
    const { source } = buildMigrationCandidate(rid, preOneACapture(rid), ART[rid]);
    assert.strictEqual(source.extras.length, Object.keys(EXTRAS_BY_RESTAURANT[rid]).length, `${rid}: every priced option`);
    assert.ok(source.extras.every((e) => e.display && e.display.name && e.display.cat), `🔴 ${rid}: an option came back unnamed`);
    assert.deepStrictEqual(source.extras.map((e) => e.display), readLiteral(formSource(rid), 'EXTRAS'),
      `🔴 ${rid}: the migrated options must be the DEPLOYED ones, field for field and in order`);
    assert.ok(source.structure.exposure, `${rid}: exposure is carried`);
    // 🔴 AND THE ORDER SURVIVES THE ROUND TRIP. `source.extras` is in the capture's order; what a
    // customer sees is extra_order, applied by the reader. Only publishing and reading back can tell
    // whether the ORDER options are offered in is the deployed one.
    const db = makeDb();
    const { input } = buildMigrationCandidate(rid, preOneACapture(rid), ART[rid]);
    await publishVersion(db, rid, input, { expected: { activeVersionId: null } });
    const servedNow = await getRestaurantMenu(db, rid);
    assert.deepStrictEqual(servedNow.extras.map((e) => e.display), readLiteral(formSource(rid), 'EXTRAS'),
      `🔴 ${rid}: the SERVED option order is not the deployed one`);
    ok(`${rid}: ${source.extras.length} options migrate with their deployed display records, and read back in the deployed order`);
  }
  {
    // 🔴 THE NUTELLA EXCLUSION, which no map could express. The renderer refuses extras for it by a
    // name comparison; after the migration that is data, and the resolver agrees.
    const { source } = buildMigrationCandidate('x_pizza', preOneACapture('x_pizza'), ART.x_pizza);
    const ctx = {
      ...exposureCtx(source.structure.exposure),
      extras: source.extras.map((e) => e.display),
      extraCategories: source.structure.extra_categories,
    };
    const exposedFor = (key) => {
      const it = source.items.find((i) => i.key === key);
      return resolveExposure({ key: it.key, cat: it.display.cat }, ctx);
    };
    assert.deepStrictEqual(exposedFor('Nutella'), [], '🔴 Nutella must be offered NOTHING — the form refuses it extras entirely');
    const margherita = exposedFor('Margherita');
    assert.strictEqual(margherita.length, source.extras.length, 'every other pizza is offered every option, as the renderer does');
    assert.deepStrictEqual(margherita, readLiteral(formSource('x_pizza'), 'EXTRAS').map((e) => e.id),
      '...in the order the form groups them');
    ok('the Nutella exclusion survives as DATA: offered nothing, while every other pizza is offered all 14 options in the served order');
  }

  // ══ 3. AMBIGUITY IS REFUSED, NEVER GUESSED ════════════════════════════════════════════════════
  {
    const rid = 'x_pizza';
    const cases = {
      'two artifact records resolving to one pricing key': [
        (a) => { a.extras = [...a.extras, { ...a.extras[0], id: 'e99' }]; }, null, /migration_refused_ambiguous/],
      'an artifact record that resolves to no pricing key at all': [
        (a) => { a.extras = [...a.extras, { id: 'e99', cat: 'Carnes', price: 10 }]; }, null, /migration_refused_unkeyable/],
      'an option the artifact offers and the catalog does not price': [
        (a) => { a.extras = [...a.extras, { id: 'e99', cat: 'Carnes', name: 'Ghost Topping', price: 10 }]; }, null, /migration_refused_unpriced/],
      'a priced option the artifact does not describe': [
        (a) => { a.extras = a.extras.slice(1); }, null, /migration_refused_undescribed/],
      'a dish the artifact offers and the catalog does not price': [
        (a) => { a.dishes = [...a.dishes, { id: 99, cat: 'individual', name: 'Ghost Dish', price: 100, desc: 'x', emoji: '👻', color: '#000' }]; },
        null, /migration_refused_unpriced/],
      'a priced dish nothing describes': [
        (a) => { a.dishes = a.dishes.slice(1); },
        (c) => { delete c.items[0].display; },   // and the capture cannot describe it either
        /migration_refused_undescribed/],
    };
    for (const [what, [mutateArtifact, mutateCapture, expected]] of Object.entries(cases)) {
      const artifact = JSON.parse(JSON.stringify(ART[rid]));
      mutateArtifact(artifact);
      const capture = preOneACapture(rid, { mutate: mutateCapture || undefined });
      assert.throws(() => buildMigrationCandidate(rid, capture, artifact), expected, `🔴 ${what} was MIGRATED`);
    }
    // ...and the unmutated pair still migrates, so the refusals are not "it refuses everything".
    assert.doesNotThrow(() => buildMigrationCandidate(rid, preOneACapture(rid), ART[rid]), 'a clean pair still migrates');
    ok(`ambiguity: ${Object.keys(cases).length} non-1:1 display↔price joins each refused with their own reason; a clean pair still migrates`);
  }

  // ══ 4. THE AUTHORED "desde" IS STRIPPED ═══════════════════════════════════════════════════════
  {
    const capture = preOneACapture('la_musa');
    assert.ok(capture.structure.variant_items.noodle_01.basePrice !== undefined,
      'premise: the captured version really does carry an authored basePrice');
    const { source, provenance } = buildMigrationCandidate('la_musa', capture, ART.la_musa);
    assert.ok(!Object.prototype.hasOwnProperty.call(source.structure.variant_items.noodle_01, 'basePrice'),
      '🔴 an authored basePrice survived — Task 7\'s validator refuses one, so this version could never publish');
    assert.strictEqual(provenance['structure.variant_items.noodle_01.basePrice'], 'stripped', 'and the strip is reported');
    // ...and the bundle re-derives the same number, so nothing a customer sees moved.
    const { rebuildFormMenu } = require('./form-menu-source');
    const built = buildCatalogV2('la_musa', { formData: require('./source-store').sourceToBuildInputs(source).formData, priceTable: require('./source-store').sourceToBuildInputs(source).priceTable, extrasTable: require('./source-store').sourceToBuildInputs(source).extras });
    const bundle = rebuildFormMenu('la_musa', built.items, built.structure, built.extras);
    assert.strictEqual(bundle.variant_items.noodle_01.basePrice, capture.structure.variant_items.noodle_01.basePrice,
      '🔴 the served "desde" changed — it must be re-derived to exactly the number that was authored');
    ok(`the authored basePrice is stripped from the candidate and re-derived identically at emission (desde L ${bundle.variant_items.noodle_01.basePrice})`);
  }

  // ══ 5. PROVENANCE IS A REPORT, NOT A FIELD ════════════════════════════════════════════════════
  {
    // The content hash covers the structure WHOLESALE, so a provenance marker written into
    // menu_structure would make two versions with an identical menu hash differently and read as
    // "changed" to 1B/1C. Asserted by value, not by inspection: the persisted doc is searched for the
    // provenance vocabulary, and two independent migrations of one capture must hash the same.
    const capture = preOneACapture('la_musa');
    const a = buildMigrationCandidate('la_musa', capture, ART.la_musa);
    const b = buildMigrationCandidate('la_musa', capture, ART.la_musa);
    assert.ok(Object.keys(a.provenance).length > 20, `non-vacuity: the merge must actually report provenance (${Object.keys(a.provenance).length} fields)`);
    const persisted = JSON.stringify(a.input.structure);
    for (const word of ['provenance', 'captured', 'artifact', 'stripped', '_from', '_source']) {
      assert.ok(!persisted.includes(word), `🔴 the persisted structure carries the provenance vocabulary ("${word}") — it would hash as a menu change`);
    }
    const db = makeDb();
    const v1 = await publishVersion(db, 'la_musa', a.input, { expected: { activeVersionId: null } });
    const h1 = (await getRestaurantMenu(db, 'la_musa')).identity.content_hash;
    const v2 = await publishVersion(db, 'la_musa', b.input, { expected: { activeVersionId: v1.versionId } });
    const h2 = (await getRestaurantMenu(db, 'la_musa')).identity.content_hash;
    assert.strictEqual(h2, h1, '🔴 two migrations of the SAME capture produced different content hashes');
    void v2;
    ok(`provenance is reported (${Object.keys(a.provenance).length} fields) and never persisted — two migrations of one capture hash identically`);
  }

  // ══ 6. THE DRAFT IS UPGRADED, NOT PUBLISHED ═══════════════════════════════════════════════════
  {
    const rid = 'la_musa';
    const KEY = 'dimsum_01';
    const db = makeDb();

    // A live version, and a DRAFT carrying a pending price edit that has not been published.
    const live = preOneACapture(rid);
    const { input } = buildMigrationCandidate(rid, live, ART[rid]);
    const published = await publishVersion(db, rid, input, { expected: { activeVersionId: null } });

    // The draft is a pre-1A source: no exposure, an authored basePrice, and the merchant's edit.
    const draft = JSON.parse(JSON.stringify(buildSourceFromCode(rid)));
    const PENDING = MENU_BY_RESTAURANT[rid][KEY] + 31;
    const it = draft.items.find((i) => i.key === KEY);
    it.price = PENDING; it.display.price = PENDING;
    for (const f of ['exposure', 'extra_order']) delete draft.structure[f];
    draft.structure.variant_items.noodle_01.basePrice = 307;
    await sourceRefOf(db, rid).set(canonicalize(draft));

    const res = await upgradeDraftInPlace(db, rid, ART[rid], { apply: true });
    assert.ok(res.upgraded && res.applied, 'the draft must actually be upgraded');
    const after = (await sourceRefOf(db, rid).get()).data();

    assert.strictEqual(after.items.find((i) => i.key === KEY).price, PENDING,
      '🔴 the merchant\'s PENDING edit was lost in the upgrade');
    assert.strictEqual(after.items.find((i) => i.key === KEY).display.price, PENDING, '...and its shown price with it');
    assert.ok(after.structure.exposure, 'the upgraded draft carries the new schema');
    assert.ok(!Object.prototype.hasOwnProperty.call(after.structure.variant_items.noodle_01, 'basePrice'),
      '🔴 an authored basePrice survived the upgrade — the merchant\'s next publish would fail on a document they never touched');
    assert.doesNotThrow(() => validateSource(after, rid), '🔴 the upgraded draft must validate — that is the whole point of upgrading it');
    // The draft is written VERBATIM — no builder in between to drop an unknown field — so it is the
    // document a stray provenance marker would actually survive in, and from there into the next
    // published version's structure hash.
    const draftJson = JSON.stringify(after);
    for (const word of ['provenance', '"captured"', '"artifact"', '"stripped"']) {
      assert.ok(!draftJson.includes(word), `🔴 the upgraded DRAFT carries the provenance vocabulary (${word})`);
    }

    // ...and NOTHING was published: the pointer, and the price a customer pays, are untouched.
    const pointer = (await db.collection('restaurants').doc(rid).collection('meta').doc('active_version').get()).data().version;
    assert.strictEqual(pointer, published.versionId, '🔴 the draft upgrade moved the active version');
    const servedNow = await getRestaurantMenu(db, rid);
    assert.strictEqual(servedNow.items.find((i) => i.key === KEY).price, MENU_BY_RESTAURANT[rid][KEY],
      `🔴 the PENDING edit went live — a customer is now charged ${PENDING} for a change nobody published`);
    ok(`the draft is upgraded in place: the pending ${KEY} edit at L ${PENDING} is preserved and still unpublished, the basePrice is stripped, and it validates`);
  }

  // ══ 6b. AND THE UPGRADE ITSELF IS CONDITIONAL ═════════════════════════════════════════════════
  {
    // A merchant saving between the upgrade's READ and its WRITE must not have it silently replaced
    // by an upgrade of the draft they just superseded. Same class as the publish CAS, one document
    // over — and the reason this suite's Firestore models `lastUpdateTime` rather than accepting
    // every write.
    //
    // 🔴 DRIVEN THROUGH upgradeDraftInPlace, not through a hand-written set(). The first version of
    // this called sourceRefOf(...).set(…, {lastUpdateTime}) directly and asserted it was refused —
    // which tests the FAKE, not the migration. Mutation caught it: removing the precondition from the
    // real code changed nothing here. The competing save now lands from INSIDE the read, so the
    // window is the real one.
    const rid = 'x_pizza';
    const db = makeDb();
    const draft = JSON.parse(JSON.stringify(buildSourceFromCode(rid)));
    delete draft.structure.exposure;                       // something for the upgrade to actually do
    await sourceRefOf(db, rid).set(canonicalize(draft));

    const edited = JSON.parse(JSON.stringify(draft));
    edited.items[0].price += 5; edited.items[0].display.price = edited.items[0].price;

    let raced = false;
    const wrap = (ref) => new Proxy(ref, {
      get(t, k) {
        if (k === 'get') {
          return async () => {
            const snap = await t.get();
            if (!raced && t.path.endsWith('/source')) { raced = true; await t.set(canonicalize(edited)); }
            return snap;
          };
        }
        if (k === 'collection') return (sub) => wrapCol(t.collection(sub));
        return typeof t[k] === 'function' ? t[k].bind(t) : t[k];
      },
    });
    const wrapCol = (col) => new Proxy(col, { get(t, k) { return k === 'doc' ? (id) => wrap(t.doc(id)) : (typeof t[k] === 'function' ? t[k].bind(t) : t[k]); } });
    const spied = { ...db, collection: (c) => wrapCol(db.collection(c)) };

    await assert.rejects(() => upgradeDraftInPlace(spied, rid, ART[rid], { apply: true }),
      /FAILED_PRECONDITION/, '🔴 the upgrade overwrote a draft saved since it read');
    assert.ok(raced, 'premise: the competing save really landed mid-upgrade');
    const still = (await sourceRefOf(db, rid).get()).data();
    assert.strictEqual(still.items[0].price, edited.items[0].price, 'the merchant\'s newer save stands');
    ok('the draft upgrade writes under a revision precondition — a save landing mid-upgrade is refused, not overwritten');
  }

  // ══ 6c. THE EXPOSURE AUTHORITY REFUSES WHAT IT CANNOT KNOW ════════════════════════════════════
  {
    const { deriveExposure, assertExposureMatchesToday } = require('./exposure-source');
    const xp = buildCatalogV2('x_pizza');
    const dishCategories = xp.structure.categories.map((c) => c.id);
    const extraCategories = xp.structure.extra_categories;

    // 🔴 THE GUARD READS THE SHIPPED FORM. A constant transcribed from a renderer line drifts the
    // moment someone adds a second excluded dish, and the catalog would keep offering options for a
    // pizza the form refuses to show them for. Planted both ways.
    assert.doesNotThrow(() => assertExposureMatchesToday('x_pizza', formSource('x_pizza')), 'the real form still matches the authored set');
    assert.throws(() => assertExposureMatchesToday('x_pizza', "const isNutella = pizza.name === 'Nutella';\nconst isTiramisu = pizza.name === 'Tiramisu';"),
      /exposure_source_drift/, '🔴 a SECOND excluded dish in the form must fail rather than be quietly un-migrated');
    assert.throws(() => assertExposureMatchesToday('x_pizza', 'const isNutella = false;'),
      /exposure_source_drift/, '🔴 the exclusion disappearing from the form must fail too');

    // A dish the exclusion names but the menu no longer has: the exclusion would silently evaporate.
    assert.throws(() => deriveExposure('x_pizza', { dishCategories, extraCategories, items: xp.items.filter((i) => i.key !== 'Nutella') }),
      /exposure_source_missing_item/, '🔴 an exclusion naming a dish that is gone must fail, not vanish');

    // An EXTRACTED brand with nothing to extract from must refuse rather than invent an allow-list —
    // inventing one would offer every option on every dish, which is a menu change nobody authored.
    assert.throws(() => deriveExposure('la_musa', { dishCategories, extraCategories, items: [] }),
      /exposure_source_missing/, '🔴 an extracted brand must not invent exposure when it has no map');
    assert.ok(deriveExposure('some_new_brand', {}) === null, 'a brand with no shipped renderer simply has no exposure to migrate');
    ok('the exposure authority is tied to the renderer: a second exclusion, a vanished one, a missing dish and a missing map are each refused');
  }

  // ══ 5b. AN UNKNOWN STRUCTURE FIELD CANNOT RIDE INTO A PERSISTED DOCUMENT ══════════════════════
  {
    // The publish path drops one in the builder; the DRAFT is persisted verbatim, so the draft is
    // where a stray field actually survives — and from there into the next published version's
    // structure hash, where it reads as "the menu changed". A pre-existing marker (from an earlier
    // tool, a debug stamp, someone's provenance annotation) is exactly that case, and it is not
    // covered by "the migration does not write one".
    const { KNOWN_STRUCTURE_FIELDS } = require('./source-store');
    const rid = 'la_musa';
    const capture = preOneACapture(rid, { mutate: (c) => {
      c.structure.provenance = { 'items.dimsum_01.price': 'captured' };
      c.structure._debug_marker = 'left by some earlier tool';
    } });
    const { source } = buildMigrationCandidate(rid, capture, ART[rid]);
    const persisted = JSON.stringify(source.structure);
    for (const word of ['provenance', '_debug_marker']) {
      assert.ok(!persisted.includes(word), `🔴 a pre-existing "${word}" survived into the document that gets persisted verbatim`);
    }
    // ...and the field list cannot fall behind the schema: whatever the real seed authors must be in
    // it, or the migration would DROP a field it was supposed to carry.
    for (const brand of BRANDS) {
      const unknown = Object.keys(buildSourceFromCode(brand).structure).filter((f) => !KNOWN_STRUCTURE_FIELDS.includes(f));
      assert.deepStrictEqual(unknown, [], `🔴 ${brand}: the seed authors structure fields the migration would silently drop: ${unknown.join(', ')}`);
    }
    assert.ok(KNOWN_STRUCTURE_FIELDS.includes('exposure') && !KNOWN_STRUCTURE_FIELDS.includes('provenance'),
      'non-vacuity: the list really distinguishes a schema field from a stray one');
    ok(`unknown structure fields are stripped before persistence (${KNOWN_STRUCTURE_FIELDS.length} known), and the known list covers everything the real seed authors`);
  }

  // ══ 6d. THE WHOLE CHAIN, THROUGH THE REAL CAPTURE WRITER ══════════════════════════════════════
  {
    // 🔴 EVERY OTHER CASE HERE FEEDS A RECONSTRUCTED CAPTURE. That reconstruction is faithful as far
    // as I know how to make it — but "as far as I know" is exactly the gap: a hand-built capture can
    // differ from what captureActiveVersion actually emits (doc-id ordering, field shapes, what a
    // record does and does not carry), and then the reconstruction agrees while the real path
    // diverges. This is the real-writer rule, and it has caught three defects in this slice already.
    //
    // So: an owner edit published on top of the live catalog, captured by the REAL reader, migrated,
    // published, read back, and CHARGED.
    for (const rid of BRANDS) {
      const db = makeDb();
      const seed = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'live' });
      const v1 = await publishVersion(db, rid, seed.input, { expected: seed.expected });

      // the owner publishes a price the code tables do not have
      const KEY = Object.keys(MENU_BY_RESTAURANT[rid])[0];
      const EDITED = MENU_BY_RESTAURANT[rid][KEY] + 9;
      const edited = { ...seed.input, items: seed.input.items.map((i) => (i.key === KEY ? { ...i, price: EDITED, display: { ...i.display, price: EDITED } } : i)) };
      await publishVersion(db, rid, edited, { expected: { activeVersionId: v1.versionId } });

      const before = await getRestaurantMenu(db, rid);
      assert.strictEqual(before.items.find((i) => i.key === KEY).price, EDITED, 'premise: the owner edit is live');
      const pricedBefore = computeServerTotal(CARTS[rid], rid, tablesOf(rid, before));
      assert.ok(pricedBefore.total > 0, `premise: the ${rid} cart prices at all`);

      // THE REAL CAPTURE — collections come back in doc-id order, which is where the ordering bug hid
      const captured = await captureActiveVersion(db, rid);
      assert.notDeepStrictEqual(captured.extras.map((e) => e.key), ART[rid].extras.map((e) => extrasKeyOf(rid, e)),
        'premise: the real capture really does come back in a different order than the deployed one');
      assert.ok(captured.extras.every((e) => e.display === undefined || e.display),
        'premise: the capture is whatever the store actually holds');

      const cand = buildMigrationCandidate(rid, captured, ART[rid]);
      await publishVersion(db, rid, cand.input, { expected: cand.expected });
      const after = await getRestaurantMenu(db, rid);

      assert.deepStrictEqual(tablesOf(rid, after).menu, tablesOf(rid, before).menu, `🔴 ${rid}: an item price moved`);
      assert.deepStrictEqual(tablesOf(rid, after).extras, tablesOf(rid, before).extras, `🔴 ${rid}: an extra price moved`);
      assert.strictEqual(after.items.find((i) => i.key === KEY).price, EDITED, `🔴 ${rid}: THE OWNER EDIT WAS REVERTED`);
      assert.deepStrictEqual(computeServerTotal(CARTS[rid], rid, tablesOf(rid, after)), pricedBefore,
        `🔴 ${rid}: the cart total moved through a real capture→migrate→publish→read cycle`);
      assert.deepStrictEqual(after.extras.map((e) => e.display), readLiteral(formSource(rid), 'EXTRAS'),
        `🔴 ${rid}: the SERVED option order is not the deployed one, off a REAL capture`);
      assert.strictEqual(after.items.length, before.items.length, `🔴 ${rid}: a dish went missing`);
      assert.strictEqual(after.extras.length, before.extras.length, `🔴 ${rid}: an option went missing`);
      ok(`${rid}: REAL chain — owner edit → publish → captureActiveVersion → migrate → publish → read → charge: ${KEY} held at L ${EDITED}, cart L ${pricedBefore.total} unchanged, ${after.extras.length} options in the deployed order`);
    }
  }

  // ══ 7. CAS-BOUND — a concurrent publish invalidates the migration ═════════════════════════════
  {
    const rid = 'x_pizza';
    const db = makeDb();
    const first = await publishVersion(db, rid, buildMigrationCandidate(rid, preOneACapture(rid), ART[rid]).input,
      { expected: { activeVersionId: null } });

    // The migration captures what is live...
    const captured = await captureActiveVersion(db, rid);
    assert.strictEqual(captured.versionId, first.versionId, 'premise: the capture is bound to what it read');
    const candidate = buildMigrationCandidate(rid, captured, ART[rid]);

    // ...and somebody publishes in between.
    const intervening = await publishVersion(db, rid, buildMigrationCandidate(rid, preOneACapture(rid, { versionId: first.versionId }), ART[rid]).input,
      { expected: { activeVersionId: first.versionId } });

    await assert.rejects(() => publishVersion(db, rid, candidate.input, { expected: candidate.expected }),
      /flip_cas_stale/, '🔴 a migration built from a superseded version was published over a newer one');
    const live = (await db.collection('restaurants').doc(rid).collection('meta').doc('active_version').get()).data().version;
    assert.strictEqual(live, intervening.versionId, 'and the newer version stands');
    ok('CAS-bound: a migration captured before an intervening publish aborts at the flip, and the newer version stands');
  }

  FINISHED = true;
  console.log(`migration-parity: OK (${n})`);
})().catch((e) => { console.error('migration-parity FAILED:', (e && e.stack) || e); process.exit(1); });
