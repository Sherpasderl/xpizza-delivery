'use strict';
// DISH PHOTOS A1 (PLAN-dish-photos r2 §2.2 E-P1; BUILD-ORDER A1 step 3) — the upload-signing SEAM. The Storage emulator does not sign,
// so E-P1 takes an injected signer; production uses makeGcsSigner. Two kinds of proof:
//   (1) the grant (pure): exact headers, every signed header returned, bounds on type/size/ids, the signer called with exactly them;
//   (2) the URL SHAPE through the REAL @google-cloud/storage V4 signer, offline, with a throwaway service-account key generated here
//       (no credentials, no network): path-style host, the object path, GOOG4-RSA-SHA256, 600 s, and EXACTLY the signed headers.
// Run: node photos/signer.test.js
const assert = require('assert');
const crypto = require('crypto');
const S = require('./signer');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

(async () => {
  assert.deepStrictEqual([S.UPLOAD_MAX_BYTES, S.UPLOAD_URL_TTL_MS, [...S.ALLOWED_CONTENT_TYPES]], [10485760, 600000, ['image/jpeg', 'image/png', 'image/webp']], 'SIGN-CONSTANTS');

  // ── (1) the grant: the signer receives exactly what is signed; the client gets back every signed header ──
  {
    const calls = [];
    const signer = async (req) => { calls.push(req); return `https://signed.example/${req.objectPath}?sig=1`; };
    const g = await S.buildUploadGrant({ bucket: 'tb-bucket', rid: 'tb_r1', uploadId: 'up_ABC123', contentType: 'image/webp', bytes: 2048, nowMs: NOW, signer });
    const headers = { 'Content-Type': 'image/webp', 'x-goog-content-length-range': '1,10485760', 'x-goog-if-generation-match': '0' };
    assert.deepStrictEqual(g, { uploadId: 'up_ABC123', url: 'https://signed.example/uploads/tb_r1/up_ABC123?sig=1', method: 'PUT', headers, expiresAt: NOW + 600000 }, 'SIGN-GRANT-SHAPE');
    assert.deepStrictEqual(calls, [{ bucket: 'tb-bucket', objectPath: 'uploads/tb_r1/up_ABC123', method: 'PUT', contentType: 'image/webp',
      extensionHeaders: { 'x-goog-content-length-range': '1,10485760', 'x-goog-if-generation-match': '0' }, expiresMs: NOW + 600000 }], 'SIGN-SIGNER-ARGS');
    ok('grant: {uploadId, url, method PUT, headers (Content-Type + length-range + if-generation-match:0), expiresAt +10 min}; the signer gets exactly those');
  }

  // ── (1b) refusals: nothing is signed for a bad request ──
  {
    let signed = 0; const signer = async () => { signed += 1; return 'x'; };
    const base = { bucket: 'tb-bucket', rid: 'tb_r1', uploadId: 'up_ABC123', contentType: 'image/jpeg', bytes: 1, nowMs: NOW, signer };
    const bad = [
      ['svg type', { contentType: 'image/svg+xml' }], ['gif type', { contentType: 'image/gif' }], ['no type', { contentType: undefined }],
      ['0 bytes', { bytes: 0 }], ['over 10 MB', { bytes: 10485761 }], ['fractional bytes', { bytes: 1.5 }], ['string bytes', { bytes: '100' }],
      ['rid with a slash', { rid: 'tb/r1' }], ['rid traversal', { rid: '..' }], ['empty rid', { rid: '' }],
      ['uploadId with a slash', { uploadId: 'a/b' }], ['uploadId too long', { uploadId: 'u'.repeat(65) }], ['no signer', { signer: null }], ['no bucket', { bucket: '' }],
    ];
    for (const [label, over] of bad) {
      await assert.rejects(() => S.buildUploadGrant({ ...base, ...over }), (e) => e.code === 'invalid_upload_request', `SIGN-REFUSES ${label}`);
    }
    assert.strictEqual(signed, 0, 'SIGN-NOTHING-SIGNED-ON-REFUSAL');
    assert.ok(await S.buildUploadGrant({ ...base, bytes: 10485760 }), 'SIGN-EXACT-MAX-OK');
    ok('refusals (type outside jpeg/png/webp, bytes ∉ 1..10485760, unsafe rid / uploadId, no signer / bucket) sign nothing; exactly 10 MB is allowed');
  }

  // ── (2) the REAL @google-cloud/storage V4 signer, offline, with a throwaway key ──
  {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const { Storage } = require('@google-cloud/storage');
    const storage = new Storage({ projectId: 'demo-photos', credentials: { client_email: 'signer@demo-photos.iam.gserviceaccount.com', private_key: privateKey } });
    const g = await S.buildUploadGrant({ bucket: 'tb-bucket', rid: 'tb_r1', uploadId: 'up_ABC123', contentType: 'image/png', bytes: 500, nowMs: Date.now(), signer: S.makeGcsSigner(storage) });
    const u = new URL(g.url);
    assert.strictEqual(u.origin, 'https://storage.googleapis.com', 'SIGN-URL-PATH-STYLE-HOST');
    assert.strictEqual(u.pathname, '/tb-bucket/uploads/tb_r1/up_ABC123', 'SIGN-URL-OBJECT-PATH');
    const q = Object.fromEntries(u.searchParams);
    assert.strictEqual(q['X-Goog-Algorithm'], 'GOOG4-RSA-SHA256', 'SIGN-URL-V4');
    assert.ok(Number(q['X-Goog-Expires']) >= 595 && Number(q['X-Goog-Expires']) <= 600, `SIGN-URL-EXPIRES-10MIN (${q['X-Goog-Expires']})`);
    assert.strictEqual(q['X-Goog-SignedHeaders'], 'content-type;host;x-goog-content-length-range;x-goog-if-generation-match', 'SIGN-URL-SIGNED-HEADERS-EXACT');
    assert.match(q['X-Goog-Signature'], /^[0-9a-f]{512}$/, 'SIGN-URL-SIGNATURE (RSA-2048, hex)');
    assert.match(q['X-Goog-Credential'], /^signer@demo-photos\.iam\.gserviceaccount\.com\/\d{8}\/auto\/storage\/goog4_request$/, 'SIGN-URL-CREDENTIAL-SCOPE');
    // the returned headers name exactly the signed extension headers (plus Content-Type): the client sends nothing it invented
    assert.deepStrictEqual(Object.keys(g.headers).map((h) => h.toLowerCase()).sort(), q['X-Goog-SignedHeaders'].split(';').filter((h) => h !== 'host'), 'SIGN-RETURNED-HEADERS-EQUAL-SIGNED');
    ok('real V4 signer (offline, throwaway key): path-style storage.googleapis.com/<bucket>/uploads/<rid>/<id>, GOOG4-RSA-SHA256, 600 s, signed headers EXACTLY content-type;host;x-goog-content-length-range;x-goog-if-generation-match = the returned headers');
  }

  console.log(`signer: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('signer: FAILED —', e && e.stack || e); process.exit(1); });
