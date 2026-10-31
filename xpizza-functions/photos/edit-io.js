'use strict';
// DISH PHOTOS A2 step 8 — the editCatalog `photos` dependency (catalog/edit-catalog-handler.js editCatalogCore):
//   readActive(rid, vid)  restaurants/{rid}/versions/{vid}/meta/photos → its `entries`; absent → null (every existing version = legacy).
//                         A malformed doc THROWS — the handler answers 503 live_version_unavailable (fail closed, never guessed).
//   attach(rid, pids)     §2.6: ONE Firestore transaction — every pid's photo_registry/{rid}/pids/{pid} must exist in state
//                         draft|published; only then is each last_ref_at set to now. Any other pid → {ok:false, code:'photo_unavailable'}
//                         and NOTHING is bumped. (Runs before the draft's own CAS write; see the handler's note.)
//   enabled()             PHOTOS_UPLOADS (photos/flag.js over RTDB config/photos_uploads_enabled).
// makePhotoEditIo({fs, enabled, now}) is the testable core; photoIoForEdit() wires production (firebase-admin required lazily).
const { photosUploadsEnabled } = require('./flag');   // static: the portal import graph is pinned (portal-split)
const ATTACHABLE = new Set(['draft', 'published']);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const malformed = (why) => Object.assign(new Error(`photos_meta_malformed: ${why}`), { code: 'photos_meta_malformed' });

function makePhotoEditIo({ fs, enabled, now = Date.now }) {
  const metaRef = (rid, vid) => fs.collection('restaurants').doc(rid).collection('versions').doc(vid).collection('meta').doc('photos');
  const regRef = (rid, pid) => fs.collection('photo_registry').doc(rid).collection('pids').doc(pid);
  return {
    enabled: () => enabled(),
    async readActive(rid, vid) {
      if (typeof vid !== 'string' || !vid) throw malformed('no active version id');
      const s = await metaRef(rid, vid).get();
      if (!s.exists) return null;
      const d = s.data();
      if (!isObj(d) || d.schema !== 1 || !isObj(d.entries)) throw malformed(`versions/${vid}/meta/photos`);
      return d.entries;
    },
    async attach(rid, pids) {
      if (!pids.length) return { ok: true };
      const t = now();
      return fs.runTransaction(async (tx) => {
        const refs = pids.map((p) => regRef(rid, p));
        const snaps = [];
        for (const r of refs) snaps.push(await tx.get(r));   // every read before any write
        for (let i = 0; i < snaps.length; i++) {
          const d = snaps[i].exists ? snaps[i].data() : null;
          if (!d || !ATTACHABLE.has(d.state)) return { ok: false, code: 'photo_unavailable', pid: pids[i] };
        }
        for (const r of refs) tx.update(r, { last_ref_at: t });
        return { ok: true };
      });
    },
  };
}

function photoIoForEdit() {
  const { getFirestore } = require('firebase-admin/firestore');
  const { getDatabase } = require('firebase-admin/database');
  return makePhotoEditIo({ fs: getFirestore(), enabled: () => photosUploadsEnabled(getDatabase()) });
}

module.exports = { makePhotoEditIo, photoIoForEdit };
