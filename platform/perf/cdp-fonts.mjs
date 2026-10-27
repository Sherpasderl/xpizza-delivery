// ── PLAN-forms-fonts-preconnect r6.1 §2.1 — the SHARED CDP font-proof primitives (extracted from capp F4's capp-perf.cdp.mjs) ──
// One harness core for every webfont surface; each surface keeps its own fixtures, states and assertions. Nothing here talks to
// the network: pages are served from a loopback static server, and EVERY other request is routed through CDP Fetch interception
// (fulfilled from a fixture, failed, or HELD and released by the caller) — a held font is a request the harness completes on demand.
//   • launch()          headless Chrome (CHROME_BIN overrides) + one flat CDP session: s(method, params), on(event, fn), ev(expr)
//   • serveDir()        loopback static server over a root, with per-path rewrites (old-policy control, the ensureFirebase seam…)
//   • router()          Fetch-domain routing: route(predicate → 'continue' | 'fail' | 'hold' | {status, headers, body}); holds can be
//                       released (continue) or failed later, and their completion is observed (Network.loadingFinished / loadingFailed)
//   • GEO / OBSERVER    every element's box to 0.01 px; the page's own layout-shift total (recorded; never the proof on its own)
//   • census()          CSS.getPlatformFontsForNode over every rendered text-bearing node (DOM text, input values/placeholders via
//                       the UA shadow tree, ::before/::after), with the node's computed font and its painted codepoints
//   • attribute()       the per-codepoint PROBE: each distinct (family stack, weight, style, codepoint) is rendered alone off-screen and
//                       read back with getPlatformFontsForNode ⇒ the one platform font that draws it; then a per-node fidelity check
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function chromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of (fs.existsSync(cache) ? fs.readdirSync(cache) : []).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse())
    for (const sub of fs.readdirSync(path.join(cache, d))) { const p = path.join(cache, d, sub, 'chrome-headless-shell'); if (fs.existsSync(p)) return p; }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain' };

// rewrite(rel, buf) → buf | undefined (unchanged). gate(rel) → 'hold' | 'fail' | undefined: a HELD response waits for release(),
// a FAILED one is destroyed mid-response (the browser sees a network error). Loopback assets (the self-hosted fonts) are gated HERE,
// never through Fetch interception: pausing every request delays the preloaded font past font-display:optional's window (calibrated).
export function serveDir(root, { rewrite = () => undefined, gate = () => undefined } = {}) {
  const held = [];
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const g = gate(rel);
    if (g === 'fail') { req.socket.destroy(); return; }
    if (g === 'hold') { held.push(() => send(rel, res)); return; }
    send(rel, res);
  });
  function send(rel, res) {
    const file = path.join(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    const r = rewrite(rel, body); if (r !== undefined) body = Buffer.isBuffer(r) ? r : Buffer.from(r);
    // PRODUCTION's cache headers (netlify.toml: /fonts/* immutable; Netlify's default elsewhere). no-store would defeat the preload: a
    // no-store response never enters the memory cache, so the face fetches the file a SECOND time and misses its window (calibrated).
    const cc = /(^|\/)fonts\//.test(rel) ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate';
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': cc, 'access-control-allow-origin': '*' });
    res.end(body);
  }
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close(),
    heldCount: () => held.length, release: () => { while (held.length) held.shift()(); } })));
}

