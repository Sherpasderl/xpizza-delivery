// P2-2 (codex r1) — geometry that only a real browser can measure. Drives the REAL layoutDecks over a
// mixed stack (ASAP + released-scheduled, collapsed and one expanded) rendered with the REAL passHTML and
// the REAL index.html CSS, then measures each card. Asserts non-badge cards reveal exactly their 80px peek
// and badge cards reveal their own 100px peek. Reverting layoutDecks (global PEEK) or deleting the
// `.peek.has-sched` height makes the measured geometry wrong and fails this runner.
//
// Dependency-free DevTools-protocol runner (same shape as xpizza-handheld/test-browser.mjs).
// Run: `node xpizza-dispatch-mobile/scheduled-badge-browser.mjs`  (CHROME_BIN overrides the binary).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { slotLabel } from './slot-format.js';
import { agingBaselineMs, agingSeconds } from './dispatch-aging.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');

// ── render a mixed deck with the real passHTML + real CSS (node side) ─────────
const style = (() => { let o = '', f = 0; for (let i = 0; i < 2; i++) { const s = html.indexOf('<style>', f); if (s < 0) break; const e = html.indexOf('</style>', s) + 8; o += html.slice(s, e) + '\n'; f = e; } return o; })();
const sliceFn = (sig) => html.slice(html.indexOf(sig), html.indexOf('\n}', html.indexOf(sig)) + 2);
const sliceConst = (sig) => html.slice(html.indexOf(sig), html.indexOf('\n', html.indexOf(sig)));
const passHTMLSrc = sliceFn('function passHTML(id, order){');
const layoutDecksSrc = sliceFn('function layoutDecks(){');
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;' }[c]));

const stubs = `
  const openPass = null; const IC_STORE='',IC_PLUS='',IC_CHECK='',IC_PHONE='';
  const levelOf=()=> 'calm'; const minutesOf=()=> 8;
  const displayDriverId=()=>null; const assignedDriverId=()=>'d1'; const canReassign=()=>true;
  const oneLineItems=()=> 'items'; const paymentLine=()=> ''; const dotVar=()=> 'var(--sky-ink)';
  const stateParts=()=> ({ lead:'Daniela', tail:'en camino' });
  const brandKey=()=> 'lm'; const brandMark=()=> 'M'; const brandName=()=> 'La Musa'; const displayLabel=(id)=>'#'+id;
  const doneClock=()=> ''; const STORE={ drivers:{ d1:{name:'Daniela'} } };
  ${sliceConst('const icClock =')}
  ${sliceConst('const hasSlot =')}
  ${sliceConst('const slotLabelSafe =')}
`;
const mk = new Function('slotLabel', 'agingBaselineMs', 'agingSeconds', 'escapeHtml', `${stubs}\n${passHTMLSrc}\n; return passHTML;`)(slotLabel, agingBaselineMs, agingSeconds, escapeHtml);
const SF = Date.now() + 90 * 60 * 1000;
const asap = { customer_name: 'Marcela', status: 'preparing', created_at: Date.now() - 12 * 60 * 1000, order_type: 'delivery' };
const released = { customer_name: 'Rodrigo', status: 'preparing', scheduled_for: SF, released_at: Date.now() - 8 * 60 * 1000, order_type: 'delivery' };
const card = (id, o, open) => mk(id, o).replace('class="pass lv-calm', `class="pass lv-calm${open ? ' open' : ''}`);
const deckA = `<div class="deck">${card('a1', asap)}${card('b1', released)}${card('b2', released)}</div>`;      // all collapsed
const deckB = `<div class="deck">${card('c1', asap)}${card('c2', released, true)}${card('c3', released)}</div>`; // middle expanded

const page = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${style}
<style>body{background:var(--ground)} .board{max-width:402px;margin:0 auto;padding:12px}</style>
</head><body>
<div class="board" id="A">${deckA}</div>
<div class="board" id="B">${deckB}</div>
<script>
  const PEEK = 80;
  ${layoutDecksSrc}
  requestAnimationFrame(() => { requestAnimationFrame(() => {
    layoutDecks();
    const read = (boardId) => [...document.querySelectorAll('#' + boardId + ' .pass')].map((p) => ({
      mt: p.style.marginTop, full: p.offsetHeight, peek: p.querySelector('.peek').offsetHeight,
      open: p.classList.contains('open'),
    }));
    window.__m = { A: read('A'), B: read('B') };
    window.__ready = true;
  }); });
</script>
</body></html>`;

// ── serve + drive headless chrome over the DevTools protocol ──────────────────
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
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'schedbadge-browser-'));
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
  await send('Emulation.setDeviceMetricsOverride', { width: 402, height: 900, deviceScaleFactor: 2, mobile: true }, sessionId);
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  };
  await send('Page.navigate', { url: base }, sessionId);
  let ready = false;
  for (let i = 0; i < 100; i++) { if (await ev('window.__ready === true')) { ready = true; break; } await new Promise((x) => setTimeout(x, 50)); }
  assert.ok(ready, 'page rendered + layoutDecks ran');
  const m = await ev('window.__m');

  // Peek heights: ASAP card 80px, each badge card its own 100px peek.
  assert.equal(m.A[0].peek, 80, 'ASAP card peek is 80px');
  assert.equal(m.A[1].peek, 100, 'badge card peek is 100px (its own measured peek, not the global PEEK)');
  assert.equal(m.A[2].peek, 100, 'second badge card peek is 100px');

  // Collapsed stack: each card after the first reveals exactly the PREVIOUS card's own peek.
  assert.equal(m.A[0].mt, '0px', 'first card has no negative margin');
  assert.equal(m.A[1].mt, `${-(m.A[0].full - m.A[0].peek)}px`, 'card after ASAP reveals ASAP’s 80px peek');
  assert.equal(m.A[2].mt, `${-(m.A[1].full - m.A[1].peek)}px`, 'card after a badge card reveals its 100px peek (not 80)');
  // Guard against a GLOBAL PEEK: with PEEK=80 the badge predecessor would reveal only 80px, pulling the
  // next card up 20px further. Assert the badge card reveals its own 100px, i.e. 20px LESS pull-up than a
  // global PEEK would give. (-(full-100) is exactly +20 vs -(full-80).)
  assert.equal(m.A[2].mt, `${-(m.A[1].full - 100)}px`, 'badge predecessor reveals 100px, not the global 80px');
  assert.notEqual(m.A[2].mt, `${-(m.A[1].full - 80)}px`, 'reverting to global PEEK=80 would change this margin');

  // Expanded predecessor → the next card sits flush (no overlap).
  assert.equal(m.B[1].open, true, 'middle card is expanded');
  assert.equal(m.B[2].mt, '0px', 'the card after an OPEN card has no negative margin (no overlap)');

  console.log('scheduled-badge-browser: OK (peek 80/100 per-card, reveal per-card, open→flush)');
  code = 0;
} catch (e) {
  console.error('scheduled-badge-browser: FAIL —', e.message);
} finally {
  try { ws.close(); } catch {}
  try { chrome.kill(); } catch {}
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.exit(code);
