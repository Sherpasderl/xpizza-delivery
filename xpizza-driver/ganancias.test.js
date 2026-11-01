// ganancias.test.js — the earnings screen (#31/#32, renderGanancias) over the REAL window.PayRate reader and the REAL
// computeShiftCash. Lifts renderGanancias + the HN helpers + refreshOpenCashSurfaces from index.html into a jsdom
// #screen-ganancias and asserts the money contract (prototype S.ganancias / S.gananciasSemana) + the Codex r1 fixes:
//   #1 readiness gate — amounts BLANK over a loading/reconnecting/reconciling feed (no false L0), filled on the flip
//      via the REAL refreshOpenCashSurfaces hook, driven through the REAL computeShiftCash;
//   #2 explicit Honduras UTC−6 — the Hoy cutoff / day buckets / week bounds + labels are TZ-independent (proven under
//      UTC, America/Tegucigalpa and Asia/Tokyo at fixed instants);
//   #3 «N entregas × L R» only when every delivery is the SAME known rate (L70 + L90 → no «×»);
//   + the carried per-delivery sum, blank-rate (empty, no bare «L»), and the week/bar/bucket behaviour.
// The driver dir is type:module, so pay-rate.js (a classic UMD) loads the browser way. Run: `node ganancias.test.js`
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { shiftDeliveries, computeShiftCash, } from './cash-helpers.js';   // REAL cash source (Codex r1 #1)
import { coloniaOf, readyTimeHHMM } from './stacked-view.js';
import { brandLabel } from './brand-helpers.js';
const realDateNow = Date.now;

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');
const SRC = readFileSync(join(__dir, 'index.html'), 'utf8');
const SCRIPT = SRC.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function liftFn(name) {
  let start = SCRIPT.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  if (SCRIPT.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0, seen = false;
  for (let i = start; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') { depth++; seen = true; }
    else if (SCRIPT[i] === '}') { depth--; if (seen && depth === 0) return SCRIPT.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function liftConst(name) { const m = SCRIPT.match(new RegExp(`const ${name} = [^;]*;`)); assert.ok(m, `const ${name}`); return m[0]; }

const DAY = 86400000;
const HN = -6 * 3600000;
function weekStartMs(nowMs) { const ds = Math.floor((nowMs + HN) / DAY) * DAY - HN; const dow = new Date(ds + HN).getUTCDay(); return ds - ((dow === 0) ? 6 : dow - 1) * DAY; }   // mirror of gananciasWeekStartMs, for seeding
function hnDayStart(nowMs) { return Math.floor((nowMs + HN) / DAY) * DAY - HN; }

function boot({ allOrders = {}, rateEntries = null, now = Date.UTC(2026, 9, 28, 18, 0, 0), ready = true, pendingHandoff = false, identValid = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="screen-ganancias" class="hidden"></div><div id="cuadre-screen"></div><div id="history-modal"></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  new Function('self', readFileSync(join(__dir, 'pay-rate.js'), 'utf8'))(window);   // window.PayRate (classic-script path)
  Date.now = () => now;      // fixed instant for deterministic HN cutoffs (restored at file end); the lifted renderGanancias reads the node-global Date.now
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const CUADRE_WD = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const body =
    'let driverRateEntries = ' + JSON.stringify(rateEntries) + ';\n' +
    'let drv2GananciasView = "hoy";\n' +
    'const driverIdentityCutoverMs = null;\n' +
    'let feedReady = _ready, cutoverLoaded = _ready;\n' +
    'let driverState = _ready ? { active: true, name: "Marvin" } : null;\n' +
    'const driverFeed = { hasPendingHandoff: () => _pendingHandoff };\n' +
    'function shiftIdentity(){ return { valid: _identValid, start: 0 }; }\n' +
    'let closeInFlight = false;\n' +
    'function showCuadre(){} function renderHistoryModal(){}\n' +
    liftConst('HN_OFFSET_MS') + '\n' +
    liftFn('hnDayStartMs') + '\n' + liftFn('hnDow') + '\n' + liftFn('gananciasWeekStartMs') + '\n' +
    liftFn('renderGanancias') + '\n' +
    liftFn('refreshOpenCashSurfaces') + '\n' +
    'return { renderGanancias, refreshOpenCashSurfaces, setReady: (b) => { feedReady = b; cutoverLoaded = b; driverState = b ? { active: true } : null; } };';
  const names = ['document', 'window', '$', 'escapeHtml', 'CUADRE_WD', 'allOrders', 'currentUser', 'shiftDeliveries', 'computeShiftCash', 'coloniaOf', 'brandLabel', 'readyTimeHHMM', '_ready', '_pendingHandoff', '_identValid'];
  const api = (new Function(...names, body))(document, window, $, escapeHtml, CUADRE_WD, allOrders, { uid: 'drv' }, shiftDeliveries, computeShiftCash, coloniaOf, brandLabel, readyTimeHHMM, ready, pendingHandoff, identValid);
  const open = () => { document.getElementById('screen-ganancias').classList.remove('hidden'); };
  return { api, host: () => document.getElementById('screen-ganancias'), open };
}

const order = (at, extra = {}) => ({ delivered_at: at, delivered_by_driver_uid: 'drv', address_area: 'Col. Prueba', restaurant_display_name: 'X. Pizza', ...extra });
const ordersAt = (times) => { const m = {}; times.forEach((at, i) => { m['o' + i] = order(at); }); return m; };

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; };

const NOW = Date.UTC(2026, 9, 28, 18, 0, 0);   // Wed 2026-10-28 12:00 HN — a fixed mid-week instant
const T = hnDayStart(NOW);                      // 00:00 HN today

// ---------- Hoy content (carried) ----------
t('Hoy: «Ganado hoy» = SUM of each delivery\'s in-effect rate (6 × 7000¢ = L 420) + cashOwed (REAL) + list', () => {
  const orders = {}; [1, 2, 3, 4, 5, 6].forEach((h, i) => { orders['o' + i] = order(T + h * 3600000, { payment_method: 'cash', total: 200 }); });   // 6 cash deliveries → real cashOwed = 1200
  const h = boot({ now: NOW, allOrders: orders, rateEntries: { r: { cents: 7000, effective_from: T - DAY } } });
  h.api.renderGanancias('hoy');
  const html = h.host().innerHTML;
  assert.ok(/class="gn-big"><span class="gn-cur">L<\/span>420</.test(html), '6 × 7000¢ = L 420');
  assert.ok(/6 entregas × L 70 · se paga aparte del efectivo/.test(html), 'uniform-rate sub');
  assert.ok(/Efectivo a entregar hoy/.test(html) && /L 1,200/.test(html), 'cashOwed via REAL computeShiftCash (6 × 200)');
  assert.ok(/Col\. Prueba/.test(html) && /\+ L 70/.test(html), 'list rows with per-delivery «+ L 70»');
});

t('Hoy #3: a MIXED rate (L70 + L90) shows just the count, NO «× L» (and the sum still adds both)', () => {
  const h = boot({ now: NOW, allOrders: ordersAt([T + 1000, T + 10000]), rateEntries: { a: { cents: 7000, effective_from: T - DAY }, b: { cents: 9000, effective_from: T + 5000 } } });
  h.api.renderGanancias('hoy');
  const html = h.host().innerHTML;
  assert.ok(/class="gn-big"><span class="gn-cur">L<\/span>160</.test(html), '7000¢ + 9000¢ = L 160 (both counted)');
  assert.ok(/2 entregas · se paga/.test(html) && !/entregas × L/.test(html), 'mixed rate → «2 entregas», NO «× L»');
});

// ---------- #1 readiness gate (through the REAL computeShiftCash) ----------
t('#1 loading: feed NOT ready → amounts BLANK (no false L0), through the real computeShiftCash', () => {
  const orders = { a: order(T + 1000, { payment_method: 'cash', total: 500 }) };
  const h = boot({ now: NOW, allOrders: orders, rateEntries: { r: { cents: 7000, effective_from: T - DAY } }, ready: false });
  h.api.renderGanancias('hoy');
  const html = h.host().innerHTML;
  assert.ok(/class="gn-big"><\/div>/.test(html), 'earn BLANK while loading');
  assert.ok(!/L 500/.test(html) && !/<span class="gn-rv">L /.test(html), 'cashOwed BLANK while loading — never a figure over a partial feed');
  assert.ok(!/\+ L 70/.test(html), 'no per-delivery amounts while loading');
});

t('#1 reconcile: a pending handoff → BLANK (even with feed+cutover ready)', () => {
  const h = boot({ now: NOW, allOrders: { a: order(T + 1000, { payment_method: 'cash', total: 500 }) }, rateEntries: { r: { cents: 7000, effective_from: T - DAY } }, pendingHandoff: true });
  h.api.renderGanancias('hoy');
  assert.ok(/class="gn-big"><\/div>/.test(h.host().innerHTML) && !/L 500/.test(h.host().innerHTML), 'reconcile in flight → blank');
});

t('#1 reconnect: readiness flips → the REAL refreshOpenCashSurfaces re-renders the OPEN screen with amounts', () => {
  const orders = {}; [1, 2, 3].forEach((hh, i) => { orders['o' + i] = order(T + hh * 3600000, { payment_method: 'cash', total: 300 }); });
  const h = boot({ now: NOW, allOrders: orders, rateEntries: { r: { cents: 7000, effective_from: T - DAY } }, ready: false });
  h.open();                                   // the earnings screen is visible
  h.api.renderGanancias('hoy');
  assert.ok(/class="gn-big"><\/div>/.test(h.host().innerHTML), 'blank before the feed is ready');
  h.api.setReady(true);                       // the feed re-emits readiness…
  h.api.refreshOpenCashSurfaces();            // …and the REAL hook re-renders the open screen
  const html = h.host().innerHTML;
  assert.ok(/class="gn-big"><span class="gn-cur">L<\/span>210</.test(html), '3 × 7000¢ = L 210 appears after the flip');
  assert.ok(/L 900/.test(html), 'cashOwed (3 × 300) appears after the flip');
});

// ---------- #2 Honduras UTC−6 (TZ-independent) ----------
t('#2 HN cutoff: Sun 21:00 HN delivery is NOT "today" at Mon 00:00 HN; Mon 00:00 HN IS', () => {
  const monHN = Date.UTC(2026, 9, 26, 6, 0, 0);      // Mon 2026-10-26 00:00 HN (06:00 UTC)
  const sun2100 = monHN - 3 * 3600000;               // Sun 21:00 HN
  const h = boot({ now: monHN, allOrders: { s: order(sun2100, { payment_method: 'cash', total: 100 }), m: order(monHN + 3600000, { payment_method: 'cash', total: 100 }) }, rateEntries: { r: { cents: 7000, effective_from: sun2100 - DAY } } });
  h.api.renderGanancias('hoy');
  assert.ok(/class="gn-big"><span class="gn-cur">L<\/span>70</.test(h.host().innerHTML), 'only the Monday delivery counts today (L 70), not Sunday\'s');
});

t('#2 TZ-INDEPENDENT: the HN helpers give identical results under UTC / America-Tegucigalpa / Asia-Tokyo', () => {
  const mod = join(__dir, '__hn-helpers.test-tmp.mjs');
  writeFileSync(mod, liftConst('HN_OFFSET_MS') + '\n' + liftFn('hnDayStartMs') + '\n' + liftFn('hnDow') + '\n' + liftFn('gananciasWeekStartMs') + '\nexport { hnDayStartMs, hnDow, gananciasWeekStartMs };');
  try {
    const instant = Date.UTC(2026, 9, 26, 3, 0, 0);   // Sun 21:00 HN (Mon 03:00 UTC)
    const run = (tz) => execFileSync(process.execPath, ['--input-type=module', '-e', `import {hnDayStartMs,hnDow,gananciasWeekStartMs} from ${JSON.stringify(mod)}; process.stdout.write(JSON.stringify([hnDayStartMs(${instant}),hnDow(${instant}),gananciasWeekStartMs(${instant})]));`], { env: { ...process.env, TZ: tz } }).toString();
    const utc = run('UTC'), hn = run('America/Tegucigalpa'), tok = run('Asia/Tokyo');
    assert.equal(utc, hn, 'UTC vs HN identical'); assert.equal(utc, tok, 'UTC vs Tokyo identical');
    const [ds, dow] = JSON.parse(utc);
    assert.equal(dow, 0, 'Sun 21:00 HN → HN day-of-week is Sunday (0), regardless of device TZ');
    assert.equal(ds, Date.UTC(2026, 9, 25, 6, 0, 0), 'HN day start = Sun 2026-10-25 00:00 HN (06:00 UTC)');
  } finally { try { require('fs').unlinkSync(mod); } catch {} }
});

// ---------- Semana content (carried) ----------
t('Semana: week sum + Por-día buckets (HN) + mid-week rate change across bars', () => {
  const ws = weekStartMs(NOW);
  const mon = [ws + 10 * 3600000, ws + 11 * 3600000];
  const fri = [ws + 4 * DAY + 10 * 3600000, ws + 4 * DAY + 11 * 3600000];
  const h = boot({ now: NOW, allOrders: ordersAt([...mon, ...fri]), rateEntries: { a: { cents: 7000, effective_from: ws - DAY }, b: { cents: 9000, effective_from: ws + 2 * DAY } } });
  h.api.renderGanancias('semana');
  const html = h.host().innerHTML;
  assert.ok(/class="gn-big"><span class="gn-cur">L<\/span>320/.test(html), '2×7000 + 2×9000 = L 320');
  assert.ok(/<span class="gn-blb">Lun<\/span>.*?<span class="gn-bv">L 140<\/span>/s.test(html), 'Lun = L 140');
  assert.ok(/<span class="gn-blb">Vie<\/span>.*?<span class="gn-bv">L 180<\/span>/s.test(html), 'Vie = L 180 (new rate)');
  assert.ok(/<span class="gn-blb">Mar<\/span>.*?<span class="gn-bv">—<\/span>/s.test(html), 'empty day → «—»');
});

// ---------- blank-rate (unseeded) ----------
t('Unseeded: NO rate → earn fully EMPTY (no number, no bare «L»), no «× L», no per-delivery «+ L»', () => {
  const h = boot({ now: NOW, allOrders: ordersAt([T + 1000, T + 2000]), rateEntries: null });
  h.api.renderGanancias('hoy');
  const html = h.host().innerHTML;
  assert.ok(/class="gn-big"><\/div>/.test(html) && !/gn-big"><span/.test(html), 'earn empty, no bare «L»');
  assert.ok(!/entregas × L/.test(html) && !/\+ L \d/.test(html), 'no «× L» / no «+ L» when the rate is unknown');
});

// ---------- capture-fixture sanity (#32) ----------
t('capture fixture (#32 Semana): proto per-day counts → week L 1,890 + bars L420/210/350/280/210/420/—', () => {
  const ws = weekStartMs(NOW);
  const counts = [6, 3, 5, 4, 3, 6, 0];
  const orders = {}; let k = 0;
  counts.forEach((c, day) => { for (let j = 0; j < c; j++) orders['o' + (k++)] = order(ws + day * DAY + (10 + j) * 3600000); });
  const h = boot({ now: NOW, allOrders: orders, rateEntries: { r: { cents: 7000, effective_from: ws - DAY } } });
  h.api.renderGanancias('semana');
  const html = h.host().innerHTML;
  assert.ok(/class="gn-big"><span class="gn-cur">L<\/span>1,890</.test(html), 'L 1,890');
  const bars = ['Lun', 'L 420', 'Mar', 'L 210', 'Mié', 'L 350', 'Jue', 'L 280', 'Vie', 'L 210', 'Sáb', 'L 420', 'Dom', '—'];
  for (let i = 0; i < bars.length; i += 2) assert.ok(new RegExp(`<span class="gn-blb">${bars[i]}</span>.*?<span class="gn-bv">${bars[i + 1]}</span>`, 's').test(html), `${bars[i]} = ${bars[i + 1]}`);
});

t('practica hint (#5): «Ves tu resumen y tu +L {rate}» DERIVED from PayRate; «Ves tu resumen» when unknown/not-ready', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const win = dom.window;
  new Function('self', readFileSync(join(__dir, 'pay-rate.js'), 'utf8'))(win);   // win.PayRate
  const B = 1767225600000;
  const run = (entries) => (new Function('window', 'driverRateEntries', liftFn('drv2PracticaPayHint') + '\nreturn drv2PracticaPayHint();'))(win, entries);
  Date.now = () => B + 1000;
  assert.equal(run({ r: { cents: 7000, effective_from: B } }), 'Ves tu resumen y tu +L 70', 'rate known → the prototype sentence with the DERIVED amount (L 70)');
  assert.equal(run({ r: { cents: 9000, effective_from: B } }), 'Ves tu resumen y tu +L 90', 'a different platform rate → that amount (never hardcoded 70)');
  assert.equal(run(null), 'Ves tu resumen', 'rate unknown → the prototype sentence minus the amount clause');
  assert.equal(run({ r: { cents: 7000, effective_from: B + 99999999 } }), 'Ves tu resumen', 'rate not yet in effect → minus the amount clause');
  Date.now = realDateNow;
});

Date.now = realDateNow;   // restore the real clock
console.log(`ganancias.test.js: ${passed} passed`);
