'use strict';
// DISH PHOTOS A2 step 9 — getEditableCatalog's photo READS (E-P3), feeding the pure photos/editable-photos.js:
//   the active version's meta/photos (via photos/edit-io readActive), the registry state of every referenced pid, and — only while in use
//   (flag on or photo data present) — the legacy-copy records photo_registry/{rid}/legacy/{hash}. Firestore only; Storage is touched
//   solely to SIGN a draft preview URL (no object read). Dark + no data ⇒ {} with no registry / legacy reads.
// PHOTOS_PUBLIC_BUCKET (advisor ruling #2) is defined in photos/buckets.js (the one bucket source) and re-exported here.
const { makePhotoEditIo } = require('./edit-io');
const { editablePhotoFields, legacyUrlFor, legacyHashOf } = require('./editable-photos');
const PS = require('./photo-state');
// static (the portal import graph is pinned identically at import and after a request — portal-split); firebase-admin stays lazy
const { photosUploadsEnabled } = require('./flag');
const { makeGcsStore } = require('./gcs-store');
const { assetBaseFor } = require('../catalog/public-photos');
const { PLATFORM } = require('../platform-manifest');

const { PHOTOS_PUBLIC_BUCKET, privateBucketName } = require('./buckets');   // codex r1 P1-1: the ONE bucket source

function makeEditableIo({ fs, enabled, publicBucket, legacyBase, signRead, now = Date.now }) {
  const edit = makePhotoEditIo({ fs, enabled });
  const regDoc = (rid, coll, id) => fs.collection('photo_registry').doc(rid).collection(coll).doc(id);
  async function readStates(rid, coll, ids) {
    const out = {};
    const snaps = await Promise.all(ids.map((id) => regDoc(rid, coll, id).get()));
    snaps.forEach((s, i) => { if (s.exists) out[ids[i]] = s.data(); });
    return out;
  }
  return {
    async fieldsFor({ rid, source, activeVersionId }) {
      const draftMap = source && source.photos && typeof source.photos === 'object' && Object.keys(source.photos).length ? source.photos : null;
      const activeEntries = activeVersionId == null ? null : await edit.readActive(rid, activeVersionId);
      let on = false;
      try { on = (await enabled()) === true; } catch (_) { on = false; }
      const pids = [...new Set([...PS.referencedPids(draftMap), ...PS.referencedPids(activeEntries)])];
      const inUse = on || !!draftMap || !!(activeEntries && Object.keys(activeEntries).length);
      if (!inUse) return {};
      const registry = {};
      for (const [pid, d] of Object.entries(await readStates(rid, 'pids', pids))) registry[pid] = d && d.state;
      const bucket = (publicBucket() || '').trim() || null;
      const base = legacyBase(rid);
      const items = Array.isArray(source && source.items) ? source.items : [];
      const hashes = [...new Set(items.map((it) => legacyUrlFor(it, base)).filter(Boolean).map(legacyHashOf))];
      const legacyRecords = await readStates(rid, 'legacy', hashes);
      return editablePhotoFields({ rid, now: now(), enabled: on, publicBucket: bucket, legacyBase: base, items, draftMap, activeEntries, registry, legacyRecords, signRead });
    },
  };
}

function editableIoForPortal() {
  const { getFirestore } = require('firebase-admin/firestore');
  const { getDatabase } = require('firebase-admin/database');
  const { getStorage } = require('firebase-admin/storage');
  return makeEditableIo({
    fs: getFirestore(), enabled: () => photosUploadsEnabled(getDatabase()), publicBucket: () => PHOTOS_PUBLIC_BUCKET.value(),
    legacyBase: (rid) => assetBaseFor(rid, PLATFORM.sites), signRead: (p, e) => makeGcsStore(getStorage().bucket(privateBucketName())).signRead(p, e),
  });
}

module.exports = { makeEditableIo, editableIoForPortal, PHOTOS_PUBLIC_BUCKET };
