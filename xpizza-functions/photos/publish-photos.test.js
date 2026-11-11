'use strict';
// DISH PHOTOS A2 step 10 (PLAN-dish-photos r2 §2.5, §2.6 publish) — photos/publish-photos.js over the in-repo Firestore double and an
// in-memory object store with generations. Run: node photos/publish-photos.test.js
//   prepare(rid, map)  registry check (draft|published, else photo_unavailable); COPY each not-yet-published pid's card + hero
//                      drafts → the PUBLIC bucket, create-only (exists = success; card and hero independently, a partial pair completes on
//                      retry); any copy failure / no public bucket → photo_publish_failed (the pointer is never touched); → the version doc
//   commit(db,rid,vid) ONE transaction BEFORE the flip: re-read every pid (still draft|published, else photo_unavailable), CREATE
//                      versions/{vid}/meta/photos, bump last_ref_at (+ record the public generations) — a sweeper claim and a publish
//                      serialize on the registry docs, exactly one wins
//   markPublished      after the flip: draft → published (never touches deleting/deleted); best effort, repaired by the sweeper
const assert = require('assert');
const { makeDb } = require('../catalog/firestore-fake');
const { makePublishPhotos } = require('./publish-photos');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'tb_r1', T = Date.UTC(2026, 9, 31, 12), PUB = 'tb-public';
const P1 = '1'.repeat(32), P2 = '2'.repeat(32), P3 = '3'.repeat(32);

function store() {
  const objs = new Map(); let gen = 500; const fail = new Set(); const copies = [];
  return { objs, fail, copies, put: (b, p) => objs.set(`${b}/${p}`, String(++gen)),
    async copyIfAbsent(srcPath, dstBucket, dstPath) {
      copies.push(dstPath);
      if (fail.has(dstPath)) throw new Error('gcs 503');
      if (!objs.has(`default/${srcPath}`)) throw Object.assign(new Error('gone'), { code: 404 });
      const k = `${dstBucket}/${dstPath}`;
      if (objs.has(k)) return { generation: objs.get(k), created: false };
      objs.set(k, String(++gen)); return { generation: objs.get(k), created: true };
    } };
}
const reg = (fs, pid) => fs.collection('photo_registry').doc(RID).collection('pids').doc(pid);
const meta = (fs, vid) => fs.collection('restaurants').doc(RID).collection('versions').doc(vid).collection('meta').doc('photos');

