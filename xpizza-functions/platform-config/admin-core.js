'use strict';
// CONVERGENCE §1 — the owner CLI's testable core (tools/platform-config-admin.js). DRY RUN unless --apply. Names + states only.
//   seed     <rid>  BREAK-GLASS (plan §0): the founding restaurant's legacy fields → the portal source, ONLY if NO source exists
//                   (an existing source is REFUSED — never an overwrite; a non-founding rid has no legacy seed ⇒ refused)
//   generate <rid>  portal source → projection (the generator; dry run = the drift state it would resolve)
//   drift    <rid>|--all   read-only drift states
// ARGUMENTS ARE STRICT (the record-evidence-boundary `--rid=` lesson): `--rid <id>` in the SPACE form only; `--rid=…`, a missing rid,
// an unknown flag or a second subcommand ⇒ exit 2 — never a silent fan-out across restaurants. `--all` is accepted by drift only.
const SRC = require('./source');
const G = require('./generate');
const D = require('./drift');
const L = require('./legacy-seed');

const SUBS = new Set(['seed', 'generate', 'drift']);
function parseArgs(argv) {
  const a = argv.slice();
  const refuse = (why) => ({ ok: false, why });
  const sub = a.shift();
  if (!SUBS.has(sub)) return refuse('usage: <seed|generate|drift> --project <id> (--rid <rid> | --all) [--apply]');
  const out = { sub, rid: null, all: false, apply: false };
  while (a.length) {
    const t = a.shift();
    if (t === '--apply') out.apply = true;
    else if (t === '--all') out.all = true;
    else if (t === '--project') { if (!a.length || a[0].startsWith('--')) return refuse('--project needs a value'); a.shift(); }
    else if (t === '--rid') { if (!a.length || a[0].startsWith('--')) return refuse('--rid needs a value'); out.rid = a.shift(); }
    else if (t.startsWith('--rid=') || t.startsWith('--project=')) return refuse(`use the space form, not ${t.split('=')[0]}=…`);
    else return refuse(`unknown argument ${t}`);
  }
  if (out.all && (out.sub !== 'drift' || out.rid)) return refuse('--all is drift-only and excludes --rid');
  if (!out.all && (!out.rid || !SRC.RID_RE.test(out.rid))) return refuse('--rid <rid> is required');
  if (out.sub === 'drift' && out.apply) return refuse('drift is read-only');
  return { ok: true, ...out };
}

async function seed({ fs, apply, now }, rid) {
  const fields = L.legacyFieldsFor(rid);
  if (!fields) return { rid, state: 'refused_no_legacy_seed' };
  if (await SRC.readPlatformSource(fs, rid).catch(() => 'invalid')) return { rid, state: 'refused_source_exists' };
  if (!apply) return { rid, state: 'would_seed' };
  const r = await SRC.writePlatformSource(fs, rid, fields, { expectedVersion: null, by: 'break-glass:seed', now });
  return { rid, state: 'seeded', version: r.version };
}
async function generate({ fs, db, apply, now }, rid) {
  if (!apply) return { rid, state: (await D.checkDrift({ fs, db }, rid)).state };
  const r = await G.generatePlatformConfig({ fs, db, now }, rid);
  return { rid, state: r.outcome, ...(r.source_version ? { source_version: r.source_version } : {}) };
}

module.exports = { parseArgs, seed, generate };
