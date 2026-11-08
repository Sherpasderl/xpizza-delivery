// The side-by-side scenes: each = the REAL screen from the packaged entry (a path + steps evaluated in the page) and, where one exists,
// its MOCKUP scene of the SAME theme, isolated at the same CSS size (DPR 2). Mockups: the owner-approved D-3 r3 desktop frames (fixed
// light, except f1b dark) and the approved v6 prototype (it follows prefers-color-scheme, so it pairs in both themes).
import { MEMBER_SEED, memberExtra, PROV, kdsSoldNode } from './fixtures.mjs';
const D3 = 'MOCKUP-capp-desktop-D3-r3.html';
const V6 = 'customer-app-prototype/APPROVED-v6/customer-app-prototype-v6-APPROVED.html';
// a D-3 r3 frame at 100 % (its window's --s set to 1), clipped to the viewport area under the fake browser bar
const NO_TOC = `document.querySelectorAll('.toc').forEach((e) => { e.style.display = 'none'; });`;   // the mockup page's sticky nav pills — page chrome, never the app
export const frame = (id) => ({ file: D3, label: `D-3 r3 ${id}`, vw: 1700, vh: 1200,
  clip: `(() => { ${NO_TOC} const f = document.getElementById(${JSON.stringify(id)}); if (!f) throw new Error('no frame ${id}');
  const w = f.querySelector('.winwrap'); w.style.setProperty('--s', '1'); w.style.maxWidth = 'none';
  const v = f.querySelector('.vp'); const r = v.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()` });
// a v6 screen by its chooser label, clipped to the phone's app area
export const v6 = (label) => ({ file: V6, label: `v6 «${label}»`, vw: 1400, vh: 1100,
  run: `(() => { S.theme = 'auto'; render();   // the v6 follows prefers-color-scheme only under «Sistema» (its default is light)
    const b = [...document.querySelectorAll('#screens [data-screen]')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error('no v6 screen ${label}'); b.click(); })()`,
  clip: `(() => { const a = document.getElementById('app'); const r = a.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()` });
// a D-3 r3 PAIR's phone (the n-th 390×844 phone beside the desktop window), at 100 %: the window hidden, the phone unscaled
export const pairPhone = (id, n = 0) => ({ file: D3, label: `D-3 r3 ${id} phone${n ? ' ' + (n + 1) : ''}`, vw: 1700, vh: 1200,
  clip: `(() => { ${NO_TOC} const f = document.getElementById(${JSON.stringify(id)}); if (!f) throw new Error('no frame ${id}');
  f.querySelectorAll('.winwrap').forEach((w) => { w.style.display = 'none'; });
  const ph = f.querySelectorAll('.phin')[${n}]; if (!ph) throw new Error('no phone ${n} in ${id}'); ph.style.setProperty('--s', '1'); ph.style.transform = 'none';
  const wr = ph.parentElement; wr.style.width = '390px'; wr.style.height = '844px'; ph.scrollIntoView();
  const r = ph.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()` });
// an S7a-states frame (a REAL v6 capture embedded as an image), by its caption tag («12 · claro» / «12 · oscuro»), at 390 CSS px
const S7A = 'MOCKUP-capp-S7a-states.html';
export const s7a = (n) => (theme) => ({ file: S7A, label: `S7a states ${n} · ${theme === 'dark' ? 'oscuro' : 'claro'}`, vw: 1400, vh: 1100,
  clip: `(() => { const tag = ${JSON.stringify(n + ' · ')} + ${JSON.stringify(theme === 'dark' ? 'oscuro' : 'claro')};
  const f = [...document.querySelectorAll('figure')].find((x) => { const l = x.querySelector('.let'); return l && l.textContent.trim() === tag; }); if (!f) throw new Error('no S7a frame ' + tag);
  const img = f.querySelector('img'); if (!img) throw new Error('no image in ' + tag); img.style.width = '390px'; img.style.height = 'auto'; img.style.maxWidth = 'none'; img.scrollIntoView();
  const r = img.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()` });
const lightOnly = (m) => (theme) => (theme === 'light' ? m : null);
const darkOnly = (m) => (theme) => (theme === 'dark' ? m : null);
const both = (m) => () => m;

// ── the member fixtures (a restored Ana; the real writers — see fixtures.mjs) ──
const member = (o = {}) => ({ seed: MEMBER_SEED(), fixtures: { ...(o.sold ? { sold: o.sold } : {}), extra: memberExtra(o) } });
// the sold dish for the S7a frames 12/14 (Carnivora): its raw identity from the SERVED identity field, marked sold by the real KDS writer
const soldOf = async (rid, name) => { const env = PROV[rid].envelope, d = env.menu.dishes.find((x) => x.name === name); const field = env.menu.avail_identity && env.menu.avail_identity.field;
  if (!d || !field || d[field] == null) throw new Error(`sold fixture: no ${name} / identity in ${rid}`); return { [rid]: await kdsSoldNode(rid, [String(d[field])]) }; };
