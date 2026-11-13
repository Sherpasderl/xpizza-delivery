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
//
// 🔴 ONE STATED DIFFERENCE, LAXER THAN PRODUCTION IN TIMING (1D D4-c2a): a transaction's create() refuses an existing
// document AT THE CALL, where Firestore refuses at COMMIT. Writes buffered earlier in the same callback have already
// been applied here (this fake applies every write immediately and models neither isolation nor rollback), so a
// "nothing was committed" claim is NOT provable on this double — every such claim is proven on the Firestore emulator
// with the real SDK (test/c2a-evidence.emulator.test.js), and the unit cells here assert only the typed error.
// ---------------------------------------------------------------------------
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

/* 🔴 WHAT THIS DOUBLE DOES NOT MODEL, so its green is not read as evidence about those things.
   Writes APPLY IMMEDIATELY: there is no snapshot isolation, no conflict retry, and no rejection of a
   read issued after a write inside a transaction. So "all reads precede all writes" — the ordering
   Firestore actually enforces, and the property rule 17 is about — is NOT checked by any cell using
   this fake. Only the emulator suites would catch a violation.
   A fixture that cannot express a production constraint makes that constraint untestable; this one is
   written down rather than assumed away, because the alternative is a green run standing in for a
   guarantee nobody checked. */
