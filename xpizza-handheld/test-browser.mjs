// H1b — checks that need a real browser. `npm --prefix xpizza-handheld run test:browser`
//   1. a11y (codex H1b r1 P2-15): in every build state of the review harness, every interactive element's RENDERED box is ≥ 48 px on
//      both axes (switches included — the prototype's 32 px switch now sits in a 52×48 hit area).
//   2. morph.js (P2-10): identical markup keeps every node; a text change keeps the scroll position and the node; attributes sync and
//      are removed; a typed <input> value survives; children are appended / removed; a tag change replaces the node.
// Same dependency-free DevTools-protocol runner as test-offline.mjs. CHROME_BIN overrides the browser binary.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2' };
const STATES = ['login', 'branch', 'checks', 'pin', 'empty', 'alert', 'alertAmber', 'alertRed', 'detailNew', 'reject', 'rejectItems', 'prepList', 'detailPrep',
  'more', 'ready', 'status', 'busySheet', 'pauseSheet', 'busyDetail', 'offline', 'agotados', 'pinPrompt', 'settings', 'logout'];

function chromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of (fs.existsSync(cache) ? fs.readdirSync(cache) : []).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of fs.readdirSync(path.join(cache, d))) { const p = path.join(cache, d, sub, 'chrome-headless-shell'); if (fs.existsSync(p)) return p; }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'h1b-browser-'));
const chrome = spawn(chromeBin(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); }); });
const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

let code = 1;
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 720, deviceScaleFactor: 2, mobile: true }, sessionId);
  await send('Emulation.setTimezoneOverride', { timezoneId: 'America/Tegucigalpa' }, sessionId);
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  };
  const open = async (url) => {
    await send('Page.navigate', { url }, sessionId);
    for (let i = 0; i < 100; i++) { if (await ev('window.__ready === true')) return; await new Promise((x) => setTimeout(x, 50)); }
    throw new Error(`not ready: ${url}`);
  };

  // 1. a11y: ≥ 48 px rendered targets
  const small = []; let measured = 0;
  for (const st of STATES) {
    await open(`${base}/review/h1b/harness.html?side=build&state=${st}`);
    const r = await ev(`[...document.querySelectorAll('#app [data-act], #app input')].filter((e) => e.offsetParent !== null || e.getClientRects().length)
      .map((e) => { const b = e.getBoundingClientRect(); return { tag: e.tagName, cls: e.className, txt: (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 30), w: Math.round(b.width), h: Math.round(b.height) }; })`);
    measured += r.length;
    for (const x of r) if (x.w < 48 || x.h < 48) small.push(`${st}: <${x.tag.toLowerCase()} class="${x.cls}"> "${x.txt}" ${x.w}×${x.h}`);
  }
  assert.deepEqual(small, [], 'every interactive target ≥ 48 px');
  assert.ok(measured > 150, `measured ${measured} targets across ${STATES.length} states`);
  console.log(`  ok a11y: ${measured} interactive targets across ${STATES.length} states, all ≥ 48×48`);

  // 2. morph.js
  await open(`${base}/review/h1b/harness.html?side=build&state=empty`);
  const m = await ev(`(async () => {
    const { morph } = await import('/xpizza-handheld/morph.js');
    const out = {};
    const host = document.createElement('div'); document.body.appendChild(host);
    const page = (t, extra = '') => '<div class="body" style="height:80px;overflow:auto"><input id="note" value="">' + Array.from({ length: 40 }, (_, i) => '<p data-i="' + i + '">' + (i === 3 ? t : 'línea ' + i) + '</p>').join('') + extra + '</div>';
    morph(host, page('uno'));
    const body = host.firstElementChild; const p3 = host.querySelector('[data-i="3"]'); const inp = host.querySelector('#note');
    body.scrollTop = 300; inp.value = 'escribiendo';
    morph(host, page('uno'));
    out.identical = host.firstElementChild === body && host.querySelector('[data-i="3"]') === p3;
    morph(host, page('dos'));
    out.textPatched = host.querySelector('[data-i="3"]') === p3 && p3.textContent === 'dos';
    out.scrollKept = body.scrollTop === 300;
    out.inputKept = host.querySelector('#note') === inp && inp.value === 'escribiendo';
    morph(host, page('dos').replace('style="height:80px;overflow:auto"', 'style="height:80px;overflow:auto" data-x="1"'));
    out.attrSet = body.getAttribute('data-x') === '1';
    morph(host, page('dos'));
    out.attrRemoved = !body.hasAttribute('data-x');
    morph(host, page('dos', '<b id="extra">x</b>'));
    out.appended = !!host.querySelector('#extra');
    morph(host, page('dos'));
    out.removed = !host.querySelector('#extra');
    morph(host, page('dos').replace('<p data-i="5">línea 5</p>', '<span data-i="5">línea 5</span>'));
    out.replaced = host.querySelector('[data-i="5"]').tagName === 'SPAN';
    return out;
  })()`);
  assert.deepEqual(m, { identical: true, textPatched: true, scrollKept: true, inputKept: true, attrSet: true, attrRemoved: true, appended: true, removed: true, replaced: true });
  console.log('  ok morph: identity kept, scroll + typing survive, attributes / children / tags patched');
  console.log('test:browser: OK');
  code = 0;
} catch (e) {
  console.error('test:browser FAILED:', e && e.message);
} finally {
  try { ws.close(); } catch (_) { /* closed */ }
  chrome.kill('SIGTERM'); server.close();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* best effort */ } process.exit(code); }, 300);
}
