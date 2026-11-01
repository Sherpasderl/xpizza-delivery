'use strict';
// DISH PHOTOS A1 step 4 (PLAN-dish-photos r2 §2.2 E-P1, §2.7, §2.8) — photoUploadStart's CORE over the in-repo Firestore double
// and an injected signer. Concurrency (two racing starts on one op_id) is NOT provable on this double (it models no isolation);
// that cell belongs to the emulator suite (step 7). Run: node photos/upload-start.test.js
const assert = require('assert');
const { makeDb } = require('../catalog/firestore-fake');
const { photoUploadStartCore, RATE } = require('./upload-start');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const T0 = Date.UTC(2026, 9, 27, 18, 0, 0);

function harness(over = {}) {
  const db = makeDb();
  let now = T0; let ids = 0; const signed = [];
  const deps = {
    db, bucket: 'tb-bucket',
    now: () => now,
    newUploadId: () => `up${String(++ids).padStart(10, '0')}`,
    photosEnabled: () => true,
    authorize: async () => ({ ok: true }),
    signer: async (r) => { signed.push(r); return `https://signed.example/${r.objectPath}?e=${r.expiresMs}`; },
    ...over,
  };
  return { db, deps, signed, advance: (ms) => { now += ms; }, get now() { return now; } };
}
const REQ = { uid: 'u_owner_1', rid: 'tb_r1', op_id: 'op_000000001', contentType: 'image/jpeg', bytes: 123456 };
const docOf = async (db, col, id) => (await db.collection(col).doc(id).get()).data();

