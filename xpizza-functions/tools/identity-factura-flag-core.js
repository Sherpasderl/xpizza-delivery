'use strict';
// BRAND-AGNOSTIC SERVER B1 (PLAN-brand-agnostic-server r0 §1.2) — the core of the OWNER's projection CLI
// (tools/identity-factura-flag.js): project factura/eligibility's FACTURA_PLATFORM_RESTAURANTS onto
// restaurants/{rid}/identity/uses_platform_factura so clients (dispatch) can read the per-brand fact instead of a code literal.
// Pure over an injected RTDB handle so it is unit-testable; the CLI only adds the project guard and the argv.
//
//   • desired value per rid: `true` when usesPlatformFactura(rid), ABSENT otherwise (OWNER RULE: only X. Pizza issues facturas);
//   • only restaurants that HAVE an identity node are touched — it never creates a partial identity;
//   • ONE multi-path update of the single leaf per changed rid (never a node replacement); a second run plans 0 rows;
//   • the read-back re-reads every identity and fails unless every platform restaurant reads `true` and every other reads absent.
const { usesPlatformFactura, FACTURA_PLATFORM_RESTAURANTS } = require('../factura/eligibility');

const FLAG = 'uses_platform_factura';
const pathOf = (rid) => `restaurants/${rid}/identity/${FLAG}`;
const desired = (rid) => (usesPlatformFactura(rid) ? true : null);

// → { rid: identity | null } for every rid (the identity node is small: names, hub, hours, flags)
async function readIdentities(rtdb, rids) {
  const out = {};
  for (const rid of rids) out[rid] = (await rtdb.ref(`restaurants/${rid}/identity`).once('value')).val();
  return out;
}

// → { rows: [{ rid, path, from, to }], missing: [rid] } — `missing` = a platform-factura rid with no identity node
function planFlags(identities) {
  const rows = []; const missing = [];
  for (const rid of Object.keys(identities).sort()) {
    const ident = identities[rid];
    if (!ident || typeof ident !== 'object') { if (desired(rid) === true) missing.push(rid); continue; }
    const from = ident[FLAG] === undefined ? null : ident[FLAG];
    const to = desired(rid);
    if (from !== to) rows.push({ rid, path: pathOf(rid), from, to });
  }
  for (const rid of [...FACTURA_PLATFORM_RESTAURANTS].sort()) if (!(rid in identities) && !missing.includes(rid)) missing.push(rid);
  return { rows, missing };
}

async function applyFlags(rtdb, rows) {
  if (rows.length) await rtdb.ref().update(Object.fromEntries(rows.map((r) => [r.path, r.to])));
}

// → [problem strings]; empty = every identity carries exactly the projected value
async function readBack(rtdb, rids) {
  const back = await readIdentities(rtdb, rids);
  const { rows, missing } = planFlags(back);
  return [
    ...missing.map((rid) => `${rid}: platform-factura restaurant has no identity node (flag cannot be projected)`),
    ...rows.map((r) => `${r.rid}: ${FLAG} reads ${JSON.stringify(r.from)}, expected ${r.to === null ? 'ABSENT' : JSON.stringify(r.to)}`),
  ];
}

module.exports = { FLAG, pathOf, desired, readIdentities, planFlags, applyFlags, readBack };