const SOLD_CARNIVORA = await soldOf('x_pizza', 'Carnivora');

// ── the real app's steps ──
const homeReady = { until: 'document.querySelector(".hsec .rcard, .rlist .rcard")', ms: 20000 };
const openStore = (rid) => [homeReady, { run: `(document.querySelector('.hsec[aria-label="Todos los restaurantes"] .rcard[data-rid="${rid}"]') || document.querySelector('.rlist .rcard[data-rid="${rid}"]')).click()` },
  { until: 'document.querySelector(".sinfo, #top .info")', ms: 20000 }, { wait: 500 }];
const addTwo = [{ run: `(() => { const b = [...document.querySelectorAll('.icards .qty-add-btn, .content .row .qty-add-btn')].filter((x) => !x.disabled).slice(0, 2); b.forEach((x) => x.click()); return b.length; })()` }, { wait: 400 }];
const toCheckoutDesk = [{ run: `document.querySelector('.deskcart [data-act="checkout"]').click()` }, { until: 'document.querySelector(".flow .col-a")', ms: 15000 }, { wait: 800 }];
const toCheckoutPhone = [{ run: `document.getElementById('cart-bar').click()` }, { wait: 300 }, { run: `document.querySelector('#layer [data-act="checkout"]').click()` }, { until: 'document.querySelector(".flow .col-a")', ms: 15000 }, { wait: 800 }];
const tab = (t) => [{ run: `(() => { const b = [...document.querySelectorAll('[data-act="tab"][data-tab="${t}"]')].find((x) => x.getClientRects().length); if (!b) throw new Error('no visible ${t} tab'); b.click(); })()` }];
const ordersReady = { until: 'document.querySelector(".orow")', ms: 20000 };
const toOrders = [homeReady, ...tab('orders'), ordersReady, { wait: 500 }];
const click = (sel) => ({ run: `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) throw new Error('no ' + ${JSON.stringify(sel)}); b.click(); })()` });
const openFirstDish = [{ run: `(document.querySelector('.icards .icard .txt') || document.querySelector('.content .row .txtbtn')).click()` }, { until: 'document.querySelector("#detail-modal.open")', ms: 8000 }, { wait: 500 }];

