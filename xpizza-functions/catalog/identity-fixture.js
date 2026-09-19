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
    /* 🔴 A SNAPSHOT IS POINT-IN-TIME, and this used to read the live map lazily — so a document
       changed AFTER a read was observed BY that read, which Firestore never does. It matters for
       anything reasoning about in-flight reads: D4's cache is anchored at a read's start precisely
       because a retirement can commit while a read is outstanding, and a lazy snapshot made that race
       impossible to stage. Captured at call time now, as production does. */
    get: async () => {
      const exists = docs.has(path);
      const captured = exists ? JSON.parse(JSON.stringify(docs.get(path))) : undefined;
      return { exists, data: () => captured };
    },
    _set: (v) => { docs.set(path, v); bump(); },
    _delete: () => { docs.delete(path); bump(); },
  });
  /* 🔴 QUERIES, because D4's writer guard asks "is there a live id already claiming this key?" and on
     x_pizza there is no id to guess — only a query finds it. Modelled as Firestore does: equality
     filters, chainable, returning a snapshot with `.docs` carrying `.id` and `.data()`. Scans this
     collection's immediate children only — a Firestore collection query does not descend, and a
     fixture that did would answer questions production cannot. */
  const col = (base) => {
    const self = {
      doc: (id) => makeRef(`${base}/${id}`),
      // Firestore collections answer .get(); a fixture without it forces tests to reach for internals.
      get: async () => makeQuery(base, []).get(),
      where: (field, op, value) => {
        if (op !== '==') throw new Error(`memFirestore: only '==' filters are modelled (got ${op})`);
        return makeQuery(base, [[field, value]]);
      },
    };
    return self;
  };
  function makeQuery(base, filters) {
    return {
      where: (field, op, value) => {
        if (op !== '==') throw new Error(`memFirestore: only '==' filters are modelled (got ${op})`);
        return makeQuery(base, filters.concat([[field, value]]));
      },
      _isQuery: true, _base: base, _filters: filters,
      get: async () => {
        const out = [];
        for (const [path, val] of docs) {
          if (!path.startsWith(`${base}/`)) continue;
          if (path.slice(base.length + 1).includes('/')) continue;      // immediate children only
          if (!filters.every(([f, v]) => val && val[f] === v)) continue;
          out.push({ id: path.split('/').pop(), exists: true, data: () => val });
        }
        return { docs: out, empty: out.length === 0, size: out.length };
      },
    };
  }
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
            /* A QUERY read inside a transaction, which Firestore supports and the writer guard needs.
               Its conflict key is the whole collection: any write under it must invalidate the read,
               because the query's ANSWER can change without any document it returned changing. */
            if (r && r._isQuery) {
              const snap = await r.get();
              readVersions.set(`__query__${r._base}|${JSON.stringify(r._filters)}`,
                JSON.stringify(snap.docs.map((d) => [d.id, d.data()])));
              return snap;
            }
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
          let nowVal;
          if (p.startsWith('__query__')) {
            const [base, filtersJson] = p.slice('__query__'.length).split('|');
            const filters = JSON.parse(filtersJson);
            const rows = [];
            for (const [path, val] of docs) {
              if (!path.startsWith(`${base}/`)) continue;
              if (path.slice(base.length + 1).includes('/')) continue;
              if (!filters.every(([f, v]) => val && val[f] === v)) continue;
              rows.push([path.split('/').pop(), val]);
            }
            nowVal = JSON.stringify(rows);
          } else {
            nowVal = docs.has(p) ? JSON.stringify(docs.get(p)) : null;
          }
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


/* ── ONE REGISTRY FAKE, SHAPED LIKE THE REAL PATH ──────────────────────────────────────────────
   🔴 EVERY LAXITY IN A FAKE IS A CONSTRAINT THE TEST STOPS CHECKING, and there were three of them
   here: a stub that ignored the restaurant, one that ignored the collection NAMES, and one that
   ignored which event it was asked for. Each made a real production constraint unobservable — a
   cross-brand lookup, a read of the wrong collection, a gate asking for the wrong event — and each
   would have answered cleanly where Firestore answers nothing.
   The real lookup path is exactly:
       restaurants/{rid}/identity/{dish|extra}/keys/{base64url(legacyKey)}
   so this fake refuses every departure from it, loudly, by throwing. `resolve(kind, key)` decides
   which keys exist, which is the only axis a caller should get to vary.
   REFUSALS THROW rather than return not-found on purpose: a miss is a legitimate registry answer and
   the overlay handles it by serving id-absent, so a wrong path answered as "not found" would look
   like an ordinary unregistered object and prove nothing. */
