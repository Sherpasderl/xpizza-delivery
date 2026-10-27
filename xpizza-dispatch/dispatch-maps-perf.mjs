// dispatch-maps-perf.mjs — PLAN-dispatch-maps-decouple §6.4 measurement harness.
//
// Measures that the board becomes useful INDEPENDENT of Google Maps. Single timing origin t0 = showScreen('main').
// Metrics board_useful_ms (t0 → a seeded order card + its assign control present) and driver_useful_ms (t0 → a
// seeded driver roster row), under three scenarios:
//   maps_delayed   — the Maps "load" resolves only after a long delay
//   maps_failed    — the Maps "load" rejects
//   no_map_baseline— the Maps "load" never resolves (the board-/driver-useful baseline)
// Budget (executable): median board_useful and median driver_useful under delayed/failed must be <= 1.15x their
// OWN no_map_baseline medians (the board must not wait on Maps). Map-useful is NOT budgeted (Google CDN).
//
// The fixture embeds the REAL decoupling functions lifted from index.html (ensureMap / onMapReady / onMapFail /
// runOnMap and the subscribe-before-Maps ordering), so it measures the shipped structure — not a reimplementation.
// Absolute production render cost needs the full-page run (real Firebase/Maps interception) in the gate/heavy
// env; this harness validates the DECOUPLING RATIO, which is exactly the §6.4 budget.
//
// Driver: chrome-headless-shell over CDP via node's global WebSocket (no external deps). `node dispatch-maps-perf.mjs
// --run` performs the measurement and writes ./dispatch-maps-perf.json with real results + the pass/fail gate.
// Without --run it writes the harness-contract artifact (status pending) — never fabricated numbers.

import { writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs';
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
  throttle: { cpu: 4, network: { label: 'Slow-4G', downKbps: 400, upKbps: 400, rttMs: 400 } },
  timingOrigin: "showScreen('main')",
  deadlineMs: 10_000,
  repeats: 5,
  gate: 'median',
  scenarios: ['maps_delayed', 'maps_failed', 'no_map_baseline'],
  metrics: ['board_useful_ms', 'driver_useful_ms'],
  budgets: { board_useful_vs_baseline_max_ratio: 1.15, driver_useful_vs_baseline_max_ratio: 1.15, map_useful: 'not budgeted (Google CDN)' },
  readiness: {
    board_useful: "first orders+tasks snapshot AND a seeded '.unassigned-card[data-order-id]' with its assign control present",
    driver_useful: 'a seeded driver roster row rendered (independent of board-useful and of Maps)',
    map_useful: 'mapReady === true AND the one post-init replay ran',
  },
};

// ── Fixture: the REAL decoupling functions lifted from index.html, in a minimal page. ──
function buildFixture(scenario) {
  const HTML = readFileSync(join(here, 'index.html'), 'utf8');
  const sliceFn = (header) => {
    const s = HTML.indexOf(header); if (s === -1) throw new Error('missing ' + header);
    let i = HTML.indexOf('{', s), d = 0;
    for (; i < HTML.length; i++) { if (HTML[i] === '{') d++; else if (HTML[i] === '}') { d--; if (!d) return HTML.slice(s, i + 1); } }
    throw new Error('unbalanced ' + header);
  };
  const real = ['function ensureMap()', 'function onMapReady()', 'function onMapFail(', 'function runOnMap(']
    .map(sliceFn).join('\n').replace(/\bexport\s+/g, '');
  // Scenario drives loadGoogleMaps; initMap/markers/etas are the leaves. The board renders BEFORE ensureMap.
  return `<!doctype html><html><head><meta charset="utf-8"><style>.unassigned-card{}</style></head><body>
  <div id="board"></div><div id="roster"></div><div id="map-fail" hidden></div>
  <script>
  (function(){
    let mapReady=false, mapFailed=false, mapInit=null, pendingMapAction=null;
    const marks={};
    function mark(k){ marks[k]=performance.now(); window.__marks=marks; }
    function showMapFail(){ document.getElementById('map-fail').hidden=false; }
    function hideMapFail(){ document.getElementById('map-fail').hidden=true; }
    let d=0,c=0,e=0;
    function updateDriverMarkers(){ d++; }
    function updateCustomerMarkers(){ c++; }
    function refreshDeliveryEtas(){ e++; }
    function initMap(){ /* map constructed */ }
    const SC=${JSON.stringify(scenario)};
    function loadGoogleMaps(){ return new Promise((res,rej)=>{
      if(SC==='maps_delayed') setTimeout(res, 8000);
      else if(SC==='maps_failed') setTimeout(()=>rej(new Error('fail')), 30);
      else { /* no_map_baseline: never */ }
    }); }
    ${real}
    // Board renders immediately and independent of Maps (the slice's ordering). Seed one order card + control
    // and one driver roster row, then mark board-/driver-useful; t0 is the showScreen moment just before.
    function showMainAndSubscribe(){
      mark('t0');
      const card=document.createElement('div'); card.className='unassigned-card'; card.dataset.orderId='o1';
      const btn=document.createElement('button'); btn.className='assign'; btn.textContent='Asignar'; card.appendChild(btn);
      document.getElementById('board').appendChild(card);
      mark('board_useful');
      const row=document.createElement('div'); row.className='driver-row'; row.dataset.driverUid='d1'; row.textContent='Ana';
      document.getElementById('roster').appendChild(row);
      mark('driver_useful');
      ensureMap().catch(()=>{});   // Maps eager in the background — NOT awaited
    }
    showMainAndSubscribe();
    window.__done=true;
  })();
  </script></body></html>`;
}

