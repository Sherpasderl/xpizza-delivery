'use strict';
// P-SELFUPDATE CP2 §1 — the build stamp (platform/stamp-version.js), the committed module copies, compat.json
// monotonicity and the unstamped → MISSING visibility (advisor ruling CP2 Q2). Run: node pselfupdate-stamp.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('../platform/stamp-version.js');
const R = require('./tools/client-version-report-core');

const ROOT = path.join(__dirname, '..');
const SITES = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform/sites.json'), 'utf8'));
const COMPAT = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform/compat.json'), 'utf8'));
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('uncaughtException', (e) => { console.error('pselfupdate-stamp FAILED:', e); process.exit(1); });
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('pselfupdate-stamp FAILED: exited without completing'); process.exitCode = 1; } });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'psu-stamp-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
let k = 0;
// a copy of a site folder's git-tracked files (what a Netlify clone has), under a dir NAMED like the folder
function copySite(folder) {
  const dst = path.join(TMP, String(++k), folder);
  const files = execFileSync('git', ['ls-files', '--', folder], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of files) {
    const out = path.join(dst, path.relative(folder, f));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), out);
  }
  // the committed module copy may be untracked in a working tree that has not committed it yet
  const sc = path.join(ROOT, folder, 'sherpa-client.js');
  if (fs.existsSync(sc)) fs.copyFileSync(sc, path.join(dst, 'sherpa-client.js'));
  return dst;
}
const snapshot = (dir) => { const out = {}; (function walk(r) { for (const e of fs.readdirSync(path.join(dir, r), { withFileTypes: true })) { const p = r ? `${r}/${e.name}` : e.name; if (e.isDirectory()) walk(p); else out[p] = fs.readFileSync(path.join(dir, p)).toString('base64'); } })(''); return out; };

// ── every manifest deployment stamps (the Q2 repo test) ───────────────────────────────────────────────────────────
const names = SITES.deployments.map((d) => d.netlify_site);
assert.strictEqual(new Set(names).size, names.length, 'netlify_site is unique per deployment');
for (const d of SITES.deployments) {
  assert.ok(typeof d.netlify_site === 'string' && d.netlify_site, `${d.id}: has a netlify_site`);
  const dir = copySite(d.folder);
  const before = snapshot(dir);
  const r = S.stamp(dir, { siteName: d.netlify_site, commit: 'c0ffee', env: 'production' });
  assert.ok(r.ok, `🔴 ${d.id} cannot be stamped: ${r.error}`);
  assert.strictEqual(r.deployment, d.id); assert.strictEqual(r.compat, COMPAT.generations[d.app]);
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
  assert.deepStrictEqual(v, { app: d.app, deployment: d.id, build: r.build, compat: COMPAT.generations[d.app], commit: 'c0ffee' });
  const after = snapshot(dir);
  // the ONLY differences: version.json added + exactly one stamp block per entrypoint
  for (const f of Object.keys(after)) {
    if (f === 'version.json') continue;
    if (d.entrypoints.includes(f)) {
      const html = Buffer.from(after[f], 'base64').toString('utf8');
      assert.strictEqual((html.match(/sherpa-stamp:begin/g) || []).length, 1, `${d.id} ${f}: one stamp block`);
      assert.strictEqual(html.replace(S.STAMP_BLOCK_RE, ''), Buffer.from(before[f], 'base64').toString('utf8'), `${d.id} ${f}: nothing but the stamp block changed`);
      for (const [m, val] of [['sherpa-app', d.app], ['sherpa-deployment', d.id], ['sherpa-context', d.context], ['app-build', r.build], ['app-compat', String(r.compat)], ['sherpa-env', 'production']]) assert.ok(html.includes(`<meta name="${m}" content="${val}">`), `${d.id} ${f}: meta ${m}`);
      const cs = html.search(/<meta\s+charset/i);
      if (cs >= 0) assert.ok(cs < html.indexOf('sherpa-stamp:begin') && cs < 1024, `${d.id} ${f}: charset meta stays first, within 1024 bytes`);
    } else assert.strictEqual(after[f], before[f], `${d.id} ${f}: untouched`);
  }
  assert.deepStrictEqual(Object.keys(after).filter((f) => !(f in before)), ['version.json']);
  // idempotent: re-stamping a stamped folder yields the same build and still one block
  const r2 = S.stamp(dir, { siteName: d.netlify_site, commit: 'c0ffee', env: 'production' });
  assert.strictEqual(r2.build, r.build, `${d.id}: re-stamp is idempotent`);
  assert.deepStrictEqual(snapshot(dir), after);
}
ok(`all ${SITES.deployments.length} manifest deployments stamp from their netlify_site: version.json + one <meta> block per entrypoint, nothing else changes, idempotent`);