(async () => {
  assert.deepStrictEqual([RATE.PER_UID_PER_HOUR, RATE.PER_RID_PER_DAY], [30, 200], 'START-RATE-CONSTANTS (Q4 ruled)');

  // ── the happy path: a grant + the upload doc ──
  {
    const h = harness();
    const r = await photoUploadStartCore(h.deps, REQ);
    assert.strictEqual(r.status, 200, `START-200 ${JSON.stringify(r)}`);
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['expiresAt', 'headers', 'method', 'uploadId', 'url'], 'START-BODY-KEYS');
    assert.strictEqual(r.body.uploadId, 'up0000000001', 'START-UPLOAD-ID');
    assert.deepStrictEqual(r.body.headers, { 'Content-Type': 'image/jpeg', 'x-goog-content-length-range': '1,10485760', 'x-goog-if-generation-match': '0' }, 'START-HEADERS');
    assert.strictEqual(h.signed[0].objectPath, 'uploads/tb_r1/up0000000001', 'START-OBJECT-PATH');
    const doc = await docOf(h.db, 'photo_uploads', 'up0000000001');
    assert.deepStrictEqual({ ...doc, created_at: 'T' }, { rid: 'tb_r1', uid: 'u_owner_1', op_id: 'op_000000001', contentType: 'image/jpeg', bytes: 123456, state: 'issued', attempts: 0, created_at: 'T' }, 'START-UPLOAD-DOC');
    ok('grant {uploadId, url, method, headers, expiresAt}; upload doc {rid, uid, op_id, contentType, bytes, state:issued, attempts:0}');
  }

  // ── idempotency {uid, rid, op_id}: same key → same upload, re-signed, no new doc, no rate charge; different spec → op_conflict ──
  {
    const h = harness();
    const a = await photoUploadStartCore(h.deps, REQ);
    h.advance(11 * 60 * 1000);                           // the first URL has expired
    const b = await photoUploadStartCore(h.deps, REQ);
    assert.strictEqual(b.body.uploadId, a.body.uploadId, 'START-IDEMPOTENT-SAME-UPLOAD');
    assert.ok(b.body.expiresAt > a.body.expiresAt, 'START-RETRY-RESIGNED');
    assert.strictEqual(h.signed[1].objectPath, h.signed[0].objectPath, 'START-RETRY-SAME-OBJECT');
    const uploads = (await h.db.collection('photo_uploads').get()).docs.length;
    assert.strictEqual(uploads, 1, 'START-RETRY-NO-NEW-DOC');
    const c = await photoUploadStartCore(h.deps, { ...REQ, bytes: 999 });
    assert.deepStrictEqual([c.status, c.body], [409, { error: 'op_conflict' }], 'START-OP-CONFLICT');
    const d = await photoUploadStartCore(h.deps, { ...REQ, rid: 'tb_r2' });
    assert.notStrictEqual(d.body.uploadId, a.body.uploadId, 'START-OTHER-RID-OTHER-UPLOAD (key includes rid)');
    const e = await photoUploadStartCore(h.deps, { ...REQ, uid: 'u_owner_2' });
    assert.notStrictEqual(e.body.uploadId, a.body.uploadId, 'START-OTHER-UID-OTHER-UPLOAD (key includes uid)');
    ok('idempotency on {uid, rid, op_id}: a retry returns the same upload, re-signed, no new doc; a different {contentType, bytes} → 409 op_conflict');
  }

  // ── authorization on EVERY call (a revoked member's retry is refused); the flag; input shape ──
  {
    let allow = true;
    const h = harness({ authorize: async () => (allow ? { ok: true } : { ok: false, code: 'not_authorized' }) });
    await photoUploadStartCore(h.deps, REQ);
    allow = false;
    const r = await photoUploadStartCore(h.deps, REQ);
    assert.deepStrictEqual([r.status, r.body], [403, { error: 'not_authorized' }], 'START-RETRY-REAUTHORIZED');
    const h2 = harness({ authorize: async () => ({ ok: false, code: 'unavailable' }) });
    const u = await photoUploadStartCore(h2.deps, REQ);
    assert.deepStrictEqual([u.status, u.body], [503, { error: 'unavailable', retryable: true }], 'START-TENANT-UNRESOLVABLE');
    assert.strictEqual(h2.signed.length, 0, 'START-NOTHING-SIGNED-WHEN-REFUSED');
    const h3 = harness({ photosEnabled: () => false });
    const f = await photoUploadStartCore(h3.deps, REQ);
    assert.deepStrictEqual([f.status, f.body], [409, { error: 'photos_disabled' }], 'START-FLAG-OFF');
    assert.strictEqual((await h3.db.collection('photo_uploads').get()).docs.length, 0, 'START-FLAG-OFF-NO-DOC');
    const h4 = harness();
    for (const [label, over] of [['svg', { contentType: 'image/svg+xml' }], ['0 bytes', { bytes: 0 }], ['>10MB', { bytes: 10485761 }], ['bad op_id', { op_id: 'x' }], ['bad rid', { rid: '../x' }], ['no uid', { uid: '' }]]) {
      const b = await photoUploadStartCore(h4.deps, { ...REQ, ...over });
      assert.deepStrictEqual([b.status, b.body], [400, { error: 'bad_request' }], `START-BAD-REQUEST ${label}`);
    }
    assert.strictEqual(h4.signed.length, 0, 'START-BAD-REQUEST-SIGNS-NOTHING');
    ok('authorize runs on every call (a revoked retry → 403; unresolvable → 503 retryable); flag off → photos_disabled, no doc; malformed → bad_request; nothing signed');
  }

  // ── fail-closed rate limits: 30 NEW starts / hour / uid, 200 / day / rid; retries are free; a broken limiter refuses ──
  {
    const h = harness();
    for (let i = 0; i < 30; i++) assert.strictEqual((await photoUploadStartCore(h.deps, { ...REQ, op_id: `op_uid_${String(i).padStart(4, '0')}` })).status, 200, `START-UID-UNDER-LIMIT ${i}`);
    const over = await photoUploadStartCore(h.deps, { ...REQ, op_id: 'op_uid_over_0' });
    assert.deepStrictEqual([over.status, over.body], [429, { error: 'rate_limited', retryable: true }], 'START-UID-RATE-LIMITED');
    assert.strictEqual((await photoUploadStartCore(h.deps, { ...REQ, op_id: 'op_uid_0000' })).status, 200, 'START-RETRY-NOT-CHARGED');
    h.advance(60 * 60 * 1000);
    assert.strictEqual((await photoUploadStartCore(h.deps, { ...REQ, op_id: 'op_uid_next_h' })).status, 200, 'START-UID-NEXT-HOUR');
    // per-rid per-day: 200 across many uids
    const h2 = harness();
    for (let i = 0; i < 200; i++) assert.strictEqual((await photoUploadStartCore(h2.deps, { ...REQ, uid: `u_m_${Math.floor(i / 20)}`, op_id: `op_rid_${String(i).padStart(4, '0')}` })).status, 200, `START-RID-UNDER-LIMIT ${i}`);
    const r = await photoUploadStartCore(h2.deps, { ...REQ, uid: 'u_m_fresh', op_id: 'op_rid_over0' });
    assert.deepStrictEqual([r.status, r.body], [429, { error: 'rate_limited', retryable: true }], 'START-RID-RATE-LIMITED');
    // fail-CLOSED: the transaction (limiter) failing → unavailable, nothing signed
    const h3 = harness(); h3.deps.db = { ...h3.db, runTransaction: async () => { throw new Error('firestore down'); } };
    const down = await photoUploadStartCore(h3.deps, REQ);
    assert.deepStrictEqual([down.status, down.body], [503, { error: 'unavailable', retryable: true }], 'START-LIMITER-FAIL-CLOSED');
    assert.strictEqual(h3.signed.length, 0, 'START-FAIL-CLOSED-SIGNS-NOTHING');
    ok('rate limits fail-CLOSED: 30 new starts/h/uid and 200/day/rid → 429 rate_limited (retryable); retries are free; next hour resets; a limiter error → 503, nothing signed');
  }

  console.log(`upload-start: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('upload-start: FAILED —', e && e.stack || e); process.exit(1); });
