// dispatch-cashbar-layout.test.js — REAL layout check (headless Chrome) for the cash/cuadre bar (codex r2 P1).
//
// Uses PRODUCTION markup + CSS: the full index.html <style> plus the real rail nesting
// (.col.right > .rail-inner > .phead + .pbody + .cash-bar) — not a hand-copied rail — so production ancestor
// clipping/positioning is exercised. Renders the ACTUAL renderCashBar output into the real #cash-bar at the
// supported rail widths (--rw-size 300/342/480) for two states (all-categories totals AND the invalid/error bar),
// and measures in Chrome that:
//   • no horizontal overflow (scrollWidth ≤ clientWidth); the all-categories bar WRAPS to ≥2 rows (flex-wrap);
//   • each critical control (review line / error line / Reconciliar) is EFFECTIVELY visible (computed
//     display/visibility/opacity up the ancestor chain), has positive size, and is NOT clipped by ANY
//     overflow-clipping ancestor (rect intersected with every clipping ancestor);
//   • the roster (.pbody) has a POSITIVE visible viewport AND actually scrolls (set scrollTop, read it back).
//
// Bounded: Chrome runs under a hard deadline with a process-GROUP kill (detached + kill(-pid)). An explicit
// --user-data-dir hangs Chrome's first-run here (verified across headless modes + the usual anti-hang flags), so
// the test lets Chrome make its own ephemeral profile (which it reaps on clean exit). On the SIGKILL (deadline)
// path a destructor is bypassed, so the test reaps the profile itself — but ONLY dirs PROVABLY ours: `lsof -g
// <our process group>` is the authority (a parallel session's or the owner's Chrome can also create
// com.google.Chrome.* temp dirs, so a blind snapshot-diff must NEVER be used). A dir we can't prove is ours is
// left alone (a leaked temp dir is harmless; the OS reaps it). Temp pages are reaped in finally.
//
// Requires Google Chrome. Run:  node dispatch-cashbar-layout.test.js
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEADLINE_MS = 30000;
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── Deterministic preflight (runs even without Chrome) ──
const styleBlock = (html.match(/<style>[\s\S]*?<\/style>/g) || []).join('\n');
assert.ok(styleBlock.includes('.rail-inner') && styleBlock.includes('.pbody') && styleBlock.includes('.col.right'), 'production <style> carries the real rail CSS');
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

// ── A page built from PRODUCTION <style> + the real rail nesting (--rw-size sets the rail width) ──
function pageFor(width, barHtml) {
  return `<!doctype html><html style="--rw-size:${width}px"><head><meta charset=utf8>${styleBlock}</head><body>
<div class="app"><div class="col right" style="height:520px"><div class="rail-inner">
  <div class="phead"><h2>Repartidores</h2><span class="n">0</span></div>
  <div class="pbody" id="pbody"><div style="height:1600px"></div></div>
  <div class="cash-bar" id="cash-bar">${barHtml}</div>
</div></div></div>
<div id="out"></div>
<script>
 var cb=document.getElementById('cash-bar'), pbody=document.getElementById('pbody');
 function effVisible(el){var e=el;while(e&&e.nodeType===1){var cs=getComputedStyle(e);if(cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity||'1')===0)return false;e=e.parentElement;}return true;}
 function unclipped(el){var r=el.getBoundingClientRect(),e=el.parentElement;while(e&&e.nodeType===1){var cs=getComputedStyle(e);if(cs.overflow!=='visible'||cs.overflowX!=='visible'||cs.overflowY!=='visible'){var c=e.getBoundingClientRect();if(r.left<c.left-1||r.right>c.right+1||r.top<c.top-1||r.bottom>c.bottom+1)return false;}e=e.parentElement;}return true;}
 function box(sel){var el=cb.querySelector(sel);if(!el)return null;var r=el.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),vis:effVisible(el),unclipped:unclipped(el)};}
 var centers=new Set();[].forEach.call(cb.children,function(e){var r=e.getBoundingClientRect();if(r.width>0)centers.add(Math.round((r.top+r.bottom)/2));});
 var vh=pbody.clientHeight; var sb=pbody.scrollTop; pbody.scrollTop=40; var moved=pbody.scrollTop; pbody.scrollTop=sb;
 var res={width:${width},sw:cb.scrollWidth,cw:cb.clientWidth,overflow:cb.scrollWidth>cb.clientWidth+1,rows:centers.size,
   rosterViewport:vh, rosterScrolls:(vh>0 && moved>0),
   recon:box('.cash-recon-btn'), review:box('.ci.cash-escape'), error:box('.ci.cash-error')};
 document.getElementById('out').textContent='LAYOUT_RESULT:'+JSON.stringify(res)+':END';
</script></body></html>`;
}

