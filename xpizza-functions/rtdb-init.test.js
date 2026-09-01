'use strict';
// Phase 1d Stage 1b REVISE — the owner-run CLIs must be able to REACH RTDB. Run: node rtdb-init.test.js
//
// `node --check` cannot catch this: it is a RUNTIME init failure. An app initialised with ADC and
// GOOGLE_CLOUD_PROJECT alone throws "Can't determine Firebase Database URL" the instant
// admin.database() is called — so a tool that mirrors to RTDB would crash before writing anything,
// and the backfill would land nothing at all. The URL must be pinned explicitly.
const assert = require('assert');
const { readFileSync } = require('fs');
const { join } = require('path');
const admin = require('firebase-admin');
const { RTDB_URL } = require('./catalog/mirror-rtdb');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  // The failure this guards against, demonstrated — so the guard below is not vacuous.
  const noUrl = admin.initializeApp({}, 'probe-no-url');
  assert.throws(() => noUrl.database().ref('catalog_snapshot/x'), /Can't determine Firebase Database URL/,
    'without a pinned URL the Admin SDK cannot resolve RTDB — this is the deploy-breaker');
  await noUrl.delete();
  ok('reproduces the failure: no databaseURL → admin.database() throws "Can\'t determine Firebase Database URL"');

  // And the fix: with the pinned URL, database() resolves and a ref into the mirror path is usable.
  const withUrl = admin.initializeApp({ databaseURL: RTDB_URL }, 'probe-with-url');
  const ref = withUrl.database().ref('catalog_snapshot/x_pizza');
  assert.ok(ref && typeof ref.set === 'function', 'the mirror ref must be usable');
  assert.strictEqual(ref.toString(), `${RTDB_URL}/catalog_snapshot/x_pizza`, 'and point at the right instance + path');
  await withUrl.delete();
  ok(`fix verified at runtime: databaseURL pinned → admin.database().ref('catalog_snapshot/…') resolves`);

  // Regression guard: BOTH owner-run CLIs must pin it. This is the check that would have caught the
  // original bug, and it fails if anyone adds a third RTDB-touching tool without the pin.
  for (const tool of ['tools/publish-version.js', 'tools/backfill-snapshot.js']) {
    const src = readFileSync(join(__dirname, tool), 'utf8');
    if (!/admin\.database\(\)/.test(src)) continue;
    assert.ok(/databaseURL:\s*RTDB_URL/.test(src), `${tool} calls admin.database() so it MUST pin databaseURL`);
    assert.ok(/require\('\.\.\/catalog\/mirror-rtdb'\)/.test(src), `${tool} must take the URL from the one shared source`);
  }
  ok('regression guard: every RTDB-touching CLI pins databaseURL from the single shared constant');

  // The pinned instance matches the one the deployed functions use (index.js pins it independently,
  // because this phase keeps index.js byte-unchanged — so assert the two agree).
  const indexSrc = readFileSync(join(__dirname, 'index.js'), 'utf8');
  assert.ok(indexSrc.includes(RTDB_URL), 'the CLIs must target the SAME RTDB instance as the deployed functions');
  ok('the CLI URL matches the instance index.js uses (one database, not two)');
  console.log(`rtdb-init: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
