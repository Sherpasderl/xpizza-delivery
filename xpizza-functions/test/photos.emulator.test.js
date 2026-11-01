'use strict';
// DISH PHOTOS A1 step 7 (PLAN-dish-photos r2 §4.1; scope line DISH-PHOTOS-A1-NOTES "Step 7 PREP") — the photo cores against the REAL
// Firestore emulator (transaction isolation the in-repo double cannot model) and the REAL Storage emulator (generations, 412s, rules),
// through the production adapter photos/gcs-store.js. Storage is reached ONLY after 2e's prod-wipe guard (assertStorageTestTarget).
// The V4 signed PUT/GET are NOT emulable (the emulator does not sign) — they are the §4.3 real-GCS gate.
// Run (HEAVY, in a granted slot):
//   PATH="/opt/homebrew/opt/openjdk/bin:$PATH" node tools/emulator-run.js --only firestore,database,storage --project demo-xpizza "node test/photos.emulator.test.js"
require('./_emulator-required')('firestore');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
const EE = require('../lib/emulator-endpoint');
const BUCKET = `${process.env.GCLOUD_PROJECT}.appspot.com`;   // the emulator's default bucket for the demo project (demo-* ⇒ a test bucket)
const target = EE.assertStorageTestTarget(process.env, BUCKET);   // 🔴 BEFORE any Storage client: throws unless THIS run's storage + a test bucket

const assert = require('assert');
const http = require('http');
require('../lib/admin');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const sharp = require('sharp');
const { photoUploadStartCore, RATE } = require('../photos/upload-start');
const { photoProcessCore } = require('../photos/process');
const { makeGcsStore } = require('../photos/gcs-store');
const { processImage } = require('../photos/pipeline');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('photos(emulator): FAILED — exited without completing'); process.exitCode = 1; } });
const WATCHDOG = setTimeout(() => { console.error('photos(emulator): FAILED — watchdog (300 s)'); process.exit(1); }, 300000);

const db = getFirestore();
const bucket = getStorage().bucket(BUCKET);
const store = makeGcsStore(bucket);
const RID = 'tb_photos_r1';
const CROPS = { card: { x: 0, y: 0, w: 800, h: 600 }, hero: { x: 0, y: 0, w: 960, h: 600 } };
let ids = 0; const newId = (p) => `${p}${Date.now().toString(36)}${(++ids).toString(36)}`;
const startDeps = (over = {}) => ({ db, bucket: BUCKET, now: Date.now, newUploadId: () => newId('up'), photosEnabled: () => true,
  authorize: async () => ({ ok: true }), signer: async (r) => `https://signed.test/${r.objectPath}?e=${r.expiresMs}`, ...over });
const processDeps = (over = {}) => ({ db, storage: store, now: Date.now, newClaimId: () => newId('cl'), photosEnabled: () => true,
  authorize: async () => ({ ok: true }), signRead: async (p, e) => `https://read.test/${p}?e=${e}`, processImage, ...over });
const jpeg = (w = 1000, h = 800) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 60, b: 40 } } }).jpeg().toBuffer();
async function issueUpload(uid, buf) {
  const r = await photoUploadStartCore(startDeps(), { uid, rid: RID, op_id: newId('op'), contentType: 'image/jpeg', bytes: buf.length });
  assert.strictEqual(r.status, 200, `premise: upload issued ${JSON.stringify(r.body)}`);
  await bucket.file(`uploads/${RID}/${r.body.uploadId}`).save(buf, { resumable: false, contentType: 'image/jpeg' });
  return r.body.uploadId;
}
function rest(method, path) {   // the Firebase Storage REST surface the CLIENT SDKs use — rules apply here (Admin bypasses them)
  const [h, p] = target.host.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: h, port: Number(p), method, path: `/v0/b/${BUCKET}/o${path}`, headers: { 'Content-Type': 'image/jpeg' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(method === 'POST' ? Buffer.from('x') : undefined);
  });
}

