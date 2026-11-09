// The S2 side-by-sides (advisor 11-09, SBS method (A)): the SDK checkout frames 1–8 vs MOCKUP-capp-S2-sdk-checkout.html (owner-approved
// v7) and the adjustment frames A–G vs MOCKUP-capp-S2-adjustment.html (owner-approved r3). Run against a bundle packaged WITH the sdkPay
// flag. Every scene states its injections (the review page + CLASSIFICATION.md):
//   · NATIVE   — runtime mode 'native' (the SDK checkout is the installed app's only, capp-shell.js:57); applied per page by sbs.mjs
//   · STAND-IN — the stand-in pay binding (standin-paysdk.mjs): frame 3 only, the one screen that needs a field host
//   · GEO      — a device position (the delivery pin), for the scenes that place an order
// 4c (the bank's native-styled challenge) is NOT shot: it is the plugin's own view — OWED by the native-shell slice with frame 3's real fields.
import { MEMBER_SEED, memberExtra, s2Extra, chainExtra } from './fixtures.mjs';
import { standinPaySdk } from './standin-paysdk.mjs';
const CK = 'MOCKUP-capp-S2-sdk-checkout.html', ADJ = 'MOCKUP-capp-S2-adjustment.html';
// a mockup frame by its figure id, in the theme asked (the page's own Light / Dark control), the device bezel and the drawn OS status
// bar removed so the app area is exactly 390×844 CSS px like the real shot
const s2frame = (file, id, label) => (theme) => ({ file, label: `${label} ${id} · ${theme}`, vw: 1400, vh: 1100,
  run: `(() => { const b = document.querySelector('#theme [data-theme="${theme}"]'); if (!b) throw new Error('no theme control'); b.click(); })()`,
  clip: `(() => { const f = document.getElementById(${JSON.stringify(id)}); if (!f) throw new Error('no frame ${id}');
  const d = f.querySelector('.device'), fr = f.querySelector('.device .frame'); if (!d || !fr) throw new Error('no device in ${id}');
  d.style.width = '410px'; d.style.height = '864px'; d.style.maxWidth = 'none'; d.style.borderRadius = '0'; d.style.boxShadow = 'none'; fr.style.borderRadius = '0';
  f.querySelectorAll('.sbar').forEach((e) => { e.style.display = 'none'; }); fr.scrollIntoView();
  const r = fr.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()` });
const ck = (id) => s2frame(CK, id, 'S2-checkout v7');
const adj = (id) => s2frame(ADJ, id, 'S2-adjustment r3');

// ── the real app's steps (the mockups draw La Musa) ──
const homeReady = { until: 'document.querySelector(".hsec .rcard, .rlist .rcard")', ms: 20000 };
const openStore = (rid) => [homeReady, { run: `(document.querySelector('.hsec[aria-label="Todos los restaurantes"] .rcard[data-rid="${rid}"]') || document.querySelector('.rlist .rcard[data-rid="${rid}"]')).click()` },
  { until: 'document.querySelector(".sinfo, #top .info")', ms: 20000 }, { wait: 500 }];
const addTwo = [{ run: `(() => { const b = [...document.querySelectorAll('.icards .qty-add-btn, .content .row .qty-add-btn')].filter((x) => !x.disabled).slice(0, 2); b.forEach((x) => x.click()); return b.length; })()` }, { wait: 400 }];
const click = (sel) => ({ run: `(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) throw new Error('no ' + ${JSON.stringify(sel)}); b.click(); })()` });
const text = (t, ms = 15000) => ({ until: `document.body.innerText.includes(${JSON.stringify(t)})`, ms });
const toCheckout = [...openStore('la_musa'), ...addTwo, { run: `document.getElementById('cart-bar').click()` }, { wait: 300 }, click('#layer [data-act="checkout"]'),
  { until: 'document.querySelector(".flow .col-a")', ms: 15000 }, { until: 'document.querySelector(".paybar")', ms: 10000 }, { wait: 800 }];
const scrollEnd = [{ run: `(() => { for (const e of [document.getElementById('scroller'), document.querySelector('.flow')]) if (e) e.scrollTop = e.scrollHeight; })()` }, { wait: 400 }];
// «Hacer pedido» → the tip screen → its place button (delivery)
const place = [{ until: 'document.querySelector("#cta:not([disabled])")', ms: 10000 }, click('#cta'), { until: 'document.querySelector("[data-act=tip-place]")', ms: 10000 }, { wait: 300 }, click('[data-act="tip-place"]')];
const GEO = { latitude: 15.52, longitude: -88.04 };

