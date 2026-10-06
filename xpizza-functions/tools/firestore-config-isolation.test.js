'use strict';
// ---------------------------------------------------------------------------
// INDEX ISOLATION BY CONSTRUCTION (codex stats build r7; advisor ruling 2026-10-05).
//
// xpizza-functions/firebase.json declares NO firestore "indexes", exactly as on main. The installed
// firebase-tools prepares an index operation only `if (firestoreConfig.indexes)` (lib/deploy/firestore/
// prepare.js), so NO deploy that uses firebase.json — bare, `--only firestore`, `--only firestore:indexes`,
// any flags, in any document — can touch indexes. Index deploys exist only through `npm run deploy:indexes`
// (tools/deploy-indexes.js), which points the CLI at the DEDICATED firebase.indexes.json.
//
//   (a) firebase.json's firestore block deep-equals main's (frozen golden), with no `indexes` key;
//   (b) every tracked reference to the dedicated config's filename is a reviewed pin — a new one fails;
//   (c) BEHAVIOURAL, against the INSTALLED CLI (network stubbed): prepare() over the real firebase.json
//       queues ZERO index operations for every target; over firebase.indexes.json it queues exactly the stats
//       field overrides and no rules.
//   (d) the CONFIG INVENTORY on disk + ancestors, parsed like the CLI: no other default config, tracked or not,
//       can reintroduce indexes (codex build r8, r9).
// Run: node tools/firestore-config-isolation.test.js
// ---------------------------------------------------------------------------
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { findFirebaseTools } = require('./firebase-cli-nodelete');
const { fieldOverrides } = require('../stats/stats-indexing');
let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 suite exited before finishing'); process.exit(1); } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FN = path.join(__dirname, '..');
const REPO = path.join(FN, '..');
const CONFIG_NAME = ['firebase', 'indexes', 'json'].join('.');   // spelled so this file's own pins stay countable
const SELF = 'xpizza-functions/tools/firestore-config-isolation.test.js';

// (a) THE FROZEN GOLDEN of main's (ba29282) firebase.json firestore block — the rules deploy + its three
//     predeploy hooks, exactly as live today.
const FIRESTORE_BLOCK_GOLDEN = {
  rules: 'firestore.rules',
  predeploy: [
    'npm --prefix "$RESOURCE_DIR" run test:catalog-rules',
    'npm --prefix "$RESOURCE_DIR" run test:catalog-parity',
    'npm --prefix "$RESOURCE_DIR" run test:pricing-cutover',
  ],
};

