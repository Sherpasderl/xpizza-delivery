// Customer app S7a-1 (PLAN-capp-S7a r1 → r3.1, APPROVED as a plan) — the multi-store SHELL's pure foundation. Pure, UMD,
// brand-agnostic (no restaurant id or name in this file — guarded). DARK: no page loads it yet; the shell UI is S7a-1's next step,
// gated on the owner's mockups (the frozen cart, the neutral return surface).
//
//   config    configFor(dirEntry, runtime) — the PUBLIC directory entry (presentation) + the per-APP runtime transport
//             (endpoints, intakeKey, mapsKey) → the existing CappUI `config` shape, plus the derived per-store storage keys
//   keys      keysFor(rid) — the per-restaurant keys: pending_place (capp-api's own), pending_pay, cart, placed
//   return    the hosted-checkout return: validated query → the owner from EXACT local records only (never an id prefix:
//             two stores share one) → a verified, resumable handoff kept until an AUTHORITATIVE terminal outcome
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappShell = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RETURN_KEY = 'capp:return';
  const keysFor = (rid) => ({ place: `capp:${rid}:pending_place`, pay: `capp:${rid}:pending_pay`, cart: `capp:${rid}:cart`, placed: `capp:${rid}:placed`, sent: `capp:${rid}:sent_order` });

  // ── r2 §1.1: the config split ──
  // dirEntry: the directory's allowlisted public entry; runtime: { endpoints, intakeKey, mapsKey } (the app deployment's)
  function configFor(dirEntry, runtime) {
    const d = dirEntry || {}, rt = runtime || {}, rid = d.restaurant_id;
    if (typeof rid !== 'string' || !rid) return null;
    const k = keysFor(rid);
    const range = (h) => (h && h.open === true && typeof h.start === 'string' && typeof h.end === 'string'
      ? [+h.start.slice(0, 2), +h.start.slice(3, 5), +h.end.slice(0, 2), +h.end.slice(3, 5)] : null);
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const sched = d.schedule && d.schedule.hours ? d.schedule.hours : null;
    return {
      restaurantId: rid, name: d.name || '', kicker: d.kicker || '', unit: Array.isArray(d.unit) && d.unit.length === 2 ? d.unit : undefined,
      logo: d.logo_url || '', logoWide: d.logo_wide === true, hero: d.hero_url || '', assetBase: d.asset_base || null,
      addr: d.pickup_addr || '', branch: d.branch || '',
      loc: Number.isFinite(d.hub_lat) && Number.isFinite(d.hub_lng) ? { lat: d.hub_lat, lng: d.hub_lng } : null,
      zoneKm: Number.isFinite(d.coverage_km) ? d.coverage_km : null,
      etaDel: Array.isArray(d.eta_delivery_min) ? d.eta_delivery_min : null, etaPick: Array.isArray(d.eta_pickup_min) ? d.eta_pickup_min : null,
      // the served schedule (C′, validated) ⇒ the store config's [h1,m1,h2,m2] per weekday; unavailable ⇒ every day closed (never assumed open)
      hours: sched ? days.map((dk) => range(sched[dk])) : Array(7).fill(null),
      feeFromCents: d.fee && d.fee.state === 'priced' && Number.isFinite(d.fee.from_cents) ? d.fee.from_cents : null,
      // the ONE free-delivery predicate (home's, Codex s7a2 r1 #7: a promotional claim needs a PRICED fee) — home and the store page
      // both read it (PLAN-capp-store-promo-feeinfo r0); the price itself is the server's (delivery-pricing: members only)
      promoFree: !!d.fee && d.fee.state === 'priced' && Number.isInteger(d.fee.from_cents) && d.fee.from_cents >= 0 && !!(d.promo && d.promo.free_delivery),
      orderIdPrefix: typeof d.order_id_prefix === 'string' ? d.order_id_prefix : undefined,
      endpoints: rt.endpoints, intakeKey: rt.intakeKey, mapsKey: rt.mapsKey || undefined,
      pendingPayKey: k.pay, cartKey: k.cart, placedKey: k.placed, sentKey: k.sent, entry: 'app',
      // PLAN-capp-signin-required r5.4: the app's guest rules (card only, email, WhatsApp code) — the RUNTIME's switch, off until it ships
      ...(rt.guestCardOnly === true ? { guestCardOnly: true } : {}),
      // PLAN-intl-phone r2.3 (S-picker): the WhatsApp country picker + E.164 on the wire — the RUNTIME's switch. FLIP PRECONDITION
      // (advisor 2026-10-27): only after S-core / S-match (server) land AND the per-sender UltraMsg country gate passes
      ...(rt.intlPhone === true ? { intlPhone: true } : {}),
      // PLAN-capp-S4 (r5): scheduled orders — the RUNTIME's one switch; with it, the store gets the SERVED schedule (the directory
      // entry's, P1) the picker computes from. FLIP PRECONDITIONS (advisor 2026-10-27): signup LIVE (G6) + PIN owner records
      // (platform_config/delivery_pin.generate === true); the «revisando» / tracker transitions need the (d) owner lookup
      ...(rt.schedulingLive === true ? { schedulingLive: true, schedule: d.schedule && typeof d.schedule === 'object' ? d.schedule : null } : {}),
    };
  }

  // ── r2 §1.5 / r3 §2 / r3.1 N3: the hosted-checkout return ──
  const ORDER_RE = /^[A-Z0-9-]{1,8}\d{6}-\d{6}-[0-9A-Z]{8}$/;
  function validateReturnQuery(search) {
    let q; try { q = new URLSearchParams(String(search || '')); } catch (_) { return null; }
    const pay = q.get('pay'), order = q.get('order'), t = q.get('t');
    if (pay !== 'complete' && pay !== 'cancel') return null;
    if (order !== null && !ORDER_RE.test(order)) return null;
    if (t !== null && !t) return null;
    return { pay, order: order || null, t: t || null };
  }
  const readJ = (storage, k) => { try { const v = storage.getItem(k); return v ? JSON.parse(v) : null; } catch (_) { return undefined; } };
  // the owner from EXACT local records: a pay stash for that order whose stored rid binding matches its key, or a placement record
  // for that order. Exactly one rid ⇒ it; zero / several ⇒ null (the neutral surface — no store is mounted or mutated)
  function resolveOwner(storage, order, rids) {
    if (!storage || !order) return { owner: null, matches: [] };
    const hits = new Set();
    for (const rid of rids || []) {
      const k = keysFor(rid);
      const pay = readJ(storage, k.pay);
      if (pay && pay.order_id === order && pay.rid === rid) hits.add(rid);
      const place = readJ(storage, k.place);
      if (place && place.order_id === order) hits.add(rid);
    }
    const matches = [...hits];
    return { owner: matches.length === 1 ? matches[0] : null, matches };
  }
  // verified write: the bytes read back equal the bytes written
  const writeV = (storage, k, v) => { try { const s = JSON.stringify(v); storage.setItem(k, s); return storage.getItem(k) === s; } catch (_) { return false; } };
  const removeV = (storage, k) => { try { storage.removeItem(k); return storage.getItem(k) === null; } catch (_) { return false; } };
  // the boot decision. A VALID query in the URL always wins: persisted (verified) ⇒ strip; persisting failed ⇒ process it IN MEMORY
  // and KEEP the URL (a stored handoff is ignored this boot). No query ⇒ resume a stored handoff (a reload during polling).
  function bootReturn({ search, storage, rids, now }) {
    const q = validateReturnQuery(search);
    if (q) {
      const { owner, matches } = resolveOwner(storage, q.order, rids);
      const h = { ...q, owner, at: typeof now === 'function' ? now() : Date.now() };
      const ok = !!storage && writeV(storage, RETURN_KEY, h);
      return { mode: ok ? 'persisted' : 'memory', strip: ok, handoff: h, owner, ambiguous: matches.length > 1 };
    }
    if (/[?&]pay=/.test(String(search || ''))) return { mode: 'invalid', strip: false, handoff: null, owner: null };
    const stored = storage ? readJ(storage, RETURN_KEY) : null;
    if (stored && typeof stored === 'object' && (stored.pay === 'complete' || stored.pay === 'cancel')) return { mode: 'resumed', strip: false, handoff: stored, owner: stored.owner || null };
    return { mode: 'none', strip: false, handoff: null, owner: null };
  }
  // r3 §2: AUTHORITATIVE terminal outcomes only (matched by kind AND clearable); the pending lock (payment_failed, clearable:false),
  // confirming, recovery and offline are NOT terminal — the handoff is kept
  // Codex r1 P1-2: an end whose completion marker did not land (`unsettled`) is NOT terminal — its evidence is kept
  function isTerminal(out) {
    if (!out || typeof out !== 'object') return false;
    if (out.unsettled === true) return false;
    if (out.kind === 'placed' || out.kind === 'paid_unverified' || out.kind === 'refunded' || out.kind === 'scheduled_review') return true;
    if (out.kind === 'payment_failed') return out.clearable !== false;
    return false;
  }
  // r3.1 N3: removed ONLY on a terminal outcome, or after a VERIFIED transfer of its credentials into the owner's pay stash.
  // Codex r1 P1-5: both are guarded by IDENTITY — `handoff` is the one the caller processed; the stored handoff is removed only
  // while it is still THAT handoff (a newer return is never deleted), and only by an outcome for ITS order
  const sameHandoff = (a, b) => !!a && !!b && typeof a === 'object' && a.pay === b.pay && (a.order || null) === (b.order || null) && (a.t || null) === (b.t || null) && a.at === b.at;
  function removeHandoffIf(storage, handoff) {
    const cur = readJ(storage, RETURN_KEY);
    return sameHandoff(cur, handoff) ? removeV(storage, RETURN_KEY) : false;
  }
  function settleHandoff(storage, out, handoff) {
    if (!storage || !handoff || !isTerminal(out)) return false;
    if (handoff.order && out.order_id !== handoff.order) return false;   // an outcome for ANOTHER order never settles it
    return removeHandoffIf(storage, handoff);
  }
  // the destination stash is written only when empty or already THIS order's (another order's is never overwritten); the
  // generation is the caller's, else this order's own — never another order's
  function transferHandoff(storage, handoff, cartGen) {
    if (!storage || !handoff || !handoff.owner || !handoff.order || !handoff.t) return false;
    const k = keysFor(handoff.owner);
    const cur = readJ(storage, k.pay);
    if (cur === undefined) return false;   // unreadable ⇒ unknown, never overwritten
    if (cur && cur.order_id !== handoff.order) return false;
    const gen = typeof cartGen === 'string' && cartGen ? cartGen : (cur && typeof cur.cart_gen === 'string' && cur.cart_gen) || null;
    const stash = { ...(cur || {}), order_id: handoff.order, t: handoff.t, rid: handoff.owner, cart_gen: gen };
    if (!writeV(storage, k.pay, stash)) return false;
    return removeHandoffIf(storage, handoff);
  }

  return { RETURN_KEY, keysFor, configFor, validateReturnQuery, resolveOwner, bootReturn, isTerminal, settleHandoff, transferHandoff };
});
