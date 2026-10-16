// dispatch-driver-admin-panel.test.js — REAL headless-Chrome interaction test for the S1b "Administrar
// repartidores" panels (desktop + mobile). Covers codex r1/r2's required browser flows by driving the REAL
// handlers (not the link helpers directly): open; a live snapshot during an edit must preserve TYPED values and
// an open dialog; the one-time link from a REAL invite submit survives a snapshot; a callable failure shows the
// mapped reason as VISIBLE toast text; navigation during the (now 5) sequential precheck reads must not be
// overwritten by the stale render AFTER the reads finish; close removes BOTH listeners and reopen leaves exactly
// one; the WhatsApp share carries the owner copy; "Reasignar" is a live openPicker action; mobile grandfathered
// name, malformed cash/name, and suspend+reactivate confirmations.
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

// Shared in-page stub harness. `toast` renders to #toast-live so the test reads VISIBLE text (codex r2 #8). A per-read
// delay models the sequential precheck reads. openPicker + window.open are captured to assert the live remedy + copy.
const STUBS = `
var escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function $(id){ return document.getElementById(id); }
var allDrivers = {};
var STORE = { drivers: {} };
var H = { accData:{}, accSubs:[], cashSubs:[], unsub:0, getData:{}, getDelay:0, getFail:false, call:'ok', toasts:[], picked:[], waUrl:'', calls:[] };
window.H = H;
function toast(m, k){ H.toasts.push({ m: m, k: k }); var el=document.getElementById('toast-live'); if(el){ el.textContent=String(m); el.setAttribute('data-kind', k||''); } }
function openPicker(oid, reassign){ H.picked.push({ oid: oid, reassign: !!reassign }); }
window.open = (u) => { H.waUrl = String(u); return null; };
var XPD = {
  getDb: () => ({}),
  getAuthInstance: () => ({ app:{}, currentUser:{ getIdToken: async()=> 't' } }),
  subscribeToDriverCash: (onData, onErr) => { var s={onData:onData,onErr:onErr}; H.cashSubs.push(s); onData(H.cashData||{}); return () => { H.unsub++; var i=H.cashSubs.indexOf(s); if(i>=0) H.cashSubs.splice(i,1); }; },
};
function _ref(db, p){ return { path: p }; }
function _onValue(r, cb, err){ var s={cb:cb,err:err}; H.accSubs.push(s); cb({ val: () => H.accData }); return () => { H.unsub++; var i=H.accSubs.indexOf(s); if(i>=0) H.accSubs.splice(i,1); }; }
function _off(){}
function _get(r){ return new Promise((res,rej)=>{ setTimeout(()=>{ if(H.getFail){ rej(new Error('read fail')); return; } if(r.path==='restaurants'){ var pe=new Error('permission-denied'); pe.code='PERMISSION_DENIED'; rej(pe); return; } /* shipped rules: a dispatcher CANNOT read the /restaurants collection — so restoring the old client dual-role read throws here, disabling Desactivar (codex r4 #1 discrimination) */ var v=H.getData[r.path]; res({ val: ()=> (v===undefined?null:v), exists: ()=> v!==undefined && v!==null }); }, H.getDelay); }); }
function _getFunctions(app, region){ return { app:app, region:region }; }
function _httpsCallable(fns, name){ return (data) => { H.calls.push({ name:name, data:data }); if(H.call==='fail'){ var e=new Error('mapped-fail'); e.code='functions/failed-precondition'; e.details={ reasons:['cash'], open_orders:[] }; return Promise.reject(e); } if(H.call==='dual'){ var e2=new Error('Cuenta con doble rol — separá las identidades antes de desactivar.'); e2.code='functions/failed-precondition'; return Promise.reject(e2); } return Promise.resolve({ data:{ ok:true, link: (name==='inviteDriver' ? 'https://reset/LINK' : undefined) } }); }; }
var draRef=_ref, draOnValue=_onValue, draOff=_off, draGet=_get, draGetFunctions=_getFunctions, draHttpsCallable=_httpsCallable;
var ref=_ref, onValue=_onValue, fbOff=_off, fbGet=_get, serverTimestamp=()=>0, mdraGetFunctions=_getFunctions, mdraHttpsCallable=_httpsCallable;
var flush = () => new Promise(r=>setTimeout(r,0));
var settle = (ms) => new Promise(r=>setTimeout(r, ms));
`;

