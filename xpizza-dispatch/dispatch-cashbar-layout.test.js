// dispatch-cashbar-layout.test.js — REAL layout check (headless Chrome) for the cash/cuadre bar (codex r2 P1).
//
// Uses PRODUCTION markup + CSS + selector hooks: the full index.html <style> plus the real ancestor chain
// (.app.left-open.right-open > .main#main-grid > .col.right.panel#right-rail > .rail-inner > .phead + .pbody#pbody
// + .cash-bar#cash-bar). Rail WIDTH comes only from the real size variable (--rw-size); rail HEIGHT comes from the
// real layout (.app height = calc(100vh - topbar)). Renders the ACTUAL renderCashBar output at 300/342/480px for
// two states (all-categories totals AND the invalid/error bar) and measures in Chrome that:
//   • no horizontal overflow (scrollWidth ≤ clientWidth); the all-categories bar WRAPS to ≥2 rows (flex-wrap);
//   • CRITICAL CONTENT — the review line, the error line, and the Reconciliar label — has EVERY text fragment
//     (text-node Range.getClientRects()) inside the intersection of ALL applicable padding-box clips, INCLUDING the
//     control's OWN box when it sets overflow:hidden, with only a subpixel epsilon. No area tolerance on text: a
//     single trailing character cut by any clip ancestor fails (codex r6). Each critical control is also
//     effectively visible (computed display/visibility/opacity up the chain) and positive-sized;
//   • the full-width CONTAINERS (.pbody roster viewport, .cash-bar) sit within each clip ancestor's padding box,
//     tolerating ONLY the known ~2px border discrepancy per edge (the rail-inner is exactly 2px wider than the
//     1px-bordered .col padding box, so a full-width child tucks ≤2px under that border by design) + subpixel —
//     NOT a percentage of area;
//   • the roster is effectively visible, positive-sized, has a positive viewport AND actually scrolls.
// Negative cells prove each check bites: (a) no .right-open → collapsed grid col clips the rail controls' text;
// (b) a control in an ancestor's BORDER band → clipped under the padding-box rule (a border-rect check would pass
// it); (c) .pbody opacity:0 → roster not effectively visible; (i) a Reconciliar button whose OWN overflow:hidden
// box is narrowed clips its label (chain starts AT the element); (ii) a review/error line losing <10% of its
// trailing text → caught by the text-fragment check though the old area metric would have passed it.
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

// This layout check is wired into the default npm test chain (xpizza-functions package.json), so it must FAIL
// LOUDLY if Chrome is missing — never skip. A silent skip would look like coverage in CI while proving nothing.
if (!fs.existsSync(CHROME)) { console.error(`\n✗ FAIL: Google Chrome not found at ${CHROME} — this real-layout check requires Chrome and must not be skipped. Install Chrome (or run where it is available) to execute the cash-bar layout gate.`); process.exit(1); }

