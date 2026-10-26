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
const multi = tree({ 'a/.env': 'X=1\n', 'b/.env.local': 'Y=1\n' }, { functions: [{ source: 'a' }, { source: 'b' }] });
assert.deepStrictEqual(G.dotenvFiles(multi), ['a/.env', 'b/.env.local'], 'DOTENV-SOURCES every functions source dir is checked');
assert.deepStrictEqual(G.dotenvFiles(tree({ '.envrc': 'x\n', 'env.txt': 'x\n', '.env.example.bak': 'x\n' })), ['.env.example.bak'], 'DOTENV-SHAPE only .env / .env.<x> names (a .env.example COPY still blocks)');
ok('.env, .env.<project>, .env.<alias>, .env.local, .env.<x> are each found by name, in every functions source dir; .envrc / env.txt are not dotenv');

// 3. main(): blocks with the overlap message, names the FILE only — never a value
{
  const d = tree({ '.env': 'MAKE_SECRET=tb-super-secret-value\n' });
  const lines = []; const rc = G.main({ argv: ['node', 'g', '--root', d], out: (m) => lines.push(m), err: (m) => lines.push(m) });
  const text = lines.join('\n');
  assert.strictEqual(rc, 1, 'DOTENV-BLOCK a present .env blocks the deploy (exit 1)');
  assert.match(text, /\.env\b/, 'it names the file');
  assert.match(text, /notifyArrivedOnTap/, 'it names the bound function');
  assert.match(text, /secret/i, 'it names the overlap risk (plain env + secret env under one name)');
  assert.ok(!/tb-super-secret-value/.test(text), 'DOTENV-NOVALUE 🔴 the guard printed a VALUE');
  const clean = []; assert.strictEqual(G.main({ argv: ['node', 'g', '--root', tree({})], out: (m) => clean.push(m), err: (m) => clean.push(m) }), 0, 'DOTENV-PASS no dotenv → exit 0');
  assert.match(clean.join('\n'), /deploy-dotenv-guard: OK/, 'the pass line says OK');
  const broken = tree({}); fs.writeFileSync(path.join(broken, 'firebase.json'), '{not json');
  assert.strictEqual(G.main({ argv: ['node', 'g', '--root', broken], out: () => {}, err: () => {} }), 1, 'DOTENV-FAILCLOSED an unreadable firebase.json blocks');
  ok('main(): a dotenv file → exit 1 naming the file, notifyArrivedOnTap and the secret overlap, never the value; none → exit 0; an internal error → exit 1');
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
    ok('the hook (second, after deploy-env-guard), run as firebase-tools runs it: passes on a dotenv-free tree, FAILS loud on a planted .env.<project> without its value');
  } else {
    ok('the guard is the second functions predeploy hook (firebase-tools not installed here: the run-as-the-CLI cell is skipped)');
  }
}
console.log(`deploy-dotenv-guard: OK (${n})`);