// (b) THE REVIEWED REFERENCES to the dedicated config's filename (raw line, trailing whitespace stripped).
//     This file's own occurrences are pinned by COUNT (listing them as text here would add more of them).
const REFERENCE_PINS = [
  { file: 'xpizza-functions/stats/stats-guard.test.js', text: "  const fbi = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.indexes.json'), 'utf8'));" },
  { file: 'xpizza-functions/stats/stats-guard.test.js', text: "  assert.deepStrictEqual(fbi, { firestore: { indexes: 'firestore.indexes.json' } }, 'firebase.indexes.json declares only the indexes');" },
  { file: 'xpizza-functions/stats/stats-guard.test.js', text: "  assert(/'firebase\\.indexes\\.json'/.test(rp), 'the report reads the deployed inventory path from firebase.indexes.json');" },
  { file: 'xpizza-functions/stats/stats-guard.test.js', text: '//     firebase.indexes.json (the dedicated index config) deploys it, and under the exemptions a realistic daily doc / a full shard need only a' },
  { file: 'xpizza-functions/stats/stats-guard.test.js', text: '     declares NO indexes, so only `npm run deploy:indexes` (--config firebase.indexes.json, --non-interactive,' },
  { file: 'xpizza-functions/stats/stats-guard.test.js', text: "  ok(`stats exemptions present in the whole-DB inventory; firebase.json declares no indexes, firebase.indexes.json only them; daily ${dailyExempt} / shard ${shardExempt} entries (default indexing: ${S.indexEntries(shard)})`);" },
  { file: 'xpizza-functions/tools/deploy-indexes.js', text: '//   = firebase deploy --only firestore:indexes --non-interactive --config firebase.indexes.json --project <pinned-and-checked>' },
  { file: 'xpizza-functions/tools/deploy-indexes.js', text: '// deploys exist ONLY through this wrapper, via firebase.indexes.json, which declares nothing but the indexes.' },
  { file: 'xpizza-functions/tools/deploy-indexes.js', text: "const INDEX_CONFIG = 'firebase.indexes.json';" },
  { file: 'xpizza-functions/tools/deploy-indexes.test.js', text: "  assert.deepStrictEqual(D.buildArgs('xpizza-delivery'), ['deploy', '--only', 'firestore:indexes', '--non-interactive', '--config', 'firebase.indexes.json', '--project', 'xpizza-delivery']);" },
  { file: 'xpizza-functions/tools/deploy-indexes.test.js', text: "  ok('flags pinned: deploy --only firestore:indexes --non-interactive --config firebase.indexes.json --project xpizza-delivery; no force flag; no other index-deploy script');" },
  { file: 'xpizza-functions/tools/firestore-indexes-report.js', text: '  // The SAME file the sanctioned deploy pushes: firebase.indexes.json → firestore.indexes (firebase.json' },
  { file: 'xpizza-functions/tools/firestore-indexes-report.js', text: "  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.indexes.json'), 'utf8'));" },
  { file: 'xpizza-functions/tools/firestore-indexes-report.js', text: "  if (!fb.firestore || !fb.firestore.indexes) throw new Error('firebase.indexes.json declares no firestore.indexes file');" },
];
const SELF_COUNT = 17;   // this file's own literal mentions: the 14 pin texts + 2 in its header comment + ALLOWED_CONFIGS

// (a)
{
  const fb = JSON.parse(fs.readFileSync(path.join(FN, 'firebase.json'), 'utf8'));
  assert.deepStrictEqual(fb.firestore, FIRESTORE_BLOCK_GOLDEN, '🔴 firebase.json\'s firestore block must equal main\'s exactly (rules + the 3 predeploy hooks)');
  assert(!('indexes' in fb.firestore), '🔴 firebase.json must declare NO firestore indexes');
  assert(!JSON.stringify(fb).includes('indexes'), '🔴 no `indexes` anywhere in firebase.json');
  const dedicated = JSON.parse(fs.readFileSync(path.join(FN, CONFIG_NAME), 'utf8'));
  assert.deepStrictEqual(dedicated, { firestore: { indexes: 'firestore.indexes.json' } }, 'the dedicated config declares ONLY the indexes');
  ok('firebase.json firestore block == main\'s frozen golden (rules + 3 predeploy hooks, no indexes); the dedicated config declares only the indexes');
}

// (b)
{
  let out = '';
  try { out = execFileSync('git', ['grep', '-n', '-I', '-F', CONFIG_NAME], { cwd: REPO, encoding: 'utf8' }); }
  catch (e) { if (e.status !== 1) throw e; }
  const hits = out.split('\n').filter(Boolean).map((l) => { const m = /^([^:]+):(\d+):(.*)$/.exec(l); return { file: m[1], line: +m[2], text: m[3].replace(/\s+$/, '') }; });
  // The mutant catalogue is a FIXTURE: its s1-79 entry deliberately carries an unreviewed reference.
  const CATALOGUE = 'xpizza-functions/tools/mutation-sweep.mutants.json';
  const self = hits.filter((h) => h.file === SELF);
  const others = hits.filter((h) => h.file !== SELF && h.file !== CATALOGUE);
  const key = (x) => `${x.file}\u0000${x.text}`;
  const pinned = new Set(REFERENCE_PINS.map(key));
  const fresh = others.filter((h) => !pinned.has(key(h))).map((h) => `${h.file}:${h.line}  ${h.text}`);
  const seen = new Set(others.map(key));
  const stale = REFERENCE_PINS.filter((p) => !seen.has(key(p))).map((p) => `${p.file}  ${p.text}`);
  assert.deepStrictEqual(fresh, [], `🔴 NEW references to ${CONFIG_NAME} (review, then pin in this file):\n  ${fresh.join('\n  ')}`);
  assert.deepStrictEqual(stale, [], `🔴 stale pins:\n  ${stale.join('\n  ')}`);
  assert.strictEqual(others.length, REFERENCE_PINS.length, 'each pinned line appears exactly once');
  assert.strictEqual(self.length, SELF_COUNT, `this file mentions ${CONFIG_NAME} literally ${self.length}× (pinned ${SELF_COUNT})`);
  ok(`every tracked reference to ${CONFIG_NAME} is a reviewed pin (${REFERENCE_PINS.length} lines in ${new Set(REFERENCE_PINS.map((p) => p.file)).size} files)`);
}