// lsof is the AUTHORITY on profile ownership: only com.google.Chrome.* temp dirs that OUR process group currently
// holds open are ours. Never attribute a dir to us by snapshot-diff.
function ownedChromeDirs(pgid) {
  const T = os.tmpdir();
  try {
    const out = execSync(`lsof -g ${pgid} 2>/dev/null`, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const names = new Set();
    for (const mm of out.matchAll(/com\.google\.Chrome\.[^/\s]+/g)) names.add(mm[0]);
    return [...names].map((name) => path.join(T, name));
  } catch (_) { return []; }   // lsof unavailable/empty → prove nothing → delete nothing
}

// ── Bounded Chrome: spawn (own group) + hard deadline + group-kill; reap ONLY our own profile on the kill path ──
function runChrome(fileUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--window-size=900,900', '--dump-dom', fileUrl], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '', done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => {
      const owned = ownedChromeDirs(child.pid);   // captured while ALIVE — provably ours (our process group holds them)
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
      for (const d of owned) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }   // reap only OUR profile
      finish(reject, new Error(`Chrome exceeded the ${DEADLINE_MS}ms deadline (process group killed; own profile reaped)`));
    }, DEADLINE_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', () => finish(resolve, out));   // clean exit → Chrome reaps its own ephemeral profile
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cashbar-layout-'));
  try {
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
        assert.ok(r.rosterViewport > 0, `${st.name} @ ${width}px: roster has a POSITIVE visible viewport (${r.rosterViewport}px)`);
        assert.strictEqual(r.rosterScrolls, true, `${st.name} @ ${width}px: the roster actually scrolls (set/read scrollTop)`);
        if (st.wrap && width <= 342) assert.ok(r.rows >= 2, `${st.name} @ ${width}px: bar WRAPPED to ≥2 rows (rows=${r.rows}) — flex-wrap engaged`);
        for (const key of st.critical) {
          const b = r[key];
          assert.ok(b, `${st.name} @ ${width}px: the ${key} control is present`);
          assert.ok(b.w > 0 && b.h > 0, `${st.name} @ ${width}px: ${key} has positive size (w=${b.w},h=${b.h})`);
          assert.ok(b.vis, `${st.name} @ ${width}px: ${key} is effectively visible (display/visibility/opacity up the ancestor chain)`);
          assert.ok(b.unclipped, `${st.name} @ ${width}px: ${key} is not clipped by any overflow-clipping ancestor`);
        }
        ok(`${st.name} @ ${width}px: no clip, roster viewport=${r.rosterViewport}px & scrolls, ${st.critical.join('+')} visible+unclipped${st.wrap ? ` (${r.rows} rows)` : ''}`);
      }
    }

    // Ownership SAFETY (codex r4-2): a FOREIGN com.google.Chrome.* dir appearing mid-run is NEVER deleted — only
    // dirs our process group holds open (lsof) are reaped, so a parallel session's / the owner's live profile is safe.
    {
      const foreign = path.join(os.tmpdir(), `com.google.Chrome.FOREIGN-${process.pid}-${Date.now()}`);
      fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'marker'), 'not-ours');
      const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', 'about:blank'], { detached: true, stdio: 'ignore' });
      try {
        let owned = [];
        for (let i = 0; i < 20 && owned.length === 0; i++) { await new Promise((r) => setTimeout(r, 250)); owned = ownedChromeDirs(child.pid); }
        assert.ok(owned.length >= 1, 'lsof proves our Chrome owns ≥1 profile dir (ownership check is live, not vacuous)');
        assert.ok(!owned.includes(foreign), 'the planted FOREIGN profile dir is NOT in our lsof-owned set');
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
        for (const d of owned) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }   // reap only OUR own
        assert.ok(fs.existsSync(foreign), 'a planted foreign com.google.Chrome.* dir SURVIVES our cleanup (never deleted by snapshot-diff)');
        ok(`ownership safety: foreign profile dir survives; reaped only our own (${owned.length} dir(s))`);
      } finally {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
        fs.rmSync(foreign, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\ndispatch-cashbar-layout: OK (${n} checks)`);
})().catch((e) => { console.error('\n✗ FAIL:', e && (e.stack || e.message)); process.exit(1); });
