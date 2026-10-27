'use strict';
// DISH PHOTOS A1 step 5 (PLAN-dish-photos r2 §2.2 E-P2, §2.6 reuse / deleting) — photoProcess's CORE over the in-repo Firestore double,
// an in-memory object store with GENERATIONS, and (mostly) a counting stand-in pipeline; one cell runs the REAL pipeline end to end.
// Concurrency (two simultaneous claims) is emulator-only (the double models no isolation). Run: node photos/process.test.js
const assert = require('assert');
const sharp = require('sharp');
const { makeDb } = require('../catalog/firestore-fake');
const { photoProcessCore, LEASE_MS, MAX_ATTEMPTS } = require('./process');
const { photoError } = require('./errors');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const WATCHDOG = setTimeout(() => { console.error('process: FAILED — watchdog (120 s)'); process.kill(process.pid, 'SIGKILL'); }, 120000); WATCHDOG.unref();
const T0 = Date.UTC(2026, 9, 27, 18, 0, 0);
const CROPS = { card: { x: 0, y: 0, w: 800, h: 600 }, hero: { x: 0, y: 0, w: 960, h: 600 } };

function makeStorage() {
  const objects = new Map(); let gen = 100; const failures = [];
  return {
    objects, failNext: (op, err) => failures.push({ op, err }),
    hit(op) { const i = failures.findIndex((f) => f.op === op); if (i >= 0) { const f = failures.splice(i, 1)[0]; throw f.err; } },
    put(path, buf) { objects.set(path, { buf, generation: String(++gen) }); },
    async metadata(path) { this.hit('metadata'); const o = objects.get(path); return o ? { generation: o.generation, size: o.buf.length } : null; },
    async download(path, { generation, maxBytes }) {
      this.hit('download');
      const o = objects.get(path);
      if (!o || o.generation !== generation) { const e = new Error('generation mismatch'); e.code = 'generation_mismatch'; throw e; }
      if (o.buf.length > maxBytes) { const e = new Error('over cap'); e.code = 'too_large'; throw e; }
      return o.buf;
    },
    async createIfAbsent(path, buf) { this.hit('create'); const o = objects.get(path); if (o) return { generation: o.generation, created: false }; this.put(path, buf); return { generation: objects.get(path).generation, created: true }; },
    async remove(path) { objects.delete(path); },
  };
}
function harness(over = {}) {
  const db = makeDb(); const storage = makeStorage(); let now = T0; let claims = 0; let decodes = 0;
  const deps = {
    db, storage, now: () => now, newClaimId: () => `c${++claims}`, photosEnabled: () => true, authorize: async () => ({ ok: true }),
    signRead: async (path, exp) => `https://read.example/${path}?e=${exp}`,
    processImage: async (buf, crops) => { decodes += 1; return { card: Buffer.from(`CARD:${buf.length}:${crops.card.x}`), hero: Buffer.from(`HERO:${buf.length}:${crops.hero.x}`), pid: `p${buf.length}x${crops.card.x}`.padEnd(32, '0') }; },
    ...over,
  };
  return { db, storage, deps, advance: (ms) => { now += ms; }, decodes: () => decodes };
}
async function seedUpload(h, { uploadId = 'up0000000001', rid = 'tb_r1', uid = 'u1', bytes = 4096, put = true, ...rest } = {}) {
  await h.db.collection('photo_uploads').doc(uploadId).set({ rid, uid, op_id: 'op_x', contentType: 'image/jpeg', bytes, state: 'issued', attempts: 0, created_at: T0, ...rest });
  if (put) h.storage.put(`uploads/${rid}/${uploadId}`, Buffer.alloc(bytes, 7));
}
const REQ = { uid: 'u1', rid: 'tb_r1', uploadId: 'up0000000001', crops: CROPS };
const up = async (h, id = 'up0000000001') => (await h.db.collection('photo_uploads').doc(id).get()).data();
const reg = async (h, pid, rid = 'tb_r1') => { const s = await h.db.collection('photo_registry').doc(rid).collection('pids').doc(pid).get(); return s.exists ? s.data() : null; };