(async () => {
  // ── 1. prepare: copies only not-yet-published pids, create-only; builds the version doc with public URLs ──
  {
    const fs = makeDb(); const s = store();
    await reg(fs, P1).set({ state: 'draft', last_ref_at: 1 }); await reg(fs, P2).set({ state: 'published', last_ref_at: 2 });
    for (const p of [P1, P2]) for (const k of ['card', 'hero']) s.put('default', `drafts/${RID}/${p}-${k}.webp`);
    const pp = makePublishPhotos({ fs, store: s, publicBucket: () => PUB, now: () => T });
    const map = { tb_a: { state: 'pid', pid: P1 }, tb_b: { state: 'pid', pid: P2 }, tb_c: { state: 'removed' } };
    const prep = await pp.prepare(RID, map);
    assert.deepStrictEqual(s.copies.sort(), [`photos/${RID}/${P1}-card.webp`, `photos/${RID}/${P1}-hero.webp`], 'PUB-COPIES-ONLY-UNPUBLISHED');
    const url = (p, k) => `https://storage.googleapis.com/${PUB}/photos/${RID}/${p}-${k}.webp`;
    assert.deepStrictEqual(prep.doc, { schema: 1, entries: { tb_a: { state: 'pid', pid: P1, card: url(P1, 'card'), hero: url(P1, 'hero') }, tb_b: { state: 'pid', pid: P2, card: url(P2, 'card'), hero: url(P2, 'hero') }, tb_c: { state: 'removed' } } }, 'PUB-VERSION-DOC');
    assert.deepStrictEqual(prep.pids, [P1, P2], 'PUB-PIDS');
    // a retry after a partial pair: the existing card is success, only the hero is created
    const s2 = store(); for (const k of ['card', 'hero']) s2.put('default', `drafts/${RID}/${P1}-${k}.webp`);
    s2.put(PUB, `photos/${RID}/${P1}-card.webp`);
    await makePublishPhotos({ fs, store: s2, publicBucket: () => PUB, now: () => T }).prepare(RID, { tb_a: { state: 'pid', pid: P1 } });
    assert.ok(s2.objs.has(`${PUB}/photos/${RID}/${P1}-hero.webp`), 'PUB-PARTIAL-PAIR-COMPLETED');
    ok('prepare: copies card + hero of not-yet-published pids create-only (published skipped; a partial pair completes on retry); the version doc carries public URLs');
  }
  // ── 2. prepare refusals: fail closed, nothing for the pointer ──
  {
    const fs = makeDb(); const s = store();
    await reg(fs, P1).set({ state: 'draft' }); await reg(fs, P3).set({ state: 'deleting' });
    for (const k of ['card', 'hero']) s.put('default', `drafts/${RID}/${P1}-${k}.webp`);
    const mk = (over = {}) => makePublishPhotos({ fs, store: s, publicBucket: () => PUB, now: () => T, ...over });
    await assert.rejects(() => mk().prepare(RID, { tb_a: { state: 'pid', pid: P3 } }), (e) => e.code === 'photo_unavailable', 'PUB-DELETING-REFUSED');
    { // no public bucket → fails closed BEFORE any photo write: the code, ZERO copies and an UNCHANGED registry doc, all in ONE named assert
      const copiesBefore = s.copies.length; const regBefore = JSON.stringify((await reg(fs, P1).get()).data());
      let code = null; try { await mk({ publicBucket: () => '' }).prepare(RID, { tb_a: { state: 'pid', pid: P1 } }); } catch (e) { code = e.code; }
      const after = { code, copies: s.copies.length - copiesBefore, registry: JSON.stringify((await reg(fs, P1).get()).data()) };
      assert.deepStrictEqual(after, { code: 'photo_publish_failed', copies: 0, registry: regBefore }, `PUB-NO-BUCKET-FAILS-CLOSED (no copy, no registry write) ${JSON.stringify(after)}`);
    }
    s.fail.add(`photos/${RID}/${P1}-hero.webp`);
    await assert.rejects(() => mk().prepare(RID, { tb_a: { state: 'pid', pid: P1 } }), (e) => e.code === 'photo_publish_failed', 'PUB-COPY-FAILURE-FAILS-CLOSED');
    // codex r1 P2-4: the card copy that DID succeed is recorded at once, so an abandoned change leaves nothing the sweeper cannot remove
    const g = (await reg(fs, P1).get()).data().generations || {};
    assert.ok(g.pub_card && !g.pub_hero, `PUB-PARTIAL-COPY-GENERATION-PERSISTED ${JSON.stringify(g)}`);
    assert.strictEqual(await mk({ publicBucket: () => '' }).prepare(RID, { tb_c: { state: 'removed' } }).then((p) => p.doc.entries.tb_c.state), 'removed', 'PUB-REMOVED-ONLY-NEEDS-NO-BUCKET');
    assert.strictEqual(await mk().prepare(RID, null), null, 'PUB-NO-MAP-NULL');
    ok('prepare: a deleting pid → photo_unavailable; no public bucket or a copy failure → photo_publish_failed; a removed-only map needs no bucket; no map → null');
  }
  // ── 3. commit: ONE transaction — meta/photos created + last_ref_at bumped; a pid gone deleting meanwhile → nothing written ──
  {
    const fs = makeDb(); const s = store();
    await reg(fs, P1).set({ state: 'draft', last_ref_at: 1 });
    for (const k of ['card', 'hero']) s.put('default', `drafts/${RID}/${P1}-${k}.webp`);
    const pp = makePublishPhotos({ fs, store: s, publicBucket: () => PUB, now: () => T });
    const prep = await pp.prepare(RID, { tb_a: { state: 'pid', pid: P1 } });
    await pp.hook(prep).commit(fs, RID, 'v9');
    assert.deepStrictEqual((await meta(fs, 'v9').get()).data(), prep.doc, 'PUB-META-CREATED');
    const r = (await reg(fs, P1).get()).data();
    assert.strictEqual(r.last_ref_at, T, 'PUB-LAST-REF-BUMPED');
    assert.ok(r.generations && r.generations.pub_card && r.generations.pub_hero, 'PUB-GENERATIONS-RECORDED');
    const prep2 = await pp.prepare(RID, { tb_a: { state: 'pid', pid: P1 } });
    await reg(fs, P1).set({ state: 'deleting', last_ref_at: 1, claim: { id: 'sweep1' } });
    await assert.rejects(() => pp.hook(prep2).commit(fs, RID, 'v10'), (e) => e.code === 'photo_unavailable', 'PUB-COMMIT-LOSES-TO-SWEEPER');
    assert.strictEqual((await meta(fs, 'v10').get()).exists, false, 'PUB-COMMIT-NOTHING-WRITTEN');
    assert.strictEqual((await reg(fs, P1).get()).data().state, 'deleting', 'PUB-COMMIT-SWEEPER-CLAIM-INTACT');
    assert.strictEqual(pp.hook(null), null, 'PUB-NO-HOOK-WITHOUT-PHOTOS');
    ok('commit: meta/photos + last_ref_at (+ public generations) in ONE transaction before the flip; a pid claimed by the sweeper meanwhile → photo_unavailable, nothing written');
  }
  // ── 4. markPublished: draft → published only ──
  {
    const fs = makeDb();
    await reg(fs, P1).set({ state: 'draft' }); await reg(fs, P2).set({ state: 'deleting' }); await reg(fs, P3).set({ state: 'published' });
    const pp = makePublishPhotos({ fs, store: store(), publicBucket: () => PUB, now: () => T });
    await pp.markPublished(RID, [P1, P2, P3, '9'.repeat(32)]);
    assert.deepStrictEqual(await Promise.all([P1, P2, P3].map(async (p) => (await reg(fs, p).get()).data().state)), ['published', 'deleting', 'published'], 'PUB-MARK-PUBLISHED');
    ok('markPublished: draft → published; deleting / published / missing untouched');
  }

  // ── codex r2 (r1 #4): a copy that SUCCEEDS then fails to be recorded is still found — the intent record (pending_public) is durable
  //    BEFORE the copy, so an abandoned publish + a later sweep leaves ZERO public objects ──
  {
    const S = require('./sweep-core');
    const fs = makeDb(); const s = store();
    for (const k of ['card', 'hero']) s.put('default', `drafts/${RID}/${P1}-${k}.webp`);
    const dg = { draft_card: s.objs.get(`default/drafts/${RID}/${P1}-card.webp`), draft_hero: s.objs.get(`default/drafts/${RID}/${P1}-hero.webp`) };
    await reg(fs, P1).set({ state: 'draft', last_ref_at: 1, generations: dg, created_at: 1 });
    const realTx = fs.runTransaction.bind(fs); let thrown = false;
    const flaky = { ...fs, collection: fs.collection, runTransaction: async (fn) => {
      if (!thrown && s.objs.has(`${PUB}/photos/${RID}/${P1}-card.webp`)) { thrown = true; throw new Error('firestore down after the copy'); }
      return realTx(fn); } };
    await assert.rejects(() => makePublishPhotos({ fs: flaky, store: s, publicBucket: () => PUB, now: () => T }).prepare(RID, { tb_a: { state: 'pid', pid: P1 } }),
      (e) => e.code === 'photo_publish_failed', 'premise: the publish failed after its copy');
    assert.ok(thrown && s.objs.has(`${PUB}/photos/${RID}/${P1}-card.webp`), 'premise: the public card exists, its generation unrecorded');
    const deleter = (b) => ({
      async deleteIfGeneration(path, gen) { const k = `${b}/${path}`; const g = s.objs.get(k); if (g === undefined) return 'missing'; if (g !== String(gen)) return 'other_generation'; s.objs.delete(k); return 'deleted'; },
      async deleteAny(path) { return s.objs.delete(`${b}/${path}`) ? 'deleted' : 'missing'; } });
    const sw = await S.sweepRid({ fs, priv: deleter('default'), pub: deleter(PUB), now: () => T + 8 * 86400e3, newClaimId: () => 'swA', log: { info: () => {}, warn: () => {} }, mode: 'live', activeVersionId: async () => null }, RID);
    assert.deepStrictEqual(sw.deleted, [P1], 'premise: the sweeper took the abandoned pid');
    const left = [...s.objs.keys()].filter((k) => k.startsWith(`${PUB}/`));
    assert.deepStrictEqual(left, [], `PUB-ABANDONED-COPY-SWEPT (public objects left: ${left.join(', ')})`);
    assert.deepStrictEqual([...s.objs.keys()].filter((k) => k.startsWith('default/drafts/')), [], 'PUB-ABANDONED-DRAFTS-SWEPT');
    ok('codex r2 (r1 #4): copy ok → registry write throws → publish abandoned → the sweep leaves zero public objects (pending_public intent record)');
  }
  console.log(`publish-photos: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('publish-photos: FAILED —', e && e.stack || e); process.exit(1); });
