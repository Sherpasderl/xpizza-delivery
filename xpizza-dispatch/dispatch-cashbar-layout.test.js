// dispatch-cashbar-layout.test.js — REAL layout check (headless Chrome) for the cash/cuadre bar (codex r2 P1).
//
// Uses PRODUCTION markup + CSS + selector hooks: the full index.html <style> plus the real ancestor chain
// (.app.left-open.right-open > .main#main-grid > .col.right.panel#right-rail > .rail-inner > .phead + .pbody#pbody
// + .cash-bar#cash-bar). Rail WIDTH comes only from the real size variable (--rw-size); rail HEIGHT comes from the
// real layout (.app height = calc(100vh - topbar)). Renders the ACTUAL renderCashBar output at 300/342/480px for
// two states (all-categories totals AND the invalid/error bar) and measures in Chrome that:
//   • no horizontal overflow (scrollWidth ≤ clientWidth); the all-categories bar WRAPS to ≥2 rows (flex-wrap);
//   • each critical control (review / error / Reconciliar) AND the roster viewport (.pbody) is EFFECTIVELY visible
//     (computed display/visibility/opacity up the ancestor chain), positive-sized, and NOT clipped by any
//     overflow-clipping ancestor — clipping measured against each ancestor's PADDING box (overflow clips there),
//     not its border rect;
//   • the roster has a positive visible viewport AND actually scrolls (set scrollTop, read it back).
// Negative cells prove each check bites: no .right-open → rail clipped; a control in an ancestor's border gap →
// clipped (padding-box, not border-box); .pbody opacity:0 → roster not effectively visible.
//
// Bounded + SAFE CLEANUP: Chrome runs under a hard deadline that process-GROUP-kills immediately (no pre-kill work
// that could itself block). The test DELETES NOTHING outside its own mkdtemp page dir — a leaked Chrome temp
// profile in $TMPDIR is harmless and the OS reaps it (and proving a dir is OURS from the outside is not reliable).
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

// ── Deterministic preflight (runs even without Chrome) ──
const styleBlock = (html.match(/<style>[\s\S]*?<\/style>/g) || []).join('\n');
assert.ok(styleBlock.includes('.col.right .rail-inner') && styleBlock.includes('.pbody') && styleBlock.includes('right-open'), 'production <style> carries the real rail CSS + open-state hook');
const cashBarRule = html.split('\n').map((l) => l.trim()).find((l) => l.startsWith('.cash-bar {'));
assert.ok(cashBarRule && cashBarRule.includes('flex-wrap: wrap'), 'the .cash-bar rule carries flex-wrap:wrap (the fix under test)');
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
  dA: { s1: C({ cash_owed: 12345, provisional: false }) }, dB: { s1: C({ cash_owed: 6789, provisional: true, unresolved_count: 3 }) },
  dC: { s1: C({ cash_owed: 4200 }) }, dD: { s1: C({ cash_owed: 999, provisional: true, needs_dispatch_review: true }) },
});
const invalidBar = renderBar({ dA: { s1: C({ cash_owed: 'oops', provisional: false }) } });
for (const label of ['Requiere reconciliación manual', 'Sin resolver', 'Efectivo final', 'Provisional', 'Heredado', 'Cuadres pendientes', 'Reconciliar'])
  assert.ok(allBar.includes(label), `all-categories render includes "${label}"`);
assert.ok(invalidBar.includes('Registro de caja inválido') && invalidBar.includes('Reconciliar'), 'invalid render shows the error + Reconciliar');
ok('all-categories + invalid renders contain every expected line (real renderer)');

if (!fs.existsSync(CHROME)) { console.log('  ⚠ Google Chrome not found — browser layout check SKIPPED (run it in the gate env with Chrome).'); process.exit(0); }

