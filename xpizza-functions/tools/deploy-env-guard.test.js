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
    assert.deepStrictEqual(names, ['.env', '.env.proj-s', '.env.proj-x', '.env.staging'], `the deploy env file set: ${names}`);
    ok('checks exactly the files firebase-tools loads at deploy: .env, .env.<projectId> per project, .env.<alias> (not .env.local, emulator-only)');
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
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`\ndeploy-env-guard: OK (${n})`);
