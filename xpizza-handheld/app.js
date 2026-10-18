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
import { FIREBASE_CONFIG, FUNCTIONS_REGION, MAPS_KEY } from './config.js';
import { initializeApp } from './vendor/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signInWithCustomToken, signOut as fbSignOut, onAuthStateChanged } from './vendor/firebase-auth.js';
import { getDatabase, ref, query, orderByChild, equalTo, onChildAdded, onChildChanged, onChildRemoved, onValue, get } from './vendor/firebase-database.js';
import { getFunctions, httpsCallable } from './vendor/firebase-functions.js';

const MIN = 60000;
const REASONS = [['agotado', 'Se acabó un producto'], ['saturada', 'Cocina saturada'], ['cerrando', 'Estamos por cerrar'], ['otro', 'Otro motivo']];
const WA = [['agotado', 'Se acabó un producto'], ['pregunta', 'Tenemos una pregunta'], ['propio', 'Escribir mi propio mensaje']];
const WA_TEXT = { agotado: 'Se nos acabó un producto: ¿te lo podemos cambiar por otro?', pregunta: 'Tenemos una pregunta sobre tu pedido.', propio: '' };

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

// ── the view model (the prototype's renderVals, on real data) ─────────────────────────────────────────────────────────────────
function vm() {
  const t = now();
  const off = !online();
  const ctl = S.feed.control;
  const pill = M.pill({ offline: off, control: ctl, nowMs: t });
  const busyOn = pill.mode === 'busy'; const pausedOn = pill.mode === 'paused';
  const orders = viewOrders();
  const q = M.queues(orders);
  const unopened = q.nuevos.filter((o) => !o.handheld_answered && !S.opened[o.id]);
  const main = S.phase === 'main';
  const alertOrder = main && S.view !== 'detail' ? unopened[0] || null : null;
  const cur = S.cur ? orders[S.cur] || null : null;
  const b = base();
  const chips = b === null ? [] : M.chips(b);
  const chosen = chips.find((c) => c.delta === S.delta) || chips[1];
  const brandName = (S.feed.brand && typeof S.feed.brand.name === 'string' && S.feed.brand.name) || '';
  const loc = (sess && sess.location_name) || '';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k) => (k === '' ? { blank: true, real: false }
    : k === 'del' ? { blank: false, real: true, label: 'Borrar', size: '16px', press: () => set({ pinEntry: S.pinEntry.slice(0, -1) }) }
      : { blank: false, real: true, label: k, size: '22px', press: () => pinPress(k) }));
  const isKeypad = S.phase === 'pin' || (main && S.view === 'pinPrompt');
  const st = S.status || {};
  const d = cur ? detail(cur, t, off, b) : { items: [] };
  const goneNames = cur ? M.orderView(cur).items.map((i) => i.name).filter((n) => S.gone[n]) : [];
  const strip = alertOrder ? M.ladderStrip(alertOrder) : null;
  const age = alertOrder && Number.isFinite(t) ? Math.max(0, Math.floor((t - alertOrder.created_at) / MIN)) : null;
  const agotados = availability();
  const curView = cur ? M.orderView(cur) : null;
  return {
    isLogin: S.phase === 'login', isBranch: S.phase === 'branch', isChecks: S.phase === 'checks', isKeypad, isPinPrompt: main && S.view === 'pinPrompt',
    loginErr: S.loginErr, loginBtnCls: S.working ? 'dis' : '', goBranch: doLogin,
    noBranches: S.pairing && S.pairing.screen === 'none', noBranchesText: S.pairing && S.pairing.copy, pairErr: S.pairErr,
    hasBranches: !!(S.pairing && S.pairing.rows && S.pairing.rows.length), pairBtnCls: S.working || !S.sel ? 'dis' : '',
    branches: (S.pairing && S.pairing.rows || []).map((r) => ({ name: r.location_name || r.rid, addr: '', cls: S.sel && S.sel.rid === r.rid ? 'on' : '', pick: () => set({ sel: r }) })),
    useBranchLabel: S.sel ? `Usar ${S.sel.location_name || S.sel.rid}` : '', goChecks: doPair,
    notifText: st.notifications ? 'Activadas' : '—', notifColor: st.notifications ? '#17633D' : '#9A1C12',
    volText: st.alarmVolumeMax ? 'Máximo' : '—', volColor: st.alarmVolumeMax ? '#17633D' : '#9A1C12',
    batteryText: st.batteryExempt ? 'Apagado para esta app' : 'Tiene que estar apagado para esta app',
    batteryPending: !st.batteryExempt, batteryOk: !!st.batteryExempt, fixBattery: refreshStatus,
    browserNote: st.note || '', checksBlocked: !!st.blocked, checksBtnCls: st.blocked ? 'dis' : '',
    testAlert: () => { sound.unlock(); bridge.alarm.start(['__prueba__']); setTimeout(() => bridge.alarm.stop(), 2500); toast('Sonando la alerta de prueba a todo volumen…'); },
    goPinCreate: () => { if (!st.blocked) set({ phase: 'pin', pinEntry: '', pinFirst: null, pinErr: '' }); },
    keypadTitle: S.phase === 'pin' ? (S.pinFirst ? COPY.pinRepeat : 'Creá el PIN del encargado') : 'PIN del encargado',
    keypadSub: S.phase === 'pin' ? 'Protege cambiar de sucursal y cerrar sesión. Para aceptar pedidos no hace falta.' : 'Para entrar a los ajustes del equipo.',
    pinDots: [0, 1, 2, 3].map((i) => ({ cls: i < S.pinEntry.length ? 'f' : '' })), pinErrText: S.pinErr, keys,
    forgotPin: () => doSignOut('olvide_pin'),
    isMain: main && !isKeypad, topIsList: S.view === 'list', topIsBack: S.view !== 'list',
    brandName, loc, pillCls: pill.cls, pillLabel: pill.label, pillRing: pill.ring, pillDot: !pill.ring, pillRingOff: pill.ringOff, pillRingAria: pill.ringAria,
    openStatus: () => set({ sheet: 'status' }),
    bannerOff: off, bannerPause: !off && pausedOn, bannerBusy: !off && !pausedOn && busyOn, pauseText: pill.pauseText, busyText: pill.busyText,
    resume: () => control('merchantSetPause', { op: 'resume' }), clearBusy: () => control('merchantSetBusy', { clear: true }),
    isList: S.view === 'list', isDetail: S.view === 'detail' && !!cur, isAgotados: S.view === 'agotados', isSettings: S.view === 'settings',
    goList: () => { stopEta(); set({ view: 'list', cur: null, pinEntry: '', pinErr: '' }); },
    tabN: S.tab === 'n' ? 'on' : '', tabP: S.tab === 'p' ? 'on' : '', tabL: S.tab === 'l' ? 'on' : '',
    cN: S.feed.loaded ? q.nuevos.length : '–', cP: S.feed.loaded ? q.prep.length : '–', cL: S.feed.loaded ? q.listos.length : '–',
    goN: () => set({ tab: 'n' }), goP: () => set({ tab: 'p' }), goL: () => set({ tab: 'l' }),
    showN: S.tab === 'n', showP: S.tab === 'p', showL: S.tab === 'l',
    emptyN: S.feed.loaded && !q.nuevos.length, emptyP: S.feed.loaded && !q.prep.length, emptyL: S.feed.loaded && !q.listos.length,
    newCards: q.nuevos.map((o) => ({ ...M.newCard(o, { nowMs: t, opened: !!S.opened[o.id] }), open: () => openOrder(o.id) })),
    prepCards: q.prep.map((o) => ({ ...M.prepCard(o, { nowMs: t, driver: driverOf(o.id), pending: o._pending, entered: S.entered === o.id }), open: () => openOrder(o.id) })),
    readyCards: q.listos.map((o) => ({ ...M.readyCard(o, { nowMs: t, driver: driverOf(o.id), pending: o._pending, entered: S.entered === o.id }), handed: () => handed(o.id) })),
    d, chips: chips.map((c) => ({ label: c.label, cls: (c.delta === S.delta ? 'on' : '') + (c.dis ? ' dis' : ''), pick: () => { if (!c.dis) set({ delta: c.delta }); } })),
    acceptLabel: chosen ? M.acceptLabel(chosen.value) : 'Aceptar',
    busyExplain: busyOn && b !== null, busyExplainText: busyOn && b !== null ? M.busyExplain(b - pill.busyAdd, pill.busyAdd) : '',
    openReject: () => set({ sheet: 'reject' }),
    shReject: S.sheet === 'reject', shItems: S.sheet === 'items', shMore: S.sheet === 'more', shWA: S.sheet === 'wa', shStatus: S.sheet === 'status',
    shBusy: S.sheet === 'busy', shPause: S.sheet === 'pause', shBranch: false, shLogout: S.sheet === 'logout',
    reasons: REASONS.map(([k, l]) => ({ label: l, cls: S.reason === k ? 'on' : '', pick: () => set({ reason: k }) })),
    isOtro: S.reason === 'otro', isAgotadoReason: S.reason === 'agotado', isOtherReason: S.reason !== 'agotado',
    rejBtnCls: S.reason && !S.rejecting[S.cur] ? '' : 'dis', confirmReject: () => doReject(goneNames),
    toItems: () => set({ sheet: 'items', gone: {} }),
    rejItems: curView ? curView.items.map((i) => ({ label: i.name, cls: S.gone[i.name] ? 'on' : '', pick: () => set({ gone: { ...S.gone, [i.name]: !S.gone[i.name] } }) })) : [],
    itemsBtnCls: goneNames.length ? '' : 'dis', closeSheet: () => set({ sheet: null }),
    openMore: () => set({ sheet: 'more', moreSel: 5 }),
    moreChips: cur ? M.moreChips(cur).map((c) => ({ label: c.label, cls: (S.moreSel === c.value ? 'on' : '') + (c.dis ? ' dis' : ''), pick: () => { if (!c.dis) set({ moreSel: c.value }); } })) : [],
    newReadyAt: cur && cur.prep && Number.isFinite(cur.prep.ready_at) ? M.fmt(cur.prep.ready_at + S.moreSel * MIN) : '',
    moveLabel: cur && cur.prep && Number.isFinite(cur.prep.ready_at) ? `Mover a las ${M.fmt(cur.prep.ready_at + S.moreSel * MIN)}` : '',
    confirmMore: doMore, openWA: () => set({ sheet: 'wa', waSel: 'agotado' }),
    waTitle: curView ? `Escribile a ${curView.cust.split(' ')[0]}` : '',
    waOpts: WA.map(([k, l]) => ({ label: l, cls: S.waSel === k ? 'on' : '', pick: () => set({ waSel: k }) })),
    waText: curView ? `Hola ${curView.cust.split(' ')[0]}, te escribimos de ${brandName} por tu pedido #${curView.num}. ${WA_TEXT[S.waSel]}` : '',
    sendWA: () => openWhatsApp(cur, curView, brandName),
    statusTitle: `Estado de ${loc}`, stOpenCls: pill.mode === 'open' ? 'on' : '', stBusyCls: busyOn ? 'on' : '', stPauseCls: pausedOn ? 'on' : '',
    setOpen: () => { if (busyOn) control('merchantSetBusy', { clear: true }); if (pausedOn) control('merchantSetPause', { op: 'resume' }); set({ sheet: null }); },
    toBusy: () => set({ sheet: 'busy' }), toPause: () => set({ sheet: 'pause' }),
    goAgotados: () => set({ view: 'agotados', sheet: null, cur: null }),
    goPinPrompt: () => set({ view: 'pinPrompt', sheet: null, pinEntry: '', pinErr: '', cur: null }),
    busyAddChips: [10, 15, 20].map((v) => ({ label: `+${v} min`, cls: S.busyAdd === v ? 'on' : '', pick: () => set({ busyAdd: v }) })),
    busyDurChips: [30, 60, 90].map((v) => ({ label: v === 30 ? '30 min' : (v === 60 ? '1 hora' : '1 h 30'), cls: S.busyDur === v ? 'on' : '', pick: () => set({ busyDur: v }) })),
    busyUntilLine: Number.isFinite(t) ? `Se apaga solo a las ${M.fmt(t + S.busyDur * MIN)}.` : '',
    confirmBusy: () => { control('merchantSetBusy', { add_min: S.busyAdd, dur_min: S.busyDur }); set({ sheet: null }); },
    pauseDurChips: [30, 60, 0].map((v) => ({ label: v === 0 ? 'Hasta reanudar' : (v === 30 ? '30 min' : '1 hora'), cls: S.pauseDur === v ? 'on' : '', pick: () => set({ pauseDur: v }) })),
    pauseReasonChips: ['Cocina llena', 'Falta personal', 'Problema técnico', 'Otro'].map((v) => ({ label: v, cls: S.pauseReason === v ? 'on' : '', pick: () => set({ pauseReason: v }) })),
    pauseBtnLabel: S.pauseDur === 0 ? 'Pausar hasta reanudar' : (Number.isFinite(t) ? `Pausar hasta las ${M.fmt(t + S.pauseDur * MIN)}` : 'Pausar'),
    confirmPause: () => { control('merchantSetPause', { op: 'pause', dur_min: S.pauseDur === 0 ? null : S.pauseDur, reason: S.pauseReason }); set({ sheet: null }); },
    agotadosSub: `Lo que marqués acá no se puede pedir en ${loc}. El menú y los precios son de la marca.`,
    agotadosCount: String(agotados.filter((m) => m.out).length), menuRows: agotados,
    openBranchSheet: () => set({ sheet: 'logout' }), askLogout: () => set({ sheet: 'logout' }), doLogout: () => doSignOut('cerrar_sesion'),
    alertOn: !!alertOrder,
    alertHead: unopened.length > 1 ? `${unopened.length} pedidos nuevos` : 'Pedido nuevo',
    alertAge: age === null ? '' : `hace ${age} min`,
    alertAgeBg: strip ? '#fff' : 'rgba(255,255,255,.18)', alertAgeFg: strip ? '#9A1C12' : '#fff',
    alertNum: alertOrder ? `#${M.orderView(alertOrder).num}` : '',
    alertSub: alertOrder ? alertSubOf(M.orderView(alertOrder)) : '',
    alertLine1: strip ? 'Tocá «Ver pedido» para decidir' : 'Suena a todo volumen hasta que lo abrás',
    alertCls: strip && strip.tone === 'red' ? 'fast' : '', alertStrip: !!strip,
    stripBg: strip && strip.tone === 'red' ? '#B42318' : '#F6E7C8', stripFg: strip && strip.tone === 'red' ? '#fff' : '#5A3605', stripText: strip ? strip.text : '',
    alertLine2: strip ? (strip.tone === 'red' ? 'Reanudá la sucursal desde la banda negra cuando estés listo' : 'A los 5 min sin respuesta pausamos la sucursal') : '',
    openAlert: () => { if (alertOrder) openOrder(alertOrder.id); },
    hasToast: !!S.toast, toastMsg: S.toast ? S.toast.msg : '', toastUndo: !!(S.toast && S.toast.undo), undoReady,
  };
}

