'use strict';
// Portal 1A Task 5/6 — THE READER RETURNS THE COMPLETE SET, WITH IDENTITY, AND NEVER FALLS BACK —
// and the GENERATOR emits exactly what that reader read.
//
// Everything here originates from the REAL writer and the REAL reader. The fake below is a Firestore,
// not a fixture: publishVersion writes into it through its own lease, its own transactions and its own
// batches, and the reader reads back what actually landed. The one thing a hand-built expected value
// could never catch is a writer and a reader that disagree, which is exactly what this task is about.
//
// The fake returns each collection's docs in DOC-ID order, because the real one does and the ids are
// content hashes — so "the order Firestore gives you" is effectively arbitrary. A reader that forgot
// to order explicitly would pass against an insertion-ordered fake and serve a shuffled menu in
// production.
//
// Run: node catalog/catalog-menu.test.js
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { buildCatalogV2, formSource, readLiteral } = require('./form-menu-source');
const { MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { publishVersion } = require('./catalog-publish');
const { getRestaurantMenu, readVersionMenu, readFlatMenu } = require('./catalog-menu');
const { seedCatalog } = require('./seed-catalog-core');
const { catalogSnapshot, generateFormBundle, generateKdsManifest, serialize } = require('./generate-form-bundle');
const { contentHash } = require('./content-hash');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const BRANDS = ['x_pizza', 'la_musa'];
const REPO_ROOT = join(__dirname, '..', '..');
const BUNDLE_PATH = {
  x_pizza: join(REPO_ROOT, 'xpizza-orders', 'menu-bundle.generated.json'),
  la_musa: join(REPO_ROOT, 'la-musa-orders', 'menu-bundle.generated.json'),
};

// ── An in-memory Firestore: enough of the API for the REAL publish + read paths ──────────────────
function makeDb() {
  const docs = new Map();
  let clock = 1757000000000;
  let autoId = 0;
  const serverTime = () => Timestamp.fromMillis((clock += 1000));
  // serverTimestamp() sentinels are resolved on write, exactly as the server does — publishVersion's
  // lease depends on reading one back as a real Timestamp.
  const resolve = (v) => {
    if (v instanceof FieldValue) return serverTime();
    if (v instanceof Timestamp) return v;
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = resolve(v[k]); return o; }
    return v;
  };
  const snapOf = (path) => {
    const data = docs.get(path);
    return {
      exists: data !== undefined, id: path.split('/').pop(), ref: docRef(path),
      data: () => data, get: (f) => (data ? data[f] : undefined),
    };
  };
  function docRef(path) {
    return {
      path, id: path.split('/').pop(),
      collection: (sub) => colRef(`${path}/${sub}`),
      get: async () => snapOf(path),
      set: async (data) => { docs.set(path, resolve(data)); },
      create: async (data) => {
        if (docs.has(path)) throw new Error(`already_exists: ${path}`);
        docs.set(path, resolve(data));
      },
      delete: async () => { docs.delete(path); },
    };
  }
  function colRef(path) {
    return {
      doc: (id) => docRef(`${path}/${id === undefined ? `auto${++autoId}` : id}`),
      get: async () => {
        const out = [];
        for (const p of docs.keys()) {
          if (!p.startsWith(`${path}/`)) continue;
          if (p.slice(path.length + 1).includes('/')) continue;    // direct children only
          out.push(snapOf(p));
        }
        out.sort((a, b) => (a.id < b.id ? -1 : 1));                // DOC-ID order, like the real one
        return { docs: out, empty: out.length === 0, forEach: (f) => out.forEach(f) };
      },
    };
  }
  return {
    collection: (c) => colRef(c),
    batch: () => {
      const ops = [];
      return {
        set: (ref, d) => ops.push(() => ref.set(d)),
        create: (ref, d) => ops.push(() => ref.create(d)),
        delete: (ref) => ops.push(() => ref.delete()),
        commit: async () => { for (const op of ops) await op(); },
      };
    },
    runTransaction: async (fn) => fn({
      get: (ref) => ref.get(),
      set: (ref, d) => { docs.set(ref.path, resolve(d)); },
      delete: (ref) => { docs.delete(ref.path); },
    }),
    _raw: docs,
  };
}

