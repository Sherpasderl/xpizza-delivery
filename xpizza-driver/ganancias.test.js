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
import { coloniaOf, readyTimeHHMM, interludeHtml, deliverySummaryHtml } from './stacked-view.js';
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
    'let driverState = _ready ? { active: true, name: "Marvin", current_shift_id: "s" } : null;\n' +
    'const driverFeed = { hasPendingHandoff: () => _pendingHandoff };\n' +
    'function shiftIdentity(){ return { valid: _identValid, start: 0 }; }\n' +
    'let closeInFlight = false;\n' +
    'function showCuadre(){} function renderHistoryModal(){}\n' +
    liftConst('HN_OFFSET_MS') + '\n' +
    liftFn('hnDayStartMs') + '\n' + liftFn('hnDow') + '\n' + liftFn('gananciasWeekStartMs') + '\n' +
    liftFn('drv2DayReady') + '\n' + liftFn('drv2DayEarned') + '\n' +   // THE one source renderGanancias (Hoy) now calls
    liftFn('renderGanancias') + '\n' +
    liftFn('refreshOpenCashSurfaces') + '\n' +
    'return { renderGanancias, refreshOpenCashSurfaces, setReady: (b) => { feedReady = b; cutoverLoaded = b; driverState = b ? { active: true, current_shift_id: "s" } : null; } };';
  const names = ['document', 'window', '$', 'escapeHtml', 'CUADRE_WD', 'allOrders', 'currentUser', 'shiftDeliveries', 'computeShiftCash', 'coloniaOf', 'brandLabel', 'readyTimeHHMM', '_ready', '_pendingHandoff', '_identValid'];
  const api = (new Function(...names, body))(document, window, $, escapeHtml, CUADRE_WD, allOrders, { uid: 'drv' }, shiftDeliveries, computeShiftCash, coloniaOf, brandLabel, readyTimeHHMM, ready, pendingHandoff, identValid);
  const open = () => { document.getElementById('screen-ganancias').classList.remove('hidden'); };
  return { api, host: () => document.getElementById('screen-ganancias'), open };
}

const order = (at, extra = {}) => ({ delivered_at: at, delivered_by_driver_uid: 'drv', address_area: 'Col. Prueba', restaurant_display_name: 'X. Pizza', ...extra });
const ordersAt = (times) => { const m = {}; times.forEach((at, i) => { m['o' + i] = order(at); }); return m; };

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; };
// The OLD builders (0d110f5b, before the interlude/summary rewire) — the DOM-equality reference for the injection tests.
const __oldTmp = join(__dir, '__old-sv.tmp.mjs');
writeFileSync(__oldTmp, execFileSync('git', ['show', '0d110f5b:xpizza-driver/stacked-view.js'], { cwd: __dir }).toString());
const OLD = await import('file://' + __oldTmp);
try { require('fs').unlinkSync(__oldTmp); } catch {}   // unlink immediately (module is cached) so it never leaks as a stray add

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

// ---------- INTERLUDE/SUMMARY injection (the rewire; Codex money) ----------
const ESC = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const IC = { wallet: '<svg class="w"></svg>', cash: '<svg class="c"></svg>', check: '✓' };
const DEPS = { ICONS: IC, esc: ESC };
const BB = 1767225600000;
// build a jsdom overlay from a builder, lift + run the injection with PAGOS + a seeded rate
function injectOverlay(kind, info, { rate = 7000, pagosLive = true } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="ov"></div></body></html>');
  const win = dom.window, doc = win.document;
  new Function('self', readFileSync(join(__dir, 'pay-rate.js'), 'utf8'))(win);
  const ov = doc.getElementById('ov');
  ov.innerHTML = (kind === 'interlude' ? interludeHtml(info, DEPS) : deliverySummaryHtml(info, DEPS));
  const oid = 'o1';
  const allOrders = { [oid]: { delivered_at: BB + 1000, delivered_by_driver_uid: 'drv' } };   // a RESOLVED delivery attributed to THIS driver, within the BB HN-day
  const entries = rate != null ? { r: { cents: rate, effective_from: BB } } : null;
  const driverFeed = { hasPendingHandoff: () => false };
  // PRODUCTION-FAITHFUL (Codex r1 P1/P2): day-ready + a real uid + a fixed instant in o1's HN-day, so drv2EarnRateFor
  // applies the SAME attribution+readiness predicate as drv2DayEarned (the old feedReady=false stub hid this). The
  // resumen row is now COUPLED to the day card (both gate on drv2DayEarned); the interlude has no card.
  const HN_OFFI = -6 * 3600000;
  const realNow = Date.now; Date.now = () => BB + 2000;
  try {
    const fns = (new Function('PAGOS_LIVE', 'window', 'allOrders', 'driverRateEntries', 'currentUser', 'driverIdentityCutoverMs',
      'feedReady', 'cutoverLoaded', 'driverState', 'driverFeed', 'shiftDeliveries', 'HN_OFFSET_MS', 'ICONS',
      liftFn('hnDayStartMs') + '\n' + liftFn('drv2DayReady') + '\n' + liftFn('drv2DayEarned') + '\n' + liftFn('drv2EarnRateFor') + '\n' + liftFn('drv2InjectInterludeEarn') + '\n' + liftFn('drv2InjectResumenEarn') + '\nreturn { ii: drv2InjectInterludeEarn, ir: drv2InjectResumenEarn };'))(
      pagosLive, win, allOrders, entries, { uid: 'drv' }, null, true, true, { active: true, current_shift_id: 's' }, driverFeed, shiftDeliveries, HN_OFFI, IC);
    ov.dataset.oid = oid;
    (kind === 'interlude' ? fns.ii : fns.ir)(ov);
  } finally { Date.now = realNow; }
  const norm = (h) => { const d = doc.createElement('div'); d.innerHTML = h; return d.innerHTML; };   // normalize the raw builder string through the SAME jsdom serializer, so the comparison is DOM-equality (not string formatting)
  return { ov, win, norm };
}

