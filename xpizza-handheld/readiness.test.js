// H1c — readiness rows: every approved string pinned (OWNER APPROVED 2026-10-26), the kiosk and no-session variants, the line under
// «Continuar», and the frozen status() path untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readiness, connecting, createConnectPoll, repairAction } from './readiness.js';
import { READINESS } from './copy.js';

const GREEN = { notifications: true, fullScreen: true, channelOk: true, alarmVolumeMax: true, batteryExempt: true, pushReady: true, pushSession: true, kiosk: false };
const st = (over) => ({ ...GREEN, ...over });

test('the approved strings, verbatim', () => {
  assert.deepEqual({ ...READINESS, steps: READINESS.steps(2) }, {
    channelTitle: 'Sonido de pedidos', channelOk: 'Activado con prioridad alta', channelTodo: 'Está silenciado para esta app',
    channelBtn: 'Activar', channelMissing: 'Falta activar el sonido de pedidos.',
    fullScreenTitle: 'Alerta en pantalla bloqueada', fullScreenOk: 'El pedido aparece aunque la pantalla esté bloqueada',
    fullScreenTodo: 'Tiene que estar permitida para esta app', fullScreenBtn: 'Permitir',
    fullScreenMissing: 'Falta permitir la alerta en pantalla bloqueada.',
    pushTitle: 'Conexión para pedidos', pushOk: 'Los pedidos llegan aunque la app esté cerrada', pushWait: 'Conectando…',
    pushWaitMissing: 'Conectando el equipo para recibir pedidos…', pushTodo: 'Hay que volver a vincular este equipo',
    pushBtn: 'Vincular', pushMissing: 'Falta conectar el equipo para recibir pedidos.',
    kiosk: 'Avisale al dueño para que lo active.', steps: 'Faltan 2 pasos para recibir pedidos.',
  });
  assert.equal(READINESS.steps(5), 'Faltan 5 pasos para recibir pedidos.');
});

test('the frozen status() (no pushReady) keeps the approved H1b screen: no new rows', () => {
  assert.deepEqual(readiness({ notifications: true, alarmVolumeMax: true, batteryExempt: false, blocked: true, note: '' }), { ex: false });
  assert.deepEqual(readiness(undefined), { ex: false });
  assert.deepEqual(readiness({ pushReady: 'true' }), { ex: false }, 'only a real boolean marks statusEx');
});

test('all green: three ok rows, no line', () => {
  const r = readiness(GREEN);
  assert.deepEqual([r.channel, r.fullScreen, r.push].map((x) => [x.title, x.state, x.text, x.btn]), [
    ['Sonido de pedidos', 'ok', 'Activado con prioridad alta', null],
    ['Alerta en pantalla bloqueada', 'ok', 'El pedido aparece aunque la pantalla esté bloqueada', null],
    ['Conexión para pedidos', 'ok', 'Los pedidos llegan aunque la app esté cerrada', null],
  ]);
  assert.equal(r.missingCount, 0); assert.equal(r.line, '');
});

test('each row alone: its todo text, its button and its own line', () => {
  let r = readiness(st({ channelOk: false }));
  assert.deepEqual([r.channel.state, r.channel.text, r.channel.btn, r.line], ['todo', 'Está silenciado para esta app', 'Activar', 'Falta activar el sonido de pedidos.']);
  r = readiness(st({ fullScreen: false }));
  assert.deepEqual([r.fullScreen.state, r.fullScreen.text, r.fullScreen.btn, r.line], ['todo', 'Tiene que estar permitida para esta app', 'Permitir', 'Falta permitir la alerta en pantalla bloqueada.']);
  r = readiness(st({ batteryExempt: false }));
  assert.equal(r.line, 'Falta apagar el ahorro de batería.', 'battery alone keeps the board line');
});

test('push: registering → «Conectando…» with no button; no native session → «Vincular»', () => {
  let r = readiness(st({ pushReady: false, pushSession: true }));
  assert.deepEqual([r.push.state, r.push.text, r.push.btn, r.line], ['wait', 'Conectando…', null, 'Conectando el equipo para recibir pedidos…']);
  assert.equal(readiness({ ...GREEN, pushReady: false, pushSession: undefined }).push.state, 'wait', 'an older shell without pushSession never forces a re-pair');
  r = readiness(st({ pushReady: false, pushSession: false }));
  assert.deepEqual([r.push.state, r.push.text, r.push.btn, r.line], ['repair', 'Hay que volver a vincular este equipo', 'Vincular', 'Falta conectar el equipo para recibir pedidos.']);
});

test('kiosk: the Settings rows lose their button and ask for the owner; «Vincular» (in-app) stays', () => {
  const r = readiness(st({ kiosk: true, channelOk: false, fullScreen: false, pushReady: false, pushSession: false }));
  assert.deepEqual([r.channel.state, r.channel.text, r.channel.btn], ['kiosk', 'Avisale al dueño para que lo active.', null]);
  assert.deepEqual([r.fullScreen.state, r.fullScreen.text, r.fullScreen.btn], ['kiosk', 'Avisale al dueño para que lo active.', null]);
  assert.deepEqual([r.push.state, r.push.btn], ['repair', 'Vincular']);
  assert.equal(r.line, 'Faltan 3 pasos para recibir pedidos.');
  assert.equal(readiness(st({ kiosk: true })).channel.state, 'ok', 'a green row stays green under kiosk');
  assert.equal(readiness(st({ kiosk: 'yes', channelOk: false })).channel.state, 'todo', 'only kiosk === true hides the button');
});

