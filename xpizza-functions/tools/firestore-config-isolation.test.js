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
const SELF_COUNT = 16;   // this file's own literal mentions: the 14 pin texts + 2 in its header comment

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
