'use strict';

/**
 * Manual factura — an owner-issued factura for an off-app sale (PLAN-manual-factura r3 §1–§5 + §8). The core every caller uses
 * (the owner CLI now, the portal endpoints later).
 *
 * ISSUE = ONE RTDB transaction on restaurants/{rid}/factura_config. That node is the PARENT of the config fields (CAI, range, expiry)
 * AND seq, so a renewal can't slip between validation and the increment, and it serializes against the app allocator's child-seq
 * transaction (RTDB retries one of two overlapping transactions). Inside it:
 *   idempotent by opId (the same payload ⇒ the existing número; a changed payload ⇒ op_reused) → validate the config (fail-closed:
 *   not is_temp, an ISO fecha_limite present and not past in Honduras-local time, range_start ≤ next ≤ range_end) → validate the amounts
 *   (safe-integer cents, total > 0, components ≥ 0, the canonical 15% split) → seq.last_reserved += 1 and manual/{opId} = the COMPLETE
 *   rendered record snapshot + { numero, payload, issued_by, issued_at, state:'issued' }.
 * One commit = número + record. seq.pending is never touched (the app's key space); /orders is never written.
 *
 * repairCopy derives the print copy facturas/{rid}/manual~{opId} ONLY from that snapshot (never the current config): create it when
 * missing; when the authority is voided, set the copy's void false→true; never un-void, never overwrite a copy's fields.
 * VOID = a monotonic transaction issued → voided on the authority, then repairCopy.
 * The restaurant must be a platform-factura restaurant (eligibility.usesPlatformFactura — the single fiscal authority).
 */

const crypto = require('crypto');
const { priceBreakdown } = require('./money');
const { buildFacturaRecord, hnDateISO } = require('./build-record');
const { usesPlatformFactura } = require('./eligibility');
const { printedAckFailed } = require('./print-recovery');   // the print agent's own marker test (byte-synced, factura/sync.test.js)

const OP_ID_RE = /^mf_[0-9a-f]{16}$/;   // ONE strict format, disjoint from a short ref (M- + UPPERCASE hex) — Codex #252-3
const RID_RE = /^[a-z0-9_]{1,40}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_CONCEPT = 'Elaboración de Pizzas';
const CONCEPT_MAX = 28;   // the renderer truncates a qty-1 line past this (xpizza-factura/src/renderer.js)
const NAME_MAX = 80;
const REASON_MAX = 120;
const CTRL_RE = /[\u0000-\u001f\u007f]/;

const configPath = (rid) => `restaurants/${rid}/factura_config`;
const manualPath = (rid, opId) => `${configPath(rid)}/manual/${opId}`;
const COPY_PREFIX = 'manual~';   // '~' is outside every server order-id charset (/^[A-Za-z0-9_-]{1,64}$/), so no app order's factura key can be a manual copy
// (the only other writers of a ~-keyed order are trusted staff accounts (Central dispatcher + kitchen), via whole-order or child /status writes; colliding
// with a REAL copy needs the never-shown 64-bit opId (facturas + factura_config are client-unreadable): it cannot occur). PLAN-manual-factura §6.
const copyPath = (rid, opId) => `facturas/${rid}/${COPY_PREFIX}${opId}`;
const isSafeCents = (v) => Number.isSafeInteger(v);
const text = (v) => (v == null ? '' : typeof v === 'string' ? v.trim() : null);

// The payload as stored (immutable) — or { code } when it can't be a manual factura.
function normalizePayload(p) {
  if (!p || typeof p !== 'object') return { code: 'bad_request' };
  const concept = text(p.concept); const name = text(p.customer_name); const rtn = text(p.rtn);
  if (concept === null || concept.length > CONCEPT_MAX || CTRL_RE.test(concept)) return { code: 'bad_concept' };
  if (name === null || name.length > NAME_MAX || CTRL_RE.test(name)) return { code: 'bad_name' };
  if (rtn === null || (rtn !== '' && !/^\d{14}$/.test(rtn))) return { code: 'bad_rtn' };
  if (rtn !== '' && name === '') return { code: 'name_required_with_rtn' };
  const { base_cents: base, isv_cents: isv, total_cents: total } = p;
  if (!isSafeCents(total) || !isSafeCents(base) || !isSafeCents(isv) || total <= 0) return { code: 'bad_amount' };
  const canon = priceBreakdown(total);   // cents, tax-inclusive 15%
  if (isv !== canon.isv_cents || base !== total - isv) return { code: 'bad_amount' };   // implies isv ≥ 0 and base ≥ 0 (no separate sign check)
  return { payload: { concept: concept || DEFAULT_CONCEPT, customer_name: name, rtn, base_cents: base, isv_cents: isv, total_cents: total } };
}

