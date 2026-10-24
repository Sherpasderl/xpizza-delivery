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
import { makeReleasedOrder, withFrozenClock } from './scheduled-badge-fixture.mjs';

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
const asap = { customer_name: 'Marcela', status: 'preparing', created_at: Date.now() - 12 * 60 * 1000, order_type: 'delivery' };
// The released card is built from the REAL releaseOne writer (frozen clock), same source as the node test.
const { order: released } = await withFrozenClock(() => makeReleasedOrder({ agoMin: 8 }));
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
  const DECK_A = ${JSON.stringify(deckA)};
  ${layoutDecksSrc}
  const read = (boardId) => [...document.querySelectorAll('#' + boardId + ' .pass')].map((p) => ({
    mt: p.style.marginTop, full: p.offsetHeight, peek: p.querySelector('.peek').offsetHeight,
    open: p.classList.contains('open'),
  }));
  requestAnimationFrame(() => { requestAnimationFrame(() => {
    layoutDecks();
    const initial = read('A');
    const B = read('B');
    // expand the first badge card → re-layout
    document.querySelectorAll('#A .pass')[1].classList.add('open');
    layoutDecks();
    const expanded = read('A');
    // collapse it again → re-layout
    document.querySelectorAll('#A .pass')[1].classList.remove('open');
    layoutDecks();
    const collapsed = read('A');
    // rerender the whole list, then re-layout (a fresh render must keep the geometry)
    document.getElementById('A').innerHTML = DECK_A;
    layoutDecks();
    const rerendered = read('A');
    window.__m = { initial, expanded, collapsed, rerendered, B };
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

  // Peek heights hold in EVERY phase: ASAP card 80px, each badge card its own 100px peek.
  const peeks = (phase, cards) => {
    assert.equal(cards[0].peek, 80, `${phase}: ASAP card peek is 80px`);
    assert.equal(cards[1].peek, 100, `${phase}: badge card peek is 100px (its own peek, not the global PEEK)`);
    assert.equal(cards[2].peek, 100, `${phase}: second badge card peek is 100px`);
  };

  // Initial collapsed stack: each card after the first reveals exactly the PREVIOUS card's own peek.
  peeks('initial', m.initial);
  assert.equal(m.initial[0].mt, '0px', 'first card has no negative margin');
  assert.equal(m.initial[1].mt, `${-(m.initial[0].full - m.initial[0].peek)}px`, 'card after ASAP reveals ASAP’s 80px peek');
  assert.equal(m.initial[2].mt, `${-(m.initial[1].full - 100)}px`, 'card after a badge card reveals its own 100px peek');
  assert.notEqual(m.initial[2].mt, `${-(m.initial[1].full - 80)}px`, 'reverting to a global PEEK=80 would change this margin');

  // Expand → collapse cycle: expanding the badge card makes the next card flush; collapsing restores it.
  peeks('expanded', m.expanded);
  assert.equal(m.expanded[1].open, true, 'the badge card is expanded');
  assert.equal(m.expanded[2].mt, '0px', 'the card after an OPEN card is flush (no overlap)');
  peeks('collapsed', m.collapsed);
  assert.deepEqual(m.collapsed.map((c) => c.mt), m.initial.map((c) => c.mt), 'collapsing restores the collapsed geometry exactly');

  // Rerender: re-rendering the list and re-running layoutDecks reproduces the same geometry.
  peeks('rerendered', m.rerendered);
  assert.deepEqual(m.rerendered.map((c) => c.mt), m.initial.map((c) => c.mt), 'rerender + re-layout reproduces the geometry');

  // Static deck B with a pre-expanded middle card: the card after it is flush.
  assert.equal(m.B[1].open, true, 'deck B middle card is expanded');
  assert.equal(m.B[2].mt, '0px', 'the card after an OPEN card has no negative margin');

  console.log('scheduled-badge-browser: OK (peek 80/100 every phase; per-card reveal; expand→collapse; rerender; open→flush)');
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
