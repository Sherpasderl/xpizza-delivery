// Item S3 (D4c-grill/item-s1/S3-DESIGN.md) — the customer app's item refusals vs MOCKUP-item-s3-refusals.html (owner-approved 11-10):
// A1 (menu_changed after «Hacer pedido») → A2 (the cart after «Recargar»: the gone dish dropped, the existing note), B1 (extra_not_allowed
// naming the dish and the extra) → B2 (after «Quitar extra y seguir»: the new total, nothing placed). Light + the mockup's dark row.
// The mockup draws the installed app's v7 pay bar, so these run like the S2 scenes: a bundle WITH the sdkPay flag, NATIVE runtime mode,
// the member seed (card on file), GEO for the pin. The cart is the mockup's: Carnivora + Pepperoni, Margherita, Potato & Dill Sausage.
// The refusals are the server's OWN bodies (resolve-lines resolutionRefusal; extras-intake refusalBody/Status, + order_id as index.js
// sends them), answered by placeSdkOrder once. A2's fresh menu is the provisioned x_pizza envelope without Potato & Dill Sausage (a new
// ETag) — what getPublicMenu serves after a publish that removed it.
import { createRequire } from 'node:module';
import { MEMBER_SEED, memberExtra, s2Extra, chainExtra, PROV } from './fixtures.mjs';
import { s2frame, click, GEO, NATIVE, homeReady } from './scenes-s2.mjs';
const require = createRequire(import.meta.url);
const RL = require('../../xpizza-functions/catalog/resolve-lines.js');
const EI = require('../../xpizza-functions/catalog/extras-intake.js');
const MK = 'MOCKUP-item-s3-refusals.html';
const GONE = 'Potato & Dill Sausage';

// the device clip of a figure (light: the rail theme at light; dark: the mockup's own dark row, ids «-dark», fixed to dark). As the tip
// scenes: the device is lifted OUT of its horizontally scrolled strip (position:fixed at the viewport's top-left) before it is measured
const frame = (id) => (theme) => { const fid = theme === 'dark' ? `${id}-dark` : id, f = s2frame(MK, fid, 'item-s3 refusals')('light');
  return { ...f, clip: `(() => { const f = document.getElementById(${JSON.stringify(fid)}); if (!f) throw new Error('no frame ${fid}');
  const d = f.querySelector('.device'), fr = f.querySelector('.device .frame'); if (!d || !fr) throw new Error('no device in ${fid}');
  for (const e of [d, fr]) e.style.transition = 'none';
  Object.assign(d.style, { position: 'fixed', left: '0px', top: '0px', zIndex: '99999', width: '410px', height: '864px', maxWidth: 'none', borderRadius: '0', boxShadow: 'none', margin: '0' });
  fr.style.borderRadius = '0'; f.querySelectorAll('.sbar').forEach((e) => { e.style.display = 'none'; });
  const r = fr.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()` }; };

const openXPizza = [homeReady, { run: `(document.querySelector('.hsec[aria-label="Todos los restaurantes"] .rcard[data-rid="x_pizza"]') || document.querySelector('.rlist .rcard[data-rid="x_pizza"]')).click()` },
  { until: 'document.querySelector(".sinfo, #top .info")', ms: 20000 }, { wait: 500 }];
// a real customer step: open the dish by its name, «Agregar»; with an extra, reopen it (a plain dish offers its extras once it is in the
// cart, per unit) and tick the extra, then close the sheet
const openDish = (name) => [{ run: `(() => { const c = [...document.querySelectorAll('.icards .icard, .content .row')].find((e) => { const n = e.querySelector('.nm'); return n && n.textContent.trim() === ${JSON.stringify(name)}; });
    if (!c) throw new Error('no dish card ' + ${JSON.stringify(name)}); (c.querySelector('.txt, .txtbtn') || c).click(); })()` },
  { until: 'document.querySelector("#detail-modal.open")', ms: 8000 }, { wait: 300 }];
const closed = { until: '!document.querySelector("#detail-modal.open")', ms: 8000 };
const shut = [{ run: `(() => { if (document.querySelector('#detail-modal.open')) (document.querySelector('#detail-modal [data-act="dclose"]') || document.getElementById('detail-overlay')).click(); })()` }, closed, { wait: 300 }];
const addDish = (name, extra) => [...openDish(name), click('#detail-modal [data-act="dcta"]'), { wait: 500 },
  ...(extra ? [{ run: `(() => { if (!document.querySelector('#detail-modal.open')) throw new Error('the sheet closed on «Agregar»'); const r = [...document.querySelectorAll('#detail-modal .detail-extras-row')].find((e) => e.querySelector('.detail-extras-name').textContent.trim() === ${JSON.stringify(extra)});
    if (!r) throw new Error('no extra ' + ${JSON.stringify(extra)} + ' in [' + [...document.querySelectorAll('#detail-modal .detail-extras-row .detail-extras-name')].map((e) => e.textContent.trim()).join('|') + ']'); r.click(); })()` },
    { until: 'document.querySelector("#detail-modal .detail-extras-row[aria-checked=true]")', ms: 5000 }, { wait: 200 }] : []), ...shut];
