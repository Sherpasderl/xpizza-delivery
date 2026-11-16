#!/usr/bin/env node
'use strict';
// CT-3 (BACKLOG-contract-tools; advisor 2026-11-16) — the ONLY way a site folder should reach Netlify by CLI.
//   node tools/netlify-deploy.js <deployment-id>          DRY: prints HEAD, the site name, the dir and the exact command
//   node tools/netlify-deploy.js <deployment-id> --yes    runs that command
// <deployment-id> is a platform/sites.json `deployments[].id` (portal, legal, kitchen-xpizza, …). Everything else is resolved
// from that file and the folder's own netlify.toml: --dir = <folder>/<[build] publish>, --site = the row's netlify_site NAME.
// It refuses (exit non-zero, `REFUSED <code>` on stderr, nothing run): usage, not_a_worktree, unknown_site, no_publish,
// dir_missing, entry_missing, outside_worktree (realpath — the repo root itself counts, the 6ae0f734 accident), outside_folder
// (a sibling site's folder), dirty_tree (untracked files always count, whatever status.showUntrackedFiles says),
// dotenv_present (a .env* file anywhere under the dir, ignored or not, would be PUBLISHED).
// It never reads, prints or passes a token: Netlify auth is the owner's own `netlify login`; NETLIFY_AUTH_TOKEN is removed from
// the child's environment unread. No dotenv, no prompts (stdin is closed for the child). No network lookups.
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

class Refusal extends Error { constructor(code, detail) { super(`${code}: ${detail}`); this.code = code; this.detail = detail; } }
const refuse = (code, detail) => { throw new Refusal(code, detail); };
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// the [build] publish value of a netlify.toml (a plain `publish = "x"` line inside [build]); null when absent
function publishOf(tomlText) {
  let inBuild = false;
  for (const raw of tomlText.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (/^\[\[?.*\]\]?$/.test(line)) { inBuild = line === '[build]'; continue; }
    const m = inBuild && line.match(/^publish\s*=\s*"([^"]*)"$/);
    if (m) return m[1];
  }
  return null;
}

const inside = (root, p) => p.startsWith(root + path.sep);

// every .env* file under dir (relative paths), recursively; symlinks are listed, never followed (containment covers them)
function dotenvsUnder(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (/^\.env/.test(e.name)) out.push(p);
    else if (e.isDirectory() && !e.isSymbolicLink()) out.push(...dotenvsUnder(dir, p));
  }
  return out;
}

// PURE of git: sites.json row → { ok, id, site, dir, entrypoints } | { ok:false, code, detail }
function resolveSite(repo, key) {
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(repo, 'platform', 'sites.json'), 'utf8')).deployments || [];
    const row = rows.find((d) => d && d.id === key);
    if (!row) refuse('unknown_site', `"${key}" is not a platform/sites.json deployment id (known: ${rows.map((d) => d.id).join(', ')})`);
    if (!row.folder || !row.netlify_site) refuse('unknown_site', `${key}: the row has no folder or netlify_site`);
    const toml = path.join(repo, row.folder, 'netlify.toml');
    const publish = fs.existsSync(toml) ? publishOf(fs.readFileSync(toml, 'utf8')) : null;
    if (publish == null) refuse('no_publish', `${row.folder}/netlify.toml has no [build] publish`);
    const want = path.resolve(repo, row.folder, publish);
    if (!fs.existsSync(want)) refuse('dir_missing', `${path.relative(repo, want) || '.'} does not exist${publish !== '.' ? ' (a build output — build it first)' : ''}`);
    const dir = fs.realpathSync(want);
    if (!inside(repo, dir)) refuse('outside_worktree', `${dir} is not inside the worktree ${repo}`);
    const own = path.join(repo, row.folder);   // Codex #106 P2: the row's OWN folder (lexical — a symlinked folder or publish never counts as it)
    if (dir !== own && !inside(own, dir)) refuse('outside_folder', `${dir} is not ${row.folder}/ or below it — a ${row.id} deploy never ships another folder`);
    const entries = Array.isArray(row.entrypoints) ? row.entrypoints : [];
    const gone = entries.filter((e) => !fs.existsSync(path.join(dir, e)));
    if (!entries.length || gone.length) refuse('entry_missing', `${dir} lacks ${gone.length ? gone.join(', ') : 'any declared entrypoint'}`);
    return { ok: true, id: row.id, site: row.netlify_site, dir, entrypoints: entries };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, code: e.code, detail: e.detail };
    return { ok: false, code: 'unknown_site', detail: `platform/sites.json unreadable: ${e.message}` };
  }
}

function plan(cwd, argv) {
  const yes = argv.includes('--yes');
  const rest = argv.filter((a) => a !== '--yes');
  if (rest.length !== 1 || rest[0].startsWith('-')) refuse('usage', 'node tools/netlify-deploy.js <deployment-id> [--yes]');
  let repo;
  try { repo = fs.realpathSync(gitOut(cwd, 'rev-parse', '--show-toplevel')); } catch (_) { refuse('not_a_worktree', `${cwd} is not inside a git worktree`); }
  const r = resolveSite(repo, rest[0]);
  if (!r.ok) refuse(r.code, r.detail);
  if (gitOut(repo, 'status', '--porcelain', '--untracked-files=all') !== '') refuse('dirty_tree', `${repo} has uncommitted or untracked changes — deploy only a committed tip`);
  const envs = dotenvsUnder(r.dir);   // Codex #106 P1: the WHOLE publish tree (ignored files are published too); symlinks not followed
  if (envs.length) refuse('dotenv_present', `${r.dir} contains ${envs.join(', ')} — it would be published`);
  const head = gitOut(repo, 'rev-parse', 'HEAD');
  const args = ['netlify-cli', 'deploy', '--prod', '--no-build', '--cwd', r.dir, '--dir', r.dir, '--site', r.site];
  return { yes, head, ...r, args };
}

function main(argv, cwd = process.cwd()) {
  let p;
  try { p = plan(cwd, argv); } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    process.stderr.write(`netlify-deploy: REFUSED ${e.code} — ${e.detail}\n`);
    return e.code === 'usage' ? 2 : 1;
  }
  process.stdout.write([`HEAD ${p.head}`, `deployment ${p.id}`, `site ${p.site}`, `dir ${p.dir}`, `command: npx ${p.args.join(' ')}`, ''].join('\n'));
  if (!p.yes) { process.stdout.write('DRY RUN — nothing deployed. Re-run with --yes to deploy exactly this.\n'); return 0; }
  const env = { ...process.env }; delete env.NETLIFY_AUTH_TOKEN;
  const r = spawnSync('npx', p.args, { cwd: p.dir, env, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.error) { process.stderr.write(`netlify-deploy: npx failed to start — ${r.error.message}\n`); return 1; }
  return r.status == null ? 1 : r.status;
}

module.exports = { resolveSite, publishOf };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
