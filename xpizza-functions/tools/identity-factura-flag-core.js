'use strict';
// BRAND-AGNOSTIC SERVER B1 (PLAN-brand-agnostic-server r0 §1.2) — the core of the OWNER's projection CLI
// (tools/identity-factura-flag.js): project factura/eligibility's FACTURA_PLATFORM_RESTAURANTS onto
// restaurants/{rid}/identity/uses_platform_factura so clients (dispatch) can read the per-brand fact instead of a code literal.
// Pure over an injected RTDB handle so it is unit-testable; the CLI only adds the project guard and the argv.
//
//   • desired value per rid: `true` when usesPlatformFactura(rid), ABSENT otherwise (OWNER RULE: only X. Pizza issues facturas);
//   • only restaurants that HAVE an identity node are touched — it never creates a partial identity;
//   • ONE identity transaction per changed rid: the leaf + version + 1 (orchestration O1a ruling); a second run plans 0 rows;
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

// ORCHESTRATION O1a (advisor ruling): ONE identity transaction per changed rid — the leaf + `version` + 1 in the SAME transaction;
// the commit re-checks the leaf (already right → no write, no bump); an identity without a numeric version is refused and named.
// Null-first safe: the cached-null pass answers null, never creating an identity. → { unversioned: [rid] }
async function applyFlags(rtdb, rows) {
  const unversioned = [];
  for (const r of rows) {
    let bad = false;
    await rtdb.ref(`restaurants/${r.rid}/identity`).transaction((cur) => {
      bad = false;
      if (cur === null) return null;
      const from = cur[FLAG] === undefined ? null : cur[FLAG];
      if (from === r.to) return undefined;
      if (!Number.isFinite(cur.version)) { bad = true; return undefined; }
      const next = { ...cur, version: cur.version + 1 };
      if (r.to === null) delete next[FLAG]; else next[FLAG] = r.to;
      return next;
    });
    if (bad) unversioned.push(r.rid);
  }
  return { unversioned };
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
