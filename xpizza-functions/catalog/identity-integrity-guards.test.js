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
  // ── 1. ZERO DIFF on every module c2b imports (the integration base 4e2a710's bytes; source-store.js moved there in add-product A —
  //    rendererContract only; the one export c2b uses, sourceRefOf, is unchanged — the other nine are identical at 37dcf43 and 4e2a710) ──────────────────────────────────────────────────────
  const PINS = {
    'catalog/identity-evidence.js': '8ce3fc7090059e742ddb6dd183c2231d299cb8c279b9142b4501a204c37d9b59',
    'catalog/evidence-encoding.js': '65cd313deaf3b2cbad07f1ad62a6301c1d10d826ecb91fa26d9fc929ebf1ea91',
    'catalog/catalog-verifier.js': '3977040f575c13a7db9f199c65c36b3b7f3adb2771d51217ab88019e5f986f0b',
    'catalog/identity-record-writer.js': '7b684fd258b277ccfe2dc9c6ea0f5673fc9416c4d1eed9f55c5a3f180baa6cf7',
    'catalog/restaurant-registry.js': '7e4a44cefb510e5224d30cced3312b5d771bc61f46eed5f62b5a555d3f667131',
    'catalog/catalog-firestore.js': '7cefff4a0b1d18bf801b91ab310c59ddcb2ada539d4a5b0fed6c98f029f044c0',
    'catalog/source-store.js': '48bd5cf46115ca6ec07cdb2650bff07a2efe3bf7e056688ade9b1222ea3187b6',
    'catalog/identity-registry.js': '20f85f4f407b972996097b7251385fe624372d5bc58da0fd3d2fc8391c8da594',
    'catalog/catalog-publish.js': '6aa44befd3467cfd3d9e3cb2c543e421edf2beee749973a620eb9f6484ce877f',
    'catalog/identity-bootstrap.js': 'acc732fe02ed81e8b2131ac936f581f2df96645ca7f98aa94574f3ee25f05e79',
  };
  for (const [f, want] of Object.entries(PINS)) assert.strictEqual(sha(read(f)), want, `🔴 ${f} changed — c2b imports it and must never edit it`);
  assert.notStrictEqual(sha(`${read('catalog/catalog-verifier.js')} `), PINS['catalog/catalog-verifier.js'], 'sensitivity');
  ok(`zero diff: the ${Object.keys(PINS).length} existing modules c2b imports (evidence, encoding, verifier, c1 gates, registry, pointer reader, source store, identity registry, publisher, bootstrap) are byte-identical to the integration base 4e2a710`);

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

  // ── 4. THE OWNS_IDENTITY ENTRIES STAY TRUE (advisor ruling 2026-10-10): identity-integrity.js and identity-integrity-monitor.js are
  //    allowlisted in catalog/identity-public-contract.test.js as identity-owning VERIFIERS that are alert-only and reached from
  //    the serving code ONLY through the scheduled verifyIdentityIntegrity export. Pinned here: (a) the EXACT requirer set of each
  //    module across xpizza-functions (tests excluded) — index.js's d4c2b block, the monitor itself, and three operator CLIs in
  //    tools/ that nothing outside tools/ requires; (b) index.js requires the monitor ONCE, inside the d4c2b block, and uses it
  //    nowhere else; (c) the write surface: the classifier is PURE (no database handle, no I/O call), and every RTDB ref in the
  //    monitor is under catalog_integrity (Firestore read-only is cell 2). Each part carries a planted RED.
  {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name.startsWith('.') ? []
      : e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(c?js|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const FILES = Object.fromEntries(walk(ROOT).map((f) => path.relative(ROOT, f)).filter((f) => !/\.test\.|^test\//.test(f)).map((f) => [f, read(f)]));
    const MODS = ['identity-integrity', 'identity-integrity-monitor'];
    const census = (files) => Object.fromEntries(MODS.map((m) => [m, Object.keys(files)
      .filter((f) => new RegExp(`require\\(\\s*['"\`](\\.{1,2}/)+(catalog/)?${m}(\\.js)?['"\`]\\s*\\)`).test(strip(files[f]))).sort()]));
    const WANT = {
      'identity-integrity': ['catalog/identity-integrity-monitor.js', 'tools/identity-boundary-core.js'],
      'identity-integrity-monitor': ['index.js', 'tools/ack-identity-finding.js', 'tools/record-evidence-boundary.js'],
    };
    assert.deepStrictEqual(census(FILES), WANT, '🔴 a new requirer of the identity integrity modules — the OWNS_IDENTITY entries assume they are reached only via the scheduled export (advisor ruling 2026-10-10)');
    const OPS = ['tools/identity-boundary-core.js', 'tools/ack-identity-finding.js', 'tools/record-evidence-boundary.js'];
    for (const t of OPS) {
      const base = path.basename(t, '.js');
      const users = Object.keys(FILES).filter((f) => !f.startsWith('tools/') && new RegExp(`require\\([^)]*${base}`).test(strip(FILES[f])));
      assert.deepStrictEqual(users, [], `🔴 ${t} (an operator CLI that loads the integrity modules) is required from outside tools/: ${users}`);
    }
    // non-vacuity: a money module requiring either one goes RED
    for (const m of MODS) {
      const planted = { ...FILES, 'menu-pricing.js': `${FILES['menu-pricing.js']}\nconst X = require('./catalog/${m}');\n` };
      assert.notDeepStrictEqual(census(planted), WANT, `sensitivity: menu-pricing.js requiring ${m} is detected`);
    }
    assert.ok(FILES['menu-pricing.js'], 'premise: the planted money module exists');

    // (b) index.js: once, inside the block, used nowhere else
    const idx = FILES['index.js'];
    const inBlock = (src) => { const a = src.indexOf('/* d4c2b:begin */'); const b = src.indexOf('/* d4c2b:end */'); return [src.slice(0, a) + src.slice(b), src.slice(a, b)]; };
    const idxOk = (src) => { const [out, blk] = inBlock(src);
      return (strip(blk).match(/require\('\.\/catalog\/identity-integrity-monitor'\)/g) || []).length === 1 && !/identity-integrity/.test(strip(out)) && !/\bIIM\b/.test(strip(out)); };
    assert.ok(idxOk(idx), '🔴 index.js must require the monitor exactly once, INSIDE the d4c2b block, and use it nowhere else');
    assert.ok(!idxOk(`${idx}\nconst Y = require('./catalog/identity-integrity');\n`), 'sensitivity: a require outside the block is detected');
    assert.ok(!idxOk(`${idx}\nexports.leak = () => IIM.RUN_READ_CAP;\n`), 'sensitivity: a use of IIM outside the block is detected');

    // (c) write surface
    const cls = strip(FILES['catalog/identity-integrity.js']);
    const classifierPure = (src) => !/require\(['"]firebase/.test(src) && !/\b(getFirestore|getDatabase|runTransaction|bulkWriter)\b|\.transaction\(|\.(ref|doc|collection|batch)\(/.test(src);
    assert.deepStrictEqual((cls.match(/require\('[^']+'\)/g) || []).sort(), ["require('./catalog-verifier')", "require('./evidence-encoding')", "require('./identity-evidence')", "require('./identity-registry')"],
      'premise: the classifier imports only identity-evidence, evidence-encoding, catalog-verifier and identity-registry (validIdShape) — all pinned, none a database handle');
    assert.ok(classifierPure(cls), '🔴 the classifier must stay PURE: no database handle, no ref/doc/collection/batch, no transaction');
    for (const w of ["db.doc('x').set({})", "rtdb.ref('menus').set(1)", "require('firebase-admin')", 'db.runTransaction(async () => {})', "db.collection('orders')"])
      assert.ok(!classifierPure(`${cls}\n${w}`), `sensitivity: a planted ${w} in the classifier is detected`);
    const mon = strip(FILES['catalog/identity-integrity-monitor.js']);
    const refsOk = (src) => { const refs = src.match(/\.ref\(([^)]*)\)/g) || []; return refs.length >= 3 && refs.every((r) => /^\.ref\(`\$\{INTEGRITY_PATH\}\//.test(r)); };
    assert.strictEqual(require('./identity-integrity-monitor').INTEGRITY_PATH, 'catalog_integrity');
    assert.ok(refsOk(mon), '🔴 every RTDB ref in the monitor must be under catalog_integrity/');
    assert.ok(!refsOk(`${mon} rtdb.ref('menus/x').set(1)`), 'sensitivity: an RTDB ref outside catalog_integrity is detected');
  }
  ok('OWNS_IDENTITY stays true (advisor ruling 2026-10-10): the identity integrity modules are required ONLY by index.js\'s d4c2b block (once, used nowhere else), the monitor, and three operator CLIs nothing outside tools/ loads; the classifier is pure; every monitor RTDB ref is under catalog_integrity/ — a planted money-module requirer, an out-of-block require or use, a classifier write and a foreign RTDB ref each go RED');

  console.log(`identity-integrity-guards: OK (${n})`);
} catch (e) {
  console.error('identity-integrity-guards FAILED:', e);
  process.exit(1);
}