const NATIVE = 'NATIVE (runtime mode)', STANDIN = 'STAND-IN (native field host)';
const s2 = (name, o) => ({ name, width: 390, height: 844, seed: MEMBER_SEED(), native: true, themes: ['light', 'dark'], ...o,
  fixtures: { extra: chainExtra(memberExtra(), s2Extra(o.s2 || {})) }, injections: [NATIVE, ...(o.preboot ? [STANDIN] : []), ...(o.geo ? ['GEO'] : [])].join(' + ') });
const placed = (view, extraSteps = [], s2o = {}) => ({ geo: GEO, s2: { place: 'placed', view, ...s2o }, steps: [...toCheckout, ...place, text('Se cobra al recibir', 20000), { wait: 800 }, ...extraSteps] });

export const S2_SCENES = [
  // ── checkout (v7) ──
  s2('S2ck-1-checkout-row', { steps: [...toCheckout, ...scrollEnd], mock: (t) => (t === 'dark' ? ck('mk-1d')(t) : ck('mk-1')(t)) }),
  s2('S2ck-2-chooser', { steps: [...toCheckout, click('[data-act="paysheet"]'), { until: 'document.querySelector("#layer [data-act=paypick]")', ms: 8000 }, { wait: 500 }], mock: ck('mk-2') }),
  s2('S2ck-3-add-card', { preboot: (t) => standinPaySdk(t === 'dark' ? 'valid' : 'mid'), steps: [...toCheckout, click('[data-act="paysheet"]'), { until: 'document.querySelector("#layer [data-act=addcard]")', ms: 8000 }, click('#layer [data-act="addcard"]'), { until: 'document.getElementById("c-num")', ms: 8000 }, { wait: 500 }],
    mock: (t) => (t === 'dark' ? ck('mk-3d')(t) : ck('mk-3')(t)), note: 'light = mid-entry (mk-3); dark = all valid (mk-3d)' }),
  s2('S2ck-4-processing', { geo: GEO, s2: { place: 'slow' }, steps: [...toCheckout, ...place, { wait: 2600 }, text('Procesando'), { wait: 400 }], mock: ck('mk-4'), note: 'placeSdkOrder held 60 s; the sheet after the kept 2-s window' }),
  s2('S2ck-4b-under-review', { geo: GEO, s2: { place: 'under_review' }, steps: [...toCheckout, ...place, text('Estamos confirmando tu pago'), { wait: 500 }], mock: ck('mk-4b') }),
  s2('S2ck-5-declined-retryable', { geo: GEO, s2: { place: 'declined', decline: 'retryable' }, steps: [...toCheckout, ...place, text('Tu banco no autorizó el pago'), { wait: 500 }], mock: ck('mk-5') }),
  s2('S2ck-6-expired', { s2: { cards: [{ card_id: 'c_old', brand: 'visa', last4: '4242', exp_month: 10, exp_year: 2026, expired: true }] }, steps: [...toCheckout, ...scrollEnd], mock: ck('mk-6') }),
  s2('S2ck-7-unavailable', { s2: { available: false }, steps: [...toCheckout, ...scrollEnd], mock: ck('mk-7') }),
  s2('S2ck-8-pedido-recibido', { ...placed('plain'), mock: ck('mk-8') }),
  // ── adjustment (r3) — the order screen of a placed SDK order, its order_pay_view streamed ──
  s2('S2adj-A-decrease', { ...placed('A', [{ wait: 1200 }]), mock: adj('mk-a') }),
  s2('S2adj-B-help', { ...placed('A', [click('[data-act="adj-more"]'), { until: 'document.querySelector("#layer .errsheet, #layer .sheet")', ms: 8000 }, { wait: 500 }]), mock: adj('mk-b') }),
  s2('S2adj-C-consent', { ...placed('C', [{ until: 'document.querySelector("#layer [data-act]")', ms: 10000 }, { wait: 600 }]), mock: adj('mk-c') }),
  s2('S2adj-D-accepted', { ...placed('D'), mock: adj('mk-d') }),
  s2('S2adj-E-verifying', { ...placed('E'), mock: adj('mk-e') }),
  s2('S2adj-F-expired', { ...placed('F'), mock: adj('mk-f') }),
  s2('S2adj-G-declined', { ...placed('G', [{ until: 'document.querySelector("#layer [data-act]")', ms: 10000 }, { wait: 600 }]), mock: adj('mk-g') }),
];
