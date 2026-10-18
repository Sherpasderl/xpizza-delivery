// H1b T7 — the VIEW MODEL: the prototype's renderVals (spec/P-prototipo.dc.html) ported onto the real state. PURE — no Firebase, no
// DOM: app.js passes the state S and ctx = {now, online, orders (the overlaid feed), base, sess, driverOf(id), set(patch), act:{…}};
// the review harness renders fixture states through this very function.
import * as M from './model.js';
import { COPY } from './copy.js';

const MIN = 60000;
const REASONS = [['agotado', 'Se acabó un producto'], ['saturada', 'Cocina saturada'], ['cerrando', 'Estamos por cerrar'], ['otro', 'Otro motivo']];
const WA = [['agotado', 'Se acabó un producto'], ['pregunta', 'Tenemos una pregunta'], ['propio', 'Escribir mi propio mensaje']];
export const WA_TEXT = { agotado: 'Se nos acabó un producto: ¿te lo podemos cambiar por otro?', pregunta: 'Tenemos una pregunta sobre tu pedido.', propio: '' };

// ── the view model (the prototype's renderVals, on real data) ─────────────────────────────────────────────────────────────────
export function buildVM(S, ctx) {
  const t = ctx.now;
  const off = !ctx.online;
  const ctl = S.feed.control;
  const pill = M.pill({ offline: off, control: ctl, nowMs: t });
  const busyOn = pill.mode === 'busy'; const pausedOn = pill.mode === 'paused';
  const orders = ctx.orders;
  const q = M.queues(orders);
  const unopened = q.nuevos.filter((o) => !o.handheld_answered && !S.opened[o.id]);
  const main = S.phase === 'main';
  const alertOrder = main && S.view !== 'detail' ? unopened[0] || null : null;
  const cur = S.cur ? orders[S.cur] || null : null;
  const b = ctx.base;
  const chips = b === null ? [] : M.chips(b);
  const chosen = chips.find((c) => c.delta === S.delta) || chips[1];
  const brandName = (S.feed.brand && typeof S.feed.brand.name === 'string' && S.feed.brand.name) || '';
  const loc = (ctx.sess && ctx.sess.location_name) || '';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k) => (k === '' ? { blank: true, real: false }
    : k === 'del' ? { blank: false, real: true, label: 'Borrar', size: '16px', press: () => ctx.set({ pinEntry: S.pinEntry.slice(0, -1) }) }
      : { blank: false, real: true, label: k, size: '22px', press: () => ctx.act.pinPress(k) }));
  const isKeypad = S.phase === 'pin' || (main && S.view === 'pinPrompt');
  const st = S.status || {};
  const d = cur ? detail(S, ctx, cur, t, off, b) : { items: [] };
  const goneNames = cur ? M.orderView(cur).items.map((i) => i.name).filter((n) => S.gone[n]) : [];
  const strip = alertOrder ? M.ladderStrip(alertOrder) : null;
  const age = alertOrder && Number.isFinite(t) ? Math.max(0, Math.floor((t - alertOrder.created_at) / MIN)) : null;
  const agotados = availability(S, ctx);
  const curView = cur ? M.orderView(cur) : null;
  return {
    isLogin: S.phase === 'login', isBranch: S.phase === 'branch', isChecks: S.phase === 'checks', isKeypad, isPinPrompt: main && S.view === 'pinPrompt',
    loginErr: S.loginErr, loginBtnCls: S.working ? 'dis' : '', goBranch: ctx.act.doLogin,
    noBranches: S.pairing && S.pairing.screen === 'none', noBranchesText: S.pairing && S.pairing.copy, pairErr: S.pairErr,
    hasBranches: !!(S.pairing && S.pairing.rows && S.pairing.rows.length), pairBtnCls: S.working || !S.sel ? 'dis' : '',
    branches: (S.pairing && S.pairing.rows || []).map((r) => ({ name: r.location_name || r.rid, addr: '', cls: S.sel && S.sel.rid === r.rid ? 'on' : '', pick: () => ctx.set({ sel: r }) })),
    useBranchLabel: S.sel ? `Usar ${S.sel.location_name || S.sel.rid}` : '', goChecks: ctx.act.doPair,
    notifText: st.notifications ? 'Activadas' : '—', notifColor: st.notifications ? '#17633D' : '#9A1C12',
    volText: st.alarmVolumeMax ? 'Máximo' : '—', volColor: st.alarmVolumeMax ? '#17633D' : '#9A1C12',
    batteryText: st.batteryExempt ? 'Apagado para esta app' : 'Tiene que estar apagado para esta app',
    batteryPending: !st.batteryExempt, batteryOk: !!st.batteryExempt, fixBattery: ctx.act.refreshStatus,
    browserNote: st.note || '', checksBlocked: !!st.blocked, checksBtnCls: st.blocked ? 'dis' : '',
    testAlert: ctx.act.testAlert,
    goPinCreate: () => { if (!st.blocked) ctx.set({ phase: 'pin', pinEntry: '', pinFirst: null, pinErr: '' }); },
    keypadTitle: S.phase === 'pin' ? (S.pinFirst ? COPY.pinRepeat : 'Creá el PIN del encargado') : 'PIN del encargado',
    keypadSub: S.phase === 'pin' ? 'Protege cambiar de sucursal y cerrar sesión. Para aceptar pedidos no hace falta.' : 'Para entrar a los ajustes del equipo.',
    pinDots: [0, 1, 2, 3].map((i) => ({ cls: i < S.pinEntry.length ? 'f' : '' })), pinErrText: S.pinErr, keys,
    forgotPin: () => ctx.act.doSignOut('olvide_pin'),
    isMain: main && !isKeypad, topIsList: S.view === 'list', topIsBack: S.view !== 'list',
    brandName, loc, pillCls: pill.cls, pillLabel: pill.label, pillRing: pill.ring, pillDot: !pill.ring, pillRingOff: pill.ringOff, pillRingAria: pill.ringAria,
    openStatus: () => ctx.set({ sheet: 'status' }),
    bannerOff: off, bannerPause: !off && pausedOn, bannerBusy: !off && !pausedOn && busyOn, pauseText: pill.pauseText, busyText: pill.busyText,
    resume: () => ctx.act.control('merchantSetPause', { op: 'resume' }), clearBusy: () => ctx.act.control('merchantSetBusy', { clear: true }),
    isList: S.view === 'list', isDetail: S.view === 'detail' && !!cur, isAgotados: S.view === 'agotados', isSettings: S.view === 'settings',
    goList: () => { stopEta(); ctx.set({ view: 'list', cur: null, pinEntry: '', pinErr: '' }); },
    tabN: S.tab === 'n' ? 'on' : '', tabP: S.tab === 'p' ? 'on' : '', tabL: S.tab === 'l' ? 'on' : '',
    cN: S.feed.loaded ? q.nuevos.length : '–', cP: S.feed.loaded ? q.prep.length : '–', cL: S.feed.loaded ? q.listos.length : '–',
    goN: () => ctx.set({ tab: 'n' }), goP: () => ctx.set({ tab: 'p' }), goL: () => ctx.set({ tab: 'l' }),
    showN: S.tab === 'n', showP: S.tab === 'p', showL: S.tab === 'l',
    emptyN: S.feed.loaded && !q.nuevos.length, emptyP: S.feed.loaded && !q.prep.length, emptyL: S.feed.loaded && !q.listos.length,
    newCards: q.nuevos.map((o) => ({ ...M.newCard(o, { nowMs: t, opened: !!S.opened[o.id] }), open: () => ctx.act.openOrder(o.id) })),
    prepCards: q.prep.map((o) => ({ ...M.prepCard(o, { nowMs: t, driver: ctx.driverOf(o.id), pending: o._pending, entered: S.entered === o.id }), open: () => ctx.act.openOrder(o.id) })),
    readyCards: q.listos.map((o) => ({ ...M.readyCard(o, { nowMs: t, driver: ctx.driverOf(o.id), pending: o._pending, entered: S.entered === o.id }), handed: () => ctx.act.handed(o.id) })),
    d, chips: chips.map((c) => ({ label: c.label, cls: (c.delta === S.delta ? 'on' : '') + (c.dis ? ' dis' : ''), pick: () => { if (!c.dis) ctx.set({ delta: c.delta }); } })),
    acceptLabel: chosen ? M.acceptLabel(chosen.value) : 'Aceptar',
    busyExplain: busyOn && b !== null, busyExplainText: busyOn && b !== null ? M.busyExplain(b - pill.busyAdd, pill.busyAdd) : '',
    openReject: () => ctx.set({ sheet: 'reject' }),
    shReject: S.sheet === 'reject', shItems: S.sheet === 'items', shMore: S.sheet === 'more', shWA: S.sheet === 'wa', shStatus: S.sheet === 'status',
    shBusy: S.sheet === 'busy', shPause: S.sheet === 'pause', shBranch: false, shLogout: S.sheet === 'logout',
    reasons: REASONS.map(([k, l]) => ({ label: l, cls: S.reason === k ? 'on' : '', pick: () => ctx.set({ reason: k }) })),
    isOtro: S.reason === 'otro', isAgotadoReason: S.reason === 'agotado', isOtherReason: S.reason !== 'agotado',
    rejBtnCls: S.reason && !S.rejecting[S.cur] ? '' : 'dis', confirmReject: () => ctx.act.doReject(goneNames),
    toItems: () => ctx.set({ sheet: 'items', gone: {} }),
    rejItems: curView ? curView.items.map((i) => ({ label: i.name, cls: S.gone[i.name] ? 'on' : '', pick: () => ctx.set({ gone: { ...S.gone, [i.name]: !S.gone[i.name] } }) })) : [],
    itemsBtnCls: goneNames.length ? '' : 'dis', closeSheet: () => ctx.set({ sheet: null }),
    openMore: () => ctx.set({ sheet: 'more', moreSel: 5 }),
    moreChips: cur ? M.moreChips(cur).map((c) => ({ label: c.label, cls: (S.moreSel === c.value ? 'on' : '') + (c.dis ? ' dis' : ''), pick: () => { if (!c.dis) ctx.set({ moreSel: c.value }); } })) : [],
    newReadyAt: cur && cur.prep && Number.isFinite(cur.prep.ready_at) ? M.fmt(cur.prep.ready_at + S.moreSel * MIN) : '',
    moveLabel: cur && cur.prep && Number.isFinite(cur.prep.ready_at) ? `Mover a las ${M.fmt(cur.prep.ready_at + S.moreSel * MIN)}` : '',
    confirmMore: ctx.act.doMore, openWA: () => ctx.set({ sheet: 'wa', waSel: 'agotado' }),
    waTitle: curView ? `Escribile a ${curView.cust.split(' ')[0]}` : '',
    waOpts: WA.map(([k, l]) => ({ label: l, cls: S.waSel === k ? 'on' : '', pick: () => ctx.set({ waSel: k }) })),
    waText: curView ? `Hola ${curView.cust.split(' ')[0]}, te escribimos de ${brandName} por tu pedido #${curView.num}. ${WA_TEXT[S.waSel]}` : '',
    sendWA: () => ctx.act.openWhatsApp(cur, curView, brandName),
    statusTitle: `Estado de ${loc}`, stOpenCls: pill.mode === 'open' ? 'on' : '', stBusyCls: busyOn ? 'on' : '', stPauseCls: pausedOn ? 'on' : '',
    setOpen: () => { if (busyOn) ctx.act.control('merchantSetBusy', { clear: true }); if (pausedOn) ctx.act.control('merchantSetPause', { op: 'resume' }); ctx.set({ sheet: null }); },
    toBusy: () => ctx.set({ sheet: 'busy' }), toPause: () => ctx.set({ sheet: 'pause' }),
    goAgotados: () => ctx.set({ view: 'agotados', sheet: null, cur: null }),
    goPinPrompt: () => ctx.set({ view: 'pinPrompt', sheet: null, pinEntry: '', pinErr: '', cur: null }),
    busyAddChips: [10, 15, 20].map((v) => ({ label: `+${v} min`, cls: S.busyAdd === v ? 'on' : '', pick: () => ctx.set({ busyAdd: v }) })),
    busyDurChips: [30, 60, 90].map((v) => ({ label: v === 30 ? '30 min' : (v === 60 ? '1 hora' : '1 h 30'), cls: S.busyDur === v ? 'on' : '', pick: () => ctx.set({ busyDur: v }) })),
    busyUntilLine: Number.isFinite(t) ? `Se apaga solo a las ${M.fmt(t + S.busyDur * MIN)}.` : '',
    confirmBusy: () => { ctx.act.control('merchantSetBusy', { add_min: S.busyAdd, dur_min: S.busyDur }); ctx.set({ sheet: null }); },
    pauseDurChips: [30, 60, 0].map((v) => ({ label: v === 0 ? 'Hasta reanudar' : (v === 30 ? '30 min' : '1 hora'), cls: S.pauseDur === v ? 'on' : '', pick: () => ctx.set({ pauseDur: v }) })),
    pauseReasonChips: ['Cocina llena', 'Falta personal', 'Problema técnico', 'Otro'].map((v) => ({ label: v, cls: S.pauseReason === v ? 'on' : '', pick: () => ctx.set({ pauseReason: v }) })),
    pauseBtnLabel: S.pauseDur === 0 ? 'Pausar hasta reanudar' : (Number.isFinite(t) ? `Pausar hasta las ${M.fmt(t + S.pauseDur * MIN)}` : 'Pausar'),
    confirmPause: () => { ctx.act.control('merchantSetPause', { op: 'pause', dur_min: S.pauseDur === 0 ? null : S.pauseDur, reason: S.pauseReason }); ctx.set({ sheet: null }); },
    agotadosSub: `Lo que marqués acá no se puede pedir en ${loc}. El menú y los precios son de la marca.`,
    agotadosCount: String(agotados.filter((m) => m.out).length), menuRows: agotados,
    openBranchSheet: () => ctx.set({ sheet: 'logout' }), askLogout: () => ctx.set({ sheet: 'logout' }), doLogout: () => ctx.act.doSignOut('cerrar_sesion'),
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
    openAlert: () => { if (alertOrder) ctx.act.openOrder(alertOrder.id); },
    hasToast: !!S.toast, toastMsg: S.toast ? S.toast.msg : '', toastUndo: !!(S.toast && S.toast.undo), undoReady: ctx.act.undoReady,
  };
}

