'use strict';
// PLAN-public-menu-display r2 T2 — `photos`: absolute dish photo URLs in a SEPARATE top-level body field.
//
// Never on the dish records: the cart serializes whole served records into the order, so a new dish field would move
// live fingerprints. A decoration that never fails a serve: no base, an ambiguous manifest or any throw → the field is
// omitted and the body is otherwise identical. One rule keyed on catalog DATA, not on the rid; the base is the order
// site's origin from the platform manifest.
// Run: node catalog/public-photos.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { assetBaseFor, buildPhotos, photosFor } = require('./public-photos');
const { makeDb } = require('./firestore-fake');
const { publishVersion } = require('./catalog-publish');
const { buildPublishCandidate } = require('../tools/publish-version');
const { catalogSnapshot } = require('./generate-form-bundle');
const { buildPublicMenu, REPRESENTATION_VERSION, BODY_CONTRACT } = require('./public-menu');
const SITES = require('../platform/sites.json');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('public-photos: FAILED — exited without completing'); process.exitCode = 1; } });
const REPO = path.join(__dirname, '..', '..');

// ── synthetic brands: one img-keyed, one has_photo-keyed (the two real data shapes, no brand literal) ──────────
const dep = (id, context, origins, app = 'orders') => ({ id, app, folder: `${id}-dir`, entrypoints: ['index.html'], context, origins, netlify_site: id });
const sites = (...deployments) => ({ schema: 1, apps: ['orders', 'kitchen'], deployments });
const S = sites(dep('orders-tb-alpha', 'tb_alpha', ['https://orders.tb-alpha.test']), dep('orders-tb-beta', 'tb_beta', ['https://orders.tb-beta.test']),
  dep('kitchen-tb-alpha', 'tb_alpha', ['https://kds.tb-alpha.test'], 'kitchen'));
const item = (key, display, has_photo) => ({ key, price: 100, display: { price: 100, cat: 'c1', ...display }, ...(has_photo === undefined ? {} : { has_photo }) });
const ALPHA = { items: [item('Uno', { id: 1, name: 'Uno', img: 'images/01-uno.jpg' }), item('Dos', { id: 2, name: 'Dos' }), item('Tres', { id: 3, name: 'Tres', img: 'images/03-tres.jpg' })], structure: {} };
const BETA = { items: [item('b_01', { id: 'b_01', name: 'B1' }, true), item('b_02', { id: 'b_02', name: 'B2' }, false), item('b_03', { id: 'b_03', name: 'B3' }, true)], structure: {} };

