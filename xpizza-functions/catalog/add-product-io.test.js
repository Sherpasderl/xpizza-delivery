'use strict';
// 1D add-product A — codex build r1 #5: the historical-name lookup. Run: node catalog/add-product-io.test.js
// The fake datastore is AT LEAST AS STRICT as Firestore where it matters: .doc() with a '/' in the id THROWS (Firestore
// reads it as a path), and any read can be made to FAIL — so "a raw display name is not a document id" and "a read
// failure is not absence" are both observable here. The real-Firestore half is the emulator cell in
// test/add-product.emulator.test.js ("Pizza / Bacon" saves and publishes on both brands).
const assert = require('assert');
const { addProductIo } = require('./add-product-io');
const { encodeKey } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
function fakeFs({ exists = new Set(), fail = new Set() } = {}) {
  const reads = [];
  const node = (path) => ({
    collection: (c) => node([...path, c]),
    doc: (id) => {
      if (typeof id !== 'string' || !id || id.includes('/')) throw new Error(`Value for argument "documentPath" must point to a document, but was "${id}"`);
      const p = [...path, id].join('/');
      return { ...node([...path, id]), get: async () => { reads.push(p); if (fail.has(p)) throw new Error(`UNAVAILABLE: ${p}`); return { exists: exists.has(p) }; } };
    },
  });
  return { fs: node([]), reads };
}
const KEYS = (k) => `restaurants/r/identity/dish/keys/${encodeKey(k)}`;
const IDS = (k) => `restaurants/r/identity/dish/ids/${k}`;

(async () => {
  {
    const f = fakeFs();
    const io = addProductIo({ fs: f.fs, rtdb: null });
    const taken = await io.registryKeysTaken('r', ['Pizza / Bacon', 'Otra'], 'name');
    assert.deepStrictEqual([...taken], [], 'a valid name with a slash is looked up, not thrown on');
    assert.ok(f.reads.every((p) => p.includes('/identity/dish/keys/')), `🔴 name mode reads ONLY the encoded key rows (${f.reads.join(', ')})`);
    assert.strictEqual(f.reads.length, 2);
    ok('name mode: only the ENCODED key-row lookup — "Pizza / Bacon" is a valid lookup, never a raw document id');
  }
  {
    const f = fakeFs({ exists: new Set([KEYS('Usado'), IDS('retirado')]) });
    const io = addProductIo({ fs: f.fs, rtdb: null });
    assert.deepStrictEqual([...await io.registryKeysTaken('r', ['Usado', 'Nuevo'], 'name')], ['Usado'], 'a key row → used before');
    assert.deepStrictEqual([...await io.registryKeysTaken('r', ['retirado', 'libre'], 'id')], ['retirado'], 'id mode: a retired slug (id doc, no key row) → used before');
    assert.deepStrictEqual([...await io.registryKeysTaken('r', ['retirado'], 'name')], [], 'name mode never consults id documents');
    ok('id mode adds the id-document lookup (a retired slug stays reserved); name mode never consults it');
  }
  for (const [mode, failing, label] of [['name', KEYS('Usado'), 'a key-row read'], ['id', KEYS('slug_a'), 'a key-row read'], ['id', IDS('slug_a'), 'an id-document read']]) {
    const f = fakeFs({ fail: new Set([failing]) });
    const io = addProductIo({ fs: f.fs, rtdb: null });
    const key = mode === 'name' ? 'Usado' : 'slug_a';
    await assert.rejects(io.registryKeysTaken('r', [key], mode), /UNAVAILABLE/, `🔴 ${mode} mode: ${label} that FAILS propagates — it is never read as "absent"`);
  }
  ok('🔴 a READ FAILURE IS NOT ABSENCE: a failing key-row or id-document read rejects (the handlers answer a retryable 503)');
  for (const bad of [undefined, null, 'slug', '']) await assert.rejects(addProductIo({ fs: fakeFs().fs }).registryKeysTaken('r', ['x'], bad), /unknown key mode/);
  ok('an unknown key mode is refused rather than guessed');
  console.log(`\nadd-product-io: OK (${n})`);
})().catch((e) => { console.error('add-product-io FAILED:', e); process.exit(1); });
