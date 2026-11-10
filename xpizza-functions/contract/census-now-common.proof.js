'use strict';
// Reproducible proof for write-provenance's COMMON 'now' (advisor ruling 2026-11-07, condition 2): runs the TARGET checkout's
// census() twice in separate child processes — once with write-provenance as-is plus 'now' in COMMON, once with 'now' removed —
// and compares EVERY result key (units compared by file list). Prints wall time + peak RSS of each run.
// Usage: node contract/census-now-common.proof.js [<xpizza-functions dir of the checkout to prove>]   (default: this checkout)
// Exit 0 = byte-identical; 1 = different; 2 = a run failed (e.g. out of memory — the "without" run may not finish on a big tree).
const { spawnSync } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const SRC = fs.readFileSync(path.join(DIR, 'contract', 'write-provenance.js'), 'utf8');
const ANCHOR = 'const COMMON = new Set([...WRITE_METHODS, ';
if (SRC.split(ANCHOR).length !== 2) { console.error('proof: COMMON anchor not found exactly once'); process.exit(2); }
const withNow = SRC.includes(`${ANCHOR}'now', `) ? SRC : SRC.replace(ANCHOR, `${ANCHOR}'now', `);
const withoutNow = withNow.replace(`${ANCHOR}'now', `, ANCHOR);
const tmp = fs.mkdtempSync(path.join(process.env.CENSUS_PROOF_TMP || os.tmpdir(), 'nowproof-'));
const runner = `
const Module = require('module'); const fs = require('fs'); const path = require('path');
const [dir, variant, out] = process.argv.slice(2);
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...r) { if (req === './write-provenance' && parent && parent.filename && parent.filename.startsWith(path.join(dir, 'contract'))) return variant; return orig.call(this, req, parent, ...r); };
const t0 = Date.now(); const res = require(path.join(dir, 'contract', 'census.js')).census();
const body = {}; for (const [k, v] of Object.entries(res)) body[k] = k === 'units' ? (Array.isArray(v) ? v.map((u) => u.file) : v) : v;
fs.writeFileSync(out, JSON.stringify(body, (k, v) => (k === 'node' || k === 'ast' ? undefined : v)));
fs.writeFileSync(out + '.ms', String(Date.now() - t0));`;
fs.writeFileSync(path.join(tmp, 'run.js'), runner);
const variants = { with_now: withNow, without_now: withoutNow };
const results = {};
for (const [name, src] of Object.entries(variants)) {
  const vf = path.join(DIR, 'contract', `_wp_${name}.tmp.js`);   // beside the original so its relative requires resolve
  fs.writeFileSync(vf, src);
  const out = path.join(tmp, `${name}.json`);
  const r = spawnSync('/usr/bin/time', ['-l', process.execPath, path.join(tmp, 'run.js'), DIR, vf, out], { encoding: 'utf8', maxBuffer: 1 << 26 });
  fs.rmSync(vf, { force: true });
  const rss = (/(\d+)\s+maximum resident set size/.exec(r.stderr || '') || [])[1];
  results[name] = { ok: r.status === 0 && fs.existsSync(out), ms: fs.existsSync(`${out}.ms`) ? Number(fs.readFileSync(`${out}.ms`, 'utf8')) : null, rssMiB: rss ? Math.round(Number(rss) / 1048576) : null, out };
  console.log(`${name}: ${results[name].ok ? 'ok' : `FAILED (exit ${r.status})`} ${results[name].ms == null ? '' : `${(results[name].ms / 1000).toFixed(1)} s`} peak ${results[name].rssMiB} MiB`);
}
if (!results.with_now.ok || !results.without_now.ok) { fs.rmSync(tmp, { recursive: true, force: true }); process.exit(2); }
const a = fs.readFileSync(results.with_now.out); const b = fs.readFileSync(results.without_now.out);
const same = Buffer.compare(a, b) === 0;
console.log(same ? `IDENTICAL census output (${a.length} bytes, every key)` : 'DIFFERENT census output');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(same ? 0 : 1);
