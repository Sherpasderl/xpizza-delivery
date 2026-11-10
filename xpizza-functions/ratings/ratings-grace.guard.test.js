'use strict';
// S-A1 r4 (Codex r3 P1-1) — the rating-redaction GRACE is sized from the HARD ceiling. Cloud Run's request timeout does not cancel
// execution, so a writer's "deadline" is not a bound; the only ceiling is each writer's configured timeoutSeconds. This guard reads
// the DEPLOYED options of EVERY ratings_v2 writer from the REAL discovery manifest (firebase-functions' loadStack, in a child process
// with the egress guard — the otp-salt-secret / drvc-secrets method) and requires REDACT_GRACE_MS ≥ 2× the largest. Raising a
// writer's timeout past grace / 2 turns this RED. A NEW ratings_v2 writer must be added to WRITERS (ratings-reader-contract lists them).
// Run: node ratings/ratings-grace.guard.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FN = path.join(__dirname, '..');
// r5 (Codex r4 #2): the writer list is DERIVED, never hand-listed — every exported function whose code reaches rating-v2.js
const { execFileSync } = require('child_process');
const acorn = require('acorn');
function derivedWriters() {
  const files = execFileSync('git', ['ls-files', '--', '.'], { cwd: FN, encoding: 'utf8' }).split('\n')
    .filter((f) => /\.(js|cjs|mjs)$/.test(f) && !/(^|\/)node_modules\//.test(f) && !/\.test\.(js|cjs|mjs)$/.test(f) && !/^test\//.test(f));
  const has = new Set(files);
  const resolve = (from, spec) => { const b = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)); for (const c of [b, `${b}.js`, `${b}/index.js`]) if (has.has(c)) return c; return null; };
  const REQ = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  const deps = new Map(files.map((f) => [f, [...fs.readFileSync(path.join(FN, f), 'utf8').matchAll(REQ)].map((m) => resolve(f, m[1])).filter(Boolean)]));
  // modules that transitively reach rating-v2.js (lazy requires included — they are textual require() calls)
  const reach = new Set(['ratings/rating-v2.js']);
  for (let grew = true; grew;) { grew = false; for (const [f, ds] of deps) if (!reach.has(f) && ds.some((d) => reach.has(d))) { reach.add(f); grew = true; } }
  const src = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  const walkIds = (nd, out = new Set()) => { if (!nd || typeof nd !== 'object') return out; if (Array.isArray(nd)) { nd.forEach((x) => walkIds(x, out)); return out; }
    if (nd.type === 'Identifier') out.add(nd.name);
    if (nd.type === 'CallExpression' && nd.callee && nd.callee.name === 'require' && nd.arguments[0] && typeof nd.arguments[0].value === 'string') { const r = resolve('index.js', nd.arguments[0].value); if (r && reach.has(r)) out.add('\u0000REACH'); }
    for (const [k, v] of Object.entries(nd)) if (k !== 'type' && v && typeof v === 'object') walkIds(v, out); return out; };
  const I = new Set(['\u0000REACH']);
  const namesOf = (id) => (id.type === 'Identifier' ? [id.name] : id.type === 'ObjectPattern' ? id.properties.map((p) => p.value && p.value.name).filter(Boolean) : []);
  for (let grew = true; grew;) {
    grew = false;
    for (const st of ast.body) {
      const decl = st.type === 'VariableDeclaration' ? st.declarations.map((d) => [namesOf(d.id), d.init]) : st.type === 'FunctionDeclaration' ? [[[st.id.name], st.body]] : [];
      for (const [names, init] of decl) { if (!init || names.every((x) => I.has(x))) continue; const used = walkIds(init); if ([...used].some((x) => I.has(x))) { names.forEach((x) => I.add(x)); grew = true; } }
    }
  }
  const writers = new Set();
  for (const st of ast.body) {
    const e = st.type === 'ExpressionStatement' ? st.expression : null;
    if (!e || e.type !== 'AssignmentExpression' || e.left.type !== 'MemberExpression') continue;
    const obj = e.left.object; const isExp = (obj.type === 'Identifier' && obj.name === 'exports') || (obj.type === 'MemberExpression' && obj.object.name === 'module' && obj.property.name === 'exports');
    if (!isExp || e.left.computed) continue;
    if ([...walkIds(e.right)].some((x) => I.has(x))) writers.add(e.left.property.name);
  }
  return [...writers].sort();
}
const WRITERS = derivedWriters();
const DEFAULT_TIMEOUT_S = 60;   // the 2nd-gen default when a function declares none
const { REDACT_GRACE_FLOOR_MS: REDACT_GRACE_MS, REDACT_RETAIN_MS } = require(path.join(FN, 'signup-endpoints'));

const env = { ...process.env };
require(path.join(FN, 'tools', 'secret-env')).scrub(env);
for (const v of ['FUNCTION_TARGET', 'PORT', 'K_SERVICE']) delete env[v];
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ratings-grace-'));
const manifestPath = path.join(out, 'manifest.json');
Object.assign(env, { GCLOUD_PROJECT: 'demo-xpizza-grace', FUNCTIONS_MANIFEST_OUTPUT_PATH: manifestPath });
const bin = path.join(FN, 'node_modules', 'firebase-functions', 'lib', 'bin', 'firebase-functions.js');
const r = spawnSync(process.execPath, ['-r', path.join(FN, 'tools', 'egress-guard.js'), bin, FN], { cwd: FN, env, encoding: 'utf8', timeout: 120000 });
assert.strictEqual(r.status, 0, `GRACE-LOAD the codebase did not load (status ${r.status}):\n${String(r.stderr).slice(-1500)}`);
const endpoints = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).endpoints || {};
fs.rmSync(out, { recursive: true, force: true });
ok(`the deployed options come from the real discovery manifest (${Object.keys(endpoints).length} endpoints)`);

for (const must of ['rateOrder', 'stampRatingFulfilment', 'deleteAccount', 'pruneInactiveAccounts', 'drainRatingRedactions']) assert.ok(WRITERS.includes(must), `🔴 premise: the DERIVED writer list includes ${must} (got ${WRITERS.join(', ')})`);
const tOf = (w) => (Number.isInteger(endpoints[w].timeoutSeconds) ? endpoints[w].timeoutSeconds : DEFAULT_TIMEOUT_S);
for (const w of WRITERS) {
  assert.ok(endpoints[w], `premise: ${w} is deployed`);
  assert.ok(REDACT_GRACE_MS >= 2 * tOf(w) * 1000, `🔴 GRACE-CEILING the floor ${REDACT_GRACE_MS} ms < 2 × ${w}'s timeout ${tOf(w)} s — raise the floor or lower the writer's timeout`);
}
assert.ok(REDACT_RETAIN_MS >= REDACT_GRACE_MS, 'retention ≥ the sanity floor');
const max = Math.max(...WRITERS.map(tOf));
ok(`the DERIVED writer list (${WRITERS.length}: every export whose code reaches rating-v2.js — incl. rateOrder, stampRatingFulfilment, deleteAccount, pruneInactiveAccounts, drainRatingRedactions): the sanity floor (${REDACT_GRACE_MS / 60000} min) ≥ 2 × each timeout (max ${max} s); retention ${REDACT_RETAIN_MS / 86400000} d ≥ the floor`);

assert.ok(endpoints.drainRatingRedactions && endpoints.drainRatingRedactions.scheduleTrigger, '🔴 the drain has its own scheduled function');
ok('the drain is its own scheduled function (drainRatingRedactions)');

console.log(`ratings-grace.guard: OK (${n})`);