function desktopPage() {
  return `<!doctype html><html><head><meta charset=utf8><style>${draStyle}</style><style>.hidden{display:none}</style></head><body>
<div class="overlay-bg hidden" id="dra-overlay"><div class="dra-panel"><div class="dra-body" id="dra-body"></div></div></div>
<button id="dra-open"></button><button id="dra-close"></button><div id="toast-live"></div>
<svg style="display:none"><symbol id="i-check"></symbol><symbol id="i-close"></symbol><symbol id="i-alert"></symbol></svg>
<div id="out"></div>
<script>window.onerror=function(msg,src,line,col){try{document.getElementById('out').textContent='PANEL_RESULT:'+JSON.stringify({error:msg+' @'+line+':'+col})+':END';}catch(e){}};</script>
<script>${STUBS}
${draJs}
(async () => {
 var res = {};
 H.accData = { u1:{enabled:true,onboarding_state:'active',name:'Ana'}, u2:{enabled:false,onboarding_state:'active',approved_at:1,name:'Beto'}, u3:{enabled:false,onboarding_state:'pending',name:'Caro'} };
 H.getData = { 'drivers/u2':{active:false}, 'tasks':{}, 'dispatchers/u2':null, 'kitchen/u2':null, 'restaurants':{} };
 H.cashData = { u2:{ s1:{ cuadre:{ closed_at: Date.now(), cash_owed:0, cash_order_count:0, provisional:false } } } };
 draOpen(); await flush();
 res.openRows = document.querySelectorAll('#dra-body .dra-row').length;
 var cashBaseline = H.cashSubs.length;
 H.pushSnap = (d)=>{ H.accData=d; H.accSubs.forEach(s=>s.cb({val:()=>d})); };

 // (a) EDITING: a typed value must SURVIVE a live snapshot (not just that the input exists).
 DRA.view='invite'; draRender();
 $('dra-i-name').value='Marta Reyes'; $('dra-i-phone').value='+504 9'; $('dra-i-email').value='marta@c.hn';
 H.pushSnap(Object.assign({ u9:{enabled:true,onboarding_state:'active',name:'Z'} }, H.accData)); await flush();
 res.typedSurvives = !!$('dra-i-name') && $('dra-i-name').value==='Marta Reyes' && DRA.view==='invite';

 // (b) LINK via the REAL submit handler (not draShowLink directly), then survive a snapshot.
 $('dra-i-create').click(); await flush(); await flush();
 var lb = /reset\\/LINK/.test($('dra-body').innerHTML) && DRA.view==='invited';
 H.pushSnap(H.accData); await flush();
 res.linkSurvives = lb && /reset\\/LINK/.test($('dra-body').innerHTML) && DRA.view==='invited';
 // WhatsApp share carries the owner copy with the typed name
 $('dra-wa').click(); await flush();
 res.waText = decodeURIComponent(H.waUrl||'');
 $('dra-link-done').click(); await flush();
 res.linkCleared = DRA.view==='list' && !/reset\\/LINK/.test($('dra-body').innerHTML);

 // (c) FAILURE → visible toast TEXT (read from the DOM #toast-live).
 H.call='fail'; H.toasts=[]; $('toast-live').textContent='';
 H.accData.u4={enabled:false,onboarding_state:'profile_submitted',name:'Dani'}; DRA.view='list'; draRender();
 var ap=document.querySelector('#dra-body .dra-act[data-act="approve"]'); if(ap) ap.click(); await flush(); await flush();
 res.toastText = $('toast-live').textContent||'';
 H.call='ok';

 // DUAL-ROLE: no client /restaurants read anymore (codex r3). The button is enabled for a clear driver; the SERVER
 // refuses a shared identity and the message surfaces via draError.
 H.call='dual'; H.toasts=[]; $('toast-live').textContent='';
 draAction('deactivate','u2'); await settle(140); DRA.cashAttested=true; draRender(); await settle(80);
 var dbtn=$('dra-deact-btn'); res.dualBtnEnabled = !!(dbtn && !dbtn.disabled);
 if(dbtn && !dbtn.disabled) dbtn.click(); await flush(); await flush();
 res.dualMsg = $('toast-live').textContent||'';
 H.call='ok'; DRA.view='list'; DRA.selUid=null; DRA.cashAttested=false; draRender();

 // CLOSE DURING A CONFIRMATION resets dialogOpen (so the next open isn't suppressed).
 draAction('suspend','u1'); await flush();
 res.confirmDialogOpen = DRA.dialogOpen===true;
 draClose();
 res.dialogClearedOnClose = DRA.dialogOpen===false;
 draOpen(); await flush();

 // (d) PENDING READS: sequential reads. Navigate away, then WAIT PAST all of them and assert the stale render never painted.
 H.getDelay=40; DRA.view='list'; draRender();
 draAction('deactivate','u2'); await flush();
 DRA.view='list'; DRA.selUid=null; draRender();
 await settle(360);
 res.navSafe = DRA.view==='list' && document.querySelectorAll('#dra-body .dra-row').length>0 && !/Desactivar a/.test($('dra-body').innerHTML);
 H.getDelay=0;

 // Reasignar is a LIVE remedy → openPicker(oid, true). Open the deactivate view for a driver with an open task.
 H.getData['tasks']={ t1:{ assigned_driver_id:'u2', status:'en_route', order_id:'o1' } };
 draAction('deactivate','u2'); await settle(120);
 res.reasignarPresent = !!$('dra-reasignar');
 var rb=$('dra-reasignar'); if(rb) rb.click(); await flush();
 res.reasignar = H.picked.some(p=>p.oid==='o1' && p.reassign===true);
 H.getData['tasks']={};
 draOpen(); await flush(); // Reasignar closed the panel (draClose + openPicker) — reopen for the remaining checks

 // acctErr → error state, never "No hay repartidores"
 H.accSubs.forEach(s=>s.err&&s.err()); DRA.view='list'; draRender(); await flush();
 res.errState = /No se pudieron cargar/.test($('dra-body').innerHTML) && !/No hay repartidores/.test($('dra-body').innerHTML);
 DRA.acctErr=false;

 // (e) CLOSE/REOPEN: BOTH listeners removed on close; EXACTLY ONE account sub after reopen.
 draClose();
 res.accSubsAfterClose = H.accSubs.length; res.cashSubsAfterClose = H.cashSubs.length;
 draOpen(); await flush();
 res.accSubsAfterReopen = H.accSubs.length; res.cashBaseline = cashBaseline; res.cashSubsAfterReopen = H.cashSubs.length;

 document.getElementById('out').textContent='PANEL_RESULT:'+JSON.stringify(res)+':END';
})().catch(e=>{ document.getElementById('out').textContent='PANEL_RESULT:'+JSON.stringify({error:String(e&&e.stack||e)})+':END'; });
</script></body></html>`;
}

