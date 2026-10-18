// PLATFORM F2 Q2 — test-only loader for the REAL kitchen SDK (xpizza-kitchen/xpizza-delivery.js) against the RTDB emulator:
// its firebase CDN imports are rewritten to the npm firebase SDK (database connected to the emulator; query and onValue
// INSTRUMENTED — every query recorded, every listener counted while attached), auth stubbed. Each loadKds() is an independent
// client (its own firebase app → its own connection), so two calls are two devices.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FN = path.join(here, '..');
const KITCHEN = path.join(FN, '..', 'xpizza-kitchen');

// opts.kitchenDir: load the SDK from another kitchen folder (e.g. a git-archived past build); opts.mockUser: an authenticated
// emulator user ({ sub, … claims }) via connectDatabaseEmulator's mockUserToken (rules see auth.uid + auth.token).
export function makeKdsLoader(project, opts = {}) {
  const KDIR = opts.kitchenDir || KITCHEN;
  const [host, port] = process.env.FIREBASE_DATABASE_EMULATOR_HOST.split(':');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kds-sdk-'));
  const dbEntry = pathToFileURL(path.join(FN, 'node_modules', 'firebase', 'database', 'dist', 'index.mjs')).href;
  const appEntry = pathToFileURL(path.join(FN, 'node_modules', 'firebase', 'app', 'dist', 'index.mjs')).href;
  fs.writeFileSync(path.join(tmp, 'app.mjs'), `export * from '${appEntry}';\n`);
  fs.writeFileSync(path.join(tmp, 'database.mjs'), `export * from '${dbEntry}';
import { getDatabase as g, connectDatabaseEmulator, query as q0, onValue as on0, set as set0, update as update0, remove as remove0, runTransaction as tx0, push as push0 } from '${dbEntry}';
export const __WRITES = [];
export function set(r, v) { __WRITES.push(['set', r.toString()]); return set0(r, v); }
export function update(r, v) { __WRITES.push(['update', r.toString()]); return update0(r, v); }
export function remove(r) { __WRITES.push(['remove', r.toString()]); return remove0(r); }
export function runTransaction(r, f, o) { __WRITES.push(['transaction', r.toString()]); return tx0(r, f, o); }
export function push(r, v) { __WRITES.push(['push', r.toString()]); return push0(r, v); }
export const __QUERIES = [];
export const __LISTENERS = { active: 0, attached: 0, detached: 0, byPath: new Map() };
export function query(r, ...c) { __QUERIES.push({ path: r.toString(), constraints: c.map((x) => x.type || (x.constructor && x.constructor.name)) }); return q0(r, ...c); }
export function onValue(r, cb, err) {
  const key = r.toString(); const L = __LISTENERS;
  L.active += 1; L.attached += 1; L.byPath.set(key, (L.byPath.get(key) || 0) + 1);
  const un = on0(r, cb, err); let done = false;
  return () => { if (done) return; done = true; L.active -= 1; L.detached += 1; L.byPath.set(key, L.byPath.get(key) - 1); un(); };
}
export function getDatabase(app) { const d = g(app); if (!d.__emu) { connectDatabaseEmulator(d, '${host}', ${Number(port)}${opts.mockUser ? `, { mockUserToken: ${JSON.stringify(opts.mockUser)} }` : ''}); d.__emu = true; } return d; }
`);
  fs.writeFileSync(path.join(tmp, 'auth.mjs'), `export function getAuth() { return { currentUser: { uid: 'kds-device' } }; }
export function signInWithEmailAndPassword() { return Promise.resolve({ user: {} }); }
export function signOut() { return Promise.resolve(); }
export function onAuthStateChanged() { return () => {}; }
`);
  let k = 0;
  async function loadKds(hostname) {
    const appName = `kds-${project}-${++k}`;   // unique per loader AND project (a reused name would be a duplicate-app error)
    globalThis.location = { hostname };
    let sdk = fs.readFileSync(path.join(KDIR, 'xpizza-delivery.js'), 'utf8');
    sdk = sdk
      .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-app\.js/g, pathToFileURL(path.join(tmp, 'app.mjs')).href)
      .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-auth\.js/g, pathToFileURL(path.join(tmp, 'auth.mjs')).href)
      .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-database\.js/g, pathToFileURL(path.join(tmp, 'database.mjs')).href)
      .replace(/from '\.\/order-filter\.js'/g, `from '${pathToFileURL(path.join(KDIR, 'order-filter.js')).href}'`)
      .replace(/from '\.\/cancel-ack-set\.js'/g, `from '${pathToFileURL(path.join(KDIR, 'cancel-ack-set.js')).href}'`)
      .replace('app = initializeApp(firebaseConfig);', 'app = initializeApp(firebaseConfig, firebaseConfig.__appName);');
    const file = path.join(tmp, `${appName}.mjs`); fs.writeFileSync(file, sdk);
    const XPD = await import(pathToFileURL(file).href);
    XPD.initDelivery({ projectId: project, apiKey: 'x', databaseURL: `http://${host}:${port}?ns=${project}`, __appName: appName });
    return XPD;
  }
  const shim = () => import(pathToFileURL(path.join(tmp, 'database.mjs')).href);
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  return { loadKds, shim, cleanup };
}
