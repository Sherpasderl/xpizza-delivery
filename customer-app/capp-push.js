// Customer app — PUSH, the client core (PLAN-capp-push r1; owner 11-14: build now, «Pedidos» first; the server decides push-or-WhatsApp per
// event). Pure, UMD, brand-agnostic; no DOM (its UI is markup strings only). It wraps @capacitor/push-notifications (window.Capacitor.Plugins.PushNotifications, handed
// in as `plugin`) and owns ONLY the client's part:
//   the soft ask   never at first launch (a first order first), never twice in a visit, never once decided; after «Ahora no» it returns
//                  AT MOST TWICE, each ≥ 30 days after the last «Ahora no» (owner Q2, 11-14) — a third «Ahora no» ends it
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
  const RETURNS_MAX = 2;   // owner Q2 (MOCKUP-capp-push r1): the card comes back after «Ahora no» at most twice
  const PLATFORMS = ['ios', 'android'];
  const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const PENDING_MAX = 8;   // held invalidations (a token waiting for its server's confirmation) — the oldest beyond this are dropped

  function createPush(o) {
    const plugin = o && o.plugin ? o.plugin : null, platform = o && PLATFORMS.includes(o.platform) ? o.platform : null;
    // app_build: the server's own shape (3a customer-push vBuild: 1–32 of [A-Za-z0-9._+-]) — anything else is sent as 'unknown', never refused
    const ab = String(o.appBuild || ''), appBuild = /^[A-Za-z0-9._+-]{1,32}$/.test(ab) ? ab : 'unknown';
    const now = typeof o.now === 'function' ? o.now : Date.now, storage = o.storage || null, api = o.api || null;
    const on = o.enabled === true && !!plugin && !!platform;
    const read = () => { try { const v = JSON.parse((storage && storage.getItem(KEY)) || 'null'); return v && v.v === 1 ? v : { v: 1 }; } catch (_) { return { v: 1 }; } };
    const write = (patch) => { try { if (storage) storage.setItem(KEY, JSON.stringify({ ...read(), ...patch, v: 1 })); } catch (_) {} };
    let offeredThisVisit = false;
    // install_id (3a e73a605a2): THIS installation's stable id — made once, kept across sign-outs (forget never clears it); a new
    // install (or wiped app data) gets a new one. 16 random bytes, base64url (3a vInstall: 16–64 of [A-Za-z0-9_-])
    function installId() {
      const cur = read().install_id;
      if (typeof cur === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(cur)) return cur;
      const b = new Uint8Array(16), rnd = typeof o.random === 'function' ? o.random : (u) => globalThis.crypto.getRandomValues(u);
      rnd(b);
      const id = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      write({ install_id: id });
      return id;
    }

    function shouldOffer({ ordersPlaced = 0 } = {}) {
      if (!on || offeredThisVisit || !(ordersPlaced >= 1)) return false;
      const s = read();
      if (s.state === 'granted' || s.state === 'denied') return false;
      const n = Number.isSafeInteger(s.snoozes) ? s.snoozes : (Number.isFinite(s.snoozed_at) ? 1 : 0);
      if (n > RETURNS_MAX) return false;
      return !(Number.isFinite(s.snoozed_at) && now() - s.snoozed_at < SNOOZE_MS);
    }
    const markOffered = () => { offeredThisVisit = true; };
    const snooze = () => { offeredThisVisit = true; const s = read(); write({ snoozed_at: now(), snoozes: (Number.isSafeInteger(s.snoozes) ? s.snoozes : 0) + 1 }); };

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

    // ctx.owner: the uid the token is registered FOR (Codex r1 P1-1) — kept with the token; the api gets it with every call so the
    // shell sends only with THAT person's ID token
    async function enable(prefs = {}, ctx = {}) {
      if (!on) return { ok: false, reason: 'unavailable' };
      let st;
      try {
        st = (await plugin.checkPermissions()).receive;
        if (st === 'prompt' || st === 'prompt-with-rationale') st = (await plugin.requestPermissions()).receive;
      } catch (_) { return { ok: false, reason: 'error' }; }
      if (st !== 'granted') { write({ state: 'denied' }); return { ok: false, reason: 'denied' }; }
      const token = await tokenOnce();
      if (!token) return { ok: false, reason: 'registration_error' };
      const owner = typeof ctx.owner === 'string' && ctx.owner ? ctx.owner : null;
      write({ state: 'granted', token, owner, server: null });   // server null = not acknowledged ⇒ never «registered» (Codex r1 P2-5)
      if (!api || typeof api.register !== 'function') return { ok: false, reason: 'no_server' };
      let r = null;
      try { r = await api.register({ token, platform, app_build: appBuild, install_id: installId(), pedidos: prefs.pedidos !== false, promociones: prefs.promociones === true }, { owner }); } catch (_) { r = null; }
      const ok = !!(r && r.ok === true);
      if (read().token === token) write({ server: ok });   // a token the server did not take is never shown as «activados» — the next enable retries
      return { ok, server: r };
    }

    // the OS permission NOW (the customer may have changed it in Ajustes): denied ⇒ remembered; allowed again after a denial ⇒ the
    // denial is cleared. A denial is UI state ONLY (Codex r1 P1-3): the token stays — it is the handle a sign-out invalidates; only a
    // completed invalidation (forget) ever drops it. Allowed again with that registration intact ⇒ opted in again, no new prompt
    async function permission() {
      if (!on) return null;
      let st = null; try { st = (await plugin.checkPermissions()).receive; } catch (_) { return null; }
      const s = read();
      if (st === 'denied' && s.state !== 'denied') write({ state: 'denied' });
      else if (st !== 'denied' && s.state === 'denied') write({ state: s.token && s.server === true ? 'granted' : null });
      return st;
    }

    // consent is the PERSON's (owner Q4): a sign-out also ends this device's opt-in — the next member opts in for themselves (an OS
    // denial stays: it is the phone's)
    // Codex r1 P1-2: the live token moves into a DURABLE pending record (token + owner) BEFORE anything is sent, so an app closed
    // mid-way loses nothing; then the phone's invalidation (FCM delete / APNs unregister) and the server's run IN PARALLEL — the phone
    // never waits on the server. A record leaves only when the server confirms; settle() retries it (the next boot). ok = both done
    const pendingOf = (s) => (Array.isArray(s.pending) ? s.pending.filter((p) => p && typeof p.token === 'string' && p.token) : []);
    async function forget() {
      const s0 = read(), pend = pendingOf(s0);
      if (s0.token) pend.push({ token: s0.token, owner: typeof s0.owner === 'string' ? s0.owner : null, native: false });
      write({ token: null, owner: null, server: null, pending: pend.slice(-PENDING_MAX), ...(s0.state === 'granted' ? { state: null } : {}) });
      return settle();
    }
    async function settle() {
      const pend = pendingOf(read());
      if (!pend.length) return { ok: true, server: null };
      // the phone holds ONE token: invalidate it only while no newer live token exists (never kill the next opt-in's)
      const nativeOwed = pend.some((p) => p.native !== true), nativeP = !nativeOwed ? Promise.resolve(true)
        : !on || read().token ? Promise.resolve(false)
        : Promise.resolve().then(() => plugin.unregister()).then(() => true, () => false);
      const mine = new Set(pend.map((p) => p.token));
      // the phone's result is durable the moment it lands — never held hostage by a server that may never answer
      nativeP.then((ok) => { if (ok) write({ pending: pendingOf(read()).map((p) => (mine.has(p.token) ? { ...p, native: true } : p)) }); });
      const owed = pend.filter((p) => p.server !== true);
      const serverP = Promise.all(owed.map((p) => (api && typeof api.unregister === 'function'
        ? Promise.resolve().then(() => api.unregister({ token: p.token }, { owner: p.owner })).then((r) => r, () => null) : Promise.resolve(null))));
      const [nativeOk, rs] = await Promise.all([nativeP, serverP]);
      const done = new Set(owed.filter((p, i) => rs[i] && rs[i].ok === true).map((p) => p.token));
      const left = pendingOf(read()).map((p) => (mine.has(p.token) ? { ...p, native: p.native === true || nativeOk, server: p.server === true || done.has(p.token) } : p))
        .filter((p) => !(p.native === true && p.server === true));
      write({ pending: left });
      return { ok: nativeOk && done.size === owed.length, native: nativeOk, server: rs.length ? rs[rs.length - 1] : null };
    }

    function onTap(cb) {
      if (!on || typeof cb !== 'function') return () => {};
      const h = plugin.addListener('pushNotificationActionPerformed', (a) => {
        const d = a && a.notification && a.notification.data, id = d && typeof d.order_id === 'string' ? d.order_id : null;
        if (id && ORDER_ID.test(id)) cb({ kind: 'order', order_id: id });
      });
      return () => { Promise.resolve(h).then((x) => x && typeof x.remove === 'function' && x.remove()).catch(() => {}); };
    }

    const state = () => { const s = read(); return { state: s.state || 'never', snoozed_at: Number.isFinite(s.snoozed_at) ? s.snoozed_at : null, registered: !!s.token && s.server === true }; };
    // whose the live token is, and how many invalidations are still owed (the shell's auth hook and boot retry read these)
    const held = () => { const s = read(); return { owner: s.token && typeof s.owner === 'string' ? s.owner : null, live: !!s.token, pending: pendingOf(s).length }; };
    return { available: () => on, shouldOffer, markOffered, snooze, enable, permission, forget, settle, held, onTap, state };
  }

  // the push UI copy — OWNER-APPROVED (MOCKUP-capp-push r1 + the Q1–Q6 rulings, 11-14); every string pinned by the SHIP GATE cell.
  // offersSub is the push-offers CONSENT text: 3a's PUSH_OFFERS_COPY_VERSION bumps whenever it changes (PUSH-COPY-VERSION pins the pair)
  const COPY = Object.freeze({
    askTitle: '¿Te avisamos cómo va tu pedido?', askOn: 'Activar avisos', askLater: 'Ahora no', toastOn: 'Avisos activados',
    orderLinePush: 'Te avisamos con una notificación',
    screenTitle: 'Notificaciones', ordersTitle: 'Mis pedidos', ordersSub: 'Cuando cambie el estado', offersTitle: 'Ofertas de Sherpa', offersSub: 'Promociones de los restaurantes',
    deniedTitle: 'Avisos apagados', deniedSub: 'Activalos en Ajustes del teléfono.', deniedAct: 'Abrir Ajustes',
    rowNone: 'Estado del pedido por WhatsApp', rowOrders: 'Mis pedidos activados', rowBoth: 'Mis pedidos · Ofertas de Sherpa', rowDenied: 'Apagadas en tu teléfono',
  });
  const COPY_PENDING = Object.freeze([]);

  // ── the push UI (MOCKUP-capp-push r1, owner-approved 11-14): markup only, every string from COPY; the shell owns state and taps ──
  const SVG = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const ICON = Object.freeze({
    bell: SVG('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),
    tag: SVG('<path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>'),
    off: SVG('<path d="M8.6 6.4A6 6 0 0 1 18 11v5l1.5 2H9"/><path d="M6 11v5l-1.5 2H5"/><path d="M10 20a2 2 0 0 0 4 0"/><path d="M4 4l16 16"/>'),
    back: SVG('<path d="M19 12H5"></path><path d="M11 18l-6-6 6-6"></path>'),
  });
  // frame 1: the soft card on «Pedido recibido», under the status line (card A, no sub-line — owner Q1)
  const askHtml = () => `<div class="px-ask" role="group" aria-label="Avisos de tu pedido"><div class="hd"><span class="ic">${ICON.bell}</span><div class="t"><b>${COPY.askTitle}</b></div></div><div class="acts"><button class="primary" data-act="push-on">${COPY.askOn}</button><button class="btn2" data-act="push-later">${COPY.askLater}</button></div></div>`;
  // frame 4: the Cuenta row's subtitle — { granted, denied, pedidos, promociones }
  function rowSub(v) {
    const x = v || {};
    if (x.denied) return COPY.rowDenied;
    if (x.granted && x.pedidos === true) return x.promociones === true ? COPY.rowBoth : COPY.rowOrders;
    if (x.granted && x.promociones === true) return COPY.offersTitle;   // advisor 11-14: offers alone ⇒ «Ofertas de Sherpa» (no WhatsApp talk)
    return COPY.rowNone;
  }
  // frame 2: the «Notificaciones» screen — two switches (the switch IS the consent, owner Q4); OS denied ⇒ the quiet card + «Abrir
  // Ajustes» (owner Q5) and both switches dimmed, off, inert
  function screenHtml(v) {
    const x = v || {}, dn = !!x.denied;
    const row = (k, ic, t, sub, on) => dn
      ? `<div class="rowbtn" aria-disabled="true">${ic}<span class="t">${t}<span>${sub}</span></span><span class="switch" role="switch" aria-checked="false" aria-disabled="true"></span></div>`
      : `<div class="rowbtn">${ic}<span class="t">${t}<span>${sub}</span></span><button class="switch" role="switch" aria-checked="${on === true}" aria-label="${t}" data-act="push-pref" data-k="${k}"${x.busy ? ' aria-disabled="true"' : ''}></button></div>`;
    const quiet = dn ? `<div class="px-quiet"><span class="ic">${ICON.off}</span><div class="t"><b>${COPY.deniedTitle}</b><span>${COPY.deniedSub}</span><button class="lnk" data-act="push-settings">${COPY.deniedAct}</button></div></div>` : '';
    return `<div class="topbar"><button class="iconbtn" data-act="notifs-back" aria-label="Volver">${ICON.back}</button><h1>${COPY.screenTitle}</h1><span class="sp"></span></div><div class="scroller">${quiet}<div class="rows">${row('pedidos', ICON.bell, COPY.ordersTitle, COPY.ordersSub, x.pedidos)}${row('promociones', ICON.tag, COPY.offersTitle, COPY.offersSub, x.promociones)}</div></div>`;
  }
  return { createPush, KEY, SNOOZE_MS, RETURNS_MAX, COPY, COPY_PENDING, ICON, askHtml, rowSub, screenHtml };
});
