// Customer app S2a (PLAN-capp-S2-r4 §5.2) — THE TRANSPORT: quote, the placement identity, cash, card, the hosted-checkout
// return, and recovery. Every quote / createOrder / chargeOnlineOrder call goes through SherpaClient.fetch (§2.4: the X-Client-*
// headers, the money latch, 426 terminal) — a guard pins that no identity endpoint is fetched directly. Brand-agnostic: every
// restaurant difference (id, order-id prefix, stash key, endpoint URLs, hours) is CONFIG — no restaurant literal (guarded).
//
// THE PLACEMENT IDENTITY (r2–r4, Codex P1 #9 / P2): ONE order_id per placement. The unresolved placement is persisted to
// `capp:{restaurant_id}:pending_place` = { order_id, method, body_sig, expected_net_cents, totals, dispatched, unresolved, card,
// admitted, issued, checkout_url, checkout_at, ts, last_send, expires_at } BEFORE the first send. BEFORE EVERY send the record of THAT outgoing identity is re-written and
// re-read (S2a r2 P1 #3): absent, expired or replaced ⇒ the send is STOPPED and the placement goes to recovery; a failed
// write ⇒ no send. A fresh id is minted ONLY when there is no live record, which happens only after a proven-safe outcome
// cleared it (the EXHAUSTIVE list, §5.2) — and every clearing removes the record ONLY if it still holds the resolved order_id
// (S2a r2 P1 #2: an old return / a delayed response never deletes a newer placement):
//   1 cash 200 / idempotent 200 ⇒ placed           5 (S1) cash legacy 409 order_conflict ⇒ cleared, ONE resend on a fresh id
//   2 card paymentStatus paid / scheduled_paid      6 (S2) paymentStatus cancelled / failed ⇒ cleared (the next placement mints)
//   3 card 409 Already paid ⇒ paid_unverified       7 the hard expiry: max(min(closing, ts + 12 h), last_send + 60 min)
//   4 card paymentStatus closed_refunded ⇒ refund sheet (and the pay stash)
//   + a 426 answering the FIRST dispatch with no 202 / admission ever seen (refused before any server write; rule iii below)
// NEVER cleared by a reload, a cart edit / discard, dismissing a sheet, order_exists (any reason), order_context_changed,
// verifying / pending / scheduled_review / the poll timeout, a 403, a network failure or a 5xx. If in doubt, never mint: the
// customer is sent to the existing order. 60 min = the server's hosted-checkout window (HOSTED_TTL_MS, 45 min) + 15 min margin,
// pinned by a test against the real server export.
//
// MONEY WRITES ARE NEVER AUTO-RETRIED (DECISIONS 2026-10-24, S2a r2 P1 #4): createOrder and chargeOnlineOrder are sent ONCE per
// tap. THE DISPATCH RULE (S2a r3, advisor ruling on Codex r2):
//   (i)   BEFORE every send, the confirmed write of that identity records the send: dispatched + 1, unresolved: true (and
//         card: true, sticky, for a charge). A failed write ⇒ no send. A reload or a storage failure mid-flight therefore
//         always finds the send unresolved.
//   (ii)  ONLY a fully parsed, definitive server response moves the record out of unresolved. Anything else — a network error,
//         a 5xx, a 202, a body that cannot be read or parsed, a 200 missing its fields — leaves it unresolved. A card identity
//         with an unresolved send is NEVER charged again: recovery is one poll with the creds, else the recovery sheet. Cash
//         stays available (the customer's «Reintentar» re-sends the SAME id: idempotent server-side, no gateway).
//   (iii) a refusal may CLEAR the record (the 426 floor) ONLY when it answers the FIRST dispatch and no 202 / admission was ever
//         seen; otherwise the identity is kept and the placement goes to recovery.
//   `unresolved` and the economics belong to the CARD send (S2a r4): a cash dispatch never sets or settles `unresolved`, and once a
//   charge was dispatched a cash attempt never overwrites the economics — a cash answer says nothing about the earlier charge.
//   LOCK_INTERRUPTED_CARD (owner policy) additionally refuses cash on an interrupted card order.
// Only quotes (read-only) retry.
// A CHANGED placement never resumes an older checkout at new numbers (S2a r2 P1 #1): the server returns a live checkout at its
// STORED economics before any gate, so when an ISSUED card placement's economics (cartSig or the expected net) differ, the
// existing placement is resolved first; still live ⇒ it is RESUMED through the STORED credentials only — a redirect to the
// stored checkout URL (while inside its hosted window) showing the ORIGINAL economics; nothing is re-sent (a re-send could
// meet an expired attempt and mint a fresh checkout at the old pin). No usable credentials ⇒ the recovery sheet.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappApi = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const HOSTED_CHECKOUT_MS = 45 * 60 * 1000;             // the server's hosted-checkout window (HOSTED_TTL_MS, pinned by a test)
  const CAPP_SEND_GRACE_MS = HOSTED_CHECKOUT_MS + 15 * 60 * 1000;
  // POLICY (advisor ruling 2026-10-26, Codex r4): an interrupted card payment LOCKS its order in the app — no card AND no cash
  // attempt on it, only recovery, until it resolves or the record expires. `false` (cash stays available) is NOT safe today: the
  // server's cash absence-check and write are not atomic against a still-running card acquisition (payments backlog, beside
  // DECISIONS:2306); flip only once that server-side exclusion lands. The lock-off path stays tested for that day.
  const LOCK_INTERRUPTED_CARD = true;
  const MAX_PLACEMENT_MS = 12 * 60 * 60 * 1000;
  const MAX_TRIES = 3;                                   // READ-ONLY calls only (the quote): 2 retries, 1.5 s then 3 s
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
    // the forms' canonical wrapper (pselfupdate-wrapper-lint): the page loads sherpa-client.js first, so the fallback arm is dead
    function sherpaFetch(u, o){ var S = root && root.SherpaClient; return (S && typeof S.fetch === 'function') ? S.fetch(u, o) : fetch(u, o); }
    const sfetch = o.fetch || sherpaFetch;
    const storage = o.storage || (() => { try { return root.localStorage; } catch (_) { return null; } })();
    const now = o.now || (() => Date.now());
    const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    // the cancel return's single bounded check: its OWN timer (a backoff sleep must never shorten it)
    const timeout = o.timeout || ((ms) => new Promise((r) => { const h = setTimeout(r, ms); if (h && typeof h.unref === 'function') h.unref(); }));
    const cryptoApi = (root && root.crypto) || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    const randomBytes = o.randomBytes || ((n) => { const b = new Uint8Array(n); cryptoApi.getRandomValues(b); return b; });
    const memberOf = typeof o.member === 'function' ? o.member : () => o.member || null;
    const lockInterruptedCard = typeof o.lockInterruptedCard === 'boolean' ? o.lockInterruptedCard : LOCK_INTERRUPTED_CARD;
    const cq = o.confirmQuote || CQ({ now, setInterval: o.setInterval, clearInterval: o.clearInterval, requote: o.requote });
    const PLACE_KEY = `capp:${cfg.restaurantId}:pending_place`;
    const PAY_KEY = cfg.pendingPayKey;
    const E = cfg.endpoints || {};
    // S7a-1 (PLAN-capp-S7a r3/r3.1): HOSTED by the multi-store shell ⇔ the shell supplies the per-store cart snapshot key and the
    // completion-marker key. Absent (direct link, every S1-S4 suite) ⇒ every path below is the S2 path, unchanged.
    const CART_KEY = cfg.cartKey || null, PLACED_KEY = cfg.placedKey || null;
    const HOSTED = !!(CART_KEY && PLACED_KEY);
    // Codex r1 P1-1: page latches (hosted). markerSuspect ⇒ an UNVERIFIED marker could not be removed: no placement this page.
    // Codex r2 P1-1 / New 1: purchased = cart_gen → order_id of every PURCHASED cart this page has seen a placed marker for —
    // recorded BEFORE any removal step (a partial reconciliation keeps it; a restart re-derives it from the marker, which stays
    // until its removal is verified). A cart of THAT generation is never dispatched again; a new cart (a new gen) places normally.
    let markerSuspect = false;
    const purchased = new Map();

    // ── storage (every access guarded: unavailable storage reads as empty and refuses writes) ──
    const readJSON = (k) => { try { const v = storage && storage.getItem(k); return v ? JSON.parse(v) : null; } catch (_) { return null; } };
    const writeJSON = (k, v) => { try { if (!storage) return false; const s = JSON.stringify(v); storage.setItem(k, s); return storage.getItem(k) === s; } catch (_) { return false; } };
    const removeKey = (k) => { try { if (storage) storage.removeItem(k); } catch (_) {} };
    // S7a-1 r3 §1.5: FAILURE-AWARE variants, used ONLY by the hosted reconciliation / freeze / handoff paths (the helpers above are
    // unchanged): a read error or unparseable value is NOT absence; a write is verified byte for byte; a removal is verified absent
    function readStrict(k) {
      try { if (!storage) return { ok: false }; const v = storage.getItem(k); if (v === null || v === undefined) return { ok: true, value: null }; return { ok: true, value: JSON.parse(v) }; } catch (_) { return { ok: false }; }
    }
    function writeStrict(k, v) { try { if (!storage) return false; const s = JSON.stringify(v); storage.setItem(k, s); return storage.getItem(k) === s; } catch (_) { return false; } }
    function removeStrict(k) { try { if (!storage) return false; storage.removeItem(k); return storage.getItem(k) === null; } catch (_) { return false; } }
    const newGen = () => { const b = randomBytes(8); let r = ''; for (const x of b) r += ID_CHARS[x % 32]; return r; };

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
    // a clearing outcome removes the record ONLY while it still holds THAT order (a newer placement is never deleted)
    function clearPlace(id) {
      const r = readJSON(PLACE_KEY);
      if (r && typeof r === 'object' && r.order_id === id) removeKey(PLACE_KEY);
    }
    // S7a-1 r3 §1.6: a placement ENDS (placed / released) ⇒ hosted: the verified completion marker FIRST, then the guarded clear;
    // a failed marker keeps the lock (recovery retries) and returns false — the caller keeps every piece of recovery evidence.
    // Not hosted ⇒ exactly clearPlace(id).
    // Codex r1 P1-4: the generation comes ONLY from THIS order's own evidence (its record, its stash — never the current cart,
    // never null). No evidence of this order on file ⇒ nothing of it is left to settle (a late answer for an order already
    // reconciled): nothing written, nothing cleared. Another order's marker is FINISHED first (reconciled), never overwritten.
    function resolvePlace(id, outcome) {
      if (!HOSTED) { clearPlace(id); return true; }
      const pr = readStrict(PLACE_KEY), ps = readStrict(PAY_KEY);
      if (!pr.ok || !ps.ok) return false;
      const r = pr.value && pr.value.order_id === id ? pr.value : null, s = ps.value && ps.value.order_id === id ? ps.value : null;
      const gen = (r && typeof r.cart_gen === 'string' && r.cart_gen) || (s && typeof s.cart_gen === 'string' && s.cart_gen) || null;
      if (!gen) return !r && !s;   // evidence without a generation ⇒ held (the freeze stays, §1.4)
      const m = readStrict(PLACED_KEY); if (!m.ok) return false;
      if (m.value && m.value.order_id !== id && !reconcile().ok) return false;
      // an UNVERIFIED marker never drives reconciliation: removed fail-closed (P1-1) — an unremovable one latches this page
      if (!writeStrict(PLACED_KEY, { order_id: id, cart_gen: gen, outcome, at: now() })) { if (!removeStrict(PLACED_KEY)) markerSuspect = true; return false; }
      clearPlace(id);
      return true;
    }
    // Codex r1 P1-2: an end whose marker did not land is reported UNSETTLED (the shell never treats it as terminal)
    const settledOf = (ok) => (ok ? {} : { unsettled: true });
    const fail = (code) => { const e = new Error(code); e.code = code; return e; };
    // a live record is re-written for THIS outgoing identity, then re-read: absent / expired / replaced ⇒ placement_lost
    function patchPlace(id, fields) {
      const r = readPlace();
      if (!r || r.order_id !== id) throw fail('placement_lost');
      Object.assign(r, typeof fields === 'function' ? fields(r) : fields || {});
      if (!writeJSON(PLACE_KEY, r)) throw fail('placement_write_failed');
      const back = readPlace();
      if (!back || back.order_id !== id) throw fail('placement_lost');
      return back;
    }
    // BEFORE EVERY send (rule i): the send itself — dispatched + 1, unresolved — with `last_send` (and the expiry it extends),
    // persisted and re-read for the specific outgoing identity
    function confirmSend(id, method, fields) {
      const t = now();
      return patchPlace(id, (cur) => ({ ...(fields || {}), dispatched: (Number(cur.dispatched) || 0) + 1, ...(method === 'online' ? { unresolved: true } : {}), card: cur.card === true || method === 'online',
        last_send: t, expires_at: expiresAtOf(cur.ts, t) }));
    }
    // rule ii: a definitive answer moves the record out of unresolved (a failed write leaves it unresolved — the safe side)
    const settle = (id) => { try { patchPlace(id, { unresolved: false }); } catch (_) {} };
    // a fresh record (a new id) — only when there is no live one
    function mintPlace(method, p) {
      const t = now();
      const r = { order_id: genOrderId(), method, body_sig: p.sig == null ? null : String(p.sig), expected_net_cents: num(p.expectedNetCents),
        totals: p.totals || null, dispatched: 0, unresolved: false, card: false, admitted: false, issued: false, ts: t, last_send: t, expires_at: expiresAtOf(t, t) };
      if (!writeJSON(PLACE_KEY, r)) throw fail('placement_write_failed');
      return r;
    }
    const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    // the economics a placement stands behind: the cart signature (cart / mode / pin / tip / auth) and the agreed net
    const sameEconomics = (r, p) => r.body_sig === (p.sig == null ? null : String(p.sig)) && r.expected_net_cents === num(p.expectedNetCents);

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
      const parsed = !!j && typeof j === 'object';
      return { status: r.status, json: parsed ? j : {}, parsed };   // `parsed` false ⇒ never a definitive answer (rule ii)
    }
    // ONE send; a thrown fetch is reported, never retried
    async function sendOnce(url, body, extraHeaders) { try { return await post(url, body, extraHeaders); } catch (e) { return { network: true, error: e }; } }
    // READ-ONLY calls only (the quote): network / 5xx (incl. 503) ⇒ up to MAX_TRIES with backoff
    async function withRetry(fn) {
      let last = null;
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
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
    // a poll state (payment-poll-state.js) → the outcome, applying the clearing rules to THAT order only
    // §4 (Codex r6): a successful GUEST placement returns a SIGNUP GRANT (phone_hash-bound, single-use, 15 min) — carried on the placed
    // outcome for the post-order account offer (frame 7); anything malformed is dropped (the offer then falls back to a normal signup)
    const grantOf = (j) => (cfg.guestCardOnly === true && !memberOf() && j && j.signup_grant && typeof j.signup_grant.token === 'string' && j.signup_grant.token
      && Number.isFinite(j.signup_grant.expires_at) ? { signup_grant: { token: j.signup_grant.token, expires_at: j.signup_grant.expires_at } } : {});
    function outcomeOfState(id, st, j) {
      // Codex r1 P1-2: the stash (the recovery credentials) is cleared ONLY once the completion is durable
      if (PAID_STATES.has(st)) { const ok = resolvePlace(id, 'placed'); if (ok) clearPayFor(id); return { ...grantOf(j), kind: 'placed', order_id: id, scheduled: st === 'scheduled_paid', tracking_token: (j && j.tracking_token) || null, scheduled_for: (j && j.scheduled_for) || null, ...settledOf(ok) }; }
      if (st === 'closed_refunded') { const ok = resolvePlace(id, 'released'); if (ok) clearPayFor(id); return { kind: 'refunded', order_id: id, refunded_total_cents: j && Number.isFinite(j.refunded_total_cents) ? j.refunded_total_cents : null, ...settledOf(ok) }; }
      if (st === 'cancelled' || st === 'failed') { const ok = resolvePlace(id, 'released'); return { kind: 'payment_failed', order_id: id, state: st, ...settledOf(ok) }; }   // (S2): the next placement mints
      return { kind: 'confirming', order_id: id, state: CONFIRMING_STATES.has(st) ? st : 'pending' };   // creds kept, no payment offer
    }
    const recoverySheet = (id) => ({ kind: 'existing_order', order_id: id, reference: ref4(id) });   // no mint, no payment action
    // S2b r1 P1-1 / P2-5: a cancel return the server still calls pending (or one without usable creds) LOCKS the order — kept on
    // its record (`pay_pending`), so a dismissal or a reload never re-opens payment: only the poll and the pending held state
    const pendingSheet = (id) => ({ kind: 'payment_failed', order_id: id, state: 'cancelled', clearable: false });
    // r2 P1-1: the lock is held IN MEMORY for this page first, so a failed write still fails closed (a reload derives it from the
    // S2a record: a card attempt that may hold a checkout needs a definitive poll before any send — place() below)
    let memLock = null;
    function lockPending(id) {
      memLock = id;
      const r = readPlace();
      if (r && r.order_id === id) { try { patchPlace(id, { pay_pending: true }); } catch (_) {} return; }
      if (r) return;   // a newer placement is never replaced
      const t = now();
      writeJSON(PLACE_KEY, { order_id: id, method: 'online', card: true, issued: true, unresolved: false, dispatched: 1, pay_pending: true, ts: t, last_send: t, expires_at: expiresAtOf(t, t) });
    }
    // a locked CASH record has no bank to wait on: its held state is the recovery sheet, never the pending one (r4 ruling)
    // Codex r1 P2-6: this page holds a payment lock (its in-memory lock, or a record the server still calls pending) — the hosted
    // mount reports device back `blocked` rather than letting the shell tear the store down over it
    // Codex r3 #5: the record is read STRICTLY here — an unreadable record is UNKNOWN, and unknown holds the lock (readPlace, which
    // reads a failure as absence, is unchanged for every S2 caller)
    function placeStrict() {
      const pr = readStrict(PLACE_KEY); if (!pr.ok) return { ok: false };
      const r = pr.value;
      const live = r && typeof r === 'object' && typeof r.order_id === 'string' && Number.isFinite(r.expires_at) && now() < r.expires_at ? r : null;
      return { ok: true, value: live };
    }
    function holdsLock() { if (memLock) return true; const ps = placeStrict(); if (!ps.ok) return true; return !!(ps.value && ps.value.pay_pending === true); }
    const cashRec = (id) => { const r = readPlace(); return !!(r && r.order_id === id && r.card !== true); };
    async function lockedOutcome(id) {
      const t = credsFor(id);
      if (!t) return cashRec(id) ? recoverySheet(id) : pendingSheet(id);
      const p = await pollOnce(id, t);
      if (p.forbidden) return recoverySheet(id);
      if (p.state === 'pending') return pendingSheet(id);
      if (memLock === id) memLock = null;
      return outcomeOfState(id, p.state, p.json);   // a definitive answer releases the lock (cancelled / failed clear the record)
    }
    // S7a-2 (Codex s7a2 r1 #1-2): the STATUS of a placement this page may hold a lock on — a locked order goes through lockedOutcome,
    // whose definitive poll RELEASES the lock (pending → paid ⇒ the customer can leave); any other through resolveExisting
    function resolveStatus(id) {
      const live = readPlace();
      if (memLock === id || (live && live.order_id === id && live.pay_pending === true)) return lockedOutcome(id);
      return resolveExisting(id);
    }
    async function resolveExisting(id) {
      const t = credsFor(id);
      if (t) {
        const p = await pollOnce(id, t);
        if (!p.forbidden) return outcomeOfState(id, p.state, p.json);
      }
      return recoverySheet(id);
    }

    // the refusals both order paths share → an outcome, or null when the path must handle it
    function commonRefusal(r) {
      const j = r.json || {};
      if (r.status === 426) return { kind: 'update_required' };
      if (r.status === 400 && (j.error === 'Restaurant closed' || (j.error === 'Bad Request' && j.detail === 'Cerrado — programá tu pedido'))) return { kind: 'closed' };
      if (r.status === 400 && j.error === 'Bad Request' && typeof j.detail === 'string' && j.detail.indexOf('Outside delivery zone') === 0) return { kind: 'out_of_zone' };
      if (r.status === 423 && j.error === 'ordering_paused') return { kind: 'paused', detail: j.detail || null };
      // §3.3 / §4 / §4b: the server's capp-guest gate (the reason codes of the confirmed wire contract)
      if (r.status === 400 && (j.error === 'guest_cash_not_allowed' || j.error === 'guest_email_required' || j.error === 'guest_ticket_invalid')) return { kind: j.error };
      return null;
    }
    const isExisting = (r) => r.status === 409 && (r.json.error === 'order_exists' || r.json.error === 'order_context_changed');
    // rule ii: a FULLY parsed, definitive answer; everything else is unresolved (the outcome is unknown)
    function definitive(method, r) {
      if (!r || r.network) return false;
      if (r.status === 426) return true;                                   // the floor: refused before any write (the status is the contract)
      if (!r.parsed) return false;
      const j = r.json;
      if (r.status === 200) return method === 'cash' ? j.ok === true : typeof j.checkout_url === 'string' && !!j.checkout_url && typeof j.poll_token === 'string' && !!j.poll_token;
      if (r.status === 202) return false;                                  // admitted: a checkout is being created
      if (r.status === 500) return method === 'online' && j.error === 'Payment not configured';
      if (r.status > 500) return false;
      return typeof j.error === 'string' && j.error !== '';
    }
    const placeErr = (e, id) => (e && e.code === 'placement_write_failed' ? { kind: 'stash_failed', order_id: id }
      : e && e.code === 'placement_lost' ? null : { kind: 'error', order_id: id, error: String((e && e.message) || e) });

    // ── one placement ──
    // p: { flow, ctx: { restaurantId, items, itemsText, member, headers }, sig, expectedNetCents, totals, sheet }
    // S7a-1 r3 §1.3: ORDERED, idempotent reconciliation of a completion marker — FIRST the guarded clear of THAT order's record,
    // then the matching-generation cart (placed ⇒ removed; released ⇒ unfrozen), then the marker. Any failure stops (ok:false).
    function reconcile() {
      if (!HOSTED) return { ok: true, done: 'none' };
      const m = readStrict(PLACED_KEY); if (!m.ok) return { ok: false, step: 'read_marker' };
      const mk = m.value;
      // a marker without a generation is not evidence (Codex r1 P1-4): removed, nothing else touched (the freeze stays, §1.4)
      if (!mk || typeof mk !== 'object' || typeof mk.order_id !== 'string' || typeof mk.cart_gen !== 'string' || !mk.cart_gen) return mk == null ? { ok: true, done: 'none' } : (removeStrict(PLACED_KEY) ? { ok: true, done: 'none' } : { ok: false, step: 'clear_marker' });
      if (mk.outcome === 'placed') purchased.set(mk.cart_gen, mk.order_id);   // r2 P1-1: before ANY removal step
      const pr = readStrict(PLACE_KEY); if (!pr.ok) return { ok: false, step: 'read_place' };
      if (pr.value && pr.value.order_id === mk.order_id && !removeStrict(PLACE_KEY)) return { ok: false, step: 'clear_place' };
      const cr = readStrict(CART_KEY); if (!cr.ok) return { ok: false, step: 'read_cart' };
      const c = cr.value;
      let cart = 'kept';
      if (c && c.cart_gen === mk.cart_gen && c.frozen_for === mk.order_id) {
        if (mk.outcome === 'placed') { if (!removeStrict(CART_KEY)) return { ok: false, step: 'clear_cart' }; cart = 'cleared'; }
        else { const { frozen_for, ...rest } = c; if (!writeStrict(CART_KEY, rest)) return { ok: false, step: 'unfreeze_cart' }; cart = 'unfrozen'; }
      }
      if (!removeStrict(PLACED_KEY)) return { ok: false, step: 'clear_marker' };
      return { ok: true, done: mk.outcome, order_id: mk.order_id, cart_gen: mk.cart_gen, cart };
    }
    // the cart's freeze (hosted): { frozen, order_id, live } — live = its placement record still exists. Codex r1 P1-3: a read
    // error is NOT an unfrozen cart — unknown ⇒ frozen (placement blocked)
    function cartFreeze() {
      if (!HOSTED) return { frozen: false };
      const cr = readStrict(CART_KEY); if (!cr.ok) return { frozen: true, unknown: true, order_id: null, live: false };
      const c = cr.value;
      if (!c || typeof c !== 'object' || typeof c.frozen_for !== 'string') return { frozen: false };
      const ps = placeStrict(); if (!ps.ok) return { frozen: true, unknown: true, order_id: c.frozen_for, live: false };   // r3 #5
      return { frozen: true, order_id: c.frozen_for, live: !!(ps.value && ps.value.order_id === c.frozen_for) };
    }
    async function place(p) {
      const method = p.flow.pay === 'online' ? 'online' : 'cash';
      // PLAN-capp-signin-required §3.2: the transport's tender mapping is part of the ONE invariant — an app GUEST (cfg.guestCardOnly,
      // no member) never maps to cash: refused here before any record, lock or send
      if (cfg.guestCardOnly === true && !memberOf() && method !== 'online') return { kind: 'guest_cash_not_allowed', local: true };
      // §4: an app guest order carries a VALID checkout ticket (the verified WhatsApp code, bound to phone + store + cart, 15 min) or
      // nothing is recorded, locked or sent
      if (cfg.guestCardOnly === true && !memberOf() && !ticketValid(p.checkoutTicket)) return { kind: 'guest_ticket_invalid', local: true };
      if (HOSTED) {
        if (markerSuspect) return { kind: 'offline', reconcile: 'marker_unverified' };   // P1-1: fail closed until a fresh mount
        const rc = reconcile();
        if (!rc.ok) return { kind: 'offline', reconcile: rc.step };   // blocked until reconciliation completes (nothing sent)
        // P1-1 (r2): a PURCHASED cart is never re-dispatched (new identity or not) — bound to its generation; a cart that carries no
        // generation is unknown ⇒ blocked once any purchase is on record here
        const cg = p.cartSnapshot && typeof p.cartSnapshot.cart_gen === 'string' && p.cartSnapshot.cart_gen ? p.cartSnapshot.cart_gen : null;
        if (purchased.size && (cg === null || purchased.has(cg))) return recoverySheet(cg === null ? [...purchased.values()].pop() : purchased.get(cg));
        const fz = cartFreeze();
        if (fz.unknown) return { kind: 'offline', reconcile: 'read_cart' };   // P1-3: unknown freeze state ⇒ blocked
        // r3 §1.4: a frozen cart whose lock expired with no marker NEVER unlocks — the drawn recovery sheet, never a new placement
        if (fz.frozen && !fz.live) return recoverySheet(fz.order_id);
      }
      const live = readPlace();
      if (memLock) return lockedOutcome(memLock);                                         // this page's lock (even if its write failed)
      if (live && live.pay_pending === true) return lockedOutcome(live.order_id);   // locked: zero writes until a definitive poll
      if (live && live.card === true && live.unresolved && (method === 'online' || lockInterruptedCard)) return resolveExisting(live.order_id);   // rule ii: never charged again
      // S2b r2 P1-1: a card attempt that may hold a checkout (admitted / issued) ⇒ a DEFINITIVE poll before ANY send for its id —
      // the dispatch rule applied on boot, so a lost pay_pending write cannot re-open payment after a reload
      if (live && live.card === true && (live.issued || live.admitted) && (method === 'online' || lockInterruptedCard)) {
        const t = credsFor(live.order_id);
        if (!t) return recoverySheet(live.order_id);
        const pr = await pollOnce(live.order_id, t);
        if (pr.forbidden) return recoverySheet(live.order_id);
        if (pr.state === 'pending' && method === 'online' && live.issued) return resume(live);   // back to ITS checkout — never a send
        const out = outcomeOfState(live.order_id, pr.state, pr.json);
        // placed / refunded / confirming — and (Codex r2 New 2) an UNSETTLED end: its marker did not land, so the record is still
        // A's and the loop below would re-dispatch A; it is returned, never re-sent
        if (out.kind !== 'payment_failed' || out.unsettled) return out;
        // cancelled / failed: cleared ⇒ a NEW placement (falls through and mints)
      }
      let expected = p.expectedNetCents;
      let healed = false; let silentRetried = false;
      for (let guard = 0; guard < 4; guard++) {
        if (typeof p.alive === 'function' && !p.alive()) return { kind: 'superseded' };   // r2 P2-3: a torn-down page never sends
        let rec;
        try {
          rec = readPlace() || mintPlace(method, p);
          // S7a-1 r3.1 N7: hosted ⇒ a VERIFIED freeze of the purchased cart is a precondition of the FIRST dispatch of an identity;
          // a failure stops here (zero sends; the drawn «Sin conexión» retry) and the retry reuses THIS identity
          if (HOSTED && !(Number(rec.dispatched) > 0)) {
            const sr = readStrict(CART_KEY); if (!sr.ok) return { kind: 'offline', order_id: rec.order_id, freeze_failed: true };   // P1-3
            const snap = sr.value && typeof sr.value === 'object' ? sr.value : {};
            const cs = p.cartSnapshot && Array.isArray(p.cartSnapshot.lines) ? p.cartSnapshot : null;
            // the cart's own generation unless it is bound to ANOTHER order (never borrowed across orders)
            // the generation: this identity's own, else the cart's own (the UI's, §1.4), else the stored cart's unless it is bound to
            // ANOTHER order (never borrowed across orders), else a new one
            const gen = rec.cart_gen || (cs && typeof cs.cart_gen === 'string' && cs.cart_gen) || ((!snap.frozen_for || snap.frozen_for === rec.order_id) && typeof snap.cart_gen === 'string' && snap.cart_gen) || newGen();
            // Codex r1 P2-8: the supplied snapshot's own version (v2 — CappCart.hydrate accepts only v2), never a v1 default
            if (!writeStrict(CART_KEY, { ...snap, v: cs ? cs.v : snap.v, rid: cfg.restaurantId, mode: p.flow && p.flow.mode, lines: cs ? cs.lines : snap.lines, cart_gen: gen, frozen_for: rec.order_id })) return { kind: 'offline', order_id: rec.order_id, freeze_failed: true };
            if (rec.cart_gen !== gen) rec = patchPlace(rec.order_id, { cart_gen: gen });
          }
          // an un-issued identity carries the economics of the body actually sent (an issued one keeps its checkout's, and a cash
          // attempt never overwrites a charge's); the method is the record's first one once a charge was ever dispatched (`card` is sticky)
          rec = confirmSend(rec.order_id, method, rec.issued || (rec.card && method !== 'online') ? {} : { ...(rec.card ? {} : { method }), body_sig: p.sig == null ? null : String(p.sig), expected_net_cents: num(expected), totals: p.totals || rec.totals || null });
        } catch (e) { const pe = placeErr(e, rec && rec.order_id); return pe || (rec ? resolveExisting(rec.order_id) : { kind: 'error', error: 'placement_lost' }); }
        const id = rec.order_id;
        const body = C.orderBody(p.flow, { ...p.ctx, orderId: id });
        if (cfg.guestCardOnly === true && !memberOf() && p.checkoutTicket) body.checkout_ticket = p.checkoutTicket.ticket;   // §4 (consumed at placement by the server)
        cq.send(body, p.sig, expected);
        const r = method === 'cash' ? await sendOnce(E.createOrder, body, p.ctx.headers) : await sendCard(id, body, p.ctx, p.alive);
        if (r && r.stop) return r.stop;
        if (!definitive(method, r)) return method === 'cash' ? { kind: 'offline', order_id: id } : resolveExisting(id);   // rule ii
        const j = r.json;
        if (r.status === 426) {                                                           // rule iii
          const cur = readPlace();
          if (cur && cur.order_id === id && Number(cur.dispatched) === 1 && cur.admitted !== true) { const ok = resolvePlace(id, 'released'); return { kind: 'update_required', order_id: id, ...settledOf(ok) }; }
          return { ...(await resolveExisting(id)), update_required: true };               // an earlier send / admission may land: kept UNRESOLVED
        }
        if (method === 'online' && r.status === 200) return cardIssued(id, body, j);   // settles only once the creds are stored
        if (method === 'online') settle(id);                                              // a cash answer never settles a charge
        if (method === 'cash') {
          if (r.status === 200) { const ok = resolvePlace(id, 'placed'); return { ...grantOf(j), kind: 'placed', order_id: j.order_id || id, tracking_token: j.tracking_token || null, idempotent: !!j.idempotent, ...settledOf(ok) }; }
          if (r.status === 409 && j.error === 'order_conflict') {
            if (healed) return { kind: 'error', order_id: id, error: 'order_conflict' };
            healed = true; clearPlace(id); continue;   // (S1): proven terminal-safe — ONE resend on a fresh id
          }
        } else {
          if (r.status === 409 && j.error === 'Already paid') return alreadyPaid(id);
        }
        if (isExisting(r)) return resolveExisting(id);
        const cr = commonRefusal(r);
        if (cr) return { ...cr, order_id: id };
        // r3 P2-3: a late answer after teardown is PERSISTED above (settle / issue / clear) but never rendered — no price sheet
        if (typeof p.alive === 'function' && !p.alive()) return { kind: 'superseded', order_id: id };
        const rj = await cq.handleRejection({ err: j, shownCents: expected, hasReward: false, retried: silentRetried, sheet: p.sheet });
        if (rj && rj.handled) {
          if (!rj.resend) return { kind: rj.declined ? 'price_declined' : 'error', order_id: id };
          if (typeof rj.expectedNetCents === 'number') expected = rj.expectedNetCents;   // the body now stands behind THIS number
          if (typeof p.onExpected === 'function') { try { p.onExpected(expected); } catch (_) {} }   // the UI shows the ceiling it sends
          if (rj.silent) silentRetried = true;
          continue;   // the SAME identity (mintNewOrderId is reward-only, never in S2)
        }
        if (method === 'online' && r.status === 500) return { kind: 'payment_not_completed', order_id: id };   // 'Payment not configured'
        return { kind: 'error', order_id: id, status: r.status, error: j.error || null };
      }
      return { kind: 'error', error: 'loop_guard' };
    }
    // r2 P1 #1 RESUME, through the stored credentials ONLY: the stored checkout URL while it is inside its hosted window (from
    // when this placement first saw it), with the ORIGINAL economics — never a re-send, never the new quote
    function resume(live) {
      const id = live.order_id;
      if (typeof live.checkout_url !== 'string' || !live.checkout_url || !Number.isFinite(live.checkout_at) || now() >= live.checkout_at + HOSTED_CHECKOUT_MS) return recoverySheet(id);
      return { kind: 'redirect', order_id: id, url: live.checkout_url, resumed: true, expected_net_cents: live.expected_net_cents, totals: live.totals || null };
    }
    // 202 in_progress ⇒ admitted (recorded); the SAME identity re-sent by THIS instance, bounded, EVERY re-send a new confirmed
    // dispatch (rule i); exhausted ⇒ the 202 stands (unresolved ⇒ recovery)
    async function sendCard(id, body, ctx, alive) {
      for (let i = 0; i < IN_PROGRESS_TRIES; i++) {
        if (i > 0 && typeof alive === 'function' && !alive()) return { stop: { kind: 'superseded', order_id: id } };   // r3 P2-3: a torn-down page never re-sends (the record keeps its 202: admitted)
        if (i > 0) { try { confirmSend(id, 'online'); } catch (e) { return { stop: placeErr(e, id) || await resolveExisting(id) }; } }
        const r = await sendOnce(E.chargeOnlineOrder, body, ctx.headers);
        if (r.network || r.status !== 202 || !r.parsed) return r;
        try { patchPlace(id, { admitted: true }); } catch (e) { return { stop: placeErr(e, id) || await resolveExisting(id) }; }
        await sleep(BACKOFF_MS(Math.min(i + 1, 2)));   // never poll without a token, never mint — re-send
      }
      return { status: 202, json: { status: 'in_progress' }, parsed: true };
    }
    // fresh / reuse 200: persist the creds AFTER the response and BEFORE the redirect (a failed write ⇒ no redirect, and the
    // send stays UNRESOLVED: the checkout exists but cannot be polled)
    function cardIssued(id, body, j) {
      if (!writeJSON(PAY_KEY, { order_id: id, t: j.poll_token, order: body, form: null, ts: now(), ...(HOSTED ? { rid: cfg.restaurantId, cart_gen: (readPlace() || {}).cart_gen || null } : {}) })) return { kind: 'stash_failed', order_id: id };   // the send stays unresolved
      const r = readPlace();
      const seenAt = r && r.order_id === id && r.checkout_url === j.checkout_url && Number.isFinite(r.checkout_at) ? r.checkout_at : now();
      try { patchPlace(id, { issued: true, checkout_url: j.checkout_url, checkout_at: seenAt, unresolved: false }); } catch (_) {}   // a reused checkout keeps the time it was first seen
      return { kind: 'redirect', order_id: id, url: j.checkout_url };
    }
    // 409 Already paid: payment recovery, never «Pago no completado», never a new payment
    async function alreadyPaid(id) {
      const t = credsFor(id);
      if (t) {
        const p = await pollOnce(id, t);
        if (!p.forbidden) return outcomeOfState(id, p.state, p.json);
      }
      const ok = resolvePlace(id, 'placed');   // (3): the server has said the order is paid; no token ⇒ never poll
      return { kind: 'paid_unverified', order_id: id, ...settledOf(ok) };
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
        // no usable creds: never «Tu banco no autorizó» without an authoritative answer — recovery, locked (S2b r1 P2-5)
        // OWNER (B), 2026-10-26: NO record and NO creds ⇒ the pending sheet once, nothing locked (a cancel almost surely charged
        // nothing); ANY record on file (cash or card, r3 P2-5) keeps the fail-closed lock
        if (!id || !t) { const r = readPlace(); const lid = r ? r.order_id : null; if (lid) lockPending(lid); return lid && r.card !== true ? recoverySheet(lid) : pendingSheet(lid || id || null); }
        const p = await Promise.race([pollOnce(id, t), timeout(CANCEL_CHECK_MS).then(() => ({ state: 'pending', json: {} }))]);
        // the authoritative poll state wins (P2 #5); a server that still says pending LOCKS the order (the pending held state)
        if (p && !p.forbidden && p.state !== 'pending') return outcomeOfState(id, p.state, p.json);
        lockPending(id);
        return pendingSheet(id);
      }
      if (pay !== 'complete' || !id || !t) return { kind: 'confirming', order_id: id || null, state: 'pending' };
      const deadline = now() + POLL_DEADLINE_MS;
      while (now() < deadline) {
        const p = await pollOnce(id, t);
        if (p.forbidden) return recoverySheet(id);
        if (p.state !== 'pending') {
          const out = outcomeOfState(id, p.state, p.json);
          if (out.kind !== 'confirming' || p.state === 'verifying' || p.state === 'scheduled_review') return out;
        }
        await sleep(POLL_EVERY_MS);
      }
      return { kind: 'confirming', order_id: id, state: 'timeout' };   // the webhook confirms later; creds kept
    }

    // ── §4: the guest's checkout code (PLAN-capp-signin-required r5.4; the CONFIRMED wire contract, advisor 2026-10-27) — WhatsApp
    //    only; the ticket is bound to phone + restaurant + cart fingerprint and expires (TICKET_TTL_MS). Never retried by itself ──
    const TICKET_TTL_MS = 15 * 60 * 1000;
    function ticketValid(t) { return !!t && typeof t.ticket === 'string' && t.ticket && Number.isFinite(t.expires_at) && now() < t.expires_at; }
    const secs = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);
    async function requestCheckoutCode({ phone, cartFp }) {
      if (!E.requestCheckoutCode) return { kind: 'offline' };
      const r = await sendOnce(E.requestCheckoutCode, { phone_e164: phone, restaurant_id: cfg.restaurantId, cart_fp: cartFp });
      if (r.network || !r.parsed) return { kind: 'offline' };
      const j = r.json;
      if (r.status === 200 && j.ok === true) return { ok: true, resendInS: secs(j.resend_in_s) ?? 60 };
      if (r.status === 429 && j.error === 'rate_limited') return { kind: 'rate_limited', retryInS: secs(j.retry_in_s) ?? 600 };
      if (r.status === 502 && j.error === 'send_failed') return { kind: 'send_failed', attempt: secs(j.attempt) ?? 1, max: secs(j.max_attempts) ?? 3 };
      if (r.status === 400 && j.error === 'country_not_allowed') return { kind: 'country_not_allowed' };
      return { kind: 'offline' };
    }
    async function verifyCheckoutCode({ phone, cartFp, code }) {
      if (!E.verifyCheckoutCode) return { kind: 'offline' };
      const r = await sendOnce(E.verifyCheckoutCode, { phone_e164: phone, restaurant_id: cfg.restaurantId, cart_fp: cartFp, code });
      if (r.network || !r.parsed) return { kind: 'offline' };
      const j = r.json;
      if (r.status === 200 && j.ok === true && typeof j.checkout_ticket === 'string' && j.checkout_ticket) return { ok: true, ticket: { ticket: j.checkout_ticket, phone, cart_fp: cartFp, expires_at: now() + TICKET_TTL_MS } };
      if (r.status === 400 && (j.error === 'code_wrong' || j.error === 'code_expired')) return { kind: j.error };
      if (r.status === 429 && j.error === 'too_many_attempts') return { kind: 'too_many_attempts', retryInS: secs(j.retry_in_s) ?? 600 };
      return { kind: 'offline' };
    }

    // the order body a card send stashed (the return restores the checkout from it)
    function stashedOrder(id) { const s = readPay(); return s && s.order_id === id && s.order && typeof s.order === 'object' ? s.order : null; }

    return { quote, latestQuote, place, handleReturn, resolveExisting, resolveStatus, requestCheckoutCode, verifyCheckoutCode, ticketValid, TICKET_TTL_MS, readPlace, clearPlace, genOrderId, expiresAtOf, credsFor, stashedOrder,
      reconcile, cartFreeze, holdsLock, newGen, readStrict, writeStrict, removeStrict, hosted: HOSTED,
      confirmQuote: cq, PLACE_KEY };
  }

  return { createApi, CAPP_SEND_GRACE_MS, HOSTED_CHECKOUT_MS, MAX_PLACEMENT_MS, MAX_TRIES, LOCK_INTERRUPTED_CARD };
});
