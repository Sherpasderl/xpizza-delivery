'use strict';
// The ONLY sanctioned index deploy (tools/deploy-indexes.js) + the installed-CLI no-delete contract
// (tools/firebase-cli-nodelete.js). Run: node tools/deploy-indexes.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const D = require('./deploy-indexes');
const C = require('./firebase-cli-nodelete');
let __finished = false;
process.on('exit', (code) => { if (code === 0 && !__finished) { console.error('🔴 suite exited before finishing'); process.exit(1); } });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');

// 1. 🔴 THE EXACT FLAGS: --non-interactive present, the force flag absent, the project pinned — in the builder
//    AND in the npm script that is the sanctioned entry point.
{
  assert.deepStrictEqual(D.buildArgs('xpizza-delivery'), ['deploy', '--only', 'firestore:indexes', '--non-interactive', '--config', 'firebase.indexes.json', '--project', 'xpizza-delivery']);
  assert(!D.buildArgs('x').some((a) => /force/.test(a)), 'the force flag is never built');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts['deploy:indexes'], 'node tools/deploy-indexes.js --project xpizza-delivery');
  for (const [k, v] of Object.entries(pkg.scripts)) {
    if (/firestore:indexes/.test(v)) assert.strictEqual(k, 'deploy:indexes', `script ${k} deploys indexes outside the sanctioned wrapper`);
    // (No script, doc or flag — a force flag included — can deploy indexes some other way: firebase.json
    //  declares none and no other tracked config may, so only this wrapper's --config reaches them;
    //  tools/firestore-config-isolation.test.js proves it against the installed CLI.)
  }
  ok('flags pinned: deploy --only firestore:indexes --non-interactive --config firebase.indexes.json --project xpizza-delivery; no force flag; no other index-deploy script');
}

// 2. The wrapper spawns EXACTLY those args, and refuses — without spawning — on the force flag, a broken source
//    contract, or a failed BEHAVIOURAL probe.
async function cell2() {
  const keepArgv = process.argv;
  const quiet = () => { const k = [console.log, console.error]; console.log = () => {}; console.error = () => {}; return () => { [console.log, console.error] = k; }; };
  const goodCheck = () => ({ version: 't', root: '/x', fails: [] });
  const goodProbe = async () => ({ fails: [] });
  try {
    process.argv = ['node', 'deploy-indexes.js', '--project', 'xpizza-delivery'];
    let spawned = null;
    const spawn = (cmd, args) => { spawned = [cmd, args]; return { status: 0 }; };
    const run = async (argv, over) => { spawned = null; const r = quiet(); try { return await D.main(argv, { spawn, check: goodCheck, probe: goodProbe, ...over }); } finally { r(); } };
    assert.strictEqual(await run(['--project', 'xpizza-delivery']), 0);
    assert.deepStrictEqual(spawned, ['firebase', D.buildArgs('xpizza-delivery')]);
    for (const extra of [['--force'], ['--force=true']]) {
      assert.strictEqual(await run(['--project', 'xpizza-delivery', ...extra]), 1); assert.strictEqual(spawned, null, `${extra} must refuse without spawning`);
    }
    assert.strictEqual(await run(['--project', 'xpizza-delivery'], { check: () => ({ version: '99', root: '/x', fails: ['🔴 contract changed'] }) }), 1);
    assert.strictEqual(spawned, null, 'a broken source contract refuses before deploying');
    assert.strictEqual(await run(['--project', 'xpizza-delivery'], { probe: async () => ({ fails: ['🔴 BEHAVIOUR — deleted'] }) }), 1);
    assert.strictEqual(spawned, null, 'a failed behavioural probe refuses before deploying');
    spawned = null; const r = quiet();
    try { assert.strictEqual(await D.main(['--project', 'xpizza-delivery'], { spawn: () => ({ status: 7 }), check: goodCheck, probe: goodProbe }), 7, "the deploy's own exit status propagates"); }
    finally { r(); }
  } finally { process.argv = keepArgv; }
  ok('wrapper spawns exactly the pinned args; the force flag, a broken source contract and a failed behavioural probe refuse WITHOUT spawning; exit status propagates');
}

// 3. Missing / wrong project → exit 2 from the real file, before anything else (spawned for real; these
//    refuse in the guard, so nothing can reach `firebase`).
function cell3() {
  for (const args of [[], ['--project', 'lamusa-social']]) {
    let code = 0, out = '';
    try { execFileSync(process.execPath, [path.join(__dirname, 'deploy-indexes.js'), ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GOOGLE_CLOUD_PROJECT: '', GCLOUD_PROJECT: '' } }); }
    catch (e) { code = e.status; out = `${e.stdout || ''}${e.stderr || ''}`; }
    assert.strictEqual(code, 2, `${JSON.stringify(args)} exited ${code}`); assert.match(out, /project_guard_refused/);
  }
  ok('missing / wrong project → exit 2 (project_guard_refused) before any deploy');
}

