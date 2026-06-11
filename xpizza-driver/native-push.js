/**
 * Native (Capacitor) FCM push registration for the Sherpa Driver app — Step 2a.
 *
 * Only active inside the native shell (window.Capacitor.isNativePlatform()).
 * Inside a Capacitor WebView, browser Web Push (VAPID) does NOT work — native
 * apps receive FCM through Android's system notification channel. This module
 * gets the device FCM token from the @capacitor/push-notifications plugin and
 * registers it with the `registerDriverPushToken` callable. The token then lives
 * on the server-only /driver_push_tokens path; dispatch reads a materialized
 * push_reachable flag (it never sees the token).
 *
 * Self-contained: builds the callable from the FirebaseApp the SDK already
 * created (XPD.getAuthInstance().app) — no SDK edits, no bundler. Plugins are
 * reached via the runtime global window.Capacitor.Plugins (this app is served
 * as plain ES modules, not bundled).
 *
 * DEVICE-VALIDATED: requires @capacitor/push-notifications installed + a real
 * device. Not exercised by the in-repo unit tests.
 *
 * Prereqs Xavier runs in ~/Projects/sherpa-driver-app:
 *   npm install @capacitor/push-notifications
 *   (add google-services.json; enable FCM in the Firebase project)
 *   rsync driver folder → www/ ; npx cap sync ; rebuild
 */
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-functions.js';

const CHANNEL_ID = 'orders'; // MUST match FCM_CHANNEL_ID in xpizza-functions/driver-push.js
const REGION = 'us-central1';

export function isNative() {
  return !!(window.Capacitor
    && typeof window.Capacitor.isNativePlatform === 'function'
    && window.Capacitor.isNativePlatform());
}

function plugin() {
  const p = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
  if (!p) throw new Error('PushNotifications plugin unavailable (native build only)');
  return p;
}

let wired = false;

/**
 * Request notification permission, register for FCM, and push the token to
 * registerDriverPushToken on the plugin's `registration` event. Idempotent —
 * safe to call on every login; listeners are wired exactly once.
 */
export async function initNativePush(app, uid) {
  if (!isNative() || !uid) return;
  const PushNotifications = plugin();
  const register = httpsCallable(getFunctions(app, REGION), 'registerDriverPushToken');

  // High-importance channel so a new-order alert wakes a locked phone.
  try {
    await PushNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'Pedidos',
      description: 'Nuevos pedidos asignados',
      importance: 5,   // IMPORTANCE_HIGH — heads-up banner + sound
      visibility: 1,   // VISIBILITY_PUBLIC — show on lock screen
      vibration: true
    });
  } catch (e) {
    console.warn('native-push: createChannel failed', e);
  }

  if (!wired) {
    wired = true;

    PushNotifications.addListener('registration', async (token) => {
      try {
        await register({
          token: token.value,
          platform: 'android',
          app_build: (window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'android'
        });
        console.log('native-push: FCM token registered');
      } catch (e) {
        console.error('native-push: register callable failed', e);
      }
    });

    PushNotifications.addListener('registrationError', (err) => {
      console.error('native-push: registration error', err);
    });

    // Tapping a notification deep-links to the order. The app listens for this
    // event and opens the relevant order card.
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const orderId = action && action.notification && action.notification.data
        && action.notification.data.order_id;
      if (orderId) {
        window.dispatchEvent(new CustomEvent('native-order-tap', { detail: { orderId } }));
      }
    });

    // App is FOREGROUNDED when the push arrives — Android delivers it to the app
    // instead of drawing a system banner. Re-emit so the app can show an in-app
    // alert. (The order list also updates live via RTDB; this just draws the
    // driver's eye to it.)
    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      const n = notification || {};
      window.dispatchEvent(new CustomEvent('native-push-received', {
        detail: {
          title: n.title || null,
          body: n.body || null,
          cancelled: !!(n.data && (n.data.cancelled === 'true' || n.data.cancelled === true)),
          orderId: (n.data && n.data.order_id) || null
        }
      }));
    });
  }

  const perm = await PushNotifications.requestPermissions();
  if (perm && perm.receive === 'granted') {
    await PushNotifications.register();
  } else {
    console.warn('native-push: notification permission not granted');
  }
}

/** Drop the FCM token + listeners (logout / notifications-off). */
export async function unregisterNativePush(app) {
  if (!isNative()) return;
  try {
    const unregister = httpsCallable(getFunctions(app, REGION), 'unregisterDriverPushToken');
    await unregister({});
  } catch (e) {
    console.error('native-push: unregister callable failed', e);
  }
  try {
    await plugin().removeAllListeners();
    wired = false;
  } catch (e) { /* non-fatal */ }
}
