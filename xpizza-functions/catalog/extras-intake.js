'use strict';
// PER-PRODUCT EXTRAS — THE INTAKE CHECK (PLAN-per-product-extras rev 2.1 §4/§5). Which paid extras an order line may
// carry, judged at every money intake (cash createOrder, card chargeOnlineOrder, quoteOrder, quoteRedemption) against
// the eligibility document of EXACTLY the catalog version the request's pricing tables were built from.
//
// MODE — a runtime platform switch, read once per request (createExtrasModeReader):
//   'off'      → nothing is read, nothing is decided (the only value that skips the check — it must be CONFIGURED)
//   'shadow'   → decided and LOGGED (eligibility_shadow), never refused: the order is charged as today
//   'enforce'  → a denied extra is refused (409 extra_not_allowed); an unreadable / absent document is a RETRYABLE
//                refusal (503 eligibility_unavailable) — never a fall-back to "unrestricted"
//   'unknown'  → the mode could not be read (an error, a timeout, a malformed value) and no last-known value within its
//                bound exists: treated as 'enforce' with outcome 'unavailable' for a FRESH issuance — the check is never
//                silently skipped because the config could not be read (codex plan r2 P1-3)
// An ABSENT node read SUCCESSFULLY is 'off' (advisor ruling, plan rev 2.2 §4): deleting it is the same admin-only authority
// as writing 'off' (platform_config is closed to clients), and reading it as unknown would turn a missed seed or a deleted
// node into a full ordering outage. Only an affirmative "absent" or "off" skips the check.
//
// It never prices anything: eligibility is not arithmetic (menu-pricing stays structure-free, deferral #8's arithmetic pin
// stands). Lines are addressed in PRICING keys through pricing's OWN resolvers (itemPricingKey / extraPricingKey), so an
// order line is judged by exactly the key it is charged by. Eligibility adds no per-brand rule of its own: it inherits
// pricing's addressing contract, whatever that is (today menu-pricing keys it per restaurant — existing onboarding debt
// there, not a second copy here).
const { eligibleSet } = require('./extras-eligibility');
const { itemPricingKey, extraPricingKey } = require('../menu-pricing');

const MODES = new Set(['off', 'shadow', 'enforce']);
const PATH = 'platform_config/extras_eligibility';

// ── the mode reader — bounded, single-flight, last-known-good (the client-floor shape, with an UNKNOWN cold outcome) ──
// maxStaleMs: how long a WARM instance keeps using its last-known mode while reads keep failing (then: unknown)
function createExtrasModeReader({ read, now = Date.now, ttlMs = 30000, timeoutMs = 1000, maxStaleMs = 10 * 60 * 1000 } = {}) {
  if (typeof read !== 'function') throw new Error('createExtrasModeReader: a read() is required');
  let last = null;          // { mode, at } — the last VALID configured mode
  let inflight = null;
  const withDeadline = (p) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('extras_mode_timeout')), timeoutMs);
    Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
  async function refresh() {
    let v;
    try { v = await withDeadline(read()); } catch (e) { return { ok: false, why: String((e && e.message) || e).slice(0, 120) }; }
    if (typeof v === 'string' && MODES.has(v)) { last = { mode: v, at: now() }; return { ok: true }; }
    if (v === null || v === undefined) { last = { mode: 'off', at: now() }; return { ok: true }; }   // a SUCCESSFUL read of an absent node = off
    return { ok: false, why: 'malformed' };
  }
  async function getMode() {
    if (last && now() - last.at < ttlMs) return { mode: last.mode, stale: false };
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    const r = await inflight;
    if (r.ok) return { mode: last.mode, stale: false };
    if (last && now() - last.at < maxStaleMs) { console.warn('eligibility_mode_stale', JSON.stringify({ why: r.why, mode: last.mode, age_ms: now() - last.at })); return { mode: last.mode, stale: true }; }
    console.warn('eligibility_mode_unknown', JSON.stringify({ why: r.why }));
    return { mode: 'unknown', stale: false };
  }
  return { getMode, _reset: () => { last = null; inflight = null; } };
}