test('the line: 2+ gaps → «Faltan N pasos…» counting every row (waiting included); a lone notifications / volume gap → no line', () => {
  assert.equal(readiness(st({ channelOk: false, pushReady: false })).line, 'Faltan 2 pasos para recibir pedidos.');
  const all = readiness({ notifications: false, fullScreen: false, channelOk: false, alarmVolumeMax: false, batteryExempt: false, pushReady: false, pushSession: false });
  assert.equal(all.missingCount, 6); assert.equal(all.line, 'Faltan 6 pasos para recibir pedidos.');
  assert.equal(readiness(st({ notifications: false })).line, '');
  assert.equal(readiness(st({ alarmVolumeMax: false })).line, '');
  assert.equal(readiness(st({ notifications: false, alarmVolumeMax: false })).line, 'Faltan 2 pasos para recibir pedidos.');
});

test('connecting(): only the checks screen with a statusEx push row in «Conectando…»', () => {
  assert.equal(connecting('checks', st({ pushReady: false, pushSession: true })), true);
  assert.equal(connecting('checks', st({ pushReady: false })), true, 'pushSession unknown → still waiting');
  assert.equal(connecting('checks', st({ pushReady: false, pushSession: false })), false, '«Vincular» is not waiting');
  assert.equal(connecting('checks', GREEN), false);
  assert.equal(connecting('main', st({ pushReady: false })), false, 'left the screen');
  assert.equal(connecting('checks', { notifications: true, alarmVolumeMax: true, batteryExempt: true }), false, 'frozen status()');
});

// a fake clock: setTimer queues, run() fires the due one and lets its refresh settle
function fakeTimers() {
  const q = []; let id = 0;
  return { q, setTimer: (fn, ms) => { const t = { id: ++id, fn, ms }; q.push(t); return t; }, clearTimer: (t) => { const i = q.indexOf(t); if (i >= 0) q.splice(i, 1); },
    run: async () => { const t = q.shift(); assert.ok(t, 'a tick is scheduled'); await t.fn(); } };
}

test('poll: re-reads every 3 s while «Conectando…», stops the moment pushReady turns true — «Continuar» unblocks without a resume', async () => {
  const T = fakeTimers(); let phase = 'checks'; let status = st({ pushReady: false, pushSession: true, blocked: true });
  const native = [st({ pushReady: false, pushSession: true }), st({ pushReady: false, pushSession: true }), GREEN];
  let poll;
  const set = (p) => { ({ phase = phase, status = status } = { phase, status, ...p }); poll.sync(connecting(phase, status)); };
  poll = createConnectPoll({ refresh: async () => set({ status: native.shift() }), setTimer: T.setTimer, clearTimer: T.clearTimer });
  set({});
  assert.equal(T.q.length, 1); assert.equal(T.q[0].ms, 3000);
  set({}); set({});
  assert.equal(T.q.length, 1, 'sync is idempotent: one loop');
  await T.run(); await T.run();
  assert.equal(readiness(status).push.state, 'wait'); assert.equal(T.q.length, 1, 'still waiting → next tick');
  await T.run();
  assert.equal(readiness(status).push.state, 'ok'); assert.equal(readiness(status).line, '', 'ready → no line');
  assert.equal(T.q.length, 0, 'ready → the loop stops'); assert.equal(poll.reads(), 0, 're-armed for a later wait');
});

test('poll: leaving the screen stops it; it is bounded; a failing read keeps polling', async () => {
  const T = fakeTimers();
  let poll = createConnectPoll({ refresh: async () => {}, setTimer: T.setTimer, clearTimer: T.clearTimer });
  poll.sync(true); assert.equal(T.q.length, 1);
  poll.sync(false); assert.equal(T.q.length, 0, 'left → cancelled');
  poll = createConnectPoll({ refresh: async () => { poll.sync(true); }, setTimer: T.setTimer, clearTimer: T.clearTimer, max: 3 });
  poll.sync(true);
  for (let i = 0; i < 3; i++) await T.run();
  assert.equal(poll.reads(), 3); assert.equal(T.q.length, 0, 'bounded: rests after max reads');
  poll.sync(true); assert.equal(T.q.length, 0, 'stays resting while still waiting');
  poll.sync(false); poll.sync(true); assert.equal(T.q.length, 1, 'a new wait re-arms it');
  const T2 = fakeTimers(); let n = 0;
  const p2 = createConnectPoll({ refresh: async () => { n++; throw new Error('read failed'); }, setTimer: T2.setTimer, clearTimer: T2.clearTimer });
  p2.sync(true); await T2.run(); await T2.run();
  assert.equal(n, 2); assert.equal(T2.q.length, 1, 'a failed read schedules the next one');
});

test('repairAction: passes the exact kind to bridge.openSettings and never throws into the click', async () => {
  const got = [];
  const act = repairAction({ openSettings: (k) => { got.push(k); return Promise.resolve(); } });
  act('channel'); act('fullScreen');
  assert.deepEqual(got, ['channel', 'fullScreen']);
  assert.doesNotThrow(() => repairAction({ openSettings: () => { throw new Error('x'); } })('channel'));
  assert.doesNotThrow(() => repairAction({ openSettings: () => Promise.reject(new Error('x')) })('channel'));
  await new Promise((r) => setImmediate(r));
});
