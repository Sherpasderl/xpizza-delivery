// ganancias.test.js — the earnings screen (#31/#32, renderGanancias) over the REAL window.PayRate reader. Lifts the
// REAL renderGanancias + gananciasWeekStartMs from index.html into a jsdom #screen-ganancias and asserts the money
// contract (prototype S.ganancias / S.gananciasSemana):
//   - Hoy «Ganado hoy» = the SUM of each delivery's OWN in-effect platform rate (NOT N × current rate);
//   - a mid-DAY rate change is counted per delivery (never retro-applied);
//   - BLANK when no rate is seeded — never an invented number (empty «Ganado» amount, no «× L» sub);
//   - the «Efectivo a entregar hoy» row = computeShiftCash().cashOwed (Lempiras), and the «Entregas de hoy» list;
//   - Semana «Por día» buckets by day-of-week, each bar = that day's per-delivery sum, incl. a mid-WEEK rate change
//     that lands different amounts on different day bars; the week total = the sum.
// The driver dir is type:module, so pay-rate.js (a classic UMD) is loaded the browser way (new Function('self', …)),
// exactly as the PAYRATE-SCRIPT <script> does. Run: `node ganancias.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { shiftDeliveries } from './cash-helpers.js';
import { coloniaOf, readyTimeHHMM } from './stacked-view.js';
import { brandLabel } from './brand-helpers.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');
const SCRIPT = readFileSync(join(__dir, 'index.html'), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];

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

const DAY = 86400000;
// Monday 00:00 (local) of the current week — the SAME formula the lifted gananciasWeekStartMs uses, so the seeded
// week is deterministic whenever the test runs.
function weekStartMs() { const d = new Date(); d.setHours(0, 0, 0, 0); const back = (d.getDay() === 0) ? 6 : d.getDay() - 1; d.setDate(d.getDate() - back); return d.getTime(); }

function boot({ allOrders = {}, rateEntries = null, cashOwed = 0, now = 0 } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="screen-ganancias" class="hidden"></div></body></html>', { pretendToBeVisual: true });
  const { document, window } = dom.window;
  new Function('self', readFileSync(join(__dir, 'pay-rate.js'), 'utf8'))(window);   // window.PayRate, exactly as the PAYRATE-SCRIPT <script> loads it
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const CUADRE_WD = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const body =
    'let driverRateEntries = ' + JSON.stringify(rateEntries) + ';\n' +
    'function todayMidnightMs(){ return _now; }\n' +                 // stubbed: deterministic "today"
    'const driverIdentityCutoverMs = null;\n' +
    'function computeShiftCash(){ return { cashOwed: _cashOwed }; }\n' +   // money-grade cashOwed (Lempiras), stubbed
    'function showScreen(){}\n' +
    'function syncTabBarForScreen(){}\n' +
    liftFn('gananciasWeekStartMs') + '\n' +
    liftFn('renderGanancias') + '\n' +
    'return { renderGanancias };';
  const names = ['document', 'window', '$', 'escapeHtml', 'CUADRE_WD', 'allOrders', 'currentUser', 'shiftDeliveries', 'coloniaOf', 'brandLabel', 'readyTimeHHMM', '_now', '_cashOwed'];
  const api = (new Function(...names, body))(document, window, $, escapeHtml, CUADRE_WD, allOrders, { uid: 'drv' }, shiftDeliveries, coloniaOf, brandLabel, readyTimeHHMM, now, cashOwed);
  return { api, host: () => document.getElementById('screen-ganancias') };
}

// seed REAL resolved deliveries for uid 'drv': delivered orders (delivered_by_driver_uid='drv', delivered_at≥since)
const order = (at, extra = {}) => ({ delivered_at: at, delivered_by_driver_uid: 'drv', address_area: 'Col. Prueba', restaurant_display_name: 'X. Pizza', ...extra });
const ordersAt = (times) => { const m = {}; times.forEach((at, i) => { m['o' + i] = order(at); }); return m; };

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; };