export const SCENES = [
  // ── C-6 desktop (D-3 r3) ──
  { name: 'C-6b-home-1440', width: 1440, height: 900, steps: [homeReady, { wait: 400 }], themes: ['light', 'dark'], mock: lightOnly(frame('f1a')) },
  { name: 'C-6c-store-1440-2-lines', width: 1440, height: 900, steps: [...openStore('x_pizza'), ...addTwo], themes: ['light', 'dark'], mock: lightOnly(frame('f2a')) },
  { name: 'C-6c-store-1280-scrolled', width: 1280, height: 800, steps: [...openStore('x_pizza'), { run: `document.getElementById('scroller').scrollTop = 420` }, { wait: 400 }], themes: ['light'], mock: lightOnly(frame('f2b')) },
  { name: 'C-6c-item-dialog-1440', width: 1440, height: 900, steps: [...openStore('la_musa'), ...openFirstDish], themes: ['light', 'dark'], mock: lightOnly(frame('f3')) },
  { name: 'C-6d-checkout-guest-1440', width: 1440, height: 900, steps: [...openStore('x_pizza'), ...addTwo, ...toCheckoutDesk], themes: ['light', 'dark'], mock: lightOnly(frame('f4a')) },
  { name: 'C-6a-column-900', width: 900, height: 640, steps: [...openStore('x_pizza')], themes: ['light'], mock: lightOnly(frame('f7b')) },
  // ── the phone (v6) ──
  { name: 'phone-home-390', width: 390, height: 844, steps: [homeReady, { wait: 400 }], themes: ['light', 'dark'], mock: both(v6('Inicio')) },
  { name: 'phone-store-390', width: 390, height: 844, steps: [...openStore('x_pizza')], themes: ['light', 'dark'], mock: both(v6('X. Pizza · en la app')) },
  { name: 'phone-dish-sheet-390', width: 390, height: 844, steps: [...openStore('x_pizza'), ...openFirstDish], themes: ['light', 'dark'], mock: both(v6('Hoja de plato: 2 pizzas con extras')), note: 'the v6 frame is 2 pizzas with extras; the real sheet is the first dish' },
  { name: 'phone-checkout-guest-390', width: 390, height: 844, steps: [...openStore('x_pizza'), ...addTwo, ...toCheckoutPhone], themes: ['light', 'dark'], mock: both(v6('Checkout invitado (X. Pizza)')) },
  // ── a MEMBER (Ana: 3 past orders — one delivered 2 h ago and unrated, one rated, one 10 days old) ──
  { name: 'C-6b-home-member-1280', width: 1280, height: 800, ...member(), steps: [homeReady, { wait: 600 }], themes: ['dark', 'light'], mock: darkOnly(frame('f1b')) },
  { name: 'C-6d-checkout-member-1280', width: 1280, height: 800, ...member(), steps: [...openStore('x_pizza'), ...addTwo, ...toCheckoutDesk], themes: ['light', 'dark'], mock: lightOnly(frame('f4b')) },
  { name: 'C-6-account-member-1440', width: 1440, height: 900, ...member(), steps: [homeReady, ...tab('account'), { until: 'document.querySelector("[data-act=signout]")', ms: 10000 }, { wait: 500 }], themes: ['light', 'dark'], mock: lightOnly(frame('f6')) },
  { name: 'pedidos-desk-1440', width: 1440, height: 900, ...member(), steps: toOrders, themes: ['light', 'dark'], mock: lightOnly(frame('r3')), note: 'D-3 r3 draws the ACTIVE state; this member has none (the help scenes carry one)' },
  { name: 'phone-pedidos-390', width: 390, height: 844, ...member(), steps: toOrders, themes: ['light', 'dark'], mock: both(v6('Pedidos · historial')) },
  { name: 'phone-receipt-390', width: 390, height: 844, ...member(), steps: [...toOrders, click('[data-act="go-receipt"][data-oid="XPZ261102-RATE01"]'), { until: 'document.querySelector(".receipt .rbody, .receipt2")', ms: 15000 }, { wait: 600 }], themes: ['light', 'dark'], mock: both(v6('Entregado')) },
  // step (c): the receipt COLD MISS — the read held 1.5 s, the row tapped before it lands; budget 0 (advisor)
  { name: 'phone-receipt-cold-cls-390', width: 390, height: 844, ...member({ receiptDelay: 1500 }), steps: toOrders,
    cls: [click('[data-act="go-receipt"][data-oid="XPZ261102-RATE01"]'), { until: 'document.querySelector(".receipt .rbody, .receipt2")', ms: 15000 }, { wait: 1200 }], themes: ['light'], mock: null, note: 'CLS budget 0; no mockup (contrast + CLS only)' },
  // C-2 rating (D-3 r2 pair) — opened from the Pedidos row «Valorar» (the mockup draws it over the delivered order screen)
  { name: 'C-2-rate-desk-1440', width: 1440, height: 900, ...member(), steps: [...toOrders, click('[data-act="rate-open"][data-oid="XPZ261102-RATE01"]'), { until: 'document.querySelector("[data-act=rate-star]")', ms: 10000 }, { wait: 500 }], themes: ['light', 'dark'], mock: lightOnly(frame('r2')), note: 'opened from Pedidos; the mockup draws it over the order screen' },
  { name: 'C-2-rate-phone-390', width: 390, height: 844, ...member(), steps: [...toOrders, click('[data-act="rate-open"][data-oid="XPZ261102-RATE01"]'), { until: 'document.querySelector("[data-act=rate-star]")', ms: 10000 }, { wait: 500 }], themes: ['light', 'dark'], mock: lightOnly(pairPhone('r2', 1))   /* r2's phone2 = the rating sheet (phone 1 is «Entregado» under it) */ },
  // C-5 help (D-3 r6 pair) — the Pedidos active card's «Ayuda» (a server-side active order)
  { name: 'C-5-help-desk-1440', width: 1440, height: 900, ...member({ active: true }), steps: [...toOrders, click('[data-act="orders-help"]'), { until: 'document.querySelector("[data-act=help-wa]")', ms: 10000 }, { wait: 500 }], themes: ['light', 'dark'], mock: lightOnly(frame('r6')), note: 'opened from the Pedidos active card; the mockup draws it over the order screen' },
  { name: 'C-5-help-phone-390', width: 390, height: 844, ...member({ active: true }), steps: [...toOrders, click('[data-act="orders-help"]'), { until: 'document.querySelector("[data-act=help-wa]")', ms: 10000 }, { wait: 500 }], themes: ['light', 'dark'], mock: lightOnly(pairPhone('r6')) },
  // the sold-out treatment (S7a frame 12: «Agotado» in the price's place) — Carnivora sold on the RTDB node
  { name: 'phone-sold-out-390', width: 390, height: 844, fixtures: { sold: SOLD_CARNIVORA }, steps: [...openStore('x_pizza'), { until: 'document.body.textContent.includes("Agotado")', ms: 10000 }, { run: `(() => { const e = [...document.querySelectorAll('.content .row, .icards .icard')].find((x) => x.textContent.includes('Agotado')); if (e) e.scrollIntoView({ block: 'center' }); })()` }, { wait: 500 }], themes: ['light', 'dark'], mock: s7a(12) },
];
