// Stats S2 — REAL → REAL: the S1 server's actual responses, through the wire, into the portal's actual
// Ventas page. Run: node xpizza-functions/stats/stats-portal-composition.test.mjs
//
// Why this exists (compose-the-real-pieces): the portal's ventas-logic tests prove the view model against
// its OWN reading of the contract, and stats-api.test.js proves the server against ITS contract. Two halves
// green against their own contracts leave the WIRE untested — a renamed field (sales_cents → sale_cents),
// a moved delta, a CSV column added on the server, and both suites still pass while the page shows "—".
// Here nothing is hand-built on either side:
//   orders  ← stats-fixtures.js (originated from the real createOrder / materialize writers)
//   rollup  ← stats-job.js runStatsRollup (the real nightly job) into the Firestore fake
//   answers ← stats-api.js getSalesStatsCore (the real handler core), wrapped exactly as index.js does
//   page    ← xpizza-portal/ventas.js + ventas-logic.js + api.js (real; only auth.js is stubbed)
// and the assertions read what the page RENDERED and what it SAVED, against the server's own numbers.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const PORTAL = join(HERE, '..', '..', 'xpizza-portal');

// 🔴 A SUITE THAT STOPS EARLY MUST NOT EXIT 0 (an awaited promise that never settles drains the loop).
let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 suite exited before finishing (an awaited promise never settled)'); process.exit(1); } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const T = require('./stats-time');
const J = require('./stats-job');
const A = require('./stats-api');
const F = require('./stats-fixtures');
const { makeRtdb } = require('./stats-rtdb-fake');
const { makeDb } = require('../catalog/firestore-fake');
const { makeCustomerKeyer } = require('./stats-identity');
const { authorizeCatalogEdit } = require('../catalog/catalog-edit-auth');

const H = await import(pathToFileURL(join(PORTAL, 'ventas-harness.mjs')).href);
const L = await import(pathToFileURL(join(PORTAL, 'ventas-logic.js')).href);

const keyer = makeCustomerKeyer('s'.repeat(40));
const TODAY = '2026-10-20';
const NOW = T.dayStartMs(TODAY) + 15 * 3600000;   // 15:00 Honduras
const at = (date, h, m = 0) => T.dayStartMs(date) + h * 3600000 + m * 60000;