const toCheckout = [...openXPizza, ...addDish('Carnivora', 'Pepperoni'), ...addDish('Margherita'), ...addDish(GONE),
  { run: `document.getElementById('cart-bar').click()` }, { wait: 300 }, click('#layer [data-act="checkout"]'),
  { until: 'document.querySelector(".flow .col-a")', ms: 15000 }, { until: 'document.querySelector(".paybar")', ms: 10000 }, { wait: 800 },
  // the mockup's order: Pickup (no pin, no tip step: «Hacer pedido · L N» places), the saved card chosen in the chooser
  click('[data-act="type"][data-val="pickup"]'), { until: '/^Total L [1-9]/.test((document.querySelector(".paybar.pay .payline span") || {}).textContent || "")', ms: 15000 },
  click('[data-act="paysheet"]'), { until: 'document.querySelector("#layer [data-act=paypick]:not([data-card=cash])")', ms: 8000 },
  click('#layer [data-act="paypick"]:not([data-card="cash"])'), { wait: 400 }, { until: '/^Hacer pedido/.test((document.querySelector("#cta:not([disabled])") || {}).textContent || "")', ms: 15000 }, { wait: 400 }];
// «Hacer pedido · L N» (a confirm step, if the flow shows one, is a customer tap too)
const place = [click('#cta'), { wait: 600 }, { run: `(() => { const g = document.querySelector('#layer [data-act="placing-go"]'); if (g) g.click(); })()` }];
const sheet = (t) => [{ until: `(document.querySelector('#layer .errsheet h2') || {}).textContent === ${JSON.stringify(t)}`, ms: 20000 }, { wait: 600 }];

const MC = RL.resolutionRefusal({ code: 'menu_changed' });
const XR = { outcome: 'denied', denied: [{ item: 'Carnivora', extra: 'Pepperoni' }] };
const REFUSAL = { menu_changed: { status: MC.status, json: { ...MC.body, order_id: 'X' } }, extra_not_allowed: { status: EI.refusalStatus(XR), json: { ...EI.refusalBody(XR), order_id: 'X' } } };
// the menu after a publish that removed GONE: same envelope, the dish and its key gone, a new validator
const without = (() => { const e = JSON.parse(JSON.stringify(PROV.x_pizza.envelope)); const d = e.menu.dishes.find((x) => x.name === GONE);
  if (!d) throw new Error(`scenes-s3: no ${GONE} in the provisioned x_pizza menu`);
  e.menu.dishes = e.menu.dishes.filter((x) => x !== d); if (e.menu.item_keys) delete e.menu.item_keys[String(d.id)];
  return { envelope: e, etag: `${PROV.x_pizza.etag}-s3gone` }; })();

const s3 = (name, kind, o) => ({ name, width: 390, height: 844, seed: MEMBER_SEED(), native: true, themes: ['light', 'dark'], geo: GEO, ...o,
  fixtures: () => { const st = { refused: false };
    return { extra: chainExtra(memberExtra(), s2Extra({ place: 'refuse', refusal: REFUSAL[kind], onRefuse: () => { st.refused = true; } })),
      ...(kind === 'menu_changed' ? { menuOverride: (rid) => (rid === 'x_pizza' && st.refused ? without : null) } : {}) }; },
  injections: [NATIVE, 'GEO'].join(' + ') });

export const S3_SCENES = [
  s3('S3-A1-menu-changed', 'menu_changed', { steps: [...toCheckout, ...place, ...sheet('El menú se actualizó, recargá el menú')], mock: frame('mk-a1') }),
  s3('S3-A2-reloaded-cart', 'menu_changed', { steps: [...toCheckout, ...place, ...sheet('El menú se actualizó, recargá el menú'), click('#layer [data-act="menu-reload"]'),
    { until: 'document.querySelector("#layer .cartnote")', ms: 20000 }, { wait: 800 }], mock: frame('mk-a2') }),
  s3('S3-B1-extra-not-allowed', 'extra_not_allowed', { steps: [...toCheckout, ...place, ...sheet('Un extra ya no está disponible')], mock: frame('mk-b1') }),
  s3('S3-B2-repaired', 'extra_not_allowed', { steps: [...toCheckout, ...place, ...sheet('Un extra ya no está disponible'), click('#layer [data-act="extra-remove"]'),
    { until: '/Total nuevo/.test((document.querySelector(".flow .cartnote") || {}).textContent || "")', ms: 20000 }, { until: '/L 938$/.test((document.querySelector("#cta") || {}).textContent || "")', ms: 15000 },
    // the frame as the mockup draws it: «Tu pedido» and its note in view (the app does not scroll there itself — the pay bar carries the new total)
    { run: `document.querySelector('.flow .cartnote').scrollIntoView({ block: 'center' })` }, { wait: 800 }], mock: frame('mk-b2') }),
];
