// Customer app S1b (PLAN-capp-S1.FINAL §1) — the STORE page, the ITEM SHEET and the CART SHEET, ported from the frozen
// prototype APPROVED-v6 (storeHtml / rowHtml / overlayHtml / wireStore / renderDetail / detailAct / saveEdit / cartInner …) onto
// the S1 modules: capp-menu (the served getPublicMenu envelope), capp-cart (the per-instance cart) and capp-serialize (the
// 1,500-character limit). Brand-agnostic: every restaurant difference is DATA (the envelope + the store config) — no restaurant
// id or name in this file (guarded). Ships DARK.
//
// mount(doc, { envelope, config, unavailable, now, onEvent })
//   config: { name, kicker, logo, logoWide, hero, unit: [singular, plural], hours: [ [h1,m1,h2,m2] | null ×7 (Sun..Sat) ],
//             addr, etaDel: [a,b], etaPick: [a,b], feeFromCents: int | null, assetBase: string | null, entry: 'app' | 'link' }
//   unavailable: Set of dish keys sold out right now (the live availability reader is wired by the host)
//   onEvent(name, detail): the controls whose screens land in later slices — 'back' (the in-app close X, S7), 'checkout' (S2),
//                          'schedule' (S2) — are host events, never dead buttons.
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
  };
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
    const now = opts.now || (() => new Date());
    const emit = (name, detail) => { try { (opts.onEvent || (() => {}))(name, detail); } catch (_) {} };
    const cart = CappCart.createCart(menu);
    const $ = (id) => doc.getElementById(id);
    const app = $('app');
    const S = { mode: 'delivery', expanded: new Set(), open: null, layerKind: null, cartNote: null, refusal: null, activeSec: '', entry: cfg.entry === 'app' ? 'app' : 'link' };

    // ── the view model: the served menu as the prototype's item shape ──
    const photo = (d) => (d && d.img && cfg.assetBase ? cfg.assetBase.replace(/\/?$/, '/') + String(d.img).replace(/^\.?\//, '') : '');
    const exOf = (k) => menu.extrasFor(k).filter((e) => e.supported).map((e) => e.key);
    const EX = {}; for (const e of menu.extras) EX[e.key] = { n: e.name, p: e.price, c: e.cat, max: 1 };
    const itemOf = (d) => {
      const g = menu.groups[d.key];
      const it = { id: d.key, n: d.name, d: d.desc, p: d.price, img: photo(d), hero: photo(d), tags: d.tags || [], ex: exOf(d.key), cat: d.cat, sold: unavailable.has(d.key) };
      if (g) it.group = { label: g.label, choices: g.choices.map((ck) => { const c = menu.dish(ck); return { id: c.key, choice: c.choice || c.name, p: c.price, n: c.name, ex: exOf(c.key), sold: unavailable.has(c.key) }; }) };
      return it;
    };
    const sections = menu.categories.map((c) => {
      const cid = String(c.id);
      const items = menu.dishes.filter((d) => String(d.cat) === cid && !d.variantOf).map(itemOf);
      const pick = menu.pickupOnlyCats.has(cid), wknd = menu.weekendOnlyCats.has(cid);
      return { id: cid, name: c.name != null ? c.name : cid, items, pickupOnly: pick, note: pick && wknd ? 'Solo viernes a domingo · para recoger' : '' };
    }).filter((s) => s.items.length);
    const find = (id) => { for (const s of sections) for (const it of s.items) { if (it.id === id) return it; if (it.group) for (const c of it.group.choices) if (c.id === id) return { ...c, d: it.d, img: it.img, hero: it.hero, tags: [], parent: it }; } return null; };
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
    function mutate(fn) {
      const before = cart.snapshot();
      try { fn(); } catch (_) { return false; }
      if (cart.count()) {
        try { CappSerialize.serialize(cart, menu); } catch (e) {
          if (e && e.code === 'cart_text_too_long') { cart.hydrate(before); S.refusal = FULL_CART; render(); return false; }
        }
      }
      S.refusal = null;
      return true;
    }

    // ── STORE ──
    function overlayHtml(it) {
      const n = qtyAll(it), exp = S.expanded.has(it.id), id = esc(it.id), launcher = !!it.group;
      return `<div class="qty-overlay" data-stop="1">
    <div class="qty-controls${n > 0 && exp ? ' visible' : ''}"><button class="qty-ctrl-btn" data-act="dec" data-id="${id}" aria-label="${launcher ? 'Ver tu pedido' : 'Quitar uno'}">−</button><span class="qty-ctrl-num">${n}</span><button class="qty-ctrl-btn" data-act="inc" data-id="${id}" aria-label="${launcher ? 'Agregar otra' : 'Agregar uno'}">+</button></div>
    <div class="qty-badge" style="display:${n > 0 && !exp ? 'flex' : 'none'}" data-act="badge" data-id="${id}" role="button" tabindex="0" aria-label="${n} en tu pedido"><span>${n > 0 ? n : 1}</span></div>
    <button class="qty-add-btn"${n > 0 ? ' style="display:none"' : ''} data-act="${launcher ? 'open' : 'inc'}" data-id="${id}" aria-label="${launcher ? 'Personalizar' : 'Agregar ' + esc(it.n)}">+</button></div>`;
    }
    function rowHtml(it) {
      const b = badgeOf(it), sold = it.sold ? '<span class="mark" style="color:var(--mute)">Agotado</span>' : '';
      const label = b ? `<span class="mark" style="color:${b.color}">${esc(b.text)}</span>` : '';
      const marks = sold || label ? `<span class="marks">${sold}${label}</span>` : '';
      const price = it.group ? 'desde ' + money(Math.min(...it.group.choices.map((c) => c.p))) : money(it.p);
      const open = `data-act="open" data-id="${esc(it.id)}"`;
      return `<div class="row${it.sold ? ' sold-out' : ''}" id="dish-${esc(it.id)}"><button class="txtbtn" ${open}>${marks}<span class="nm">${esc(it.n)}</span>${it.d ? `<span class="ds">${esc(it.d)}</span>` : ''}<span class="prrow"><span class="pr">${esc(price)}</span></span></button>
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

    // ── ITEM SHEET (per-instance extras; S1: toggles) ──
    const detailSkeleton = () => `<div class="detail-overlay" id="detail-overlay" data-act="dclose"></div><div class="detail-modal" id="detail-modal" aria-hidden="true" role="dialog" aria-labelledby="detail-header-title"><div class="detail-drag-handle" aria-hidden="true"></div><div class="detail-header"><button class="detail-close" id="detail-close" data-act="dclose" aria-label="Cerrar">${IC.close}</button><div class="detail-header-title" id="detail-header-title"></div><div class="detail-header-spacer"></div></div><div class="detail-scroll" id="detail-scroll"></div><div class="detail-cta-bar"><div class="detail-step" id="detail-step" role="group" aria-label="Cantidad"></div><button class="detail-cta" id="detail-cta" data-act="dcta"></button></div></div>`;
    const extrasByCat = (ids) => { const out = []; for (const id of ids) { const e = EX[id]; if (!e) continue; let g = out.find((x) => x.cat === e.c); if (!g) out.push(g = { cat: e.c, list: [] }); g.list.push({ id, ...e }); } return out; };
    const instTotal = (inst) => Object.keys(inst || {}).reduce((a, k) => a + (EX[k] ? EX[k].p : 0), 0);
    function openDetail(id) { const it = find(id); if (!it) return; S.open = it.group ? { id, kind: 'launcher', staged: { choice: null, ex: {}, qty: 1 } } : { id, kind: 'dish', staged: { qty: 1 } }; openDetailDom(); }
    function openEdit(key, g = '') { const l = cart.lines().find((x) => x.key === key); if (!l) return; const it = find(key); const n = l.ex.filter((inst) => CappCart.sigOf(inst) === g).length; S.open = { id: it.parent ? it.parent.id : it.id, kind: 'edit', key, g, n, staged: { choice: it.parent ? it.id : null, ex: Object.fromEntries(g ? g.split(',').map((k) => [k, 1]) : []) } }; openDetailDom(); }
    function openDetailDom() { renderDetail(); $('detail-overlay').classList.add('open'); $('detail-modal').classList.add('open'); $('detail-modal').setAttribute('aria-hidden', 'false'); }
    function closeDetail() { $('detail-overlay').classList.remove('open'); $('detail-modal').classList.remove('open'); $('detail-modal').setAttribute('aria-hidden', 'true'); S.open = null; renderStoreKeep(); }
    function extraRow(e, q, act, attrs) {
      const sel = q > 0;
      return `<div class="detail-extras-row" data-act="${act}" ${attrs} role="checkbox" aria-checked="${sel}" tabindex="0"><span class="xrow-main"><span class="detail-extras-name">${esc(e.n)}</span><span class="xrow-price">+${money(e.p)}</span></span><div class="detail-extras-toggle ${sel ? 'selected' : ''}">${IC.check.replace('class="i"', '')}</div></div>`;
    }
    function renderDetail() {
      const o = S.open, it = find(o.id);
      $('detail-header-title').textContent = o.kind === 'edit' ? 'Editar' : it.n;
      const src = it.hero || it.img;
      let html = `<div class="detail-photo${src ? '' : ' empty'}">${src ? `<img class="detail-photo-img" src="${esc(src)}" alt="${esc(it.n)}">` : ''}</div>`;
      const body = (price) => `<div class="detail-body"><div class="detail-name">${esc(it.n)}</div><div class="detail-price">${price}</div>${it.d ? `<div class="detail-desc">${esc(it.d)}</div>` : ''}</div>`;
      const groupLabel = (g) => `<div class="detail-cat-label"><span>${esc(g.label)}</span><span class="grp-status ${o.staged.choice ? 'done' : 'req'}">${o.staged.choice ? IC.check.replace('class="i"', '') + 'Requerido' : IC.alert.replace('class="i"', '') + 'Elegí 1 · Requerido'}</span></div>`;
      const variantRows = (g, min) => `<div class="detail-extras-list">${g.choices.map((c) => { const sel = o.staged.choice === c.id, delta = c.p - min > 0 ? c.p - min : null; return `<div class="detail-variant-row${sel ? ' sel' : ''}" data-act="variant" data-id="${esc(c.id)}" role="radio" aria-checked="${sel}" tabindex="0"><div><span class="detail-extras-name">${esc(c.choice)}</span>${delta !== null ? `<span class="detail-extras-price">+${money(delta)}</span>` : ''}</div><span class="detail-variant-radio"></span></div>`; }).join('')}</div>`;
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
      const keep = $('detail-scroll').scrollTop; $('detail-scroll').innerHTML = html; $('detail-scroll').scrollTop = keep;
      const step = $('detail-step'), cta = $('detail-cta'); cta.disabled = false; cta.className = 'detail-cta';
      const stepper = (n, minusOk) => `<button class="detail-step-btn" data-act="qty" data-delta="-1" aria-label="Quitar una"${minusOk ? '' : ' disabled'}>−</button><span class="detail-step-num" aria-live="polite">${n}</span><button class="detail-step-btn" data-act="qty" data-delta="1" aria-label="Agregar una">+</button>`;
      const label = (verb, amount) => `<span>${verb}</span><span class="detail-cta-divider">·</span><span>${money(amount)}</span>`;
      if (o.kind === 'edit') { step.hidden = true; step.innerHTML = ''; const base = o.staged.choice ? find(o.staged.choice).p : it.p; cta.innerHTML = label('Guardar', o.n * (base + instTotal(o.staged.ex))); return; }
      step.hidden = false;
      if (o.kind === 'launcher') { const c = it.group.choices.find((x) => x.id === o.staged.choice), n = o.staged.qty || 1; step.innerHTML = stepper(n, n > 1); if (!c) { cta.disabled = true; cta.innerHTML = `<span>Elegí tu ${esc(it.group.label.toLowerCase())}</span>`; } else cta.innerHTML = label('Agregar', n * (c.p + instTotal(o.staged.ex))); return; }
      const q = qtyOf(it.id);
      if (it.sold) { step.innerHTML = stepper(o.staged.qty || 1, false); cta.disabled = true; cta.innerHTML = '<span>Agotado</span>'; return; }
      if (q === 0) { const n = o.staged.qty || 1; step.innerHTML = stepper(n, n > 1); cta.innerHTML = label('Agregar', n * it.p); }
      else { const lineSum = cart.groups().filter((g) => g.key === it.id).reduce((a, g) => a + g.total, 0); step.innerHTML = stepper(q, true); cta.innerHTML = label('Guardar', lineSum); }
    }
    function detailAct(t) {
      const o = S.open, it = find(o.id), act = t.dataset.act;
      if (act === 'qty') { const d = Number(t.dataset.delta); if (o.kind === 'launcher' || qtyOf(it.id) === 0) o.staged.qty = Math.max(1, (o.staged.qty || 1) + d); else { mutate(() => cart.setQty(it.id, qtyOf(it.id) + d)); if (!qtyOf(it.id)) o.staged.qty = 1; } }
      else if (act === 'extra') { const i = Number(t.dataset.inst), e = t.dataset.eid; const l = cart.lines().find((x) => x.key === it.id); const cur = Object.keys((l && l.ex[i]) || {}); mutate(() => cart.setInstance(it.id, i, cur.includes(e) ? cur.filter((k) => k !== e) : [...cur, e])); }
      else if (act === 'variant') { o.staged.choice = t.dataset.id; const allowed = new Set(find(o.staged.choice).ex); for (const k of Object.keys(o.staged.ex)) if (!allowed.has(k)) delete o.staged.ex[k]; }
      else if (act === 'staged') { const e = t.dataset.eid; if (o.staged.ex[e]) delete o.staged.ex[e]; else o.staged.ex[e] = 1; }
      else if (act === 'dcta') {
        if (o.kind === 'edit') { saveEdit(); return; }
        if (o.kind === 'launcher') { const c = find(o.staged.choice); if (!c) return; if (mutate(() => cart.add(c.id, Object.keys(o.staged.ex), o.staged.qty || 1))) { bumpPill(); closeDetail(); } return; }
        if (it.sold) return;
        if (qtyOf(it.id) === 0) { if (!mutate(() => cart.add(it.id, [], o.staged.qty || 1))) { renderDetail(); return; } bumpPill(); if (!it.ex.length) { closeDetail(); return; } renderDetail(); syncPill(); return; }   // with extras the sheet stays open to dress each instance (v11)
        closeDetail(); return;
      }
      renderDetail(); syncPill();
    }
    function saveEdit() {
      const o = S.open; const target = o.staged.choice || o.key;
      mutate(() => cart.edit(o.key, o.g, Object.keys(o.staged.ex), target));
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
      const refusal = S.refusal ? `<div class="cartnote">${IC.info}<span>${esc(S.refusal)}</span></div>` : '';
      if (!lines.length) return head + note + `<div class="empty">${IC.bag}<span>Tu pedido está vacío.</span><button class="btn2" data-act="cartclose">Ver el menú</button></div>`;
      return head + note + refusal + lines.map((d) => `<div class="cline">${lineName(d, 'cl-txt')}${lineStep(d)}<span class="cl-p">${money(d.total)}</span></div>`).join('')
        + `<div class="ctot"><div class="sumrow"><span>Subtotal</span><span>${money(total)}</span></div></div>`
        + '<div class="sheetbar"><button class="primary" data-act="checkout">Ir al checkout</button></div>';
    }
    function runStoreSearch(q) {
      const box = $('sresults'); if (!box) return;
      const nq = norm(q).trim(); const hits = nq ? sections.flatMap((s) => s.items).filter((it) => norm(it.n + ' ' + (it.d || '')).includes(nq)) : [];
      box.innerHTML = !nq ? '' : hits.length ? `<div class="rcount">${hits.length} resultado${hits.length === 1 ? '' : 's'}</div>${hits.map(rowHtml).join('')}` : `<div class="noresults">Nada con «${esc(q)}». Probá otra palabra.</div>`;
    }
    function renderLayer() {
      const L = $('layer'); if (!L) return; const k = S.layerKind;
      if (!k) { L.innerHTML = ''; return; }
      if (k === 'cart') L.innerHTML = `<div class="scrim" data-act="cartclose"></div><div class="sheet" role="dialog" aria-label="Tu pedido" style="padding-bottom:0"><div class="grab"></div>${cartInner()}</div>`;
      else if (k === 'menu') { const total = sections.reduce((a, s) => a + s.items.length, 0); L.innerHTML = `<div class="scrim" data-act="lclose"></div><div class="sheet" role="dialog" aria-label="Menú completo"><div class="grab"></div><div class="sheethead"><div><h2>Menú</h2><small>${isOpen() ? 'Abierto hoy · cierra ' + esc(closesText()) : 'Cerrado · ' + esc(opensText())} · ${total} platos</small></div><button class="iconbtn" data-act="lclose" aria-label="Cerrar">${IC.close}</button></div><nav aria-label="Secciones">${sections.map((s) => `<button class="navrow${s.id === S.activeSec ? ' on' : ''}" data-act="goto" data-goto="${esc(s.id)}">${esc(s.name)}<span>${s.items.length}</span></button>`).join('')}</nav></div>`; }
      else if (k === 'ssearch') { L.innerHTML = `<div class="search" role="dialog" aria-label="Buscar en el menú"><div class="searchbar"><label for="sq">${IC.search}<input id="sq" type="search" placeholder="Buscar platos" autocomplete="off" data-field="sq"></label><button class="textbtn" data-act="lclose">Cancelar</button></div><div class="results" id="sresults"></div></div>`; runStoreSearch(''); }
    }

    function render() {
      app.classList.toggle('narrow', app.clientWidth > 0 && app.clientWidth < 375);
      app.innerHTML = `<div class="screen">${storeHtml()}</div>${detailSkeleton()}<div class="layer" id="layer"></div>`;   // the prototype's mount (render())
      wireStore(); renderLayer();
      if (S.open) { renderDetail(); $('detail-overlay').classList.add('open'); $('detail-modal').classList.add('open'); $('detail-modal').setAttribute('aria-hidden', 'false'); }
    }
    function onClick(ev) {
      const t = ev.target.closest && ev.target.closest('[data-act]'); if (!t || !app.contains(t)) return;
      const act = t.dataset.act, id = t.dataset.id;
      if (S.open && ['qty', 'extra', 'variant', 'staged', 'dcta'].includes(act)) { detailAct(t); return; }
      if (act === 'dclose') { closeDetail(); return; }
      if (act === 'inc') { const it = find(id); if (it && it.group) { openDetail(id); return; } if (it && it.sold) return; if (mutate(() => cart.inc(id))) { S.expanded.add(id); bumpPill(); } renderStoreKeep(); return; }
      if (act === 'dec') { const it = find(id); if (it && it.group) { S.layerKind = 'cart'; renderLayer(); return; } mutate(() => cart.dec(id)); renderStoreKeep(); return; }
      if (act === 'badge') { S.expanded.add(id); renderStoreKeep(); return; }
      if (act === 'open') { openDetail(id); return; }
      if (act === 'pill') { S.layerKind = 'cart'; renderLayer(); return; }
      if (act === 'cartclose' || act === 'lclose') { S.layerKind = null; S.cartNote = null; renderLayer(); return; }
      if (act === 'rev') { const k = t.dataset.key, g = t.dataset.grp || ''; mutate(() => (Number(t.dataset.rev) > 0 ? cart.lineInc(k, g) : cart.lineDec(k, g))); renderStoreKeep(); S.layerKind = 'cart'; renderLayer(); return; }
      if (act === 'edit') { S.layerKind = null; renderLayer(); openEdit(t.dataset.key, t.dataset.grp || ''); return; }
      if (act === 'mode') { S.mode = t.dataset.val; renderStoreKeep(); return; }
      if (act === 'jump') { jumpTo(t.dataset.jump); return; }
      if (act === 'menu') { S.layerKind = 'menu'; renderLayer(); return; }
      if (act === 'goto') { S.layerKind = null; renderLayer(); jumpTo(t.dataset.goto); return; }
      if (act === 'ssearch') { S.layerKind = 'ssearch'; renderLayer(); return; }
      if (act === 'back') { emit('back'); return; }
      if (act === 'checkout') { let body = null; try { body = CappSerialize.serialize(cart, menu); } catch (e) { S.refusal = e && e.code === 'cart_text_too_long' ? FULL_CART : null; renderLayer(); return; } emit('checkout', { body, mode: S.mode }); return; }
      if (act === 'closed-sched') { emit('schedule'); return; }
    }
    function onInput(ev) { const t = ev.target; if (t && t.dataset && t.dataset.field === 'sq') runStoreSearch(t.value); }

    app.classList.add('app');
    doc.addEventListener('click', onClick);
    doc.addEventListener('input', onInput);
    render();
    return {
      cart, menu, render, state: S,
      restore(snapshot) { const r = cart.hydrate(snapshot); S.cartNote = r.dropped || null; render(); return r; },
      destroy() { doc.removeEventListener('click', onClick); doc.removeEventListener('input', onInput); },
    };
  }

  return { mount, FULL_CART };
});
