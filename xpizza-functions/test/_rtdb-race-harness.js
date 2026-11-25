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
const EXPOSE = '\n;exports.__rtdbRaceHarness = { PersistentConnection: PersistentConnection };\n';

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

// one macrotask turn: the SDK's own connect timer (setTimeout 0 in scheduleConnect_) fires, then queued sends drain — no sleeps
const flush = () => new Promise((res) => setTimeout(() => setImmediate(res), 0));
let seq = 0;
// one independent Admin app = its own Repo + PersistentConnection + cache (§3.2: baseline / candidate never share a connection)
function client(label = 'c') {
  process.env.FIREBASE_DATABASE_EMULATOR_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST || '127.0.0.1:9';   // owner auth, no credential fetch; never dialled
  const { initializeApp } = require('firebase-admin/app');
  const { getDatabase } = require('firebase-admin/database');
  const app = initializeApp({ projectId: 'demo-rtdb-race', databaseURL: 'https://demo-rtdb-race.firebaseio.com' }, `rtdb-race-${label}-${++seq}`);
  const db = getDatabase(app);
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
    serve: async (at, { only = ['g', 'q', 'n', 'p', 'm'], max = 64 } = {}) => {
      for (let i = 0; i < max; i++) {
        const m = sent().find((x) => only.includes(x.a) && conn().requestCBHash_[x.r] && !x.__done);
        if (!m) return i;
        if (m.a === 'g') { m.__done = true; conn().onDataMessage_({ r: m.r, b: { s: 'ok', d: at(m.b.p) } }); }
        else if (m.a === 'q' && !m.__data) { m.__data = true; conn().onDataMessage_({ a: 'd', b: { p: m.b.p, d: at(m.b.p) } }); }
        else { m.__done = true; conn().onDataMessage_({ r: m.r, b: { s: 'ok', d: {} } }); }
        await flush();
      }
      throw new Error('rtdb-race-harness: serve() did not drain');
    },
    listens: () => { const out = []; for (const [p, m] of conn().listens) for (const q of m.keys()) out.push([p, q]); return out; },
    close: () => app.delete(),
  };
}

module.exports = { FILE, SHA256, INTERNALS, client, flush };