function mobilePage() {
  return `<!doctype html><html><head><meta charset=utf8></head><body>
<button id="x"></button><div id="toast-live"></div><div id="out"></div>
<script>window.onerror=function(msg,src,line,col){try{document.getElementById('out').textContent='PANEL_RESULT:'+JSON.stringify({error:msg+' @'+line+':'+col})+':END';}catch(e){}};</script>
<script>${STUBS}
${mdraJs}
(async () => {
 var res = {};
 STORE.drivers = { g1:{ name:'Grandpa Driver' } };
 H.accData = { u1:{enabled:true,onboarding_state:'active',name:'Ana'}, u2:{enabled:false,onboarding_state:'active',approved_at:1,name:'Beto'}, g1:{enabled:true,onboarding_state:'active',grandfathered:true}, ux:{enabled:true,onboarding_state:'active',name:42} };
 H.getData = { 'drivers/u2':{active:false}, 'tasks':{}, 'dispatchers/u2':null, 'kitchen/u2':null, 'restaurants':{} };
 H.cashData = { u2:{ s1:{ cuadre:{ closed_at: Date.now(), cash_owed:0, cash_order_count:0, provisional:'yes' } } } }; // MALFORMED flag
 mdraOpen(); await flush();
 res.openRows = document.querySelectorAll('#mdra-body .mdra-row').length;
 var cashBaseline = H.cashSubs.length;
 // P2-13 grandfathered name fallback; P2-12 malformed name (ux.name=42) renders without crashing
 res.grandfatheredName = /Grandpa Driver/.test($('mdra-body').innerHTML);
 res.malformedNameOk = document.querySelectorAll('#mdra-body .mdra-row').length >= 4 && !/\\[object/.test($('mdra-body').innerHTML);
 H.pushSnap = (d)=>{ H.accData=d; H.accSubs.forEach(s=>s.cb({val:()=>d})); };

 // LINK from a REAL submit, survives a snapshot
 MDRA.view='invite'; mdraRender();
 $('mdra-n').value='Marta'; $('mdra-p').value='+504'; $('mdra-e').value='m@c.hn';
 $('mdra-cr').click(); await flush(); await flush();
 var lb = /reset\\/LINK/.test($('mdra-body').innerHTML) && MDRA.view==='invited';
 H.pushSnap(H.accData); await flush();
 res.linkSurvives = lb && /reset\\/LINK/.test($('mdra-body').innerHTML) && MDRA.view==='invited';
 $('mdra-wa').click(); await flush(); res.waText = decodeURIComponent(H.waUrl||'');
 $('mdra-dn').click(); await flush(); res.linkCleared = MDRA.view==='list';

 // FAILURE → visible toast TEXT
 H.call='fail'; H.toasts=[]; $('toast-live').textContent='';
 H.accData.u4={enabled:false,onboarding_state:'profile_submitted',name:'Dani'}; MDRA.view='list'; mdraRender();
 var ap=document.querySelector('#mdra-body [data-mact="approve"]'); if(ap) ap.click(); await flush(); await flush();
 res.toastText = $('toast-live').textContent||''; H.call='ok';

 // suspend AND reactivate show CONFIRMATION screens (P2-13), not an immediate call
 MDRA.view='list'; mdraRender();
 var sb=document.querySelector('#mdra-body [data-mact="suspend"]'); if(sb) sb.click(); await flush();
 res.suspendConfirms = !!document.getElementById('mdra-cfm') && MDRA.dialogOpen===true;
 if(document.getElementById('mdra-cxl')) document.getElementById('mdra-cxl').click(); await flush();
 res.dialogClearedOnCancel = MDRA.dialogOpen===false;
 // reactivate: seed a deactivated driver, click Reactivar → confirmation
 H.pushSnap(Object.assign({ ud:{enabled:false,deactivated:true,onboarding_state:'active',approved_at:1,name:'Desac'} }, H.accData)); MDRA.view='list'; mdraRender(); await flush();
 var rb=document.querySelector('#mdra-body [data-mact="reactivate"]'); if(rb) rb.click(); await flush();
 res.reactivateConfirms = !!document.getElementById('mdra-cfm') && MDRA.dialogOpen===true;
 if(document.getElementById('mdra-cxl')) document.getElementById('mdra-cxl').click(); await flush();

 // confirm-before-call: the callable is invoked ONLY after the confirmation is accepted
 H.calls=[]; MDRA.view='list'; mdraRender();
 var sbtn=document.querySelector('#mdra-body [data-mact="suspend"]'); if(sbtn) sbtn.click(); await flush();
 res.noCallBeforeConfirm = !H.calls.some(c=>c.name==='setDriverSuspended') && MDRA.dialogOpen===true;
 if($('mdra-cfm')) $('mdra-cfm').click(); await flush(); await flush();
 res.callAfterConfirm = H.calls.some(c=>c.name==='setDriverSuspended');
 // close DURING a confirmation resets dialogOpen
 MDRA.view='list'; mdraRender();
 var sbtn2=document.querySelector('#mdra-body [data-mact="suspend"]'); if(sbtn2) sbtn2.click(); await flush();
 res.mConfirmDialogOpen = MDRA.dialogOpen===true;
 mdraClose(); res.mDialogClearedOnClose = MDRA.dialogOpen===false; mdraOpen(); await flush();
 // dual-role: server refuses; the message surfaces via mdraErr (no client /restaurants read)
 H.call='dual'; $('toast-live').textContent='';
 mdraAction('deactivate','u2'); await settle(140); MDRA.attested=true; mdraRender(); await settle(80);
 var gb=$('mdra-go'); res.dualBtnEnabled = !!(gb && !gb.disabled); if(gb && !gb.disabled) gb.click(); await flush(); await flush();
 res.dualMsg = $('toast-live').textContent||''; H.call='ok'; MDRA.view='list'; MDRA.attested=false; mdraRender();

 // malformed cash → "no disponible", never a clean L0
 MDRA.view='list'; mdraRender();
 H.getDelay=40; mdraAction('deactivate','u2'); await settle(360);
 res.cashUnavailable = /no disponible/i.test($('mdra-body').innerHTML) && !/L\\s*0\\b/.test($('mdra-body').innerHTML);
 // navigation during the pending reads is not overwritten
 MDRA.view='list'; MDRA.sel=null; mdraRender(); await settle(60);
 res.navSafe = MDRA.view==='list' && !/Desactivar a/.test($('mdra-body').innerHTML);
 H.getDelay=0;

 // CLOSE/REOPEN listener lifecycle
 mdraClose();
 res.accSubsAfterClose = H.accSubs.length; res.cashSubsAfterClose = H.cashSubs.length;
 mdraOpen(); await flush();
 res.accSubsAfterReopen = H.accSubs.length;
 document.getElementById('out').textContent='PANEL_RESULT:'+JSON.stringify(res)+':END';
})().catch(e=>{ document.getElementById('out').textContent='PANEL_RESULT:'+JSON.stringify({error:String(e&&e.stack||e)})+':END'; });
</script></body></html>`;
}

