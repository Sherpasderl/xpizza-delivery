'use strict';
// DISH PHOTOS A2 step 10 — photos/gcs-copy.js copyIfAbsent(srcPath, dstBucket, dstPath): the publish copy, create-only
// (ifGenerationMatch 0 on the DESTINATION), public immutable cache headers; a 412 = already there (same bytes by construction) → its
// generation; any other error propagates (publish fails closed). Over a fake that mimics @google-cloud/storage's call shapes; the real
// behaviour is the §4.3 real-GCS gate. Run: node photos/gcs-copy.test.js
const assert = require('assert');
const { makeGcsCopy } = require('./gcs-copy');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const err = (code) => Object.assign(new Error(`gcs ${code}`), { code });

function fakeStorage() {
  const objs = new Map(); let gen = 900; const calls = [];
  const bucket = (name = 'tb-default') => ({ name, file: (path) => ({ bucket: name, name: path,
    async copy(dst, opts) {
      calls.push({ from: `${name}/${path}`, to: `${dst.bucket}/${dst.name}`, opts });
      if (!objs.has(`${name}/${path}`)) throw err(404);
      if (opts && opts.preconditionOpts && opts.preconditionOpts.ifGenerationMatch === 0 && objs.has(`${dst.bucket}/${dst.name}`)) throw err(412);
      objs.set(`${dst.bucket}/${dst.name}`, String(++gen));
    },
    async getMetadata() { const g = objs.get(`${name}/${path}`); if (!g) throw err(404); return [{ generation: g }]; },
  }) });
  return { objs, calls, bucket };
}

(async () => {
  const s = fakeStorage(); const C = makeGcsCopy(s);
  s.objs.set('tb-default/drafts/r/p-card.webp', '1');
  const a = await C.copyIfAbsent('drafts/r/p-card.webp', 'tb-public', 'photos/r/p-card.webp');
  assert.deepStrictEqual(a, { generation: s.objs.get('tb-public/photos/r/p-card.webp'), created: true }, 'COPY-CREATED');
  assert.deepStrictEqual(s.calls[0].opts, { preconditionOpts: { ifGenerationMatch: 0 }, contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' }, 'COPY-CREATE-ONLY-IMMUTABLE (codex r1 P2-6: cacheControl at the TOP level, beside contentType — File.copy maps nested metadata to CUSTOM metadata)');
  const b = await C.copyIfAbsent('drafts/r/p-card.webp', 'tb-public', 'photos/r/p-card.webp');
  assert.deepStrictEqual(b, { generation: a.generation, created: false }, 'COPY-412-IS-EXISTING');
  ok('copyIfAbsent: create-only (ifGenerationMatch 0), webp + public immutable cache; a 412 → the existing generation, created:false');
  await assert.rejects(() => C.copyIfAbsent('drafts/r/gone.webp', 'tb-public', 'photos/r/gone.webp'), (e) => e.code === 404, 'COPY-SOURCE-MISSING-PROPAGATES');
  ok('any other error (a missing draft, a 503) propagates — publish fails closed');
  console.log(`gcs-copy: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('gcs-copy: FAILED —', e && e.stack || e); process.exit(1); });
