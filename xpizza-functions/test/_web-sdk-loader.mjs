// TRACKER FIXES (BUILD-tracker-fixes r1.1 §3.1) — test-only loader for a site's REAL client SDK (xpizza-driver, xpizza-dispatch,
// xpizza-dispatch-mobile) against the RTDB EMULATOR, under PRODUCTION rules. Generalised from F2's KDS loader.
//
//   - Every module of the site's graph (the SDK and its sibling ./x.js modules, recursively) is copied into a temp dir with its
//     gstatic CDN imports rewritten to local shims and its sibling imports rewritten to the copied files.
//   - firebase-database → the npm Web SDK, connected to the emulator with mockUserToken auth: REAL reads, queries, transactions
//     and atomic multi-path updates; rules enforced. Writers are INSTRUMENTED: hooks.beforeWrite(op) runs before the write is
//     issued and hooks.afterWrite(op, result) after it is acknowledged (the runner uses these for write-sourced event capture).
//   - firebase-auth → a signed-in stub whose currentUser.uid equals the emulator auth uid (no auth emulator needed).
//   - firebase-functions → httpsCallable routed to opts.callables[name]({data, auth}) (the runner supplies real handlers).
// Each load() is an independent client (its own app → its own connection).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FN = path.join(here, '..');
const REPO = path.join(FN, '..');
const CDN = /https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-(app|auth|database|functions)\.js/g;
const SIBLING = /(from\s*|import\s*\(\s*)(['"])(\.\/[\w.-]+\.js)(\?[^'"]*)?\2/g;

// opts.root: the repository root whose site SDK + node_modules are loaded (default: this checkout). The tracker golden passes a
// BASELINE worktree root so a baseline capture never imports candidate site code or SDK versions.
// opts.ns: the RTDB namespace (default `project`). Pass the Admin app's namespace (e.g. 'xpizza-delivery-default-rtdb') when the
// clients must share a database with index.js's triggers — the emulator keeps namespaces separate.
export function makeWebSdkLoader({ project, site, uid, claims = {}, callables = {}, hooks = {}, root = REPO, ns = project }) {
  if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) throw new Error('_web-sdk-loader: FIREBASE_DATABASE_EMULATOR_HOST not set');
  const [host, port] = process.env.FIREBASE_DATABASE_EMULATOR_HOST.split(':');
  const SITE = path.join(root, site);
  const FNR = path.join(root, 'xpizza-functions');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `websdk-${site}-`));
  const npm = (p) => pathToFileURL(path.join(FNR, 'node_modules', 'firebase', p, 'dist', 'index.mjs')).href;
  const reg = `__websdk_${Math.random().toString(36).slice(2)}`;
  globalThis[reg] = { hooks, callables, uid, claims };

  fs.writeFileSync(path.join(tmp, 'app.mjs'), `export * from '${npm('app')}';\n`);
  fs.writeFileSync(path.join(tmp, 'database.mjs'), `export * from '${npm('database')}';
import * as D from '${npm('database')}';
const R = globalThis['${reg}'];
const op = async (kind, r, value, run) => {
  const o = { kind, path: r.toString().replace(/^[a-z]+:\\/\\/[^/]+\\/?/, '').split('?')[0], value };
  if (R.hooks.beforeWrite) await R.hooks.beforeWrite(o);
  const res = await run();
  if (R.hooks.afterWrite) await R.hooks.afterWrite(o, res);
  return res;
};
export function set(r, v) { return op('set', r, v, () => D.set(r, v)); }
export function update(r, v) { return op('update', r, v, () => D.update(r, v)); }
export function remove(r) { return op('remove', r, null, () => D.remove(r)); }
export function push(r, v) { return op('push', r, v, () => D.push(r, v)); }
export function runTransaction(r, f, o) { return op('transaction', r, f, () => D.runTransaction(r, f, o)); }
export function getDatabase(app) {
  const d = D.getDatabase(app);
  if (!d.__emu) { D.connectDatabaseEmulator(d, '${host}', ${Number(port)}, { mockUserToken: { sub: R.uid, user_id: R.uid, ...R.claims } }); d.__emu = true; }
  return d;
}
`);
  fs.writeFileSync(path.join(tmp, 'auth.mjs'), `const R = globalThis['${reg}'];
const user = { uid: R.uid, getIdToken: async () => 'emulator-token' };
export function getAuth() { return { currentUser: user }; }
export function signInWithEmailAndPassword() { return Promise.resolve({ user }); }
export function sendPasswordResetEmail() { return Promise.resolve(); }
export function signOut() { return Promise.resolve(); }
export function onAuthStateChanged(_a, cb) { if (typeof cb === 'function') setTimeout(() => cb(user), 0); return () => {}; }
`);
  fs.writeFileSync(path.join(tmp, 'functions.mjs'), `const R = globalThis['${reg}'];
export function getFunctions() { return {}; }
export function httpsCallable(_f, name) {
  return async (data) => {
    const h = R.callables[name];
    if (!h) throw new Error('_web-sdk-loader: no callable handler for ' + name);
    return { data: await h({ data, auth: { uid: R.uid, token: { uid: R.uid, ...R.claims } } }) };
  };
}
`);
  const shim = { app: 'app.mjs', auth: 'auth.mjs', database: 'database.mjs', functions: 'functions.mjs' };
  const copied = new Map();   // original abs path → tmp abs path
  let k = 0;
  function copyModule(abs) {
    if (copied.has(abs)) return copied.get(abs);
    const out = path.join(tmp, `m${++k}-${path.basename(abs)}`);
    copied.set(abs, out);
    let src = fs.readFileSync(abs, 'utf8');
    src = src.replace(CDN, (_m, which) => pathToFileURL(path.join(tmp, shim[which])).href);
    src = src.replace(SIBLING, (_m, pre, q, rel) => `${pre}${q}${pathToFileURL(copyModule(path.join(path.dirname(abs), rel))).href}${q}`);
    fs.writeFileSync(out, src);
    return out;
  }

  // The RTDB emulator applies firebase.json's rules ONLY to the project's default namespace (`${project}-default-rtdb`); any other
  // namespace — including index.js's Admin one — is OPEN. So before the first client connects, the PRODUCTION rules are loaded
  // into `ns` explicitly (fail closed: a rejected load throws, never a silently permissive run).
  let rulesLoaded = null;
  const loadRules = () => (rulesLoaded = rulesLoaded || (async () => {
    const rules = fs.readFileSync(path.join(root, 'xpizza-reference', 'database.rules.json'), 'utf8');
    const r = await fetch(`http://${host}:${port}/.settings/rules.json?ns=${ns}`, { method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: rules });
    if (!r.ok) throw new Error(`_web-sdk-loader: loading the production rules into ns=${ns} failed (${r.status})`);
  })());

  let n = 0;
  async function load({ hostname = 'test.example', config = {} } = {}) {
    await loadRules();
    if (!globalThis.window) globalThis.window = globalThis;   // native-location.js probes window.Capacitor (absent → PWA path)
    globalThis.location = { hostname };
    const entry = copyModule(path.join(SITE, 'xpizza-delivery.js'));
    // a fresh copy per load → an independent module instance (its own app/db); the graph's siblings are shared
    const inst = path.join(tmp, `entry-${++n}.mjs`);
    const src = fs.readFileSync(entry, 'utf8');
    if (!src.includes('app = initializeApp(firebaseConfig);')) throw new Error('_web-sdk-loader: initDelivery shape changed (initializeApp patch did not apply)');
    fs.writeFileSync(inst, src.replace('app = initializeApp(firebaseConfig);', `app = initializeApp(firebaseConfig, '${reg}-${n}');`));
    const XPD = await import(pathToFileURL(inst).href);
    XPD.initDelivery({ projectId: project, apiKey: 'x', databaseURL: `http://${host}:${port}?ns=${ns}`, ...config });
    return XPD;
  }
  const cleanup = () => { fs.rmSync(tmp, { recursive: true, force: true }); delete globalThis[reg]; };
  return { load, cleanup, tmp };
}
