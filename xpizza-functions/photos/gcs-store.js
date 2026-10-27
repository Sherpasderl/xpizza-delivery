'use strict';
// DISH PHOTOS A1 step 6 (PLAN-dish-photos r2 §2.2 E-P2) — the ONE adapter from photoProcessCore's storage interface to a
// @google-cloud/storage Bucket (the caller passes `getStorage().bucket()`; nothing here requires the library):
//   metadata(path)                       → {generation, size} | null on 404
//   download(path, {generation, maxBytes}) → Buffer, streamed from THAT generation with a byte counter that aborts past maxBytes
//                                           (code too_large); 404 / another generation → code generation_mismatch
//   createIfAbsent(path, buf, {contentType}) → {generation, created}: save with ifGenerationMatch:0; a 412 means it exists → its generation
//   remove(path)                         → delete, ignoring not-found
//   signRead(path, expiresMs)            → a V4 path-style signed GET (the 1 h draft preview)
// Any other error propagates unchanged — the core treats it as transient.
const typed = (code, msg) => Object.assign(new Error(msg), { code });
const is404 = (e) => e && (e.code === 404 || e.code === '404');
const is412 = (e) => e && (e.code === 412 || e.code === '412');

function makeGcsStore(bucket) {
  return {
    async metadata(path) {
      try { const [m] = await bucket.file(path).getMetadata(); return { generation: String(m.generation), size: Number(m.size) }; }
      catch (e) { if (is404(e)) return null; throw e; }
    },
    download(path, { generation, maxBytes }) {
      return new Promise((resolve, reject) => {
        const chunks = []; let total = 0; let done = false;
        const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
        const stream = bucket.file(path, { generation }).createReadStream({ validation: false });
        stream.on('data', (c) => {
          total += c.length;
          if (total > maxBytes) { finish(reject, typed('too_large', `over ${maxBytes} bytes`)); stream.destroy(); return; }
          chunks.push(c);
        });
        stream.on('error', (e) => finish(reject, is404(e) ? typed('generation_mismatch', 'object gone or replaced') : e));
        stream.on('end', () => finish(resolve, Buffer.concat(chunks)));
      });
    },
    async createIfAbsent(path, buf, { contentType }) {
      const f = bucket.file(path);
      try {
        await f.save(buf, { resumable: false, contentType, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { cacheControl: 'private, max-age=0, no-store' } });
        return { generation: String(f.metadata.generation), created: true };
      } catch (e) {
        if (!is412(e)) throw e;
        const [m] = await bucket.file(path).getMetadata();
        return { generation: String(m.generation), created: false };
      }
    },
    async remove(path) { await bucket.file(path).delete({ ignoreNotFound: true }); },
    async signRead(path, expiresMs) {
      const [url] = await bucket.file(path).getSignedUrl({ version: 'v4', action: 'read', expires: expiresMs, virtualHostedStyle: false });
      return url;
    },
  };
}

module.exports = { makeGcsStore };
