'use strict';
// DISH PHOTOS A2 step 13 (PLAN-dish-photos r2 §2.6 sweep + Codex r2 P2-2 resumable claims) — photos/sweep-core.js over the in-repo Firestore
// double and two in-memory object stores with generations. Run: node photos/sweep-core.test.js
const assert = require('assert');
const { makeDb } = require('../catalog/firestore-fake');
const S = require('./sweep-core');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RID = 'tb_r1', DAY = 86400e3, T = Date.UTC(2026, 9, 31, 12);
const P_OLD = 'a'.repeat(32), P_REF = 'b'.repeat(32), P_NEW = 'c'.repeat(32), P_PUB = 'd'.repeat(32), P_RB = 'e'.repeat(32), P_PUBOLD = 'f'.repeat(32);

function objStore() {
  const objs = new Map(); const deletes = [];
  return { objs, deletes,
    async deleteIfGeneration(path, gen) { deletes.push(path); const g = objs.get(path); if (g === undefined) return 'missing'; if (g !== String(gen)) return 'other_generation'; objs.delete(path); return 'deleted'; } };
}
async function world() {
  const fs = makeDb(); const priv = objStore(); const pub = objStore();
  const reg = (pid) => fs.collection('photo_registry').doc(RID).collection('pids').doc(pid);
  const put = async (pid, state, lastRef, extra = {}) => {
    await reg(pid).set({ state, last_ref_at: lastRef, generations: { draft_card: '11', draft_hero: '12', ...(state === 'published' ? { pub_card: '21', pub_hero: '22' } : {}) }, created_at: 1, ...extra });
    priv.objs.set(`drafts/${RID}/${pid}-card.webp`, '11'); priv.objs.set(`drafts/${RID}/${pid}-hero.webp`, '12');
    if (state === 'published') { pub.objs.set(`photos/${RID}/${pid}-card.webp`, '21'); pub.objs.set(`photos/${RID}/${pid}-hero.webp`, '22'); }
  };
  await put(P_OLD, 'draft', T - 8 * DAY);            // unreferenced draft past 7 d → swept
  await put(P_REF, 'draft', T - 30 * DAY);           // referenced by the DRAFT map → kept
  await put(P_NEW, 'draft', T - 2 * DAY);            // unreferenced but inside the 7 d grace → kept
  await put(P_PUB, 'published', T - 10 * DAY);       // unreferenced published inside 30 d → kept
  await put(P_RB, 'published', T - 90 * DAY);        // referenced by an OLD retained version (rollback) → kept
  await put(P_PUBOLD, 'published', T - 31 * DAY);    // unreferenced published past 30 d → swept (both buckets)
  await fs.collection('restaurants').doc(RID).collection('meta').doc('source').set({ items: [], photos: { tb_k: { state: 'pid', pid: P_REF } } });
  for (const [vid, entries] of [['v-old', { tb_k: { state: 'pid', pid: P_RB, card: 'c', hero: 'h' } }], ['v-active', { tb_j: { state: 'removed' } }]]) {
    await fs.collection('restaurants').doc(RID).collection('versions').doc(vid).set({ created: 1 });
    await fs.collection('restaurants').doc(RID).collection('versions').doc(vid).collection('meta').doc('photos').set({ schema: 1, entries });
  }
  await fs.collection('restaurants').doc(RID).collection('meta').doc('active_version').set({ version: 'v-active', generation: 1 });
  let ids = 0; let now = T;
  const deps = { fs, priv, pub, now: () => now, newClaimId: () => `sw${++ids}`, log: { info: () => {}, warn: () => {} }, activeVersionId: async () => 'v-active' };
  return { fs, priv, pub, reg, deps, setNow: (t) => { now = t; } };
}
const state = async (w, pid) => (await w.reg(pid).get()).data();

