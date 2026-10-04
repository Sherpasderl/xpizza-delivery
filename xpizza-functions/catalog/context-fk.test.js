'use strict';
// Portal 1D · D4-a — the freshness keys (catalog/context-fk.js; PLAN-D4a rev 9 step 3 + ERRATA E1).
// Expected values are written from the plan's definition, not read back from the module.
const assert = require('assert');
const K = require('./context-fk');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const T = (seconds, nanoseconds) => ({ seconds, nanoseconds });
const fk = (g, r, s, ns) => ({ generation: g, revision: r, updateTime: T(s, ns) });

try {
  // 1. Lexicographic order: generation, then revision, then (seconds, nanoseconds).
  const ladder = [fk(0, 0, 0, 0), fk(0, 0, 0, 1), fk(0, 0, 1, 0), fk(0, 1, 0, 0), fk(1, 0, 0, 0), fk(1, 0, 0, 999999999), fk(2, 7, 5, 5)];
  for (let i = 0; i < ladder.length; i += 1) {
    for (let j = 0; j < ladder.length; j += 1) {
      assert.strictEqual(K.compareFK(ladder[i], ladder[j]), Math.sign(i - j), `order ${i} vs ${j}`);
    }
  }
  ok(`FK orders by (generation, revision, seconds, nanoseconds) across all ${ladder.length * ladder.length} ordered pairs`);

  // 2. LOSSLESS: two commit times inside one millisecond are distinct (a ms/ISO encoding would collapse them).
  const a = K.makeFK({ generation: 3, record: { identity_revision: 2 }, updateTime: { seconds: 1700000000, nanoseconds: 123456001 } });
  const b = K.makeFK({ generation: 3, record: { identity_revision: 2 }, updateTime: { seconds: 1700000000, nanoseconds: 123456002 } });
  assert.strictEqual(K.compareFK(a, b), -1, '🔴 1ns apart must compare strictly');
  assert.notStrictEqual(K.fkString(a), K.fkString(b));
  assert.strictEqual(K.fkString(a), 'g3.r2.t1700000000.123456001');
  // a Firestore Timestamp's underscore fields are accepted too, and an unrepresentable time is refused
  assert.deepStrictEqual(K.makeFK({ generation: 1, record: {}, updateTime: { _seconds: 9, _nanoseconds: 8 } }), fk(1, 0, 9, 8));
  assert.strictEqual(K.makeFK({ generation: 1, record: {}, updateTime: { seconds: 1.5, nanoseconds: 0 } }), null);
  assert.strictEqual(K.makeFK({ generation: 1, record: {}, updateTime: { seconds: 1, nanoseconds: 1e9 } }), null);
  ok('recordUpdateTime is kept as {seconds, nanoseconds}: 1ns apart compares strictly; an inexact time is refused (null), never rounded');

  // 3. Absent / malformed → the MINIMUM (never an error, never a guess).
  for (const bad of [undefined, null, {}, 'x', fk(-1, 0, 1, 0), fk(0, 1.5, 1, 0), { generation: 1, revision: 1 }, fk(1, 1, 1, -1)]) {
    assert.deepStrictEqual(K.normalizeFK(bad), K.MIN_FK, `malformed ${JSON.stringify(bad)} → MIN`);
    assert.strictEqual(K.isValidFK(bad), false);
    assert.strictEqual(K.compareFK(fk(0, 0, 0, 1), bad), 1, 'any real FK beats a malformed one');
  }
  assert.strictEqual(K.isValidFK(fk(0, 0, 0, 0)), true, 'all-zeros is a WELL-FORMED value, distinct from malformed');
  ok('an absent/malformed stored FK reads as MIN_FK, so any well-formed write replaces it');

  // 4. identity_revision: absent/malformed reads 0; valid is kept exactly.
  assert.strictEqual(K.revisionOf({}), 0);
  assert.strictEqual(K.revisionOf({ identity_revision: 'x' }), 0);
  assert.strictEqual(K.revisionOf({ identity_revision: -2 }), 0);
  assert.strictEqual(K.revisionOf({ identity_revision: 4 }), 4);
  ok('identity_revision absent/malformed → 0 (plan step 6); a valid value is kept');

  // 5. ERRATA E1 — CK ignores generation; FK does not.
  const g1 = fk(1, 2, 10, 5), g7 = fk(7, 2, 10, 5);
  assert.strictEqual(K.compareCK(K.ckOfFK(g1), K.ckOfFK(g7)), 0, 'same content, different activation → same CK');
  assert.strictEqual(K.ckString(K.ckOfFK(g1)), K.ckString(K.ckOfFK(g7)));
  assert.strictEqual(K.compareFK(g1, g7), -1, '…while the FK still orders the activations');
  assert.strictEqual(K.compareCK(K.ckOfFK(fk(9, 1, 10, 5)), K.ckOfFK(fk(0, 1, 10, 6))), -1, 'CK advances on updateTime alone');
  assert.strictEqual(K.compareCK(K.ckOfFK(fk(9, 1, 99, 0)), K.ckOfFK(fk(0, 2, 10, 0))), -1, 'CK: revision before time');
  assert.deepStrictEqual(K.makeCK({ record: { identity_revision: 3 }, updateTime: T(4, 5) }), { revision: 3, updateTime: T(4, 5) });
  assert.strictEqual(K.ckString(K.makeCK({ record: {}, updateTime: T(4, 5) })), 'r0.t4.000000005');
  ok('ERRATA E1: CK = (revision, updateTime) ignores generation (a re-activation keeps it); FK orders activations');

  console.log(`context-fk: OK (${n})`);
} catch (e) {
  console.error('context-fk FAILED:', e);
  process.exit(1);
}
