#!/usr/bin/env node
'use strict';
// MANUAL FACTURA — the OWNER issues a factura for an off-app sale (PLAN-manual-factura r3; owner deadline 11-21). OWNER-RUN; every
// write is the owner's (rule 21). PREVIEW unless --apply. Pinned: --project must be stated and match .firebaserc (exit 2 otherwise);
// ADC credentials (gcloud auth application-default login); no dotenv.
//
//   node tools/manual-factura.js --project xpizza-delivery issue --rid x_pizza --total 115.00 [--concept "…"] [--name "…" --rtn 14digits] --by "<who>"   (preview)
//   … the same … --op <opId from the preview> --apply
//   node tools/manual-factura.js --project xpizza-delivery status --rid x_pizza --op <opId | M-ref>
//   node tools/manual-factura.js --project xpizza-delivery void --rid x_pizza --op <opId | M-ref> --reason "…" --by "<who>" [--apply]
//
// issue: --total is the amount the customer paid, in lempiras (ISV-inclusive); base and ISV come from the canonical 15% split. Without
// --apply it prints the renderer-faithful preview, the número it WILL take (if nothing else issues first), a NEW opId and the exact
// command to issue it, and writes nothing. --apply REQUIRES that --op: the operation's identity is known before anything is written,
// so a crash at any point is retried with the same command and never consumes a second número (Codex #252-2). An --op that already
// exists goes straight to the core's idempotent return + copy repair, before any new-issuance check (Codex #252-4).
// status / void take the opId or the short ref printed on the PEDIDO line; status also repairs the print copy.
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
  not_found: 'No se encontró esa factura.', op_required: 'Falta --op: copiá el comando que mostró la vista previa.', copy_not_voided: 'La factura quedó anulada pero la copia de impresión aún no: volvé a correr el mismo comando.', short_ref_exhausted: 'No se pudo asignar una referencia corta.', bad_request: 'Faltan datos o no son válidos.',
};
const messageOf = (code) => MESSAGES[code] || code;

function renderText(record) {
  const { layoutFactura } = require('../../xpizza-factura/src/renderer');   // the print agent's own layout (renderer-faithful)
  return layoutFactura(record).join('\n');
}

const newOpId = () => `mf_${crypto.randomBytes(8).toString('hex')}`;
const shq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;   // POSIX single-quote: the printed command is pasted into a shell
function applyCommand({ rid, concept, total, name, rtn, by, op }) {
  const opt = (k, v) => (v ? ` --${k} ${shq(v)}` : '');
  return `node tools/manual-factura.js --project xpizza-delivery issue --rid ${rid} --total ${total}${opt('concept', concept)}${opt('name', name)}${opt('rtn', rtn)}${opt('by', by)} --op ${op} --apply`;
}

// The número it WILL take + the exact rendered document + the opId to issue it with. Reads only.
async function preview(rtdb, { rid, concept, total, name, rtn, by, op, now }) {
  const opId = op || newOpId();
  if (!MF.OP_ID_RE.test(opId)) return { ok: false, code: 'bad_op_id' };
  const payload = derivePayload({ concept, total, name, rtn });
  if (!payload) return { ok: false, code: 'bad_amount' };
  const norm = MF.normalizePayload(payload);
  if (norm.code) return { ok: false, code: norm.code };
  const cfg = (await rtdb.ref(`restaurants/${rid}/factura_config`).once('value')).val();
  if (!cfg) return { ok: false, code: 'config_missing' };
  const next = (cfg.seq && cfg.seq.last_reserved) + 1;
  const why = MF.configRefusal(cfg, next, hnDateISO(now));
  if (why) return { ok: false, code: why };
  const record = MF.buildManualRecord(cfg, norm.payload, next, { now, opId });   // the short ref shown = this op's 8-char ref (extended only on a rare collision)
  return { ok: true, numero: next, factura_number: record.factura_number, payload: norm.payload, text: renderText(record), restaurant: cfg.restaurant_name, fecha_hn: hnDateISO(now),
    op_id: opId, apply_command: applyCommand({ rid, concept, total, name, rtn, by, op: opId }) };
}

