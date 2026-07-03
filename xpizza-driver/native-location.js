/**
 * Native (Capacitor) background-location for the driver shift.
 *
 * ACTIVE PATH — self-contained ShiftLocationService (native FGS). Root-caused 2026-07-03: aggressive OEMs
 * (Honor/Huawei "Pged-Freezer", Xiaomi, etc.) FREEZE the app process when backgrounded + stationary, which
 * stalled Transistorsoft's heartbeat and froze the dispatch pin. A process holding a foreground service is
 * freeze-EXEMPT, so our native ShiftLocationService holds a permanent notification for the whole shift and
 * streams a fused location every 10s straight to ingestDriverLocation over native HTTP (no WebView JS, no
 * motion-adaptive drop). It is the SOLE active location source.
 *
 *   clock-in  → startDriverShift callable (mints opaque ingest token) → ShiftKeepAlive.start({token})
 *   clock-out → ShiftKeepAlive.stop() → endDriverShift callable
 *
 * Transistorsoft stays INSTALLED but DORMANT (never started) — license retained, available as a per-device
 * fallback. buildConfig/getBgGeo below are kept for that option; they are not called on the active path.
 */
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js';

const REGION = 'us-central1';

export function isNative() {
  return !!(window.Capacitor
    && typeof window.Capacitor.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform());
}

function getShiftService() {
  const svc = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ShiftKeepAlive;
  if (!svc) throw new Error('ShiftKeepAlive plugin unavailable (native shift service not registered)');
  return svc;
}

/**
 * Stop any lingering Transistorsoft tracking. CRITICAL for the 2.3.x → 2.4.x rollout: existing drivers
 * have TS ENABLED, and its native-persisted state survives the app update — so it would auto-resurrect on
 * launch and fight ShiftLocationService (observed on-device: TS's TrackingService cancelled our FGS's
 * notification). Call this on every native launch AND before starting our service. Idempotent; a no-op if
 * TS was never running / isn't present.
 */
export async function disableLingeringTransistorsoft() {
  if (!isNative()) return;
  try {
    const bg = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation;
    if (bg && typeof bg.stop === 'function') await bg.stop();
  } catch (e) { /* not running / not installed — fine */ }
}

/**
 * Start a native shift: mint the ingest token, start the foreground location service.
 * Returns { shift_id }. No-op off-native.
 */
export async function startNativeTracking(app, uid) {
  if (!isNative() || !uid) return null;
  const start = httpsCallable(getFunctions(app, REGION), 'startDriverShift');
  const res = await start({
    platform: 'native',
    device_id: (window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'android'
  });
  const { shift_id, ingest_token } = (res && res.data) || {};
  if (!ingest_token) throw new Error('startDriverShift returned no ingest_token');

  await disableLingeringTransistorsoft();   // belt: never let TS run alongside our service
  await getShiftService().start({ token: ingest_token });
  console.log(`native-location: shift service started (shift ${shift_id})`);
  return { shift_id };
}

/** End a native shift: stop the service, revoke the token server-side. No-op off-native. */
export async function stopNativeTracking(app) {
  if (!isNative()) return;
  try { await getShiftService().stop(); } catch (e) { console.error('native-location: stop failed', e); }
  try {
    await httpsCallable(getFunctions(app, REGION), 'endDriverShift')({});
  } catch (e) {
    console.error('native-location: endDriverShift failed', e);
  }
  console.log('native-location: tracking stopped');
}

/**
 * Foreground keep-alive ping — now a NO-OP. The native ShiftLocationService streams continuously (10s)
 * whether foregrounded or backgrounded, so the old WebView-side ping is unnecessary. Kept as an exported
 * no-op so existing callers in index.html don't break.
 */
export async function pingNativeLocation() { /* no-op — ShiftLocationService handles all cadence */ }

// ============================================================================
// DORMANT: Transistorsoft config, retained for optional per-device fallback.
// NOT called on the active path. To re-enable, call getBgGeo().ready({options:
// buildConfig(token)}).start() from startNativeTracking instead of the service.
// ============================================================================
const INGEST_URL = 'https://ingestdriverlocation-m7syoovdsa-uc.a.run.app';

function getBgGeo() {
  const bg = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation;
  if (!bg) throw new Error('Transistorsoft BackgroundGeolocation unavailable');
  return bg;
}

function buildConfig(token) {
  return {
    reset: true,
    debug: false,
    desiredAccuracy: -1,
    distanceFilter: 15,
    stationaryRadius: 25,
    heartbeatInterval: 60,
    preventSuspend: true,
    stopOnTerminate: false,
    startOnBoot: true,
    foregroundService: true,
    notification: {
      title: 'Sherpa Driver',
      text: 'Compartiendo ubicación durante el turno'
    },
    backgroundPermissionRationale: {
      title: 'Permitir ubicación "Todo el tiempo"',
      message: 'Para que el despachador te vea durante las entregas, incluso con la app cerrada.',
      positiveAction: 'Cambiar a "Permitir todo el tiempo"'
    },
    url: INGEST_URL,
    httpRootProperty: 'locations',
    locationTemplate:
      '{"ts":"<%= timestamp %>","lat":<%= latitude %>,"lng":<%= longitude %>,"accuracy":<%= accuracy %>,"heading":<%= heading %>,"speed":<%= speed %>}',
    headers: { 'X-Driver-Token': token },
    autoSync: true,
    batchSync: true,
    maxBatchSize: 50,
    maxRecordsToPersist: 10000,
    logLevel: 3
  };
}
