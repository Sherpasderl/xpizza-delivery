'use strict';
// CT-3 (BACKLOG-contract-tools; advisor 2026-11-16): tools/netlify-deploy.js deploys ONLY a known site folder from
// platform/sites.json to ITS OWN Netlify site. The train-deploy accident it prevents: a portal CLI deploy that published the
// WHOLE repo to sherpa-portal (deploy 6ae0f734).
// Every cell runs the REAL script (a child process) inside a throwaway git repo whose platform/sites.json is a BYTE COPY of the
// real file and whose site folders carry the real netlify.toml files. `npx` is a fake on PATH that records its argv, cwd and
// whether NETLIFY_AUTH_TOKEN reached it, so the --yes cells prove the exact command without touching Netlify.
// Run: node tools/netlify-deploy.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REAL = path.resolve(__dirname, '..');
const SCRIPT = path.join(REAL, 'tools', 'netlify-deploy.js');
const SITES_RAW = fs.readFileSync(path.join(REAL, 'platform', 'sites.json'));
const SITES = JSON.parse(SITES_RAW).deployments;
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const cell = (label, fn) => { try { fn(); } catch (e) { console.error(`  ✗ ${label}`); throw e; } ok(label); };

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ct3-')));
  const repo = path.join(root, 'repo'); fs.mkdirSync(path.join(repo, 'platform'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'platform', 'sites.json'), SITES_RAW);
  for (const folder of ['xpizza-portal', 'xpizza-kitchen', 'customer-app', 'legal']) {
    fs.mkdirSync(path.join(repo, folder), { recursive: true });
    fs.copyFileSync(path.join(REAL, folder, 'netlify.toml'), path.join(repo, folder, 'netlify.toml'));
  }
  fs.writeFileSync(path.join(repo, 'xpizza-portal', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(repo, 'xpizza-kitchen', 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(repo, 'legal', 'index.html'), '<!doctype html>');   // es/index.html deliberately absent
  fs.writeFileSync(path.join(repo, '.gitignore'), 'customer-app/dist/\n');
  git(repo, 'init', '-q'); git(repo, 'add', '-A');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const rec = path.join(root, 'npx-record.json');
  fs.writeFileSync(path.join(bin, 'npx'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), token: 'NETLIFY_AUTH_TOKEN' in process.env }));\n`);
  fs.chmodSync(path.join(bin, 'npx'), 0o755);
  return { root, repo, bin, rec };
}
function run(sb, args, { cwd = sb.repo, env = {} } = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${sb.bin}${path.delimiter}${process.env.PATH}`, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr, ran: fs.existsSync(sb.rec) };
}
const refusedWith = (r, code) => {
  assert.notStrictEqual(r.code, 0, `exit must be non-zero (stdout ${r.out}) (stderr ${r.err})`);
  assert.ok(r.err.includes(`REFUSED ${code}`), `stderr names REFUSED ${code}: ${r.err}`);
  assert.strictEqual(r.ran, false, 'npx must never run on a refusal');
};

