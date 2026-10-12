'use strict';
// R3 P0 — provisions the self-contained comparison SDK (contract/sdk-10.13.2) with npm CONTAINED in the repository
// (codex r3 P2): npm's cache and logs go to <dir>/.npm-cache and <dir>/.npm-logs (git-ignored), EVERY inherited npm
// setting (npm_config_* / NPM_CONFIG_*, any case) is dropped, and the user / global npmrc are replaced by an empty
// repository-local file, so neither ~/.npm nor an inherited cache / registry / prefix is read or written. The child is
// hermetic (no NODE_OPTIONS gate preload). A failure to provision throws — never a skip.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function npmEnv(baseEnv, dir) {
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) if (!/^npm_config_/i.test(k) && k !== 'NODE_OPTIONS') env[k] = v;
  const local = path.join(dir, '.npm-cache');
  env.npm_config_cache = local;
  env.npm_config_logs_dir = path.join(dir, '.npm-logs');
  env.npm_config_userconfig = path.join(local, 'empty-user-npmrc');       // two files: npm refuses one file as both
  env.npm_config_globalconfig = path.join(local, 'empty-global-npmrc');
  env.npm_config_update_notifier = 'false';
  return env;
}

function npmArgs(dir) {
  return ['ci', '--no-audit', '--no-fund', '--cache', path.join(dir, '.npm-cache'), '--logs-dir', path.join(dir, '.npm-logs')];
}

function provision(dir, { baseEnv = process.env, spawn = spawnSync } = {}) {
  if (fs.existsSync(path.join(dir, 'node_modules', 'firebase', 'package.json'))) return { provisioned: false };
  fs.mkdirSync(path.join(dir, '.npm-cache'), { recursive: true });
  for (const f of ['empty-user-npmrc', 'empty-global-npmrc']) fs.writeFileSync(path.join(dir, '.npm-cache', f), '');
  const r = spawn('npm', npmArgs(dir), { cwd: dir, encoding: 'utf8', env: npmEnv(baseEnv, dir) });
  if (r.error || r.status !== 0) throw new Error(`🔴 R3-P0:SDK10 could not provision ${path.basename(dir)} (npm ci exit ${r.status}${r.error ? `, ${r.error.message}` : ''}): ${(r.stderr || '').slice(-400)}`);
  return { provisioned: true };
}

module.exports = { provision, npmEnv, npmArgs };