// The short reference printed on the PEDIDO line (owner Q4 11-21): «M-» + hex of sha256(opId), 8 chars unless an existing manual record
// already holds it — then extended (decided inside the issuing transaction, so two issues can't take the same one).
const shortRefOf = (opId, len) => `M-${crypto.createHash('sha256').update(String(opId)).digest('hex').slice(0, len).toUpperCase()}`;
const SHORT_REF_RE = /^M-[0-9A-F]{8,64}$/;
function freeShortRef(manual, opId) {
  const used = new Set(Object.values(manual || {}).map((m) => m && m.short_ref).filter(Boolean));
  for (let k = 8; k <= 64; k += 2) { const ref = shortRefOf(opId, k); if (!used.has(ref)) return ref; }
  return null;
}

const hashOf = (payload) => crypto.createHash('sha256').update(JSON.stringify(Object.keys(payload).sort().map((k) => [k, payload[k]]))).digest('hex');

// why the config can't issue `next` (null = it can) — fail-closed
const filled = (v) => typeof v === 'string' && v.trim() !== '';
const realDate = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso; };
function configRefusal(cfg, next, today) {   // today = the Honduras-local ISO date (hnDateISO)
  if (!filled(cfg.cai_code) || !filled(cfg.prefix) || !filled(cfg.rtn) || !filled(cfg.legal_name)   // the printed fiscal identity (Codex #252-6)
    || !cfg.seq || !Number.isSafeInteger(cfg.seq.last_reserved) || !Number.isSafeInteger(cfg.range_start) || !Number.isSafeInteger(cfg.range_end)) return 'config_invalid';
  if (cfg.is_temp === true) return 'config_temp';
  if (typeof cfg.fecha_limite !== 'string' || !ISO_DATE_RE.test(cfg.fecha_limite) || !realDate(cfg.fecha_limite)) return 'config_no_expiry';
  if (today > cfg.fecha_limite) return 'config_expired';
  if (next > cfg.range_end) return 'range_exhausted';
  if (next < cfg.range_start) return 'range_invalid';
  return null;
}

// The rendered record for a manual sale — the SAME builder the app uses, fed a one-line cash order. Pure (the CLI preview uses it too).
function buildManualRecord(cfg, payload, numero, { now, opId, shortRef = shortRefOf(opId, 8) }) {
  const order = {
    orderId: shortRef,   // ⇒ the PEDIDO line; the record's order_id stays the manual key below
    items: [{ qty: 1, description: payload.concept, line_gross_cents: payload.total_cents }],
    subtotal_cents: payload.base_cents, tax_cents: payload.isv_cents, total_cents: payload.total_cents,
    customer_name: payload.customer_name || 'Consumidor Final', razon_social: payload.customer_name, rtn_cliente: payload.rtn,
    payment_method: 'cash',
  };
  return { ...buildFacturaRecord({ order, config: cfg, reserved: numero, now }), order_id: `${COPY_PREFIX}${opId}` };
}

function refuse(code) { return { ok: false, code }; }

async function issueManual(db, { rid, opId, payload, issuedBy, now }) {
  if (typeof rid !== 'string' || !RID_RE.test(rid)) return refuse('bad_request');
  if (!usesPlatformFactura(rid)) return refuse('not_platform_factura');
  if (typeof opId !== 'string' || !OP_ID_RE.test(opId)) return refuse('bad_op_id');
  if (typeof issuedBy !== 'string' || !issuedBy) return refuse('bad_request');
  const norm = normalizePayload(payload);
  if (norm.code) return refuse(norm.code);
  const hash = hashOf(norm.payload);
  let out;
  await db.ref(configPath(rid)).transaction((cfg) => {
    out = null;
    if (cfg === null) { out = { code: 'config_missing' }; return null; }   // null-first: a real config re-runs this with its value
    const existing = cfg.manual && cfg.manual[opId];
    if (existing) { out = existing.payload_hash === hash ? { existing } : { code: 'op_reused' }; return cfg; }   // never abort on a value seen locally: returned unchanged, the server confirms it (or re-runs this with its own)
    const next = (cfg.seq && cfg.seq.last_reserved) + 1;
    const why = configRefusal(cfg, next, hnDateISO(now));
    if (why) { out = { code: why }; return cfg; }   // e.g. a partial local cache after a same-process update() must not refuse a valid config
    const shortRef = freeShortRef(cfg.manual, opId);
    if (!shortRef) { out = { code: 'short_ref_exhausted' }; return cfg; }
    const record = buildManualRecord(cfg, norm.payload, next, { now, opId, shortRef });
    const entry = { op_id: opId, short_ref: shortRef, source: 'manual', payload: norm.payload, payload_hash: hash, numero: next, factura_number: record.factura_number,
      record, issued_by: issuedBy, issued_at: now, state: 'issued' };
    out = { entry };
    return { ...cfg, seq: { ...cfg.seq, last_reserved: next }, manual: { ...(cfg.manual || {}), [opId]: entry } };
  }, undefined, false);   // applyLocally=false: a parent-node null-first pass applied locally would blind same-process readers of factura_config (the app allocator reads it)
  if (!out || out.code) return refuse((out && out.code) || 'config_missing');
  const e = out.entry || out.existing;
  await repairCopy(db, { rid, opId });   // idempotent; a crash before it is healed by the next call / a re-run
  return { ok: true, idempotent: !!out.existing, numero: e.numero, factura_number: e.factura_number, short_ref: e.short_ref, state: e.state, op_id: opId };
}

