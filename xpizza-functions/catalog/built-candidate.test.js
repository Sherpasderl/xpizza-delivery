'use strict';
// codex build r1 #4 — every source-built candidate is built ONE way (extras priced from the SOURCE) and validated as
// publish validates it, at SAVE and in draft assessment. Run: node catalog/built-candidate.test.js
//   1. NO-EDIT GOLDEN: with an unedited source (extras equal to code today) the new build is BYTE-IDENTICAL to the old
//      call (buildCatalogV2 without the extras table) — and, for sensitivity, an extra-price edit makes them DIFFER.
//   2. WIRING: the REAL editCatalogCore and assessDraft refuse a built candidate that publish would refuse. Proven by
//      stubbing the builder back to the PRE-FIX behaviour (extras priced from code): the save is refused before the CAS
//      write, nothing is written, and the assessment reports draft_unbuildable. (The end-to-end save → publish → price
//      proof on the real Firestore is test/extra-price-edit.emulator.test.js.)
const assert = require('assert');
process.env.EDIT_TOKEN_SECRET = process.env.EDIT_TOKEN_SECRET || 'x'.repeat(32);
const { canonicalize, sourceToBuildInputs } = require('./source-store');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const { buildCatalogV2 } = require('./form-menu-source');
const CV = require('./candidate-validate');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (x) => JSON.parse(JSON.stringify(x));
const oldBuild = (rid, src) => { const i = sourceToBuildInputs(src); return buildCatalogV2(rid, { formData: i.formData, priceTable: i.priceTable }); };
const EXTRA = { x_pizza: 'Salsa Roja', la_musa: 'rice_white' };
const editExtra = (src, rid, delta) => {
  const s = clone(src); const e = s.extras.find((x) => x.key === EXTRA[rid]);
  e.price += delta; if (e.display && Object.prototype.hasOwnProperty.call(e.display, 'price')) e.display.price = e.price;
  return s;
};

{
  for (const rid of ['x_pizza', 'la_musa']) {
    const src = canonicalize(buildSourceFromCode(rid));
    const { built } = CV.buildSourceCandidate(rid, src);
    assert.deepStrictEqual(built, oldBuild(rid, src), `${rid}: an unedited source builds BYTE-IDENTICALLY to the old call`);
    assert.doesNotThrow(() => CV.assertBuiltValid(rid, built, 'golden'), `${rid}: and the candidate is valid`);
    // sensitivity: an extra-price edit is exactly where the two builds part
    const edited = editExtra(src, rid, 7);
    const now = CV.buildSourceCandidate(rid, edited).built;
    assert.notDeepStrictEqual(now, oldBuild(rid, edited), `${rid}: an extra-price edit makes the builds differ (the comparison is not vacuous)`);
    assert.strictEqual(now.extras.find((e) => e.key === EXTRA[rid]).price, edited.extras.find((e) => e.key === EXTRA[rid]).price, `${rid}: the NEW build prices the extra from the source`);
    assert.throws(() => CV.assertBuiltValid(rid, oldBuild(rid, edited), 'old'), /publish_refused_invalid/, `${rid}: the OLD build of that edit is a candidate publish refuses (the dead end)`);
    assert.doesNotThrow(() => CV.assertBuiltValid(rid, now, 'new'), `${rid}: the NEW build of it is valid`);
  }
  ok('no-edit golden: an unedited source builds byte-identically to the old call on both brands; an extra-price edit builds valid now and was refused before');
}

