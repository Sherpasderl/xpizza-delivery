'use strict';
// Phase 1d Stage 2b-pre — what makeRtdbMirror ACTUALLY WRITES. Run: node mirror-rtdb.test.js
//
// The emulator suite asserts the payload writeMirror PASSES to its injected writer, which leaves the
// real writer's projection untested — dropping a field inside makeRtdbMirror was invisible to it.
// Since the mirror is the Firestore-INDEPENDENT fallback, a field silently missing here is exactly the
// failure that would only surface during an outage.
const assert = require('assert');
const { makeRtdbMirror, RTDB_URL } = require('./catalog/mirror-rtdb');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  const writes = [];
  const fakeRtdb = { ref: (path) => ({ set: async (v) => { writes.push({ path, value: v }); } }) };
  const mirror = makeRtdbMirror(fakeRtdb);
  await mirror('x_pizza', { version: 'v-123', seq: 7, rid: 'x_pizza', menu: { A: 1 }, extras: { E: 2 } });

  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].path, 'catalog_snapshot/x_pizza', 'writes to the server-only mirror path');
  const v = writes[0].value;
  assert.strictEqual(v.version, 'v-123', 'version witness');
  assert.strictEqual(v.seq, 7, 'the ORDINAL must survive the projection — without it a reader cannot compute version distance without Firestore');
  assert.strictEqual(v.rid, 'x_pizza');
  assert.deepStrictEqual(v.menu, { A: 1 });
  assert.deepStrictEqual(v.extras, { E: 2 });
  assert.ok(Number.isFinite(v.at), 'a wall-clock stamp for triage');
  ok('the written mirror carries version, seq, rid, menu, extras — self-describing without Firestore');

  // Every field the fallback needs must be present; a projection that drops one is caught here.
  assert.deepStrictEqual(Object.keys(v).sort(), ['at', 'extras', 'menu', 'rid', 'seq', 'version'],
    'the written shape is pinned — adding or dropping a field is a deliberate change, not an accident');
  ok('the written shape is pinned (dropping seq, or any field, fails here)');
  assert.ok(RTDB_URL.startsWith('https://'), 'the shared instance URL is exported for the CLIs to pin');
  ok('RTDB_URL is exported as the single shared instance constant');
  console.log(`mirror-rtdb: OK (${n})`);
})().catch((e) => { console.error(e); process.exit(1); });