(async () => {
  // ── E1: the op key is idempotent under REAL concurrency ──
  {
    const uid = 'tb_uid_e1', op = newId('op');
    const call = () => photoUploadStartCore(startDeps(), { uid, rid: RID, op_id: op, contentType: 'image/png', bytes: 1234 });
    const rs = await Promise.all([call(), call(), call()]);
    assert.ok(rs.every((r) => r.status === 200), `PHOTO-EMU-OP-IDEMPOTENT all granted ${JSON.stringify(rs.map((r) => r.status))}`);
    assert.strictEqual(new Set(rs.map((r) => r.body.uploadId)).size, 1, 'PHOTO-EMU-OP-IDEMPOTENT one uploadId');
    const docs = await db.collection('photo_uploads').where('op_id', '==', op).get();
    assert.strictEqual(docs.size, 1, 'PHOTO-EMU-OP-IDEMPOTENT one photo_uploads doc');
    ok('E1 PHOTO-EMU-OP-IDEMPOTENT: 3 concurrent starts with one op_id → one upload doc, the same uploadId every time');
  }
  // ── E2: the per-uid hourly limit NEVER over-grants under concurrency, and is EXACT once contention clears (advisor ruling, A1
  //    heavy turn): contended transactions that exhaust their retries answer `unavailable` (fail CLOSED by design, upload-start.js);
  //    the exact status mix is asserted: every answer is a grant, rate_limited or unavailable — nothing else — and the counter equals
  //    the grants; then the non-granted calls re-issued ONE AT A TIME top the grants up to exactly the limit, every further one rate_limited ──
  {
    const uid = 'tb_uid_e2';
    const N = RATE.PER_UID_PER_HOUR + 1;
    const start = () => photoUploadStartCore(startDeps(), { uid, rid: RID, op_id: newId('op'), contentType: 'image/jpeg', bytes: 10 });
    const rs = await Promise.all(Array.from({ length: N }, start));
    const mix = { granted: 0, rate_limited: 0, unavailable: 0, other: [] };
    for (const r of rs) {
      if (r.status === 200) mix.granted += 1;
      else if (r.body && r.body.error === 'rate_limited' && r.status === 429) mix.rate_limited += 1;
      else if (r.body && r.body.error === 'unavailable' && r.status === 503 && r.body.retryable === true) mix.unavailable += 1;
      else mix.other.push([r.status, r.body && r.body.error]);
    }
    const counted = async () => (await db.collection('photo_rate_uid').where('uid', '==', uid).get()).docs.reduce((n, d) => n + (Number(d.data().count) || 0), 0);
    assert.deepStrictEqual(mix.other, [], `PHOTO-EMU-RATE-MIX only grant / rate_limited / unavailable ${JSON.stringify(mix)}`);
    assert.strictEqual(mix.granted + mix.rate_limited + mix.unavailable, N, `PHOTO-EMU-RATE-MIX every call answered ${JSON.stringify(mix)}`);
    assert.ok(mix.granted <= RATE.PER_UID_PER_HOUR, `PHOTO-EMU-RATE-NEVER-OVER ${JSON.stringify(mix)}`);
    assert.strictEqual(await counted(), mix.granted, `PHOTO-EMU-RATE-COUNTER-EQUALS-GRANTS ${JSON.stringify(mix)}`);
    let granted = mix.granted;
    for (let i = 0; i < N - mix.granted; i++) {   // the non-granted calls, again, sequentially (no contention)
      const r = await start();
      if (r.status === 200) granted += 1;
      else assert.strictEqual(r.body && r.body.error, 'rate_limited', `PHOTO-EMU-RATE-SEQUENTIAL only grants then rate_limited (${r.status} ${r.body && r.body.error})`);
    }
    assert.strictEqual(granted, RATE.PER_UID_PER_HOUR, `PHOTO-EMU-RATE-EXACT-ONCE-CLEAR ${granted} (concurrent ${JSON.stringify(mix)})`);
    const more = await start();
    assert.deepStrictEqual([more.status, more.body && more.body.error], [429, 'rate_limited'], 'PHOTO-EMU-RATE-EXACT-ONCE-CLEAR the next is rate_limited');
    assert.strictEqual(await counted(), RATE.PER_UID_PER_HOUR, 'PHOTO-EMU-RATE-COUNTER-EXACT');
    ok(`E2 PHOTO-EMU-RATE: ${N} concurrent starts → ${JSON.stringify({ granted: mix.granted, rate_limited: mix.rate_limited, unavailable: mix.unavailable })} (never over, counter = grants); sequential retries → exactly ${RATE.PER_UID_PER_HOUR} grants, then rate_limited`);
  }
  // ── E3: two concurrent process calls on one upload → ONE decode ──
  {
    const uploadId = await issueUpload('tb_uid_e3', await jpeg());
    let decodes = 0;
    const deps = processDeps({ processImage: async (buf, crops) => { decodes++; await new Promise((r) => setTimeout(r, 300)); return processImage(buf, crops); } });
    const rs = await Promise.all([photoProcessCore(deps, { uid: 'tb_uid_e3', rid: RID, uploadId, crops: CROPS }), photoProcessCore(deps, { uid: 'tb_uid_e3', rid: RID, uploadId, crops: CROPS })]);
    assert.strictEqual(decodes, 1, `PHOTO-EMU-ONE-CLAIM one decode (${decodes})`);
    assert.ok(rs.some((r) => r.status === 200), 'PHOTO-EMU-ONE-CLAIM one success');
    assert.ok(rs.every((r) => r.status === 200 || (r.body && r.body.error === 'in_progress')), `PHOTO-EMU-ONE-CLAIM the other is in_progress or the stored result ${JSON.stringify(rs.map((r) => r.body && (r.body.error || r.body.pid)))}`);
    const again = await photoProcessCore(deps, { uid: 'tb_uid_e3', rid: RID, uploadId, crops: CROPS });
    assert.strictEqual(again.body.pid, rs.find((r) => r.status === 200).body.pid, 'PHOTO-EMU-ONE-CLAIM a retry returns the stored pid');
    assert.strictEqual(decodes, 1, 'PHOTO-EMU-ONE-CLAIM the retry does not decode');
    ok('E3 PHOTO-EMU-ONE-CLAIM: 2 concurrent processPhoto calls → one decode, one success, the other in_progress/stored; a retry returns the stored pid');
  }
  // ── E4: createIfAbsent on the emulator's 412 — SEQUENTIAL ──
  // EMULATOR LIMITATION (heavy 2026-11-01): two CONCURRENT create-only saves BOTH succeeded (two generations), although the upload
  // carries ifGenerationMatch=0 (pinned on the wire by photos/gcs-store.test.js GCS-REAL-SDK-UPLOAD-CARRIES-IF-GENERATION-MATCH-0).
  // The emulator does not serialize the precondition; the concurrent guarantee is a deploy-time real-GCS acceptance item.
  {
    const path = `drafts/${RID}/e4-${newId('x')}-card.webp`;
    const first = await store.createIfAbsent(path, Buffer.from('a'), { contentType: 'image/webp' });
    const second = await store.createIfAbsent(path, Buffer.from('a'), { contentType: 'image/webp' });
    assert.deepStrictEqual([first.created, second.created], [true, false], `PHOTO-EMU-CREATE-IF-ABSENT the second create meets the 412 ${JSON.stringify([first, second])}`);
    assert.strictEqual(second.generation, first.generation, 'PHOTO-EMU-CREATE-IF-ABSENT the second reports the first\'s generation');
    ok('E4 PHOTO-EMU-CREATE-IF-ABSENT: create-only then create-only → created, then the SAME generation via the emulator\'s 412 (concurrency: unit wire pin + real-GCS acceptance)');
  }
  // ── E5: an upload replaced between metadata and download is refused (generation pin) ──
  {
    const uploadId = await issueUpload('tb_uid_e5', await jpeg());
    let decodes = 0;
    const racing = { ...store, async metadata(p) { const m = await store.metadata(p); await bucket.file(p).save(await jpeg(1100, 900), { resumable: false }); return m; } };
    const r = await photoProcessCore(processDeps({ storage: racing, processImage: async (b, c) => { decodes++; return processImage(b, c); } }), { uid: 'tb_uid_e5', rid: RID, uploadId, crops: CROPS });
    assert.strictEqual(decodes, 0, 'PHOTO-EMU-GENERATION-PIN nothing decoded');
    assert.notStrictEqual(r.status, 200, `PHOTO-EMU-GENERATION-PIN refused (${JSON.stringify(r.body)})`);
    ok(`E5 PHOTO-EMU-GENERATION-PIN: the object replaced after the metadata read → ${r.body && r.body.error}, nothing decoded`);
  }
  // ── E6: the streamed byte cap aborts (an 11 MiB object never buffers whole) ──
  {
    const path = `uploads/${RID}/e6-${newId('x')}`;
    await bucket.file(path).save(Buffer.alloc(11 * 1024 * 1024, 7), { resumable: false });
    const m = await store.metadata(path);
    await assert.rejects(() => store.download(path, { generation: m.generation, maxBytes: 10485760 }), (e) => e.code === 'too_large', 'PHOTO-EMU-BYTE-CAP');
    ok('E6 PHOTO-EMU-BYTE-CAP: an 11 MiB object → too_large mid-stream (the generation-pinned download aborts past 10 MiB)');
  }
  // ── E7: the deny-all rules are live in the emulator — the client surface reads and writes nothing ──
  {
    const objPath = encodeURIComponent(`drafts/${RID}/e7.webp`);
    await bucket.file(`drafts/${RID}/e7.webp`).save(Buffer.from('w'), { resumable: false });
    const read = await rest('GET', `/${objPath}?alt=media`);
    const write = await rest('POST', `?name=${encodeURIComponent(`uploads/${RID}/e7`)}`);
    const list = await rest('GET', `?prefix=${encodeURIComponent(`drafts/${RID}/`)}`);
    for (const [what, code] of [['read', read], ['write', write], ['list', list]]) assert.ok(code === 403 || code === 401, `PHOTO-EMU-RULES-DENY client ${what} → ${code}`);
    ok(`E7 PHOTO-EMU-RULES-DENY: unauthenticated client read / write / list → ${read} / ${write} / ${list} (storage.rules deny-all)`);
  }
  // ── E8: after commit the upload object is gone and the draft pair exists, private + no-store ──
  {
    const uploadId = await issueUpload('tb_uid_e8', await jpeg());
    const r = await photoProcessCore(processDeps(), { uid: 'tb_uid_e8', rid: RID, uploadId, crops: CROPS });
    assert.strictEqual(r.status, 200, `PHOTO-EMU-UPLOAD-DELETED premise ${JSON.stringify(r.body)}`);
    const [upExists] = await bucket.file(`uploads/${RID}/${uploadId}`).exists();
    assert.strictEqual(upExists, false, 'PHOTO-EMU-UPLOAD-DELETED the upload object is removed after the commit');
    for (const kind of ['card', 'hero']) {
      const [md] = await bucket.file(`drafts/${RID}/${r.body.pid}-${kind}.webp`).getMetadata();
      assert.strictEqual(md.contentType, 'image/webp', `PHOTO-EMU-UPLOAD-DELETED ${kind} webp`);
      assert.strictEqual(md.cacheControl, 'private, max-age=0, no-store', `PHOTO-EMU-UPLOAD-DELETED ${kind} private no-store`);
    }
    const reg = (await db.doc(`photo_registry/${RID}/pids/${r.body.pid}`).get()).data();
    assert.strictEqual(reg && reg.state, 'draft', 'PHOTO-EMU-UPLOAD-DELETED the registry pid is draft');
    ok('E8 PHOTO-EMU-UPLOAD-DELETED: commit → the upload object removed; the card + hero drafts exist (webp, private no-store); registry draft');
  }

  FINISHED = true; clearTimeout(WATCHDOG);
  console.log(`photos(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('photos(emulator): FAILED —', e && e.stack || e); process.exit(1); });
