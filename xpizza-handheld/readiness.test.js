// H1c — readiness rows: every approved string pinned (OWNER APPROVED 2026-10-26), the kiosk and no-session variants, the line under
// «Continuar», and the frozen status() path untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readiness } from './readiness.js';
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