(async () => {
  assert.deepStrictEqual([LEASE_MS, MAX_ATTEMPTS], [90000, 3], 'PROC-CONSTANTS');

  // ── the happy path ──
  {
    const h = harness(); await seedUpload(h);
    const r = await photoProcessCore(h.deps, REQ);
    assert.strictEqual(r.status, 200, `PROC-200 ${JSON.stringify(r)}`);
    const pid = r.body.pid;
    assert.deepStrictEqual(r.body.preview, { card: `https://read.example/drafts/tb_r1/${pid}-card.webp?e=${T0 + 3600000}`, hero: `https://read.example/drafts/tb_r1/${pid}-hero.webp?e=${T0 + 3600000}`, expiresAt: T0 + 3600000 }, 'PROC-PREVIEW-SIGNED-1H');
    const u = await up(h); assert.deepStrictEqual([u.state, u.result, u.claim], ['done', { pid }, undefined], 'PROC-UPLOAD-DONE');
    const g = await reg(h, pid);
    assert.deepStrictEqual({ state: g.state, gens: Object.keys(g.generations).sort(), last_ref_at: g.last_ref_at }, { state: 'draft', gens: ['draft_card', 'draft_hero'], last_ref_at: T0 }, 'PROC-REGISTRY-CREATED-DRAFT');
    assert.ok(h.storage.objects.has(`drafts/tb_r1/${pid}-card.webp`) && h.storage.objects.has(`drafts/tb_r1/${pid}-hero.webp`), 'PROC-DRAFT-OBJECTS');
    assert.ok(!h.storage.objects.has('uploads/tb_r1/up0000000001'), 'PROC-UPLOAD-OBJECT-DELETED-AFTER-COMMIT');
    ok('upload → draft objects + registry {state:draft, draft generations, last_ref_at} + upload doc done {pid}; signed 1 h previews; the upload object removed after commit');
  }

  // ── idempotency + claim rules ──
  {
    const h = harness(); await seedUpload(h);
    const a = await photoProcessCore(h.deps, REQ);
    const b = await photoProcessCore(h.deps, REQ);
    assert.deepStrictEqual([b.status, b.body.pid, h.decodes()], [200, a.body.pid, 1], 'PROC-DONE-RETRY-RETURNS-STORED (no re-decode)');
    const c = await photoProcessCore(h.deps, { ...REQ, crops: { ...CROPS, card: { x: 8, y: 0, w: 800, h: 600 } } });
    assert.deepStrictEqual([c.status, c.body], [409, { error: 'op_conflict' }], 'PROC-DONE-DIFFERENT-CROPS-CONFLICT');
    for (const [label, over] of [['other uid', { uid: 'u2' }], ['other rid', { rid: 'tb_r2' }]]) {
      const x = await photoProcessCore(h.deps, { ...REQ, ...over });
      assert.deepStrictEqual([x.status, x.body], [403, { error: 'not_authorized' }], `PROC-CROSS-TENANT ${label}`);
    }
    const h2 = harness(); await seedUpload(h2, { state: 'processing', claim: { id: 'other', lease_until: T0 + 30000, crops_hash: 'x' }, attempts: 1 });
    const live = await photoProcessCore(h2.deps, REQ);
    assert.deepStrictEqual([live.status, live.body, h2.decodes()], [409, { error: 'in_progress', retryable: true }, 0], 'PROC-LIVE-LEASE-IN-PROGRESS');
    h2.advance(31000);
    const taken = await photoProcessCore(h2.deps, REQ);
    assert.strictEqual(taken.status, 200, 'PROC-EXPIRED-LEASE-TAKEN-OVER');
    assert.strictEqual((await up(h2)).attempts, 2, 'PROC-ATTEMPTS-COUNTED');
    const h3 = harness();
    const missing = await photoProcessCore(h3.deps, REQ);
    assert.deepStrictEqual([missing.status, missing.body], [404, { error: 'upload_missing' }], 'PROC-NO-UPLOAD-DOC');
    ok('done retry → stored pid (no re-decode); new crops → op_conflict; another uid / rid → 403; a live lease → in_progress; an expired lease is taken over (attempts+1)');
  }

  // ── terminal outcomes (stored; a retry never re-decodes) ──
  {
    const cases = [
      ['upload object absent', async (h) => seedUpload(h, { put: false }), 'upload_missing', 404],
      ['metadata size > 10 MB', async (h) => { await seedUpload(h, { put: false }); h.storage.put('uploads/tb_r1/up0000000001', Buffer.alloc(10485761)); }, 'too_large', 400],
      ['stream over the cap', async (h) => { await seedUpload(h); h.storage.failNext('download', Object.assign(new Error('cap'), { code: 'too_large' })); }, 'too_large', 400],
      ['object replaced after the metadata read', async (h) => { await seedUpload(h); h.storage.failNext('download', Object.assign(new Error('gen'), { code: 'generation_mismatch' })); }, 'upload_missing', 404],
      ['pipeline bad_type', async (h) => { await seedUpload(h); h.deps.processImage = async () => { throw photoError('bad_type', 'x'); }; }, 'bad_type', 400],
      ['pipeline too_small', async (h) => { await seedUpload(h); h.deps.processImage = async () => { throw photoError('too_small', 'x'); }; }, 'too_small', 400],
      ['pipeline bad_crop', async (h) => { await seedUpload(h); h.deps.processImage = async () => { throw photoError('bad_crop', 'x'); }; }, 'bad_crop', 400],
    ];
    for (const [label, setup, code, status] of cases) {
      const h = harness(); await setup(h);
      const r = await photoProcessCore(h.deps, REQ);
      assert.deepStrictEqual([r.status, r.body], [status, { error: code }], `PROC-TERMINAL ${label}`);
      const u = await up(h); assert.deepStrictEqual([u.state, u.code, u.claim], ['failed', code, undefined], `PROC-TERMINAL-STORED ${label}`);
      const before = h.decodes(); const again = await photoProcessCore(h.deps, REQ);
      assert.deepStrictEqual([again.body, h.decodes()], [{ error: code }, before], `PROC-TERMINAL-NO-REDECODE ${label}`);
    }
    ok('terminal: upload_missing (absent / replaced), too_large (metadata / stream), bad_type / too_small / bad_crop — stored on the doc; a retry answers the same code without decoding');
  }

  // ── transient failures: lease released, attempts kept; the 3rd → terminal unavailable ──
  {
    const h = harness(); await seedUpload(h);
    for (let i = 1; i <= 2; i++) {
      h.storage.failNext('download', new Error('ECONNRESET'));
      const r = await photoProcessCore(h.deps, REQ);
      assert.deepStrictEqual([r.status, r.body], [503, { error: 'unavailable', retryable: true }], `PROC-TRANSIENT-${i}`);
      const u = await up(h); assert.deepStrictEqual([u.state, u.claim, u.attempts], ['issued', undefined, i], `PROC-TRANSIENT-LEASE-RELEASED ${i}`);
    }
    h.storage.failNext('download', new Error('ECONNRESET'));
    const third = await photoProcessCore(h.deps, REQ);
    assert.deepStrictEqual([third.status, third.body], [503, { error: 'unavailable', retryable: true }], 'PROC-TRANSIENT-3');
    const u = await up(h); assert.deepStrictEqual([u.state, u.code], ['failed', 'unavailable'], 'PROC-THIRD-TRANSIENT-TERMINAL');
    const after = await photoProcessCore(h.deps, REQ);
    assert.deepStrictEqual(after.body, { error: 'unavailable', retryable: true }, 'PROC-TERMINAL-UNAVAILABLE-STAYS');
    ok('transient: 503 retryable, lease released, attempts kept; the 3rd failure is terminal `unavailable` (state failed)');
  }

  // ── crash after the objects, before the completion transaction → the retry completes with the same pid ──
  {
    const h = harness(); await seedUpload(h);
    const realTx = h.db.runTransaction.bind(h.db); let calls = 0;
    h.deps.db = { ...h.db, collection: h.db.collection, runTransaction: async (fn) => { calls += 1; if (calls === 2) throw new Error('crash before completion'); return realTx(fn); } };
    const r1 = await photoProcessCore(h.deps, REQ);
    assert.strictEqual(r1.status, 503, 'PROC-CRASH-BEFORE-COMPLETION-503');
    const pid = `p4096x0`.padEnd(32, '0');
    assert.ok(h.storage.objects.has(`drafts/tb_r1/${pid}-card.webp`), 'premise: the draft objects were written');
    const r2 = await photoProcessCore(h.deps, REQ);
    assert.deepStrictEqual([r2.status, r2.body.pid], [200, pid], 'PROC-RETRY-COMPLETES-SAME-PID');
    assert.strictEqual((await reg(h, pid)).state, 'draft', 'PROC-RETRY-REGISTRY');
    ok('a crash between the objects and the completion transaction: the retry completes (objects already exist → same generations, same pid)');
  }

  // ── registry rules: published never reset; deleted → draft (reuse); deleting → in_progress, then take-over after lease + 60 s ──
  {
    const pid = `p4096x0`.padEnd(32, '0');
    const regRef = (h) => h.db.collection('photo_registry').doc('tb_r1').collection('pids').doc(pid);
    const h1 = harness(); await seedUpload(h1); await regRef(h1).set({ state: 'published', last_ref_at: 1, generations: { pub_card: '9', pub_hero: '9' }, created_at: 1 });
    await photoProcessCore(h1.deps, REQ);
    assert.strictEqual((await reg(h1, pid)).state, 'published', 'PROC-PUBLISHED-NEVER-RESET');
    const h2 = harness(); await seedUpload(h2); await regRef(h2).set({ state: 'deleted', last_ref_at: 1, generations: { draft_card: '1', draft_hero: '1' }, created_at: 1 });
    await photoProcessCore(h2.deps, REQ);
    const g2 = await reg(h2, pid);
    assert.ok(g2.state === 'draft' && g2.generations.draft_card !== '1', `PROC-DELETED-TO-DRAFT-REUSE ${JSON.stringify(g2)}`);
    const h3 = harness(); await seedUpload(h3); await regRef(h3).set({ state: 'deleting', claim: { id: 'sweep1', lease_until: T0 + 120000 }, last_ref_at: 1, generations: {}, created_at: 1 });
    const busy = await photoProcessCore(h3.deps, REQ);
    assert.deepStrictEqual([busy.status, busy.body], [409, { error: 'in_progress', retryable: true }], 'PROC-DELETING-LIVE-IN-PROGRESS');
    assert.deepStrictEqual([(await up(h3)).state, (await up(h3)).claim], ['issued', undefined], 'PROC-DELETING-RELEASES-UPLOAD-LEASE');
    h3.advance(120000 + 60000 + 1);
    const took = await photoProcessCore(h3.deps, REQ);
    const g3 = await reg(h3, pid);
    assert.deepStrictEqual([took.status, g3.state, g3.claim], [200, 'draft', undefined], 'PROC-DELETING-EXPIRED-TAKEN-OVER');
    ok('registry: published stays published; deleted → draft with fresh generations (reuse); deleting with a live lease → in_progress (upload lease released); after lease + 60 s → take-over to draft');
  }

  // ── the flag, authorization, input shape ──
  {
    const h = harness({ photosEnabled: () => false }); await seedUpload(h);
    assert.deepStrictEqual((await photoProcessCore(h.deps, REQ)).body, { error: 'photos_disabled' }, 'PROC-FLAG-OFF');
    const h2 = harness({ authorize: async () => ({ ok: false, code: 'not_authorized' }) }); await seedUpload(h2);
    assert.deepStrictEqual((await photoProcessCore(h2.deps, REQ)).body, { error: 'not_authorized' }, 'PROC-UNAUTHORIZED');
    const h3 = harness(); await seedUpload(h3);
    for (const [label, over] of [['uploadId path', { uploadId: 'a/b' }], ['crops missing', { crops: null }], ['bad rid', { rid: '..' }]])
      assert.deepStrictEqual((await photoProcessCore(h3.deps, { ...REQ, ...over })).body, { error: 'bad_request' }, `PROC-BAD-REQUEST ${label}`);
    assert.strictEqual(h.decodes() + h2.decodes() + h3.decodes(), 0, 'PROC-REFUSALS-NEVER-DECODE');
    ok('flag off → photos_disabled; unauthorized → 403; malformed → bad_request; none of them decodes');
  }

  // ── one REAL end-to-end cell: a real JPEG through the real pipeline ──
  {
    const { processImage } = require('./pipeline');
    const h = harness({ processImage });
    const jpg = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#a33' } }).jpeg().toBuffer();
    await seedUpload(h, { put: false, bytes: jpg.length }); h.storage.put('uploads/tb_r1/up0000000001', jpg);
    const r = await photoProcessCore(h.deps, REQ);
    assert.strictEqual(r.status, 200, `PROC-REAL-PIPELINE ${JSON.stringify(r)}`);
    const card = h.storage.objects.get(`drafts/tb_r1/${r.body.pid}-card.webp`).buf;
    const m = await sharp(card).metadata();
    assert.deepStrictEqual([m.format, m.width, m.height], ['webp', 800, 600], 'PROC-REAL-CARD-WEBP');
    ok('end to end with the REAL pipeline: a real JPEG → a real 800×600 WEBP draft object under its content-id pid');
  }

  console.log(`process: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('process: FAILED —', e && e.stack || e); process.exit(1); });
