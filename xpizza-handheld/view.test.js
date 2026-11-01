// H1b — view.js buildVM: every handler in the view model, in every state, runs without throwing (codex H1b r1 P1-6: every Back
// threw a ReferenceError), and the Back handlers really navigate to the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVM } from './view.js';
import * as M from './model.js';

const MIN = 60000;
const T = Date.UTC(2026, 9, 19, 1, 20);
const fullPrep = (at, c) => ({ committed_min: c, extra_min: 0, accepted_at: at, ready_at: at + c * MIN });
const order = (over = {}) => ({ id: 'o1', order_id: 'o1', restaurant_id: 'tb_norte', status: 'new', order_type: 'delivery', display_number: 7, created_at: T,
  customer_name: 'Ana P.', customer_phone: '99990000', payment_method: 'cash', total: 100, items_text: '1x Plato [Sin sal]', ...over });
function baseState(over = {}) {
  return { phase: 'main', loginErr: '', working: false, pairing: null, sel: null, pairErr: '', status: { notifications: true, alarmVolumeMax: true, batteryExempt: true, blocked: false, note: '' },
    pinEntry: '', pinFirst: null, pinErr: '', view: 'list', tab: 'n', sheet: null, cur: null,
    feed: { orders: {}, loaded: true, control: null, brand: { name: 'Marca TB' }, menu: [{ key: 'Plato', label: 'Plato' }], availability: {}, offset: 0, connected: true, sessionLost: false },
    opened: {}, driver: {}, eta: {}, delta: 0, reason: null, gone: {}, moreSel: 5, busyAdd: 15, busyDur: 60, pauseDur: 30, pauseReason: 'Cocina llena', toast: null, entered: null, rejecting: {}, ...over };
}
function ctxFor(S) {
  const calls = [];
  const log = [];
  const act = new Proxy({}, { get: (_t, k) => (...a) => { calls.push(String(k)); log.push([String(k), ...a]); return undefined; } });
  const sets = [];
  return { calls, sets, log, ctx: { now: T, online: true, orders: S.feed.orders, base: 18, sess: { uid: 'u', rid: 'tb_norte', brand_id: 'tb', location_name: 'Norte', prep_default_min: 18 },
    driverOf: () => M.driverInfo(null), set: (p) => sets.push(p), act } };
}
function handlers(v, path = 'vm', out = []) {
  if (typeof v === 'function') out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => handlers(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) handlers(x, `${path}.${k}`, out);
  return out;
}
const STATES = {
  list: () => baseState({ feed: { ...baseState().feed, orders: { o1: order() } } }),
  detailNew: () => baseState({ view: 'detail', cur: 'o1', feed: { ...baseState().feed, orders: { o1: order() } } }),
  detailPrep: () => baseState({ view: 'detail', cur: 'o1', tab: 'p', feed: { ...baseState().feed, orders: { o1: order({ status: 'preparing', prep: fullPrep(T, 18) }) } } }),
  sheets: () => baseState({ view: 'detail', cur: 'o1', sheet: 'reject', feed: { ...baseState().feed, orders: { o1: order() } } }),
  agotados: () => baseState({ view: 'agotados' }), settings: () => baseState({ view: 'settings' }), pinPrompt: () => baseState({ view: 'pinPrompt' }),
  login: () => baseState({ phase: 'login' }), checks: () => baseState({ phase: 'checks' }), pin: () => baseState({ phase: 'pin' }),
  branch: () => baseState({ phase: 'branch', pairing: { screen: 'branch', rows: [{ rid: 'tb_norte', brand_id: 'tb', location_name: 'Norte' }] } }),
};

test('every handler in every state runs without throwing', () => {
  let count = 0;
  for (const [name, mk] of Object.entries(STATES)) {
    const S = mk(); const { ctx } = ctxFor(S);
    for (const [path, fn] of handlers(buildVM(S, ctx))) {
      assert.doesNotThrow(() => fn(), `${name}: ${path}`);
      count++;
    }
  }
  assert.ok(count > 150, `swept ${count} handlers`);
});

test('every Back (goList) stops the ETA watcher and navigates to the list', () => {
  for (const name of ['detailNew', 'detailPrep', 'agotados', 'settings', 'pinPrompt']) {
    const S = STATES[name](); const { ctx, calls, sets } = ctxFor(S);
    buildVM(S, ctx).goList();
    assert.ok(calls.includes('stopEta'), `${name}: stopEta via ctx`);
    assert.equal(sets.at(-1).view, 'list', `${name}: back to the list`);
  }
});

