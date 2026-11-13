'use strict';
// S4 (PLAN-structure-S4-r4 R2.1 S4-STAGED-ROUNDTRIP, §5) — on the Firestore EMULATOR: source → the REAL build → the REAL publishVersion →
// the version read back by catalog-menu.readVersionMenu: structure.staged_categories survives verbatim; a second publish changing only a
// staged entry's `after` writes a version that carries the new anchor (the value is lost nowhere); the SERVED menu (buildPublicMenu) of
// either version never carries it, and a promoted category (its first dish moved in) is served in its place. Both brands.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:s4sections
require('./_emulator-required')('firestore');

const assert = require('assert');
const admin = require('firebase-admin');
admin.initializeApp({ projectId: 'demo-xpizza' });
const db = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('s4-sections(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

const { publishVersion } = require('../catalog/catalog-publish');
const { buildSourceCandidate } = require('../catalog/candidate-validate');
const { readVersionMenu } = require('../catalog/catalog-menu');
const { buildPublicMenu } = require('../catalog/public-menu');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const clone = (o) => JSON.parse(JSON.stringify(o));
const KNOWN = new Set(['x_pizza', 'la_musa']);
const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
async function publish(rid, source, expected) {
  const { inputs, built } = buildSourceCandidate(rid, source);
  return (await quiet(() => publishVersion(db, rid, { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: built.extras, source_sha: 's4e',
    ...(built.key_mode == null ? {} : { key_mode: built.key_mode }), ...(built.frozen_keys == null ? {} : { frozen_keys: built.frozen_keys }) }, { expected: { activeVersionId: expected } }))).versionId;
}
const served = async (rid) => clone((await quiet(() => buildPublicMenu(db, rid, { known: KNOWN, isActive: async () => true }))).body);

(async () => {
  for (const rid of ['la_musa', 'x_pizza']) {
    const base = buildSourceFromCode(rid);
    if (rid === 'x_pizza') base.structure.categories.forEach((c) => { c.name = c.id === 'ny' ? 'NY' : 'Individual'; });
    const anchor = base.structure.categories[0].id;
    const s1 = clone(base); s1.structure.staged_categories = [{ id: 'postres', name: 'Postres', after: anchor }, { id: 'cafe', name: 'Café', after: null }];
    const v1 = await publish(rid, s1, null);
    const r1 = await readVersionMenu(db, rid, v1);
    assert.deepStrictEqual(r1.structure.staged_categories, s1.structure.staged_categories, `${rid}: S4-STAGED-ROUNDTRIP the version reads back the staged list verbatim`);
    const b1 = await served(rid);
    assert.ok(!('staged_categories' in b1) && !b1.categories.some((c) => c.id === 'postres' || c.id === 'cafe'), `${rid}: never served`);

    const s2 = clone(s1); s2.structure.staged_categories[0].after = base.structure.categories[1].id;
    const v2 = await publish(rid, s2, v1);
    assert.notStrictEqual(v2, v1, `${rid}: an after-only change is a new version`);
    assert.strictEqual((await readVersionMenu(db, rid, v2)).structure.staged_categories[0].after, base.structure.categories[1].id, `${rid}: the new anchor is what v2 carries`);

    const s3 = clone(s2); s3.structure.staged_categories = s3.structure.staged_categories.filter((e) => e.id !== 'postres');
    const at = s3.structure.categories.findIndex((c) => c.id === base.structure.categories[1].id) + 1;
    s3.structure.categories.splice(at, 0, { id: 'postres', name: 'Postres' });
    const dish = s3.items.find((i) => i.display.cat === anchor && i.display.variantOf == null); dish.display.cat = 'postres';
    const v3 = await publish(rid, s3, v2);
    const r3 = await readVersionMenu(db, rid, v3);
    assert.deepStrictEqual(r3.structure.staged_categories, [{ id: 'cafe', name: 'Café', after: null }], `${rid}: the promoted entry left the staged list`);
    const b3 = await served(rid);
    assert.deepStrictEqual(b3.categories.map((c) => c.id), s3.structure.categories.map((c) => c.id), `${rid}: the promoted category is served in its place`);
    assert.ok(!('staged_categories' in b3), `${rid}: still never served`);
    ok(`${rid}: staged → published (read back verbatim, never served) → after-only re-publish → promotion served in place`);
  }
  FINISHED = true;
  console.log('\ns4-sections(emulator): OK');
  process.exit(0);
})().catch((e) => { console.error('s4-sections(emulator): FAILED —', e && e.stack); process.exit(1); });
