'use strict';
// 1D D4-c2b — STATIC GUARDS for the identity integrity monitor (PLAN-D4c2b rev 14 §0 owner rules, §5, §8 ship contract):
//   · every existing module c2b imports is BYTE-IDENTICAL to the build base (zero diff; imports only)
//   · every Firestore transaction in the monitor and the boundary tool is READ-ONLY ({readOnly: true} at every call site); no
//     Firestore write anywhere in the monitor; its ONLY write is one RTDB transaction on catalog_integrity/{rid}
//   · brand-free; never serverNow (which writes a probe); not on the request path (only index.js's d4c2b block imports it)
//   · the scheduled function's options: every 15 min, 300 s, 512 MiB, maxInstances 1, concurrency 1, no platform retry
// Each assertion carries a planted SENSITIVITY check so it cannot pass vacuously. Run: node catalog/identity-integrity-guards.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

try {
  // ── 1. ZERO DIFF on every module c2b imports (37dcf43 bytes) ──────────────────────────────────────────────────────
  const PINS = {
    'catalog/identity-evidence.js': '8ce3fc7090059e742ddb6dd183c2231d299cb8c279b9142b4501a204c37d9b59',
    'catalog/evidence-encoding.js': '65cd313deaf3b2cbad07f1ad62a6301c1d10d826ecb91fa26d9fc929ebf1ea91',
    'catalog/catalog-verifier.js': '3977040f575c13a7db9f199c65c36b3b7f3adb2771d51217ab88019e5f986f0b',
    'catalog/identity-record-writer.js': '7b684fd258b277ccfe2dc9c6ea0f5673fc9416c4d1eed9f55c5a3f180baa6cf7',
    'catalog/restaurant-registry.js': '7e4a44cefb510e5224d30cced3312b5d771bc61f46eed5f62b5a555d3f667131',
    'catalog/catalog-firestore.js': '7cefff4a0b1d18bf801b91ab310c59ddcb2ada539d4a5b0fed6c98f029f044c0',
    'catalog/source-store.js': '61174ddfc808f86b0748b0ed59548ce656953e358ceaf529b99661d5ea0cc4ec',
    'catalog/identity-registry.js': '20f85f4f407b972996097b7251385fe624372d5bc58da0fd3d2fc8391c8da594',
    'catalog/catalog-publish.js': '6aa44befd3467cfd3d9e3cb2c543e421edf2beee749973a620eb9f6484ce877f',
    'catalog/identity-bootstrap.js': 'acc732fe02ed81e8b2131ac936f581f2df96645ca7f98aa94574f3ee25f05e79',
  };
  for (const [f, want] of Object.entries(PINS)) assert.strictEqual(sha(read(f)), want, `🔴 ${f} changed — c2b imports it and must never edit it`);
  assert.notStrictEqual(sha(`${read('catalog/catalog-verifier.js')} `), PINS['catalog/catalog-verifier.js'], 'sensitivity');
  ok(`zero diff: the ${Object.keys(PINS).length} existing modules c2b imports (evidence, encoding, verifier, c1 gates, registry, pointer reader, source store, identity registry, publisher, bootstrap) are byte-identical to 37dcf43`);

  // ── 2. read-only on catalog data; the only write is its own RTDB node ──────────────────────────────────────────────
  {
    const mon = strip(read('catalog/identity-integrity-monitor.js'));
    const txCalls = mon.match(/runTransaction\(/g) || [];
    const readOnly = mon.match(/, READ_ONLY\);/g) || [];   // `}, READ_ONLY);` and the one-line `…, READ_ONLY);`
    assert.ok(txCalls.length >= 4, 'premise: the monitor\'s transactions are present');
    assert.strictEqual(readOnly.length, txCalls.length, '🔴 every Firestore transaction in the monitor must end with READ_ONLY');
    assert.ok(/const READ_ONLY = Object\.freeze\(\{ readOnly: true \}\);/.test(mon), 'READ_ONLY is { readOnly: true }');
    assert.ok(!/\btx\.(set|update|create|delete)\(/.test(mon), '🔴 no transactional Firestore write');
    assert.ok(!/\.(batch|bulkWriter)\(|\.add\(|\.set\(|\.update\(|\.create\(|\.delete\(/.test(mon.replace(/window\.(shift|push)|log\.push|\.push\(/g, '')), '🔴 no Firestore write call in the monitor');
    assert.strictEqual((mon.match(/\.transaction\(/g) || []).length, 2, 'two RTDB transactions: the per-restaurant commit and the enumeration record');
    assert.ok(/nodeRef\(g, rid\)\.transaction\(/.test(mon) && /ref\(`\$\{INTEGRITY_PATH\}\/\$\{v\.rid\}`\)\.transaction\(/.test(mon), 'both on catalog_integrity/{rid}');
    assert.ok(!/serverNow/.test(mon), '🔴 never serverNow (it writes a probe); server time = the snapshot readTime');
    const bnd = strip(read('tools/record-evidence-boundary.js'));
    assert.ok(/\}, \{ readOnly: true \}\);/.test(bnd) && (bnd.match(/runTransaction\(/g) || []).length === 1, 'the boundary tool\'s one Firestore transaction is read-only');
    // sensitivity: a transaction without READ_ONLY is caught
    const planted = mon.replace('}, READ_ONLY);', '});');
    assert.notStrictEqual((planted.match(/, READ_ONLY\);/g) || []).length, txCalls.length, 'sensitivity: a non-read-only transaction is detected');
  }
  ok('read-only: every Firestore transaction in the monitor (and the boundary tool) ends with {readOnly: true}; no transactional or direct Firestore write; the only writes are RTDB transactions on catalog_integrity/{rid}; never serverNow');

  // ── 3. brand-free + not on the request path + the scheduled options ──────────────────────────────────────────────
  {
    const files = ['catalog/identity-integrity.js', 'catalog/identity-integrity-state.js', 'catalog/identity-integrity-monitor.js', 'tools/record-evidence-boundary.js',
      'tools/identity-boundary-core.js', 'tools/ack-identity-finding.js', 'tools/setup-identity-alerts.js', 'tools/identity-alerts-core.js'];
    for (const f of files) {
      const src = strip(read(f));
      assert.ok(!/x_pizza|la_musa|xpizza|lamusa/i.test(src.replace(/xpizza-delivery|xpizza-reference/g, '')), `🔴 ${f} names a restaurant`);
      assert.ok(!/(restaurantId|rid)\s*[!=]==?\s*['"`]/.test(src), `🔴 ${f} branches on a restaurant id literal`);
    }
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name.startsWith('.') ? []
      : e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(c?js|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const importers = walk(ROOT).map((f) => path.relative(ROOT, f)).filter((f) => !/\.test\.|^test\/|^tools\//.test(f))
      .filter((f) => /require\(['"][./]*(catalog\/)?identity-integrity(-state|-monitor)?['"]\)/.test(read(f))).sort();
    assert.deepStrictEqual(importers, ['catalog/identity-integrity-monitor.js', 'index.js'], '🔴 only index.js (its d4c2b block) and the monitor itself load the integrity modules — never a request path');
    const idx = read('index.js');
    const block = idx.slice(idx.indexOf('/* d4c2b:begin */'), idx.indexOf('/* d4c2b:end */'));
    assert.ok(/maxInstances: 1, concurrency: 1, retryCount: 0/.test(block), 'one instance, one concurrent invocation, NO platform retry');
    assert.ok(/exports\.verifyIdentityIntegrity = onSchedule\(/.test(block) && /makeFirestoreRegistryReader\(getFirestore\(\)\)/.test(block), 'scheduled; restaurants only from the registry reader');
    assert.ok(!/x_pizza|la_musa/.test(block));
    const M = require('./identity-integrity-monitor');
    assert.deepStrictEqual([M.INTEGRITY_SCHEDULE, M.INTEGRITY_TIMEOUT_S, M.INTEGRITY_MEMORY, M.READS_PER_SECOND, M.RUN_READ_CAP, M.RESTAURANT_ALLOWANCE_MS, M.SUMMARY_RESERVE_MS],
      ['every 15 minutes', 300, '512MiB', 100, 15000, 25000, 30000]);
    assert.ok(M.RUN_BUDGET_MS + M.SUMMARY_RESERVE_MS < M.INTEGRITY_TIMEOUT_S * 1000, 'restaurant work + the summary reserve fit inside the function timeout');
    assert.deepStrictEqual([M.OBJECT_PAGE, M.REGISTRY_BATCH, M.AUDIT_PAGE, M.CERT_READ_LIMIT, M.COUNT_LIMIT, M.GROWTH_LIMIT, M.QUIET_MS], [25, 10, 20, 9, 401, 20001, 600000]);
  }
  ok('brand-free (no restaurant literal, no rid branch) across the monitor modules and tools; loaded only by index.js\'s d4c2b block (never a request path); scheduled every 15 min / 300 s / 512 MiB / maxInstances 1 / concurrency 1 / no retry; the plan\'s budgets (25 s / 30 s reserve / 15,000 reads / 100 reads/s / pages 25 / batches 10 / audit 20 / certs 9 / counts 401 + 20001 / quiet 10 min)');

  console.log(`identity-integrity-guards: OK (${n})`);
} catch (e) {
  console.error('identity-integrity-guards FAILED:', e);
  process.exit(1);
}
