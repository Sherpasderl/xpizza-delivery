// H1b T7 — the view controller. DOM + wiring only: every decision lives in the tested modules (model, clock, offline-queue,
// undo, api, feeds, eta, setup, bridge). The screens are the prototype's own markup (index.html <template>), rendered by tmpl.js
// from vm(), a port of the prototype's renderVals onto the real state.
import { compile } from './tmpl.js';
import * as M from './model.js';
import { makeClock, makeTimer } from './clock.js';
import { createQueue, browserStorage } from './offline-queue.js';
import { createUndo } from './undo.js';
import { createApi, rejectToast } from './api.js';
import { startFeeds } from './feeds.js';
import { createEta, googleRoute } from './eta.js';
import { startPairing, createSessionStore, hashPin, createPinGate, signOut } from './setup.js';
import { createBridge, webAudioSound, NATIVE_PLUGIN } from './bridge.js';
import { COPY, BOARD } from './copy.js';
import { buildVM, WA_TEXT } from './view.js';
import { FIREBASE_CONFIG, FUNCTIONS_REGION, MAPS_KEY } from './config.js';
import { initializeApp } from './vendor/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signInWithCustomToken, signOut as fbSignOut, onAuthStateChanged } from './vendor/firebase-auth.js';
import { getDatabase, ref, query, orderByChild, equalTo, onChildAdded, onChildChanged, onChildRemoved, onValue, get } from './vendor/firebase-database.js';
import { getFunctions, httpsCallable } from './vendor/firebase-functions.js';

const MIN = 60000;

// ── platform ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const fb = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fb);
const rdb = getDatabase(fb);
const fns = getFunctions(fb, FUNCTIONS_REGION);
const call = async (name, data) => (await httpsCallable(fns, name)(data)).data;
const storage = browserStorage(window.localStorage);
const store = createSessionStore(storage);
const pinGate = createPinGate({ storage });
const sound = webAudioSound(window);
const cap = window.Capacitor;
const bridge = createBridge({ isNative: () => !!(cap && cap.isNativePlatform && cap.isNativePlatform()), plugin: cap && cap.Plugins ? cap.Plugins[NATIVE_PLUGIN] || null : null,
  sound, doc: document, wakeLock: navigator.wakeLock || null });
const clock = makeClock();
const rtdb = {
  onQuery(path, child, value, h) {
    const q = query(ref(rdb, path), orderByChild(child), equalTo(value));
    let first = true;
    const offs = [
      onChildAdded(q, (s) => h.added(s.key, s.val()), h.error),
      onChildChanged(q, (s) => h.changed(s.key, s.val()), h.error),
      onChildRemoved(q, (s) => h.removed(s.key), h.error),
    ];
    get(q).then(() => { if (first) { first = false; h.loaded(); } }, h.error);
    return () => offs.forEach((u) => u());
  },
  onValue: (path, cb, err) => onValue(ref(rdb, path), (s) => cb(s.val()), err),
};

// ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const S = {
  phase: 'boot', loginErr: '', working: false, pairing: null, sel: null, pairErr: '', status: null,
  pinEntry: '', pinFirst: null, pinErr: '',
  view: 'list', tab: 'n', sheet: null, cur: null,
  feed: { orders: {}, loaded: false, control: null, brand: null, menu: null, availability: null, offset: null, connected: false, sessionLost: false },
  opened: {}, driver: {}, eta: {}, delta: 0, reason: null, gone: {}, moreSel: 5, busyAdd: 15, busyDur: 60, pauseDur: 30, pauseReason: 'Cocina llena',
  waSel: 'agotado', toast: null, entered: null, rejecting: {},
};
let sess = null;                                      // {uid, rid, brand_id, location_name, prep_default_min}
const gen = { n: 1 };
const session = { current: () => ({ uid: sess && sess.uid, rid: sess && sess.rid, gen: gen.n }), bump: () => { gen.n++; } };
let queue = null; let undo = null; let api = null; let feeds = null; let eta = null; let wasOnline = false;

