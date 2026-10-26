'use strict';
// DEPLOY DOTENV GUARD (owner ruling 2026-10-26 — C's 6 keys are Secret Manager secrets bound to notifyArrivedOnTap): ANY
// functions dotenv file present at deploy blocks the deploy, names only the FILE, never reads or prints a value; the guard is
// a functions predeploy hook right after deploy-env-guard. Run: node tools/deploy-dotenv-guard.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('./deploy-dotenv-guard');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FN = path.join(__dirname, '..');
const tree = (files, fb = { functions: [{ source: '.' }] }) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-dotenv-'));
  fs.writeFileSync(path.join(d, 'firebase.json'), JSON.stringify(fb));
  for (const [k, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, k)), { recursive: true }); fs.writeFileSync(path.join(d, k), v); }
  return d;
};

// 1. the clean shapes: no dotenv / only the committed .env.example → no finding
assert.deepStrictEqual(G.dotenvFiles(tree({})), [], 'DOTENV-CLEAN an empty functions dir has no finding');
assert.deepStrictEqual(G.dotenvFiles(tree({ '.env.example': 'MAKE_SECRET=\n' })), [], 'DOTENV-EXAMPLE the committed .env.example is not a deploy dotenv');
ok('clean: no dotenv file, or only the committed .env.example → nothing to block');

// 2. every dotenv the CLI could load (and .env.local) is found by NAME, across every functions source
for (const f of ['.env', '.env.xpizza-delivery', '.env.default', '.env.local', '.env.anything']) {
  assert.deepStrictEqual(G.dotenvFiles(tree({ [f]: 'MAKE_SECRET=tb-value\n' })), [f], `DOTENV-FIND ${f} is a blocking dotenv file`);
}
// codex r1 P2 — the nested-config repro: $RESOURCE_DIR holds a .env AND a firebase.json whose functions source points ELSEWHERE.
// RESOURCE_DIR IS the source being deployed, so its own files are what count; its firebase.json is never consulted.
const nested = tree({ '.env': 'X=1\n', 'nested/index.js': '' }, { functions: [{ source: 'nested' }] });
assert.deepStrictEqual(G.dotenvFiles(nested), ['.env'], 'DOTENV-NESTED 🔴 a .env in RESOURCE_DIR was missed (the guard followed a firebase.json elsewhere)');
const noFb = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-dotenv-nofb-')); fs.writeFileSync(path.join(noFb, '.env.local'), 'Y=1\n');
assert.deepStrictEqual(G.dotenvFiles(noFb), ['.env.local'], 'DOTENV-NOFB a source dir with no firebase.json is scanned too');
assert.deepStrictEqual(G.dotenvFiles(tree({ '.envrc': 'x\n', 'env.txt': 'x\n', '.env.example.bak': 'x\n' })), ['.env.example.bak'], 'DOTENV-SHAPE only .env / .env.<x> names (a .env.example COPY still blocks)');
ok('.env, .env.<project>, .env.<alias>, .env.local, .env.<x> are each found by name in the deployed source dir ITSELF (a nested firebase.json pointing elsewhere is ignored); .envrc / env.txt are not dotenv');

// 3. main(): blocks with the overlap message, names the FILE only — never a value
{
  const d = tree({ '.env': 'MAKE_SECRET=tb-super-secret-value\n' });
  const lines = []; const rc = G.main({ argv: ['node', 'g', '--root', d], env: {}, out: (m) => lines.push(m), err: (m) => lines.push(m) });
  const text = lines.join('\n');
  assert.strictEqual(rc, 1, 'DOTENV-BLOCK a present .env blocks the deploy (exit 1)');
  assert.match(text, /\.env\b/, 'it names the file');
  assert.match(text, /notifyArrivedOnTap/, 'it names the bound function');
  assert.match(text, /secret/i, 'it names the overlap risk (plain env + secret env under one name)');
  assert.ok(!/tb-super-secret-value/.test(text), 'DOTENV-NOVALUE 🔴 the guard printed a VALUE');
  const clean = []; assert.strictEqual(G.main({ argv: ['node', 'g', '--root', tree({})], env: {}, out: (m) => clean.push(m), err: (m) => clean.push(m) }), 0, 'DOTENV-PASS no dotenv → exit 0');
  assert.match(clean.join('\n'), /deploy-dotenv-guard: OK/, 'the pass line says OK');
  // fail closed: the deployed dir unknown / unset / empty / missing / not a directory → exit 1 (never "nothing found")
  const quiet = { out: () => {}, err: () => {} };
  const aFile = path.join(tree({}), 'firebase.json');
  for (const [why, argv, env] of [
    ['no --root and no RESOURCE_DIR', ['node', 'g'], {}],
    ['--root with no value', ['node', 'g', '--root'], {}],
    ['--root "" (an unset $RESOURCE_DIR in the hook)', ['node', 'g', '--root', ''], {}],
    ['--root a missing path', ['node', 'g', '--root', path.join(os.tmpdir(), 'tb-dotenv-no-such-dir-xyz')], {}],
    ['--root a FILE', ['node', 'g', '--root', aFile], {}],
    ['RESOURCE_DIR="" and no --root', ['node', 'g'], { RESOURCE_DIR: '' }],
  ]) assert.strictEqual(G.main({ argv, env, ...quiet }), 1, `DOTENV-FAILCLOSED ${why} must block`);
  assert.strictEqual(G.main({ argv: ['node', 'g'], env: { RESOURCE_DIR: tree({}) }, ...quiet }), 0, 'RESOURCE_DIR alone (a clean dir) is the deployed dir');
  assert.strictEqual(G.main({ argv: ['node', 'g'], env: { RESOURCE_DIR: tree({ '.env': 'X=1\n' }) }, ...quiet }), 1, 'RESOURCE_DIR alone (with a .env) blocks');
  ok('main(): a dotenv file → exit 1 naming the file, notifyArrivedOnTap and the secret overlap, never the value; none → exit 0; the deployed dir unset / empty / missing / a file → exit 1');
}