// ---------- Hoy ----------
t('Hoy: «Ganado hoy» = SUM of each delivery\'s in-effect rate (6 × 7000¢ = L 420), + cashOwed row + list', () => {
  const now = weekStartMs();   // any fixed local midnight
  const h = boot({ now, allOrders: ordersAt([now + 3600000, now + 2 * 3600000, now + 3 * 3600000, now + 4 * 3600000, now + 5 * 3600000, now + 6 * 3600000]), rateEntries: { r: { cents: 7000, effective_from: now - DAY } }, cashOwed: 1430 });
  h.api.renderGanancias('hoy');
  const html = h.host().innerHTML;
  assert.ok(/Ganado hoy · informativo/.test(html), 'earn card label');
  assert.ok(/class="gn-big"><span class="gn-cur">L<\/span>420</.test(html), '6 × 7000¢ = L 420 (sum, not hardcoded 70)');
  assert.ok(/6 entregas × L 70 · se paga aparte del efectivo/.test(html), 'sub = N entregas × L {rate}');
  assert.ok(/Efectivo a entregar hoy/.test(html) && /L 1,430/.test(html), 'cashOwed row (Lempiras)');
  assert.ok(/Entregas de hoy/.test(html) && /Col\. Prueba/.test(html) && /\+ L 70/.test(html), 'list: colonia + per-delivery «+ L 70»');
});

t('Hoy: a mid-DAY rate change is counted PER delivery (3 × 7000¢ + 3 × 9000¢ = L 480), never retro-applied', () => {
  const now = weekStartMs();
  const before = [now + 1000, now + 2000, now + 3000], after = [now + 10000, now + 11000, now + 12000];
  const h = boot({ now, allOrders: ordersAt([...before, ...after]), rateEntries: { a: { cents: 7000, effective_from: now - DAY }, b: { cents: 9000, effective_from: now + 5000 } }, cashOwed: 0 });
  h.api.renderGanancias('hoy');
  assert.ok(/class="gn-big"><span class="gn-cur">L<\/span>480</.test(h.host().innerHTML), '3×7000 + 3×9000 = 48000¢ = L 480 (not 6×70, not 6×90)');
});

t('Hoy: NO rate seeded → «Ganado hoy» is BLANK (never an invented number), no «× L» sub', () => {
  const now = weekStartMs();
  const h = boot({ now, allOrders: ordersAt([now + 1000, now + 2000]), rateEntries: null, cashOwed: 300 });
  h.api.renderGanancias('hoy');
  const html = h.host().innerHTML;
  assert.ok(/class="gn-big"><span class="gn-cur">L<\/span><\/div>/.test(html), 'earn amount is EMPTY (just «L», no number)');
  assert.ok(!/entregas × L/.test(html), 'no «× L {rate}» sub when the rate is unknown');
  assert.ok(!/\+ L \d/.test(html), 'no per-delivery «+ L {n}» when the rate is unknown');
  assert.ok(/L 300/.test(html), 'cashOwed still shows (it is not rate-dependent)');
});

