// Customer app S1b (PLAN-capp-S1.FINAL §1) — the STORE page, the ITEM SHEET and the CART SHEET, ported from the frozen
// prototype APPROVED-v6 (storeHtml / rowHtml / overlayHtml / wireStore / renderDetail / detailAct / saveEdit / cartInner …) onto
// the S1 modules: capp-menu (the served getPublicMenu envelope), capp-cart (the per-instance cart) and capp-serialize (the
// 1,500-character limit). Brand-agnostic: every restaurant difference is DATA (the envelope + the store config) — no restaurant
// id or name in this file (guarded). Ships DARK.
//
// mount(doc, { envelope, config, unavailable, now, onEvent })
//   config: { name, kicker, logo, logoWide, hero, unit: [singular, plural], hours: [ [h1,m1,h2,m2] | null ×7 (Sun..Sat) ],
//             addr, etaDel: [a,b], etaPick: [a,b], feeFromCents: int | null, assetBase: string | null, entry: 'app' | 'link' }
//   unavailable: the LIVE availability — a Set of sold-out dish keys (the host mutates it) or a function key → bool; read at render
//                AND at action time, never snapshotted (the live reader itself is wired by the host)
//   onEvent(name, detail): the controls whose screens land in later slices — 'back' (the in-app close X, S7), 'checkout' (S2),
//                          'schedule' (S2) — are host events, never dead buttons.
//
// S2b — the CHECKOUT UI (prototype APPROVED-v6 checkoutHtml / tipHtml / placingHtml / sendingHtml / pinStepHtml / errSheet + the
// approved Q9 mockup's refund and existing-order sheets) over the S2a modules: capp-checkout (the flow model, gates, totals) and
// capp-api (the transport). A minimal screen router: S.screen = 'store' | 'checkout' | 'tip' | 'sending' (the «Realizando
// pedido…» card is a LAYER over checkout / tip, as in the prototype). Every screen renders inside <div class="screen">.
//   more config (all optional DATA): restaurantId, orderIdPrefix, pendingPayKey, endpoints { quoteOrder, createOrder,
//             chargeOnlineOrder, paymentStatus } (the capp-api config), branch (the «· sucursal» suffix), loc { lat, lng } (the
//             branch pin: the geo-denied fallback), zoneKm (fallback for the quote's max_km), mapsKey (a Google Maps JS key: a
//             real map inside the drawn map chrome; absent ⇒ the prototype's schematic map)
//   more opts: CappCheckout, CappApi (default window.CappCheckout / window.CappApi), apiOpts (extra createApi options — tests
//             script the server through apiOpts.fetch / storage), api (a prebuilt transport), member (the optional signed-in
//             context, capp-checkout's shape), geolocation (default navigator.geolocation), navigate(url) (default
//             location.assign), search (default location.search — a ?pay= hosted-checkout return), timers { setTimeout,
//             clearTimeout, setInterval, clearInterval }, priceSheet (default the ported confirmPriceSheet)
//   more host events: 'placed' (the outcome), 'home' (the refund sheet), 'signin' («¿Ya tenés cuenta? Entrá»), 'pay-cash'
//             («Pago no completado» → «Pagar en efectivo»; ruling pending)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappUI = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const money = (n) => 'L ' + Math.round(n).toLocaleString('en-US');
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtT = (h, m) => `${((h + 11) % 12) + 1}:${pad2(m)} ${h < 12 ? 'a.m.' : 'p.m.'}`;
  const fmtMin = (mins) => fmtT(Math.floor(mins / 60) % 24, mins % 60);
  const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  // S2-checkout: the status poll while the bank answers / a review is open (the contract names no client interval — proposed values)
  const POLL_SDK_MS = 3000, POLL_SDK_REVIEW_MS = 15000;
  // advisor 11-08: a long bank delay never hammers the server — after the first minute of pending (20 polls at 3 s) every 10 s
  const POLL_SDK_SLOW_MS = 10000, POLL_SDK_FAST_N = 20;
  const FULL_CART = 'Tu carrito está lleno. Empezá otro carrito con el resto de tu pedido.';   // owner-approved 2026-10-24 (cart_text_too_long)

  // ── icons (the prototype's, one stroke, one weight) ──
  const I = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const IC = {
    close: I('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'), search: I('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
    menu: I('<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h10"/>'), check: I('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    bag: I('<path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'), clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    info: I('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'), alert: I('<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>'),
    update: I('<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>'),   // MOCKUP-capp-native-store-update (owner-approved): an arrow into a tray
    bike: I('<circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M8.5 17h7"/><path d="M14 6h3l2.5 8.5"/><path d="M4 11h7l2 6"/>'),
    // S2b (the prototype's IC, verbatim)
    back: I('<path d="M19 12H5"/><path d="M11 18l-6-6 6-6"/>'), chev: I('<path d="M9 6l6 6-6 6"/>'), down: I('<path d="M6 9l6 6 6-6"/>'), up: I('<path d="m18 15-6-6-6 6"/>'),
    plus: I('<path d="M12 5v14"/><path d="M5 12h14"/>'), home: I('<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/>'),
    user: I('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'), pin: I('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.6"/>'),
    pinfill: '<svg width="38" height="38" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/></svg>',
    store: I('<path d="M4 9.5V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9.5"/><path d="M2.5 9.5 4.1 4a1 1 0 0 1 1-.7h13.8a1 1 0 0 1 1 .7l1.6 5.5a2.5 2.5 0 0 1-4.8 1.2 2.5 2.5 0 0 1-4.8 0 2.5 2.5 0 0 1-4.8 0 2.5 2.5 0 0 1-4.8-1.2Z"/><path d="M9 21v-5h6v5"/>'),
    card: I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>'), cash: I('<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9h.01M18 15h.01"/>'),
    locoff: I('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><path d="M4 4l16 16"/>'),
    // PLAN-capp-signin-required (approved mockup 2026-10-27): the chat bubble (frames 3a/3b) and the lock (frame 4), one stroke
    chat: I('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/>'), lock: I('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  };
  const BKSP = I('<path d="M9 5h11a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-6-7z"/><path d="m12 9 5 5"/><path d="m17 9-5 5"/>');
  // the tip step's rider (prototype RIDER :1918-1952, verbatim) and the sending screen's live variant (RIDER_LIVE :2023-2026)
  const RIDER = `<svg class="rider" viewBox="0 0 360 210" aria-hidden="true">
  <defs><clipPath id="skyclip"><rect x="0" y="62" width="360" height="110" rx="18"/></clipPath></defs>
  <!-- skyline band: tints of the Cuadra blue→teal promo family -->
  <rect x="0" y="62" width="360" height="110" rx="18" fill="var(--il-sky-a)"/>
  <g clip-path="url(#skyclip)">
    <g fill="var(--il-sky-c)"><rect x="18" y="104" width="30" height="70"/><rect x="66" y="92" width="22" height="82"/><rect x="118" y="98" width="44" height="76"/><rect x="206" y="84" width="26" height="90"/><rect x="258" y="100" width="22" height="74"/><rect x="304" y="94" width="36" height="80"/></g>
    <g fill="var(--il-sky-b)"><rect x="0" y="122" width="42" height="52"/><rect x="94" y="116" width="32" height="58"/><rect x="170" y="110" width="24" height="64"/><rect x="236" y="120" width="40" height="54"/><rect x="322" y="112" width="38" height="62"/></g>
    <g fill="var(--il-sky-a)" opacity=".9"><rect x="8" y="130" width="5" height="6"/><rect x="18" y="130" width="5" height="6"/><rect x="8" y="142" width="5" height="6"/><rect x="102" y="124" width="5" height="6"/><rect x="112" y="124" width="5" height="6"/><rect x="102" y="136" width="5" height="6"/><rect x="244" y="128" width="5" height="6"/><rect x="254" y="128" width="5" height="6"/><rect x="332" y="120" width="5" height="6"/><rect x="342" y="120" width="5" height="6"/><rect x="332" y="132" width="5" height="6"/></g>
  </g>
  <!-- ground shadow -->
  <ellipse cx="186" cy="186" rx="132" ry="6" fill="var(--ink)" opacity=".09"/>
  <!-- rear wheel -->
  <circle cx="100" cy="162" r="24" fill="var(--il-tyre)"/><circle cx="100" cy="162" r="13" fill="var(--surf2)"/><circle cx="100" cy="162" r="4" fill="var(--il-tyre)"/>
  <!-- scooter: rear cowl, rack, box, floorboard, seat -->
  <path d="M78 150 C70 118 100 104 150 108 L176 108 C186 124 182 150 170 150 Z" fill="var(--acc)"/>
  <rect x="52" y="118" width="62" height="6" rx="3" fill="var(--il-tyre)"/>
  <rect x="72" y="62" width="18" height="10" rx="5" fill="var(--pop-fill)"/><rect x="50" y="70" width="62" height="50" rx="8" fill="var(--pop-fill)"/><path d="M50 78 a8 8 0 0 1 8 -8 h46 a8 8 0 0 1 8 8 v6 H50 Z" fill="var(--pop-bg)"/>
  <rect x="132" y="148" width="94" height="14" rx="7" fill="var(--acc)"/>
  <rect x="110" y="96" width="72" height="14" rx="7" fill="var(--ink)"/>
  <!-- rider legs (behind the leg shield), shoe on the floorboard -->
  <path d="M166 104 L200 122 L204 150" fill="none" stroke="var(--il-pants)" stroke-width="15" stroke-linecap="round" stroke-linejoin="round"/>
  <ellipse cx="208" cy="153" rx="11" ry="5" fill="var(--ink)"/>
  <!-- leg shield, fork, front wheel, fender, handlebar, mirror -->
  <path d="M212 160 C236 136 240 106 244 80 L264 80 C260 110 254 142 236 162 Z" fill="var(--acc)"/>
  <path d="M254 86 L270 158" stroke="var(--acc)" stroke-width="10" stroke-linecap="round"/>
  <circle cx="272" cy="162" r="24" fill="var(--il-tyre)"/><circle cx="272" cy="162" r="13" fill="var(--surf2)"/><circle cx="272" cy="162" r="4" fill="var(--il-tyre)"/>
  <path d="M240 150 A32 32 0 0 1 304 150 L296 154 A24 24 0 0 0 248 154 Z" fill="var(--acc)"/>
  <rect x="230" y="70" width="46" height="9" rx="4.5" fill="var(--ink)"/><circle cx="266" cy="92" r="6" fill="var(--surf2)"/>
  <path d="M268 70 L278 58" stroke="var(--ink)" stroke-width="2.5" stroke-linecap="round"/><circle cx="279" cy="56" r="4.5" fill="var(--ink)"/>
  <!-- rider: jacket, arm + hand, head, helmet + visor -->
  <path d="M140 108 C132 84 140 58 156 52 L180 56 C190 76 190 98 182 110 Z" fill="var(--il-jacket)"/>
  <path d="M174 64 L250 76" fill="none" stroke="var(--il-jacket)" stroke-width="13" stroke-linecap="round"/><circle cx="252" cy="76" r="6.5" fill="var(--il-skin)"/>
  <circle cx="176" cy="40" r="15" fill="var(--il-skin)"/>
  <path d="M157 42 A19 19 0 0 1 195 42 L195 46 L157 46 Z" fill="var(--ink)"/><rect x="180" y="38" width="17" height="10" rx="4" fill="var(--acc)"/>
</svg>`;
  const RIDER_LIVE = RIDER.replace('class="rider"', 'class="rider live"')
    .replace(/(<circle cx="(100|272)" cy="162" r="24"[^>]*\/><circle cx="\2" cy="162" r="13"[^>]*\/>)(<circle cx="\2" cy="162" r="4"[^>]*\/>)/g, (m, rims, cx, hub) => `<g class="wh" style="transform-origin:${cx}px 162px">${rims}<path d="M${cx} 150v24M${Number(cx) - 12} 162h24" stroke="var(--il-tyre)" stroke-width="2.4" stroke-linecap="round"/>${hub}</g>`)
    .replace('<!-- rear wheel -->', '<g class="speed" aria-hidden="true"><path d="M14 118h40"/><path d="M4 136h30"/><path d="M20 152h44"/></g><g class="mover">')
    .replace('</svg>', '</g></svg>');
  const CHECK_OK = `<span class="sok">${IC.check}</span>`;
  // the schematic map (prototype mapSvg :1796-1806) — the fallback when no Maps key is configured. capp-dark (PLAN §3): its colours are
  // the --map-* tokens (light = v6's light values, dark = v6 mapSvg's dark branch; capp.css), via inline style so the OS theme flips it
  // live — never a hex literal here
  const MAP_SVG = (() => {
    const road = 'var(--map-road)', minor = 'var(--map-minor)', park = 'var(--map-park)', water = 'var(--map-water)';
    return `<svg class="mapsvg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <rect x="62" y="56" width="30" height="26" rx="3" style="fill:${park}"/><path d="M-5 92 C 20 80, 40 96, 70 86 S 100 76, 110 84 L110 110 L-5 110 Z" style="fill:${water}"/>
    <g style="stroke:${minor}" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke">${[10, 34, 56, 78].map((y) => `<path d="M-5 ${y}H105"/>`).join('')}${[10, 36, 62, 86].map((x) => `<path d="M${x} -5V105"/>`).join('')}</g>
    <g style="stroke:${road}" stroke-width="3.4" stroke-linecap="round" fill="none">${[22, 50, 74].map((x) => `<path d="M${x} -5V105"/>`).join('')}${[22, 42, 64].map((y) => `<path d="M-5 ${y}H105"/>`).join('')}<path d="M-5 100 L45 60 L105 20"/></g></svg>`;
  })();
  // the «confirming» line on the approved «Enviando tu pedido…» screen (Q9, no sheet, no button)
  const CONFIRMING_HINT = 'Estamos confirmando tu pago con el banco.';
  const CART_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M1 1h3l2 11h11l2-7H6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="20" r="1.5" fill="currentColor"/><circle cx="17" cy="20" r="1.5" fill="currentColor"/></svg>';
  const TRASH = (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 3h12M5 3V2h4v1M2 3l1 9h6l1-9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  // the catalog's own marks (the prototype's priority + colours); the LABEL is the served one when the envelope carries badges
  const BADGE_PRIORITY = ['signature_special', 'chefs_pick', 'must_try', 'crowd_favourite'];
  const BADGE_FALLBACK = { signature_special: 'Especial de la casa', chefs_pick: 'Selección del chef', must_try: 'Imperdible', crowd_favourite: 'Favorito' };

  // ── the view model: the served menu as the prototype's item shape (S7a-2: shared with the shell's Inicio / Buscar, so a search hit
  //    is exactly an item the store displays — launchers priced «desde», never a raw variant child; `dish` = the canonical dish id) ──
  // «Volver a pedir» (advisor ruling 2026-11-02): THE store's cart-write path, ONE implementation. The mounted store edits its cart
  // through these functions and guards, and the shell's «+» / reorder (no store on screen) go through the very same ones — so their
  // safety is by construction a customer's tap inside the store. No new cross-tab guarantee is claimed beyond that.
  // apiConfigOf: the store's transport config (the ONE source — the store's own api and the shell's are built from it)
  function apiConfigOf(cfg) {
    return { restaurantId: cfg.restaurantId, orderIdPrefix: cfg.orderIdPrefix, pendingPayKey: cfg.pendingPayKey, endpoints: cfg.endpoints, hours: cfg.hours,
      cartKey: cfg.cartKey, placedKey: cfg.placedKey, guestCardOnly: cfg.guestCardOnly === true, ...(cfg.schedulingLive === true ? { schedulingLive: true } : {}) };   // S7a-1: hosted by the shell (both absent ⇒ the S2 path, unchanged); §3.2 the guest tender rule
  }
  // the cart, its generation and every guard on it: o = { menu, cfg, api: () => the store's api, mods: () => true once it exists,
  // CappCart, CappSerialize } — the deps are the CALLER's resolved ones (Codex VP r5 #1: never globals), else the same resolution
  function createCartCore(o) {
    const { menu, cfg } = o, api = () => o.api(), mods = () => o.mods();
    const CappCart = o.CappCart || (typeof self !== 'undefined' && self.CappCart) || require('./capp-cart.js');
    const CappSerialize = o.CappSerialize || (typeof self !== 'undefined' && self.CappSerialize) || require('./capp-serialize.js');
    const hosted = !!(cfg.cartKey && cfg.placedKey);
    // S7a r3.4-1: a HOSTED cart (the shell's per-store keys) records each instance's last-seen prices, so a cart restored onto a
    // re-priced menu is DISCLOSED (frame 13); the S2 / link path keeps today's byte-identical snapshots
    const cart = CappCart.createCart(menu, hosted ? { provenance: true } : undefined);
    // S7a-1 (PLAN-capp-S7a r2 §1.4; Codex r2 New 1): hosted ⇒ the cart's GENERATION — re-minted whenever the cart starts empty (or a
    // restore found it purchased and cleared), restored with a snapshot, carried with every placement and every persisted snapshot
    let gen = null;
    const genNow = () => { const a = api(); if (!gen && a && typeof a.newGen === 'function') gen = a.newGen(); return gen; };
    // S7a-1 r3 §1.1 (Codex r1 P2-7): hosted ⇒ a cart frozen for a placement — or whose freeze state is unknown — is READ-ONLY
    function frozenNow() {
      if (!hosted) return false;
      if (!mods() || !api().hosted) return true;
      const rc = api().reconcile(); if (!rc.ok) return true;
      return api().cartFreeze().frozen === true;
    }
    function lockedHere() {
      if (!hosted) return false;
      if (!mods() || !api().hosted) return true;
      const a = api(), rc = a.reconcile(); if (!rc.ok) return true;
      const fz = a.cartFreeze();
      return !!(fz.unknown || (fz.frozen && fz.live) || (typeof a.holdsLock === 'function' && a.holdsLock()));
    }
    // a mutation: refused when not orderable or frozen; a write the cart refuses changes nothing; one that would push the order text past
    // the server's cap is REVERTED ({ tooLong }) — the caller draws the owner-approved line
    function mutate(fn, orderable) {
      if (!orderable || frozenNow()) return { ok: false };
      const before = cart.snapshot();
      try { fn(cart); } catch (_) { return { ok: false }; }
      if (cart.count()) {
        try { CappSerialize.serialize(cart, menu); } catch (e) {
          if (e && e.code === 'cart_text_too_long') { cart.hydrate(before); return { ok: false, tooLong: true }; }
        }
      }
      if (!cart.count()) gen = null;   // an emptied cart: the next one is a NEW cart (a new generation)
      return { ok: true };
    }
    // what is persisted (the shell's onCartChange) and what the store's snapshot() returns
    const snapshotFor = (mode) => ({ ...cart.snapshot(), rid: cfg.restaurantId, mode, ...(hosted ? { cart_gen: cart.count() ? genNow() : null } : {}) });
    // S7a-1 r3 §1.3 (hosted): reconcile FIRST — blocked until it completes; a purchased (cleared) cart is never restored
    function restore(snapshot) {
      let mode = null;
      if (hosted && mods() && api().hosted) {
        const rc = api().reconcile(); if (!rc.ok) return { blocked: true, step: rc.step };
        if (rc.done === 'placed' && snapshot && snapshot.cart_gen && snapshot.cart_gen === rc.cart_gen) {
          // Codex r3 #1: the PURCHASED lines are cleared from memory too, BEFORE the generation is released — a new generation is
          // only ever minted for an empty cart, so purchased lines can never be disguised as a new cart
          cart.hydrate({ v: 2, lines: [] }); gen = null; return { cleared: true };
        }
        gen = snapshot && typeof snapshot.cart_gen === 'string' && snapshot.cart_gen ? snapshot.cart_gen : null;   // the restored cart keeps its generation
        // Codex r1 P2-7: the persisted mode is restored with the lines (a frozen pickup cart is never re-shown as delivery)
        if (snapshot && (snapshot.mode === 'pickup' || snapshot.mode === 'delivery')) mode = snapshot.mode;
      }
      return { hydrated: cart.hydrate(snapshot), mode };
    }
    return { cart, genNow, frozenNow, lockedHere, mutate, snapshotFor, restore, hosted };
  }

  function viewSections(menu, cfg) {
    // F1: the served photo first (card on rows/cards, hero on the sheet); assetBase + dish.img ONLY on a legacy payload — on a
    // photo-capable one the served map is authoritative and a dish it leaves out has no photo (Codex r2 P2-3: never resurrect a removal)
    const photo = (d, size = 'card') => (d && d.photo ? d.photo[size] : !menu.photosAuthoritative && d && d.img && cfg.assetBase ? cfg.assetBase.replace(/\/?$/, '/') + String(d.img).replace(/^\.?\//, '') : '');
    const exOf = (k) => menu.extrasFor(k).filter((e) => e.supported).map((e) => e.key);
    const itemOf = (d) => {
      const g = menu.groups[d.key];
      const it = { id: d.key, n: d.name, d: d.desc, p: d.price, img: photo(d), hero: photo(d, 'hero'), tags: d.tags || [], ex: exOf(d.key), cat: d.cat, dish: d.dish_id };
      if (g) it.group = { label: g.label, choices: g.choices.map((ck) => { const c = menu.dish(ck); return { id: c.key, choice: c.choice || c.name, p: c.price, n: c.name, ex: exOf(c.key) }; }) };
      return it;
    };
    return menu.categories.map((c) => {
      const cid = String(c.id);
      const items = menu.dishes.filter((d) => String(d.cat) === cid && !d.variantOf).map(itemOf);
      const pick = menu.pickupOnlyCats.has(cid), wknd = menu.weekendOnlyCats.has(cid);
      return { id: cid, name: c.name != null ? c.name : cid, items, pickupOnly: pick, note: pick && wknd ? 'Solo viernes a domingo · para recoger' : '' };
    }).filter((s) => s.items.length);
  }

  // the Google Maps JS loader — ONE load per window, shared by every mount and the shell's pin editor (S7a-2); no key ⇒ null
  function loadMapsFor(doc, key) {
    if (!key) return null;
    const w = doc && doc.defaultView; if (!w) return null;
    if (w.google && w.google.maps && w.google.maps.Map) return Promise.resolve(w.google.maps);
    if (w.__cappMapsP) return w.__cappMapsP;
    w.__cappMapsP = new Promise((resolve, reject) => {
      w.__cappMapsReady = () => resolve(w.google.maps);
      const s = doc.createElement('script'); s.async = true;
      s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&loading=async&callback=__cappMapsReady';
      s.onerror = () => { w.__cappMapsP = null; reject(new Error('maps_load_failed')); };
      doc.head.appendChild(s);
    });
    return w.__cappMapsP;
  }

  // the app's error sheet (.errsheet) — also the shell's (S7a-2 frame 15)
  function errSheetHtml(e) {
    const acts = e.acts.map((a) => `<button class="${a.primary ? 'primary' : 'btn2 wide'}" data-act="${a.act}"${a.disabled ? ' disabled' : ''}${a.id ? ` id="${a.id}"` : ''}>${esc(a.label)}</button>`).join('');
    const ic = e.ic ? IC[e.ic] : e.icon === 'ok' ? IC.check : e.icon === 'warn' || e.icon === 'calm' ? IC.alert : IC.close;
    return `<div class="scrim"></div><div class="sheet" role="alertdialog" aria-label="${esc(e.title)}"><div class="grab"></div><div class="errsheet"><div class="icon${e.icon ? ' ' + e.icon : ''}">${ic}</div><h2>${esc(e.title)}</h2><p>${e.bodyHtml != null ? e.bodyHtml : esc(e.body)}</p>${e.note ? `<p class="note">${e.note}</p>` : ''}<div class="acts">${acts}</div></div></div>`;
  }
  function mount(doc, opts) {
    const CappMenu = opts.CappMenu || (typeof self !== 'undefined' && self.CappMenu) || require('./capp-menu.js');
    const CappCart = opts.CappCart || (typeof self !== 'undefined' && self.CappCart) || require('./capp-cart.js');
    const CappSerialize = opts.CappSerialize || (typeof self !== 'undefined' && self.CappSerialize) || require('./capp-serialize.js');
    const menu = CappMenu.adaptMenu(opts.envelope);
    const cfg = opts.config || {};
    const unavailable = opts.unavailable || new Set();
    // Codex perf-core r2 #6: a DISPATCH REFUSAL is kept as presentation state — the dishes the fresh read refused stay sold for the
    // whole UI (frame 14's note, mark, Subtotal, CTA and + gates), for Set AND function hosts alike, until the host signals a newer
    // AUTHORITATIVE availability update (ui.availabilityUpdated()) or the customer removes that dish's lines
    const refused = new Set();
    const hostSoldOf = (key) => { try { return typeof unavailable === 'function' ? !!unavailable(key) : unavailable.has(key); } catch (_) { return false; } };
    const soldOf = (key) => refused.has(key) || hostSoldOf(key);
    const now = opts.now || (() => new Date());
    // S7a-2 (PLAN-capp-S7a r3.3-F2, APPROVED): a store mounted on a PRESENTATION body (the stored menu, not yet re-verified) is
    // BROWSE-ONLY — every ordering control is inert with the existing disabled attribute, no geometry change, and every cart
    // mutation and the checkout entry are refused; setOrderable(true) (the verified body arrived) turns them live IN PLACE
    let orderable = opts.orderable !== false;
    let dead = false;   // S2b r1 P2-3: destroy() ⇒ every later callback of this instance is a no-op
    const emit = (name, detail) => { if (dead) return; try { (opts.onEvent || (() => {}))(name, detail); } catch (_) {} };
    // S7a-1 (PLAN-capp-S7a r2 §1.6): the shell's per-store cart persistence hook — after a SUCCESSFUL mutation, a restore and a
    // delivery/pickup change; a throwing hook never affects the UI; absent ⇒ nothing is called
    const notifyCart = () => { if (dead || typeof opts.onCartChange !== 'function' || frozenNow()) return; try { opts.onCartChange(core.snapshotFor(S.mode)); } catch (_) {} };
    const hostedKeys = () => !!(cfg.cartKey && cfg.placedKey);
    // the cart, its generation and its guards: the ONE cart-write path (createCartCore — the shell's «+» / reorder use it too)
    const core = createCartCore({ menu, cfg, api: () => api, mods: () => mods(), CappCart, CappSerialize });
    const cart = core.cart, genNow = () => core.genNow();
    const $ = (id) => doc.getElementById(id);
    const app = $('app');
    // PLAN-capp-desktop-website r2 D-2: the host's viewport (capp-view.js) — DESKTOP ⇒ the APPROVED v6 desk view's DOM (the store's
    // deskcart aside, the checkout's col-b); no view handed over (the single-store page, every phone) ⇒ byte-identical to before
    const view = opts.view && typeof opts.view.desk === 'function' ? opts.view : null;
    const S = { desk: view ? !!view.desk() : false, mode: 'delivery', expanded: new Set(), open: null, layerKind: null, cartNote: null, refusal: null, activeSec: '', searchQ: '', entry: cfg.entry === 'app' ? 'app' : 'link',
      // S2b
      screen: 'store', stack: [], flow: null, q: null, qKey: null, askedKey: null, outZone: false, closedRefused: false, geo: null, err: null, tipDraft: '',
      backScreen: null, sendHint: null, sendTotals: null, pinDraft: null, pinToast: false, pinStepOk: false, lastDelivery: null };

    // ── the view model: the served menu as the prototype's item shape ──
    const EX = {}; for (const e of menu.extras) EX[e.key] = { n: e.name, p: e.price, c: e.cat, max: 1 };
    const sections = viewSections(menu, cfg);
    const find = (id) => { for (const s of sections) for (const it of s.items) { if (it.id === id) return it; if (it.group) for (const c of it.group.choices) if (c.id === id) return { ...c, d: it.d, img: it.img, hero: it.hero, tags: [], parent: it }; } return null; };
    const isSoldBy = (it, has) => !!it && (has(it.id) || (it.parent ? has(it.parent.id) : false) || (it.group ? it.group.choices.every((c) => has(c.id)) : false));
    const isSold = (it) => isSoldBy(it, soldOf);
    const unit = cfg.unit && cfg.unit.length === 2 ? cfg.unit : ['plato', 'platos'];
    const unitOf = (n) => n + ' ' + (n === 1 ? unit[0] : unit[1]);
    const badgeOf = (it) => { const k = BADGE_PRIORITY.find((t) => (it.tags || []).includes(t)); if (!k) return null; const served = menu.badges && menu.badges[k] && menu.badges[k].label; return { text: served || BADGE_FALLBACK[k], color: k === 'must_try' || k === 'crowd_favourite' ? 'var(--acc)' : 'var(--price)' }; };

    // ── hours (the store config's, on the injected clock) ──
    const clock = () => { const d = now(); return { min: d.getHours() * 60 + d.getMinutes(), day: d.getDay() }; };
    const range = (day) => { const h = cfg.hours && cfg.hours[day]; return h ? [h[0] * 60 + h[1], h[2] * 60 + h[3]] : null; };
    // S4 one clock (advisor 2026-10-27): under schedulingLive, open / closed is the SERVED schedule's (its zone, [start, end)) — the ASAP
    // card and the picker never disagree on a device in another zone; absent ⇒ the device-local helper, as before
    const isOpen = () => { if (cfg.schedulingLive === true && cfg.schedule) { const K = schedMod(); if (K.valid(cfg.schedule)) return K.openAt(cfg.schedule, now().getTime()); }
      const c = clock(), o = range(c.day); return !!o && c.min >= o[0] && c.min < o[1]; };
    const closesText = () => { const o = range(clock().day); return o ? fmtMin(o[1]) : ''; };
    const opensText = () => { const c = clock(), o = range(c.day); if (o && c.min < o[0]) return 'Abre hoy ' + fmtMin(o[0]); for (let d = 1; d <= 7; d++) { const oo = range((c.day + d) % 7); if (oo) return 'Abre ' + (d === 1 ? 'mañana' : 'el ' + DAYS[(c.day + d) % 7]) + ' ' + fmtMin(oo[0]); } return 'Cerrado por ahora'; };
    const firstSlot = () => { const c = clock(); for (let off = 0; off < 7; off++) { const o = range((c.day + off) % 7); if (!o) continue; let t = off === 0 ? Math.max(c.min + 60, o[0]) : o[0]; t = Math.ceil(t / 15) * 15; if (t + 30 <= o[1] + 15 && t < o[1]) return { off, t }; } return null; };
    const etaTxt = (mode) => (mode === 'delivery' ? (cfg.etaDel ? `≈ ${cfg.etaDel[0]} min` : '') : (cfg.etaPick ? `Listo en ≈ ${cfg.etaPick[1]} min` : ''));

    // ── cart reads (capp-cart) ──
    const qtyOf = (id) => { const l = cart.lines().find((x) => x.key === id); return l ? l.qty : 0; };
    const qtyAll = (it) => (it.group ? it.group.choices.reduce((a, c) => a + qtyOf(c.id), 0) : qtyOf(it.id));
    const cartTotal = () => cart.subtotalCents() / 100;
    const displayLines = () => cart.groups().map((g) => ({ key: g.key, g: g.sig, item: find(g.key) || { n: g.dish.name }, n: g.n, extras: g.extras.map((e) => e.name).join(', '), total: g.total, editable: g.editable }));
    // every mutation is guarded: a write the cart refuses (the quantity cap, an unsupported extra) changes nothing, and one that would
    // push the order text past the server's cap is REVERTED with the owner-approved line
    // S7a-1 r3 §1.1 (Codex r1 P2-7): hosted ⇒ a cart frozen for a placement — or whose freeze state is unknown — is READ-ONLY:
    // every mutation and mode change is refused before it lands. Reconciliation runs first, so a finished placement unfreezes it.
    // Absent the hosted keys ⇒ never frozen (the S2 path)
    function frozenNow() { return core.frozenNow(); }
    function mutate(fn) {
      const m = core.mutate(fn, orderable);
      if (!m.ok) { if (m.tooLong) { S.refusal = FULL_CART; showRefusal(); } return false; }
      S.refusal = null;
      if (refused.size) { const inCart = new Set(cart.lines().map((l) => l.key)); for (const k of [...refused]) if (!inCart.has(k)) refused.delete(k); }   // removed ⇒ the refusal clears
      notifyCart();
      return true;
    }

    // a refusal is shown WHERE the action happened: inside the open sheet, in the cart sheet, else as the prototype's toast
    let toastT = null;
    // S1's refusal toast stays 4 s (S1-approved); the S2b toasts take the prototype's toast() lifetime, 2.2 s (P:1377)
    const TOAST_MS = 2200;
    function toast(msg, ms = 4000) { const tm = opts.timers || { setTimeout: (f, d) => setTimeout(f, d), clearTimeout: (h) => clearTimeout(h) }; const t = $('toast'); if (!t || dead) return; t.textContent = msg; t.classList.add('on'); if (toastT !== null) tm.clearTimeout(toastT); toastT = tm.setTimeout(() => { toastT = null; if (!dead) t.classList.remove('on'); }, ms); }
    function showRefusal() { if (S.open) renderDetail(); else if (S.layerKind === 'cart') renderLayer(); else toast(S.refusal); }
    const tooLong = () => { if (!cart.count()) return false; try { CappSerialize.serialize(cart, menu); return false; } catch (e) { return !!(e && e.code === 'cart_text_too_long'); } };

    // ── STORE ──
    function overlayHtml(it) {
      // F4: a sold dish's «+» is inert for everyone — disabled, aria-disabled, out of the tab order (CSS alone left a live tab stop)
      const n = qtyAll(it), exp = S.expanded.has(it.id), id = esc(it.id), launcher = !!it.group, off = isSold(it) ? ' disabled aria-disabled="true" tabindex="-1"' : '';
      return `<div class="qty-overlay" data-stop="1">
    <div class="qty-controls${n > 0 && exp ? ' visible' : ''}"><button class="qty-ctrl-btn" data-act="dec" data-id="${id}" aria-label="${launcher ? 'Ver tu pedido' : 'Quitar uno'}">−</button><span class="qty-ctrl-num">${n}</span><button class="qty-ctrl-btn" data-act="inc" data-id="${id}" aria-label="${launcher ? 'Agregar otra' : 'Agregar uno'}"${off}>+</button></div>
    <div class="qty-badge" style="display:${n > 0 && !exp ? 'flex' : 'none'}" data-act="badge" data-id="${id}" role="button" tabindex="0" aria-label="${n} en tu pedido"><span>${n > 0 ? n : 1}</span></div>
    <button class="qty-add-btn"${n > 0 ? ' style="display:none"' : ''} data-act="${launcher ? 'open' : 'inc'}" data-id="${id}" aria-label="${launcher ? 'Personalizar' : 'Agregar ' + esc(it.n)}"${off}>+</button></div>`;
    }
    function rowHtml(it) {
      // the owner's frame 12 (D1 ruled (a), approved 2026-10-27): a sold dish's «Agotado» TAKES THE PRICE SLOT (muted ink) — no marks
      // line is added, so a dish that sells out while the menu is open never grows its row; its + gets P's drawn .sold-out dimming
      const b = badgeOf(it), sold = isSold(it);
      const label = b ? `<span class="mark" style="color:${b.color}">${esc(b.text)}</span>` : '';
      const marks = label ? `<span class="marks">${label}</span>` : '';
      const price = sold ? 'Agotado' : it.group ? 'desde ' + money(Math.min(...it.group.choices.map((c) => c.p))) : money(it.p);
      const open = `data-act="open" data-id="${esc(it.id)}"`;
      return `<div class="row${isSold(it) ? ' sold-out' : ''}" id="dish-${esc(it.id)}"><button class="txtbtn" ${open}>${marks}<span class="nm">${esc(it.n)}</span>${it.d ? `<span class="ds">${esc(it.d)}</span>` : ''}<span class="prrow"><span class="pr">${esc(price)}</span></span></button>
    ${it.img ? `<div class="thumb"><button class="openimg" ${open} aria-label="Ver ${esc(it.n)}" tabindex="-1"><img src="${esc(it.img)}" alt="" loading="lazy"></button>${overlayHtml(it)}</div>` : `<div class="ovl-inline">${overlayHtml(it)}</div>`}</div>`;
    }
    // PLAN-capp-store-promo-feeinfo r0 — the store header as v6: the guest promo pill (:1617; reserved, hidden, while auth is
    // unresolved — home's rule, no pop-in), the member's «Envío gratis» (:1609 feeFree) and the fee ⓘ (only with a priced fee AND a
    // zone: no control without effect). The auth tri-state is the HOST's (opts.authState); no getter ⇒ no promo UI at all
    function authOf() {
      if (typeof opts.authState !== 'function') return null;
      // the ADMITTED identity — the one the checkout sends with (Codex promo r1 #1) — AND a usable token by the transport's own predicate
      // (Codex promo r2 P2-A + r3, CappApi.tokenUsable: unexpired): no usable token ⇒ the server prices a guest ⇒ 'unresolved', nothing claimed
      if (memberCtx) { let A = null; try { A = opts.CappApi || (typeof self !== 'undefined' && self.CappApi) || (typeof require === 'function' ? require('./capp-api.js') : null); } catch (_) { A = null; } return A && typeof A.tokenUsable === 'function' && A.tokenUsable(memberCtx, now().getTime()) ? 'member' : 'unresolved'; }
      let v; try { v = opts.authState(); } catch (_) { v = null; }
      return v === 'guest' ? 'guest' : 'unresolved';   // a session not (yet) admitted — restoring, or an incomplete one being signed out — claims nothing
    }
    function pillsHtml() {
      const a = authOf();
      return cfg.promoFree === true && a && a !== 'member' ? `<div class="pills hdpills"><span class="pill deal"${a === 'guest' ? '' : ' style="visibility:hidden" aria-hidden="true"'}>Envío gratis con tu cuenta</span></div>` : '';
    }
    function factsHtml() {
      const mode = S.mode, open = isOpen();
      const ib = Number.isFinite(cfg.zoneKm) ? `<button class="infobtn" data-act="feeinfo" aria-label="Detalle del envío">${IC.info}</button>` : '';
      const feeTxt = cfg.feeFromCents != null ? `<span>· ${cfg.promoFree === true && authOf() === 'member' ? '<span class="free">Envío gratis</span>' : `Envío desde ${money(cfg.feeFromCents / 100)}`}${ib}</span>` : '';
      return open
        ? `<span class="full"><span class="dot"></span><strong>Abierto</strong> · cierra ${esc(closesText())}</span>` + (mode === 'delivery'
          ? `${etaTxt('delivery') ? `<span>${esc(etaTxt('delivery'))}</span>` : ''}${feeTxt}`
          : `${etaTxt('pickup') ? `<span>${esc(etaTxt('pickup'))}</span>` : ''}${cfg.addr ? `<span class="mute full">Recogé en ${esc(cfg.addr)}</span>` : ''}`)
        : `<span class="full"><span class="dot off"></span><strong>Cerrado</strong> · ${esc(opensText())}</span>`;
    }
    function patchAuth() {
      if (S.desk) { patchDeskAuth(); return; }
      const top = $('top'), info = top && top.querySelector('.info'); if (!info) return;
      const old = info.querySelector('.hdpills'), html = pillsHtml();
      if (old) { if (html) old.outerHTML = html; else old.remove(); } else if (html) { const id = info.querySelector('.idrow'); if (id) id.insertAdjacentHTML('afterend', html); }
      const f = info.querySelector('.facts'); if (f) patchFacts(f);
    }
    // Codex promo r2 P2-B: the fee line changes IN PLACE — the live «Detalle del envío» node is kept (a focused ⓘ stays focused); only
    // the nodes before it are swapped. Without an ⓘ on both sides: the whole line, focus restored by descriptor
    function patchFacts(f) {
      const tpl = doc.createElement('div'); tpl.innerHTML = factsHtml();
      const ib = f.querySelector('.infobtn'), nib = tpl.querySelector('.infobtn');
      if (ib && nib && ib.parentElement && nib.parentElement) {
        const fs = ib.parentElement, nfs = nib.parentElement;
        while (fs.firstChild && fs.firstChild !== ib) fs.removeChild(fs.firstChild);
        for (const n of [...nfs.childNodes]) if (n !== nib) fs.insertBefore(n, ib);
        return;
      }
      const fd = f.contains(doc.activeElement) ? descOf(doc.activeElement) : null;
      f.innerHTML = tpl.innerHTML;
      if (fd) { const el = refind(fd); if (el) el.focus({ preventScroll: true }); }
    }
    // the store page's shared pieces (the phone header and the C-6c desk page draw the SAME ones)
    const houseItems = () => sections.flatMap((s) => s.items).filter((x) => x.img && (x.tags || []).some((t) => ['signature_special', 'chefs_pick', 'must_try'].includes(t))).slice(0, 5);
    function closedNoteHtml(open) {
      const fs = !open && !sched() ? firstSlot() : null;
      const sfd = !open && sched() ? schedDays().find((d) => d.slots.length) || null : null;
      const dayWord = (off) => (off === 0 ? 'hoy' : off === 1 ? 'mañana' : DAYS[(clock().day + off) % 7]);
      return !open && sched() ? `<div class="closednote">${IC.clock}<span>${sfd ? `Podés programar un pedido para ${sfd.off === 0 ? 'hoy' : esc(schedMod().slotWhen(servedSched(), now().getTime(), sfd.slots[0]).split(' · ')[0].toLowerCase())}, desde las ${esc(schedMod().slotTime(servedSched(), sfd.slots[0]))}` : 'Sin horarios disponibles · ' + esc(opensText()).toLowerCase()}</span>${sfd ? '<button class="lnk" data-act="closed-sched">Programar</button>' : ''}</div>`
        : !open ? `<div class="closednote">${IC.clock}<span>${fs ? `Podés programar un pedido para ${esc(dayWord(fs.off))}, desde las ${esc(fmtMin(fs.t))}` : 'Sin horarios disponibles · ' + esc(opensText()).toLowerCase()}</span>${fs ? '<button class="lnk" data-act="closed-sched">Programar</button>' : ''}</div>` : '';
    }
    const avatarHtml = () => (cfg.logo ? `<div class="avatar${cfg.logoWide ? ' wide' : ''}"><img src="${esc(cfg.logo)}" alt="${esc(cfg.name)}"></div>` : `<div class="avatar txt" aria-hidden="true">${esc(String(cfg.name || '').split(' ').map((x) => x[0]).join('').slice(0, 2))}</div>`);
    function cartPillHtml() {
      const n = cart.count();
      return `<button class="cart-bar" id="cart-bar" data-act="pill" aria-label="Tu pedido"><span class="cart-icon">${CART_ICON}</span><span class="cart-pill-text">${n ? unitOf(n) : 'Tu pedido'}</span><span class="cart-pill-dot">·</span><span class="cart-pill-text">${money(cartTotal())}</span></button>`;
    }
    function storeHtml() {
      if (S.desk) return storeDeskHtml();
      const mode = S.mode, open = isOpen();
      const house = houseItems();
      const facts = factsHtml();
      const closednote = closedNoteHtml(open);
      const avatar = avatarHtml();
      // advisor 11-02: a sold house dish reads like a sold category row (frame 12: «Agotado» in the price slot, muted; P's inert +)
      let content = house.length ? `<section class="toprow" aria-label="La casa recomienda"><h2>La casa recomienda</h2><div class="cards">${house.map((it) => { const so = isSold(it); return `<div class="card${so ? ' sold-out' : ''}"><div class="ph"><button class="openimg" data-act="open" data-id="${esc(it.id)}" aria-label="Ver ${esc(it.n)}" tabindex="-1" style="border-radius:14px"><img src="${esc(it.img)}" alt="" loading="lazy"></button>${overlayHtml(it)}</div><button class="txtbtn" data-act="open" data-id="${esc(it.id)}"><span class="nm">${esc(it.n)}</span><span class="prrow"><span class="mute" style="font-size:14px">${so ? 'Agotado' : money(it.p)}</span></span></button></div>`; }).join('')}</div></section>` : '';
      for (const s of sections) content += `<section class="sec" id="sec-${esc(s.id)}" data-sec="${esc(s.id)}"><div class="sechead"><h2>${esc(s.name)}</h2><span>${esc(s.items.length + (s.items.length === 1 ? ' plato' : ' platos'))}</span></div>${s.note ? `<div class="secnote">${esc(s.note)}</div>` : ''}${s.pickupOnly && mode === 'delivery' ? '<div class="secflag">Solo para Pickup · cambiá a Pickup arriba para pedirlas</div>' : ''}<div>${s.items.map(rowHtml).join('')}</div></section>`;
      const pill = cartPillHtml();
      const nav = `<div class="store-nav">${S.entry === 'app' ? `<button class="iconbtn" data-act="back" aria-label="Cerrar">${IC.close}</button>` : '<span></span>'}<span></span></div>`;
      const hero = cfg.hero ? `<img class="hero" id="hero" src="${esc(cfg.hero)}" alt="">` : '<div class="hero" id="hero"></div>';
      const scroller = `<div class="scroller" id="scroller">${nav}<header id="top">${hero}<div class="info"><div class="idrow">${avatar}<div class="idtxt"><h1 class="brandname">${esc(cfg.name || '')}</h1>${cfg.kicker ? `<div class="kicker">${esc(cfg.kicker)}</div>` : ''}</div></div>${pillsHtml()}<div class="facts">${facts}</div>${closednote}
      <div class="seg" role="group" aria-label="Tipo de pedido"><button aria-pressed="${mode === 'delivery'}" data-act="mode" data-val="delivery">${IC.bike}Delivery</button><button aria-pressed="${mode === 'pickup'}" data-act="mode" data-val="pickup">${IC.bag}Pickup</button></div></div></header>
    <div class="stick" id="stick"><div class="slim">${S.entry === 'app' ? `<button class="iconbtn" data-act="back" aria-label="Cerrar">${IC.close}</button>` : '<span class="sp"></span>'}<b>${esc(cfg.name || '')}</b><button class="iconbtn" data-act="ssearch" aria-label="Buscar en el menú">${IC.search}</button></div>
      <div class="tabsbar"><button class="iconbtn" data-act="menu" aria-label="Ver todo el menú">${IC.menu}</button><nav class="tabs" id="tabs" aria-label="Categorías">${sections.map((s, i) => `<button class="tab" data-act="jump" data-jump="${esc(s.id)}" aria-current="${i === 0}">${esc(s.name)}</button>`).join('')}</nav>${S.entry === 'app' ? '' : `<button class="iconbtn" data-act="ssearch" aria-label="Buscar en el menú">${IC.search}</button>`}</div></div>
    <main class="content" id="content">${content}</main></div>`;
      return `<div class="storewrap">${scroller}${S.desk ? `<aside class="deskcart" aria-label="Tu pedido">${cartInner(true)}</aside>` : ''}</div>${pill}`;   // v6 :1628
    }
    // C-6c (MOCKUP-capp-desktop-D3 r3 frames 2a/2b, approved; advisor calls 1–7): the desktop store page — the host's top bar
    // (opts.deskChrome), the wide hero with the logo over it, identity + tools (Delivery/Pickup, the fee and ETA cells, «Buscar en»),
    // the sticky category rail beside two-column item cards, the v6 cart aside. The SAME acts, cart and overlays as the phone page
    function deskFactsHtml() {
      const open = isOpen();
      return (open ? `<span><span class="dot"></span><strong>Abierto</strong></span>${closesText() ? `<span>cierra ${esc(closesText())}</span>` : ''}` : `<span><span class="dot off"></span><strong>Cerrado</strong></span><span>${esc(opensText())}</span>`)
        + (cfg.addr ? `<span>·</span><span>${esc(cfg.addr)}</span>` : '');
    }
    // the delivery window «a–b min» (rule 11: a window, never one straight-line minute) — the store cell's and the checkout card's
    const etaWindow = () => { const e = cfg.etaDel; return e && Number.isFinite(e[0]) ? `${Number.isFinite(e[1]) && e[1] > e[0] ? `${e[0]}–${e[1]}` : e[0]} min` : ''; };
    function deskCellsHtml() {
      if (!isOpen()) return '';
      const cells = [];
      if (S.mode === 'delivery') {
        if (cfg.feeFromCents != null) {
          const ib = Number.isFinite(cfg.zoneKm) ? `<button class="infobtn" data-act="feeinfo" aria-label="Detalle del envío">${IC.info}</button>` : '';
          cells.push(cfg.promoFree === true && authOf() === 'member' ? `<div><b class="free">Envío gratis${ib}</b><span>por ser miembro</span></div>` : `<div><b>Envío desde ${money(cfg.feeFromCents / 100)}${ib}</b><span>según tu dirección</span></div>`);
        }
        if (etaWindow()) cells.push(`<div><b>${etaWindow()}</b><span>llega aprox.</span></div>`);
      } else {
        if (etaTxt('pickup')) cells.push(`<div><b>${esc(etaTxt('pickup'))}</b></div>`);
        if (cfg.addr) cells.push(`<div><b>Recogé en</b><span>${esc(cfg.addr)}</span></div>`);
      }
      return cells.length ? `<div class="cells${cells.length === 1 ? ' one' : ''}">${cells.join('')}</div>` : '';
    }
    function deskCardHtml(it) {
      const b = badgeOf(it), sold = isSold(it);
      const price = sold ? 'Agotado' : it.group ? 'desde ' + money(Math.min(...it.group.choices.map((c) => c.p))) : money(it.p);
      const open = `data-act="open" data-id="${esc(it.id)}"`;
      return `<div class="icard${sold ? ' sold-out' : ''}" id="dish-${esc(it.id)}"><button class="txtbtn txt" ${open}><span class="nm">${esc(it.n)}</span>${it.d ? `<span class="ds">${esc(it.d)}</span>` : ''}<span class="pr">${esc(price)}</span>${b ? `<span class="pills"><span class="mark" style="color:${b.color}">${esc(b.text)}</span></span>` : ''}</button>`
        + `${it.img ? `<div class="thumb"><button class="openimg" ${open} aria-label="Ver ${esc(it.n)}" tabindex="-1"><img src="${esc(it.img)}" alt="" loading="lazy"></button>${overlayHtml(it)}</div>` : `<div class="thumb noimg">${overlayHtml(it)}</div>`}</div>`;
    }
    function storeDeskHtml() {
      const mode = S.mode, open = isOpen();
      const house = houseItems();
      const closednote = closedNoteHtml(open);
      // the logo is the page's own avatar (its white plate), laid over the hero's lower edge — outside the clipped hero so it overlaps
      const logo = avatarHtml();
      const hero = `<div class="hero" id="hero">${cfg.hero ? `<img src="${esc(cfg.hero)}" alt="">` : ''}</div>${logo}`;
      const today = range(clock().day);
      const cur = S.activeSec && sections.some((s) => s.id === S.activeSec) ? S.activeSec : (sections[0] || {}).id;
      const rail = `<nav class="catnav" aria-label="Categorías del menú"><h3>Menú</h3>${today ? `<div class="hours">Hoy ${esc(fmtMin(today[0]))} – ${esc(fmtMin(today[1]))}</div>` : ''}${sections.map((s) => `<button data-act="jump" data-jump="${esc(s.id)}" aria-current="${s.id === cur}">${esc(s.name)}</button>`).join('')}</nav>`;
      let content = house.length ? `<section class="hfeat" aria-label="La casa recomienda"><div class="sechead"><h2>La casa recomienda</h2></div><div class="featured">${house.map((it) => { const so = isSold(it); return `<div class="card${so ? ' sold-out' : ''}"><div class="ph"><button class="openimg" data-act="open" data-id="${esc(it.id)}" aria-label="Ver ${esc(it.n)}" tabindex="-1" style="border-radius:12px"><img src="${esc(it.img)}" alt="" loading="lazy"></button>${overlayHtml(it)}</div><button class="txtbtn" data-act="open" data-id="${esc(it.id)}"><span class="nm">${esc(it.n)}</span><span class="pr">${so ? 'Agotado' : money(it.p)}</span></button></div>`; }).join('')}</div></section>` : '';
      for (const s of sections) content += `<section class="sec" id="sec-${esc(s.id)}" data-sec="${esc(s.id)}"><div class="sechead"><h2>${esc(s.name)}</h2>${s.note ? `<span>${esc(s.note)}</span>` : ''}</div>${s.pickupOnly && mode === 'delivery' ? '<div class="secflag">Solo para Pickup · cambiá a Pickup arriba para pedirlas</div>' : ''}<div class="icards">${s.items.map(deskCardHtml).join('')}</div></section>`;
      const pill = cartPillHtml();
      const chrome = typeof opts.deskChrome === 'function' ? String(opts.deskChrome() || '') : '';
      const scroller = `<div class="scroller store-main" id="scroller"><div class="shero">${hero}</div>
    <div class="sinfo"><div>${cfg.kicker ? `<div class="kicker">${esc(cfg.kicker)}</div>` : ''}<h1 class="brandname">${esc(cfg.name || '')}</h1>${pillsHtml()}<div class="facts">${deskFactsHtml()}</div>${closednote}</div>
      <div class="tools"><div class="toolrow"><div class="seg" role="group" aria-label="Tipo de pedido"><button aria-pressed="${mode === 'delivery'}" data-act="mode" data-val="delivery">${IC.bike}Delivery</button><button aria-pressed="${mode === 'pickup'}" data-act="mode" data-val="pickup">${IC.bag}Pickup</button></div>${deskCellsHtml()}</div><button class="ssearch" data-act="ssearch">${IC.search}Buscar en ${esc(cfg.name || '')}</button></div></div>
    <div class="sgrid">${rail}<main class="scontent" id="content">${content}</main></div></div>`;
      return `${chrome}<div class="storewrap">${scroller}<aside class="deskcart" aria-label="Tu pedido">${cartInner(true)}</aside></div>${pill}`;
    }
    // the auth tri-state changed on the desk page: its promo pill and fee cell in place (a focused ⓘ refound by descriptor)
    function patchDeskAuth() {
      const info = app.querySelector('.sinfo'); if (!info) return;
      const dc = app.querySelector('.deskcart');
      const fd = info.contains(doc.activeElement) || (dc && dc.contains(doc.activeElement)) ? descOf(doc.activeElement) : null;
      if (dc) { dc.innerHTML = cartInner(true); applyOrderable(); }   // Codex C-6c r1 #4: the guest's card-only note follows the auth
      const old = info.querySelector('.hdpills'), html = pillsHtml();
      if (old) { if (html) old.outerHTML = html; else old.remove(); } else if (html) { const b = info.querySelector('.brandname'); if (b) b.insertAdjacentHTML('afterend', html); }
      const row = info.querySelector('.toolrow'), c = row && row.querySelector('.cells'), nc = deskCellsHtml();
      if (c) { if (nc) c.outerHTML = nc; else c.remove(); } else if (row && nc) row.insertAdjacentHTML('beforeend', nc);
      if (fd && lost()) { const el = refind(fd); if (el) el.focus({ preventScroll: true }); }
    }
    let sectionEls = [];
    function wireStore() {
      const sc = $('scroller'); if (!sc) return;
      sectionEls = [...sc.querySelectorAll('.sec')];
      let lastActive = '';
      const onScroll = () => {
        if (!sc.isConnected) return;
        if (S.desk) { deskSpy(sc); return; }
        if (!$('top') || !$('stick')) return;
        const y = sc.scrollTop;
        const hero = $('hero'); if (hero) { hero.style.transform = `translateY(${Math.min(y, 150) * 0.35}px) scale(${1 + Math.min(y, 150) / 900})`; hero.style.opacity = String(Math.max(0.35, 1 - y / 260)); }
        const collapseAt = $('top').offsetHeight - 4; $('stick').classList.toggle('collapsed', y > collapseAt);
        let active = sectionEls.length ? sectionEls[0].dataset.sec : ''; const line = y + $('stick').offsetHeight + 24;
        for (const el of sectionEls) if (el.offsetTop <= line) active = el.dataset.sec;
        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4 && sectionEls.length) active = sectionEls[sectionEls.length - 1].dataset.sec;
        if (active !== lastActive) { lastActive = active; S.activeSec = active; for (const t of sc.querySelectorAll('.tab')) { const on = t.dataset.jump === active; t.setAttribute('aria-current', String(on)); if (on) { const strip = $('tabs'), sr = strip.getBoundingClientRect(), tr = t.getBoundingClientRect(); const first = t === strip.firstElementChild; if (strip.scrollTo) strip.scrollTo({ left: Math.max(0, first ? 0 : strip.scrollLeft + (tr.left - sr.left) - (sr.width - tr.width) / 2), behavior: first ? 'auto' : 'smooth' }); } } }
      };
      sc.addEventListener('scroll', onScroll, { passive: true }); onScroll();
    }
    function deskSpy(sc) {
      if (!sectionEls.length) return;
      const top = sc.getBoundingClientRect().top + 24;
      let active = sectionEls[0].dataset.sec;
      for (const el of sectionEls) if (el.getBoundingClientRect().top <= top) active = el.dataset.sec;
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4 && sc.scrollTop > 0) active = sectionEls[sectionEls.length - 1].dataset.sec;
      if (active === S.activeSec) return;
      S.activeSec = active;
      for (const b of sc.querySelectorAll('.catnav [data-jump]')) b.setAttribute('aria-current', String(b.dataset.jump === active));
    }
    function jumpTo(id) { const el = $('sec-' + id), sc = $('scroller'); if (!el || !sc) return; if (S.desk) { if (sc.scrollTo) sc.scrollTo({ top: sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 16, behavior: 'smooth' }); return; } const extra = $('stick').classList.contains('collapsed') ? 0 : 56; if (sc.scrollTo) sc.scrollTo({ top: el.offsetTop - ($('stick').offsetHeight + extra) + 8, behavior: 'smooth' }); }
    function renderStoreKeep() { const sc = $('scroller'); const y = sc ? sc.scrollTop : 0; render(); const sc2 = $('scroller'); if (sc2) sc2.scrollTop = y; }

    // ── focus (sheets are dialogs: focus moves in, Tab stays in, the background and a closed sheet are inert, focus returns) ──
    const FOCUSABLE = 'button:not([disabled]),input,[tabindex]:not([tabindex="-1"]),a[href]';
    // a control is described by its id + EVERY data-* attribute (act, id, key, grp, rev, eid, inst, delta …), so «+» never matches «−»
    const descOf = (el) => (el && el.dataset && el !== doc.body ? { ds: { ...el.dataset }, elId: el.id } : null);
    // only controls a user can reach: not inside an inert subtree, not display:none / hidden up the tree
    const shown = (el) => { const win = doc.defaultView; for (let n = el; n && n !== app.parentNode; n = n.parentElement) { if (n.hidden) return false; try { if (win.getComputedStyle(n).display === 'none') return false; } catch (_) {} } return true; };
    const reachable = (el) => !!el && !el.closest('[inert]') && shown(el);
    const attrSel = (ds) => Object.entries(ds).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}="${String(v).replace(/["\\]/g, '\\$&')}"]`).join('');
    // focus is restored INSIDE the active dialog (the open sheet, else the open layer), else the page — never into an inert copy
    function refind(d) {
      if (!d) return null;
      const root = dialogEl() || app;
      const pick = (sel) => { try { return [...root.querySelectorAll(sel)].find(reachable) || null; } catch (_) { return null; } };
      if (d.elId) { const e = $(d.elId); if (e && root.contains(e) && reachable(e)) return e; }
      const ds = d.ds || {}; if (!Object.keys(ds).length) return null;
      return pick(attrSel(ds)) || (ds.act === 'inc' || ds.act === 'dec' ? pick(`[data-act="inc"]${attrSel({ id: ds.id })}`) || pick(`[data-act="badge"]${attrSel({ id: ds.id })}`) || pick(`[data-act="open"]${attrSel({ id: ds.id })}`) : null);
    }
    const lost = () => !doc.activeElement || doc.activeElement === doc.body || !doc.contains(doc.activeElement);
    const focusTo = (el) => { if (el && el.focus) { try { el.focus(); } catch (_) {} } };
    const setInert = (el, on) => { if (!el) return; if (on) { el.setAttribute('inert', ''); el.setAttribute('aria-hidden', 'true'); } else { el.removeAttribute('inert'); el.removeAttribute('aria-hidden'); } };
    let returnTo = null;   // where focus goes back when the open dialog closes
    const screenEl = () => app.querySelector('.screen');
    function dialogEl() { if (S.open) return $('detail-modal'); const L = $('layer'); return S.layerKind && L ? L : null; }
    // the browse-only pass: the ordering controls not ALREADY disabled for their own reason get the existing disabled attribute,
    // marked data-ord so setOrderable(true) can release exactly them, in place (runs after every render / layer / sheet paint)
    // the cart's ordering controls live in the cart SHEET (#layer) and, on desktop, the deskcart aside (D-2) — ONE list of hosts
    // (Codex D-2 r1 #3: a browse-only aside never offers an enabled control without effect)
    const CART_HOSTS = ['#layer', '.deskcart'];
    const ORDERING = ['.qty-add-btn', '.qty-ctrl-btn', '.detail-step-btn', '#detail-cta', ...CART_HOSTS.flatMap((h) => [`${h} .cstep button`, `${h} [data-act="checkout"]`])].join(', ');
    function applyOrderable() {
      if (orderable || dead) return;
      for (const el of app.querySelectorAll(ORDERING)) if (!el.disabled) { el.disabled = true; el.setAttribute('aria-disabled', 'true'); el.dataset.ord = '1'; }
    }
    function syncInert() { applyOrderable();
      const dlg = !!(S.open || S.layerKind);
      setInert(screenEl(), dlg);
      const pill = $('cart-bar'); if (pill) setInert(pill, dlg);
      setInert($('detail-modal'), !S.open);
      const L = $('layer'); if (L) setInert(L, !!S.open || !S.layerKind);
    }

    // ── ITEM SHEET (per-instance extras; S1: toggles) ──
    const detailSkeleton = () => `<div class="detail-overlay" id="detail-overlay" data-act="dclose"></div><div class="detail-modal${S.desk ? ' wide' : ''}" id="detail-modal" aria-hidden="true" role="dialog" aria-labelledby="${S.desk ? 'detail-name' : 'detail-header-title'}"><div class="detail-drag-handle" aria-hidden="true"></div><div class="detail-header">${S.desk ? '<span class="detail-close-slot" aria-hidden="true"></span>' : `<button class="detail-close" id="detail-close" data-act="dclose" aria-label="Cerrar">${IC.close}</button>`}<div class="detail-header-title" id="detail-header-title"></div><div class="detail-header-spacer"></div></div>${S.desk ? '<div class="dbody" id="detail-dbody"><div class="dphoto" id="detail-dphoto"></div><div class="detail-scroll dscroll" id="detail-scroll"></div></div>' : '<div class="detail-scroll" id="detail-scroll"></div>'}<div class="detail-cta-bar"><div class="detail-step" id="detail-step" role="group" aria-label="Cantidad"></div><button class="detail-cta" id="detail-cta" data-act="dcta"></button></div></div>`;
    const extrasByCat = (ids) => { const out = []; for (const id of ids) { const e = EX[id]; if (!e) continue; let g = out.find((x) => x.cat === e.c); if (!g) out.push(g = { cat: e.c, list: [] }); g.list.push({ id, ...e }); } return out; };
    const instTotal = (inst) => Object.keys(inst || {}).reduce((a, k) => a + (EX[k] ? EX[k].p : 0), 0);
    function openDetail(id) { const it = find(id); if (!it) return; S.open = it.group ? { id, kind: 'launcher', staged: { choice: null, ex: {}, qty: 1 } } : { id, kind: 'dish', staged: { qty: 1 } }; openDetailDom(); }
    function openEdit(key, g = '') { const l = cart.lines().find((x) => x.key === key); if (!l) return; const it = find(key); const n = l.ex.filter((inst) => CappCart.sigOf(inst) === g).length; S.open = { id: it.parent ? it.parent.id : it.id, kind: 'edit', key, g, n, staged: { choice: it.parent ? it.id : null, ex: Object.fromEntries(g ? g.split(',').map((k) => [k, 1]) : []) } }; openDetailDom(); }
    function openDetailDom() { if (!S.open) return; T_report(); returnTo = returnTo || descOf(doc.activeElement); renderDetail(); $('detail-overlay').classList.add('open'); $('detail-modal').classList.add('open'); syncInert(); focusTo((S.desk && $('detail-name')) || $('detail-close')); }
    function closeDetail() { $('detail-overlay').classList.remove('open'); $('detail-modal').classList.remove('open'); S.open = null; S.refusal = null; renderStoreKeep(); syncInert(); reportRoute(); const back = refind(returnTo); returnTo = null; focusTo(back || $('cart-bar')); }
    function extraRow(e, q, act, attrs) {
      const sel = q > 0;
      return `<div class="detail-extras-row" data-act="${act}" ${attrs} role="checkbox" aria-checked="${sel}" tabindex="0"><span class="xrow-main"><span class="detail-extras-name">${esc(e.n)}</span><span class="xrow-price">+${money(e.p)}</span></span><div class="detail-extras-toggle ${sel ? 'selected' : ''}">${IC.check.replace('class="i"', '')}</div></div>`;
    }
    function renderDetail() { renderDetailBody(); applyOrderable(); if (detailHad && lost()) focusTo(refind(detailHad)); detailHad = null; }
    let detailHad = null;
    function renderDetailBody() {
      const o = S.open, it = find(o.id);
      const src = it.hero || it.img;
      const desk = S.desk && !!$('detail-dbody');
      $('detail-header-title').textContent = o.kind === 'edit' ? 'Editar' : desk ? cfg.name || '' : it.n;
      let html = desk ? '' : `<div class="detail-photo${src ? '' : ' empty'}">${src ? `<img class="detail-photo-img" src="${esc(src)}" alt="${esc(it.n)}">` : ''}</div>`;
      if (desk) {   // the photo pane (decorative; the heading names the dish) — no photo ⇒ one column, no empty well
        const ph = $('detail-dphoto'), was = ph.dataset.src || '';
        if (was !== (src || '')) { ph.dataset.src = src || ''; ph.innerHTML = src ? `<div class="detail-photo"><img class="detail-photo-img" src="${esc(src)}" alt=""></div><span class="lgtag">${esc(cfg.name || '')}</span>` : ''; }
        $('detail-dbody').classList.toggle('nophoto', !src);
      }
      // the desk dialog (advisor 11-02, frame 3 a11y): ✕ is the NEXT Tab stop after the focused heading — it follows the h2 in the DOM
      // and is drawn in the header's slot by CSS (.detail-close-slot keeps the header's layout)
      const nameEl = desk ? `<h2 class="detail-name" id="detail-name" tabindex="-1">${esc(it.n)}</h2><button class="detail-close" id="detail-close" data-act="dclose" aria-label="Cerrar">${IC.close}</button>` : `<div class="detail-name">${esc(it.n)}</div>`;
      const body = (price) => (desk ? `<div class="detail-body">${nameEl}${it.d ? `<p class="detail-desc">${esc(it.d)}</p>` : ''}<div class="detail-price">${price}</div></div>`   // D-3 r3 frame 3: name, description, price
        : `<div class="detail-body">${nameEl}<div class="detail-price">${price}</div>${it.d ? `<div class="detail-desc">${esc(it.d)}</div>` : ''}</div>`);
      const groupLabel = (g) => `<div class="detail-cat-label"><span>${esc(g.label)}</span><span class="grp-status ${o.staged.choice ? 'done' : 'req'}">${o.staged.choice ? IC.check.replace('class="i"', '') + 'Requerido' : IC.alert.replace('class="i"', '') + 'Elegí 1 · Requerido'}</span></div>`;
      const variantRows = (g, min) => `<div class="detail-extras-list">${g.choices.map((c) => { const sel = o.staged.choice === c.id, delta = c.p - min > 0 ? c.p - min : null, off = soldOf(c.id); return `<div class="detail-variant-row${sel ? ' sel' : ''}${off ? ' sold-out' : ''}" data-act="variant" data-id="${esc(c.id)}" role="radio" aria-checked="${sel}"${off ? ' aria-disabled="true" style="opacity:.45"' : ''} tabindex="0"><div><span class="detail-extras-name">${esc(c.choice)}</span>${off ? '<span class="detail-extras-price">Agotado</span>' : delta !== null ? `<span class="detail-extras-price">+${money(delta)}</span>` : ''}</div><span class="detail-variant-radio"></span></div>`; }).join('')}</div>`;
      const optLabel = (cat) => `<div class="detail-cat-label"><span>${esc(cat)}</span><span class="grp-status optional">Opcional</span></div>`;
      const exOfChoice = () => { const c = o.staged.choice ? find(o.staged.choice) : null; return c ? c.ex : (it.group ? [] : it.ex); };
      if (o.kind === 'edit') {
        html += `<div class="detail-body">${nameEl}${o.n > 1 ? `<div class="detail-desc">Se aplica a ${o.n === 2 ? 'las' : 'los'} ${o.n} ${unit[1]} de esta línea.</div>` : ''}</div>`;
        if (it.group) { const min = Math.min(...it.group.choices.map((c) => c.p)); html += groupLabel(it.group) + variantRows(it.group, min); }
        for (const grp of extrasByCat(it.group ? exOfChoice() : it.ex)) html += optLabel(grp.cat) + `<div class="detail-extras-list">${grp.list.map((e) => extraRow(e, o.staged.ex[e.id] || 0, 'staged', `data-eid="${esc(e.id)}"`)).join('')}</div>`;
      } else if (o.kind === 'launcher') {
        const g = it.group, min = Math.min(...g.choices.map((c) => c.p)), max = Math.max(...g.choices.map((c) => c.p));
        html += body(min === max ? money(min) : 'desde ' + money(min)) + groupLabel(g) + variantRows(g, min);
        for (const grp of extrasByCat(exOfChoice())) html += optLabel(grp.cat) + `<div class="detail-extras-list">${grp.list.map((e) => extraRow(e, o.staged.ex[e.id] || 0, 'staged', `data-eid="${esc(e.id)}"`)).join('')}</div>`;
      } else {
        const q = qtyOf(it.id), l = cart.lines().find((x) => x.key === it.id);
        html += body(money(it.p));
        if (q > 0 && it.ex.length) for (let inst = 0; inst < q; inst++) {
          if (q > 1) html += `<div class="detail-pizza-header">${esc(unit[0][0].toUpperCase() + unit[0].slice(1))} ${inst + 1}</div>`;
          for (const grp of extrasByCat(it.ex)) html += optLabel(grp.cat) + `<div class="detail-extras-list">${grp.list.map((e) => extraRow(e, (l && l.ex[inst] && l.ex[inst][e.id]) || 0, 'extra', `data-eid="${esc(e.id)}" data-inst="${inst}"`)).join('')}</div>`;
        }
      }
      if (S.refusal) html += `<div class="cartnote">${IC.info}<span>${esc(S.refusal)}</span></div>`;
      html += '<div style="height:12px"></div>';
      detailHad = $('detail-modal').contains(doc.activeElement) ? descOf(doc.activeElement) : null;
      const keep = $('detail-scroll').scrollTop, db = desk ? $('detail-dbody') : null, keepB = db ? db.scrollTop : 0; $('detail-scroll').innerHTML = html; $('detail-scroll').scrollTop = keep; if (db) db.scrollTop = keepB;
      const step = $('detail-step'), cta = $('detail-cta'); cta.disabled = false; cta.className = 'detail-cta';
      const stepper = (n, minusOk, plusOk = true) => `<button class="detail-step-btn" data-act="qty" data-delta="-1" aria-label="Quitar una"${minusOk ? '' : ' disabled'}>−</button><span class="detail-step-num" aria-live="polite">${n}</span><button class="detail-step-btn" data-act="qty" data-delta="1" aria-label="Agregar una"${plusOk ? '' : ' disabled aria-disabled="true"'}>+</button>`;
      const label = (verb, amount) => `<span>${verb}</span><span class="detail-cta-divider">·</span><span>${money(amount)}</span>`;
      if (o.kind === 'edit') { step.hidden = true; step.innerHTML = ''; const base = o.staged.choice ? find(o.staged.choice).p : it.p; const target = o.staged.choice || o.key; if (editSold(o)) { cta.disabled = true; cta.innerHTML = '<span>Agotado</span>'; return; } cta.innerHTML = label('Guardar', o.n * (base + instTotal(o.staged.ex))); return; }
      step.hidden = false;
      if (o.kind === 'launcher') { const c = it.group.choices.find((x) => x.id === o.staged.choice), n = o.staged.qty || 1; step.innerHTML = stepper(n, n > 1); if (c && (soldOf(c.id) || soldOf(it.id))) { cta.disabled = true; cta.innerHTML = '<span>Agotado</span>'; return; } if (!c) { cta.disabled = true; cta.innerHTML = `<span>Elegí tu ${esc(it.group.label.toLowerCase())}</span>`; } else cta.innerHTML = label('Agregar', n * (c.p + instTotal(o.staged.ex))); return; }
      const q = qtyOf(it.id);
      if (isSold(it)) { const q0 = qtyOf(it.id); step.innerHTML = q0 > 0 ? stepper(q0, true, false) : stepper(o.staged.qty || 1, false, false); cta.disabled = true; cta.innerHTML = '<span>Agotado</span>'; return; }   // Codex perf-core r3 #1: + inert, − live
      if (q === 0) { const n = o.staged.qty || 1; step.innerHTML = stepper(n, n > 1); cta.innerHTML = label('Agregar', n * it.p); }
      else { const lineSum = cart.groups().filter((g) => g.key === it.id).reduce((a, g) => a + g.total, 0); step.innerHTML = stepper(q, true); cta.innerHTML = label('Guardar', lineSum); }
    }
    function detailAct(t) {
      const o = S.open, it = find(o.id), act = t.dataset.act;
      if (act === 'qty') { const d = Number(t.dataset.delta); if (d > 0 && isSold(it)) { renderDetail(); return; }   // r3 #1: the handler refuses a sold / refused dish's + too
        if (o.kind === 'launcher' || qtyOf(it.id) === 0) o.staged.qty = Math.max(1, (o.staged.qty || 1) + d); else { mutate(() => cart.setQty(it.id, qtyOf(it.id) + d)); if (!qtyOf(it.id)) o.staged.qty = 1; } }
      else if (act === 'extra') { const i = Number(t.dataset.inst), e = t.dataset.eid; const l = cart.lines().find((x) => x.key === it.id); const cur = Object.keys((l && l.ex[i]) || {}); mutate(() => cart.setInstance(it.id, i, cur.includes(e) ? cur.filter((k) => k !== e) : [...cur, e])); }
      else if (act === 'variant') { if (soldOf(t.dataset.id)) return; o.staged.choice = t.dataset.id; const allowed = new Set(find(o.staged.choice).ex); for (const k of Object.keys(o.staged.ex)) if (!allowed.has(k)) delete o.staged.ex[k]; }
      else if (act === 'staged') { const e = t.dataset.eid; if (o.staged.ex[e]) delete o.staged.ex[e]; else o.staged.ex[e] = 1; }
      else if (act === 'dcta') {
        if (o.kind === 'edit') { saveEdit(); return; }
        if (o.kind === 'launcher') { const c = find(o.staged.choice); if (!c || soldOf(c.id) || soldOf(it.id)) { renderDetail(); return; } if (mutate(() => cart.add(c.id, Object.keys(o.staged.ex), o.staged.qty || 1))) { bumpPill(); closeDetail(); } return; }
        if (isSold(it)) { renderDetail(); return; }
        if (qtyOf(it.id) === 0) { if (!mutate(() => cart.add(it.id, [], o.staged.qty || 1))) { renderDetail(); return; } bumpPill(); if (!it.ex.length) { closeDetail(); return; } renderDetail(); syncPill(); return; }   // with extras the sheet stays open to dress each instance (v11)
        closeDetail(); return;
      }
      renderDetail(); syncPill();
    }
    // an edit is refused when its target is sold out OR, for a choice, its launcher is
    const editSold = (o) => soldOf(o.staged.choice || o.key) || (o.staged.choice ? soldOf(o.id) : false);
    function saveEdit() {
      const o = S.open; const target = o.staged.choice || o.key;
      if (editSold(o)) { renderDetail(); return; }
      if (!mutate(() => cart.edit(o.key, o.g, Object.keys(o.staged.ex), target))) { renderDetail(); return; }   // refused: the sheet stays open, the reason shown in it
      closeDetail();
    }
    function syncPill() { const p = $('cart-bar'); if (!p) return; const n = cart.count(); p.querySelectorAll('.cart-pill-text')[0].textContent = n ? unitOf(n) : 'Tu pedido'; p.querySelectorAll('.cart-pill-text')[1].textContent = money(cartTotal()); const dc = app.querySelector('.deskcart'); if (dc) { dc.innerHTML = cartInner(true); applyOrderable(); } }   // v6 :1726 — the desk aside follows every edit (and keeps browse-only)
    function bumpPill() { const p = $('cart-bar'); if (!p) return; p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump'); }

    // ── CART SHEET (Subtotal only in S1: the fee rows are S2/S3) ──
    const lineName = (d, cls) => (d.editable
      ? `<button class="lnedit ${cls}" data-act="edit" data-key="${esc(d.key)}" data-grp="${esc(d.g)}" aria-label="Editar ${esc(d.item.n)}"><span class="ln-n">${esc(d.item.n)}</span>${d.extras ? `<span class="ln-x">+ ${esc(d.extras)}</span>` : ''}<span class="ln-ed">Editar</span></button>`
      : `<div class="lnstatic ${cls}"><span class="ln-n">${esc(d.item.n)}</span>${d.extras ? `<span class="ln-x">+ ${esc(d.extras)}</span>` : ''}</div>`);
    const lineStep = (d, sold = false) => `<div class="cstep"><button data-act="rev" data-rev="-1" data-key="${esc(d.key)}" data-grp="${esc(d.g)}" aria-label="Quitar uno de ${esc(d.item.n)}">${d.n <= 1 ? TRASH(14) : '−'}</button><span>${d.n}</span><button data-act="rev" data-rev="1" data-key="${esc(d.key)}" data-grp="${esc(d.g)}" aria-label="Agregar otro igual: ${esc(d.item.n)}"${sold ? ' disabled aria-disabled="true"' : ''}>+</button></div>`;
    function cartInner(desk = false) {   // v6 :1743 — desk ⇒ the aside: no close button, no «Ver el menú» on the empty state
      const lines = displayLines(), mode = S.mode;
      // the owner's frame 14 (MOCKUP-capp-S7a-states.html, approved 2026-10-27): a line whose dish is unavailable NOW — after a
      // dispatch refusal, or known before — keeps its row: «Agotado» in the price slot (muted, frame 12), the name block .45,
      // its + inert at .4, its trash / − LIVE; ONE calm note line per sold dish; the Subtotal leaves those lines out; «Ir al
      // checkout» stays disabled until they are removed. The mark follows the live availability (an update that says the dish
      // is back clears it) — never a stored flag.
      const soldOfLine = (d) => isSold(find(d.key));
      const soldDishes = [...new Map(lines.filter(soldOfLine).map((d) => [d.key, d.item.n])).values()];
      const total = lines.reduce((a, d) => a + (soldOfLine(d) ? 0 : d.total), 0);
      const head = `<div class="sheethead"><div><h2>Tu pedido</h2><small>${desk && S.desk ? esc(cfg.name || '') + (lines.length ? ' · ' + unitOf(cart.count()) : '') : (lines.length ? unitOf(cart.count()) + ' · ' : '') + (mode === 'delivery' ? 'Delivery' : 'Pickup')}</small></div>${desk ? '' : `<button class="iconbtn" data-act="cartclose" aria-label="Cerrar el carrito">${IC.close}</button>`}</div>`;
      // C-6c (advisor call 7): the guest's card-only note — true copy, drawn only while the guest rules are ON (runtime.guestCardOnly)
      const cnote = desk && S.desk && opts.guestCardOnly === true && authOf() === 'guest' ? '<div class="cnote"><b>Pagás con tarjeta.</b> Creá una cuenta para pagar en efectivo y sumar recompensas.</div>' : '';
      const upd = appUpdated() && lines.length > 0;   // state 4: only over a cart that survived the update
      const updNote = upd ? `<div class="cartnote" role="status">${IC.info}<span>App actualizada. Tu carrito sigue aquí.</span></div>` : '';
      const note = S.cartNote ? `<div class="cartnote">${IC.info}<span>${S.cartNote === 1 ? '1 plato ya no está disponible' : S.cartNote + ' platos ya no están disponibles'}</span></div>` : '';
      const over = tooLong();
      const refusal = S.refusal || over ? `<div class="cartnote">${IC.info}<span>${esc(over ? FULL_CART : S.refusal)}</span></div>` : '';
      if (!lines.length) return head + note + (desk && S.desk ? `<div class="empty">${IC.bag}<b>Tu pedido está vacío</b><span>Agregá platos del menú y aparecen aquí.</span></div>` : `<div class="empty">${IC.bag}<span>Tu pedido está vacío.</span>${desk ? '' : '<button class="btn2" data-act="cartclose">Ver el menú</button>'}</div>`);
      const soldNote = soldDishes.length ? `<div class="cartnote" role="status">${IC.info}<span>${soldDishes.map((n) => `<span class="cn-l">${esc(n)} se agotó. Quitalo para enviar tu pedido.</span>`).join('')}</span></div>` : '';
      // the owner's frame 10 (approved 2026-10-27): a cart FROZEN for a placement (S7a-1 r3 §1.1) is read-only — one calm note,
      // the lines' controls at the drawn .45 (disabled), and «Ver estado del pedido»: the placement's STATUS (poll with its stored
      // credentials, else «Necesitamos revisar tu pedido») — never a send. No other exit (ruling: no «Empezar un pedido nuevo»)
      if (frozenNow()) {
        return head + `<div class="cartnote"${upd ? ' role="status"' : ''}>${IC.info}<span>${upd ? '<span class="cn-l">App actualizada. Estamos revisando tu pedido.</span><span class="cn-l">Tu pedido se está confirmando; no se puede cambiar mientras tanto.</span>' : 'Tu pedido se está confirmando; no se puede cambiar mientras tanto.'}</span></div>` + lines.map((d) => `<div class="cline frozen">${lineName(d, 'cl-txt').replace(/^<button /, '<button disabled aria-disabled="true" ')}${lineStep(d).replace(/<button /g, '<button disabled aria-disabled="true" ')}<span class="cl-p">${money(d.total)}</span></div>`).join('')
          + `<div class="ctot"><div class="sumrow"><span>Subtotal</span><span>${money(total)}</span></div></div>`
          + '<div class="sheetbar"><button class="primary" data-act="frozen-status">Ver estado del pedido</button></div>';
      }
      const off = over || soldDishes.length > 0;
      // the owner's frame 13 (approved 2026-10-27; the forms' Plan 5 pattern, b8ba8467): a configuration whose unit price changed
      // since the customer last saw it — ONE calm note line PER CHANGED CONFIGURATION (r3.4-1; Codex s7a2 r1 #6), named as its cart
      // line shows it («Carnivora + Pepperoni») with ITS configured unit prices, and each changed line's OLD subtotal struck above the
      // new one. Totals at the new price; no block, no accept button (continuing is acceptance); a sold line keeps frame 14 instead
      const changes = cart.priceChanges().filter((c) => !isSold(find(c.key)));
      const confName = (c) => c.name + (c.sig ? ' + ' + c.sig.split(',').map((k) => (menu.extra(k) || { name: k }).name).join(', ') : '');
      const priceNote = changes.length && mods() ? `<div class="cartnote" role="status">${IC.info}<span>${changes.map((c) => `<span class="cn-l">${esc(C.priceNoticeText({ name: confName(c), from: c.fromCents / 100, to: c.toCents / 100 }))}</span>`).join('')}</span></div>` : '';
      const oldOf = (d) => { const cs = changes.filter((c) => c.key === d.key && c.sig === d.g); return cs.length ? d.total - cs.reduce((a, c) => a + (c.newSubtotalCents - c.oldSubtotalCents) / 100, 0) : null; };
      return head + updNote + note + refusal + soldNote + priceNote + lines.map((d) => { const so = soldOfLine(d), old = so ? null : oldOf(d);
        return `<div class="cline${so ? ' sold-out' : ''}">${lineName(d, 'cl-txt')}${lineStep(d, so)}<span class="cl-p">${so ? 'Agotado' : old !== null ? `<s class="cl-old">${money(old)}</s>${money(d.total)}` : money(d.total)}</span></div>`; }).join('')
        + cnote + `<div class="ctot"><div class="sumrow"><span>Subtotal</span><span>${money(total)}</span></div></div>`
        + `<div class="sheetbar"><button class="primary${soldDishes.length ? ' sold-wait' : ''}" data-act="checkout"${off ? ' disabled aria-disabled="true"' : ''}>Ir al checkout</button></div>`;
    }
    function runStoreSearch(q) {
      const box = $('sresults'); if (!box) return;
      const nq = norm(q).trim(); const hits = nq ? sections.flatMap((s) => s.items).filter((it) => norm(it.n + ' ' + (it.d || '')).includes(nq)) : [];
      box.innerHTML = !nq ? '' : hits.length ? `<div class="rcount">${hits.length} resultado${hits.length === 1 ? '' : 's'}</div>${hits.map(rowHtml).join('')}` : `<div class="noresults">Nada con «${esc(q)}». Probá otra palabra.</div>`;
    }
    function openLayer(kind) { if (kind === 'cart' && S.layerKind !== 'cart') pushHist(); returnTo = descOf(doc.activeElement); S.layerKind = kind; renderLayer(true); }   // the cart is a back step (P openCart :1752)
    // THE layer teardown (Codex guest r2 #2): every way a layer goes away — closeLayer, a browser / device Back — runs it: the pin map is
    // dropped, and a code sheet's pending verification is invalidated (its late success never sends)
    function layerTeardown() {
      const k = S.layerKind;
      if (k === 'otp' || k === 'err') { otpTickStop(); S.otp = null; }
      if (k === 'pin') dropPinMap();
    }
    function closeLayer() {
      if (S.layerKind === 'placing') placingStop(); if (S.layerKind === 'cart') appUpdatedSeen(); layerTeardown(); S.layerKind = null; S.cartNote = null; S.refusal = null; S.err = null; renderLayer(); const back = refind(returnTo); returnTo = null; focusTo(back || $('cart-bar') || $('cta')); closeLayerThen(); }
    // a quote that failed while another layer was open: its sheet once that layer closes (still the same failed state)
    function closeLayerThen() { if (S.quoteErrSheet && !S.layerKind && (S.screen === 'checkout' || S.screen === 'tip')) { S.quoteErrSheet = false; if (S.quoteErr && S.quoteErr === stateKey()) showErr(ERR.generic('err-requote')); } }
    const T_report = () => { if (typeof queueMicrotask === 'function') queueMicrotask(reportRoute); else reportRoute(); };   // after the sheet's state is set
    function renderLayer(fresh) { T_report(); return renderLayerNow(fresh); }
    function renderLayerNow(fresh) {
      if (dead) return;
      const L = $('layer'); if (!L) return; const k = S.layerKind;
      if (!k) { L.innerHTML = ''; syncInert(); return; }
      const keep = !fresh && L.contains(doc.activeElement) ? descOf(doc.activeElement) : null;   // S2b: a keypad tap keeps its key focused
      if (k === 'ssearch' && !fresh && L.querySelector('#sq')) { runStoreSearch(S.searchQ); syncInert(); return; }   // an open search keeps its query, results and focus
      if (k === 'cart') L.innerHTML = `<div class="scrim" data-act="cartclose"></div><div class="sheet" role="dialog" aria-label="Tu pedido" style="padding-bottom:0"><div class="grab"></div>${cartInner()}</div>`;
      else if (k === 'menu') { const total = sections.reduce((a, s) => a + s.items.length, 0); L.innerHTML = `<div class="scrim" data-act="lclose"></div><div class="sheet" role="dialog" aria-label="Menú completo"><div class="grab"></div><div class="sheethead"><div><h2>Menú</h2><small>${isOpen() ? 'Abierto hoy · cierra ' + esc(closesText()) : 'Cerrado · ' + esc(opensText())} · ${total} platos</small></div><button class="iconbtn" data-act="lclose" aria-label="Cerrar">${IC.close}</button></div><nav aria-label="Secciones">${sections.map((s) => `<button class="navrow${s.id === S.activeSec ? ' on' : ''}" data-act="goto" data-goto="${esc(s.id)}">${esc(s.name)}<span>${s.items.length}</span></button>`).join('')}</nav></div>`; }
      else if (k === 'ssearch') { L.innerHTML = `<div class="search" role="dialog" aria-label="Buscar en el menú"><div class="searchbar"><label for="sq">${IC.search}<input id="sq" type="search" placeholder="Buscar platos" autocomplete="off" data-field="sq" value="${esc(S.searchQ)}"></label><button class="textbtn" data-act="lclose">Cancelar</button></div><div class="results" id="sresults"></div></div>`; runStoreSearch(S.searchQ); }
      // S2b layers (the prototype's renderLayer kinds)
      else if (k === 'err') L.innerHTML = errSheet(S.err);
      else if (k === 'otp') L.innerHTML = codeSheetHtml();
      else if (k === 'placing') L.innerHTML = placingHtml();
      else if (k === 'tipother') L.innerHTML = tipOtherHtml();
      else if (k === 'pin') L.innerHTML = pinStepHtml();
      else if (k === 'feeinfo') L.innerHTML = feeInfoHtml();
      else if (k === 'cc') L.innerHTML = ccSheetHtml();
      else if (k === 'paysheet') L.innerHTML = sdkChooserHtml();   // S2-checkout 2
      else if (k === 'sdkproc') L.innerHTML = SDK.proc ? PCO.procHtml(SDK.proc) : '';   // 4 / 4b
      else if (k === 'sdkdecl') L.innerHTML = SDK.decl ? PCO.declineHtml(SDK.decl, sdkCtx()) : '';   // 5
      syncInert();
      if (fresh) { const first = k === 'ssearch' ? $('sq') : L.querySelector(FOCUSABLE); focusTo(first); }
      else if (keep && lost()) focusTo(refind(keep));
      if (k === 'pin') wireMaps();
    }

    // ═══ S-picker: the WhatsApp field's country (mockup frames 4–6) ═══
    // the note under the input: a non-HN country names itself and its national length; once complete, how it will be saved
    function ccNote(f) {
      const P = phoneMod(), cc = ccOf(f), c = P.byCc(cc); if (cc === P.DEFAULT_CC) return '';
      return `${esc(c.name)} · <b>${c.len} dígitos</b>${P.valid(cc, f.phone) ? ` · se guarda como <b>${esc(P.display(cc, f.phone))}</b>` : ''}`;
    }
    function phoneFld(f, extra, off) {   // off: frame 10b's fixed variant (the cash-chips lock)
      const P = phoneMod(), cc = ccOf(f), c = P.byCc(cc), open = S.layerKind === 'cc', note = ccNote(f);
      return `<div class="fld"><label for="f-phone">WhatsApp <span class="req">*</span></label><div class="phonerow"><button type="button" class="cc${open ? ' focus' : ''}" data-act="cc" aria-label="País del número: ${esc(c.name)} +${cc}" aria-haspopup="dialog"${off ? ' disabled' : ''}>+${cc} ${open ? IC.up : IC.down}</button><input id="f-phone" data-field="phone" type="tel" inputmode="numeric" value="${esc(P.format(cc, f.phone))}" placeholder="${esc(c.ph)}" autocomplete="tel"${off ? ' disabled' : ''}></div><div class="note" id="f-phone-cc"${note ? '' : ' hidden'}>${note}</div>${extra}</div>`;
    }
    function ccSheetHtml() {
      const P = phoneMod(), cur = ccOf(S.flow);
      return `<div class="scrim" data-act="lclose"></div><div class="sheet ccsheet" role="dialog" aria-label="País del número"><div class="grab"></div>
        <div class="sheethead"><h2>País del número <small>Solo cambia el código de tu WhatsApp. Entregamos únicamente en Honduras.</small></h2><button class="iconbtn" data-act="lclose" aria-label="Cerrar">${IC.close}</button></div>
        ${P.COUNTRIES.map((c) => `<button class="crow${c.cc === cur ? ' on' : ''}" data-act="cc-pick" data-cc="${c.cc}" aria-pressed="${c.cc === cur}"${hasSlotLock() ? ' disabled tabindex="-1"' : ''}><span class="nm">${esc(c.name)}</span><span class="code">+${c.cc}</span>${c.cc === cur ? IC.check : ''}</button>`).join('')}</div>`;
    }

    // ═══ S2b: CHECKOUT ═══
    const T_ = opts.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h), setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h) };
    const navTo = opts.navigate || ((url) => { doc.defaultView.location.assign(url); });
    const navigate = (url) => { if (!dead) navTo(url); };
    // the order-intake key (per-brand config, data only; never logged): createOrder / chargeOnlineOrder require it (index.js:750-760,
    // :1469-1479). Missing ⇒ the app sends nothing: a config error at boot and «Hacer pedido» stays disabled (fail closed)
    const intakeOk = () => typeof cfg.intakeKey === 'string' && cfg.intakeKey !== '';
    const intakeHeaders = () => ({ Authorization: 'Bearer ' + cfg.intakeKey });
    // G6 §4c: the member can ARRIVE mid-flow (an in-app sign-in): setMember() swaps it and the checkout fills in place
    let memberCtx = opts.member || null;
    const member = () => memberCtx;
    // PLAN-capp-signin-required r5.4 §3 (owner FINAL: app guests pay CARD ONLY; frozen approved mockup 2026-10-27). DARK behind the
    // runtime flag cfg.guestCardOnly (the shell sets it); absent ⇒ today's S2 checkout byte for byte. ONE invariant for every
    // dispatch / restore / retry: a guest's effective tender is ONLINE, else it is refused locally (frame 6) — nothing is sent.
    const cardOnlyGuest = () => cfg.guestCardOnly === true && !member();
    // PLAN-intl-phone r2.3 S-picker (MOCKUP-intl-phone-picker-APPROVED-2026-10-27, frames 4–6): the runtime flag cfg.intlPhone (the
    // shell sets it); absent ⇒ today's single «+504» input and the '+504 9999-9999' wire, byte for byte. Present ⇒ the country button +
    // sheet, the national length / local format per country, and E.164 on the wire for EVERY country (+504 included). FLIP
    // PRECONDITION: S-core / S-match (server) landed AND the per-sender UltraMsg country gate passed (plan §5)
    const intl = () => cfg.intlPhone === true;
    // PLAN-capp-S4 (r5): scheduled orders — the runtime flag cfg.schedulingLive (the shell sets it, with the SERVED schedule in
    // cfg.schedule); absent ⇒ today's ASAP-only checkout, byte for byte. FLIP PRECONDITIONS: signup LIVE + PIN owner records; the
    // «revisando» / tracker transitions need the (d) owner lookup (C = the scheduled variant of S5's order screen)
    const sched = () => cfg.schedulingLive === true;
    let SKM = null;
    const schedMod = () => SKM || (SKM = opts.CappSchedule || (typeof self !== 'undefined' && self.CappSchedule) || require('./capp-schedule.js'));
    // the schedule the picker computes from: P1 (the directory's, in hand) until a P2 revalidation is applied at a USER action
    const servedSched = () => S.sched || cfg.schedule || null;
    const applyHeldSched = () => { if (S.schedHeld) { S.sched = S.schedHeld; S.schedHeld = null; } };
    const schedDays = () => schedMod().days(servedSched(), now().getTime(), S.flow ? S.flow.mode : 'delivery');
    const anySlotNow = () => schedDays().some((d) => d.slots.length > 0);
    // row 10: a RETAINED scheduled identity (dispatched, its body recorded) — its slot is fixed until the send resolves
    // Codex G7 r1 #1: from the RECORD only (capp-api's retainedSend), never from the current flow — and only for the member who sent it
    // (owner); a guest or another member sees no lock (and is refused locally at the send, heldByOther)
    function lockedBody() {
      if (!sched() || !api || !S.flow) return null;
      let rs = null; try { rs = api.retainedSend(); } catch (_) { rs = null; }
      const m = member();
      return rs && m && typeof m.uid === 'string' && rs.owner === m.uid ? rs.body : null;
    }
    const heldByOther = () => { try { return !!(sched() && api && api.retainedByOther()); } catch (_) { return false; } };
    // Codex G7 r3: the retained send's slot — null whenever the record has none (an owned ASAP send keeps its tender lock, never a slot
    // lock); hasSlotLock() is the ONE predicate every consumer reads
    function lockedSlot() { const b = lockedBody(); return b && Number.isFinite(b.scheduled_for) ? b.scheduled_for : null; }
    const hasSlotLock = () => lockedSlot() !== null;
    // advisor ruling (a), Codex S4 r2: the TENDER of a retained send is fixed with its slot — the recorded one (the replay re-sends
    // those bytes to that tender's endpoint); null ⇒ not locked
    function lockedPay() { const b = lockedBody(); return b ? (b.payment_method === 'online' ? 'online' : 'cash') : null; }
    // Codex S4 r1 #1 (owner G=B): scheduling requires an account — the ONE guard every scheduling entry (the cards, the closed
    // preselect, the closure sheet's «Programar», the Inicio cue, a restore) and the dispatch go through; a non-member gets frame G
    // (the order stays ASAP, so a closed store's closure refusal stands)
    const canSchedule = () => !!member();
    function scheduleGate() { S.schedAfterSignin = true; emit('signin', { ctx: 'schedule' }); }
    let PH = null;
    const phoneMod = () => PH || (PH = opts.CappPhone || (typeof self !== 'undefined' && self.CappPhone) || require('./capp-phone.js'));
    const ccOf = (f) => (f && f.cc && phoneMod().byCc(f.cc) ? f.cc : phoneMod().DEFAULT_CC);
    // a stored / member number into the flow — the plan's wire contract: a QUALIFIED E.164 ⇒ its country; a bare number of EXACTLY 8
    // digits (or 504 + 8) ⇒ Honduras; anything else is unparseable ⇒ false, the phone left empty (never a composed +504 guess)
    const LEGACY_PHONE = /^(?:\+?504[ -]?)?\d{4}[ -]?\d{4}$/;
    function setPhone(f, raw) {
      const P = phoneMod(), q = P.parseE164(raw);
      if (q) { f.cc = q.cc; f.phone = P.format(q.cc, q.national); return true; }
      // Codex S-picker r1 #2: the legacy fallback accepts ONLY the known legacy syntax — 8 digits with an optional space / dash, an
      // optional 504 / +504 prefix — checked BEFORE any stripping ('9612+3344', 'abc96123344', '( +44 ) 123456' are never a +504 number)
      const t = String(raw || '').trim(), ok = LEGACY_PHONE.test(t);
      f.cc = P.DEFAULT_CC; f.phone = ok ? P.format(P.DEFAULT_CC, P.digits(t).slice(-8)) : '';
      return ok;
    }
    // the ONE fresh flow: with the picker on, the member's number lands in its own country; a member number that does not parse opens
    // «Tus datos» in edit (the customer types it) — the member path never sends a number it could not read (5f intl recon)
    function newFlow() {
      const f = C.freshFlow(member());
      if (sched()) { f.time = isOpen() || !canSchedule() ? 'asap' : 'schedule'; f.slot = null; f.slotDay = null; }
      if (intl()) { const m = member(); if (!setPhone(f, m && m.phone ? m.phone : '') && m) f.editWho = true; }
      return f;
    }
    // how a number is shown back (the code sheet, the member row): the picker's '+cc formatted'; off ⇒ the forms' fullPhone, as before
    const phoneShown = (f) => (intl() ? phoneMod().display(ccOf(f), f.phone) : C.fullPhone(f.phone));
    // the modules are resolved LAZILY (the S1 host may load the page without them): no modules ⇒ the store keeps S1's host event
    let C = null, api = null;
    function mods() {
      if (C && api) return true;
      try {
        C = opts.CappCheckout || (typeof self !== 'undefined' && self.CappCheckout) || require('./capp-checkout.js');
        const A = opts.CappApi || (typeof self !== 'undefined' && self.CappApi) || require('./capp-api.js');
        api = opts.api || A.createApi({ config: apiConfigOf(cfg),
          CappCheckout: C, member, ...(opts.apiOpts || {}), now: () => now().getTime() });   // Codex promo r4 #3: ONE clock — the transport judges the token at the UI's time (the claim's), never a second apiOpts.now
        return true;
      } catch (_) { C = null; api = null; return false; }
    }
    // the ported «El precio cambió» sheet (capp-confirm-quote.js confirmPriceSheet), passed through place({ sheet }) unrestyled
    const priceSheet = opts.priceSheet || ((o) => { const fn = (typeof self !== 'undefined' && self.confirmPriceSheet) || (doc.defaultView && doc.defaultView.confirmPriceSheet); return fn ? fn({ document: doc, oldCents: o.oldCents, newCents: o.newCents }) : Promise.resolve(false); });
    // cents → «L 485» (whole) / «L 485.50»
    const moneyC = (c) => { const n = Number(c) || 0; return n % 100 === 0 ? money(n / 100) : 'L ' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    const storeLine = () => esc(cfg.name || '') + (cfg.branch ? ' · ' + esc(cfg.branch) : '');
    const logoChip = (cls) => (cfg.logo ? `<span class="${cls}${cfg.logoWide ? ' wide' : ''}"><img src="${esc(cfg.logo)}" alt=""></span>` : `<span class="${cls} txt" aria-hidden="true">${esc(String(cfg.name || '').split(' ').map((x) => x[0]).join('').slice(0, 2))}</span>`);
    const finitePin = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

    // ── the order context, the state key (what a quote stands for) and the totals of the CURRENT state ──
    function ctxBase() { const s = CappSerialize.serialize(cart, menu); return { restaurantId: cfg.restaurantId, items: s.items, itemsText: s.items_text, member: member(), ...(sched() ? { appCash: true } : {}) }; }
    function stateKey() { const f = S.flow; const m = member(); return JSON.stringify([f.mode, f.mode === 'delivery' ? f.pin : null, C.tipCentsOf(f), cart.snapshot().lines, m && m.uid ? m.uid : null]); }
    function totalsNow() { if (!S.flow || !S.q || S.qKey !== stateKey()) return { ready: false }; return C.totals(S.flow, S.q, cart.subtotalCents(), S.q.sig); }
    // delivery is quoted only once there is an address to price: a confirmed pin, or the device location (never the branch fallback)
    const quotable = (f) => f.mode !== 'delivery' || (finitePin(f.pin) && (f.pin.confirmed === true || S.geo === 'ok'));
    // ONE quote per state: entry, mode / pin / tip / cart change (newer-wins is capp-api's)
    async function requote() {
      if (!S.flow || !mods() || !cart.count() || S.screen === 'store' || S.screen === 'sending') return;
      const f = S.flow; const key = stateKey();
      if (key === S.askedKey || key === S.quoteErr) return;   // a failed state waits for «Reintentar» or a change (no loop)
      S.askedKey = key;
      if (!quotable(f)) { S.q = null; S.qKey = null; return; }
      let c; try { c = ctxBase(); } catch (_) { return; }
      const r = await api.quote(f, c);
      if (dead || r.kind === 'superseded') return;
      // S2b r1 P2-6: a failed quote is never a silent dead end — the key is released and the generic held state offers «Reintentar»
      if (r.kind === 'offline' || r.kind === 'try_again' || r.kind === 'refused') { S.askedKey = null; S.quoteErr = key; quoteFailed(); }
      else S.quoteErr = null;
      if (r.kind === 'ok') { S.q = r.record; S.qKey = key; if (f.mode === 'delivery') { S.outZone = false; if (r.record.resp.delivery) S.lastDelivery = r.record.resp.delivery; } }
      else if (r.kind === 'out_of_zone') { S.outZone = true; }
      // pin / offline / try_again / refused / update_required: no amount is shown (never a guess); a refused QUOTE has no sheet; the placement's sheets are below (onOutcome)
      if (S.pinToast && f.mode === 'delivery') { S.pinToast = false; if (r.kind === 'ok') toast('Pin confirmado', TOAST_MS); else if (r.kind === 'out_of_zone') toast('Ese punto queda fuera de la zona', TOAST_MS); }
      if (S.screen === 'checkout' || S.screen === 'tip') render();
    }
    // ── gates (capp-checkout missingStep, G0 first) ──
    const poKeys = new Set(); for (const s of sections) if (s.pickupOnly) for (const it of s.items) { poKeys.add(it.id); if (it.group) for (const c of it.group.choices) poKeys.add(c.id); }
    const poLines = () => cart.lines().filter((l) => poKeys.has(l.key));
    const sectionOfKey = (k) => sections.find((s) => s.items.some((it) => it.id === k || (it.group && it.group.choices.some((c) => c.id === k))));
    // r3.3-F2: a cart line whose dish (or its choice's launcher) is known unavailable NOW blocks placement — cash and card alike (no
    // new copy: the line carries the drawn «Agotado» mark; the CTA stays as labelled, disabled)
    const soldLines = (has = soldOf) => cart.lines().filter((l) => isSoldBy(find(l.key), has));
    const soldBlock = () => soldLines().length > 0;
    const gateCtx = () => ({ open: isOpen(), closedRefused: S.closedRefused, ...(sched() ? { anySlot: hasSlotLock() || anySlotNow() } : {}), pickupOnlyCount: poLines().length, outZone: S.outZone, member: member(), unavailableLines: soldLines().length,
      ...(cardOnlyGuest() ? { guestEmail: true, emailRefused: S.emailRefused === true } : {}) });
    const need = () => C.missingStep(S.flow, gateCtx());
    function ctaLabel(T) {
      if (hasSlotLock()) return 'Reintentar';   // row 10b: the drawn «Reintentar» re-sends the SAME order
      const n = need(); if (n) return n;
      if (S.flow.mode === 'delivery') return 'Continuar';   // delivery continues to the tip step
      const amt = T.ready ? ' · ' + moneyC(T.total) : '';   // pickup places from here (no tip); no amount until the quote is ready
      return S.flow.pay === 'online' ? (sdkOn() ? 'Hacer pedido' : 'Pagar') + amt : 'Confirmar pedido' + amt;   // S2-checkout v7: «Hacer pedido · L X»
    }
    // cash-chips lock: on 10b the fields need() reads are FIXED and the replay re-sends the recorded body — they never block «Reintentar»
    // (a remounted 10b with an empty flow would otherwise be a dead end)
    const ctaOff = (T) => (!hasSlotLock() && !!need()) || soldBlock() || (S.flow.mode !== 'delivery' && (!T.ready || !intakeOk()));   // pickup places from here
    function syncCta() { const b = $('cta'); if (!b || !S.flow) return; const T = totalsNow(); b.disabled = ctaOff(T); b.textContent = ctaLabel(T); }

    // ── the map: the drawn chrome; a real Google map inside it when a key is configured, else the schematic SVG ──
    const loadMaps = () => loadMapsFor(doc, cfg.mapsKey);
    const mapCenter = () => { const p = S.pinDraft || (S.flow && S.flow.pin); return finitePin(p) ? { lat: p.lat, lng: p.lng } : (cfg.loc && finitePin(cfg.loc) ? { lat: cfg.loc.lat, lng: cfg.loc.lng } : null); };
    const gmapBox = (kind) => (cfg.mapsKey ? `<div class="gmap" data-gmap="${kind}" style="position:absolute;inset:0"></div>` : '');   // TODO(owner ruling): style the live map; S2b keeps the drawn chrome on top
    let pinGen = 0, pinMap = null;   // S2b r1 P1-2: the ACTIVE pin map; an obsolete instance's callbacks are dropped
    // the pin step closing — «Listo», «Cancelar», device back — makes its map obsolete: a late idle never reaches the checkout
    function dropPinMap() { pinGen++; pinMap = null; S.pinDraft = null; }
    // capp-dark §3 (PLAN r2): the live maps follow the OS — ONE subscription per mount restyles every live instance IN PLACE
    // (setOptions on the same map: camera, pin draft and listeners untouched); never a render. Absent CappTheme ⇒ light, no subscription
    const Theme = opts.CappTheme || (typeof self !== 'undefined' && self.CappTheme) || null;
    const themeStyles = () => (Theme ? Theme.mapStyles(doc.defaultView) : null);
    const unTheme = Theme && doc.defaultView ? Theme.subscribe(doc.defaultView, () => {
      if (dead) return;
      for (const el of app.querySelectorAll('[data-gmap]')) if (el.__map && typeof el.__map.setOptions === 'function') { try { el.__map.setOptions({ styles: themeStyles() }); } catch (_) {} }
    }) : null;
    function wireMaps() {
      const els = [...app.querySelectorAll('[data-gmap]')]; if (!els.length) return;
      const p = loadMaps(); if (!p) return;
      p.then((gm) => {
        for (const el of els) {
          const c = mapCenter(); if (!el.isConnected || el.__map || !c) continue;
          const big = el.dataset.gmap === 'pin';
          const m = new gm.Map(el, { center: c, zoom: 17, disableDefaultUI: true, clickableIcons: false, gestureHandling: big ? 'greedy' : 'none', keyboardShortcuts: big, styles: themeStyles() });   // capp-dark §3: the theme read at CONSTRUCTION (a late load is never stale)
          el.__map = m;
          if (big) { const gen = ++pinGen; pinMap = { gen, m, el }; m.addListener('idle', () => { if (gen !== pinGen || dead) return; const cc = m.getCenter(); if (cc) S.pinDraft = { lat: cc.lat(), lng: cc.lng() }; }); }
        }
      }).catch(() => {});
    }
    // S2b-geo: ONE reverse-geocode per CONFIRMED pin version (GPS fix, «Listo», a saved address, a restored return); an unconfirmed
    // fallback pin is never geocoded. The reply applies only to the version it was asked for (C.applyGeocode); a failure settles
    // the version with nothing. No Maps key ⇒ no geocode (today's row).
    // The reply NEVER re-renders (r1 P1/P3): it patches the address text nodes in place, so an open pin editor keeps its live map,
    // centre and draft, the «Realizando» countdown keeps running and «Enviando»'s completion check stays.
    let geoAsked = null;   // { f, v }: the flow + version already asked
    function geocodePin() {
      const f = S.flow;
      if (dead || !f || f.mode !== 'delivery' || !(f.pin && f.pin.confirmed === true) || !finitePin(f.pin)) return;
      const v = f.pinV, at = { lat: f.pin.lat, lng: f.pin.lng };   // r1 P2: the coordinates of THIS version, captured with it
      if ((f.geo && f.geo.v === v) || (geoAsked && geoAsked.f === f && geoAsked.v === v)) return;
      const p = loadMaps(); if (!p) return;
      geoAsked = { f, v };
      const land = (results) => { if (dead || !C.applyGeocode(f, v, results) || S.flow !== f) return; paintAddr(); };
      p.then((gm) => {
        if (dead || f.pinV !== v) return;   // r1 P2: the pin moved while Maps loaded — obsolete, never sent (the new version asks for itself)
        try { new gm.Geocoder().geocode({ location: at }, (results, status) => land(status === 'OK' ? results : [])); } catch (_) { land([]); }
      }).catch(() => land([]));
    }
    // the address text nodes ([data-addr]: the checkout row's bold, «Realizando»'s store sub, «Enviando»'s row bold), in place
    function paintAddr() {
      const line = C.addrLine(S.flow); if (!line) return;   // none: the rendered text already is today's
      for (const el of app.querySelectorAll('[data-addr]')) el.textContent = line;
    }
    // S7a-2: the shell's guest location (opts.seedPin: { lat, lng, confirmed } or a function returning it); a pin the customer
    // confirms here is reported back (onEvent 'pin') so the shell's guest location follows it
    const seedPin = () => { let p = null; try { p = typeof opts.seedPin === 'function' ? opts.seedPin() : opts.seedPin; } catch (_) { p = null; } return p && finitePin(p) ? p : null; };
    // the device location (unconfirmed until «Listo»); denied / unavailable ⇒ the drawn «Ubicación desactivada» row
    const geoApi = () => (opts.geolocation !== undefined ? opts.geolocation : (doc.defaultView && doc.defaultView.navigator && doc.defaultView.navigator.geolocation) || null);
    function requestGeo() {
      const g = geoApi(); const f = S.flow;
      const denied = () => { S.geo = 'denied'; if (!finitePin(f.pin) && cfg.loc && finitePin(cfg.loc)) C.setPin(f, cfg.loc.lat, cfg.loc.lng, false); if (S.screen === 'checkout') render(); };
      if (!g || typeof g.getCurrentPosition !== 'function') { denied(); return; }
      try {
        // OWNER 2026-10-21 (DECISIONS:2072): a DETECTED fix is a real location ⇒ the pin is CONFIRMED in the model (the body's
        // pin_confirmed:true is the device's truth); only a denied / failed / fallback location must be confirmed on the pin step
        g.getCurrentPosition((pos) => { S.geo = 'ok'; if (!(f.pin && f.pin.confirmed)) { C.setPin(f, pos.coords.latitude, pos.coords.longitude, true); emit('pin', { lat: pos.coords.latitude, lng: pos.coords.longitude, confirmed: true, source: 'gps' }); } if (S.screen === 'checkout') render(); }, denied, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
      } catch (_) { denied(); }
    }

    // ── «Entrega & Pago» (prototype checkoutHtml :1828-1888) ──
    function feeRowHtml(T, info) {
      if (S.flow.mode !== 'delivery') return '';
      const d = S.lastDelivery;
      const ib = info && d && Number.isFinite(d.from_cents) && Number.isFinite(d.max_km) ? `<button class="infobtn" data-act="feeinfo" aria-label="Cómo se calcula el envío">${IC.info}</button>` : '';
      // the promotion state (struck price + «Gratis»); the prototype's «Envío gratis · {promo}» note needs a promo label the quote does not carry
      if (T.ready && T.envioFree) return `<div class="sumrow"><span>Envío${ib}</span><span><span class="strike">${moneyC(T.envio)}</span><span class="free">Gratis</span></span></div>`;
      if (!T.ready) return `<div class="sumrow"><span>Envío${ib} <span class="mute">· según tu dirección</span></span><span></span></div>`;   // no address yet: the amount comes after the pin
      return `<div class="sumrow"><span>Envío${ib}</span><span>${moneyC(T.envio)}</span></div>`;
      // the guest «Creá tu cuenta y tu envío es gratis» line needs a promo flag the quote does not carry (not rendered)
    }
    // S4: the prototype's two cards + the inline picker (P:1838-1841): day chips, EVERY slot of the day (N3), the empty states; row 10b's
    // read-only variant while a scheduled send is unresolved (frame 10b: «Lo antes posible», the days and the OTHER slots in the drawn
    // disabled .45; the pressed «Programar» card and the chosen slot stay as drawn; the window note, then note A) — taps are refused by
    // the handler (lockedSlot), not by the markup
    function schedCards(f, open, del) {
      const K = schedMod(), s = servedSched(), t0 = now().getTime(), on = hasSlotLock(), lk = on ? lockedSlot() : null;
      if (on) { f.time = 'schedule'; f.slot = lk; f.slotDay = K.dayKey(s, lk); }
      const ds = schedDays(), first = ds.find((d) => d.slots.length), sdayKey = f.slotDay || (first ? first.key : null), sd = ds.find((d) => d.key === sdayKey) || null;
      const dis = on ? ' disabled' : '';
      const cards = `<div class="opts"><button class="opt" aria-pressed="${f.time === 'asap'}" data-act="time" data-val="asap"${open && !on ? '' : ' disabled'}><b>Lo antes posible</b><span>${open ? esc(etaTxt(del ? 'delivery' : 'pickup')) : 'No disponible · cerrado'}</span></button>
      <button class="opt" aria-pressed="${f.time === 'schedule'}" data-act="time" data-val="schedule"><b>Programar</b><span>${Number.isFinite(f.slot) ? esc(K.slotWhen(s, t0, f.slot)) : 'Hasta 7 días'}</span></button></div>`;
      if (f.time !== 'schedule') return cards;
      const chips = `<div class="daychips" role="group" aria-label="Día">${ds.map((d) => `<button class="daychip" aria-pressed="${d.key === sdayKey}" data-act="slotday" data-val="${d.key}"${d.slots.length && !on ? '' : ' disabled'}><b>${esc(K.chipDay(d))}</b><span>${esc(K.chipSub(d))}</span></button>`).join('')}</div>`;
      // Codex S4 r1 #5: the retained send's slot is shown as recorded even when the generator no longer offers it (the server decides)
      const daySlots = on ? [...new Set([...(sd && sd.key === K.dayKey(s, lk) ? sd.slots : []), lk])].sort((x, y) => x - y) : sd ? sd.slots : [];
      const grid = daySlots.length
        ? `<div class="chips slotgrid" role="group" aria-label="Horario">${daySlots.map((ms) => `<button class="chip" aria-pressed="${f.slot === ms}" data-act="slot" data-val="${ms}"${f.slot === ms ? '' : dis}>${esc(K.slotTime(s, ms))}</button>`).join('')}</div><span class="note">Cada horario es una ventana de 30 minutos.</span>${on ? '<span class="note">Estamos confirmando este horario; no se puede cambiar mientras tanto.</span>' : ''}`
        : `<div class="gate"><b>${sd && sd.off === 0 ? 'Hoy ya no hay horarios' : 'Sin horarios disponibles'}</b><span class="note">Elegí otro día.</span></div>`;
      return cards + chips + grid;
    }
    // C-6d (MOCKUP-capp-desktop-D3 r3 frames 4a/4b, approved; advisor calls 1–6): the desktop checkout — its own bar («Volver a la
    // tienda» = the existing back-to-the-menu, the Sherpa lock, «Pago seguro»), column A = the approved sections under the page H1,
    // column B (sticky) = the store card → the SAME CTA (#cta: label, act and disabled state unchanged) → the guest's next step →
    // «Tu pedido» (open by default) with the totals → the fine print. Presentation only: every value is the phone checkout's
    function checkoutDeskHtml({ entrega, datos, pago, ctaBtn, T, tip, del, g, lines, nItems }) {
      const brand = typeof opts.deskBrand === 'function' ? String(opts.deskBrand() || '') : '';
      let terms = null; try { terms = typeof opts.deskTerms === 'function' ? opts.deskTerms() : null; } catch (_) { terms = null; }
      const bar = `<div class="ckbar"><button class="backtxt" data-act="addmore">${IC.back}Volver a la tienda</button>${brand}<span class="sec-lock">${IC.lock}Pago seguro</span></div>`;
      const when = del ? (etaWindow() ? 'llega en ' + etaWindow() : '') : etaTxt('pickup');
      const card = `<div class="storecard">${logoChip('lg')}<span class="t"><b>${storeLine()}</b>${cfg.addr || when ? `<span>${[cfg.addr ? esc(cfg.addr) : '', esc(when)].filter(Boolean).join(' · ')}</span>` : ''}</span></div>`;
      // advisor call 5: only the true half of the drawn line (the hosted payment charges when paid — never a claim about «no se cobra»)
      const next = g ? '<div class="guestline"><b>Después del código de WhatsApp</b> se abre el pago seguro con tarjeta.</div>' : '';
      const open = S.sumOpen !== false;   // frame 4a: open by default on the desk
      const tipRow = tip ? `<div class="sumrow"><span>Propina</span><span>${moneyC(tip)}</span></div>` : del ? '<div class="sumrow"><span>Propina</span><span class="r mute">Se elige en el siguiente paso</span></div>' : '';   // call 3
      const pedido = `<section class="fsec" aria-label="Resumen del pedido"><div class="osum box"><button class="toggle" data-act="sumtoggle" aria-expanded="${open}"><span class="tt">Tu pedido<span> · ${esc(unitOf(nItems))}</span></span>${open ? IC.up : IC.down}</button>
      ${open ? `<div class="lines">${lines.map((d) => `<div class="osline">${lineName(d, 'n')}${lineStep(d)}<span class="p">${money(d.total)}</span></div>`).join('')}<button class="addmore" data-act="addmore">${IC.plus}Agregar más platos</button></div>` : ''}
      <div class="ostot"><div class="sumrow"><span>Subtotal</span><span>${moneyC(T.ready ? T.subtotal : cart.subtotalCents())}</span></div>${feeRowHtml(T, true)}${tipRow}<div class="sumrow tot"><span>Total</span><span>${T.ready ? moneyC(T.total) : '—'}</span></div></div></div></section>`;
      // call 6: the Terms sentence only with the platform's real (https) Terms link; «Sherpa lo entrega» only on a delivery
      const fine = [terms ? `Al continuar aceptás los <a href="${esc(terms)}" target="_blank" rel="noopener">Términos de Sherpa</a>.` : '', del ? 'El restaurante prepara tu pedido; Sherpa lo entrega.' : ''].filter(Boolean).join(' ');
      return `<div class="flow" id="flow">${bar}<div class="col-a"><h1 class="flowtitle">Entrega &amp; Pago</h1>${entrega}${datos}${pago}</div>
    <div class="col-b">${card}${ctaBtn}${next}${pedido}${fine ? `<p class="finenote">${fine}</p>` : ''}</div></div>`;
    }
    function checkoutHtml() {
      const f = S.flow, del = f.mode === 'delivery', m = member(), open = isOpen(), po = poLines(), T = totalsNow();
      const poNames = [...new Set(po.map((l) => { const s = sectionOfKey(l.key); return s ? s.name : l.key; }))].join(', ');
      const geoDenied = S.geo === 'denied' && !m;
      // MOCKUP-capp-cash-chips-lock (owner-approved): on frame 10b the replay re-sends the SAME body — every control it ignores is
      // fixed at the drawn .45 (disabled), back once the record is gone
      const fx = hasSlotLock(), fxOff = fx ? ' disabled' : '';
      const pinOk = S.pinStepOk === true;   // the drawn «Pin confirmado» = confirmed ON THE PIN STEP (P f.pinOk), not a detected fix
      const chev = IC.chev.replace('class="i"', 'class="i chev"');
      const zoneKm = (S.lastDelivery && Number.isFinite(S.lastDelivery.max_km) ? S.lastDelivery.max_km : cfg.zoneKm);
      // Entrega — ASAP only (scheduling, the «Programar» card, is S4)
      const timeCards = sched() ? schedCards(f, open, del) : `<div class="opts"><button class="opt" aria-pressed="${open}" data-act="time" data-val="asap"${open ? '' : ' disabled'}><b>Lo antes posible</b><span>${open ? esc(etaTxt(del ? 'delivery' : 'pickup')) : 'No disponible · cerrado'}</span></button></div>`;
      const mapBlock = `<button class="map${S.outZone && del ? ' out' : ''}" data-act="pin" aria-label="Ajustar el pin en el mapa"${fxOff}>${MAP_SVG}${gmapBox('preview')}<span class="pin">${IC.pinfill}</span><span class="tag">${geoDenied ? 'Pin en el restaurante' : pinOk ? 'Pin confirmado' : 'Tu ubicación'}</span><span class="adj">Ajustar pin</span></button>
    ${geoDenied ? `<div class="locrow">${IC.locoff}<span>Ubicación desactivada</span><button data-act="loc-on">Activar</button></div>` : ''}
    ${S.outZone && del ? `<div class="gate" role="alert"><b>${esc(cfg.name || '')} no llega a esta dirección</b><span class="note">${Number.isFinite(zoneKm) && cfg.branch ? `Entregamos hasta ${esc(zoneKm)} km de ${esc(cfg.branch)}. ` : ''}Mové el pin a una dirección dentro de la zona, o recogé en tienda.</span><div class="row2"><button class="btn2" data-act="pin">Cambiar dirección</button><button class="btn2 dark" data-act="type" data-val="pickup">Recoger en tienda</button></div></div>` : ''}`;
      // a guest's address line (S2b-geo, MOCKUP-capp-S2b-geo-address.html A1 / b / b2): the confirmed pin's reverse-geocode; c (none,
      // pending, superseded) keeps today's copy byte for byte
      const geoLine = C.addrLine(f);
      const addrRow = `<button class="urow" data-act="pin"${fxOff}>${IC.pin}<span class="t"><b data-addr>${geoLine ? esc(geoLine) : geoDenied ? 'Mové el pin a tu puerta' : 'Tu ubicación'}</b><span>${pinOk ? 'Pin confirmado' : 'Ajustá el pin a tu dirección'}</span></span>${chev}</button>`;
      const detailsFld = `<div class="fld"><label for="f-details">Detalles adicionales <span class="req">*</span></label><input id="f-details" data-field="details" value="${esc(f.details)}" placeholder="Colonia, portón, piso, referencia…" autocomplete="off"${fxOff}></div>`;
      const detailsRow = m && !S.editDetails && (f.details || '').trim().length >= 3 ? `<div class="urow">${IC.home}<span class="t"><b>${esc(f.details)}</b><span>Detalles adicionales</span></span><button class="act" data-act="editdetails"${fxOff}>Cambiar</button></div>` : '';
      const entrega = `<section class="fsec" aria-label="Entrega"><h2>Entrega</h2>
    <div class="seg" role="group" aria-label="Tipo de pedido"><button aria-pressed="${del}" data-act="type" data-val="delivery"${fxOff}>Delivery</button><button aria-pressed="${!del}" data-act="type" data-val="pickup"${fxOff}>Pickup</button></div>
    ${del && po.length ? `<div class="gate"><b>«${esc(poNames)}» es solo para Pickup</b><div class="row2"><button class="btn2" data-act="rm-po">Quitar del pedido</button><button class="btn2 dark" data-act="type" data-val="pickup">Cambiar a Pickup</button></div></div>` : ''}
    ${timeCards}
    ${del ? `${mapBlock}<div class="urows">${addrRow}${detailsRow}</div>${detailsRow ? '' : detailsFld}` : `<div class="urows"><div class="urow">${IC.store}<span class="t"><b>${storeLine()}</b><span>${esc(cfg.addr || '')}</span></span></div></div><div class="note">Te avisamos por WhatsApp cuando esté listo.</div>`}</section>`;
      // Tus datos — TODO(fiscal flag): «factura / » + the RTN fields render ONLY behind a server flag; no such config key exists yet
      const moreRow = `<button class="urow" data-act="more"${fxOff}>${IC.plus}<span class="t"><b>Agregar email / notas</b></span>${chev}</button>`;
      const moreFields = `<div class="fld"><label for="f-email">Correo <span class="mute">(opcional · para tu recibo)</span></label><input id="f-email" data-field="email" type="email" value="${esc(f.email)}" placeholder="tu@correo.com" autocomplete="email"${fxOff}></div>
       <div class="fld"><label for="f-notes">Notas para el restaurante</label><textarea id="f-notes" data-field="notes" placeholder="Sin cebolla, extra salsa… (opcional)"${fxOff}>${esc(f.notes)}</textarea></div>`;
      // §3.1 / §4b / §4c (frames 1, 1b, 1c): the guest's «Tus datos» opens with the sign-in ROW (replacing the small link), the phone
      // carries the WhatsApp code + consent note, the EMAIL is its own required field, and the more-row is «Agregar notas»
      const g = cardOnlyGuest();
      // frame 1c: THIS device had an account (the local marker, §4c) ⇒ «Ya tenés cuenta en este teléfono» + «Entrá de nuevo · ···· 3344»
      // (only the last 4 shown; the sign-in pre-fills the full number); otherwise «Entrá o creá tu cuenta». Either keeps cart + checkout
      let dev = null; try { dev = typeof opts.deviceAccount === 'function' ? opts.deviceAccount() : null; } catch (_) { dev = null; }
      const signinRow = dev && typeof dev.last4 === 'string' && /^\d{4}$/.test(dev.last4)
        ? `<div class="signin"><span class="note">Ya tenés cuenta en este teléfono</span><button class="primary" data-act="signin" data-ctx="checkout-returning">Entrá de nuevo · ···· ${esc(dev.last4)}</button></div>`
        : `<div class="signin"><button class="primary" data-act="signin" data-ctx="checkout">Entrá o creá tu cuenta</button></div>`;
      const emailBad = g && (S.emailRefused || (String(f.email || '').trim() && !C.validEmail(f.email)));
      const datosGuest = `<section class="fsec" aria-label="Tus datos"><h2>Tus datos</h2>${signinRow}
         <div class="fld"><label for="f-name">Nombre <span class="req">*</span></label><input id="f-name" data-field="name" value="${esc(f.name)}" placeholder="Tu nombre" autocomplete="name"></div>
         ${intl() ? phoneFld(f, '<span class="note">Te enviamos un código por WhatsApp para confirmarlo. Al continuar aceptás recibir mensajes de WhatsApp sobre este pedido.</span>') : `<div class="fld"><label for="f-phone">WhatsApp <span class="req">*</span></label><input id="f-phone" data-field="phone" type="tel" inputmode="numeric" value="${esc(f.phone)}" placeholder="+504 9999-9999" autocomplete="tel"><span class="note">Te enviamos un código por WhatsApp para confirmarlo. Al continuar aceptás recibir mensajes de WhatsApp sobre este pedido.</span></div>`}
         <div class="fld${emailBad ? ' bad' : ''}"><label for="f-email">Correo <span class="req">*</span> <span class="mute">· para tu recibo</span></label><input id="f-email" data-field="email" type="email" value="${esc(f.email)}" placeholder="tu@correo.com" autocomplete="email"></div>
         ${S.more ? `<div class="fld"><label for="f-notes">Notas para el restaurante</label><textarea id="f-notes" data-field="notes" placeholder="Sin cebolla, extra salsa… (opcional)">${esc(f.notes)}</textarea></div>` : `<div class="urows"><button class="urow" data-act="more">${IC.plus}<span class="t"><b>Agregar notas</b></span>${chev}</button></div>`}</section>`;
      const datos = g ? datosGuest : `<section class="fsec" aria-label="Tus datos"><h2>Tus datos</h2>
    ${m && !f.editWho ? `<div class="urows"><div class="urow">${IC.user}<span class="t"><b>${esc(m.name)}</b><span>${esc(intl() ? phoneShown(newFlow()) : C.fullPhone(m.phone))}</span></span><button class="act" data-act="editwho"${fxOff}>Cambiar</button></div>${S.more ? '' : moreRow}</div>`
      : `<div class="fld"><label for="f-name">Nombre <span class="req">*</span></label><input id="f-name" data-field="name" value="${esc(f.name)}" placeholder="Tu nombre" autocomplete="name"${fxOff}></div>
         ${intl() ? phoneFld(f, '', fx) : `<div class="fld"><label for="f-phone">WhatsApp <span class="req">*</span></label><input id="f-phone" data-field="phone" type="tel" inputmode="numeric" value="${esc(f.phone)}" placeholder="+504 9999-9999" autocomplete="tel"${fxOff}></div>`}
         ${!m ? `<div class="line" style="font-size:14px"><span class="mute">¿Ya tenés cuenta?</span><button class="lnk" data-act="signin" data-ctx="checkout">Entrá</button></div>` : ''}${S.more ? '' : `<div class="urows">${moreRow}</div>`}`}
    ${S.more ? moreFields : ''}</section>`;
      // Tu pedido (the redeem / «Descuento» row is pending a ruling — not rendered)
      const lines = displayLines(), nItems = cart.count();
      const sumRow = `<button class="urow" data-act="sumtoggle" aria-expanded="${!!S.sumOpen}">${logoChip('lg')}<span class="t"><b>${storeLine()}</b><span>${esc(unitOf(nItems))}${S.sumOpen ? '' : ' · ' + esc(lines.map((d) => d.n + '× ' + d.item.n).join(', '))}</span></span>${IC.down.replace('class="i"', 'class="i chev"')}</button>`;
      const sumBody = S.sumOpen ? `<div class="sumbody">${lines.map((d) => `<div class="osline">${lineName(d, 'n')}${lineStep(d)}<span class="p">${money(d.total)}</span></div>`).join('')}<button class="addmore" data-act="addmore">${IC.plus}Agregar más platos</button></div>` : '';
      const tip = T.ready ? T.tip : C.tipCentsOf(f);
      const pedido = `<section class="fsec" aria-label="Resumen del pedido"><h2>Tu pedido</h2>
    <div class="osum flat">${sumRow}${sumBody}
      <div class="ostot"><div class="sumrow"><span>Subtotal</span><span>${moneyC(T.ready ? T.subtotal : cart.subtotalCents())}</span></div>${feeRowHtml(T, true)}${tip ? `<div class="sumrow"><span>Propina</span><span>${moneyC(tip)}</span></div>` : ''}<div class="sumrow tot"><span>Total</span><span>${T.ready ? moneyC(T.total) : '—'}</span></div></div></div></section>`;
      // Pago — row 10: a retained scheduled send fixes its tender (the other option in the drawn disabled .45, as the other slots)
      const lp = lockedPay(); if (lp !== null) f.pay = lp;
      const payOff = (v) => (lp !== null && lp !== v ? ' disabled' : '');
      const payOpts = `<div class="optrow" role="radiogroup" aria-label="Forma de pago">
      <button class="opt" aria-pressed="${f.pay === 'online'}" data-act="pay" data-val="online"${payOff('online')}><span class="radio" aria-hidden="true"></span><span class="txt"><b>Pagar en línea<span class="rec">Recomendado</span></b><span>Con tarjeta, en la página segura de PixelPay (3D Secure).</span></span></button>
      <button class="opt" aria-pressed="${f.pay === 'cash'}" data-act="pay" data-val="cash"${payOff('cash')}><span class="radio" aria-hidden="true"></span><span class="txt"><b>Efectivo ${del ? 'al entregar' : 'al recoger'}</b><span>${del ? 'Pagás cuando llegue tu pedido.' : 'Pagás en tienda al recoger.'}</span></span></button></div>`;
      // §3.1 (frame 1): a guest has ONE option — card, already selected (cash ABSENT, not dimmed) — and the fixed line with the why
      const pagoGuest = `<section class="fsec" aria-label="Pago"><h2>Pago</h2><div class="optrow" role="radiogroup" aria-label="Forma de pago">
      <button class="opt" aria-pressed="true" data-act="pay" data-val="online"><span class="radio" aria-hidden="true"></span><span class="txt"><b>Pagar en línea</b><span>Con tarjeta, en la página segura de PixelPay (3D Secure).</span></span></button></div>
      <p class="paynote">Pagás con tarjeta. <button class="lnk" data-act="signin" data-ctx="paynote">Creá una cuenta</button> para pagar en efectivo y sumar recompensas.</p></section>`;
      const pago = g ? pagoGuest : `<section class="fsec" aria-label="Pago"><h2>Pago</h2>${m && f.pay && !S.showPay
        ? `<div class="urows"><div class="urow">${f.pay === 'cash' ? IC.cash : IC.card}<span class="t"><b>${f.pay === 'cash' ? 'Efectivo ' + (del ? 'al entregar' : 'al recoger') : 'Tarjeta · PixelPay'}</b><span>${f.pay === 'cash' ? 'Como tu último pedido' : 'Página segura, 3D Secure'}</span></span><button class="act" data-act="showpay"${lp !== null ? ' disabled' : ''}>Cambiar</button></div></div>` : payOpts}${cashPanel(T)}</section>`;
      const ctaBtn = `<button class="primary" id="cta" data-act="confirm"${ctaOff(T) ? ' disabled' : ''}>${esc(ctaLabel(T))}</button>`;
      const sdkC = sdkOn() && !S.desk;   // S2-checkout (v7): the payment row in the bar replaces the «Pago» section (the installed app only)
      const bar = sdkC ? sdkBar(T, { label: ctaLabel(T), enabled: !ctaOff(T), act: 'confirm', id: 'cta' }) : `<div class="paybar">${ctaBtn}</div>`;
      if (S.desk) return checkoutDeskHtml({ entrega, datos, pago, ctaBtn, T, tip, del, g, lines, nItems });
      // the prototype's footer «¿Problemas con tu pedido? Escribinos al …» (:1886) is omitted — pending a ruling
      return `<div class="flow" id="flow"><div class="flowbar plain"><h1>Entrega &amp; Pago</h1></div>
    <div class="col-a">${entrega}${datos}${S.desk ? pago : pedido + (sdkC ? '' : pago)}</div>${S.desk ? `<div class="col-b">${pedido}</div>` : ''}${bar}</div>`;   // v6 :1886-1887 — desk MOVES «Tu pedido» to col-b
    }
    // the cash panel: chips + the change line against the QUOTED Total (no chips until that Total exists)
    const tenderNote = (T) => { const f = S.flow; if (!T.ready || !f.tendered) return ''; const ch = C.changeCents(f, T.total); return ch === null ? 'Ese monto es menor que el total (' + moneyC(T.total) + ').' : ch > 0 ? 'Tu cambio: ' + moneyC(ch) : 'Pago exacto, sin cambio.'; };
    function cashPanel(T) {
      const f = S.flow; if (f.pay !== 'cash') return '';
      const tot = T.ready ? T.total / 100 : null; let base = tot === null ? null : Math.ceil(tot / 500) * 500; if (base !== null && base <= tot) base += 500;
      const tender = Number(f.tendered), fxOff = hasSlotLock() ? ' disabled' : '';   // frame 10b: the amount is fixed (cash-chips lock)
      const chips = tot === null ? '' : `<div class="chips">${[{ l: 'Pago exacto', v: tot }, { l: money(base), v: base }].map((c) => `<button class="chip" aria-pressed="${tender === c.v}" data-act="tender" data-val="${c.v}"${fxOff}>${c.l}</button>`).join('')}</div>`;
      return `<div class="fld"><label for="f-tender">¿Con cuánto vas a pagar? <span class="mute">(para llevarte el cambio exacto)</span></label>${chips}<input id="f-tender" data-field="tendered" inputmode="numeric" value="${esc(f.tendered)}" placeholder="Otro monto (L)"${fxOff}><span class="note" id="tender-note">${esc(tenderNote(T))}</span></div>`;
    }

    // ── the tip step (prototype tipHtml :1954-1961) ──
    const tipKey = () => { const c = S.flow.tipChoice; return c === null ? null : c.kind === 'none' ? 0 : c.kind === 'other' ? 'other' : c.lempiras; };
    const tipReady = (T) => C.tipChosen(S.flow) && T.ready && !need() && !soldBlock() && intakeOk();
    function tipHtml() {
      const f = S.flow, T = totalsNow(), c = tipKey();
      const chip = (v, label) => `<button class="chip" aria-pressed="${c === v}" data-act="tipc" data-val="${v}">${label}</button>`;
      const tot = T.ready ? moneyC(T.total) : '—';
      return `<div class="topbar"><button class="iconbtn" data-act="back" aria-label="Volver a Entrega y Pago">${IC.back}</button><h1></h1><span class="sp"></span></div>
    <div class="tipwrap"><div class="tiphero">${RIDER}<h1>Agregá una propina</h1><p>La propina va completa a tu repartidor.</p></div>
    <div class="tipchips" role="group" aria-label="Propina">${C.TIP_PRESETS.map((v) => chip(v, v ? money(v) : 'Sin propina')).join('')}${chip('other', 'Otro')}</div>
    <div class="tipfoot"><div class="sumrow"><span>Propina</span><span>${c === null ? '—' : f.tipCents ? moneyC(f.tipCents) : 'Sin propina'}</span></div><div class="sumrow tot"><span>Total</span><span>${tot}</span></div>${sdkOn() && !S.desk ? sdkTipRow(T) : ''}<button class="primary" data-act="tip-place"${tipReady(T) ? '' : ' disabled'}>Hacer pedido · ${tot}</button></div></div>`;
    }
    const tipOtherHtml = () => { const d = S.tipDraft || ''; return `<div class="scrim" data-act="lclose"></div><div class="sheet" role="dialog" aria-label="Otro monto"><div class="grab"></div><div class="sheethead"><div><h2>Otro monto</h2><small>Propina para tu repartidor</small></div><button class="iconbtn" data-act="lclose" aria-label="Cerrar">${IC.close}</button></div><div class="tipother"><label class="tipamt"><span>L</span><input inputmode="numeric" data-field="tipOther" value="${esc(d || '0')}" style="width:calc(${Math.max(1, (d || '0').length)}ch + 6px)" aria-label="Monto de la propina"></label><div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-act="tk" data-val="${n}">${n}</button>`).join('')}<span></span><button data-act="tk" data-val="0">0</button><button data-act="tk" data-val="del" aria-label="Borrar">${BKSP}</button></div><button class="primary" data-act="tip-save">Guardar</button></div></div>`; };
    // the draft never exceeds the server's cap (TIP_MAX_LEMPIRAS): a digit that would is refused
    const capDraft = (s, prev) => { const d = String(s).replace(/\D/g, '').replace(/^0+(?=\d)/, ''); return Number(d || 0) > C.TIP_MAX_LEMPIRAS ? prev : d; };

    // ── «Realizando pedido…» (prototype placeTap / placingHtml :1972-1991) — «Volver» sends nothing ──
    let placingT = null, placingI = null, beatT = null;
    function placingStop() { if (placingI !== null) T_.clearInterval(placingI); if (placingT !== null) T_.clearTimeout(placingT); placingI = placingT = null; }
    const etaRange = (mode) => { const e = mode === 'delivery' ? cfg.etaDel : cfg.etaPick; if (!e) return null; const r5 = (x) => Math.round(x / 5) * 5; const n = clock().min; return { k: mode === 'delivery' ? 'Llega' : 'Listo para recoger', v: fmtMin(r5(n + e[0])) + ' – ' + fmtMin(r5(n + e[1])) }; };
    // mark: 'b' | 's' — the bold / the sub is the delivery address line ([data-addr], patched in place by paintAddr)
    const prow = (ic, b, s, mark) => `<div class="prow">${ic}<span class="t"><b${mark === 'b' ? ' data-addr' : ''}>${b}</b>${s ? `<span${mark === 's' ? ' data-addr' : ''}>${s}</span>` : ''}</span></div>`;
    // the delivery address line: the confirmed pin's geo line (S2b-geo frames a / b2); else today's — the customer's own
    // «Detalles adicionales», else «Tu ubicación»
    const addrText = () => esc(C.addrLine(S.flow) || (S.flow.details || '').trim() || 'Tu ubicación');
    function placingHtml() {
      const f = S.flow, del = f.mode === 'delivery', T = totalsNow(), lines = displayLines();
      const e = sched() && f.time === 'schedule' && Number.isFinite(f.slot) ? { k: schedMod().slotWhen(servedSched(), now().getTime(), f.slot), v: '' } : etaRange(f.mode);
      return `<div class="scrim"></div><div class="sheet" role="dialog" aria-label="Realizando pedido"><div class="grab"></div><div class="placing"><h2>Realizando pedido…</h2>
    ${e ? prow(IC.clock, e.v ? esc(e.k) + ' ' + esc(e.v) : esc(e.k), del ? 'Delivery' : 'Pickup') : ''}
    ${prow(IC.store, storeLine(), del ? addrText() : esc(cfg.addr || ''), del ? 's' : '')}
    ${prow(IC.bag, esc(unitOf(cart.count())), esc(lines.map((d) => d.n + '× ' + d.item.n).join(', ')))}
    ${prow(f.pay === 'online' ? IC.card : IC.cash, f.pay === 'online' ? 'Tarjeta · PixelPay' : 'Efectivo ' + (del ? 'al entregar' : 'al recoger'), 'Total ' + moneyC(T.total) + (T.tip ? ' · incluye propina ' + moneyC(T.tip) : ''))}
    <div class="acts"><button class="primary okbtn" data-act="placing-go"><i class="fill" aria-hidden="true"></i><span>Se ve bien (<span class="cd">0:02</span>)</span></button><button class="btn2 wide" data-act="placing-back">Volver</button></div></div></div>`;
    }
    function placeTap() {
      // the ONE choke point every caller goes through (the CTAs AND «Usar otra tarjeta», which calls this directly): a
      // known-unavailable line never starts a countdown (Codex perf-core r1 #7); the button-level gates stay as well
      if (dead) return;
      if (soldBlock()) { openLayer('cart'); return; }   // never silently nothing: the cart shows which dish sold out (frame 14)
      if (heldByOther()) { backTo('checkout'); showErr(ERR.heldOther()); return; }   // Codex G7 r1 #1 (a): before the code sheet, the countdown or any request
      if (guestCashBlocked()) return;   // §3.2: refused locally, frame 6
      if (guestNeedsCode()) { if (intakeOk() && S.flow && !need() && C.tipChosen(S.flow) && totalsNow().ready) openCode(); return; }   // §4: the WhatsApp code BEFORE anything is sent (frame 2)
      if (!intakeOk() || !S.flow || need() || !C.tipChosen(S.flow) || !totalsNow().ready) return;
      placingStop(); S.backScreen = S.screen; openLayer('placing');
      let left = 2;
      placingI = T_.setInterval(() => { left = Math.max(0, left - 1); const cd = doc.querySelector('[data-act="placing-go"] .cd'); if (cd) cd.textContent = '0:0' + left; }, 1000);
      placingT = T_.setTimeout(placingGo, 2000);
    }
    // the verified guest's send: placeTap's gates, without the «Realizando pedido…» window (the verify tap was the commit)
    function placeNow() {
      if (dead) return;
      if (soldBlock()) { openLayer('cart'); return; }
      if (guestCashBlocked() || guestNeedsCode()) return;
      if (!intakeOk() || !S.flow || need() || !C.tipChosen(S.flow) || !totalsNow().ready) return;
      placingStop(); S.backScreen = S.screen; send();
    }
    function placingGo() { placingStop(); if (dead || S.layerKind !== 'placing') return; S.layerKind = null; renderLayer(); send(); }

    // ── «Enviando tu pedido…» (prototype sendingHtml :2029-2042) while place() is in flight ──
    function sendingHtml() {
      const f = S.flow, del = f.mode === 'delivery', lines = displayLines();
      const st = S.sendTotals || { total: null, tip: 0 };
      return `<div class="sending" aria-live="polite"><div class="shero">${RIDER_LIVE}</div>
    <div class="sndcard"><div class="shd"><h2>Enviando tu pedido…</h2><span class="sspin" id="sspin"><i class="ring" aria-hidden="true"></i></span></div>
      ${prow(IC.pin, del ? addrText() : 'Pickup · ' + storeLine(), del ? 'Entrega' + (sched() && f.time === 'schedule' && Number.isFinite(f.slot) ? ' · ' + esc(schedMod().slotWhen(servedSched(), now().getTime(), f.slot)) : '') : esc(cfg.addr || ''), del ? 'b' : '')}
      <div class="prow">${logoChip('lg')}<span class="t"><b>${storeLine()}</b><span>${esc(lines.map((d) => d.n + '× ' + d.item.n).join(', '))}</span></span></div>
      ${prow(f.pay === 'online' ? IC.card : IC.cash, (f.pay === 'online' ? 'Tarjeta · PixelPay' : 'Efectivo ' + (del ? 'al entregar' : 'al recoger')) + (st.total !== null ? ' · ' + moneyC(st.total) : ''), st.tip ? 'Incluye propina ' + moneyC(st.tip) : 'Pago')}
      <p class="shint">${esc(S.sendHint || 'Esto toma unos segundos')}</p></div></div>`;
    }
    // r3.3-F2 [r2 ruling 2]: availability is re-read at DISPATCH (after the countdown, behind the painted «Enviando»), bounded at
    // AVAIL_RECHECK_MS, with the forms' FAIL-OPEN rule: a failed / non-OK / timed-out read CLEARS the sold-outs (agotado-failopen).
    // opts.readAvailability() → Promise<iterable of sold dish keys | null on failure>. Absent ⇒ no re-check (today's behaviour).
    const AVAIL_RECHECK_MS = 1500;
    // Codex perf-core r1 #3/#4: the result belongs to ONE dispatch attempt. It is applied only if this mount is alive and the
    // attempt still current (a destroyed / superseded mount never touches the host's state). A Set input is the host's own live
    // state, updated in place; a function input is NOT overridden — the fresh read decides this dispatch only, then the host's
    // function governs again (so a later "available" from the host re-enables placement). Returns the fresh Set, or null if stale.
    async function recheckAvailability(attempt) {
      let keys = null;
      try {
        keys = await new Promise((res) => { const t = T_.setTimeout(() => res(null), AVAIL_RECHECK_MS); Promise.resolve().then(() => opts.readAvailability()).then((v) => { T_.clearTimeout(t); res(v); }, () => { T_.clearTimeout(t); res(null); }); });
      } catch (_) { keys = null; }
      if (dead || attempt !== attemptSeq) return null;
      const fresh = new Set(); try { if (keys) for (const k of keys) fresh.add(String(k)); } catch (_) { fresh.clear(); }
      if (unavailable && typeof unavailable !== 'function' && typeof unavailable.clear === 'function' && typeof unavailable.add === 'function') { unavailable.clear(); for (const k of fresh) unavailable.add(k); }
      return fresh;
    }
    // §3.2 THE shared invariant (every dispatch path calls it: placeTap, send — which «Reintentar» / «Usar otra tarjeta» reach —
    // and «Pagar en efectivo»): a guest whose effective tender is not ONLINE is refused LOCALLY with frame 6; nothing is sent
    // ── §4 THE GUEST'S WHATSAPP CODE (frames 2, 2b–2d, 3a, 3b; the confirmed wire contract) ──
    // A valid ticket for THIS phone and THIS cart is the only way a guest order is sent; it is asked for at the «Hacer pedido» tap,
    // in a sheet over the tip step (nothing sent behind it). The order goes on as soon as the code verifies.
    const phoneE164 = () => { if (intl()) return S.flow ? phoneMod().toE164(ccOf(S.flow), S.flow.phone) : ''; const d = String((S.flow && S.flow.phone) || '').replace(/\D/g, '').slice(-8); return d.length === 8 ? '+504' + d : ''; };   // S-picker: the chosen country's E.164
    const cartFpNow = () => (S.q && S.q.sig != null ? String(S.q.sig) : '');
    const guestNeedsCode = () => cardOnlyGuest() && !(S.ticket && api && api.ticketValid(S.ticket) && S.ticket.phone === phoneE164() && S.ticket.cart_fp === cartFpNow());
    const nowMs = () => now().getTime();   // the mount's clock (the countdowns)
    let otpTick = null;
    function otpTickStop() { if (otpTick !== null) { T_.clearInterval(otpTick); otpTick = null; } }
    const mmss = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(t / 60) + ':' + pad2(t % 60); };
    function otpTickStart() {
      otpTickStop();
      otpTick = T_.setInterval(() => {
        if (dead || !S.otp) { otpTickStop(); return; }
        const n = nowMs();
        const rs = doc.querySelector('#layer [data-otp="resend-in"]');
        if (rs) { if (S.otp.resendAt && n < S.otp.resendAt) rs.textContent = 'Reenviar en ' + mmss(S.otp.resendAt - n); else renderLayer(); }
        const lk = doc.querySelector('#layer [data-otp="locked"]');
        if (lk) { if (S.otp.lockedUntil && n < S.otp.lockedUntil) lk.textContent = 'Demasiados intentos. Probá de nuevo en ' + Math.ceil((S.otp.lockedUntil - n) / 60000) + ' min.'; else { S.otp.state = 'entry'; S.otp.lockedUntil = null; renderLayer(); } }
        const rb = doc.querySelector('#layer #otp-retry');
        if (rb) { if (S.otp.blockedUntil && n < S.otp.blockedUntil) rb.textContent = 'Reintentar en ' + mmss(S.otp.blockedUntil - n); else { rb.disabled = false; rb.textContent = 'Reintentar'; } }
      }, 1000);
    }
    function openCode() {
      if (!mods() || !api.requestCheckoutCode) return;
      S.otp = { state: 'entry', code: '', resendAt: null, lockedUntil: null, blockedUntil: null, phone: phoneE164(), busy: false, seq: 0, localFails: 0 };
      S.ticket = null; openLayer('otp'); otpTickStart(); requestCode();
    }
    function closeOtp() { otpTickStop(); S.otp = null; closeLayer(); }
    function closeCodeErr() { if (S.layerKind === 'err') { S.layerKind = 'otp'; S.err = null; renderLayer(); } }
    const codeErr = (attempt, max, blockedMs) => {
      const blocked = blockedMs != null;
      return { icon: 'warn', ic: 'chat', title: 'No pudimos enviar tu código por WhatsApp',
        ...(blocked ? { body: 'Lo intentamos 3 veces sin éxito. Tu pedido no se envió ni se cobró nada. Probá con otro número, o entrá con tu cuenta.' }
          : { bodyHtml: `Revisá que <b>${esc(phoneShown(S.flow))}</b> tenga WhatsApp y señal. Tu pedido está intacto; no se envió ni se cobró nada.`, note: `Intento <b>${esc(attempt)} de ${esc(max)}</b>` }),
        acts: blocked ? [{ act: 'otp-resend', label: 'Reintentar en ' + mmss(blockedMs), primary: true, disabled: true, id: 'otp-retry' }, { act: 'otp-change', label: 'Cambiar número' }, { act: 'otp-back', label: 'Volver al pedido' }]
          : [{ act: 'otp-resend', label: 'Reintentar', primary: true }, { act: 'otp-change', label: 'Cambiar número' }] };
    };
    // Codex guest r1 #7: every code request / verify is BOUNDED (CODE_TIMEOUT_MS) and owned by a sequence number — a late or superseded
    // answer is dropped; «Reenviar» always starts a fresh request (never a silent no-op behind a hung one)
    const CODE_TIMEOUT_MS = 15000;
    const bounded = (p) => new Promise((res) => { const t = T_.setTimeout(() => res({ kind: 'timeout' }), CODE_TIMEOUT_MS); Promise.resolve(p).then((v) => { T_.clearTimeout(t); res(v || { kind: 'offline' }); }, () => { T_.clearTimeout(t); res({ kind: 'offline' }); }); });
    async function requestCode() {
      const o = S.otp; if (!o) return;
      const my = ++o.seq; o.busy = true; o.phone = phoneE164();
      const r = await bounded(api.requestCheckoutCode({ phone: o.phone, cartFp: cartFpNow() }));
      if (dead || S.otp !== o || o.seq !== my) return;   // closed, or superseded by a newer request
      o.busy = false;
      if (r.ok) { o.state = o.state === 'locked' ? 'locked' : 'entry'; o.code = ''; o.resendAt = nowMs() + r.resendInS * 1000; S.layerKind = 'otp'; S.err = null; renderLayer(); return; }
      // a timeout or a dropped connection is a failed SEND (we cannot know it arrived): counted here, the drawn 3a / 3b
      let rr = r;
      if (r.kind === 'timeout' || r.kind === 'offline') { o.localFails += 1; rr = { kind: 'send_failed', attempt: o.localFails, max: 3 }; }
      if (rr.kind === 'send_failed' && rr.attempt < rr.max) { S.err = codeErr(rr.attempt, rr.max); S.layerKind = 'err'; renderLayer(); return; }   // frame 3a
      if (rr.kind === 'send_failed' || rr.kind === 'rate_limited') { o.blockedUntil = nowMs() + (rr.kind === 'rate_limited' ? rr.retryInS : 600) * 1000; S.err = codeErr(3, 3, o.blockedUntil - nowMs()); S.layerKind = 'err'; renderLayer(); return; }   // frame 3b
      S.err = { ...ERR.generic('otp-resend') }; S.layerKind = 'err'; renderLayer();   // a country the sender cannot reach (undrawn ⇒ the generic sheet)
    }
    async function verifyCode() {
      const o = S.otp; if (!o || o.busy || o.state === 'locked' || o.code.length !== 6) return;
      const my = ++o.seq; o.busy = true; renderLayer();
      // contract amendment 2026-10-27: the ticket is bound to the order id this placement will send (the same id on a retry)
      const oid = api.orderIdForCode({ flow: S.flow, sig: S.q && S.q.sig });
      const r = oid ? await bounded(api.verifyCheckoutCode({ phone: o.phone, cartFp: cartFpNow(), code: o.code, orderId: oid })) : { kind: 'offline' };
      if (dead || S.otp !== o || o.seq !== my) return;   // the sheet was closed / a resend superseded it: a late success NEVER sends
      o.busy = false;
      if (r.ok) { S.ticket = r.ticket; closeOtp(); placeNow(); return; }   // advisor 2026-10-27: the verify tap IS the commit — no extra window; straight to the drawn «Enviando»
      if (r.kind === 'code_wrong') { o.state = 'wrong'; o.code = ''; }
      else if (r.kind === 'code_expired') { o.state = 'expired'; o.code = ''; o.resendAt = null; }
      else if (r.kind === 'too_many_attempts') { o.state = 'locked'; o.code = ''; o.lockedUntil = nowMs() + r.retryInS * 1000; }
      else { S.err = { ...ERR.generic('otp-verify-retry') }; S.layerKind = 'err'; renderLayer(); return; }   // timeout / offline: «Reintentar» re-verifies the same code
      renderLayer(); const b0 = doc.querySelector('#layer .otp input'); if (b0 && !b0.disabled) focusTo(b0);
    }
    // the six boxes; a whole code pasted (with spaces or a dash) into any box fills them all (WhatsApp has no OS autofill)
    function otpInput(el) {
      const o = S.otp; if (!o || o.state === 'locked') return;
      const i = Math.min(Number(el.dataset.i) || 0, o.code.length), digits = String(el.value || '').replace(/\D/g, '');
      o.code = digits.length >= 6 ? digits.slice(0, 6) : (o.code.slice(0, i) + digits).slice(0, 6);   // a pasted whole code fills all six
      if (o.state === 'wrong') o.state = 'entry';
      renderLayer();
      const next = doc.querySelector(`#layer .otp input[data-i="${Math.min(o.code.length, 5)}"]`); if (next) focusTo(next);
    }
    function codeSheetHtml() {
      const o = S.otp || { state: 'entry', code: '' }, T = totalsNow();
      const off = o.state === 'locked', cls = o.state === 'wrong' ? ' bad' : off ? ' off' : '';
      const boxes = `<div class="otp${cls}" aria-label="Código de 6 dígitos">${[0, 1, 2, 3, 4, 5].map((i) => `<input inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="Dígito ${i + 1}" data-field="otp" data-i="${i}" value="${esc(o.code[i] || '')}" class="${o.code[i] ? 'f' : ''}${i === Math.min(o.code.length, 5) && !off ? ' focus' : ''}"${off ? ' disabled' : ''}>`).join('')}</div>`;
      const line = o.state === 'wrong' ? `<p class="inline err">${IC.alert}<span>Ese código no es. Revisalo e intentá de nuevo.</span></p>`
        : o.state === 'expired' ? `<p class="inline warn">${IC.clock}<span>Este código ya venció. Pedí uno nuevo.</span></p>`
        : off ? `<p class="inline mute">${IC.clock}<span data-otp="locked">Demasiados intentos. Probá de nuevo en ${Math.max(1, Math.ceil(((o.lockedUntil || 0) - nowMs()) / 60000))} min.</span></p>` : '';
      const waiting = o.resendAt && nowMs() < o.resendAt;
      const rowx = o.state === 'expired' || (!off && !waiting) ? `<div class="rowx"><button type="button" data-act="otp-resend">Reenviar código</button><button type="button" data-act="otp-change">Cambiar número</button></div>`
        : off ? `<div class="rowx"><button type="button" data-act="otp-change">Cambiar número</button><button type="button" data-act="otp-signin">¿Ya tenés cuenta? Entrá</button></div>`
        : `<div class="rowx"><span data-otp="resend-in">Reenviar en ${mmss(o.resendAt - nowMs())}</span><button type="button" data-act="otp-change">Cambiar número</button></div>`;
      return `<div class="scrim" data-act="lclose"></div><div class="sheet" role="dialog" aria-label="Ingresá el código"><div class="grab"></div><div class="sg">
    <div class="topb"><span class="iconbtn" aria-hidden="true"></span><span class="bm">Confirmá tu WhatsApp</span><button class="iconbtn" data-act="lclose" aria-label="Cerrar">${IC.close}</button></div>
    <div class="h1">Ingresá el código</div><p class="sub">Te lo enviamos por WhatsApp al <b>${esc(phoneShown(S.flow))}</b>.</p>
    ${boxes}${line}
    <button class="cta" type="button" data-act="otp-verify"${o.code.length === 6 && !off && !o.busy ? '' : ' disabled'}>Verificar y hacer pedido · ${T.ready ? moneyC(T.total) : ''}</button>
    ${rowx}
    <p class="fine">No creamos una cuenta; solo confirmamos que este número es tuyo. Tu pedido sale al verificar.</p></div></div>`;
    }
    function guestCashBlocked() {
      if (!cardOnlyGuest() || !S.flow || S.flow.pay === 'online') return false;
      backTo('checkout'); showErr(ERR.guestCash()); return true;
    }
    async function send() {
      const f = S.flow, T = totalsNow(), rb = lockedSlot() !== null ? lockedBody() : null;   // rb: the retained replay's recorded body
      // Codex cash-chips r1 P1-2: a replay sends the RECORDED body — it never waits on a fresh pin / quote (geolocation denied included)
      if (dead || !intakeOk() || (!T.ready && !rb) || !mods()) return;
      if (heldByOther()) { backTo('checkout'); showErr(ERR.heldOther()); return; }   // Codex G7 r1 #1 (a): no request, the record untouched
      if (sched() && f && f.time === 'schedule' && !canSchedule()) { backTo('checkout'); scheduleGate(); return; }   // G=B: never sent
      // Codex S4 r1 #4: the NEWEST received schedule decides (a held P2 revalidation included; painting stays deferred until here)
      if (sched() && f && f.time === 'schedule' && !hasSlotLock() && !schedMod().offered(S.schedHeld || servedSched(), now().getTime(), f.mode, f.slot)) {
        applyHeldSched(); f.slot = null; backTo('checkout'); return;   // the picker shows «Elegí un horario»; nothing was sent
      }
      if (guestCashBlocked()) return;   // no key ⇒ nothing is sent (the record stays clean)
      let c; try { c = { ...ctxBase(), headers: intakeHeaders() }; } catch (_) { return; }   // the key only where the server requires it
      const attempt = ++attemptSeq; S.terminal = null;   // Codex r4 #2: THIS attempt's settled outcome only
      S.sentOrder = sentOrderOf(f, T, rb);   // «Pedido recibido»: what THIS send stands behind, handed to the host with 'placed'
      const sdkPath = sdkOn() && f.pay === 'online';   // S2-checkout: frame 4 is a sheet over the screen of the tap (v7), never «Enviando»
      if (!sdkPath) S.screen = 'sending'; S.sendHint = null; S.sendTotals = rb ? { total: Number.isFinite(rb.expected_net_cents) ? rb.expected_net_cents : null, tip: Number.isFinite(rb.tip_cents) ? rb.tip_cents : 0 } : { total: T.total, tip: T.tip }; render();
      let has = soldOf;
      if (typeof opts.readAvailability === 'function') {
        const fresh = await recheckAvailability(attempt);   // the FRESH read decides (a stale sold-out is cleared on failure, never trusted)
        if (fresh === null || dead || attempt !== attemptSeq) return;
        has = (k) => fresh.has(k);
      }
      // a line known unavailable at dispatch (incl. one that sold out during the countdown): NOTHING is sent — back to where the
      // customer tapped, the cart open with the line still in it (its «Agotado» mark is the owner's frame 14 — not built yet)
      const soldNow = soldLines(has);
      if (soldNow.length) { for (const l of soldNow) refused.add(l.key); emit('dispatch_refused', { reason: 'unavailable', keys: soldNow.map((l) => l.key) }); backTo(); openLayer('cart'); return; }
      // S2b r1 P2-7: an accepted price change ⇒ «Enviando» shows the ceiling actually sent
      const onExpected = (cents) => { if (dead || !Number.isFinite(cents)) return; S.sendTotals = { total: cents, tip: T.tip }; if (S.screen === 'sending') render(); };
      if (sdkOn() && f.pay === 'online') {   // S2-checkout: the in-app card (placeSdk, capp-api) — never the hosted charge
        const card = sdkCard(); if (!card) { backTo(); openLayer('paysheet'); return; }
        return sdkSend({ flow: f, ctx: c, sig: S.q ? S.q.sig : null, expectedNetCents: T.total, totals: T, card, ...sdkAuth(), cartSnapshot: { ...cart.snapshot(), cart_gen: genNow() }, alive: () => !dead }, attempt);
      }
      let out;
      try { out = await api.place({ flow: f, ctx: c, replacesOrderId: SDK.replaces || undefined, freshOk: !!T.ready, sig: rb ? (S.q ? S.q.sig : null) : S.q.sig, checkoutTicket: cardOnlyGuest() ? S.ticket : undefined, expectedNetCents: rb ? rb.expected_net_cents : T.total, totals: rb && !T.ready ? null : T, sheet: priceSheet, onExpected, alive: () => !dead, cartSnapshot: api.hosted ? { ...cart.snapshot(), cart_gen: genNow() } : cart.snapshot() }); } catch (e) { out = { kind: 'error', error: String(e && e.message) }; }
      if (!dead) onOutcome(out, attempt);
    }
    // «Pedido recibido» (v6 orderHtml): the order as SENT — the lines, the economics (the recorded body's on a replay), the
    // delivery details, the tender and when — so the host's order screen never reads the live cart or flow after the send
    function sentOrderOf(f, T, rb) {
      const m = member(), del = f.mode === 'delivery', cents = (c) => (Number.isFinite(c) ? c / 100 : null);
      const tot = rb ? rb.expected_net_cents : T.total, tip = rb ? rb.tip_cents : T.tip, fee = rb ? null : (T.envioFree ? 0 : T.envio);
      const slot = sched() && f.time === 'schedule' && Number.isFinite(f.slot) ? f.slot : null;
      return { mode: del ? 'delivery' : 'pickup', pay: f.pay === 'online' ? 'online' : 'cash',
        // C-2: each line's canonical dish id (the cart key's served dish_id) — the rating sheet's purchased dishes, never matched by name
        lines: displayLines().map((d) => ({ n: d.n, name: d.item.n, extras: d.extras || '', total: d.total, dish_id: typeof d.item.dish === 'string' && d.item.dish ? d.item.dish : null })),
        fee: del ? cents(fee) : null, tip: cents(tip) || 0, total: cents(tot),
        addr: C.addrLine(f) || 'Tu ubicación', details: (f.details || '').trim(), notes: (f.notes || '').trim(),
        scheduled: slot !== null, scheduledFor: slot, whenText: slot !== null ? schedMod().slotWhen(servedSched(), now().getTime(), slot) : 'Lo antes posible',
        phoneText: phoneShown(f) || (m ? C.fullPhone(m.phone) : ''), phone: phoneShown(f) || '', email: (f.email || '').trim(), name: (f.name || '').trim(),
        phoneWire: f.cc && intl() ? phoneMod().toE164(f.cc, f.phone) : (C.fullPhone(f.phone) ? '+' + C.fullPhone(f.phone).replace(/\D/g, '') : '') };
    }
    // the sent order survives the hosted-checkout redirect: stored under the per-store key, bound to its order id, read back only for
    // THAT order's outcome, cleared once handed over (device storage, best-effort: a failed write ⇒ the screen shows no sent lines)
    const devStore = opts.apiOpts && opts.apiOpts.storage;
    function keepSent(orderId) {
      if (!cfg.sentKey || !devStore || typeof orderId !== 'string' || !S.sentOrder) return;
      try { devStore.setItem(cfg.sentKey, JSON.stringify({ v: 1, order_id: orderId, order: S.sentOrder })); } catch (_) {}
    }
    function takeSent(orderId) {
      if (!cfg.sentKey || !devStore) return null;
      let r = null; try { r = JSON.parse(devStore.getItem(cfg.sentKey) || 'null'); } catch (_) { r = null; }
      try { devStore.removeItem(cfg.sentKey); } catch (_) {}
      return r && r.v === 1 && r.order_id === orderId && r.order && typeof r.order === 'object' ? r.order : null;
    }
    // the 600 ms happy beat: the spinner becomes the green check, then the host takes over (S5)
    function beat(out) {
      const sp = $('sspin'); if (sp) { sp.innerHTML = CHECK_OK; sp.classList.add('done'); }
      if (beatT !== null) T_.clearTimeout(beatT);
      const stored = takeSent(out.order_id);   // a hosted return: this page never ran send() — the snapshot kept before the redirect
      beatT = T_.setTimeout(() => { beatT = null; emit('placed', { ...out, order: S.sentOrder || stored || null }); }, 600);
    }
    // back to where the customer tapped (closure / out-of-zone: to «Entrega & Pago», where those gates live)
    function backTo(screen) {
      const target = screen || S.backScreen || 'checkout';
      // landing on the screen the stack would return to (tip → «Entrega & Pago»): walk back, so history stays in step
      if (S.backScreen === 'tip' && target === 'checkout' && S.stack.length && S.stack[S.stack.length - 1].screen === 'checkout') { S.screen = 'tip'; back(); return; }
      S.screen = target; render();
    }
    function showErr(e) { S.err = e; openLayer('err'); }
    // MOCKUP-capp-native-store-update state 4 (owner: ONE cart line, no sheet): back from the store on a new build, the cart says so
    // once — gone when the cart is closed (the host owns the one-shot)
    const appUpdated = () => { try { return typeof opts.appUpdated === 'function' && opts.appUpdated() === true; } catch (_) { return false; } };
    const appUpdatedSeen = () => { try { if (appUpdated() && typeof opts.onAppUpdatedSeen === 'function') opts.onAppUpdatedSeen(); } catch (_) {} };
    // the store this INSTALLED app updates from (the host's: native + its platform's runtime.store_urls entry); null ⇒ no store sheet
    const storeNow = () => (cfg.store && typeof cfg.store.url === 'string' && typeof cfg.store.name === 'string' ? cfg.store : null);
    function quoteFailed() {
      if (S.screen !== 'checkout' && S.screen !== 'tip') return;
      if (S.layerKind) { S.quoteErrSheet = true; return; }   // shown when the open layer closes
      showErr(ERR.generic('err-requote'));
    }
    const ERR = {
      offline: () => ({ title: 'Sin conexión', body: 'No pudimos enviar tu pedido. Revisá tu conexión e intentá de nuevo; tu pedido está intacto.', icon: 'warn', acts: [{ act: 'err-retry', label: 'Reintentar', primary: true }, { act: 'lclose', label: 'Cerrar' }] }),
      // S2 drops the «Programar» button and the schedule sentence (OWNER 2026-10-26; CLOSED_SHEET.scheduleHint is S4's)
      closed: () => (sched() ? { title: C.CLOSED_SHEET.title(cfg.name || '', closesText()), body: C.CLOSED_SHEET.body + ' ' + C.CLOSED_SHEET.scheduleHint, icon: 'warn', acts: [{ act: 'err-sched', label: 'Programar', primary: true }, { act: 'lclose', label: 'Cerrar' }] }
        : { title: C.CLOSED_SHEET.title(cfg.name || '', closesText()), body: C.CLOSED_SHEET.body, icon: 'warn', acts: [{ act: 'lclose', label: 'Cerrar' }] }),   // S4 (P:1974): «Programar»
      // S4 N1 (owner, Option 1) and row 9 (owner-approved; the calm held sheet of #mk-pending, one action)
      slotRefused: () => ({ title: 'Ese horario ya no está disponible', body: 'Tu pedido no se envió ni se cobró nada. Elegí otro horario; tu pedido está intacto.', icon: 'warn', acts: [{ act: 'err-slot', label: 'Elegir otro horario', primary: true }, { act: 'lclose', label: 'Cerrar' }] }),
      schedReview: () => ({ title: 'Tu pago está hecho; estamos revisando tu horario', body: 'Tu horario ya no estaba disponible cuando se confirmó el pago. No hace falta pagar de nuevo: te escribimos por WhatsApp para acordar otro horario.', icon: 'calm', ic: 'clock', acts: [{ act: 'lclose', label: 'Entendido', primary: true }], held: true }),
      // TODO(ruling pending): «Pagar en efectivo» is a host event only
      // frame 6 (approved): the existing title, the fixed body; «Pagar con tarjeta» selects card and sends again, «Creá tu cuenta» signs up
      // frame 4 (approved): the session dropped mid-checkout — calm, the lock; the member's data and tender stay as they are
      reauth: () => ({ title: 'Tu sesión se interrumpió', body: 'Volvé a entrar para enviar tu pedido. Tu pedido está intacto y no se cobró nada; tus datos y tu forma de pago quedan igual.', icon: 'calm', ic: 'lock', acts: [{ act: 'reauth', label: 'Volver a entrar', primary: true }, { act: 'lclose', label: 'Cerrar' }] }),
      guestCash: () => ({ title: 'No pudimos enviar tu pedido', body: 'El pago en efectivo es solo para cuentas. Pagá con tarjeta o creá tu cuenta.', acts: [{ act: 'guest-card', label: 'Pagar con tarjeta', primary: true }, { act: 'guest-signup', label: 'Creá tu cuenta' }] }),
      // advisor 2026-10-27: a guest NEVER SEES a cash option — the same sheet without «Pagar en efectivo» (and without the body's cash
      // clause: the approved sentence, shortened, no new words); «Usar otra tarjeta» is its primary. The invariant stays as the backstop.
      payFailedGuest: () => ({ title: 'Pago no completado', body: 'Tu banco no autorizó el pago. Podés intentar con otra tarjeta; tu pedido está intacto.', acts: [{ act: 'err-card', label: 'Usar otra tarjeta', primary: true }] }),
      payFailed: () => ({ title: 'Pago no completado', body: 'Tu banco no autorizó el pago. Podés intentar con otra tarjeta o pagar en efectivo; tu pedido está intacto.', acts: [{ act: 'err-cash', label: 'Pagar en efectivo', primary: true }, { act: 'err-card', label: 'Usar otra tarjeta' }] }),
      // the approved Q9 mockup #mk-refunded
      refunded: (cents) => ({ title: 'Te reembolsamos tu pago', body: `${cfg.name || ''} ya había cerrado cuando se confirmó tu pago. Te devolvimos el total completo${Number.isFinite(cents) ? ', ' + moneyC(cents) : ''}; no se te cobrará.`, icon: 'ok', acts: [{ act: 'home', label: 'Volver al inicio', primary: true }] }),
      // the approved Q9 mockup #mk-exists — «Escribir a la tienda» hidden (no public restaurant contact in the app data)
      // the owner-approved held-states mockup (MOCKUP-capp-S2b-held-states.html #mk-paused / #mk-generic / #mk-pending)
      // Codex G7 r1 #1, advisor ruling (a) 2026-10-31 — OWNER-PENDING copy (DECISIONS.md 2026-10-31): another account's scheduled send
      // is still confirming on this device; ONE action (a retry would only refuse again)
      // MOCKUP-capp-native-store-update (owner 2026-11-01): the INSTALLED app below the compatibility floor (426) — the calm sheet,
      // «Abrir {tienda}» + «Ahora no»; state 3 (a placement / payment still in flight) without the order reference (owner)
      storeUpdate: (store) => ({ title: 'Actualizá la app para hacer pedidos', body: 'Esta versión ya no puede enviar pedidos. Tu carrito se guarda tal cual y te espera cuando volvás.', icon: 'calm', ic: 'update',
        acts: [{ act: 'store-open', label: `Abrir ${store}`, primary: true }, { act: 'lclose', label: 'Ahora no' }] }),
      storeUpdatePending: (store) => ({ title: 'Actualizá la app para seguir', body: 'Tu pedido en curso está a salvo y no hace falta pagar de nuevo. Cuando volvás con la app actualizada, revisamos cómo quedó.', note: 'Tu carrito también se guarda.', icon: 'calm', ic: 'clock',
        acts: [{ act: 'store-open', label: `Abrir ${store}`, primary: true }, { act: 'lclose', label: 'Ahora no' }] }),
      heldOther: () => ({ title: 'Hay un pedido de otra cuenta confirmándose en este teléfono', body: 'Entrá con esa cuenta o esperá unos minutos.', icon: 'calm', ic: 'clock', acts: [{ act: 'lclose', label: 'Entendido', primary: true }] }),
      paused: () => ({ title: `${cfg.name || ''} no está recibiendo pedidos en este momento`, body: 'Tu pedido no se envió ni se cobró nada; está intacto para que lo intentés en unos minutos.', icon: 'warn', ic: 'clock', acts: [{ act: 'lclose', label: 'Entendido', primary: true }] }),
      generic: (retry = 'err-retry') => ({ title: 'No pudimos enviar tu pedido', body: 'Intentá de nuevo en un momento; tu pedido está intacto.', acts: [{ act: retry, label: 'Reintentar', primary: true }, { act: 'lclose', label: 'Cerrar' }] }),
      pending: () => ({ title: 'Tu pago todavía está en verificación', body: 'Estamos confirmando tu pago con el banco. No hace falta pagar de nuevo; esperá un momento mientras termina.', icon: 'calm', ic: 'clock', acts: [{ act: 'lclose', label: 'Volver al pedido', primary: true }], held: true }),
      exists: (ref) => ({ title: 'Necesitamos revisar tu pedido', body: 'Ya existe un pedido con este número, así que no lo enviamos de nuevo para no duplicarlo. Escríbenos y lo revisamos.', icon: 'calm', note: `Referencia <b>#${esc(ref || '')}</b>`, acts: [{ act: 'lclose', label: 'Volver al pedido' }], held: true }),
    };
    let attemptSeq = 0;
    // frame 10's «Ver estado del pedido»: the frozen placement's state through the existing reader (no send, no new identity)
    let statusBusy = false;
    // PLAN-capp-desktop-D4a-routing r2 §4 (Codex r2 #4): ONE non-placement recovery for EVERY case lockedHere() can report — the
    // «Ver estado del pedido» button and a URL-driven entry into /pago under a lock. Status reads only, never a send:
    //   modules / hosted api unavailable · reconcile failure · unknown freeze · an unreadable pending record ⇒ «Sin conexión» (its
    //   «Reintentar» re-runs THIS) · a frozen cart ⇒ resolveStatus(its order) · a held lock (memLock / pay_pending) ⇒
    //   resolveStatus(id) ⇒ lockedOutcome (no credentials ⇒ the recovery / pending sheet; a definitive state releases it)
    async function frozenStatus() { return recoverLocked(); }
    async function recoverLocked() {
      if (statusBusy) return;
      let id = null, out = null;
      if (!mods() || !api.hosted) out = { kind: 'offline' };
      else if (!api.reconcile().ok) out = { kind: 'offline' };
      else {
        const fz = api.cartFreeze();
        if (fz.unknown) out = { kind: 'offline' };
        else if (fz.frozen) { id = fz.order_id || null; if (!id) out = { kind: 'offline' }; }
        else if (typeof api.holdsLock === 'function' && api.holdsLock()) { const live = api.readPlace(); id = live && typeof live.order_id === 'string' ? live.order_id : null; if (!id) out = { kind: 'offline' }; }
        else { renderLayer(); return; }   // nothing locked (any more): nothing to resolve
      }
      if (!out) { statusBusy = true; try { out = await api.resolveStatus(id); } catch (_) { out = { kind: 'offline' }; } finally { statusBusy = false; } }
      if (dead) return;
      closeLayer();
      // over the STORE (no checkout to go back to): the held sheets as drawn; any other outcome takes the normal path with a flow
      const k = out && out.kind;
      if (k === 'existing_order') { showErr(ERR.exists(out.reference)); return; }
      if (k === 'payment_failed' && out.clearable === false) { showErr(ERR.pending()); return; }
      if (k === 'offline' || !k) { const e = ERR.offline(); showErr({ ...e, acts: e.acts.map((x) => (x.act === 'err-retry' ? { ...x, act: 'frozen-status' } : x)) }); return; }   // «Reintentar» re-reads the status — never a send
      if (!S.flow) { S.flow = newFlow(); C.setMode(S.flow, S.mode); }
      onOutcome(out);
    }
    function onOutcome(out, attempt) {
      emit('outcome', out);   // S7a-2 (Codex s7a2 r1 #4): every outcome reaches the host (a return handoff settles on a LATER terminal one)
      const k = out && out.kind;
      if (k === 'redirect') {
        // a RESUMED checkout shows the STORED economics (never the current quote), then leaves for the stored URL
        if (out.resumed) { const t = out.totals || {}; S.sendTotals = { total: Number.isFinite(out.expected_net_cents) ? out.expected_net_cents : (Number.isFinite(t.total) ? t.total : null), tip: Number.isFinite(t.tip) ? t.tip : 0 }; S.screen = 'sending'; render(); }
        if (!out.resumed) keepSent(out.order_id);   // «Pedido recibido» after the hosted return (a new page load) shows THIS order as sent
        navigate(out.url); return;
      }
      // r3 §1.7 (Codex r3 #3): a SETTLED success is recorded — the one exception to «never leave while sending», honoured only once
      // reconciliation has durably completed (the leave verdict re-checks it); an unsettled end never qualifies
      // bound to THAT attempt (a later attempt's outcome only — a stale one is ignored) and to its order (a hosted-checkout return
      // carries no attempt: its own outcome)
      if ((k === 'placed' || k === 'paid_unverified') && out.unsettled !== true && typeof out.order_id === 'string' && (attempt === undefined || attempt === attemptSeq)) S.terminal = { order_id: out.order_id };
      if (k === 'placed' || k === 'paid_unverified') { if (S.screen !== 'sending') { S.screen = 'sending'; render(); } beat(out); return; }
      // the native app below the floor, with a store to send it to (runtime.store_urls; else today's shared notice): state 2, or state 3
      // when the identity is kept in flight (capp-api returns the existing outcome — confirming / existing_order — with update_required)
      // — AFTER placed / paid (a confirmed order always wins), BEFORE every other outcome (Codex store-update r1 #1)
      if (storeNow() && (k === 'update_required' || out.update_required === true)) { backTo('checkout'); showErr(out.update_required === true ? ERR.storeUpdatePending(storeNow().name) : ERR.storeUpdate(storeNow().name)); return; }
      if (k === 'confirming') { S.screen = 'sending'; S.sendHint = CONFIRMING_HINT; render(); return; }
      // §3.3 / frame 4: a MEMBER whose order met the GUEST gate — the server could not verify the session (token expired / SDK failure,
      // uid:null). Never a silent cash guest: the member stays a member, nothing was sent or charged, and is asked to sign in again
      if (member() && (k === 'guest_cash_not_allowed' || k === 'guest_email_required' || k === 'guest_ticket_invalid')) { backTo(); showErr(ERR.reauth()); return; }
      if (k === 'guest_cash_not_allowed') { if (S.flow && cardOnlyGuest()) S.flow.pay = 'online'; backTo('checkout'); showErr(ERR.guestCash()); return; }   // §3.3 server refusal ⇒ frame 6
      if (k === 'guest_ticket_invalid') { S.ticket = null; backTo(); openCode(); return; }   // §4: re-verify (expired / consumed / missing) — the code sheet over the screen of the tap
      if (k === 'guest_email_required') { S.emailRefused = true; backTo('checkout'); return; }   // §4b ⇒ frame 1b: the email field red, CTA «Revisá tu correo»
      if (k === 'held_other_account') { backTo('checkout'); showErr(ERR.heldOther()); return; }   // capp-api's backstop: nothing was sent
      if (k === 'schedule_needs_account') { backTo('checkout'); scheduleGate(); return; }   // capp-api's wire guard (G=B): nothing was sent
      if (k === 'offline') { backTo(sched() && S.flow && S.flow.time === 'schedule' ? 'checkout' : undefined); showErr(ERR.offline()); return; }   // S4 frame 10a: over «Entrega & Pago» (its picker becomes row 10b)
      if (k === 'closed') { S.closedRefused = true; backTo(); showErr(ERR.closed()); return; }   // over the screen of the tap (P placeTap :1975)
      if (k === 'slot_refused') { backTo('checkout'); showErr(ERR.slotRefused()); return; }   // S4 N1
      if (k === 'scheduled_review') { backTo('checkout'); showErr(ERR.schedReview()); return; }   // S4 row 9: paid, the slot under review
      if (k === 'out_of_zone') { S.outZone = true; backTo('checkout'); return; }
      // Codex cash-chips r1 P1-1: the replayed bytes were refused on their quote — the lock is released; «Entrega & Pago» quotes again
      // and the customer re-confirms (its own notices: the price note, the CTA), nothing was rebuilt or re-sent
      if (k === 'replay_requote') { backTo('checkout'); S.askedKey = null; S.quoteErr = null; requote(); return; }
      if (k === 'payment_failed') {
        backTo('checkout');   // P pixelPay :2016 — back() to «Entrega & Pago», then the sheet
        if (out.clearable === false) { showErr(ERR.pending()); return; }   // a cancel return the server still calls pending: the order stays locked
        // «Usar otra tarjeta» needs the whole checkout back: after a return that could not restore it, the generic held state (U3)
        showErr(S.returning && !contextRestored() ? ERR.generic() : cardOnlyGuest() ? ERR.payFailedGuest() : ERR.payFailed()); return;
      }
      if (k === 'refunded') { backTo('checkout'); showErr(ERR.refunded(out.refunded_total_cents)); return; }
      if (k === 'existing_order') { backTo('checkout'); showErr(ERR.exists(out.reference)); return; }   // also a kept identity after a 426 (update_required: true)
      // the held-states mockup draws both sheets over «Entrega & Pago» (#mk-paused / #mk-generic)
      if (k === 'paused') { backTo('checkout'); showErr(ERR.paused()); return; }
      // one sheet for the failures the customer can't tell apart: the card checkout not opened, the payment reference not saved,
      // a generic refusal, an unexpected error
      if (k === 'stash_failed' || k === 'try_again' || k === 'refused' || k === 'error' || k === 'payment_not_completed') { backTo('checkout'); showErr(ERR.generic()); return; }
      // update_required (426) is the shared self-update module's «Actualización pendiente»; price_declined: the ported sheet was answered
      backTo();
    }
    const errSheet = errSheetHtml;
    // the quote's values when it carries both; before a quote (the store header's ⓘ) the DIRECTORY's — never «undefined km»
    const feeInfoHtml = () => { const q = S.lastDelivery || {}, d = Number.isFinite(q.from_cents) && Number.isFinite(q.max_km) ? q : { from_cents: cfg.feeFromCents, max_km: cfg.zoneKm }; return `<div class="scrim" data-act="lclose"></div><div class="sheet" role="dialog" aria-label="Envío"><div class="grab"></div><div class="errsheet"><h2>Envío</h2><p>Sherpa calcula el envío según la distancia entre la sucursal y tu dirección. Desde ${moneyC(d.from_cents)}; zona de entrega hasta ${esc(d.max_km)} km de ${storeLine()}.</p><div class="acts"><button class="btn2 wide" data-act="lclose">Entendido</button></div></div></div>`; };
    // ── the full-screen pin step (prototype pinStepHtml :2186-2190; the prototype-only «Simulación» strip dropped) ──
    function pinStepHtml() {
      const zoneKm = (S.lastDelivery && Number.isFinite(S.lastDelivery.max_km) ? S.lastDelivery.max_km : cfg.zoneKm);
      const out = S.outZone;
      return `<div class="pinstep" role="dialog" aria-label="Confirmá dónde entregamos"><div class="mapwrap">${MAP_SVG}${gmapBox('pin')}<div class="store-nav" style="position:absolute"><button class="iconbtn" data-act="lclose" aria-label="Cancelar">${IC.close}</button><span></span></div><div class="hint">Mové el mapa hasta que el pin quede en tu puerta</div><span class="pin">${IC.pinfill}</span></div>
    <div class="foot"><b>Confirmá dónde entregamos</b><span class="sub">${out && Number.isFinite(zoneKm) && cfg.branch ? `${esc(cfg.name || '')} entrega hasta ${esc(zoneKm)} km de ${esc(cfg.branch)}; este punto queda fuera.` : 'Las direcciones aquí se describen con referencias: el pin es la dirección, los detalles son la referencia.'}</span><button class="primary" data-act="pin-done">Listo</button></div></div>`;
    }

    // «Ir al checkout»: THE path into the checkout — a tap, and (D-4a) a URL-driven entry through resumeTo('pago')
    function checkoutTap() { if (!orderable || soldBlock()) return false; if (typeof opts.beforeCheckout === 'function' && opts.beforeCheckout() === false) return true; let body = null; try { body = CappSerialize.serialize(cart, menu); } catch (e) { S.refusal = e && e.code === 'cart_text_too_long' ? FULL_CART : null; renderLayer(); return false; } emit('checkout', { body, mode: S.mode }); openCheckout(); return true; }
    // ── navigation ──
    function openCheckout() {
      if (!mods()) return false;
      // S7a-2 (PLAN-capp-S7a r2 §2.2): the flow is created ONCE with its pin decided — a restored return flow, else this mount's
      // own flow, else SEEDED from the shell's guest location (same coordinates ⇒ the same pin version) — before any render can geocode
      if (!S.flow) { S.flow = newFlow(); const sp = seedPin(); if (sp) C.setPin(S.flow, sp.lat, sp.lng, sp.confirmed === true); }
      C.setMode(S.flow, S.mode);
      if (cardOnlyGuest()) S.flow.pay = 'online';   // §3.1: one option, card, already selected
      // S4 P2: the schedule revalidated in the background, never awaited; a CHANGED one is held and applied at the next user picker
      // action (never under a finger); a failure leaves the schedule in hand
      if (sched() && api && typeof api.scheduleOnly === 'function') { const at = cfg.restaurantId; api.scheduleOnly().then((x) => { if (!dead && x && at === cfg.restaurantId && JSON.stringify(x) !== JSON.stringify(servedSched())) S.schedHeld = x; }, () => {}); }
      S.layerKind = null; S.cartNote = null; S.refusal = null; returnTo = null;
      // the cart stays on the stack: device back from «Entrega & Pago» reopens it (P :2298-2301)
      S.stack.push({ screen: 'store', layer: 'cart' }); S.stack = S.stack.slice(-12); pushHist();
      S.screen = 'checkout'; render();
      const sc = $('flow'); if (sc) sc.scrollTop = 0;
      if (S.flow.mode === 'delivery' && !finitePin(S.flow.pin) && S.geo === null) requestGeo();
      return true;
    }
    // «Agregar más platos», the last line removed, a pickup-only purge: straight to the MENU (P toMenu :1993-2001), the history walked back with it
    function toStore() {
      const i = S.stack.map((x) => x.screen).lastIndexOf('store');
      S.layerKind = null;
      if (i >= 0) { const k = S.stack.length - i; S.stack = S.stack.slice(0, i); if (ownHist()) { skipPop++; histN -= k; try { if (H) H.go(-k); else hist().go(-k); } catch (_) {} } }
      S.screen = 'store'; render();
    }
    // ── device / browser back (P pushHist / back / backInternal / popstate :1352-1371): «Entrega & Pago» has no back control;
    //    device back → the cart → the menu; the tip step's back → «Entrega & Pago» ──
    let histN = 0, skipPop = 0;
    // S7a-1 (PLAN-capp-S7a r2 §1.3): hosted ⇒ the shell's adapter { push, back, go, owns, subscribe } replaces the four
    // browser-touching primitives (pushState / back / go(-k) / ownHist); absent ⇒ window.history, exactly as before
    const H = opts.history || null;
    const hist = () => doc.defaultView && doc.defaultView.history;
    function pushHist() { histN++; try { if (H) H.push(); else hist().pushState({ ca: histN }, ''); } catch (_) {} }
    const ownHist = () => { try { if (H) return histN > 0 && H.owns() === true; const h = hist(); return histN > 0 && !!h.state && h.state.ca === histN; } catch (_) { return false; } };
    function go(screen) { S.stack.push({ screen: S.screen }); S.stack = S.stack.slice(-12); pushHist(); S.screen = screen; render(); const sc = $('flow'); if (sc) sc.scrollTop = 0; }
    function backInternal() {
      if (S.layerKind === 'cart') { closeLayer(); return; }   // closing the cart → the menu
      if (S.layerKind === 'placing') { placingStop(); closeLayer(); return; }   // a back during «Realizando pedido…» = «Volver» (nothing sent)
      if (S.screen === 'sending' || !S.stack.length) return;   // «Enviando» is not a back step
      const top = S.stack.pop();
      if (S.layerKind) { layerTeardown(); S.layerKind = null; S.err = null; }
      S.screen = top.screen; render();
      if (top.layer) openLayerNoPush(top.layer);
    }
    function openLayerNoPush(kind) { returnTo = null; S.layerKind = kind; renderLayer(true); }
    function back() { if (ownHist()) { skipPop++; histN--; try { if (H) H.back(); else hist().back(); } catch (_) {} } backInternal(); }
    function onPop(e) {
      if (skipPop > 0) { skipPop--; return; }
      const n = e && e.state && typeof e.state.ca === 'number' ? e.state.ca : 0;
      if (n < histN) { histN = n; backInternal(); }   // a forward move is ignored: only walks back
    }
    // S7a-1: a DEVICE back delivered by the shell (hosted). The same decisions as backInternal, reported: the cart closes / the
    // «Realizando pedido…» countdown is CANCELLED (zero sends) ⇒ consumed; «Enviando» ⇒ blocked; the store root ⇒ pass.
    // Codex r1 P2-6: a held / locked sheet (pending, recovery) ⇒ blocked; a payment lock this page holds ⇒ the store root is NOT
    // an unlocked root — blocked, never pass (the shell must not tear the store down over the lock)
    // Codex r2 P2-6 + advisor ruling (a), 2026-10-27: only a LIVE lock keeps the store — the pending lock (memLock / pay_pending),
    // a cart frozen for an order whose record still exists (a held recovery, an unresolved send), or an UNKNOWN freeze state
    // (fail closed). A frozen-but-NOT-live cart (§1.4, the lock expired with no marker) may be left: its freeze and evidence are
    // fully persisted, so leaving loses nothing — it re-mounts frozen
    // D-4a: the step this mount shows, for the host's URL reflection (the checkout flow — tip, sending, outcome — is ONE URL)
    function routeNow() { if (S.screen !== 'store') return { step: 'pago' }; if (S.open && S.open.id != null) return { step: 'plato', dish: String(S.open.id) }; if (S.layerKind === 'cart') return { step: 'pedido' }; return { step: 'store' }; }
    function reportRoute() { if (dead || typeof opts.onRoute !== 'function') return; try { opts.onRoute(routeNow()); } catch (_) { /* never breaks the UI */ } }
    const lockedNow = () => lockedHere() || frozenNow();
    function lockedHere() { return core.lockedHere(); }
    // Codex r2 New 3: a SHELL exit (a tab, the shell's own back, a shell screen opened over the store) asks with intent 'leave' —
    // answered without acting: blocked while sending, over a held sheet, or under a lock; otherwise pass (destroy() then cancels
    // a «Realizando pedido…» countdown: zero sends)
    function deviceBack(intent) {
      if (dead) return 'pass';
      if (intent === 'leave') return (S.screen === 'sending' && !S.terminal) || (S.layerKind === 'err' && S.err && S.err.held === true) || lockedHere() ? 'blocked' : 'pass';
      if (S.layerKind === 'err' && S.err && S.err.held === true) return 'blocked';
      if (S.layerKind === 'cart' || S.layerKind === 'placing') { histN = Math.max(0, histN - 1); backInternal(); return 'consumed'; }
      if (S.screen === 'sending') return 'blocked';
      if (!S.stack.length) { if (S.layerKind) { closeLayer(); return 'consumed'; } return lockedHere() ? 'blocked' : 'pass'; }
      histN = Math.max(0, histN - 1); backInternal(); return 'consumed';
    }
    function checkoutAct(t) {
      const f = S.flow, a = t.dataset.act, v = t.dataset.val;
      if (hasSlotLock() && (a === 'type' || a === 'editwho' || a === 'more' || a === 'editdetails' || a === 'tender' || a === 'pin' || a === 'cc')) return true;   // frame 10b: fixed (cash-chips lock)
      if (a === 'type') { if (frozenNow()) return true; S.mode = v === 'pickup' ? 'pickup' : 'delivery'; C.setMode(f, S.mode); notifyCart(); if (S.mode === 'delivery' && !finitePin(f.pin) && S.geo === null) requestGeo(); render(); return true; }
      if (a === 'rm-po') { for (const l of poLines()) mutate(() => cart.setQty(l.key, 0)); if (!cart.count()) toStore(); else render(); return true; }
      if (a === 'editwho') { f.editWho = true; render(); return true; }
      if (sched() && (a === 'time' || a === 'slotday' || a === 'slot')) {
        if (hasSlotLock()) return true;   // row 10: fixed while the send is unresolved
        applyHeldSched();   // P2: a revalidated schedule lands on a USER action, never under a finger
        if (a === 'time' && v === 'schedule' && !canSchedule()) { scheduleGate(); return true; }   // frame G: the order stays ASAP
        if (a === 'time') { f.time = v === 'schedule' ? 'schedule' : 'asap'; if (f.time === 'asap') f.slot = null; }
        if (a === 'slotday') { f.slotDay = v; f.slot = null; }
        if (a === 'slot') { const ms = Number(v); if (Number.isFinite(ms)) { f.slot = ms; f.slotDay = schedMod().dayKey(servedSched(), ms); } }
        render(); return true;
      }
      if (a === 'cc' && intl()) { openLayer('cc'); render(); return true; }
      if (a === 'more') { S.more = true; render(); return true; }
      if (a === 'editdetails') { S.editDetails = true; render(); return true; }
      if (a === 'sumtoggle') { S.sumOpen = S.desk ? S.sumOpen === false : !S.sumOpen; render(); return true; }
      if ((a === 'pay' || a === 'showpay') && lockedPay() !== null) return true;   // row 10: the tender is fixed while the send is unresolved
      if (a === 'pay') { f.pay = v === 'online' || cardOnlyGuest() ? 'online' : 'cash'; S.showPay = false; render(); return true; }
      if (a === 'showpay') { S.showPay = true; render(); return true; }
      if (a === 'tender') { f.tendered = v; render(); return true; }
      if (a === 'addmore') { toStore(); return true; }
      if (a === 'time') return true;   // ASAP is the only option in S2
      if (a === 'pin') { S.pinDraft = finitePin(f.pin) ? { lat: f.pin.lat, lng: f.pin.lng } : (cfg.loc && finitePin(cfg.loc) ? { lat: cfg.loc.lat, lng: cfg.loc.lng } : null); openLayer('pin'); return true; }
      if (a === 'loc-on') { S.geo = null; requestGeo(); return true; }
      if (a === 'feeinfo') { openLayer('feeinfo'); return true; }
      // §4c: the cart and this checkout step are kept (the host returns here); the returning row PRE-FILLS the full number
      if (a === 'signin') { const ctx = t.dataset.ctx || 'checkout'; let dev = null; if (ctx === 'checkout-returning') { try { dev = opts.deviceAccount(); } catch (_) { dev = null; } }
        emit('signin', { ctx, ...(dev && dev.e164 ? { prefill: dev.e164 } : {}) }); return true; }
      if (a === 'confirm' && hasSlotLock()) { if (!ctaOff(totalsNow())) send(); return true; }   // S4 row 10b: «Reintentar» re-sends the SAME order (its tip already chosen)
      if (a === 'confirm') { if (ctaOff(totalsNow())) return true; if (f.mode === 'delivery') go('tip'); else placeTap(); return true; }
      return false;
    }
    function tipAct(t) {
      const f = S.flow, a = t.dataset.act;
      if (a === 'back') { back(); return true; }
      if (a === 'tipc') { const v = t.dataset.val; if (v === 'other') { S.tipDraft = f.tipChoice && f.tipChoice.kind === 'other' && f.tipCents ? String(f.tipCents / 100) : ''; openLayer('tipother'); return true; } C.chooseTip(f, Number(v)); render(); return true; }
      if (a === 'tip-place') { if (!tipReady(totalsNow())) return true; placeTap(); return true; }
      return false;
    }
    function layerAct(t) {
      // S-picker: a country picked ⇒ the sheet closes, the digits stay (capped to the new length), the phone focused
      if (t.dataset.act === 'cc-pick' && S.layerKind === 'cc' && intl() && S.flow) {
        if (hasSlotLock()) return true;   // Codex cash-chips r2 P2-2: frame 10b's phone is fixed (an already-open picker too)
        const f = S.flow, cc = t.dataset.cc; if (!phoneMod().byCc(cc)) return true;
        if (cc !== ccOf(f)) { f.cc = cc; f.phone = phoneMod().format(cc, f.phone); }
        S.layerKind = null; renderLayer(); returnTo = null; render(); const ph = $('f-phone'); if (ph) focusTo(ph); syncCta(); return true;
      }
      const a = t.dataset.act;
      if (a === 'tk') { const v = t.dataset.val; S.tipDraft = v === 'del' ? (S.tipDraft || '').slice(0, -1) : capDraft((S.tipDraft || '') + v, S.tipDraft || ''); renderLayer(); return true; }
      if (a === 'tip-save') { const n = Number(S.tipDraft) || 0; C.chooseTip(S.flow, { other: Math.min(n, C.TIP_MAX_LEMPIRAS) }); closeLayer(); render(); return true; }
      if (a === 'placing-go') { placingGo(); return true; }
      if (a === 'placing-back') { placingStop(); closeLayer(); return true; }
      if (a === 'pin-done') {
        // the ACTIVE map's centre at the tap (an `idle` may not have fired yet); no live map ⇒ the draft
        const live = pinMap && pinMap.gen === pinGen && pinMap.el.isConnected ? pinMap.m.getCenter() : null;
        const d = live ? { lat: live.lat(), lng: live.lng() } : S.pinDraft;
        dropPinMap();   // the closing map is obsolete from here
        if (d && finitePin(d)) {
          C.setPin(S.flow, d.lat, d.lng, true); S.pinStepOk = true; emit('pin', { lat: d.lat, lng: d.lng, confirmed: true, source: 'pin' });
          // P :2272 toasts on every «Listo»: after the re-quote when the point moved, at once when it did not (no re-quote runs)
          if (stateKey() === S.askedKey) toast(S.outZone ? 'Ese punto queda fuera de la zona' : 'Pin confirmado', TOAST_MS);
          else { S.outZone = false; S.pinToast = true; }
        }
        closeLayer(); render(); return true;
      }
      if (a === 'store-open') { if (storeNow()) emit('store-open', { url: storeNow().url }); return true; }   // the host leaves for the store; the sheet stays
      if (a === 'err-retry') { closeLayer(); send(); return true; }   // the SAME placement (capp-api keeps the id)
      if ((a === 'err-sched' || a === 'err-slot') && sched() && S.flow && !canSchedule()) { closeLayer(); backTo('checkout'); scheduleGate(); return true; }   // frame G
      if (a === 'err-sched' && sched() && S.flow) { closeLayer(); S.closedRefused = false; applyHeldSched(); S.flow.time = 'schedule'; S.flow.slot = null; backTo('checkout'); return true; }   // P:2287: the picker
      if (a === 'err-slot' && sched() && S.flow) { closeLayer(); applyHeldSched(); S.flow.time = 'schedule'; S.flow.slot = null; backTo('checkout'); return true; }   // N1: the picker, the slot cleared
      if (a === 'err-requote') { closeLayer(); S.quoteErr = null; requote(); return true; }   // the failed quote, asked again (its key was released)
      if (a === 'err-cash') { closeLayer(); if (cardOnlyGuest()) { showErr(ERR.guestCash()); return true; } emit('pay-cash', {}); return true; }   // TODO(ruling pending); a guest never reaches cash (§3.2)
      if (a === 'reauth') { closeLayer(); emit('signin', { ctx: 'reauth' }); return true; }   // the host re-authenticates, then this checkout continues
      if (a === 'otp-verify') { verifyCode(); return true; }
      if (a === 'otp-verify-retry') { closeCodeErr(); verifyCode(); return true; }
      if (a === 'otp-resend') { closeCodeErr(); requestCode(); return true; }
      if (a === 'otp-change') { closeOtp(); S.screen = 'checkout'; render(); const ph = $('f-phone'); if (ph) focusTo(ph); return true; }   // «Cambiar número»: back to Tus datos, the phone focused
      if (a === 'otp-signin') { closeOtp(); emit('signin', { ctx: 'code' }); return true; }
      if (a === 'otp-back') { closeOtp(); return true; }   // «Volver al pedido»: the sheet closes, the cart as it was
      if (a === 'guest-card') { closeLayer(); if (S.flow) S.flow.pay = 'online'; S.screen = 'checkout'; render(); placeTap(); return true; }   // frame 6 «Pagar con tarjeta»: card, then the send again
      if (a === 'guest-signup') { closeLayer(); emit('signin', { ctx: 'refusal' }); return true; }
      if (a === 'err-card') {   // a new card attempt goes through the same placing card — once the restored checkout is priced
        closeLayer(); S.screen = 'checkout';
        if (S.flow) S.flow.pay = 'online';   // §3.2 (Codex guest r1 #6): «Usar otra tarjeta» EXPLICITLY selects online — never an ambiguous tender
        if (totalsNow().ready) { render(); placeTap(); return true; }
        S.askedKey = null; S.quoteErr = null;
        const asked = requote(); render();   // requote marks its key first: the render does not ask again
        asked.then(() => { if (dead) return; if (totalsNow().ready) placeTap(); else if (!S.layerKind) showErr(ERR.generic('err-requote')); });
        return true;
      }
      if (a === 'home') { closeLayer(); emit('home'); return true; }
      return false;
    }
    // ?pay= — the hosted-checkout return
    // S2b r1 P2-4: the checkout context (mode, pin, customer fields, tip) back from the body the card send stashed; null ⇒ not
    // fully restorable (an action that needs it is never offered)
    function flowFromBody(b) {
      if (!b || typeof b !== 'object') return null;
      const f = newFlow();
      C.setMode(f, b.order_type === 'pickup' ? 'pickup' : 'delivery');
      Object.assign(f, { name: String(b.customer_name || ''), phone: String(b.customer_phone || '').replace(/^\+504\s*/, ''), email: String(b.customer_email || ''),
        notes: b.notes && b.notes !== '—' ? String(b.notes) : '', pay: b.payment_method === 'online' || cardOnlyGuest() ? 'online' : 'cash' });   // §3.2: a guest's restore is never cash
      if (intl()) setPhone(f, b.customer_phone);   // the picker's wire is E.164: the restored number keeps its country
      if (sched()) { const sf = Number(b.scheduled_for); if (b.scheduled_for != null && Number.isFinite(sf) && canSchedule()) { f.time = 'schedule'; f.slot = sf; f.slotDay = schedMod().dayKey(servedSched(), sf); } else { f.time = 'asap'; f.slot = null; } }
      if (f.mode === 'delivery') {
        if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return null;
        C.setPin(f, b.lat, b.lng, true); f.details = String(b.address_details || '');
        const l = Number(b.tip_cents || 0) / 100;
        if (!Number.isInteger(l) || C.chooseTip(f, C.TIP_PRESETS.includes(l) ? l : { other: l }) === false) return null;
      }
      return f;
    }
    const contextRestored = () => !!S.flow && S.flowRestored === true && !need() && (S.flow.mode !== 'delivery' || C.tipChosen(S.flow));
    async function handlePayReturn(search) {
      if (!mods()) return;
      const q0 = new URLSearchParams(search || ''); const rec0 = api.readPlace();
      const rid0 = q0.get('order') || (rec0 && rec0.order_id) || null;
      const back = rid0 ? flowFromBody(api.stashedOrder(rid0)) : null;
      if (back) { S.flow = back; S.mode = back.mode; S.flowRestored = true; }
      if (!S.flow) { S.flow = newFlow(); C.setMode(S.flow, S.mode); S.flow.pay = 'online'; }
      S.returning = true;
      const rec = api.readPlace();
      S.backScreen = 'checkout'; S.screen = 'sending'; S.sendHint = null;
      S.sendTotals = rec ? { total: Number.isFinite(rec.expected_net_cents) ? rec.expected_net_cents : null, tip: rec.totals && Number.isFinite(rec.totals.tip) ? rec.totals.tip : 0 } : null;
      render();
      let out; try { out = await api.handleReturn(search); } catch (e) { out = { kind: 'error' }; }
      if (out && !dead) onOutcome(out);
      return out;   // S7a-2: the shell settles its return handoff on an AUTHORITATIVE outcome (CappShell.settleHandoff)
    }

    // ── S2-checkout: card payment INSIDE the installed app (MOCKUP-capp-S2-sdk-checkout v7, owner 11-08; advisor design A–D and rulings
    // 1–5, 11-08; CONTRACT-sdk-checkout r3). Dark unless cfg.sdkCheckout (the shell sets it only for the INSTALLED app with
    // runtime.sdkPay); the web keeps the hosted page. The money path is capp-api's (placeSdk inside the placement machinery); this block
    // only paints and routes: the payment row (checkout bar + tip footer), the chooser, «Agregar tarjeta» (its inputs come from the native
    // field host — none in the webview without it, ruling 5), the processing sheet (frames 4 / 4b, after the kept 2-s window, ruling 2),
    // the decline sheet (5), the wells (6 / 7), the status poll while the bank answers, and the cash switch (§5).
    const sdkMod = (n, f) => { try { return opts[n] || (typeof self !== 'undefined' && self[n]) || (typeof require === 'function' ? require(f) : null); } catch (_) { return null; } };
    let PCARD = null, PCO = null;
    function sdkOn() {
      if (cfg.sdkCheckout !== true || !mods() || typeof api.placeSdk !== 'function') return false;
      PCARD = PCARD || sdkMod('CappPayCard', './capp-pay-card.js'); PCO = PCO || sdkMod('CappPayCheckout', './capp-pay-checkout.js');
      return !!(PCARD && PCO);
    }
    const SDK = { cards: null, avail: null, sel: null, loading: false, loaded: false, decl: null, declId: null, proc: null, pollT: null, pollN: 0, save: true, form: {}, replaces: null, back: null };
    const sdkCtx = () => ({ guest: !member(), cashAllowed: !cardOnlyGuest() });
    const sdkHost = () => (opts.paySdk && opts.paySdk.fieldHost && typeof opts.paySdk.fieldHost.input === 'function' ? opts.paySdk.fieldHost : null);
    const sdkAuth = () => ({ checkoutTicket: cardOnlyGuest() ? S.ticket : undefined });
    // the saved cards (members) and the card path's availability — read once per mount, when the checkout first shows
    function sdkLoad() {
      if (SDK.loading || SDK.loaded || !sdkOn()) return;
      SDK.loading = true;
      Promise.all([member() ? Promise.resolve().then(() => api.listCards()).catch(() => null) : null, Promise.resolve().then(() => api.sdkPayStatus()).catch(() => null)]).then(([list, st]) => {
        if (dead) return;
        SDK.loading = false; SDK.loaded = true;
        SDK.cards = PCARD.cardsVm(list);
        SDK.avail = st ? st.available : null;   // unknown ⇒ the server decides at placement (its `unavailable`)
        if (!SDK.sel && SDK.cards.selected) SDK.sel = { kind: 'card', card_id: SDK.cards.selected };
        if (S.screen === 'checkout' || S.screen === 'tip') render();
      });
    }
    // the method the row shows: cash, the chosen saved / new card, else the expired one (frame 6, dimmed), else none
    function sdkMethod() {
      if (S.flow && S.flow.pay === 'cash') return { kind: 'cash' };
      const s = SDK.sel;
      if (s && s.kind === 'new') return { kind: 'card', brand: s.display.brand, label: PCARD.cardLabel(s.display.brand, s.display.last4) };
      const row = s && s.kind === 'card' && SDK.cards ? SDK.cards.rows.find((r) => r.card_id === s.card_id && !r.expired) : null;
      if (row) return { kind: 'card', brand: row.brand, label: row.label };
      const exp = SDK.cards && !SDK.cards.selected ? SDK.cards.rows.find((r) => r.expired) : null;
      return exp ? { kind: 'card', brand: exp.brand, label: exp.label, sub: exp.sub, dim: true, expired: true } : null;
    }
    // the selection placeSdk sends (CappPayCard.placeBody's card), or null
    function sdkCard() {
      const s = SDK.sel; if (!s) return null;
      if (s.kind === 'new') return { kind: 'new', sdk_token: s.sdk_token, save: s.save, authentication_identifier: s.authentication_identifier, display: { ...s.display } };
      return SDK.cards && SDK.cards.rows.some((r) => r.card_id === s.card_id && !r.expired) ? { kind: 'saved', card_id: s.card_id } : null;
    }
    function sdkGate() {
      const m = sdkMethod(), ctx = sdkCtx();
      if (S.flow && S.flow.pay === 'cash') return '';
      if (SDK.avail === false) return PCO.gateHtml('unavailable', ctx);
      return m && m.expired ? PCO.gateHtml('token_expired', ctx) : '';
    }
    // the bar: a well ⇒ the disabled «Elegí cómo pagar»; no card chosen ⇒ «Elegí cómo pagar» opens the chooser; else the host's primary
    function sdkBar(T, cta) {
      const m = sdkMethod(), gate = sdkGate(), cardless = S.flow && S.flow.pay !== 'cash' && !sdkCard();
      const c = gate ? { label: 'Elegí cómo pagar', enabled: false } : cardless ? { label: 'Elegí cómo pagar', enabled: true, act: 'paysheet', id: cta.id } : cta;
      return PCO.payBarHtml({ method: gate && !(m && m.expired) ? null : m, total_cents: T.ready ? T.total : 0, cta: c, gate });
    }
    const sdkTipRow = (T) => (sdkGate() ? '' : PCO.payRowHtml(sdkMethod(), T.ready ? T.total : 0));
    function sdkChooserHtml() {
      const sel = S.flow && S.flow.pay === 'cash' ? { kind: 'cash' } : SDK.sel && SDK.sel.kind === 'card' ? SDK.sel : null;
      return PCO.chooserHtml({ cards: SDK.cards || { rows: [], selected: null }, selected: sel, cash: sdkCtx().cashAllowed });
    }
    const sdkFormHtml = () => PCO.formHtml(PCARD.formVm(SDK.form, { member: !!member() }), sdkHost());
    function sdkStopPoll() { if (SDK.pollT !== null) { T_.clearTimeout(SDK.pollT); SDK.pollT = null; } }
    function sdkPollLater(id, ms) {
      sdkStopPoll();
      SDK.pollT = T_.setTimeout(async () => {
        SDK.pollT = null; if (dead) return;
        let out; try { out = await api.sdkStatus(id, sdkAuth()); } catch (_) { out = { kind: 'sdk_pending', order_id: id }; }
        if (!dead) onSdkOutcome(out);
      }, ms);
    }
    function sdkProc(review) {
      const total = S.sendTotals && Number.isFinite(S.sendTotals.total) ? S.sendTotals.total : (totalsNow().ready ? totalsNow().total : 0);
      const m = sdkMethod();
      SDK.proc = { total_cents: total, card: m && m.kind === 'card' ? { brand: m.brand, label: m.label } : null, review: !!review };
      if (S.layerKind === 'sdkproc') renderLayer(); else openLayerNoPush('sdkproc');
    }
    // one outcome of placeSdk / sdkStatus / sdkSwitchToCash → the screen (the money decisions are capp-api's)
    function onSdkOutcome(out) {
      const k = out && out.kind;
      sdkStopPoll();
      if (k === 'sdk_pending') { sdkProc(SDK.proc && SDK.proc.review); sdkPollLater(out.order_id, SDK.pollN++ < POLL_SDK_FAST_N ? POLL_SDK_MS : POLL_SDK_SLOW_MS); return; }
      if (k === 'sdk_review') { sdkProc(true); sdkPollLater(out.order_id, POLL_SDK_REVIEW_MS); return; }
      SDK.pollN = 0;   // any settled outcome restarts the backoff
      if (S.layerKind === 'sdkproc') { S.layerKind = null; renderLayer(); }
      if (k === 'placed') { SDK.replaces = null; onOutcome(out); return; }
      if (k === 'sdk_declined') {
        SDK.declId = out.order_id;
        SDK.decl = PCARD.nextStep({ outcome: 'declined', decline: out.bucket }, sdkCtx());
        if (out.bucket === 'token_expired' || out.bucket === 'hard') SDK.sel = null;   // the declined card is unselected (frame 5)
        backTo(); openLayerNoPush('sdkdecl'); return;
      }
      if (k === 'sdk_expired') { backTo('checkout'); if (!out.safe) sdkPollLater(out.order_id, POLL_SDK_MS); return; }
      if (k === 'sdk_unavailable') { SDK.avail = false; backTo(); return; }
      if (k === 'sdk_not_allowed' || k === 'sdk_bad_card') { backTo('checkout'); return; }
      if (k === 'sdk_switched') { SDK.replaces = out.replaces; SDK.declId = null; if (S.flow) S.flow.pay = 'cash'; render(); placeNow(); return; }
      onOutcome(out);   // the shared refusals (closed, offline, the recovery sheet, …)
    }
    // send(): the SDK card path (after the kept 2-s window); the processing sheet over the screen of the tap
    async function sdkSend(p, attempt) {
      sdkProc(false);
      let out; try { out = await api.placeSdk(p); } catch (_) { out = { kind: 'sdk_pending', order_id: null }; }
      if (dead || attempt !== attemptSeq) return;
      if (out && out.kind === 'sdk_pending' && !out.order_id) { const id = api.sdkLive(); out = id ? { ...out, order_id: id } : { kind: 'offline' }; }
      onSdkOutcome(out);
    }
    async function sdkCash() {
      const id = SDK.declId;
      if (S.layerKind) { S.layerKind = null; renderLayer(); }
      if (!id) { if (S.flow) S.flow.pay = 'cash'; render(); return; }   // nothing was attempted: simply cash
      sdkProc(false);
      let out; try { out = await api.sdkSwitchToCash(id, sdkAuth()); } catch (_) { out = { kind: 'sdk_pending', order_id: id }; }
      if (!dead) onSdkOutcome(out);
    }
    async function sdkSaveCard() {
      const b = opts.paySdk; const host = sdkHost(); if (!b || !host) return;
      const r = await b.tokenize(host);
      if (dead || !r || r.ok !== true) { toast('No pudimos guardar la tarjeta. Revisá los datos.'); return; }
      SDK.sel = { kind: 'new', sdk_token: r.sdk_token, save: !!member() && SDK.save, authentication_identifier: r.authentication_identifier, display: { ...r.display } };
      if (S.flow) S.flow.pay = 'online';
      S.screen = SDK.back || 'checkout'; SDK.back = null; render();   // owner ruling 1: back to checkout with the card selected
    }
    // the SDK acts (the chooser, the form, the sheets, the wells) — true when handled
    function sdkAct(t) {
      const a = t.dataset.act; if (!sdkOn() || !S.flow) return false;
      if (a === 'paysheet') { openLayer('paysheet'); return true; }
      if (a === 'paysheet-close') { closeLayer(); return true; }
      if (a === 'paypick') { const v = t.dataset.card; if (v === 'cash') S.flow.pay = 'cash'; else { S.flow.pay = 'online'; SDK.sel = { kind: 'card', card_id: v }; } closeLayer(); render(); return true; }
      if (a === 'addcard' || a === 'decl-fix' || a === 'decl-add_card') { if (S.layerKind) { S.layerKind = null; renderLayer(); } SDK.back = S.screen === 'addcard' ? SDK.back : S.screen; SDK.form = {}; SDK.save = true; S.screen = 'addcard'; render(); return true; }
      if (a === 'addcard-back') { S.screen = SDK.back || 'checkout'; SDK.back = null; render(); openLayer('paysheet'); return true; }   // back to the chooser, nothing saved
      if (a === 'savecard') { SDK.save = !SDK.save; render(); return true; }
      if (a === 'cvv-info') { toast('Son los 3 dígitos al reverso de tu tarjeta.'); return true; }
      if (a === 'addcard-save') { sdkSaveCard(); return true; }
      if (a === 'decl-other_card') { S.layerKind = null; renderLayer(); openLayer('paysheet'); return true; }
      if (a === 'decl-cash') { sdkCash(); return true; }
      if (a === 'sdk-retry') { SDK.loaded = false; SDK.avail = null; sdkLoad(); render(); return true; }
      return false;
    }
    // mount: a live SDK attempt on this device ⇒ its status FIRST (advisor condition), the processing sheet meanwhile
    function sdkResume() {
      if (!sdkOn()) return;
      const id = api.sdkLive(); if (!id) return;
      sdkProc(false);
      Promise.resolve().then(() => api.sdkStatus(id, sdkAuth())).catch(() => ({ kind: 'sdk_pending', order_id: id })).then((out) => { if (!dead) onSdkOutcome(out); });
    }

    function render() {
      if (dead) return;
      app.classList.toggle('narrow', app.clientWidth > 0 && app.clientWidth < 375);
      if (view) app.classList.toggle('desk', S.desk);   // D-2 (v6 :1384); never touched without a view
      const keepSearch = S.layerKind === 'ssearch' && $('layer') && $('layer').querySelector('#sq') ? $('layer') : null;
      const ae = doc.activeElement;
      const had = app.contains(ae) ? descOf(ae) : null;
      const caret = had && ae && ae.id && typeof ae.selectionStart === 'number' ? [ae.id, ae.selectionStart, ae.selectionEnd] : null;   // S2b: typing survives a quote landing
      const keepToast = $('toast');
      const prevFlow = $('flow'); const flowY = prevFlow ? prevFlow.scrollTop : null; const prevScreen = app.dataset.screen;
      // the S2b router: every screen inside <div class="screen"> (the prototype's mount)
      const html = S.screen === 'checkout' ? checkoutHtml() : S.screen === 'tip' ? tipHtml() : S.screen === 'sending' ? sendingHtml() : S.screen === 'addcard' && sdkOn() ? sdkFormHtml() : storeHtml();
      app.innerHTML = `<div class="screen">${html}</div>${detailSkeleton()}<div class="layer" id="layer"></div><div class="toast" id="toast" role="status" aria-live="polite"></div>`;   // the prototype's mount (render())
      app.dataset.screen = S.screen;
      if (keepSearch) app.replaceChild(keepSearch, $('layer'));
      if (keepToast) app.replaceChild(keepToast, $('toast'));   // a live refusal toast survives the re-render that follows it
      if (S.screen === 'store') wireStore();
      if (S.screen === 'checkout' && flowY !== null && prevScreen === 'checkout' && $('flow')) $('flow').scrollTop = flowY;
      renderLayer();
      if (S.open) { renderDetail(); $('detail-overlay').classList.add('open'); $('detail-modal').classList.add('open'); }
      syncInert(); reportRoute();
      if (had && lost()) { focusTo(refind(had)); if (caret && doc.activeElement && doc.activeElement.id === caret[0]) { try { doc.activeElement.setSelectionRange(caret[1], caret[2]); } catch (_) {} } }
      if (S.screen === 'checkout') wireMaps();
      if ((S.screen === 'checkout' || S.screen === 'tip') && cfg.sdkCheckout === true) sdkLoad();   // S2-checkout: the cards + availability, once
      if (S.screen === 'checkout' || S.screen === 'tip') requote();
      geocodePin();
    }
    function onClick(ev) {
      const t = ev.target.closest && ev.target.closest('[data-act]'); if (!t || !app.contains(t)) return;
      const act = t.dataset.act, id = t.dataset.id;
      if (S.open && ['qty', 'extra', 'variant', 'staged', 'dcta'].includes(act)) { detailAct(t); return; }
      if (act === 'dclose') { closeDetail(); return; }
      if (cfg.sdkCheckout === true && /^(paysheet|paypick|addcard|savecard|cvv-info|decl-|sdk-retry)/.test(act) && sdkAct(t)) return;   // S2-checkout
      // S2b: the open layer's controls, then the current screen's
      if (S.layerKind && ['err', 'placing', 'tipother', 'pin', 'feeinfo', 'otp', 'cc'].includes(S.layerKind)) { if (act === 'lclose') { closeLayer(); return; } if (layerAct(t)) return; }
      if (S.screen === 'checkout' && !S.layerKind) {
        if (act === 'rev') { if (Number(t.dataset.rev) > 0 && isSold(find(t.dataset.key))) return; mutate(() => (Number(t.dataset.rev) > 0 ? cart.lineInc(t.dataset.key, t.dataset.grp || '') : cart.lineDec(t.dataset.key, t.dataset.grp || ''))); if (!cart.count()) toStore(); else render(); return; }
        if (checkoutAct(t)) return;
      }
      if (S.screen === 'tip' && !S.layerKind && tipAct(t)) return;
      if (act === 'inc') { const it = find(id); if (it && it.group) { openDetail(id); return; } if (!it || isSold(it)) { renderStoreKeep(); return; } if (mutate(() => cart.inc(id))) { S.expanded.add(id); bumpPill(); } renderStoreKeep(); return; }
      if (act === 'dec') { const it = find(id); if (it && it.group) { openLayer('cart'); return; } mutate(() => cart.dec(id)); renderStoreKeep(); return; }
      if (act === 'badge') { S.expanded.add(id); renderStoreKeep(); return; }
      if (act === 'open') { returnTo = descOf(t); openDetail(id); return; }
      if (act === 'pill') { openLayer('cart'); return; }
      if (act === 'feeinfo' && S.screen === 'store' && !S.layerKind) { returnTo = descOf(t); openLayer('feeinfo'); return; }   // the store header's ⓘ (v6 :1609): the directory's values
      if (act === 'cartclose') { back(); return; }   // closing the cart is a back step → the menu (P :2297)
      if (act === 'lclose') { closeLayer(); return; }
      if (act === 'rev') { const k = t.dataset.key, g = t.dataset.grp || '', d = descOf(t); if (Number(t.dataset.rev) > 0 && isSold(find(k))) return; mutate(() => (Number(t.dataset.rev) > 0 ? cart.lineInc(k, g) : cart.lineDec(k, g))); renderStoreKeep(); renderLayer(); focusTo(refind(d) || [...$('layer').querySelectorAll(FOCUSABLE)].find(reachable)); return; }
      // the sheet's «Editar» closes the sheet ⇒ focus comes back to the cart bar; the desk aside's stays put ⇒ back to ITSELF (Codex D-2 r1 #2)
      if (act === 'edit') { const fromAside = !!t.closest('.deskcart'); S.layerKind = null; renderLayer(); returnTo = fromAside ? descOf(t) : { elId: 'cart-bar', ds: { act: 'pill' } }; openEdit(t.dataset.key, t.dataset.grp || ''); return; }
      if (act === 'mode') { if (frozenNow()) return; S.mode = t.dataset.val; notifyCart(); renderStoreKeep(); return; }
      if (act === 'jump') { jumpTo(t.dataset.jump); return; }
      if (act === 'menu') { openLayer('menu'); return; }
      if (act === 'goto') { closeLayer(); jumpTo(t.dataset.goto); return; }
      if (act === 'ssearch') { openLayer('ssearch'); return; }
      if (act === 'back') { emit('back'); return; }
      // S7a-2: the host may adopt a newer verified menu first (opts.beforeCheckout() === false ⇒ it took over: not opened here)
      if (act === 'checkout') { checkoutTap(); return; }
      if (act === 'closed-sched' && sched()) {
        if (!cart.count()) { toast('Agregá platos y programá al final'); return; }
        if (!S.flow) S.flow = newFlow();
        if (canSchedule()) { S.flow.time = 'schedule'; S.flow.slot = null; } else S.schedAfterSignin = false;
        openCheckout(); if (!canSchedule()) scheduleGate();
        return;
      }
      if (act === 'closed-sched') { emit('schedule'); return; }
      if (act === 'frozen-status') { frozenStatus(); return; }
    }
    const FLOW_FIELDS = ['details', 'name', 'phone', 'email', 'notes', 'tendered'];
    function onInput(ev) {
      const t = ev.target; if (!t || !t.dataset) return;
      const fld = t.dataset.field;
      if (fld === 'otp') { otpInput(t); return; }
      if (fld === 'sq') { S.searchQ = t.value; runStoreSearch(t.value); return; }
      if (S.flow && FLOW_FIELDS.includes(fld) && hasSlotLock()) return;   // Codex cash-chips r1 P2-3: frame 10b's fields are fixed (inputs too)
      if (fld === 'tipOther') { S.tipDraft = capDraft(t.value, S.tipDraft || ''); t.value = S.tipDraft || '0'; t.style.width = `calc(${Math.max(1, t.value.length)}ch + 6px)`; return; }
      if (S.flow && fld === 'phone' && intl()) {
        // the country's local format as they type, never past its national length
        const P = phoneMod(), raw = String(t.value || '').trim();
        // Codex S-picker r1 #1 (+ advisor): a QUALIFIED number ('+' or '00') is read as E.164 FIRST — never formatted into the selected
        // country's digits. It parses (a paste / autofill, or the last digit typed) ⇒ its country and digits together. It does not
        // parse YET ⇒ the text stays exactly as typed (no formatting, no truncation, the country unchanged) and the order is
        // incomplete (valid() refuses a qualified text) — so a number can be typed by hand; an unparseable one is cleared on blur
        if (/^(\+|00)/.test(raw)) {
          const q = P.parseE164(raw.replace(/^00/, '+'));
          if (q) {
            S.flow.cc = q.cc; S.flow.phone = P.format(q.cc, q.national);
            render(); const ph = $('f-phone'); if (ph) { focusTo(ph); try { ph.setSelectionRange(ph.value.length, ph.value.length); } catch (_) {} }
          } else S.flow.phone = t.value;
          syncCta(); return;
        }
        const cc = ccOf(S.flow), v = P.format(cc, t.value);
        if (t.value !== v) t.value = v;
        S.flow.phone = v; S.flow.cc = cc;
        const n = $('f-phone-cc'); if (n) { const h = ccNote(S.flow); n.innerHTML = h; n.hidden = !h; }
        syncCta(); return;
      }
      if (S.flow && FLOW_FIELDS.includes(fld)) {
        S.flow[fld] = t.value;
        if (fld === 'email' && cardOnlyGuest()) { S.emailRefused = false; if (C.validEmail(t.value)) { const fe = t.closest('.fld'); if (fe) fe.classList.remove('bad'); } }   // the red clears as soon as it is valid
        if (fld === 'tendered') { const n = $('tender-note'); if (n) n.textContent = tenderNote(totalsNow()); }
        syncCta();
      }
    }
    // the prototype's keyboard handler (Escape closes; Enter / Space activate the checkbox / radio rows and the badge) + Tab containment
    function onKey(e) {
      if (!app.contains(e.target) && e.target !== doc.body) return;
      if (e.key === 'Escape') {
        if (S.open) { e.preventDefault(); closeDetail(); return; }
        // an alert sheet without «Cerrar» / «Volver» (the refund sheet) is answered by its button, never dismissed
        if (S.layerKind === 'err' && !(S.err && S.err.acts.some((a) => a.act === 'lclose'))) { e.preventDefault(); return; }
        if (S.layerKind === 'cart') { e.preventDefault(); back(); return; }
        if (S.layerKind) { e.preventDefault(); closeLayer(); return; }
      }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role="checkbox"][data-act], [role="radio"][data-act], .qty-badge')) { e.preventDefault(); e.target.click(); return; }
      if (e.key === 'Tab') {
        const dlg = dialogEl(); if (!dlg) return;
        const f = [...dlg.querySelectorAll(FOCUSABLE)].filter(reachable);
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1];
        if (!dlg.contains(doc.activeElement)) { e.preventDefault(); focusTo(first); return; }
        if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); focusTo(last); } else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); focusTo(first); }
      }
    }

    app.classList.add('app');
    doc.addEventListener('click', onClick);
    doc.addEventListener('input', onInput);
    doc.addEventListener('keydown', onKey);
    // S-picker: leaving the WhatsApp field with a qualified number that never parsed ⇒ it is cleared (the CTA's «Escribí tu WhatsApp»)
    function onPhoneOut(ev) {
      const t = ev.target; if (!t || t.id !== 'f-phone' || !S.flow || !intl() || hasSlotLock()) return;   // frame 10b: never rewrites the fixed phone
      if (/^\s*(\+|00)/.test(String(t.value || '')) && !phoneMod().parseE164(String(t.value).trim().replace(/^00/, '+'))) { t.value = ''; S.flow.phone = ''; syncCta(); }
    }
    if (intl()) doc.addEventListener('focusout', onPhoneOut);
    if (!H && doc.defaultView) doc.defaultView.addEventListener('popstate', onPop);
    const unsubBack = H && typeof H.subscribe === 'function' ? H.subscribe(deviceBack) : null;
    render();
    if (mods() && !intakeOk()) { try { (doc.defaultView && doc.defaultView.console || console).error('capp: config error — intakeKey missing; placing disabled'); } catch (_) {} }
    // S2b: a hosted-checkout return (?pay=…)
    const search = opts.search != null ? String(opts.search) : (doc.defaultView && doc.defaultView.location ? doc.defaultView.location.search : '');
    const returning = /[?&]pay=/.test(search || '') ? handlePayReturn(search) : null;
    if (!returning) sdkResume();   // S2-checkout: a live SDK attempt ⇒ its status first
    return {
      cart, menu, render, state: S, openCheckout, returning,
      // D-2: the viewport crossed the breakpoint — re-render THIS screen in the other view; every piece of state (cart, screen, flow,
      // open layer, locks, refusals) lives in S / the records and is untouched; render() keeps focus, caret and the checkout scroll
      // Codex D-2 r1 #1: the store's menu scroll is kept, and a focused control that has no twin in the other view lands on its
      // VISIBLE equivalent — the aside ⇄ the cart bar (render() itself restores every control that exists in both views)
      // D-4a §4: the ONE URL-driven entry into a step — never a placement, never a BROWSER history entry (in-app steps count as a
      // tap's). 'pago': the lock FIRST (every lockedHere case ⇒ recoverLocked, status only), else the «Ir al checkout» tap path
      resumeTo(step, dish) {
        if (dead || S.screen !== 'store') return false;
        if (step === 'pedido') { if (!cart.count()) return false; openLayer('cart'); return true; }
        if (step === 'plato') { if (dish == null || !find(String(dish))) return false; openDetail(String(dish)); return true; }
        if (step === 'pago') { if (lockedNow()) { recoverLocked(); return true; } if (!cart.count()) return false; return checkoutTap(); }
        return step === 'store';
      },
      lockedNow: () => !dead && lockedNow(),
      route: () => routeNow(),
      setView(desk) {
        if (dead || !view) return; const d = desk === true; if (d === S.desk) return;
        const sc = $('scroller'), y = sc ? sc.scrollTop : null, ae = doc.activeElement;
        const fromAside = !!(ae && ae.closest && ae.closest('.deskcart')), fromPill = !!(ae && ae.id === 'cart-bar');
        S.desk = d; render();
        const sc2 = $('scroller'); if (sc2 && y !== null) sc2.scrollTop = y;
        if (S.open && lost()) focusTo((d && $('detail-name')) || $('detail-close'));   // Codex C-6c r1 #2: the heading is gone ⇒ the sheet's ✕
        if (lost() && !dialogEl()) {
          if (!d && fromAside) focusTo($('cart-bar'));
          else if (d && fromPill) { const a = app.querySelector('.deskcart'); focusTo(a && ([...a.querySelectorAll('button:not([disabled])')].find(reachable) || a)); }
        }
      },
      deviceBack,
      // the host's AUTHORITATIVE availability has been re-read (its Set / function now reflects it): a dispatch refusal yields to it
      availabilityUpdated() { if (dead) return; refused.clear(); render(); },
      // S7a-2: the verified menu arrived — the ordering controls turn live IN PLACE (no re-render: boxes, scroll and focus unchanged)
      setOrderable(on) {
        if (dead) return; orderable = on === true;
        if (!orderable) { applyOrderable(); return; }
        for (const el of app.querySelectorAll('[data-ord]')) { el.disabled = false; el.removeAttribute('aria-disabled'); delete el.dataset.ord; }
      },
      orderable: () => orderable,
      // PLAN-capp-store-promo-feeinfo r0: the host's auth tri-state moved — the store header's pill and fee line update IN PLACE
      // (no store re-render: an open sheet, the scroll and focus stay); a reserved pill becomes the guest's without a reflow
      authChanged() { if (!dead) patchAuth(); },
      openCart() { if (dead || S.screen !== 'store') return false; openLayer('cart'); return true; },
      // the store round trip (Codex store-update r2 #1): back on a new build, an UNRESOLVED placement's verification is started
      // explicitly — the same status read «Ver estado del pedido» runs (recoverLocked); nothing locked ⇒ nothing to verify
      resumeVerification() { if (dead || !mods()) return false; const locked = frozenNow() || (typeof api.holdsLock === 'function' && api.holdsLock()); if (locked) frozenStatus(); return locked; },
      // G6 §4c: a sign-in on THIS checkout — the member's details fill «Tus datos» (name, phone, email; never over what the customer
      // typed differently), the step and the cart stay; the tender is the customer's (a guest's card stays card)
      setMember(m) {
        if (dead) return;
        const prevCtx = memberCtx;
        memberCtx = m && typeof m === 'object' ? m : null;
        if (!memberCtx) S.schedAfterSignin = false;
        const f = S.flow;
        if (!memberCtx && f && sched() && f.time === 'schedule' && !hasSlotLock()) { f.time = 'asap'; f.slot = null; }   // signed out ⇒ no scheduling (G=B)
        if (!memberCtx && f && cardOnlyGuest()) f.pay = 'online';   // Codex G7 r1 #1: a guest is card-only in the state, not only on screen
        if (f && memberCtx) {
          if (!String(f.name || '').trim() && memberCtx.name) f.name = String(memberCtx.name);
          let unread = false;
          if (!String(f.phone || '').trim() && memberCtx.phone) { if (intl()) unread = !setPhone(f, memberCtx.phone); else f.phone = String(memberCtx.phone); }
          if (!String(f.email || '').trim() && memberCtx.email) f.email = String(memberCtx.email);
          f.editWho = unread; S.emailRefused = false;   // an unreadable member number stays in edit (intl)
          if (S.schedAfterSignin && sched()) { f.time = 'schedule'; f.slot = null; }   // frame G: signed in ⇒ the picker opens
        }
        // Codex promo r1 #2: on the STORE page the production auth path (dropMember / applyMember → here) keeps the page — the same
        // admitted identity (none → none, the same uid) patches the header in place; a new one re-renders keeping scroll and focus
        if (S.screen === 'store') {
          if ((!prevCtx && !memberCtx) || (prevCtx && memberCtx && prevCtx.uid != null && prevCtx.uid === memberCtx.uid)) { patchAuth(); return; }
          const fd = descOf(doc.activeElement); renderStoreKeep(); const el = refind(fd); if (el && el !== doc.activeElement) el.focus({ preventScroll: true });
          return;
        }
        render();
      },
      // Codex s7a2 r1 #1: the cart AS IT IS IN MEMORY (the same shape onCartChange persists) — a remount carries this, never only the
      // stored copy, so a failed persistence can never lose an edit
      snapshot() { return core.snapshotFor(S.mode); },
      // S7a-2: a Buscar / Inicio dish result opens THAT dish's sheet on this store (P open-dish :2253) — false when it is not here
      openDetail(key) { if (dead || S.screen !== 'store' || !find(key)) return false; openDetail(key); return true; },
      restore(snapshot) {
        const rr = core.restore(snapshot);   // the ONE path (reconcile first; a purchased cart cleared, never restored)
        if (rr.blocked) return { blocked: true, step: rr.step };
        if (rr.cleared) { render(); return { cleared: true }; }
        if (rr.mode) { S.mode = rr.mode; if (S.flow && C) C.setMode(S.flow, S.mode); }
        const r = rr.hydrated; notifyCart(); S.cartNote = r.dropped || null; S.refusal = tooLong() ? FULL_CART : null; render(); if (S.refusal) toast(S.refusal); return r; },
      // «Volver a pedir»: replace the cart through the SAME restore path — refused exactly where the store refuses an edit (its lock /
      // freeze predicate), never over a cart mid-placement
      replaceCart(snapshot) { if (dead || lockedNow()) return { locked: true }; return this.restore(snapshot); },
      destroy() {
        dead = true; placingStop(); otpTickStop(); if (beatT !== null) { T_.clearTimeout(beatT); beatT = null; }
        S.layerKind = null; const L = $('layer'); if (L) L.innerHTML = '';
        for (const el of [...doc.querySelectorAll('.cq-sheet')]) el.remove();   // the ported «El precio cambió» sheet (capp-confirm-quote)
        if (typeof unTheme === 'function') { try { unTheme(); } catch (_) {} }
        doc.removeEventListener('click', onClick); doc.removeEventListener('input', onInput); doc.removeEventListener('keydown', onKey); doc.removeEventListener('focusout', onPhoneOut); if (!H && doc.defaultView) doc.defaultView.removeEventListener('popstate', onPop); if (typeof unsubBack === 'function') { try { unsubBack(); } catch (_) {} } },
    };
  }

  // PLAN-capp-signin-required r5.4 frame 7 (approved): the post-order ACCOUNT OFFER under «Pedido recibido» (the host draws that
  // screen). ONE benefit; the phone already verified (no second code: the signup grant), the email from the order and still editable;
  // a visible «Ahora no». Renders nothing without a live grant. Actions are host events: 'offer-create' (redeem the grant: the
  // signup flow, G6) and 'offer-skip'.
  function accountOfferHtml(o) {
    const g = o && o.grant, t = o && typeof o.now === 'number' ? o.now : Date.now();
    if (!g || typeof g.token !== 'string' || !g.token || !Number.isFinite(g.expires_at) || t >= g.expires_at) return '';
    return `<div class="guestcard offer"><div class="sg">
      <div class="h1">Guardá tus datos para la próxima</div><p class="sub">La próxima vez pedís sin escribir nada ni esperar un código.</p>
      <div class="ml">WhatsApp</div><input class="inp" id="offer-phone" value="${esc(o.phone || '')}" readonly aria-label="WhatsApp"><span class="badge">${IC.check} Tu número ya está confirmado.</span>
      <div class="ml">Correo</div><input class="inp" id="offer-email" type="email" value="${esc(o.email || '')}" autocomplete="email" aria-label="Correo">
      <button class="cta" type="button" data-act="offer-create">Crear mi cuenta</button><button class="lnk" type="button" data-act="offer-skip">Ahora no</button></div></div>`;
  }

  return { mount, viewSections, loadMapsFor, MAP_SVG, FULL_CART, accountOfferHtml, errSheetHtml, createCartCore, apiConfigOf };
});
