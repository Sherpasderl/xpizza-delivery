'use strict';
// DISH PHOTOS A2 step 10 (PLAN-dish-photos r2 §2.5 publish, §2.6 the publish half of the reference protocol).
//   prepare(rid, map)        BEFORE the version is written: every referenced pid's registry doc must be draft|published (else
//                            photo_unavailable); each pid not yet published has its card + hero drafts COPIED to the public bucket
//                            create-only (an existing object = success: same bytes by construction; card and hero independently, so a
//                            partial pair completes on the retry). No public bucket (A0 not done) or any copy failure → photo_publish_failed.
//                            → {doc: versions/{vid}/meta/photos, pids, gens} | null (no map)
//   hook(prepared).commit    passed into publishVersion and run AFTER the version docs are verified and BEFORE the flip: ONE Firestore
//                            transaction re-reads every pid (still draft|published, else photo_unavailable), CREATES meta/photos and bumps
//                            last_ref_at (+ the public generations the sweeper deletes by). The sweeper's claim is a transaction on the
//                            same docs, so a claim and a publish serialize — exactly one wins. A failure leaves the pointer untouched.
//   markPublished(rid, pids) AFTER the flip: draft → published (best effort; the sweeper's repair pass finishes a crash here).
const PS = require('./photo-state');
const ATTACHABLE = new Set(['draft', 'published']);
const err = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { code });
const publicUrl = (bucket, rid, pid, kind) => `https://storage.googleapis.com/${bucket}/photos/${rid}/${pid}-${kind}.webp`;

function makePublishPhotos({ fs, store, publicBucket, now = Date.now }) {
  const regRef = (rid, pid) => fs.collection('photo_registry').doc(rid).collection('pids').doc(pid);
  const metaRef = (db, rid, vid) => db.collection('restaurants').doc(rid).collection('versions').doc(vid).collection('meta').doc('photos');
  return {
    async prepare(rid, map) {
      if (!map || !Object.keys(map).length) return null;
      const pids = PS.referencedPids(map);
      const states = {};
      for (const pid of pids) {
        const s = await regRef(rid, pid).get();
        const st = s.exists ? (s.data() || {}).state : null;
        if (!ATTACHABLE.has(st)) throw err('photo_unavailable', `photo ${pid} is ${st || 'unknown'}`);
        states[pid] = st;
      }
      const bucket = (publicBucket() || '').trim();
      if (pids.length && !bucket) throw err('photo_publish_failed', 'no public photo bucket is configured (PHOTOS_PUBLIC_BUCKET)');
      const gens = {};
      for (const pid of pids) {
        if (states[pid] === 'published') continue;
        gens[pid] = {};
        for (const kind of ['card', 'hero']) {
          try { gens[pid][kind] = (await store.copyIfAbsent(`drafts/${rid}/${pid}-${kind}.webp`, bucket, `photos/${rid}/${pid}-${kind}.webp`)).generation; }
          catch (e) { throw err('photo_publish_failed', `copying ${pid}-${kind} failed: ${String((e && e.message) || e).slice(0, 120)}`); }
        }
      }
      const doc = PS.versionPhotosDoc(map, (pid, kind) => (bucket ? publicUrl(bucket, rid, pid, kind) : null));
      return { doc, pids, gens };
    },
    hook(prepared) {
      if (!prepared) return null;
      return {
        commit: (db, rid, versionId) => db.runTransaction(async (tx) => {
          const refs = prepared.pids.map((p) => regRef(rid, p));
          const snaps = [];
          for (const r of refs) snaps.push(await tx.get(r));   // every read before any write
          snaps.forEach((s, i) => { const st = s.exists ? (s.data() || {}).state : null; if (!ATTACHABLE.has(st)) throw err('photo_unavailable', `photo ${prepared.pids[i]} became ${st || 'unknown'}`); });
          tx.create(metaRef(db, rid, versionId), prepared.doc);
          const t = now();
          refs.forEach((r, i) => {
            const g = prepared.gens[prepared.pids[i]];
            tx.update(r, { last_ref_at: t, ...(g ? { 'generations.pub_card': String(g.card), 'generations.pub_hero': String(g.hero) } : {}) });
          });
        }),
      };
    },
    async markPublished(rid, pids) {
      for (const pid of pids || []) {
        try {
          await fs.runTransaction(async (tx) => {
            const r = regRef(rid, pid); const s = await tx.get(r);
            if (s.exists && (s.data() || {}).state === 'draft') tx.update(r, { state: 'published' });
          });
        } catch (e) { console.warn('photo_mark_published_failed', JSON.stringify({ rid, pid, error: String((e && e.message) || e).slice(0, 120) })); }
      }
    },
  };
}

module.exports = { makePublishPhotos, publicUrl };
