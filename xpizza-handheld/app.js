// H1b T7 — the view controller. DOM + wiring only: every decision lives in the tested modules (model, clock, offline-queue,
// undo, api, feeds, eta, setup, bridge). The screens are the prototype's own markup (index.html <template>), rendered by tmpl.js
// from vm(), a port of the prototype's renderVals onto the real state.
import { compile } from './tmpl.js';
import { morph } from './morph.js';
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
import { getAuth, initializeAuth, inMemoryPersistence, signInWithEmailAndPassword, signInWithCustomToken, signOut as fbSignOut, onAuthStateChanged } from './vendor/firebase-auth.js';
import { getDatabase, ref, query, orderByChild, equalTo, onChildAdded, onChildChanged, onChildRemoved, onValue, get } from './vendor/firebase-database.js';
import { getFunctions, httpsCallable } from './vendor/firebase-functions.js';

const MIN = 60000;

// ── platform ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The DEVICE identity lives on the default app (persistent: it must survive restarts). The owner/manager who pairs the device signs in
// on a SEPARATE app with in-memory persistence (codex H1b r1 P1-2): a human refresh token is never written to the shared handheld.
const fb = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fb);
const rdb = getDatabase(fb);
const fns = getFunctions(fb, FUNCTIONS_REGION);
const call = async (name, data) => (await httpsCallable(fns, name)(data)).data;
const humanApp = initializeApp(FIREBASE_CONFIG, 'human-pairing');
const humanAuth = initializeAuth(humanApp, { persistence: inMemoryPersistence });
const humanFns = getFunctions(humanApp, FUNCTIONS_REGION);
const humanCall = async (name, data) => (await httpsCallable(humanFns, name)(data)).data;
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
const live = (g) => g === gen.n;                      // codex H1b r1 P1-1: a continuation started under another session touches nothing
const session = { current: () => ({ uid: sess && sess.uid, rid: sess && sess.rid, gen: gen.n }), bump: () => { gen.n++; } };
let queue = null; let undo = null; let api = null; let feeds = null; let eta = null; let wasOnline = false;

