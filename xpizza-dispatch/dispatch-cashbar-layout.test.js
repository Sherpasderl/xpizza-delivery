// dispatch-cashbar-layout.test.js — REAL layout check (headless Chrome) for the cash/cuadre bar (codex r2 P1).
//
// With every category present (review + unresolved + final + provisional + Heredado) PLUS the payment-pending
// count and Reconciliar, the bar must not clip inside the fixed-width rail (342px, overflow:hidden). This renders
// the ACTUAL renderCashBar output with the ACTUAL .cash-bar CSS into a clipping rail and measures, in Chrome,
// that every line + the Reconciliar control has a bounding box fully inside the rail (no horizontal clip) at the
// supported widths (narrowest 300 / default 342 / wide 480). The bar is allowed to grow VERTICALLY (it wraps).
//
// Requires Google Chrome. Run:  node dispatch-cashbar-layout.test.js
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

if (!fs.existsSync(CHROME)) { console.log('  ⚠ Google Chrome not found — layout check SKIPPED (run it in the gate env with Chrome).'); process.exit(0); }

// ── Extract the REAL .cash-bar CSS + the REAL renderCashBar ──
const cssLines = html.split('\n').filter((l) => /^\s*\.(cash-bar|cash-div|cash-recon-btn)\b/.test(l.trim())).map((l) => l.trim());
assert.ok(cssLines.some((l) => l.includes('flex-wrap')), 'cash-bar CSS carries flex-wrap (the fix under test)');
const fnSrc = (src, name) => { const s = src.indexOf(`function ${name}(`); const e = src.indexOf('\n}\n', s); return src.slice(s, e + 2); };
const src = fnSrc(html, 'renderCashBar');

// Render the ALL-CATEGORIES bar through the real renderer.
const today = Date.now();
const cashEl = { innerHTML: '' };
const $ = (id) => (id === 'cash-bar' ? cashEl : { addEventListener() {} });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const C = (o) => ({ cuadre: { closed_at: today, cash_order_count: 1, ...o } });
const allCats = {
  dA: { s1: C({ cash_owed: 12345, provisional: false }) },                                   // final
  dB: { s1: C({ cash_owed: 6789, provisional: true, unresolved_count: 3 }) },                // provisional + unresolved
  dC: { s1: C({ cash_owed: 4200 }) },                                                        // legacy (Heredado)
  dD: { s1: C({ cash_owed: 999, provisional: true, needs_dispatch_review: true }) },         // review
};
const render = new Function('$', 'document', 'reconciliationOrders', 'escapeHtml', `let lastDriverCash={},driverCashError=null;\n${src}\nreturn renderCashBar;`)($, { querySelector: () => null }, { o1: {}, o2: {}, o3: {}, o4: {}, o5: {} }, esc);
render(allCats);
const barHtml = cashEl.innerHTML;
for (const label of ['Requiere reconciliación manual', 'Sin resolver', 'Efectivo final', 'Provisional', 'Heredado', 'Cuadres pendientes', 'Reconciliar'])
  assert.ok(barHtml.includes(label), `all-categories render includes "${label}"`);
ok('all-categories render contains every line + Reconciliar (real renderer)');

// ── Build a test page: the rail clip (width W, overflow:hidden) around the real .cash-bar HTML + CSS ──
function pageFor(width) {
  return `<!doctype html><html><head><meta charset="utf8"><style>
:root{--surface:#1a212c;--text:#e8eef6;--text-dim:#8a97a8;--warn:#e7bd86;--accent:#ec9aa1;--border-soft:#2a333f;}
*{box-sizing:border-box} body{margin:0;font-family:Inter,system-ui,sans-serif}
#rail{width:${width}px;overflow:hidden;background:#111}
${cssLines.join('\n')}
.cash-bar .ci b{font-family:'IBM Plex Mono',ui-monospace,monospace}
</style></head><body>
<div id="rail"><div class="cash-bar" id="cb">${barHtml}</div></div>
<div id="out"></div>
<script>
 var rail=document.getElementById('rail').getBoundingClientRect();
 var cb=document.getElementById('cb');
 var over=[]; var centers=new Set();
 // Definitive horizontal-clip signal: content overflows the clipping box (scrollWidth > clientWidth). With
 // flex-wrap the content WRAPS to extra rows → no overflow; with nowrap the categories overflow the 342px rail.
 var contentOverflow = cb.scrollWidth > cb.clientWidth + 1;
 [].forEach.call(cb.children,function(el){
   var r=el.getBoundingClientRect();
   centers.add(Math.round((r.top+r.bottom)/2));   // vertical center band → row count (align-items:center groups a row)
   var txt=(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,24);
   if(r.width>0 && (r.right>rail.right+1 || r.left<rail.left-1)) over.push({t:txt,right:Math.round(r.right),railRight:Math.round(rail.right)});
 });
 var clipped = contentOverflow || over.length>0;
 document.getElementById('out').textContent='LAYOUT_RESULT:'+JSON.stringify({width:${width},childCount:cb.children.length,sw:cb.scrollWidth,cw:cb.clientWidth,rows:centers.size,over:over,clipped:clipped})+':END';
</script></body></html>`;
}

function measure(width) {
  const file = path.join(os.tmpdir(), `cashbar-layout-${width}-${Date.now()}.html`);
  fs.writeFileSync(file, pageFor(width));
  // perl alarm wrapper so headless Chrome can't hang the test (memory note).
  const dom = execFileSync('perl', ['-e', 'alarm 30; exec @ARGV', CHROME, '--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=900,700', '--dump-dom', `file://${file}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  fs.unlinkSync(file);
  const m = dom.match(/LAYOUT_RESULT:(.*?):END/);
  assert.ok(m, `got a LAYOUT_RESULT from Chrome at ${width}px`);
  return JSON.parse(m[1]);
}

for (const width of [300, 342, 480]) {
  const res = measure(width);
  assert.ok(res.childCount >= 7, `${width}px: all 7+ segments present (got ${res.childCount})`);
  assert.strictEqual(res.clipped, false, `${width}px: NO horizontal clip — content fits the rail (scrollWidth ${res.sw} > clientWidth ${res.cw}; over=${JSON.stringify(res.over)})`);
  if (width <= 342) assert.ok(res.rows >= 2, `${width}px: the bar WRAPPED to multiple rows (rows=${res.rows}) rather than cramming into one — proves flex-wrap engaged`);
  ok(`layout @ ${width}px: no clip (sw ${res.sw} ≤ cw ${res.cw}), ${res.rows} row(s), ${res.childCount} segments — measured in Chrome`);
}

console.log(`\ndispatch-cashbar-layout: OK (${n} checks)`);