// the alert's sub line, as the prototype: «Entrega · 4 productos · L 485»
function alertSubOf(v) {
  const total = v.payLine ? v.payLine.split(' · ')[0] : '';
  return [v.isDelivery ? 'Entrega' : 'Pickup', v.qty + ' productos', total].filter(Boolean).join(' · ');
}

function detail(cur, t, off, b) {
  const v = M.orderView(cur);
  const isNew = cur.status === 'new'; const isPrep = cur.status === 'preparing'; const isReady = cur.status === 'ready';
  const drv = driverOf(cur.id);
  const rm = cur.prep && Number.isFinite(cur.prep.ready_at) ? cur.prep.ready_at : null;
  const lt = M.lateTag(rm !== null && Number.isFinite(t) ? Math.ceil((rm - t) / MIN) || 0 : null);
  const realAt = cur.prep && Number.isFinite(cur.prep.ready_marked_at) ? cur.prep.ready_marked_at : null;
  const dv = M.driverView(cur, drv, t);
  const info = M.detailInfo(cur, { offline: off, driver: drv });
  const rs = M.rejectState(cur);
  return {
    title: v.title, cust: v.cust, initial: v.initial, items: v.items, note: v.note, hasNote: v.hasNote, payLine: v.payLine,
    isNew: isNew && !rs, isPrep, isActive: isPrep || isReady, isDelivery: v.isDelivery, showTime: isPrep || isReady,
    timeLine: isReady ? `Listo a las ${M.fmt(realAt)}` : `Listo a las ${M.fmt(rm)}`,
    tag: isReady ? (realAt !== null && rm !== null ? (realAt <= rm ? 'A tiempo' : `Con ${Math.ceil((realAt - rm) / MIN)} min de atraso`) : '') : lt.label,
    tagCls: isReady ? '' : lt.cls, driverName: dv.name, driverSub: dv.sub,
    showWA: !off && !!phoneOf(cur), canMore: M.canMore(cur, drv.assigned, off) && !cur._pending, info, hasInfo: !!info,
    accept: () => doAccept(cur, b), ready: () => doReady(cur),
  };
}

function availability() {
  const man = Array.isArray(S.feed.menu) ? S.feed.menu : [];
  const flags = S.feed.availability || {};
  const enc = (raw) => encodeURIComponent(String(raw)).replace(/\./g, '%2E');   // the KDS/server availKey, byte-identical rule
  const rows = man.filter((m) => m && m.key != null).map((m) => {
    const f = flags[enc(m.key)]; const out = !!(f && f.available === false);
    const name = m.label != null ? String(m.label) : String(m.key);
    return { name, out, lbl: out ? 'Agotado' : 'Disponible', swCls: out ? 'off' : '', aria: `${name}${out ? ': agotado. Activar' : ': disponible. Marcar agotado'}`,
      toggle: () => control('merchantSetAvailability', { item_key_raw: String(m.key), available: out }) };
  });
  return rows.sort((a, b2) => Number(b2.out) - Number(a.out));
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