// ── 2. WIRING: the builder regresses to pricing extras from code → SAVE refuses before the write; assessment says so ──
const stubDb = (rid, live, writes, T0) => {
  const doc = (p) => ({
    get: async () => (p === `restaurants/${rid}/meta/source` ? { exists: true, data: () => clone(live), updateTime: T0 }
      : p === `restaurants/${rid}/meta/active_version` ? { exists: true, data: () => ({ version: 'v1' }) } : { exists: false, data: () => ({}) }),
    set: async () => { writes.push(p); }, update: async () => { writes.push(p); },
  });
  return { collection: (c) => ({ doc: (d) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c}/${d}/${c2}/${d2}`) }), get: async () => ({ exists: true, data: () => ({}) }) }) }) };
};
const activeOf = (rid, live) => { const b = oldBuild(rid, live); return async () => ({ built: { ...b, extras: sourceToBuildInputs(live).extras }, versionId: 'v1', extraRecords: b.extras }); };
const owner = async () => ({ ok: true, uid: 'u', role: 'owner', actor: 'o@x.hn' });

(async () => {
  // ── 3. codex's bootstrap_unpriced_extra case: a source-only NEW extra (la_musa) validates; the OLD builder threw on it
  //       (so the save's draft_unbuildable branch — mutant H03 — WAS reachable). The new builder prices it from the
  //       source, and the ADD-ONLY comparison refuses the membership change instead. Nothing stored either way. ──
  {
    const { editCatalogCore: realSave } = require('./edit-catalog-handler');
    const rid = 'la_musa';
    const live = canonicalize(buildSourceFromCode(rid));
    const s = clone(live); const e = clone(s.extras.find((x) => x.key === 'sauce_aioli'));
    e.key = 'extra_nuevo'; e.display = { ...e.display, id: 'extra_nuevo', name: 'Extra Nuevo' };
    s.extras.push(e);
    assert.doesNotThrow(() => require('./source-store').validateSource(s, rid), 'premise: the source with a new extra VALIDATES');
    assert.throws(() => oldBuild(rid, s), /bootstrap_unpriced_extra: la_musa\/extra_nuevo/, 'the OLD builder threw on it (codex: H03 was reachable)');
    assert.doesNotThrow(() => CV.assertBuiltValid(rid, CV.buildSourceCandidate(rid, s).built, 'new'), 'the NEW builder builds a valid candidate');
    const writes = []; const T0 = '2026-10-09T10:00:00.000000Z';
    const r = await realSave({ db: stubDb(rid, live, writes, T0), authorize: owner, readActiveBuilt: activeOf(rid, live) }, { restaurantId: rid, source: s, baseSourceUpdateTime: T0 }, {});
    assert.deepStrictEqual([r.status, r.body.error], [400, 'extras_changed'], `the add-only comparison refuses it: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.deepStrictEqual(writes, [], 'nothing stored');
    ok('bootstrap_unpriced_extra: a source-only new extra validated and then THREW in the old builder (H03 reachable); it now builds and the add-only comparison refuses it (extras_changed) — nothing stored');
  }

  const cvPath = require.resolve('./candidate-validate');
  for (const m of ['./edit-catalog-handler', './draft-assess']) delete require.cache[require.resolve(m)];
  require.cache[cvPath] = { id: cvPath, filename: cvPath, loaded: true, children: [], paths: [],
    exports: { ...CV, buildSourceCandidate: (rid, source) => ({ inputs: sourceToBuildInputs(source), built: oldBuild(rid, source) }) } };
  const { editCatalogCore } = require('./edit-catalog-handler');
  const { assessDraft } = require('./draft-assess');

  for (const rid of ['x_pizza', 'la_musa']) {
    const live = canonicalize(buildSourceFromCode(rid));
    const edited = editExtra(live, rid, 7);
    const writes = [];
    const T0 = '2026-10-09T10:00:00.000000Z';
    const db = stubDb(rid, live, writes, T0);
    const readActiveBuilt = activeOf(rid, live);
    const r = await editCatalogCore({ db, authorize: owner, readActiveBuilt },
      { restaurantId: rid, source: edited, baseSourceUpdateTime: T0 }, {});
    assert.deepStrictEqual([r.status, r.body.error], [400, 'draft_unbuildable'], `${rid}: ${JSON.stringify(r.body).slice(0, 240)}`);
    assert.match(r.body.detail, /publish_refused_invalid/, `${rid}: refused by the SAME candidate validation publish runs`);
    assert.deepStrictEqual(writes, [], `${rid}: 🔴 refused BEFORE the CAS write — nothing stored`);
    const a = assessDraft(rid, edited, await readActiveBuilt());
    assert.deepStrictEqual([a.publishable, a.code], [false, 'draft_unbuildable'], `${rid}: the assessment reports the same draft unpublishable`);
  }
  ok('wiring: with the builder regressed to code-priced extras, the REAL save refuses an extra-price edit before writing and the REAL assessment reports it — the check runs where it must');
  console.log(`\nbuilt-candidate: OK (${n})`);
})().catch((e) => { console.error('built-candidate FAILED:', e); process.exit(1); });