// The shared-machine rule for light browser work: ONE Chrome at a time (callers run sequentially) and only while the 1-min load is
// under maxLoad; polls every 60 s, gives up loudly after maxWaitMs.
export async function waitForLoad({ maxLoad = 30, pollMs = 60000, maxWaitMs = 30 * 60000, log = console.log } = {}) {
  const t0 = Date.now();
  for (;;) {
    const l = os.loadavg()[0];
    if (l < maxLoad) return l;
    if (Date.now() - t0 > maxWaitMs) throw new Error(`load stayed ≥ ${maxLoad} for ${Math.round(maxWaitMs / 60000)} min (now ${l.toFixed(1)}) — not starting Chrome`);
    log(`  … waiting: 1-min load ${l.toFixed(1)} ≥ ${maxLoad}`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export async function launch({ width = 390, height = 844, dpr = 2, throttle = false, args = [] } = {}) {
  await waitForLoad();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-fonts-'));
  const chrome = spawn(chromeBin(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
    '--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars', ...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const rmProfile = () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} };
  process.once('exit', () => { try { chrome.kill('SIGTERM'); } catch (_) {} rmProfile(); });   // a thrown run never orphans OUR Chrome or its profile
  const close = () => { try { chrome.kill('SIGTERM'); } catch (_) {} setTimeout(rmProfile, 300); };   // OUR child, by handle — never a pattern kill
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let b = ''; const t = setTimeout(() => reject(new Error('Chrome did not start')), 20000);
      chrome.stderr.on('data', (d) => { b += d; const m = b.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
    });
    const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    let id = 0; const pend = new Map(); const handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result); return; }
      if (m.method) for (const fn of handlers.get(m.method) || []) { try { fn(m.params); } catch (err) { console.error(err); } }
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pend.set(i, { resolve, reject, method }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    const on = (method, fn) => { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(fn); };
    for (const d of ['Page', 'Runtime', 'DOM', 'CSS', 'Network']) await s(`${d}.enable`);
    // COLD cache = the fresh profile above (one per launch). NOT Network.setCacheDisabled: it also disables the preload's reuse.
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: true });
    if (throttle) {   // F4's Slow 4G + 4× CPU
      await s('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
      await s('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    const ev = async (expression) => {
      const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
      return r.result.value;
    };
    return { s, on, ev, close: () => { try { ws.close(); } catch (_) {} close(); } };
  } catch (e) { close(); throw e; }
}

// Fetch-domain routing. decide(url, request) → 'continue' | 'fail' | 'hold' | { status, headers?, body (string|Buffer) }.
// Returns { holds: Map(url → requestId), release(urlPredicate), failHeld(urlPredicate), finished: Map(url → 'ok'|'failed') }.
export async function router(cdp, decide) {
  const { s, on } = cdp;
  const holds = new Map(); const finished = new Map(); const byReq = new Map(); const seen = new Set();
  on('Network.requestWillBeSent', (p) => { byReq.set(p.requestId, p.request.url); seen.add(p.request.url); });
  on('Network.loadingFinished', (p) => { const u = byReq.get(p.requestId); if (u) finished.set(u, 'ok'); });
  on('Network.loadingFailed', (p) => { const u = byReq.get(p.requestId); if (u) finished.set(u, 'failed'); });
  on('Fetch.requestPaused', async (p) => {
    const url = p.request.url; const d = decide(url, p.request);
    try {
      if (d === 'continue') return await s('Fetch.continueRequest', { requestId: p.requestId });
      if (d === 'fail') return await s('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' });
      if (d === 'hold') { holds.set(url, p.requestId); return; }
      const body = Buffer.isBuffer(d.body) ? d.body : Buffer.from(String(d.body ?? ''));
      const headers = Object.entries({ 'content-type': 'application/json', 'access-control-allow-origin': '*', ...(d.headers || {}) }).map(([name, value]) => ({ name, value: String(value) }));
      await s('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: d.status || 200, responseHeaders: headers, body: body.toString('base64') });
    } catch (_) { /* the page may have navigated or aborted; nothing to do */ }
  });
  // EXTERNAL requests only (every https origin); loopback page assets flow untouched (see serveDir's gate)
  await s('Fetch.enable', { patterns: [{ urlPattern: 'https://*', requestStage: 'Request' }] });
  const take = (pred) => [...holds.entries()].filter(([u]) => pred(u)).map(([u, id]) => { holds.delete(u); return id; });
  return {
    holds, finished, seen,
    release: async (pred) => { for (const id of take(pred)) await s('Fetch.continueRequest', { requestId: id }).catch(() => {}); },
    failHeld: async (pred) => { for (const id of take(pred)) await s('Fetch.failRequest', { requestId: id, errorReason: 'Failed' }).catch(() => {}); },
  };
}

// every element's box (document order) to 0.01 px — a font reflow re-wraps text ⇒ widths / heights / positions change
export const GEO = `[...document.querySelectorAll('body *')].filter((e) => !/^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE)$/.test(e.tagName))
  .map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => v.toFixed(2)).join(','); })`;
export const OBSERVER = `window.__cls = 0; window.__shifts = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; window.__shifts.push(e.value); } }).observe({ type: 'layout-shift', buffered: true }); } catch (_) {}`;

const cssText = (props, name) => (props.find((p) => p.name === name) || {}).value || '';
function transform(text, tt) {
  if (tt === 'uppercase') return text.toLocaleUpperCase('es');
  if (tt === 'lowercase') return text.toLocaleLowerCase('es');
  if (tt === 'capitalize') return text.replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toLocaleUpperCase('es'));
  return text;
}

