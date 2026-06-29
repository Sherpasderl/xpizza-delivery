/**
 * Native (Capacitor) background-location tracking via Transistorsoft — Step 2c.
 *
 * PREPPED, NOT YET RUNNABLE: the @transistorsoft/capacitor-background-geolocation
 * plugin is licensed and not installed until the key is purchased. This module
 * is inert until then (guarded by isNative() + plugin presence). The CONFIG and
 * the shift/token wiring below are the load-bearing, reviewed parts.
 *
 * Flow (native only):
 *   clock-in  → startDriverShift callable (mints opaque ingest token) →
 *               BackgroundGeolocation.ready(config) → .start()
 *   clock-out → BackgroundGeolocation.stop() → endDriverShift callable
 *
 * Transistorsoft's native HTTP uploader POSTs batches to ingestDriverLocation,
 * bypassing the WebView throttle (ADR 0003). The token rides in the custom
 * X-Driver-Token header (Cloud Functions reserves Authorization: Bearer).
 *
 * NON-BUNDLED ACCESS (verified against plugin source): the plugin registers via
 * `registerPlugin('BackgroundGeolocation')`, so its native methods are on
 * `window.Capacitor.Plugins.BackgroundGeolocation` — callable directly from this
 * non-bundled app (same proven pattern as @capacitor/push-notifications). The
 * methods we use (ready/start/stop) are thin pass-throughs to native; the JS
 * wrapper's only real logic (onLocation/onHttp event sugar, JWT-auth helper) is
 * unused here. So no bundler is required. If we later want event listeners for
 * debugging, either Capacitor's addListener('http'/'location', cb) on the bridge
 * global, or drop the plugin's compiled dist JS into www/ and import the wrapper.
 */
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js';

const REGION = 'us-central1';
// The function's run.app URL (NOT the cloudfunctions.net alias, which 400s for
// gen2 after an update). Stable per project.
const INGEST_URL = 'https://ingestdriverlocation-m7syoovdsa-uc.a.run.app';

export function isNative() {
  return !!(window.Capacitor
    && typeof window.Capacitor.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform());
}

// The plugin registers via `registerPlugin('BackgroundGeolocation')`, so its
// native methods are on the Capacitor bridge global below — no bundler needed
// (same pattern as @capacitor/push-notifications in native-push.js, which is
// validated on-device). ready/start/stop are thin pass-throughs to native; the
// rich JS wrapper only adds event-subscription sugar + JWT-auth processing,
// neither of which this (Candidate-B, autonomous-uploader) design uses.
function getBgGeo() {
  const bg = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BackgroundGeolocation;
  if (!bg) throw new Error('Transistorsoft BackgroundGeolocation unavailable (Step 2c plugin not installed/wired)');
  return bg;
}

// Handle for the heartbeat keep-alive listener, so clock-out can detach it.
let heartbeatSub = null;