const inputsFor = (rid, over = {}) => {
  const v2 = buildCatalogV2(rid);
  return {
    items: over.items || v2.items,
    structure: over.structure || v2.structure,
    extras: EXTRAS_BY_RESTAURANT[rid] || {},
    extraRecords: over.extraRecords || v2.extras,
    source_sha: over.source_sha || 'task5-test',
  };
};

(async () => {
  // ══ 1. THE COMPLETE SET ═══════════════════════════════════════════════════════════════════════
  const db = makeDb();
  const published = {};
  for (const rid of BRANDS) {
    published[rid] = (await publishVersion(db, rid, inputsFor(rid))).versionId;
    const menu = await getRestaurantMenu(db, rid);
    assert.deepStrictEqual(Object.keys(menu).sort(), ['extras', 'identity', 'items', 'structure', 'variants'],
      `${rid}: the reader must return the complete set`);
    assert.strictEqual(menu.items.length, Object.keys(MENU_BY_RESTAURANT[rid]).length, `${rid}: every priced item`);
    assert.strictEqual(menu.extras.length, Object.keys(EXTRAS_BY_RESTAURANT[rid]).length, `${rid}: every priced extra`);
    assert.ok(menu.extras.every((e) => e.display && e.display.name), `🔴 ${rid}: an extra came back unnamed`);
    assert.ok(menu.items.every((i) => i.display && i.display.name), `🔴 ${rid}: an item came back unnamed`);
    ok(`${rid}: the reader returns ${menu.items.length} items + ${menu.extras.length} named extras + variants + structure + identity`);
  }
  {
    const lm = await getRestaurantMenu(db, 'la_musa');
    assert.strictEqual(lm.variants.noodle_01.basePrice, 307, '🔴 the launcher\'s desde is derived on read');
    assert.strictEqual(lm.items.find((i) => i.key === 'noodle_01').price, 414, '...while the launcher keeps its own price');
    const xp = await getRestaurantMenu(db, 'x_pizza');
    assert.deepStrictEqual(xp.variants, {}, 'a brand with no variants reads back an empty map, not undefined');
    ok('variants resolve on read: la_musa desde L307 off a L414 launcher; x_pizza has none');
  }
  {
    // ORDER IS SERVED ORDER, not the order Firestore handed the docs back in.
    const menu = await getRestaurantMenu(db, 'x_pizza');
    const raw = await db.collection('restaurants').doc('x_pizza').collection('versions').doc(published.x_pizza)
      .collection('extras').get();
    const rawOrder = raw.docs.map((d) => d.data().key);
    const served = menu.extras.map((e) => e.key);
    assert.deepStrictEqual(served, menu.structure.extra_order, 'extras are served in extra_order');
    assert.notDeepStrictEqual(rawOrder, served,
      'premise: the store really does hand these back in a different order — otherwise this proves nothing');
    assert.deepStrictEqual(menu.extras.map((e) => e.display), readLiteral(formSource('x_pizza'), 'EXTRAS'),
      '🔴 and the served order is the authored one, field for field');
    ok(`ordering: extras come back in doc-id order (${rawOrder[0]} first) and are SERVED in authored order (${served[0]} first)`);
  }

  // ══ 2. IDENTITY OVER THE WHOLE PAYLOAD ════════════════════════════════════════════════════════
  {
    const { identity } = await getRestaurantMenu(db, 'la_musa');
    assert.deepStrictEqual(Object.keys(identity).sort(), ['content_hash', 'rid', 'schema_version', 'seq', 'version_id']);
    assert.strictEqual(identity.rid, 'la_musa');
    assert.strictEqual(identity.schema_version, 2);
    assert.strictEqual(identity.version_id, published.la_musa, 'the identity names the version actually served');
    assert.strictEqual(identity.seq, 1, 'and its ordinal');
    assert.ok(/^[0-9a-f]{64}$/.test(identity.content_hash), 'a FULL sha256 — never a truncated prefix');
    ok(`identity: {rid, schema_version, version_id, seq, content_hash} — ${identity.version_id} seq 1`);
  }
  {
    // 🔴 THE DISCRIMINATING CASE. Four versions OF THE SAME RESTAURANT, each differing from the
    // control in ONE thing a customer sees and NOTHING a customer pays.
    //
    // Same restaurant deliberately: `rid` is part of the fingerprint, so comparing two brands' hashes
    // comes out different no matter what the hash covered. The first version of this test did exactly
    // that, and passed while the hash ignored the entire structure — found by mutation, not by review.
    const rid = 'skew_shop';
    const base = buildCatalogV2('x_pizza');
    const control = (await publishVersion(db, rid, inputsFor('x_pizza'))).versionId;
    const recordOf = async (vid) => (await db.collection('restaurants').doc(rid).collection('versions').doc(vid).get()).data();
    const controlRec = await recordOf(control);
    const controlHash = (await readVersionMenu(db, rid, control)).identity.content_hash;

    const skews = {
      'a renamed dish': { items: base.items.map((i, idx) => (idx === 0 ? { ...i, display: { ...i.display, name: `${i.display.name} ` } } : i)) },
      'a renamed OPTION': { extraRecords: base.extras.map((e, idx) => (idx === 0 ? { ...e, display: { ...e.display, name: `${e.display.name} ` } } : e)) },
      'a changed option EXPOSURE': { structure: { ...base.structure, extras_by_category: { individual: ['Carnes'] } } },
      'a reordered option list': { structure: { ...base.structure, extra_order: [base.structure.extra_order[1], base.structure.extra_order[0], ...base.structure.extra_order.slice(2)] } },
    };
    for (const [what, over] of Object.entries(skews)) {
      const vid = (await publishVersion(db, rid, { ...inputsFor('x_pizza'), ...over })).versionId;
      const rec = await recordOf(vid);
      assert.strictEqual(rec.menu_hash, controlRec.menu_hash, `premise: ${what} moves no item price`);
      assert.strictEqual(rec.extras_hash, controlRec.extras_hash, `premise: ${what} moves no extra price`);
      assert.notStrictEqual((await readVersionMenu(db, rid, vid)).identity.content_hash, controlHash,
        `🔴 ${what} produced the SAME content hash — a version skew 1B/1C could not see`);
    }
    ok('identity DISCRIMINATES: a renamed dish, a renamed option, a changed exposure and a reordered option list each move content_hash while BOTH money hashes collide');
  }
  {
    // ...and it is not merely "any two versions differ": the same payload hashes the same.
    const a = contentHash({ rid: 'x_pizza', schema_version: 2, ...catalogSnapshot('x_pizza') });
    const b = contentHash({ rid: 'x_pizza', schema_version: 2, ...catalogSnapshot('x_pizza') });
    const live = (await getRestaurantMenu(db, 'x_pizza')).identity.content_hash;
    assert.strictEqual(a, b, 'the hash is stable for identical content');
    assert.strictEqual(a, live, '🔴 and the bootstrap payload hashes to exactly what the published version reads back as');
    assert.notStrictEqual(a, contentHash({ rid: 'la_musa', schema_version: 2, ...catalogSnapshot('la_musa') }), 'different menus, different hashes');
    ok('identity is STABLE: identical content hashes identically, and the in-memory build matches the published version byte for byte');
  }
  {
    // 🔴 HASHED OVER WHAT IS SERVED, NOT OVER WHAT WAS PASSED IN. The caller's array order carries no
    // meaning — item_order does — so handing the same menu in a different order must produce the SAME
    // fingerprint. A publisher that hashed its own inputs would pin a value the reader (which reads
    // back in served order) could never reproduce, and every read of that version would fail closed.
    const rid = 'order_agnostic_shop';
    const v2 = buildCatalogV2('x_pizza');
    const canonical = (await publishVersion(db, rid, inputsFor('x_pizza'))).versionId;
    const shuffled = (await publishVersion(db, rid, {
      ...inputsFor('x_pizza'),
      items: v2.items.slice().reverse(),
      extraRecords: v2.extras.slice().reverse(),
    })).versionId;
    const A = await readVersionMenu(db, rid, canonical);
    const B = await readVersionMenu(db, rid, shuffled);
    assert.deepStrictEqual(B.items.map((i) => i.key), A.items.map((i) => i.key), 'both serve in item_order regardless of input order');
    assert.strictEqual(B.identity.content_hash, A.identity.content_hash,
      '🔴 the same menu passed in a different order fingerprinted differently');
    ok('the fingerprint is over the SERVED payload: the same menu handed in reverse order hashes identically and reads back identically');
  }

  // ══ 3. RE-CHECK ON READ — every plant fails CLOSED, with its own code ═════════════════════════
  {
    const vpath = (rid, vid) => db.collection('restaurants').doc(rid).collection('versions').doc(vid);
    const plant = async (label, mutate, code) => {
      const rid = `plant_${label.replace(/\W+/g, '_')}`;
      const { versionId } = await publishVersion(db, rid, inputsFor('x_pizza'));
      assert.ok(await getRestaurantMenu(db, rid), 'premise: it reads cleanly BEFORE the plant');
      await mutate(rid, versionId);
      await assert.rejects(() => getRestaurantMenu(db, rid), (e) => {
        assert.strictEqual(e.code, code, `${label}: expected code ${code}, got ${e.code} (${e.message})`);
        return true;
      }, `🔴 ${label} was SERVED`);
    };
    const firstItem = async (rid, vid) => (await vpath(rid, vid).collection('menu_items').get()).docs[0];
    const firstExtra = async (rid, vid) => (await vpath(rid, vid).collection('extras').get()).docs[0];

    await plant('a shown price that disagrees with the charged one', async (rid, vid) => {
      const d = await firstItem(rid, vid);
      await d.ref.set({ ...d.data(), display: { ...d.data().display, price: d.data().price + 1 } });
    }, 'catalog_price_disagreement');

    await plant('a display record with no price at all', async (rid, vid) => {
      const d = await firstExtra(rid, vid);
      const { price: _gone, ...rest } = d.data().display;
      await d.ref.set({ ...d.data(), display: rest });
    }, 'catalog_display_price_missing');

    await plant('an extra stripped of its display record', async (rid, vid) => {
      const d = await firstExtra(rid, vid);
      await d.ref.set({ key: d.data().key, price: d.data().price });
    }, 'catalog_missing_display');

    await plant('a dish renamed in place', async (rid, vid) => {
      const d = await firstItem(rid, vid);
      await d.ref.set({ ...d.data(), display: { ...d.data().display, name: 'TAMPERED' } });
    }, 'catalog_content_mismatch');

    await plant('an option dropped from extra_order', async (rid, vid) => {
      const s = await vpath(rid, vid).collection('meta').doc('menu_structure').get();
      await s.ref.set({ ...s.data(), extra_order: s.data().extra_order.slice(1) });
    }, 'menu_structure_bad');

    await plant('a record naming a different version', async (rid, vid) => {
      const r = await vpath(rid, vid).get();
      await r.ref.set({ ...r.data(), version: 'v-somebody-elses' });
    }, 'version_identity_mismatch');

    await plant('a record with its content hash removed', async (rid, vid) => {
      const r = await vpath(rid, vid).get();
      const { content_hash: _gone, ...rest } = r.data();
      await r.ref.set(rest);
    }, 'version_content_hash_missing');

    await plant('a record with no ordinal', async (rid, vid) => {
      const r = await vpath(rid, vid).get();
      const { seq: _gone, ...rest } = r.data();
      await r.ref.set(rest);
    }, 'version_seq_missing');

    await plant('a record claiming a schema we do not serve', async (rid, vid) => {
      const r = await vpath(rid, vid).get();
      await r.ref.set({ ...r.data(), schema_version: 3 });
    }, 'version_schema_unsupported');

    ok('fail-closed on read: 9 distinct plants each refused with its OWN typed code — none served');
  }
  {
    // The display tamper above is the one the MONEY descriptor cannot see. Stated as its own claim,
    // because "the reader threw" is not the point — the point is which check caught it.
    const rid = 'plant_a_dish_renamed_in_place';
    const vid = (await db.collection('restaurants').doc(rid).collection('meta').doc('active_version').get()).data().version;
    const rec = (await db.collection('restaurants').doc(rid).collection('versions').doc(vid).get()).data();
    const { readVersionDocs } = require('./catalog-firestore');
    await assert.doesNotReject(() => readVersionDocs(db, rid, vid),
      'premise: the MONEY reader is perfectly happy with a renamed dish — prices did not move');
    assert.ok(rec.menu_hash && rec.content_hash !== undefined);
    ok('the renamed-dish tamper passes every money check and is caught ONLY by content_hash — which is why it exists');
  }

  // ══ 4. NO FALLBACK EVER SUBSTITUTES FOR IMMUTABLE IDENTITY ════════════════════════════════════
  {
    const flat = makeDb();
    const v2 = buildCatalogV2('la_musa');
    await seedCatalog(flat, {
      la_musa: {
        profile: { name: 'La Musa', tier: 'flagship', schema_version: 2 },
        menu: MENU_BY_RESTAURANT.la_musa, extras: EXTRAS_BY_RESTAURANT.la_musa,
        v2Items: v2.items, v2Extras: v2.extras, structure: v2.structure,
      },
    });
    // The flat data is really there and really complete — this is what the old reader returned.
    const viaFlat = await readFlatMenu(flat, 'la_musa');
    assert.strictEqual(viaFlat.items.length, 44);
    assert.strictEqual(viaFlat.extras.length, 14);
    assert.strictEqual(viaFlat.identity, undefined,
      '🔴 a flat read must carry NO identity — it has no version, no ordinal and no pinned hash to tell the truth with');
    // ...and the pointer-resolving reader refuses it anyway.
    await assert.rejects(() => getRestaurantMenu(flat, 'la_musa'), (e) => {
      assert.strictEqual(e.code, 'active_version_absent');
      return true;
    }, '🔴 an absent pointer fell back to flat data — a menu with a provenance nobody can state');
    ok('no fallback: a COMPLETE flat menu sits right there, readFlatMenu returns it identity-less, and getRestaurantMenu still refuses');
  }
  {
    // A version-specific read is about THAT version. With an active pointer set and a healthy
    // version behind it, asking for a version that does not exist must not quietly answer with the
    // live one.
    await assert.rejects(() => readVersionMenu(db, 'x_pizza', 'v-never-published'), (e) => {
      assert.strictEqual(e.code, 'version_missing');
      return true;
    });
    await assert.rejects(() => readVersionMenu(db, 'x_pizza', null), (e) => {
      assert.strictEqual(e.code, 'version_id_required');
      return true;
    }, 'a missing version id is a caller bug, not an invitation to resolve the pointer');
    const live = await getRestaurantMenu(db, 'x_pizza');
    assert.strictEqual(live.identity.version_id, published.x_pizza, 'premise: there WAS a live version to wrongly fall back to');
    ok('a version-specific read answers about that version or fails — it never substitutes the active one');
  }

  // ══ 4b. A CANDIDATE THE READER WOULD REFUSE NEVER REACHES THE POINTER ═════════════════════════
  {
    // The pre-flip verify asks the READER, not a hand-rolled item_order check. That matters because
    // the hand-rolled one knew about exactly one rule: it would have certified as publishable a
    // version with unnamed options or a lost option ordering, and the first anyone would know is a
    // menu serving no add-ons. One rule set, asked before the flip and again at serve time.
    const rid = 'refuse_shop';
    const good = (await publishVersion(db, rid, inputsFor('x_pizza'))).versionId;
    const pointer = async () => (await db.collection('restaurants').doc(rid).collection('meta').doc('active_version').get()).data().version;
    assert.strictEqual(await pointer(), good, 'premise: there is a good version live to be overwritten');

    const { extra_order: _dropped, ...noExtraOrder } = buildCatalogV2('x_pizza').structure;
    await assert.rejects(() => publishVersion(db, rid, { ...inputsFor('x_pizza'), structure: noExtraOrder }),
      /publish_refused_structure/, '🔴 a structure that lost its option ordering was accepted');
    assert.strictEqual(await pointer(), good, '...and the pointer stayed on the good version');

    await assert.rejects(() => publishVersion(db, rid, { ...inputsFor('x_pizza'), extraRecords: [] }),
      (e) => { assert.strictEqual(e.code, 'catalog_missing_display', `got ${e.code}: ${e.message}`); return true; },
      '🔴 a version whose options have no display records reached the flip');
    assert.strictEqual(await pointer(), good, '...and the pointer stayed on the good version');
    ok('publish fail-closed: a lost option ordering and unnamed options are each refused BEFORE the flip; the live version is untouched');
  }

  // ══ 5. READER == GENERATOR, both originating from the same published version ══════════════════
  for (const rid of BRANDS) {
    const fromStore = await getRestaurantMenu(db, rid);
    const fromBootstrap = catalogSnapshot(rid);
    const committed = readFileSync(BUNDLE_PATH[rid], 'utf8');
    assert.strictEqual(serialize(generateFormBundle(rid, fromStore)), committed,
      `🔴 ${rid}: the bundle generated off the PUBLISHED VERSION is not the committed artifact`);
    assert.strictEqual(serialize(generateFormBundle(rid, fromBootstrap)), committed,
      `${rid}: ...nor is the bootstrap one`);
    const bundle = generateFormBundle(rid, fromStore);
    assert.deepStrictEqual(bundle.extras, readLiteral(formSource(rid), 'EXTRAS'),
      `${rid}: the generated extras equal the form's own EXTRAS, field for field AND in order`);
    assert.strictEqual(`${JSON.stringify(generateKdsManifest(rid, fromStore), null, 2)}\n`,
      readFileSync(join(REPO_ROOT, 'menus', `${rid}.json`), 'utf8'),
      `${rid}: the KDS manifest off the published version == the committed manifest`);
    ok(`reader==generator ${rid}: bundle + KDS manifest generated off the published version are byte-identical to the committed artifacts`);
  }
  {
    // NON-VACUITY: a value that exists ONLY in the published version must reach the artifact. If the
    // generator were quietly re-reading the form, every assertion above would still pass.
    const rid = 'sentinel_shop';
    const v2 = buildCatalogV2('la_musa');
    const items = v2.items.map((i, idx) => (idx === 0 ? { ...i, display: { ...i.display, name: 'ONLY-IN-THE-VERSION' } } : i));
    await publishVersion(db, rid, { ...inputsFor('la_musa'), items });
    const snap = await getRestaurantMenu(db, rid);
    const bundle = generateFormBundle('la_musa', snap);
    const firstKey = v2.structure.item_order[0];
    assert.strictEqual(bundle.dishes[0].name, 'ONLY-IN-THE-VERSION', 'the version-only name reaches the bundle');
    assert.strictEqual(generateKdsManifest('la_musa', snap).find((m) => m.key === firstKey).label, 'ONLY-IN-THE-VERSION',
      '...and the KDS label');
    assert.notStrictEqual(JSON.parse(readFileSync(BUNDLE_PATH.la_musa, 'utf8')).dishes[0].name, 'ONLY-IN-THE-VERSION',
      'and the committed artifact does NOT carry it — so the equality above was not a tautology');
    ok('non-vacuity: a display value existing ONLY in the published version flows into both artifacts');
  }
  {
    // An extras-only sentinel, separately: extras are the collection this task added, and the dish
    // sentinel above would pass even if extras were being read from somewhere else entirely.
    const rid = 'sentinel_extras';
    const v2 = buildCatalogV2('x_pizza');
    const extraRecords = v2.extras.map((e, idx) => (idx === 0 ? { ...e, display: { ...e.display, name: 'OPTION-ONLY-IN-THE-VERSION' } } : e));
    await publishVersion(db, rid, { ...inputsFor('x_pizza'), extraRecords });
    const snap = await getRestaurantMenu(db, rid);
    assert.strictEqual(generateFormBundle('x_pizza', snap).extras[0].name, 'OPTION-ONLY-IN-THE-VERSION');
    assert.notStrictEqual(readLiteral(formSource('x_pizza'), 'EXTRAS')[0].name, 'OPTION-ONLY-IN-THE-VERSION',
      'the form does not carry it — the extras really came from the version');
    ok('non-vacuity: an EXTRA named only in the published version flows into the bundle');
  }

  // ══ 6. OFFLINE + CREDENTIAL-FREE ══════════════════════════════════════════════════════════════
  {
    const admin = require('firebase-admin');
    assert.strictEqual(admin.apps.length, 0,
      '🔴 something in the read/generate path initialized a Firebase app — offline CI would need credentials');
    const generatorSrc = readFileSync(join(__dirname, 'generate-form-bundle.js'), 'utf8');
    assert.ok(!/firebase-admin|applicationDefault|sourceRefOf|meta\/source/.test(generatorSrc),
      'the generator reaches no credential, no admin SDK and no DRAFT — it is a pure function of a catalog snapshot');
    ok('offline: this whole suite ran with zero Firebase apps initialized; the generator touches no credential and no draft');
  }

  console.log(`catalog-menu: OK (${n})`);
})().catch((e) => { console.error('catalog-menu FAILED:', (e && e.stack) || e); process.exit(1); });
