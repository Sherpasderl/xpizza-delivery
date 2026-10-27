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
  const FULL_CART = 'Tu carrito está lleno. Empezá otro carrito con el resto de tu pedido.';   // owner-approved 2026-10-24 (cart_text_too_long)

  // ── icons (the prototype's, one stroke, one weight) ──
  const I = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const IC = {
    close: I('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'), search: I('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
    menu: I('<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h10"/>'), check: I('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    bag: I('<path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'), clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    info: I('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'), alert: I('<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>'),
    bike: I('<circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M8.5 17h7"/><path d="M14 6h3l2.5 8.5"/><path d="M4 11h7l2 6"/>'),
    // S2b (the prototype's IC, verbatim)
    back: I('<path d="M19 12H5"/><path d="M11 18l-6-6 6-6"/>'), chev: I('<path d="M9 6l6 6-6 6"/>'), down: I('<path d="M6 9l6 6 6-6"/>'),
    plus: I('<path d="M12 5v14"/><path d="M5 12h14"/>'), home: I('<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/>'),
    user: I('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'), pin: I('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.6"/>'),
    pinfill: '<svg width="38" height="38" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/></svg>',
    store: I('<path d="M4 9.5V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9.5"/><path d="M2.5 9.5 4.1 4a1 1 0 0 1 1-.7h13.8a1 1 0 0 1 1 .7l1.6 5.5a2.5 2.5 0 0 1-4.8 1.2 2.5 2.5 0 0 1-4.8 0 2.5 2.5 0 0 1-4.8 0 2.5 2.5 0 0 1-4.8-1.2Z"/><path d="M9 21v-5h6v5"/>'),
    card: I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>'), cash: I('<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9h.01M18 15h.01"/>'),
    locoff: I('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><path d="M4 4l16 16"/>'),
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
  // the schematic map (prototype mapSvg :1796-1806, light theme; S1 ships no dark toggle) — the fallback when no Maps key is configured
  const MAP_SVG = (() => {
    const road = '#FFFFFF', minor = '#F4F6F1', park = '#DCE6D4', water = '#D6E4EA';
    return `<svg class="mapsvg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <rect x="62" y="56" width="30" height="26" rx="3" fill="${park}"/><path d="M-5 92 C 20 80, 40 96, 70 86 S 100 76, 110 84 L110 110 L-5 110 Z" fill="${water}"/>
    <g stroke="${minor}" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke">${[10, 34, 56, 78].map((y) => `<path d="M-5 ${y}H105"/>`).join('')}${[10, 36, 62, 86].map((x) => `<path d="M${x} -5V105"/>`).join('')}</g>
    <g stroke="${road}" stroke-width="3.4" stroke-linecap="round" fill="none">${[22, 50, 74].map((x) => `<path d="M${x} -5V105"/>`).join('')}${[22, 42, 64].map((y) => `<path d="M-5 ${y}H105"/>`).join('')}<path d="M-5 100 L45 60 L105 20"/></g></svg>`;
  })();
  // the «confirming» line on the approved «Enviando tu pedido…» screen (Q9, no sheet, no button)
  const CONFIRMING_HINT = 'Estamos confirmando tu pago con el banco.';
  const CART_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M1 1h3l2 11h11l2-7H6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9" cy="20" r="1.5" fill="currentColor"/><circle cx="17" cy="20" r="1.5" fill="currentColor"/></svg>';
  const TRASH = (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 3h12M5 3V2h4v1M2 3l1 9h6l1-9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  // the catalog's own marks (the prototype's priority + colours); the LABEL is the served one when the envelope carries badges
  const BADGE_PRIORITY = ['signature_special', 'chefs_pick', 'must_try', 'crowd_favourite'];
  const BADGE_FALLBACK = { signature_special: 'Especial de la casa', chefs_pick: 'Selección del chef', must_try: 'Imperdible', crowd_favourite: 'Favorito' };

  function mount(doc, opts) {
    const CappMenu = opts.CappMenu || (typeof self !== 'undefined' && self.CappMenu) || require('./capp-menu.js');
    const CappCart = opts.CappCart || (typeof self !== 'undefined' && self.CappCart) || require('./capp-cart.js');
    const CappSerialize = opts.CappSerialize || (typeof self !== 'undefined' && self.CappSerialize) || require('./capp-serialize.js');
    const menu = CappMenu.adaptMenu(opts.envelope);
    const cfg = opts.config || {};
    const unavailable = opts.unavailable || new Set();
    const soldOf = (key) => { try { return typeof unavailable === 'function' ? !!unavailable(key) : unavailable.has(key); } catch (_) { return false; } };
    const now = opts.now || (() => new Date());
    let dead = false;   // S2b r1 P2-3: destroy() ⇒ every later callback of this instance is a no-op
    const emit = (name, detail) => { if (dead) return; try { (opts.onEvent || (() => {}))(name, detail); } catch (_) {} };
    // S7a-1 (PLAN-capp-S7a r2 §1.6): the shell's per-store cart persistence hook — after a SUCCESSFUL mutation, a restore and a
    // delivery/pickup change; a throwing hook never affects the UI; absent ⇒ nothing is called
    const notifyCart = () => { if (dead || typeof opts.onCartChange !== 'function' || frozenNow()) return; try { opts.onCartChange({ ...cart.snapshot(), rid: cfg.restaurantId, mode: S.mode }); } catch (_) {} };
    const cart = CappCart.createCart(menu);
    const $ = (id) => doc.getElementById(id);
    const app = $('app');
    const S = { mode: 'delivery', expanded: new Set(), open: null, layerKind: null, cartNote: null, refusal: null, activeSec: '', searchQ: '', entry: cfg.entry === 'app' ? 'app' : 'link',
      // S2b
      screen: 'store', stack: [], flow: null, q: null, qKey: null, askedKey: null, outZone: false, closedRefused: false, geo: null, err: null, tipDraft: '',
      backScreen: null, sendHint: null, sendTotals: null, pinDraft: null, pinToast: false, pinStepOk: false, lastDelivery: null };

    // ── the view model: the served menu as the prototype's item shape ──
    const photo = (d) => (d && d.img && cfg.assetBase ? cfg.assetBase.replace(/\/?$/, '/') + String(d.img).replace(/^\.?\//, '') : '');
    const exOf = (k) => menu.extrasFor(k).filter((e) => e.supported).map((e) => e.key);
    const EX = {}; for (const e of menu.extras) EX[e.key] = { n: e.name, p: e.price, c: e.cat, max: 1 };
    const itemOf = (d) => {
      const g = menu.groups[d.key];
      const it = { id: d.key, n: d.name, d: d.desc, p: d.price, img: photo(d), hero: photo(d), tags: d.tags || [], ex: exOf(d.key), cat: d.cat };
      if (g) it.group = { label: g.label, choices: g.choices.map((ck) => { const c = menu.dish(ck); return { id: c.key, choice: c.choice || c.name, p: c.price, n: c.name, ex: exOf(c.key) }; }) };
      return it;
    };
    const sections = menu.categories.map((c) => {
      const cid = String(c.id);
      const items = menu.dishes.filter((d) => String(d.cat) === cid && !d.variantOf).map(itemOf);
      const pick = menu.pickupOnlyCats.has(cid), wknd = menu.weekendOnlyCats.has(cid);
      return { id: cid, name: c.name != null ? c.name : cid, items, pickupOnly: pick, note: pick && wknd ? 'Solo viernes a domingo · para recoger' : '' };
    }).filter((s) => s.items.length);
    const find = (id) => { for (const s of sections) for (const it of s.items) { if (it.id === id) return it; if (it.group) for (const c of it.group.choices) if (c.id === id) return { ...c, d: it.d, img: it.img, hero: it.hero, tags: [], parent: it }; } return null; };
    const isSold = (it) => !!it && (soldOf(it.id) || (it.parent ? soldOf(it.parent.id) : false) || (it.group ? it.group.choices.every((c) => soldOf(c.id)) : false));
    const unit = cfg.unit && cfg.unit.length === 2 ? cfg.unit : ['plato', 'platos'];
    const unitOf = (n) => n + ' ' + (n === 1 ? unit[0] : unit[1]);
    const badgeOf = (it) => { const k = BADGE_PRIORITY.find((t) => (it.tags || []).includes(t)); if (!k) return null; const served = menu.badges && menu.badges[k] && menu.badges[k].label; return { text: served || BADGE_FALLBACK[k], color: k === 'must_try' || k === 'crowd_favourite' ? 'var(--acc)' : 'var(--price)' }; };

    // ── hours (the store config's, on the injected clock) ──
    const clock = () => { const d = now(); return { min: d.getHours() * 60 + d.getMinutes(), day: d.getDay() }; };
    const range = (day) => { const h = cfg.hours && cfg.hours[day]; return h ? [h[0] * 60 + h[1], h[2] * 60 + h[3]] : null; };
    const isOpen = () => { const c = clock(), o = range(c.day); return !!o && c.min >= o[0] && c.min < o[1]; };
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
    function frozenNow() {
      if (!(cfg.cartKey && cfg.placedKey)) return false;
      if (!mods() || !api.hosted) return true;
      const rc = api.reconcile(); if (!rc.ok) return true;
      return api.cartFreeze().frozen === true;
    }
    function mutate(fn) {
      if (frozenNow()) return false;
      const before = cart.snapshot();
      try { fn(); } catch (_) { return false; }
      if (cart.count()) {
        try { CappSerialize.serialize(cart, menu); } catch (e) {
          if (e && e.code === 'cart_text_too_long') { cart.hydrate(before); S.refusal = FULL_CART; showRefusal(); return false; }
        }
      }
      S.refusal = null;
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
      const n = qtyAll(it), exp = S.expanded.has(it.id), id = esc(it.id), launcher = !!it.group;
      return `<div class="qty-overlay" data-stop="1">
    <div class="qty-controls${n > 0 && exp ? ' visible' : ''}"><button class="qty-ctrl-btn" data-act="dec" data-id="${id}" aria-label="${launcher ? 'Ver tu pedido' : 'Quitar uno'}">−</button><span class="qty-ctrl-num">${n}</span><button class="qty-ctrl-btn" data-act="inc" data-id="${id}" aria-label="${launcher ? 'Agregar otra' : 'Agregar uno'}">+</button></div>
    <div class="qty-badge" style="display:${n > 0 && !exp ? 'flex' : 'none'}" data-act="badge" data-id="${id}" role="button" tabindex="0" aria-label="${n} en tu pedido"><span>${n > 0 ? n : 1}</span></div>
    <button class="qty-add-btn"${n > 0 ? ' style="display:none"' : ''} data-act="${launcher ? 'open' : 'inc'}" data-id="${id}" aria-label="${launcher ? 'Personalizar' : 'Agregar ' + esc(it.n)}">+</button></div>`;
    }
    function rowHtml(it) {
      const b = badgeOf(it), sold = isSold(it) ? '<span class="mark" style="color:var(--mute)">Agotado</span>' : '';
      const label = b ? `<span class="mark" style="color:${b.color}">${esc(b.text)}</span>` : '';
      const marks = sold || label ? `<span class="marks">${sold}${label}</span>` : '';
      const price = it.group ? 'desde ' + money(Math.min(...it.group.choices.map((c) => c.p))) : money(it.p);
      const open = `data-act="open" data-id="${esc(it.id)}"`;
      return `<div class="row${isSold(it) ? ' sold-out' : ''}" id="dish-${esc(it.id)}"><button class="txtbtn" ${open}>${marks}<span class="nm">${esc(it.n)}</span>${it.d ? `<span class="ds">${esc(it.d)}</span>` : ''}<span class="prrow"><span class="pr">${esc(price)}</span></span></button>
    ${it.img ? `<div class="thumb"><button class="openimg" ${open} aria-label="Ver ${esc(it.n)}" tabindex="-1"><img src="${esc(it.img)}" alt="" loading="lazy"></button>${overlayHtml(it)}</div>` : `<div class="ovl-inline">${overlayHtml(it)}</div>`}</div>`;
    }
    function storeHtml() {
      const mode = S.mode, open = isOpen();
      const house = sections.flatMap((s) => s.items).filter((x) => x.img && (x.tags || []).some((t) => ['signature_special', 'chefs_pick', 'must_try'].includes(t))).slice(0, 5);
      const feeTxt = cfg.feeFromCents != null ? `<span>· Envío desde ${money(cfg.feeFromCents / 100)}</span>` : '';
      const facts = open
        ? `<span class="full"><span class="dot"></span><strong>Abierto</strong> · cierra ${esc(closesText())}</span>` + (mode === 'delivery'
          ? `${etaTxt('delivery') ? `<span>${esc(etaTxt('delivery'))}</span>` : ''}${feeTxt}`
          : `${etaTxt('pickup') ? `<span>${esc(etaTxt('pickup'))}</span>` : ''}${cfg.addr ? `<span class="mute full">Recogé en ${esc(cfg.addr)}</span>` : ''}`)
        : `<span class="full"><span class="dot off"></span><strong>Cerrado</strong> · ${esc(opensText())}</span>`;
      const fs = !open ? firstSlot() : null;
      const dayWord = (off) => (off === 0 ? 'hoy' : off === 1 ? 'mañana' : DAYS[(clock().day + off) % 7]);
      const closednote = !open ? `<div class="closednote">${IC.clock}<span>${fs ? `Podés programar un pedido para ${esc(dayWord(fs.off))}, desde las ${esc(fmtMin(fs.t))}` : 'Sin horarios disponibles · ' + esc(opensText()).toLowerCase()}</span>${fs ? '<button class="lnk" data-act="closed-sched">Programar</button>' : ''}</div>` : '';
      const avatar = cfg.logo ? `<div class="avatar${cfg.logoWide ? ' wide' : ''}"><img src="${esc(cfg.logo)}" alt="${esc(cfg.name)}"></div>` : `<div class="avatar txt" aria-hidden="true">${esc(String(cfg.name || '').split(' ').map((x) => x[0]).join('').slice(0, 2))}</div>`;
      let content = house.length ? `<section class="toprow" aria-label="La casa recomienda"><h2>La casa recomienda</h2><div class="cards">${house.map((it) => `<div class="card"><div class="ph"><button class="openimg" data-act="open" data-id="${esc(it.id)}" aria-label="Ver ${esc(it.n)}" tabindex="-1" style="border-radius:14px"><img src="${esc(it.img)}" alt="" loading="lazy"></button>${overlayHtml(it)}</div><button class="txtbtn" data-act="open" data-id="${esc(it.id)}"><span class="nm">${esc(it.n)}</span><span class="prrow"><span class="mute" style="font-size:14px">${money(it.p)}</span></span></button></div>`).join('')}</div></section>` : '';
      for (const s of sections) content += `<section class="sec" id="sec-${esc(s.id)}" data-sec="${esc(s.id)}"><div class="sechead"><h2>${esc(s.name)}</h2><span>${esc(s.items.length + (s.items.length === 1 ? ' plato' : ' platos'))}</span></div>${s.note ? `<div class="secnote">${esc(s.note)}</div>` : ''}${s.pickupOnly && mode === 'delivery' ? '<div class="secflag">Solo para Pickup · cambiá a Pickup arriba para pedirlas</div>' : ''}<div>${s.items.map(rowHtml).join('')}</div></section>`;
      const n = cart.count();
      const pill = `<button class="cart-bar" id="cart-bar" data-act="pill" aria-label="Tu pedido"><span class="cart-icon">${CART_ICON}</span><span class="cart-pill-text">${n ? unitOf(n) : 'Tu pedido'}</span><span class="cart-pill-dot">·</span><span class="cart-pill-text">${money(cartTotal())}</span></button>`;
      const nav = `<div class="store-nav">${S.entry === 'app' ? `<button class="iconbtn" data-act="back" aria-label="Cerrar">${IC.close}</button>` : '<span></span>'}<span></span></div>`;
      const hero = cfg.hero ? `<img class="hero" id="hero" src="${esc(cfg.hero)}" alt="">` : '<div class="hero" id="hero"></div>';
      const scroller = `<div class="scroller" id="scroller">${nav}<header id="top">${hero}<div class="info"><div class="idrow">${avatar}<div class="idtxt"><h1 class="brandname">${esc(cfg.name || '')}</h1>${cfg.kicker ? `<div class="kicker">${esc(cfg.kicker)}</div>` : ''}</div></div><div class="facts">${facts}</div>${closednote}
      <div class="seg" role="group" aria-label="Tipo de pedido"><button aria-pressed="${mode === 'delivery'}" data-act="mode" data-val="delivery">${IC.bike}Delivery</button><button aria-pressed="${mode === 'pickup'}" data-act="mode" data-val="pickup">${IC.bag}Pickup</button></div></div></header>
    <div class="stick" id="stick"><div class="slim">${S.entry === 'app' ? `<button class="iconbtn" data-act="back" aria-label="Cerrar">${IC.close}</button>` : '<span class="sp"></span>'}<b>${esc(cfg.name || '')}</b><button class="iconbtn" data-act="ssearch" aria-label="Buscar en el menú">${IC.search}</button></div>
      <div class="tabsbar"><button class="iconbtn" data-act="menu" aria-label="Ver todo el menú">${IC.menu}</button><nav class="tabs" id="tabs" aria-label="Categorías">${sections.map((s, i) => `<button class="tab" data-act="jump" data-jump="${esc(s.id)}" aria-current="${i === 0}">${esc(s.name)}</button>`).join('')}</nav>${S.entry === 'app' ? '' : `<button class="iconbtn" data-act="ssearch" aria-label="Buscar en el menú">${IC.search}</button>`}</div></div>
    <main class="content" id="content">${content}</main></div>`;
      return `<div class="storewrap">${scroller}</div>${pill}`;
    }
    let sectionEls = [];
    function wireStore() {
      const sc = $('scroller'); if (!sc) return;
      sectionEls = [...sc.querySelectorAll('.sec')];
      let lastActive = '';
      const onScroll = () => {
        if (!sc.isConnected || !$('top') || !$('stick')) return;
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
    function jumpTo(id) { const el = $('sec-' + id), sc = $('scroller'); if (!el || !sc) return; const extra = $('stick').classList.contains('collapsed') ? 0 : 56; if (sc.scrollTo) sc.scrollTo({ top: el.offsetTop - ($('stick').offsetHeight + extra) + 8, behavior: 'smooth' }); }
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
    function syncInert() {
      const dlg = !!(S.open || S.layerKind);
      setInert(screenEl(), dlg);
      const pill = $('cart-bar'); if (pill) setInert(pill, dlg);
      setInert($('detail-modal'), !S.open);
      const L = $('layer'); if (L) setInert(L, !!S.open || !S.layerKind);
    }

    // ── ITEM SHEET (per-instance extras; S1: toggles) ──
    const detailSkeleton = () => `<div class="detail-overlay" id="detail-overlay" data-act="dclose"></div><div class="detail-modal" id="detail-modal" aria-hidden="true" role="dialog" aria-labelledby="detail-header-title"><div class="detail-drag-handle" aria-hidden="true"></div><div class="detail-header"><button class="detail-close" id="detail-close" data-act="dclose" aria-label="Cerrar">${IC.close}</button><div class="detail-header-title" id="detail-header-title"></div><div class="detail-header-spacer"></div></div><div class="detail-scroll" id="detail-scroll"></div><div class="detail-cta-bar"><div class="detail-step" id="detail-step" role="group" aria-label="Cantidad"></div><button class="detail-cta" id="detail-cta" data-act="dcta"></button></div></div>`;
    const extrasByCat = (ids) => { const out = []; for (const id of ids) { const e = EX[id]; if (!e) continue; let g = out.find((x) => x.cat === e.c); if (!g) out.push(g = { cat: e.c, list: [] }); g.list.push({ id, ...e }); } return out; };
    const instTotal = (inst) => Object.keys(inst || {}).reduce((a, k) => a + (EX[k] ? EX[k].p : 0), 0);
    function openDetail(id) { const it = find(id); if (!it) return; S.open = it.group ? { id, kind: 'launcher', staged: { choice: null, ex: {}, qty: 1 } } : { id, kind: 'dish', staged: { qty: 1 } }; openDetailDom(); }
    function openEdit(key, g = '') { const l = cart.lines().find((x) => x.key === key); if (!l) return; const it = find(key); const n = l.ex.filter((inst) => CappCart.sigOf(inst) === g).length; S.open = { id: it.parent ? it.parent.id : it.id, kind: 'edit', key, g, n, staged: { choice: it.parent ? it.id : null, ex: Object.fromEntries(g ? g.split(',').map((k) => [k, 1]) : []) } }; openDetailDom(); }
    function openDetailDom() { if (!S.open) return; returnTo = returnTo || descOf(doc.activeElement); renderDetail(); $('detail-overlay').classList.add('open'); $('detail-modal').classList.add('open'); syncInert(); focusTo($('detail-close')); }
    function closeDetail() { $('detail-overlay').classList.remove('open'); $('detail-modal').classList.remove('open'); S.open = null; S.refusal = null; renderStoreKeep(); syncInert(); const back = refind(returnTo); returnTo = null; focusTo(back || $('cart-bar')); }
    function extraRow(e, q, act, attrs) {
      const sel = q > 0;
      return `<div class="detail-extras-row" data-act="${act}" ${attrs} role="checkbox" aria-checked="${sel}" tabindex="0"><span class="xrow-main"><span class="detail-extras-name">${esc(e.n)}</span><span class="xrow-price">+${money(e.p)}</span></span><div class="detail-extras-toggle ${sel ? 'selected' : ''}">${IC.check.replace('class="i"', '')}</div></div>`;
    }
    function renderDetail() { renderDetailBody(); if (detailHad && lost()) focusTo(refind(detailHad)); detailHad = null; }
    let detailHad = null;
    function renderDetailBody() {
      const o = S.open, it = find(o.id);
      $('detail-header-title').textContent = o.kind === 'edit' ? 'Editar' : it.n;
      const src = it.hero || it.img;
      let html = `<div class="detail-photo${src ? '' : ' empty'}">${src ? `<img class="detail-photo-img" src="${esc(src)}" alt="${esc(it.n)}">` : ''}</div>`;
      const body = (price) => `<div class="detail-body"><div class="detail-name">${esc(it.n)}</div><div class="detail-price">${price}</div>${it.d ? `<div class="detail-desc">${esc(it.d)}</div>` : ''}</div>`;
      const groupLabel = (g) => `<div class="detail-cat-label"><span>${esc(g.label)}</span><span class="grp-status ${o.staged.choice ? 'done' : 'req'}">${o.staged.choice ? IC.check.replace('class="i"', '') + 'Requerido' : IC.alert.replace('class="i"', '') + 'Elegí 1 · Requerido'}</span></div>`;
      const variantRows = (g, min) => `<div class="detail-extras-list">${g.choices.map((c) => { const sel = o.staged.choice === c.id, delta = c.p - min > 0 ? c.p - min : null, off = soldOf(c.id); return `<div class="detail-variant-row${sel ? ' sel' : ''}${off ? ' sold-out' : ''}" data-act="variant" data-id="${esc(c.id)}" role="radio" aria-checked="${sel}"${off ? ' aria-disabled="true" style="opacity:.45"' : ''} tabindex="0"><div><span class="detail-extras-name">${esc(c.choice)}</span>${off ? '<span class="detail-extras-price">Agotado</span>' : delta !== null ? `<span class="detail-extras-price">+${money(delta)}</span>` : ''}</div><span class="detail-variant-radio"></span></div>`; }).join('')}</div>`;
      const optLabel = (cat) => `<div class="detail-cat-label"><span>${esc(cat)}</span><span class="grp-status optional">Opcional</span></div>`;
      const exOfChoice = () => { const c = o.staged.choice ? find(o.staged.choice) : null; return c ? c.ex : (it.group ? [] : it.ex); };
      if (o.kind === 'edit') {
        html += `<div class="detail-body"><div class="detail-name">${esc(it.n)}</div>${o.n > 1 ? `<div class="detail-desc">Se aplica a ${o.n === 2 ? 'las' : 'los'} ${o.n} ${unit[1]} de esta línea.</div>` : ''}</div>`;
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
      const keep = $('detail-scroll').scrollTop; $('detail-scroll').innerHTML = html; $('detail-scroll').scrollTop = keep;
      const step = $('detail-step'), cta = $('detail-cta'); cta.disabled = false; cta.className = 'detail-cta';
      const stepper = (n, minusOk) => `<button class="detail-step-btn" data-act="qty" data-delta="-1" aria-label="Quitar una"${minusOk ? '' : ' disabled'}>−</button><span class="detail-step-num" aria-live="polite">${n}</span><button class="detail-step-btn" data-act="qty" data-delta="1" aria-label="Agregar una">+</button>`;
      const label = (verb, amount) => `<span>${verb}</span><span class="detail-cta-divider">·</span><span>${money(amount)}</span>`;
      if (o.kind === 'edit') { step.hidden = true; step.innerHTML = ''; const base = o.staged.choice ? find(o.staged.choice).p : it.p; const target = o.staged.choice || o.key; if (editSold(o)) { cta.disabled = true; cta.innerHTML = '<span>Agotado</span>'; return; } cta.innerHTML = label('Guardar', o.n * (base + instTotal(o.staged.ex))); return; }
      step.hidden = false;
      if (o.kind === 'launcher') { const c = it.group.choices.find((x) => x.id === o.staged.choice), n = o.staged.qty || 1; step.innerHTML = stepper(n, n > 1); if (c && (soldOf(c.id) || soldOf(it.id))) { cta.disabled = true; cta.innerHTML = '<span>Agotado</span>'; return; } if (!c) { cta.disabled = true; cta.innerHTML = `<span>Elegí tu ${esc(it.group.label.toLowerCase())}</span>`; } else cta.innerHTML = label('Agregar', n * (c.p + instTotal(o.staged.ex))); return; }
      const q = qtyOf(it.id);
      if (isSold(it)) { step.innerHTML = stepper(o.staged.qty || 1, false); cta.disabled = true; cta.innerHTML = '<span>Agotado</span>'; return; }
      if (q === 0) { const n = o.staged.qty || 1; step.innerHTML = stepper(n, n > 1); cta.innerHTML = label('Agregar', n * it.p); }
      else { const lineSum = cart.groups().filter((g) => g.key === it.id).reduce((a, g) => a + g.total, 0); step.innerHTML = stepper(q, true); cta.innerHTML = label('Guardar', lineSum); }
    }
    function detailAct(t) {
      const o = S.open, it = find(o.id), act = t.dataset.act;
      if (act === 'qty') { const d = Number(t.dataset.delta); if (o.kind === 'launcher' || qtyOf(it.id) === 0) o.staged.qty = Math.max(1, (o.staged.qty || 1) + d); else { mutate(() => cart.setQty(it.id, qtyOf(it.id) + d)); if (!qtyOf(it.id)) o.staged.qty = 1; } }
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
    function syncPill() { const p = $('cart-bar'); if (!p) return; const n = cart.count(); p.querySelectorAll('.cart-pill-text')[0].textContent = n ? unitOf(n) : 'Tu pedido'; p.querySelectorAll('.cart-pill-text')[1].textContent = money(cartTotal()); }
    function bumpPill() { const p = $('cart-bar'); if (!p) return; p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump'); }

    // ── CART SHEET (Subtotal only in S1: the fee rows are S2/S3) ──
    const lineName = (d, cls) => (d.editable
      ? `<button class="lnedit ${cls}" data-act="edit" data-key="${esc(d.key)}" data-grp="${esc(d.g)}" aria-label="Editar ${esc(d.item.n)}"><span class="ln-n">${esc(d.item.n)}</span>${d.extras ? `<span class="ln-x">+ ${esc(d.extras)}</span>` : ''}<span class="ln-ed">Editar</span></button>`
      : `<div class="lnstatic ${cls}"><span class="ln-n">${esc(d.item.n)}</span>${d.extras ? `<span class="ln-x">+ ${esc(d.extras)}</span>` : ''}</div>`);
    const lineStep = (d) => `<div class="cstep"><button data-act="rev" data-rev="-1" data-key="${esc(d.key)}" data-grp="${esc(d.g)}" aria-label="Quitar uno de ${esc(d.item.n)}">${d.n <= 1 ? TRASH(14) : '−'}</button><span>${d.n}</span><button data-act="rev" data-rev="1" data-key="${esc(d.key)}" data-grp="${esc(d.g)}" aria-label="Agregar otro igual: ${esc(d.item.n)}">+</button></div>`;
    function cartInner() {
      const lines = displayLines(), mode = S.mode, total = cartTotal();
      const head = `<div class="sheethead"><div><h2>Tu pedido</h2><small>${lines.length ? unitOf(cart.count()) + ' · ' : ''}${mode === 'delivery' ? 'Delivery' : 'Pickup'}</small></div><button class="iconbtn" data-act="cartclose" aria-label="Cerrar el carrito">${IC.close}</button></div>`;
      const note = S.cartNote ? `<div class="cartnote">${IC.info}<span>${S.cartNote === 1 ? '1 plato ya no está disponible' : S.cartNote + ' platos ya no están disponibles'}</span></div>` : '';
      const over = tooLong();
      const refusal = S.refusal || over ? `<div class="cartnote">${IC.info}<span>${esc(over ? FULL_CART : S.refusal)}</span></div>` : '';
      if (!lines.length) return head + note + `<div class="empty">${IC.bag}<span>Tu pedido está vacío.</span><button class="btn2" data-act="cartclose">Ver el menú</button></div>`;
      return head + note + refusal + lines.map((d) => `<div class="cline">${lineName(d, 'cl-txt')}${lineStep(d)}<span class="cl-p">${money(d.total)}</span></div>`).join('')
        + `<div class="ctot"><div class="sumrow"><span>Subtotal</span><span>${money(total)}</span></div></div>`
        + `<div class="sheetbar"><button class="primary" data-act="checkout"${over ? ' disabled aria-disabled="true"' : ''}>Ir al checkout</button></div>`;
    }
    function runStoreSearch(q) {
      const box = $('sresults'); if (!box) return;
      const nq = norm(q).trim(); const hits = nq ? sections.flatMap((s) => s.items).filter((it) => norm(it.n + ' ' + (it.d || '')).includes(nq)) : [];
      box.innerHTML = !nq ? '' : hits.length ? `<div class="rcount">${hits.length} resultado${hits.length === 1 ? '' : 's'}</div>${hits.map(rowHtml).join('')}` : `<div class="noresults">Nada con «${esc(q)}». Probá otra palabra.</div>`;
    }
    function openLayer(kind) { if (kind === 'cart' && S.layerKind !== 'cart') pushHist(); returnTo = descOf(doc.activeElement); S.layerKind = kind; renderLayer(true); }   // the cart is a back step (P openCart :1752)
    function closeLayer() { if (S.layerKind === 'placing') placingStop(); if (S.layerKind === 'pin') dropPinMap(); S.layerKind = null; S.cartNote = null; S.refusal = null; S.err = null; renderLayer(); const back = refind(returnTo); returnTo = null; focusTo(back || $('cart-bar') || $('cta')); closeLayerThen(); }
    // a quote that failed while another layer was open: its sheet once that layer closes (still the same failed state)
    function closeLayerThen() { if (S.quoteErrSheet && !S.layerKind && (S.screen === 'checkout' || S.screen === 'tip')) { S.quoteErrSheet = false; if (S.quoteErr && S.quoteErr === stateKey()) showErr(ERR.generic('err-requote')); } }
    function renderLayer(fresh) {
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
      else if (k === 'placing') L.innerHTML = placingHtml();
      else if (k === 'tipother') L.innerHTML = tipOtherHtml();
      else if (k === 'pin') L.innerHTML = pinStepHtml();
      else if (k === 'feeinfo') L.innerHTML = feeInfoHtml();
      syncInert();
      if (fresh) { const first = k === 'ssearch' ? $('sq') : L.querySelector(FOCUSABLE); focusTo(first); }
      else if (keep && lost()) focusTo(refind(keep));
      if (k === 'pin') wireMaps();
    }

    // ═══ S2b: CHECKOUT ═══
    const T_ = opts.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h), setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h) };
    const navTo = opts.navigate || ((url) => { doc.defaultView.location.assign(url); });
    const navigate = (url) => { if (!dead) navTo(url); };
    // the order-intake key (per-brand config, data only; never logged): createOrder / chargeOnlineOrder require it (index.js:750-760,
    // :1469-1479). Missing ⇒ the app sends nothing: a config error at boot and «Hacer pedido» stays disabled (fail closed)
    const intakeOk = () => typeof cfg.intakeKey === 'string' && cfg.intakeKey !== '';
    const intakeHeaders = () => ({ Authorization: 'Bearer ' + cfg.intakeKey });
    const member = () => opts.member || null;
    // the modules are resolved LAZILY (the S1 host may load the page without them): no modules ⇒ the store keeps S1's host event
    let C = null, api = null;
    function mods() {
      if (C && api) return true;
      try {
        C = opts.CappCheckout || (typeof self !== 'undefined' && self.CappCheckout) || require('./capp-checkout.js');
        const A = opts.CappApi || (typeof self !== 'undefined' && self.CappApi) || require('./capp-api.js');
        api = opts.api || A.createApi({ config: { restaurantId: cfg.restaurantId, orderIdPrefix: cfg.orderIdPrefix, pendingPayKey: cfg.pendingPayKey, endpoints: cfg.endpoints, hours: cfg.hours,
          cartKey: cfg.cartKey, placedKey: cfg.placedKey },   // S7a-1: hosted by the shell (both absent ⇒ the S2 path, unchanged)
          CappCheckout: C, member, ...(opts.apiOpts || {}) });
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
    function ctxBase() { const s = CappSerialize.serialize(cart, menu); return { restaurantId: cfg.restaurantId, items: s.items, itemsText: s.items_text, member: member() }; }
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
    const gateCtx = () => ({ open: isOpen(), closedRefused: S.closedRefused, pickupOnlyCount: poLines().length, outZone: S.outZone, member: member() });
    const need = () => C.missingStep(S.flow, gateCtx());
    function ctaLabel(T) {
      const n = need(); if (n) return n;
      if (S.flow.mode === 'delivery') return 'Continuar';   // delivery continues to the tip step
      const amt = T.ready ? ' · ' + moneyC(T.total) : '';   // pickup places from here (no tip); no amount until the quote is ready
      return S.flow.pay === 'online' ? 'Pagar' + amt : 'Confirmar pedido' + amt;
    }
    const ctaOff = (T) => !!need() || (S.flow.mode !== 'delivery' && (!T.ready || !intakeOk()));   // pickup places from here
    function syncCta() { const b = $('cta'); if (!b || !S.flow) return; const T = totalsNow(); b.disabled = ctaOff(T); b.textContent = ctaLabel(T); }

    // ── the map: the drawn chrome; a real Google map inside it when a key is configured, else the schematic SVG ──
    let mapsP = null;
    function loadMaps() {
      if (!cfg.mapsKey) return null;
      const w = doc.defaultView; if (!w) return null;
      if (w.google && w.google.maps && w.google.maps.Map) return Promise.resolve(w.google.maps);
      if (mapsP) return mapsP;
      mapsP = new Promise((resolve, reject) => {
        w.__cappMapsReady = () => resolve(w.google.maps);
        const s = doc.createElement('script'); s.async = true;
        s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(cfg.mapsKey) + '&loading=async&callback=__cappMapsReady';
        s.onerror = () => { mapsP = null; reject(new Error('maps_load_failed')); };
        doc.head.appendChild(s);
      });
      return mapsP;
    }
    const mapCenter = () => { const p = S.pinDraft || (S.flow && S.flow.pin); return finitePin(p) ? { lat: p.lat, lng: p.lng } : (cfg.loc && finitePin(cfg.loc) ? { lat: cfg.loc.lat, lng: cfg.loc.lng } : null); };
    const gmapBox = (kind) => (cfg.mapsKey ? `<div class="gmap" data-gmap="${kind}" style="position:absolute;inset:0"></div>` : '');   // TODO(owner ruling): style the live map; S2b keeps the drawn chrome on top
    let pinGen = 0, pinMap = null;   // S2b r1 P1-2: the ACTIVE pin map; an obsolete instance's callbacks are dropped
    // the pin step closing — «Listo», «Cancelar», device back — makes its map obsolete: a late idle never reaches the checkout
    function dropPinMap() { pinGen++; pinMap = null; S.pinDraft = null; }
    function wireMaps() {
      const els = [...app.querySelectorAll('[data-gmap]')]; if (!els.length) return;
      const p = loadMaps(); if (!p) return;
      p.then((gm) => {
        for (const el of els) {
          const c = mapCenter(); if (!el.isConnected || el.__map || !c) continue;
          const big = el.dataset.gmap === 'pin';
          const m = new gm.Map(el, { center: c, zoom: 17, disableDefaultUI: true, clickableIcons: false, gestureHandling: big ? 'greedy' : 'none', keyboardShortcuts: big });
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
    // the device location (unconfirmed until «Listo»); denied / unavailable ⇒ the drawn «Ubicación desactivada» row
    const geoApi = () => (opts.geolocation !== undefined ? opts.geolocation : (doc.defaultView && doc.defaultView.navigator && doc.defaultView.navigator.geolocation) || null);
    function requestGeo() {
      const g = geoApi(); const f = S.flow;
      const denied = () => { S.geo = 'denied'; if (!finitePin(f.pin) && cfg.loc && finitePin(cfg.loc)) C.setPin(f, cfg.loc.lat, cfg.loc.lng, false); if (S.screen === 'checkout') render(); };
      if (!g || typeof g.getCurrentPosition !== 'function') { denied(); return; }
      try {
        // OWNER 2026-10-21 (DECISIONS:2072): a DETECTED fix is a real location ⇒ the pin is CONFIRMED in the model (the body's
        // pin_confirmed:true is the device's truth); only a denied / failed / fallback location must be confirmed on the pin step
        g.getCurrentPosition((pos) => { S.geo = 'ok'; if (!(f.pin && f.pin.confirmed)) C.setPin(f, pos.coords.latitude, pos.coords.longitude, true); if (S.screen === 'checkout') render(); }, denied, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
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
    function checkoutHtml() {
      const f = S.flow, del = f.mode === 'delivery', m = member(), open = isOpen(), po = poLines(), T = totalsNow();
      const poNames = [...new Set(po.map((l) => { const s = sectionOfKey(l.key); return s ? s.name : l.key; }))].join(', ');
      const geoDenied = S.geo === 'denied' && !m;
      const pinOk = S.pinStepOk === true;   // the drawn «Pin confirmado» = confirmed ON THE PIN STEP (P f.pinOk), not a detected fix
      const chev = IC.chev.replace('class="i"', 'class="i chev"');
      const zoneKm = (S.lastDelivery && Number.isFinite(S.lastDelivery.max_km) ? S.lastDelivery.max_km : cfg.zoneKm);
      // Entrega — ASAP only (scheduling, the «Programar» card, is S4)
      const timeCards = `<div class="opts"><button class="opt" aria-pressed="${open}" data-act="time" data-val="asap"${open ? '' : ' disabled'}><b>Lo antes posible</b><span>${open ? esc(etaTxt(del ? 'delivery' : 'pickup')) : 'No disponible · cerrado'}</span></button></div>`;
      const mapBlock = `<button class="map${S.outZone && del ? ' out' : ''}" data-act="pin" aria-label="Ajustar el pin en el mapa">${MAP_SVG}${gmapBox('preview')}<span class="pin">${IC.pinfill}</span><span class="tag">${geoDenied ? 'Pin en el restaurante' : pinOk ? 'Pin confirmado' : 'Tu ubicación'}</span><span class="adj">Ajustar pin</span></button>
    ${geoDenied ? `<div class="locrow">${IC.locoff}<span>Ubicación desactivada</span><button data-act="loc-on">Activar</button></div>` : ''}
    ${S.outZone && del ? `<div class="gate" role="alert"><b>${esc(cfg.name || '')} no llega a esta dirección</b><span class="note">${Number.isFinite(zoneKm) && cfg.branch ? `Entregamos hasta ${esc(zoneKm)} km de ${esc(cfg.branch)}. ` : ''}Mové el pin a una dirección dentro de la zona, o recogé en tienda.</span><div class="row2"><button class="btn2" data-act="pin">Cambiar dirección</button><button class="btn2 dark" data-act="type" data-val="pickup">Recoger en tienda</button></div></div>` : ''}`;
      // a guest's address line (S2b-geo, MOCKUP-capp-S2b-geo-address.html A1 / b / b2): the confirmed pin's reverse-geocode; c (none,
      // pending, superseded) keeps today's copy byte for byte
      const geoLine = C.addrLine(f);
      const addrRow = `<button class="urow" data-act="pin">${IC.pin}<span class="t"><b data-addr>${geoLine ? esc(geoLine) : geoDenied ? 'Mové el pin a tu puerta' : 'Tu ubicación'}</b><span>${pinOk ? 'Pin confirmado' : 'Ajustá el pin a tu dirección'}</span></span>${chev}</button>`;
      const detailsFld = `<div class="fld"><label for="f-details">Detalles adicionales <span class="req">*</span></label><input id="f-details" data-field="details" value="${esc(f.details)}" placeholder="Colonia, portón, piso, referencia…" autocomplete="off"></div>`;
      const detailsRow = m && !S.editDetails && (f.details || '').trim().length >= 3 ? `<div class="urow">${IC.home}<span class="t"><b>${esc(f.details)}</b><span>Detalles adicionales</span></span><button class="act" data-act="editdetails">Cambiar</button></div>` : '';
      const entrega = `<section class="fsec" aria-label="Entrega"><h2>Entrega</h2>
    <div class="seg" role="group" aria-label="Tipo de pedido"><button aria-pressed="${del}" data-act="type" data-val="delivery">Delivery</button><button aria-pressed="${!del}" data-act="type" data-val="pickup">Pickup</button></div>
    ${del && po.length ? `<div class="gate"><b>«${esc(poNames)}» es solo para Pickup</b><div class="row2"><button class="btn2" data-act="rm-po">Quitar del pedido</button><button class="btn2 dark" data-act="type" data-val="pickup">Cambiar a Pickup</button></div></div>` : ''}
    ${timeCards}
    ${del ? `${mapBlock}<div class="urows">${addrRow}${detailsRow}</div>${detailsRow ? '' : detailsFld}` : `<div class="urows"><div class="urow">${IC.store}<span class="t"><b>${storeLine()}</b><span>${esc(cfg.addr || '')}</span></span></div></div><div class="note">Te avisamos por WhatsApp cuando esté listo.</div>`}</section>`;
      // Tus datos — TODO(fiscal flag): «factura / » + the RTN fields render ONLY behind a server flag; no such config key exists yet
      const moreRow = `<button class="urow" data-act="more">${IC.plus}<span class="t"><b>Agregar email / notas</b></span>${chev}</button>`;
      const moreFields = `<div class="fld"><label for="f-email">Correo <span class="mute">(opcional · para tu recibo)</span></label><input id="f-email" data-field="email" type="email" value="${esc(f.email)}" placeholder="tu@correo.com" autocomplete="email"></div>
       <div class="fld"><label for="f-notes">Notas para el restaurante</label><textarea id="f-notes" data-field="notes" placeholder="Sin cebolla, extra salsa… (opcional)">${esc(f.notes)}</textarea></div>`;
      const datos = `<section class="fsec" aria-label="Tus datos"><h2>Tus datos</h2>
    ${m && !f.editWho ? `<div class="urows"><div class="urow">${IC.user}<span class="t"><b>${esc(m.name)}</b><span>${esc(C.fullPhone(m.phone))}</span></span><button class="act" data-act="editwho">Cambiar</button></div>${S.more ? '' : moreRow}</div>`
      : `<div class="fld"><label for="f-name">Nombre <span class="req">*</span></label><input id="f-name" data-field="name" value="${esc(f.name)}" placeholder="Tu nombre" autocomplete="name"></div>
         <div class="fld"><label for="f-phone">WhatsApp <span class="req">*</span></label><input id="f-phone" data-field="phone" type="tel" inputmode="numeric" value="${esc(f.phone)}" placeholder="+504 9999-9999" autocomplete="tel"></div>
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
      // Pago
      const payOpts = `<div class="optrow" role="radiogroup" aria-label="Forma de pago">
      <button class="opt" aria-pressed="${f.pay === 'online'}" data-act="pay" data-val="online"><span class="radio" aria-hidden="true"></span><span class="txt"><b>Pagar en línea<span class="rec">Recomendado</span></b><span>Con tarjeta, en la página segura de PixelPay (3D Secure).</span></span></button>
      <button class="opt" aria-pressed="${f.pay === 'cash'}" data-act="pay" data-val="cash"><span class="radio" aria-hidden="true"></span><span class="txt"><b>Efectivo ${del ? 'al entregar' : 'al recoger'}</b><span>${del ? 'Pagás cuando llegue tu pedido.' : 'Pagás en tienda al recoger.'}</span></span></button></div>`;
      const pago = `<section class="fsec" aria-label="Pago"><h2>Pago</h2>${m && f.pay && !S.showPay
        ? `<div class="urows"><div class="urow">${f.pay === 'cash' ? IC.cash : IC.card}<span class="t"><b>${f.pay === 'cash' ? 'Efectivo ' + (del ? 'al entregar' : 'al recoger') : 'Tarjeta · PixelPay'}</b><span>${f.pay === 'cash' ? 'Como tu último pedido' : 'Página segura, 3D Secure'}</span></span><button class="act" data-act="showpay">Cambiar</button></div></div>` : payOpts}${cashPanel(T)}</section>`;
      const bar = `<div class="paybar"><button class="primary" id="cta" data-act="confirm"${ctaOff(T) ? ' disabled' : ''}>${esc(ctaLabel(T))}</button></div>`;
      // the prototype's footer «¿Problemas con tu pedido? Escribinos al …» (:1886) is omitted — pending a ruling
      return `<div class="flow" id="flow"><div class="flowbar plain"><h1>Entrega &amp; Pago</h1></div>
    <div class="col-a">${entrega}${datos}${pedido}${pago}</div>${bar}</div>`;
    }
    // the cash panel: chips + the change line against the QUOTED Total (no chips until that Total exists)
    const tenderNote = (T) => { const f = S.flow; if (!T.ready || !f.tendered) return ''; const ch = C.changeCents(f, T.total); return ch === null ? 'Ese monto es menor que el total (' + moneyC(T.total) + ').' : ch > 0 ? 'Tu cambio: ' + moneyC(ch) : 'Pago exacto, sin cambio.'; };
    function cashPanel(T) {
      const f = S.flow; if (f.pay !== 'cash') return '';
      const tot = T.ready ? T.total / 100 : null; let base = tot === null ? null : Math.ceil(tot / 500) * 500; if (base !== null && base <= tot) base += 500;
      const tender = Number(f.tendered);
      const chips = tot === null ? '' : `<div class="chips">${[{ l: 'Pago exacto', v: tot }, { l: money(base), v: base }].map((c) => `<button class="chip" aria-pressed="${tender === c.v}" data-act="tender" data-val="${c.v}">${c.l}</button>`).join('')}</div>`;
      return `<div class="fld"><label for="f-tender">¿Con cuánto vas a pagar? <span class="mute">(para llevarte el cambio exacto)</span></label>${chips}<input id="f-tender" data-field="tendered" inputmode="numeric" value="${esc(f.tendered)}" placeholder="Otro monto (L)"><span class="note" id="tender-note">${esc(tenderNote(T))}</span></div>`;
    }

    // ── the tip step (prototype tipHtml :1954-1961) ──
    const tipKey = () => { const c = S.flow.tipChoice; return c === null ? null : c.kind === 'none' ? 0 : c.kind === 'other' ? 'other' : c.lempiras; };
    const tipReady = (T) => C.tipChosen(S.flow) && T.ready && !need() && intakeOk();
    function tipHtml() {
      const f = S.flow, T = totalsNow(), c = tipKey();
      const chip = (v, label) => `<button class="chip" aria-pressed="${c === v}" data-act="tipc" data-val="${v}">${label}</button>`;
      const tot = T.ready ? moneyC(T.total) : '—';
      return `<div class="topbar"><button class="iconbtn" data-act="back" aria-label="Volver a Entrega y Pago">${IC.back}</button><h1></h1><span class="sp"></span></div>
    <div class="tipwrap"><div class="tiphero">${RIDER}<h1>Agregá una propina</h1><p>La propina va completa a tu repartidor.</p></div>
    <div class="tipchips" role="group" aria-label="Propina">${C.TIP_PRESETS.map((v) => chip(v, v ? money(v) : 'Sin propina')).join('')}${chip('other', 'Otro')}</div>
    <div class="tipfoot"><div class="sumrow"><span>Propina</span><span>${c === null ? '—' : f.tipCents ? moneyC(f.tipCents) : 'Sin propina'}</span></div><div class="sumrow tot"><span>Total</span><span>${tot}</span></div><button class="primary" data-act="tip-place"${tipReady(T) ? '' : ' disabled'}>Hacer pedido · ${tot}</button></div></div>`;
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
      const f = S.flow, del = f.mode === 'delivery', T = totalsNow(), e = etaRange(f.mode), lines = displayLines();
      return `<div class="scrim"></div><div class="sheet" role="dialog" aria-label="Realizando pedido"><div class="grab"></div><div class="placing"><h2>Realizando pedido…</h2>
    ${e ? prow(IC.clock, esc(e.k) + ' ' + esc(e.v), del ? 'Delivery' : 'Pickup') : ''}
    ${prow(IC.store, storeLine(), del ? addrText() : esc(cfg.addr || ''), del ? 's' : '')}
    ${prow(IC.bag, esc(unitOf(cart.count())), esc(lines.map((d) => d.n + '× ' + d.item.n).join(', ')))}
    ${prow(f.pay === 'online' ? IC.card : IC.cash, f.pay === 'online' ? 'Tarjeta · PixelPay' : 'Efectivo ' + (del ? 'al entregar' : 'al recoger'), 'Total ' + moneyC(T.total) + (T.tip ? ' · incluye propina ' + moneyC(T.tip) : ''))}
    <div class="acts"><button class="primary okbtn" data-act="placing-go"><i class="fill" aria-hidden="true"></i><span>Se ve bien (<span class="cd">0:02</span>)</span></button><button class="btn2 wide" data-act="placing-back">Volver</button></div></div></div>`;
    }
    function placeTap() {
      if (dead || !intakeOk() || !S.flow || need() || !C.tipChosen(S.flow) || !totalsNow().ready) return;
      placingStop(); S.backScreen = S.screen; openLayer('placing');
      let left = 2;
      placingI = T_.setInterval(() => { left = Math.max(0, left - 1); const cd = doc.querySelector('[data-act="placing-go"] .cd'); if (cd) cd.textContent = '0:0' + left; }, 1000);
      placingT = T_.setTimeout(placingGo, 2000);
    }
    function placingGo() { placingStop(); if (dead || S.layerKind !== 'placing') return; S.layerKind = null; renderLayer(); send(); }

    // ── «Enviando tu pedido…» (prototype sendingHtml :2029-2042) while place() is in flight ──
    function sendingHtml() {
      const f = S.flow, del = f.mode === 'delivery', lines = displayLines();
      const st = S.sendTotals || { total: null, tip: 0 };
      return `<div class="sending" aria-live="polite"><div class="shero">${RIDER_LIVE}</div>
    <div class="sndcard"><div class="shd"><h2>Enviando tu pedido…</h2><span class="sspin" id="sspin"><i class="ring" aria-hidden="true"></i></span></div>
      ${prow(IC.pin, del ? addrText() : 'Pickup · ' + storeLine(), del ? 'Entrega' : esc(cfg.addr || ''), del ? 'b' : '')}
      <div class="prow">${logoChip('lg')}<span class="t"><b>${storeLine()}</b><span>${esc(lines.map((d) => d.n + '× ' + d.item.n).join(', '))}</span></span></div>
      ${prow(f.pay === 'online' ? IC.card : IC.cash, (f.pay === 'online' ? 'Tarjeta · PixelPay' : 'Efectivo ' + (del ? 'al entregar' : 'al recoger')) + (st.total !== null ? ' · ' + moneyC(st.total) : ''), st.tip ? 'Incluye propina ' + moneyC(st.tip) : 'Pago')}
      <p class="shint">${esc(S.sendHint || 'Esto toma unos segundos')}</p></div></div>`;
    }
    async function send() {
      const f = S.flow, T = totalsNow();
      if (dead || !intakeOk() || !T.ready || !mods()) return;   // no key ⇒ nothing is sent (the record stays clean)
      let c; try { c = { ...ctxBase(), headers: intakeHeaders() }; } catch (_) { return; }   // the key only where the server requires it
      S.screen = 'sending'; S.sendHint = null; S.sendTotals = { total: T.total, tip: T.tip }; render();
      // S2b r1 P2-7: an accepted price change ⇒ «Enviando» shows the ceiling actually sent
      const onExpected = (cents) => { if (dead || !Number.isFinite(cents)) return; S.sendTotals = { total: cents, tip: T.tip }; if (S.screen === 'sending') render(); };
      let out;
      try { out = await api.place({ flow: f, ctx: c, sig: S.q.sig, expectedNetCents: T.total, totals: T, sheet: priceSheet, onExpected, alive: () => !dead, cartSnapshot: cart.snapshot() }); } catch (e) { out = { kind: 'error', error: String(e && e.message) }; }
      if (!dead) onOutcome(out);
    }
    // the 600 ms happy beat: the spinner becomes the green check, then the host takes over (S5)
    function beat(out) {
      const sp = $('sspin'); if (sp) { sp.innerHTML = CHECK_OK; sp.classList.add('done'); }
      if (beatT !== null) T_.clearTimeout(beatT);
      beatT = T_.setTimeout(() => { beatT = null; emit('placed', out); }, 600);
    }
    // back to where the customer tapped (closure / out-of-zone: to «Entrega & Pago», where those gates live)
    function backTo(screen) {
      const target = screen || S.backScreen || 'checkout';
      // landing on the screen the stack would return to (tip → «Entrega & Pago»): walk back, so history stays in step
      if (S.backScreen === 'tip' && target === 'checkout' && S.stack.length && S.stack[S.stack.length - 1].screen === 'checkout') { S.screen = 'tip'; back(); return; }
      S.screen = target; render();
    }
    function showErr(e) { S.err = e; openLayer('err'); }
    function quoteFailed() {
      if (S.screen !== 'checkout' && S.screen !== 'tip') return;
      if (S.layerKind) { S.quoteErrSheet = true; return; }   // shown when the open layer closes
      showErr(ERR.generic('err-requote'));
    }
    const ERR = {
      offline: () => ({ title: 'Sin conexión', body: 'No pudimos enviar tu pedido. Revisá tu conexión e intentá de nuevo; tu pedido está intacto.', icon: 'warn', acts: [{ act: 'err-retry', label: 'Reintentar', primary: true }, { act: 'lclose', label: 'Cerrar' }] }),
      // S2 drops the «Programar» button and the schedule sentence (OWNER 2026-10-26; CLOSED_SHEET.scheduleHint is S4's)
      closed: () => ({ title: C.CLOSED_SHEET.title(cfg.name || '', closesText()), body: C.CLOSED_SHEET.body, icon: 'warn', acts: [{ act: 'lclose', label: 'Cerrar' }] }),
      // TODO(ruling pending): «Pagar en efectivo» is a host event only
      payFailed: () => ({ title: 'Pago no completado', body: 'Tu banco no autorizó el pago. Podés intentar con otra tarjeta o pagar en efectivo; tu pedido está intacto.', acts: [{ act: 'err-cash', label: 'Pagar en efectivo', primary: true }, { act: 'err-card', label: 'Usar otra tarjeta' }] }),
      // the approved Q9 mockup #mk-refunded
      refunded: (cents) => ({ title: 'Te reembolsamos tu pago', body: `${cfg.name || ''} ya había cerrado cuando se confirmó tu pago. Te devolvimos el total completo${Number.isFinite(cents) ? ', ' + moneyC(cents) : ''}; no se te cobrará.`, icon: 'ok', acts: [{ act: 'home', label: 'Volver al inicio', primary: true }] }),
      // the approved Q9 mockup #mk-exists — «Escribir a la tienda» hidden (no public restaurant contact in the app data)
      // the owner-approved held-states mockup (MOCKUP-capp-S2b-held-states.html #mk-paused / #mk-generic / #mk-pending)
      paused: () => ({ title: `${cfg.name || ''} no está recibiendo pedidos en este momento`, body: 'Tu pedido no se envió ni se cobró nada; está intacto para que lo intentés en unos minutos.', icon: 'warn', ic: 'clock', acts: [{ act: 'lclose', label: 'Entendido', primary: true }] }),
      generic: (retry = 'err-retry') => ({ title: 'No pudimos enviar tu pedido', body: 'Intentá de nuevo en un momento; tu pedido está intacto.', acts: [{ act: retry, label: 'Reintentar', primary: true }, { act: 'lclose', label: 'Cerrar' }] }),
      pending: () => ({ title: 'Tu pago todavía está en verificación', body: 'Estamos confirmando tu pago con el banco. No hace falta pagar de nuevo; esperá un momento mientras termina.', icon: 'calm', ic: 'clock', acts: [{ act: 'lclose', label: 'Volver al pedido', primary: true }], held: true }),
      exists: (ref) => ({ title: 'Necesitamos revisar tu pedido', body: 'Ya existe un pedido con este número, así que no lo enviamos de nuevo para no duplicarlo. Escríbenos y lo revisamos.', icon: 'calm', note: `Referencia <b>#${esc(ref || '')}</b>`, acts: [{ act: 'lclose', label: 'Volver al pedido' }], held: true }),
    };
    function onOutcome(out) {
      const k = out && out.kind;
      if (k === 'redirect') {
        // a RESUMED checkout shows the STORED economics (never the current quote), then leaves for the stored URL
        if (out.resumed) { const t = out.totals || {}; S.sendTotals = { total: Number.isFinite(out.expected_net_cents) ? out.expected_net_cents : (Number.isFinite(t.total) ? t.total : null), tip: Number.isFinite(t.tip) ? t.tip : 0 }; S.screen = 'sending'; render(); }
        navigate(out.url); return;
      }
      if (k === 'placed' || k === 'paid_unverified') { if (S.screen !== 'sending') { S.screen = 'sending'; render(); } beat(out); return; }
      if (k === 'confirming') { S.screen = 'sending'; S.sendHint = CONFIRMING_HINT; render(); return; }
      if (k === 'offline') { backTo(); showErr(ERR.offline()); return; }
      if (k === 'closed') { S.closedRefused = true; backTo(); showErr(ERR.closed()); return; }   // over the screen of the tap (P placeTap :1975)
      if (k === 'out_of_zone') { S.outZone = true; backTo('checkout'); return; }
      if (k === 'payment_failed') {
        backTo('checkout');   // P pixelPay :2016 — back() to «Entrega & Pago», then the sheet
        if (out.clearable === false) { showErr(ERR.pending()); return; }   // a cancel return the server still calls pending: the order stays locked
        // «Usar otra tarjeta» needs the whole checkout back: after a return that could not restore it, the generic held state (U3)
        showErr(S.returning && !contextRestored() ? ERR.generic() : ERR.payFailed()); return;
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
    function errSheet(e) {
      const acts = e.acts.map((a) => `<button class="${a.primary ? 'primary' : 'btn2 wide'}" data-act="${a.act}">${esc(a.label)}</button>`).join('');
      const ic = e.ic ? IC[e.ic] : e.icon === 'ok' ? IC.check : e.icon === 'warn' || e.icon === 'calm' ? IC.alert : IC.close;
      return `<div class="scrim"></div><div class="sheet" role="alertdialog" aria-label="${esc(e.title)}"><div class="grab"></div><div class="errsheet"><div class="icon${e.icon ? ' ' + e.icon : ''}">${ic}</div><h2>${esc(e.title)}</h2><p>${esc(e.body)}</p>${e.note ? `<p class="note">${e.note}</p>` : ''}<div class="acts">${acts}</div></div></div>`;
    }
    const feeInfoHtml = () => { const d = S.lastDelivery || {}; return `<div class="scrim" data-act="lclose"></div><div class="sheet" role="dialog" aria-label="Envío"><div class="grab"></div><div class="errsheet"><h2>Envío</h2><p>Sherpa calcula el envío según la distancia entre la sucursal y tu dirección. Desde ${moneyC(d.from_cents)}; zona de entrega hasta ${esc(d.max_km)} km de ${storeLine()}.</p><div class="acts"><button class="btn2 wide" data-act="lclose">Entendido</button></div></div></div>`; };
    // ── the full-screen pin step (prototype pinStepHtml :2186-2190; the prototype-only «Simulación» strip dropped) ──
    function pinStepHtml() {
      const zoneKm = (S.lastDelivery && Number.isFinite(S.lastDelivery.max_km) ? S.lastDelivery.max_km : cfg.zoneKm);
      const out = S.outZone;
      return `<div class="pinstep" role="dialog" aria-label="Confirmá dónde entregamos"><div class="mapwrap">${MAP_SVG}${gmapBox('pin')}<div class="store-nav" style="position:absolute"><button class="iconbtn" data-act="lclose" aria-label="Cancelar">${IC.close}</button><span></span></div><div class="hint">Mové el mapa hasta que el pin quede en tu puerta</div><span class="pin">${IC.pinfill}</span></div>
    <div class="foot"><b>Confirmá dónde entregamos</b><span class="sub">${out && Number.isFinite(zoneKm) && cfg.branch ? `${esc(cfg.name || '')} entrega hasta ${esc(zoneKm)} km de ${esc(cfg.branch)}; este punto queda fuera.` : 'Las direcciones aquí se describen con referencias: el pin es la dirección, los detalles son la referencia.'}</span><button class="primary" data-act="pin-done">Listo</button></div></div>`;
    }

    // ── navigation ──
    function openCheckout() {
      if (!mods()) return false;
      if (!S.flow) S.flow = C.freshFlow(member());
      C.setMode(S.flow, S.mode);
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
      if (S.layerKind) { if (S.layerKind === 'pin') dropPinMap(); S.layerKind = null; S.err = null; }
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
    function deviceBack() {
      if (dead) return 'pass';
      if (S.layerKind === 'err' && S.err && S.err.held === true) return 'blocked';
      if (S.layerKind === 'cart' || S.layerKind === 'placing') { histN = Math.max(0, histN - 1); backInternal(); return 'consumed'; }
      if (S.screen === 'sending') return 'blocked';
      if (!S.stack.length) { if (S.layerKind) { closeLayer(); return 'consumed'; } return api && api.hosted && typeof api.holdsLock === 'function' && api.holdsLock() ? 'blocked' : 'pass'; }
      histN = Math.max(0, histN - 1); backInternal(); return 'consumed';
    }
    function checkoutAct(t) {
      const f = S.flow, a = t.dataset.act, v = t.dataset.val;
      if (a === 'type') { if (frozenNow()) return true; S.mode = v === 'pickup' ? 'pickup' : 'delivery'; C.setMode(f, S.mode); notifyCart(); if (S.mode === 'delivery' && !finitePin(f.pin) && S.geo === null) requestGeo(); render(); return true; }
      if (a === 'rm-po') { for (const l of poLines()) mutate(() => cart.setQty(l.key, 0)); if (!cart.count()) toStore(); else render(); return true; }
      if (a === 'editwho') { f.editWho = true; render(); return true; }
      if (a === 'more') { S.more = true; render(); return true; }
      if (a === 'editdetails') { S.editDetails = true; render(); return true; }
      if (a === 'sumtoggle') { S.sumOpen = !S.sumOpen; render(); return true; }
      if (a === 'pay') { f.pay = v === 'online' ? 'online' : 'cash'; S.showPay = false; render(); return true; }
      if (a === 'showpay') { S.showPay = true; render(); return true; }
      if (a === 'tender') { f.tendered = v; render(); return true; }
      if (a === 'addmore') { toStore(); return true; }
      if (a === 'time') return true;   // ASAP is the only option in S2
      if (a === 'pin') { S.pinDraft = finitePin(f.pin) ? { lat: f.pin.lat, lng: f.pin.lng } : (cfg.loc && finitePin(cfg.loc) ? { lat: cfg.loc.lat, lng: cfg.loc.lng } : null); openLayer('pin'); return true; }
      if (a === 'loc-on') { S.geo = null; requestGeo(); return true; }
      if (a === 'feeinfo') { openLayer('feeinfo'); return true; }
      if (a === 'signin') { emit('signin', { ctx: t.dataset.ctx || 'checkout' }); return true; }
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
          C.setPin(S.flow, d.lat, d.lng, true); S.pinStepOk = true;
          // P :2272 toasts on every «Listo»: after the re-quote when the point moved, at once when it did not (no re-quote runs)
          if (stateKey() === S.askedKey) toast(S.outZone ? 'Ese punto queda fuera de la zona' : 'Pin confirmado', TOAST_MS);
          else { S.outZone = false; S.pinToast = true; }
        }
        closeLayer(); render(); return true;
      }
      if (a === 'err-retry') { closeLayer(); send(); return true; }   // the SAME placement (capp-api keeps the id)
      if (a === 'err-requote') { closeLayer(); S.quoteErr = null; requote(); return true; }   // the failed quote, asked again (its key was released)
      if (a === 'err-cash') { closeLayer(); emit('pay-cash', {}); return true; }   // TODO(ruling pending)
      if (a === 'err-card') {   // a new card attempt goes through the same placing card — once the restored checkout is priced
        closeLayer(); S.screen = 'checkout';
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
      const f = C.freshFlow(member());
      C.setMode(f, b.order_type === 'pickup' ? 'pickup' : 'delivery');
      Object.assign(f, { name: String(b.customer_name || ''), phone: String(b.customer_phone || '').replace(/^\+504\s*/, ''), email: String(b.customer_email || ''),
        notes: b.notes && b.notes !== '—' ? String(b.notes) : '', pay: b.payment_method === 'online' ? 'online' : 'cash' });
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
      if (!S.flow) { S.flow = C.freshFlow(member()); C.setMode(S.flow, S.mode); S.flow.pay = 'online'; }
      S.returning = true;
      const rec = api.readPlace();
      S.backScreen = 'checkout'; S.screen = 'sending'; S.sendHint = null;
      S.sendTotals = rec ? { total: Number.isFinite(rec.expected_net_cents) ? rec.expected_net_cents : null, tip: rec.totals && Number.isFinite(rec.totals.tip) ? rec.totals.tip : 0 } : null;
      render();
      let out; try { out = await api.handleReturn(search); } catch (e) { out = { kind: 'error' }; }
      if (out && !dead) onOutcome(out);
    }

    function render() {
      if (dead) return;
      app.classList.toggle('narrow', app.clientWidth > 0 && app.clientWidth < 375);
      const keepSearch = S.layerKind === 'ssearch' && $('layer') && $('layer').querySelector('#sq') ? $('layer') : null;
      const ae = doc.activeElement;
      const had = app.contains(ae) ? descOf(ae) : null;
      const caret = had && ae && ae.id && typeof ae.selectionStart === 'number' ? [ae.id, ae.selectionStart, ae.selectionEnd] : null;   // S2b: typing survives a quote landing
      const keepToast = $('toast');
      const prevFlow = $('flow'); const flowY = prevFlow ? prevFlow.scrollTop : null; const prevScreen = app.dataset.screen;
      // the S2b router: every screen inside <div class="screen"> (the prototype's mount)
      const html = S.screen === 'checkout' ? checkoutHtml() : S.screen === 'tip' ? tipHtml() : S.screen === 'sending' ? sendingHtml() : storeHtml();
      app.innerHTML = `<div class="screen">${html}</div>${detailSkeleton()}<div class="layer" id="layer"></div><div class="toast" id="toast" role="status" aria-live="polite"></div>`;   // the prototype's mount (render())
      app.dataset.screen = S.screen;
      if (keepSearch) app.replaceChild(keepSearch, $('layer'));
      if (keepToast) app.replaceChild(keepToast, $('toast'));   // a live refusal toast survives the re-render that follows it
      if (S.screen === 'store') wireStore();
      if (S.screen === 'checkout' && flowY !== null && prevScreen === 'checkout' && $('flow')) $('flow').scrollTop = flowY;
      renderLayer();
      if (S.open) { renderDetail(); $('detail-overlay').classList.add('open'); $('detail-modal').classList.add('open'); }
      syncInert();
      if (had && lost()) { focusTo(refind(had)); if (caret && doc.activeElement && doc.activeElement.id === caret[0]) { try { doc.activeElement.setSelectionRange(caret[1], caret[2]); } catch (_) {} } }
      if (S.screen === 'checkout') wireMaps();
      if (S.screen === 'checkout' || S.screen === 'tip') requote();
      geocodePin();
    }
    function onClick(ev) {
      const t = ev.target.closest && ev.target.closest('[data-act]'); if (!t || !app.contains(t)) return;
      const act = t.dataset.act, id = t.dataset.id;
      if (S.open && ['qty', 'extra', 'variant', 'staged', 'dcta'].includes(act)) { detailAct(t); return; }
      if (act === 'dclose') { closeDetail(); return; }
      // S2b: the open layer's controls, then the current screen's
      if (S.layerKind && ['err', 'placing', 'tipother', 'pin', 'feeinfo'].includes(S.layerKind)) { if (act === 'lclose') { closeLayer(); return; } if (layerAct(t)) return; }
      if (S.screen === 'checkout' && !S.layerKind) {
        if (act === 'rev') { mutate(() => (Number(t.dataset.rev) > 0 ? cart.lineInc(t.dataset.key, t.dataset.grp || '') : cart.lineDec(t.dataset.key, t.dataset.grp || ''))); if (!cart.count()) toStore(); else render(); return; }
        if (checkoutAct(t)) return;
      }
      if (S.screen === 'tip' && !S.layerKind && tipAct(t)) return;
      if (act === 'inc') { const it = find(id); if (it && it.group) { openDetail(id); return; } if (!it || isSold(it)) { renderStoreKeep(); return; } if (mutate(() => cart.inc(id))) { S.expanded.add(id); bumpPill(); } renderStoreKeep(); return; }
      if (act === 'dec') { const it = find(id); if (it && it.group) { openLayer('cart'); return; } mutate(() => cart.dec(id)); renderStoreKeep(); return; }
      if (act === 'badge') { S.expanded.add(id); renderStoreKeep(); return; }
      if (act === 'open') { returnTo = descOf(t); openDetail(id); return; }
      if (act === 'pill') { openLayer('cart'); return; }
      if (act === 'cartclose') { back(); return; }   // closing the cart is a back step → the menu (P :2297)
      if (act === 'lclose') { closeLayer(); return; }
      if (act === 'rev') { const k = t.dataset.key, g = t.dataset.grp || '', d = descOf(t); mutate(() => (Number(t.dataset.rev) > 0 ? cart.lineInc(k, g) : cart.lineDec(k, g))); renderStoreKeep(); renderLayer(); focusTo(refind(d) || [...$('layer').querySelectorAll(FOCUSABLE)].find(reachable)); return; }
      if (act === 'edit') { S.layerKind = null; renderLayer(); returnTo = { elId: 'cart-bar', ds: { act: 'pill' } }; openEdit(t.dataset.key, t.dataset.grp || ''); return; }
      if (act === 'mode') { if (frozenNow()) return; S.mode = t.dataset.val; notifyCart(); renderStoreKeep(); return; }
      if (act === 'jump') { jumpTo(t.dataset.jump); return; }
      if (act === 'menu') { openLayer('menu'); return; }
      if (act === 'goto') { closeLayer(); jumpTo(t.dataset.goto); return; }
      if (act === 'ssearch') { openLayer('ssearch'); return; }
      if (act === 'back') { emit('back'); return; }
      if (act === 'checkout') { let body = null; try { body = CappSerialize.serialize(cart, menu); } catch (e) { S.refusal = e && e.code === 'cart_text_too_long' ? FULL_CART : null; renderLayer(); return; } emit('checkout', { body, mode: S.mode }); openCheckout(); return; }
      if (act === 'closed-sched') { emit('schedule'); return; }
    }
    const FLOW_FIELDS = ['details', 'name', 'phone', 'email', 'notes', 'tendered'];
    function onInput(ev) {
      const t = ev.target; if (!t || !t.dataset) return;
      const fld = t.dataset.field;
      if (fld === 'sq') { S.searchQ = t.value; runStoreSearch(t.value); return; }
      if (fld === 'tipOther') { S.tipDraft = capDraft(t.value, S.tipDraft || ''); t.value = S.tipDraft || '0'; t.style.width = `calc(${Math.max(1, t.value.length)}ch + 6px)`; return; }
      if (S.flow && FLOW_FIELDS.includes(fld)) {
        S.flow[fld] = t.value;
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
    if (!H && doc.defaultView) doc.defaultView.addEventListener('popstate', onPop);
    const unsubBack = H && typeof H.subscribe === 'function' ? H.subscribe(deviceBack) : null;
    render();
    if (mods() && !intakeOk()) { try { (doc.defaultView && doc.defaultView.console || console).error('capp: config error — intakeKey missing; placing disabled'); } catch (_) {} }
    // S2b: a hosted-checkout return (?pay=…)
    const search = opts.search != null ? String(opts.search) : (doc.defaultView && doc.defaultView.location ? doc.defaultView.location.search : '');
    const returning = /[?&]pay=/.test(search || '') ? handlePayReturn(search) : null;
    return {
      cart, menu, render, state: S, openCheckout, returning,
      deviceBack,
      restore(snapshot) {
        // S7a-1 r3 §1.3 (hosted): reconcile FIRST — blocked until it completes; a purchased (cleared) cart is never restored
        if (cfg.cartKey && cfg.placedKey && mods() && api.hosted) { const rc = api.reconcile(); if (!rc.ok) return { blocked: true, step: rc.step }; if (rc.done === 'placed' && snapshot && snapshot.cart_gen && snapshot.cart_gen === rc.cart_gen) return { cleared: true };
          // Codex r1 P2-7: the persisted mode is restored with the lines (a frozen pickup cart is never re-shown as delivery)
          if (snapshot && (snapshot.mode === 'pickup' || snapshot.mode === 'delivery')) { S.mode = snapshot.mode; if (S.flow && C) C.setMode(S.flow, S.mode); } }
        const r = cart.hydrate(snapshot); notifyCart(); S.cartNote = r.dropped || null; S.refusal = tooLong() ? FULL_CART : null; render(); if (S.refusal) toast(S.refusal); return r; },
      destroy() {
        dead = true; placingStop(); if (beatT !== null) { T_.clearTimeout(beatT); beatT = null; }
        S.layerKind = null; const L = $('layer'); if (L) L.innerHTML = '';
        for (const el of [...doc.querySelectorAll('.cq-sheet')]) el.remove();   // the ported «El precio cambió» sheet (capp-confirm-quote)
        doc.removeEventListener('click', onClick); doc.removeEventListener('input', onInput); doc.removeEventListener('keydown', onKey); if (!H && doc.defaultView) doc.defaultView.removeEventListener('popstate', onPop); if (typeof unsubBack === 'function') { try { unsubBack(); } catch (_) {} } },
    };
  }

  return { mount, FULL_CART };
});
