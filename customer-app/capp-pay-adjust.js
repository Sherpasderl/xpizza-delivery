// Customer app — S2: the order's total changes AFTER the card hold (PLAN-capp-native-shell-and-payments r3.8 §2.10; the owner-
// approved MOCKUP-capp-S2-adjustment r3, frames A–G, owner rulings 11-07; SLICE-capp-S2-adjustment-client r0, advisor OK 11-08).
// Built to CONTRACT-sdk-customer r4 (APPROVED AS CONTRACT 11-08): the input is the server's customer-safe projection
// `order_pay_view/{token}` (§1.2) exactly as published — read here, never written; its ONE closed Outcome enum (§1.3) picks the frame.
// Pure: view + order status + this device's own state → which frame the order screen draws, and its HTML. No DOM, no I/O, no clock:
// the shell streams the view, anchors the countdown monotonically (§1.4) and passes `left` (ms to the deadline). Dark unless
// runtime.sdkPay. Brand-agnostic: the restaurant is data. Money in integer cents.
//   A  notice (a committed decrease): «Actualizamos tu total» (+ «Más información» → B)
//   B  «¿Cómo funciona el cobro?» — the ONLY place holds are explained (owner r2)
//   C  consent.outcome `pending`: «{restaurante} cambió tu pedido», the change list, 3 min (owner)
//   E  `processing` / `bank_pending` (no well) · `action_required` (the SDK challenge well)
//   D  `accepted`: the status subline «Nuevo total aceptado» (owner: a status line only)
//   F  `kept` / `expired` / `not_applied` — or the countdown reached zero while the view still says `pending` (§1.4) — and G once
//      dismissed: «Tu pedido sigue como estaba. Total L X» from total_cents, never old_total_cents (§1.3)
//   G  `declined`: ONE button «Mantener mi pedido» (owner) → F
//   R  `under_review`: a calm inline notice, no button — NEW UX, copy OWNER-PENDING (placeholder below; advisor 11-08)
//   local: { help?: true, dismissed?: { [adjustment_id]: true }, left?: ms | null, readOnly?: true (a shared-link viewer, §3.2) }
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappPayAdjust = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const int = (n) => Number.isInteger(n);
  const cents = (n) => int(n) && n >= 0;
  const moneyC = (c) => 'L ' + Math.round(c / 100).toLocaleString('en-US');
  const signed = (c) => (c < 0 ? '− ' : '') + moneyC(Math.abs(c));
  // the mockup's own glyphs
  const I = (p) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
  const IC = {
    info: I('<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>'),
    card: I('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path>'),
    cardX: I('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path><path d="M7 15h4"></path>'),
    edit: I('<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"></path><path d="M13.5 6.5l3 3"></path>'),
    down: I('<path d="M6 9l6 6 6-6"></path>'),
  };
  // CONTRACT §1.3 — the closed enum, verbatim; anything else is not a view this app knows (⇒ no adjustment UI)
  const OUTCOMES = Object.freeze(['pending', 'processing', 'action_required', 'bank_pending', 'accepted', 'declined', 'kept', 'expired', 'not_applied', 'under_review']);
  const FRAME = Object.freeze({ pending: 'C', processing: 'E', action_required: 'E', bank_pending: 'E', accepted: 'D', declined: 'G', kept: 'F', expired: 'F', not_applied: 'F', under_review: 'R' });
  const BRANDS = Object.freeze({ visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex' });   // §4; `other` ⇒ no brand word
  const CANCELLED = new Set(['cancelled']), TERMINAL = new Set(['delivered', 'collected', 'completed', 'closed']);
  const CONSENT_MIN = 3;   // owner 11-07; the server's expires_at is authoritative

  // a view this app can draw: v 1, the committed total, and (when present) a consent / notice of the contract's shape
  const viewOk = (v) => !!v && typeof v === 'object' && v.v === 1 && cents(v.total_cents);
  const consentOk = (c) => !!c && typeof c.adjustment_id === 'string' && c.adjustment_id !== '' && OUTCOMES.includes(c.outcome) && cents(c.old_total_cents) && cents(c.new_total_cents) && int(c.expires_at) && Array.isArray(c.changes);
  const noticeOk = (n) => !!n && n.kind === 'decrease' && cents(n.old_total_cents) && cents(n.new_total_cents) && Array.isArray(n.changes);

  // view + the order's status + local → { notice: 'decrease' | 'kept' | 'review' | null, sheet: 'help' | 'consent' | 'verify' | 'declined' | null, well, statusSub, readOnly }
  function frameOf(view, status, local) {
    const out = { notice: null, sheet: null, well: false, statusSub: null, readOnly: false };
    if (!viewOk(view) || CANCELLED.has(status)) return out;   // §1.3 precedence: cancelled ⇒ the cancellation view only
    const L = local && typeof local === 'object' ? local : {};
    const c = consentOk(view.consent) ? view.consent : null;
    if (noticeOk(view.notice) && !TERMINAL.has(status)) out.notice = 'decrease';   // the notice only while active
    if (c && !TERMINAL.has(status)) {
      let f = FRAME[c.outcome];
      if (f === 'C' && Number.isFinite(L.left) && L.left <= 0) f = 'F';   // §1.4: zero ⇒ F locally while the view still says pending
      if (f === 'G' && L.dismissed && L.dismissed[c.adjustment_id] === true) f = 'F';
      if (f === 'C') { out.sheet = 'consent'; out.readOnly = L.readOnly === true; }
      else if (f === 'E') { out.sheet = 'verify'; out.well = c.outcome === 'action_required' && L.readOnly !== true; }
      else if (f === 'G') out.sheet = L.readOnly === true ? null : 'declined';
      else if (f === 'D') out.statusSub = 'Nuevo total aceptado';
      else if (f === 'R') out.notice = 'review';
      if (f === 'F' || (f === 'G' && L.readOnly === true)) out.notice = 'kept';
    }
    if (L.help === true && (out.sheet === null || out.sheet === 'consent')) out.sheet = 'help';   // B over A or C; never over E / G
    return out;
  }

  // «Tenés N min para responder»: whole minutes to the anchored deadline, never below 1 while the sheet shows
  const minutesLeft = (left) => (Number.isFinite(left) ? Math.max(1, Math.min(CONSENT_MIN, Math.ceil(left / 60000))) : CONSENT_MIN);

  const cardText = (card) => {
    if (!card || !/^\d{4}$/.test(String(card.last4))) return '';
    const b = Object.prototype.hasOwnProperty.call(BRANDS, card.brand) ? BRANDS[card.brand] : '';
    return `${b ? b + ' ' : ''}···· ${esc(card.last4)}`;
  };

  // one Change (§2) as a .sumrow. Drawn by the mockup: an added line («+ name», its cents). The other kinds have NO drawn copy —
  // OWNER-PENDING: the name (+ its configuration, «no disponible» as A's receipt draws it) and the signed effect on the total
  const COMPONENT = { delivery: 'Envío', tip: 'Propina', discount: 'Descuento' };
  function changeRow(ch) {
    if (!ch || !int(ch.delta_cents)) return '';
    if (ch.kind === 'component') return COMPONENT[ch.component] ? `<div class="sumrow"><span>${COMPONENT[ch.component]}</span><span>${signed(ch.delta_cents)}</span></div>` : '';
    if (typeof ch.name !== 'string' || !ch.name) return '';
    const name = `${esc(ch.name)}${typeof ch.config === 'string' && ch.config ? ` · ${esc(ch.config)}` : ''}`;
    if (ch.kind === 'line_added') return `<div class="sumrow"><span>+ ${name}</span><span>${moneyC(ch.delta_cents)}</span></div>`;
    if (ch.kind === 'line_removed' || ch.kind === 'line_unavailable' || ch.kind === 'line_qty' || ch.kind === 'line_price') {
      return `<div class="sumrow"><span>${name}${ch.kind === 'line_unavailable' ? ' · no disponible' : ''}</span><span>${signed(ch.delta_cents)}</span></div>`;
    }
    return '';
  }

  // A / F / R: the inline lines right after the status row
  function noticeHtml(view, fr) {
    if (!viewOk(view)) return '';
    const parts = [];
    if (fr.notice === 'decrease') {
      const n = view.notice, why = n.changes.some((c) => c && c.kind === 'line_unavailable') ? 'Un producto no estaba disponible. ' : '';
      parts.push(`<div class="notecard" role="status">${IC.info}<div class="t"><b>Actualizamos tu total</b><p>${why}Tu nuevo total es ${moneyC(n.new_total_cents)} y es lo único que se te cobra.</p><button class="lnk" data-act="adj-more">Más información</button></div></div>`);
    }
    if (fr.notice === 'kept') parts.push(`<div class="closednote" role="status">${IC.info}<span>Tu pedido sigue como estaba. Total ${moneyC(view.total_cents)}.</span></div>`);
    // OWNER-PENDING placeholder (advisor 11-08: under_review = a calm notice, no button; flagged for the owner's copy)
    if (fr.notice === 'review') parts.push(`<div class="closednote" role="status" data-owner-pending="under_review">${IC.info}<span>Estamos revisando el cambio de tu total. Te avisamos por WhatsApp.</span></div>`);
    return parts.join('');
  }

  // the payment block (every frame): «Pago» + the card, «Total» (the committed total), «Se cobra al recibir tu pedido.»
  function payHtml(view) {
    if (!viewOk(view)) return '';
    const label = cardText(view.card);
    return `<div class="receipt"><button class="toggle" aria-expanded="true">Pago${label ? ` <span>${label}</span>` : ''}${IC.down}</button><div class="rbody"><div class="rrow tot"><span>Total</span><span class="r">${moneyC(view.total_cents)}</span></div><p class="note">Se cobra al recibir tu pedido.</p></div></div>`;
  }

  // B · C · E · G
  function sheetHtml(view, fr, local, storeName) {
    if (!viewOk(view)) return '';
    const c = view.consent, L = local && typeof local === 'object' ? local : {};
    if (fr.sheet === 'help') {
      return `<div class="scrim" data-act="adj-ok"></div><div class="sheet" role="dialog" aria-label="¿Cómo funciona el cobro?"><div class="grab"></div><div class="errsheet"><div class="icon calm">${IC.card}</div><h2>¿Cómo funciona el cobro?</h2><p>Al hacer tu pedido, tu banco reserva el monto en tu tarjeta. El cobro real se hace cuando recibís tu pedido, y solo por el total final (${moneyC(view.total_cents)}).</p><p>Si el total cambia, tu banco puede mostrar por unos días un cargo pendiente por el monto anterior. No se cobra: el banco lo libera solo.</p><div class="acts"><button class="primary" data-act="adj-ok">Entendido</button></div></div></div>`;
    }
    if (fr.sheet === 'consent') {
      const store = esc(storeName || ''), label = cardText(view.card);
      const acts = fr.readOnly
        // §3.2: a shared-link viewer sees the change without buttons — OWNER-PENDING copy
        ? '<p class="note" data-owner-pending="read_only">Respondé desde la app con la que hiciste el pedido</p>'
        : `<div class="acts"><button class="primary" data-act="adj-accept">Aceptar nuevo total</button><button class="btn2 wide" data-act="adj-keep">Mantener mi pedido</button></div>
            <p class="cdown">Tenés ${minutesLeft(L.left)} min para responder</p>`;
      return `<div class="scrim"></div><div class="sheet" role="alertdialog" aria-label="${store} cambió tu pedido"><div class="grab"></div><div class="errsheet"><div class="icon calm">${IC.edit}</div><h2>${store} cambió tu pedido</h2><p>${store} agregó esto a tu pedido. Revisalo antes de aceptar el nuevo total.</p>
            <div class="osum">${c.changes.map(changeRow).join('')}<div class="sumrow tot"><span>Total</span><span><span class="strike">${moneyC(c.old_total_cents)}</span>${moneyC(c.new_total_cents)}</span></div></div>
            <p class="note">Se cobra ${label ? `a tu ${label} ` : ''}al recibir tu pedido. <button class="lnk" data-act="adj-more">Más información</button></p>
            ${acts}</div></div>`;
    }
    if (fr.sheet === 'verify') {
      return `<div class="scrim"></div><div class="sheet" role="dialog" aria-label="Verificando con tu banco" aria-live="polite"><div class="grab"></div><div class="errsheet"><i class="ring" aria-hidden="true"></i><h2>Verificando con tu banco…</h2><p>Tu banco pide confirmar el nuevo total. No cerrés la app.</p>${fr.well ? '<div class="ph3ds" id="adj-3ds"></div>' : ''}</div></div>`;
    }
    if (fr.sheet === 'declined') {
      return `<div class="scrim"></div><div class="sheet" role="alertdialog" aria-label="No pudimos actualizar tu total"><div class="grab"></div><div class="errsheet"><div class="icon">${IC.cardX}</div><h2>No pudimos actualizar tu total</h2><p>Tu banco no autorizó el nuevo total. Tu pedido sigue como estaba (${moneyC(view.total_cents)}).</p><div class="acts"><button class="primary" data-act="adj-keep">Mantener mi pedido</button></div></div></div>`;
    }
    return '';
  }

  return { frameOf, noticeHtml, payHtml, sheetHtml, minutesLeft, OUTCOMES, FRAME };
});