// ── shared folders: the two kitchen / track sites get different identities from the same files ─────────────────────
{
  const a = copySite('xpizza-kitchen'); const b = copySite('xpizza-kitchen');
  const ra = S.stamp(a, { siteName: 'xpizzakitchendisplay' }); const rb = S.stamp(b, { siteName: 'lamusakitchendisplay' });
  assert.strictEqual(ra.build, rb.build, 'same files → same build');
  assert.ok(fs.readFileSync(path.join(a, 'index.html'), 'utf8').includes('<meta name="sherpa-context" content="x_pizza">'));
  assert.ok(fs.readFileSync(path.join(b, 'index.html'), 'utf8').includes('<meta name="sherpa-context" content="la_musa">'));
  ok('shared folder: xpizzakitchendisplay → kitchen-xpizza/x_pizza, lamusakitchendisplay → kitchen-lamusa/la_musa (no host classifier)');
}

// ── hash: deterministic over runtime bytes incl. the module; metadata, tests, docs excluded ────────────────────────
{
  const dir = copySite('xpizza-track');
  const b0 = S.computeBuild(dir, ['index.html']);
  assert.strictEqual(S.computeBuild(dir, ['index.html']), b0, 'deterministic');
  fs.writeFileSync(path.join(dir, 'version.json'), '{"x":1}'); fs.writeFileSync(path.join(dir, 'x.test.js'), 'x'); fs.writeFileSync(path.join(dir, 'NOTES.md'), 'x');
  fs.mkdirSync(path.join(dir, 'node_modules')); fs.writeFileSync(path.join(dir, 'node_modules', 'a.js'), 'x');
  assert.strictEqual(S.computeBuild(dir, ['index.html']), b0, 'version.json, tests, docs and node_modules do not change the build');
  fs.appendFileSync(path.join(dir, 'sherpa-client.js'), '\n');
  const b1 = S.computeBuild(dir, ['index.html']);
  assert.notStrictEqual(b1, b0, 'a change to the copied shared module changes the build');
  fs.appendFileSync(path.join(dir, 'driver-eta.js'), ' ');
  assert.notStrictEqual(S.computeBuild(dir, ['index.html']), b1, 'any runtime byte changes the build');
  ok('build hash: deterministic; runtime bytes (incl. the shared module) change it; version.json / tests / docs / node_modules do not');
}

