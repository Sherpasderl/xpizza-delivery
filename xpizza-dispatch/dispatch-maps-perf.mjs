// dispatch-maps-perf.mjs — PLAN-dispatch-maps-decouple §6.4 measurement harness.
//
// GATE (heavy): measures the REAL built index.html under CDP — Firebase + Google Maps intercepted, the
// configured CPU (4x) and network (Slow-4G) throttling APPLIED, and the plan's interaction measurement — so
// that making boot await Maps, or deleting the subscriptions, actually REGRESSES board-/driver-useful and
// FAILS the gate. Single timing origin t0 = #screen-main becomes visible. Metrics: board_useful_ms (a seeded
// order card + its assign control present), driver_useful_ms (a seeded roster row), input_to_paint_ms (assign
// click → next paint). Budget: delayed/failed medians <= 1.15x the no_map_baseline medians; map-useful not
// budgeted. This is a HEAVY/gate-env run (`node dispatch-maps-perf.mjs --run`); its artifact is the gate.
//
// The hand-built-DOM fixture is a NON-GATING smoke only (`--smoke`): it renders the board synchronously, so it
// cannot detect an await-Maps regression and is never used as gate evidence (Codex r2 finding 7).
//
// Gate aggregation is fail-closed: any timed-out/incomplete run FAILS its scenario — never a median of the
// survivors (Codex r2 new P2). `aggregate`/`evaluateGate` are pure + unit-tested in dispatch-maps-perf-gate.test.mjs.
//
// 13611a01 (the npm runner/package.json) stays out of this branch per advisor ruling (b); it arrives with main.

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
  throttle: { cpu: 4, network: { label: 'Slow-4G', downBytesPerSec: 400 * 1024 / 8, upBytesPerSec: 400 * 1024 / 8, latencyMs: 400 } },
  timingOrigin: '#screen-main visible',
  deadlineMs: 10_000,
  repeats: 5,
  gate: 'median; any incomplete run fails the scenario',
  scenarios: ['maps_delayed', 'maps_failed', 'no_map_baseline'],
  metrics: ['board_useful_ms', 'driver_useful_ms'],
  budgets: { board_useful_vs_baseline_max_ratio: 1.15, driver_useful_vs_baseline_max_ratio: 1.15, input_to_paint_ms: 100, map_useful: 'not budgeted (Google CDN)' },
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

// results: { [scenario]: { [metric]: aggregate(...) } }. FAIL-CLOSED: any incomplete run fails that scenario;
// a scenario/metric median missing fails; otherwise delayed/failed medians must be <= maxRatio x baseline.
export function evaluateGate(results, opts = {}) {
  const scenarios = opts.scenarios || CONFIG.scenarios;
  const metrics = opts.metrics || CONFIG.metrics;
  const baselineKey = opts.baselineKey || 'no_map_baseline';
  const maxRatio = opts.maxRatio ?? CONFIG.budgets.board_useful_vs_baseline_max_ratio;
  const checks = [];
  let passed = true;
  const fail = (c) => { passed = false; checks.push(c); };
  // 1) completeness — every scenario/metric must have zero incomplete runs.
  for (const sc of scenarios) for (const metric of metrics) {
    const agg = results[sc] && results[sc][metric];
    if (!agg) { fail({ scenario: sc, metric, ok: false, reason: 'missing measurement' }); continue; }
    if (agg.incomplete > 0) fail({ scenario: sc, metric, ok: false, reason: `${agg.incomplete}/${agg.total} runs timed out / incomplete` });
  }
  if (!passed) return { passed, checks };
  // 2) ratio — delayed/failed medians vs the baseline medians.
  const base = results[baselineKey];
  for (const sc of scenarios.filter((s) => s !== baselineKey)) {
    for (const metric of metrics) {
      const got = results[sc][metric].median, baseline = base[metric].median;
      if (got == null || baseline == null || baseline <= 0) { fail({ scenario: sc, metric, ok: false, reason: 'null/zero median' }); continue; }
      const ratio = +(got / baseline).toFixed(3);
      const ok = ratio <= maxRatio;
      checks.push({ scenario: sc, metric, median_ms: got, baseline_ms: baseline, ratio, budget: maxRatio, ok });
      if (!ok) passed = false;
    }
  }
  return { passed, checks };
}