function makeDb() {
  const docs = new Map();            // path -> { data, updateTime }
  let clock = 1757000000000;
  let autoId = 0;
  const tick = () => Timestamp.fromMillis((clock += 1000));
  let pinned = null;                 // a WriteBatch commit's ONE commit time (every write and serverTimestamp in it), else null
  const stamp = () => pinned || tick();
  // serverTimestamp() sentinels resolve on write, exactly as the server does — publishVersion's lease
  // depends on reading one back as a real Timestamp.
  const resolve = (v) => {
    if (v instanceof FieldValue) return stamp();
    if (v instanceof Timestamp) return v;
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = resolve(v[k]); return o; }
    return v;
  };
  const put = (path, data) => { docs.set(path, { data: resolve(data), updateTime: stamp() }); };
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
      /* 🔴 set() IGNORES `lastUpdateTime`, BECAUSE FIRESTORE DOES — and this fake used to ENFORCE it,
         which made it STRICTER THAN THE REAL API in the one direction that hides a missing guard.
         The draft upgrade passed `set(data, { lastUpdateTime })`, Firestore accepted and dropped the
         option (preconditions belong to update() and delete()), and this fake refused the stale write —
         so a cell driving the real function, and a mutant confirming the option mattered, both certified
         a guard THAT DID NOT EXIST IN PRODUCTION. Measured against the emulator: real `set()` with a
         stale precondition COMMITS; real `update()` refuses with code 9.
         🔴 A DOUBLE THAT IS STRICTER THAN REALITY IS WORSE THAN ONE THAT IS LAXER. A laxer double lets a
         defect through and something downstream notices; a stricter one PRODUCES EVIDENCE FOR A
         GUARANTEE THE SYSTEM DOES NOT HAVE, and nothing downstream can contradict it. If this fake is
         ever wrong again, let it be in the lax direction.
         A refusal is now DELIBERATELY NOT thrown here: the option is accepted and ignored, exactly as
         Firestore does, so any production code relying on it fails in tests the same way it fails in
         production. The draft upgrade now uses a transaction with an EXPLICIT revision comparison,
         which this fake can model because the comparison is in the code rather than in the database. */
      set: async (data, opts) => {
        void opts;                 // accepted and ignored — see the note above; do not "fix" this
        put(path, data);
      },
      create: async (data) => {
        if (docs.has(path)) throw new Error(`already_exists: ${path}`);
        put(path, data);
      },
      /* update() ENFORCES `lastUpdateTime`, BECAUSE FIRESTORE DOES (measured, per the note above: real update() with a stale
         precondition refuses with code 9). Faithful, never laxer:
         · a missing document refuses with code 5, as Firestore's update does;
         · the precondition must be a real Timestamp (the SDK's type; a caller passing a string is a bug production would hit);
         · a top-level key REPLACES that field; a DOTTED key is a field path — it sets the nested field and keeps its siblings
           (creating intermediate maps), exactly as Firestore's update(); every other field is kept. */
      update: async (data, opts) => updateNow(path, data, opts),
      delete: async () => { docs.delete(path); },
    };
  }
  // update()'s body, SYNCHRONOUS so a WriteBatch can apply all its writes with no await between them (see batch.commit)
  function updateNow(path, data, opts) {
        const held = docs.get(path);
        if (held === undefined) { const e = new Error(`not_found: ${path}`); e.code = 5; throw e; }
        const want = opts && opts.lastUpdateTime;
        if (want !== undefined) {
          if (!(want instanceof Timestamp)) throw new TypeError('firestore-fake: update() precondition lastUpdateTime must be a Timestamp');
          if (!want.isEqual(held.updateTime)) { const e = new Error(`FAILED_PRECONDITION: ${path}`); e.code = 9; throw e; }
        }
        // a STRUCTURAL copy (no JSON round-trip, no magic keys): plain maps and arrays are copied, every other value — a Timestamp,
        // NaN, ±Infinity, any non-plain object — is kept exactly, so an update never alters a field it was not given
        const copy = (v) => (Array.isArray(v) ? v.map(copy)
          : v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]))
            : v);
        const next = copy(held.data);
        for (const [k, v] of Object.entries(data)) {
          const segs = k.split('.');
          let o = next;
          for (const sgm of segs.slice(0, -1)) { if (!o[sgm] || typeof o[sgm] !== 'object' || Array.isArray(o[sgm])) o[sgm] = {}; o = o[sgm]; }
          o[segs[segs.length - 1]] = v;
        }
        put(path, next);
        return { writeTime: docs.get(path).updateTime };
  }
  function colRef(path) {
    /* 🔴 EQUALITY QUERIES, because D4's registry writer guard asks "is a live id already claiming this
       key?" and on x_pizza the id is a random token — there is nothing to look up by doc id. Without
       this the guard throws inside every publish's preserve-on-write and silently registers nothing,
       which is how it first showed up here. Immediate children only, as a Firestore collection query
       is: a fixture that descended would answer a question production cannot. */
    /* 🔴 limit() IS MODELLED BECAUSE PRODUCTION BOUNDS ITS QUERIES. A caller that reads a claimant set
       under a cap and treats an over-full result as an explicit refusal cannot be exercised by a
       fixture whose queries are unbounded — the cap branch would be unreachable in every test while
       being the branch that matters in production. Cutting AFTER sorting is what Firestore does, so a
       cap of N returns the same N rows here as there. */
    const query = (filters, cap = null) => ({
      _isQuery: true, _base: path, _filters: filters, _limit: cap,
      where: (f, op, v) => {
        if (op !== '==') throw new Error(`firestore-fake: only '==' filters are modelled (got ${op})`);
        return query(filters.concat([[f, v]]), cap);
      },
      limit: (nn) => {
        if (!Number.isInteger(nn) || nn <= 0) throw new Error(`firestore-fake: limit must be a positive integer (got ${nn})`);
        return query(filters, nn);
      },
      get: async () => {
        const out = [];
        for (const p of docs.keys()) {
          if (!p.startsWith(`${path}/`)) continue;
          if (p.slice(path.length + 1).includes('/')) continue;
          const snap = snapOf(p);
          const d = snap.data();
          if (!filters.every(([f, v]) => d && d[f] === v)) continue;
          out.push(snap);
        }
        out.sort((a, b) => (a.id < b.id ? -1 : 1));
        const capped = cap === null ? out : out.slice(0, cap);
        return { docs: capped, empty: capped.length === 0, size: capped.length };
      },
    });
    return {
      where: (f, op, v) => {
        if (op !== '==') throw new Error(`firestore-fake: only '==' filters are modelled (got ${op})`);
        return query([[f, v]]);
      },
      limit: (nn) => query([], nn),
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
    /* 🔴 A WriteBatch IS ATOMIC IN FIRESTORE, so it is atomic here (advisor 11-13; editCatalogCore commits the draft and the
       high-water mark in ONE batch, edit-catalog-handler.js:405). commit() applies every write SYNCHRONOUSLY — no await between
       them, so nothing else interleaves — and on the first refusal restores the documents exactly as they were before the
       commit, then rethrows it: every write lands, or none does. The writes share ONE commit time (serverTimestamp included),
       returned per write as WriteResult.writeTime. Refusals are Firestore's: update() on a missing doc → 5, a stale
       lastUpdateTime → 9 (updateNow); create() over an existing doc → 6 ALREADY_EXISTS. At the call, like the SDK: an
       update needs at least one field and a Timestamp precondition; the field/value varargs form is not modelled and is
       refused rather than misread. */
    batch: () => {
      const ops = [];
      const self = {
        set: (ref, d) => { ops.push(() => put(ref.path, d)); return self; },
        create: (ref, d) => {
          ops.push(() => {
            if (docs.has(ref.path)) { const e = new Error(`6 ALREADY_EXISTS: entity already exists: path=/${ref.path}`); e.code = 6; throw e; }
            put(ref.path, d);
          });
          return self;
        },
        update: (ref, data, ...rest) => {
          if (typeof data === 'string' || rest.length > 1) throw new TypeError('firestore-fake: batch.update(ref, field, value, …) — the field/value form is not modelled');
          if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) throw new Error('firestore-fake: batch.update needs at least one field to update (as the SDK)');
          const opts = rest[0];
          if (opts && opts.lastUpdateTime !== undefined && !(opts.lastUpdateTime instanceof Timestamp)) throw new TypeError('firestore-fake: update() precondition lastUpdateTime must be a Timestamp');
          ops.push(() => updateNow(ref.path, data, opts));
          return self;
        },
        delete: (ref) => { ops.push(() => { docs.delete(ref.path); }); return self; },
        commit: async () => {
          const before = new Map(docs);
          pinned = tick();
          try {
            for (const op of ops) op();
            return ops.map(() => ({ writeTime: pinned }));
          } catch (e) {
            docs.clear(); for (const [k, v] of before) docs.set(k, v);
            throw e;
          } finally { pinned = null; }
        },
      };
      return self;
    },
    runTransaction: async (fn) => fn({
      get: (ref) => ref.get(),      // a query ref answers .get() too — see colRef's query()
      set: (ref, d) => { put(ref.path, d); },
      /* 🔴 ADDED BECAUSE THE DOUBLE WAS LAXER THAN FIRESTORE. A real transaction has update(), with
         DOTTED PATHS that write a nested field without replacing its parent — which is exactly how
         Slice D transitions an activation record's status without clobbering the base_generation and
         attempt beside it. The fake offered only set(), so production code using update() failed with
         "tx.update is not a function" in unit tests while working in the emulator: a double that
         cannot express a real operation silently narrows what the tests can cover. Missing-document
         behaviour mirrors Firestore's, which REFUSES rather than creating. */
      update: (ref, patch) => {
        const held = docs.get(ref.path);
        if (held === undefined) throw new Error(`fake_update_missing_doc: ${ref.path} — Firestore's update() refuses a document that does not exist`);
        // 🔴 the STORED SHAPE is { data, updateTime }; the document is `held.data`. Treating the
        // wrapper as the document re-wraps it on write and corrupts every field.
        const next = JSON.parse(JSON.stringify(held.data || {}));
        for (const [k, v] of Object.entries(patch || {})) {
          if (!k.includes('.')) { next[k] = v; continue; }
          const parts = k.split('.');
          let node = next;
          for (let i = 0; i < parts.length - 1; i++) {
            if (node[parts[i]] === undefined || node[parts[i]] === null || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
            node = node[parts[i]];
          }
          node[parts[parts.length - 1]] = v;
        }
        put(ref.path, next);
      },
      /* 1D D4-c2a — a real transaction has create(), and the activation/certification evidence uses it. Same
         refusal as Firestore: a document that already exists is ALREADY_EXISTS (gRPC code 6), naming the path. One
         stated difference: Firestore refuses at COMMIT, this double at the call — the callback aborts either way. */
      create: (ref, d) => {
        if (docs.has(ref.path)) {
          const e = new Error(`6 ALREADY_EXISTS: entity already exists: path=/${ref.path}`);
          e.code = 6; e.details = `entity already exists: path=/${ref.path}`;
          throw e;
        }
        put(ref.path, d);
      },
      delete: (ref) => { docs.delete(ref.path); },
    }),
    _raw: docs,
  };
}

module.exports = { makeDb };
