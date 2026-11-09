// Customer app — «PEDIDO RECIBIDO»: the order screen after a placement, ported from the frozen prototype APPROVED-v6 (orderHtml
// P:2070-2105, statusCopy P:2055-2067, mapSvg / ROUTE / routePoint P:1785-1797) — the owner's 2026-11-01 ruling: v6 is approved,
// build what it draws (the driver card, the PIN card and «Parada rápida» included). Plus the approved deltas: the guest's
// account offer (MOCKUP-capp-guest-checkout frame 7, owner 10-27) in v6's `.rw` slot (D-3 k7's resolution, advisor-accepted), and
// the scheduled frames of MOCKUP-capp-S4-states: C «Pedido programado» (owner option B, 10-27) and R «Revisando tu pedido» (owner
// 11-01). Pure HTML from an order record + a context, no DOM, no clock of its own (`now` is passed) — the shell (capp-shell-ui)
// owns state, wiring and the live status. Brand-agnostic: every store difference is DATA (no restaurant id or name here).
// Fail closed (nothing invented): no «Orden #N» line until the server returns the display number; no PIN card without a PIN on the
// record; no «Ayuda» without the platform's help number; no «Compartir seguimiento» without a tracking link.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappOrder = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => 'L ' + Math.round(n).toLocaleString('en-US');
  const I = (d, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const IC = {   // v6's own paths (P:1190-1210)
    close: I('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
    home: I('<path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z"/>'),
    down: I('<path d="M6 9l6 6 6-6"/>'),
    wa: I('<path d="M4 20l1.3-3.9A8 8 0 1 1 8.2 19z"/><path d="M9.5 9.5c0 3 2 5 5 5l1-1.5-2-1-1 1a4 4 0 0 1-1.5-1.5l1-1-1-2z"/>'),
    share: I('<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/>'),
  };

  const FINAL = new Set(['delivered', 'collected', 'cancelled']);
  // the tracker's own words where v6 and the tracker share a state, from their ONE source (status-view.js, synced byte-identical): the
  // «parada rápida» line and the calm copy of a claim with no driver name yet (advisor ruling 2026-11-01 — never retyped here)
  const SV = () => (typeof StatusView !== 'undefined' ? StatusView : (typeof require === 'function' ? require('./status-view.js') : null));
  const STACKED_COPY = (() => { const v = SV(); return v ? v.STATUS_STACKED_COPY : ''; })();
  function namelessOut() { const v = SV(); const p = v ? v.presentStatus({ status: 'out_for_delivery', order_type: 'delivery', now: 0 }) : null; return p ? { t: p.headline, s: p.sub || '' } : { t: '', s: '' }; }
  // the v6 copy, byte for byte (statusCopy P:2055-2067); `d` = the driver's name
  function statusCopy(o) {
    const d = o.driver, del = o.mode === 'delivery';
    switch (o.status) {
      case 'new': return { t: 'Pedido recibido', s: 'Estamos por empezar a preparar tu pedido', segs: del ? [{ a: .5 }, 0, 0, 0, 0] : [{ a: .5 }, 0, 0] };
      case 'preparing': return { t: 'Tu pedido se está preparando', s: del ? 'Te avisaremos cuando vaya en camino' : 'Te avisaremos cuando esté listo', segs: del ? [1, { a: .55 }, 0, 0, 0] : [1, { a: .5 }, 0] };
      case 'ready': return { t: '¡Tu pedido está listo para recoger!', s: `Pasá por ${o.storeName} a recogerlo`, segs: [1, 1, { a: .5 }] };
      case 'collected': return { t: '¡Gracias por tu compra!', s: o.doneAt ? `Recogido a las ${o.doneAt}` : '', segs: [1, 1, 1] };
      // a claim with no driver name yet: the tracker's owner-approved calm copy (status-view) — v6 always names the driver (default, advisor)
      case 'out': if (!d) return { ...namelessOut(), segs: [1, 1, { a: .5 }, 0, 0] };
        return o.stacked ? { t: `${d} va en camino`, s: STACKED_COPY, segs: [1, 1, { a: .35 }, 0, 0], live: true, p: .3 }
        : { t: `${d} está en camino`, s: Number.isFinite(o.etaMin) ? `Llega en ~${o.etaMin} min` : '', big: true, segs: [1, 1, { a: .5 }, 0, 0], live: true, p: .45 };
      case 'arriving': return { t: `${d} está llegando`, s: 'Tu pedido está llegando', big: true, segs: [1, 1, 1, { a: .6 }, 0], live: true, p: .92 };
      case 'delivered': return { t: '¡Pedido entregado!', s: o.doneAt ? `¡Buen provecho! · Entregado ${o.doneAt}` : '¡Buen provecho!', segs: [1, 1, 1, 1, 1], ok: true };
      case 'cancelled': return { t: 'Pedido cancelado', s: 'Si pagaste por adelantado, te contactaremos sobre el reembolso', segs: del ? [0, 0, 0, 0, 0] : [0, 0, 0], danger: true };
    }
    return { t: '', s: '', segs: [] };
  }
  // MOCKUP-capp-S4-states C (option B) and R: the drawn order screen with what can't be true before release changed — no order
  // number, the segbar unfilled, no «Compartir seguimiento»
  const SCHED = {
    C: { t: 'Pedido programado', line: 'Te avisamos por WhatsApp cuando entre a cocina', s: 'Tu pedido está programado. Lo empezamos a preparar antes de tu horario.' },
    R: { t: 'Revisando tu pedido', line: 'Te avisamos por WhatsApp', s: 'Estamos revisando tu horario con el restaurante. Te escribimos por WhatsApp si hay que cambiarlo.' },
  };
  // R (S4 r5): no release by scheduled_for + 30 min (the owner-lookup seam is absent — C until then)
  const REVIEW_AFTER_MS = 30 * 60000;
  function schedPhase(o, now) {
    if (!o.scheduled) return null;
    return Number.isFinite(o.scheduledFor) && Number.isFinite(now) && now >= o.scheduledFor + REVIEW_AFTER_MS ? 'R' : 'C';
  }

  // ── the live record (order_tracking/{token}, public by token) → v6's status: the tracker's own status words, mapped onto the states
  // v6 draws. «arriving» has no server signal (never derived — advisor default); `ready` is still «preparing» for a delivery (status-view) ──
  const TZ = 'America/Tegucigalpa';
  let _clk = null;
  function clockText(ms) {
    if (!Number.isFinite(ms)) return null;
    try { if (!_clk) _clk = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }); } catch (_) { return null; }
    const p = {}; for (const x of _clk.formatToParts(new Date(ms))) p[x.type] = x.value;
    const h = Number(p.hour) % 24; return `${(h % 12) || 12}:${String(p.minute).padStart(2, '0')} ${h >= 12 ? 'p. m.' : 'a. m.'}`;
  }
  function fromTracking(rec, mode) {
    if (!rec || typeof rec !== 'object') return null;
    const s = String(rec.status || ''), del = mode === 'delivery';
    const status = s === 'new' ? 'new' : s === 'preparing' ? 'preparing' : s === 'ready' ? (del ? 'preparing' : 'ready')
      : s === 'out_for_delivery' ? (del ? 'out' : 'ready') : s === 'delivered' || s === 'completed' ? (del ? 'delivered' : 'collected') : s === 'cancelled' ? 'cancelled' : null;
    if (!status) return null;
    const name = typeof rec.driver_name === 'string' && rec.driver_name.trim() ? rec.driver_name.trim() : null;
    return { status, driver: name, stacked: status === 'out' && rec.is_active_drop === false, doneAt: clockText(Number(rec.delivered_at)) };
  }

  // a receipt with no priced lines (NOTE-getMyOrders-receipt: lines null ⇒ the items_text lines): v6's rows WITHOUT an amount. The split
  // and the patterns are the forms' own history parser (la-musa-orders/account.js parseOrderItems — capp-order.test.mjs runs both
  // on the same inputs): «Nx Name (L###) [+ extras]» joined by « | »; the unit price is dropped (it would not sum); unrecognized ⇒ raw
  function textLines(txt) {
    return String(txt || '').split(' | ').map((seg) => {
      seg = seg.trim(); if (!seg) return null;
      let m = seg.match(/^(\d+)x\s+([\s\S]+?)\s*\(L[\d.,]+\)\s*(?:\[\+\s*([\s\S]+?)\])?\s*$/);
      if (m) return { n: m[1], name: m[2].trim(), extras: (m[3] || '').replace(/(\d+)x\s/g, '$1× ').trim(), total: null };
      m = seg.match(/^(\d+)x\s+([\s\S]+)$/);
      if (m) return { n: m[1], name: m[2].trim(), extras: '', total: null };
      return { n: '', name: seg, extras: '', total: null };
    }).filter(Boolean);
  }

  // ── the illustrated map (v6 mapSvg P:1791; the colours are the map tokens so it follows the theme) ──
  const ROUTE = [[22, 64], [22, 42], [50, 42], [50, 34], [74, 34]];   // store → home, in % of the box
  function routePoint(p) {
    const segs = []; let L = 0; for (let i = 1; i < ROUTE.length; i++) { const a = ROUTE[i - 1], b = ROUTE[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]); segs.push({ a, b, d }); L += d; }
    let t = Math.max(0, Math.min(1, p)) * L; for (const s of segs) { if (t <= s.d) { const k = t / s.d; return [s.a[0] + (s.b[0] - s.a[0]) * k, s.a[1] + (s.b[1] - s.a[1]) * k]; } t -= s.d; }
    return ROUTE[ROUTE.length - 1];
  }
  // capp-dark (PLAN §3): v6's light / dark values live in the --map-* tokens (capp.css, three forms) and the route is the ink — the
  // map follows the OS live; `dark` is kept for the call shape only
  function mapSvg(dark, route) {
    const road = 'var(--map-road)', minor = 'var(--map-minor)', park = 'var(--map-park)', water = 'var(--map-water)';
    const line = route ? `<polyline points="${ROUTE.map(([x, y]) => x + ',' + y).join(' ')}" fill="none" stroke-width="1.1" stroke-dasharray="1 2.6" stroke-linecap="round" vector-effect="non-scaling-stroke" style="stroke:var(--ink);stroke-width:3px"/>` : '';
    return `<svg class="mapsvg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <rect x="62" y="56" width="30" height="26" rx="3" style="fill:${park}"/><path d="M-5 92 C 20 80, 40 96, 70 86 S 100 76, 110 84 L110 110 L-5 110 Z" style="fill:${water}"/>
    <g style="stroke:${minor}" stroke-width="1.6" stroke-linecap="round" vector-effect="non-scaling-stroke">${[10, 34, 56, 78].map((y) => `<path d="M-5 ${y}H105"/>`).join('')}${[10, 36, 62, 86].map((x) => `<path d="M${x} -5V105"/>`).join('')}</g>
    <g style="stroke:${road}" stroke-width="3.4" stroke-linecap="round" fill="none">${[22, 50, 74].map((x) => `<path d="M${x} -5V105"/>`).join('')}${[22, 42, 64].map((y) => `<path d="M-5 ${y}H105"/>`).join('')}<path d="M-5 100 L45 60 L105 20"/></g>${line}</svg>`;
  }

  // o: { order_id, display_number?, mode, status, storeName, branch, storeAddr, lines: [{ n, name, extras, total }], fee, tip, total,
  //      pay, addr, details, notes, whenText, phoneText, scheduled, scheduledFor, driver?, stacked?, pin?, etaMin?, windowText?, doneAt? }
  // c: { entry: 'app' | 'link', now, dark, offerHtml, helpOk, shareOk, pay? }
  //    pay (S2, an sdk_auth_v1 order under runtime.sdkPay — CappPayAdjust's pieces, built by the shell): { notice, rows, statusSub }
  //    — absent ⇒ the screen is byte-identical to the base (a cell compares against the pinned original)
  function orderHtml(o, c) {
    const del = o.mode === 'delivery', ph = schedPhase(o, c.now), sc = ph ? SCHED[ph] : null;
    const st = sc ? 'new' : (o.status || 'new');
    const cc0 = statusCopy({ ...o, status: st });
    // S2: a cancelled sdk order's held card was never charged — the truthful line, never the refund one (advisor 11-08)
    const cc = st === 'cancelled' && c.pay && typeof c.pay === 'object' && typeof c.pay.rows === 'string' && c.pay.rows ? { ...cc0, s: 'No se hizo ningún cargo a tu tarjeta.' } : cc0;
    const driverPos = !sc && cc.p !== undefined ? routePoint(cc.p) : null;
    const [sx, sy] = ROUTE[0], [hx, hy] = ROUTE[ROUTE.length - 1];
    const markers = `<span class="mk-label" style="left:${sx}%;top:${sy}%">${esc(o.storeName)}${o.branch ? ' · ' + esc(o.branch) : ''}</span><span class="mk-dot" style="left:${sx}%;top:${sy}%"></span>
    ${del ? `<span class="mk-home" style="left:${hx}%;top:${hy}%">${IC.home}</span>` : ''}${o.stacked && st === 'out' ? '<span class="mk-dot" style="left:50%;top:52%;background:var(--mute)"></span>' : ''}${driverPos ? `<span class="mk-driver" style="left:${driverPos[0]}%;top:${driverPos[1]}%"></span>` : ''}`;
    const backBtn = c.entry === 'app' ? `<button class="iconbtn" data-act="order-close" aria-label="Cerrar">${IC.close}</button>` : '<span></span>';
    const help = c.helpOk ? `<button class="helpchip" data-act="order-help">${IC.wa}Ayuda</button>` : '';
    const map = `<div class="order-map">${mapSvg(!!c.dark, del)}${markers}<div class="ovl">${backBtn}${help}</div></div>`;
    const segs = sc ? (del ? [0, 0, 0, 0, 0] : [0, 0, 0]) : cc.segs;
    const segbar = `<div class="segbar${cc.danger && !sc ? ' cancel' : ''}" aria-hidden="true">${segs.map((s) => s === 1 ? '<div class="sg done"></div>' : s && s.a ? `<div class="sg active"><div class="fill" style="--p:${s.a}"></div></div>` : '<div class="sg"></div>').join('')}</div>`;
    // v6 etaRange (P:1271): «Programado · llega / listo» + the slot for a scheduled order (S4 C's drawn anchor); else «Llega» /
    // «Listo para recoger» + the window (S5's form-live-status, the shell's) — none on a final state or without a window
    const wl = sc ? { k: del ? 'Programado · llega' : 'Programado · listo', v: o.whenText } : { k: del ? 'Llega' : 'Listo para recoger', v: o.windowText };
    const windowLine = FINAL.has(st) || !wl.v ? '' : `<div class="mk-window">${esc(wl.k)} <b>${esc(wl.v)}</b></div>`;
    const title = sc ? sc.t : st === 'new' ? 'Pedido recibido' : cc.t;
    const num = sc ? `<div class="mk-num"><span>${esc(sc.line)}</span></div>`
      : o.display_number != null && String(o.display_number) !== '' ? `<div class="mk-num">Orden #${esc(o.display_number)} <span>· Te avisamos por WhatsApp</span></div>` : '';
    // S2 D (MOCKUP-capp-S2-adjustment r3): «Nuevo total aceptado» leads the status subline (owner: a status line only)
    const pay = c.pay && typeof c.pay === 'object' && typeof c.pay.rows === 'string' && c.pay.rows ? c.pay : null, sub = (t) => (pay && pay.statusSub ? `${esc(pay.statusSub)}${t ? ' · ' + esc(t) : ''}` : esc(t));
    const statusrow = sc ? `<div class="mk-status mute" style="font-size:13.5px;text-align:center">${sub(sc.s)}</div>`
      : st === 'new' ? `<div class="mk-status mute" style="font-size:13.5px;text-align:center">${sub(cc.s)}</div>`
        : `<div class="statusrow">${(st === 'out' || st === 'arriving') && o.driver ? `<span class="av" aria-hidden="true">${esc(String(o.driver)[0])}</span>` : ''}<div class="st"><div class="ssub${cc.big ? ' big' : ''}" style="margin-top:0">${sub(cc.s)}</div>${cc.live ? '<div class="live"><i></i>Actualizando en tiempo real</div>' : ''}</div></div>`;
    const driverCard = !sc && (st === 'out' || st === 'arriving') && o.driver ? `<div class="drivercard"><span class="av statusrow-av" style="width:40px;height:40px;border-radius:50%;background:var(--surf);display:flex;align-items:center;justify-content:center;font-weight:700">${esc(String(o.driver)[0])}</span><div class="t"><b>${esc(o.driver)}</b><span>Tu repartidor · moto</span></div>${c.driverActs || ''}</div>
    ${typeof o.pin === 'string' && /^\d{4,6}$/.test(o.pin) ? `<div class="pincard"><span class="pin">${o.pin.split('').join(' ')}</span><span class="t">Dale este código a tu repartidor al recibir tu pedido.</span></div>` : ''}` : '';
    const details = del ? `<div class="mk-card"><span class="k">Detalles de entrega</span><span class="v">${esc(o.addr)}</span>${o.details ? `<span class="n">${esc(o.details)}</span>` : ''}${o.notes ? `<span class="n">Nota: ${esc(o.notes)}</span>` : ''}</div>`
      : `<div class="mk-card"><span class="k">Recoger en</span><span class="v">${esc(o.storeName)}${o.branch ? ' · ' + esc(o.branch) : ''}</span><span class="n">${esc(o.storeAddr || '')}</span></div>`;
    const lineRows = (o.lines || []).map((d) => `<div class="rrow"><span>${c.past ? (d.n === '' ? '' : `${esc(d.n)}× `) : `${d.n}× `}${esc(d.name)}${d.extras ? `<span class="note" style="display:block">+ ${esc(d.extras)}</span>` : ''}</span><span>${d.total == null && c.past ? '' : money(d.total || 0)}</span></div>`).join('')
      + `${del && o.fee != null ? `<div class="rrow"><span class="k">Envío</span><span>${o.fee ? money(o.fee) : '<span class="free">Gratis</span>'}</span></div>` : ''}${c.past && o.redeem ? `<div class="rrow"><span class="k">Descuento</span><span class="free">− ${money(o.redeem)}</span></div>` : ''}${o.tip ? `<div class="rrow"><span class="k">Propina</span><span>${money(o.tip)}</span></div>` : ''}${Number.isFinite(o.total) ? `<div class="rrow tot"><span>Total</span><span>${money(o.total)}</span></div>` : ''}`;
    // EVERY receipt addition is gated on c.past (Codex rcpt r1 #1): the live screen renders byte-identical to the base (a cell compares).
    // a past order's receipt (NOTE-getMyOrders-receipt): the tender is cash / card only — «Tarjeta», never digits (advisor 11-01); an
    // unknown tender or slot is not drawn (never guessed)
    const payKnown = !c.past || o.pay === 'cash' || o.pay === 'card' || o.pay === 'online';
    const payText = o.pay === 'online' ? 'Pagado en línea · PixelPay' : c.past && o.pay === 'card' ? 'Tarjeta' : 'Efectivo ' + (del ? 'al entregar' : 'al recoger');
    // advisor 11-01: a past order states no payment status it cannot know — «Se cobra al …» is false once done, and a cancelled card
    // order's refund is not ours to guess ⇒ Estado only for a card order that was delivered / collected («Confirmado»)
    const estado = !c.past || ((o.pay === 'card' || o.pay === 'online') && (st === 'delivered' || st === 'collected'));
    // S2: an sdk order's card is HELD, charged on delivery — «Pagado en línea / Confirmado» would be false: the Pago rows (pay.rows, checkout
    // v2 frame 8) take their place at the head of «Pago y entrega»; none on a cancelled order (nothing will be charged)
    const payLines = `${pay ? (st === 'cancelled' ? '' : pay.rows) : ''}${payKnown && !pay ? `<div class="rrow"><span class="k">Pago</span><span>${payText}</span></div>${estado ? `<div class="rrow"><span class="k">Estado</span><span>${o.pay === 'online' || (c.past && o.pay === 'card') ? 'Confirmado' : 'Se cobra al ' + (del ? 'entregar' : 'recoger')}</span></div>` : ''}` : ''}${c.past && !o.whenText ? '' : `<div class="rrow"><span class="k">Cuándo</span><span>${esc(o.whenText || 'Lo antes posible')}</span></div>`}${o.phoneText ? `<div class="rrow"><span class="k">WhatsApp</span><span>${esc(o.phoneText)}</span></div>` : ''}`;
    // the confirmation («new», C, R) carries the receipt blocks in the open; the live tracker folds them (v6)
    const open = sc || st === 'new';
    const receipt = open ? `<div class="receipt2"><h3>Tu pedido</h3>${lineRows}</div>`
      : `<div class="receipt"><button class="toggle" data-act="order-receipt" aria-expanded="${!!(c.past || c.receiptOpen)}">Resumen del pedido <span>· ${esc(o.storeName)}</span>${IC.down}</button><div class="rbody"${c.past || c.receiptOpen ? '' : ' hidden'}>${lineRows}</div></div>`;
    const payrows = open ? `<div class="receipt2"><h3>Pago y entrega</h3>${payLines}</div>`
      : `<div class="receipt"><div class="toggle" style="cursor:default">Pago y entrega</div><div class="rbody">${payLines}</div></div>`;
    const share = !sc && !FINAL.has(st) && del && c.shareOk ? `<button class="shareline" data-act="order-share">${IC.share}Compartir seguimiento</button>` : '';
    // a past receipt still being read (c.hold — advisor 11-01, no reflow): the screen ENDS before the first block that needs it (a
    // delivery's address card; else «Resumen del pedido») — an empty marker holds the place; the shell then puts the tail (c.tailOnly)
    // IN PLACE of the marker, so nothing already drawn moves. The CTA belongs to the tail: never pushed down by a late block
    // C-6d (D-3 r3 frame 5, approved): the LIVE desktop panel follows the leaders' order — «Orden #N» after the receipt, before the
    // share line (c.desk; a past receipt keeps its order: its tail is streamed in place). Without c.desk: byte-identical
    const deskOrder = !!c.desk && !c.past;
    const tail = `${del ? details : ''}${receipt}${payrows}
    ${deskOrder ? num : ''}${share}<button class="btn2 again" data-act="order-again">Hacer otro pedido</button>${c.entry === 'link' ? '<div class="credit">Enviado por <b>Sherpa</b></div>' : ''}`;
    if (c.past && c.tailOnly) return tail;   // past-only (Codex rcpt r2): the live screen ignores hold / tailOnly
    const sheet = `<div class="mk-sheet"><div class="mk-handle"></div><div class="mk-title${cc.ok && !sc ? ' success' : ''}${cc.danger && !sc ? ' danger' : ''}">${esc(title)}</div>${windowLine}
    ${deskOrder ? '' : num}${segbar}${statusrow}${pay && pay.notice ? pay.notice : ''}${driverCard}${c.rateHtml || ''}${c.offerHtml || ''}${del ? '' : details}${c.past && c.hold ? '<div data-rc-tail></div>' : tail}</div>`;
    return `<div class="scroller"><div class="orderwrap">${map}${sheet}</div></div>`;
  }

  // C-5 (PLAN §C-5; MOCKUP-capp-desktop-D3 r3 §9.6; advisor 11-02): the help sheet, contextual to ONE order — «Escribinos por WhatsApp»
  // to the platform's support number with the order number written in (the shell builds the link; no number configured ⇒ no sheet).
  // The ticket reasons are NOT drawn here: their states are undrawn and their Central surface (X-1) is not built (advisor: tickets OFF)
  function helpSheetHtml(h) {
    const ctx = [h.num ? `Orden #${esc(h.num)}` : null, h.storeName ? esc(h.storeName) : null].filter(Boolean).join(' · ');
    return `<div class="scrim" data-act="help-close"></div><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="help-h"><div class="grab"></div>
    <div class="helpsheet"><h2 id="help-h" tabindex="-1">Ayuda con tu pedido</h2>${ctx ? `<p class="ctx"><b>${ctx}</b>${h.windowText ? ` · llega ${esc(h.windowText)}` : ''}</p>` : ''}
      <button class="wa" data-act="help-wa">${IC.wa}Escribinos por WhatsApp</button><p class="fine">${h.num ? 'Abre WhatsApp con el número de tu orden ya escrito. ' : ''}Central de despacho responde en minutos mientras tu pedido está activo.</p></div></div>`;
  }

  return { orderHtml, helpSheetHtml, textLines, statusCopy, schedPhase, routePoint, fromTracking, clockText, FINAL, SCHED, REVIEW_AFTER_MS };
});