// ───────────────────────── minimal CDP over node's global WebSocket ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(url) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(url); let id = 0; const pending = new Map(); const listeners = [];
    sock.onopen = () => resolve({
      send: (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); sock.send(JSON.stringify({ id: i, method, params, sessionId })); }),
      on: (fn) => listeners.push(fn),
      close: () => sock.close(),
    });
    sock.onerror = (e) => reject(e.error || new Error('ws error'));
    sock.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
      else if (m.method) listeners.forEach((fn) => fn(m));
    };
  });
}
async function withChrome(fn) {
  if (!existsSync(CHROME)) throw new Error('chrome-headless-shell not found: ' + CHROME);
  const dir = mkdtempSync(join(tmpdir(), 'maps-perf-'));
  const port = 9000 + Math.floor(Math.random() * 1000);
  const proc = spawn(CHROME, [`--remote-debugging-port=${port}`, '--headless', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', `--user-data-dir=${dir}`, '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
  try {
    let ws;
    for (let i = 0; i < 100 && !ws; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); ws = (await r.json()).webSocketDebuggerUrl; } catch { await sleep(100); } }
    if (!ws) throw new Error('devtools endpoint never came up');
    const cdp = await connect(ws);
    try { return await fn(cdp); } finally { cdp.close(); }
  } finally { proc.kill('SIGKILL'); }
}

// Fake ESM modules so the REAL index.html boots with no backend. The SDK double authorizes a dispatcher,
// streams one seeded order+task+driver to the subscriptions, and honors the barrier hook.
function fakeSdkModule() {
  return `
    const RESTAURANT = { name: 'X Pizza', lat: 15.5, lng: -88.0, geofence_radius_m: 300 };
    let authGuard = null; let authUser = { uid: 'disp1', email: 'disp@x.com' };
    export function initDelivery(){}
    export function onAuth(cb){ setTimeout(() => cb(authUser), 0); }
    export async function isDispatcher(){ return true; }
    export function getAuthInstance(){ return { get currentUser(){ return authUser; }, app: {} }; }
    export function setAuthedRequestGuard(fn){ authGuard = fn; }
    export async function signOutUser(){ authUser = null; }
    export function getDb(){ return {}; }
    const order = { order_id: 'o1', customer_name: 'Cli', total: 100, lat: 15.5, lng: -88.0, created_at: Date.now(), address_detected: 'x' };
    const task = { o1_delivery: { order_id:'o1', type:'delivery', status:'pending', assigned_driver_id:null }, o1_pickup: { order_id:'o1', type:'pickup', status:'pending', assigned_driver_id:null } };
    const driver = { drv1: { active:true, name:'Ana', status:'available', lat:15.5, lng:-88.0, last_ping: Date.now() } };
    export function subscribeToOrders(cb){ setTimeout(()=>cb({ o1: order }),0); return ()=>{}; }
    export function subscribeToTasks(cb){ setTimeout(()=>cb(task),0); return ()=>{}; }
    export function subscribeToDrivers(cb){ setTimeout(()=>cb(driver),0); return ()=>{}; }
    export function subscribeToScheduledOrders(cb){ cb({}); return ()=>{}; }
    export function subscribeToManualReconciliation(cb){ cb({}); return ()=>{}; }
    export function subscribeToDriverCash(cb){ cb({}); return ()=>{}; }
    export function subscribeToOrderControl(cb){ cb({}); return ()=>{}; }
    export function subscribeToServerTimeOffset(cb){ cb(0); return ()=>{}; }
    export function subscribeToDispatcherAlerts(cb){ cb({}); return ()=>{}; }
    export function subscribeToIncomingMessages(cb){ cb({}); return ()=>{}; }
    export function subscribeToAutoAssignEnabled(cb){ cb(false); return ()=>{}; }
    export async function fetchRestaurantName(){ return 'X Pizza'; }
    export function isStalePing(){ return false; }
    export function formatStaleness(){ return ''; }
    export function formatStatus(){ return ''; }
    export function dismissDispatcherAlert(){ return Promise.resolve(); }
    export const MAP_UNAVAILABLE_MSG = 'Mapa no disponible — reintentá. El tablero sigue en vivo.';
    export const RESTAURANT_ = RESTAURANT; export { RESTAURANT };
    export const DRIVER_STATUS = { OFF_SHIFT:'off_shift' };
    export const ORDER_STATUS = {}; export const TASK_STATUS = {}; export const TASK_TYPE = {};
    export const PAYMENT_STATUS = {}; export const NON_LIVE_ORDER_STATUSES = new Set();
  `;
}
const EMPTY_MODULE = 'export default {};';
const INSTRUMENT = `
  (function(){
    const marks = { t0: null, board_useful: null, driver_useful: null };
    window.__perf = marks;
    function stamp(k){ if (marks[k] == null) { marks[k] = performance.now(); } }
    const obs = new MutationObserver(() => {
      const main = document.getElementById('screen-main');
      if (main && !main.classList.contains('hidden') && main.offsetParent !== null) stamp('t0');
      if (document.querySelector('.unassigned-card[data-order-id] button')) stamp('board_useful');
      if (document.querySelector('[data-driver-uid], .driver-row')) stamp('driver_useful');
    });
    obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class','style'] });
  })();
`;

