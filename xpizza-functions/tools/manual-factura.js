#!/usr/bin/env node
'use strict';
// MANUAL FACTURA — the OWNER issues a factura for an off-app sale (PLAN-manual-factura r3; owner deadline 11-21). OWNER-RUN; every
// write is the owner's (rule 21). PREVIEW unless --apply. Pinned: --project must be stated and match .firebaserc (exit 2 otherwise);
// ADC credentials (gcloud auth application-default login); no dotenv.
//
//   node tools/manual-factura.js --project xpizza-delivery issue --rid x_pizza --total 115.00 [--concept "…"] [--name "…" --rtn 14digits] --by "<who>" [--apply] [--op <opId>]
//   node tools/manual-factura.js --project xpizza-delivery status --rid x_pizza --op <opId>
//   node tools/manual-factura.js --project xpizza-delivery void --rid x_pizza --op <opId> --reason "…" --by "<who>" [--apply]
//
// issue: --total is the amount the customer paid, in lempiras (ISV-inclusive); base and ISV come from the canonical 15% split. Without
// --apply it prints the renderer-faithful preview and the número it WILL take (if nothing else issues first) and writes nothing. With
// --apply it issues through factura/manual-core (ONE transaction) and prints the número + the opId. To retry safely, re-run with the
// SAME --op: it returns the same número, never a second one.
const crypto = require('crypto');
const MF = require('../factura/manual-core');
const { priceBreakdown } = require('../factura/money');
const { hnDateISO } = require('../factura/build-record');