// ── Measurement helpers (shared) ──
//  effVisible   — display/visibility/opacity up the ancestor chain.
//  clipRect     — intersection of the PADDING boxes of every overflow-clipping element from the element itself
//                 (INCLUSIVE, so a control that clips its OWN label with overflow:hidden is caught) up through its
//                 ancestors. overflow clips at the padding edge (clientLeft/Top + clientWidth/Height), not the border.
//  textVisible  — every TEXT fragment (text-node Range rects) of a critical control lies inside clipRect, subpixel
//                 epsilon only. No area tolerance: trailing characters cut by ANY clip ancestor fail (codex r6).
//  boxUnclipped — a full-width CONTAINER's border-box within each ancestor's padding box, tolerating only the known
//                 ~2px border discrepancy per edge (+ subpixel). The rail-inner/pbody/cash-bar are exactly 2px wider
//                 than the 1px-bordered .col padding box, so they tuck ≤2px under that border by design.
const MEASURE_FNS = `
 var SUBPX=0.5;      // subpixel epsilon only
 var BORDER_TOL=2;   // full-width containers only: 1px .col border each side = exactly 2px of by-design tuck
 function effVisible(el){var e=el;while(e&&e.nodeType===1){var cs=getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity||'1')===0)return false;e=e.parentElement;}return true;}
 function clipRect(el){var L=-1e9,T=-1e9,R=1e9,B=1e9,e=el;while(e&&e.nodeType===1){var cs=getComputedStyle(e);if(cs.overflow!=='visible'||cs.overflowX!=='visible'||cs.overflowY!=='visible'){var br=e.getBoundingClientRect();var pl=br.left+e.clientLeft,pt=br.top+e.clientTop,pr=pl+e.clientWidth,pb=pt+e.clientHeight;if(pl>L)L=pl;if(pt>T)T=pt;if(pr<R)R=pr;if(pb<B)B=pb;}e=e.parentElement;}return {l:L,t:T,r:R,b:B};}
 function textVisible(el){if(!el)return false;var clip=clipRect(el);var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT,null),node,rects=[];while((node=w.nextNode())){if(!node.nodeValue||!node.nodeValue.trim())continue;var rng=document.createRange();rng.selectNodeContents(node);var rs=rng.getClientRects();for(var i=0;i<rs.length;i++){if(rs[i].width>0&&rs[i].height>0)rects.push(rs[i]);}}if(!rects.length)return false;for(var j=0;j<rects.length;j++){var r=rects[j];if(r.left<clip.l-SUBPX||r.right>clip.r+SUBPX||r.top<clip.t-SUBPX||r.bottom>clip.b+SUBPX)return false;}return true;}
 function boxUnclipped(el,tol){if(!el)return false;var r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)return false;var t=(tol==null?BORDER_TOL:tol)+SUBPX,e=el.parentElement;while(e&&e.nodeType===1){var cs=getComputedStyle(e);if(cs.overflow!=='visible'||cs.overflowX!=='visible'||cs.overflowY!=='visible'){var br=e.getBoundingClientRect();var pl=br.left+e.clientLeft,pt=br.top+e.clientTop,pr=pl+e.clientWidth,pb=pt+e.clientHeight;if(r.left<pl-t||r.right>pr+t||r.top<pt-t||r.bottom>pb+t)return false;}e=e.parentElement;}return true;}
 function box(el){if(!el)return null;var r=el.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),vis:effVisible(el)};}`;

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
 var pb=box(pbody);
 function crit(sel){var el=cb.querySelector(sel);if(!el)return null;var b=box(el);b.textVisible=textVisible(el);return b;}
 var res={width:${width},sw:cb.scrollWidth,cw:cb.clientWidth,overflow:cb.scrollWidth>cb.clientWidth+1,rows:centers.size,
   rosterViewport:vh,rosterScrolls:(vh>0&&moved>0),rosterVis:pb.vis,rosterH:pb.h,rosterBox:boxUnclipped(pbody),
   cbBox:boxUnclipped(cb),
   recon:crit('.cash-recon-btn'),review:crit('.ci.cash-escape'),error:crit('.ci.cash-error')};
 document.getElementById('out').textContent='LAYOUT_RESULT:'+JSON.stringify(res)+':END';
</script></body></html>`;
}
// Negative cell (b): the clip region is the PADDING box, not the border rect — a control wholly inside a thick
// border band is clipped by overflow:hidden; a border-rect check would wrongly pass it.
function borderBoxPage() {
  return `<!doctype html><meta charset=utf8><style>#clip{position:relative;width:200px;height:80px;border:25px solid gray;overflow:hidden}#inside{position:absolute;left:10px;top:10px;width:12px;height:12px}#inborder{position:absolute;left:-18px;top:10px;width:12px;height:12px}</style>
<div id=clip><div id=inside></div><div id=inborder></div></div><div id=out></div>
<script>${MEASURE_FNS}
 var res={inside:boxUnclipped(document.getElementById('inside'),2), inborder:boxUnclipped(document.getElementById('inborder'),2)};
 document.getElementById('out').textContent='LAYOUT_RESULT:'+JSON.stringify(res)+':END';
</script>`;
}
// Negative cells (i) + (ii): text-fragment clipping below the old area threshold / by the element's own box.
function textClipPage() {
  return `<!doctype html><meta charset=utf8><style>
 button,span{font:14px sans-serif}
 #btnClip{overflow:hidden;width:40px;white-space:nowrap;padding:0;border:0;display:inline-block}
 #btnOk{white-space:nowrap;padding:0;border:0;display:inline-block}
 #lineWrap,#lineOkWrap{overflow:hidden;white-space:nowrap;display:inline-block}
