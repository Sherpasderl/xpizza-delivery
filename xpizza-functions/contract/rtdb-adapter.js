'use strict';
/* R3 §5a — THE STAFF-PAGE FIREBASE ADAPTER: the modular CDN APIs the pages import, implemented on firebase-admin against
 * the SAME emulator, one dedicated Admin connection PER PAGE (a page is its own client: it never sees the server
 * writers' optimistic local events, and its own writes are optimistic locally, as in a browser).
 *
 * Exported names = exactly what the pages and their xpizza-delivery.js copies import (census at 2cb5a1c):
 *   firebase-app       initializeApp
 *   firebase-database  getDatabase ref query orderByChild equalTo get onValue off set update remove runTransaction serverTimestamp
 *                      (+ child orderByKey orderByValue limitToFirst limitToLast startAt endAt endBefore startAfter push
 *                       onChildAdded onChildChanged onChildRemoved increment — supersets, harmless)
 *   firebase-auth      getAuth onAuthStateChanged signInWithEmailAndPassword signOut getIdToken sendPasswordResetEmail
 *   firebase-functions getFunctions httpsCallable  (routed to a host-supplied handler, else REFUSED loudly)
 * Page writes go through the Admin Reference prototype, so the §2b write gate sees them like any other write.
 *
 * BOOKKEEPING (§5a): every subscription is recorded { id, kind, path, query, delivered }; every delivered callback bumps
 * `delivered` and the page-wide sequence. barrier(): a marker written from a SEPARATE Admin connection, observed by an
 * adapter-internal listener on THIS page's connection — RTDB delivers server updates in commit order per connection, so
 * when the marker arrives every earlier ACKNOWLEDGED write has been delivered to the page's subscriptions. The barrier
 * never uses get() (a get on an actively listened query can be served from cache).
 */
const admin = require('firebase-admin');

let PAGE_SEQ = 0;
let BARRIER_APP = null;

function appFor(name, options = null) {
  try { return admin.app(name); } catch (_) { return admin.initializeApp({ ...admin.app().options, ...(options || {}) }, name); }
}

