'use strict';
/* R3 P1 §4b — THE TERMINAL OBSERVABLES (PLAN-R3-P1 rev 4, Amendment A2). A terminal region of the reviewed registry
 * (contract/outputs/registry.json, status terminal) names one of these observables. Each observable is:
 *   · capture(page | record) → a SNAPSHOT: the exact text / markup the surface shows (taken by the run, after its action);
 *   · compare[fact](snapshot, facts, ctx) → { ok, mode, detail } — the oracle's fact (contract/oracle.js factsOf, derived
 *     only from intent + writer response + persisted evidence) against what the surface shows.
 * mode is 'shown' (the surface prints the fact and it agrees) or 'not-shown' (the surface prints NOTHING of that fact —
 * asserted, e.g. no money token at all — which is agreement for a surface the contract does not require to show it).
 * A comparator never reads a reader helper: the snapshot is parsed here, with its own strict grammar.
 * An observable that has no comparator for a fact a cell asks of it is a MISSING comparison (execution.guard) — RED.
 */
const { JSDOM } = require('jsdom');
const { compareMoney, fmt } = require('./oracle');

const squash = (t) => String(t == null ? '' : t).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const frag = (html) => new JSDOM(`<!doctype html><body>${html || ''}</body>`).window.document.body;
const MONEY_TOKEN = /\bL\s?\d[\d,]*(?:\.\d{2})?\b/;
const PAY_WORDS = /efectivo|tarjeta|pagad|pagar|cobr|pixelpay|cambio/i;
// codex P1-a r1 P1-5: an asserted ABSENCE checks that the FACT is not on the surface — any value of it, not merely the
// correct one. These patterns recognise a displayed order number / place / driver whatever its value.
const NUM_ANY = /#\s?\d{1,7}\b|\b(?:orden|pedido|order|ticket)\s*(?:n[°ºo]\.?|#|número|num\.?)\s*[\w-]+|\bPZX-[\w-]+|\b[A-Z]{2,4}-\d{6}-\d{6}-[A-Z0-9]+\b/i;
const PLACE_ANY = /direcci[oó]n|ubicaci[oó]n|\bcolonia\b|\bcol\.\s|\bcasa\b|\bcalle\b|\bavenida\b|\bbarrio\b|\bresidencial\b|\bport[oó]n\b|google\.com\/maps|maps\.google|waze\.com|-?\d{1,2}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/i;
const DRIVER_ANY = /repartidor|motorista|conductor|driver|asignad[oa] a/i;
// the order's OWN tracking link (it carries the order by token, not a number or a place) is set aside — only that URL
const withoutTracking = (b, o) => (o && o.tracking_token ? b.split(/(\s+)/).filter((w) => !(/^https?:\/\//.test(w) && w.includes(o.tracking_token))).join('') : b);
const placeShown = (text, o) => PLACE_ANY.test(text) || [o.address_detected, o.address_details, o.maps_link].some((x) => x && text.includes(x));
// codex P1-a r1 P1-9: a terminal snapshot carries the EXPOSED state of its region (the sheet open, the step active, …)
const exposedBy = (checks) => { const bad1 = checks.find(([ok]) => !ok); return bad1 ? { ok: false, detail: bad1[1] } : { ok: true, detail: checks.map((c) => c[1]).join('; ') }; };
const shown = (doc, el) => { if (!el) return false; const w = doc.defaultView; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { if (e.hasAttribute('hidden')) return false; const cs = w.getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } return true; };
const okv = (mode, detail) => ({ ok: true, mode, detail });
const bad = (detail, extra = {}) => ({ ok: false, detail, ...extra });
const lempirasPermitted = (m) => !!m && m.centavos % 100 === 0;   // §1 F-MONEY evidence includes `total` (whole lempiras)
const cmpL = (expected, text) => compareMoney(expected, squash(text), lempirasPermitted(expected) ? { precision: 'lempiras', permitsLempiras: true } : { precision: 'cents' });
const cmpC = (expected, text) => compareMoney(expected, squash(text), { precision: 'cents' });
// both precisions are printed by the forms ('L 340' in the cart, 'L 340.00' on the receipt): try the exact-cent grammar
// first, then whole lempiras where §1 permits it
const cmpAny = (expected, text) => { const c = cmpC(expected, text); return c.ok ? c : cmpL(expected, text); };

function itemsAgree(rows, lines, label) {
  if (rows.length !== lines.length) return bad(`${label}: ${rows.length} item row(s) shown, ${lines.length} persisted (${JSON.stringify(rows)})`);
  for (let i = 0; i < lines.length; i++) {
    const r = rows[i]; const l = lines[i];
    if (squash(r.name) !== squash(l.name)) return bad(`${label}: row ${i} name "${r.name}" ≠ persisted "${l.name}"`);
    if (Number(r.qty) !== l.qty) return bad(`${label}: row ${i} qty ${r.qty} ≠ persisted ${l.qty}`);
    if (r.price !== undefined) { const c = cmpAny(l.cents, r.price); if (!c.ok) return bad(`${label}: row ${i} price — ${c.reason}`); }
  }
  return okv('shown', `${lines.length} line(s) agree (name, qty${rows[0] && rows[0].price !== undefined ? ', price' : ''})`);
}
const notShown = (text, re, what) => (re.test(text) ? bad(`${what} must not be shown here, but "${(re.exec(text) || [])[0]}" is`) : okv('not-shown', `no ${what} on this surface`));

// ── KDS ticket (R1) — the private projection on the real KDS page ──
const kdsTicket = {
  // two exposures, taken in order: the ticket on the live board, then Programados opened (it replaces the board)
  capture({ doc, orderId }) {
    const el = doc.getElementById(`card-${orderId}`);
    return { orderId, found: !!el, html: el ? el.outerHTML : '', nudged: !!(el && el.classList.contains('nudge-overdue')), boardIds: [...doc.querySelectorAll('.tk[id^="card-"]')].map((x) => x.id.slice(5)),
      exposed: exposedBy([[!!el, 'the ticket is in the DOM'], [shown(doc, el), 'the ticket is visible on the board']]) };
  },
  captureScheduled({ doc }) {
    const scr = doc.getElementById('scheduled-screen');
    return { scheduledListHtml: scr ? scr.innerHTML : null, scheduledExposed: exposedBy([[!!scr && shown(doc, scr), 'Programados is open (#scheduled-screen shown)']]) };
  },
  parse(s) {
    const b = frag(s.html); const tk = b.querySelector('.tk');
    const q = (sel) => (tk && tk.querySelector(sel) ? squash(tk.querySelector(sel).textContent) : null);
    return { tk, dataS: tk && tk.getAttribute('data-s'), name: q('.h-name'), type: q('.h-type'), id: q('.h-id'), cta: q('.h-cta'), schedLine: q('.sched-line'),
      items: tk ? [...tk.querySelectorAll('.card-item')].map((r) => { const qty = squash((r.querySelector('.card-item-qty') || {}).textContent); return { qty: Number(qty.replace(/[×x]$/, '')), name: squash(r.textContent.slice(qty.length)) }; }) : [],
      text: tk ? squash(tk.textContent) : '' };
  },
  compare: {
    ITEMS: (s, f) => { const p = kdsTicket.parse(s); return itemsAgree(p.items, f.ITEMS.value.map((l) => ({ name: l.name, qty: l.qty })), 'KDS ticket'); },
    NUM: (s, f) => { const p = kdsTicket.parse(s); const want = f.NUM.value != null ? `#${f.NUM.value}` : null; return p.id === want ? okv('shown', `${p.id}`) : bad(`ticket number "${p.id}" ≠ ${want} (F-NUM: display_number if stamped)`); },
    FULFIL: (s, f) => { const p = kdsTicket.parse(s); const want = { delivery: 'Delivery', pickup: 'Pickup' }[f.FULFIL.value]; return p.type === want ? okv('shown', p.type) : bad(`ticket type "${p.type}" ≠ ${want}`); },
    SCHED: (s, f) => {
      const p = kdsTicket.parse(s);
      if (!f.SCHED.value.asap) return bad('P1-a: scheduled orders are not in this slice');
      if (p.schedLine || p.dataS === 'sched') return bad(`an ASAP order shows a scheduled mark (${p.schedLine || p.dataS})`);
      if (s.scheduledListHtml == null || !s.scheduledExposed || !s.scheduledExposed.ok) return bad(`the Programados list was not captured OPEN (${s.scheduledExposed ? s.scheduledExposed.detail : 'not captured'}) — the SCHED cell needs it`);
      if (s.scheduledListHtml.includes(s.orderId || '\u0000') || (p.name && squash(frag(s.scheduledListHtml).textContent).includes(p.name))) return bad('an ASAP order is listed in Programados');
      return okv('shown', 'ASAP: no scheduled mark on the ticket, not listed in Programados');
    },
    STATUS: (s, f) => { const p = kdsTicket.parse(s); const want = { new: { col: 'nuevo', cta: /Empezar/ } }[f.STATUS.value]; if (!want) return bad(`P1-a: status ${f.STATUS.value} is not in this slice`); return p.dataS === want.col && want.cta.test(p.cta || '') && !s.nudged ? okv('shown', `${p.dataS} · ${p.cta}; no ready nudge`) : bad(`ticket state ${p.dataS} / "${p.cta}"${s.nudged ? ' / NUDGED overdue' : ''} ≠ new (nuevo / Empezar, no nudge)`); },
    BRAND: (s, f, ctx) => (s.found && ctx.brandBoard === f._meta.intent.rid ? okv('shown', `the ticket is on ${ctx.brandBoard}'s board`) : bad(`ticket found=${s.found} on board ${ctx.brandBoard} (order brand ${f._meta.intent.rid})`)),
    MONEY: (s) => notShown(kdsTicket.parse(s).text, MONEY_TOKEN, 'amount'),
    CASH: (s) => notShown(kdsTicket.parse(s).text, PAY_WORDS, 'cash / payment wording'),
    COLLECT: (s) => { const t = kdsTicket.parse(s).text; const m = notShown(t, MONEY_TOKEN, 'amount'); return m.ok ? notShown(t, PAY_WORDS, 'collect wording') : m; },
    DRIVER: (s, f) => (f.DRIVER.value === null ? notShown(kdsTicket.parse(s).text, DRIVER_ANY, 'driver') : bad('P1-a: a delivered order is not in this slice')),
    PLACE: (s, f) => (placeShown(kdsTicket.parse(s).text + ' ' + s.html, f._meta.persisted) ? bad('a place / address is shown on the KDS ticket (any value)') : okv('not-shown', 'no place / address of any value on the KDS ticket')),
  },
};

// ── order form (R13 / R14 / R15) ──
const cartPill = {
  capture: ({ doc }) => ({ text: squash((doc.getElementById('cart-pill-text') || {}).textContent), total: squash((doc.getElementById('cart-total') || {}).textContent),
    exposed: exposedBy([[!!doc.querySelector('#s1.stage.active'), 'step 1 is active'], [shown(doc, doc.getElementById('cart-bar')), 'the cart bar is shown']]) }),
  compare: {
    ITEMS: (s, f) => { const m = /^(\d+) pizzas?$/.exec(s.text); const n = f.ITEMS.value.reduce((a, l) => a + l.qty, 0); return m && Number(m[1]) === n ? okv('shown', `count ${n}`) : bad(`pill "${s.text}" ≠ ${n} item(s)`); },
    MONEY: (s, f) => { if (!s.total) return bad('the cart bar shows no total'); const c = cmpL(f.MONEY.value, s.total); return c.ok ? okv('shown', s.total) : bad(`cart bar total — ${c.reason}`); },
  },
};
const envioRow = (rows) => rows.find((r) => /Env[ií]o/.test(r.name));
const reviewSheet = {
  capture: ({ doc }) => ({ bodyHtml: (doc.getElementById('cart-review-body') || {}).innerHTML || '', totalText: squash((doc.getElementById('cart-review-total') || {}).textContent),
    exposed: exposedBy([[!!doc.querySelector('#cart-review-sheet.open'), 'the cart review sheet is OPEN'], [!!doc.querySelector('#cart-overlay.open'), 'its overlay is open']]) }),
  rows(s) { return [...frag(s.bodyHtml).querySelectorAll('.cart-review-item')].map((r) => { const pr = r.querySelector('.cart-review-item-price'); return { name: squash((r.querySelector('.cart-review-item-name') || {}).textContent), qty: r.querySelector('.cart-qty-num') ? Number(squash(r.querySelector('.cart-qty-num').textContent)) : null, price: pr ? squash(pr.textContent) : null, struck: !!(pr && /line-through/.test(pr.getAttribute('style') || '')) }; }); },
  compare: {
    ITEMS: (s, f) => itemsAgree(reviewSheet.rows(s).filter((r) => !/Env[ií]o/.test(r.name)), f.ITEMS.value, 'cart review sheet'),
    MONEY: (s, f) => { const c = cmpL(f.MONEY.value, s.totalText); return c.ok ? okv('shown', s.totalText) : bad(`sheet total — ${c.reason}`); },
    'DISPLAY:envio_gratis': (s, f, ctx) => envioDisplay(envioRow(reviewSheet.rows(s)), f, ctx, (r) => /Env[ií]o Gratis/.test(r.name) && r.struck && cmpC({ centavos: 7000, currency: 'HNL' }, r.price).ok, s.totalText),
  },
};
function envioDisplay(row, f, ctx, wellFormed, totalText) {
  const show = ctx.spec.envio_gratis.show[f.FULFIL.value];
  if (!show) return row ? bad(`Envío Gratis shown for ${f.FULFIL.value}`) : okv('shown', `absent for ${f.FULFIL.value} (as specified)`);
  if (!row) return bad(`Envío Gratis row missing for ${f.FULFIL.value}`);
  if (!wellFormed(row)) return bad(`Envío row malformed: ${JSON.stringify(row)}`);
  if (totalText != null && !cmpAny(f.MONEY.value, totalText).ok) return bad(`the L70 entered the total (${totalText} ≠ ${fmt(f.MONEY.value)})`);
  return okv('shown', `Envío Gratis shown for ${f.FULFIL.value}; total stays ${fmt(f.MONEY.value)}`);
}
const payStep = {
  capture: ({ doc }) => ({ summaryHtml: (doc.getElementById('s2-summary') || {}).innerHTML || '', tendered: (doc.getElementById('cash-tendered') || {}).value || '', changeHint: squash((doc.getElementById('change-hint') || {}).textContent), activeChip: (() => { const c = doc.querySelector('#change-chips .change-chip.active'); return c ? { amt: c.getAttribute('data-amt'), label: squash(c.textContent) } : null; })(), cashPanelShown: ((doc.getElementById('cash-change-panel') || { style: {} }).style.display || '') !== 'none',
    exposed: exposedBy([[!!doc.querySelector('#s2.stage.active'), 'the pay step (#s2) is active'], [shown(doc, doc.getElementById('s2-summary')), 'the pay-step summary is shown']]) }),
  rows(s) { const b = frag(s.summaryHtml); return { rows: [...b.querySelectorAll('.review-item')].map((r) => ({ name: squash((r.querySelector('.review-item-name') || {}).textContent), price: squash((r.querySelector('.review-item-price') || {}).textContent), prem: !!r.querySelector('.s2-prem') })), total: b.querySelector('.review-total') ? squash(b.querySelector('.review-total').lastElementChild.textContent) : null, text: squash(b.textContent) }; },
  compare: {
    ITEMS: (s, f) => itemsAgree(payStep.rows(s).rows.filter((r) => !/^Env[ií]o$/.test(r.name) && !r.prem).map((r) => { const m = /^(\d+)x (.+)$/.exec(r.name); return { qty: m ? Number(m[1]) : NaN, name: m ? m[2] : r.name, price: r.price }; }), f.ITEMS.value, 'pay-step summary'),
    MONEY: (s, f) => { const t = payStep.rows(s).total; const c = cmpL(f.MONEY.value, t); return c.ok ? okv('shown', t) : bad(`pay-step total — ${c.reason}`); },
    TENDER: (s, f) => {
      const v = f.TENDER.value; if (!v) return bad('P1-a: a non-cash tender is not in this slice');
      if (!s.cashPanelShown) return bad('the cash panel is not shown for a cash order');
      if (!v.tender) return s.changeHint === '' ? okv('not-shown', 'no tender → no change') : bad(`no tender, but "${s.changeHint}"`);
      if (!s.activeChip || Number(s.activeChip.amt) * 100 !== v.tender.centavos) return bad(`selected tender ${JSON.stringify(s.activeChip)} ≠ ${fmt(v.tender)}`);
      const m = /^Tu cambio: (L\s?[\d,.]+)$/.exec(s.changeHint); if (!m) return bad(`change hint "${s.changeHint}" does not parse`);
      const c = cmpC(v.change, m[1]); return c.ok ? okv('shown', `tender ${s.activeChip.label}, change ${m[1]}`) : bad(`change — ${c.reason}`);
    },
    REWARD: (s, f) => { const r = payStep.rows(s); if (f.REWARD.value.redemption) return bad('P1-a: a redemption is not in this slice'); return r.rows.some((x) => x.prem) || /Premio|Ahorrás/.test(r.text) ? bad('a reward row is shown without a redemption') : okv('not-shown', 'no redemption → no reward row'); },
    'DISPLAY:envio_gratis': (s, f, ctx) => { const r = payStep.rows(s); return envioDisplay(r.rows.find((x) => /^Env[ií]o$/.test(x.name)), f, ctx, (x) => /^Gratis$/.test(x.price), r.total); },
  },
};
const confirmation = {
  capture: ({ doc }) => ({ html: (doc.getElementById('s5') || {}).innerHTML || '', active: !!doc.querySelector('#s5.stage.active'),
    exposed: exposedBy([[!!doc.querySelector('#s5.stage.active'), 'the confirmation (#s5) is the active stage'], [shown(doc, doc.getElementById('order-id-display')), 'its order reference is shown']]) }),
  parse(s) {
    const b = frag(s.html); const rowsOf = (sel) => [...b.querySelectorAll(`${sel} .receipt-row`)].map((r) => ({ label: squash(r.children[0] && r.children[0].textContent), value: squash(r.children[1] && r.children[1].textContent), struck: !!(r.children[1] && /line-through/.test(r.children[1].getAttribute('style') || '')), html: r.innerHTML }));
    return { b, items: rowsOf('#receipt-items'), pay: rowsOf('#receipt-payment'), orderId: squash((b.querySelector('#order-id-display') || {}).textContent), sub: squash((b.querySelector('#success-sub') || {}).textContent), text: squash(b.textContent), rw: b.querySelector('#acct-success-rewards') };
  },
  compare: {
    ITEMS: (s, f) => itemsAgree(confirmation.parse(s).items.filter((r) => !/Env[ií]o|^Total$/.test(r.label)).map((r) => { const m = /^(\d+)× (.+)$/.exec(r.label); return { qty: m ? Number(m[1]) : NaN, name: m ? m[2] : r.label, price: r.value }; }), f.ITEMS.value, 'confirmation receipt'),
    MONEY: (s, f) => { const t = (confirmation.parse(s).items.find((r) => r.label === 'Total') || {}).value; const c = cmpC(f.MONEY.value, t); return c.ok ? okv('shown', t) : bad(`receipt Total — ${c.reason}`); },
    NUM: (s, f) => { const p = confirmation.parse(s); const m = /^Orden #\s*(.+)$/.exec(p.orderId); const want = f.NUM.value != null ? String(f.NUM.value) : f._meta.orderId; return m && m[1] === want ? okv('shown', p.orderId) : bad(`confirmation "${p.orderId}" ≠ F-NUM ${want}`, { shape: m ? (m[1] === f._meta.orderId ? 'Orden # {order_id}' : m[1]) : p.orderId }); },
    COLLECT: (s, f) => { const p = confirmation.parse(s); const pago = (p.pay.find((r) => r.label === 'Pago') || {}).value; const est = (p.pay.find((r) => r.label === 'Estado') || {}).value; if (!f.COLLECT.value.collect) return bad('P1-a: a nothing-to-collect order is not in this slice'); return /Efectivo al entregar/.test(pago || '') && /Se cobra al entregar/.test(est || '') ? okv('shown', `${pago} · ${est}`) : bad(`cash collect copy "${pago}" / "${est}"`); },
    PAYLIFE: (s, f) => { const p = confirmation.parse(s); const est = (p.pay.find((r) => r.label === 'Estado') || {}).value; const want = { pending: /Se cobra al entregar/ }[f.PAYLIFE.value]; if (!want) return bad(`P1-a: pay life ${f.PAYLIFE.value} is not in this slice`); return want.test(est || '') ? okv('shown', est) : bad(`Estado "${est}" ≠ ${f.PAYLIFE.value}`); },
    REWARD: (s, f) => {
      const p = confirmation.parse(s); const e = f.REWARD.value.earn; if (f.REWARD.value.redemption) return bad('P1-a: a redemption is not in this slice');
      if (!e) return p.rw && squash(p.rw.textContent) ? bad('an earn card is shown with no earn_preview') : okv('not-shown', 'no earn preview');
      const math = squash((p.rw && p.rw.querySelector('.rw-math') || {}).textContent); const cap = squash((p.rw && p.rw.querySelector('.rw-slotcap') || {}).textContent); const on = p.rw ? p.rw.querySelectorAll('.rw-slot--on').length : -1;
      const unit = (n) => `${n} sello${n === 1 ? '' : 's'}`; const got = e.delta + (e.welcome || 0);
      return math.includes(unit(e.delta)) && (!e.welcome || math.includes(`${e.welcome} de bienvenida`)) && cap.startsWith(`${got} / ${e.goal}`) && on === got ? okv('shown', `${math} · ${cap}`) : bad(`earn card "${math}" / "${cap}" / ${on} on ≠ earn_preview ${JSON.stringify(e)}`);
    },
    FULFIL: (s, f) => { const p = confirmation.parse(s); if (f.FULFIL.value !== 'delivery') return bad('P1-a: pickup is not in this slice'); return /Llegamos/.test(p.sub) && !/recog/i.test(p.text) && p.pay.some((r) => r.label === 'Ubicación') ? okv('shown', 'delivery copy + Ubicación') : bad(`delivery copy missing / pickup wording present ("${p.sub}")`); },
    SCHED: (s, f) => { const p = confirmation.parse(s); if (!f.SCHED.value.asap) return bad('P1-a: scheduled is not in this slice'); return /programad/i.test(p.text) ? bad('an ASAP order shows scheduled wording') : okv('shown', `ASAP ("${p.sub}")`); },
    PLACE: (s, f) => {
      const p = confirmation.parse(s); const loc = p.pay.find((r) => r.label === 'Ubicación'); const o = f._meta.persisted;
      if (!loc) return bad('no Ubicación row for a delivery order');
      const hrefs = [...frag(loc.html).querySelectorAll('a')].map((a) => a.getAttribute('href'));
      const coords = hrefs.map((h) => (/[?&](?:q|ll)=(-?[\d.]+),(-?[\d.]+)/.exec(h) || []).slice(1).map(Number));
      return coords.length && coords.every(([la, ln]) => la === o.lat && ln === o.lng) ? okv('shown', `Maps / Waze at ${o.lat},${o.lng}`) : bad(`Ubicación links ${JSON.stringify(hrefs)} ≠ persisted ${o.lat},${o.lng}`);
    },
    'DISPLAY:envio_gratis': (s, f, ctx) => { const p = confirmation.parse(s); const r = p.items.find((x) => /Env[ií]o/.test(x.label)); return envioDisplay(r && { ...r, name: r.label }, f, ctx, (x) => /Env[ií]o Gratis/.test(x.label) && x.struck && cmpC({ centavos: 7000, currency: 'HNL' }, x.value).ok, (p.items.find((x) => x.label === 'Total') || {}).value); },
  },
};

// ── WhatsApp order-received (R9) — the rendered body captured at the transport ──
const waPayload = {
  capture: ({ sends, phone }) => ({ sends: sends.filter((x) => x.to === String(phone).replace(/^\+/, '')).map((x) => ({ to: x.to, body: x.body, origin: x.origin })), exposed: exposedBy([[sends.some((x) => x.to === String(phone).replace(/^\+/, '')), 'a message was delivered to the customer\'s phone at the transport']]) }),
  one(s) { return s.sends.length === 1 ? s.sends[0].body : null; },
  compare: {
    ITEMS: (s, f) => { const b = waPayload.one(s); if (b == null) return bad(`${s.sends.length} sends to the customer (expected exactly one at LP new)`); const rows = [...b.matchAll(/^🍕 (.+)$/gmu)].flatMap((m) => m[1].split(/\s*\|\s*|,\s*(?=\d+x )/)).map((t) => { const m = /^(\d+)x (.+) \((L\s?[\d,.]+)\)$/.exec(t.trim()); return m ? { qty: Number(m[1]), name: m[2], price: m[3] } : { qty: NaN, name: t }; }); return itemsAgree(rows, f.ITEMS.value, 'order-received WhatsApp'); },
    MONEY: (s, f) => { const b = waPayload.one(s); const m = b && /Total: (L\s?[\d,.]+)/.exec(b); if (!m) return bad('no Total in the message'); const c = cmpL(f.MONEY.value, m[1]); return c.ok ? okv('shown', m[1]) : bad(`message total — ${c.reason}`); },
    BRAND: (s, f) => { const b = waPayload.one(s); return b && b.includes(`Recibimos tu pedido en ${f.BRAND.value} `) ? okv('shown', f.BRAND.value) : bad(`brand "${f.BRAND.value}" not named in "${b && b.split('\n')[2]}"`); },
    FULFIL: (s, f) => { const b = waPayload.one(s) || ''; if (f.FULFIL.value !== 'delivery') return bad('P1-a: pickup is not in this slice'); return /en camino/.test(b) && !/recog/i.test(b) ? okv('shown', 'delivery copy ("en camino")') : bad('delivery copy missing / pickup wording present'); },
    STATUS: (s, f) => { const b = waPayload.one(s) || ''; return f.STATUS.value === 'new' && /Recibimos tu pedido/.test(b) ? okv('shown', 'received') : bad(`status ${f.STATUS.value} vs "${b.split('\n')[2]}"`); },
    NUM: (s, f) => { const b = withoutTracking(waPayload.one(s) || '', f._meta.persisted); return NUM_ANY.test(b) || b.includes(f._meta.orderId) ? bad(`an order number is shown in the message ("${(NUM_ANY.exec(b) || [f._meta.orderId])[0]}") — compare it, not absence`) : okv('not-shown', 'no order number of any value in the message (the tracking link carries the order)'); },
    PAYLIFE: (s) => notShown(waPayload.one(s) || '', PAY_WORDS, 'payment wording'),
    COLLECT: (s) => notShown(waPayload.one(s) || '', PAY_WORDS, 'collect wording'),
    PLACE: (s, f) => { const b = withoutTracking(waPayload.one(s) || '', f._meta.persisted); return placeShown(b, f._meta.persisted) ? bad('a place / address IS in the message (any value; not-in-source expected absent)') : okv('not-shown', 'no place / address of any value in the message (not in source)'); },
  },
};

const OBSERVABLES = { 'kds.ticket': kdsTicket, 'form.cartPill': cartPill, 'form.reviewSheet': reviewSheet, 'form.payStep': payStep, 'form.confirmation': confirmation, 'wa.orderReceived': waPayload };
module.exports = { OBSERVABLES, squash, MONEY_TOKEN };
