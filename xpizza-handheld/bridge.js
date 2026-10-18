// H1b T6 — the native bridge (PLAN-H1b T6; advisor 7, FROZEN for H1c; codex P1-7). H1c implements EXACTLY this, as the Capacitor
// plugin `SherpaHandheld` with alarmStart({orderIds}) / alarmStop() / alarmAck() / status() / keepAwake({on}) / addListener('resume').
//   bridge.alarm.start(orderIds)  ring for exactly this set; replaces the previous set
//   bridge.alarm.stop()           silence + clear the set
//   bridge.alarm.ack()            staff touched: silence the CURRENT set; an id not in it re-rings via start()
//   bridge.status() → Promise<{notifications, alarmVolumeMax, batteryExempt, native, blocked, note}>
//   bridge.keepAwake(on)
//   bridge.onResume(cb) → unsubscribe
// Browser stub (no native shell): a Web Audio loop, visibilitychange → onResume, the Wake Lock API; status() all true, native:false,
// with the approved C-2 note. Native-missing guard: inside the native shell WITHOUT the plugin, status() is all false and blocked
// (the checks screen blocks) and the alarm is a no-op — it NEVER falls back to the browser stub. BC3: native alert delivery (FCM data
// message → alarm) is H1c's.
export const NATIVE_PLUGIN = 'SherpaHandheld';
export const C2_BROWSER_NOTE = 'Modo navegador · sin alarma del sistema';

const norm = (ids) => [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string'))].sort();

export function createBridge({ isNative, plugin, sound, doc = null, wakeLock = null }) {
  if (isNative()) return plugin ? nativeBridge(plugin) : missingBridge();
  return browserBridge({ sound, doc, wakeLock });
}

function nativeBridge(p) {
  return {
    alarm: {
      start: (ids) => { void p.alarmStart({ orderIds: norm(ids) }); },
      stop: () => { void p.alarmStop(); },
      ack: () => { void p.alarmAck(); },
    },
    async status() {
      let s = {};
      try { s = (await p.status()) || {}; } catch (_) { s = {}; }
      const out = { notifications: s.notifications === true, alarmVolumeMax: s.alarmVolumeMax === true, batteryExempt: s.batteryExempt === true };
      return { ...out, native: true, blocked: !(out.notifications && out.alarmVolumeMax && out.batteryExempt), note: '' };
    },
    keepAwake: async (on) => { try { await p.keepAwake({ on: !!on }); } catch (_) { /* best effort */ } },
    onResume(cb) { const h = p.addListener('resume', cb); return () => { try { h && h.remove && h.remove(); } catch (_) { /* gone */ } }; },
  };
}

function missingBridge() {
  return {
    alarm: { start() {}, stop() {}, ack() {} },
    status: async () => ({ notifications: false, alarmVolumeMax: false, batteryExempt: false, native: true, blocked: true, note: '' }),
    keepAwake: async () => {},
    onResume: () => () => {},
  };
}

function browserBridge({ sound, doc, wakeLock }) {
  let current = []; let acked = new Set(); let lock = null;
  const apply = () => { if (current.some((id) => !acked.has(id))) sound.start(); else sound.stop(); };
  return {
    alarm: {
      start(ids) {
        current = norm(ids);
        acked = new Set([...acked].filter((id) => current.includes(id)));   // an id that left the set is new if it returns
        apply();
      },
      stop() { current = []; acked = new Set(); sound.stop(); },
      ack() { acked = new Set(current); sound.stop(); },
    },
    status: async () => ({ notifications: true, alarmVolumeMax: true, batteryExempt: true, native: false, blocked: false, note: C2_BROWSER_NOTE }),
    async keepAwake(on) {
      try {
        if (on && !lock && wakeLock) lock = await wakeLock.request('screen');
        if (!on && lock) { const l = lock; lock = null; await l.release(); }
      } catch (_) { lock = null; }
    },
    onResume(cb) {
      if (!doc) return () => {};
      const f = () => { if (doc.visibilityState === 'visible') cb(); };
      doc.addEventListener('visibilitychange', f);
      return () => doc.removeEventListener('visibilitychange', f);
    },
  };
}

// The browser alarm sound: the prototype's two-tone square beep, once a second, while ringing. AudioContext needs a user gesture
// first (the checks screen's "Probar alerta" provides it).
export function webAudioSound(win) {
  let ctx = null; let timer = null;
  const beep = () => {
    if (!ctx) return;
    [0, 0.22].forEach((t) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'square'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.16);
      o.connect(g); g.connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.18);
    });
  };
  return {
    unlock() { try { if (!ctx) { const A = win.AudioContext || win.webkitAudioContext; if (A) ctx = new A(); } if (ctx && ctx.resume) ctx.resume(); } catch (_) { ctx = null; } },
    start() { if (timer) return; beep(); timer = win.setInterval(beep, 1000); },
    stop() { if (timer) { win.clearInterval(timer); timer = null; } },
  };
}