(async () => {
  // ── 1. references: the draft map ∪ meta/photos of EVERY retained version; any read failure aborts ──
  {
    const w = await world();
    const refs = await S.scanReferences(w.deps, RID);
    assert.deepStrictEqual([...refs].sort(), [P_REF, P_RB].sort(), 'SWEEP-REFS');
    const broken = { ...w.deps, fs: { collection: (c) => (c === 'restaurants' ? { doc: () => ({ collection: (c2) => (c2 === 'versions' ? { get: async () => { throw new Error('down'); } } : w.fs.collection('restaurants').doc(RID).collection(c2)) }) } : w.fs.collection(c)) } };
    await assert.rejects(() => S.scanReferences(broken, RID), /scan_incomplete/, 'SWEEP-SCAN-FAILURE-ABORTS');
    const r = await S.sweepRid({ ...w.deps, fs: broken.fs, mode: 'live' }, RID);
    assert.strictEqual(r.aborted, 'scan_incomplete', 'SWEEP-SCAN-FAILURE-RUN-ABORTED');
    assert.deepStrictEqual([r.deleted, w.priv.deletes, w.pub.deletes, (await state(w, P_OLD)).state], [[], [], [], 'draft'], 'SWEEP-SCAN-FAILURE-NOTHING-DELETED');
    ok('scan: the draft map ∪ meta/photos of every retained version (a rolled-back-to version keeps its pid); a read failure → scan_incomplete');
  }
  // ── 2. a LIVE run: only the expired, unreferenced pids are deleted (generation-matched, both buckets) and marked deleted ──
  {
    const w = await world();
    const r = await S.sweepRid({ ...w.deps, mode: 'live' }, RID);
    assert.deepStrictEqual(r.deleted.sort(), [P_OLD, P_PUBOLD].sort(), 'SWEEP-DELETED');
    for (const p of [P_OLD, P_PUBOLD]) assert.strictEqual((await state(w, p)).state, 'deleted', `SWEEP-MARKED ${p}`);
    for (const p of [P_REF, P_NEW, P_PUB, P_RB]) assert.ok(['draft', 'published'].includes((await state(w, p)).state), `SWEEP-KEPT ${p}`);
    assert.ok(!w.priv.objs.has(`drafts/${RID}/${P_OLD}-card.webp`) && !w.pub.objs.has(`photos/${RID}/${P_PUBOLD}-hero.webp`), 'SWEEP-OBJECTS-GONE');
    assert.ok(w.pub.objs.has(`photos/${RID}/${P_RB}-card.webp`), 'SWEEP-ROLLBACK-REFERENCE-PROTECTS');
    ok('live: unreferenced draft past 7 d + published past 30 d deleted in both buckets → deleted; referenced (draft / any retained version) and in-grace kept');
  }
  // ── 3. dry_run and off write nothing ──
  {
    const w = await world();
    const before = JSON.stringify([...w.fs._raw]);
    const r = await S.sweepRid({ ...w.deps, mode: 'dry_run' }, RID);
    assert.deepStrictEqual(r.would_delete.sort(), [P_OLD, P_PUBOLD].sort(), 'SWEEP-DRY-REPORTS');
    assert.strictEqual(JSON.stringify([...w.fs._raw]), before, 'SWEEP-DRY-NO-FIRESTORE-WRITE');
    assert.deepStrictEqual([w.priv.deletes, w.pub.deletes], [[], []], 'SWEEP-DRY-NO-DELETE');
    const off = await S.sweepRid({ ...w.deps, mode: 'off' }, RID);
    assert.deepStrictEqual(off, { rid: RID, mode: 'off' }, 'SWEEP-OFF-NOTHING');
    ok('dry_run reports the candidates and writes / deletes nothing; off does nothing');
  }
  // ── 4. the claim: an attach between scan and claim (last_ref_at changed) → skipped; a re-created object survives ──
  {
    const w = await world();
    const cand = { pid: P_OLD, last_ref_at: (await state(w, P_OLD)).last_ref_at };
    await w.reg(P_OLD).set({ ...(await state(w, P_OLD)), last_ref_at: T });   // an editCatalog attach landed
    assert.strictEqual(await S.claim(w.deps, RID, cand), null, 'SWEEP-ATTACH-WINS');
    assert.strictEqual((await state(w, P_OLD)).state, 'draft', 'SWEEP-ATTACH-KEPT');
    const w2 = await world();
    w2.priv.objs.set(`drafts/${RID}/${P_OLD}-card.webp`, '99');   // re-created since (another generation)
    await S.sweepRid({ ...w2.deps, mode: 'live' }, RID);
    assert.strictEqual(w2.priv.objs.get(`drafts/${RID}/${P_OLD}-card.webp`), '99', 'SWEEP-RECREATED-OBJECT-SURVIVES');
    assert.strictEqual((await state(w2, P_OLD)).state, 'deleted', 'SWEEP-OTHER-GENERATION-COUNTS-AS-DONE');
    ok('claim: a changed last_ref_at (an attach / publish in between) → skipped; an object at another generation is never deleted and counts as done');
  }
  // ── 5. crash recovery: claimed-then-crashed → after lease + 60 s the next run takes over and finishes; before that, nothing ──
  {
    const w = await world();
    const c = await S.claim(w.deps, RID, { pid: P_OLD, last_ref_at: (await state(w, P_OLD)).last_ref_at });
    assert.ok(c && c.id, 'premise: claimed');
    w.priv.objs.delete(`drafts/${RID}/${P_OLD}-card.webp`);   // crashed after deleting the card only
    w.setNow(T + 2 * 60e3);
    let r = await S.sweepRid({ ...w.deps, mode: 'live' }, RID);
    assert.strictEqual((await state(w, P_OLD)).state, 'deleting', 'SWEEP-LIVE-LEASE-RESPECTED');
    assert.ok(!r.recovered.includes(P_OLD), 'premise: not yet');
    w.setNow(T + S.LEASE_MS + 61e3);
    r = await S.sweepRid({ ...w.deps, mode: 'live' }, RID);
    assert.ok(r.recovered.includes(P_OLD), 'SWEEP-RECOVERY-TAKES-OVER');
    assert.strictEqual((await state(w, P_OLD)).state, 'deleted', 'SWEEP-RECOVERY-FINISHES (missing card = done)');
    assert.ok(!w.priv.objs.has(`drafts/${RID}/${P_OLD}-hero.webp`), 'SWEEP-RECOVERY-DELETES-THE-REST');
    ok('recovery: a crashed claim (card already gone) is left alone while its lease lives; after lease + 60 s the next run takes over (new fence) and finishes');
  }
  // ── 6. fencing: a fenced-out owner's final write fails; an owner stops deleting at lease − 30 s ──
  {
    const w = await world();
    const c = await S.claim(w.deps, RID, { pid: P_OLD, last_ref_at: (await state(w, P_OLD)).last_ref_at });
    await w.reg(P_OLD).set({ ...(await state(w, P_OLD)), claim: { id: 'someone-else', lease_until: T + S.LEASE_MS } });   // taken over
    assert.strictEqual(await S.markDeleted(w.deps, RID, P_OLD, c.id), false, 'SWEEP-FENCED-OUT-FINAL-WRITE-FAILS');
    assert.strictEqual((await state(w, P_OLD)).state, 'deleting', 'SWEEP-FENCED-STATE-INTACT');
    const w2 = await world();
    const c2 = await S.claim(w2.deps, RID, { pid: P_OLD, last_ref_at: (await state(w2, P_OLD)).last_ref_at });
    w2.setNow(c2.lease_until - 29e3);
    const done = await S.deleteObjects(w2.deps, RID, await state(w2, P_OLD), c2);
    assert.strictEqual(done, false, 'SWEEP-STOPS-NEAR-LEASE-END');
    assert.deepStrictEqual([w2.priv.deletes, w2.pub.deletes], [[], []], 'SWEEP-NO-DELETE-AFTER-LEASE-MINUS-30S');
    ok('a fenced-out owner\'s final write fails (state stays deleting); an owner issues no delete once now > lease − 30 s');
  }
  // ── 7. repair pass + stale uploads ──
  {
    const w = await world();
    await w.fs.collection('restaurants').doc(RID).collection('versions').doc('v-active').collection('meta').doc('photos').set({ schema: 1, entries: { tb_x: { state: 'pid', pid: P_NEW, card: 'c', hero: 'h' } } });
    await w.fs.collection('photo_uploads').doc('up1').set({ rid: RID, state: 'issued', created_at: T - 2 * DAY });
    await w.fs.collection('photo_uploads').doc('up2').set({ rid: RID, state: 'issued', created_at: T - 3600e3 });
    const r = await S.sweepRid({ ...w.deps, mode: 'live' }, RID);
    assert.strictEqual((await state(w, P_NEW)).state, 'published', 'SWEEP-REPAIR-ACTIVE-DRAFT-TO-PUBLISHED');
    assert.deepStrictEqual(r.repaired, [P_NEW], 'SWEEP-REPAIR-REPORTED');
    assert.deepStrictEqual([(await w.fs.collection('photo_uploads').doc('up1').get()).data().state, (await w.fs.collection('photo_uploads').doc('up2').get()).data().state], ['expired', 'issued'], 'SWEEP-STALE-UPLOADS-EXPIRED');
    ok('repair: an active-version pid still marked draft → published; issued uploads older than 1 day → expired');
  }
  // ── 4c. codex r1 P1-2: a LIVE processing reservation blocks the claim (same last_ref_at); an expired one does not ──
  {
    const w = await world();
    await w.reg(P_OLD).set({ ...(await state(w, P_OLD)), reserve: { id: 'proc1', until: T + 1 } });
    const cand = { pid: P_OLD, last_ref_at: (await state(w, P_OLD)).last_ref_at };
    assert.strictEqual(await S.claim(w.deps, RID, cand), null, 'SWEEP-LIVE-RESERVE-BLOCKS-CLAIM');
    assert.strictEqual((await state(w, P_OLD)).state, 'draft', 'SWEEP-LIVE-RESERVE-KEPT');
    w.setNow(T + 1);
    const c = await S.claim(w.deps, RID, cand);
    assert.ok(c && c.id, 'SWEEP-EXPIRED-RESERVE-CLAIMABLE');
    ok('claim: a live processing reservation (reserve.until > now) is respected; once it expires the pid is claimable again');
  }
  console.log(`sweep-core: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('sweep-core: FAILED —', e && e.stack || e); process.exit(1); });
