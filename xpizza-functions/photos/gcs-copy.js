'use strict';
// DISH PHOTOS A2 step 10 — the publish copy (§2.5 step 1): drafts/{rid}/{pid}-*.webp in the default (private) bucket → photos/{rid}/{pid}-*.webp
// in the PUBLIC photo bucket, CREATE-ONLY on the destination (ifGenerationMatch 0): an object that already exists is the same bytes by
// construction (pid = content id), so a 412 is success and returns its generation. Immutable names ⇒ public, max-age 1 y, immutable —
// cacheControl at the copy options' TOP level beside contentType (codex r1 P2-6: File.copy turns a nested `metadata` into CUSTOM metadata).
// Any other error propagates (publish fails closed). `storage` is a @google-cloud/storage client (getStorage() in production).
const is412 = (e) => e && (e.code === 412 || e.code === '412');

function makeGcsCopy(storage, privateBucket) {   // codex r1 P1-1: the private (source) bucket is NAMED
  return {
    async copyIfAbsent(srcPath, dstBucket, dstPath) {
      const dst = storage.bucket(dstBucket).file(dstPath);
      try {
        await storage.bucket(privateBucket).file(srcPath).copy(dst, { preconditionOpts: { ifGenerationMatch: 0 }, contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
        const [m] = await dst.getMetadata();
        return { generation: String(m.generation), created: true };
      } catch (e) {
        if (!is412(e)) throw e;
        const [m] = await dst.getMetadata();
        return { generation: String(m.generation), created: false };
      }
    },
  };
}

module.exports = { makeGcsCopy };