async function repairCopy(db, { rid, opId }) {
  const auth = (await db.ref(manualPath(rid, opId)).once('value')).val();
  if (!auth || !auth.record) return { ok: false, code: 'not_found' };
  const voided = auth.state === 'voided';
  let created = false; let voidSet = false;
  await db.ref(copyPath(rid, opId)).transaction((cur) => {
    created = false; voidSet = false;
    if (cur === null) {   // create from the SNAPSHOT (a real copy makes RTDB re-run this with its value)
      created = true;
      return { ...auth.record, void: voided, ...(voided ? { void_reason: auth.void_reason || '', voided_at: auth.voided_at } : {}) };
    }
    if (voided && cur.void !== true) { voidSet = true; return { ...cur, void: true, void_reason: auth.void_reason || '', voided_at: auth.voided_at }; }   // false → true only
    return cur;   // never un-void, never overwrite (unchanged: the server confirms the copy we judged)
  }, undefined, false);   // applyLocally=false: no speculative local value for same-process readers
  return { ok: true, created, void_set: voidSet };
}

async function voidManual(db, { rid, opId, reason, voidedBy, now }) {
  if (typeof rid !== 'string' || !RID_RE.test(rid) || typeof opId !== 'string' || !OP_ID_RE.test(opId)) return refuse('bad_request');
  if (!usesPlatformFactura(rid)) return refuse('not_platform_factura');
  const why = text(reason);
  if (why === null || why.length > REASON_MAX || CTRL_RE.test(why) || typeof voidedBy !== 'string' || !voidedBy) return refuse('bad_request');
  let out;
  await db.ref(manualPath(rid, opId)).transaction((cur) => {
    out = null;
    if (cur === null) { out = { code: 'not_found' }; return null; }
    if (cur.state === 'voided') { out = { idempotent: true }; return cur; }
    if (cur.state !== 'issued') { out = { code: 'bad_state' }; return cur; }
    out = { voided: true };
    return { ...cur, state: 'voided', void_reason: why, voided_by: voidedBy, voided_at: now };
  }, undefined, false);   // applyLocally=false: no speculative local value for same-process readers
  if (!out || out.code) return refuse((out && out.code) || 'not_found');
  await repairCopy(db, { rid, opId });
  const copy = (await db.ref(copyPath(rid, opId)).once('value')).val();
  if (!copy || copy.void !== true) return refuse('copy_not_voided');   // success only once the printable copy shows voided (a re-run repairs it)
  return { ok: true, idempotent: !!out.idempotent };
}

// The ONE op a key names: an opId as is, or the short ref printed on the paper (one read of the low-volume manual node). null = none.
async function resolveOp(db, { rid, key }) {
  if (typeof key !== 'string' || typeof rid !== 'string' || !RID_RE.test(rid)) return null;
  if (OP_ID_RE.test(key)) return (await db.ref(manualPath(rid, key)).once('value')).val() ? key : null;
  if (!SHORT_REF_RE.test(key)) return null;
  const all = (await db.ref(`${configPath(rid)}/manual`).once('value')).val() || {};
  return Object.keys(all).find((k) => OP_ID_RE.test(k) && all[k] && all[k].short_ref === key) || null;
}

// The copy's print state, allowlisted (never the raw print_error text).
const printClass = (copy) => (copy && copy.printed === true ? 'printed' : printedAckFailed(copy) ? 'printed_ack_failed' : 'not_printed');

// Status for one manual factura (by opId or short ref). Runs the idempotent repairCopy first (no periodic caller until the portal
// release), then reports the authority + the copy, issuance and printing separately.
async function statusManual(db, { rid, key }) {
  const opId = await resolveOp(db, { rid, key });
  if (!opId) return { found: false };
  await repairCopy(db, { rid, opId });
  const auth = (await db.ref(manualPath(rid, opId)).once('value')).val();
  const copy = (await db.ref(copyPath(rid, opId)).once('value')).val();
  return { found: true, op_id: opId, short_ref: auth.short_ref, state: auth.state, numero: auth.numero, factura_number: auth.factura_number, total_cents: auth.payload && auth.payload.total_cents,
    issued_at: auth.issued_at, voided_at: auth.voided_at || null, copy: !!copy, print: printClass(copy), copy_void: !!(copy && copy.void) };
}

module.exports = { COPY_PREFIX, issueManual, repairCopy, voidManual, statusManual, resolveOp, normalizePayload, buildManualRecord, configRefusal, shortRefOf, OP_ID_RE, SHORT_REF_RE, DEFAULT_CONCEPT, CONCEPT_MAX };