// ── render ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const root = document.getElementById('app');
const tpl = compile(document.getElementById('screen').innerHTML);
let acts = {}; let queued = false;
function render() {
  if (queued) return; queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const keep = {}; for (const el of root.querySelectorAll('input[id]')) keep[el.id] = el.value;
    const focus = document.activeElement && document.activeElement.id;
    const r = tpl.render(vm());
    root.innerHTML = r.html; acts = r.acts;
    for (const [id, v] of Object.entries(keep)) { const el = document.getElementById(id); if (el) el.value = v; }
    if (focus) { const el = document.getElementById(focus); if (el) el.focus(); }
  });
}
root.addEventListener('click', (e) => { const t = e.target.closest('[data-act]'); if (t && acts[t.dataset.act]) { sound.unlock(); acts[t.dataset.act](); } });
const set = (patch) => { Object.assign(S, patch); render(); };
let toastTimer = null;
function toast(msg, undoId = null) {
  clearTimeout(toastTimer);
  set({ toast: { msg, undo: undoId } });
  toastTimer = setTimeout(() => set({ toast: null }), 5000);
}
const flash = (id) => { set({ entered: id }); setTimeout(() => set({ entered: null }), 400); };

// ── helpers over the tested modules ───────────────────────────────────────────────────────────────────────────────────────────
const online = () => S.feed.connected === true;
const now = () => clock.now();
function viewOrders() {
  const undoReadies = Object.keys(S.feed.orders).map((id) => { const p = undo && undo.pending(id); return p ? { order_id: id, at: undoAt[id] } : null; }).filter(Boolean);
  return M.applyPending(S.feed.orders, queue ? queue.items() : [], undoReadies);
}
const undoAt = {};
function base() {
  const b = sess && Number.isInteger(sess.prep_default_min) ? sess.prep_default_min : null;
  return b === null ? null : b + M.effectiveBusy(S.feed.control && S.feed.control.busy, now());
}
function refreshDriver(oid) {
  if (!api) return;
  api.orderState(oid).then((st) => {
    if (st && Number.isInteger(st.prep_default_min)) sess.prep_default_min = store.refreshBase(st.prep_default_min);
    S.driver[oid] = st; render();
  });
}
function watchEta(oid) {
  if (!eta || !MAPS_KEY) return () => {};
  return eta.watch(oid, () => api.orderState(oid), (ms) => { S.eta[oid] = ms; render(); });
}
let stopEta = () => {};
const driverOf = (oid) => M.driverInfo(S.driver[oid], S.eta[oid]);

// ── the live context for view.js ──
function vm() {
  return buildVM(S, {
    now: now(), online: online(), orders: viewOrders(), base: base(), sess, driverOf, set,
    act: { doLogin, doPair, refreshStatus, pinPress, doSignOut, control, openOrder, handed, doReject, doMore, openWhatsApp, undoReady, doAccept, doReady, phoneOf,
      testAlert: () => { sound.unlock(); bridge.alarm.start(['__prueba__']); setTimeout(() => bridge.alarm.stop(), 2500); toast('Sonando la alerta de prueba a todo volumen…'); } },
  });
}