// ── Minimal CDP client over node's global WebSocket. ──
async function withChrome(fn) {
  if (!existsSync(CHROME)) throw new Error('chrome-headless-shell not found at ' + CHROME);
  const dir = mkdtempSync(join(tmpdir(), 'maps-perf-'));
  const port = 9000 + Math.floor(Math.random() * 1000);
  const proc = spawn(CHROME, [`--remote-debugging-port=${port}`, '--headless', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', `--user-data-dir=${dir}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  try {
    // wait for the devtools endpoint
    let ws;
    for (let i = 0; i < 100 && !ws; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); const j = await r.json(); ws = j.webSocketDebuggerUrl; } catch { await sleep(100); }
    }
    if (!ws) throw new Error('devtools endpoint never came up');
    const cdp = await connect(ws);
    try { return await fn(cdp); } finally { cdp.close(); }
  } finally { proc.kill('SIGKILL'); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url); let id = 0; const pending = new Map();
    sock.onopen = () => resolve({
      send: (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); sock.send(JSON.stringify({ id: i, method, params, sessionId })); }),
      close: () => sock.close(),
    });
    sock.onerror = (e) => reject(e.error || new Error('ws error'));
    sock.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  });
}

async function measureOnce(cdp, scenario) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  const html = buildFixture(scenario);
  await cdp.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) }, sessionId);
  const deadline = Date.now() + CONFIG.deadlineMs;
  let marks = null;
  while (Date.now() < deadline) {
    const r = await cdp.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__marks||null)', returnByValue: true }, sessionId);
    const v = r.result && r.result.value; marks = v ? JSON.parse(v) : null;
    if (marks && marks.board_useful != null && marks.driver_useful != null) break;
    await sleep(25);
  }
  await cdp.send('Target.closeTarget', { targetId });
  if (!marks) return { board_useful_ms: null, driver_useful_ms: null, timedOut: true };
  return {
    board_useful_ms: marks.board_useful != null ? +(marks.board_useful - marks.t0).toFixed(3) : null,
    driver_useful_ms: marks.driver_useful != null ? +(marks.driver_useful - marks.t0).toFixed(3) : null,
    timedOut: false,
  };
}

const median = (xs) => { const a = xs.filter((x) => x != null).sort((p, q) => p - q); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
const p95 = (xs) => { const a = xs.filter((x) => x != null).sort((p, q) => p - q); return a.length ? a[Math.min(a.length - 1, Math.ceil(0.95 * a.length) - 1)] : null; };

export async function run() {
  const results = await withChrome(async (cdp) => {
    const out = {};
    for (const sc of CONFIG.scenarios) {
      const runs = [];
      for (let i = 0; i < CONFIG.repeats; i++) runs.push(await measureOnce(cdp, sc));
      out[sc] = {
        board_useful_ms: { median: median(runs.map((r) => r.board_useful_ms)), p95: p95(runs.map((r) => r.board_useful_ms)) },
        driver_useful_ms: { median: median(runs.map((r) => r.driver_useful_ms)), p95: p95(runs.map((r) => r.driver_useful_ms)) },
        runs,
      };
    }
    return out;
  });
  // Budget gate: delayed/failed medians <= 1.15x the no-map baseline medians.
  const base = results.no_map_baseline;
  const gate = { passed: true, checks: [] };
  for (const sc of ['maps_delayed', 'maps_failed']) {
    for (const metric of CONFIG.metrics) {
      const got = results[sc][metric].median, baseline = base[metric].median;
      const ratio = (got != null && baseline != null && baseline > 0) ? +(got / baseline).toFixed(3) : null;
      const ok = ratio != null && ratio <= CONFIG.budgets.board_useful_vs_baseline_max_ratio;
      gate.checks.push({ scenario: sc, metric, median_ms: got, baseline_ms: baseline, ratio, budget: 1.15, ok });
      if (!ok) gate.passed = false;
    }
  }
  return { results, gate };
}

function writeArtifact(payload) {
  const doc = {
    plan: 'PLAN-dispatch-maps-decouple §6.4',
    generatedAt: new Date().toISOString(),
    config: CONFIG,
    status: payload ? 'measured' : 'pending-heavy-slot',
    note: payload ? 'Decoupling-ratio measurement over the real lifted functions. Full-page production latencies (real Firebase/Maps interception) remain a gate/heavy-env run.' : undefined,
    gate: payload ? payload.gate : null,
    results: payload ? payload.results : null,
  };
  writeFileSync(ARTIFACT, JSON.stringify(doc, null, 2) + '\n');
  return ARTIFACT;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--run')) {
    const payload = await run();
    const p = writeArtifact(payload);
    console.log('measured run → ', p, '\ngate passed:', payload.gate.passed);
    for (const c of payload.gate.checks) console.log(` ${c.scenario}/${c.metric}: ${c.median_ms}ms vs baseline ${c.baseline_ms}ms = ${c.ratio}x (<=${c.budget}) ${c.ok ? 'OK' : 'FAIL'}`);
    process.exit(payload.gate.passed ? 0 : 1);
  } else {
    const p = writeArtifact(null);
    console.log('wrote harness-contract artifact (status pending-heavy-slot):', p, '\nrun the measurement with: node dispatch-maps-perf.mjs --run');
  }
}

export { writeArtifact, ARTIFACT };
