'use strict';
// DISH PHOTOS A1 step 6 — photos/gcs-store.js, the ONE adapter from photoProcessCore's storage interface to @google-cloud/storage's File
// API, over a fake bucket that mimics the real call shapes and error codes (404 not found, 412 precondition failed). The real GCS behaviour
// is the §4.3 real-GCS gate (2e wiring); the Storage emulator suite is step 7. Run: node photos/gcs-store.test.js
const assert = require('assert');
const { Readable } = require('stream');
const { makeGcsStore } = require('./gcs-store');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const labelled = (label, p) => p.catch((e) => { throw new Error(`${label}: ${e && e.message}`); });   // a bare rejection carries its marker
const err = (code) => Object.assign(new Error(`gcs ${code}`), { code });

function fakeBucket() {
  const objects = new Map(); let gen = 1000; const calls = [];
  const file = (path, opts = {}) => ({
    async getMetadata() { calls.push(['getMetadata', path]); const o = objects.get(path); if (!o) throw err(404); return [{ generation: o.generation, size: String(o.buf.length) }]; },
    createReadStream() {
      calls.push(['createReadStream', path, opts.generation]);
      const o = objects.get(path);
      if (!o || (opts.generation && o.generation !== String(opts.generation))) { const r = new Readable({ read() {} }); process.nextTick(() => r.destroy(err(404))); return r; }
      return Readable.from([o.buf.subarray(0, Math.ceil(o.buf.length / 2)), o.buf.subarray(Math.ceil(o.buf.length / 2))]);
    },
    async save(buf, o2) {
      calls.push(['save', path, o2.preconditionOpts, o2.contentType, o2.metadata && o2.metadata.cacheControl]);
      if (o2.preconditionOpts && o2.preconditionOpts.ifGenerationMatch === 0 && objects.has(path)) throw err(412);
      objects.set(path, { buf, generation: String(++gen) });
    },
    get metadata() { const o = objects.get(path); return o ? { generation: o.generation } : {}; },
    async delete(o2) { calls.push(['delete', path, o2]); if (!objects.has(path) && !(o2 && o2.ignoreNotFound)) throw err(404); objects.delete(path); },
    async getSignedUrl(o2) { calls.push(['getSignedUrl', path, o2]); return [`https://signed/${path}?a=${o2.action}&e=${o2.expires}`]; },
  });
  return { objects, calls, file, put: (p, buf) => objects.set(p, { buf, generation: String(++gen) }) };
}

(async () => {
  const b = fakeBucket(); const S = makeGcsStore(b);
  // metadata
  assert.strictEqual(await labelled('GCS-METADATA-404-IS-NULL', S.metadata('uploads/r/u1')), null, 'GCS-METADATA-404-IS-NULL');
  b.put('uploads/r/u1', Buffer.alloc(1000, 1));
  assert.deepStrictEqual(await S.metadata('uploads/r/u1'), { generation: b.objects.get('uploads/r/u1').generation, size: 1000 }, 'GCS-METADATA-NUMERIC-SIZE');
  ok('metadata: 404 → null; {generation, size} with a numeric size');

  // download: pinned to the generation; byte-capped
  const g = b.objects.get('uploads/r/u1').generation;
  assert.strictEqual((await labelled('GCS-DOWNLOAD-AT-CAP', S.download('uploads/r/u1', { generation: g, maxBytes: 1000 }))).length, 1000, 'GCS-DOWNLOAD-AT-CAP');
  assert.ok(b.calls.some((c) => c[0] === 'createReadStream' && c[2] === g), 'GCS-DOWNLOAD-PINNED-GENERATION');
  await assert.rejects(() => S.download('uploads/r/u1', { generation: g, maxBytes: 999 }), (e) => e.code === 'too_large', 'GCS-DOWNLOAD-OVER-CAP-ABORTS');
  await assert.rejects(() => S.download('uploads/r/u1', { generation: '1', maxBytes: 5000 }), (e) => e.code === 'generation_mismatch', 'GCS-DOWNLOAD-OTHER-GENERATION');
  await assert.rejects(() => S.download('uploads/r/gone', { generation: g, maxBytes: 5000 }), (e) => e.code === 'generation_mismatch', 'GCS-DOWNLOAD-GONE');
  ok('download: generation-pinned stream; one byte over the cap aborts (too_large); another generation / gone → generation_mismatch');

  // createIfAbsent: ifGenerationMatch 0; an existing object → its generation, created:false
  const c1 = await S.createIfAbsent('drafts/r/p-card.webp', Buffer.from('x'), { contentType: 'image/webp' });
  assert.ok(c1.created === true && typeof c1.generation === 'string', 'GCS-CREATE');
  const save = b.calls.find((c) => c[0] === 'save');
  assert.deepStrictEqual([save[2], save[3], save[4]], [{ ifGenerationMatch: 0 }, 'image/webp', 'private, max-age=0, no-store'], 'GCS-CREATE-PRECONDITION-AND-HEADERS');
  const c2 = await labelled('GCS-CREATE-EXISTS-412', S.createIfAbsent('drafts/r/p-card.webp', Buffer.from('x'), { contentType: 'image/webp' }));
  assert.deepStrictEqual(c2, { generation: c1.generation, created: false }, 'GCS-CREATE-EXISTS-412');
  ok('createIfAbsent: save with ifGenerationMatch:0 (private, no-store); a 412 → the existing generation, created:false');

  // remove + signRead
  await S.remove('uploads/r/u1'); await labelled('GCS-REMOVE-IGNORE-NOT-FOUND', S.remove('uploads/r/never'));
  assert.ok(!b.objects.has('uploads/r/u1'), 'GCS-REMOVE');
  assert.deepStrictEqual(b.calls.filter((c) => c[0] === 'delete').map((c) => c[2]), [{ ignoreNotFound: true }, { ignoreNotFound: true }], 'GCS-REMOVE-IGNORE-NOT-FOUND');
  const url = await S.signRead('drafts/r/p-card.webp', 1234);
  const sig = b.calls.find((c) => c[0] === 'getSignedUrl');
  assert.deepStrictEqual([url, sig[2]], ['https://signed/drafts/r/p-card.webp?a=read&e=1234', { version: 'v4', action: 'read', expires: 1234, virtualHostedStyle: false }], 'GCS-SIGN-READ-V4');
  ok('remove ignores not-found; signRead = a V4 path-style GET');

  // any other error is passed through untouched (the core treats it as transient)
  const b2 = fakeBucket(); b2.file = () => ({ async getMetadata() { throw err(503); } });
  await assert.rejects(() => makeGcsStore(b2).metadata('x'), (e) => e.code === 503, 'GCS-OTHER-ERRORS-PROPAGATE');
  ok('other errors propagate unchanged (transient for the core)');

  console.log(`gcs-store: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('gcs-store: FAILED —', e && e.stack || e); process.exit(1); });