// ── the world ───────────────────────────────────────────────────────────────────────────────────
const orders = {};
const add = (o) => { orders[o.order_id] = o; return o; };
// this week (14–20) — the page's default "Últimos 7 días" — and the week before (7–13) for the deltas
add(F.deliver(F.pickup(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-14', 19), phone: '88880001', totalCents: 31000, items: [{ name: 'Pepperoni 12″', qty: 2, unit: 155 }] }), at('2026-10-14', 19, 20)), at('2026-10-14', 19, 45)));
add(F.cashOrder({ rid: 'r_a', pm: 'card_delivery', now: at('2026-10-15', 13), phone: '88880002', totalCents: 18000, items: [{ name: 'Margherita 12″', qty: 1, unit: 180 }] }));
add(F.cashOrder({ rid: 'r_a', pm: 'cash', orderType: 'pickup', now: at('2026-10-17', 20), phone: '88880001', totalCents: 9000, items: [{ name: 'Pan de ajo', qty: 3, unit: 30 }] }));
add(F.cancel(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-16', 12), phone: '88880003', totalCents: 4000 })));
add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-10-08', 19), phone: '88880005', totalCents: 20000, items: [{ name: 'Pepperoni 12″', qty: 1, unit: 200 }] }));
add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at(TODAY, 11), phone: '88880009', totalCents: 15000, items: [{ name: 'Margherita 12″', qty: 1, unit: 150 }] }));   // live today
add(F.cashOrder({ rid: 'r_a', pm: 'cash', orderType: 'pickup', now: at('2026-10-16', 18), phone: '', totalCents: 25000, items: [{ name: 'Carnívora 18″', qty: 1, unit: 250 }] }));   // no phone: an anonymous Sale
add(F.cashOrder({ rid: 'r_b', pm: 'cash', now: at('2026-10-15', 12), phone: '88880001', totalCents: 99900 }));   // another merchant: must not appear
const fsdb = makeDb();
const rtdb = makeRtdb(orders);
await J.runStatsRollup({ rtdb, fsdb, keyer, listRestaurants: async () => ['r_a', 'r_b'], log: () => {} }, { nowMs: NOW, mode: 'range', from: '2026-10-01', to: '2026-10-19', commit: true });

// ── the server, wrapped exactly as index.js exports.getSalesStats does ──────────────────────────
// PLAN-portal-membership r3: owners in the membership model (brand_members + a valid legacy brand record)
const legacyBrand = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
const MEMBERS = new Map([['brands/r_a', legacyBrand('r_a')], ['brands/r_b', legacyBrand('r_b')],
  ['brand_members/r_a/owners/uA', { granted_at: 1, granted_by: 'x' }], ['brand_members/r_b/owners/uB', { granted_at: 1, granted_by: 'x' }]]);
const memberDb = { ref: (p) => ({ once: async () => { const v = MEMBERS.has(p) ? MEMBERS.get(p) : null; return { exists: () => v !== null, val: () => v }; } }) };
const TOKENS = { 'TK-test': { uid: 'uA' } };
const liveCache = A.makeLiveCache();
const served = [];
async function serve(url, opts) {
  const u = new URL(String(url));
  const fn = u.pathname.split('/').pop();
  assert.strictEqual(fn, 'getSalesStats', `the page only calls getSalesStats here (got ${fn})`);
  const query = Object.fromEntries(u.searchParams);
  const authz = (opts && opts.headers && opts.headers.Authorization) || '';
  const req = { method: 'GET', query, get: (h) => (h.toLowerCase() === 'authorization' ? authz : undefined) };
  const out = await A.getSalesStatsCore({
    authorize: (rid) => authorizeCatalogEdit({ db: memberDb, verifyIdToken: async (t) => { if (!TOKENS[t]) throw new Error('bad'); return TOKENS[t]; } }, req, rid),
    fsdb, rtdb, getKeyer: () => keyer, nowMs: NOW, liveCache,
  }, req);
  served.push({ query, out });
  // index.js: CSV → Content-Type, Content-Disposition (filename), out.headers (X-Next-Cursor), text body; else JSON
  const headers = new Map();
  if (out.contentType) {
    if (out.filename) headers.set('content-disposition', `attachment; filename="${out.filename}"`);
    for (const [k, v] of Object.entries(out.headers || {})) headers.set(k.toLowerCase(), v);
  }
  const text = out.contentType ? out.body : JSON.stringify(out.body);
  return { ok: out.status >= 200 && out.status < 300, status: out.status, text: async () => text, json: async () => JSON.parse(text), headers: { get: (h) => headers.get(h.toLowerCase()) || null } };
}

// The page's clock is pinned to the server's for EVERY module the page loads, however it is loaded (ventas.js, and what it
// imports — ventas-tab.js computes the period, rend-data.js …): the global Date itself, frozen at NOW — never a per-module
// rewrite (a hand-kept module list let ventas-tab.js read the real clock and ask a server living on TODAY for a future day).
const RealDate = Date;
globalThis.Date = class PinnedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };

const byId = H.installDom();
const dl = H.captureDownloads();
globalThis.fetch = serve;
byId.get('shopname').textContent = 'X. Pizza';
await H.loadModules(['ventas']);
document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uA' } }));
document.dispatchEvent(new CustomEvent('portal:restaurant', { detail: { rid: 'r_a' } }));
byId.get('navventas').click();
await H.settle(30);

// 1. the page asked the real server for the default period, and the real answer carries what the page reads (the WIRE half)
// The cell's DOM half read the RETIRED Ventas page (ventas.js handed it to ventas-tab.js, c27397ed6); none of its classes exist
// in any page now. Each retired read → the Rendimiento cell that composes the SAME real server answer today (advisor 11-15):
//   vkval  (Ventas · Pedidos · Ticket promedio = the server's kpis) → xpizza-portal/rend-data.test.mjs:217 (exact values from the
//          REAL body) + xpizza-portal/ventas-tab.test.mjs:47 (the three figures on the page)
//   vdl    (deltas = the server's)                                  → xpizza-portal/ventas-tab.test.mjs:236 (the comparison line
//          from the REAL deltas, exact)
//   viname (top products, the server's order)                      → xpizza-portal/rend-data.test.mjs:217 (ranked by sales, exact)
//   «Actualizado: en vivo.» (freshness from days[].computed_at)    → xpizza-portal/rend-data.test.mjs:197 + ventas-tab.test.mjs:246
//   r_b's sale nowhere on r_a's page                               → xpizza-functions/stats/stats-api.test.js:149 (cell 4: r_a's
//          kpis exact in a world holding r_b's L 999 — the server scopes by restaurantId; the page renders only that answer)
//   vhc / vth (the Mon–Sun × hours grid) + «pico:»                 → xpizza-portal/ventas-tab.test.mjs:246 (7 day rows, the peak
//          sentence) · NOT carried: the full-grid count 7 × hours (that cell pins the 7 day rows, not the vd-hc cells per vd-hh hour)
//   vbig   (delivery / pickup share of ALL sales)                  → xpizza-portal/ventas-tab.test.mjs:246 (the «· N %» rows) ·
//          NOT carried: the exact share value against the server's cents (no Rendimiento cell pins it — reported to the advisor)
//   vcsub / vcnote (customer shares «de las ventas», «Sin clasificar») → xpizza-portal/ventas-tab.test.mjs:246 (Nuevos /
//          Recurrentes rows) · NOT carried: the exact shares and the remainder note of rend-logic.js:212-213 (reported likewise)
{
  const json = served.find((s) => !s.query.format);
  assert.ok(json, 'non-vacuity: the page requested the stats');
  assert.strictEqual(json.query.to, TODAY, 'non-vacuity: the page asked for the PINNED today (a module reading the real clock escapes the pin)');
  assert.strictEqual(json.out.status, 200);
  // the approved Rendimiento default: the two weeks ending today, no comparison
  assert.deepStrictEqual([json.query.from, json.query.to, json.query.compare], [T.addDays(TODAY, -13), TODAY, 'none']);
  const b = json.out.body;
  assert.ok(b.kpis.orders >= 4 && b.kpis.sales_cents > 0, 'non-vacuity: the world has sales in the period');
  assert.ok(b.customers.anonymous_orders >= 1, 'non-vacuity: the period has an anonymous Sale');
  ok('JSON: the page asks the PINNED today for the approved default (two weeks, no comparison); the real server answers it');
}

// 2. both CSV kinds: the real server header passes the portal allowlist, and the saved file IS the server body
{
  // the exports live on «Más detalle» → «Descargar» (Rendimiento V3b): the same two server kinds, clicked as the owner does
  const host = byId.get('viewventas');
  H.byClass(host, 'vd-more')[0].click();
  await H.settle(60);
  const link = (title) => { const row = H.byClass(host, 'vd-file').find((r) => H.textOf(H.byClass(r, 'vd-fileb')[0]) === title); assert.ok(row, `the «${title}» export is offered`); return H.byClass(row, 'vd-lnk')[0]; };
  link('Resumen diario (CSV)').click();
  await H.settle(30);
  link('Pedidos (CSV)').click();
  await H.settle(30);
  await dl.read();
  const csvServed = served.filter((s) => s.query.format === 'csv');
  assert.deepStrictEqual(csvServed.map((s) => s.query.kind), ['daily', 'orders']);
  for (const s of csvServed) assert.strictEqual(s.out.status, 200, `${s.query.kind}: served`);
  assert.strictEqual(dl.saved.length, 2, '🔴 both real CSVs passed the allowlist and were saved — the allowlist matches the server');
  // owner decision 2026-10-06: a UTF-8 BOM leads each download (Excel accents); the server is unchanged
  const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
  assert.ok(!csvServed[0].out.body.startsWith('\uFEFF') && !csvServed[1].out.body.startsWith('\uFEFF'), 'premise: the server sends no BOM');
  assert.ok(dl.saved[0].bytes.equals(Buffer.concat([BOM, Buffer.from(csvServed[0].out.body, 'utf8')])), 'daily: BOM + the server bytes, exactly');
  assert.ok(dl.saved[1].bytes.equals(Buffer.concat([BOM, Buffer.from(csvServed[1].out.body, 'utf8')])), 'orders (one page): BOM + the server bytes, exactly');
  assert.ok(/Pepperoni 12″|Pan de ajo/.test(dl.saved[1].bytes.subarray(3).toString('utf8')), 'non-vacuity: non-ASCII item names survive in UTF-8');
  assert.strictEqual(dl.saved[0].name, csvServed[0].out.filename);
  assert.strictEqual(dl.saved[1].name, csvServed[1].out.filename);
  assert.deepStrictEqual(L.CSV_HEADERS.orders, A.ORDER_COLUMNS, 'the portal\'s orders allowlist IS the server\'s ORDER_COLUMNS');
  assert.ok(dl.saved[1].bytes.subarray(3).toString('utf8').split('\r\n').length - 2 >= 4, 'non-vacuity: the orders file has rows');
  ok('CSV: the real daily + orders headers pass the portal allowlist; saved bytes == BOM + server bytes');
}

// 3. a REAL non-owner answer (the server's 403 not_owner, staff token) renders the owner-only message
{
  MEMBERS.set('restaurants/r_a/kitchen_staff/sA', true);
  TOKENS['TK-staff'] = { uid: 'sA' };
  const res = await serve('https://x/getSalesStats?restaurantId=r_a&from=2026-10-14&to=2026-10-20', { headers: { Authorization: 'Bearer TK-staff' } });
  assert.strictEqual(res.status, 403);
  const body = await res.json();
  assert.strictEqual(body.error, 'not_owner');
  const api = await import(pathToFileURL(join(PORTAL, 'api.js')).href);
  let err = null;
  try { await api.readResponse(res); } catch (e) { err = e; }
  assert.ok(err && err.kind === 'NotAuthorized' && err.code === 'not_owner', 'the portal\'s reader types the real 403');
  assert.strictEqual(L.ventasMessage(err.kind, err.code)[0], 'Solo el dueño ve las ventas');
  ok('the server\'s real not_owner refusal → the portal\'s owner-only sentence');
}

dl.restore();
__finished = true;
console.log(`stats-portal-composition: ${n} cells passed`);
process.exit(0);
