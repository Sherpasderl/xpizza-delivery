'use strict';
// Portal 1D · D1 — shared test fixtures for the identity work.
//
// Extracted so the registry suite and the no-op suite drive ONE in-memory Firestore rather than two
// copies that agree today. The concurrency behaviour below is the part that matters and the part most
// easily got subtly wrong; two versions of it would eventually disagree about what a conflict is, and
// the suite that had the laxer one would quietly stop testing anything.

/* An in-memory Firestore with REAL optimistic concurrency: a transaction records what it read, and if
   any of those documents changed before it committed, it re-runs. Without that the concurrency test
   would pass against a store where nothing can ever conflict — which is the shape of test that made
   this whole initiative necessary. */
function memFirestore() {
  const docs = new Map();
  let version = 0;
  const bump = () => { version += 1; return version; };
  const ref = (path) => ({
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    _set: (v) => { docs.set(path, v); bump(); },
    _delete: () => { docs.delete(path); bump(); },
  });
  const col = (base) => ({ doc: (id) => makeRef(`${base}/${id}`) });
  function makeRef(path) {
    const r = ref(path);
    r.collection = (c) => col(`${path}/${c}`);
    return r;
  }
  const db = {
    _docs: docs,
    collection: (c) => col(c),
    async runTransaction(fn, { attempts = 8 } = {}) {
      for (let i = 0; i < attempts; i += 1) {
        const readVersions = new Map();
        const writes = [];
        /* 🔴 FIRESTORE REFUSES A READ AFTER A WRITE INSIDE A TRANSACTION, and this stub now refuses it
           too. It did not before — which made the stub LAXER than production in a second way, on top
           of the kind-blindness already found: identity-registry.js states "every read first" in a
           comment and relies on it, and a future edit that read after writing would have passed every
           test here and thrown in production, where the failure is a publish that cannot commit.
           A fake that silently permits what the real thing forbids is not a fake of that thing. */
        let wrote = false;
        const tx = {
          get: async (r) => {
            if (wrote) throw new Error('firestore_read_after_write: a transaction must do all reads before any write');
            readVersions.set(r.path, docs.has(r.path) ? JSON.stringify(docs.get(r.path)) : null);
            return r.get();
          },
          set: (r, v) => { wrote = true; writes.push(() => r._set(v)); },
          delete: (r) => { wrote = true; writes.push(() => r._delete()); },
        };
        const out = await fn(tx);
        // conflict check: did anything we READ change under us?
        let stale = false;
        for (const [p, seen] of readVersions) {
          const nowVal = docs.has(p) ? JSON.stringify(docs.get(p)) : null;
          if (nowVal !== seen) { stale = true; break; }
        }
        if (stale) { if (db._onRetry) db._onRetry(); continue; }
        writes.forEach((w) => w());
        return out;
      }
      throw new Error('transaction_retries_exhausted');
    },
  };
  return db;
}


/* A registry that resolves only SOME keys — the interrupted-backfill state.
   🔴 KIND-AWARE, and that is not incidental. The first version keyed on the string alone, so a dish
   key that happens to match an extra's name resolved as BOTH — which the real registry cannot do,
   because the two kinds are separate collections. A stub that is laxer than the thing it stands in for
   turns a passing test into no test at all, and here it silently granted ids to extras that were never
   registered. Takes { dish: [...], extra: [...] }. */
function partialRegistry(resolvable) {
  const known = {
    dish: new Set((resolvable && resolvable.dish) || []),
    extra: new Set((resolvable && resolvable.extra) || []),
  };
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          doc: (kind) => ({
            collection: () => ({
              doc: (encodedKey) => ({
                get: async () => {
                  const key = Buffer.from(encodedKey, 'base64url').toString('utf8');
                  const set = known[kind] || new Set();
                  return set.has(key)
                    ? { exists: true, data: () => ({ canonical_id: `ID_${kind}_${key}` }) }
                    : { exists: false, data: () => null };
                },
              }),
            }),
          }),
        }),
      }),
    }),
  };
}

module.exports = { memFirestore, partialRegistry };
