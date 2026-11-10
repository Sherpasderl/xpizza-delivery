'use strict';
// TRAIN BLOCKER (advisor ruling, 2026-11-01) — the deployed functions declare NO non-secret params.
// A defineString / defineInt / defineBoolean / defineFloat / defineList param with no value makes the functions emulator PROMPT on
// stdin (quality-runner hangs forever), and the owner's deploy prompts the same way; firebase-tools then writes .env.<project>,
// which deploy-dotenv-guard blocks on every later deploy. Secrets (defineSecret / defineJsonSecret) live in Secret Manager and are
// fine. The census is firebase-functions' OWN registry (params.declaredParams), filled by loading the real index.js in a fresh
// child — exactly what the CLI's discovery sees — not a grep.
// Run: node deploy-params.guard.test.js
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const SECRET_KINDS = new Set(['SecretParam', 'JsonSecretParam']);
const PROBE = "process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza'; process.env.MAKE_SECRET = process.env.MAKE_SECRET || 'params-secret';"
  + " require('./index.js'); const p = require('firebase-functions/params');"
  + " process.stdout.write('PARAMS ' + JSON.stringify(p.declaredParams.map((x) => ({ name: x.name, kind: x.constructor && x.constructor.name }))) + '\\n');";

// the params a fresh load of the deployed source declares (extra preload modules for the sensitivity cell)
// The child must load the WHOLE deployed closure: index.js gates its load on FUNCTION_TARGET (a gen2 instance loads only its
// group, index.js:6–8), so an inherited one would census a single group — a false pass (codex HIGH P2). It is removed with the
// other runtime identity vars; `keepTarget` exists only for the premise cell that proves the gate is real.
const ISOLATE_VARS = ['FUNCTION_TARGET', 'K_SERVICE', 'FUNCTION_NAME'];
function declared(preload = [], { keepTarget = false } = {}) {
  const env = { ...process.env }; delete env.NODE_OPTIONS;
  if (!keepTarget) for (const k of ISOLATE_VARS) delete env[k];
  for (const k of Object.keys(env)) if (/_EMULATOR_HOST$/.test(k)) delete env[k];   // a plain offline load, as cors-preflight.test.js does
  // tools/egress-guard.js FIRST: loopback-only, so loading index.js here can never reach a real endpoint (endpoint census)
  const r = spawnSync(process.execPath, ['-r', path.join(__dirname, 'tools', 'egress-guard.js'), ...preload.flatMap((f) => ['-r', f]), '-e', PROBE], { cwd: __dirname, env, encoding: 'utf8', timeout: 60000 });
  assert.ok(!/r3-egress: .*REFUSED/.test(r.stderr || ''), `DEPLOY-PARAMS-NO-EGRESS loading index.js attempted a non-loopback connection\n${(r.stderr || '').slice(-800)}`);
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('PARAMS '));
  assert.ok(r.status === 0 && line, `premise — index.js loads in a fresh child and the registry is read (status ${r.status})\n${(r.stderr || '').slice(-800)}`);
  return JSON.parse(line.slice('PARAMS '.length));
}

const params = declared();
const nonSecret = params.filter((p) => !SECRET_KINDS.has(p.kind));
assert.deepStrictEqual(nonSecret, [], `🔴 DEPLOY-PARAMS-NONE-NONSECRET the deployed functions declare non-secret params ${JSON.stringify(nonSecret)} — each makes the emulator / deploy prompt and firebase-tools write a dotenv the dotenv guard then blocks`);
ok(`the deployed functions declare no non-secret params (${params.length} declared, all secrets: ${JSON.stringify(params.map((p) => p.name))})`);

// sensitivity: one defineString anywhere in the loaded closure is caught by the same census
const plant = path.join(__dirname, 'test', '_plant-string-param.js');
const planted = declared([plant]);
assert.ok(planted.some((p) => p.name === 'TB_PLANTED_PARAM' && !SECRET_KINDS.has(p.kind)), `DEPLOY-PARAMS-SENSITIVE a planted defineString is seen by the census ${JSON.stringify(planted)}`);
ok('sensitive: a planted defineString in the loaded closure is reported as a non-secret param');

// codex HIGH P2 regression: FUNCTION_TARGET set in the PARENT (an isolated portal target) + a param planted ONLY on the full-load
// path (test/_plant-full-load-param.js: declared when photos/functions.js loads) → still detected, because the child loads it all
{
  const fullPlant = path.join(__dirname, 'test', '_plant-full-load-param.js');
  const saved = process.env.FUNCTION_TARGET; process.env.FUNCTION_TARGET = 'getEditableCatalog';
  try {
    const isolated = declared([fullPlant], { keepTarget: true });
    assert.ok(!isolated.some((p) => p.name === 'TB_FULL_LOAD_PARAM'), `premise — with FUNCTION_TARGET kept, the isolated load never reaches the full-load plant ${JSON.stringify(isolated)}`);
    const full = declared([fullPlant]);
    assert.ok(full.some((p) => p.name === 'TB_FULL_LOAD_PARAM' && !SECRET_KINDS.has(p.kind)), `🔴 DEPLOY-PARAMS-FULL-LOAD an inherited FUNCTION_TARGET hid a full-load param from the census ${JSON.stringify(full)}`);
  } finally { if (saved === undefined) delete process.env.FUNCTION_TARGET; else process.env.FUNCTION_TARGET = saved; }
}
ok('FUNCTION_TARGET inherited from the parent (getEditableCatalog) cannot narrow the census: a param planted only on the full-load path is still detected (and the kept-target premise shows the gate is real)');

console.log(`deploy-params.guard: OK (${n})`);