// "115", "115.5", "115.50" → integer cents exactly (string arithmetic: no float drift). Anything else → null.
function parseTotalCents(s) {
  if (typeof s !== 'string' || !/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [l, c = ''] = s.split('.');
  const cents = Number(l) * 100 + Number((c + '00').slice(0, 2));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function derivePayload({ concept, total, name, rtn }) {
  const total_cents = parseTotalCents(total);
  if (total_cents === null) return null;
  const b = priceBreakdown(total_cents);
  return { concept: concept || '', customer_name: name || '', rtn: rtn || '', base_cents: b.subtotal_cents, isv_cents: b.isv_cents, total_cents };
}

// The owner reads Spanish: one line per refusal code (vos).
const MESSAGES = {
  name_required_with_rtn: 'Con RTN, poné el nombre o razón social.', bad_rtn: 'El RTN debe tener 14 dígitos.', bad_amount: 'El monto no es válido (lempiras, p. ej. 115.00).',
  bad_concept: 'El concepto puede tener hasta 28 caracteres.', bad_name: 'El nombre puede tener hasta 80 caracteres.',
  config_temp: 'La configuración fiscal es de PRUEBA: no se puede emitir.', config_expired: 'La fecha límite de emisión (CAI) ya pasó.',
  config_no_expiry: 'Falta la fecha límite de emisión en la configuración fiscal.', range_exhausted: 'Se agotó el rango autorizado de facturas.',
  range_invalid: 'El número siguiente está fuera del rango autorizado.', config_invalid: 'La configuración fiscal está incompleta.',
  config_missing: 'No hay configuración fiscal para este restaurante.', op_reused: 'Ese código de operación ya se usó con otros datos.',
  not_platform_factura: 'Este restaurante no emite facturas desde la plataforma.', bad_op_id: 'El código de operación no es válido.',
  not_found: 'No se encontró esa factura.', short_ref_exhausted: 'No se pudo asignar una referencia corta.', bad_request: 'Faltan datos o no son válidos.',
};
const messageOf = (code) => MESSAGES[code] || code;

function renderText(record) {
  const { layoutFactura } = require('../../xpizza-factura/src/renderer');   // the print agent's own layout (renderer-faithful)
  return layoutFactura(record).join('\n');
}

// The número it WILL take + the exact rendered document. Reads only.
async function preview(rtdb, { rid, concept, total, name, rtn, op, now }) {
  const payload = derivePayload({ concept, total, name, rtn });
  if (!payload) return { ok: false, code: 'bad_amount' };
  const norm = MF.normalizePayload(payload);
  if (norm.code) return { ok: false, code: norm.code };
  const cfg = (await rtdb.ref(`restaurants/${rid}/factura_config`).once('value')).val();
  if (!cfg) return { ok: false, code: 'config_missing' };
  const next = (cfg.seq && cfg.seq.last_reserved) + 1;
  const why = MF.configRefusal(cfg, next, now);
  if (why) return { ok: false, code: why };
  const record = MF.buildManualRecord(cfg, norm.payload, next, now, op || 'preview', op ? MF.shortRefOf(op, 8) : 'M-????????');
  return { ok: true, numero: next, factura_number: record.factura_number, payload: norm.payload, text: renderText(record), restaurant: cfg.restaurant_name, fecha_hn: hnDateISO(now) };
}

async function apply(rtdb, { rid, concept, total, name, rtn, by, op, now }) {
  const payload = derivePayload({ concept, total, name, rtn });
  if (!payload) return { ok: false, code: 'bad_amount' };
  const opId = op || `mf_${crypto.randomBytes(8).toString('hex')}`;
  const r = await MF.issueManual(rtdb, { rid, opId, payload, issuedBy: by, now });
  return r.ok ? { ...r, op_id: opId } : r;
}

async function status(rtdb, { rid, op }) { return MF.statusManual(rtdb, { rid, opId: op }); }

async function voidCmd(rtdb, { rid, op, reason, by, apply: doApply, now }) {
  const before = await MF.statusManual(rtdb, { rid, opId: op });
  if (!before.found) return { ok: false, code: 'not_found' };
  if (!doApply) return { ok: true, dryRun: true, status: before };
  const r = await MF.voidManual(rtdb, { rid, opId: op, reason, voidedBy: by, now });
  if (!r.ok) return r;
  return { ok: true, idempotent: r.idempotent, status: await MF.statusManual(rtdb, { rid, opId: op }) };
}

module.exports = { parseTotalCents, derivePayload, preview, apply, status, voidCmd, messageOf };

if (require.main === module) {
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });   // FIRST: a wrong / unstated project exits 2 before anything is touched
  const argv = process.argv.slice(2);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const has = (k) => argv.includes(k);
  const cmd = ['issue', 'status', 'void'].find((c) => argv.includes(c));
  const usage = (msg) => { console.error(`manual-factura: ${msg}\n  see the header of tools/manual-factura.js for usage`); process.exit(1); };
  const rid = val('--rid');
  if (!cmd) usage('a command is required: issue | status | void');
  if (!rid) usage('--rid is required (no default)');
  const admin = require('firebase-admin');
  const { RTDB_URL } = require('../catalog/mirror-rtdb');
  admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
  const rtdb = admin.database();
  const now = Date.now();
  const L = (c) => `L ${(c / 100).toFixed(2)}`;
  const done = (code) => { admin.app().delete().finally(() => process.exit(code)); };
  (async () => {
    if (cmd === 'issue') {
      const args = { rid, concept: val('--concept'), total: val('--total'), name: val('--name'), rtn: val('--rtn'), by: val('--by'), op: val('--op'), now };
      if (!args.total) usage('--total is required (lempiras, e.g. 115.00)');
      if (!args.by) usage('--by is required (who is issuing)');
      const p = await preview(rtdb, args);
      if (!p.ok) { console.error(`NO SE EMITIÓ: ${messageOf(p.code)} (${p.code})`); return done(1); }
      console.log(`${p.restaurant} — manual factura PREVIEW (${p.fecha_hn})\n${'-'.repeat(48)}\n${p.text}\n${'-'.repeat(48)}`);
      console.log(`total ${L(p.payload.total_cents)} = base ${L(p.payload.base_cents)} + ISV 15% ${L(p.payload.isv_cents)}`);
      if (!has('--apply')) { console.log(`DRY RUN — it WILL take ${p.factura_number} (if nothing else issues first). Re-run with --apply to issue.`); return done(0); }
      const r = await apply(rtdb, args);
      if (!r.ok) { console.error(`NO SE EMITIÓ: ${messageOf(r.code)} (${r.code})`); return done(1); }
      console.log(`${r.idempotent ? 'ALREADY ISSUED' : 'ISSUED'}: ${r.factura_number}  ref ${r.short_ref}  (opId ${r.op_id}${r.idempotent ? '' : ' — keep it: re-run with --op to retry safely'})`);
      return done(0);
    }
    const op = val('--op');
    if (!op) usage('--op <opId or M- short ref> is required');
    if (cmd === 'status') {
      const s = await status(rtdb, { rid, op });
      console.log(s.found ? `${s.factura_number}  ${s.short_ref}  ${s.state}  ${L(s.total_cents)}  copy:${s.copy ? 'yes' : 'NO'}  printed:${s.printed ? 'yes' : 'no'}  copy_void:${s.copy_void ? 'yes' : 'no'}` : 'not found');
      return done(s.found ? 0 : 1);
    }
    const reason = val('--reason'); const by = val('--by');
    if (!reason || !by) usage('void needs --reason and --by');
    const v = await voidCmd(rtdb, { rid, op, reason, by, apply: has('--apply'), now });
    if (!v.ok) { console.error(`NO SE ANULÓ: ${messageOf(v.code)} (${v.code})`); return done(1); }
    console.log(v.dryRun ? `DRY RUN — ${v.status.factura_number} is ${v.status.state}. Re-run with --apply to void it.` : `${v.idempotent ? 'ALREADY VOIDED' : 'VOIDED'}: ${v.status.factura_number}  copy_void:${v.status.copy_void ? 'yes' : 'no'}  printed:${v.status.printed ? 'yes (a printed paper stays printed)' : 'no'}`);
    return done(0);
  })().catch((e) => { console.error('manual-factura: ERROR', e && e.code ? e.code : 'unexpected'); done(1); });
}
