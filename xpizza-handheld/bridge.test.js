// H1b T6 — bridge.js: the contract H1c implements (advisor 7, frozen), the browser stub, and the native-missing guard (codex P1-7).
//   alarm.start(orderIds) ring for exactly this set (replaces the previous) · alarm.stop() silence + clear · alarm.ack() silence the
//   CURRENT set (an id not in it re-rings via start) · status() · keepAwake(on) · onResume(cb) → unsubscribe
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, blockedEx, C2_BROWSER_NOTE, NATIVE_PLUGIN } from './bridge.js';

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

// ── H1c additions (PLAN-H1c "Contract additions") ──
function nativeRig(statusEx) {
  const calls = []; const ls = {};
  const plugin = {
    alarmStart: async (a) => calls.push(['alarmStart', a]), alarmStop: async () => {}, alarmAck: async () => {},
    status: async () => ({ notifications: true, alarmVolumeMax: true, batteryExempt: true }), keepAwake: async () => {},
    statusEx: statusEx === undefined ? undefined : async () => statusEx,
    openSettings: async (a) => calls.push(['openSettings', a]), setDeviceCredential: async (a) => calls.push(['setDeviceCredential', a]),
    endDeviceSession: async () => calls.push(['endDeviceSession']), pushToken: async () => ({ token: 'tok_1' }),
    addListener: (ev, cb) => { ls[ev] = cb; const h = { remove: () => { delete ls[ev]; calls.push(['remove', ev]); } }; return Object.assign(Promise.resolve(h), h); },
  };
  if (statusEx === undefined) delete plugin.statusEx;
  return { b: createBridge({ isNative: () => true, plugin, sound: { start() { throw new Error('never'); }, stop() {} } }), calls, ls };
}
const ALL = { notifications: true, fullScreen: true, channelOk: true, alarmVolumeMax: true, batteryExempt: true, pushReady: true, defaultHome: false };

test('H1c: alarm.start(ids, {known}) sends the feed snapshot; without {known} the payload is EXACTLY the frozen one', () => {
  const { b, calls } = nativeRig(ALL);
  b.alarm.start(['o2', 'o1'], { known: ['o3', 'o1', 'o2', 'o1'] });
  b.alarm.start([], { known: ['o1'] });
  b.alarm.start(['o1']);
  assert.deepEqual(calls, [['alarmStart', { orderIds: ['o1', 'o2'], known: ['o1', 'o2', 'o3'] }], ['alarmStart', { orderIds: [], known: ['o1'] }], ['alarmStart', { orderIds: ['o1'] }]]);
});

test('H1c: statusEx — normalized booleans; blocked = status()\'s rule OR fullScreen / channelOk / pushReady false; defaultHome is info only', async () => {
  assert.deepEqual(await nativeRig(ALL).b.statusEx(), { ...ALL, kiosk: false, pushSession: undefined, native: true, blocked: false });
  for (const k of ['notifications', 'fullScreen', 'channelOk', 'alarmVolumeMax', 'batteryExempt', 'pushReady']) {
    assert.equal((await nativeRig({ ...ALL, [k]: false }).b.statusEx()).blocked, true, `${k} false → blocked`);
    assert.equal((await nativeRig({ ...ALL, [k]: 'true' }).b.statusEx()).blocked, true, `${k} non-boolean → false → blocked`);
  }
  assert.equal((await nativeRig({ ...ALL, defaultHome: false }).b.statusEx()).blocked, false);
  const old = await nativeRig(undefined).b.statusEx();
  assert.equal(old.blocked, true, 'an older shell without statusEx fails CLOSED');
  assert.equal(blockedEx(ALL), false);
});

test('readiness 2026-10-26: statusEx passes kiosk (strict boolean) and pushSession (boolean or undefined); neither changes blocked', async () => {
  const k = await nativeRig({ ...ALL, kiosk: true, pushSession: false }).b.statusEx();
  assert.deepEqual([k.kiosk, k.pushSession, k.blocked], [true, false, false]);
  const odd = await nativeRig({ ...ALL, kiosk: 'true', pushSession: 'false' }).b.statusEx();
  assert.deepEqual([odd.kiosk, odd.pushSession], [false, undefined], 'non-booleans: kiosk false, pushSession unknown');
  assert.equal((await nativeRig({ ...ALL, pushReady: false, pushSession: true }).b.statusEx()).blocked, true, 'pushReady still blocks');
});

test('H1c: openSettings / setDeviceCredential / endDeviceSession / pushToken delegate; listeners deliver and unsubscribe', async () => {
  const { b, calls, ls } = nativeRig(ALL);
  await b.openSettings('fullScreen'); await b.setDeviceCredential('CT', 'hh_1', 'tb_norte'); await b.endDeviceSession();
  assert.equal(await b.pushToken(), 'tok_1');
  const seen = []; const tok = [];
  const offA = b.onAlarmChanged((e) => seen.push(e)); const offT = b.onTokenChange((t) => tok.push(t));
  await Promise.resolve();
  ls.alarmChanged({ ids: ['o1'], ringing: true }); ls.alarmChanged(null); ls.tokenChange({ token: 'tok_2' });
  offA(); offT();
  assert.deepEqual(seen, [{ ids: ['o1'], ringing: true }, { ids: [], ringing: false }]);
  assert.deepEqual(tok, ['tok_2']);
  assert.deepEqual(calls, [['openSettings', { kind: 'fullScreen' }], ['setDeviceCredential', { customToken: 'CT', uid: 'hh_1', rid: 'tb_norte' }], ['endDeviceSession'],
    ['remove', 'alarmChanged'], ['remove', 'tokenChange']]);
});

test('H1c: the browser stub and the native-missing bridge — additions are no-ops; only native-missing has statusEx (blocked)', async () => {
  const { bridge, sound } = browserRig();
  assert.equal(bridge.statusEx, undefined, 'the browser checks screen reads status()');
  await bridge.openSettings('battery'); await bridge.setDeviceCredential('CT', 'u', 'r'); await bridge.endDeviceSession();
  assert.equal(await bridge.pushToken(), null);
  bridge.onAlarmChanged(() => {})(); bridge.onTokenChange(() => {})();
  bridge.alarm.start(['o1'], { known: ['o1', 'o2'] });
  assert.equal(sound.on, true, 'a {known} argument changes nothing in the browser');
  const miss = createBridge({ isNative: () => true, plugin: null, sound: { start() { throw new Error('never'); }, stop() {} } });
  assert.equal((await miss.statusEx()).blocked, true);
  await miss.endDeviceSession(); assert.equal(await miss.pushToken(), null);
});

test('codex b4 r1 P2: each readiness field ABSENT from an otherwise-ready response fails safe — blocked and that row not ready', async () => {
  const { readiness } = await import('./readiness.js');
  const row = { channelOk: 'channel', fullScreen: 'fullScreen', pushReady: 'push' };
  for (const k of ['channelOk', 'fullScreen', 'pushReady']) {
    const resp = { ...ALL, pushSession: true }; delete resp[k];
    const s = await nativeRig(resp).b.statusEx();
    assert.equal(s[k], false, `${k} absent → false`);
    assert.equal(s.blocked, true, `${k} absent → blocked`);
    assert.notEqual(readiness(s)[row[k]].state, 'ok', `${k} absent → the row is not ready`);
  }
});