// the alert's sub line, as the prototype: «Entrega · 4 productos · L 485»
function alertSubOf(v) {
  const total = v.payLine ? v.payLine.split(' · ')[0] : '';
  return [v.isDelivery ? 'Entrega' : 'Pickup', v.qty + ' productos', total].filter(Boolean).join(' · ');
}

function detail(S, ctx, cur, t, off, b) {
  const v = M.orderView(cur);
  const isNew = cur.status === 'new'; const isPrep = cur.status === 'preparing'; const isReady = cur.status === 'ready';
  const drv = ctx.driverOf(cur.id);
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
    showWA: !off && !!M.phoneOf(cur), canMore: M.canMore(cur, drv.assigned, off) && !cur._pending, info, hasInfo: !!info,
    accept: () => ctx.act.doAccept(cur, b), ready: () => ctx.act.doReady(cur),
  };
}

function availability(S, ctx) {
  const man = Array.isArray(S.feed.menu) ? S.feed.menu : [];
  const flags = S.feed.availability || {};
  const enc = (raw) => encodeURIComponent(String(raw)).replace(/\./g, '%2E');   // the KDS/server availKey, byte-identical rule
  const rows = man.filter((m) => m && m.key != null).map((m) => {
    const f = flags[enc(m.key)]; const out = !!(f && f.available === false);
    const name = m.label != null ? String(m.label) : String(m.key);
    return { name, out, lbl: out ? 'Agotado' : 'Disponible', swCls: out ? 'off' : '', aria: `${name}${out ? ': agotado. Activar' : ': disponible. Marcar agotado'}`,
      toggle: () => ctx.act.control('merchantSetAvailability', { item_key_raw: String(m.key), available: out }) };
  });
  return rows.sort((a, b2) => Number(b2.out) - Number(a.out));
}

