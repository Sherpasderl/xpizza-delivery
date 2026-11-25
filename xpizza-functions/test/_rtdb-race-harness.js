'use strict';
// RTDB get()/listener race harness (PLAN-rtdb-get-once-race-r3 §4.1; Codex #387/#390 recipe). The REAL Admin-loaded standalone bundle —
// the exact file firebase-admin's lib/database/database.js requires ('@firebase/database-compat/standalone') — is compiled into
// require.cache under its own filename with ONE line appended that exports its internal PersistentConnection. firebase-admin then loads
// THIS module instance, so every query, cache, event registration and connection-listen entry is the SDK's own. Only the socket is
// replaced: establishConnection_ installs a captured wire and calls the SDK's own onReady_. Requests are recorded; responses and server
// pushes are delivered when a cell says so, through the SDK's own onDataMessage_. No network, no sleeps.
//   const H = require('./_rtdb-race-harness'); const c = H.client('baseline');
//   c.db.ref('x').get(); await H.flush(); c.pending('g') → [{ r, a, b }]; c.reply(req, data); c.push('x', data); c.listens() → [path, queryId][]
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const ADMIN_DB = require.resolve('firebase-admin/database');
const FILE = Module.createRequire(ADMIN_DB).resolve('@firebase/database-compat/standalone');
const SOURCE = fs.readFileSync(FILE, 'utf8');
const SHA256 = crypto.createHash('sha256').update(SOURCE).digest('hex');
const EXPOSE = '\n;exports.__rtdbRaceHarness = { PersistentConnection: PersistentConnection, nodeFromJSON: nodeFromJSON };\n';

function install() {
  const cached = require.cache[FILE];
  if (cached && cached.exports && cached.exports.__rtdbRaceHarness) return cached.exports.__rtdbRaceHarness;
  if (cached) throw new Error('rtdb-race-harness: the standalone bundle was loaded before the harness (require the harness first)');
  const m = new Module(FILE, module);
  m.filename = FILE;
  m.paths = Module._nodeModulePaths(path.dirname(FILE));
  m._compile(SOURCE + EXPOSE, FILE);
  m.loaded = true;
  require.cache[FILE] = m;
  const { PersistentConnection } = m.exports.__rtdbRaceHarness;
  // the socket, and only the socket: a captured wire, then the SDK's own onReady_ (connected_, restoreState_, onConnectStatus_)
  PersistentConnection.prototype.establishConnection_ = function () {
    const conn = this;
    if (!conn.__wire) conn.__wire = { sent: [] };
    conn.realtime_ = { sendRequest: (msg) => { conn.__wire.sent.push(msg); }, close() {} };
    conn.onReady_(Date.now(), 'harness');
    return Promise.resolve();
  };
  return m.exports.__rtdbRaceHarness;
}
const INTERNALS = install();

// NO NETWORK, EVER: the harness drives REAL handlers (index.js), some of which call out (PixelPay's hosted create uses fetch). Any outbound
// call from a process that loaded the harness fails closed here — a handler sees a transport failure, exactly its own error path.
const NET = [];
const refuse = (what) => { NET.push(what); return Promise.reject(Object.assign(new Error(`rtdb-race-harness: network disabled (${what})`), { code: 'ENETUNREACH' })); };
globalThis.fetch = (url) => refuse(`fetch ${String(url && url.url ? url.url : url).replace(/\?.*$/, '')}`);
for (const mod of ['http', 'https']) { const m = require(mod); m.request = (...a) => { const r = new (require('events'))(); process.nextTick(() => r.emit('error', Object.assign(new Error(`rtdb-race-harness: network disabled (${mod})`), { code: 'ENETUNREACH' }))); r.end = () => r; r.write = () => true; r.setTimeout = () => r; r.destroy = () => r; NET.push(`${mod}.request`); return r; }; m.get = m.request; }