function createFirebaseHost({ pageId = `page${++PAGE_SEQ}`, user = { uid: 'staff_r3', email: 'staff@r3.test' }, claims = {}, callables = {}, fixture = (fn) => fn(), log = () => {}, options = null } = {}) {
  const app = appFor(`r3-${pageId}`, options);
  const db = app.database();
  const subs = []; let seq = 0; const getCalls = []; const callbackErrors = [];
  // codex r1 P1-5: adapter work IN FLIGHT — a page callback that returned a promise, an outstanding read / write
  let pendingWork = 0;
  const track = (p) => { if (!p || typeof p.then !== 'function') return p; pendingWork += 1; const done = () => { pendingWork -= 1; }; p.then(done, done); return p; };
  const SV = admin.database.ServerValue;

  // ── snapshots / refs (modular shapes over Admin compat objects) ──
  const wrapRef = (r) => r && ({
    __admin: r, key: r.key, get parent() { return wrapRef(r.parent); }, get root() { return wrapRef(r.root); },
    toString: () => r.toString(), toJSON: () => r.toString(), isEqual: (o) => !!o && o.__admin && o.__admin.isEqual(r),
  });
  const wrapSnap = (s) => s && ({
    key: s.key, get ref() { return wrapRef(s.ref); }, val: () => s.val(), exists: () => s.exists(), exportVal: () => s.exportVal(), toJSON: () => s.toJSON(),
    get size() { return s.numChildren(); }, get priority() { return s.getPriority(); },
    child: (p) => wrapSnap(s.child(p)), hasChild: (p) => s.hasChild(p), hasChildren: () => s.hasChildren(),
    forEach: (cb) => s.forEach((c) => cb(wrapSnap(c))),
  });
  const adminOf = (q) => (q && q.__admin) || null;
  const describe = (q) => (q && q.__desc) || (q && q.__admin ? { path: decodeURIComponent(new URL(q.__admin.toString()).pathname).replace(/^\/+/, ''), constraints: [] } : null);

  // ── constraints ──
  const C = (type, args) => ({ __constraint: true, type, args });
  function query(r, ...cs) {
    let q = adminOf(r);
    const desc = { ...describe(r), constraints: [...((describe(r) || {}).constraints || [])] };
    for (const c of cs) {
      if (!c || !c.__constraint || typeof q[c.type] !== 'function') throw new Error(`r3-adapter: unsupported query constraint ${c && c.type}`);
      q = q[c.type](...c.args); desc.constraints.push([c.type, ...c.args]);
    }
    return { __admin: q, __desc: desc, get ref() { return wrapRef(q.ref); } };
  }

  // ── subscriptions ──
  function subscribe(kind, q, cb, cancelCb, opts) {
    const a = adminOf(q);
    if (!a) throw new Error('r3-adapter: subscribe on a non-ref');
    const rec = { id: subs.length, kind, ...describe(q), delivered: 0, lastSeq: 0, active: true, cb, aq: a };
    subs.push(rec);
    // an exception thrown by the PAGE's callback is the page's error (a browser reports it and keeps running): recorded in
    // callbackErrors — which every page cell asserts empty — never rethrown into the SDK's event loop
    const guard = (fn) => {
      let r;
      try { r = fn(); } catch (e) { callbackErrors.push({ sub: rec.id, path: rec.path, error: String(e && e.stack || e).slice(0, 600) }); return; }
      if (r && typeof r.then === 'function') track(r.then(undefined, (e) => { callbackErrors.push({ sub: rec.id, path: rec.path, error: `async: ${String(e && e.stack || e).slice(0, 600)}` }); }));
    };
    const handler = kind === 'value'
      ? (s) => { rec.delivered += 1; rec.lastSeq = ++seq; guard(() => cb(wrapSnap(s))); }
      : (s, prev) => { rec.delivered += 1; rec.lastSeq = ++seq; guard(() => cb(wrapSnap(s), prev === undefined ? null : prev)); };
    const err = (e) => { rec.error = String(e && e.message || e); if (cancelCb) cancelCb(e); };
    if (opts && opts.onlyOnce) a.once(kind, handler, err);
    else a.on(kind, handler, err);
    rec.off = () => { if (rec.active) { a.off(kind, handler); rec.active = false; } };
    return rec.off;
  }
  // modular off(query, eventType?, callback?) — codex r1 P2: matches the QUERY (path + constraints), the event type when
  // given, and the page's CALLBACK identity when given; another query or callback on the same path keeps its listener
  function off(q, eventType, cb) {
    // codex r2 P2: SDK query EQUALITY (the Admin Query's isEqual) — the same normalization both client SDKs apply,
    // so an equivalent query built in another constraint order matches
    const target = adminOf(q);
    const sameQuery = (s) => !!(target && s.aq && s.aq.isEqual(target));
    for (const s of subs) if (s.active && sameQuery(s) && (!eventType || s.kind === eventType) && (!cb || s.cb === cb)) s.off();
  }

  const database = {
    getDatabase: () => ({ __r3db: true, app: { name: `r3-${pageId}` } }),
    ref: (_db, p) => { const r = p ? db.ref(p) : db.ref(); return { ...wrapRef(r), __desc: { path: String(p || '').replace(/^\/+/, ''), constraints: [] } }; },
    child: (r, p) => { const c = adminOf(r).child(p); return { ...wrapRef(c), __desc: { path: [describe(r).path, p].filter(Boolean).join('/'), constraints: [] } }; },
    query,
    orderByChild: (p) => C('orderByChild', [p]), orderByKey: () => C('orderByKey', []), orderByValue: () => C('orderByValue', []),
    equalTo: (v, k) => C('equalTo', k === undefined ? [v] : [v, k]), startAt: (v, k) => C('startAt', k === undefined ? [v] : [v, k]), endAt: (v, k) => C('endAt', k === undefined ? [v] : [v, k]),
    startAfter: (v, k) => C('startAfter', k === undefined ? [v] : [v, k]), endBefore: (v, k) => C('endBefore', k === undefined ? [v] : [v, k]),
    limitToFirst: (n) => C('limitToFirst', [n]), limitToLast: (n) => C('limitToLast', [n]),
    get: (q) => { getCalls.push(describe(q)); return track((async () => wrapSnap(await adminOf(q).get()))()); },
    onValue: (q, cb, cancelCb, opts) => { if (cancelCb && typeof cancelCb === 'object') { opts = cancelCb; cancelCb = undefined; } return subscribe('value', q, cb, cancelCb, opts); },
    onChildAdded: (q, cb, c, o) => subscribe('child_added', q, cb, c, o),
    onChildChanged: (q, cb, c, o) => subscribe('child_changed', q, cb, c, o),
    onChildRemoved: (q, cb, c, o) => subscribe('child_removed', q, cb, c, o),
    off,
    set: (r, v) => track(adminOf(r).set(v)),
    update: (r, v) => track(adminOf(r).update(v)),
    remove: (r) => track(adminOf(r).remove()),
    push: (r, v) => { const t = adminOf(r).push(v); const w = wrapRef(t); if (v !== undefined) { w.then = (a, b) => t.then((x) => wrapRef(x)).then(a, b); w.catch = (b) => t.catch(b); } return w; },
    runTransaction: (r, fn, opts) => track((async () => { const res = await adminOf(r).transaction(fn, undefined, opts && opts.applyLocally !== undefined ? opts.applyLocally : true); return { committed: res.committed, snapshot: wrapSnap(res.snapshot), toJSON: () => ({ committed: res.committed }) }; })()),
    serverTimestamp: () => SV.TIMESTAMP,
    increment: (n) => SV.increment(n),
  };

  // ── auth: a signed-in staff user ──
  const authUser = { uid: user.uid, email: user.email, getIdToken: async () => `r3-token:${user.uid}`, getIdTokenResult: async () => ({ token: `r3-token:${user.uid}`, claims: { ...claims } }) };
  const authObj = { currentUser: authUser };
  const auth = {
    getAuth: () => authObj,
    onAuthStateChanged: (_a, cb) => { setTimeout(() => cb(authObj.currentUser), 0); return () => {}; },
    signInWithEmailAndPassword: async () => { authObj.currentUser = authUser; return { user: authUser }; },
    signOut: async () => { authObj.currentUser = null; },
    getIdToken: async (u) => (u || authUser).getIdToken(),
    sendPasswordResetEmail: async () => {},
  };
  const functions = {
    getFunctions: () => ({ __r3fns: true }),
    httpsCallable: (_f, name) => async (data) => {
      if (!callables[name]) throw new Error(`r3-adapter: callable ${name} is not routed in this harness (REFUSED — never silently stubbed)`);
      return { data: await callables[name](data, { uid: user.uid }) };
    },
  };
  const appMod = { initializeApp: () => ({ name: `r3-${pageId}` }) };

  // ── §5a barrier ──
  let barrierN = 0; let seen = 0; const waiters = [];
  const bref = db.ref(`__r3_barrier__/${pageId}`);
  bref.on('child_added', (s) => { seen = Math.max(seen, Number(s.key)); while (waiters.length && waiters[0].n <= seen) waiters.shift().resolve(); });
  const barrierApp = options ? appFor(`r3-barrier-${options.databaseURL}`, options) : (BARRIER_APP || (BARRIER_APP = appFor('r3-barrier')));
  async function barrier() {
    const n = ++barrierN;
    const p = new Promise((resolve) => waiters.push({ n, resolve }));
    await fixture(() => barrierApp.database().ref(`__r3_barrier__/${pageId}/${n}`).set(true));   // acknowledged, from ANOTHER connection
    await p;                                                                                      // …and delivered on THIS one
    return n;
  }

  async function close() { for (const s of subs) s.off && s.off(); bref.off(); await app.delete(); }

  return { pageId, db, modules: { 'firebase-app': appMod, 'firebase-database': database, 'firebase-auth': auth, 'firebase-functions': functions },
    subs, getCalls, callbackErrors, barrier, seq: () => seq, inflight: () => pendingWork, close };
}

module.exports = { createFirebaseHost, appFor };
