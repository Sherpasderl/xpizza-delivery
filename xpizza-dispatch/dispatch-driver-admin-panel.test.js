// dispatch-driver-admin-panel.test.js — REAL headless-Chrome interaction test for the S1b "Administrar
// repartidores" panels (desktop + mobile). codex r1 P2-9/10 required browser coverage of: open, a live snapshot
// arriving during an edit/open dialog (must NOT clobber it), the one-time link surviving a snapshot, visible
// failure feedback, navigation during pending reads (a stale async render must not overwrite a later view), and
// close/reopen listener cleanup. The real PANEL JS is extracted from the shipped HTML and driven in Chrome with
// in-page stubs for the account subscription + callables (no network, deterministic).
//
// Follows dispatch-cashbar-layout.test.js EXACTLY for the Chrome harness: --dump-dom, a hard deadline that
// process-GROUP-kills immediately, mkdtemp page dir reaped in finally, and FAIL LOUD (never skip) if Chrome missing.
// Run:  node dispatch-driver-admin-panel.test.js
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEADLINE_MS = 30000;
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const desktop = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const mobileHtml = fs.readFileSync(path.join(__dirname, '..', 'xpizza-dispatch-mobile', 'index.html'), 'utf8');

// ── extract the real panel source (pure functions + wiring, no import lines) ──
function slice(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker); assert.ok(s > -1, `start marker not found: ${startMarker}`);
  const e = src.indexOf(endMarker, s); assert.ok(e > -1, `end marker not found: ${endMarker}`);
  return src.slice(s, e);
}
const draStyle = (desktop.match(/<style id="dra-style">([\s\S]*?)<\/style>/) || [, ''])[1];
const draJs = slice(desktop, 'function deriveDriverAcctState(rec) {', "$('dra-open')?.addEventListener");
const mdraJs = slice(mobileHtml, 'function mdraDeriveState(rec) {', '\nrenderLive();');
assert.ok(/function draRenderLink/.test(draJs) && /function draRenderDeactivate/.test(draJs), 'desktop panel source extracted');
assert.ok(/function mdraRenderLink/.test(mdraJs) && /function mdraDeactivate/.test(mdraJs), 'mobile panel source extracted');
ok('extracted the real desktop + mobile panel source from the shipped HTML');

// Shared in-page stub harness (same for both panels; the panel-specific db-fn names are aliased per page).
const STUBS = `
var escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function $(id){ return document.getElementById(id); }
var allDrivers = {};
var STORE = { drivers: {} };
var H = { accData:{}, accSubs:[], cashSubs:[], unsub:0, getData:{}, getDelay:0, getFail:false, call:'ok', toasts:[] };
window.H = H;
function toast(m, k){ H.toasts.push({ m: m, k: k }); }
var navigatorStub = navigator;
var XPD = {
  getDb: () => ({}),
  getAuthInstance: () => ({ app:{}, currentUser:{ getIdToken: async()=> 't' } }),
  subscribeToDriverCash: (onData, onErr) => { var s={onData:onData,onErr:onErr}; H.cashSubs.push(s); onData(H.cashData||{}); return () => { H.unsub++; var i=H.cashSubs.indexOf(s); if(i>=0) H.cashSubs.splice(i,1); }; },
};
function _ref(db, p){ return { path: p }; }
function _onValue(r, cb, err){ var s={cb:cb,err:err}; H.accSubs.push(s); cb({ val: () => H.accData }); return () => { H.unsub++; var i=H.accSubs.indexOf(s); if(i>=0) H.accSubs.splice(i,1); }; }
function _off(){}
function _get(r){ return new Promise((res,rej)=>{ setTimeout(()=>{ if(H.getFail){ rej(new Error('read fail')); return; } var v=H.getData[r.path]; res({ val: ()=> (v===undefined?null:v), exists: ()=> v!==undefined && v!==null }); }, H.getDelay); }); }
function _getFunctions(app, region){ return { app:app, region:region }; }
function _httpsCallable(fns, name){ return (data) => { if(H.call==='fail'){ var e=new Error('No se puede todavía'); e.code='functions/failed-precondition'; e.details={ reasons:['cash'], open_orders:[] }; return Promise.reject(e); } return Promise.resolve({ data:{ ok:true, link: (name==='inviteDriver' ? 'https://reset/LINK' : undefined) } }); }; }
// desktop aliases
var draRef=_ref, draOnValue=_onValue, draOff=_off, draGet=_get, draGetFunctions=_getFunctions, draHttpsCallable=_httpsCallable;
// mobile aliases
var ref=_ref, onValue=_onValue, fbOff=_off, fbGet=_get, serverTimestamp=()=>0, mdraGetFunctions=_getFunctions, mdraHttpsCallable=_httpsCallable;
var flush = () => new Promise(r=>setTimeout(r,0));
`;