// (d) THE CONFIG INVENTORY (codex build r8 S1, r9 S1/S2): no OTHER default config — tracked OR NOT — can
//     reintroduce indexes. The installed CLI resolves its project root ON THE FILESYSTEM (detectProjectRoot
//     walks UP from the cwd for `firebase.json`) and parses configs with its own comment-tolerant loadCJSON,
//     so this checks exactly that:
//       • every firebase*.json ON DISK under the repo root (untracked and gitignored included; only
//         node_modules and .git skipped) must be exactly the two known files;
//       • NO ancestor directory of the repo root, up to `/`, may hold a firebase.json;
//       • parsed with the INSTALLED CLI's loadCJSON, no config but the dedicated one may hold a `firestore`
//         object (or array) with an `indexes` key — across every on-disk firebase*.json and every tracked *.json;
//       • FAIL CLOSED: an unparseable firebase*.json, or an unparseable JSON whose text mentions "firestore".
const ALLOWED_CONFIGS = ['xpizza-functions/firebase.indexes.json', 'xpizza-functions/firebase.json'];
const DEDICATED = 'xpizza-functions/' + CONFIG_NAME;
const isConfigName = (p) => /^firebase[^/]*\.json$/i.test(path.posix.basename(p));
function declaresIndexes(node) {
  let found = false;
  const walk = (o) => {
    if (!o || typeof o !== 'object' || found) return;
    if (Object.prototype.hasOwnProperty.call(o, 'firestore')) {
      const fsc = Array.isArray(o.firestore) ? o.firestore : [o.firestore];
      if (fsc.some((x) => x && typeof x === 'object' && Object.prototype.hasOwnProperty.call(x, 'indexes'))) { found = true; return; }
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(node);
  return found;
}
// Every firebase*.json on disk under `root` (relative, posix). Symlinked FILES count (the CLI follows them);
// symlinked DIRECTORIES are not descended (no loops).
function diskConfigs(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if ((e.isFile() || e.isSymbolicLink()) && isConfigName(e.name)) out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}
// Every firebase.json in an ANCESTOR of `root`, up to `/` (what detectProjectRoot would reach from above).
function ancestorConfigs(root) {
  const found = [];
  for (let d = path.dirname(path.resolve(root)); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'firebase.json'))) found.push(path.join(d, 'firebase.json'));
    if (path.dirname(d) === d) break;
  }
  return found;
}
/**
 * inventoryViolations({ root, tracked, loadCJSON }) — the whole check, over a real directory tree.
 *   tracked: repo-relative paths tracked by git (their *.json are parsed too)
 */
