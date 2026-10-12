// dispatch-cashbar-layout.test.js — REAL layout check (headless Chrome) for the cash/cuadre bar (codex r2 P1).
//
// Renders the ACTUAL renderCashBar output with the ACTUAL .cash-bar CSS inside the REAL rail structure — a
// fixed-height flex column (phead + scrolling roster + cash-bar footer) clipped to the supported rail widths —
// and measures, in Chrome, that with many categories present NOTHING is clipped and the roster still scrolls.
// Two states: the all-categories totals bar, and the invalid/error bar. For each width (300/342/480):
//   • no horizontal overflow (scrollWidth ≤ clientWidth); the all-categories bar WRAPS to ≥2 rows (flex-wrap works);
//   • the critical controls (review line / error line / Reconciliar) have POSITIVE width+height and are FULLY
//     contained in the rail both horizontally AND vertically (not clipped by the rail's right or bottom edge);
//   • the roster (.pbody) still scrolls (the footer didn't consume the scroll area).
//
// Bounded: Chrome runs under a hard deadline with a process-GROUP kill (detached + kill(-pid)); the temp page and
// Chrome profile dir are removed in finally. A hung Chrome fails within the deadline instead of blocking.
//
// Requires Google Chrome. Run:  node dispatch-cashbar-layout.test.js
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEADLINE_MS = 30000;
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── Extract the REAL .cash-bar CSS + the REAL renderCashBar (deterministic — runs even without Chrome) ──
const cssLines = html.split('\n').filter((l) => /^\s*\.(cash-bar|cash-div|cash-recon-btn)\b/.test(l.trim())).map((l) => l.trim());
assert.ok(cssLines.some((l) => l.startsWith('.cash-bar {') && l.includes('flex-wrap: wrap')), 'the .cash-bar rule carries flex-wrap:wrap (the fix under test)');
const fnSrc = (src, name) => { const s = src.indexOf(`function ${name}(`); const e = src.indexOf('\n}\n', s); return src.slice(s, e + 2); };
const src = fnSrc(html, 'renderCashBar');

function renderBar(data) {
  const cashEl = { innerHTML: '' };
  const $ = (id) => (id === 'cash-bar' ? cashEl : { addEventListener() {} });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const render = new Function('$', 'document', 'reconciliationOrders', 'escapeHtml', `let lastDriverCash={},driverCashError=null;\n${src}\nreturn renderCashBar;`)($, { querySelector: () => null }, { o1: {}, o2: {}, o3: {}, o4: {}, o5: {} }, esc);
  render(data);
  return cashEl.innerHTML;
}
const today = Date.now();
const C = (o) => ({ cuadre: { closed_at: today, cash_order_count: 1, ...o } });
const allBar = renderBar({
  dA: { s1: C({ cash_owed: 12345, provisional: false }) },                                   // final
  dB: { s1: C({ cash_owed: 6789, provisional: true, unresolved_count: 3 }) },                // provisional + unresolved
  dC: { s1: C({ cash_owed: 4200 }) },                                                        // legacy (Heredado)
  dD: { s1: C({ cash_owed: 999, provisional: true, needs_dispatch_review: true }) },         // review
});
const invalidBar = renderBar({ dA: { s1: C({ cash_owed: 'oops', provisional: false }) } });  // malformed → error
for (const label of ['Requiere reconciliación manual', 'Sin resolver', 'Efectivo final', 'Provisional', 'Heredado', 'Cuadres pendientes', 'Reconciliar'])
  assert.ok(allBar.includes(label), `all-categories render includes "${label}"`);
assert.ok(invalidBar.includes('Registro de caja inválido') && invalidBar.includes('Reconciliar'), 'invalid render shows the error + Reconciliar');
ok('all-categories + invalid renders contain every expected line (real renderer)');

if (!fs.existsSync(CHROME)) { console.log('  ⚠ Google Chrome not found — browser layout check SKIPPED (run it in the gate env with Chrome).'); process.exit(0); }

