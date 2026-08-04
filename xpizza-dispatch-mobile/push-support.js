// push-support.js — PURE capability gate for staff web push. No DOM/Firebase.
// iOS only delivers web push to a home-screen-installed (standalone) PWA on 16.4+.
export function pushSupport({ standalone, iosVersion, hasServiceWorker, hasPushManager, permission }) {
  if (!hasServiceWorker || !hasPushManager) return { ok: false, reason: 'unsupported' };
  // iosVersion is null on non-iOS; only enforce the iOS-specific gates when it's a number.
  if (typeof iosVersion === 'number') {
    if (iosVersion < 16.4) return { ok: false, reason: 'ios-too-old' };
    if (!standalone) return { ok: false, reason: 'not-installed' };
  }
  if (permission === 'denied') return { ok: false, reason: 'denied' };
  return { ok: true, reason: 'ok' };
}
