// Customer app — PUSH, the client core (PLAN-capp-push r1; owner 11-14: build now, «Pedidos» first; the server decides push-or-WhatsApp per
// event). Pure, UMD, brand-agnostic; no DOM. It wraps @capacitor/push-notifications (window.Capacitor.Plugins.PushNotifications, handed
// in as `plugin`) and owns ONLY the client's part:
//   the soft ask   never at first launch (a first order first), never twice in a visit, 30 days after «Ahora no», never once decided
//   enable         the SYSTEM prompt only here → granted → register() → the FCM token → api.register (PLAN §6b body) when the api exists
//   forget         sign-out / a uid switch: the server forgets THIS token (best effort, while the ID token is valid); the device drops it
//   taps           an order push opens THAT order (data.order_id); anything else does nothing (campaign targets: their own slice)
// Dark: `enabled` (the `push` runtime flag, native only) AND a native platform AND the plugin — else nothing touches the plugin.
// Rule 20: the token is never logged, never put in a URL; the device keeps it only to unregister it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappPush = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY = 'capp:push:v1';
  const SNOOZE_MS = 30 * 864e5;
  const PLATFORMS = ['ios', 'android'];
  const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;

  function createPush(o) {
    const plugin = o && o.plugin ? o.plugin : null, platform = o && PLATFORMS.includes(o.platform) ? o.platform : null;
    const now = typeof o.now === 'function' ? o.now : Date.now, storage = o.storage || null, api = o.api || null, appBuild = String(o.appBuild || '').slice(0, 32);
    const on = o.enabled === true && !!plugin && !!platform;
    const read = () => { try { const v = JSON.parse((storage && storage.getItem(KEY)) || 'null'); return v && v.v === 1 ? v : { v: 1 }; } catch (_) { return { v: 1 }; } };
    const write = (patch) => { try { if (storage) storage.setItem(KEY, JSON.stringify({ ...read(), ...patch, v: 1 })); } catch (_) {} };
    let offeredThisVisit = false;

    function shouldOffer({ ordersPlaced = 0 } = {}) {
      if (!on || offeredThisVisit || !(ordersPlaced >= 1)) return false;
      const s = read();
      if (s.state === 'granted' || s.state === 'denied') return false;
      return !(Number.isFinite(s.snoozed_at) && now() - s.snoozed_at < SNOOZE_MS);
    }
    const markOffered = () => { offeredThisVisit = true; };
    const snooze = () => { offeredThisVisit = true; write({ snoozed_at: now() }); };

    // the OS's answer to register(): the token, or null on registrationError — the one-shot listeners always removed
    function tokenOnce() {
      return new Promise((resolve) => {
        const handles = []; let done = false;
        const fin = (v) => { if (done) return; done = true; for (const h of handles) Promise.resolve(h).then((x) => x && typeof x.remove === 'function' && x.remove()).catch(() => {}); resolve(v); };
        handles.push(plugin.addListener('registration', (t) => fin(t && typeof t.value === 'string' && t.value ? t.value : null)));
        handles.push(plugin.addListener('registrationError', () => fin(null)));
        Promise.all(handles).then(() => plugin.register()).catch(() => fin(null));
      });
    }

    async function enable(prefs = {}) {
      if (!on) return { ok: false, reason: 'unavailable' };
      let st;
      try {
        st = (await plugin.checkPermissions()).receive;
        if (st === 'prompt' || st === 'prompt-with-rationale') st = (await plugin.requestPermissions()).receive;
      } catch (_) { return { ok: false, reason: 'error' }; }
      if (st !== 'granted') { write({ state: 'denied' }); return { ok: false, reason: 'denied' }; }
      const token = await tokenOnce();
      if (!token) return { ok: false, reason: 'registration_error' };
      write({ state: 'granted', token });
      if (!api || typeof api.register !== 'function') return { ok: true, server: null };
      let r = null;
      try { r = await api.register({ token, platform, app_build: appBuild, pedidos: prefs.pedidos !== false, promociones: prefs.promociones === true }); } catch (_) { r = null; }
      return { ok: !!(r && r.ok === true), server: r };
    }

    async function forget() {
      const tok = read().token;
      write({ token: null });
      if (!tok || !api || typeof api.unregister !== 'function') return { ok: true, server: null };
      try { return { ok: true, server: await api.unregister({ token: tok }) }; } catch (_) { return { ok: true, server: null }; }
    }

    function onTap(cb) {
      if (!on || typeof cb !== 'function') return () => {};
      const h = plugin.addListener('pushNotificationActionPerformed', (a) => {
        const d = a && a.notification && a.notification.data, id = d && typeof d.order_id === 'string' ? d.order_id : null;
        if (id && ORDER_ID.test(id)) cb({ kind: 'order', order_id: id });
      });
      return () => { Promise.resolve(h).then((x) => x && typeof x.remove === 'function' && x.remove()).catch(() => {}); };
    }

    const state = () => { const s = read(); return { state: s.state || 'never', snoozed_at: Number.isFinite(s.snoozed_at) ? s.snoozed_at : null, registered: !!s.token }; };
    return { available: () => on, shouldOffer, markOffered, snooze, enable, forget, onTap, state };
  }

  return { createPush, KEY, SNOOZE_MS };
});