// Measurement helpers (shared): effective visibility up the ancestor chain; clipping vs each overflow ancestor's
// PADDING box (overflow:hidden clips to the padding edge — clientLeft/clientTop + clientWidth/clientHeight, NOT the
// border rect). We flag SUBSTANTIAL clipping (>10% of the element's area hidden by some clip ancestor), not a
// pixel: the production rail is a rounded, 1px-bordered .panel, so a full-width child legitimately tucks ≤ the
// border width under that border/radius by design — a pixel-exact "unclipped" is impossible there. The real
// regression surface (r2 P1) is a segment cut off / the rail collapsed / the bar overflowing — all whole-element,
// never a 2px tuck. The visible-fraction rule catches those (negative cell (b): a control in the border BAND is 0%
// inside the padding box → flagged, whereas a border-RECT check would wrongly pass it; negative cell (a): collapsed
// rail → ~0% → flagged) while tolerating the by-design border tuck.
const MEASURE_FNS = `
 var CLIP_MIN_VISIBLE=0.9;
 function effVisible(el){var e=el;while(e&&e.nodeType===1){var cs=getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity||'1')===0)return false;e=e.parentElement;}return true;}
 function unclipped(el){var r=el.getBoundingClientRect();var A=r.width*r.height;if(A<=0)return false;var e=el.parentElement;while(e&&e.nodeType===1){var cs=getComputedStyle(e);if(cs.overflow!=='visible'||cs.overflowX!=='visible'||cs.overflowY!=='visible'){var br=e.getBoundingClientRect();var pl=br.left+e.clientLeft,pt=br.top+e.clientTop,pr=pl+e.clientWidth,pb=pt+e.clientHeight;var iw=Math.max(0,Math.min(r.right,pr)-Math.max(r.left,pl));var ih=Math.max(0,Math.min(r.bottom,pb)-Math.max(r.top,pt));if((iw*ih)/A<CLIP_MIN_VISIBLE)return false;}e=e.parentElement;}return true;}
 function measure(el){if(!el)return null;var r=el.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),vis:effVisible(el),unclipped:unclipped(el)};}`;

// Production page: real .app/.main/#right-rail ancestors; width only via --rw-size; height from the real layout.
function pageFor(width, barHtml, opts = {}) {
  const appClasses = opts.appClasses || 'app left-open right-open';
  const extraCss = opts.extraCss || '';
  return `<!doctype html><html style="--rw-size:${width}px"><head><meta charset=utf8>${styleBlock}<style>${extraCss}</style></head><body>
<div class="${appClasses}" id="app"><div class="main" id="main-grid">
  <div class="col right panel" id="right-rail"><div class="rail-inner">
    <div class="phead"><h2>Repartidores</h2><span class="n">0</span></div>
    <div class="pbody" id="pbody"><div style="height:1600px"></div></div>
    <div class="cash-bar" id="cash-bar">${barHtml}</div>
  </div></div>
</div></div>
<div id="out"></div>
<script>${MEASURE_FNS}
 var cb=document.getElementById('cash-bar'), pbody=document.getElementById('pbody');
 var centers=new Set();[].forEach.call(cb.children,function(e){var r=e.getBoundingClientRect();if(r.width>0)centers.add(Math.round((r.top+r.bottom)/2));});
 var vh=pbody.clientHeight,sb=pbody.scrollTop;pbody.scrollTop=40;var moved=pbody.scrollTop;pbody.scrollTop=sb;
 var res={width:${width},sw:cb.scrollWidth,cw:cb.clientWidth,overflow:cb.scrollWidth>cb.clientWidth+1,rows:centers.size,
   rosterViewport:vh,rosterScrolls:(vh>0&&moved>0),roster:measure(pbody),
   recon:measure(cb.querySelector('.cash-recon-btn')),review:measure(cb.querySelector('.ci.cash-escape')),error:measure(cb.querySelector('.ci.cash-error'))};
 document.getElementById('out').textContent='LAYOUT_RESULT:'+JSON.stringify(res)+':END';
</script></body></html>`;
}
// Negative cell for the padding-box clip rule: a control inside the border area is outside the overflow clip box.
function borderBoxPage() {
  return `<!doctype html><meta charset=utf8><style>#clip{position:relative;width:200px;height:80px;border:25px solid gray;overflow:hidden}#inside{position:absolute;left:10px;top:10px;width:12px;height:12px}#inborder{position:absolute;left:-18px;top:10px;width:12px;height:12px}</style>
<div id=clip><div id=inside></div><div id=inborder></div></div><div id=out></div>
<script>${MEASURE_FNS}
 var res={inside:measure(document.getElementById('inside')).unclipped, inborder:measure(document.getElementById('inborder')).unclipped};
 document.getElementById('out').textContent='LAYOUT_RESULT:'+JSON.stringify(res)+':END';
</script>`;
}