// ── the check ──
const own = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
// A line's item / extra key is resolved by PRICING's OWN resolvers (menu-pricing itemPricingKey / extraPricingKey) — the
// key the line is CHARGED by, never a second guess (codex stage-2 r1 P1-1: preferring a recognized `id` let
// {name:'Salsa Roja', id:'Pepperoni'} be judged as Pepperoni and charged as Salsa Roja). The other field is ignored
// exactly as pricing ignores it. A key the tables do not price is pricing's refusal, not ours.
function lineItemKey(line, tables, rid) {
  const k = itemPricingKey(line, rid);
  return (typeof k === 'string' || typeof k === 'number') && own((tables && tables.menu) || {}, String(k)) ? String(k) : null;
}
function lineExtraKeys(line, tables, rid) {
  const ex = (tables && tables.extras) || {};
  const out = [];
  for (const e of (Array.isArray(line && line.extras) ? line.extras : [])) {
    const k = extraPricingKey(e, rid);
    if ((typeof k === 'string' || typeof k === 'number') && own(ex, String(k))) out.push(String(k));
  }
  return out;
}

// 🔴 MALFORMED KEYS ARE REFUSED, NEVER SKIPPED (codex stage-2 r2 P1). Pricing reads a line's key as a JavaScript PROPERTY key,
// so it COERCES: {name: ["Salsa Roja"]} prices as "Salsa Roja" (an array stringifies), as would an object, a boolean or null
// with a matching table key. Skipping such a key here let a denied extra through every intake while pricing charged it
// (L338; La Musa {id: ["rice_white"]} → L506). Rather than mirror the coercion, a product's or an extra's `id` / `name` that is
// PRESENT and not a string or a finite number makes the whole request malformed (400). Both fields, priced or not: no
// legitimate client sends anything else, and refusing is the only answer that cannot drift from pricing.
const validKey = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
function malformedKeys(items) {
  const out = [];
  (Array.isArray(items) ? items : []).forEach((line, i) => {
    if (!line || typeof line !== 'object') return;   // a non-object line is pricing's refusal (no key to coerce)
    for (const f of ['id', 'name']) if (own(line, f) && line[f] !== undefined && !validKey(line[f])) out.push({ line: i, field: f });
    (Array.isArray(line.extras) ? line.extras : []).forEach((e, j) => {
      if (!e || typeof e !== 'object') return;
      for (const f of ['id', 'name']) if (own(e, f) && e[f] !== undefined && !validKey(e[f])) out.push({ line: i, extra: j, field: f });
    });
  });
  return out;
}

// → { outcome: 'skip' | 'allow' | 'denied' | 'unavailable' | 'malformed', mode, versionId, denied: [{ item, extra }] }
async function extrasCheck({ mode, tables, items, rid, envelopeOf, readEligibility, deadlineMs = 1500 }) {
  const m = mode && mode.mode;
  if (m === 'off') return { outcome: 'skip', mode: 'off', versionId: null, denied: [] };
  const bad = malformedKeys(items);   // pure, no read: decided before (and regardless of) the version document
  if (bad.length) return { outcome: 'malformed', mode: (m === 'shadow' || m === 'enforce') ? m : 'unknown', versionId: null, denied: [], malformed: bad.slice(0, 10) };
  if (m !== 'shadow' && m !== 'enforce') return { outcome: 'unavailable', mode: 'unknown', versionId: null, denied: [], why: 'mode_unknown' };
  const env = typeof envelopeOf === 'function' ? envelopeOf(tables) : undefined;
  const versionId = env && typeof env.versionId === 'string' && env.versionId ? env.versionId : null;
  if (!versionId) return { outcome: 'unavailable', mode: m, versionId: null, denied: [], why: 'no_version' };   // flat / unversioned pricing: no document to bind to
  let doc;
  try {
    doc = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('eligibility_read_timeout')), deadlineMs);
      Promise.resolve(readEligibility(rid, versionId)).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  } catch (e) {
    return { outcome: 'unavailable', mode: m, versionId, denied: [], why: String((e && e.message) || e).slice(0, 120) };
  }
  if (!doc || !doc.projection) return { outcome: 'unavailable', mode: m, versionId, denied: [], why: 'document_absent' };   // a pre-feature version: never "unrestricted"
  const denied = [];
  for (const line of (Array.isArray(items) ? items : [])) {
    const itemKey = lineItemKey(line, tables, rid);
    if (!itemKey || !doc.projection.items || !own(doc.projection.items, itemKey)) continue;   // an unknown item is pricing's refusal, not ours
    const ok = eligibleSet(doc.projection, itemKey);
    for (const k of lineExtraKeys(line, tables, rid)) if (!ok.has(k)) denied.push({ item: itemKey, extra: k });
  }
  return { outcome: denied.length ? 'denied' : 'allow', mode: m, versionId, denied };
}

