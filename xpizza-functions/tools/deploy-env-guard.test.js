'use strict';
// The deploy-env guard: driven over REAL temp trees (and this checkout), never by restating its rule.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('./deploy-env-guard');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-env-guard-'));
try {
  const tree = (files) => {
    const d = fs.mkdtempSync(path.join(tmp, 't-'));
    fs.writeFileSync(path.join(d, 'firebase.json'), JSON.stringify({ functions: [{ source: '.' }] }));
    fs.writeFileSync(path.join(d, '.firebaserc'), JSON.stringify({ projects: { default: 'proj-x', staging: 'proj-s' } }));
    for (const [n2, t] of Object.entries(files)) fs.writeFileSync(path.join(d, n2), t);
    return d;
  };
  // 1. every file firebase-tools loads at deploy is checked: .env, .env.<id> for each project, .env.<alias>
  {
    const d = tree({});
    const names = G.deployEnvFiles(d).map((f) => path.basename(f)).sort();
    assert.deepStrictEqual(names, ['.env', '.env.default', '.env.proj-s', '.env.proj-x', '.env.staging'], `the deploy env file set: ${names}`);
    ok('checks exactly the files firebase-tools loads at deploy: .env, .env.<projectId> per project, .env.<alias> for EVERY alias incl. .env.default (not .env.local, emulator-only)');
  }
  // 2. each forbidden name is caught in each loaded file, incl. `export` and spacing; values never printed
  {
    for (const f of ['.env', '.env.proj-x', '.env.staging']) {
      for (const k of ['FUNCTIONS_EMULATOR', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS', 'FIREBASE_DATABASE_EMULATOR_HOST', 'FIREBASE_EMULATOR_HUB']) {
        const d = tree({ [f]: `A=1\n  export ${k} = super-secret-value\nB=2\n` });
        const v = G.violations(d);
        assert.deepStrictEqual(v.bad, [`${f}: ${k}`], `🔴 ${k} in ${f} was not caught`);
      }
    }
    ok('each of the 5 lib/admin.js signals is caught in .env, .env.<projectId> and .env.<alias>, including `export KEY = …` spacing');
  }
  // 3. clean files pass; non-loaded files (.env.local, .env.bak) are NOT the deploy env and are not judged here
  {
    const d = tree({ '.env': 'ULTRAMSG_TOKEN=x\nMAKE_SECRET=y\n', '.env.local': 'FIRESTORE_EMULATOR_HOST=127.0.0.1:8080\n' });
    assert.deepStrictEqual(G.violations(d), { checked: ['.env'], bad: [] });
    ok('a clean deploy env passes; .env.local (emulator-only, never loaded at deploy) is outside this invariant');
  }
  // 4. the CLI never prints a value, and the real checkout is clean
  {
    const d = tree({ '.env': 'FIRESTORE_EMULATOR_HOST=super-secret-value\n' });
    const r = spawnSync(process.execPath, [path.join(__dirname, 'deploy-env-guard.js'), '--root', d], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1, '🔴 the CLI did not fail on a forbidden key');
    assert.match(r.stderr, /\.env: FIRESTORE_EMULATOR_HOST/, 'it names the file and key');
    assert.ok(!/super-secret-value/.test(r.stdout + r.stderr), '🔴 a VALUE from a deploy env file was printed');
    const here = spawnSync(process.execPath, [path.join(__dirname, 'deploy-env-guard.js')], { encoding: 'utf8' });
    assert.strictEqual(here.status, 0, `🔴 THIS checkout's functions deploy env carries an emulator signal:\n${here.stderr}`);
    ok(`no value is ever printed; this checkout's deploy env is clean (${here.stdout.trim()})`);
  }
  // 5. functions.ignore excludes `.env.*` from the ARCHIVE — the deploy still LOADS them, from the source dir: driven
  //    through the installed CLI's own loadUserEnvs (what deploy/functions/prepare.js calls), over a real temp dir
  {
    const envJs = '/usr/local/lib/node_modules/firebase-tools/lib/functions/env.js';
    if (fs.existsSync(envJs)) {
      // the CLI refuses .env.<projectId> AND .env.<alias> together, so each is driven on its own
      const load = (files, alias) => {
        const d = tree(files);
        const out = path.join(d, 'loaded.json');
        const r = spawnSync(process.execPath, ['-e', `const E=require(${JSON.stringify(envJs)}); require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(E.loadUserEnvs({ functionsSource: ${JSON.stringify(d)}, projectId: 'proj-x', projectAlias: ${JSON.stringify(alias)}, isEmulator: false })).sort()))`], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
        return JSON.parse(fs.readFileSync(out, 'utf8'));
      };
      assert.deepStrictEqual(load({ '.env': 'A_KEY=1\n', '.env.proj-x': 'B_KEY=2\n' }, 'default'), ['A_KEY', 'B_KEY'], '🔴 deploy no longer loads .env + .env.<projectId> from the source dir');
      assert.deepStrictEqual(load({ '.env': 'A_KEY=1\n', '.env.staging': 'C_KEY=3\n' }, 'staging'), ['A_KEY', 'C_KEY'], '🔴 deploy no longer loads .env.<alias> from the source dir');
      const fb = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firebase.json'), 'utf8'));
      assert.ok(fb.functions[0].ignore.includes('.env.*'), 'premise — the archive ignores .env.*');
      ok('deploy LOADS .env, .env.<projectId>, .env.<alias> from the source dir (installed CLI loadUserEnvs) — independent of functions.ignore, which keeps every .env.* OUT of the uploaded archive');
    }
  }
  // 6. codex r2 P1-3: `.env.default` is checked (firebase-tools selects the `default` alias), and the guard is ENFORCED on the
  //    deploy path — the FIRST functions predeploy hook, run here EXACTLY as firebase-tools runs it (lifecycleHooks.js:
  //    `"<node>" "<cross-env-shell>" "<command>"` through a shell, RESOURCE_DIR = the functions source dir)
  {
    const d = tree({ '.env.default': 'export FIREBASE_DATABASE_EMULATOR_HOST = super-secret-value\n' });
    assert.deepStrictEqual(G.violations(d).bad, ['.env.default: FIREBASE_DATABASE_EMULATOR_HOST'], '🔴 .env.default (the default alias\'s dotenv) is not checked');
    const FN = path.join(__dirname, '..');
    const fb = JSON.parse(fs.readFileSync(path.join(FN, 'firebase.json'), 'utf8'));
    const hooks = [].concat(fb.functions[0].predeploy || []);
    assert.ok(hooks.length >= 1 && /deploy-env-guard\.js/.test(hooks[0]), '🔴 the deploy-env guard is not the FIRST functions predeploy hook — it would not run on deploy');
    const ft = '/usr/local/lib/node_modules/firebase-tools';
    if (fs.existsSync(ft)) {
      const crossEnv = path.resolve(require.resolve('cross-env', { paths: [ft] }), '..', 'bin', 'cross-env-shell.js');
      // firebase-tools gives a hook GCLOUD_PROJECT = the deploy's target project (lifecycleHooks.js getChildEnvironment)
      const runHook = (resourceDir, project) => spawnSync(`"${process.execPath}" "${crossEnv}" "${hooks[0].replace(/"/g, '\\"')}"`, [],
        { shell: true, encoding: 'utf8', cwd: FN, env: { ...process.env, RESOURCE_DIR: resourceDir, PROJECT_DIR: FN, GCLOUD_PROJECT: project } });
      const clean = runHook(FN, 'xpizza-delivery');
      assert.strictEqual(clean.status, 0, `🔴 the predeploy hook FAILED on the clean checkout: ${clean.stdout}${clean.stderr}`);
      // a planted signal: a temp RESOURCE_DIR holding the guard, the configs and a poisoned .env.default
      const pd = tree({ '.env.default': 'FIRESTORE_EMULATOR_HOST=super-secret-value\n' });
      fs.mkdirSync(path.join(pd, 'tools'));
      fs.copyFileSync(path.join(__dirname, 'deploy-env-guard.js'), path.join(pd, 'tools', 'deploy-env-guard.js'));
      const planted = runHook(pd, 'proj-x');   // .env.default is the `default` alias of proj-x in this tree
      assert.notStrictEqual(planted.status, 0, '🔴 the predeploy hook PASSED with an emulator signal planted in .env.default — the deploy would proceed');
      assert.match(planted.stderr, /\.env\.default: FIRESTORE_EMULATOR_HOST/, 'it fails LOUD, naming the file and key');
      assert.ok(!/super-secret-value/.test(planted.stdout + planted.stderr), '🔴 the hook printed a VALUE');
      ok(`.env.default is checked; the guard is the FIRST functions predeploy hook — run as firebase-tools runs it (cross-env-shell, RESOURCE_DIR): passes on this checkout (${clean.stdout.trim()}), FAILS loud on a planted .env.default without printing its value`);
    }
  }
  // 7. codex r3 P2-3 — parsed with firebase-tools' OWN dotenv semantics, and SCOPED to what this deploy loads
  {
    assert.ok(G.PARSER && /firebase-tools|dotenv/.test(G.PARSER.name), 'a real dotenv parser is in use');
    // (a) a multiline QUOTED value whose text contains a forbidden name is a VALUE, not a key
    const ml = tree({ '.env': 'CONFIG_TEXT="first line\nFIRESTORE_EMULATOR_HOST=127.0.0.1:8080\nlast line"\nOTHER=1\n' });
    assert.deepStrictEqual(G.violations(ml, 'proj-x').bad, [], `🔴 a multiline quoted value was read as a key (parser: ${G.PARSER.name})`);
    const ml2 = tree({ '.env': 'CONFIG_TEXT="a\nb"\nFIRESTORE_EMULATOR_HOST=127.0.0.1:8080\n' });
    assert.deepStrictEqual(G.violations(ml2, 'proj-x').bad, ['.env: FIRESTORE_EMULATOR_HOST'], '…while a real key after it is still caught');
    // (b) an UNSELECTED project's alias file does not block this deploy; it does block a deploy TO that project
    const st = tree({ '.env.staging': 'FIREBASE_EMULATOR_HUB=127.0.0.1:4400\n' });
    assert.deepStrictEqual(G.violations(st, 'proj-x').bad, [], '🔴 a forbidden key in an UNSELECTED .env.staging blocked a deploy to proj-x');
    assert.deepStrictEqual(G.violations(st, 'proj-s').bad, ['.env.staging: FIREBASE_EMULATOR_HUB'], 'a deploy TO the staging project is blocked');
    assert.deepStrictEqual(G.violations(st, null).bad, ['.env.staging: FIREBASE_EMULATOR_HUB'], 'with NO known target every file is checked (fail-safe)');
    const msg = spawnSync(process.execPath, [path.join(__dirname, 'deploy-env-guard.js'), '--root', st], { encoding: 'utf8', env: { ...process.env, GCLOUD_PROJECT: '' } });
    assert.ok(msg.status === 1 && /NO target project known — checked EVERY project and alias/.test(msg.stderr), 'and it SAYS it checked everything');
    ok(`parsed with ${G.PARSER.name}: a multiline quoted value containing a forbidden name is a value, not a key; scoped to the target — a forbidden key in an unselected .env.staging does not block a proj-x deploy but blocks a proj-s deploy; no known target ⇒ every file checked, and the message says so`);
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`\ndeploy-env-guard: OK (${n})`);