test('the offline banner shows until the FIRST snapshot, even while connected (codex H1b r1 P2-13)', () => {
  const S = baseState({ feed: { ...baseState().feed, loaded: false, connected: true } });
  const v = buildVM(S, ctxFor(S).ctx);
  assert.equal(v.bannerOff, true);
  assert.equal(v.emptyN, false);
  const L = baseState();
  assert.equal(buildVM(L, ctxFor(L).ctx).bannerOff, false, 'loaded + connected → no banner');
});

test('«Entregado» (handed): a ready PICKUP card hands the exact order id to act.handed; a ready delivery card is not a pickup', () => {
  const ready = (over) => order({ status: 'ready', prep: { ...fullPrep(T, 18), ready_marked_at: T + 18 * MIN }, ...over });
  const S = baseState({ tab: 'l', feed: { ...baseState().feed, orders: { o1: ready({ order_type: 'pickup' }), o2: ready({ id: 'o2', order_id: 'o2' }) } } });
  const handed = [];
  const { ctx } = ctxFor(S);
  ctx.act = new Proxy({}, { get: (_t, k) => (...a) => { if (k === 'handed') handed.push(a); } });
  const vm = buildVM(S, { ...ctx, orders: S.feed.orders });
  const pick = vm.readyCards.find((c) => c.id === 'o1'); const del = vm.readyCards.find((c) => c.id === 'o2');
  assert.ok(pick && del, 'both ready orders are listed');
  assert.deepEqual([pick.isPickup, del.isPickup], [true, false]);
  pick.handed();
  assert.deepEqual(handed, [['o1']], 'act.handed receives exactly the pickup order id');
});

