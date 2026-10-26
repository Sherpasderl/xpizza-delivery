'use strict';
// MIRROR KEY ENCODING (hotfix 2026-10-26, «N.Y. Plain Slice») — the REAL publish path with RTDB-unsafe dish names, against the
// Firestore + RTDB emulators: a synthetic brand whose dish names contain . # $ / [ ] is published through publishVersion with the
// REAL mirror writer (makeRtdbMirror); then
//   M1 the mirror landed (it failed in production): key_encoding uri1, every stored key RTDB-safe, version / seq = the pointer's;
//   M2 the ladder's reader (makeRtdbMirrorReader) returns tables EXACTLY equal to the Firestore-served tables (names as typed);
//   M3 a COLD ladder serves them from the mirror (source mirror_cold) and prices a dotted dish;
//   M4 the identity verifier's mirror rung (mirrorValue, gated io) reads the same decoded tables.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:mirror-keys
const assert = require('assert');
require('./_emulator-required')('database', 'firestore');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  require('../lib/admin');
  const { getDatabase } = require('firebase-admin/database');
  const { getFirestore } = require('firebase-admin/firestore');
  const rtdb = getDatabase(); const fs = getFirestore();
  const { buildSourceFromCode } = require('../tools/seed-source-store');
  const { publishVersion } = require('../catalog/catalog-publish');
  const { getActivePointer, readVersionDocs } = require('../catalog/catalog-firestore');
  const { buildTablesFromDocs } = require('../catalog/catalog-transform');
  const { sourceRefOf, canonicalize, encodeUpdateTime } = require('../catalog/source-store');
  const { sourceToBuildInputs } = require('../catalog/source-store');
  const { buildCatalogV2 } = require('../catalog/form-menu-source');
  const { makeRtdbMirror } = require('../catalog/mirror-rtdb');
  const { createSnapshotFallback, makeRtdbMirrorReader } = require('../catalog/snapshot-fallback');
  const { createIdentityVerifier } = require('../catalog/identity-record-verifier');
  const W = require('../catalog/identity-record-writer');
  const RID = 'mk_synth';
  const UNSAFE = /[.#$/[\]]/;

  // a synthetic brand: x_pizza's source with EVERY dish key + name renamed to carry an RTDB-unsafe character (rotating . # $ / [ ])
  const t = JSON.parse(JSON.stringify(buildSourceFromCode('x_pizza')));
  const CH = ['N.Y. ', 'No#', 'Promo $', 'Media/', 'Pizza [', 'XL]'];
  const map = {}; let i = 0;
  for (const it of t.items) {
    const tag = CH[i++ % CH.length];
    if (typeof it.key === 'string' && !map[it.key]) map[it.key] = `${tag}${it.key}`;
    if (it.display && typeof it.display.name === 'string' && !map[it.display.name]) map[it.display.name] = `${tag}${it.display.name}`;
  }
  // the EXTRAS too (Codex r1 P2: an empty extras table is stored by RTDB as an OMITTED node — the fixture must be publishable
  // with real extras, and their names carry the unsafe characters as well)
  let j = 0;
  for (const e of t.extras) {
    const tag = CH[j++ % CH.length];
    if (typeof e.key === 'string' && !map[e.key]) map[e.key] = `${tag}${e.key}`;
    if (e.display && typeof e.display.name === 'string' && !map[e.display.name]) map[e.display.name] = `${tag}${e.display.name}`;
  }
  const rename = (o) => (typeof o === 'string' ? (map[o] || o) : Array.isArray(o) ? o.map(rename) : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [map[k] || k, rename(v)])) : o);
  const src = rename(t);
  for (const it of [...src.items, ...src.extras]) { if (it.display) delete it.display.identity_id; }
  await sourceRefOf(fs, RID).set(canonicalize(src));
  const snap = await sourceRefOf(fs, RID).get();
  // the candidate as contract/third-brand builds it, plus the renamed extras' own price table (buildCatalogV2 opts.extrasTable)
  const inputs = sourceToBuildInputs(snap.data());
  const built = buildCatalogV2(RID, { formData: inputs.formData, priceTable: inputs.priceTable, extrasTable: inputs.extras });
  const candidate = { items: built.items, structure: built.structure, extras: inputs.extras, extraRecords: (snap.data().extras || []).map((e) => ({ key: e.key, price: e.price, display: e.display })) };
  await publishVersion(fs, RID, { ...candidate, source_sha: 'mirror-keys' },
    { expected: { activeVersionId: null, draftRevision: encodeUpdateTime(snap.updateTime) }, mirror: makeRtdbMirror(rtdb) });
  const ptr = await getActivePointer(fs, RID);
  const { itemDocs, extraDocs, seq } = await readVersionDocs(fs, RID, ptr.version);
  const served = buildTablesFromDocs(itemDocs, extraDocs);
  assert.ok(Object.keys(served.menu).some((k) => k.startsWith('N.Y. ')) && Object.keys(served.menu).every((k) => UNSAFE.test(k)), 'premise: every served menu key carries an RTDB-unsafe character');
  assert.ok(Object.keys(served.extras).length > 0 && Object.keys(served.extras).every((k) => UNSAFE.test(k)), 'premise: NON-empty extras, every key RTDB-unsafe');
  ok(`published ${RID} through publishVersion with ${Object.keys(served.menu).length} dish + ${Object.keys(served.extras).length} extra keys, all RTDB-unsafe (. # $ / [ ])`);

  // M1
  const stored = (await rtdb.ref(`catalog_snapshot/${RID}`).get()).val();
  assert.ok(stored, 'M1 the mirror LANDED (in production it failed with catalog_mirror_write_failed)');
  assert.deepStrictEqual([stored.key_encoding, stored.version, stored.seq], ['uri1', ptr.version, seq]);
  for (const k of [...Object.keys(stored.menu), ...Object.keys(stored.extras)]) assert.ok(!UNSAFE.test(k), `M1 stored key RTDB-safe: ${k}`);
  ok('M1 the mirror landed: key_encoding uri1, every stored key RTDB-safe, version / seq = the active pointer\'s');

  // M2
  const read = await makeRtdbMirrorReader(rtdb)(RID);
  assert.deepStrictEqual([read.menu, read.extras], [served.menu, served.extras], 'M2 decoded tables == the Firestore-served tables, names as typed');
  ok('M2 the ladder\'s reader returns tables EXACTLY equal to the Firestore-served ones');

  // M3
  const f = createSnapshotFallback({ mirrorReader: makeRtdbMirrorReader(rtdb), alarm: () => {} });
  const s = await f.snapshotFor(RID);
  const dotted = Object.keys(served.menu).find((k) => k.startsWith('N.Y. '));
  assert.deepStrictEqual([s.source, s.menu[dotted]], ['mirror_cold', served.menu[dotted]], `M3 a cold ladder prices «${dotted}»`);
  ok(`M3 a COLD ladder serves the mirror and prices «${dotted}»`);

  // M4
  const v = createIdentityVerifier({ db: fs, rtdb, log: () => {} });
  const work = W.workDeadline(W.makeDeadline(60000), 1000);
  const m = await v.readers.mirrorValue(RID, { db: W.gateIo(fs, work, 'verify'), rtdb: W.gateIo(rtdb, work, 'verify') });
  assert.deepStrictEqual([m.version, m.menu, m.extras], [ptr.version, served.menu, served.extras], 'M4');
  ok('M4 the identity verifier\'s mirror rung reads the same decoded tables');

  console.log(`\nmirror-keys(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
