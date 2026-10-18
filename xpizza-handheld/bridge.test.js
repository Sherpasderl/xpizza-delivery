// H1b T6 — bridge.js: the contract H1c implements (advisor 7, frozen), the browser stub, and the native-missing guard (codex P1-7).
//   alarm.start(orderIds) ring for exactly this set (replaces the previous) · alarm.stop() silence + clear · alarm.ack() silence the
//   CURRENT set (an id not in it re-rings via start) · status() · keepAwake(on) · onResume(cb) → unsubscribe
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, C2_BROWSER_NOTE, NATIVE_PLUGIN } from './bridge.js';

function browserRig() {
  const sound = { on: false, starts: 0, start() { this.on = true; this.starts++; }, stop() { this.on = false; } };
  const doc = { visibilityState: 'visible', ls: new Set(), addEventListener(_t, f) { this.ls.add(f); }, removeEventListener(_t, f) { this.ls.delete(f); } };
  const lock = { released: 0, release() { this.released++; return Promise.resolve(); } };
  const wake = { requests: 0, request: async () => { wake.requests++; return lock; } };
  const bridge = createBridge({ isNative: () => false, plugin: null, sound, doc, wakeLock: wake });
  return { bridge, sound, doc, wake, lock };
}

test('two orders ring; a remote accept shrinks the set and the OTHER keeps ringing; empty → silent', () => {
  const { bridge, sound } = browserRig();
  bridge.alarm.start(['o2', 'o1']);
  assert.equal(sound.on, true);
  bridge.alarm.start(['o2']);                          // o1 accepted on another device
  assert.equal(sound.on, true, 'o2 still rings');
  bridge.alarm.start([]);
  assert.equal(sound.on, false);
});

test('ack silences the CURRENT set; a NEW order re-rings; the acked ones stay silent while still present', () => {
  const { bridge, sound } = browserRig();
  bridge.alarm.start(['o1', 'o2']);
  bridge.alarm.ack();
  assert.equal(sound.on, false);
  bridge.alarm.start(['o1', 'o2']);
  assert.equal(sound.on, false, 'the same set stays silent after ack');
  bridge.alarm.start(['o1', 'o2', 'o3']);
  assert.equal(sound.on, true, 'o3 is new → rings');
  bridge.alarm.ack(); bridge.alarm.start(['o3']);
  assert.equal(sound.on, false);
  bridge.alarm.start([]); bridge.alarm.start(['o1']);
  assert.equal(sound.on, true, 'an id that LEFT the set and came back is new again');
});

test('logout: alarm.stop() silences and clears (a later start of the same ids rings again)', () => {
  const { bridge, sound } = browserRig();
  bridge.alarm.start(['o1']); bridge.alarm.ack(); bridge.alarm.stop();
  assert.equal(sound.on, false);
  bridge.alarm.start(['o1']);
  assert.equal(sound.on, true);
});

test('browser status: all true, native:false, with the approved C-2 note; keepAwake uses the Wake Lock API; onResume on visible', async () => {
  const { bridge, doc, wake, lock } = browserRig();
  assert.deepEqual(await bridge.status(), { notifications: true, alarmVolumeMax: true, batteryExempt: true, native: false, blocked: false, note: C2_BROWSER_NOTE });
  assert.equal(C2_BROWSER_NOTE, 'Modo navegador · sin alarma del sistema');
  await bridge.keepAwake(true); await bridge.keepAwake(true);
  assert.equal(wake.requests, 1, 'one lock held');
  await bridge.keepAwake(false);
  assert.equal(lock.released, 1);
  let resumed = 0;
  const off = bridge.onResume(() => resumed++);
  doc.visibilityState = 'hidden'; for (const f of doc.ls) f();
  doc.visibilityState = 'visible'; for (const f of doc.ls) f();
  assert.equal(resumed, 1);
  off(); for (const f of doc.ls) f();
  assert.equal(resumed, 1);
});

test('native with the plugin: every call is delegated to it, exactly', async () => {
  const calls = [];
  const plugin = {
    alarmStart: async (a) => calls.push(['alarmStart', a]), alarmStop: async () => calls.push(['alarmStop']), alarmAck: async () => calls.push(['alarmAck']),
    status: async () => ({ notifications: true, alarmVolumeMax: false, batteryExempt: true }),
    keepAwake: async (a) => calls.push(['keepAwake', a]),
    addListener: (ev, cb) => { calls.push(['addListener', ev]); return { remove: () => calls.push(['remove', ev]) }; },
  };
  const b = createBridge({ isNative: () => true, plugin, sound: { start() { throw new Error('never the stub'); }, stop() {} } });
  b.alarm.start(['o2', 'o1', 'o2']); b.alarm.ack(); b.alarm.stop();
  await b.keepAwake(true);
  const off = b.onResume(() => {}); off();
  assert.deepEqual(await b.status(), { notifications: true, alarmVolumeMax: false, batteryExempt: true, native: true, blocked: true, note: '' }, 'any false → the checks screen blocks');
  assert.deepEqual(calls, [['alarmStart', { orderIds: ['o1', 'o2'] }], ['alarmAck'], ['alarmStop'], ['keepAwake', { on: true }], ['addListener', 'resume'], ['remove', 'resume']]);
});

test('native-missing guard: inside the native shell WITHOUT the plugin → status all false + blocked, alarms are no-ops, NEVER the browser stub', async () => {
  const sound = { start() { throw new Error('never the stub'); }, stop() {} };
  const b = createBridge({ isNative: () => true, plugin: null, sound });
  assert.deepEqual(await b.status(), { notifications: false, alarmVolumeMax: false, batteryExempt: false, native: true, blocked: true, note: '' });
  b.alarm.start(['o1']); b.alarm.ack(); b.alarm.stop();
  await b.keepAwake(true);
  assert.equal(typeof b.onResume(() => {}), 'function');
  assert.equal(NATIVE_PLUGIN, 'SherpaHandheld', 'the frozen plugin name H1c registers');
});