// Issue (or recover) the op the preview named. An EXISTING op goes straight to the core (idempotent return + copy repair; a changed
// payload ⇒ op_reused) — never through the new-issuance preflight, which would refuse it once the range is used up or the CAI expired.
async function apply(rtdb, { rid, concept, total, name, rtn, by, op, now }) {
  if (!op) return { ok: false, code: 'op_required' };
  if (!MF.OP_ID_RE.test(op)) return { ok: false, code: 'bad_op_id' };
  const payload = derivePayload({ concept, total, name, rtn });
  if (!payload) return { ok: false, code: 'bad_amount' };
  return MF.issueManual(rtdb, { rid, opId: op, payload, issuedBy: by, now });
}

async function status(rtdb, { rid, op }) { return MF.statusManual(rtdb, { rid, key: op }); }

async function voidCmd(rtdb, { rid, op, reason, by, apply: doApply, now }) {
  const opId = await MF.resolveOp(rtdb, { rid, key: op });   // resolved ONCE; every step below acts on this op
  if (!opId) return { ok: false, code: 'not_found' };
  if (!doApply) return { ok: true, dryRun: true, status: await MF.statusManual(rtdb, { rid, key: opId }) };
  const r = await MF.voidManual(rtdb, { rid, opId, reason, voidedBy: by, now });
  if (!r.ok) return r;
  return { ok: true, idempotent: r.idempotent, status: await MF.statusManual(rtdb, { rid, key: opId }) };
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
      if (has('--apply')) {
        if (!args.op) usage('--apply needs the --op the preview printed (run without --apply first)');
        const existing = MF.OP_ID_RE.test(args.op) && await MF.resolveOp(rtdb, { rid, key: args.op });
        if (!existing) {   // a NEW issuance: show what will be issued first
          const p = await preview(rtdb, args);
          if (!p.ok) { console.error(`NO SE EMITIÓ: ${messageOf(p.code)} (${p.code})`); return done(1); }
          console.log(`${p.restaurant} — manual factura (${p.fecha_hn})\n${'-'.repeat(48)}\n${p.text}\n${'-'.repeat(48)}`);
        }
        const r = await apply(rtdb, args);
        if (!r.ok) { console.error(`NO SE EMITIÓ: ${messageOf(r.code)} (${r.code})`); return done(1); }
        console.log(`${r.idempotent ? 'ALREADY ISSUED (copy checked)' : 'ISSUED'}: ${r.factura_number}  ref ${r.short_ref}  (opId ${r.op_id})`);
        return done(0);
      }
      const p = await preview(rtdb, args);
      if (!p.ok) { console.error(`NO SE EMITIÓ: ${messageOf(p.code)} (${p.code})`); return done(1); }
      console.log(`${p.restaurant} — manual factura PREVIEW (${p.fecha_hn})\n${'-'.repeat(48)}\n${p.text}\n${'-'.repeat(48)}`);
      console.log(`total ${L(p.payload.total_cents)} = base ${L(p.payload.base_cents)} + ISV 15% ${L(p.payload.isv_cents)}`);
      console.log(`DRY RUN — it WILL take ${p.factura_number} (if nothing else issues first). opId ${p.op_id}\nTo issue it, run EXACTLY (re-run the same line if anything fails):\n  ${p.apply_command}`);
      return done(0);
    }
    const op = val('--op');
    if (!op) usage('--op <opId or M- short ref> is required');
    if (cmd === 'status') {
      const s = await status(rtdb, { rid, op });
      console.log(s.found ? `${s.factura_number}  ${s.short_ref}  ${s.state}  ${L(s.total_cents)}  copy:${s.copy ? 'yes' : 'NO'}  print:${s.print}  copy_void:${s.copy_void ? 'yes' : 'no'}  (opId ${s.op_id})` : 'not found');
      return done(s.found ? 0 : 1);
    }
    const reason = val('--reason'); const by = val('--by');
    if (!reason || !by) usage('void needs --reason and --by');
    const v = await voidCmd(rtdb, { rid, op, reason, by, apply: has('--apply'), now });
    if (!v.ok) { console.error(`NO SE ANULÓ: ${messageOf(v.code)} (${v.code})`); return done(1); }
    console.log(v.dryRun ? `DRY RUN — ${v.status.factura_number} is ${v.status.state}. Re-run with --apply to void it.` : `${v.idempotent ? 'ALREADY VOIDED' : 'VOIDED'}: ${v.status.factura_number}  copy_void:yes  print:${v.status.print}${v.status.print === 'not_printed' ? '' : ' (a printed paper stays printed)'}`);
    return done(0);
  })().catch((e) => { console.error('manual-factura: ERROR', e && e.code ? e.code : 'unexpected'); done(1); });
}
