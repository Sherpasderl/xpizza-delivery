'use strict';
// DISH PHOTOS A2 step 10 — photos/publish-io.js: publishEdited's (and requestPublish's) photos dependency = edit-io's readActive +
// publish-photos (prepare / hook / markPublished) over the GCS copy adapter. Run: node photos/publish-io.test.js
const assert = require('assert');
const { makeDb } = require('../catalog/firestore-fake');
const { makePublishIo } = require('./publish-io');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
(async () => {
  const fs = makeDb();
  const io = makePublishIo({ fs, storage: { bucket: () => ({ file: () => ({}) }) }, publicBucket: () => 'tb-public' });
  assert.deepStrictEqual(Object.keys(io).sort(), ['hook', 'markPublished', 'prepare', 'readActive'], 'PIO-SHAPE');
  assert.strictEqual(await io.readActive('tb_r1', 'v1'), null, 'PIO-READ-ACTIVE-ABSENT');
  assert.strictEqual(await io.prepare('tb_r1', null), null, 'PIO-PREPARE-NOTHING');
  assert.strictEqual(io.hook(null), null, 'PIO-NO-HOOK');
  ok('publish-io: {readActive, prepare, hook, markPublished} composed over Firestore + the GCS copy adapter');
  console.log(`publish-io: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('publish-io: FAILED —', e && e.stack || e); process.exit(1); });