// The uploader config. locationTemplate + httpRootProperty shape each POST as
// { locations: [ { ts, lat, lng, accuracy, heading, speed }, ... ] } — exactly
// what ingestDriverLocation expects (ts is ISO; the endpoint coerces it).
function buildConfig(token) {
  return {
    // CRITICAL: Transistorsoft persists its config across launches and IGNORES
    // the config passed to ready() on subsequent calls UNLESS reset:true. Our
    // ingest token changes every shift, so we MUST re-apply the full config each
    // time → reset:true. (Without it, ready() silently keeps stale/empty config:
    // url:"", headers:{} → no uploads. Confirmed via getState() 2026-06-20.)
    reset: true,
    // debug → device beeps on each recorded location + emits debug
    // notifications. Invaluable for on-device testing (Honor logcat is
    // OEM-suppressed). MUST be false for the production / Play Store release
    // build (flip back to true to re-debug on a device).
    debug: false,
    // motion
    desiredAccuracy: -1,        // DESIRED_ACCURACY_HIGH; tune down for battery
    distanceFilter: 15,         // metres between samples while moving
    stationaryRadius: 25,
    // Keep the pin + "GPS vivo" label live while parked. The motion-based tracker
    // stops emitting once stationary, so without a heartbeat last_ping ages past
    // the client's 90s stale threshold even though the driver is on shift. The beat
    // fires every 60s while stationary; the listener in startNativeTracking forces
    // a fresh fix each time → autoSync → ingestDriverLocation refreshes last_ping.
    heartbeatInterval: 60,
    preventSuspend: true,
    // lifecycle — survive backgrounding / app kill
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
    // HTTP — native uploader → ingestDriverLocation
    url: INGEST_URL,
    httpRootProperty: 'locations',
    locationTemplate:
      '{"ts":"<%= timestamp %>","lat":<%= latitude %>,"lng":<%= longitude %>,"accuracy":<%= accuracy %>,"heading":<%= heading %>,"speed":<%= speed %>}',
    headers: { 'X-Driver-Token': token },
    autoSync: true,
    batchSync: true,
    maxBatchSize: 50,
    // offline queue survives no-signal; replays in order (endpoint dedupes by ts)
    maxRecordsToPersist: 10000,
    // don't log the token in plugin logs
    logLevel: 3
  };
}

/**
 * Start a native shift: mint the ingest token, configure + start Transistorsoft.
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

  const BgGeo = getBgGeo();
  // The native ready() expects { options: <config> } — that's how the plugin's
  // JS wrapper calls it (NativeModule.ready({ options: config })). Passing the
  // raw config to the bridge proxy silently applies nothing. start()/stop() take
  // no args. Verified against dist/index.js (2026-06-20).
  await BgGeo.ready({ options: buildConfig(ingest_token) });

  // Heartbeat keep-alive (see heartbeatInterval in buildConfig): each beat, force
  // a fresh persisted fix so autoSync POSTs it to ingestDriverLocation and
  // last_ping stays < 90s old while the driver is parked/stationary. addListener
  // on the bridge global is the same channel the wrapper uses internally
  // (NativeModule.addListener) — verified against dist/index.js.
  try { if (heartbeatSub) { await heartbeatSub.remove(); heartbeatSub = null; } } catch (e) {}
  heartbeatSub = await BgGeo.addListener('heartbeat', () => {
    BgGeo.getCurrentPosition({ options: { samples: 1, persist: true, timeout: 30 } })
      .catch((e) => console.warn('native-location: heartbeat fix failed', e));
  });

  await BgGeo.start();
  console.log(`native-location: tracking started (shift ${shift_id})`);
  return { shift_id };
}

/** End a native shift: stop tracking, revoke the token server-side. No-op off-native. */
export async function stopNativeTracking(app) {
  if (!isNative()) return;
  try { if (heartbeatSub) { await heartbeatSub.remove(); heartbeatSub = null; } } catch (e) {}
  try { await getBgGeo().stop(); } catch (e) { console.error('native-location: stop failed', e); }
  try {
    await httpsCallable(getFunctions(app, REGION), 'endDriverShift')({});
  } catch (e) {
    console.error('native-location: endDriverShift failed', e);
  }
  console.log('native-location: tracking stopped');
}

/**
 * Foreground keep-alive ping. Forces a fresh persisted fix; autoSync uploads it to
 * ingestDriverLocation, refreshing last_ping. Transistorsoft stops emitting once the
 * driver is stationary, so without this the pin goes stale (>90s) while parked.
 *
 * This runs in the WebView, so it only covers the FOREGROUND case (Android suspends
 * WebView JS in the background/Doze — the same throttle the native uploader bypasses
 * for motion updates). Background-stationary liveness is a separate, native concern.
 * No-op off-native.
 */
export async function pingNativeLocation() {
  if (!isNative()) return;
  try {
    await getBgGeo().getCurrentPosition({ options: { samples: 1, persist: true, timeout: 30 } });
  } catch (e) {
    console.warn('native-location: foreground ping failed', e);
  }
}
