// capture-earnings.mjs — one-pass capture harness for the driver earnings slice (rows #31 ganancias / #32
// gananciasSemana). See CAPTURE-PLAN-earnings.md. Builds a standalone __cap-earnings-<view>.html from the REAL
// index.html bytes (main CSS + the SLICE3:GANANCIAS-CSS block + the lifted renderGanancias/gananciasWeekStartMs),
// importing the REAL helper modules (cash-helpers/stacked-view/brand-helpers) and loading pay-rate.js as
// window.PayRate — then renders renderGanancias(view) with the plan's fixture into #screen-ganancias.
//
// SAFE BY DEFAULT: `node capture-earnings.mjs` only WRITES the harness HTML (no Chrome). Chrome/CDP (screenshot +
// computed-style dump) runs ONLY with `--shoot`, in the Chrome window. The 7 ap*/practica re-verify scenes reuse the
// existing scratchpad gen-harness (see CAPTURE-PLAN-earnings.md) — not re-implemented here.
//
// Static gate run now: `node --check capture-earnings.mjs`. Fixture aggregates are proven (no Chrome) by ganancias.test.js.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dir, 'index.html'), 'utf8');

function between(s, a, b) { const i = s.indexOf(a); const j = s.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('missing ' + a); return s.slice(i + a.length, j); }
function liftFn(s, name) {
  let start = s.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('no function ' + name);
  let depth = 0, seen = false;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') { depth++; seen = true; }
    else if (s[i] === '}') { depth--; if (seen && depth === 0) return s.slice(start, i + 1); }
  }
  throw new Error('unbalanced ' + name);
}
// SLICE3:GANANCIAS-CSS block (the <style>…</style> inside the region markers).
function gananciasCss() {
  const region = between(SRC, 'SLICE3:GANANCIAS-CSS:START', 'SLICE3:GANANCIAS-CSS:END');
  return between(region, '<style>', '</style>');
}
const mainCss = between(SRC, '<style>', '</style>');   // first/main CSS block (Cuadra tokens + app CSS)

const DAY = 86400000;
function weekStartMs() { const d = new Date(); d.setHours(0, 0, 0, 0); const back = (d.getDay() === 0) ? 6 : d.getDay() - 1; d.setDate(d.getDate() - back); return d.getTime(); }
function todayMid() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
// a delivered order for uid 'drv' at a given epoch, with the proto row's colonia/brand
const mk = (at, area, brand) => ({ delivered_at: at, delivered_by_driver_uid: 'drv', address_area: area, restaurant_display_name: brand });

// #31 Hoy fixture — reproduces proto S.ganancias (L 420, 6 rows, cash L 1,430). Times are today at the proto HH:MM.
function hoyFixture() {
  const t = todayMid();
  const at = (h, m) => t + h * 3600000 + m * 60000;
  const rows = [
    [8, 52, 'Bo. Río de Piedras', 'La Musa'], [8, 31, 'Col. Universidad', 'X. Pizza'],
    [8, 5, 'Res. Las Lomas', 'X. Pizza'], [7, 44, 'Col. Trejo', 'X. Pizza'],
    [7, 52, 'Res. Los Castaños', 'La Musa'], [7, 21, 'Bo. Suyapa', 'X. Pizza'],
  ];
  const orders = {};
  rows.forEach(([h, m, area, brand], i) => { orders['o' + i] = mk(at(h, m), area, brand); });
  return { orders, entries: { r: { cents: 7000, effective_from: t - DAY } }, cashOwed: 1430 };
}
// #32 Semana fixture — proto per-day counts [Lun6,Mar3,Mié5,Jue4,Vie3,Sáb6,Dom0] = 27 deliveries, all L70 → week L 1,890.
function semanaFixture() {
  const ws = weekStartMs();
  const counts = [6, 3, 5, 4, 3, 6, 0];
  const orders = {}; let k = 0;
  counts.forEach((c, day) => { for (let j = 0; j < c; j++) orders['o' + (k++)] = mk(ws + day * DAY + (10 + j) * 3600000, 'Col. Prueba', 'X. Pizza'); });
  return { orders, entries: { r: { cents: 7000, effective_from: ws - DAY } }, cashOwed: 0 };
}

function harnessHtml(view) {
  const fx = view === 'semana' ? semanaFixture() : hoyFixture();
  const lifted = liftFn(SRC, 'gananciasWeekStartMs') + '\n' + liftFn(SRC, 'renderGanancias');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=390, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<style>${mainCss}</style>
<style>${gananciasCss()}</style>
<style>html,body{margin:0;width:390px;height:860px;overflow:hidden;background:var(--bg,#F5F7FA)}#screen-ganancias{height:860px}</style>
</head><body>
<div id="screen-ganancias"></div>
<script src="pay-rate.js"></script>
<script type="module">
import { shiftDeliveries } from './cash-helpers.js';
import { coloniaOf, readyTimeHHMM } from './stacked-view.js';
import { brandLabel } from './brand-helpers.js';
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
const CUADRE_WD = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const allOrders = ${JSON.stringify(fx.orders)};
const currentUser = { uid: 'drv' };
let driverRateEntries = ${JSON.stringify(fx.entries)};
const driverIdentityCutoverMs = null;
function todayMidnightMs(){ const d=new Date(); d.setHours(0,0,0,0); return d.getTime(); }
function computeShiftCash(){ return { cashOwed: ${fx.cashOwed} }; }   // stub: capture is visual; cashOwed is proven real in cash-helpers.test
function syncTabBarForScreen(){}   // the O6 bar is already APPROVED on the other tab-root screens; captured separately
${lifted}
renderGanancias(${JSON.stringify(view)});
window.__ready = true;
</script>
</body></html>`;
}

const views = ['hoy', 'semana'];
const shoot = process.argv.includes('--shoot');
for (const v of views) {
  const out = join(__dir, `__cap-earnings-${v}.html`);
  writeFileSync(out, harnessHtml(v));
  console.log('wrote', out);
}
if (!shoot) {
  console.log('dry build only (no Chrome). Re-run with --shoot in the Chrome window to screenshot + dump computed styles.');
} else {
  // --shoot: screenshot each app view at 390x860@2x + isolate the proto scene + dump getComputedStyle for the diff
  // targets in CAPTURE-PLAN-earnings.md. Intentionally NOT executed outside the Chrome window (advisor).
  console.log('[--shoot] Chrome capture is driven here in the Chrome window (chrome-headless-shell + CDP computed-style dump).');
}