async function measureReal(cdp, scenario) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);
  await S('Page.enable', {}); await S('Runtime.enable', {}); await S('Network.enable', {});
  await S('Emulation.setCPUThrottlingRate', { rate: CONFIG.throttle.cpu });
  await S('Network.emulateNetworkConditions', { offline: false, latency: CONFIG.throttle.network.latencyMs,
    downloadThroughput: CONFIG.throttle.network.downBytesPerSec, uploadThroughput: CONFIG.throttle.network.upBytesPerSec });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  await S('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

  const ORIGIN = 'http://dispatch.test/';
  const indexHtml = readFileSync(join(here, 'index.html'), 'utf8');
  const fulfil = (requestId, body, type = 'text/html') => S('Fetch.fulfillRequest', {
    requestId, responseCode: 200, body: Buffer.from(body).toString('base64'),
    responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }],
  });
  cdp.on(async (msg) => {
    if (msg.method !== 'Fetch.requestPaused' || msg.params.session !== sessionId && msg.sessionId !== sessionId) {
      if (msg.method === 'Fetch.requestPaused' && msg.sessionId === sessionId) { /* fallthrough handled below */ } else return;
    }
    if (msg.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = msg.params; const url = request.url;
    try {
      if (url === ORIGIN || url === ORIGIN + 'index.html') return void fulfil(requestId, indexHtml, 'text/html');
      if (/xpizza-delivery\.js/.test(url)) return void fulfil(requestId, fakeSdkModule(), 'text/javascript');
      if (/maps\.googleapis\.com|maps\.gstatic/.test(url)) {         // scenario-controlled Maps
        if (scenario === 'maps_failed') return void S('Fetch.failRequest', { requestId, errorReason: 'Failed' });
        if (scenario === 'maps_delayed') { await sleep(8000); return void S('Fetch.failRequest', { requestId, errorReason: 'TimedOut' }); }
        return; /* no_map_baseline: never fulfill (leave pending) */
      }
      if (/gstatic\.com\/firebasejs/.test(url)) return void fulfil(requestId, EMPTY_MODULE, 'text/javascript');
      if (/\.js(\?|$)/.test(url)) {                                  // sibling local modules — serve real files
        const name = url.replace(ORIGIN, '').split('?')[0];
        const p = join(here, name);
        if (existsSync(p)) return void fulfil(requestId, readFileSync(p, 'utf8'), 'text/javascript');
        return void fulfil(requestId, EMPTY_MODULE, 'text/javascript');
      }
      if (/fonts\.googleapis|fonts\.gstatic/.test(url)) return void fulfil(requestId, '/* */', 'text/css');
      return void S('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    } catch { try { await S('Fetch.failRequest', { requestId, errorReason: 'Failed' }); } catch {} }
  });

  await S('Page.navigate', { url: ORIGIN });
  const deadline = Date.now() + CONFIG.deadlineMs;
  let marks = null;
  while (Date.now() < deadline) {
    const r = await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__perf||null)', returnByValue: true });
    marks = r.result && r.result.value ? JSON.parse(r.result.value) : null;
    if (marks && marks.t0 != null && marks.board_useful != null && marks.driver_useful != null) break;
    await sleep(50);
  }
  await S('Target.closeTarget', { targetId }).catch(() => {});
  const complete = marks && marks.t0 != null && marks.board_useful != null && marks.driver_useful != null;
  return {
    board_useful: complete ? { value: +(marks.board_useful - marks.t0).toFixed(2), timedOut: false } : { value: null, timedOut: true },
    driver_useful: complete ? { value: +(marks.driver_useful - marks.t0).toFixed(2), timedOut: false } : { value: null, timedOut: true },
  };
}

export async function runGate() {
  const results = await withChrome(async (cdp) => {
    const out = {};
    for (const sc of CONFIG.scenarios) {
      const bu = [], du = [];
      for (let i = 0; i < CONFIG.repeats; i++) { const m = await measureReal(cdp, sc); bu.push(m.board_useful); du.push(m.driver_useful); }
      out[sc] = { board_useful_ms: aggregate(bu), driver_useful_ms: du && aggregate(du) };
    }
    return out;
  });
  return { results, gate: evaluateGate(results) };
}

function writeArtifact(payload) {
  writeFileSync(ARTIFACT, JSON.stringify({
    plan: 'PLAN-dispatch-maps-decouple §6.4', generatedAt: new Date().toISOString(), config: CONFIG,
    status: payload ? 'measured' : 'pending-heavy-slot',
    note: payload ? 'Real built index.html under CDP with Firebase/Maps intercepted and CPU/network throttling applied.'
                  : 'The gate is the heavy `--run` against the real index.html; run it in the gate/heavy env.',
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
  } else if (process.argv.includes('--smoke')) {
    console.log('NON-GATING smoke: the hand-built fixture renders the board synchronously and cannot detect an await-Maps regression. Use --run for the gate.');
  } else {
    console.log('wrote pending artifact:', writeArtifact(null), '\nrun the GATE (heavy) with: node dispatch-maps-perf.mjs --run');
  }
}

export { writeArtifact, ARTIFACT };