// one macrotask turn: the SDK's own connect timer (setTimeout 0 in scheduleConnect_) fires, then queued sends drain — no sleeps
const flush = () => new Promise((res) => setTimeout(() => setImmediate(res), 0));
let seq = 0;
// one independent Admin app = its own Repo + PersistentConnection + cache (§3.2: baseline / candidate never share a connection)
const PROJECT = 'demo-rtdb-race';
const OPTIONS = { projectId: PROJECT, databaseURL: `https://${PROJECT}.firebaseio.com` };
function client(label = 'c') {
  process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9';   // owner auth, no credential fetch; never dialled
  const { initializeApp } = require('firebase-admin/app');
  const { getDatabase } = require('firebase-admin/database');
  const app = initializeApp(OPTIONS, `rtdb-race-${label}-${++seq}`);
  return wrap(app, getDatabase(app));
}
function wrap(app, db) {
  const conn = () => { const r = db._delegate && db._delegate._repo; const c = r && r.persistentConnection_; if (!c) throw new Error('rtdb-race-harness: no PersistentConnection yet (issue a read first)'); return c; };
  const sent = () => (conn().__wire ? conn().__wire.sent : []);
  return {
    app, db, conn,
    sent,
    pending: (a) => sent().filter((m) => m.a === a && conn().requestCBHash_[m.r]),
    reply: (msg, data, status = 'ok') => conn().onDataMessage_({ r: msg.r, b: { s: status, d: data } }),
    push: (p, data) => conn().onDataMessage_({ a: 'd', b: { p, d: data } }),
    // the server answers in REQUEST order, ONE frame per event turn — the production frame order. (Delivering every reply in one
    // synchronous burst HIDES the race: the listen's data lands before get()'s promise continuation runs.) A get is answered with
    // `at(path)`; a listen first with a data push of `at(path)`, then its ok; anything else with ok. `only` limits the actions served.
    serve: async (atOrStore, { only = ['g', 'q', 'n', 'p', 'm'], max = 64, until = null } = {}) => {   // until(sent) → true stops early (a cell issues its competitor there)
      const at = typeof atOrStore === 'function' ? atOrStore : atOrStore.at; const apply = typeof atOrStore === 'function' ? null : atOrStore.apply;
      for (let i = 0; i < max; i++) {
        if (until && until(sent())) return i;
        const m = sent().find((x) => only.includes(x.a) && conn().requestCBHash_[x.r] && !x.__done);
        if (!m) { if (until) { await flush(); continue; } return i; }   // with until: the helper may not have issued its read yet — wait a turn
        if (m.a === 'g') { m.__done = true; conn().onDataMessage_({ r: m.r, b: { s: 'ok', d: at(m.b.p) } }); }
        else if (m.a === 'q' && !m.__data) { m.__data = true; conn().onDataMessage_({ a: 'd', b: { p: m.b.p, d: at(m.b.p) } }); }
        else { m.__done = true; const st = apply && (m.a === 'p' || m.a === 'm') ? apply(m) : 'ok'; conn().onDataMessage_({ r: m.r, b: { s: st, d: st === 'ok' ? {} : 'stale' } }); }
        await flush();
      }
      throw new Error('rtdb-race-harness: serve() did not drain');
    },
    listens: () => { const out = []; for (const [p, m] of conn().listens) for (const q of m.keys()) out.push([p, q]); return out; },
    close: () => app.delete(),
  };
}

// a stateful server tree for serve(): reads at a path; 'p' (set / a transaction's conditional put — the hash is not modelled: every put
// lands, as the first attempt of an uncontended transaction does) and 'm' (merge) update it. store.at is serve()'s reader.
function store(tree = {}) {
  const root = { v: JSON.parse(JSON.stringify(tree)) };
  const parts = (p) => String(p).split('/').filter(Boolean);
  const at = (p) => { let o = root.v; for (const k of parts(p)) { if (o == null || typeof o !== 'object') return null; o = o[k]; } return o === undefined ? null : JSON.parse(JSON.stringify(o)); };
  const put = (p, d) => { const ks = parts(p); if (!ks.length) { root.v = d; return; } let o = root.v && typeof root.v === 'object' ? root.v : (root.v = {}); for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (d == null) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = JSON.parse(JSON.stringify(d)); };
  const writes = [];
  // a conditional put (a transaction's, carrying h = the hash of the value its callback saw) lands only when h matches the server's
  // current value — the server's own compare-and-set; otherwise 'datastale' and the SDK retries on the server value (as in production)
  const apply = (m) => {
    if (m.a === 'p') {
      if (m.b.h != null && INTERNALS.nodeFromJSON(at(m.b.p)).hash() !== m.b.h) { writes.push({ a: 'p', p: m.b.p, stale: true }); return 'datastale'; }
      put(m.b.p, m.b.d); writes.push({ a: 'p', p: m.b.p }); return 'ok';
    }
    if (m.a === 'm') { for (const [k, v] of Object.entries(m.b.d || {})) put(`${m.b.p}/${k}`, v); writes.push({ a: 'm', p: m.b.p }); }
    return 'ok';
  };
  return { at, put, apply, writes, tree: () => root.v };
}

