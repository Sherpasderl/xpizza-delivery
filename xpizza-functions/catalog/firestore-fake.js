'use strict';
// ---------------------------------------------------------------------------
// A TEST-ONLY in-memory Firestore — enough of the API for the REAL publish and read paths.
//
// Not a fixture. publishVersion writes into this through its own lease, its own transactions and its
// own batches, and the reader reads back what actually landed, so a writer and a reader that disagree
// show up here rather than in production. Nothing in the runtime import graph requires this file.
//
// Two details are deliberate, because both are places a friendlier fake would hide a real bug:
//
//   • COLLECTIONS RETURN DOCS IN DOC-ID ORDER. The real one does, and the ids are content hashes, so
//     "the order Firestore gives you" is effectively arbitrary. A reader that forgot to order
//     explicitly passes against an insertion-ordered fake and serves a shuffled menu in production.
//   • EVERY WRITE STAMPS A NEW updateTime. The draft CAS compares those, so a fake that left them
//     constant would make a stale-draft publish look fresh — which is the exact race the CAS exists
//     to lose.
// ---------------------------------------------------------------------------
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

function makeDb() {
  const docs = new Map();            // path -> { data, updateTime }
  let clock = 1757000000000;
  let autoId = 0;
  const tick = () => Timestamp.fromMillis((clock += 1000));
  // serverTimestamp() sentinels resolve on write, exactly as the server does — publishVersion's lease
  // depends on reading one back as a real Timestamp.
  const resolve = (v) => {
    if (v instanceof FieldValue) return tick();
    if (v instanceof Timestamp) return v;
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = resolve(v[k]); return o; }
    return v;
  };
  const put = (path, data) => { docs.set(path, { data: resolve(data), updateTime: tick() }); };
  const snapOf = (path) => {
    const held = docs.get(path);
    return {
      exists: held !== undefined,
      id: path.split('/').pop(),
      ref: docRef(path),
      updateTime: held ? held.updateTime : undefined,
      data: () => (held ? held.data : undefined),
      get: (f) => (held ? held.data[f] : undefined),
    };
  };
  function docRef(path) {
    return {
      path,
      id: path.split('/').pop(),
      collection: (sub) => colRef(`${path}/${sub}`),
      get: async () => snapOf(path),
      // `lastUpdateTime` is a real Firestore PRECONDITION and is modelled, not ignored: the draft
      // upgrade writes under one so a merchant saving between the read and the write is refused
      // rather than overwritten. A fake that accepted every write would make that guard untestable,
      // which is the same as not having it.
      set: async (data, opts) => {
        if (opts && opts.lastUpdateTime) {
          const held = docs.get(path);
          const at = held ? held.updateTime : undefined;
          if (!at || at.toMillis() !== opts.lastUpdateTime.toMillis()) {
            const e = new Error(`FAILED_PRECONDITION: the document was modified (${path})`);
            e.code = 9;
            throw e;
          }
        }
        put(path, data);
      },
      create: async (data) => {
        if (docs.has(path)) throw new Error(`already_exists: ${path}`);
        put(path, data);
      },
      delete: async () => { docs.delete(path); },
    };
  }
  function colRef(path) {
    return {
      doc: (id) => docRef(`${path}/${id === undefined ? `auto${++autoId}` : id}`),
      get: async () => {
        const out = [];
        for (const p of docs.keys()) {
          if (!p.startsWith(`${path}/`)) continue;
          if (p.slice(path.length + 1).includes('/')) continue;    // direct children only
          out.push(snapOf(p));
        }
        out.sort((a, b) => (a.id < b.id ? -1 : 1));                // DOC-ID order, like the real one
        return { docs: out, empty: out.length === 0, forEach: (f) => out.forEach(f) };
      },
    };
  }
  return {
    collection: (c) => colRef(c),
    batch: () => {
      const ops = [];
      return {
        set: (ref, d) => ops.push(() => ref.set(d)),
        create: (ref, d) => ops.push(() => ref.create(d)),
        delete: (ref) => ops.push(() => ref.delete()),
        commit: async () => { for (const op of ops) await op(); },
      };
    },
    runTransaction: async (fn) => fn({
      get: (ref) => ref.get(),
      set: (ref, d) => { put(ref.path, d); },
      delete: (ref) => { docs.delete(ref.path); },
    }),
    _raw: docs,
  };
}

module.exports = { makeDb };