// the client generation a shadow observation is filed under: the ORDERS client's normalized compat (client-floor
// readClientHeaders), read exactly as isBelowFloor reads it — header-less or a foreign app → null (codex stage-2 r1 P2-4)
const ordersClientGen = (h) => (h && h.app === 'orders' && Number.isInteger(h.compat) ? h.compat : null);

// shadow: say what enforce WOULD do — the denominator of §6 (every evaluation, not just the would-refuses)
function logShadow(endpoint, rid, res, clientGen) {
  if (res.mode !== 'shadow') return;
  console.log('eligibility_shadow', JSON.stringify({ endpoint, rid, outcome: res.outcome === 'denied' ? 'would_refuse' : res.outcome,
    versionId: res.versionId, client_gen: clientGen === undefined ? null : clientGen, denied: res.denied.slice(0, 5), why: res.why || null,
    ...(res.malformed ? { malformed: res.malformed.slice(0, 5) } : {}) }));
}
// does this result REFUSE (enforce or unknown)? shadow and off never do
const refuses = (res) => (res.mode === 'enforce' || res.mode === 'unknown') && (res.outcome === 'denied' || res.outcome === 'unavailable' || res.outcome === 'malformed');

const EXTRA_NOT_ALLOWED = { error: 'extra_not_allowed', detail: 'Uno de los extras ya no está disponible para ese producto. Revisá tu pedido.' };
const ELIGIBILITY_UNAVAILABLE = { error: 'eligibility_unavailable', retryable: true, retryAfter: 2, detail: 'No pudimos confirmar los extras de tu pedido. Probá de nuevo.' };
const ITEM_MALFORMED = { error: 'item_malformed', detail: 'Tu pedido tiene un producto o un extra que no reconocemos. Volvé a armarlo, por favor.' };
const refusalBody = (res) => (res.outcome === 'denied' ? { ...EXTRA_NOT_ALLOWED, lines: res.denied }
  : res.outcome === 'malformed' ? { ...ITEM_MALFORMED } : { ...ELIGIBILITY_UNAVAILABLE });
const refusalStatus = (res) => (res.outcome === 'denied' ? 409 : res.outcome === 'malformed' ? 400 : 503);
// send a refusal the one way every intake does: 409 / 503, Retry-After on the retryable one, the typed body (+ `extra`)
function sendRefusal(res, xr, extra = {}) {
  if (xr.outcome === 'unavailable') res.set('Retry-After', String(ELIGIBILITY_UNAVAILABLE.retryAfter));
  return res.status(refusalStatus(xr)).json({ ...extra, ...refusalBody(xr) });
}
// the guard reason handed to acquireHostedAttempt (only on a FRESH issuance — bound reuse is never re-judged)
const guardReason = (res) => (refuses(res) ? (res.outcome === 'denied' ? 'extra_not_allowed' : 'eligibility_unavailable') : null);

module.exports = { createExtrasModeReader, extrasCheck, malformedKeys, logShadow, refuses, refusalBody, refusalStatus, sendRefusal, guardReason, ordersClientGen, lineItemKey, lineExtraKeys, PATH, MODES };