// Condition 1 — NO-REGRESSION: with PAGOS off, the overlay (new builder + inert injection) is byte-identical to the OLD builder (showEarnings:false).
t('injection #1 no-regression: PAGOS off → overlay == old builder output (both call sites), byte-identical', () => {
  const ilInfo = { deliveredName: 'Daniela', cash: 385, vuelto: 115, showEarnings: false, next: { name: 'Carlos' } };
  const il = injectOverlay('interlude', ilInfo, { pagosLive: false });
  assert.equal(il.ov.innerHTML, il.norm(OLD.interludeHtml(ilInfo, DEPS)), 'interlude: PAGOS off → identical to the old builder');
  const rsInfo = { order: { payment_method: 'cash', total: 385 }, deliveredName: 'Daniela', time: '7:43', vuelto: 115, showEarnings: false, dayCashOwed: 385 };
  const rs = injectOverlay('summary', rsInfo, { pagosLive: false });
  assert.equal(rs.ov.innerHTML, rs.norm(OLD.deliverySummaryHtml(rsInfo, DEPS)), 'summary: PAGOS off → identical to the old builder');
});

// Condition 2 — FIDELITY when live: new builder + inject(rate 70) == OLD builder with showEarnings:true (same element/classes/text/position); rate 90 case.
t('injection #2 fidelity: PAGOS on + rate 70 → overlay == old builder showEarnings:true; rate 90 lands the new amount', () => {
  const ilInfo = { deliveredName: 'Daniela', cash: 385, vuelto: 115, showEarnings: false, next: { name: 'Carlos' } };
  const il = injectOverlay('interlude', ilInfo, { rate: 7000 });
  assert.equal(il.ov.innerHTML, il.norm(OLD.interludeHtml({ ...ilInfo, showEarnings: true }, DEPS)), 'interlude rate 70 == old builder showEarnings:true (DOM-equal .il-sub)');
  const rsInfo = { order: { payment_method: 'cash', total: 385 }, deliveredName: 'Daniela', time: '7:43', vuelto: 115, showEarnings: false, dayCashOwed: 385 };
  const rs = injectOverlay('summary', rsInfo, { rate: 7000 });
  // Codex r1 P1: the per-delivery row and the «Ganado hoy» card now SHARE the day predicate, so a day-ready resumen
  // shows BOTH. The injected «Tu pago» row still reproduces the old builder's showEarnings:true row byte-for-byte —
  // assert that row verbatim as a substring — AND the coupled day card is present.
  const OLD_ROW = rs.norm(OLD.deliverySummaryHtml({ ...rsInfo, showEarnings: true }, DEPS)).match(/<div class="rs-row"><span class="ico[^]*?Tu pago por esta entrega[^]*?<\/div><\/div>/);
  assert.ok(OLD_ROW && rs.ov.innerHTML.includes(OLD_ROW[0]), 'summary rate 70 → the «Tu pago» row is byte-identical to the old builder showEarnings:true row');
  assert.ok(/class="rs-stat rs-earned"/.test(rs.ov.innerHTML) && /Ganado hoy · 1 entrega/.test(rs.ov.innerHTML), 'summary day-ready → the coupled «Ganado hoy» card appears (shared day predicate)');
  // rate 90 → the NEW amount, same shape, never hardcoded 70
  const il90 = injectOverlay('interlude', ilInfo, { rate: 9000 }).ov.innerHTML;
  assert.ok(il90.includes('+L 90') && !il90.includes('+L 70'), 'interlude rate 90 → «+L 90»');
  const rs90 = injectOverlay('summary', rsInfo, { rate: 9000 }).ov.innerHTML;
  assert.ok(/<span class="rs-pos">\+ L 90<\/span>/.test(rs90) && !rs90.includes('+ L 70'), 'summary rate 90 → «+ L 90» in the rs-pos span');
});

// Condition 3 — LATE rate load: rate unknown at show → nothing; rate arrives → re-inject (idempotent) shows the amount.
t('injection #3 late load: unknown rate → nothing; re-inject after the rate arrives → the amount appears (idempotent)', () => {
  const rsInfo = { order: { payment_method: 'cash', total: 385 }, deliveredName: 'Daniela', time: '7:43', vuelto: 115, showEarnings: false, dayCashOwed: 385 };
  const dom = new JSDOM('<!doctype html><html><body><div id="ov"></div></body></html>');
  const win = dom.window, doc = win.document;
  new Function('self', readFileSync(join(__dir, 'pay-rate.js'), 'utf8'))(win);
  const ov = doc.getElementById('ov'); ov.innerHTML = deliverySummaryHtml(rsInfo, DEPS); ov.dataset.oid = 'o1';
  const allOrders = { o1: { delivered_at: BB + 1000, delivered_by_driver_uid: 'drv' } };
  let entries = null;   // rate NOT loaded yet
  const realNow = Date.now; Date.now = () => BB + 2000;   // production-faithful: a fixed instant in o1's HN-day (shared day predicate, Codex r1)
  const mk = () => (new Function('PAGOS_LIVE', 'window', 'allOrders', 'driverRateEntries', 'currentUser', 'driverIdentityCutoverMs',
    'feedReady', 'cutoverLoaded', 'driverState', 'driverFeed', 'shiftDeliveries', 'HN_OFFSET_MS', 'ICONS',
    liftFn('hnDayStartMs') + '\n' + liftFn('drv2DayReady') + '\n' + liftFn('drv2DayEarned') + '\n' + liftFn('drv2EarnRateFor') + '\n' + liftFn('drv2InjectResumenEarn') + '\nreturn drv2InjectResumenEarn;'))(
    true, win, allOrders, entries, { uid: 'drv' }, null, true, true, { active: true, current_shift_id: 's' }, { hasPendingHandoff: () => false }, shiftDeliveries, -6 * 3600000, IC);
  try {
    mk()(ov);
    assert.ok(!ov.innerHTML.includes('Tu pago por esta entrega'), 'unknown rate → NOTHING injected (never stale/invented)');
    entries = { r: { cents: 7000, effective_from: BB } };   // rate arrives
    mk()(ov); mk()(ov);   // re-inject twice → idempotent
    assert.ok(ov.innerHTML.includes('Tu pago por esta entrega') && /<span class="rs-pos">\+ L 70<\/span>/.test(ov.innerHTML), 'after the rate arrives → the row appears');
    assert.equal((ov.innerHTML.match(/Tu pago por esta entrega/g) || []).length, 1, 'exactly ONE row after repeated re-injects (idempotent)');
  } finally { Date.now = realNow; }
});

// ---------- resumen «Ganado hoy» day-earnings stat card — ONE SOURCE with the Ganancias screen (Codex r1 REVISE) ----------
// drv2DayEarned() is THE single day-earnings computation: HN-midnight day (hnDayStartMs), RESOLVED-only deliveries, the
// SAME money-readiness gate as the Ganancias screen — recomputed on EVERY call, nothing cached on the overlay. Both
// renderGanancias (Hoy) and drv2InjectResumenEarn call it, so the resumen card can never show a figure that differs
// from the Ganancias «Ganado hoy» (parity asserted below across a 2nd shift / provisional attribution / pending
// handoff / overlay reuse). The overlay harness runs the REAL shiftDeliveries (imported) + real hnDayStartMs — no stub,
// no silent catch → [].
const HN_OFF = -6 * 3600000;
const hnTodayStart = () => Math.floor((Date.now() + HN_OFF) / 86400000) * 86400000 - HN_OFF;   // HN midnight of today
const DLV = (ms = Date.now() - 1000, uid = 'drv') => ({ delivered_at: ms, delivered_by_driver_uid: uid });   // a RESOLVED delivery
function dayEarnedHarness({ pagosLive = true, entries = { r: { cents: 7000, effective_from: Date.UTC(2026, 0, 1) } },
    allOrders = {}, feedReady = true, cutoverLoaded = true, driverState = { active: true, current_shift_id: 's' }, hasPendingHandoff = false, identValid = true, uid = 'drv', cutover = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const win = dom.window, doc = win.document;
  new Function('self', readFileSync(join(__dir, 'pay-rate.js'), 'utf8'))(win);
  const driverFeed = { hasPendingHandoff: () => hasPendingHandoff };
  const shiftIdentity = () => ({ valid: identValid, start: 0 });
  const api = (new Function('PAGOS_LIVE', 'window', 'allOrders', '_rates0', 'currentUser', 'driverIdentityCutoverMs',
    'feedReady', 'cutoverLoaded', 'driverState', 'driverFeed', 'shiftIdentity', 'shiftDeliveries', 'HN_OFFSET_MS', 'ICONS',
    'let driverRateEntries = _rates0;\n' +
    liftFn('hnDayStartMs') + '\n' + liftFn('drv2DayReady') + '\n' + liftFn('drv2DayEarned') + '\n' + liftFn('drv2EarnRateFor') + '\n' + liftFn('drv2InjectResumenEarn') + '\n' +
    'return { de: () => drv2DayEarned(), ir: drv2InjectResumenEarn, setRates: (r) => { driverRateEntries = r; } };'))(
    pagosLive, win, allOrders, entries, { uid }, cutover, feedReady, cutoverLoaded, driverState, driverFeed, shiftIdentity, shiftDeliveries, HN_OFF, IC);
  const freshOverlay = () => { const ov = doc.createElement('div'); ov.innerHTML = deliverySummaryHtml({ order: { payment_method: 'cash', total: 385 }, deliveredName: 'Daniela', time: '7:43', vuelto: 115, showEarnings: false, dayCashOwed: 385 }, DEPS); ov.dataset.oid = 'x'; return ov; };
  return { win, doc, de: api.de, ir: api.ir, setRates: api.setRates, freshOverlay };
}
// the card's figure from the overlay, or null when hidden
function cardFigure(ov) {
  const e = ov.querySelector('.rs-stat.rs-earned'); if (!e) return null;
  const m = e.textContent.match(/L\s*([\d.,]+)\s*Ganado hoy · (\d+) entrega/);
  return m ? { cents: Math.round(parseFloat(m[1].replace(/,/g, '')) * 100), count: Number(m[2]) } : { raw: e.textContent };
}

t('resumen «Ganado hoy» ONE-SOURCE: card === drv2DayEarned() (the Ganancias value), rendered in the 2-up grid', () => {
  const h = dayEarnedHarness({ allOrders: { a: DLV(Date.now() - 2000), b: DLV(Date.now() - 1000) } });
  const exp = h.de();
  assert.equal(exp.ready, true); assert.equal(exp.count, 2); assert.equal(exp.cents, 14000, 'day total = 2 × L70');
  const ov = h.freshOverlay(); h.ir(ov);
  assert.ok(ov.querySelector('.rs-stats'), '2-up grid');
  assert.deepEqual(cardFigure(ov), { cents: exp.cents, count: exp.count }, 'card shows exactly the Ganancias figure');
  assert.ok(ov.textContent.includes('Ganado hoy · 2 entregas'), '«Ganado hoy · 2 entregas»');
  assert.ok(ov.textContent.includes('Efectivo a entregar hoy'), 'the cash stat is kept');
});

t('P2a (Codex r1): «Ganado hoy» survives a clock-out — drv2DayEarned is DAY-ready with NO open shift (identity invalid)', () => {
  const h = dayEarnedHarness({ allOrders: { a: DLV(Date.now() - 1000) }, identValid: false, driverState: { active: false } });   // clock-out clears current_shift_id (no shift id, inactive); the day must still compute
  const de = h.de();
  assert.equal(de.ready, true, 'the day is ready even with no open shift — earnings must not vanish at clock-out');
  assert.equal(de.cents, 7000, 'today\'s resolved delivery still counts after clock-out');
});

t('resumen «Ganado hoy» no-regression: PAGOS off → no card; byte-identical to the old builder', () => {
  const h = dayEarnedHarness({ pagosLive: false, allOrders: { a: DLV() } });
  const ov = h.freshOverlay(); h.ir(ov);
  assert.equal(cardFigure(ov), null, 'no «Ganado hoy» card');
  assert.ok(!ov.querySelector('.rs-stats'), 'no grid');
  const norm = (s) => { const d = h.doc.createElement('div'); d.innerHTML = s; return d.innerHTML; };
  assert.equal(ov.innerHTML, norm(OLD.deliverySummaryHtml({ order: { payment_method: 'cash', total: 385 }, deliveredName: 'Daniela', time: '7:43', vuelto: 115, showEarnings: false, dayCashOwed: 385 }, DEPS)), 'byte-identical to the old builder');
});

t('resumen «Ganado hoy» PARITY: overlay figure === drv2DayEarned() across 2nd shift / provisional / pending handoff / reuse', () => {
  // (a) second shift, SAME HN day — a delivery from an earlier shift today still counts (DAY-based, not shift-based)
  { const h = dayEarnedHarness({ allOrders: { early: DLV(hnTodayStart() + 1000), late: DLV(Date.now() - 1000) } });
    const exp = h.de(); assert.equal(exp.count, 2, "both of today's deliveries count regardless of shift");
    const ov = h.freshOverlay(); h.ir(ov);
    assert.deepEqual(cardFigure(ov), { cents: exp.cents, count: exp.count }, 'card === the day figure across shifts'); }
  // (b) provisional attribution — a legacy-only (delivered_by_uid) delivery is NOT resolved → excluded from BOTH
  { const h = dayEarnedHarness({ allOrders: { res: DLV(), prov: { delivered_at: Date.now() - 1000, delivered_by_uid: 'drv' } } });
    const exp = h.de(); assert.equal(exp.count, 1, 'only the resolved delivery counts (provisional excluded)');
    const ov = h.freshOverlay(); h.ir(ov);
    assert.deepEqual(cardFigure(ov), { cents: exp.cents, count: exp.count }, 'card excludes provisional, exactly like Ganancias'); }
  // (c) pending handoff → not ready → BOTH hide (never a false figure)
  { const h = dayEarnedHarness({ allOrders: { a: DLV() }, hasPendingHandoff: true });
    assert.equal(h.de().ready, false, 'pending handoff → not ready');
    const ov = h.freshOverlay(); h.ir(ov);
    assert.equal(cardFigure(ov), null, 'card hidden under a pending handoff'); }
  // (d) overlay reuse — inject twice on the same overlay → exactly one card, still the one-source figure
  { const h = dayEarnedHarness({ allOrders: { a: DLV(), b: DLV(Date.now() - 1500) } });
    const ov = h.freshOverlay(); h.ir(ov); h.ir(ov);
    assert.equal(ov.querySelectorAll('.rs-stat.rs-earned').length, 1, 'exactly one card after reuse');
    assert.deepEqual(cardFigure(ov), { cents: h.de().cents, count: h.de().count }, 'reused overlay still shows the one-source figure'); }
});

t('resumen «Ganado hoy» late rate (recomputed, not cached): unseeded → hidden; rate arrives on the SAME overlay → appears', () => {
  const h = dayEarnedHarness({ entries: null, allOrders: { a: DLV(), b: DLV(Date.now() - 1500) } });
  const ov = h.freshOverlay(); h.ir(ov);
  assert.equal(cardFigure(ov), null, 'unseeded rate → hidden (blank, not a false L0)');
  h.setRates({ r: { cents: 7000, effective_from: Date.UTC(2026, 0, 1) } });   // rate arrives (refreshOpenCashSurfaces re-injects)
  h.ir(ov);
  assert.deepEqual(cardFigure(ov), { cents: 14000, count: 2 }, 'the card appears, recomputed from the current rate (no stale cache)');
  assert.equal(ov.querySelectorAll('.rs-stat.rs-earned').length, 1, 'exactly one card');
});

t('resumen «Ganado hoy» singular «1 entrega»; a different platform rate lands the new amount (never hardcoded)', () => {
  const h = dayEarnedHarness({ entries: { r: { cents: 9000, effective_from: Date.UTC(2026, 0, 1) } }, allOrders: { a: DLV() } });
  const ov = h.freshOverlay(); h.ir(ov);
  assert.deepEqual(cardFigure(ov), { cents: 9000, count: 1 }, 'rate 90, 1 delivery → L 90 · 1 entrega');
  assert.ok(/Ganado hoy · 1 entrega\b/.test(ov.textContent) && !/1 entregas/.test(ov.textContent), 'singular «1 entrega»');
});

// ---------- OVERLAY REUSE through the REAL drv2ShowInterlude/drv2ShowResumen + refreshOpenCashSurfaces (Codex rewire r1 P1) ----------
function showHarness({ pagosLive = true, rateEntries = null, allOrders = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="cuadre-screen"></div><div id="history-modal"></div></body></html>');
  const win = dom.window, doc = win.document;
  new Function('self', readFileSync(join(__dir, 'pay-rate.js'), 'utf8'))(win);
  const $ = (id) => doc.getElementById(id);
  const XPD = { getDriverOrders: () => [{ phase: 'in_transit', order: {} }] };   // a live next stop → the interlude path (not resumen)
  const shiftIdentity = () => ({ valid: true, start: 0 });
  const computeShiftCash = () => ({ cashOwed: 1430 });
  const body =
    'let drv2Interlude = null, drv2InterludeShownFor = null, drv2ResumenShownFor = null, drv2InterludeTimer = null;\n' +
    'let allOrders = _allOrders, driverRateEntries = _rateEntries, drv2GananciasView = "hoy";\n' +
    'let feedReady = true, cutoverLoaded = true, driverState = { active: true, current_shift_id: "s" }, closeInFlight = false;\n' +
    'const driverFeed = { hasPendingHandoff: () => false }; const driverIdentityCutoverMs = null;\n' +
    'function drv2DismissInterlude(){ const o=$("drv2-interlude"); if(o) o.classList.remove("open"); drv2Interlude=null; drv2InterludeShownFor=null; }\n' +
    'function showCuadre(){} function renderHistoryModal(){} function renderGanancias(){}\n' +
    liftConst('HN_OFFSET_MS') + '\n' + liftFn('hnDayStartMs') + '\n' + liftFn('drv2DayReady') + '\n' + liftFn('drv2DayEarned') + '\n' +   // the «Ganado hoy» one source drv2InjectResumenEarn now calls
    liftFn('drv2EarnRateFor') + '\n' + liftFn('drv2InjectInterludeEarn') + '\n' + liftFn('drv2InjectResumenEarn') + '\n' +
    liftFn('refreshOpenCashSurfaces') + '\n' + liftFn('drv2DismissResumen') + '\n' + liftFn('drv2ShowResumen') + '\n' + liftFn('drv2ShowInterlude') + '\n' +
    'return { showInterlude: (info) => { drv2Interlude = info; drv2ShowInterlude(); }, showResumen: (info) => drv2ShowResumen(info), refresh: () => refreshOpenCashSurfaces(), setRate: (e) => { driverRateEntries = e; }, setOrders: (o) => { allOrders = o; }, setReady: (b) => { feedReady = b; cutoverLoaded = b; driverState = b ? { active: true } : null; } };';
  const names = ['document', 'window', '$', 'PAGOS_LIVE', 'ICONS', 'escapeHtml', 'coloniaOf', 'interludeHtml', 'deliverySummaryHtml', 'readyTimeHHMM', 'XPD', 'currentUser', 'allTasks', 'shiftIdentity', 'computeShiftCash', 'shiftDeliveries', 'clearTimeout', 'setTimeout', '_allOrders', '_rateEntries'];
  const api = (new Function(...names, body))(doc, win, $, pagosLive, IC, ESC, coloniaOf, interludeHtml, deliverySummaryHtml, readyTimeHHMM, XPD, { uid: 'drv' }, {}, shiftIdentity, computeShiftCash, shiftDeliveries, () => 0, () => 0, allOrders, rateEntries);
  return { api, il: () => $('drv2-interlude'), rs: () => $('drv2-resumen') };
}
const ilInfo = (orderId, cash, vuelto) => ({ orderId, name: 'X', cash, vuelto });

t('reuse P1: interlude A→B shows B\'s cash (not A\'s stale base), PAGOS OFF — the regression Codex found', () => {
  const h = showHarness({ pagosLive: false });
  h.api.showInterlude(ilInfo('A', 385, 115));
  assert.ok(h.il().innerHTML.includes('Cobraste L 385') && h.il().innerHTML.includes('vuelto L 115'), 'A shows 385/115');
  h.api.showInterlude(ilInfo('B', 500, 0));   // reuse the SAME #drv2-interlude element
  const b = h.il().innerHTML;
  assert.ok(b.includes('Cobraste L 500'), 'B shows ITS OWN cash (500), not A\'s stale 385');
  assert.ok(!b.includes('385') && !b.includes('vuelto L 115'), 'no stale A data leaks into B');
});

t('reuse: cashless→cash keeps B\'s cash line (PAGOS off)', () => {
  const h = showHarness({ pagosLive: false });
  h.api.showInterlude({ orderId: 'A', name: 'X' });                 // cashless (no cash/vuelto → no .il-sub)
  h.api.showInterlude(ilInfo('B', 500, 0));                         // cash
  assert.ok(h.il().innerHTML.includes('Cobraste L 500'), 'cashless→cash: B\'s cash line is present, not dropped');
});

t('reuse with PAGOS on: A→B injects B\'s per-delivery rate at B\'s delivered_at; A→unknown→nothing', () => {
  const B = 1767225600000;
  const orders = { A: { delivered_at: B + 1000, delivered_by_driver_uid: 'drv' }, B: { delivered_at: B + 3 * 86400000, delivered_by_driver_uid: 'drv' } };
  const h = showHarness({ pagosLive: true, rateEntries: { a: { cents: 7000, effective_from: B }, b: { cents: 9000, effective_from: B + 2 * 86400000 } }, allOrders: orders });
  h.api.showInterlude(ilInfo('A', 385, 115));
  assert.ok(h.il().innerHTML.includes('+L 70'), 'A (delivered before the change) → L 70, its historical rate');
  h.api.showInterlude(ilInfo('B', 500, 0));
  assert.ok(h.il().innerHTML.includes('+L 90') && !h.il().innerHTML.includes('+L 70'), 'B (delivered after the change) → L 90 at ITS delivered_at, not A\'s 70');
  h.api.setOrders({ C: {} });   // C has NO delivered_at → the rate is unknowable
  h.api.showInterlude(ilInfo('C', 100, 0));
  assert.ok(!/\+L \d/.test(h.il().innerHTML), 'C with an unknown rate (no delivered_at) → nothing injected');
});

t('P1 (Codex r1): an order attributed to ANOTHER driver → NO «+L» per-delivery row (the attribution leak)', () => {
  const B = 1767225600000;
  const orders = { mine: { delivered_at: B + 1000, delivered_by_driver_uid: 'drv' }, theirs: { delivered_at: B + 2000, delivered_by_driver_uid: 'otherdrv' } };
  const h = showHarness({ pagosLive: true, rateEntries: { a: { cents: 7000, effective_from: B } }, allOrders: orders });
  h.api.showInterlude(ilInfo('theirs', 385, 0));
  assert.ok(!/\+L \d/.test(h.il().innerHTML), 'another driver\'s order → no per-delivery pay (same attribution the day total uses)');
  h.api.showInterlude(ilInfo('mine', 385, 0));
  assert.ok(h.il().innerHTML.includes('+L 70'), 'the driver\'s OWN delivery → +L 70');
});

t('reuse: refreshOpenCashSurfaces re-injects the OPEN interlude on a late rate load, idempotently', () => {
  const B = 1767225600000;
  const h = showHarness({ pagosLive: true, rateEntries: null, allOrders: { A: { delivered_at: B + 1000, delivered_by_driver_uid: 'drv' } } });
  h.api.showInterlude(ilInfo('A', 385, 115));
  assert.ok(!/\+L \d/.test(h.il().innerHTML), 'no rate yet → nothing');
  h.api.setRate({ r: { cents: 7000, effective_from: B } });
  h.api.refresh(); h.api.refresh();   // late load + repeat
  assert.ok(h.il().innerHTML.includes('+L 70'), 'after the rate arrives → +L 70 via the refresh hook');
  assert.equal((h.il().innerHTML.match(/\+L 70/g) || []).length, 1, 'exactly ONE «+L 70» (idempotent refresh)');
});

t('reuse: summary A→B shows B\'s order + B\'s rate (the Tu-pago row never carries stale state)', () => {
  const B = 1767225600000;
  const orders = { A: { payment_method: 'cash', total: 385, delivered_at: B + 1000, delivered_by_driver_uid: 'drv' }, B: { payment_method: 'cash', total: 777, delivered_at: B + 3 * 86400000, delivered_by_driver_uid: 'drv' } };
  const h = showHarness({ pagosLive: true, rateEntries: { a: { cents: 7000, effective_from: B }, b: { cents: 9000, effective_from: B + 2 * 86400000 } }, allOrders: orders });
  h.api.showResumen({ orderId: 'A', name: 'X' });
  assert.ok(h.rs().innerHTML.includes('L 385') && /\+ L 70/.test(h.rs().innerHTML), 'A: total 385 + pay L 70');
  h.rs().classList.remove('open');            // dismissed; new run
  h.api.showResumen({ orderId: 'B', name: 'X' });
  const b = h.rs().innerHTML;
  assert.ok(b.includes('L 777') && /\+ L 90/.test(b) && !b.includes('385') && !/\+ L 70/.test(b), 'B: total 777 + pay L 90, no stale A');
  assert.equal((b.match(/Tu pago por esta entrega/g) || []).length, 1, 'exactly one Tu-pago row');
});

t('reuse resumen «Ganado hoy» readiness transition (Codex r2 P2): shown → not-ready HIDES → ready REAPPEARS, via the refresh hook', () => {
  const RATE = { r: { cents: 7000, effective_from: Date.UTC(2026, 0, 1) } };
  const h = showHarness({ pagosLive: true, rateEntries: RATE, allOrders: { a: DLV(), b: DLV(Date.now() - 1500) } });
  h.api.showResumen({ orderId: 'a', name: 'X' });
  assert.ok(h.rs().querySelector('.rs-stat.rs-earned') && /Ganado hoy · 2 entregas/.test(h.rs().innerHTML), 'ready → «Ganado hoy · 2 entregas» shown');
  h.api.setReady(false); h.api.refresh();   // feed goes not-ready → refreshOpenCashSurfaces re-injects the OPEN resumen
  assert.ok(!h.rs().querySelector('.rs-stat.rs-earned'), 'not ready → card hidden (no false figure)');
  h.api.setReady(true); h.api.refresh();     // readiness returns
  assert.ok(h.rs().querySelector('.rs-stat.rs-earned') && /Ganado hoy · 2 entregas/.test(h.rs().innerHTML), 'ready again → card reappears via the refresh hook (no manual re-open)');
  assert.equal(h.rs().querySelectorAll('.rs-stat.rs-earned').length, 1, 'exactly one card after the transitions');
});

t('reuse resumen «Ganado hoy» added-delivery (Codex r2 P2): a 2nd delivery lands while open → the figure updates on refresh', () => {
  const RATE = { r: { cents: 7000, effective_from: Date.UTC(2026, 0, 1) } };
  const h = showHarness({ pagosLive: true, rateEntries: RATE, allOrders: { a: DLV() } });
  h.api.showResumen({ orderId: 'a', name: 'X' });
  assert.ok(/Ganado hoy · 1 entrega\b/.test(h.rs().innerHTML), 'starts at 1 delivery');
  assert.deepEqual(cardFigure(h.rs()), { cents: 7000, count: 1 }, 'L 70 · 1 entrega');
  h.api.setOrders({ a: DLV(), b: DLV(Date.now() - 1500) });   // a 2nd delivery lands while the resumen is open
  h.api.refresh();
  assert.deepEqual(cardFigure(h.rs()), { cents: 14000, count: 2 }, 'after the refresh → L 140 · 2 entregas (figure updated live)');
  assert.equal(h.rs().querySelectorAll('.rs-stat.rs-earned').length, 1, 'still exactly one card');
});

t('reuse P2a: cash→cashless interlude — B has NO cash line, nothing stale from A', () => {
  const h = showHarness({ pagosLive: false });
  h.api.showInterlude(ilInfo('A', 385, 115));                 // cash
  h.api.showInterlude({ orderId: 'B', name: 'X' });           // cashless (no cash/vuelto → no .il-sub)
  const b = h.il().innerHTML;
  assert.ok(!b.includes('Cobraste') && !b.includes('385') && !b.includes('vuelto L 115'), 'cash→cashless: B has no cash line and no stale A data');
  assert.ok(!b.includes('il-sub'), 'B (cashless, PAGOS off) renders no .il-sub at all');
  // PAGOS on + a known rate: B (cashless) shows ONLY the created «+L 70» sub, still no stale cash
  const BB2 = 1767225600000;
  const h2 = showHarness({ pagosLive: true, rateEntries: { r: { cents: 7000, effective_from: BB2 } }, allOrders: { A: { delivered_at: BB2 + 1000, delivered_by_driver_uid: 'drv' }, B: { delivered_at: BB2 + 1000, delivered_by_driver_uid: 'drv' } } });
  h2.api.showInterlude(ilInfo('A', 385, 115));
  h2.api.showInterlude({ orderId: 'B', name: 'X' });
  const b2 = h2.il().innerHTML;
  assert.ok(b2.includes('+L 70') && b2.includes('class="il-sub"') && !b2.includes('Cobraste') && !b2.includes('385'), 'cash→cashless PAGOS on: B shows ONLY «+L 70» (created sub), no stale cash');
});

t('reuse P2b: summary late load + repeated refresh — «Tu pago» appears after the rate arrives, exactly ONE row after N refreshes', () => {
  const BB3 = 1767225600000;
  const h = showHarness({ pagosLive: true, rateEntries: null, allOrders: { A: { payment_method: 'cash', total: 385, delivered_at: BB3 + 1000, delivered_by_driver_uid: 'drv' } } });
  h.api.showResumen({ orderId: 'A', name: 'X' });
  assert.ok(!h.rs().innerHTML.includes('Tu pago por esta entrega'), 'no rate yet → no «Tu pago» row');
  h.api.setRate({ r: { cents: 7000, effective_from: BB3 } });
  h.api.refresh(); h.api.refresh(); h.api.refresh();          // late load + repeated refresh through refreshOpenCashSurfaces
  const r = h.rs().innerHTML;
  assert.ok(r.includes('Tu pago por esta entrega') && /\+ L 70/.test(r), 'after the rate arrives → the «Tu pago» row with + L 70');
  assert.equal((r.match(/Tu pago por esta entrega/g) || []).length, 1, 'exactly ONE «Tu pago» row after 3 refreshes (idempotent)');
});

Date.now = realDateNow;   // restore the real clock
console.log(`ganancias.test.js: ${passed} passed`);
