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
  const act = new Proxy({}, { get: (_t, k) => (...a) => { calls.push(String(k)); return undefined; } });
  const sets = [];
  return { calls, sets, ctx: { now: T, online: true, orders: S.feed.orders, base: 18, sess: { uid: 'u', rid: 'tb_norte', brand_id: 'tb', location_name: 'Norte', prep_default_min: 18 },
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