// ── failure = UNSTAMPED, never a failed build, never partial ───────────────────────────────────────────────────────
{
  for (const [label, site, folder] of [['unknown SITE_NAME', 'nope', 'xpizza-track'], ['no SITE_NAME', undefined, 'xpizza-track'], ['wrong folder for the site', 'xpizzatrack', 'xpizza-kitchen']]) {
    const dir = copySite(folder); const before = snapshot(dir);
    const r = S.stamp(dir, { siteName: site });
    assert.strictEqual(r.ok, false, label);
    assert.deepStrictEqual(snapshot(dir), before, `${label}: the folder is byte-identical (unstamped)`);
  }
  // partial failure: the 2nd entrypoint is unwritable → the 1st is rolled back
  const dir = copySite('legal'); const before = snapshot(dir);
  fs.chmodSync(path.join(dir, 'es', 'index.html'), 0o444);
  const r = S.stamp(dir, { siteName: 'sherpa-driver-privacy' });
  fs.chmodSync(path.join(dir, 'es', 'index.html'), 0o644);
  assert.strictEqual(r.ok, false, 'an unwritable entrypoint fails the stamp');
  assert.deepStrictEqual(snapshot(dir), before, 'partial output is rolled back');
  // codex CP2 r1 S7: a PREVIOUSLY STAMPED folder (manual deploy re-run) that then fails → clean UNSTAMPED, not the old stamp
  const stampedThenUnknown = copySite('legal');
  assert.ok(S.stamp(stampedThenUnknown, { siteName: 'sherpa-driver-privacy' }).ok);
  assert.ok(fs.existsSync(path.join(stampedThenUnknown, 'version.json')));
  assert.strictEqual(S.stamp(stampedThenUnknown, { siteName: 'nope' }).ok, false);
  assert.deepStrictEqual(snapshot(stampedThenUnknown), before, '🔴 success → failed stamp leaves the clean UNSTAMPED folder (no old block, no old version.json)');
  // success → a PARTIAL write failure (the 2nd entrypoint unwritable after the 1st was re-stamped) → still clean unstamped
  const stampedThenPartial = copySite('legal');
  assert.ok(S.stamp(stampedThenPartial, { siteName: 'sherpa-driver-privacy' }).ok);
  const es = path.join(stampedThenPartial, 'es', 'index.html');
  fs.writeFileSync(es, fs.readFileSync(es, 'utf8').replace(S.STAMP_BLOCK_RE, ''));      // the 2nd entrypoint is clean…
  fs.chmodSync(es, 0o444);                                                              // …and cannot be written
  const rp = S.stamp(stampedThenPartial, { siteName: 'sherpa-driver-privacy' });
  fs.chmodSync(es, 0o644);
  assert.strictEqual(rp.ok, false);
  assert.deepStrictEqual(snapshot(stampedThenPartial), before, '🔴 success → partial-write failure leaves the clean UNSTAMPED folder');
  // an UNWRITABLE stamped file cannot be cleaned: the failure says so out loud
  const stuck = copySite('legal');
  assert.ok(S.stamp(stuck, { siteName: 'sherpa-driver-privacy' }).ok);
  fs.chmodSync(path.join(stuck, 'es', 'index.html'), 0o444);
  const rs = S.stamp(stuck, { siteName: 'nope' });
  fs.chmodSync(path.join(stuck, 'es', 'index.html'), 0o644);
  assert.ok(!rs.ok && /could NOT remove the stamp from: es\/index\.html/.test(rs.error), `an uncleanable stamp is reported (${rs.error})`);
  // the CLI exits 0 with a loud error
  const cli = path.join(ROOT, 'platform', 'stamp-version.js');
  const d2 = copySite('xpizza-track');
  let out = '';
  try { execFileSync(process.execPath, [cli], { cwd: d2, env: { ...process.env, SITE_NAME: 'unknown-site' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }); } catch (e) { assert.fail(`the CLI must exit 0 on a stamp failure (exit ${e.status})`); }
  const res2 = require('child_process').spawnSync(process.execPath, [cli], { cwd: d2, env: { ...process.env, SITE_NAME: 'unknown-site' }, encoding: 'utf8', timeout: 60000 });
  out = res2.stderr;
  assert.strictEqual(res2.status, 0); assert.ok(/SHERPA STAMP FAILED/.test(out), 'the build log carries a loud error');
  assert.ok(!fs.existsSync(path.join(d2, 'version.json')));
  const res3 = require('child_process').spawnSync(process.execPath, [cli], { cwd: d2, env: { ...process.env, SITE_NAME: 'xpizzatrack', COMMIT_REF: 'abc', CONTEXT: 'production' }, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(res3.status, 0); assert.ok(/sherpa-stamp: track-xpizza build [0-9a-f]{20} compat 1/.test(res3.stdout));
  ok('stamp failure (unknown/no SITE_NAME, wrong folder, unwritable file, and success → failed / partial re-stamp) → clean UNSTAMPED output; an uncleanable file is reported; CLI exits 0 with "SHERPA STAMP FAILED"');
}

// ── an unstamped deployment is MISSING in the owner's coverage report (ruling Q2) ─────────────────────────────────
{
  const now = Date.UTC(2026, 9, 6, 18, 30);
  const hours = R.windowHours(now, 2);
  const deps = SITES.deployments.map((d) => ({ id: d.id, app: d.app, context: d.context }));
  const stats = {};
  for (const h of hours) for (const d of deps) if (d.id !== 'track-lamusa') ((stats[h] = stats[h] || {})[d.id] = {})[d.context] = { 1: 3 };
  const h = R.aggregateHistory(stats, deps, hours, {});
  const row = h.coverage.find((c) => c.deployment === 'track-lamusa');
  assert.strictEqual(row.status, 'MISSING', '🔴 a deployment that never reports is listed MISSING');
  assert.deepStrictEqual(row.unknown_hours, hours);
  assert.ok(h.coverage.filter((c) => c.deployment !== 'track-lamusa').every((c) => c.status === 'COMPLETE'));
  const partial = R.aggregateHistory({ [hours[0]]: stats[hours[0]] }, deps, hours, {});
  assert.ok(partial.coverage.filter((c) => c.deployment !== 'track-lamusa').every((c) => c.status === 'PARTIAL'));
  assert.strictEqual(deps.length, 12, 'every manifest deployment is a coverage row');
  ok('coverage report: a deployment with no heartbeat in the window (e.g. shipped unstamped) is MISSING; partial = PARTIAL; full = COMPLETE');
}

// ── committed module copies: byte-identical (drift guard) + loaded by every entrypoint before first use ───────────
{
  const canon = fs.readFileSync(path.join(ROOT, 'platform/client/sherpa-client.js'));
  const folders = [...new Set(SITES.deployments.map((d) => d.folder))];
  for (const f of folders) assert.ok(canon.equals(fs.readFileSync(path.join(ROOT, f, 'sherpa-client.js'))), `🔴 ${f}/sherpa-client.js drifted from platform/client/ — run npm run sync:client`);
  for (const d of SITES.deployments) for (const e of d.entrypoints) {
    const html = fs.readFileSync(path.join(ROOT, d.folder, e), 'utf8');
    const rel = e.includes('/') ? '../'.repeat(e.split('/').length - 1) + 'sherpa-client.js' : 'sherpa-client.js';
    const tag = `<script src="${rel}"></script>`;
    assert.strictEqual(html.split(tag).length - 1, 1, `🔴 ${d.folder}/${e}: loads the module exactly once (${tag})`);
    const at = html.indexOf(tag);
    const firstScript = html.search(/<script\b/);
    assert.strictEqual(at, firstScript, `${d.folder}/${e}: the module is the FIRST script (loaded before any use)`);
  }
  ok(`module copies byte-identical in all ${folders.length} site folders; every entrypoint loads it once, as its first script`);
}

// ── compat.json: never lowered (vs every committed version) ────────────────────────────────────────────────────────
{
  const revs = execFileSync('git', ['log', '--format=%H', '--', 'platform/compat.json'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(revs.length >= 1);
  for (const rev of revs) {
    const old = JSON.parse(execFileSync('git', ['show', `${rev}:platform/compat.json`], { cwd: ROOT, encoding: 'utf8' }));
    for (const [app, g] of Object.entries(old.generations)) assert.ok(COMPAT.generations[app] >= g, `🔴 compat generation for ${app} lowered (${g} at ${rev.slice(0, 7)} → ${COMPAT.generations[app]})`);
  }
  // the check itself bites: a lowered generation is caught
  const lowered = { ...COMPAT.generations, orders: 0 };
  assert.ok(Object.entries(JSON.parse(execFileSync('git', ['show', `${revs[0]}:platform/compat.json`], { cwd: ROOT, encoding: 'utf8' })).generations).some(([a, g]) => lowered[a] < g));
  ok(`compat.json never lowered against all ${revs.length} committed version(s)`);
}

FINISHED = true;
console.log(`pselfupdate-stamp: OK (${n})`);
