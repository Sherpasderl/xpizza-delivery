// Customer app S1 (PLAN-capp-S1.FINAL §0, §1, §5 Guards) — the slice's standing constraints, checked against the pinned base:
//   1. no restaurant id / name in customer-app/ code (brand-agnostic: restaurants differ only in DATA)
//   2. customer-app/ stays DARK — not a manifest site (both sites.json copies), no netlify.toml
//   3. the live forms are byte-unchanged vs the base (both whole directories)
//   4. NO server change — nothing under xpizza-functions/ changes except tests, fixtures, generated inventories and the
//      package.json test chain (whose dependencies stay identical)
// Run: node --test customer-app/capp-guards.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '2ce3198d';
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
const LEAK = /x_pizza|la_musa|xpizza|lamusa|X\.? ?Pizza|La Musa/i;
const codeFiles = () => readdirSync(join(ROOT, 'customer-app')).filter((f) => /\.(m?js|html|css)$/.test(f) && !/\.test\.m?js$/.test(f));

test('no restaurant id or name in customer-app/ code', () => {
  const files = codeFiles();
  assert.ok(files.length >= 4, `premise: the S1 modules exist (${files.join(', ')})`);
  for (const f of files) {
    const hit = readFileSync(join(ROOT, 'customer-app', f), 'utf8').match(LEAK);
    assert.equal(hit, null, `🔴 ${f} carries a restaurant literal: ${hit && hit[0]}`);
  }
  assert.ok(LEAK.test("rid === 'la_musa'") && LEAK.test('X. Pizza'), 'non-vacuity: the detector fires');
});

test('customer-app/ stays dark: not a manifest site, no netlify.toml', () => {
  for (const p of ['platform/sites.json', 'xpizza-functions/platform/sites.json']) {
    const m = JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
    const folders = (m.deployments || []).map((d) => d.folder);
    assert.ok(folders.length > 0, `premise: ${p} lists deployments`);
    assert.ok(!folders.some((f) => String(f).replace(/\/$/, '') === 'customer-app'), `🔴 ${p} deploys customer-app/`);
    assert.ok(!JSON.stringify(m).includes('customer-app'), `🔴 ${p} mentions customer-app`);
  }
  assert.equal(existsSync(join(ROOT, 'customer-app', 'netlify.toml')), false, '🔴 customer-app/ has a netlify.toml');
});

test(`the live forms are byte-unchanged vs ${BASE}`, () => {
  const changed = git('diff', '--name-only', BASE, '--', 'xpizza-orders', 'la-musa-orders').trim();
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', 'xpizza-orders', 'la-musa-orders').trim();
  assert.equal(changed, '', `🔴 live form files changed: ${changed}`);
  assert.equal(untracked, '', `🔴 new files in the live forms: ${untracked}`);
});

test(`no server change: xpizza-functions/ differs from ${BASE} only in tests, fixtures, generated inventories and the test chain`, () => {
  const changed = git('diff', '--name-only', BASE, '--', 'xpizza-functions').trim().split('\n').filter(Boolean)
    .concat(git('ls-files', '--others', '--exclude-standard', '--', 'xpizza-functions').trim().split('\n').filter(Boolean));
  const allowed = (p) => /\.test\.(m?js|cjs)$/.test(p) || /^xpizza-functions\/test\//.test(p) || /\.golden\.json$|\.expect\.json$/.test(p)
    || p === 'xpizza-functions/tools/form-source-inventory.json' || p === 'xpizza-functions/package.json';
  const bad = changed.filter((p) => !allowed(p));
  assert.deepEqual(bad, [], `🔴 production files changed: ${bad.join(', ')}`);
  if (changed.includes('xpizza-functions/package.json')) {
    const was = JSON.parse(git('show', `${BASE}:xpizza-functions/package.json`)); const now = JSON.parse(readFileSync(join(ROOT, 'xpizza-functions/package.json'), 'utf8'));
    const strip = (j) => { const c = { ...j, scripts: { ...j.scripts } }; delete c.scripts.test; for (const k of Object.keys(c.scripts)) if (/^test:capp-s1/.test(k)) delete c.scripts[k]; return c; };
    assert.deepEqual(strip(now), strip(was), '🔴 package.json changed beyond the test chain / the capp-s1 test scripts');
  }
});
