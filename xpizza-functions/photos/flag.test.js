'use strict';
// DISH PHOTOS A1 step 6 (PLAN-dish-photos r2 §2.8) — PHOTOS_UPLOADS = RTDB config/photos_uploads_enabled, the repo's cached-flag pattern
// (tracking/flag.js): fresh within 30 s → cached; only an explicit `true` is ON; absent / non-boolean / read error / 500 ms timeout → OFF
// (+ 5 s backoff); a stale `true` is never retained. Run: node photos/flag.test.js
const assert = require('assert');
const F = require('./flag');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const T = Date.UTC(2026, 9, 27, 18, 0, 0);   // realistic epoch ms (the pattern's empty cache has at:0)
const dbOf = (fn) => ({ ref: (p) => ({ once: async () => { assert.strictEqual(p, 'config/photos_uploads_enabled', 'FLAG-PATH'); return { val: () => fn() }; } }) });

(async () => {
  assert.deepStrictEqual([F.FLAG_PATH, F.FLAG_TTL_MS, F.FLAG_REFRESH_TIMEOUT_MS, F.FLAG_BACKOFF_MS], ['config/photos_uploads_enabled', 30000, 500, 5000], 'FLAG-CONSTANTS');
  for (const [label, v, want] of [['absent', null, false], ['string "true"', 'true', false], ['1', 1, false], ['false', false, false], ['true', true, true]]) {
    F._resetForTest();
    assert.strictEqual(await F.photosUploadsEnabled(dbOf(() => v), T), want, `FLAG-VALUE ${label}`);
  }
  ok('only an explicit boolean true is ON; absent / "true" / 1 / false → OFF');

  F._resetForTest(); let reads = 0; let val = true;
  const db = dbOf(() => { reads += 1; return val; });
  assert.strictEqual(await F.photosUploadsEnabled(db, T), true);
  val = false;
  assert.strictEqual(await F.photosUploadsEnabled(db, T + 29999), true, 'FLAG-CACHED-WITHIN-TTL');
  assert.strictEqual(reads, 1, 'FLAG-ONE-READ-WITHIN-TTL');
  assert.strictEqual(await F.photosUploadsEnabled(db, T + 30000), false, 'FLAG-REFRESHED-AFTER-TTL');
  ok('cached for 30 s, refreshed after');

  F._resetForTest();
  const broken = { ref: () => ({ once: async () => { throw new Error('rtdb down'); } }) };
  const err = console.error; console.error = () => {};
  assert.strictEqual(await F.photosUploadsEnabled(broken, T), false, 'FLAG-READ-ERROR-OFF');
  console.error = err;
  F._resetForTest();
  const hang = { ref: () => ({ once: () => new Promise(() => {}) }) };
  assert.strictEqual(await F.photosUploadsEnabled(hang, T), false, 'FLAG-TIMEOUT-OFF');
  ok('a read error or a 500 ms timeout → OFF (fail closed)');

  console.log(`photos-flag: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('photos-flag: FAILED —', e && e.stack || e); process.exit(1); });
