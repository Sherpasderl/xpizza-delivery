'use strict';
// 1D add-product B — tools/verify-first-group-core.js on the emulator, on the SHIPPED switches (render + authoring ON, no
// stub). x_pizza's group is authored by the REAL portal editor, saved and published by the REAL handlers (which write the
// KDS manifest); La Musa's published Pad Thai is checked against ITS spec (the verifier is brand-agnostic). Every negative
// cell must FAIL on the check it is about; a verification run writes NOTHING.
require('./_emulator-required')('firestore', 'database');

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'verify-first-group-'.padEnd(48, 'x');
const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza` });
const db = admin.firestore();
const rtdb = admin.database();
const { editCatalogCore } = require('../catalog/edit-catalog-handler');
const { publishEditedCore } = require('../catalog/publish-edited-handler');
const { publishVersion, previewVersion } = require('../catalog/catalog-publish');
const { sourceRefOf, canonicalize, encodeUpdateTime } = require('../catalog/source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildPublishCandidate } = require('../tools/publish-version');
const { getActivePointer, getActiveVersionId } = require('../catalog/catalog-firestore');
const { addProductIo } = require('../catalog/add-product-io');
const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { backfillIdentities } = require('../catalog/identity-backfill');
const { groupCapabilities } = require('../catalog/platform-groups');
const { verifyFirstGroup } = require('../tools/verify-first-group-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('verify-first-group(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const toPrecondition = (v) => {
  if (typeof v !== 'string') return v;
  const [sec, nanos] = v.split('.');
  if (!/^\d+$/.test(sec || '') || !/^\d+$/.test(nanos || '')) return v;
  return new admin.firestore.Timestamp(Number(sec), Number(nanos));
};
const as = (role) => async () => ({ ok: true, uid: `u_${role}`, role, actor: `${role}@x.hn` });
const io = addProductIo({ fs: db, rtdb });
const readActiveBuilt = (rid) => async () => {
  const versionId = await getActiveVersionId(db, rid);
  const p = await previewVersion(db, rid, versionId);
  const extras = {}; for (const e of p.extras) extras[e.key] = e.price;
  return { built: { items: p.items, structure: p.structure, extras }, versionId, extraRecords: p.extras };
};
const readDraft = (rid) => async () => { const s = await sourceRefOf(db, rid).get(); return { source: s.data(), updateTime: encodeUpdateTime(s.updateTime) }; };
const rev = async (rid) => encodeUpdateTime((await sourceRefOf(db, rid).get()).updateTime);
const draft = async (rid) => (await sourceRefOf(db, rid).get()).data();
const save = async (rid, source) => editCatalogCore({ db, authorize: as('owner'), readActiveBuilt: readActiveBuilt(rid), toPrecondition, addProduct: io },
  { restaurantId: rid, source, baseSourceUpdateTime: await rev(rid) }, {});
const publish = (rid, saved) => publishEditedCore({ db, authorize: as('owner'), readActiveBuilt: readActiveBuilt(rid), readDraft: readDraft(rid), publishVersion,
  mirror: makeRtdbMirror(rtdb), sourceSha: 'verify-first-group', addProduct: io },
  { restaurantId: rid, token: saved.body.token, acknowledgedChanges: saved.body.diff.largeChangeSet, fiscalAck: true }, {});

async function seedBrand(rid) {
  await db.collection('restaurants').doc(rid).set({ name: rid, pricing_key_mode: rid === 'la_musa' ? 'id' : 'name', active: true, schema_version: 2 });
  await sourceRefOf(db, rid).set(canonicalize(buildSourceFromCode(rid)));
  const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: 'vfg-seed' });
  await publishVersion(db, rid, input, { expected: { activeVersionId: null }, mirror: makeRtdbMirror(rtdb) });
  await backfillIdentities(db, rid, catalogSnapshot(rid), { captured: await getActivePointer(db, rid) });
  // a ROUTING-VALID identity (the public menu's isActive reads it and fails CLOSED otherwise — as in production)
  await rtdb.ref(`restaurants/${rid}/identity`).set({ ...require('../seed_identity').IDENTITIES[rid], whatsapp_instance: 'test-instance', whatsapp_enabled: false, active: true });
}
async function wipe() {
  assert.match(rtdb.ref().toString(), /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//, '🔴 refusing to wipe a non-emulator RTDB');
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST, '🔴 refusing to wipe Firestore without FIRESTORE_EMULATOR_HOST');
  for (const c of await db.listCollections()) await db.recursiveDelete(c);
  await rtdb.ref().remove();
}
const spec = (f) => JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'tools', 'group-specs', f), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => `[${c.surface}] ${c.what}`);
async function expectFail(rid, sp, pattern, why) {
  const r = await verifyFirstGroup({ fs: db, rtdb, rid, spec: sp });
  assert.strictEqual(r.ok, false, `🔴 ${why}: the verifier must FAIL`);
  assert.ok(failed(r).some((f) => pattern.test(f)), `${why}: the failing check names it (got ${JSON.stringify(failed(r))})`);
  return r;
}

(async () => {
  assert.deepStrictEqual(groupCapabilities(), { render: true, authoring: true }, 'premise: the SHIPPED switches (the flip), not a stub');
  await wipe();
  await seedBrand('x_pizza'); await seedBrand('la_musa');
  // La Musa's kitchen list as production has it: written by the REAL manifest writer for its active version
  const k = await io.syncKds('la_musa', { versionId: await getActiveVersionId(db, 'la_musa') });
  assert.strictEqual(k.written, true, `premise: La Musa's KDS manifest written by the production writer ${JSON.stringify(k)}`);

  // x_pizza: the first use, authored by the REAL portal editor exactly as the owner will, then saved + published
  const E = await import(pathToFileURL(path.join(__dirname, '..', '..', 'xpizza-portal', 'editor.js')).href);
  const NY = spec('ny-plain-slice.json');
  const R = (k) => `tmp:vfg-${k}-0000-0000`;
  const d = E.createDraft(await draft('x_pizza'));
  E.addProduct(d, { ref: R('l'), cat: NY.launcher.cat });
  E.setAddition(d, R('l'), 'name', NY.launcher.name); E.setAddition(d, R('l'), 'desc', NY.launcher.desc); E.setAddition(d, R('l'), 'price', '624');
  E.setRequiredChoice(d, R('l'), true, [R('a'), R('b')]);
  E.setGroupLabel(d, R('l'), NY.label);
  E.setChoiceName(d, R('a'), 'Salsa Roja'); E.setChoiceName(d, R('b'), 'Salsa Vodka');
  E.addChoice(d, R('l'), R('c')); E.setChoiceName(d, R('c'), 'Combinada'); E.setChoiceRecommended(d, R('c'), true);
  E.setGroupExtrasNone(d, R('l'), true);
  E.setGroupPrice(d, R('l'), '624');
  const sv = await save('x_pizza', E.draftSource(d));
  assert.strictEqual(sv.status, 200, `save: ${JSON.stringify(sv.body).slice(0, 300)}`);
  const pb = await publish('x_pizza', sv);
  assert.strictEqual(pb.status, 200, `publish: ${JSON.stringify(pb.body).slice(0, 300)}`);

  // ── 1. positive, both brands, and ZERO writes ──
  // codex r1 P1-1: EVERYTHING — every Firestore document at every depth (path, data, update time) and the whole RTDB tree
  const allDocs = async () => {
    const out = [];
    const walkCol = async (col) => { for (const d of await col.listDocuments()) { const sn = await d.get(); out.push([d.path, sn.exists ? sn.data() : null, sn.exists ? String(sn.updateTime.toMillis()) + ':' + sn.updateTime.nanoseconds : null]); for (const sub of await d.listCollections()) await walkCol(sub); } };
    for (const c of await db.listCollections()) await walkCol(c);
    return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  };
  const snapshot = async () => JSON.stringify({ rtdb: (await rtdb.ref().get()).val(), fs: await allDocs() });
  const before = await snapshot();
  const x = await verifyFirstGroup({ fs: db, rtdb, rid: 'x_pizza', spec: NY });
  assert.ok(x.ok, `🔴 the owner's NY Plain Slice verifies (failing: ${JSON.stringify(failed(x))})`);
  assert.ok(x.checks.length >= 25 && ['catalog', 'public', 'kds'].every((s) => x.checks.some((c) => c.surface === s)), 'premise: all three surfaces were checked');
  const lm = await verifyFirstGroup({ fs: db, rtdb, rid: 'la_musa', spec: spec('la_musa.pad-thai.json') });
  assert.ok(lm.ok, `🔴 La Musa's published Pad Thai verifies against ITS spec (failing: ${JSON.stringify(failed(lm))})`);
  const after = await snapshot();
  assert.ok(JSON.parse(after).fs.length > 50, 'premise: the snapshot really covers the documents (registry, pointers, versions, items, identity…)');
  assert.strictEqual(after, before, '🔴 a verification run writes NOTHING (EVERY Firestore document — data + update time — and the whole RTDB tree byte-identical)');
  ok(`positive: x_pizza's NY Plain Slice (${x.checks.length} checks: catalog, public menu incl. served dishes, KDS, pointer unchanged) and La Musa's Pad Thai (its own spec) — brand-agnostic; a run writes NOTHING anywhere (every Firestore doc + RTDB)`);

  // ── 2. negative cells: each FAILS on the check it is about ──
  { const s = clone(NY); s.choices[1].price = 650; await expectFail('x_pizza', s, /Salsa Vodka: price L 650/, 'a wrong choice price'); }
  { const s = clone(NY); s.launcher.price = 600; await expectFail('x_pizza', s, /its own price is L 600/, 'a wrong product price'); }
  { const s = clone(NY); s.choices[0].tags = ['recommended']; await expectFail('x_pizza', s, /Salsa Roja: tags/, 'an extra tag'); }
  { const s = clone(NY); delete s.choices[2].tags; await expectFail('x_pizza', s, /Combinada: tags/, 'a missing tag'); }
  { const s = clone(NY); s.choices = [s.choices[1], s.choices[0], s.choices[2]]; await expectFail('x_pizza', s, /the choices IN ORDER/, 'the wrong order'); }
  { const s = clone(NY); s.label = 'Salsas'; await expectFail('x_pizza', s, /the group label is "Salsas"/, 'a wrong label'); }
  { const s = clone(NY); s.launcher.extras_policy = 'all'; await expectFail('x_pizza', s, /extras_policy is "all"/, 'a wrong extras policy'); }
  { await expectFail('la_musa', NY, /exactly one product named "NY Plain Slice"/, 'the product is absent on another brand'); }
  // the PUBLIC surface on its own: a served menu that disagrees with the (correct) catalog fails the public checks
  const { buildPublicMenu } = require('../catalog/public-menu');
  const lid = String((await previewVersion(db, 'x_pizza', await getActiveVersionId(db, 'x_pizza'))).items.find((i) => i.display.name === NY.launcher.name).display.id);
  const tamper = (fn) => async (...a) => { const pm = await buildPublicMenu(...a); const b = JSON.parse(JSON.stringify(pm.body)); fn(b.variant_items[lid]); return { ...pm, body: b }; };
  for (const [fn, re, why] of [[(g) => { g.label = 'Otra'; }, /\[public\] label/, 'a served label'], [(g) => { g.basePrice = 1; }, /\[public\] the derived starting price/, 'a served "desde" price'],
    [(g) => { g.variantIds = [...g.variantIds].reverse(); }, /\[public\] its choices IN ORDER/, 'a served order']]) {
    const r = await verifyFirstGroup({ fs: db, rtdb, rid: 'x_pizza', spec: NY, _buildPublicMenu: tamper(fn) });
    assert.ok(!r.ok && failed(r).some((f) => re.test(f)) && failed(r).every((f) => f.startsWith('[public]')), `🔴 ${why} that disagrees fails ONLY the public check (got ${JSON.stringify(failed(r))})`);
  }
  // codex r1 P1-2: the served DISHES — removed, a served price, a served tag, an extra served choice — each fails the public checks
  const tamperDishes = (fn) => async (...a) => { const pm = await buildPublicMenu(...a); const b = JSON.parse(JSON.stringify(pm.body)); b.dishes = fn(b.dishes); return { ...pm, body: b }; };
  const isUnit = (x) => x.name === NY.launcher.name || String(x.variantOf) === lid;
  for (const [fn, re, why] of [
    [(ds) => ds.filter((x) => !isUnit(x)), /\[public\] the served product/, 'the group\'s dishes removed from the served menu'],
    [(ds) => ds.map((x) => (x.name === `${NY.launcher.name} - Salsa Vodka` ? { ...x, price: 999 } : x)), /\[public\] served Salsa Vodka/, 'a served choice at 999'],
    [(ds) => ds.map((x) => (x.name === `${NY.launcher.name} - Salsa Roja` ? { ...x, tags: ['recommended'] } : x)), /\[public\] served Salsa Roja/, 'a wrong served tag'],
    [(ds) => [...ds, { ...ds.find((x) => x.name === `${NY.launcher.name} - Combinada`), id: 9999, name: `${NY.launcher.name} - Extra`, choice: 'Extra' }], /\[public\] the served menu has no other choice/, 'an extra served choice'],
  ]) {
    const r = await verifyFirstGroup({ fs: db, rtdb, rid: 'x_pizza', spec: NY, _buildPublicMenu: tamperDishes(fn) });
    assert.ok(!r.ok && failed(r).some((f) => re.test(f)) && failed(r).every((f) => f.startsWith('[public]')), `🔴 ${why}: fails the public check (got ${JSON.stringify(failed(r))})`);
  }
  // codex r1 P1-3: a served menu from ANOTHER version (its seq) fails provenance
  { const r = await verifyFirstGroup({ fs: db, rtdb, rid: 'x_pizza', spec: NY, _buildPublicMenu: async (...a) => ({ ...(await buildPublicMenu(...a)), seq: -1 }) });
    assert.ok(!r.ok && failed(r).some((f) => /served menu is the captured active version/.test(f)), `🔴 a served menu of another version fails (got ${JSON.stringify(failed(r))})`); }
  // a catalog whose choice price and display price disagree (the validators never publish one) fails that choice's price check
  {
    const tampered = async (...a) => { const p = await previewVersion(...a); const items = p.items.map((i) => (i.display && i.display.name === `${NY.launcher.name} - Salsa Vodka` ? { ...i, display: { ...i.display, price: 999 } } : i)); return { ...p, items }; };
    const r = await verifyFirstGroup({ fs: db, rtdb, rid: 'x_pizza', spec: NY, _previewVersion: tampered });
    assert.ok(!r.ok && failed(r).some((f) => /Salsa Vodka: price L 624/.test(f)), `🔴 a display price that disagrees with the charged price fails (got ${JSON.stringify(failed(r))})`);
  }
  ok('codex r1 P1-2/P1-3: served dishes removed / a served price / a served tag / an extra served choice, and a served menu of another version — each fails the public checks');
  ok('negative: wrong choice price, wrong product price, extra tag, missing tag, wrong order, wrong label, wrong extras policy, absent product — each FAILS on its own check; a SERVED menu that disagrees (label / "desde" / order) fails the public checks alone');

  // ── 3. the KDS manifest: the shipped shape is exactly whole-dish row + one row per choice, in order ──
  const rows = (await rtdb.ref('menus/x_pizza').get()).val();
  const unitIdx = rows.map((r, i) => (r.label === NY.launcher.name || r.label.startsWith(`${NY.launcher.name} - `) ? i : -1)).filter((i) => i > -1);
  assert.strictEqual(unitIdx.length, 4, 'premise: the publish wrote a whole-dish row + 3 choice rows');
  const restore = async () => rtdb.ref('menus/x_pizza').set(rows);
  await rtdb.ref('menus/x_pizza').set(rows.filter((r) => r.label !== NY.launcher.name));
  await expectFail('x_pizza', NY, /whole-dish row \+ one row per choice/, 'the whole-dish row is missing'); await restore();
  await rtdb.ref('menus/x_pizza').set(rows.filter((r) => r.label !== `${NY.launcher.name} - Salsa Vodka`));
  await expectFail('x_pizza', NY, /whole-dish row \+ one row per choice/, 'a choice row is missing'); await restore();
  await rtdb.ref('menus/x_pizza').set([...rows, { key: 'NY Plain Slice - Extra', label: 'NY Plain Slice - Extra', category: 'ny' }]);
  await expectFail('x_pizza', NY, /whole-dish row \+ one row per choice/, 'a stray row for the product'); await restore();
  // codex r1 P2-4: a stray row labelled EXACTLY the product, under another key
  await rtdb.ref('menus/x_pizza').set([...rows, { key: 'ny_plain_slice_dup', label: NY.launcher.name, category: 'ny' }]);
  await expectFail('x_pizza', NY, /whole-dish row \+ one row per choice/, 'a stray row labelled exactly the product'); await restore();
  { const sw = rows.slice(); const [a, b] = [unitIdx[1], unitIdx[2]]; [sw[a], sw[b]] = [sw[b], sw[a]]; await rtdb.ref('menus/x_pizza').set(sw); }
  await expectFail('x_pizza', NY, /whole-dish row \+ one row per choice/, 'the rows out of order'); await restore();
  const meta = (await rtdb.ref('menus/_meta/x_pizza').get()).val();
  await rtdb.ref('menus/_meta/x_pizza/version_id').set('v-stale');
  await expectFail('x_pizza', NY, /manifest belongs to the captured active version/, 'a manifest of another version'); await rtdb.ref('menus/_meta/x_pizza').set(meta);
  assert.ok((await verifyFirstGroup({ fs: db, rtdb, rid: 'x_pizza', spec: NY })).ok, 'restored → passes again');
  ok('KDS: the whole-dish row missing, a choice row missing, a stray row, a stray row labelled EXACTLY the product (another key), rows out of order, a manifest of another version — each FAILS; restored → passes');

  // ── 5. a SECOND group on the same brand (the owner's 12" Plain Slice): same label "Salsa", the same three choice names,
  //       a different section — authored + published by the REAL editor/handlers; BOTH verify, and production's group index
  //       (what intake's gate snapshot builds from) sees two independent groups ──
  {
    const P12 = spec('plain-slice-12.json');
    const d2 = E.createDraft(await draft('x_pizza'));
    const R2 = (k) => `tmp:vfg2-${k}-0000-0000`;
    E.addProduct(d2, { ref: R2('l'), cat: P12.launcher.cat });
    E.setAddition(d2, R2('l'), 'name', P12.launcher.name); E.setAddition(d2, R2('l'), 'desc', 'La clásica Plain Slice de 12", queso mozzarella, salsa de tu elección.'); E.setAddition(d2, R2('l'), 'price', '299');
    E.setRequiredChoice(d2, R2('l'), true, [R2('a'), R2('b')]);
    E.setGroupLabel(d2, R2('l'), P12.label);
    E.setChoiceName(d2, R2('a'), 'Salsa Roja'); E.setChoiceName(d2, R2('b'), 'Salsa Vodka');
    E.addChoice(d2, R2('l'), R2('c')); E.setChoiceName(d2, R2('c'), 'Combinada'); E.setChoiceRecommended(d2, R2('c'), true);
    E.setGroupExtrasNone(d2, R2('l'), true); E.setGroupPrice(d2, R2('l'), '299');
    const sv2 = await save('x_pizza', E.draftSource(d2));
    assert.strictEqual(sv2.status, 200, `save of the second group: ${JSON.stringify(sv2.body).slice(0, 300)}`);
    const pb2 = await publish('x_pizza', sv2);
    assert.strictEqual(pb2.status, 200, `publish of the second group: ${JSON.stringify(pb2.body).slice(0, 300)}`);
    const both = await Promise.all([verifyFirstGroup({ fs: db, rtdb, rid: 'x_pizza', spec: NY }), verifyFirstGroup({ fs: db, rtdb, rid: 'x_pizza', spec: P12 })]);
    assert.ok(both[0].ok, `🔴 the NY Plain Slice still verifies beside a second group (${JSON.stringify(failed(both[0]))})`);
    assert.ok(both[1].ok, `🔴 the 12" Plain Slice verifies (${JSON.stringify(failed(both[1]))})`);
    const act = await previewVersion(db, 'x_pizza', await getActiveVersionId(db, 'x_pizza'));
    const gi = require('../catalog/group-index').groupIndexFrom({ items: act.items, structure: act.structure });
    const names = (k) => act.items.find((i) => i.key === k).display.name;
    assert.ok(gi.ok, 'production group index reads the two-group catalog');
    assert.deepStrictEqual([...gi.launchers].map(names).sort(), ['NY Plain Slice', 'Plain Slice'], 'two independent launchers');
    for (const L of ['NY Plain Slice', 'Plain Slice']) for (const c of ['Salsa Roja', 'Salsa Vodka', 'Combinada']) {
      const k = act.items.find((i) => i.display.name === `${L} - ${c}`).key;
      assert.strictEqual(names(gi.parentOf.get(k)), L, `"${L} - ${c}" belongs to "${L}" (same choice name, different product)`);
    }
    const labels = Object.values(act.structure.variant_items).filter((g) => g.label === 'Salsa').length;
    assert.strictEqual(labels, 2, 'two groups may share the label "Salsa"');
  }
  ok('a SECOND group on the same brand (12" Plain Slice: same label, same 3 choice names, another section): saved + published by the real handlers; BOTH specs verify; the group index maps each "{product} - {choice}" to its own product');

  // ── codex r1 P1-3: a publish RACING the run (between the reads and the final pointer re-read) → "catalog changed" ──
  {
    const race = async () => {
      const dr = E.createDraft(await draft('x_pizza'));
      const any = E.draftSource(dr).items.find((i) => i.key && !i.display.variantOf && i.display.name !== NY.launcher.name && i.display.name !== 'Plain Slice' && Number.isInteger(i.price));
      E.setItemPrice(dr, any.key, String(any.price + 1));
      const s3 = await save('x_pizza', E.draftSource(dr)); assert.strictEqual(s3.status, 200, `race save ${JSON.stringify(s3.body).slice(0, 200)}`);
      const p3 = await publish('x_pizza', s3); assert.strictEqual(p3.status, 200, `race publish ${JSON.stringify(p3.body).slice(0, 200)}`);
    };
    const r = await verifyFirstGroup({ fs: db, rtdb, rid: 'x_pizza', spec: NY, _onRead: race });
    assert.ok(!r.ok && failed(r).some((f) => /catalog changed during verification, re-run/.test(f)), `🔴 a publish during the run fails with "re-run" (got ${JSON.stringify(failed(r))})`);
    const again = await verifyFirstGroup({ fs: db, rtdb, rid: 'x_pizza', spec: NY });
    assert.ok(again.ok, `re-run after the publish settles → passes (${JSON.stringify(failed(again))})`);
  }
  ok('codex r1 P1-3: a real publish racing the run → FAILS "catalog changed during verification, re-run"; the re-run passes');

  // ── codex r1 P2-5: production's rid shape — a hyphenated rid is a VALID argument (not refused as a spec error) ──
  { const r = await verifyFirstGroup({ fs: db, rtdb, rid: 'r3-synth', spec: NY });
    assert.ok(!r.ok && !r.checks.some((c) => c.surface === 'spec') && failed(r).some((f) => /an active version exists/.test(f)), `a hyphenated rid is read (no catalog there), not refused (got ${JSON.stringify(failed(r))})`);
    const bad = await verifyFirstGroup({ fs: db, rtdb, rid: '../x', spec: NY });
    assert.ok(!bad.ok && bad.checks.some((c) => c.surface === 'spec' && /not a restaurant id/.test(c.what))); }
  ok('codex r1 P2-5: rids follow production\'s RID_RE — "r3-synth" is read (absent catalog fails honestly), "../x" is refused before any read');

  // ── 4. an invalid spec is refused before any read ──
  const bad = await verifyFirstGroup({ fs: null, rtdb: null, rid: 'x_pizza', spec: { launcher: { name: 'X' }, label: '', choices: [{ choice: 'A', price: 0 }] } });
  assert.strictEqual(bad.ok, false); assert.ok(bad.checks.every((c) => c.surface === 'spec') && bad.checks.length >= 3, JSON.stringify(bad.checks));
  ok('an invalid spec is refused with its reasons, before any read (no handle was even given)');

  FINISHED = true;
  console.log(`\nverify-first-group(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('verify-first-group(emulator) FAILED:', e); process.exit(1); });