// ── actions ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function openOrder(id) {
  bridge.alarm.ack();
  const o = S.feed.orders[id];
  if (o && o.status === 'new') S.opened[id] = performance.now();
  stopEta(); stopEta = watchEta(id);
  refreshDriver(id);
  set({ cur: id, view: 'detail', sheet: null, delta: 0, tab: o && o.status === 'new' ? 'n' : S.tab });
}
function persistFailed(r) { if (!r.ok) { toast(COPY.saveFailed); return true; } return false; }
function doAccept(cur, b) {
  if (b === null) return;
  const c = M.chips(b).find((x) => x.delta === S.delta) || M.chips(b)[1];
  if (persistFailed(api.act('accept', cur.id, { prep_min: c.value }))) return;
  stopEta(); flash(cur.id); set({ view: 'list', tab: 'p', cur: null, delta: 0 });
}
function doReady(cur) {
  undoAt[cur.id] = now() || Date.now();
  undo.startReady(cur.id);
  stopEta(); flash(cur.id); set({ view: 'list', tab: 'l', cur: null });
  toast(online() ? `#${M.orderView(cur).num} marcado listo` : `#${M.orderView(cur).num} guardado como listo · se envía al volver`, cur.id);
}
function undoReady() {
  const id = S.toast && S.toast.undo; if (!id) return;
  clearTimeout(toastTimer); undo.cancel(id); delete undoAt[id];
  set({ toast: null, view: 'detail', cur: id, tab: 'p' });
}
function doMore() {
  const cur = S.cur && S.feed.orders[S.cur]; if (!cur) return;
  if (persistFailed(api.act('more', cur.id, { add_min: S.moreSel }))) return;
  set({ sheet: null });
}
async function handed(id) { await act('merchantHanded', { oid: id }); }
async function act(name, data) {
  const r = await api.direct(name, data);
  if (r.class === 'offline') toast(COPY.offlineControl);
  else if (r.class === 'auth') doSignOut('session_lost');
  else if (r.class !== 'ok') toast(BOARD.orderChanged);
  return r;
}
const control = (name, data) => act(name, data);
async function doReject(goneNames) {
  const cur = S.cur && S.feed.orders[S.cur];
  if (!cur || !S.reason || S.rejecting[cur.id]) return;
  if (S.reason === 'agotado' && !goneNames.length) return;
  if (!online()) { toast(COPY.offlineReject); return; }
  const noteEl = document.getElementById('rejnote');
  const note = S.reason === 'otro' && noteEl && noteEl.value.trim() ? noteEl.value.trim().slice(0, 200) : null;
  const reason = S.reason; const next = reason === 'saturada' ? 'busy' : (reason === 'cerrando' ? 'pause' : null);
  S.rejecting[cur.id] = true;
  stopEta(); set({ sheet: null, view: 'list', tab: 'n', cur: null, reason: null, gone: {} });
  const r = await api.reject(cur.id, { reason, note, gone_items: goneNames }, { onResolved: (st) => { const m = rejectToast(cur, st); if (m) toast(m); } });
  delete S.rejecting[cur.id];
  if (r.class === 'auth') { doSignOut('session_lost'); return; }
  if (r.class !== 'ok') { toast(BOARD.orderChanged); render(); return; }
  const m = rejectToast(cur, r.state); if (m) toast(m);
  for (const n of goneNames) {                         // the prototype marks the gone items agotado at this location
    const it = (Array.isArray(S.feed.menu) ? S.feed.menu : []).find((x) => x && String(x.label) === n);
    if (it) act('merchantSetAvailability', { item_key_raw: String(it.key), available: false });
  }
  set({ sheet: next });
}
function phoneOf(o) { const d = String((o && o.customer_phone) || '').replace(/\D/g, ''); return d.length === 8 ? `504${d}` : (d.length >= 10 ? d : ''); }
function openWhatsApp(cur, v, brandName) {
  const p = phoneOf(cur); if (!p || !v) return;
  const text = `Hola ${v.cust.split(' ')[0]}, te escribimos de ${brandName} por tu pedido #${v.num}. ${WA_TEXT[S.waSel]}`;
  window.open(`https://wa.me/${p}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  set({ sheet: null }); toast('Abriendo WhatsApp con el mensaje listo…');
}

// ── setup flow ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function doLogin() {
  if (S.working) return;
  const email = (document.getElementById('em') || {}).value || ''; const password = (document.getElementById('pw') || {}).value || '';
  set({ working: true, loginErr: '' });
  try {
    const p = await startPairing({ auth: authPort, call, store }, { email: email.trim(), password });
    set({ phase: 'branch', pairing: p, sel: p.selected || (p.rows.length === 1 ? p.rows[0] : null), pairErr: '', working: false });
  } catch (_) { set({ loginErr: BOARD.loginWrong, working: false }); }
}
const authPort = {
  signInHuman: (e, p) => signInWithEmailAndPassword(auth, e, p),
  signOut: () => fbSignOut(auth),
  signInWithToken: async (tk) => (await signInWithCustomToken(auth, tk)).user,
};
async function doPair() {
  if (S.working || !S.sel || !S.pairing) return;
  set({ working: true, pairErr: '' });
  const r = await S.pairing.pair(S.sel, 'Equipo de la sucursal');
  if (!r.ok) { set({ working: false, pairErr: COPY.pairRefused }); return; }
  sess = r.session; await refreshStatus(); set({ working: false, phase: 'checks' });
}
async function refreshStatus() { set({ status: await bridge.status() }); }
async function pinPress(k) {
  const e = S.pinEntry + k;
  if (e.length < 4) { set({ pinEntry: e, pinErr: '' }); return; }
  if (S.phase === 'pin') {
    if (!S.pinFirst) { set({ pinFirst: e, pinEntry: '' }); return; }
    if (S.pinFirst !== e) { set({ pinFirst: null, pinEntry: '', pinErr: COPY.pinMismatch }); return; }
    try { pinGate.setRecord(await hashPin(e)); } catch (_) { set({ pinEntry: '', pinErr: COPY.saveFailed }); return; }
    set({ pinEntry: '', pinFirst: null }); startMain(); return;
  }
  const r = await pinGate.try(e);
  if (r.ok) set({ pinEntry: '', pinErr: '', view: 'settings' });
  else set({ pinEntry: '', pinErr: r.locked ? COPY.pinLocked : 'PIN incorrecto. Probá de nuevo.' });
}
async function doSignOut(reason) {
  await signOut({ session, feeds, queue, undoStop: () => {}, eta, bridge, auth: authPort, store }, reason);
  pinGate.clear();
  feeds = null; queue = null; undo = null; api = null; sess = null;
  S.feed = { orders: {}, loaded: false, control: null, brand: null, menu: null, availability: null, offset: null, connected: false, sessionLost: false };
  bridge.keepAwake(false);
  set({ phase: 'login', view: 'list', sheet: null, cur: null, pairing: null, sel: null, loginErr: '', pairErr: '', opened: {}, driver: {}, eta: {}, toast: null });
}

// ── main (paired) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function startMain() {
  queue = createQueue({ storage, partition: { uid: sess.uid, rid: sess.rid }, session });
  undo = createUndo({ queue, session, makeTimer: () => makeTimer() });
  api = createApi({ call, queue, isOnline: online, rid: sess.rid });
  eta = createEta({ route: googleRoute(window.google) });
  queue.onDrop(() => toast(BOARD.orderChanged));
  undo.onDropped((d) => toast(d.reason === 'storage' ? COPY.saveFailed : BOARD.orderChanged));
  feeds = startFeeds({ rtdb, rid: sess.rid, brandId: sess.brand_id, onState: onFeed });
  bridge.keepAwake(true);
  set({ phase: 'main', view: 'list', tab: 'n' });
}
function onFeed(st) {
  if (st.sessionLost) { doSignOut('session_lost'); return; }
  clock.setOffset(st.offset);
  const cameOnline = st.connected && !wasOnline; wasOnline = st.connected;
  S.feed = st;
  for (const id of Object.keys(S.opened)) { const o = st.orders[id]; if (!o || o.status !== 'new' || o.handheld_answered) delete S.opened[id]; }
  if (cameOnline && queue && queue.items().length) {
    const n = queue.items().length;
    api.flush().then((r) => { if (r && r.sent) toast(COPY.reconnected(r.sent)); else void n; });
  }
  ringSync();
  render();
}
let lastRing = '';
function ringSync() {
  if (S.phase !== 'main') return;
  const ids = M.alarmSet(S.feed.orders).filter((id) => !S.opened[id]);
  const key = ids.join(',');
  if (key === lastRing) return;
  lastRing = key;
  if (ids.length) bridge.alarm.start(ids); else bridge.alarm.stop();
}

// the 1 s heartbeat: countdowns, the undo window, the re-ring of an order opened 1 min without a decision (prototype)
setInterval(() => {
  if (S.phase !== 'main') return;
  undo && undo.tick();
  if (online() && queue && queue.items().length) api.flush();
  const p = performance.now(); let reRing = false;
  for (const [id, at] of Object.entries(S.opened)) if (p - at >= MIN && S.cur !== id) { delete S.opened[id]; reRing = true; }
  if (reRing) { lastRing = ''; bridge.alarm.stop(); ringSync(); }
  render();
}, 1000);
setInterval(() => { if (S.phase === 'main' && api && online()) api.direct('merchantHeartbeat', {}); }, 60000);
bridge.onResume(() => { undo && undo.onResume(); if (online() && api) api.flush(); render(); });

// ── boot ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A paired device (session + PIN) opens straight onto the list — also offline at a cold start (the banner shows until the feed's
// first snapshot). An invalid identity is caught where it already is: online, the feed's permission error → sessionLost →
// re-pair; an Auth user that is a DIFFERENT uid signs out at once. A device paired but without a PIN resumes at the checks.
const saved = store.load();
if (saved && pinGate.record()) { sess = saved; startMain(); }
const unsub = onAuthStateChanged(auth, (u) => {
  unsub();
  if (saved && u && u.uid !== saved.uid) { doSignOut('session_lost'); return; }
  if (S.phase === 'main') return;
  if (saved && u && u.uid === saved.uid) { sess = saved; refreshStatus().then(() => set({ phase: 'checks' })); return; }
  set({ phase: 'login' });
});
render();
