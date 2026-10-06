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
add(F.cashOrder({ rid: 'r_b', pm: 'cash', now: at('2026-10-15', 12), phone: '88880001', totalCents: 99900 }));   // another merchant: must not appear
const fsdb = makeDb();
const rtdb = makeRtdb(orders);
await J.runStatsRollup({ rtdb, fsdb, keyer, listRestaurants: async () => ['r_a', 'r_b'], log: () => {} }, { nowMs: NOW, mode: 'range', from: '2026-10-01', to: '2026-10-19', commit: true });

// ── the server, wrapped exactly as index.js exports.getSalesStats does ──────────────────────────
const MEMBERS = new Set(['restaurants/r_a/owners/uA', 'restaurants/r_b/owners/uB']);
const memberDb = { ref: (p) => ({ once: async () => ({ exists: () => MEMBERS.has(p) }) }) };
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

// The page's clock is pinned to the server's (ventas.js reads Date.now() for "today"): a test-only rewrite.
const pinClock = (s) => s.replace(/Date\.now\(\)/g, String(NOW));

const byId = H.installDom();
const dl = H.captureDownloads();
globalThis.fetch = serve;
byId.get('shopname').textContent = 'X. Pizza';
await H.loadModules(['ventas'], { ventas: pinClock });
document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uA' } }));
document.dispatchEvent(new CustomEvent('portal:restaurant', { detail: { rid: 'r_a' } }));
byId.get('navventas').click();
await H.settle(30);

// 1. the page asked the real server for the default period, and rendered ITS numbers
{
  const json = served.find((s) => !s.query.format);
  assert.ok(json, 'non-vacuity: the page requested the stats');
  assert.strictEqual(json.out.status, 200);
  assert.deepStrictEqual([json.query.from, json.query.to, json.query.compare], ['2026-10-14', TODAY, 'previous']);
  const b = json.out.body;
  assert.ok(b.kpis.orders >= 4 && b.kpis.sales_cents > 0, 'non-vacuity: the world has sales in the period');
  const page = byId.get('viewventas');
  const text = H.textOf(page);
  const kpiVals = H.byClass(page, 'vkval').map(H.textOf);
  assert.deepStrictEqual(kpiVals, [L.lempiras(b.kpis.sales_cents), L.count(b.kpis.orders), L.lempiras(b.kpis.average_paid_ticket_cents)],
    'the three KPI values are the server\'s kpis, formatted');
  assert.ok(kpiVals[0] !== '—' && kpiVals[2] !== '—', '…and every field name the page reads exists on the real response');
  const pills = H.byClass(page, 'vdl').map(H.textOf);
  assert.deepStrictEqual(pills, [b.deltas.sales_pct, b.deltas.orders_pct, b.deltas.average_paid_ticket_pct].map(L.pct1), 'the deltas are the server\'s');
  const top = H.byClass(page, 'viname').map(H.textOf);
  assert.deepStrictEqual(top, b.items.filter((i) => !i.reward && i.cents > 0).slice(0, 5).map((i) => i.name), 'top products, in the server\'s order');
  assert.ok(top.includes('Pepperoni 12″') && top.includes('Pan de ajo'));
  assert.ok(text.includes('Actualizado: en vivo.'), 'the period includes today → "en vivo" (from the real days[].computed_at)');
  assert.ok(!text.includes('99,900') && !text.includes('L 999'), 'r_b\'s sale is nowhere on r_a\'s page');
  const heatCells = H.byClass(page, 'vhc');
  assert.strictEqual(heatCells.length, 7 * H.byClass(page, 'vth').length, 'a full Mon–Sun × hours grid');
  assert.ok(text.includes('pico:'), 'a peak is named from the real heatmap');
  const types = H.byClass(page, 'vbig').map(H.textOf);
  const dl$ = b.by_type.delivery.cents, pk$ = b.by_type.pickup.cents;
  assert.strictEqual(types[0], `${Math.round((dl$ / (dl$ + pk$)) * 100)}% · ${L.lempiras(dl$)}`);
  ok('JSON: KPIs, deltas, top products, delivery split, heatmap and "en vivo" render the REAL server answer');
}

// 2. both CSV kinds: the real server header passes the portal allowlist, and the saved file IS the server body
{
  const [daily, ordersBtn] = H.byClass(byId.get('viewventas'), 'btn');
  daily.click();
  await H.settle(30);
  ordersBtn.click();
  await H.settle(30);
  await dl.read();
  const csvServed = served.filter((s) => s.query.format === 'csv');
  assert.deepStrictEqual(csvServed.map((s) => s.query.kind), ['daily', 'orders']);
  for (const s of csvServed) assert.strictEqual(s.out.status, 200, `${s.query.kind}: served`);
  assert.strictEqual(dl.saved.length, 2, '🔴 both real CSVs passed the allowlist and were saved — the allowlist matches the server');
  assert.strictEqual(dl.saved[0].text, csvServed[0].out.body, 'daily: byte-for-byte');
  assert.strictEqual(dl.saved[1].text, csvServed[1].out.body, 'orders (one page): byte-for-byte');
  assert.strictEqual(dl.saved[0].name, csvServed[0].out.filename);
  assert.strictEqual(dl.saved[1].name, csvServed[1].out.filename);
  assert.deepStrictEqual(L.CSV_HEADERS.orders, A.ORDER_COLUMNS, 'the portal\'s orders allowlist IS the server\'s ORDER_COLUMNS');
  assert.ok(dl.saved[1].text.split('\r\n').length - 2 >= 4, 'non-vacuity: the orders file has rows');
  ok('CSV: the real daily + orders headers pass the portal allowlist; saved bytes == server bytes');
}

// 3. a REAL non-owner answer (the server's 403 not_owner, staff token) renders the owner-only message
{
  MEMBERS.add('restaurants/r_a/kitchen_staff/sA');
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
