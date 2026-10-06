/* ── P-SELFUPDATE CP2 §3 — the ORDER-FORM ADAPTER (order-self-update.js) ─────────────────────────────────────────────
 *
 * Canonical source: <repo>/platform/client/order-self-update.js; byte-identical committed copies in xpizza-orders/ and
 * la-musa-orders/ (`npm run sync:client`, drift-guarded). Loaded with a plain <script src> AFTER the form's main
 * script, so the form's own globals (activeStageId, liveMenuBusy, snapshotForm, cartRestore, …) exist. It reads them;
 * it changes none of the form's existing paths. When the shared module is absent or INERT (an unstamped page) this file
 * does nothing at all.
 *
 * canReload — TRUE only when ALL hold (PLAN §3, owner Q8):
 *   • no payment return on this page load: a `?pay=` URL or the pay-return overlay means handlePaymentReturn() owns the
 *     page (its polling, timeout and ambiguous outcomes), so it never reloads — the `*_pending_pay` stash and the return
 *     URL are never touched;
 *   • no submission in flight (orderSubmitting / __paySubmitting) — and the coordinator has ALREADY refused while any
 *     money-bearing attempt is latched as outcome-unknown;
 *   • not the receipt (s5 — a completed order must stay on screen);
 *   • ordinary update: the live menu's own safe moment (liveMenuBusy() false: stage s1, no dish modal, no cart review),
 *     no open sheet / overlay, no focused field, no tap / keystroke in the last 30 s;
 *   • the 426 transition (mode 'checkout' — only after a definitive pre-mutation refusal of a FIRST submission; the
 *     latch decides the rest): any stage but the receipt.
 * prepareReload — the form's own snapshotForm() (the same snapshot the PixelPay retry path stashes and restores), plus
 *   the cash tender + its exact/custom mode (snapshot v2), the stage and the shown total. The coordinator writes it to sessionStorage; a failed write = no reload.
 * afterReload — restores through cartRestore() (each line keeps the price it was ADDED at; a line the live menu no longer
 *   agrees with stays visible and BLOCKING at the send gate), waits for the live menu, then shows the customer anything
 *   that changed (the cart review + the existing conflict announcement). A 426 restore lands on the checkout review with
 *   "confirmá de nuevo"; the customer confirms again on the new build. Prices stay server-authoritative.
 */