// 4. ENFORCED: a functions predeploy hook, right after deploy-env-guard, run exactly as firebase-tools runs it
{
  const fb = JSON.parse(fs.readFileSync(path.join(FN, 'firebase.json'), 'utf8'));
  const hooks = [].concat(fb.functions[0].predeploy || []);
  assert.ok(/deploy-env-guard\.js/.test(hooks[0]), 'premise: deploy-env-guard stays the FIRST hook');
  assert.strictEqual(hooks[1], 'node "$RESOURCE_DIR/tools/deploy-dotenv-guard.js" --root "$RESOURCE_DIR"', 'DOTENV-HOOK 🔴 the dotenv guard is not the second functions predeploy hook');
  const ft = '/usr/local/lib/node_modules/firebase-tools';
  if (fs.existsSync(ft)) {
    const crossEnv = path.resolve(require.resolve('cross-env', { paths: [ft] }), '..', 'bin', 'cross-env-shell.js');
    const runHook = (resourceDir) => spawnSync(`"${process.execPath}" "${crossEnv}" "${hooks[1].replace(/"/g, '\\"')}"`, [],
      { shell: true, encoding: 'utf8', cwd: FN, env: { ...process.env, RESOURCE_DIR: resourceDir, PROJECT_DIR: resourceDir, GCLOUD_PROJECT: 'proj-x' } });
    const withGuard = (files) => { const d = tree(files); fs.mkdirSync(path.join(d, 'tools')); fs.copyFileSync(path.join(__dirname, 'deploy-dotenv-guard.js'), path.join(d, 'tools', 'deploy-dotenv-guard.js')); return d; };
    const clean = runHook(withGuard({ '.env.example': 'MAKE_SECRET=\n' }));
    assert.strictEqual(clean.status, 0, `DOTENV-HOOK-CLEAN the hook failed on a dotenv-free tree: ${clean.stdout}${clean.stderr}`);
    const planted = runHook(withGuard({ '.env.xpizza-delivery': 'ULTRAMSG_TOKEN=tb-super-secret-value\n' }));
    assert.notStrictEqual(planted.status, 0, 'DOTENV-HOOK-BLOCK 🔴 the predeploy hook PASSED with a planted dotenv — the deploy would proceed');
    assert.match(planted.stderr, /\.env\.xpizza-delivery/, 'it fails loud, naming the file');
    assert.ok(!/tb-super-secret-value/.test(planted.stdout + planted.stderr), 'DOTENV-HOOK-NOVALUE 🔴 the hook printed a VALUE');
    // the nested-config repro through the real hook: PROJECT_DIR ≠ RESOURCE_DIR, RESOURCE_DIR = the nested functions source
    const proj = tree({}, { functions: [{ source: 'functions' }] });
    const res = path.join(proj, 'functions'); fs.mkdirSync(path.join(res, 'tools'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'deploy-dotenv-guard.js'), path.join(res, 'tools', 'deploy-dotenv-guard.js'));
    fs.writeFileSync(path.join(res, 'firebase.json'), JSON.stringify({ functions: [{ source: 'elsewhere' }] }));
    fs.mkdirSync(path.join(res, 'elsewhere'));
    fs.writeFileSync(path.join(res, '.env'), 'MAKE_SECRET=tb-super-secret-value\n');
    const nestedRun = spawnSync(`"${process.execPath}" "${crossEnv}" "${hooks[1].replace(/"/g, '\\"')}"`, [],
      { shell: true, encoding: 'utf8', cwd: FN, env: { ...process.env, RESOURCE_DIR: res, PROJECT_DIR: proj, GCLOUD_PROJECT: 'proj-x' } });
    assert.notStrictEqual(nestedRun.status, 0, 'DOTENV-HOOK-NESTED 🔴 PROJECT_DIR ≠ RESOURCE_DIR: the hook PASSED with a .env in the deployed source');
    assert.ok(!/tb-super-secret-value/.test(nestedRun.stdout + nestedRun.stderr), 'DOTENV-HOOK-NOVALUE (nested)');
    const unsetRun = spawnSync(`"${process.execPath}" "${crossEnv}" "${hooks[1].replace(/"/g, '\\"')}"`, [],
      { shell: true, encoding: 'utf8', cwd: FN, env: (() => { const e = { ...process.env, PROJECT_DIR: proj }; delete e.RESOURCE_DIR; return e; })() });
    assert.notStrictEqual(unsetRun.status, 0, 'DOTENV-HOOK-UNSET 🔴 the hook PASSED with RESOURCE_DIR unset');
    ok('the hook (second, after deploy-env-guard), run as firebase-tools runs it: passes on a dotenv-free tree, FAILS loud on a planted .env.<project> without its value; PROJECT_DIR ≠ RESOURCE_DIR (nested config) and an unset RESOURCE_DIR each block');
  } else {
    ok('the guard is the second functions predeploy hook (firebase-tools not installed here: the run-as-the-CLI cell is skipped)');
  }
}
console.log(`deploy-dotenv-guard: OK (${n})`);
