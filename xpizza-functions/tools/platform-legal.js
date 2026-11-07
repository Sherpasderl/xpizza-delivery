#!/usr/bin/env node
'use strict';
// PLAN-guest-checkout-server §3.3 (S3c) — Sherpa's OWN legal documents for the customer app's signup scope (context:'platform'):
// platform_config/legal = { terms_url, privacy_url, terms_version, privacy_version, promos_copy_version } — the SAME 5-field shape as
// restaurants/{rid}/legal (signup-core.js legalFor). OWNER / OPS-RUN; DRY RUN unless --apply; no setup UI (advisor ruling).
//
//   node tools/platform-legal.js --project xpizza-delivery --show
//   node tools/platform-legal.js --project xpizza-delivery --terms-url https://… --privacy-url https://… \
//        --terms-version 2026-11 --privacy-version 2026-11 --promos-copy-version 2026-11 [--apply]
//
// Until this node exists, every platform signup surface answers legal_unconfigured / legal_ready:false (fail-closed). A version
// change is what re-asks consent (consent/_platform records the versions it accepted). The write is ONE transaction that only
// ever replaces the whole node with a validated value.
const FIELDS = Object.freeze(['terms_url', 'privacy_url', 'terms_version', 'privacy_version', 'promos_copy_version']);
const LEGAL_PATH = 'platform_config/legal';
const VERSION_RE = /^[A-Za-z0-9._-]{1,40}$/;
const isHttpsUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && !!x.hostname && x.href === u; } catch (_) { return false; } };

// → { ok, value } | { ok:false, problems:[…] } — pure
function validate(input) {
  const v = input || {};
  const problems = [];
  for (const k of ['terms_url', 'privacy_url']) if (!isHttpsUrl(v[k])) problems.push(`${k} must be an exact https URL`);
  for (const k of ['terms_version', 'privacy_version', 'promos_copy_version']) if (typeof v[k] !== 'string' || !VERSION_RE.test(v[k])) problems.push(`${k} must match ${VERSION_RE}`);
  for (const k of Object.keys(v)) if (!FIELDS.includes(k)) problems.push(`unknown field ${k}`);
  return problems.length ? { ok: false, problems } : { ok: true, value: Object.fromEntries(FIELDS.map((k) => [k, v[k]])) };
}
// what an --apply would change, field by field (null = absent today)
function diff(current, next) {
  const cur = current && typeof current === 'object' ? current : {};
  return FIELDS.filter((k) => cur[k] !== next[k]).map((k) => ({ field: k, from: cur[k] === undefined ? null : cur[k], to: next[k] }));
}

async function show({ rtdb }) {
  return (await rtdb.ref(LEGAL_PATH).get()).val();
}
async function setLegal({ rtdb, input, apply = false }) {
  const r = validate(input);
  if (!r.ok) return { ok: false, refused: r.problems.join('; ') };
  const before = (await rtdb.ref(LEGAL_PATH).get()).val();
  const changes = diff(before, r.value);
  if (!apply) return { ok: true, dryRun: true, changes };
  if (!changes.length) return { ok: true, unchanged: true, changes };
  // the SDK's first run may see its unloaded cache as null — the value is the same either way, so the server simply compares
  const tx = await rtdb.ref(LEGAL_PATH).transaction(() => r.value);
  return { ok: !!(tx && tx.committed), changes };
}

module.exports = { FIELDS, LEGAL_PATH, validate, diff, show, setLegal };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const { requireProject } = require('./require-project');
  const PROJECT_ID = requireProject({ requireFlag: true });
  const admin = require('firebase-admin');
  const { RTDB_URL } = require('../catalog/mirror-rtdb');
  admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
  const rtdb = admin.database();
  (async () => {
    if (argv.includes('--show')) { console.log(JSON.stringify(await show({ rtdb }), null, 2)); process.exit(0); }
    const input = Object.fromEntries(FIELDS.map((k) => [k, val(`--${k.replace(/_/g, '-')}`)]));
    const r = await setLegal({ rtdb, input, apply: argv.includes('--apply') });
    if (r.refused) { console.error(`platform-legal: REFUSED — ${r.refused}`); process.exit(2); }
    for (const c of r.changes) console.log(`  ${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
    if (r.dryRun) { console.log(`DRY RUN — ${r.changes.length} field(s) would change at ${LEGAL_PATH} (add --apply)`); process.exit(0); }
    console.log(r.unchanged ? 'unchanged — nothing written' : (r.ok ? `written: ${LEGAL_PATH}` : 'NOT written (transaction aborted)'));
    process.exit(r.ok ? 0 : 1);
  })().catch((e) => { console.error('platform-legal: FAILED —', e && e.message); process.exit(1); });
}
