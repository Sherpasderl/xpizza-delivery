/**
 * PLATFORM F2 Q2 (PLAN-F2-query-rules §2) — LIVE parity of the KDS feed. The REAL kitchen SDK (xpizza-kitchen/xpizza-delivery.js),
 * its firebase CDN imports rewritten to the npm firebase SDK connected to the RTDB emulator (auth stubbed; the rules here are
 * permissive — access is proven separately by test:f2-access-rules), runs under BOTH kitchen hosts (x_pizza, la_musa). After every
 * step of a legacy-provenance corpus — intake, scheduled → releasing → new, preparing, ready, out for delivery, delivered,
 * cancelled, plus a pending_payment order and a THIRD location (distinction only) — the module's subscribeToOrders and
 * subscribeScheduledOrders deliver EXACTLY what today's KDS showed: the pre-F2 filters (access/kds-filter-pre-f2.mjs) over a
 * whole-/orders read. Given census (a) = 0 (every order carries a legacy location) that is identity; the third location is the
 * one intended difference (the catch-all used to show it) and is asserted as such. Also: the feed is ONE query on restaurant_id.
 *   npm run test:kds-feed-parity
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
require('./_emulator-required')('database');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const here = path.dirname(fileURLToPath(import.meta.url));
const FN = path.join(here, '..');
const KITCHEN = path.join(FN, '..', 'xpizza-kitchen');
const PRE = await import(pathToFileURL(path.join(FN, 'access', 'kds-filter-pre-f2.mjs')).href);
const PROJECT = 'demo-kds-feed-parity';
const [host, port] = process.env.FIREBASE_DATABASE_EMULATOR_HOST.split(':');

// shims: the npm firebase SDK (database connected to the emulator), auth stubbed
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kds-parity-'));
const dbEntry = pathToFileURL(path.join(FN, 'node_modules', 'firebase', 'database', 'dist', 'index.mjs')).href;
const appEntry = pathToFileURL(path.join(FN, 'node_modules', 'firebase', 'app', 'dist', 'index.mjs')).href;
fs.writeFileSync(path.join(tmp, 'app.mjs'), `export * from '${appEntry}';\n`);
fs.writeFileSync(path.join(tmp, 'database.mjs'), `export * from '${dbEntry}';
import { getDatabase as g, connectDatabaseEmulator } from '${dbEntry}';
export const __QUERIES = [];
import { query as q0 } from '${dbEntry}';
export function query(r, ...c) { __QUERIES.push({ path: r.toString(), constraints: c.map((x) => x.type || (x.constructor && x.constructor.name)) }); return q0(r, ...c); }
export function getDatabase(app) { const d = g(app); if (!d.__emu) { connectDatabaseEmulator(d, '${host}', ${Number(port)}); d.__emu = true; } return d; }
`);
fs.writeFileSync(path.join(tmp, 'auth.mjs'), `export function getAuth() { return {}; }
export function signInWithEmailAndPassword() { return Promise.resolve({ user: {} }); }
export function signOut() { return Promise.resolve(); }
export function onAuthStateChanged() { return () => {}; }
`);
async function loadKds(hostname, appName) {
  globalThis.location = { hostname };
  let sdk = fs.readFileSync(path.join(KITCHEN, 'xpizza-delivery.js'), 'utf8');
  sdk = sdk
    .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-app\.js/g, pathToFileURL(path.join(tmp, 'app.mjs')).href)
    .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-auth\.js/g, pathToFileURL(path.join(tmp, 'auth.mjs')).href)
    .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-database\.js/g, pathToFileURL(path.join(tmp, 'database.mjs')).href)
    .replace(/from '\.\/order-filter\.js'/g, `from '${pathToFileURL(path.join(KITCHEN, 'order-filter.js')).href}'`)
    .replace(/from '\.\/cancel-ack-set\.js'/g, `from '${pathToFileURL(path.join(KITCHEN, 'cancel-ack-set.js')).href}'`)
    .replace('app = initializeApp(firebaseConfig);', 'app = initializeApp(firebaseConfig, firebaseConfig.__appName);');   // two KDS instances in one process
  const file = path.join(tmp, `kds-${appName}.mjs`); fs.writeFileSync(file, sdk);
  const XPD = await import(pathToFileURL(file).href);
  XPD.initDelivery({ projectId: PROJECT, apiKey: 'x', databaseURL: `http://${host}:${port}?ns=${PROJECT}`, __appName: appName });
  return XPD;
}

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const env = await initializeTestEnvironment({ projectId: PROJECT, database: { rules: JSON.stringify({ rules: { '.read': true, '.write': false } }) } });
const admin = (fn) => env.withSecurityRulesDisabled((ctx) => fn(ctx.database()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const kds = { x_pizza: await loadKds('xpizzakitchen.netlify.app', 'kx'), la_musa: await loadKds('lamusakitchendisplay.netlify.app', 'km') };
  const dbShim = await import(pathToFileURL(path.join(tmp, 'database.mjs')).href);
  assert.strictEqual(kds.x_pizza.KDS_RESTAURANT_ID, 'x_pizza'); assert.strictEqual(kds.la_musa.KDS_RESTAURANT_ID, 'la_musa');
  const got = {}; const unsubs = [];
  for (const [rid, X] of Object.entries(kds)) {
    got[rid] = { live: null, sched: null };
    unsubs.push(X.subscribeToOrders((m) => { got[rid].live = m; }), X.subscribeScheduledOrders((m) => { got[rid].sched = m; }));
  }
  const queries = dbShim.__QUERIES.filter((q) => /\/orders$/.test(q.path));
  assert.ok(queries.length >= 4 && queries.every((q) => q.constraints.length === 2), `every feed subscription is ONE query with two constraints on /orders (${JSON.stringify(queries)})`);
  ok('the real KDS module (both hosts) subscribes through ONE orders query — orderByChild + equalTo — for both views');

  const order = (id, rid, status, extra = {}) => ({ order_id: id, restaurant_id: rid, status, created_at: 1_800_000_000_000, items_text: '1x Pizza', ...extra });
  const STEPS = [
    ['intake (cash, both brands)', { 'orders/X1': order('X1', 'x_pizza', 'new'), 'orders/M1': order('M1', 'la_musa', 'new') }],
    ['online order awaiting payment', { 'orders/X2': order('X2', 'x_pizza', 'pending_payment', { payment_method: 'online' }) }],
    ['scheduled orders held', { 'orders/X3': order('X3', 'x_pizza', 'scheduled', { release_at: 1_800_000_900_000 }), 'orders/M2': order('M2', 'la_musa', 'scheduled', { release_at: 1 }) }],
    ['scheduled → releasing', { 'orders/X3/status': 'releasing' }],
    ['released → new; payment confirmed', { 'orders/X3/status': 'new', 'orders/X2/status': 'new' }],
    ['preparing', { 'orders/X1/status': 'preparing', 'orders/M1/status': 'preparing' }],
    ['ready', { 'orders/X1/status': 'ready' }],
    ['out for delivery', { 'orders/X1/status': 'out_for_delivery' }],
    ['delivered', { 'orders/X1/status': 'delivered', 'orders/X1/delivered_at': 1_800_000_600_000 }],
    ['cancelled', { 'orders/M1/status': 'cancelled' }],
    ['a THIRD location (distinction only)', { 'orders/T1': order('T1', 'tb_centro', 'new'), 'orders/T2': order('T2', 'tb_norte', 'scheduled') }],
    ['an order deleted', { 'orders/X2': null }],
  ];
  const keys = (m) => Object.keys(m || {}).sort();
  let thirdPresent = false;
  for (const [label, u] of STEPS) {
    await admin((db) => db.ref().update(u));
    await sleep(500);
    let all = {}; await admin(async (db) => { all = (await db.ref('orders').once('value')).val() || {}; });
    const third = label.startsWith('a THIRD');
    if (third) thirdPresent = true;   // once present, the third location stays the one intended difference
    for (const rid of Object.keys(kds)) {
      const todayLive = PRE.filterLiveOrders(all, rid); const todaySched = PRE.filterScheduledOrders(all, rid);
      // the intended difference: today's x_pizza catch-all also showed a third location; the exact feed does not
      const strip = (m) => Object.fromEntries(Object.entries(m).filter(([, o]) => o && (o.restaurant_id === 'x_pizza' || o.restaurant_id === 'la_musa')));
      const wantLive = thirdPresent ? strip(todayLive) : todayLive; const wantSched = thirdPresent ? strip(todaySched) : todaySched;
      assert.deepStrictEqual(got[rid].live, wantLive, `[${label}] ${rid} live view = today's (${JSON.stringify(keys(got[rid].live))} vs ${JSON.stringify(keys(wantLive))})`);
      assert.deepStrictEqual(got[rid].sched, wantSched, `[${label}] ${rid} Programados view = today's`);
      if (third && rid === 'x_pizza') assert.ok(keys(todayLive).includes('T1') && !keys(got[rid].live).includes('T1') && keys(todaySched).includes('T2') && !keys(got[rid].sched).includes('T2'), 'premise: today\'s catch-all showed the third location; the exact feed does not');
    }
  }
  ok(`${STEPS.length} lifecycle steps × both hosts × both views: the module's feed equals today's KDS (pre-F2 filters over the whole /orders) at every step; the only difference is the third location the old catch-all showed`);
  for (const u of unsubs) u();
} finally {
  await env.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`kds-feed-parity.emulator: OK (${n})`);
process.exit(0);