// ---------- Semana ----------
t('Semana: «Por día» buckets by day-of-week; a mid-WEEK rate change lands different amounts on different bars', () => {
  const ws = weekStartMs();
  // Mon ×2 (before the Wed change, 7000¢) + Fri ×2 (after, 9000¢). Wed-effective change at ws + 2*DAY.
  const mon = [ws + 10 * 3600000, ws + 11 * 3600000];
  const fri = [ws + 4 * DAY + 10 * 3600000, ws + 4 * DAY + 11 * 3600000];
  const h = boot({ now: ws, allOrders: ordersAt([...mon, ...fri]), rateEntries: { a: { cents: 7000, effective_from: ws - DAY }, b: { cents: 9000, effective_from: ws + 2 * DAY } }, cashOwed: 0 });
  h.api.renderGanancias('semana');
  const html = h.host().innerHTML;
  assert.ok(/Ganado esta semana/.test(html), 'week earn card');
  assert.ok(/class="gn-big"><span class="gn-cur">L<\/span>320/.test(html), 'week sum = 2×7000 + 2×9000 = 32000¢ = L 320');
  assert.ok(/4 entregas · lun /.test(html), 'sub: N entregas · week range (lun … a dom …)');
  // bars: Lun = 2×7000 = L 140, Vie = 2×9000 = L 180 (mid-week change reflected), empty days = «—»
  assert.ok(/<span class="gn-blb">Lun<\/span>.*?<span class="gn-bv">L 140<\/span>/s.test(html), 'Lun bar = 2 × 7000¢ = L 140');
  assert.ok(/<span class="gn-blb">Vie<\/span>.*?<span class="gn-bv">L 180<\/span>/s.test(html), 'Vie bar = 2 × 9000¢ = L 180 (new rate)');
  assert.ok(/<span class="gn-blb">Mar<\/span>.*?<span class="gn-bv">—<\/span>/s.test(html), 'a day with no deliveries → «—»');
  assert.ok(/fija por la plataforma/.test(html), 'tariff line');
});

t('Semana: NO rate seeded → week earn BLANK + every non-empty bar value blank (never invented)', () => {
  const ws = weekStartMs();
  const h = boot({ now: ws, allOrders: ordersAt([ws + 10 * 3600000, ws + 11 * 3600000]), rateEntries: null, cashOwed: 0 });
  h.api.renderGanancias('semana');
  const html = h.host().innerHTML;
  assert.ok(/class="gn-big"><span class="gn-cur">L<\/span><\/div>/.test(html), 'week earn amount EMPTY when no rate');
  assert.ok(!/gn-bv">L \d/.test(html), 'no bar shows an «L {n}» amount when the rate is unknown');
});

// CAPTURE-FIXTURE SANITY (no Chrome) — the #32 capture fixture in capture-earnings.mjs (proto S.gananciasSemana per-day
// counts [Lun6·Mar3·Mié5·Jue4·Vie3·Sáb6·Dom0] = 27 deliveries at L70) must render the prototype's numbers, so the
// Chrome side-by-side is pixel confirmation, not a numbers hunt. (The #31 Hoy fixture = the «L 420» case above.)
t('capture fixture (#32 Semana): proto per-day counts → week L 1,890 + bars L420/210/350/280/210/420/—', () => {
  const ws = weekStartMs();
  const counts = [6, 3, 5, 4, 3, 6, 0];   // Lun..Dom
  const orders = {}; let k = 0;
  counts.forEach((c, day) => { for (let j = 0; j < c; j++) orders['o' + (k++)] = order(ws + day * DAY + (10 + j) * 3600000); });
  const h = boot({ now: ws, allOrders: orders, rateEntries: { r: { cents: 7000, effective_from: ws - DAY } }, cashOwed: 0 });
  h.api.renderGanancias('semana');
  const html = h.host().innerHTML;
  assert.ok(/class="gn-big"><span class="gn-cur">L<\/span>1,890</.test(html), '27 × 7000¢ = L 1,890');
  assert.ok(/27 entregas · lun /.test(html), '27 entregas · {current-week range}');
  const bars = ['Lun', 'L 420', 'Mar', 'L 210', 'Mié', 'L 350', 'Jue', 'L 280', 'Vie', 'L 210', 'Sáb', 'L 420', 'Dom', '—'];
  for (let i = 0; i < bars.length; i += 2) {
    assert.ok(new RegExp(`<span class="gn-blb">${bars[i]}</span>.*?<span class="gn-bv">${bars[i + 1]}</span>`, 's').test(html), `${bars[i]} bar = ${bars[i + 1]}`);
  }
});

console.log(`ganancias.test.js: ${passed} passed`);