const sb = sandbox();
try {
  cell('premise: the sandbox sites.json is byte-identical to the real platform/sites.json', () => {
    assert.ok(Buffer.compare(fs.readFileSync(path.join(sb.repo, 'platform', 'sites.json')), SITES_RAW) === 0);
    assert.ok(SITES.some((d) => d.id === 'portal') && !SITES.some((d) => d.id === 'map'), 'premise rows');
  });

  cell('CT3-USAGE: no key, two keys, or an unknown flag → REFUSED usage (exit 2), nothing run', () => {
    for (const a of [[], ['portal', 'legal'], ['portal', '--force'], ['--yes']]) { const r = run(sb, a); refusedWith(r, 'usage'); assert.strictEqual(r.code, 2); }
  });

  cell('CT3-UNKNOWN: a key that is not a sites.json deployment id (incl. `map`, a folder name, a netlify site name) → REFUSED unknown_site', () => {
    for (const k of ['map', 'xpizza-portal', 'sherpa-portal', '..', 'PORTAL']) refusedWith(run(sb, [k, '--yes']), 'unknown_site');
  });

  cell('CT3-NO-PUBLISH: a site folder with no netlify.toml [build] publish → REFUSED no_publish', () => {
    const t = path.join(sb.repo, 'xpizza-kitchen', 'netlify.toml'); const keep = fs.readFileSync(t, 'utf8');
    fs.writeFileSync(t, keep.replace(/^\s*publish\s*=.*$/m, '')); git(sb.repo, 'commit', '-qam', 'nopub');
    try { refusedWith(run(sb, ['kitchen-xpizza', '--yes']), 'no_publish'); }
    finally { fs.writeFileSync(t, keep); git(sb.repo, 'commit', '-qam', 'restore'); }
    fs.renameSync(t, t + '.off'); git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-qm', 'notoml');
    try { refusedWith(run(sb, ['kitchen-xpizza', '--yes']), 'no_publish'); }
    finally { fs.renameSync(t + '.off', t); git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-qm', 'restore2'); }
  });

  cell('CT3-DIR-MISSING: the resolved publish dir does not exist (customer-app → customer-app/dist unbuilt) → REFUSED dir_missing', () => {
    refusedWith(run(sb, ['orders-app', '--yes']), 'dir_missing');
  });

  cell('CT3-ENTRY-MISSING: a dir without one of the row\'s declared entrypoints (legal: es/index.html) → REFUSED entry_missing', () => {
    const r = run(sb, ['legal', '--yes']); refusedWith(r, 'entry_missing'); assert.ok(r.err.includes('es/index.html'), r.err);
  });

  cell('CT3-OUTSIDE: a publish dir that resolves outside the worktree (publish = "..", or a symlinked folder) → REFUSED outside_worktree', () => {
    const t = path.join(sb.repo, 'xpizza-portal', 'netlify.toml'); const keep = fs.readFileSync(t, 'utf8');
    fs.writeFileSync(t, keep.replace(/^(\s*publish\s*=\s*)".*"/m, '$1".."')); git(sb.repo, 'commit', '-qam', 'root');
    try { refusedWith(run(sb, ['portal', '--yes']), 'outside_worktree'); }   // ".." from xpizza-portal = the REPO ROOT (the 6ae0f734 accident)
    finally { fs.writeFileSync(t, keep); git(sb.repo, 'commit', '-qam', 'restore3'); }
    const outside = path.join(sb.root, 'elsewhere'); fs.mkdirSync(outside);
    fs.copyFileSync(path.join(sb.repo, 'xpizza-kitchen', 'netlify.toml'), path.join(outside, 'netlify.toml'));
    fs.writeFileSync(path.join(outside, 'index.html'), 'x');
    fs.rmSync(path.join(sb.repo, 'xpizza-kitchen'), { recursive: true }); fs.symlinkSync(outside, path.join(sb.repo, 'xpizza-kitchen'));
    git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-qm', 'symlink');
    try { refusedWith(run(sb, ['kitchen-xpizza', '--yes']), 'outside_worktree'); }
    finally {
      fs.unlinkSync(path.join(sb.repo, 'xpizza-kitchen')); fs.renameSync(outside, path.join(sb.repo, 'xpizza-kitchen'));
      git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-qm', 'restore4');
    }
  });

  cell('CT3-DIRTY: a modified or untracked file anywhere in the worktree → REFUSED dirty_tree', () => {
    const f = path.join(sb.repo, 'notes.txt'); fs.writeFileSync(f, 'x');
    try { refusedWith(run(sb, ['portal', '--yes']), 'dirty_tree'); } finally { fs.unlinkSync(f); }
    const g = path.join(sb.repo, 'platform', 'sites.json'); fs.appendFileSync(g, '\n');
    try { refusedWith(run(sb, ['portal', '--yes']), 'dirty_tree'); } finally { git(sb.repo, 'checkout', '-q', '--', 'platform/sites.json'); }
  });

  cell('CT3-DOTENV: a .env file inside the publish dir (it would be PUBLISHED) → REFUSED dotenv_present', () => {
    const f = path.join(sb.repo, 'xpizza-kitchen', '.env.local'); fs.writeFileSync(f, 'A=1');
    git(sb.repo, 'add', '-f', '-A'); git(sb.repo, 'commit', '-qm', 'env');
    try { refusedWith(run(sb, ['kitchen-xpizza', '--yes']), 'dotenv_present'); }
    finally { git(sb.repo, 'rm', '-q', '--cached', 'xpizza-kitchen/.env.local'); fs.unlinkSync(f); git(sb.repo, 'commit', '-qm', 'unenv'); }
  });

  cell('CT3-DOTENV-NESTED (Codex #106 P1): a GITIGNORED .env file in a SUBFOLDER of the publish dir → REFUSED dotenv_present', () => {
    const gi = path.join(sb.repo, '.gitignore'); const keep = fs.readFileSync(gi, 'utf8');
    fs.writeFileSync(gi, keep + '.env*\n'); git(sb.repo, 'commit', '-qam', 'ignore env');
    const d = path.join(sb.repo, 'xpizza-kitchen', 'config'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, '.env.local'), 'A=1');
    try {
      assert.strictEqual(git(sb.repo, 'status', '--porcelain', '--untracked-files=all'), '', 'premise: the nested dotenv is ignored, the tree is clean');
      const r = run(sb, ['kitchen-xpizza', '--yes']); refusedWith(r, 'dotenv_present'); assert.ok(r.err.includes('config/.env.local'), r.err);
    } finally { fs.rmSync(d, { recursive: true }); fs.writeFileSync(gi, keep); git(sb.repo, 'commit', '-qam', 'unignore env'); }
  });

  cell('CT3-SIBLING (Codex #106 P2): a publish dir that leaves the row\'s own folder for a SIBLING site (publish = "../xpizza-kitchen", or a symlink to it) → REFUSED outside_folder', () => {
    const t = path.join(sb.repo, 'xpizza-portal', 'netlify.toml'); const keep = fs.readFileSync(t, 'utf8');
    fs.writeFileSync(t, keep.replace(/^(\s*publish\s*=\s*)".*"/m, '$1"../xpizza-kitchen"')); git(sb.repo, 'commit', '-qam', 'sibling');
    try { refusedWith(run(sb, ['portal', '--yes']), 'outside_folder'); }
    finally { fs.writeFileSync(t, keep); git(sb.repo, 'commit', '-qam', 'restore5'); }
    fs.symlinkSync('../xpizza-kitchen', path.join(sb.repo, 'xpizza-portal', 'pub'));
    fs.writeFileSync(t, keep.replace(/^(\s*publish\s*=\s*)".*"/m, '$1"pub"')); git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-qm', 'sibling link');
    try { refusedWith(run(sb, ['portal', '--yes']), 'outside_folder'); }
    finally { fs.unlinkSync(path.join(sb.repo, 'xpizza-portal', 'pub')); fs.writeFileSync(t, keep); git(sb.repo, 'add', '-A'); git(sb.repo, 'commit', '-qm', 'restore6'); }
  });

  cell('CT3-DIRTY-CONFIG (Codex #106 P2): status.showUntrackedFiles=no in the repo config still refuses an untracked file → REFUSED dirty_tree', () => {
    git(sb.repo, 'config', 'status.showUntrackedFiles', 'no'); const f = path.join(sb.repo, 'xpizza-portal', 'stray.html'); fs.writeFileSync(f, 'x');
    try { refusedWith(run(sb, ['portal', '--yes']), 'dirty_tree'); }
    finally { fs.unlinkSync(f); git(sb.repo, 'config', '--unset', 'status.showUntrackedFiles'); }
  });

  cell('CT3-OUTSIDE-CWD: run from a directory that is not inside a git worktree → REFUSED not_a_worktree', () => {
    refusedWith(run(sb, ['portal'], { cwd: sb.root }), 'not_a_worktree');
  });

  const head = git(sb.repo, 'rev-parse', 'HEAD');
  const dir = path.join(sb.repo, 'xpizza-portal');
  const want = ['netlify-cli', 'deploy', '--prod', '--no-build', '--cwd', dir, '--dir', dir, '--site', 'sherpa-portal'];

  cell('CT3-DRY: the default is a DRY print — HEAD sha, site name, absolute dir and the exact command; npx never runs', () => {
    const r = run(sb, ['portal']);
    assert.strictEqual(r.code, 0, r.err); assert.strictEqual(r.ran, false, 'dry run must not invoke npx');
    assert.ok(r.out.includes(`HEAD ${head}`), `prints the HEAD sha: ${r.out}`);
    assert.ok(/^site sherpa-portal$/m.test(r.out), `prints the sites.json NAME on its own line: ${r.out}`);
    assert.ok(r.out.includes(`dir ${dir}`), `prints the absolute dir: ${r.out}`);
    assert.ok(r.out.includes(`npx ${want.join(' ')}`), `prints the exact command: ${r.out}`);
    assert.ok(/DRY RUN/.test(r.out) && /--yes/.test(r.out), 'says it is a dry run and how to deploy');
  });

  cell('CT3-YES: --yes runs exactly the printed command (argv + cwd) and NETLIFY_AUTH_TOKEN never reaches it', () => {
    const r = run(sb, ['portal', '--yes'], { env: { NETLIFY_AUTH_TOKEN: 'must-not-pass' } });
    assert.strictEqual(r.code, 0, r.err); assert.ok(r.ran, 'npx ran');
    const got = JSON.parse(fs.readFileSync(sb.rec, 'utf8')); fs.unlinkSync(sb.rec);
    assert.deepStrictEqual(got.argv, want); assert.strictEqual(fs.realpathSync(got.cwd), dir);
    assert.strictEqual(got.token, false, 'the token env var is stripped'); assert.ok(!r.out.includes('must-not-pass') && !r.err.includes('must-not-pass'));
  });

  cell('CT3-REAL: every real sites.json row resolves against THIS worktree — known folder, publish dir from its netlify.toml, inside the worktree', () => {
    const ND = require(SCRIPT);
    for (const d of SITES) {
      const r = ND.resolveSite(REAL, d.id);
      if (d.folder === 'customer-app') { assert.ok(!r.ok ? r.code === 'dir_missing' : r.dir === path.join(REAL, 'customer-app', 'dist'), `${d.id}: ${JSON.stringify(r)}`); continue; }
      assert.ok(r.ok, `${d.id} resolves: ${JSON.stringify(r)}`);
      assert.strictEqual(r.site, d.netlify_site); assert.ok(r.dir.startsWith(REAL + path.sep) && r.dir !== REAL, d.id);
    }
    assert.strictEqual(ND.resolveSite(REAL, 'map').code, 'unknown_site');
  });
} finally { fs.rmSync(sb.root, { recursive: true, force: true }); }
console.log(`netlify-deploy: OK (${n})`);