function desktopPage() {
  return `<!doctype html><html><head><meta charset=utf8><style>${draStyle}</style><style>.hidden{display:none}</style></head><body>
<div class="overlay-bg hidden" id="dra-overlay"><div class="dra-panel"><div class="dra-body" id="dra-body"></div></div></div>
<button id="dra-open"></button><button id="dra-close"></button>
<svg style="display:none"><symbol id="i-check"></symbol><symbol id="i-close"></symbol><symbol id="i-alert"></symbol></svg>
<div id="out"></div>
<script>window.onerror=function(msg,src,line,col){try{document.getElementById('out').textContent='PANEL_RESULT:'+JSON.stringify({error:msg+' @'+line+':'+col})+':END';}catch(e){}};</script>
<script>${STUBS}
${draJs}
(async () => {
 var res = {};
 H.accData = { u1:{enabled:true,onboarding_state:'active',name:'Ana'}, u2:{enabled:false,onboarding_state:'active',approved_at:1,name:'Beto'}, u3:{enabled:false,onboarding_state:'pending',name:'Caro'} };
 H.getData = { 'drivers/u2':{active:false}, 'tasks':{}, 'dispatchers/u2':null, 'kitchen/u2':null };
 H.cashData = { u2:{ s1:{ cuadre:{ closed_at: Date.now(), cash_owed:0, cash_order_count:0, provisional:false } } } };
 draOpen(); await flush();
 res.openRows = document.querySelectorAll('#dra-body .dra-row').length;
 // snapshot during an open INVITE edit must not clobber it
 DRA.view='invite'; draRender();
 H.pushSnap = (d)=>{ H.accData=d; H.accSubs.forEach(s=>s.cb({val:()=>d})); };
 H.pushSnap(Object.assign({ u9:{enabled:true,onboarding_state:'active',name:'Z'} }, H.accData)); await flush();
 res.inviteSurvives = !!document.getElementById('dra-i-name') && DRA.view==='invite';
 // one-time link survives a snapshot
 DRA.view='list'; draRender(); draShowLink('https://reset/LINK'); await flush();
 var lb = /reset\\/LINK/.test($('dra-body').innerHTML) && DRA.view==='invited';
 H.pushSnap(H.accData); await flush();
 res.linkSurvives = lb && /reset\\/LINK/.test($('dra-body').innerHTML) && DRA.view==='invited';
 $('dra-link-done').click(); await flush();
 res.linkCleared = DRA.view==='list' && !/reset\\/LINK/.test($('dra-body').innerHTML);
 // callable failure → visible toast
 H.call='fail'; H.toasts=[];
 H.accData.u4={enabled:false,onboarding_state:'profile_submitted',name:'Dani'}; DRA.view='list'; draRender();
 var ap=document.querySelector('#dra-body .dra-act[data-act="approve"]'); if(ap) ap.click(); await flush(); await flush();
 res.toastShown = H.toasts.length>0;
 H.call='ok';
 // navigation during pending reads — a stale deactivate render must NOT overwrite the list
 H.getDelay=40; DRA.view='list'; draRender();
 draAction('deactivate','u2'); await flush();
 DRA.view='list'; DRA.selUid=null; draRender();
 await new Promise(r=>setTimeout(r,90));
 res.navSafe = DRA.view==='list' && document.querySelectorAll('#dra-body .dra-row').length>0 && !/Desactivar a/.test($('dra-body').innerHTML);
 H.getDelay=0;
 // acctErr → error state, never "No hay repartidores"
 H.accSubs.forEach(s=>s.err&&s.err()); DRA.view='list'; draRender(); await flush();
 res.errState = /No se pudieron cargar/.test($('dra-body').innerHTML) && !/No hay repartidores/.test($('dra-body').innerHTML);
 DRA.acctErr=false;
 // close/reopen listener lifecycle
 var before=H.unsub; draClose(); res.unsubOnClose = H.unsub>before;
 var subs=H.accSubs.length; draOpen(); await flush();
 res.resubOnOpen = H.accSubs.length>subs;
 document.getElementById('out').textContent='PANEL_RESULT:'+JSON.stringify(res)+':END';
})().catch(e=>{ document.getElementById('out').textContent='PANEL_RESULT:'+JSON.stringify({error:String(e&&e.stack||e)})+':END'; });
</script></body></html>`;
}