function inventoryViolations({ root, tracked, loadCJSON }) {
  const violations = [], skipped = [];
  const all = diskConfigs(root);
  // TRANSIENT emulator configs: tools/emulator-run.js writes `xpizza-functions/firebase.emulator.<pid>.json` for
  // the life of one emulator run (a copy of firebase.json + ports) and deletes it at exit / sweeps a dead pid's.
  // Allowed by that EXACT name only, and still parsed below — one that declares indexes fails like any other.
  const TRANSIENT = /^xpizza-functions\/firebase\.emulator\.\d+\.json$/;
  const onDisk = all.filter((p) => !TRANSIENT.test(p));
  if (JSON.stringify(onDisk) !== JSON.stringify(ALLOWED_CONFIGS)) violations.push(`firebase*.json ON DISK is ${JSON.stringify(onDisk)}, expected exactly ${JSON.stringify(ALLOWED_CONFIGS)}`);
  for (const a of ancestorConfigs(root)) violations.push(`an ANCESTOR firebase.json exists: ${a} — the CLI would honour it from any cwd above the configs`);
  const toParse = [...new Set([...all, ...tracked.filter((p) => /\.json$/i.test(p))])];
  let parsed = 0;
  for (const rel of toParse) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    let j;
    try { j = loadCJSON(abs); parsed++; }
    catch (e) {
      const text = fs.readFileSync(abs, 'latin1');
      if (isConfigName(rel)) violations.push(`${rel}: an UNPARSEABLE firebase config — fail closed (${String(e.message).split('\n').filter(Boolean).pop().slice(0, 80)})`);
      else if (/firestore/i.test(text)) violations.push(`${rel}: unparseable JSON mentioning "firestore" — fail closed`);
      else skipped.push(`${rel}: ${String(e.message).split('\n').filter(Boolean).pop().slice(0, 80)}`);
      continue;
    }
    if (rel !== DEDICATED && declaresIndexes(j)) violations.push(`${rel} declares firestore "indexes" — only ${DEDICATED} may`);
  }
  return { violations, skipped, parsed };
}
const CLI_LIB = path.join(findFirebaseTools().root, 'lib');
const { loadCJSON } = require(path.join(CLI_LIB, 'loadCJSON'));
{
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const r = inventoryViolations({ root: REPO, tracked, loadCJSON });
  assert.deepStrictEqual(r.violations, [], `🔴 config inventory:\n  ${r.violations.join('\n  ')}`);
  assert(r.parsed > 20, `premise: the JSON files were parsed with the CLI's loadCJSON (${r.parsed})`);
  if (r.skipped.length) console.log(`    (skipped unparseable JSON without "firestore", by reason: ${r.skipped.join(' | ')})`);
  ok(`config inventory ON DISK == ${JSON.stringify(ALLOWED_CONFIGS)}; no ancestor firebase.json up to /; ${r.parsed} JSON parsed with the CLI's loadCJSON, none but the dedicated config declares indexes; fail-closed on unparseable configs`);
}

