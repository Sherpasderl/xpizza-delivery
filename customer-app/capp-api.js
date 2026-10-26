// Customer app S2a (PLAN-capp-S2-r4 §5.2) — THE TRANSPORT: quote, the placement identity, cash, card, the hosted-checkout
// return, and recovery. Every quote / createOrder / chargeOnlineOrder call goes through SherpaClient.fetch (§2.4: the X-Client-*
// headers, the money latch, 426 terminal) — a guard pins that no identity endpoint is fetched directly. Brand-agnostic: every
// restaurant difference (id, order-id prefix, stash key, endpoint URLs, hours) is CONFIG — no restaurant literal (guarded).
//
// THE PLACEMENT IDENTITY (r2–r4, Codex P1 #9 / P2): ONE order_id per placement. The unresolved placement is persisted to
// `capp:{restaurant_id}:pending_place` = { order_id, method, body_sig, ts, last_send, expires_at } BEFORE the first send, and
// `last_send` is re-persisted BEFORE EVERY send (a failed write ⇒ no send). A fresh id is minted ONLY when there is no live
// record, which happens only after a proven-safe outcome cleared it (the EXHAUSTIVE list, §5.2):
//   1 cash 200 / idempotent 200 ⇒ placed           5 (S1) cash legacy 409 order_conflict ⇒ cleared, ONE resend on a fresh id
//   2 card paymentStatus paid / scheduled_paid      6 (S2) paymentStatus cancelled / failed ⇒ cleared (the next placement mints)
//   3 card 409 Already paid ⇒ paid_unverified       7 the hard expiry: max(min(closing, ts + 12 h), last_send + 60 min)
//   4 card paymentStatus closed_refunded ⇒ refund sheet (and the pay stash)
// NEVER cleared by a reload, a cart edit / discard, dismissing a sheet, order_exists (any reason), order_context_changed,
// verifying / pending / scheduled_review / the poll timeout, a 403, a network failure or a 5xx. If in doubt, never mint: the
// customer is sent to the existing order. 60 min = the server's hosted-checkout window (HOSTED_TTL_MS, 45 min) + 15 min margin,
// pinned by a test against the real server export.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappApi = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const CAPP_SEND_GRACE_MS = 60 * 60 * 1000;
  const MAX_PLACEMENT_MS = 12 * 60 * 60 * 1000;
  const MAX_TRIES = 3;                                   // the forms' policy (createOrder MAX_TRIES): 2 retries, 1.5 s then 3 s
  const BACKOFF_MS = (attempt) => attempt * 1500;
  const IN_PROGRESS_TRIES = 8;                           // 202 in_progress: re-send the SAME identity, bounded
  const POLL_DEADLINE_MS = 90000, POLL_EVERY_MS = 2500;  // the forms' return cadence
  const CANCEL_CHECK_MS = 5000;                          // the forms' single bounded check on a cancel return
  const ID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // the forms' genOrderId suffix charset
  const PAID_STATES = new Set(['paid', 'scheduled_paid']);
  const CONFIRMING_STATES = new Set(['verifying', 'pending', 'scheduled_review']);
  const pad2 = (n) => String(n).padStart(2, '0');

  // ── config: { restaurantId, orderIdPrefix, pendingPayKey, endpoints: { quoteOrder, createOrder, chargeOnlineOrder, paymentStatus },
  //             hours } — all DATA from the host's store config
  function createApi(opts) {
    const o = opts || {};
    const cfg = o.config || {};
    const C = o.CappCheckout || (root && root.CappCheckout) || require('./capp-checkout.js');
    const CQ = o.createConfirmQuote || (root && root.createConfirmQuote) || require('./capp-confirm-quote.js').createConfirmQuote;
    const sfetch = o.fetch || ((u, i) => root.SherpaClient.fetch(u, i));
    const storage = o.storage || (() => { try { return root.localStorage; } catch (_) { return null; } })();
    const now = o.now || (() => Date.now());
    const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    // the cancel return's single bounded check: its OWN timer (a backoff sleep must never shorten it)
    const timeout = o.timeout || ((ms) => new Promise((r) => { const h = setTimeout(r, ms); if (h && typeof h.unref === 'function') h.unref(); }));
    const cryptoApi = (root && root.crypto) || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    const randomBytes = o.randomBytes || ((n) => { const b = new Uint8Array(n); cryptoApi.getRandomValues(b); return b; });
    const memberOf = typeof o.member === 'function' ? o.member : () => o.member || null;
    const cq = o.confirmQuote || CQ({ now, setInterval: o.setInterval, clearInterval: o.clearInterval, requote: o.requote });
    const PLACE_KEY = `capp:${cfg.restaurantId}:pending_place`;
    const PAY_KEY = cfg.pendingPayKey;
    const E = cfg.endpoints || {};

    // ── storage (every access guarded: unavailable storage reads as empty and refuses writes) ──
    const readJSON = (k) => { try { const v = storage && storage.getItem(k); return v ? JSON.parse(v) : null; } catch (_) { return null; } };
    const writeJSON = (k, v) => { try { if (!storage) return false; const s = JSON.stringify(v); storage.setItem(k, s); return storage.getItem(k) === s; } catch (_) { return false; } };
    const removeKey = (k) => { try { if (storage) storage.removeItem(k); } catch (_) {} };

    // ── the order id: the forms' genOrderId scheme (prefix + yymmdd-hhmmss + 8 CSPRNG chars), on the injected clock ──
    function genOrderId() {
      const d = new Date(now());
      const b = randomBytes(8); let r = ''; for (const x of b) r += ID_CHARS[x % 32];
      return `${cfg.orderIdPrefix}${String(d.getFullYear()).slice(-2)}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}-${r}`;
    }

    // ── the placement record ──
    function expiresAtOf(ts, lastSend) {
      const closing = C.closingAt(cfg.hours, new Date(ts));
      const inner = closing === null ? ts + MAX_PLACEMENT_MS : Math.min(closing, ts + MAX_PLACEMENT_MS);
      return Math.max(inner, lastSend + CAPP_SEND_GRACE_MS);
    }
    // every read checks the expiry first: past it the record is deleted and the placement counts as resolved
    function readPlace() {
      const r = readJSON(PLACE_KEY);
      if (!r || typeof r !== 'object' || typeof r.order_id !== 'string' || !Number.isFinite(r.expires_at)) { if (r !== null) removeKey(PLACE_KEY); return null; }
      if (now() >= r.expires_at) { removeKey(PLACE_KEY); return null; }
      return r;
    }
    function clearPlace() { removeKey(PLACE_KEY); }
    // write FIRST, then send: `last_send` (and the record itself) persisted before every send of this identity
    function beginSend(method, bodySig) {
      const t = now();
      const r = readPlace() || { order_id: genOrderId(), method, body_sig: bodySig == null ? null : String(bodySig), ts: t };
      r.method = method; r.last_send = t; r.expires_at = expiresAtOf(r.ts, t);
      if (!writeJSON(PLACE_KEY, r)) { const e = new Error('placement_write_failed'); e.code = 'placement_write_failed'; throw e; }
      return r.order_id;
    }

    // ── the pay stash: the minimal legacy shape { order_id, t, order, form, ts } under the config's key ──
    const readPay = () => readJSON(PAY_KEY);
    const credsFor = (id) => { const s = readPay(); return s && s.order_id === id && typeof s.t === 'string' && s.t ? s.t : null; };
    // the forms' clearPendingPayFor: remove only THIS order's stash (or an unusable one); another order's is kept
    function clearPayFor(id) {
      const raw = (() => { try { return storage && storage.getItem(PAY_KEY); } catch (_) { return null; } })();
      if (raw === null || raw === undefined) return;
      let s; try { s = JSON.parse(raw); } catch (_) { s = undefined; }
      const sid = s && typeof s === 'object' ? s.order_id : undefined;
      if (typeof sid === 'string' && sid !== '' && sid !== id) return;
      removeKey(PAY_KEY);
    }

    // ── wire ──
    const headersFor = (extra) => { const h = { 'Content-Type': 'application/json', ...(extra || {}) }; const m = memberOf(); if (m && m.idToken) h['x-firebase-id-token'] = m.idToken; return h; };
    async function post(url, body, extraHeaders) {
      const r = await sfetch(url, { method: 'POST', headers: headersFor(extraHeaders), body: JSON.stringify(body) });
      let j = null; try { j = await r.json(); } catch (_) { j = null; }
      return { status: r.status, json: j || {} };
    }
    // network / 5xx (incl. 503) ⇒ up to MAX_TRIES with backoff; `before` runs before EVERY attempt (the last_send write)
    async function withRetry(fn, before) {
      let last = null;
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        if (before) { try { before(); } catch (_) { return { stashFailed: true }; } }   // the write failed ⇒ this attempt is not sent
        try { const r = await fn(); if (r.status < 500) return r; last = r; } catch (e) { last = { network: true, error: e }; }
        if (attempt < MAX_TRIES) await sleep(BACKOFF_MS(attempt));
      }
      return last;
    }
    const ref4 = (id) => String(id || '').slice(-4).toUpperCase();   // the forms' «Referencia #ABCD»

    // ── quote: a newer request always wins (parent §7 «Stale async quote») ──
    let qseq = 0; let latest = null;
    async function quote(f, ctx) {
      const seq = ++qseq;
      const body = C.quoteBody(f, ctx);
      const sig = await C.cartSig(f, ctx);   // captured when the request is SENT
      const tipCents = C.tipCentsOf(f);
      const r = await withRetry(() => post(E.quoteOrder, body, ctx.headers));
      if (seq !== qseq) return { kind: 'superseded' };
      if (!r || r.network) return { kind: 'offline' };
      const j = r.json;
      if (r.status === 200 && j.ok === true) { latest = { resp: j, sig, tipCents }; cq.store(j, sig); return { kind: 'ok', record: latest }; }
      if (r.status >= 500) return { kind: 'try_again' };
      const err = j.error;
      if (err === 'outside_delivery_bands') return { kind: 'out_of_zone' };
      if (err === 'pin_required') return { kind: 'pin' };
      if (err === 'rate_limited' || r.status === 429) return { kind: 'try_again' };
      if (r.status === 426) return { kind: 'update_required' };
      return { kind: 'refused', error: err || null };   // delivery_pricing_invalid / tip_* / bad_cart / …: a generic refusal
    }
    const latestQuote = () => latest;

    // ── resolve-first: an existing order is never re-purchased and never minted over ──
    async function pollOnce(id, t) {
      try {
        const r = await sfetch(`${E.paymentStatus}?order_id=${encodeURIComponent(id)}&t=${encodeURIComponent(t)}`, { method: 'GET' });
        if (r.status === 403) return { forbidden: true };
        let j = {}; try { j = await r.json(); } catch (_) { j = {}; }
        return { state: r.ok && j.state ? j.state : 'pending', json: j };
      } catch (_) { return { state: 'pending', json: {}, network: true }; }
    }
    // a terminal poll state → the outcome, applying the clearing rules
    function outcomeOfState(id, st, j) {
      if (PAID_STATES.has(st)) { clearPlace(); clearPayFor(id); return { kind: 'placed', order_id: id, scheduled: st === 'scheduled_paid', tracking_token: (j && j.tracking_token) || null, scheduled_for: (j && j.scheduled_for) || null }; }
      if (st === 'closed_refunded') { clearPlace(); clearPayFor(id); return { kind: 'refunded', order_id: id, refunded_total_cents: j && Number.isFinite(j.refunded_total_cents) ? j.refunded_total_cents : null }; }
      if (st === 'cancelled' || st === 'failed') { clearPlace(); return { kind: 'payment_failed', order_id: id, state: st }; }   // (S2): the next placement mints
      return { kind: 'confirming', order_id: id, state: st };   // verifying / pending / scheduled_review — creds kept, no payment offer
    }
    async function resolveExisting(id) {
      const t = credsFor(id);
      if (t) {
        const p = await pollOnce(id, t);
        if (!p.forbidden) return outcomeOfState(id, p.state, p.json);
      }
      return { kind: 'existing_order', order_id: id, reference: ref4(id) };   // the recovery sheet; no mint, no payment action
    }

    // the refusals both order paths share → an outcome, or null when the path must handle it
    function commonRefusal(r, id) {
      const j = r.json || {};
      if (r.status === 426) return { kind: 'update_required' };
      if (r.status === 400 && (j.error === 'Restaurant closed' || (j.error === 'Bad Request' && j.detail === 'Cerrado — programá tu pedido'))) return { kind: 'closed' };
      if (r.status === 400 && j.error === 'Bad Request' && typeof j.detail === 'string' && j.detail.indexOf('Outside delivery zone') === 0) return { kind: 'out_of_zone' };
      if (r.status === 423 && j.error === 'ordering_paused') return { kind: 'paused', detail: j.detail || null };
      return null;
    }
    const isExisting = (r) => r.status === 409 && (r.json.error === 'order_exists' || r.json.error === 'order_context_changed');

    // ── one placement: build → (beginSend → send) with the ported module's token discipline ──
    // p: { flow, ctx: { restaurantId, items, itemsText, member, headers }, sig, expectedNetCents, sheet }
    async function place(p) {
      const method = p.flow.pay === 'online' ? 'online' : 'cash';
      let expected = p.expectedNetCents;
      let healed = false; let silentRetried = false;
      for (let guard = 0; guard < 4; guard++) {
        let id;
        try { id = beginSend(method, p.sig); } catch (e) {   // a failed write ⇒ no send; anything else is an error, never mislabelled
          return e && e.code === 'placement_write_failed' ? { kind: 'stash_failed' } : { kind: 'error', error: String((e && e.message) || e) };
        }
        const body = C.orderBody(p.flow, { ...p.ctx, orderId: id });
        cq.send(body, p.sig, expected);
        const r = method === 'cash' ? await sendCash(body, p.ctx) : await sendCard(body, p.ctx);
        if (r && r.stashFailed) return { kind: 'stash_failed', order_id: id };
        if (!r || r.network) return { kind: 'offline', order_id: id };   // «Reintentar» re-sends the SAME id
        const j = r.json || {};
        if (method === 'cash' && r.status === 200 && j.ok) { clearPlace(); return { kind: 'placed', order_id: j.order_id || id, tracking_token: j.tracking_token || null, idempotent: !!j.idempotent }; }
        if (method === 'online' && r.status === 200 && j.checkout_url) return cardIssued(id, body, j);
        if (method === 'online' && r.status === 202) return { kind: 'try_again', order_id: id };   // in_progress exhausted (bounded)
        if (method === 'online' && r.status === 409 && j.error === 'Already paid') return alreadyPaid(id);
        if (method === 'cash' && r.status === 409 && j.error === 'order_conflict') {
          if (healed) return { kind: 'error', order_id: id, error: 'order_conflict' };
          healed = true; clearPlace(); continue;   // (S1): proven terminal-safe — ONE resend on a fresh id
        }
        if (isExisting(r)) return resolveExisting(id);
        const cr = commonRefusal(r, id); if (cr) return { ...cr, order_id: id };
        const rec = await cq.handleRejection({ err: j, shownCents: expected, hasReward: false, retried: silentRetried, sheet: p.sheet });
        if (rec && rec.handled) {
          if (!rec.resend) return { kind: rec.declined ? 'price_declined' : 'error', order_id: id };
          if (typeof rec.expectedNetCents === 'number') expected = rec.expectedNetCents;   // the body now stands behind THIS number
          if (rec.silent) silentRetried = true;
          continue;   // the SAME identity (mintNewOrderId is reward-only, never in S2)
        }
        if (method === 'online' && r.status === 500) return { kind: 'payment_not_completed', order_id: id };   // the app deployment absent
        if (method === 'online' && r.status >= 500) return { kind: 'payment_not_completed', order_id: id };
        return { kind: 'error', order_id: id, status: r.status, error: j.error || null };
      }
      return { kind: 'error', error: 'loop_guard' };
    }
    function sendCash(body, ctx) { return withRetry(() => post(E.createOrder, body, ctx.headers), () => touchSend()); }
    async function sendCard(body, ctx) {
      for (let i = 0; i < IN_PROGRESS_TRIES; i++) {
        const r = await withRetry(() => post(E.chargeOnlineOrder, body, ctx.headers), () => touchSend());
        if (!r || r.network || r.stashFailed || r.status !== 202) return r;
        await sleep(BACKOFF_MS(Math.min(i + 1, 2)));   // 202 in_progress: never poll without a token, never mint — re-send
      }
      return { status: 202, json: { status: 'in_progress' } };
    }
    // `last_send` re-persisted before EVERY attempt of the same identity; a failed write stops that attempt
    function touchSend() {
      const r = readPlace(); if (!r) return;
      const t = now(); r.last_send = t; r.expires_at = expiresAtOf(r.ts, t);
      if (!writeJSON(PLACE_KEY, r)) { const e = new Error('placement_write_failed'); e.code = 'placement_write_failed'; throw e; }
    }
    // fresh / reuse 200: persist the creds AFTER the response and BEFORE the redirect (a failed write ⇒ no redirect)
    function cardIssued(id, body, j) {
      if (!j.poll_token || !writeJSON(PAY_KEY, { order_id: id, t: j.poll_token, order: body, form: null, ts: now() })) return { kind: 'stash_failed', order_id: id };
      return { kind: 'redirect', order_id: id, url: j.checkout_url };
    }
    // 409 Already paid: payment recovery, never «Pago no completado», never a new payment
    async function alreadyPaid(id) {
      const t = credsFor(id);
      if (t) {
        const p = await pollOnce(id, t);
        if (!p.forbidden) return outcomeOfState(id, p.state, p.json);
      }
      clearPlace();   // (3): the server has said the order is paid; no token ⇒ never poll
      return { kind: 'paid_unverified', order_id: id };
    }

    // ── the hosted-checkout return: ?pay=complete|cancel&order=&t= ──
    async function handleReturn(search) {
      const q = new URLSearchParams(search || '');
      const pay = q.get('pay');
      if (!pay) return null;
      const s = readPay();
      let id = q.get('order'); let t = q.get('t');
      if (s && (!id || s.order_id === id)) { id = id || s.order_id; t = t || s.t; }
      if (pay === 'cancel') {
        if (!id || !t) return { kind: 'payment_failed', order_id: id || null, state: 'cancelled' };
        const p = await Promise.race([pollOnce(id, t), timeout(CANCEL_CHECK_MS).then(() => ({ state: 'pending', json: {} }))]);
        if (p && !p.forbidden && (PAID_STATES.has(p.state) || p.state === 'closed_refunded')) return outcomeOfState(id, p.state, p.json);
        return { kind: 'payment_failed', order_id: id, state: 'cancelled', clearable: false };   // a genuine cancel: «Pago no completado»
      }
      if (pay !== 'complete' || !id || !t) return { kind: 'confirming', order_id: id || null, state: 'pending' };
      const deadline = now() + POLL_DEADLINE_MS;
      while (now() < deadline) {
        const p = await pollOnce(id, t);
        if (p.forbidden) return { kind: 'existing_order', order_id: id, reference: ref4(id) };
        if (p.state !== 'pending') {
          const out = outcomeOfState(id, p.state, p.json);
          if (out.kind !== 'confirming' || p.state === 'verifying' || p.state === 'scheduled_review') return out;
        }
        await sleep(POLL_EVERY_MS);
      }
      return { kind: 'confirming', order_id: id, state: 'timeout' };   // the webhook confirms later; creds kept
    }

    return { quote, latestQuote, place, handleReturn, resolveExisting, readPlace, clearPlace, genOrderId, expiresAtOf, credsFor,
      confirmQuote: cq, PLACE_KEY };
  }

  return { createApi, CAPP_SEND_GRACE_MS, MAX_PLACEMENT_MS, MAX_TRIES };
});
