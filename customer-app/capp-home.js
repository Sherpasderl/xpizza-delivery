// Customer app S7a-2 (PLAN-capp-S7a r1 §2 + r2 §2 + r3.3, APPROVED; MOCKUP-capp-S7a-states frames 1–9, APPROVED 2026-10-27) —
// INICIO and BUSCAR, ported from the frozen prototype APPROVED-v6 (homeHtml P:1523-1560, searchHtml P:1563-1575, rcardHtml,
// tabbarHtml, the v6 cuisine icons P:1406-1478) onto the directory (capp-directory) and the shared menu cache (capp-menu-cache).
// Pure HTML from a view model, no DOM — the shell (capp-shell-ui) owns state and wiring. Brand-agnostic: every store difference
// is DATA (no restaurant id or name in this file — guarded). DARK: only the undeployed shell page loads it.
//
// S5-absent (no order statistics yet, r1 §2.4): «Lo más pedido», reorder counts, likes and «#1 en …» are not drawn (nothing
// invented); «Destacados» says «Abiertos ahora y para pedir hoy» (frame 5 A) and orders open first, then the directory order.
// House: `house` absent ⇒ the catalog-tag fallback (signature / chefs_pick / must_try with a photo); `house: []` ⇒ hidden; a
// list ⇒ those canonical dish ids, the ones the LOADED menu lacks dropped (r3 §5). Rows hide below 2 entries (P).
// Fees: only a `priced` fee is drawn («Envío desde L X»); anything else draws no fee text — never «Envío gratis» / L 0. The
// free-delivery promotion is a MEMBER price (P feeFree); while auth is unresolved neither the member nor the guest variant shows.
// Approved states: 1 loading line · 2 zero stores · 3 B all closed (its 2nd sentence only while scheduling is live) · 4 all out
// of zone · 6 dishes loading · 7 directory error · 8 search partial (never «No encontramos» over a partial) · 9 partial directory.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappHome = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const money = (n) => 'L ' + Math.round(n).toLocaleString('en-US');
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtT = (h, m) => `${((h + 11) % 12) + 1}:${pad2(m)} ${h < 12 ? 'a.m.' : 'p.m.'}`;
  const fmtMin = (mins) => fmtT(Math.floor(mins / 60) % 24, mins % 60);
  const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

  // ── icons (the prototype's IC, verbatim) ──
  const I = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const IC = {
    chev: I('<path d="M9 6l6 6-6 6"/>'), down: I('<path d="M6 9l6 6 6-6"/>'), search: I('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
    home: I('<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/>'), bag: I('<path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
    user: I('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'), receipt: I('<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6"/><path d="M9 12h6"/>'),
    pin: I('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="2.6"/>'),
    store: I('<path d="M4 9.5V20a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9.5"/><path d="M2.5 9.5 4.1 4a1 1 0 0 1 1-.7h13.8a1 1 0 0 1 1 .7l1.6 5.5a2.5 2.5 0 0 1-4.8 1.2 2.5 2.5 0 0 1-4.8 0 2.5 2.5 0 0 1-4.8 0 2.5 2.5 0 0 1-4.8-1.2Z"/><path d="M9 21v-5h6v5"/>'),
    clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'), info: I('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'),
    alert: I('<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>'),
    bike: I('<circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M8.5 17h7"/><path d="M14 6h3l2.5 8.5"/><path d="M4 11h7l2 6"/>'),
    locoff: I('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><path d="M4 4l16 16"/>'), nav: I('<path d="M12 3l8 18-8-4-8 4z"/>'),
    plus: I('<path d="M12 5v14"/><path d="M5 12h14"/>'), close: I('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
    bell: I('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>'),   // G7 (the approved mockup's)
    out: I('<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5"/><path d="M14 16l4-4-4-4"/><path d="M18 12H9"/>'),
    phone: I('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 17h2"/>'),
    check: I('<path d="m5 12.5 4.5 4.5L19 7.5"/>'), help: I('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7"/><path d="M12 17h.01"/>'),
    pinfill: '<svg width="38" height="38" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/></svg>',
  };
  // the Sola compass (Sherpa-owned shell only; never on a restaurant surface) — P:1217
  const SOLA = (size = 22, n = '#2F5FB8', m = 'currentColor') => `<svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 9.2A14.8 14.8 0 1 1 24 38.8A14.8 14.8 0 1 1 24 9.2" stroke="${m}" stroke-width="3.4" fill="none"/><path d="M24 12.6L27.3 24L20.7 24Z" fill="${n}"/><path d="M27.3 24L24 31.6L20.7 24Z" fill="${m}"/><circle cx="24" cy="24" r="1.7" fill="var(--bg)"/></svg>`;

  // ── the v6 cuisine icons (P:1406-1478, verbatim; labels come from the platform taxonomy, never from here) ──
  const cuisP = (d, k, o = {}) => ({ t: 'p', d, k, ...o });
  const cuisC = (cx, cy, r, k, o = {}) => ({ t: 'c', cx, cy, r, k, ...o });
  const cuisE = (cx, cy, rx, ry, k, o = {}) => ({ t: 'e', cx, cy, rx, ry, k, ...o });
  const cuisS = (d, k, s, o = {}) => ({ t: 'p', d, k, s, ...o });   // stroke part
  const CUIS_GEO = {
    todo: { label: 'Todo', tint: 'cool', parts: [   // fork-and-knife monogram: a neutral, elegant mark instead of a plate
      cuisP('M19.5 9.5c-3.5 7-3.5 14 .5 21h4.5v-21z', 'slate', { tint: true }), cuisP('M21.5 30.5h3v14.5a1.5 1.5 0 0 1-3 0z', 'ink'),
      cuisP('M30.5 9.5v9.5c0 3.5 1.6 5.5 3.5 6v20.5a1.5 1.5 0 0 0 3 0V25c1.9-.5 3.5-2.5 3.5-6V9.5h-2.2v9h-1.4v-9h-2.2v9h-1.4v-9z', 'slate'),
      cuisE(21, 14, 1.2, 3, 'white', { hl: true }) ] },
    pizza: { label: 'Pizza', tint: 'warm', parts: [
      cuisP('M28 46L13 19Q28 11 43 19z', 'cheese', { tint: true }),
      cuisP('M12 20Q28 10 44 20L42.2 23.5Q28 15.2 13.8 23.5z', 'crust'),
      cuisP('M28 46L13 19Q20 15 28 14z', 'ink', { shade: true }),
      cuisC(24, 25, 3, 'coral'), cuisC(33, 28, 3, 'coral'), cuisC(28, 35.5, 2.5, 'coral'),
      cuisE(21.5, 32, 2.6, 1.5, 'green', { detail: true }),
      cuisE(24, 20, 5, 2.4, 'white', { hl: true }) ] },
    italiana: { label: 'Italiana', tint: 'warm', parts: [
      cuisE(27, 37, 17, 7, 'cream', { tint: true }), cuisP('M10 37a17 7 0 0 0 34 0a17 7 0 0 1-34 0z', 'ink', { shade: true }),
      cuisE(27, 34, 11, 5.6, 'cheese'),
      cuisS('M18.5 32.5q4-4 8 0t8 0', 'crust', 1.9), cuisS('M18 35.8q4.5-3 9 0t9 0', 'crust', 1.9), cuisS('M20 30q4-2.5 8 0t8 0', 'crust', 1.4, { detail: true }),
      cuisS('M40 13L34.5 27.5', 'slate', 2), cuisS('M37.5 9.5v5M40 9v5M42.5 9.5v5', 'slate', 1.4), cuisS('M37 14.5h6', 'slate', 1.4),
      cuisE(20, 32, 5, 2, 'white', { hl: true }) ] },
    asiatica: { label: 'Asiática', tint: 'cool', parts: [
      cuisP('M12 28H44C44 40 38 46 28 46C18 46 12 40 12 28z', 'slate', { tint: true }),
      cuisP('M28 46C38 46 44 40 44 28H40C40 38 35 44 28 46z', 'ink', { shade: true }),
      cuisE(28, 28, 16, 3.2, 'cream'),
      cuisS('M33 8L23.5 29', 'crust', 2), cuisS('M39.5 10L30 31', 'crust', 2),
      cuisS('M22 22c-1.5-3 1.5-4 0-7', 'slate2', 1.5, { detail: true }), cuisS('M28 21c-1.5-3 1.5-4 0-7', 'slate2', 1.5, { detail: true }),
      cuisE(20, 33, 4, 2.4, 'white', { hl: true }) ] },
    mariscos: { label: 'Mariscos', tint: 'rose', parts: [
      cuisP('M11 28C16 19 26 16 36 22C32 26 32 30 36 34C26 40 16 37 11 28z', 'coral', { tint: true }),
      cuisP('M36 22L46 15L44 28L46 41L36 34C33 31 33 25 36 22z', 'coral'),
      cuisP('M36 22C32 26 32 30 36 34C26 40 16 37 11 28C14 32 24 36 36 34z', 'ink', { shade: true }),
      cuisS('M21 21q4-5 9-2', 'cream', 1.5, { detail: true }), cuisC(18.5, 26.5, 1.7, 'ink'),
      cuisE(19, 24, 5, 2.4, 'white', { hl: true }) ] },
    cafe: { label: 'Café', tint: 'warm', parts: [
      cuisE(26, 44, 15, 3.4, 'slate2'),
      cuisP('M14 24H36V33A8 8 0 0 1 28 41H22A8 8 0 0 1 14 33z', 'white', { tint: true }),
      cuisP('M36 24V33A8 8 0 0 1 28 41H24C31 41 32 37 32 33V24z', 'ink', { shade: true }),
      cuisE(25, 24, 11, 2.6, 'coffee'), cuisS('M36.5 27.5a5 5 0 0 1 0 10', 'slate', 2.4),
      cuisS('M21 18c-1.5-3 1.5-4 0-7', 'slate2', 1.5, { detail: true }), cuisS('M28 18c-1.5-3 1.5-4 0-7', 'slate2', 1.5, { detail: true }),
      cuisE(19, 30, 3, 4, 'white', { hl: true }) ] },
    desayuno: { label: 'Desayuno', tint: 'warm', parts: [
      cuisC(25, 31, 13, 'ink'), cuisC(25, 31, 10.6, 'slate', { tint: true }), cuisS('M37.5 27.5L49 22.5', 'ink', 3.6),
      cuisP('M19 27c2-6 11-7 14-2c3 4 3 10-3 11c-5 1-12-2-11-9z', 'cream'),
      cuisP('M33 25c3 4 3 10-3 11c-3 .6-6 0-8-1c4 1 9 0 10-4c1-3 1-4 1-6z', 'ink', { shade: true }),
      cuisC(26, 30, 3.6, 'ochre'), cuisE(24, 28.5, 1.4, .9, 'white', { hl: true }) ] },
    hamburguesas: { label: 'Hamburguesas', tint: 'warm', parts: [
      cuisP('M13 26C13 14 43 14 43 26z', 'crust', { tint: true }), cuisP('M43 26C43 20 37 15.5 30 14.6C38 16 41 21 41 26z', 'ink', { shade: true }),
      cuisC(22, 20, 1.1, 'cream', { detail: true }), cuisC(28, 18, 1.1, 'cream', { detail: true }), cuisC(34, 20, 1.1, 'cream', { detail: true }),
      cuisP('M12 28q4 3 8 0t8 0t8 0t8 0v3H12z', 'green'), cuisP('M13 31h30v5a2.5 2.5 0 0 1-2.5 2.5h-25A2.5 2.5 0 0 1 13 36z', 'brown'),
      cuisP('M13 38.5H43V40A5 5 0 0 1 38 45H18A5 5 0 0 1 13 40z', 'crust'),
      cuisE(22, 19, 5, 2.4, 'white', { hl: true }) ] },
    pollo: { label: 'Pollo', tint: 'cool', parts: [
      cuisP('M16 20C10 28 14 40 26 40C34 40 40 34 36 26C32 18 22 14 16 20z', 'crust', { tint: true }),
      cuisP('M26 40C34 40 40 34 36 26C34 22 30 19 26 17C31 20 35 24 34 30C33 36 28 39 22 39.5z', 'ink', { shade: true }),
      cuisS('M34 32L44 42', 'white', 4.2), cuisC(45.5, 40.5, 3.1, 'white'), cuisC(41.5, 45.5, 3.1, 'white'),
      cuisE(19, 25, 4, 3, 'white', { hl: true }) ] },
    postres: { label: 'Postres', tint: 'rose', parts: [
      cuisP('M17 32H39L36.5 46H19.5z', 'blue', { tint: true }), cuisP('M39 32L36.5 46H31L33 32z', 'ink', { shade: true }),
      cuisS('M23 34l-1 10M28 34v10M33 34l1 10', 'ink', 1.2, { detail: true }),
      cuisP('M15 32C13 24 20 21 23 24C25 17 33 17 35 24C38 21 44 24 41 32z', 'cream'),
      cuisC(28, 19.5, 2.8, 'coral'), cuisS('M28 16.5q2-3 4.5-3', 'green', 1.5),
      cuisE(21, 26, 4, 2.4, 'white', { hl: true }) ] },
    bebidas: { label: 'Bebidas', tint: 'cool', parts: [
      cuisP('M18 15H38L35 44H21z', 'white', { tint: true }), cuisP('M19.4 29H36.6L35 44H21z', 'blue'),
      cuisP('M38 15L35 44H30L32.5 15z', 'ink', { shade: true }),
      cuisS('M32.5 8.5L26.5 30', 'coral', 2.2), cuisP('M25.5 33.5l4.5-1.2l1.2 4.5l-4.5 1.2z', 'cream', { detail: true }),
      cuisE(22.5, 21, 2, 4, 'white', { hl: true }) ] },
  };
  const CUIS_PAL = { cheese: '#E2C47F', crust: '#C68F64', green: '#8E9B72', coral: '#D4836D', cream: '#F4ECDC', white: '#FFFFFF', slate: '#6E7B8B', slate2: '#A3AFBC', ink: '#4A4541', ochre: '#D9B35D', blue: '#A9BCD0', brown: '#7D5A46', coffee: '#6F4E3A' };
  const cuisPart = (p) => { const geo = p.t === 'c' ? `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}"` : p.t === 'e' ? `<ellipse cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${p.ry}"` : `<path d="${p.d}"`; if (p.hl) return ''; if (p.shade) return `${geo} fill="#000" opacity=".09"/>`; if (p.s) return `${geo} fill="none" stroke="${CUIS_PAL[p.k]}" stroke-width="${p.s}" stroke-linecap="round" stroke-linejoin="round"/>`; return `${geo} fill="${CUIS_PAL[p.k]}"/>`; };
  const CUIS = Object.fromEntries(Object.entries(CUIS_GEO).map(([k, v]) => [k, { label: v.label, icon: `<svg viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="28" fill="var(--a-${v.tint})"/>${v.parts.map(cuisPart).join('')}</svg>` }]));

  // ── hours (the store config's [h1,m1,h2,m2] per weekday, on the injected clock — capp-ui's own rules) ──
  const clockOf = (now) => ({ min: now.getHours() * 60 + now.getMinutes(), day: now.getDay() });
  const rangeOf = (cfg, day) => { const h = cfg && cfg.hours && cfg.hours[day]; return h ? [h[0] * 60 + h[1], h[2] * 60 + h[3]] : null; };
  const isOpen = (cfg, now) => { const c = clockOf(now), o = rangeOf(cfg, c.day); return !!o && c.min >= o[0] && c.min < o[1]; };
  const closesText = (cfg, now) => { const o = rangeOf(cfg, clockOf(now).day); return o ? fmtMin(o[1]) : ''; };
  const opensText = (cfg, now) => { const c = clockOf(now), o = rangeOf(cfg, c.day); if (o && c.min < o[0]) return 'Abre hoy ' + fmtMin(o[0]); for (let d = 1; d <= 7; d++) { const oo = rangeOf(cfg, (c.day + d) % 7); if (oo) return 'Abre ' + (d === 1 ? 'mañana' : 'el ' + DAYS[(c.day + d) % 7]) + ' ' + fmtMin(oo[0]); } return 'Cerrado por ahora'; };
  // S4 (read only under schedulingLive): «Programar pedido» only when the SERVED schedule offers a slot — the picker's own generator
  // (CappSchedule), so the cue never promises a slot the picker would not show
  const schedMod = () => (typeof self !== 'undefined' && self.CappSchedule) || require('./capp-schedule.js');
  const hasSlot = (cfg, now) => { const K = schedMod(), ms = typeof now === 'number' ? now : now.getTime(); return !!cfg && (K.slots(cfg.schedule, ms, 'pickup').length > 0 || K.slots(cfg.schedule, ms, 'delivery').length > 0); };

  // ── the store as the prototype's `r`: directory entry (presentation) + its CappUI config + its displayed menu (if loaded) ──
  function storeOf(row) {
    const e = row.entry || {}, cfg = row.cfg || {};
    return { id: row.rid, name: e.name || '', kicker: e.kicker || '', logo: cfg.logo || '', logoWide: cfg.logoWide === true, hero: cfg.hero || '',
      cuisines: Array.isArray(e.cuisines) ? e.cuisines : [], etaDel: cfg.etaDel || null, etaPick: cfg.etaPick || null, pickup: e.pickup === true, cfg,
      fee: e.fee || null, promo: e.promo || null, house: Array.isArray(e.house) ? e.house : null, meals: e.meals && typeof e.meals === 'object' ? e.meals : {},
      sections: row.view ? row.view.sections : null, menuState: row.menuState || null, gone: row.gone === true, held: row.held === true, sold: row.sold || null };
  }
  // fees (Sherpa data): a PRICED fee only; the promotion is the member's price (P feeFree), never assumed while auth is unresolved
  const priced = (r) => !!r.fee && r.fee.state === 'priced' && Number.isInteger(r.fee.from_cents) && r.fee.from_cents >= 0;
  // a promotional claim needs a PRICED fee too (Codex s7a2 r1 #7): no verified price ⇒ no «Envío gratis» of any kind
  const promoOn = (r) => priced(r) && !!(r.promo && r.promo.free_delivery);
  const feeFree = (r, auth) => promoOn(r) && auth === 'member';
  const feeHtml = (r, auth) => (feeFree(r, auth) ? '<span class="free">Envío gratis</span>' : priced(r) ? 'Envío desde ' + money(r.fee.from_cents / 100) : '');
  const dishPrice = (it) => (it.group ? 'desde ' + money(Math.min(...it.group.choices.map((c) => c.p))) : money(it.p));
  const items = (r) => (r.sections ? r.sections.flatMap((s) => s.items) : []);
  // «Buen precio»: the platform's median rule (P isValue) — only once the store's menu is loaded and the platform sets it
  const isValue = (r, platform) => {
    const cap = platform && platform.value && Number.isInteger(platform.value.median_up_to_cents) ? platform.value.median_up_to_cents / 100 : null;
    if (cap === null || !r.sections) return false;
    const ps = items(r).map((it) => (it.group ? Math.min(...it.group.choices.map((c) => c.p)) : it.p)).sort((a, b) => a - b);
    return ps.length > 0 && ps[Math.floor(ps.length / 2)] <= cap;
  };
  const HOUSE_TAGS = ['signature_special', 'chefs_pick', 'must_try'];
  // «La casa recomienda» across stores (P houseDishes, the S5 `pop` exclusion skipped until S5): up to 4 a store, 12 in all
  const houseDishes = (stores) => stores.flatMap((r) => {
    if (!r.sections || (r.house && !r.house.length)) return [];
    const all = items(r).filter((x) => x.img);
    const picks = r.house ? all.filter((x) => r.house.includes(x.dish)) : all.filter((x) => (x.tags || []).some((t) => HOUSE_TAGS.includes(t)));
    return picks.slice(0, 4).map((it) => ({ r, it }));
  }).slice(0, 12);
  // the platform's «moments» (P mealDishes): a store's sections carry a moment id (its presentation `meals`); the title is Sherpa's
  const mealDishes = (stores, meal) => stores.flatMap((r) => (r.sections || []).filter((s) => r.meals[s.id] === meal).flatMap((s) => s.items.filter((it) => it.img).map((it) => ({ r, it })))).slice(0, 10);
  const initials = (name) => esc(String(name).split(' ').map((x) => x[0]).join('').slice(0, 2));
  const logoChip = (r, cls) => (r.logo ? `<span class="${cls}${r.logoWide ? ' wide' : ''}"><img src="${esc(r.logo)}" alt=""></span>` : `<span class="${cls} txt" aria-hidden="true">${initials(r.name)}</span>`);
  const heroImg = (r, lazy) => (r.hero ? `<img src="${esc(r.hero)}" alt=""${lazy ? ' loading="lazy"' : ''}>` : '');
  const city = (platform) => (platform && typeof platform.city_label === 'string' && platform.city_label ? platform.city_label : '');
  // a row's entry state (r3.3-F1): gone ⇒ disabled in place; held ⇒ the drawn pressed state while its verification is awaited
  const rowAttrs = (r) => `${r.gone ? ' disabled aria-disabled="true"' : ''}`;
  const rowCls = (r) => `${r.gone ? ' gone' : ''}${r.held ? ' held' : ''}`;

  // «Pedidos» (PLAN-capp-desktop-website r2 D-3 / Gates, advisor ruling): NO approved orders-list screen exists, so no control may
  // lead to one — the tab, the desknav entry and both Cuenta rows are left out (a control without effect is never shipped). An
  // orders screen = an owner mockup + a handler, and then this flips (the controls come back exactly as drawn)
  const ORDERS_SCREEN = false;
  // ── the shell chrome (P tabbarHtml / desknavHtml; entry 'app') ──
  function tabbarHtml(vm) {
    const cur = (id) => vm.tab === id;
    const t = (id, label, ic, extra = '') => `<button data-act="tab" data-tab="${id}" aria-current="${cur(id)}" aria-label="${label}">${ic}<span>${label}</span>${extra}</button>`;
    const badge = vm.cartN ? `<i class="badge" aria-hidden="true">${vm.cartN}</i>` : vm.live ? '<i class="badge dot" aria-hidden="true"></i>' : '';
    return `<nav class="tabbar" aria-label="Navegación">${t('home', 'Inicio', IC.home)}<button class="search" data-act="tab" data-tab="search" aria-current="${cur('search')}">${IC.search}<span>Buscar</span></button>${ORDERS_SCREEN ? t('orders', 'Pedidos', IC.receipt, badge) : ''}${t('account', 'Cuenta', IC.user)}</nav>`;
  }
  function desknavHtml(vm) {
    const t = (id, label) => `<button class="nb" data-act="tab" data-tab="${id}" aria-current="${vm.tab === id}">${label}</button>`;
    return `<div class="desknav"><span class="lock">${SOLA(22, 'var(--acc)')}Sherpa</span>${t('home', 'Inicio')}${t('search', 'Buscar')}${ORDERS_SCREEN ? t('orders', 'Pedidos') : ''}${t('account', 'Cuenta')}<span class="sp"></span><span class="mute" style="font-size:13px">${esc(city(vm.platform))}</span></div>`;
  }
  const shellWrap = (vm, inner) => `${desknavHtml(vm)}${inner}${tabbarHtml(vm)}`;

  // ── INICIO ──
  function rcardHtml(r, vm) {
    const now = vm.now, auth = vm.auth, open = !r.gone && isOpen(r.cfg, now);
    // the guest-only pill is reserved (hidden) while auth is unresolved, so its line never appears under a finger
    const deal = promoOn(r) && auth !== 'member' ? `<span class="pill deal"${auth === 'guest' ? '' : ' style="visibility:hidden" aria-hidden="true"'}>Envío gratis con tu cuenta</span>` : '';
    const pills = open ? [isValue(r, vm.platform) ? '<span class="pill value">Buen precio</span>' : '', deal].filter(Boolean).join('') : '';
    const fee = feeHtml(r, auth);
    return `<button class="rcard${open ? '' : ' closed'}${rowCls(r)}" data-act="open-store" data-rid="${esc(r.id)}" aria-label="${esc(r.name)}${open ? '' : ', cerrado'}"${rowAttrs(r)}>
    <span class="ph">${heroImg(r, true)}${logoChip(r, 'logo')}</span>
    <span class="rt"><span class="nm">${esc(r.name)}</span>${open && r.etaDel ? `<span class="eta">${r.etaDel[0]}–${r.etaDel[1]} min</span>` : ''}</span>
    ${open ? `<span class="meta"><span class="dot"></span><b>Abierto</b> · cierra ${esc(closesText(r.cfg, now))}${fee ? ` · ${fee}` : ''}</span>`
      : `<span class="closedline"><span class="dot off"></span>Cerrado · ${esc(opensText(r.cfg, now))}${vm.schedulingLive && !r.gone && hasSlot(r.cfg, now) ? '<span class="lnk">Programar pedido</span>' : ''}</span>`}
    ${pills ? `<span class="pills">${pills}</span>` : ''}
  </button>`;
  }
  const dcard = ({ r, it }) => `<button class="dcard" data-act="open-dish" data-rid="${esc(r.id)}" data-id="${esc(it.id)}" aria-label="${esc(it.n)} · ${esc(r.name)}"${rowAttrs(r)}><span class="ph"><img src="${esc(it.img)}" alt="" loading="lazy">${logoChip(r, 'lg')}</span><span class="nm">${esc(it.n)}</span><span class="prrow"><span class="pr">${esc(dishPrice(it))}</span></span><span class="st">${esc(r.name)}</span></button>`;
  function scard(r, vm) {
    const open = !r.gone && isOpen(r.cfg, vm.now), pickup = vm.filters.has('pickup');
    const eta = open ? (pickup ? (r.etaPick ? `Listo en ≈ ${r.etaPick[1]} min` : '') : (r.etaDel ? `${r.etaDel[0]}–${r.etaDel[1]} min` : '')) : '';
    // a store with no drawable fee keeps its line box (a zero-width space), so a fee that arrives later never grows the card
    const fee = feeHtml(r, vm.auth);
    const line = open ? `<span>${fee || '​'}</span>` : `<span>Cerrado · ${esc(opensText(r.cfg, vm.now))}</span>`;
    const pills = [isValue(r, vm.platform) ? '<span class="pill value">Buen precio</span>' : '', !open && vm.schedulingLive && !r.gone && hasSlot(r.cfg, vm.now) ? '<span class="pill sched">Programar pedido</span>' : ''].filter(Boolean).join('');
    const deal = promoOn(r) && vm.auth === 'guest' ? '<span class="tag-deal">Envío gratis con tu cuenta</span>' : '';
    return `<div class="scard${open ? '' : ' closed'}${rowCls(r)}"><button class="ph" data-act="open-store" data-rid="${esc(r.id)}" aria-label="${esc(r.name)}${open ? '' : ', cerrado'}"${rowAttrs(r)}>${heroImg(r, true)}${deal}${logoChip(r, 'logo')}</button>
      <button class="rt" data-act="open-store" data-rid="${esc(r.id)}"${rowAttrs(r)}><span class="nm">${esc(r.name)}</span>${eta ? `<span class="eta">${eta}</span>` : ''}</button><div class="ln">${line}</div>${pills ? `<div class="pills">${pills}</div>` : ''}</div>`;
  }
  const sec = (title, sub, cards) => (cards.length < 2 ? '' : `<section class="hsec" aria-label="${esc(title)}"><div class="hd"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div><button class="nxt" data-act="rownext" aria-label="Ver más de ${esc(title)}">${IC.chev}</button></div><div class="hrow">${cards.join('')}</div></section>`);
  const emptyHtml = (icon, b, span, btn) => `<div class="empty">${IC[icon]}<b>${esc(b)}</b>${span ? `<span>${esc(span)}</span>` : ''}${btn ? `<button class="btn2" data-act="${btn[0]}">${esc(btn[1])}</button>` : ''}</div>`;
  function homeHead(vm) {
    const line = vm.addr && vm.addr.line ? vm.addr.line : 'Agregá tu dirección';
    const short = vm.addr && vm.addr.short ? vm.addr.short : 'Tu ubicación';
    const locrow = vm.locDenied ? `<div class="locrow">${IC.locoff}<span>Ubicación desactivada</span><button data-act="loc-on">Activar</button></div>` : '';
    return `<div class="home-head">
      <button class="addr-btn" data-act="addr" aria-label="Dirección de entrega: ${esc(line)}"><span><span class="k">Entregar en</span><span class="v"><span>${esc(short)}</span>${IC.down}</span></span></button>
      ${locrow}
    </div>`;
  }
  function homeHtml(vm) {
    const head = homeHead(vm);
    const all = (vm.rows || []).map(storeOf);
    const page = (body, credit) => shellWrap(vm, `<div class="scroller">${head}<div class="home-body">${body}</div>${credit || ''}</div>`);
    const c = city(vm.platform);
    if (!all.length) {
      if (vm.phase === 'error') return page(emptyHtml('alert', 'No pudimos cargar los restaurantes', 'Revisá tu conexión e intentá de nuevo.', ['dir-retry', 'Reintentar']));   // frame 7
      if (vm.phase !== 'ready') return page('<p class="note hload">Cargando restaurantes…</p>');   // frame 1
      return page(emptyHtml('store', 'Todavía no hay restaurantes aquí', c ? `Pronto vas a poder pedir en ${c}.` : ''));   // frame 2
    }
    if (vm.outOfZone) return page(emptyHtml('pin', 'Ningún restaurante entrega en esta dirección', 'Probá otra dirección o recogé en tienda.', ['addr', 'Cambiar dirección']));   // frame 4
    const live = all.filter((r) => !r.gone);
    const cuisine = vm.cuisine || '', F = vm.filters;
    const vis = all.filter((r) => (!cuisine || r.cuisines.includes(cuisine)) && (!F.has('open') || (!r.gone && isOpen(r.cfg, vm.now))) && (!F.has('free') || feeFree(r, vm.auth))
      && (!F.has('pickup') || r.pickup) && (!F.has('fast') || (r.etaDel && r.etaDel[0] <= 30)));
    const notes = [];
    if (vm.partial) notes.push(`<div class="closednote hnote">${IC.info}<span>Algunos restaurantes no cargaron.</span><button class="lnk" data-act="dir-retry">Reintentar</button></div>`);   // frame 9
    if (live.length && !live.some((r) => isOpen(r.cfg, vm.now))) notes.push(`<div class="closednote hnote">${IC.clock}<span>Ahora no hay restaurantes abiertos.${vm.schedulingLive ? ' Podés programar tu pedido.' : ''}</span></div>`);   // frame 3 B
    const tax = vm.platform && Array.isArray(vm.platform.cuisines) ? vm.platform.cuisines : [];
    const cuisineIds = tax.filter((x) => CUIS[x.id] && live.some((r) => r.cuisines.includes(x.id)));
    const cuisRow = cuisineIds.length ? `<div class="cuisrow" role="group" aria-label="Tipo de comida"><button class="cuis" aria-pressed="${!cuisine}" data-act="cuisine" data-val="">${CUIS.todo.icon}<span>Todo</span></button>${cuisineIds.map((x) => `<button class="cuis" aria-pressed="${cuisine === x.id}" data-act="cuisine" data-val="${esc(x.id)}">${CUIS[x.id].icon}<span>${esc(x.label)}</span></button>`).join('')}</div>` : '';
    const chips = [['open', 'Abierto ahora', IC.store, live.some((r) => isOpen(r.cfg, vm.now))], ['free', 'Envío gratis', IC.bike, live.some((r) => feeFree(r, vm.auth))],
      ['pickup', 'Pickup', IC.bag, live.some((r) => r.pickup && r.etaPick)], ['fast', 'Menos de 30 min', IC.clock, live.some((r) => r.etaDel && r.etaDel[0] <= 30)]].filter((x) => x[3]);   // only chips the data supports
    const fchips = chips.length ? `<div class="fchips" role="group" aria-label="Filtros">${chips.map(([k, l, ic]) => `<button class="fchip" aria-pressed="${F.has(k)}" data-act="filter" data-val="${k}">${ic}${l}</button>`).join('')}</div>` : '';
    const open = (r) => !r.gone && isOpen(r.cfg, vm.now);
    const featured = vis.map((r, i) => [r, i]).sort((a, b) => (open(b[0]) - open(a[0])) || (a[1] - b[1])).map(([r]) => r).slice(0, 10);
    const houseList = houseDishes(vis.filter((r) => !r.gone));
    const meals = vm.platform && vm.platform.meals ? Object.entries(vm.platform.meals).map(([k, title]) => [title, mealDishes(vis.filter((r) => !r.gone), k)]).filter(([, d]) => d.length >= 2) : [];
    const nLive = live.length;
    const rows = !vis.length ? `<div class="empty">${IC.search}<b>Nada con esos filtros</b><span>Probá con otro tipo de comida o quitá un filtro.</span><button class="btn2" data-act="clearfilters">Quitar filtros</button></div>`
      : sec('Destacados', 'Abiertos ahora y para pedir hoy', featured.map((r) => scard(r, vm)))
        + sec('La casa recomienda', [...new Set(houseList.map((x) => x.r.name))].join(' · '), houseList.map(dcard))
        + meals.map(([title, d]) => sec(title, [...new Set(d.map((x) => x.r.name))].join(' · '), d.map(dcard))).join('')
        + `<section class="hsec" aria-label="Todos los restaurantes"><div class="hd"><div><h2>Todos los restaurantes</h2><p>${vis.length === all.length ? (c ? `${nLive} en ${esc(c)}` : `${nLive} restaurantes`) : `${vis.filter((r) => !r.gone).length} de ${nLive}`}</p></div></div><div class="rlist" style="padding-top:0">${vis.map((r) => rcardHtml(r, vm)).join('')}</div></section>`;
    return page(notes.join('') + cuisRow + fchips + rows, `<div class="credit">${nLive} restaurantes${c ? ` en ${esc(c)}` : ''}</div>`);
  }

  // ── BUSCAR (P searchHtml): store hits from the directory at once; dish hits over the LOADED menus' DISPLAYED items (launchers
  //    priced «desde», never raw variant children), in directory → section → item order, capped at 12 ──
  // completeness also needs the DIRECTORY (Codex s7a2 r1 #9): a cold directory is still loading, and an errored or partial one may
  // be missing stores — never «No encontramos» over either
  function searchModel(rows, q, dirState) {
    const ds = dirState || { phase: 'ready', partial: false };
    const s = norm(String(q || '').trim());
    const all = (rows || []).map(storeOf).filter((r) => !r.gone);
    const settled = (r) => r.menuState === 'fresh' || r.menuState === 'stale' || r.menuState === 'presentation' || r.menuState === 'failed';
    const loading = ds.phase === 'cold' || all.some((r) => !settled(r));
    const complete = ds.phase === 'ready' && ds.partial !== true && all.every((r) => r.menuState === 'fresh');   // a stale / presentation / failed / missing menu ⇒ partial
    if (!s) return { q: s, stores: [], dishes: [], loading, complete, all };
    const stores = all.filter((r) => norm(r.name + ' ' + r.kicker).includes(s));
    const dishes = all.flatMap((r) => (r.sections || []).flatMap((sec) => sec.items.filter((it) => norm(it.n + ' ' + it.d).includes(s)).map((it) => ({ r, it })))).slice(0, 12);
    return { q: s, stores, dishes, loading, complete, all };
  }
  function srowR(r, vm) {
    const open = isOpen(r.cfg, vm.now);
    const st = open ? `abierto${r.etaDel ? ` · ${r.etaDel[0]}–${r.etaDel[1]} min` : ''}` : 'cerrado · ' + esc(opensText(r.cfg, vm.now)).toLowerCase();
    return `<button class="srow${rowCls(r)}" data-act="open-store" data-rid="${esc(r.id)}">${r.hero ? `<img src="${esc(r.hero)}" alt="">` : `<span class="noph" style="width:56px;height:56px;flex:none">${initials(r.name)}</span>`}<span class="t"><b>${esc(r.name)}</b><span>${r.kicker ? esc(r.kicker) + ' · ' : ''}${st}</span></span>${IC.chev}</button>`;
  }
  const srowD = ({ r, it }) => `<button class="srow" data-act="open-dish" data-rid="${esc(r.id)}" data-id="${esc(it.id)}">${it.img ? `<img src="${esc(it.img)}" alt="">` : `<span class="noph" style="width:56px;height:56px;flex:none">${esc(it.n[0])}</span>`}<span class="t"><b>${esc(it.n)}</b><span>${esc(r.name)}${it.d ? ' · ' + esc(it.d) : ''}</span></span><span class="pr">${esc(dishPrice(it))}</span></button>`;
  function searchHtml(vm) {
    const q = vm.q || '';
    const m = searchModel(vm.rows, q, { phase: vm.phase, partial: vm.partial });
    let body = '';
    if (!m.q) body = (vm.recent || []).length ? `<h3>Búsquedas recientes</h3><div class="recent">${vm.recent.map((x) => `<button class="chip" data-act="recent" data-q="${esc(x)}">${esc(x)}</button>`).join('')}</div>`
      : emptyHtml('search', 'Buscá restaurantes o platos', 'Tus búsquedas recientes van a aparecer aquí.');   // frame 18
    else if (m.loading && !m.dishes.length) {   // frame 6: stores at once; dishes pending (one quiet line)
      body = (m.stores.length ? `<h3>Restaurantes</h3>${m.stores.map((r) => srowR(r, vm)).join('')}` : '') + '<h3>Platos</h3><p class="note sload">Buscando platos…</p>';
    } else if (m.all.length && m.all.every((r) => r.menuState === 'failed')) {   // frame 16: no menu answered — the directory's matches, then the drawn block
      body = (m.stores.length ? `<h3>Restaurantes</h3>${m.stores.map((r) => srowR(r, vm)).join('')}` : '') + emptyHtml('alert', 'No pudimos buscar platos', 'Ningún menú cargó. Revisá tu conexión e intentá de nuevo.', ['menus-retry', 'Reintentar']);
    } else {
      const partialNote = !m.complete ? '<p class="note spart">Algunos menús no cargaron; puede haber más platos.</p>' : '';   // frame 8
      if (!m.stores.length && !m.dishes.length) {
        // «No encontramos» ONLY when every menu answered; over a partial the note and the restaurants instead
        body = m.complete ? `<div class="hint">No encontramos «${esc(q)}». Probá otra palabra, o mirá los restaurantes.</div><h3>Restaurantes</h3>${m.all.map((r) => srowR(r, vm)).join('')}`
          : `${partialNote}<h3>Restaurantes</h3>${m.all.map((r) => srowR(r, vm)).join('')}`;
      } else body = partialNote + (m.stores.length ? `<h3>Restaurantes</h3>${m.stores.map((r) => srowR(r, vm)).join('')}` : '') + (m.dishes.length ? `<h3>Platos</h3>${m.dishes.map(srowD).join('')}` : '');
    }
    return shellWrap(vm, `<div class="searchbar"><label for="gq">${IC.search}<input id="gq" type="search" placeholder="Restaurantes o platos" autocomplete="off" value="${esc(q)}" data-field="q"></label>${q ? '<button class="textbtn" data-act="clearq">Borrar</button>' : ''}</div><div class="results" id="results">${body}</div>`);
  }


  // ── the guest location layers (P addrSheet :2179-2184 guest rows, the location soft-ask :1766, the full-screen pin step :2186 / capp-ui
  //    pinStepHtml — its store-free sentence; the map is the drawn schematic with a live map inside when a Maps key is configured) ──
  const addrSheetHtml = () => `<div class="scrim" data-act="lclose"></div><div class="sheet" role="dialog" aria-label="Dirección de entrega"><div class="grab"></div><div class="sheethead"><div><h2>Entregar en</h2><small>La zona de cada restaurante se revisa con esta dirección.</small></div><button class="iconbtn" data-act="lclose" aria-label="Cerrar">${IC.close}</button></div>
    <nav><button class="navrow" data-act="loc-use">${IC.nav.replace('class="i"', 'class="i" style="margin-right:10px"')}Usar mi ubicación actual<span></span></button><button class="navrow" data-act="addr-new">${IC.plus.replace('class="i"', 'class="i" style="margin-right:10px"')}Agregar dirección<span></span></button></nav></div>`;
  const softaskHtml = () => `<div class="scrim" data-act="lclose"></div><div class="sheet" role="dialog" aria-label="Ubicación"><div class="grab"></div><div class="softask"><div class="ill">${IC.pin}</div><h2>Encontrá restaurantes cerca de vos</h2><p>Usamos tu ubicación solo para mostrarte quién te entrega y poner el pin donde estás.</p><div class="acts"><button class="primary" data-act="loc-allow">Usar mi ubicación</button><button class="btn2 wide" data-act="loc-deny">Escribir mi dirección</button></div></div></div>`;
  const pinEditorHtml = (mapSvg, live) => `<div class="pinstep" role="dialog" aria-label="Confirmá dónde entregamos"><div class="mapwrap">${mapSvg || ''}${live ? '<div class="gmap" data-gmap="pin" style="position:absolute;inset:0"></div>' : ''}<div class="store-nav" style="position:absolute"><button class="iconbtn" data-act="lclose" aria-label="Cancelar">${IC.close}</button><span></span></div><div class="hint">Mové el mapa hasta que el pin quede en tu puerta</div><span class="pin">${IC.pinfill}</span></div>
    <div class="foot"><b>Confirmá dónde entregamos</b><span class="sub">Las direcciones aquí se describen con referencias: el pin es la dirección, los detalles son la referencia.</span><button class="primary" data-act="pin-done">Listo</button></div></div>`;

  // frame 11 (approved 2026-10-27): the NEUTRAL return surface — a hosted-checkout return this phone cannot tie to one store's
  // records: no store is mounted or mutated, no tab bar; one .empty block; «Ir a Inicio»
  const neutralReturnHtml = (order) => `<div class="scroller"><div class="empty neutral">${IC.receipt}<b>No encontramos este pedido en este teléfono</b><span>Si ya pagaste, tu pago no se pierde. Escribinos con tu número de pedido y lo revisamos.</span>${order ? `<p class="note">Pedido #${esc(order)}</p>` : ''}<button class="btn2" data-act="neutral-home">Ir a Inicio</button></div></div>`;

  // PLAN-capp-signin-required r5.4 frame 5b (approved): the GUEST's Cuenta tab — the shell's .guestcard with ONE primary «Entrá o creá
  // tu cuenta» and three benefits; «Pedidos» (this phone's) and «Ayuda» stay. While auth is unresolved the card keeps its geometry,
  // hidden (never shown as guest before the SDK says so)
  function accountGuestHtml(vm) {
    const known = vm.auth === 'guest';
    return shellWrap(vm, `<div class="flow"><div class="flowbar plain"><h1>Cuenta</h1></div>
    <div class="guestcard"${known ? '' : ' style="visibility:hidden" aria-hidden="true"'}><h2>Tu cuenta</h2>
      <ul><li>${IC.check}<span>Efectivo al entregar o al recoger</span></li><li>${IC.check}<span>Recompensas, promos y envío gratis</span></li><li>${IC.check}<span>Programá pedidos y guardá tu dirección</span></li></ul>
      ${known ? '<button class="primary" data-act="signin" data-ctx="account">Entrá o creá tu cuenta</button>' : '<span class="primary" aria-hidden="true">Entrá o creá tu cuenta</span>'}</div>
    <div class="rows">${ORDERS_SCREEN ? `<button class="rowbtn" data-act="tab" data-tab="orders">${IC.bag}<span class="t">Pedidos<span>Los de este teléfono</span></span>${IC.chev}</button>` : ''}<button class="rowbtn" data-act="help">${IC.help}<span class="t">Ayuda</span>${IC.chev}</button></div></div>`);
  }

  // G7 (MOCKUP-capp-member-cuenta-APPROVED-2026-10-27, frames 1 / 1b / 4a / 4b): the MEMBER's Cuenta — .acct-hero (name, phone and
  // email on three lines; the initial in the avatar), Pedidos / Promociones (.switch) / Ayuda, the session group, the muted version.
  // vm.acct = { placeholder, name, phone, email, promos: true | false | null (no served value ⇒ inert, frame 4b), settled, version } — inert and
  // still loading ⇒ frame 4b's ON-dimmed placeholder; inert and SETTLED (no stored consent) ⇒ OFF + dimmed (ruling (ii), OWNER-PENDING)
  function accountMemberHtml(vm) {
    const a = vm.acct || {}, inert = typeof a.promos !== 'boolean';
    const hero = a.placeholder
      ? '<div class="acct-hero"><span class="av ph" aria-hidden="true"></span><div class="t"><span class="bar n"></span><span class="bar s"></span><span class="bar e"></span></div></div>'
      : `<div class="acct-hero"><span class="av" aria-hidden="true">${esc(String(a.name || '').trim().charAt(0).toUpperCase())}</span><div class="t"><b>${esc(a.name)}</b><span>${esc(a.phone)}</span><span>${esc(a.email)}</span></div></div>`;
    return shellWrap(vm, `<div class="flow"><div class="flowbar plain"><h1>Cuenta</h1></div>
    <div style="height:12px"></div>${hero}<div class="rows">
      ${ORDERS_SCREEN ? `<button class="rowbtn" data-act="tab" data-tab="orders">${IC.bag}<span class="t">Pedidos</span>${IC.chev}</button>` : ''}
      <button class="rowbtn" data-act="promos"${inert ? ' aria-disabled="true"' : ''}>${IC.bell}<span class="t">Promociones<span>Ofertas por correo y WhatsApp</span></span><span class="switch" role="switch" aria-checked="${inert ? !a.settled : a.promos}"${inert ? ' aria-disabled="true"' : ''}></span></button>
      <button class="rowbtn" data-act="help">${IC.help}<span class="t">Ayuda</span>${IC.chev}</button></div>
    <div class="rows sess">
      <button class="rowbtn" data-act="signout">${IC.out}<span class="t">Cerrar sesión</span></button>
      <button class="rowbtn" data-act="forget">${IC.phone}<span class="t">Olvidar este teléfono<span>Cierra tu sesión y deja de recordar tu número</span></span></button></div>
    <div class="credit ver">v${esc(a.version || '')}</div></div>`);
  }
  // G7 frame 2: «Olvidar este teléfono» — the shell's .errsheet, the calm icon, two exits
  const forgetSheetHtml = () => `<div class="scrim"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="Olvidar este teléfono"><div class="grab"></div>
    <div class="errsheet"><div class="icon calm">${IC.phone}</div><h2>¿Olvidar este teléfono?</h2>
      <p>Cerramos tu sesión y este teléfono deja de recordar tu número: la próxima vez lo escribís de nuevo. Tu cuenta y tus pedidos no se borran.</p>
      <div class="acts"><button class="primary" data-act="forget-confirm">Olvidar este teléfono</button><button class="btn2 wide" data-act="lclose">Cancelar</button></div></div></div>`;

  // coverage on Inicio (r1 §2.3, display only — the quote stays the authority): straight-line hub → location ≤ coverage_km
  const kmBetween = (a, b) => { const dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180, s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2; return 2 * 6371 * Math.asin(Math.sqrt(s)); };
  const covers = (entry, loc) => { if (!loc || !entry || !Number.isFinite(entry.hub_lat) || !Number.isFinite(entry.hub_lng) || !Number.isFinite(entry.coverage_km)) return null; return kmBetween({ lat: entry.hub_lat, lng: entry.hub_lng }, loc) <= entry.coverage_km; };
  // frame 4 only when EVERY listed store answers «outside» (an unknown coverage is never counted as outside)
  const allOutOfZone = (rows, loc) => { const live = (rows || []).filter((r) => !r.gone); return !!loc && live.length > 0 && live.every((r) => covers(r.entry, loc) === false); };

  return { homeHtml, searchHtml, tabbarHtml, neutralReturnHtml, accountGuestHtml, accountMemberHtml, forgetSheetHtml, addrSheetHtml, softaskHtml, pinEditorHtml, searchModel, storeOf, isOpen, opensText, closesText, houseDishes, mealDishes, isValue, feeHtml, covers, allOutOfZone, kmBetween, CUIS, IC, norm };
});