(function () {
  'use strict';
  var SC = window.SherpaClient;
  if (!SC || SC.inert) return;

  var OVERLAYS = '.detail-overlay.open, .cart-overlay.open, .schedule-sheet.open, .schedule-overlay.open, .sched-modal.open,'
    + ' .map-fullscreen-overlay.open, .cc-menu.open, .cart-review-sheet.open, .acct-fs-overlay.open, #pay-return-overlay, dialog[open]';

  function payReturnActive() {
    try { return new URLSearchParams(location.search).has('pay') || !!document.getElementById('pay-return-overlay'); } catch (_) { return true; }
  }
  function typing() {
    var a = document.activeElement;
    return !!(a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable));
  }
  function submitting() {
    try { return !!(orderSubmitting || window.__paySubmitting); } catch (_) { return true; }   // unreadable = not safe
  }
  function shownTotal() { try { var t = document.getElementById('cart-review-total') || document.getElementById('total'); return t ? t.textContent : null; } catch (_) { return null; } }

  function canReload(ctx) {
    if (payReturnActive() || submitting()) return false;
    var stage = activeStageId();
    if (stage === 's5') return false;
    if (ctx && ctx.mode === 'checkout') return true;
    if (liveMenuTerminal() || liveMenuBusy()) return false;
    if (typing() || !SC.quiet()) return false;           // never right after a tap / keystroke
    if (document.querySelector(OVERLAYS)) return false;
    return true;
  }

  // Snapshot v2 (codex CP2 r1 B3): snapshotForm() does not carry the cash tender — the amount the customer pays WITH and
  // its exact/custom mode — so it travels beside it, captured by the form's own liveMenuCustomerCapture().
  function prepareReload(ctx) {
    var form = snapshotForm();
    var tender = (typeof liveMenuCustomerCapture === 'function') ? liveMenuCustomerCapture() : null;
    // codex CP2 r2: the ACCOUNT's delivery choice for this order (a saved address picked for it, or a one-off), so the
    // account start-up after the reload re-applies IT instead of the profile default. null for a guest.
    var delivery = null;
    try { if (window.__ACCOUNT && typeof window.__ACCOUNT.getDeliverySelection === 'function') delivery = window.__ACCOUNT.getDeliverySelection(); } catch (_) { delivery = null; }
    var snap = { v: 2, mode: (ctx && ctx.mode) || 'idle', stage: activeStageId(), form: form, tender: tender, delivery: delivery, shown_total: shownTotal(), lines: cartLines().length };
    JSON.stringify(snap);                       // must serialize, or there is nothing safe to restore → throw = no reload
    return snap;
  }

  // The tender comes back AFTER the payment method (selectPay redraws the cash panel):
  //   • "Pago exacto" (exact mode) → the box is set to the total at restore time, exact mode ON. From there the form
  //     behaves exactly as it does today: its exact mode follows CART edits (updateTotal) but NOT a later server re-quote
  //     (the box keeps its amount; at submit a tender below the total is omitted and the server's exact default applies);
  //   • a custom amount → exactly that amount, custom mode (the form's liveMenuCustomerRestore: value, then mode LAST).
  function restoreTender(t) {
    if (!t || !document.getElementById('cash-tendered')) return;
    if (t.exact === true) { setCashTendered(redeemAdjustedTotal()); return; }
    if (t.tender !== null && t.tender !== undefined && typeof liveMenuCustomerRestore === 'function') liveMenuCustomerRestore({ tender: t.tender, exact: false });
  }

  function say(text, inCheckout) {
    var err = inCheckout ? (document.getElementById('err3') || document.getElementById('err1')) : (document.getElementById('err1') || document.getElementById('err3'));
    if (err) { err.textContent = text; err.style.display = 'block'; }
  }

  // Mirrors restoreOrderForm()'s rehydration (the proven PixelPay-retry path) WITHOUT its pending-pay stash, its
  // resume-order-id, or its "go home on failure": an update that cannot restore leaves the fresh page, as any reload.
  function restoreSnapshot(snap, toCheckout) {
    try { if (window.__ACCOUNT && typeof window.__ACCOUNT.setRestoring === 'function') window.__ACCOUNT.setRestoring(true); } catch (_) {}
    try {
      Object.keys(qty).forEach(function (k) { delete qty[k]; }); Object.assign(qty, snap.qty || {});
      Object.keys(pizzaExtras).forEach(function (k) { delete pizzaExtras[k]; }); Object.assign(pizzaExtras, snap.extras || {});
      cartRestore(snap.cart);
      var setV = function (id, val) { var el = document.getElementById(id); if (el) el.value = val || ''; };
      var f = snap.fields || {};
      setV('cname', f.cname);
      var phone = f.cphoneCC ? ('+' + f.cphoneCC + ' ' + (f.cphone || '')) : (f.cphone || '');
      if (typeof window.__applyPhoneRaw === 'function') window.__applyPhoneRaw(phone); else setV('cphone', f.cphone);
      setV('cemail', f.cemail); setV('notes', f.notes); setV('address-detected', f.addressDetected); setV('address-details', f.addressDetails);
      if (snap.rtn) {
        var t = document.getElementById('rtn-toggle'); if (t) t.checked = !!snap.rtn.on;
        if (typeof toggleRtn === 'function') { try { toggleRtn(); } catch (_) {} }
        if (snap.rtn.on) { setV('razon-social', snap.rtn.razon); setV('rtn-cliente', snap.rtn.num); }
      }
      renderMenu(); updateCart(); updateTotal();
      try {
        if (snap.redeem && window.__ACCOUNT && window.__ACCOUNT.restoreRedeem) {
          window.__ACCOUNT.restoreRedeem(snap.redeem, snap.redeemQuote, null);
          try { if (typeof window.__ACCOUNT.requoteRedeem === 'function') Promise.resolve(window.__ACCOUNT.requoteRedeem(redeemCartItems())).catch(function () {}); } catch (_) {}
          if (typeof renderRedeemUI === 'function') renderRedeemUI();
          try { var q = window.__ACCOUNT.getRedeemQuote ? window.__ACCOUNT.getRedeemQuote() : null; if (typeof applyRedeemQuoteToTotals === 'function') applyRedeemQuoteToTotals(q); } catch (_) {}
        }
      } catch (_) {}
      window.__scheduledFor = snap.scheduledFor || null;
      window.__timeMode = snap.timeMode || 'standard';
      if (toCheckout) {
        showStage('s2', 50);
        setOrderType(snap.orderType || 'delivery');
        if (snap.orderType !== 'pickup') {
          lat = snap.lat; lng = snap.lng;
          if (snap.lat && snap.lng) __restorePos = { lat: snap.lat, lng: snap.lng };
          setTimeout(initMap, 100);
        }
        if (snap.payment) selectPay(snap.payment);
        try { if (typeof forceRequote === 'function') forceRequote(); } catch (_) {}
      } else {
        // s1: remember the checkout choices so "Ir al checkout" finds them; the map is initialised when checkout opens
        try { setOrderType(snap.orderType || 'delivery'); } catch (_) {}
        if (snap.orderType !== 'pickup' && snap.lat && snap.lng) { lat = snap.lat; lng = snap.lng; __restorePos = { lat: snap.lat, lng: snap.lng }; }
        if (snap.payment) { try { selectPay(snap.payment); } catch (_) {} }
      }
      return true;
    } catch (e) {
      try { console.warn('self_update_restore_failed', String((e && e.message) || e).slice(0, 200)); } catch (_) {}
      return false;
    } finally {
      try { if (window.__ACCOUNT && typeof window.__ACCOUNT.setRestoring === 'function') window.__ACCOUNT.setRestoring(false); } catch (_) {}
    }
  }

  // After the live menu has had its say (applied / refused / failed, or 10 s), show anything that changed.
  function reviewWhenMenuSettles(data, toCheckout) {
    var started = Date.now();
    var base = null;
    try { var s0 = window.__liveMenu && window.__liveMenu.applier && window.__liveMenu.applier.state(); base = s0 ? s0.counts : null; } catch (_) {}
    (function poll() {
      var settled = false;
      try {
        var st = window.__liveMenu && window.__liveMenu.applier && window.__liveMenu.applier.state();
        if (!st) settled = true;
        else if (st.fatal) settled = true;
        else if (base && (st.counts.applied + st.counts.refused + st.counts.deferred) > (base.applied + base.refused + base.deferred)) settled = true;
      } catch (_) { settled = true; }
      if (!settled && Date.now() - started < 10000) { setTimeout(poll, 250); return; }
      try {
        var conflicts = cartConflicts();
        var changed = conflicts.length > 0 || (data.shown_total && shownTotal() && data.shown_total !== shownTotal());
        if (conflicts.length) announceCartConflicts(conflicts);
        if (toCheckout) {
          /* the "confirm again" line is already shown; conflicts (if any) replaced it above */
        } else if (changed) {
          openCartReview();
          if (!conflicts.length) say('Actualizamos el menú. Revisá tu pedido antes de continuar.');
        }
      } catch (_) {}
    })();
  }

  function afterReload(data) {
    if (!data || (data.v !== 1 && data.v !== 2) || !data.form) return;
    var toCheckout = data.mode === 'checkout';
    if (!restoreSnapshot(data.form, toCheckout)) return;
    try { if (data.v === 2) restoreTender(data.tender); } catch (_) {}
    // hand the account its delivery choice back (applied by its own start-up, or at once if that already ran)
    try { if (data.v === 2 && data.delivery && window.__ACCOUNT && typeof window.__ACCOUNT.setRestoredDelivery === 'function') window.__ACCOUNT.setRestoredDelivery(data.delivery); } catch (_) {}
    if (toCheckout) say('Actualizamos la página para completar tu pedido. Revisá y confirmá de nuevo.', true);   // at once; the menu review follows
    reviewWhenMenuSettles(data, toCheckout);
  }

  function notice(text) {
    // during a submission screen the message belongs in the sending line; elsewhere a quiet banner
    try {
      var sm = document.getElementById('sending-msg');
      if (sm && activeStageId() === 's4') { sm.textContent = text + ' — intentá de nuevo en un momento.'; return; }
    } catch (_) {}
    var el = document.getElementById('psu-notice');
    if (!el) {
      el = document.createElement('div'); el.id = 'psu-notice'; el.setAttribute('role', 'status');
      var s = el.style; s.position = 'fixed'; s.left = '50%'; s.bottom = '14px'; s.transform = 'translateX(-50%)'; s.zIndex = '9998';
      s.background = '#1E1B18'; s.color = '#fff'; s.padding = '8px 14px'; s.borderRadius = '999px'; s.font = '600 12px/1.3 system-ui, sans-serif'; s.pointerEvents = 'none';
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  // The update is taken at the module's own triggers (load, every 10 min while visible, wake) when this says safe —
  // never in reaction to a tap, so the page does not reload under a customer's finger.
  SC.registerAdapter({ canReload: canReload, prepareReload: prepareReload, afterReload: afterReload, notice: notice });
})();