function registryStub({ rid: expectRid, resolve }) {
  const refuse = (m) => { throw new Error(`registry_stub_refused: ${m}`); };
  return {
    collection: (c) => {
      if (c !== 'restaurants') refuse(`the registry hangs off 'restaurants', asked '${c}'`);
      return {
        doc: (rid) => {
          if (expectRid !== undefined && rid !== expectRid) {
            refuse(`registry_wrong_restaurant: asked ${rid}, scoped to ${expectRid}`);
          }
          return {
            collection: (c2) => {
              if (c2 !== 'identity') refuse(`the registry lives under 'identity', asked '${c2}'`);
              return {
                doc: (kind) => {
                  if (kind !== 'dish' && kind !== 'extra') refuse(`kind is dish|extra, asked '${kind}'`);
                  return {
                    collection: (c3) => {
                      /* A legacy-key lookup reads 'keys'. 'ids' is the REVERSE index and holds a
                         different row shape; a name-blind stub would hand a keys row back for an ids
                         read and the two indexes would appear interchangeable, which is the one thing
                         they are not. */
                      if (c3 !== 'keys') refuse(`a legacy-key lookup reads 'keys', asked '${c3}'`);
                      return {
                        doc: (encodedKey) => ({
                          get: async () => {
                            if (typeof encodedKey !== 'string' || !encodedKey) refuse('an empty document id');
                            const key = Buffer.from(encodedKey, 'base64url').toString('utf8');
                            // The id must be the ENCODING of that key — base64url decoding is lenient,
                            // so a raw unencoded key would decode to mojibake and silently miss.
                            if (Buffer.from(key, 'utf8').toString('base64url') !== encodedKey) {
                              refuse(`document id is not base64url(legacyKey): '${String(encodedKey).slice(0, 32)}'`);
                            }
                            const id = resolve(kind, key);
                            return id
                              ? { exists: true, data: () => ({ canonical_id: id }) }
                              : { exists: false, data: () => null };
                          },
                        }),
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

/* Resolves EVERY key — the worst case for a no-op claim, because it is the state in which identity is
   most present. Testing the no-op against an empty registry would prove only that absent ids change
   nothing, which is trivially true and not the claim. */
const fullRegistry = (rid) => registryStub({ rid, resolve: (kind, key) => `ID_${kind}_${key}` });

/* A registry that resolves only SOME keys — the interrupted-backfill state. KIND-AWARE, because the
   two kinds are separate collections in the real thing: keyed on the string alone, a dish key that
   happens to match an extra's name resolved as BOTH, silently granting ids to extras that were never
   registered. Takes { dish: [...], extra: [...] }. */
function partialRegistry(resolvable, rid) {
  const known = {
    dish: new Set((resolvable && resolvable.dish) || []),
    extra: new Set((resolvable && resolvable.extra) || []),
  };
  return registryStub({ rid, resolve: (kind, key) => ((known[kind] || new Set()).has(key) ? `ID_${kind}_${key}` : null) });
}

/* The 86 gate's RTDB stub, likewise shaped like the real read: `.once('value')` on this restaurant's
   own availability node. A `.get()`-shaped stub returns undefined and the gate fails OPEN — the
   comparison then passes against two empty results. A path-blind one answers the other brand's read.
   An event-blind one answers a gate that asked for the wrong event. */
function availabilityStub(rid, node, assert) {
  const wantPath = `restaurants/${rid}/item_availability`;
  return { ref: (path) => {
    assert.strictEqual(path, wantPath, `${rid}: the 86 gate must read ITS OWN availability node (asked ${path})`);
    return { once: async (evt) => {
      assert.strictEqual(evt, 'value', `${rid}: the 86 gate must read the 'value' event (asked ${String(evt)})`);
      return { val: () => node };
    } };
  } };
}

module.exports = { memFirestore, partialRegistry, fullRegistry, registryStub, availabilityStub };
