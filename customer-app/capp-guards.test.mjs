// Customer app S1 (PLAN-capp-S1.FINAL §0, §1, §5 Guards) — the slice's standing constraints, checked against the pinned base:
//   1. no restaurant id / name in customer-app/ code (brand-agnostic: restaurants differ only in DATA)
//   2. (S2-srv-app, PLAN-capp-S2-r4 §2.2) customer-app/ is the ONE `context:"platform"` orders deployment, with exactly the
//      approved SHAPE — asserted from the manifest, never a host literal (the host is config: §2.1a)
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
// sherpa-client.js is the shared PLATFORM module, synced byte-for-byte into every manifest site (npm run sync:client); it is
// not app code, so it is exempt from the literal scan ONLY while it stays identical to platform/client/sherpa-client.js
const SYNCED = 'sherpa-client.js';
// capp-confirm-quote.js (S2a, PLAN-capp-S2-r4 §5.1 Q6) is a BYTE-IDENTICAL port of the forms' form-confirm-quote.js — its only
// restaurant mention is a comment about the forms' chrome. Exempt ONLY while it stays identical to BOTH form copies.
const PORTED = { 'capp-confirm-quote.js': ['xpizza-orders/form-confirm-quote.js', 'la-musa-orders/form-confirm-quote.js'] };
const codeFiles = () => readdirSync(join(ROOT, 'customer-app')).filter((f) => /\.(m?js|html|css)$/.test(f) && !/\.test\.m?js$/.test(f) && f !== SYNCED && !(f in PORTED));

test('no restaurant id or name in customer-app/ code', () => {
  const files = codeFiles();
  assert.ok(files.length >= 4, `premise: the S1 modules exist (${files.join(', ')})`);
  for (const f of files) {
    const hit = readFileSync(join(ROOT, 'customer-app', f), 'utf8').match(LEAK);
    assert.equal(hit, null, `🔴 ${f} carries a restaurant literal: ${hit && hit[0]}`);
  }
  assert.ok(LEAK.test("rid === 'la_musa'") && LEAK.test('X. Pizza'), 'non-vacuity: the detector fires');
  assert.ok(readFileSync(join(ROOT, 'customer-app', SYNCED)).equals(readFileSync(join(ROOT, 'platform', 'client', SYNCED))), `🔴 customer-app/${SYNCED} is not the platform copy — the literal-scan exemption no longer holds`);
  for (const [f, sources] of Object.entries(PORTED)) for (const src of sources) {
    assert.ok(readFileSync(join(ROOT, 'customer-app', f)).equals(readFileSync(join(ROOT, src))), `🔴 customer-app/${f} is not byte-identical to ${src} — the literal-scan exemption no longer holds`);
  }
});

test('customer-app/ is the one platform orders deployment, with exactly the approved shape (no host literal)', () => {
  const copies = ['platform/sites.json', 'xpizza-functions/platform/sites.json'].map((p) => readFileSync(join(ROOT, p), 'utf8'));
  assert.equal(copies[0], copies[1], 'premise: the bundled manifest is the canonical one');
  const m = JSON.parse(copies[0]);
  const app = m.deployments.filter((d) => d.app === 'orders' && d.context === 'platform');
  assert.equal(app.length, 1, '🔴 exactly one platform orders deployment');
  const d = app[0];
  assert.equal(m.deployments.filter((x) => x.folder === 'customer-app').length, 1, 'customer-app/ is deployed exactly once');
  assert.deepEqual([d.folder, d.entrypoints, d.context], ['customer-app', ['index.html', 'shell.html'], 'platform']);   // shell.html: the S7a-2 multi-store page, stamped (advisor 2026-10-27)
  assert.ok(Array.isArray(d.origins) && d.origins.length >= 1, 'declares its origin(s)');
  for (const o of d.origins) assert.equal(new URL(o).origin, o, `${o} is an exact origin`), assert.equal(new URL(o).protocol, 'https:');
  assert.deepEqual(Object.keys(d.pay_return).sort(), ['default', 'env']);
  assert.equal(d.pay_return.env, 'PIXELPAY_RETURN_URL_APP');
  assert.ok(d.origins.includes(d.pay_return.default), 'pay_return.default is one of its own origins');
  assert.ok(typeof d.netlify_site === 'string' && d.netlify_site.length > 0, 'names its Netlify site (the stamp keys on it)');
  assert.ok(existsSync(join(ROOT, 'customer-app', 'netlify.toml')), 'the build stamp is wired (netlify.toml)');
  assert.match(readFileSync(join(ROOT, 'customer-app', 'netlify.toml'), 'utf8'), /command = "node \.\.\/platform\/stamp-version\.js"/);
});

test(`the live forms are byte-unchanged vs ${BASE}`, () => {
  const changed = git('diff', '--name-only', BASE, '--', 'xpizza-orders', 'la-musa-orders').trim();
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', 'xpizza-orders', 'la-musa-orders').trim();
  assert.equal(changed, '', `🔴 live form files changed: ${changed}`);
  assert.equal(untracked, '', `🔴 new files in the live forms: ${untracked}`);
});