// ── Bounded Chrome: spawn (own group) + hard deadline that group-kills IMMEDIATELY (no pre-kill work). No profile
//    deletion — only the test's own mkdtemp page dir is reaped (in finally). ──
function runChrome(fileUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--window-size=1700,900', '--dump-dom', fileUrl], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
  let seq = 0;
  const run = async (pageHtml) => {
    const file = path.join(tmp, `p${seq++}.html`);
    fs.writeFileSync(file, pageHtml);
    const dom = await runChrome(`file://${file}`);
    const m = dom.match(/LAYOUT_RESULT:(.*?):END/);
    assert.ok(m, 'got a LAYOUT_RESULT from Chrome');
    return JSON.parse(m[1]);
  };
  try {
    // ── POSITIVE: production page, both states × widths ──
    const states = [
      { name: 'all-categories', bar: allBar, critical: ['review', 'recon'], wrap: true },
      { name: 'invalid', bar: invalidBar, critical: ['error', 'recon'], wrap: false },
    ];
    for (const st of states) {
      for (const width of [300, 342, 480]) {
        const r = await run(pageFor(width, st.bar));
        assert.strictEqual(r.overflow, false, `${st.name} @ ${width}px: NO horizontal overflow (sw ${r.sw} ≤ cw ${r.cw})`);
        assert.ok(r.rosterViewport > 0 && r.rosterScrolls, `${st.name} @ ${width}px: roster has a positive viewport (${r.rosterViewport}px) AND scrolls`);
        assert.ok(r.roster && r.roster.vis && r.roster.unclipped && r.roster.h > 0, `${st.name} @ ${width}px: roster is effectively visible, positive-sized, and unclipped`);
        if (st.wrap && width <= 342) assert.ok(r.rows >= 2, `${st.name} @ ${width}px: bar WRAPPED to ≥2 rows (rows=${r.rows})`);
        for (const key of st.critical) {
          const b = r[key];
          assert.ok(b && b.w > 0 && b.h > 0, `${st.name} @ ${width}px: ${key} present with positive size`);
          assert.ok(b.vis, `${st.name} @ ${width}px: ${key} is effectively visible`);
          assert.ok(b.unclipped, `${st.name} @ ${width}px: ${key} is not clipped (padding-box of every overflow ancestor)`);
        }
        ok(`${st.name} @ ${width}px: no clip, roster visible+scrolls, ${st.critical.join('+')} visible+unclipped${st.wrap ? ` (${r.rows} rows)` : ''}`);
      }
    }
    // ── NEGATIVE (a): production ancestors matter — drop .right-open → grid col collapses → rail clipped ──
    {
      const r = await run(pageFor(342, allBar, { appClasses: 'app left-open' }));
      assert.ok(!(r.recon && r.recon.unclipped) || !(r.review && r.review.unclipped), 'without .right-open the rail is CLIPPED by the collapsed grid column (production ancestor/hook is load-bearing)');
      ok('negative (a): removing the production .right-open hook clips the rail controls — caught');
    }
    // ── NEGATIVE (b): padding-box clip rule — a control in the border gap is clipped (border-box would miss it) ──
    {
      const r = await run(borderBoxPage());
      assert.strictEqual(r.inside, true, 'negative (b): a control inside the padding box is unclipped');
      assert.strictEqual(r.inborder, false, 'negative (b): a control in the BORDER area (outside the padding box) is CLIPPED — padding-box rule, not border-box');
      ok('negative (b): clipping measured at the padding box (a border-area control is detected as clipped)');
    }
    // ── NEGATIVE (c): roster effective visibility — .pbody opacity:0 is caught despite positive clientHeight ──
    {
      const r = await run(pageFor(342, allBar, { extraCss: '#pbody{opacity:0}' }));
      assert.strictEqual(r.roster.vis, false, 'negative (c): an opacity:0 roster is NOT effectively visible (even with positive clientHeight/scroll)');
      ok('negative (c): roster effective-visibility check catches an invisible (opacity:0) roster viewport');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });   // only our own page dir — nothing else is ever deleted
  }
  console.log(`\ndispatch-cashbar-layout: OK (${n} checks)`);
})().catch((e) => { console.error('\n✗ FAIL:', e && (e.stack || e.message)); process.exit(1); });
