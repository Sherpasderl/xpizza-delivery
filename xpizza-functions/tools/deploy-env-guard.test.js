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
    assert.match(G.parserName(), /^firebase-tools functions\/env\.js parse \(/, 'the parser is the DEPLOYING firebase-tools\' own parse (no fallback)');
    // (a) a multiline QUOTED value whose text contains a forbidden name is a VALUE, not a key
    const ml = tree({ '.env': 'CONFIG_TEXT="first line\nFIRESTORE_EMULATOR_HOST=127.0.0.1:8080\nlast line"\nOTHER=1\n' });
    assert.deepStrictEqual(G.violations(ml, 'proj-x').bad, [], `🔴 a multiline quoted value was read as a key (parser: ${G.parserName()})`);
    const ml2 = tree({ '.env': 'CONFIG_TEXT="a\nb"\nFIRESTORE_EMULATOR_HOST=127.0.0.1:8080\n' });
    assert.deepStrictEqual(G.violations(ml2, 'proj-x').bad, ['.env: FIRESTORE_EMULATOR_HOST'], '…while a real key after it is still caught');
    // (b) an UNSELECTED project's alias file does not block this deploy; it does block a deploy TO that project
    const st = tree({ '.env.staging': 'FIREBASE_EMULATOR_HUB=127.0.0.1:4400\n' });
    assert.deepStrictEqual(G.violations(st, 'proj-x').bad, [], '🔴 a forbidden key in an UNSELECTED .env.staging blocked a deploy to proj-x');
    assert.deepStrictEqual(G.violations(st, 'proj-s').bad, ['.env.staging: FIREBASE_EMULATOR_HUB'], 'a deploy TO the staging project is blocked');
    assert.deepStrictEqual(G.violations(st, null).bad, ['.env.staging: FIREBASE_EMULATOR_HUB'], 'with NO known target every file is checked (fail-safe)');
    const msg = spawnSync(process.execPath, [path.join(__dirname, 'deploy-env-guard.js'), '--root', st], { encoding: 'utf8', env: { ...process.env, GCLOUD_PROJECT: '' } });
    assert.ok(msg.status === 1 && /NO target project known — checked EVERY project and alias/.test(msg.stderr), 'and it SAYS it checked everything');
    ok(`parsed with ${G.parserName()}: a multiline quoted value containing a forbidden name is a value, not a key; scoped to the target — a forbidden key in an unselected .env.staging does not block a proj-x deploy but blocks a proj-s deploy; no known target ⇒ every file checked, and the message says so`);
  }
  // 8. codex r4 P1-2 — codex's input, and NO fallback parser: unresolvable ⇒ the deploy is BLOCKED
  {
    // firebase-tools' parseStrict does NOT treat backticks as a multiline quote: the embedded line IS a key at deploy
    const bt = tree({ '.env': 'CONFIG_TEXT=`first\nFIRESTORE_EMULATOR_HOST=127.0.0.1:8080\nLAST=last`\n' });
    assert.deepStrictEqual(G.violations(bt, 'proj-x').bad, ['.env: FIRESTORE_EMULATOR_HOST'], '🔴 codex\'s backtick input: the FIRESTORE_EMULATOR_HOST line the deploy WOULD load was missed');
    // the deploying CLI cannot be resolved (no `firebase` on PATH) ⇒ exit 1, says the deploy is blocked and how to fix
    const noCli = spawnSync(process.execPath, [path.join(__dirname, 'deploy-env-guard.js'), '--root', bt], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin', GCLOUD_PROJECT: 'proj-x' } });
    assert.strictEqual(noCli.status, 1, `🔴 with no resolvable firebase-tools the guard did not FAIL CLOSED (exit ${noCli.status})`);
    assert.match(noCli.stderr, /deploy is BLOCKED[\s\S]*npm i -g firebase-tools/, 'it says the deploy is blocked and how to fix it');
    ok('codex\'s backtick input: the embedded FIRESTORE_EMULATOR_HOST (a key under the deploy\'s own parser) is caught; with no resolvable firebase-tools the guard FAILS CLOSED (exit 1: deploy blocked, how to fix) — there is no fallback parser');
  }
  // 9. codex r5 — NO VALUE EVER LEAKS on ANY exit path, and the FIRST `firebase` on PATH decides (never a later one)
  {
    const SECRET = 'xyzzy-PLANTED-SECRET-9f8e7d';
    const guard = (root, env) => spawnSync(process.execPath, [path.join(__dirname, 'deploy-env-guard.js'), '--root', root], { encoding: 'utf8', env: { ...process.env, GCLOUD_PROJECT: 'proj-x', ...env } });
    const paths = [
      ['parse error (a malformed line carrying a secret)', tree({ '.env': `OK=1\nAPI-KEY=${SECRET}\n` }), {}, 1, /\.env: parse error: 1 unparseable line\(s\) \(line 2\)/],
      ['forbidden key with a secret value', tree({ '.env': `FIRESTORE_EMULATOR_HOST=${SECRET}\n` }), {}, 1, /\.env: FIRESTORE_EMULATOR_HOST/],
      ['unresolvable CLI (with a secret in the file)', tree({ '.env': `TOKEN=${SECRET}\n` }), { PATH: '/usr/bin:/bin' }, 1, /deploy is BLOCKED/],
      ['clean pass (a secret value present)', tree({ '.env': `TOKEN=${SECRET}\n` }), {}, 0, /deploy-env-guard: OK/],
    ];
    for (const [label, root, env, code, re] of paths) {
      const r = guard(root, env);
      assert.strictEqual(r.status, code, `${label}: exit ${r.status}\n${r.stderr}`);
      assert.match(`${r.stdout}${r.stderr}`, re, `${label}: the expected message`);
      assert.ok(!`${r.stdout}${r.stderr}`.includes(SECRET), `🔴 ${label}: a VALUE was printed`);
    }
    // an EARLIER `firebase` on PATH that is not firebase-tools (a wrapper script) ⇒ FAIL CLOSED, even though the real CLI
    // is later on PATH — the deploy would run the wrapper, so its parser cannot be vouched for
    const wrapDir = fs.mkdtempSync(path.join(tmp, 'wrap-'));
    fs.writeFileSync(path.join(wrapDir, 'firebase'), '#!/bin/sh\nexec /usr/local/bin/firebase "$@"\n', { mode: 0o755 });
    const realBin = path.dirname(fs.realpathSync(require('child_process').execFileSync('/usr/bin/which', ['firebase'], { encoding: 'utf8' }).trim()));
    const wrapped = guard(tree({ '.env': 'A=1\n' }), { PATH: `${wrapDir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/local/bin${path.delimiter}${realBin}` });
    assert.strictEqual(wrapped.status, 1, `🔴 an earlier non-firebase-tools 'firebase' on PATH was skipped past (exit ${wrapped.status})`);
    assert.match(wrapped.stderr, /the FIRST `firebase` on PATH is missing, or is not inside a firebase-tools package/);
    // the FIRST `firebase` resolves INSIDE another package (nested in a firebase-tools-shaped dir): the NEAREST package
    // decides — it is not firebase-tools ⇒ fail closed (walking further up to the outer firebase-tools would vouch for a
    // parser the deploy does not run)
    {
      const outer = fs.mkdtempSync(path.join(tmp, 'fake-ft-'));
      fs.writeFileSync(path.join(outer, 'package.json'), JSON.stringify({ name: 'firebase-tools' }));
      fs.mkdirSync(path.join(outer, 'lib', 'functions'), { recursive: true });
      fs.writeFileSync(path.join(outer, 'lib', 'functions', 'env.js'), `module.exports = require(${JSON.stringify('/usr/local/lib/node_modules/firebase-tools/lib/functions/env.js')});`);
      const inner = path.join(outer, 'node_modules', 'other');
      fs.mkdirSync(path.join(inner, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(inner, 'package.json'), JSON.stringify({ name: 'other-tool' }));
      fs.writeFileSync(path.join(inner, 'bin', 'firebase'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const nested = guard(tree({ '.env': 'A=1\n' }), { PATH: `${path.join(inner, 'bin')}${path.delimiter}/usr/bin${path.delimiter}/bin` });
      assert.strictEqual(nested.status, 1, `🔴 a first 'firebase' inside a NON-firebase-tools package was accepted via an OUTER firebase-tools dir (exit ${nested.status})`);
    }
    ok('no value is printed on ANY exit path (parse error — count + line number only, forbidden key, unresolvable CLI, clean pass), each with a planted secret; an EARLIER non-firebase-tools `firebase` on PATH FAILS CLOSED instead of skipping to the real CLI later on PATH, and so does a first `firebase` whose NEAREST package is not firebase-tools (never an outer one)');
  }
  // 10. codex r6 — ONE error boundary: an unexpected error prints a FIXED message + the error's code/name only; and an
  //     EMPTY PATH entry is the cwd (a real candidate)
  {
    const SECRET = 'xyzzy-PLANTED-SECRET-r6-41c2';
    const capture = (opts) => { const o = []; const e = []; const code = G.main({ out: (m) => o.push(m), err: (m) => e.push(m), ...opts }); return { code, text: `${o.join('\n')}\n${e.join('\n')}` }; };
    // (a) an injected parser throws an Error whose MESSAGE carries the secret
    const root = tree({ '.env': `A=1\n` });
    const thrown = capture({ argv: ['node', 'g', '--root', root], env: { GCLOUD_PROJECT: 'proj-x' }, parserName: 'injected', keys: () => { const e = new Error(`boom near ${SECRET}`); e.code = 'EINJECTED'; throw e; } });
    assert.strictEqual(thrown.code, 1, '🔴 an unexpected parser error did not block the deploy');
    assert.match(thrown.text, /deploy-env-guard: internal error while checking \.env; deploy BLOCKED \(EINJECTED\)/, 'a FIXED message: the file + the error code only');
    assert.ok(!thrown.text.includes(SECRET), '🔴 the internal-error path printed the error MESSAGE (it carried the secret)');
    const noCode = capture({ argv: ['node', 'g', '--root', root], env: { GCLOUD_PROJECT: 'proj-x' }, parserName: 'injected', keys: () => { throw new TypeError(`bad ${SECRET}`); } });
    assert.ok(noCode.code === 1 && /deploy BLOCKED \(TypeError\)/.test(noCode.text) && !noCode.text.includes(SECRET), '🔴 a code-less error leaked its message or did not block');
    // (b) a PERMISSION error reading a dotenv file (the real CLI, a real unreadable file)
    const locked = tree({ '.env': `TOKEN=${SECRET}\n` });
    fs.chmodSync(path.join(locked, '.env'), 0o000);
    try {
      const r = spawnSync(process.execPath, [path.join(__dirname, 'deploy-env-guard.js'), '--root', locked], { encoding: 'utf8', env: { ...process.env, GCLOUD_PROJECT: 'proj-x' } });
      if (process.getuid && process.getuid() !== 0) {
        assert.strictEqual(r.status, 1, `🔴 an unreadable .env did not block (exit ${r.status})`);
        assert.match(r.stderr, /internal error while checking \.env; deploy BLOCKED \(EACCES\)/);
      }
      assert.ok(!`${r.stdout}${r.stderr}`.includes(SECRET), '🔴 the permission-error path printed a value');
    } finally { fs.chmodSync(path.join(locked, '.env'), 0o644); }
    // (c) an EMPTY PATH entry means the cwd: a non-firebase-tools `firebase` THERE decides, though /usr/local/bin has the real one
    const cwdDir = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    fs.writeFileSync(path.join(cwdDir, 'firebase'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r2 = spawnSync(process.execPath, [path.join(__dirname, 'deploy-env-guard.js'), '--root', root], { cwd: cwdDir, encoding: 'utf8', env: { ...process.env, PATH: `${path.delimiter}/usr/local/bin`, GCLOUD_PROJECT: 'proj-x' } });
    assert.strictEqual(r2.status, 1, `🔴 an EMPTY PATH entry (the cwd) was dropped — the cwd wrapper did not decide (exit ${r2.status})`);
    assert.match(r2.stderr, /the FIRST `firebase` on PATH is missing, or is not inside a firebase-tools package/);
    ok('one error boundary: an injected parser error (message carrying a secret) and a real permission-denied .env each BLOCK with a fixed "internal error while checking <file>; deploy BLOCKED (<code>)" — never the message or stack; an EMPTY PATH entry is the cwd, so a cwd `firebase` wrapper decides (fail closed)');
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`\ndeploy-env-guard: OK (${n})`);