// The rendered-font census of the current document, one record per TEXT NODE (queried on the text node itself: an element query
// aggregates descendants and pseudo-elements, which blurs attribution — calibrated). Covers DOM text, the UA shadow text of inputs
// (values / placeholders, via pierce) and ::before / ::after content (queried on the pseudo node). Only nodes the renderer reports
// fonts for (i.e. painted) are kept. → [{ nodeId, path, family, weight, style, clamp, codepoints:[int], spaces, fonts:[…] }]
export async function census(cdp) {
  const { s } = cdp;
  const { root } = await s('DOM.getDocument', { depth: -1, pierce: true });
  const out = [];
  const styleOf = async (nodeId) => { try { return (await s('CSS.getComputedStyleForNode', { nodeId })).computedStyle; } catch (_) { return null; } };
  const record = async (fontNodeId, styleNodeId, raw, label) => {
    const props = await styleOf(styleNodeId); if (!props) return;
    let fonts = [];
    try { ({ fonts } = await s('CSS.getPlatformFontsForNode', { nodeId: fontNodeId })); } catch (_) { return; }
    if (!fonts.length) return;
    const shown = transform(raw, cssText(props, 'text-transform'));
    const clamp = cssText(props, '-webkit-line-clamp');
    out.push({ nodeId: fontNodeId, path: label, family: cssText(props, 'font-family'), weight: cssText(props, 'font-weight'), style: cssText(props, 'font-style'),
      clamp: clamp && clamp !== 'none' ? clamp : null,
      codepoints: [...shown].filter((ch) => !/\s/.test(ch)).map((ch) => ch.codePointAt(0)), spaces: (shown.match(/\s+/g) || []).length,
      fonts: fonts.map(({ familyName, isCustomFont, glyphCount }) => ({ familyName, isCustomFont, glyphCount })) });
  };
  const visit = async (node, trail) => {
    const label = node.nodeType === 1 ? `${trail}>${node.localName}${(node.attributes || []).reduce((a, v, i, arr) => (i % 2 === 0 && v === 'id' ? `${a}#${arr[i + 1]}` : a), '')}` : trail;
    if (node.pseudoType) {
      const props = await styleOf(node.nodeId);
      const m = props && cssText(props, 'content').match(/^"(.*)"$/);
      if (m && m[1].trim()) await record(node.nodeId, node.nodeId, m[1], `${trail}::${node.pseudoType}`);
      return;
    }
    if (node.nodeType === 1) for (const c of node.children || []) if (c.nodeType === 3 && c.nodeValue.trim()) await record(c.nodeId, node.nodeId, c.nodeValue, label);
    for (const p of node.pseudoElements || []) await visit(p, label);
    for (const k of [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])]) if (k.nodeType !== 3) await visit(k, label);
  };
  await visit(root, '');
  return out;
}

