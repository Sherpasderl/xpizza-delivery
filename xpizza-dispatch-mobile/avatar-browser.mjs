// Real-browser proof (DevTools protocol, same runner shape as xpizza-handheld/test-browser.mjs) that the
// `.av.empty{padding:0}` fix makes the empty-driver avatar a centred CIRCLE: 42×42 on the board (.peek .av)
// and 44×44 in the picker (.row .av) — not the 52×96 ellipse the `.empty` collision produced. Run:
// `node xpizza-dispatch-mobile/avatar-browser.mjs` (CHROME_BIN overrides the binary).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
const style = (() => { let o = '', f = 0; for (let i = 0; i < 2; i++) { const s = html.indexOf('<style>', f); if (s < 0) break; const e = html.indexOf('</style>', s) + 8; o += html.slice(s, e) + '\n'; f = e; } return o; })();
const EMPTY = '<span class="av empty"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span>';
const page = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>avatar</title>${style}<style>body{background:var(--ground)}</style></head><body>
  <div class="deck"><div class="pass lv-act"><button class="peek"><span class="t rd num"><b>3</b><s>min</s></span><span class="m"><span class="r1"><span class="nm">X</span></span></span>${EMPTY}</button></div></div>
  <div class="panel" style="max-width:360px"><button class="row" type="button"><span class="m"><b>Y</b></span>${EMPTY}</button></div>
</body></html>`;

function chromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of (fs.existsSync(cache) ? fs.readdirSync(cache) : []).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of fs.readdirSync(path.join(cache, d))) { const p = path.join(cache, d, sub, 'chrome-headless-shell'); if (fs.existsSync(p)) return p; }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-browser-'));
const chrome = spawn(chromeBin(), ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) resolve(m[1]); }); });
const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

let code = 1;
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width: 402, height: 700, deviceScaleFactor: 2, mobile: true }, sessionId);
  const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  await send('Page.navigate', { url: base }, sessionId);
  let ready = false;
  for (let i = 0; i < 100; i++) { if (await ev('document.querySelectorAll(".av.empty").length === 2')) { ready = true; break; } await new Promise((x) => setTimeout(x, 50)); }
  assert.ok(ready, 'page rendered both empty avatars');
  const m = await ev(`(() => { const r = (sel) => { const a = document.querySelector(sel + ' .av.empty'); const b = a.getBoundingClientRect(); const s = a.querySelector('svg').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), dx: Math.round((s.left+s.width/2)-(b.left+b.width/2)), dy: Math.round((s.top+s.height/2)-(b.top+b.height/2)) }; }; return { board: r('.peek'), picker: r('.row') }; })()`);
  assert.deepEqual(m.board, { w: 42, h: 42, dx: 0, dy: 0 }, 'board avatar is a 42×42 centred circle');
  assert.deepEqual(m.picker, { w: 44, h: 44, dx: 0, dy: 0 }, 'picker avatar is a 44×44 centred circle');
  console.log('avatar-browser: OK (board 42×42, picker 44×44, both centred)');
  code = 0;
} catch (e) { console.error('avatar-browser: FAIL —', e.message); }
finally { try { ws.close(); } catch {} try { chrome.kill(); } catch {} server.close(); try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }
process.exit(code);
