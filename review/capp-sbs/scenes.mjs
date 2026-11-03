// The side-by-side scenes: each = the REAL screen from the packaged entry (a path + steps evaluated in the page) and, where one exists,
// its MOCKUP scene of the SAME theme, isolated at the same CSS size (DPR 2). Mockups: the owner-approved D-3 r3 desktop frames (fixed
// light, except f1b dark) and the approved v6 prototype (it follows prefers-color-scheme, so it pairs in both themes).
const D3 = 'MOCKUP-capp-desktop-D3-r3.html';
const V6 = 'customer-app-prototype/APPROVED-v6/customer-app-prototype-v6-APPROVED.html';
// a D-3 r3 frame at 100 % (its window's --s set to 1), clipped to the viewport area under the fake browser bar
export const frame = (id) => ({ file: D3, label: `D-3 r3 ${id}`, vw: 1700, vh: 1200,
  clip: `(() => { const f = document.getElementById(${JSON.stringify(id)}); if (!f) throw new Error('no frame ${id}');
  const w = f.querySelector('.winwrap'); w.style.setProperty('--s', '1'); w.style.maxWidth = 'none';
  const v = f.querySelector('.vp'); const r = v.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()` });
// a v6 screen by its chooser label, clipped to the phone's app area
export const v6 = (label) => ({ file: V6, label: `v6 «${label}»`, vw: 1400, vh: 1100,
  run: `(() => { S.theme = 'auto'; render();   // the v6 follows prefers-color-scheme only under «Sistema» (its default is light)
    const b = [...document.querySelectorAll('#screens [data-screen]')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error('no v6 screen ${label}'); b.click(); })()`,
  clip: `(() => { const a = document.getElementById('app'); const r = a.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()` });
const lightOnly = (m) => (theme) => (theme === 'light' ? m : null);
const both = (m) => () => m;

// ── the real app's steps ──
const homeReady = { until: 'document.querySelector(".hsec .rcard, .rlist .rcard")', ms: 20000 };
const openStore = (rid) => [homeReady, { run: `(document.querySelector('.hsec[aria-label="Todos los restaurantes"] .rcard[data-rid="${rid}"]') || document.querySelector('.rlist .rcard[data-rid="${rid}"]')).click()` },
  { until: 'document.querySelector(".sinfo, #top .info")', ms: 20000 }, { wait: 500 }];
const addTwo = [{ run: `(() => { const b = [...document.querySelectorAll('.icards .qty-add-btn, .content .row .qty-add-btn')].filter((x) => !x.disabled).slice(0, 2); b.forEach((x) => x.click()); return b.length; })()` }, { wait: 400 }];
const toCheckoutDesk = [{ run: `document.querySelector('.deskcart [data-act="checkout"]').click()` }, { until: 'document.querySelector(".flow .col-a")', ms: 15000 }, { wait: 800 }];
const toCheckoutPhone = [{ run: `document.getElementById('cart-bar').click()` }, { wait: 300 }, { run: `document.querySelector('#layer [data-act="checkout"]').click()` }, { until: 'document.querySelector(".flow .col-a")', ms: 15000 }, { wait: 800 }];
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
];