// The per-codepoint probe. For each distinct (family stack, weight, style, codepoint) among the nodes, render it alone in an off-screen
// span carrying exactly that computed font and read the ONE platform font that draws it. Mutates nothing visible; removes its probes.
// → Map(`${family}|${weight}|${style}|${cp}` → familyName)
export async function attribute(cdp, nodes) {
  const { s, ev } = cdp;
  const keys = [...new Set(nodes.flatMap((n) => [...n.codepoints, 32].map((cp) => `${n.family}|${n.weight}|${n.style}|${cp}`)))];
  const map = new Map();
  for (let i = 0; i < keys.length; i += 200) {
    const batch = keys.slice(i, i + 200);
    await ev(`(() => { const host = document.createElement('div'); host.id = '__fprobe'; host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:visible;contain:strict;width:9000px;height:9000px';
      for (const [j, k] of ${JSON.stringify(batch)}.entries()) { const [fam, w, st, cp] = k.split('|'); const e = document.createElement('span');
        e.id = '__fp' + j; e.style.cssText = 'white-space:pre;font-size:32px'; e.style.fontFamily = fam; e.style.fontWeight = w; e.style.fontStyle = st;
        e.textContent = String.fromCodePoint(Number(cp)); host.appendChild(e); }
      document.documentElement.appendChild(host); return true; })()`);
    const { root } = await s('DOM.getDocument', { depth: 0 });
    for (let j = 0; j < batch.length; j++) {
      const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector: `#__fp${j}` });
      const { fonts } = await s('CSS.getPlatformFontsForNode', { nodeId });
      map.set(batch[j], fonts.length === 1 ? fonts[0].familyName : fonts.map((f) => f.familyName).join('+') || '(none)');
    }
    await ev(`document.getElementById('__fprobe').remove(), true`);
  }
  return map;
}

// Runs per node, from the probe: [{ familyName, codepoints:[int] }]; plus the fidelity check (probe counts per font == the node's own
// glyph counts). A node's mismatch is returned, never silently ignored.
export function runsOf(node, probe) {
  const runs = new Map();
  for (const cp of node.codepoints) { const f = probe.get(`${node.family}|${node.weight}|${node.style}|${cp}`); if (!runs.has(f)) runs.set(f, []); runs.get(f).push(cp); }
  const probeCounts = Object.fromEntries([...runs].map(([f, cps]) => [f, cps.length]));
  const nodeCounts = Object.fromEntries(node.fonts.map((f) => [f.familyName, f.glyphCount]));
  // Fidelity: NON-whitespace glyphs per font must match EXACTLY; the node's extra glyphs may only be whitespace, on the font that draws
  // a space for this stack, and at most one per raw whitespace run (collapsing / line-edge trimming can only remove spaces).
  const spaceFont = probe.get(`${node.family}|${node.weight}|${node.style}|32`);
  const problems = [];
  for (const f of new Set([...Object.keys(probeCounts), ...Object.keys(nodeCounts)])) {
    const extra = (nodeCounts[f] || 0) - (probeCounts[f] || 0);
    const allowed = f === spaceFont ? node.spaces : 0;
    if (node.clamp) {
      // LISTED SHAPING EXCEPTION — -webkit-line-clamp: Chrome lays the clamped text out twice and over-reports its glyphs. The SET of
      // fonts must still match the probe exactly, and the node must report at least the probe's non-space glyphs; only the exact
      // count is relaxed (calibrated: .pizza-card-desc, line-clamp 1, 30 chars → 51 glyphs).
      if (!probeCounts[f] && f !== spaceFont) problems.push(`${f}: a clamped node reports a font the probe never attributed`);
      else if (!nodeCounts[f] && probeCounts[f]) problems.push(`${f}: the probe attributes glyphs to a font the clamped node does not report`);
      else if (extra < 0) problems.push(`${f}: clamped node ${nodeCounts[f] || 0} < probe ${probeCounts[f] || 0}`);
      continue;
    }
    if (extra < 0 || extra > allowed) problems.push(`${f}: node ${nodeCounts[f] || 0} vs probe ${probeCounts[f] || 0} (+≤${allowed} spaces)`);
  }
  return { runs: [...runs].map(([familyName, codepoints]) => ({ familyName, codepoints })), probeCounts, nodeCounts, fidelity: problems };
}

export async function geometry(cdp) { return cdp.ev(GEO); }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
