// Customer app S2a (PLAN-capp-S2-r4 §5.1) — the CHECKOUT FLOW MODEL: «Entrega & Pago» + the tip step, as pure data. Pure, UMD,
// brand-agnostic (no restaurant id or name in this file — guarded). No DOM, no network: capp-api.js sends, S2b renders.
//
//   state    the prototype's S.flow (APPROVED-v6 freshFlow :1801-1805) for ONE restaurant: mode, pin, details, name, phone,
//            email, rtn, razon, rtnNum, notes, pay, tendered, tipChoice (null = nothing chosen yet), tipCents. It survives the
//            cart ↔ checkout round trip (rail ES 1022): the host keeps the object.
//   gates    missingStep (:1812-1824), in order, the same copy — preceded by G0, the closed store (Q2: ASAP only in S2).
//   money    (finding #1) Subtotal = the quote's FOOD total_cents (== the cart subtotal, else re-quote); Envío = the quote's
//            delivery_cents; Total = the net_total_cents of the quote issued FOR THE SELECTED TIP — never net + tip here.
//   cartSig  sha256(canonicalJson({restaurant_id, items, order_type, pin, uid, tip_cents})): a token never rides a different
//            restaurant / cart / mode / pin / auth / tip (the ported capp-confirm-quote.js attaches on a signature match only).
//   bodies   deterministic quote + order bodies (§5.1); quote_token / expected_net_cents are attached ONLY by the ported
//            module's send(). Every quote body (cash AND card) carries entry_mode:'app' (§3.6).
//   geo      S2b-geo (MOCKUP-capp-S2b-geo-address.html; PLAN-colonia r1 §1): the reverse-geocode of a CONFIRMED pin, bound to
//            the pin's version (pinV). Every pin change bumps pinV and clears geo SYNCHRONOUSLY; a reply applies only to the
//            version it was asked for. The order body carries address_area (PLAN-colonia §1) ONLY for a delivery whose CONFIRMED pin
//            has a non-empty area bound to its current version — raw (the server's privacy filter is the only authority); pending,
//            superseded, failed or pickup ⇒ no key. Never in the quote body or the cart signature.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappCheckout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TIP_PRESETS = [0, 20, 40, 60];   // lempiras — the platform's fixed presets (prototype SH.tips :1148, ruling 12)
  const TIP_MAX_LEMPIRAS = 2000;          // the server's TIP_MAX_CENTS / 100 (owner Q7; the functions' tip.js) — pinned by a test
  const ENTRY_MODE = 'app';
  // G0 (Q2, finding #11): the closed store's CTA — the prototype's own ASAP-card copy (checkoutHtml :1838)
  const COPY = {
    closed: 'No disponible · cerrado',
    pickupOnly: 'Quitá los platos solo para Pickup',
    outZone: 'Fuera de la zona de delivery',
    pin: 'Ajustá el pin a tu dirección',
    details: 'Agregá Detalles adicionales',
    name: 'Escribí tu nombre',
    phone: 'Escribí tu WhatsApp',
    email: 'Revisá tu correo',
    pay: 'Elegí cómo pagar',
    rtn: 'Completá tu RTN (14 dígitos)',
  };
  // the closure-refusal sheet (placeTap :1974). OWNER 2026-10-26 (DECISIONS.md): S2 DROPS the sentence promising «Programar»
  // (hidden until S4); it is kept here as `scheduleHint` so S4 re-enables it by appending it to `body` again
  const CLOSED_SHEET = {
    title: (name, closes) => `${name} cerró a las ${closes}`,
    body: 'Tu pedido no se envió.',
    scheduleHint: 'Podés programarlo para el próximo horario disponible.',   // S4 only
  };
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;   // the prototype's check (:1821)
  const localPhone = (p) => String(p || '').replace(/\D/g, '').replace(/^504/, '');
  const validEmail = (e) => { const t = String(e || '').trim(); return t && EMAIL_RE.test(t) ? t : ''; };

  // ── state ──
  // member: the optional host context { uid, idToken, name, phone, email, lastPay, details } (§5.4)
  function freshFlow(member) {
    const m = member || null;
    return {
      mode: 'delivery', pin: { lat: null, lng: null, confirmed: false },
      details: m && m.details ? String(m.details) : '', name: m ? String(m.name || '') : '', phone: m ? String(m.phone || '') : '',
      email: m ? String(m.email || '') : '', rtn: false, razon: '', rtnNum: '', notes: '',
      pay: m && (m.lastPay === 'cash' || m.lastPay === 'online') ? m.lastPay : '', tendered: '', editWho: false,
      tipChoice: null, tipCents: 0,
      pinV: 0, geo: null,   // S2b-geo: the pin's version and its reverse-geocode { v, street, area } (null = none yet)
    };
  }
  // switching to pickup clears the tip (prototype :1891, :1909-1913); pickup never reaches the tip step
  function setMode(f, mode) {
    f.mode = mode === 'pickup' ? 'pickup' : 'delivery';
    if (f.mode === 'pickup') { f.tipChoice = null; f.tipCents = 0; }
    return f;
  }
  function setPin(f, lat, lng, confirmed) {
    const p = { lat: Number(lat), lng: Number(lng), confirmed: confirmed === true };
    const o = f.pin;
    if (o && o.lat === p.lat && o.lng === p.lng && o.confirmed === p.confirmed) return f;   // the same pin keeps its version (one geocode)
    f.pin = p; f.pinV = (Number(f.pinV) || 0) + 1; f.geo = null;   // a NEW pin: its old street / area are gone at once
    return f;
  }

  // ── S2b-geo: the reverse-geocode of the confirmed pin (Google Geocoder results, address_components) ──
  const compsOf = (results) => (Array.isArray(results) ? results : []).flatMap((r) => (r && Array.isArray(r.address_components) ? r.address_components : []));
  const nameOf = (c) => (c && typeof c.long_name === 'string' ? c.long_name.trim() : '');
  const hasType = (c, t) => !!(c && Array.isArray(c.types) && c.types.includes(t));
  // PLAN-colonia §1: neighborhood, else sublocality_level_1, else sublocality — never locality / route / street_number. Raw:
  // the server's privacy filter is the only authority over what is kept.
  function areaFromGeocode(results) {
    const cs = compsOf(results);
    for (const t of ['neighborhood', 'sublocality_level_1', 'sublocality']) { const c = cs.find((x) => hasType(x, t) && nameOf(x)); if (c) return nameOf(c); }
    return '';
  }
  // the street: the route's long_name ONLY (no street_number, no plus_code); Google's «Unnamed Road» is no street
  function routeFrom(results) {
    const c = compsOf(results).find((x) => hasType(x, 'route') && nameOf(x));
    const n = c ? nameOf(c) : '';
    return /^unnamed road$/i.test(n) ? '' : n;
  }
  // a reply for version v: applied ONLY if the pin is still that version (a superseded reply is discarded); a failed or empty
  // reply settles the version with nothing (no retry: one geocode per confirmed pin)
  function applyGeocode(f, v, results) {
    if (v !== f.pinV) return false;
    f.geo = { v, street: routeFrom(results), area: areaFromGeocode(results) };
    return true;
  }
  // display only (advisor ruling 2026-10-26, a truth rule): an area name that already says what it is — Colonia / Col. / Barrio /
  // Bo. / Residencial / Res., as a whole word — is shown as given (never «Col. Barrio …»); otherwise «Col. {X}». address_area stays raw.
  const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const displayArea = (a) => (/^(colonia|col|barrio|bo|residencial|res)(\.|\s)/.test(fold(a) + ' ') ? a : 'Col. ' + a);
  // PLAN-colonia §1 at submit: the area of THIS confirmed pin version, or '' (pending / superseded / none — submit never waits)
  function areaOf(f) {
    const g = f && f.geo;
    return g && g.v === f.pinV && f.pin && f.pin.confirmed === true && typeof g.area === 'string' ? g.area : '';
  }
  // the delivery line (A1 «{street}, Col. {X}» · b «{street}» · b2 «Col. {X}»); '' = today's row (c: none, pending, stale)
  function addrLine(f) {
    const g = f && f.geo;
    if (!g || g.v !== f.pinV || !(f.pin && f.pin.confirmed === true)) return '';
    const a = g.area ? displayArea(g.area) : '';
    return g.street && a ? g.street + ', ' + a : g.street || a;
  }
  // a preset (lempiras, one of TIP_PRESETS) or «Otro» { other: lempiras }. 0 either way = «Sin propina» (a CHOICE, not null)
  function chooseTip(f, choice) {
    let l = null; let kind = null;
    if (typeof choice === 'number' && TIP_PRESETS.includes(choice)) { l = choice; kind = 'preset'; }
    else if (choice && typeof choice === 'object' && Number.isInteger(choice.other) && choice.other >= 0 && choice.other <= TIP_MAX_LEMPIRAS) { l = choice.other; kind = 'other'; }
    if (l === null || f.mode !== 'delivery') return false;
    f.tipChoice = l === 0 ? { kind: 'none', lempiras: 0 } : { kind, lempiras: l };
    f.tipCents = l * 100;
    return true;
  }
  const tipCentsOf = (f) => (f.mode === 'delivery' && f.tipChoice ? f.tipCents : 0);
  const tipChosen = (f) => f.mode !== 'delivery' || f.tipChoice !== null;   // «Hacer pedido» disabled until a preset or «Sin propina»

  // ── hours (the store config's [h1,m1,h2,m2] | null ×7, Sun..Sat — the same reader capp-ui.js uses) ──
  const rangeOf = (hours, day) => { const h = hours && hours[day]; return Array.isArray(h) && h.length === 4 ? [h[0] * 60 + h[1], h[2] * 60 + h[3]] : null; };
  function isOpenAt(hours, d) { const o = rangeOf(hours, d.getDay()); const m = d.getHours() * 60 + d.getMinutes(); return !!o && m >= o[0] && m < o[1]; }
  // the closing instant (ms) of the business day of `d`, or null when the hours cannot be read / the day is closed
  function closingAt(hours, d) {
    const o = rangeOf(hours, d.getDay());
    if (!o) return null;
    const c = new Date(d.getTime()); c.setHours(0, 0, 0, 0);
    return c.getTime() + o[1] * 60000;
  }

  // ── gates ── ctx: { open, closedRefused, pickupOnlyCount, outZone, member } → '' | the CTA copy (in order)
  function missingStep(f, ctx) {
    const c = ctx || {};
    const del = f.mode === 'delivery';
    if (c.open === false || c.closedRefused === true) return COPY.closed;
    if (del && (c.pickupOnlyCount || 0) > 0) return COPY.pickupOnly;
    if (del && c.outZone === true) return COPY.outZone;
    if (del && !(f.pin && f.pin.confirmed === true && Number.isFinite(f.pin.lat) && Number.isFinite(f.pin.lng))) return COPY.pin;
    if (del && (f.details || '').trim().length < 3) return COPY.details;
    if (!c.member || f.editWho) {
      if (!(f.name || '').trim()) return COPY.name;
      if (localPhone(f.phone).length !== 8) return COPY.phone;
    }
    if (f.email && !EMAIL_RE.test(String(f.email).trim())) return COPY.email;
    if (!f.pay) return COPY.pay;
    if (f.rtn && !/^\d{14}$/.test((f.rtnNum || '').trim())) return COPY.rtn;
    return '';
  }

  // ── canonical JSON + the cart signature ──
  function canonicalJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  // ctx: { restaurantId, items (the S1 serializer's), member }
  function sigInput(f, ctx) {
    const del = f.mode === 'delivery';
    return { restaurant_id: ctx.restaurantId, items: ctx.items, order_type: f.mode,
      pin: del ? { lat: f.pin.lat, lng: f.pin.lng, confirmed: f.pin.confirmed === true } : null,
      uid: ctx.member && ctx.member.uid ? String(ctx.member.uid) : null, tip_cents: tipCentsOf(f) };
  }
  async function cartSig(f, ctx, subtle) {
    const s = subtle || (typeof crypto !== 'undefined' && crypto.subtle);
    const bytes = new TextEncoder().encode(canonicalJson(sigInput(f, ctx)));
    const h = new Uint8Array(await s.digest('SHA-256', bytes));
    return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ── bodies (deterministic) ──
  const fullPhone = (p) => { const d = localPhone(p); return d ? '+504 ' + (d.length > 4 ? d.slice(0, 4) + '-' + d.slice(4) : d) : ''; };   // the forms' fullPhone (504)
  function quoteBody(f, ctx) {
    const del = f.mode === 'delivery';
    const b = { restaurant_id: ctx.restaurantId, items: ctx.items, mode: f.mode, entry_mode: ENTRY_MODE };
    if (del) b.pin = { lat: f.pin.lat, lng: f.pin.lng, confirmed: f.pin.confirmed === true };
    const t = tipCentsOf(f); if (t > 0) b.tip_cents = t;
    return b;
  }
  // ctx: { restaurantId, items, itemsText, orderId }
  function orderBody(f, ctx) {
    const del = f.mode === 'delivery';
    const b = { restaurant_id: ctx.restaurantId, order_id: ctx.orderId, customer_name: (f.name || '').trim(), customer_phone: fullPhone(f.phone),
      items: ctx.items, items_text: ctx.itemsText, notes: (f.notes || '').trim() || '—', order_type: f.mode,
      payment_method: f.pay === 'online' ? 'online' : 'cash', razon_social: f.rtn ? (f.razon || '').trim() : '', rtn_cliente: f.rtn ? (f.rtnNum || '').trim() : '' };
    if (del) { b.lat = f.pin.lat; b.lng = f.pin.lng; b.pin_confirmed = true; b.address_details = (f.details || '').trim(); const a = areaOf(f); if (a) b.address_area = a; }
    const em = validEmail(f.email); if (em) b.customer_email = em;
    const t = tipCentsOf(f); if (t > 0) b.tip_cents = t;
    if (b.payment_method === 'cash') { const ct = Number(f.tendered); if (Number.isFinite(ct) && ct > 0) b.cash_tendered = ct; }
    else b.entry_mode = ENTRY_MODE;
    return b;
  }

  // ── money (finding #1) ── q: the quote record { resp, sig, tipCents } for the CURRENT signature, or null
  function totals(f, q, cartSubtotalCents, currentSig) {
    if (!q || !q.resp || q.resp.ok !== true) return { ready: false, reason: 'no_quote' };
    if (currentSig != null && q.sig !== currentSig) return { ready: false, reason: 'stale_quote' };
    if (q.tipCents !== tipCentsOf(f)) return { ready: false, reason: 'tip_requote' };
    const r = q.resp;
    if (r.total_cents !== cartSubtotalCents) return { ready: false, reason: 'subtotal_mismatch' };   // re-quote; never show a guess
    const d = f.mode === 'delivery' && r.delivery ? r.delivery : null;
    const promo = d && Number(d.promo_discount_cents) > 0;
    return { ready: true, subtotal: r.total_cents, envio: d ? d.delivery_cents : 0, envioFree: !!promo, promoCents: promo ? d.promo_discount_cents : 0,
      tip: tipCentsOf(f), total: r.net_total_cents };
  }
  // cash change against the QUOTED Total (lempiras in, cents out); null when nothing / too little was entered
  function changeCents(f, totalCents) {
    const ct = Math.round(Number(f.tendered) * 100);
    return Number.isFinite(ct) && ct >= totalCents && ct > 0 ? ct - totalCents : null;
  }

  // PLAN-capp-S7a r3.3-F2 [r2] (Codex perf r2 New-2): "is the served menu unchanged?" is a CONTENT FINGERPRINT of the RAW envelope —
  // sha-256 over THIS file's canonicalJson (one canonical form in the app) — never deep equality of adapted models (they carry
  // functions). The envelope body carries no transport metadata (the etag is an HTTP header). WebCrypto, so async.
  async function menuFingerprint(envelope) {
    if (!envelope || typeof envelope !== 'object' || !envelope.menu || typeof envelope.menu !== 'object') throw new Error('capp-checkout: no menu in the envelope');
    const subtle = typeof crypto !== 'undefined' && crypto ? crypto.subtle : null;
    if (!subtle) throw new Error('capp-checkout: no WebCrypto');
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(envelope)));
    return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  // PLAN 5 (owner-approved repriced-cart pattern, DECISIONS 2026-10-26 (1)) — the notice copy, ONE source with the forms: this
  // body is pinned byte-equal to the forms' priceNoticeText (fixtures/price-notice-text.body.txt, from b8ba8467; S7a r3.4-2).
  // Unit prices in LEMPIRAS (the caller converts cents). Rendered by capp-ui's cart sheet (frame 13, approved 2026-10-27).
  function priceNoticeText(e){ return 'Cambió el precio de ' + e.name + ': antes L ' + Number(e.from).toFixed(0) + ', ahora L ' + Number(e.to).toFixed(0) + '.'; }

  return { TIP_PRESETS, TIP_MAX_LEMPIRAS, ENTRY_MODE, COPY, CLOSED_SHEET, freshFlow, setMode, setPin, chooseTip, tipCentsOf, tipChosen,
    isOpenAt, closingAt, missingStep, canonicalJson, sigInput, cartSig, quoteBody, orderBody, totals, changeCents, fullPhone,
    areaFromGeocode, routeFrom, applyGeocode, displayArea, addrLine, menuFingerprint, priceNoticeText };
});