// ── render ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const root = document.getElementById('app');
const tpl = compile(document.getElementById('screen').innerHTML);
// codex H1b r1 P2-10: the screen is PATCHED (morph.js), and an unchanged render touches nothing — scroll, focus, typing and running
// animations survive the 1 s heartbeat. The act ids are positional, so identical markup keeps a valid registry.
let acts = {}; let queued = false; let lastHtml = null;
function render() {
  if (queued) return; queued = true;
  requestAnimationFrame(() => {
    queued = false;
    const r = tpl.render(vm());
    acts = r.acts;
    if (r.html !== lastHtml) { morph(root, r.html); lastHtml = r.html; }
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
function keepDriver(oid, st, g) {
  if (!live(g) || !st) return;
  if (Number.isInteger(st.prep_default_min) && sess) sess.prep_default_min = store.refreshBase(st.prep_default_min);
  S.driver[oid] = st;
}
function refreshDriver(oid) {
  if (!api) return;
  const g = gen.n;
  api.orderState(oid).then((st) => { keepDriver(oid, st, g); render(); });
}
function watchEta(oid) {
  if (!eta || !MAPS_KEY) return () => {};
  const g = gen.n;
  return eta.watch(oid, async () => { const st = api ? await api.orderState(oid) : null; keepDriver(oid, st, g); return st; },
    (ms) => { if (live(g)) { S.eta[oid] = ms; render(); } });
}
let stopEta = () => {};
const driverOf = (oid) => M.driverInfo(S.driver[oid], S.eta[oid]);

// ── the live context for view.js ──
function vm() {
  return buildVM(S, {
    now: now(), online: online(), orders: viewOrders(), base: base(), sess, driverOf, set,
    act: { doLogin, doPair, refreshStatus, pinPress, doSignOut, control, openOrder, handed, doReject, doMore, openWhatsApp, undoReady, doAccept, doReady,
      stopEta: () => stopEta(), checksContinue,
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
  if (!api) return null;
  const g = gen.n;
  const r = await api.direct(name, data);             // auth loss is reported by the api itself (onAuthLost → teardown)
  if (!live(g) || r.class === 'stopped' || r.class === 'auth') return r;
  if (r.class === 'offline') toast(COPY.offlineControl);
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
  const g = gen.n; const menu = Array.isArray(S.feed.menu) ? S.feed.menu : [];   // THIS location's menu, captured before the await
  stopEta(); set({ sheet: null, view: 'list', tab: 'n', cur: null, reason: null, gone: {} });
  const r = await api.reject(cur.id, { reason, note, gone_items: goneNames }, { onResolved: (st) => { if (!live(g)) return; const m = rejectToast(cur, st); if (m) toast(m); } });
  if (!live(g) || r.class === 'stopped' || r.class === 'auth') return;   // codex H1b r1 P1-1: never touches a newly paired location
  delete S.rejecting[cur.id];
  if (r.class !== 'ok') { toast(BOARD.orderChanged); render(); return; }
  const m = rejectToast(cur, r.state); if (m) toast(m);
  for (const n of goneNames) {                         // the prototype marks the gone items agotado at this location
    const it = menu.find((x) => x && String(x.label) === n);
    if (it) act('merchantSetAvailability', { item_key_raw: String(it.key), available: false });
  }
  set({ sheet: next });
}
function openWhatsApp(cur, v, brandName) {
  const p = M.phoneOf(cur); if (!p || !v) return;
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
    const p = await startPairing({ auth: pairingAuth, call: humanCall, store }, { email: email.trim(), password });
    set({ phase: 'branch', pairing: p, sel: p.selected || (p.rows.length === 1 ? p.rows[0] : null), pairErr: '', working: false });
  } catch (_) { set({ loginErr: BOARD.loginWrong, working: false }); }
}
// pairing: the human signs in on the in-memory app and is signed out BEFORE the device identity signs in on the default app
const pairingAuth = {
  signInHuman: (e, p) => signInWithEmailAndPassword(humanAuth, e, p),
  signOut: () => fbSignOut(humanAuth),
  signInWithToken: async (tk) => (await signInWithCustomToken(auth, tk)).user,
};
// logout: the device identity (and any lingering human session)
const deviceAuth = { signOut: async () => { await fbSignOut(auth); try { await fbSignOut(humanAuth); } catch (_) { /* none */ } } };
async function doPair() {
  if (S.working || !S.sel || !S.pairing) return;
  set({ working: true, pairErr: '' });
  const r = await S.pairing.pair(S.sel, 'Equipo de la sucursal');
  // codex H1b r1 P2-9: a failed token exchange happens AFTER the human was signed out — back to the login, never a dead picker
  if (!r.ok && r.error === 'token_exchange') { set({ working: false, phase: 'login', pairing: null, sel: null, loginErr: COPY.pairRefused }); return; }
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
// checks → «Continuar»: a device already paired with a PIN goes back to its list; a new one creates the PIN (A4)
function checksContinue() { if (sess && pinGate.record()) startMain(); else set({ phase: 'pin', pinEntry: '', pinFirst: null, pinErr: '' }); }
let signingOut = false;
// codex H1b r1 P1-3: EVERY auth-loss signal lands here (the feed's sessionLost, the api's onAuthLost for queue / direct / heartbeat /
// reject / orderState, the Auth observer). Re-entrant calls are ignored; api.stop() voids every late continuation first.
async function doSignOut(reason) {
  if (signingOut) return;
  signingOut = true;
  try {
    if (api) api.stop();
    stopEta(); stopEta = () => {};
    await signOut({ session, feeds, queue, undoStop: () => {}, eta, bridge, auth: deviceAuth, store }, reason);
  } finally { signingOut = false; }
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
  api = createApi({ call, queue, isOnline: online, rid: sess.rid, onAuthLost: () => doSignOut('session_lost') });
  loadMaps();
  eta = createEta({ route: googleRoute(() => window.google) });   // the Maps global is read at route time (loaded lazily)
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
setInterval(() => {
  if (S.phase !== 'main' || !api || !online()) return;
  api.direct('merchantHeartbeat', {});                // an auth result reaches onAuthLost inside the api
  // codex H1b r1 P2-8: driver identity / presence for the visible delivery orders, independent of Maps
  const q = M.queues(S.feed.orders);
  for (const o of [...q.prep, ...q.listos]) if (o.order_type !== 'pickup') refreshDriver(o.id);
}, 60000);
// codex H1b r1 P2-7: the Maps JS API loads only when a key is configured; eta.js reads the global lazily, so routing starts once loaded
let mapsRequested = false;
function loadMaps() {
  if (!MAPS_KEY || mapsRequested || (window.google && window.google.maps)) return;
  mapsRequested = true;
  const s = document.createElement('script');
  s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(MAPS_KEY)}&v=weekly`;
  s.async = true;
  s.onerror = () => { mapsRequested = false; };      // retried at the next session start; until then the name only
  document.head.appendChild(s);
}
bridge.onResume(() => { undo && undo.onResume(); if (online() && api) api.flush(); render(); });

// ── boot ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A paired device (session + PIN) opens straight onto the list — also offline at a cold start (the banner shows until the feed's
// first snapshot). An invalid identity is caught where it already is: online, the feed's permission error → sessionLost →
// re-pair; an Auth user that is a DIFFERENT uid signs out at once. A device paired but without a PIN resumes at the checks.
// codex H1b r1 P1-4: the native-missing guard runs on EVERY boot — a persisted pairing inside a native shell whose plugin is missing
// (or whose checks fail) opens the checks screen, never a silent list. The browser stub is never blocked.
// codex H1b r1 P1-3: the Auth observer stays subscribed: once the device user has been seen, losing it (or a different uid) tears the
// session down. A null at a cold start (never seen — e.g. offline before Auth restores) is left to the feed's permission signal.
const saved = store.load();
let bootDecided = false; let seenDevice = false;
if (saved && pinGate.record()) {
  bridge.status().then((st) => {
    bootDecided = true; sess = saved;
    if (st.native && st.blocked) set({ status: st, phase: 'checks' }); else { S.status = st; startMain(); }
  });
}
onAuthStateChanged(auth, (u) => {
  if (u && sess && u.uid === sess.uid) seenDevice = true;
  if (sess && u && u.uid !== sess.uid) { doSignOut('session_lost'); return; }
  if (sess && !u && seenDevice) { doSignOut('session_lost'); return; }
  if (S.phase !== 'boot' || bootDecided) return;
  if (saved && u && u.uid === saved.uid) { bootDecided = true; sess = saved; refreshStatus().then(() => set({ phase: 'checks' })); return; }
  if (!(saved && pinGate.record())) { bootDecided = true; set({ phase: 'login' }); }
});
render();