(async () => {
  // ── 1. the base: exactly one orders deployment for the rid, with exactly one exact https origin ─────────────────
  {
    assert.strictEqual(assetBaseFor('tb_alpha', S), 'https://orders.tb-alpha.test/', 'the orders deployment of this rid (the kitchen one is ignored)');
    assert.strictEqual(assetBaseFor('tb_beta', S), 'https://orders.tb-beta.test/');
    assert.strictEqual(assetBaseFor('tb_gamma', S), null, 'no orders deployment → no base');
    assert.strictEqual(assetBaseFor('tb_alpha', sites(dep('a', 'tb_alpha', ['https://a.test']), dep('b', 'tb_alpha', ['https://b.test']))), null, 'two orders deployments → ambiguous → null');
    assert.strictEqual(assetBaseFor('tb_alpha', sites(dep('a', 'tb_alpha', ['https://a.test', 'https://b.test']))), null, 'two origins → ambiguous → null');
    assert.strictEqual(assetBaseFor('tb_alpha', sites(dep('a', 'tb_alpha', []))), null, 'no origin → null');
    for (const bad of ['http://a.test', 'https://a.test/', 'https://a.test/x', 'javascript:alert(1)', 7, null]) {
      assert.strictEqual(assetBaseFor('tb_alpha', sites(dep('a', 'tb_alpha', [bad]))), null, `a non-exact https origin (${JSON.stringify(bad)}) → null`);
    }
    for (const junk of [null, {}, { deployments: 'x' }, { deployments: [null, 7] }]) assert.strictEqual(assetBaseFor('tb_alpha', junk), null, 'a malformed manifest → null');
    ok('assetBaseFor: the one orders deployment of the rid, its one exact https origin + "/"; none / two / non-https / malformed → null');
  }

  // ── 2. the rule, keyed on data: a relative img, else has_photo's card/hero files, else absent ───────────────────
  {
    const base = 'https://orders.tb-alpha.test/';
    assert.deepStrictEqual(buildPhotos(ALPHA, base), {
      1: { card: `${base}images/01-uno.jpg`, hero: `${base}images/01-uno.jpg` },
      3: { card: `${base}images/03-tres.jpg`, hero: `${base}images/03-tres.jpg` },
    }, 'img → card = hero = base + img; no photo → absent');
    const bb = 'https://orders.tb-beta.test/';
    assert.deepStrictEqual(buildPhotos(BETA, bb), {
      b_01: { card: `${bb}images/b_01-card.webp`, hero: `${bb}images/b_01-hero.webp` },
      b_03: { card: `${bb}images/b_03-card.webp`, hero: `${bb}images/b_03-hero.webp` },
    }, 'has_photo → the card/hero files; has_photo false → absent');
    assert.deepStrictEqual(Object.keys(buildPhotos(BETA, bb)), ['b_01', 'b_03'], 'keyed by String(dish.id), in item order');
    // an img that is not a plain relative path is SKIPPED — never emitted, and never a fallback to has_photo
    for (const img of ['https://evil.test/x.jpg', '//evil.test/x.jpg', '/images/x.jpg', '../x.jpg', 'images/../../x.jpg', 'images\\x.jpg', 'images/a b.jpg', 'images/x.jpg?q=1', 'data:image/png;base64,AA', '', 7]) {
      const c = { items: [item('k', { id: 'k', name: 'K', img }, true)], structure: {} };
      assert.deepStrictEqual(buildPhotos(c, base), {}, `img ${JSON.stringify(img)} → skipped`);
    }
    // a has_photo key that is not a plain file-name segment is skipped too
    for (const key of ['a/b', '../x', 'a b', '']) {
      assert.deepStrictEqual(buildPhotos({ items: [item(key, { id: key || 'x', name: 'K' }, true)], structure: {} }, base), {}, `key ${JSON.stringify(key)} → skipped`);
    }
    assert.deepStrictEqual(buildPhotos({ items: [], structure: {} }, base), {}, 'no photos → an empty map');
    ok('buildPhotos: img → base+img (card = hero); has_photo → <key>-card/-hero.webp; nothing → absent; unsafe img / key skipped, never emitted');
  }

  // ── 3. photosFor never throws: trouble → null (the caller omits the field) ──────────────────────────────────────
  {
    assert.deepStrictEqual(photosFor('tb_alpha', ALPHA, S), buildPhotos(ALPHA, 'https://orders.tb-alpha.test/'));
    assert.strictEqual(photosFor('tb_gamma', ALPHA, S), null, 'no base → null');
    assert.strictEqual(photosFor('tb_alpha', { items: 'x' }, S), null, 'a malformed catalog → null');
    const exploding = { get items() { throw new Error('boom'); }, structure: {} };
    assert.strictEqual(photosFor('tb_alpha', exploding, S), null, 'a throw → null');
    ok('photosFor: the photos, or null on no base / a malformed catalog / a throw — it never throws');
  }

  // ── 4. served by buildPublicMenu: declared, covered by the etag, and degrade-only ───────────────────────────────
  {
    assert.deepStrictEqual(BODY_CONTRACT.photos, { type: 'object' }, 'declared, optional, never fromSource-required');
    assert.strictEqual(REPRESENTATION_VERSION, '1d.2', 'the served marker is 1d.2 (D3 RULED)');
    const known = new Set(['x_pizza', 'la_musa']);
    const seeded = async (rid) => {
      const db = makeDb();
      const { input, expected } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'photos' });
      await publishVersion(db, rid, input, { expected });
      return db;
    };
    for (const rid of ['x_pizza', 'la_musa']) {
      const db = await seeded(rid);
      const live = await buildPublicMenu(db, rid, { known, isActive: async () => true });
      assert.strictEqual(live.representation_version, '1d.2');
      assert.ok(live.body.photos && Object.keys(live.body.photos).length > 0, `${rid}: the default (the platform manifest) serves photos`);
      // dish records are untouched: no dish carries a photo field it did not carry before
      assert.ok(live.body.dishes.every((d) => !('photo' in d) && !('photos' in d)), `${rid}: dish records unchanged`);
      // degrade: no base → no field, and the rest of the body is byte-equal
      const none = await buildPublicMenu(db, rid, { known, isActive: async () => true, sites: sites() });
      assert.ok(!('photos' in none.body), `${rid}: no base → photos omitted`);
      const { photos: _p, ...rest } = live.body; void _p;
      assert.deepStrictEqual(none.body, rest, `${rid}: the body without photos is otherwise identical`);
      assert.notStrictEqual(none.etag, live.etag, `${rid}: the etag moves with photos`);
      // a manifest that throws when read → omitted, the menu still served
      const hostile = { get deployments() { throw new Error('manifest boom'); } };
      const h = await buildPublicMenu(db, rid, { known, isActive: async () => true, sites: hostile });
      assert.ok(!('photos' in h.body), `${rid}: a throwing manifest → photos omitted, menu served`);
    }
    ok('buildPublicMenu: photos served by default (marker 1d.2), dish records untouched; no base or a throwing manifest → omitted, rest byte-equal; etag moves with it');
  }

  // ── 5. CENSUS: every URL the live catalogs emit is a committed file of that brand's order site ─────────────────
  {
    let total = 0;
    for (const rid of ['x_pizza', 'la_musa']) {
      const photos = photosFor(rid, catalogSnapshot(rid), SITES);
      assert.ok(photos, `${rid}: photos`);
      const d = SITES.deployments.find((x) => x.app === 'orders' && x.context === rid);
      const base = `${d.origins[0]}/`;
      for (const [id, { card, hero }] of Object.entries(photos)) {
        for (const u of [card, hero]) {
          assert.ok(u.startsWith(base), `${rid}/${id}: ${u} is on its own order site`);
          const rel = u.slice(base.length);
          assert.ok(fs.existsSync(path.join(REPO, d.folder, rel)), `🔴 ${rid}/${id}: ${rel} is not a committed file of ${d.folder}`);
          total++;
        }
      }
    }
    assert.ok(total >= 60, `premise: the census saw the photos (${total} URLs)`);
    ok(`census: all ${total} emitted card/hero URLs are committed files on their brand's order site`);
  }

  FINISHED = true;
  console.log(`\npublic-photos: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