function mobilePage() {
  return `<!doctype html><html><head><meta charset=utf8></head><body>
<button id="x"></button><div id="out"></div>
<script>window.onerror=function(msg,src,line,col){try{document.getElementById('out').textContent='PANEL_RESULT:'+JSON.stringify({error:msg+' @'+line+':'+col})+':END';}catch(e){}};</script>
<script>${STUBS}
${mdraJs}
(async () => {
 var res = {};
 STORE.drivers = { g1:{ name:'Grandpa Driver' } };
 H.accData = { u1:{enabled:true,onboarding_state:'active',name:'Ana'}, u2:{enabled:false,onboarding_state:'active',approved_at:1,name:'Beto'}, g1:{enabled:true,onboarding_state:'active',grandfathered:true} };
 H.getData = { 'drivers/u2':{active:false}, 'tasks':{}, 'dispatchers/u2':null, 'kitchen/u2':null };
 H.cashData = { u2:{ s1:{ cuadre:{ closed_at: Date.now(), cash_owed:0, cash_order_count:0, provisional:false } } } };
 mdraOpen(); await flush();
 res.openRows = document.querySelectorAll('#mdra-body .mdra-row').length;
 // grandfathered name fallback (P2-13): g1 has no profile/name → roster name shows, not a short uid
 res.grandfatheredName = /Grandpa Driver/.test($('mdra-body').innerHTML);
 // one-time link survives a snapshot
 H.pushSnap = (d)=>{ H.accData=d; H.accSubs.forEach(s=>s.cb({val:()=>d})); };
 mdraLink('https://reset/MLINK'); await flush();
 var lb = /reset\\/MLINK/.test($('mdra-body').innerHTML) && MDRA.view==='invited';
 H.pushSnap(H.accData); await flush();
 res.linkSurvives = lb && /reset\\/MLINK/.test($('mdra-body').innerHTML) && MDRA.view==='invited';
 $('mdra-dn').click(); await flush(); res.linkCleared = MDRA.view==='list';
 // callable failure → visible toast
 H.call='fail'; H.toasts=[];
 H.accData.u4={enabled:false,onboarding_state:'profile_submitted',name:'Dani'}; MDRA.view='list'; mdraRender();
 var ap=document.querySelector('#mdra-body [data-mact="approve"]'); if(ap) ap.click(); await flush(); await flush();
 res.toastShown = H.toasts.length>0; H.call='ok';
 // suspend shows a CONFIRMATION screen (P2-13), not an immediate call
 MDRA.view='list'; mdraRender();
 var sb=document.querySelector('#mdra-body [data-mact="suspend"]'); if(sb) sb.click(); await flush();
 res.suspendConfirms = !!document.getElementById('mdra-cfm') && MDRA.dialogOpen===true;
 if(document.getElementById('mdra-cxl')) document.getElementById('mdra-cxl').click(); await flush();
 // navigation during pending reads — stale deactivate render must not overwrite
 H.getDelay=40; MDRA.view='list'; mdraRender();
 mdraAction('deactivate','u2'); await flush();
 MDRA.view='list'; MDRA.sel=null; mdraRender();
 await new Promise(r=>setTimeout(r,90));
 res.navSafe = MDRA.view==='list' && !/Desactivar a/.test($('mdra-body').innerHTML);
 H.getDelay=0;
 // close/reopen listener lifecycle
 var before=H.unsub; mdraClose(); res.unsubOnClose = H.unsub>before;
 var subs=H.accSubs.length; mdraOpen(); await flush(); res.resubOnOpen = H.accSubs.length>subs;
 document.getElementById('out').textContent='PANEL_RESULT:'+JSON.stringify(res)+':END';
})().catch(e=>{ document.getElementById('out').textContent='PANEL_RESULT:'+JSON.stringify({error:String(e&&e.stack||e)})+':END'; });
</script></body></html>`;
}

