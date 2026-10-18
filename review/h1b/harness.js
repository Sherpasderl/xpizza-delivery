// REVIEW ONLY — the H1b fidelity harness (PLAN-H1b T7 "screenshot each prototype state beside the build at 360×720").
//   proto: the approved prototype's OWN logic (its <script> Component, run on a 6-line DCLogic shim) driven by its own handlers.
//   build: view.js buildVM on fixture state (real /orders shapes, a synthetic third brand).
// Both render through tmpl.js with the shipped styles.css. Sets window.__ready when painted.
import { compile } from '../../xpizza-handheld/tmpl.js';
import { buildVM } from '../../xpizza-handheld/view.js';
import * as M from '../../xpizza-handheld/model.js';

const qs = new URLSearchParams(location.search);
const side = qs.get('side') || 'build';
const state = qs.get('state') || 'login';
const MIN = 60000;
const noop = () => {};

async function protoRender() {
  const src = await (await fetch('../../xpizza-handheld/spec/P-prototipo.dc.html')).text();
  const a = src.indexOf('<div class="phone">') + '<div class="phone">'.length;
  const b = src.indexOf('<div style="flex:1;display:flex;flex-direction:column;gap:14px;min-width:0">');
  let phone = src.slice(a, b); phone = phone.slice(0, phone.trimEnd().lastIndexOf('</div>'));
  const js = src.slice(src.indexOf('data-dc-script'), src.lastIndexOf('</script>'));
  const code = js.slice(js.indexOf('>') + 1);
  class DCLogic { constructor(props) { this.props = props; this.state = {}; } setState(p) { Object.assign(this.state, typeof p === 'function' ? p(this.state) : p); } }
  const Component = new Function('DCLogic', `${code}\nreturn Component;`)(DCLogic);
  const c = new Component({});
  c.audio = () => null; c.beep = noop;                 // silent in review
  const v = () => c.renderVals();
  const press = (digits) => (x) => { for (const d of digits) { const k = v().keys.find((kk) => kk.label === d); k.press(); } };
  const setup = ['skipSetup'];
  const toDetailNew = [...setup, 'simNew', (x) => x.openAlert()];
  const toDetailPrep = [...toDetailNew, (x) => x.d.accept(), (x) => x.prepCards[0].open()];
  const STEPS = {
    login: [], branch: ['goBranch'], checks: ['goBranch', 'goChecks'], pin: ['goBranch', 'goChecks', 'fixBattery', 'goPinCreate'],
    empty: setup, alert: [...setup, 'simNew'], alertAmber: [...setup, 'simNew', 'ff1', 'ff1'], alertRed: [...setup, 'simNew', 'ff5'],
    detailNew: toDetailNew, reject: [...toDetailNew, 'openReject'], rejectItems: [...toDetailNew, 'openReject', (x) => x.reasons[0].pick(), 'toItems'],
    prepList: [...toDetailNew, (x) => x.d.accept()], detailPrep: toDetailPrep, more: [...toDetailPrep, 'openMore'],
    ready: [...toDetailPrep, (x) => x.d.ready()], status: [...setup, 'openStatus'], busySheet: [...setup, 'openStatus', 'toBusy'],
    pauseSheet: [...setup, 'openStatus', 'toPause'], busyDetail: [...setup, 'openStatus', 'toBusy', 'confirmBusy', 'simNew', (x) => x.openAlert()],
    offline: [...setup, 'toggleNet'], agotados: [...setup, 'openStatus', 'goAgotados'], pinPrompt: [...setup, 'openStatus', 'goPinPrompt'],
    settings: [...setup, 'openStatus', 'goPinPrompt', press('1234')], logout: [...setup, 'openStatus', 'goPinPrompt', press('1234'), 'askLogout'],
  };
  for (const s of STEPS[state] || []) { const x = v(); if (typeof s === 'function') s(x); else x[s](); }
  clearTimeout(c._tt); clearTimeout(c._ft); c.state.entered = null;
  return compile(phone).render(v()).html;
}

async function buildRender() {
  const html = await (await fetch('../../xpizza-handheld/index.html')).text();
  const tpl = html.slice(html.indexOf('<template id="screen">') + 22, html.indexOf('</template>'));
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
    pinPrompt: () => { S.view = 'pinPrompt'; }, settings: () => { S.view = 'settings'; }, logout: () => { S.view = 'settings'; S.sheet = 'logout'; },
  };
  (FIX[state] || noop)();
  const act = new Proxy({}, { get: () => noop });
  const vals = buildVM(S, { now, online, orders: S.feed.orders, base, sess: { uid: 'hh_tb_norte_r', rid: 'tb_norte', brand_id: 'tb', location_name: 'Norte', prep_default_min: 18 },
    driverOf: () => M.driverInfo(null), set: noop, act });
  return compile(tpl).render(vals).html;
}

(side === 'proto' ? protoRender() : buildRender()).then((html) => {
  document.getElementById('app').innerHTML = html;
  document.fonts.ready.then(() => { window.__ready = true; });
}, (e) => { document.getElementById('app').textContent = `harness error: ${e && e.stack}`; window.__ready = true; });
