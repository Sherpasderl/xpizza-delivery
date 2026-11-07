'use strict';
// MIRROR KEY ENCODING (hotfix 2026-10-26: «N.Y. Plain Slice» — catalog_mirror_write_failed: RTDB refuses a key containing
// . # $ / [ ] or a control character). The RTDB mirror catalog_snapshot/{rid} stores the price tables keyed by item / extra NAME
// for name-keyed restaurants, so ANY such name broke the mirror write. The fix encodes keys AT THE MIRROR BOUNDARY ONLY:
//   • makeRtdbMirror encodes every menu / extras key with the shared reversible availKey and stamps key_encoding:'uri1' —
//     ONLY when some key needs it; otherwise the written value is byte-identical to today (la_musa ids, ordinary names);
//   • decodeMirror (makeRtdbMirrorReader AND the identity verifier's mirrorValue) decodes a marked mirror back to the names as
//     typed; an unmarked mirror reads exactly as stored; an unknown marker or a key that does not round-trip → THROWS
//     (fail closed: the ladder reports catalog_mirror_read_failed and refuses, the verifier reports mirror_read_failed).
// Run: node catalog/mirror-key-encoding.test.js
const assert = require('assert');
const { makeRtdbMirror } = require('./mirror-rtdb');
const { decodeMirror, KEY_ENCODING } = require('./mirror-keys');
const { createSnapshotFallback, makeRtdbMirrorReader } = require('./snapshot-fallback');
const { createIdentityVerifier } = require('./identity-record-verifier');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('mirror-key-encoding: FAILED — exited without completing'); process.exitCode = 1; } });