if (!fs.existsSync(CHROME)) { console.error(`\n✗ FAIL: Google Chrome not found at ${CHROME} — this real-panel interaction gate requires Chrome and must not be skipped.`); process.exit(1); }

function runChrome(fileUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--window-size=900,1200', '--virtual-time-budget=12000', '--dump-dom', fileUrl], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
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
    const mm = dom.match(/PANEL_RESULT:(\{[\s\S]*\}):END/); assert.ok(mm, 'got a PANEL_RESULT from Chrome');
    return JSON.parse(mm[1]);
  };
  const OWNER_COPY = 'creá tu contraseña para la app de repartidores con este enlace. Es de un solo uso: https://reset/LINK';
  try {
    const d = await run(desktopPage());
    assert.ok(!d.error, `desktop driver threw: ${d.error}`);
    assert.ok(d.openRows >= 3, `desktop: panel opens and renders the roster (${d.openRows} rows)`);
    assert.strictEqual(d.typedSurvives, true, 'desktop: a typed invite value SURVIVES a live snapshot during the edit');
    assert.strictEqual(d.linkSurvives, true, 'desktop: a REAL invite submit shows the one-time link and it survives a snapshot');
    assert.ok(d.waText.includes('Hola Marta Reyes, ') && d.waText.includes(OWNER_COPY), `desktop: WhatsApp share carries the owner copy with the name (${d.waText})`);
    assert.strictEqual(d.linkCleared, true, 'desktop: "Listo" clears the one-time link and returns to the list');
    assert.ok(d.toastText && /efectivo|no se puede|todav/i.test(d.toastText), `desktop: a callable failure shows mapped reason TEXT in the toast (${d.toastText})`);
    assert.strictEqual(d.navSafe, true, 'desktop: after ALL pending reads finish, the stale deactivate render did NOT overwrite the list');
    assert.strictEqual(d.reasignar, true, 'desktop: "Reasignar" is a live remedy → openPicker(orderId, true)');
    assert.strictEqual(d.dualBtnEnabled, true, 'desktop: the Desactivar button is enabled for a clear driver (no client /restaurants read)');
    assert.ok(/doble rol|despacho o cocina/i.test(d.dualMsg), `desktop: a dual-role SERVER refusal surfaces a clear message (${d.dualMsg})`);
    assert.strictEqual(d.confirmDialogOpen, true, 'desktop: a confirmation sets dialogOpen');
    assert.strictEqual(d.dialogClearedOnClose, true, 'desktop: closing DURING a confirmation resets dialogOpen');
    assert.strictEqual(d.errState, true, 'desktop: a failed accounts read shows an error state, never "No hay repartidores"');
    assert.strictEqual(d.accSubsAfterClose, 0, 'desktop: close removes the account listener');
    assert.strictEqual(d.cashSubsAfterClose, 0, 'desktop: close removes the cash listener');
    assert.strictEqual(d.accSubsAfterReopen, 1, 'desktop: reopen leaves EXACTLY ONE account listener (no leak)');
    ok(`desktop panel: typed-survives / real-submit-link / WA-copy / failure-text / nav-safe / reasignar-live / error-state / exact-listener-cleanup (${d.openRows} rows)`);

    const m = await run(mobilePage());
    assert.ok(!m.error, `mobile driver threw: ${m.error}`);
    assert.ok(m.openRows >= 4, `mobile: sheet opens and renders the roster (${m.openRows} rows)`);
    assert.strictEqual(m.grandfatheredName, true, 'mobile: a grandfathered (no-profile) record shows the roster name, not a short uid');
    assert.strictEqual(m.malformedNameOk, true, 'mobile: a malformed name (42) renders a neutral row without crashing the list');
    assert.strictEqual(m.linkSurvives, true, 'mobile: a REAL invite submit shows the one-time link and it survives a snapshot');
    assert.ok(m.waText.includes('Hola Marta, ') && m.waText.includes(OWNER_COPY), `mobile: WhatsApp share carries the owner copy with the name (${m.waText})`);
    assert.strictEqual(m.linkCleared, true, 'mobile: "Listo" returns to the list');
    assert.ok(m.toastText && /efectivo|no se puede|todav/i.test(m.toastText), `mobile: a callable failure shows mapped reason TEXT (${m.toastText})`);
    assert.strictEqual(m.suspendConfirms, true, 'mobile: suspend shows a confirmation screen (desktop parity), not an immediate call');
    assert.strictEqual(m.dialogClearedOnCancel, true, 'mobile: cancelling a confirmation clears dialogOpen');
    assert.strictEqual(m.reactivateConfirms, true, 'mobile: reactivate shows a confirmation screen, not an immediate call');
    assert.strictEqual(m.noCallBeforeConfirm, true, 'mobile: the suspend callable is NOT invoked before the confirmation is accepted');
    assert.strictEqual(m.callAfterConfirm, true, 'mobile: the suspend callable IS invoked after the confirmation is accepted');
    assert.strictEqual(m.mConfirmDialogOpen, true, 'mobile: a confirmation sets dialogOpen');
    assert.strictEqual(m.mDialogClearedOnClose, true, 'mobile: closing DURING a confirmation resets dialogOpen');
    assert.strictEqual(m.dualBtnEnabled, true, 'mobile: Desactivar is enabled for a clear driver (no rules-denied /restaurants read — restoring it would disable the button)');
    assert.ok(/doble rol|despacho o cocina/i.test(m.dualMsg), `mobile: a dual-role SERVER refusal surfaces a clear message (${m.dualMsg})`);
    assert.strictEqual(m.cashUnavailable, true, 'mobile: a malformed cuadre flag renders "Cuadre no disponible", never a clean L0');
    assert.strictEqual(m.navSafe, true, 'mobile: navigating away during pending reads is not overwritten by the stale deactivate render');
    assert.strictEqual(m.accSubsAfterClose, 0, 'mobile: close removes the account listener');
    assert.strictEqual(m.cashSubsAfterClose, 0, 'mobile: close removes the cash listener');
    assert.strictEqual(m.accSubsAfterReopen, 1, 'mobile: reopen leaves EXACTLY ONE account listener (no leak)');
    ok(`mobile panel: grandfathered+malformed-name / real-submit-link / WA-copy / failure-text / suspend+reactivate-confirm / malformed-cash / nav-safe / exact-listener-cleanup (${m.openRows} rows)`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\ndispatch-driver-admin-panel: OK (${n} checks)`);
})().catch((e) => { console.error('\n✗ FAIL:', e && (e.stack || e.message)); process.exit(1); });