// index.js on the harness: the DEFAULT app is this harness's (lib/admin.js — index.js's only initializeApp — is pre-cached as a no-op),
// so every inline getDatabase() read in a REAL exported handler runs on the controlled wire. Auth runs in the Admin SDK's emulator mode
// (unsigned test ID tokens, idToken(); verifyIdToken decodes them on this app only); nothing is ever dialled. Loaded once per process: cells use distinct keys.
// firestore: a catalog/firestore-fake instance (makeDb()) that getFirestore() returns for index.js and every module it loads — the money
// handlers' catalog / pricing / gate steps run on it, seeded by the REAL writers (publishVersion …). FieldValue / Timestamp stay real.
let INDEX = null;
function indexApp({ firestore = null } = {}) {
  if (INDEX) { if (firestore && INDEX.firestore !== firestore) throw new Error('rtdb-race-harness: indexApp() already loaded with another Firestore'); return INDEX; }
  if (firestore) {
    const fsFile = require.resolve('firebase-admin/firestore');
    if (require.cache[fsFile] && require.cache[fsFile].__rtdbRace !== true && require.cache[require.resolve('../index.js')]) throw new Error('rtdb-race-harness: index.js already loaded');
    const real = require('firebase-admin/firestore');
    const fm = new Module(fsFile, module); fm.filename = fsFile; fm.loaded = true; fm.__rtdbRace = true;
    fm.exports = { ...real, getFirestore: () => firestore };
    require.cache[fsFile] = fm;
  }
  process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9';
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || PROJECT;
  const { initializeApp } = require('firebase-admin/app');
  const { getDatabase } = require('firebase-admin/database');
  const app = initializeApp(OPTIONS);
  const adminFile = require.resolve('../lib/admin.js');
  if (require.cache[adminFile]) throw new Error('rtdb-race-harness: lib/admin.js already loaded (require the harness first)');
  const m = new Module(adminFile, module); m.filename = adminFile; m.loaded = true; m.exports = {}; require.cache[adminFile] = m;
  // identity: getAuth() is one Auth instance per app, so its verifyIdToken is replaced ON THIS APP ONLY by a decode of the test token
  // (idToken() below). Only the transport to Google is skipped: the handlers' own claim checks (customer === true, uid) run unchanged,
  // and an expired or foreign-audience token is refused exactly as the SDK refuses it.
  const auth = require('firebase-admin/auth').getAuth(app);
  auth.verifyIdToken = async (t) => {
    const p = JSON.parse(Buffer.from(String(t).split('.')[1] || '', 'base64url').toString('utf8') || 'null');
    if (!p || p.aud !== PROJECT || p.iss !== `https://securetoken.google.com/${PROJECT}` || !(p.exp > Date.now() / 1000) || !p.sub) throw Object.assign(new Error('invalid'), { code: 'auth/argument-error' });
    return { ...p, uid: p.sub };
  };
  const idx = require('../index.js');
  INDEX = { ...wrap(app, getDatabase(app)), idx, firestore };
  return INDEX;
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(uid, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid, iat: now, auth_time: now, exp: now + 3600, ...claims })}.`;
}
// a REAL exported onRequest handler, called with a minimal req / res → { status, body }
function call(handler, { method = 'POST', headers = {}, body = {} } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return new Promise((resolve, reject) => {
    const res = { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; }, setHeader(k, v) { this.headers[k] = v; },
      getHeader(k) { return this.headers[k]; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; }, send(b) { resolve({ status: this.statusCode, body: b }); return this; },
      end(b) { resolve({ status: this.statusCode, body: b }); return this; }, on() { return this; } };
    const req = { method, headers: h, body, get: (k) => h[String(k).toLowerCase()], header: (k) => h[String(k).toLowerCase()], ip: '10.0.0.1', url: '/', path: '/', query: {}, rawBody: Buffer.from(JSON.stringify(body)) };
    Promise.resolve().then(() => handler(req, res)).catch(reject);
  });
}

module.exports = { FILE, SHA256, INTERNALS, client, flush, store, indexApp, idToken, call, NET };