// (d) REGRESSIONS on real temp directory trees (the same function, the CLI's own loadCJSON + Config.load).
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfginv-'));
  const mkRepo = (base) => {
    fs.mkdirSync(path.join(base, 'xpizza-functions'), { recursive: true });
    for (const f of ['firebase.json', CONFIG_NAME, 'firestore.rules', 'firestore.indexes.json']) fs.copyFileSync(path.join(FN, f), path.join(base, 'xpizza-functions', f));
    return base;
  };
  const check = (root, tracked = []) => inventoryViolations({ root, tracked, loadCJSON }).violations;
  try {
    // baseline: a faithful copy is clean (non-vacuity of every fixture below)
    const clean = mkRepo(path.join(tmp, 'clean', 'repo'));
    assert.deepStrictEqual(check(clean), [], 'premise: a faithful copy of the two configs passes');
    // r9 S1a: an UNTRACKED root firebase.json (on disk only — git never sees it)
    const r1 = mkRepo(path.join(tmp, 'r1', 'repo'));
    fs.writeFileSync(path.join(r1, 'firebase.json'), '{"firestore":{"indexes":"xpizza-functions/firestore.indexes.json"}}');
    assert(check(r1).some((v) => /ON DISK/.test(v)), 'an untracked root firebase.json is caught');
    // a nested, gitignored-looking one
    const r2 = mkRepo(path.join(tmp, 'r2', 'repo'));
    fs.mkdirSync(path.join(r2, 'build'), { recursive: true });
    fs.writeFileSync(path.join(r2, 'build', 'firebase.json'), '{}');
    assert(check(r2).some((v) => /ON DISK/.test(v)), 'a nested untracked firebase.json is caught');
    // r9 S1b: a firebase.json in a PARENT directory — and the REAL CLI honours it from a nested cwd
    const parent = path.join(tmp, 'parent');
    const r3 = mkRepo(path.join(parent, 'repo'));
    fs.writeFileSync(path.join(parent, 'firebase.json'), '{"firestore":{"indexes":"repo/xpizza-functions/firestore.indexes.json"}}');
    assert(check(r3).some((v) => /ANCESTOR firebase\.json exists/.test(v)), 'a parent-directory firebase.json is caught');
    const { Config } = require(path.join(CLI_LIB, 'config'));
    fs.mkdirSync(path.join(r3, 'docs'), { recursive: true });
    const seenByCli = Config.load({ cwd: path.join(r3, 'docs') });
    assert.strictEqual(seenByCli.projectDir, parent, 'premise: the real CLI, run from a nested cwd with no closer config, loads the PARENT\'s firebase.json');
    assert(seenByCli.src.firestore && seenByCli.src.firestore.indexes, 'premise: …and would see its indexes');
    // r9 S2: codex's COMMENTED deploy/settings.json (JSON.parse rejects it; the CLI's loadCJSON accepts it)
    const r4 = mkRepo(path.join(tmp, 'r4', 'repo'));
    fs.mkdirSync(path.join(r4, 'deploy'), { recursive: true });
    const commented = '{\n  // deployment settings\n  "firestore": { "indexes": "xpizza-functions/firestore.indexes.json" }\n}\n';
    fs.writeFileSync(path.join(r4, 'deploy', 'settings.json'), commented);
    assert.throws(() => JSON.parse(commented), 'premise: plain JSON.parse rejects the commented file');
    assert(check(r4, ['deploy/settings.json']).some((v) => /deploy\/settings\.json declares firestore "indexes"/.test(v)), 'the commented config is parsed like the CLI parses it — and caught');
    // FAIL CLOSED: an unparseable firebase config, and unparseable JSON mentioning firestore
    const r5 = mkRepo(path.join(tmp, 'r5', 'repo'));
    fs.writeFileSync(path.join(r5, 'xpizza-functions', 'firebase.json'), '{ "firestore": { "rules": "firestore.rules", ');
    assert(check(r5).some((v) => /UNPARSEABLE firebase config — fail closed/.test(v)), 'an unparseable firebase.json fails closed');
    const r6 = mkRepo(path.join(tmp, 'r6', 'repo'));
    fs.writeFileSync(path.join(r6, 'notes.json'), '{ "firestore": { indexes: ');
    assert(check(r6, ['notes.json']).some((v) => /unparseable JSON mentioning "firestore" — fail closed/.test(v)), 'unparseable JSON mentioning firestore fails closed');
    const r7 = mkRepo(path.join(tmp, 'r7', 'repo'));
    fs.writeFileSync(path.join(r7, 'junk.json'), '{ not json');
    assert.deepStrictEqual(check(r7, ['junk.json']), [], 'unparseable JSON with no firestore mention is skipped (reported), not failed');
    // a live emulator run's transient config is allowed by its exact name — but still checked for indexes
    const r8 = mkRepo(path.join(tmp, 'r8', 'repo'));
    fs.copyFileSync(path.join(r8, 'xpizza-functions', 'firebase.json'), path.join(r8, 'xpizza-functions', 'firebase.emulator.4242.json'));
    assert.deepStrictEqual(check(r8), [], 'a transient emulator config (exact name, no indexes) is allowed');
    fs.writeFileSync(path.join(r8, 'xpizza-functions', 'firebase.emulator.4242.json'), '{"firestore":{"indexes":"firestore.indexes.json"}}');
    assert(check(r8).some((v) => /firebase\.emulator\.4242\.json declares firestore "indexes"/.test(v)), '…and fails if it declares indexes');
    fs.writeFileSync(path.join(r8, 'xpizza-functions', 'firebase.emulator.json'), '{}');
    assert(check(r8).some((v) => /ON DISK/.test(v)), 'a look-alike without the pid is NOT the transient name');
    ok('regressions: untracked root, nested untracked, PARENT-dir (the real CLI honours it), commented settings (CLI loadCJSON), unparseable firebase config + firestore JSON fail closed; transient emulator config allowed by exact name, still checked');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// (c) BEHAVIOURAL — the INSTALLED CLI's own Config.load + firestore prepare(), network stubbed.
(async () => {
  const R = path.join(findFirebaseTools().root, 'lib');
  const ens = require(path.join(R, 'ensureApiEnabled'));
  const { FirestoreApi } = require(path.join(R, 'firestore', 'api'));
  const { RulesDeploy } = require(path.join(R, 'rulesDeploy'));
  const prepare = require(path.join(R, 'deploy', 'firestore', 'prepare')).default;
  const { Config } = require(path.join(R, 'config'));
  const keep = { ensure: ens.ensure, getDatabase: FirestoreApi.prototype.getDatabase, compile: RulesDeploy.prototype.compile };
  ens.ensure = async () => {}; FirestoreApi.prototype.getDatabase = async () => ({}); RulesDeploy.prototype.compile = async () => {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsiso-'));
  for (const f of ['firebase.json', CONFIG_NAME, 'firestore.rules', 'firestore.indexes.json']) fs.copyFileSync(path.join(FN, f), path.join(dir, f));   // the REAL tracked files
  const quiet = () => { const k = [console.log, console.info, process.stdout.write]; console.log = console.info = () => {}; process.stdout.write = () => true; return () => { [console.log, console.info, process.stdout.write] = k; }; };
  const run = async (configPath, only) => {
    const config = Config.load({ cwd: dir, configPath });
    const ctx = { projectId: 'probe' };
    const r = quiet();
    try { await prepare(ctx, { config, only, projectId: 'probe', project: 'probe', rc: {} }); } finally { r(); }
    return { indexes: (ctx.firestore && ctx.firestore.indexes) || [], rules: (ctx.firestore && ctx.firestore.rules) || [] };
  };
  try {
    for (const only of [undefined, 'firestore', 'firestore:indexes', 'firestore:rules', 'functions,firestore']) {
      const r = await run('firebase.json', only);
      assert.deepStrictEqual(r.indexes, [], `🔴 firebase.json with ${only === undefined ? 'a bare deploy' : `--only ${only}`} prepared an INDEX operation`);
    }
    const r = await run(CONFIG_NAME, 'firestore:indexes');
    assert.strictEqual(r.indexes.length, 1, 'the dedicated config prepares ONE index set');
    assert.deepStrictEqual(r.indexes[0].indexesRawSpec.fieldOverrides, fieldOverrides(), 'exactly the stats field overrides');
    assert.deepStrictEqual(r.indexes[0].indexesRawSpec.indexes, [], 'no composite indexes');
    assert.deepStrictEqual(r.rules, [], 'the dedicated config prepares NO rules');
    // non-vacuity: the same prepare() DOES queue indexes when a config declares them
    const withIdx = JSON.parse(fs.readFileSync(path.join(dir, 'firebase.json'), 'utf8')); withIdx.firestore.indexes = 'firestore.indexes.json';
    fs.writeFileSync(path.join(dir, 'firebase.json'), JSON.stringify(withIdx));
    assert.strictEqual((await run('firebase.json', 'firestore')).indexes.length, 1, 'non-vacuity: a firebase.json WITH indexes would queue them');
    ok(`installed firebase-tools ${findFirebaseTools().version}: firebase.json prepares 0 index ops (bare / firestore / firestore:indexes / rules / functions,firestore); the dedicated config prepares exactly the ${fieldOverrides().length} stats overrides and no rules`);
  } finally {
    Object.assign(ens, { ensure: keep.ensure }); FirestoreApi.prototype.getDatabase = keep.getDatabase; RulesDeploy.prototype.compile = keep.compile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nfirestore-config-isolation: ${n} cells passed`);
  __finished = true;
})().catch((e) => { console.error(e); process.exit(1); });
