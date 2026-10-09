'use strict';
// ---------------------------------------------------------------------------
// 1D add-product PHASE A — the I/O the add-product decisions need, kept out of the tested cores and out of the
// pinned portal/functions.js (whose moved blocks gain one dependency line each). Everything here is a READ,
// except the post-activation KDS manifest sync (catalog/kds-manifest.js, its own conditional transaction).
//   readKeyMode(rid)            the restaurant profile's pricing_key_mode (DATA, never a rid literal)
//   hwmRef(rid)                 restaurants/{rid}/meta/display_id_hwm — the never-reused numeric id high-water mark
//   registryKeysTaken(rid, ks)  which of these keys already have an identity-registry key row (a name used before)
//   syncKds(rid, {versionId, generation})  write the active catalog's KDS manifest; never throws
// ---------------------------------------------------------------------------
const { keysColOf, idsColOf, encodeKey } = require('./identity-registry');
const { previewVersion } = require('./catalog-publish');
const { syncKdsManifest } = require('./kds-manifest');
const { getActivePointer } = require('./catalog-firestore');

const hwmRefOf = (fs, rid) => fs.collection('restaurants').doc(rid).collection('meta').doc('display_id_hwm');

function addProductIo({ fs, rtdb }) {
  return {
    readKeyMode: async (rid) => {
      const snap = await fs.collection('restaurants').doc(rid).get();
      return snap.exists ? (snap.data() || {}).pricing_key_mode : undefined;
    },
    hwmRef: (rid) => hwmRefOf(fs, rid),
    /* A key counts as PREVIOUSLY USED when the registry holds a key row for it — or, for a slug brand whose ids ARE its
       keys, an id document with that slug (a rollback to a certified version retires the id and deletes the key row,
       but the slug stays permanently reserved: re-adding it would save and then fail every publish with
       identity_slug_retired). Random-token ids never collide with a key, so the id lookup is harmless elsewhere. */
    registryKeysTaken: async (rid, keys) => {
      const uniq = [...new Set(keys)];
      const snaps = await Promise.all(uniq.map((k) => Promise.all([
        keysColOf(fs, rid, 'dish').doc(encodeKey(k)).get(),
        idsColOf(fs, rid, 'dish').doc(String(k)).get().catch(() => ({ exists: false })),
      ])));
      return new Set(uniq.filter((k, i) => snaps[i][0].exists || snaps[i][1].exists));
    },
    /* The activation's generation comes from the ACTIVE POINTER, read after the publish (catalog-publish.js is pinned
       and is not modified to return it). If the pointer already names a NEWER version, this activation was superseded:
       that publish writes its own list, and this one is skipped (the generation-conditional writer would no-op it). */
    syncKds: async (rid, { versionId }) => {
      try {
        const ptr = await getActivePointer(fs, rid);
        if (!ptr || ptr.version !== versionId || !Number.isInteger(ptr.generation)) return { pending: false, written: false, reason: 'superseded' };
        const preview = await previewVersion(fs, rid, versionId);
        return await syncKdsManifest(rtdb, rid, { catalog: { items: preview.items }, generation: ptr.generation, versionId });
      } catch (e) {
        try { console.error(`kds_manifest_sync_failed ${JSON.stringify({ rid, version: versionId, error: String((e && e.message) || e).slice(0, 200) })}`); } catch (_) {}
        return { pending: true, written: false, reason: 'failed' };
      }
    },
  };
}

module.exports = { addProductIo, hwmRefOf };