</style>
<button id=btnClip>Reconciliar</button><button id=btnOk>Reconciliar</button>
<div id=lineWrap><span id=line>Efectivo final C$ 12.345,67 · revisar</span></div>
<div id=lineOkWrap><span id=lineOk>Efectivo final C$ 12.345,67 · revisar</span></div>
<div id=out></div>
<script>${MEASURE_FNS}
 var line=document.getElementById('line'), lw=document.getElementById('lineWrap');
 var natural=line.getBoundingClientRect().width;
 lw.style.width=Math.round(natural*0.93)+'px';   // clip ~7% of the trailing text — BELOW the old 10% area threshold
 void lw.offsetWidth;
 var res={
   btnClip:textVisible(document.getElementById('btnClip')),   // own overflow:hidden box narrows the label
   btnOk:textVisible(document.getElementById('btnOk')),
   line:textVisible(line),
   lineOk:textVisible(document.getElementById('lineOk')),
   lineVisibleFraction:lw.clientWidth/natural};
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
        assert.ok(r.rosterVis && r.rosterBox && r.rosterH > 0, `${st.name} @ ${width}px: roster effectively visible, positive-sized, container within ±2px of the padding box`);
        assert.strictEqual(r.cbBox, true, `${st.name} @ ${width}px: cash-bar container within ±2px of each ancestor's padding box`);
        if (st.wrap && width <= 342) assert.ok(r.rows >= 2, `${st.name} @ ${width}px: bar WRAPPED to ≥2 rows (rows=${r.rows})`);
        for (const key of st.critical) {
          const b = r[key];
          assert.ok(b && b.w > 0 && b.h > 0, `${st.name} @ ${width}px: ${key} present with positive size`);
          assert.ok(b.vis, `${st.name} @ ${width}px: ${key} is effectively visible`);
          assert.strictEqual(b.textVisible, true, `${st.name} @ ${width}px: every text fragment of ${key} is inside the clip chain (incl its own box), subpixel epsilon`);
        }
        ok(`${st.name} @ ${width}px: no clip, roster ok, ${st.critical.join('+')} text fully visible${st.wrap ? ` (${r.rows} rows)` : ''}`);
      }
    }
    // ── NEGATIVE (a): production ancestors matter — drop .right-open → grid col collapses → critical text clipped ──
    {
      const r = await run(pageFor(342, allBar, { appClasses: 'app left-open' }));
      assert.strictEqual(r.recon && r.recon.textVisible, false, 'negative (a): without .right-open the collapsed grid column clips the Reconciliar label (production hook is load-bearing)');
      ok('negative (a): removing the production .right-open hook clips the rail control text — caught');
    }
    // ── NEGATIVE (b): clip region is the PADDING box, not the border rect ──
    {
      const r = await run(borderBoxPage());
      assert.strictEqual(r.inside, true, 'negative (b): a control inside the padding box is unclipped');
      assert.strictEqual(r.inborder, false, 'negative (b): a control in the BORDER band (outside the padding box) is CLIPPED — padding-box rule, not border-rect');
      ok('negative (b): clipping measured at the padding box (a border-band control is detected as clipped)');
    }
    // ── NEGATIVE (c): roster effective visibility — .pbody opacity:0 caught despite positive clientHeight/scroll ──
    {
      const r = await run(pageFor(342, allBar, { extraCss: '#pbody{opacity:0}' }));
      assert.strictEqual(r.rosterVis, false, 'negative (c): an opacity:0 roster is NOT effectively visible (even with positive clientHeight/scroll)');
      ok('negative (c): roster effective-visibility check catches an invisible (opacity:0) roster viewport');
    }
    // ── NEGATIVE (i)+(ii): text-fragment clipping (own box; and below the old 10% area threshold) ──
    {
      const r = await run(textClipPage());
      assert.strictEqual(r.btnOk, true, 'control (i): a normally-sized Reconciliar label is fully visible');
      assert.strictEqual(r.btnClip, false, 'negative (i): a Reconciliar button whose OWN overflow:hidden box is narrowed clips its label — caught (chain starts AT the element, not parentElement)');
      assert.strictEqual(r.lineOk, true, 'control (ii): an unclipped line is fully visible');
      assert.ok(r.lineVisibleFraction > 0.9, `negative (ii) premise: only ${((1 - r.lineVisibleFraction) * 100).toFixed(1)}% of the line is clipped — the OLD 10% area metric would have PASSED it (visible fraction ${r.lineVisibleFraction.toFixed(3)})`);
      assert.strictEqual(r.line, false, 'negative (ii): a review/error line losing <10% of its trailing text is caught by the text-fragment check');
      ok('negative (i)+(ii): text-fragment check catches an own-box label clip and a <10% trailing-text clip the area metric missed');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });   // only our own page dir — nothing else is ever deleted
  }
  console.log(`\ndispatch-cashbar-layout: OK (${n} checks)`);
})().catch((e) => { console.error('\n✗ FAIL:', e && (e.stack || e.message)); process.exit(1); });
