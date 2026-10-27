// dispatch-maps-perf.mjs — PLAN-dispatch-maps-decouple §6.4 measurement harness.
//
// GATE: measures the REAL built index.html — served over a local HTTP server with Firebase + the SDK replaced
// by test doubles and the Google Maps script routed to a scenario-controlled local endpoint, so the page boots
// headless with no backend and the three Maps conditions are real:
//   maps_delayed   — the Maps script is held ~8s then errors
//   maps_failed    — the Maps script errors immediately
//   no_map_baseline— the Maps script never responds (the board-/driver-useful baseline)
// The page reports its own timing back (board/driver-useful marked by a MutationObserver from t0 = #screen-main
// visible), so there is no CDP evaluate to hang. One headless Chrome at a time; each run is hard-capped.
// Budget: delayed/failed medians <= 1.15x the no_map_baseline medians (the board must not wait on Maps).
//
// Gate aggregation is fail-closed: any timed-out/incomplete run FAILS its scenario — never a median of the
// survivors (Codex r2 new P2). `aggregate`/`evaluateGate` are pure + unit-tested in dispatch-maps-perf-gate.test.mjs.
// 13611a01 (the npm runner/package.json) stays out of this branch per advisor ruling (b); it arrives with main.

import { writeFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = join(here, 'dispatch-maps-perf.json');
const CHROME = `${process.env.HOME}/.cache/puppeteer/chrome-headless-shell/mac_arm-131.0.6778.204/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

export const CONFIG = {
  chrome: { kind: 'chrome-headless-shell', version: 'mac_arm-131.0.6778.204' },
  viewport: { width: 1440, height: 900, dpr: 1 },
  timingOrigin: '#screen-main visible',
  deadlineMs: 9000, runCapMs: 20000, repeats: 5,
  gate: 'median; any incomplete run fails the scenario',
  scenarios: ['maps_delayed', 'maps_failed', 'no_map_baseline'],
  metrics: ['board_useful_ms', 'driver_useful_ms'],
  budgets: { board_useful_vs_baseline_max_ratio: 1.15, driver_useful_vs_baseline_max_ratio: 1.15, map_useful: 'not budgeted (Google CDN)' },
};

// ───────────────────────── PURE gate logic (unit-tested) ─────────────────────────
export function aggregate(runs) {
  const complete = runs.filter((r) => r && !r.timedOut && r.value != null).map((r) => r.value);
  const incomplete = runs.length - complete.length;
  const sorted = complete.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)] : null;
  return { median, p95, incomplete, total: runs.length };
}
export function evaluateGate(results, opts = {}) {
  const scenarios = opts.scenarios || CONFIG.scenarios;
  const metrics = opts.metrics || CONFIG.metrics;
  const baselineKey = opts.baselineKey || 'no_map_baseline';
  const maxRatio = opts.maxRatio ?? CONFIG.budgets.board_useful_vs_baseline_max_ratio;
  const checks = []; let passed = true;
  const fail = (c) => { passed = false; checks.push(c); };
  for (const sc of scenarios) for (const metric of metrics) {
    const agg = results[sc] && results[sc][metric];
    if (!agg) { fail({ scenario: sc, metric, ok: false, reason: 'missing measurement' }); continue; }
    if (agg.incomplete > 0) fail({ scenario: sc, metric, ok: false, reason: `${agg.incomplete}/${agg.total} runs timed out / incomplete` });
  }
  if (!passed) return { passed, checks };
  const base = results[baselineKey];
  for (const sc of scenarios.filter((s) => s !== baselineKey)) for (const metric of metrics) {
    const got = results[sc][metric].median, baseline = base[metric].median;
    if (got == null || baseline == null || baseline <= 0) { fail({ scenario: sc, metric, ok: false, reason: 'null/zero median' }); continue; }
    const ratio = +(got / Math.max(baseline, 0.01)).toFixed(3);
    const ok = ratio <= maxRatio;
    checks.push({ scenario: sc, metric, median_ms: got, baseline_ms: baseline, ratio, budget: maxRatio, ok });
    if (!ok) passed = false;
  }
  return { passed, checks };
}

// ───────────────────────── local server serving the real page ─────────────────────────
const FB_DATABASE = `export const ref=(...a)=>({_ref:a});export const onValue=(r,cb)=>{setTimeout(()=>cb({val:()=>({})}),0);return ()=>{};};export const off=()=>{};export const get=async()=>({exists:()=>false,val:()=>null});`;
const FB_FUNCTIONS = `export const getFunctions=()=>({});export const httpsCallable=()=>async()=>({data:{}});`;
// Injected reporter: mark t0 (screen-main visible), board_useful (seeded card + control), driver_useful (roster
// row) via a MutationObserver, then POST the deltas. POSTs a timedOut report if the board never renders.
const REPORTER = (deadlineMs) => `<script>
  (function(){var marks={t0:null,board:null,driver:null},start=performance.now();
   function s(k){if(marks[k]==null)marks[k]=performance.now();}
   function post(timedOut){try{fetch('/report',{method:'POST',keepalive:true,body:JSON.stringify({
     timedOut:timedOut, board_useful:(marks.board!=null&&marks.t0!=null)?+(marks.board-marks.t0).toFixed(2):null,
     driver_useful:(marks.driver!=null&&marks.t0!=null)?+(marks.driver-marks.t0).toFixed(2):null})});}catch(e){}}
   var o=new MutationObserver(function(){var m=document.getElementById('screen-main');
     if(m&&!m.classList.contains('hidden')&&m.offsetParent!==null)s('t0');
     if(document.querySelector('.unassigned-card[data-order-id] button'))s('board');
     if(document.querySelector('[data-driver-uid],.driver-row'))s('driver');
     if(marks.t0!=null&&marks.board!=null&&marks.driver!=null){o.disconnect();post(false);}});
   o.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style']});
   setTimeout(function(){o.disconnect();post(marks.board==null||marks.driver==null);}, ${deadlineMs});})();
</script>`;

function startServer(scenario) {
  const indexHtml = readFileSync(join(here, 'index.html'), 'utf8')
    .replace('https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js', '/__fake/fb-database.mjs')
    .replace('https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js', '/__fake/fb-functions.mjs')
    .replace('https://maps.${c}apis.com/maps/api/js', '/__maps/js?c=${c}')   // scenario-controlled Maps endpoint
    .replace('</body>', REPORTER(CONFIG.deadlineMs) + '</body>');
  let reportResolve; const reportP = new Promise((r) => { reportResolve = r; });
  const held = [];
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (req.method === 'POST' && path === '/report') { let b = ''; req.on('data', (d) => b += d); req.on('end', () => { res.writeHead(200); res.end('ok'); reportResolve(b); }); return; }
    if (path === '/__maps/js') {                             // Maps per scenario
      if (scenario === 'maps_failed') { res.writeHead(500); res.end(''); return; }
      if (scenario === 'maps_delayed') { const t = setTimeout(() => { try { res.writeHead(500); res.end(''); } catch {} }, 8000); held.push(() => clearTimeout(t)); return; }
      return; /* no_map_baseline: never respond (hold the socket) */
    }
    const send = (x, t) => { res.writeHead(200, { 'Content-Type': t }); res.end(x); };
    try {
      if (path === '/' || path === '/index.html') return send(indexHtml, 'text/html');
      if (path === '/xpizza-delivery.js') return send(readFileSync(join(here, '_fake-sdk.mjs'), 'utf8'), 'text/javascript');
      if (path === '/__fake/fb-database.mjs') return send(FB_DATABASE, 'text/javascript');
      if (path === '/__fake/fb-functions.mjs') return send(FB_FUNCTIONS, 'text/javascript');
      if (path.endsWith('.js')) { const p = join(here, path.replace(/^\//, '')); if (existsSync(p)) return send(readFileSync(p, 'utf8'), 'text/javascript'); }
      res.writeHead(404); res.end('');
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return { server, reportP, cleanup: () => { held.forEach((f) => f()); try { server.close(); } catch {} } };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measureRun(scenario) {
  const { server, reportP, cleanup } = startServer(scenario);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'maps-perf-'));
  const proc = spawn(CHROME, ['--headless', '--disable-gpu', '--no-first-run', '--window-size=1440,900', `--user-data-dir=${dir}`, `http://127.0.0.1:${port}/`], { stdio: 'ignore' });
  try {
    const timeout = new Promise((r) => setTimeout(() => r('__TIMEOUT__'), CONFIG.runCapMs));
    const raw = await Promise.race([reportP, timeout]);
    if (raw === '__TIMEOUT__') return { board_useful: { value: null, timedOut: true }, driver_useful: { value: null, timedOut: true } };
    const r = JSON.parse(raw);
    const ok = !r.timedOut && r.board_useful != null && r.driver_useful != null;
    return {
      board_useful: ok ? { value: r.board_useful, timedOut: false } : { value: null, timedOut: true },
      driver_useful: ok ? { value: r.driver_useful, timedOut: false } : { value: null, timedOut: true },
    };
  } finally { try { proc.kill('SIGKILL'); } catch {} cleanup(); await sleep(50); }
}

