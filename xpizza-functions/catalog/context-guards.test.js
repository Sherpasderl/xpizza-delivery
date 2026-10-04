'use strict';
// Portal 1D · D4-a — STRUCTURAL guards for the resolved catalog context (PLAN-D4a rev 9 steps 8, 9, 11).
//
// 🔴 THE DECOUPLING IS A BYTE-COMPARE, NOT AN ARGUMENT. catalog-publish.js (publishVersion, rollbackVersion,
// flipPointer, writeMirror, snapshotOf / active_snapshot, the lease, the D1 pass), the legacy mirror writer
// and reader, and the pricing caches are pinned to their sha256 at main 06353c7 — the goldens below were
// computed from `git show 06353c7:<file>`, not from this tree. D4-a may not change one byte of them.
const assert = require('assert');
const crypto = require('crypto');
const fsys = require('fs');
const path = require('path');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const sha = (f) => crypto.createHash('sha256').update(fsys.readFileSync(path.join(__dirname, f))).digest('hex');

try {
  const FROZEN = {
    'catalog-publish.js': '9177d921ff2cfcf23d389fab98cf3053242afc57703ac2d2bebf81e0395d99b3',   // publish, rollback, snapshotOf, active_snapshot, lease, D1
    'mirror-rtdb.js': 'b4b8b78cba26dbecede5db5b719871b8c72435fdcba42b18b686c1b71c0b5a81',      // makeRtdbMirror + its allowlist
    'catalog.js': '554f338f5ed841cc5e6f6d8c9033fe82b27d0c34673537b7c821598599e42464',          // the pricing caches
    'snapshot-fallback.js': 'e91f90f407e0d9603065a668b7209345a5a95610ce695174c30c7cc487a2303e', // the ladder (selection, K, deadlines)
    'catalog-firestore.js': '7cefff4a0b1d18bf801b91ab310c59ddcb2ada539d4a5b0fed6c98f029f044c0', // the pricing reader + pointer
  };
  for (const [f, want] of Object.entries(FROZEN)) {
    assert.strictEqual(sha(f), want, `🔴 ${f} changed — D4-a must not modify it (plan rev 9 steps 8-9)`);
  }
  // Sensitivity partner: the comparison detects a one-byte change.
  const one = crypto.createHash('sha256').update(Buffer.concat([fsys.readFileSync(path.join(__dirname, 'catalog-publish.js')), Buffer.from(' ')])).digest('hex');
  assert.notStrictEqual(one, FROZEN['catalog-publish.js']);
  ok(`${Object.keys(FROZEN).length} files byte-identical to main 06353c7 (catalog-publish.js, the legacy mirror, the pricing caches, the ladder, the pricing reader); a one-byte change is detected`);

  // The writer writes ONLY the context path; nothing in D4-a writes the legacy mirror or active_snapshot.
  const NEW = ['context-fk.js', 'policy-primitive.js', 'catalog-context.js', 'catalog-verifier.js', 'context-writer.js', 'context-source.js'];
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');   // code only
  const code = Object.fromEntries(NEW.map((f) => [f, strip(fsys.readFileSync(path.join(__dirname, f), 'utf8'))]));
  for (const [f, src] of Object.entries(code)) {
    // Datastore WRITES specifically (Map/Set bookkeeping is not a write): transaction/batch/doc/ref writes,
    // a chained `.ref(…)`/`.child(…)`/`.doc(…)` write, and any reference to the legacy fallback artifacts.
    const writes = /\b(tx|batch|b|vref|ref|docRef|snapRef|db|rtdb|fs)\.(set|update|delete|create|push|remove)\(|\.(ref|child|doc)\([^)]*\)\.(set|update|delete|create|push|remove)\(|\.batch\(\)/;
    assert.ok(!writes.test(src), `🔴 ${f} performs a datastore write other than the fenced context transaction`);
    assert.ok(!/active_snapshot|snapshotOf|makeRtdbMirror\(|['"`]catalog_snapshot\/|\$\{CONTEXT_PATH\}_|catalog_snapshot\$/.test(src), `🔴 ${f} references a legacy fallback artifact`);
  }
  {
    const writes = /\b(tx|batch|b|vref|ref|docRef|snapRef|db|rtdb|fs)\.(set|update|delete|create|push|remove)\(|\.(ref|child|doc)\([^)]*\)\.(set|update|delete|create|push|remove)\(|\.batch\(\)/;
    for (const w of ['tx.set(r, {})', 'tx.update(vref, {})', "rtdb.ref('catalog_snapshot/x').set({})", 'ref.child(\'head\').remove()', 'db.batch()', "fs.doc('a/b').delete()"]) assert.ok(writes.test(w), `sensitivity: ${w} is caught`);
    for (const nw of ['cache.set(k, v)', 'built.delete(key)', 'flights.set(rid, p)']) assert.ok(!writes.test(nw), `sensitivity: ${nw} is bookkeeping, not a write`);
  }
  assert.ok(/ref\(`\$\{CONTEXT_PATH\}\/\$\{rid\}`\)/.test(code['context-writer.js']) && /CONTEXT_PATH = 'catalog_snapshot_ctx'/.test(code['context-writer.js']), 'the one path the writer touches is catalog_snapshot_ctx/{rid}');
  assert.strictEqual((code['context-writer.js'].match(/\.transaction\(/g) || []).length, 1, 'exactly one RTDB write: the fenced transaction');
  ok('the new modules write ONLY catalog_snapshot_ctx/{rid}, through ONE fenced transaction; no reference to active_snapshot, snapshotOf, makeRtdbMirror or the legacy mirror path');

  // 🔴 BRAND-FREE (plan step 11): no restaurant literal and no `restaurantId ===` branch in any new module.
  for (const [f, src] of Object.entries(code)) {
    assert.ok(!/x_pizza|la_musa|xpizza|lamusa/i.test(src), `🔴 ${f} names a restaurant`);
    assert.ok(!/(restaurantId|rid)\s*[!=]==?\s*['"`]/.test(src), `🔴 ${f} branches on a restaurant id literal`);
  }
  const idx = fsys.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const block = idx.slice(idx.indexOf('exports.writeCatalogContextOnMirror'), idx.indexOf('exports.sweepStalePending'));
  assert.ok(block.includes('makeFirestoreRegistryReader(getFirestore())'), 'the reconciler enumerates restaurants from Firestore');
  assert.ok(!/x_pizza|la_musa/.test(block), '🔴 the invokers carry no restaurant list');
  ok(`brand-free: ${NEW.length} new modules and both invokers contain no restaurant literal and no rid-literal branch; the reconciler enumerates via makeFirestoreRegistryReader`);

  // CONTEXT_RECORD_TTL_MS == the pricing pointer TTL, measured BEHAVIOURALLY on the unchanged pricing reader.
  const { CONTEXT_RECORD_TTL_MS } = require('./context-source');
  const { createCatalogReader } = require('./catalog');
  let t = 0; let probes = 0;
  const reader = createCatalogReader({
    getRestaurantDocs: async () => ({ versionId: 'v', seq: 1, itemDocs: [{ key: 'a', price: 1 }], extraDocs: [] }),
    getActiveVersionId: async () => { probes += 1; return 'v'; }, now: () => t,
  });
  (async () => {
    await reader.getTables('r'); t = CONTEXT_RECORD_TTL_MS - 1; await reader.getTables('r');
    const within = probes; t = CONTEXT_RECORD_TTL_MS; await reader.getTables('r');
    assert.deepStrictEqual([within, probes], [1, 2], `the pricing pointer is re-read at exactly ${CONTEXT_RECORD_TTL_MS}ms — the same number as CONTEXT_RECORD_TTL_MS`);
    ok(`CONTEXT_RECORD_TTL_MS (${CONTEXT_RECORD_TTL_MS}) equals the pricing pointer TTL, measured on the real reader ("within one TTL" is one number)`);

    // Bounds: writer deadline < trigger timeout; reconciler function timeout < its interval; trigger capped.
    const W = require('./context-writer');
    assert.ok(W.CONTEXT_WRITER_DEADLINE_MS / 1000 < 60, 'the writer deadline is below the trigger\'s 60s function timeout');
    assert.ok(W.CONTEXT_RECONCILE_TIMEOUT_S * 1000 < W.CONTEXT_RECONCILE_INTERVAL_MS, 'the reconciler\'s function timeout is below its interval');
    assert.strictEqual(W.CONTEXT_RECONCILE_INTERVAL, 'every 5 minutes');
    assert.ok(W.CONTEXT_RECONCILE_CONCURRENCY >= 1 && W.CONTEXT_RECONCILE_CONCURRENCY <= 8);
    assert.ok(/writeCatalogContextOnMirror = onValueWritten\(\s*\{ ref: '\/catalog_snapshot\/\{rid\}'[^}]*maxInstances: \d+/.test(block), 'the trigger is on the legacy mirror path and capped by maxInstances');
    assert.ok(!/retry:\s*true/.test(block), 'no platform retry — the reconciler IS the retry');
    assert.deepStrictEqual([...W.OUTCOMES], ['committed', 'idempotent', 'superseded', 'refused', 'failed', 'timeout']);
    ok('bounds: writer deadline < trigger timeout, reconciler timeout < interval, trigger maxInstances-capped with no platform retry; outcomes are exactly the plan\'s six');

    // FK propagation (codex r8 B1): the old (rid, versionId, identityRevision) tuple appears in no key.
    for (const [f, src] of Object.entries(code)) {
      assert.ok(!/identityRevision\s*\)|`\$\{rid\}::\$\{versionId\}::\$\{[^}]*revision/.test(src), `🔴 ${f} builds a key from the bare revision tuple`);
    }
    const ks = code['context-source.js'];
    assert.ok(/bkey = \(rid, versionId, ck\) => `\$\{rid\}::\$\{versionId\}::\$\{ckString\(ck\)\}`/.test(ks), 'request-side cache key = (rid, versionId, CK) built by ckString (E1)');
    assert.ok(/compareFK\(fk, curFK\)/.test(code['context-writer.js']), 'the fence compares the full FK');
    ok('the FK/CK keys are built only in context-fk.js: request caches key on (rid, versionId, ckString(CK)) (E1), the fence on compareFK; no key is built from a bare revision tuple');

    console.log(`context-guards: OK (${n})`);
  })().catch((e) => { console.error('context-guards FAILED:', e); process.exit(1); });
} catch (e) {
  console.error('context-guards FAILED:', e);
  process.exit(1);
}