// H1c readiness rows (OWNER APPROVED 2026-10-26): the REAL template rendered through buildVM, per state — row order, exact strings,
// buttons → the right action, kiosk / no-session variants, and the frozen status() screen unchanged.
import fs from 'node:fs';
import { compile } from './tmpl.js';
import { repairAction } from './readiness.js';
const TPL = (() => { const h = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8'); return compile(h.slice(h.indexOf('<template id="screen">') + 22, h.indexOf('</template>'))); })();
const EX = { notifications: true, fullScreen: true, channelOk: true, alarmVolumeMax: true, batteryExempt: true, pushReady: true, defaultHome: false, kiosk: false, pushSession: true, native: true, blocked: false };
const checksOf = (status, actOver = null) => {
  const S = baseState({ phase: 'checks', status }); const { ctx, calls, log } = ctxFor(S);
  if (actOver) ctx.act = new Proxy(ctx.act, { get: (t, k) => (k in actOver ? actOver[k] : t[k]) });
  const out = TPL.render(buildVM(S, ctx));
  const body = out.html.slice(out.html.indexOf('Que no se pierda ningún pedido'));   // the whole screen, line under «Continuar» included
  const text = body.replace(/<[^>]+>/g, '\n').split('\n').map((x) => x.trim()).filter(Boolean);
  const press = (label) => { const m = body.match(new RegExp(`data-act="(\\d+)"[^>]*>${label}<`)); assert.ok(m, `button ${label}`); out.acts[m[1]](); };
  return { text, body, calls, log, press, hasBtn: (label) => new RegExp(`>${label}<`).test(body) };
};

test('readiness: all green — the six rows in the approved order, the new ones with their ok text, no line', () => {
  const { text } = checksOf(EX);
  const titles = ['Notificaciones', 'Sonido de pedidos', 'Alerta en pantalla bloqueada', 'Volumen de alerta', 'Ahorro de batería', 'Conexión para pedidos'];
  assert.deepEqual(titles.map((t) => text.indexOf(t)).every((i, k, a) => i >= 0 && (k === 0 || i > a[k - 1])), true, text.join(' | '));
  for (const s of ['Activado con prioridad alta', 'El pedido aparece aunque la pantalla esté bloqueada', 'Los pedidos llegan aunque la app esté cerrada']) assert.ok(text.includes(s), s);
  assert.ok(!text.some((s) => s.startsWith('Falta')), 'no line');
});

test('readiness: todo rows show the approved text + button, and each button runs its repair', () => {
  const r = checksOf({ ...EX, channelOk: false, fullScreen: false, blocked: true });
  assert.ok(r.text.includes('Está silenciado para esta app')); assert.ok(r.text.includes('Tiene que estar permitida para esta app'));
  assert.ok(r.text.includes('Faltan 2 pasos para recibir pedidos.'));
  r.press('Activar'); r.press('Permitir');
  assert.deepEqual(r.log, [['openSettings', 'channel'], ['openSettings', 'fullScreen']], 'exact destinations');
  // controller → bridge: the real repairAction behind the view's buttons
  const got = [];
  const w = checksOf({ ...EX, channelOk: false, fullScreen: false, blocked: true }, { openSettings: repairAction({ openSettings: async (k) => { got.push(k); } }) });
  w.press('Permitir'); w.press('Activar');
  assert.deepEqual(got, ['fullScreen', 'channel']);
  const one = checksOf({ ...EX, fullScreen: false, blocked: true });
  assert.ok(one.text.includes('Falta permitir la alerta en pantalla bloqueada.'));
  assert.ok(!one.text.includes('Falta apagar el ahorro de batería.'), 'the board battery line does not show for another gap');
});

test('readiness: push registering → «Conectando…», no button; no native session → «Vincular» signs out to the login', () => {
  const w = checksOf({ ...EX, pushReady: false, pushSession: true, blocked: true });
  assert.ok(w.text.includes('Conectando…')); assert.ok(w.text.includes('Conectando el equipo para recibir pedidos…')); assert.ok(!w.hasBtn('Vincular'));
  const r = checksOf({ ...EX, pushReady: false, pushSession: false, blocked: true });
  assert.ok(r.text.includes('Hay que volver a vincular este equipo')); assert.ok(r.text.includes('Falta conectar el equipo para recibir pedidos.'));
  r.press('Vincular'); assert.deepEqual(r.calls, ['doSignOut']);
});

test('readiness: kiosk — no Settings button, «Avisale al dueño para que lo active.» on each red Settings row', () => {
  const k = checksOf({ ...EX, kiosk: true, channelOk: false, fullScreen: false, blocked: true });
  assert.equal(k.text.filter((s) => s === 'Avisale al dueño para que lo active.').length, 2);
  assert.ok(!k.hasBtn('Activar') && !k.hasBtn('Permitir'), 'no repair button can open Settings');
  assert.ok(k.text.includes('Faltan 2 pasos para recibir pedidos.'));
});

test('readiness: the frozen status() (browser / older shell) renders the approved H1b screen exactly as before', () => {
  const old = checksOf({ notifications: true, alarmVolumeMax: true, batteryExempt: false, native: true, blocked: true, note: '' });
  for (const s of ['Sonido de pedidos', 'Alerta en pantalla bloqueada', 'Conexión para pedidos']) assert.ok(!old.text.includes(s), s);
  assert.ok(old.text.includes('Falta apagar el ahorro de batería.'));
  assert.match(old.body, /<div class="srow" style="border-bottom:none"><span><span style="display:block">Ahorro de batería/, 'battery stays the last row');
});

test('readiness (OWNER 2026-10-26, choice A): a green new row shows «Listo» on the right like the battery row; a red one does not', () => {
  const g = checksOf(EX);
  assert.equal(g.text.filter((s) => s === 'Listo').length, 4, 'battery + the three new rows');
  for (const t of ['Sonido de pedidos', 'Alerta en pantalla bloqueada', 'Conexión para pedidos']) {
    const i = g.text.indexOf(t); assert.equal(g.text[i + 2], 'Listo', `${t}: title, ok text, «Listo»`);
  }
  assert.ok(!/<svg/.test(g.body.slice(g.body.indexOf('Sonido de pedidos'))), 'no check icons (the srow style, not the preview icons)');
  const r = checksOf({ ...EX, channelOk: false, fullScreen: false, pushReady: false, pushSession: true, blocked: true });
  assert.equal(r.text.filter((s) => s === 'Listo').length, 1, 'only the green battery row');
});

test('readiness (codex b4 r1 P3): the line sits UNDER «Continuar», as approved', () => {
  const r = checksOf({ ...EX, channelOk: false, fullScreen: false, blocked: true });
  const btn = r.text.indexOf('Continuar'); const line = r.text.indexOf('Faltan 2 pasos para recibir pedidos.');
  assert.ok(btn >= 0 && line > btn, r.text.join(' | '));
  const one = checksOf({ ...EX, pushReady: false, pushSession: false, blocked: true });
  assert.ok(one.text.indexOf('Falta conectar el equipo para recibir pedidos.') > one.text.indexOf('Continuar'));
});
