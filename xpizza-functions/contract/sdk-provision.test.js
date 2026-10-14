'use strict';
// R3 P0 — static cells for contract/sdk-provision.js (codex r3 P2): npm for the comparison SDK is CONTAINED in the
// repository — its cache / logs / npmrc are repository-local, every inherited npm setting is dropped, and a failed
// provisioning throws. Runs without npm (an injected spawn records what WOULD be launched).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { provision, npmEnv, npmArgs } = require('./sdk-provision');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-SDK-PROVISION ${m}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-sdkprov-'));
const inside = (p) => path.resolve(p).startsWith(path.resolve(dir) + path.sep);
const inherited = { PATH: process.env.PATH, HOME: '/home/someone', NODE_OPTIONS: '--require /x/count-marks.js', npm_config_cache: '/elsewhere/.npm', NPM_CONFIG_LOGS_DIR: '/elsewhere/logs', npm_config_registry: 'https://mirror.invalid/', Npm_Config_Prefix: '/elsewhere/prefix', npm_config_userconfig: '/home/someone/.npmrc' };

try {
  const env = npmEnv(inherited, dir);
  const npmKeys = Object.keys(env).filter((k) => /^npm_config_/i.test(k)).sort();
  assert.deepStrictEqual(npmKeys, ['npm_config_cache', 'npm_config_globalconfig', 'npm_config_logs_dir', 'npm_config_update_notifier', 'npm_config_userconfig'], FAIL(`inherited npm settings leaked into the child: ${npmKeys.join(', ')}`));
  for (const k of ['npm_config_cache', 'npm_config_logs_dir', 'npm_config_userconfig', 'npm_config_globalconfig']) assert.ok(inside(env[k]), FAIL(`${k} = ${env[k]} is outside the repository-local dir`));
  assert.ok(!('NODE_OPTIONS' in env) && env.PATH === process.env.PATH, FAIL('the child is not hermetic (NODE_OPTIONS) or lost PATH'));
  ok('child env: every inherited npm_config_* (any case: cache, logs, registry, prefix, userconfig) dropped; cache / logs / user + global npmrc repository-local; no NODE_OPTIONS');

  const args = npmArgs(dir); const at = (f) => args[args.indexOf(f) + 1];
  assert.ok(args[0] === 'ci' && inside(at('--cache')) && inside(at('--logs-dir')), FAIL(`npm args not contained: ${args.join(' ')}`));
  ok('npm ci --cache <dir>/.npm-cache --logs-dir <dir>/.npm-logs (explicit, in addition to the env)');

  const calls = [];
  const fake = (status, error) => (cmd, a, o) => { calls.push({ cmd, a, o }); return { status, error, stderr: 'boom' }; };
  assert.deepStrictEqual(provision(dir, { baseEnv: inherited, spawn: fake(0), guarded: false }), { provisioned: true });
  const c = calls[0];
  assert.ok(c.cmd === 'npm' && c.o.cwd === dir && c.o.env.npm_config_cache === path.join(dir, '.npm-cache') && fs.readFileSync(c.o.env.npm_config_userconfig, 'utf8') === '' && fs.readFileSync(c.o.env.npm_config_globalconfig, 'utf8') === '' && c.o.env.npm_config_userconfig !== c.o.env.npm_config_globalconfig, FAIL('provision() did not launch the contained npm ci'));
  assert.throws(() => provision(dir, { baseEnv: inherited, spawn: fake(1), guarded: false }), /could not provision/, FAIL('a nonzero npm ci did not throw'));
  assert.throws(() => provision(dir, { baseEnv: inherited, spawn: fake(null, new Error('ENOENT')), guarded: false }), /could not provision.*ENOENT/, FAIL('a failed spawn did not throw'));
  // B3: under the egress guard npm is refused, so a guarded caller with the SDK absent fails naming the pre-guard step and
  // launches NOTHING; this file itself runs under the guard, so the DEFAULT is the guarded path
  const g0 = calls.length;
  assert.throws(() => provision(dir, { baseEnv: inherited, spawn: fake(0), guarded: true }), /not provisioned.*egress guard.*node contract\/sdk-provision\.js/, FAIL('a guarded caller with the SDK absent did not fail naming the pre-guard step'));
  assert.strictEqual(calls.length, g0, FAIL('a guarded caller launched npm (the guard would refuse it mid-install)'));
  // the DEFAULT: a process with tools/egress-guard.js preloaded is guarded without being told (a spy spawn records npm)
  const probe = spawnSync(process.execPath, ['-r', path.join(__dirname, '..', 'tools', 'egress-guard.js'), '-e',
    `const n=[];try{require(${JSON.stringify(path.join(__dirname, 'sdk-provision.js'))}).provision(${JSON.stringify(dir)},{spawn:()=>{n.push(1);return{status:0}}});console.log('NO-THROW',n.length)}catch(e){console.log('THREW',n.length,e.message)}`],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.match(probe.stdout || '', /^THREW 0 .*not provisioned.*egress guard/m, FAIL(`under tools/egress-guard.js the default did not refuse before npm: ${(probe.stdout || '') + (probe.stderr || '')}`));
  ok('guarded caller (explicit, and the DEFAULT in a process preloading tools/egress-guard.js), SDK absent → throws naming `node contract/sdk-provision.js`, launches no npm process');
  fs.mkdirSync(path.join(dir, 'node_modules', 'firebase'), { recursive: true }); fs.writeFileSync(path.join(dir, 'node_modules', 'firebase', 'package.json'), '{}');
  const before = calls.length; assert.deepStrictEqual(provision(dir, { baseEnv: inherited, spawn: fake(0), guarded: false }), { provisioned: false });
  assert.strictEqual(calls.length, before, FAIL('an already-provisioned SDK launched npm'));
  assert.deepStrictEqual(provision(dir, { baseEnv: inherited, spawn: fake(0), guarded: true }), { provisioned: false }, FAIL('a guarded caller refused an ALREADY provisioned SDK'));
  ok('provision(): launches the contained npm ci (two empty local npmrc files written — npm refuses one file as both user and global); nonzero exit and failed spawn THROW; already provisioned → no npm process');
  // B3: test:r3-p0-adapter provisions FIRST, outside the guard, then runs the suite through the runner — whose inner
  // command (the suite body) still gets the egress guard preloaded
  const { SDK10_DIR } = require('./sdk-provision');
  assert.strictEqual(SDK10_DIR, path.join(__dirname, 'sdk-10.13.2'), FAIL(`the CLI provisions ${SDK10_DIR}, not contract/sdk-10.13.2`));
  const script = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).scripts['test:r3-p0-adapter'];
  const m = /^node contract\/sdk-provision\.js && node tools\/emulator-run\.js .*"(node [^"]+)"\s*$/.exec(script || '');
  assert.ok(m, FAIL(`test:r3-p0-adapter does not provision before the runner: ${script}`));
  const { injectCounter } = require('../tools/emulator-run.js');
  const EG = path.join(__dirname, '..', 'tools', 'egress-guard.js');
  const inner = injectCounter(m[1], EG, '/abs/count-marks.js', '/abs/emu-null-guard.js');
  assert.ok(inner.includes(`-r ${EG}`) && /p0-adapter\.emulator\.test\.js/.test(inner) && !/sdk-provision/.test(m[1]), FAIL(`the adapter suite body is not run under the egress guard: ${inner}`));
  ok('test:r3-p0-adapter = `node contract/sdk-provision.js && node tools/emulator-run.js … "node contract/p0-adapter…"`: provisioned outside the guard; the suite body still preloads tools/egress-guard.js');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\nr3-sdk-provision: OK (${n})`);