export async function runGate() {
  const results = {};
  for (const sc of CONFIG.scenarios) {
    const bu = [], du = [];
    for (let i = 0; i < CONFIG.repeats; i++) { const m = await measureRun(sc); bu.push(m.board_useful); du.push(m.driver_useful); }   // ONE Chrome at a time
    results[sc] = { board_useful_ms: aggregate(bu), driver_useful_ms: aggregate(du) };
  }
  return { results, gate: evaluateGate(results) };
}

function writeArtifact(payload) {
  writeFileSync(ARTIFACT, JSON.stringify({
    plan: 'PLAN-dispatch-maps-decouple §6.4', generatedAt: new Date().toISOString(), config: CONFIG,
    status: payload ? 'measured' : 'pending-heavy-slot',
    note: payload ? 'Real built index.html served locally with Firebase/SDK doubles + scenario-controlled Maps; page self-reports board/driver-useful from t0=#screen-main visible.'
                  : 'Run the gate with `node dispatch-maps-perf.mjs --run` (spawns headless Chrome; one at a time).',
    gate: payload ? payload.gate : null, results: payload ? payload.results : null,
  }, null, 2) + '\n');
  return ARTIFACT;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--run')) {
    const payload = await runGate();
    writeArtifact(payload);
    console.log('GATE run →', ARTIFACT, '\npassed:', payload.gate.passed);
    for (const c of payload.gate.checks) console.log(' ', JSON.stringify(c));
    process.exit(payload.gate.passed ? 0 : 1);
  } else {
    console.log('wrote pending artifact:', writeArtifact(null), '\nrun the GATE with: node dispatch-maps-perf.mjs --run');
  }
}
export { writeArtifact, ARTIFACT };