// ── A page with the REAL rail: fixed-height flex column — phead (pinned) + scrolling roster (.pbody) + cash-bar ──
function pageFor(width, barHtml) {
  return `<!doctype html><meta charset=utf8><style>
:root{--surface:#1a212c;--text:#e8eef6;--text-dim:#8a97a8;--warn:#e7bd86;--accent:#ec9aa1;--border-soft:#2a333f}
*{box-sizing:border-box}body{margin:0;font-family:Inter,system-ui,sans-serif;color:var(--text)}
#rail{width:${width}px;height:520px;display:flex;flex-direction:column;overflow:hidden}
.phead-x{flex:none;height:44px;border-bottom:1px solid var(--border-soft)}
.pbody-x{flex:1;min-height:0;overflow-y:auto}
.roster-tall{height:1600px}
${cssLines.join('\n')}
</style>
<div id=rail><div class=phead-x>Repartidores</div><div class=pbody-x id=pbody><div class=roster-tall>roster</div></div><div class=cash-bar id=cb>${barHtml}</div></div>
<div id=out></div>
<script>
 var rail=document.getElementById('rail').getBoundingClientRect();
 var cb=document.getElementById('cb');
 var pbody=document.getElementById('pbody');
 function box(sel){var e=cb.querySelector(sel);if(!e)return null;var r=e.getBoundingClientRect();
   return {w:Math.round(r.width),h:Math.round(r.height),
     inH:(r.left>=rail.left-1 && r.right<=rail.right+1), inV:(r.top>=rail.top-1 && r.bottom<=rail.bottom+1)};}
 var centers=new Set();
 [].forEach.call(cb.children,function(e){var r=e.getBoundingClientRect(); if(r.width>0) centers.add(Math.round((r.top+r.bottom)/2));});
 var res={width:${width},sw:cb.scrollWidth,cw:cb.clientWidth,overflow:cb.scrollWidth>cb.clientWidth+1,rows:centers.size,
   rosterScrolls: pbody.scrollHeight>pbody.clientHeight+1,
   recon:box('.cash-recon-btn'), review:box('.ci.cash-escape'), error:box('.ci.cash-error')};
 document.getElementById('out').textContent='LAYOUT_RESULT:'+JSON.stringify(res)+':END';
</script>`;
}

// ── Bounded Chrome: spawn (own process group) + hard deadline + group kill; cleanup in finally. ──
// (No explicit --user-data-dir: Chrome headless makes + reaps its own ephemeral profile — an explicit fresh
//  --user-data-dir hangs first-run setup here — so nothing profile-wise leaks; the finally reaps the temp pages.)
function runChrome(fileUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--window-size=900,900', '--dump-dom', fileUrl], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '', done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} finish(reject, new Error(`Chrome exceeded the ${DEADLINE_MS}ms deadline (process group killed)`)); }, DEADLINE_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', () => finish(resolve, out));
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cashbar-layout-'));
  try {
    // Each state names the critical controls that MUST be present + fully visible.
    const states = [
      { name: 'all-categories', bar: allBar, critical: ['review', 'recon'], wrap: true },
      { name: 'invalid', bar: invalidBar, critical: ['error', 'recon'], wrap: false },
    ];
    for (const st of states) {
      for (const width of [300, 342, 480]) {
        const file = path.join(tmp, `${st.name}-${width}.html`);
        fs.writeFileSync(file, pageFor(width, st.bar));
        const dom = await runChrome(`file://${file}`);
        const m = dom.match(/LAYOUT_RESULT:(.*?):END/);
        assert.ok(m, `${st.name} @ ${width}px: got a LAYOUT_RESULT from Chrome`);
        const r = JSON.parse(m[1]);
        assert.strictEqual(r.overflow, false, `${st.name} @ ${width}px: NO horizontal overflow (scrollWidth ${r.sw} ≤ clientWidth ${r.cw})`);
        assert.strictEqual(r.rosterScrolls, true, `${st.name} @ ${width}px: the roster still scrolls (footer didn't eat the scroll area)`);
        if (st.wrap && width <= 342) assert.ok(r.rows >= 2, `${st.name} @ ${width}px: bar WRAPPED to ≥2 rows (rows=${r.rows}) — flex-wrap engaged`);
        for (const key of st.critical) {
          const b = r[key];
          assert.ok(b, `${st.name} @ ${width}px: the ${key} control is present`);
          assert.ok(b.w > 0 && b.h > 0, `${st.name} @ ${width}px: the ${key} control has positive size (w=${b.w},h=${b.h}) — not hidden`);
          assert.ok(b.inH && b.inV, `${st.name} @ ${width}px: the ${key} control is fully inside the rail (H=${b.inH},V=${b.inV}) — not clipped`);
        }
        ok(`${st.name} @ ${width}px: no clip, roster scrolls, ${st.critical.join('+')} visible & contained${st.wrap ? ` (${r.rows} rows)` : ''}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\ndispatch-cashbar-layout: OK (${n} checks)`);
})().catch((e) => { console.error('\n✗ FAIL:', e && (e.stack || e.message)); process.exit(1); });