// an RTDB stand-in that ENFORCES the real key rule on set (the production failure), and serves get
const RTDB_FORBIDDEN = /[.#$/[\]\u0000-\u001f\u007f]/;
function strictRtdb() {
  const store = new Map();
  const check = (v, where) => {
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      if (!k.length || RTDB_FORBIDDEN.test(k)) throw new Error(`set failed: value argument contains an invalid key (${k}) in property '${where}'`);
      check(x, `${where}.${k}`);
    }
  };
  return {
    store,
    ref: (path) => ({
      set: async (v) => { check(v, path.replace(/\//g, '.')); store.set(path, JSON.parse(JSON.stringify(v))); },
      get: async () => ({ val: () => (store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : null) }),
    }),
  };
}
const DOTTED = { 'N.Y. Plain Slice': 129, 'Pizza Grande': 299, 'A#1': 10, 'B$2': 11, 'C/3': 12, 'D[4]': 13, '50% off?': 14 };
const EXTRAS = { 'Extra Queso': 25, 'Jalapeño.': 15 };

(async () => {
  // ── 1. the PRODUCTION failure, reproduced, and the fix ─────────────────────────────────────────────────────────────────
  {
    const db = strictRtdb();
    await makeRtdbMirror(db)('x_pizza', { version: 'v-dot', seq: 9, rid: 'x_pizza', menu: DOTTED, extras: EXTRAS });
    const w = db.store.get('catalog_snapshot/x_pizza');
    assert.strictEqual(w.key_encoding, 'uri1', 'ENC-MARKED');
    assert.strictEqual(KEY_ENCODING, 'uri1');
    for (const k of [...Object.keys(w.menu), ...Object.keys(w.extras)]) assert.ok(!RTDB_FORBIDDEN.test(k), `ENC-RTDB-SAFE ${k}`);
    assert.ok('N%2EY%2E%20Plain%20Slice' in w.menu, 'the dotted name is stored encoded');
    assert.deepStrictEqual([w.version, w.seq, w.rid], ['v-dot', 9, 'x_pizza'], 'version / seq / rid untouched');
    ok('a dotted name (and # $ / [ ] %) mirrors: every key RTDB-safe under key_encoding uri1 (the real key rule is enforced)');
  }

  // ── 2. round trip: the reader returns the names EXACTLY as typed; the cold ladder prices them ─────────────────────────
  {
    const db = strictRtdb();
    await makeRtdbMirror(db)('x_pizza', { version: 'v-dot', seq: 9, rid: 'x_pizza', menu: DOTTED, extras: EXTRAS });
    const read = await makeRtdbMirrorReader(db)('x_pizza');
    assert.deepStrictEqual([read.menu, read.extras], [DOTTED, EXTRAS], 'DEC-ROUND-TRIP names as the merchant typed them');
    assert.ok(!('key_encoding' in read), 'the decoded value carries no marker');
    const alarms = [];
    const f = createSnapshotFallback({ mirrorReader: makeRtdbMirrorReader(db), alarm: (k, d) => alarms.push([k, d]) });
    const s = await f.snapshotFor('x_pizza');   // a COLD instance (no last-good, no active seq)
    assert.strictEqual(s.source, 'mirror_cold');
    assert.strictEqual(s.menu['N.Y. Plain Slice'], 129, 'LADDER-COLD prices the dotted item');
    assert.deepStrictEqual([s.menu, s.extras], [DOTTED, EXTRAS]);
    ok('round trip: makeRtdbMirror → RTDB → makeRtdbMirrorReader → a COLD ladder prices «N.Y. Plain Slice» by its typed name');
  }

  // ── 3. byte-identical when no key needs encoding (la_musa ids, ordinary names, a literal %) ────────────────────────────
  {
    for (const [rid, menu, extras] of [['la_musa', { lm_pizza_01: 250, 'lm-bebida-2': 40 }, { lm_ex_1: 10 }], ['x_pizza', { 'Pizza Grande': 299, 'Promo 50%': 100, 'Jalapeño': 5 }, { 'Extra Queso': 25 }]]) {
      const writes = [];
      await makeRtdbMirror({ ref: (path) => ({ set: async (v) => { writes.push({ path, value: v }); } }) })(rid, { version: 'v1', seq: 3, rid, menu, extras });
      const v = writes[0].value;
      assert.deepStrictEqual(Object.keys(v).sort(), ['at', 'extras', 'menu', 'rid', 'seq', 'version'], `BYTE-IDENTICAL ${rid}: no marker`);
      assert.deepStrictEqual([v.menu, v.extras], [menu, extras], `BYTE-IDENTICAL ${rid}: tables as given`);
      assert.deepStrictEqual(decodeMirror(v), v, `an unmarked mirror reads exactly as stored (${rid})`);
    }
    ok('no key needs encoding (la_musa ids; names with spaces / ñ / a literal %) → the written mirror is today\'s, byte-identical; reads unchanged');
  }

  // ── 4. fail closed: an unknown marker or a key that does not round-trip ─────────────────────────────────────────────────
  {
    const base = { version: 'v', seq: 1, rid: 'x_pizza', at: 1, extras: {} };
    for (const [label, v] of [['unknown marker', { ...base, key_encoding: 'uri2', menu: { A: 1 } }],
      ['a malformed escape', { ...base, key_encoding: 'uri1', menu: { 'A%E0%A4%A': 1 } }],
      ['a non-canonical encoding (lowercase %2e)', { ...base, key_encoding: 'uri1', menu: { 'A%2e': 1 } }],
      ['an unescaped space under the marker', { ...base, key_encoding: 'uri1', menu: { 'A B': 1 } }]]) {
      assert.throws(() => decodeMirror(v), /mirror_key_decode_failed/, `DEC-FAIL-CLOSED ${label}`);
    }
    const db = strictRtdb(); db.store.set('catalog_snapshot/x_pizza', { ...base, key_encoding: 'uri1', menu: { 'A%2e': 1 } });
    const alarms = [];
    const f = createSnapshotFallback({ mirrorReader: makeRtdbMirrorReader(db), alarm: (k, d) => alarms.push(k) });
    await assert.rejects(f.snapshotFor('x_pizza'), /snapshot_fallback_unavailable/, 'the ladder refuses');
    assert.ok(alarms.includes('catalog_mirror_read_failed'), 'and says so');
    ok('fail closed: an unknown marker / a malformed or non-canonical key → decode throws; the ladder refuses with catalog_mirror_read_failed');
  }

  // ── 5. the identity verifier's mirror rung reads the SAME decoded tables ───────────────────────────────────────────────
  {
    const db = strictRtdb();
    await makeRtdbMirror(db)('x_pizza', { version: 'v-dot', seq: 9, rid: 'x_pizza', menu: DOTTED, extras: EXTRAS });
    const v = createIdentityVerifier({ db: {}, rtdb: db, log: () => {} });
    const W = require('./identity-record-writer');
    const io = () => { const work = W.workDeadline(W.makeDeadline(60000), 1000); return { db: W.gateIo({}, work, 'verify'), rtdb: W.gateIo(db, work, 'verify') }; };   // the verifier's own gated handles
    const m = await v.readers.mirrorValue('x_pizza', io());
    assert.deepStrictEqual([m.version, m.seq, m.menu, m.extras], ['v-dot', 9, DOTTED, EXTRAS], 'VERIFIER-DECODES the typed names');
    db.store.set('catalog_snapshot/x_pizza', { version: 'v', seq: 1, rid: 'x_pizza', at: 1, key_encoding: 'uri9', menu: {}, extras: {} });
    await assert.rejects(v.readers.mirrorValue('x_pizza', io()), /mirror_key_decode_failed/, 'VERIFIER-FAIL-CLOSED');
    ok('the identity verifier\'s mirrorValue decodes through the same function (and fails closed the same way)');
  }

  FINISHED = true;
  console.log(`\nmirror-key-encoding: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