// PLAN-capp-S2-r4 §2.2: this guard is re-pointed per slice to that slice's EXACT allowlist. S2-srv-tip: the server files the
// tip money core + P-C change, the slice's test-only inverses, the R3 contract files it regenerated, and the mutant catalogue.
// S2-srv-app (added on top): the app deployment's manifest entry (+ bundled copy), its validator, the return resolver, the
// sync-client filter and the slice's test-only inverse.
// Colonia (PLAN-colonia r1, recomposed onto S2b-geo; added on top): the privacy filter module, the order writer's same-line hunk,
// the census FIELD_FACTS entry and the slice's test-only inverse (charge-inputs / index.js / census JSON are already listed).
const S2TIP_SERVER = new Set(['address-area.js', 'create-order-build.js', 'contract/census.js', 'tools/area-inverse.js', 'tools/area-charge-inputs-inverse.js', 'catalog/charge-inputs.js', 'compute-server-net.js', 'createorder-classify.js', 'delivery/delivery-pricing.js',
  'delivery/delivery-wire.js', 'driver-ledger/ledger-core.js', 'factura/build-record.js', 'index.js', 'order-exists.js', 'payer-email.js',
  'pixelpay-hosted-charge.js', 'quote-issue.js', 'rewards-redeem-intake.js', 'stats/stats-api.js', 'stats/stats-build.js', 'tip.js', 'whatsapp.js',
  'tools/s2tip-inverse.js', 'tools/s2tip-module-inverse.js', 'tools/mutation-sweep.mutants.json',
  'contract/census-map.json', 'contract/census.json', 'contract/regions.json',
  'platform/sites.json', 'platform-manifest.js', 'pixelpay-return-url.js', 'tools/sync-client.js', 'tools/s2app-inverse.js'].map((f) => `xpizza-functions/${f}`));
test(`no server change beyond S2-srv-tip + S2-srv-app + colonia: xpizza-functions/ differs from ${BASE} only in tests, fixtures, generated inventories, the test chain and the slices' allowlist`, () => {
  const changed = git('diff', '--name-only', BASE, '--', 'xpizza-functions').trim().split('\n').filter(Boolean)
    .concat(git('ls-files', '--others', '--exclude-standard', '--', 'xpizza-functions').trim().split('\n').filter(Boolean));
  const allowed = (p) => /\.test\.(m?js|cjs)$/.test(p) || /^xpizza-functions\/test\//.test(p) || /\.golden\.json$|\.expect\.json$/.test(p)
    || p === 'xpizza-functions/tools/form-source-inventory.json' || p === 'xpizza-functions/package.json' || S2TIP_SERVER.has(p);
  const bad = changed.filter((p) => !allowed(p));
  assert.deepEqual(bad, [], `🔴 production files changed: ${bad.join(', ')}`);
  if (changed.includes('xpizza-functions/package.json')) {
    const was = JSON.parse(git('show', `${BASE}:xpizza-functions/package.json`)); const now = JSON.parse(readFileSync(join(ROOT, 'xpizza-functions/package.json'), 'utf8'));
    const strip = (j) => { const c = { ...j, scripts: { ...j.scripts } }; delete c.scripts.test; for (const k of Object.keys(c.scripts)) if (/^test:(capp-s1|s2tip$|capp-s2a$|capp-s2a-browser$|address-area$|capp-s4$)/.test(k)) delete c.scripts[k]; return c; };
    assert.deepEqual(strip(now), strip(was), '🔴 package.json changed beyond the test chain / the capp-s1 test scripts');
  }
});

// S2b r2 (the order-intake key): the app builds the Authorization header in ONE place, and each real-handler suite keeps at least
// one cell whose headers come from the app (CappUI.mount + ctxBase), so a hand-built ctx.headers can never again hide a missing key
test('the intake key: one builder in the app, no literal; each real-handler suite has a cell through the real UI', () => {
  const ui = readFileSync(join(ROOT, 'customer-app/capp-ui.js'), 'utf8');
  assert.equal((ui.match(/Authorization/g) || []).length, 1, 'capp-ui builds the header once (intakeHeaders)');
  assert.match(ui, /const intakeHeaders = \(\) => \(\{ Authorization: 'Bearer ' \+ cfg\.intakeKey \}\);/, 'from config only');
  assert.match(ui, /c = \{ \.\.\.ctxBase\(\), headers: intakeHeaders\(\) \}/, 'and only on the placement ctx (the quote ctx stays bare)');
  for (const f of codeFiles()) assert.ok(!/Bearer [A-Za-z0-9_-]{6,}/.test(readFileSync(join(ROOT, 'customer-app', f), 'utf8')), `no key literal in ${f}`);
  for (const suite of ['xpizza-functions/test/capp-s2a.emulator.test.js', 'xpizza-functions/test/capp-domain-transition.emulator.test.js']) {
    const src = readFileSync(join(ROOT, suite), 'utf8');
    assert.match(src, /CappUI\.mount\(/, `${suite}: a cell mounts the real UI`);
    assert.match(src, /intakeKey: /, `${suite}: …with the key as config (its headers built by ctxBase)`);
  }
});