// 4. 🔴 THE INSTALLED CLI STILL HAS THE NON-INTERACTIVE NO-DELETE BRANCH — for indexes AND field overrides
//    (source structure; SECONDARY to the behavioural probe, cell 6).
function cell4() {
  let r;
  try { r = C.checkInstalled(); }
  catch (e) { assert.fail(`🔴 cannot locate the installed firebase-tools to verify the no-delete contract: ${e.message}`); }
  assert.deepStrictEqual(r.fails, [], `🔴 firebase-tools ${r.version} at ${r.root} no longer guarantees a non-interactive index deploy deletes nothing:\n${r.fails.join('\n')}`);
  ok(`installed firebase-tools ${r.version}: non-interactive, no force flag → never deletes indexes or field overrides (structure verified)`);

  // non-vacuity: each way the contract could break is detected, with clear text
  const api = fs.readFileSync(path.join(r.root, 'lib', 'firestore', 'api.js'), 'utf8');
  const prompt = fs.readFileSync(path.join(r.root, 'lib', 'prompt.js'), 'utf8');
  const breaks = [
    ['indexes confirm defaults to true', api.replace(/(message: "Would you like to delete these indexes)/, '$1').replace(/default: false,(\s*message: "Would you like to delete these indexes)/, 'default: true,$1'), prompt, /indexes: the confirm/],
    ['field-override confirm defaults to true', api.replace(/default: false,(\s*message: "Would you like to delete these field overrides)/, 'default: true,$1'), prompt, /field overrides: the confirm/],
    ['index delete flag starts true', api.replace('let shouldDeleteIndexes = options.force;', 'let shouldDeleteIndexes = true;'), prompt, /indexes: the delete flag/],
    ['field delete no longer gated', api.replace('if (shouldDeleteFields && fieldOverridesToDelete.length > 0) {', 'if (fieldOverridesToDelete.length > 0) {'), prompt, /field overrides: deletion must be gated/],
    ['non-interactive returns true', api, prompt.replace('return { shouldReturn: true, value: opts.default };', 'return { shouldReturn: true, value: true };'), /no longer returns the DEFAULT/],
    ["confirm() ignores guard()'s value (codex r4)", api, prompt.replace(/(async function confirm\(opts\) \{[\s\S]*?if \(shouldReturn\) \{\s*)return value;/, '$1return true;'), /confirm\(\) no longer RETURNS guard/],
  ];
  for (const [label, a, p, re] of breaks) {
    assert.notStrictEqual(a + p, api + prompt, `fixture premise: "${label}" actually changed the source`);
    const f = C.checkSources({ api: a, prompt: p });
    assert(f.some((x) => re.test(x)), `"${label}" not detected: ${JSON.stringify(f)}`);
  }
  ok('the contract check detects each break (confirm default, delete-flag start, delete gating, prompt default) with clear text');
}
// 6. 🔴 THE PRIMARY PROOF IS BEHAVIOURAL (codex build r4): the INSTALLED CLI's real confirm() returns
//    false non-interactively, and its real deploy() — reads stubbed, writes spied — deletes NOTHING
//    without the force flag while the force:true control deletes both (so the spies see deletions).
async function cell6() {
  const r = await C.probeInstalled();
  assert.deepStrictEqual(r.fails, [], r.fails.join('\n'));
  assert.deepStrictEqual([r.safe.deleteIndex, r.safe.deleteField], [0, 0], 'no deletion without the force flag');
  assert.strictEqual(r.safe.patchField, 1, 'the declared override was applied — the drive really ran deploy()');
  assert.deepStrictEqual([r.forced.deleteIndex, r.forced.deleteField], [1, 1], 'control: force:true deletes both');
  // non-vacuity: break the installed confirm() IN MEMORY (deploy() calls it through the module object) —
  // the probe must catch it, behaviourally.
  const { root } = C.findFirebaseTools();
  const promptMod = require(path.join(root, 'lib', 'prompt.js'));
  const real = promptMod.confirm;
  promptMod.confirm = async () => true;
  let broken;
  try { broken = await C.probeInstalled({ root }); } finally { promptMod.confirm = real; }
  assert(broken.fails.some((f) => /confirm\(\{nonInteractive:true, force:false, default:false\}\) returned true/.test(f)), JSON.stringify(broken.fails));
  assert(broken.fails.some((f) => /without the force flag DELETED 1 index\(es\) and 1 field override/.test(f)), JSON.stringify(broken.fails));
  ok('BEHAVIOURAL probe of the installed CLI: confirm() → false, deploy() deletes 0 without the force flag, control deletes 1/1; a confirm() returning true is caught');
}

// (Index isolation is by construction, not by scanning text: tools/firestore-config-isolation.test.js
//  — firebase.json has no indexes, the config inventory is exact, and the installed CLI prepares no index
//  operation from any default config.)

(async () => {
  await cell2();
  cell3(); cell4();
  await cell6();
  console.log(`\ndeploy-indexes: ${n} cells passed`);
  __finished = true;
})().catch((e) => { console.error(e); process.exit(1); });
