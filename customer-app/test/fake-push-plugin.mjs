// A fake of @capacitor/push-notifications 8.1.1 — EXACTLY the plugin's published surface (test/vendor/capacitor-push-notifications-8.1.1/
// definitions.d.ts, pinned by capp-push.test PUSH-PIN): the same methods, the same four events and their payload shapes, permission states
// 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied', addListener → Promise<{ remove }>. Never laxer: an unknown event name throws,
// register() before a granted permission fails like the OS (no token), and every call is recorded for the cells.
export const PUSH_EVENTS = Object.freeze(['registration', 'registrationError', 'pushNotificationReceived', 'pushNotificationActionPerformed']);
export const PUSH_METHODS = Object.freeze(['addListener', 'checkPermissions', 'createChannel', 'deleteChannel', 'getDeliveredNotifications', 'listChannels', 'register',
  'removeAllDeliveredNotifications', 'removeAllListeners', 'removeDeliveredNotifications', 'requestPermissions', 'unregister']);

export function createFakePushPlugin({ permission = 'prompt', onRequest = 'granted', token = 'fcm_tok_test_0001', registrationError = null } = {}) {
  let perm = permission;
  const calls = [], listeners = new Map(PUSH_EVENTS.map((e) => [e, new Set()]));
  const emit = (e, payload) => { for (const f of [...listeners.get(e)]) f(payload); };
  const rec = (m, a) => calls.push([m, a]);
  const plugin = {
    async checkPermissions() { rec('checkPermissions'); return { receive: perm }; },
    async requestPermissions() { rec('requestPermissions'); if (perm === 'prompt' || perm === 'prompt-with-rationale') perm = onRequest; return { receive: perm }; },
    async register() {
      rec('register');
      setTimeout(() => {   // the OS answers on a later turn, as on a device
        if (perm !== 'granted') emit('registrationError', { error: 'permission not granted' });
        else if (registrationError) emit('registrationError', { error: registrationError });
        else emit('registration', { value: token });
      }, 0);
    },
    async unregister() { rec('unregister'); },
    async getDeliveredNotifications() { rec('getDeliveredNotifications'); return { notifications: [] }; },
    async removeDeliveredNotifications(d) { rec('removeDeliveredNotifications', d); },
    async removeAllDeliveredNotifications() { rec('removeAllDeliveredNotifications'); },
    async createChannel(c) { rec('createChannel', c); },
    async deleteChannel(a) { rec('deleteChannel', a); },
    async listChannels() { rec('listChannels'); return { channels: [] }; },
    async addListener(eventName, fn) {
      if (!listeners.has(eventName)) throw new Error(`fake-push: unknown event ${eventName}`);
      if (typeof fn !== 'function') throw new Error('fake-push: listenerFunc must be a function');
      rec('addListener', eventName); listeners.get(eventName).add(fn);
      return { remove: async () => { listeners.get(eventName).delete(fn); } };
    },
    async removeAllListeners() { rec('removeAllListeners'); for (const s of listeners.values()) s.clear(); },
  };
  return {
    plugin, calls, of: (m) => calls.filter((c) => c[0] === m), listenerCount: (e) => listeners.get(e).size,
    // a notification the user TAPPED (ActionPerformed { actionId, notification: PushNotificationSchema })
    tap: (data, id = 'n1') => emit('pushNotificationActionPerformed', { actionId: 'tap', notification: { id, data } }),
    setPermission: (p) => { perm = p; },
  };
}