if (!fs.existsSync(CHROME)) { console.error(`\n✗ FAIL: Google Chrome not found at ${CHROME} — this real-panel interaction gate requires Chrome and must not be skipped.`); process.exit(1); }

function runChrome(fileUrl) {
  return new Promise((resolve, reject) => {
    // --virtual-time-budget: the panel driver is async (stubbed reads/callables resolve on timers); advance virtual
    // time so all timers fire before --dump-dom serializes the DOM. Without it the dump races the async driver.
    const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--window-size=900,1200', '--virtual-time-budget=8000', '--dump-dom', fileUrl], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '', done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} finish(reject, new Error(`Chrome exceeded the ${DEADLINE_MS}ms deadline (group killed)`)); }, DEADLINE_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', () => finish(resolve, out));
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dra-panel-'));
  let seq = 0;
  const run = async (html) => {
    const file = path.join(tmp, `p${seq++}.html`); fs.writeFileSync(file, html);
    const dom = await runChrome(`file://${file}`);
    const m = dom.match(/PANEL_RESULT:(\{[\s\S]*\}):END/); assert.ok(m, 'got a PANEL_RESULT from Chrome');
    return JSON.parse(m[1]);
  };
  try {
    const d = await run(desktopPage());
    assert.ok(!d.error, `desktop driver threw: ${d.error}`);
    assert.ok(d.openRows >= 3, `desktop: panel opens and renders the roster (${d.openRows} rows)`);
    assert.strictEqual(d.inviteSurvives, true, 'desktop: a live snapshot during an open invite edit does NOT clobber it');
    assert.strictEqual(d.linkSurvives, true, 'desktop: the one-time link survives a live snapshot');
    assert.strictEqual(d.linkCleared, true, 'desktop: "Listo" clears the one-time link and returns to the list');
    assert.strictEqual(d.toastShown, true, 'desktop: a callable failure surfaces a visible toast');
    assert.strictEqual(d.navSafe, true, 'desktop: navigating away during pending reads is not overwritten by the stale deactivate render');
    assert.strictEqual(d.errState, true, 'desktop: a failed accounts read shows an error state, never "No hay repartidores"');
    assert.strictEqual(d.unsubOnClose, true, 'desktop: close unsubscribes the account + cash listeners');
    assert.strictEqual(d.resubOnOpen, true, 'desktop: reopen re-subscribes cleanly');
    ok(`desktop panel: open/snapshot-safe/link-persist/failure-toast/nav-safe/error-state/cleanup (${d.openRows} rows)`);

    const m = await run(mobilePage());
    assert.ok(!m.error, `mobile driver threw: ${m.error}`);
    assert.ok(m.openRows >= 3, `mobile: sheet opens and renders the roster (${m.openRows} rows)`);
    assert.strictEqual(m.grandfatheredName, true, 'mobile: a grandfathered (no-profile) record shows the roster name, not a short uid');
    assert.strictEqual(m.linkSurvives, true, 'mobile: the one-time link survives a live snapshot');
    assert.strictEqual(m.linkCleared, true, 'mobile: "Listo" returns to the list');
    assert.strictEqual(m.toastShown, true, 'mobile: a callable failure surfaces a visible toast (not alert)');
    assert.strictEqual(m.suspendConfirms, true, 'mobile: suspend shows a confirmation screen (desktop parity), not an immediate call');
    assert.strictEqual(m.navSafe, true, 'mobile: navigating away during pending reads is not overwritten by the stale deactivate render');
    assert.strictEqual(m.unsubOnClose, true, 'mobile: close unsubscribes the account + cash listeners');
    assert.strictEqual(m.resubOnOpen, true, 'mobile: reopen re-subscribes cleanly');
    ok(`mobile panel: open/grandfathered-name/link-persist/failure-toast/suspend-confirm/nav-safe/cleanup (${m.openRows} rows)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\ndispatch-driver-admin-panel: OK (${n} checks)`);
})().catch((e) => { console.error('\n✗ FAIL:', e && (e.stack || e.message)); process.exit(1); });
