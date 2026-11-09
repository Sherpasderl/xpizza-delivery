// Customer app — S2-checkout: the MARKUP of the owner-approved MOCKUP-capp-S2-sdk-checkout v7 (owner 11-08, the exact build target;
// v3's 1–4 + 8, v2's 5–7 restored). Pure HTML from CappPayCard's view models — no DOM, no I/O, no state; capp-ui owns the flow.
//   1 payBarHtml   the payment row (brand tile · label · chevron) + the charge line + the primary, in the pay bar (Uber Eats)
//   2 chooserHtml  «Elegí cómo pagar»: ✕, the saved cards (a checkmark on the selected; an expired one shown, not selectable),
//                  «Agregar tarjeta», «Efectivo al entregar» (members, where the store allows cash)
//   3 formHtml     «Agregar tarjeta» (DoorDash): back arrow, stacked fields, ONE pinned «Guardar tarjeta». The inputs come from an
//                  injected FIELD HOST (advisor Q9, PCI unsettled): without one, no input is drawn in the webview
//   4 procHtml     «Procesando tu pago…» over the dimmed checkout; 4b + the owner's under_review line
//   5 declineHtml  v2's decline sheet, per bucket; 6 / 7 gateHtml the checkout's .gate well (expired saved card / card unavailable)
//   4c is the SDK's own native challenge themed with our tokens (contract §8, VENDOR) — not DOM here.
// Brand-agnostic (the restaurant is not named on these frames); every string from the mockup's copy table (CappPayCard.COPY).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappPayCheckout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const moneyC = (c) => 'L ' + Math.round(c / 100).toLocaleString('en-US');
  const PC = (typeof self !== 'undefined' && self.CappPayCard) || (typeof require === 'function' ? require('./capp-pay-card.js') : null);
  const I = (p) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;
  const IC = {
    chev: '<svg class="i chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>',
    tick: '<svg class="i tick" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"></path></svg>',
    close: I('<path d="M6 6l12 12"></path><path d="M18 6L6 18"></path>'),
    plus: I('<path d="M12 5v14"></path><path d="M5 12h14"></path>'),
    cash: I('<rect x="3" y="6" width="18" height="12" rx="2"></rect><circle cx="12" cy="12" r="2.5"></circle><path d="M6 9h.01M18 15h.01"></path>'),
    card: I('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path>'),
    cardX: I('<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 10h18"></path><path d="M7 15h4"></path>'),
    back: I('<path d="M19 12H5"></path><path d="M11 18l-6-6 6-6"></path>'),
    alert: I('<circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path><path d="M12 16h.01"></path>'),
    info: I('<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path>'),
    lock: I('<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path>'),
  };
  // the mockup's two drawn tiles; any other brand ⇒ the plain card icon (no invented logo)
  const TILE = {
    visa: '<svg class="bb" viewBox="0 0 40 26" aria-hidden="true"><rect x=".5" y=".5" width="39" height="25" rx="4" fill="#FFFFFF" stroke="#D2D5DB"></rect><text x="20" y="17.6" text-anchor="middle" font-family="Red Hat Display, Arial, sans-serif" font-weight="800" font-style="italic" font-size="11.5" letter-spacing=".2" fill="#1A1F71">VISA</text></svg>',
    mastercard: '<svg class="bb" viewBox="0 0 40 26" aria-hidden="true"><rect x=".5" y=".5" width="39" height="25" rx="4" fill="#FFFFFF" stroke="#D2D5DB"></rect><circle cx="16" cy="13" r="7" fill="#EB001B"></circle><circle cx="24" cy="13" r="7" fill="#F79E1B" fill-opacity=".92"></circle></svg>',
  };
  const brandTile = (b) => (Object.prototype.hasOwnProperty.call(TILE, b) ? TILE[b] : IC.card);
  const btn = (cls, act, label, disabled) => `<button class="${cls}" data-act="${act}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`;

  // 1 (+ 6 / 7) — method: { kind: 'card', brand, label, sub?, dim? } | { kind: 'cash' } | null; gate: frame 6 / 7's well (gateHtml),
  // between the row and the primary — no charge line under a well; cta: { label, enabled, act? = 'place', id? } (the host's hooks)
  function payBarHtml({ method, total_cents, cta, gate }) {
    const c = cta || { label: '', enabled: false };
    const sub = method && typeof method.sub === 'string' && method.sub ? `<span>${esc(method.sub)}</span>` : '';
    const row = !method ? '' : method.kind === 'cash'
      ? `<div class="urows"><button class="urow payrow" aria-label="Cambiar forma de pago" data-act="paysheet">${IC.cash}<span class="t"><b>Efectivo al entregar</b></span>${IC.chev}</button></div>`
      : `<div class="urows"><button class="urow payrow${method.dim ? ' dim' : ''}" aria-label="Cambiar forma de pago" data-act="paysheet">${brandTile(method.brand)}<span class="t"><b>${esc(method.label)}</b>${sub}</span>${IC.chev}</button></div>`;
    // before the quote (advisor ruling 11-09 — a state v7 does not draw): frame 8's sentence without an amount; the quote prefixes
    // «Total L X · » in place — only a real total (a positive integer of cents), never «L 0» / «NaN»
    // the guard is on the RENDERED amount (Codex r1 P2): moneyC rounds to whole lempiras, so 1–49 cents would print «L 0»
    const amt = Number.isInteger(total_cents) && Math.round(total_cents / 100) >= 1 ? `Total ${moneyC(total_cents)} · ` : '';
    // the charge line: a card ⇒ «… Se cobra al recibir tu pedido.» + «Más información» (v7); cash ⇒ «… Pagás cuando llegue tu pedido.»
    // (tip-step r2 frame 5, owner-approved 11-09 — no hold, so no help link); none under a gate well (6 / 7)
    const line = !method || gate ? ''
      : method.kind === 'cash' ? `<p class="payline"><span>${amt}Pagás cuando llegue tu pedido.</span></p>`
      : `<p class="payline"><span>${amt}Se cobra al recibir tu pedido.</span><button class="lnk" data-act="adj-more">Más información</button></p>`;
    const id = typeof c.id === 'string' && c.id ? ` id="${esc(c.id)}"` : '';
    return `<div class="paybar pay">${row}${line}${gate || ''}<button class="primary"${id} data-act="${esc(c.act || 'place')}"${c.enabled ? '' : ' disabled'}>${esc(c.label)}</button></div>`;
  }

  // the row + the charge line alone — the tip step's footer, where «Hacer pedido» lives for a delivery (advisor ruling 3: one component)
  function payRowHtml(method, total_cents) {
    const h = payBarHtml({ method, total_cents, cta: { label: '', enabled: false } });
    return h.slice('<div class="paybar pay">'.length, h.lastIndexOf('<button class="primary"'));
  }

  // 2 — cards: CappPayCard.cardsVm; selected: { kind: 'card', card_id } | { kind: 'cash' } | null; cash: members where allowed
  function chooserHtml({ cards, selected, cash }) {
    const sel = selected || {};
    const rows = (cards && Array.isArray(cards.rows) ? cards.rows : []).map((r) => {
      const on = sel.kind === 'card' && sel.card_id === r.card_id && !r.expired;
      return `<button class="urow" aria-pressed="${on}" data-act="paypick" data-card="${esc(r.card_id)}"${r.expired ? ' disabled' : ''}>${brandTile(r.brand)}<span class="t"><b>${esc(r.label)}</b><span>${esc(r.sub)}</span></span>${on ? IC.tick : ''}</button>`;
    }).join('');
    const add = `<button class="urow" data-act="addcard">${IC.plus}<span class="t"><b>Agregar tarjeta</b></span></button>`;
    const cashOn = sel.kind === 'cash';
    const cashRow = cash ? `<button class="urow" aria-pressed="${cashOn}" data-act="paypick" data-card="cash">${IC.cash}<span class="t"><b>Efectivo al entregar</b><span>Pagás cuando llegue tu pedido.</span></span>${cashOn ? IC.tick : ''}</button>` : '';
    return `<div class="scrim" data-act="paysheet-close"></div><div class="sheet" role="dialog" aria-label="Elegí cómo pagar"><div class="grab"></div>
    <div class="topbar"><button class="iconbtn" aria-label="Cerrar" data-act="paysheet-close">${IC.close}</button><h2>Elegí cómo pagar</h2><span class="sp"></span></div>
    <div class="body"><div class="urows">${rows}${add}${cashRow}</div></div></div>`;
  }

  // 3 — fv: CappPayCard.formVm; host: { input(field) → the input's HTML } (DOM or a native secure-field placeholder) | null
  const FIELD = { number: { id: 'c-num', label: 'Número de tarjeta' }, expiry: { id: 'c-exp', label: 'Vencimiento' }, cvv: { id: 'c-cvv', label: 'CVV' }, name: { id: 'c-name', label: 'Nombre en la tarjeta' } };
  function formHtml(fv, host) {
    const v = fv || { errors: {}, primary: { label: 'Guardar tarjeta', enabled: false }, save: { shown: false } };
    const input = (f) => {
      let h = host && typeof host.input === 'function' ? host.input(f) : '';
      if (typeof h !== 'string') h = '';
      const err = v.errors && v.errors[f];
      return err ? h.replace(/>$/, ` aria-invalid="true" aria-describedby="${FIELD[f].id}-err">`) : h;
    };
    const fld = (f, extraCls, labelExtra, after) => {
      const err = v.errors && v.errors[f];
      return `<div class="fld${extraCls || ''}${err ? ' bad' : ''}"><label for="${FIELD[f].id}">${FIELD[f].label}${labelExtra || ''}</label>${input(f)}${after || ''}${err ? `<div class="err" id="${FIELD[f].id}-err" role="alert">${IC.alert}<span>${esc(err)}</span></div>` : ''}</div>`;
    };
    const tile = v.brand ? brandTile(v.brand) : '';
    const save = v.save && v.save.shown ? `<div class="togrow"><span class="t">Guardar tarjeta para la próxima</span><button class="switch" role="switch" aria-checked="${!!v.save.on}" aria-label="Guardar tarjeta para la próxima" data-act="savecard"></button></div>` : '';
    // the primary is v7's «Guardar tarjeta» (disabled until valid); the missing-step label lives in the field errors
    const ok = !!(v.primary && v.primary.enabled);
    return `<div class="flow px"><div class="flowbar"><button class="iconbtn" aria-label="Volver" data-act="addcard-back">${IC.back}</button></div>
            <h1 class="flowtitle">Agregar tarjeta</h1>
            <div class="fsec">
              ${fld('number', ' brand', '', tile)}
              <div class="pxrow">${fld('expiry')}${fld('cvv', '', `<button class="infobtn" aria-label="Qué es el CVV" data-act="cvv-info">${IC.info}</button>`)}</div>
              ${fld('name')}
              ${save}
              <div class="line pxlock">${IC.lock}<span>Tus datos van cifrados directo al banco. Solo guardamos los últimos 4 dígitos.</span></div>
            </div>
            <div class="paybar">${btn('primary', 'addcard-save', 'Guardar tarjeta', !ok)}</div>
          </div>`;
  }

  // 4 / 4b — card: { brand, label } | null; review: the PSP is slow (under_review)
  function procHtml({ total_cents, card, review }) {
    const cardl = card ? `<div class="cardl">${brandTile(card.brand)}<span>${esc(card.label)}</span></div>` : '';
    return `<div class="scrim"></div><div class="sheet proc" role="dialog" aria-label="Procesando tu pago" aria-live="polite"><div class="grab"></div><i class="ring lg" aria-hidden="true"></i><h2>Procesando tu pago…</h2><div><div class="amt">${moneyC(total_cents)}</div>${cardl}</div><p class="note">Esto toma unos segundos. No cerrés la app.</p>${review ? `<p class="note review">${esc(PC.COPY.review)}</p>` : ''}</div>`;
  }

  // 5 — step: CappPayCard.nextStep(declined); ctx: { guest, cashAllowed }
  function declineHtml(step, ctx) {
    const b = step && step.bucket, d = PC.COPY.declined[b] || PC.COPY.declined.hard;
    const acts = (step && Array.isArray(step.acts) ? step.acts : []).map((a, i) => btn(i === 0 ? 'primary' : 'btn2 wide', `decl-${a}`, PC.COPY.acts[a])).join('');
    return `<div class="scrim"></div><div class="sheet" role="alertdialog" aria-label="${esc(d.title)}"><div class="grab"></div><div class="errsheet"><div class="icon">${IC.cardX}</div><h2>${esc(d.title)}</h2><p>${esc(PC.declineBody(b, ctx))}</p><div class="acts">${acts}</div></div></div>`;
  }

  // 6 / 7 — the checkout's .gate well; a guest is card-only (owner ruling 3)
  function gateHtml(kind, ctx) {
    const c = ctx || {}, cash = c.guest !== true && c.cashAllowed === true;
    if (kind === 'token_expired') {
      return `<div class="gate" role="status"><b>Tu tarjeta guardada venció</b><span class="note">${esc(PC.declineBody('token_expired', c))}</span><div class="row2"><button class="btn2 dark" data-act="addcard">Agregar tarjeta</button>${cash ? '<button class="btn2" data-act="decl-cash">Pagar en efectivo</button>' : ''}</div></div>`;
    }
    if (!cash) return '<div class="gate" role="status"><b>El pago con tarjeta no está disponible ahora</b><span class="note">Intentá de nuevo en unos minutos. Tu pedido queda guardado.</span><div class="row2"><button class="btn2 dark" data-act="sdk-retry">Reintentar</button></div></div>';
    return '<div class="gate" role="status"><b>El pago con tarjeta no está disponible ahora</b><span class="note">Podés pagar en efectivo al recibir tu pedido. Todo lo demás sigue igual.</span><div class="row2"><button class="btn2 dark" data-act="decl-cash">Pagar en efectivo</button></div></div>';
  }

  return { payBarHtml, payRowHtml, chooserHtml, formHtml, procHtml, declineHtml, gateHtml, brandTile };
});
