// REVIEW / TEST ONLY — the build-side fixture states (real /orders shapes, synthetic third brand), shared by the fidelity harness and
// xpizza-handheld/test-browser.mjs. fixture(state, {online}) → {S, ctx}: buildVM(S, ctx) renders it.
import * as M from '../../xpizza-handheld/model.js';
const MIN = 60000;
const noop = () => {};
export function fixture(state, { online: onlineOverride } = {}) {
  const T = new Date('2026-10-18T19:20:00-06:00').getTime();
  const fullPrep = (at, c, e = 0, extra = {}) => ({ committed_min: c, extra_min: e, accepted_at: at, ready_at: at + (c + e) * MIN, ...extra });
  const o47 = (over = {}) => ({ id: 'o47', order_id: 'o47', restaurant_id: 'tb_norte', status: 'new', order_type: 'delivery', display_number: 47, created_at: T,
    customer_name: 'Andrea M.', customer_phone: '99990000', payment_method: 'online', total: 485, notes: 'Sin cebolla en las baleadas, por favor',
    items_text: '2x Baleada con huevo y aguacate | 1x Pollo frito 3 piezas [Sin picante] | 1x Horchata grande', ...over });
  const stamp = { at: T, op_id: 'op_x' };
  const S = { phase: 'main', loginErr: '', working: false, pairing: null, sel: null, pairErr: '', status: { notifications: true, alarmVolumeMax: true, batteryExempt: false, native: false, blocked: true, note: '' },
    pinEntry: '', pinFirst: null, pinErr: '', view: 'list', tab: 'n', sheet: null, cur: null,
    feed: { orders: {}, loaded: true, control: null, brand: { name: 'Marca TB' }, menu: null, availability: {}, offset: 0, connected: true, sessionLost: false },
    opened: {}, driver: {}, eta: {}, delta: 0, reason: null, gone: {}, moreSel: 5, busyAdd: 15, busyDur: 60, pauseDur: 30, pauseReason: 'Cocina llena', waSel: 'agotado', toast: null, entered: null, rejecting: {} };
  let now = T; let online = true; let base = 18;
  const rows = [{ rid: 'tb_norte', brand_id: 'tb', location_name: 'Norte' }, { rid: 'tb_centro', brand_id: 'tb', location_name: 'Centro' }, { rid: 'tb_sur', brand_id: 'tb', location_name: 'Sur' }];
  const put = (o) => { S.feed.orders[o.id] = o; };
  const busy = { busy: { add_min: 15, until: T + 60 * MIN, since: T } };
  const FIX = {
    login: () => { S.phase = 'login'; }, branch: () => { S.phase = 'branch'; S.pairing = { screen: 'branch', rows }; S.sel = rows[0]; },
    checks: () => { S.phase = 'checks'; }, pin: () => { S.phase = 'pin'; },
    empty: () => {}, alert: () => put(o47()), alertAmber: () => { put(o47({ no_answer: { dispatch_notified: stamp } })); now = T + 2 * MIN; },
    alertRed: () => { put(o47({ no_answer: { dispatch_notified: stamp, paused: stamp } })); S.feed.control = { current: { paused: true, by: 'sistema' } }; now = T + 5 * MIN; },
    detailNew: () => { put(o47()); S.view = 'detail'; S.cur = 'o47'; S.opened.o47 = 1; },
    reject: () => { put(o47()); S.view = 'detail'; S.cur = 'o47'; S.opened.o47 = 1; S.sheet = 'reject'; },
    rejectItems: () => { put(o47()); S.view = 'detail'; S.cur = 'o47'; S.opened.o47 = 1; S.sheet = 'items'; S.reason = 'agotado'; },
    prepList: () => { put(o47({ status: 'preparing', prep: fullPrep(T, 18) })); S.tab = 'p'; },
    detailPrep: () => { put(o47({ status: 'preparing', prep: fullPrep(T, 18) })); S.view = 'detail'; S.cur = 'o47'; S.tab = 'p'; },
    more: () => { put(o47({ status: 'preparing', prep: fullPrep(T, 18) })); S.view = 'detail'; S.cur = 'o47'; S.tab = 'p'; S.sheet = 'more'; },
    ready: () => { put(o47({ status: 'ready', prep: fullPrep(T, 18, 0, { ready_marked_at: T }) })); S.tab = 'l'; S.toast = { msg: '#47 marcado listo', undo: 'o47' }; },
    status: () => { S.sheet = 'status'; }, busySheet: () => { S.sheet = 'busy'; }, pauseSheet: () => { S.sheet = 'pause'; },
    busyDetail: () => { S.feed.control = busy; base = 33; put(o47({ display_number: 47 })); S.view = 'detail'; S.cur = 'o47'; S.opened.o47 = 1; },
    offline: () => { online = false; }, agotados: () => { S.view = 'agotados'; S.feed.menu = ['Baleada sencilla', 'Baleada con huevo y aguacate', 'Pollo frito 3 piezas', 'Tajadas con carne', 'Horchata grande', 'Refresco 600 ml'].map((n) => ({ key: n, label: n })); },
    rejectOtro: () => { put(o47()); S.view = 'detail'; S.cur = 'o47'; S.opened.o47 = 1; S.sheet = 'reject'; S.reason = 'otro'; },
    listLong: () => { for (let i = 0; i < 16; i++) put(o47({ id: `o${60 + i}`, order_id: `o${60 + i}`, display_number: 60 + i, created_at: T - i * 1000 })); S.opened = Object.fromEntries(Object.keys(S.feed.orders).map((k) => [k, 1])); },
    pinPrompt: () => { S.view = 'pinPrompt'; }, settings: () => { S.view = 'settings'; }, logout: () => { S.view = 'settings'; S.sheet = 'logout'; },
  };
  (FIX[state] || noop)();
  if (onlineOverride !== undefined) online = onlineOverride;
  const act = new Proxy({}, { get: () => noop });
  const ctx = { now, online, orders: S.feed.orders, base, sess: { uid: 'hh_tb_norte_r', rid: 'tb_norte', brand_id: 'tb', location_name: 'Norte', prep_default_min: 18 },
    driverOf: () => M.driverInfo(null), set: noop, act };
  return { S, ctx };
}
