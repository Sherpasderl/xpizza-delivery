// Customer app S1 (PLAN-capp-S1.FINAL §0, §1, §5 Guards) — the slice's standing constraints, checked against the pinned base:
//   1. no restaurant id / name in customer-app/ code (brand-agnostic: restaurants differ only in DATA)
//   2. (S2-srv-app, PLAN-capp-S2-r4 §2.2) customer-app/ is the ONE `context:"platform"` orders deployment, with exactly the
//      approved SHAPE — asserted from the manifest, never a host literal (the host is config: §2.1a)
//   3. the live forms are byte-unchanged by the capp range (both whole directories)
//   4. NO server change — nothing under xpizza-functions/ changes except tests, fixtures, generated inventories and the
//      package.json test chain (whose dependencies stay identical)
// 3 and 4 are proven over the capp lane's OWN commit range, never the live tree (the portal/slice2-untouched precedent): at an
// assembled tip, other approved slices legitimately change those files, and that is not this lane's change.
//   RANGE: BASE 2ce3198d → CAPP_TIP 927acf22 (capp G7 batch + the S3c module inverse + its regenerated form-source inventory + the
//   native shell N1–N2 + readAvailability). A later capp commit that touches the live
//   forms or xpizza-functions/ re-points CAPP_TIP to itself. Fails closed: both resolve, BASE ⊑ CAPP_TIP ⊑ HEAD, git answers.
//   SELF-ENFORCING (Codex capp-tail r1 P2): any commit after CAPP_TIP that touches customer-app/ FAILS the range until CAPP_TIP is
//   re-pointed — a later capp commit can never escape the scope checks. This file alone is exempt (a re-pin cannot name itself);
//   a commit touching it AND anything else under customer-app/ is still caught. At an assembled tip (advisor ruling, 2e dry run):
//   MERGE commits are not capp commits (--no-merges), and the files tools/sync-client.js WRITES into customer-app/ are another
//   lane's synced copies — excluded, their list derived by running sync-client itself against a recording fs (never a hand list),
//   and each is asserted BYTE-IDENTICAL to its source, so the exclusion can never hide an edit.
//   MERGED-IN history is not this lane's either (--first-parent): a merge of main brings main's own capp commits (already gated
//   by main's pin) into CAPP_TIP..HEAD, and no single CAPP_TIP can cover both parents without pulling main's server work into
//   BASE..CAPP_TIP. Every commit made ON this branch is still on the first-parent chain, so none escapes the re-pin.
// Run: node --test customer-app/capp-guards.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import * as nodePath from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '2ce3198d';
const CAPP_TIP = '4aa89a55';
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
// git paths NUL-delimited (-z): a quoted non-ASCII path would never match a blob lookup (Codex r1 P2-3)
const paths = (out) => out.split('\0').filter(Boolean);
// byte identity, null-safe: a missing copy is a named failure, not an ENOENT before the named assertion (Codex r1 P3)
const sameBytes = (a, b) => existsSync(join(ROOT, a)) && existsSync(join(ROOT, b)) && readFileSync(join(ROOT, a)).equals(readFileSync(join(ROOT, b)));
const isAncestor = (a, b) => { try { git('merge-base', '--is-ancestor', a, b); return true; } catch (_) { return false; } };
// the files tools/sync-client.js copies INTO customer-app/ — read from sync-client itself (run against a recording fs; nothing written)
const syncedIntoApp = () => {
  const tool = join(ROOT, 'xpizza-functions', 'tools', 'sync-client.js'), real = createRequire(tool), copies = [];
  const fsRec = { copyFileSync: (src, dst) => copies.push([String(src), String(dst)]) };
  vm.runInNewContext(readFileSync(tool, 'utf8'), { require: (id) => (id === 'fs' || id === 'node:fs' ? fsRec : id === 'path' || id === 'node:path' ? nodePath : real(id)),
    __dirname: dirname(tool), __filename: tool, module: { exports: {} }, exports: {}, console: { log() {} } }, { filename: tool });
  const rel = (p) => relative(ROOT, p).split(sep).join('/');
  assert.ok(copies.length > 0, 'premise: sync-client was read (it copies files)');
  const into = copies.map(([s, d]) => ({ src: rel(s), dst: rel(d) })).filter(({ dst }) => dst.startsWith('customer-app/'));
  assert.ok(into.some(({ dst }) => dst === 'customer-app/sherpa-client.js'), 'non-vacuity: sync-client writes customer-app/sherpa-client.js');
  return into;
};
const capRange = () => {
  for (const sha of [BASE, CAPP_TIP]) assert.equal(git('cat-file', '-t', sha).trim(), 'commit', `🔴 ${sha} is not a commit`);
  assert.ok(isAncestor(BASE, CAPP_TIP), `🔴 ${BASE} is not an ancestor of ${CAPP_TIP} — not the capp range`);
  assert.ok(isAncestor(CAPP_TIP, 'HEAD'), `🔴 ${CAPP_TIP} is not in HEAD's history — the capp range is not part of this tree`);
  const synced = syncedIntoApp();
  for (const { src, dst } of synced) assert.ok(sameBytes(dst, src), `🔴 ${dst} is a sync-client copy but differs from (or is missing beside) its source ${src} — an edit hidden in a synced file`);
  // the lane's first-parent commits AND every descendant of the pin (--ancestry-path): a lane commit after the pin that comes in as a
  // merge's SECOND parent (the assembly shape) is off the first-parent chain, and the merge equals that parent, so neither the
  // first-parent walk nor the evil-merge cell would see it (Codex r1 P2-1). Main's own merged-in history is not a descendant of the pin.
  // Both ranges are listed WITHOUT a pathspec (Codex r2 P2-1): a path-limited walk applies git's history simplification, which drops a
  // merge's side when the merge is TREESAME to a parent for that path; each listed commit's OWN paths are then filtered here.
  const skip = new Set(['customer-app/capp-guards.test.mjs', ...synced.map(({ dst }) => dst)]);
  const touched = (range) => git('log', '--no-merges', '--no-renames', '--name-only', '-z', '--format=%x01%h %s', ...range).split('\x01').filter(Boolean)
    .map((rec) => { const [head, ...files] = rec.split('\0'); const [subject, first] = head.split('\n'); return { subject, files: [first, ...files].map((f) => (f || '').replace(/^\n+/, '')).filter(Boolean) }; })
    .filter(({ files }) => files.some((f) => f.startsWith('customer-app/') && !skip.has(f))).map(({ subject }) => subject);
  const later = [...new Set([...touched(['--first-parent', `${CAPP_TIP}..HEAD`]), ...touched(['--ancestry-path', `${CAPP_TIP}..HEAD`])])].join('\n');
  assert.equal(later, '', `🔴 capp commit(s) after CAPP_TIP ${CAPP_TIP} — re-point CAPP_TIP to the newest of them:\n${later}`);
  return [BASE, CAPP_TIP];
};
// THIS LANE's changes (advisor ruling 11-07, after the merge of main): the range cells take their changed-file set from the lane only —
// every NON-merge commit on the first-parent chain BASE..upTo, plus every path a first-parent MERGE's resolution wrote itself (its blob
// differs from EVERY parent's: equal to parent 2 = the merged-in line's own change, equal to parent 1 = untouched). ONE helper, shared
// with the evil-merge cell below. A plain BASE..CAPP_TIP diff would count all of main's merged-in work as this lane's.
const blobAt = (rev, f) => { try { return git('rev-parse', '-q', '--verify', `${rev}:${f}`).trim(); } catch (_) { return null; } };
const resolutionEdits = (upTo, scopes) => {
  const out = [];
  for (const m of git('rev-list', '--first-parent', '--merges', `${BASE}..${upTo}`).trim().split('\n').filter(Boolean)) {
    const parents = git('log', '-1', '--format=%P', m).trim().split(' ').filter(Boolean);
    for (const f of paths(git('diff', '--no-renames', '--name-only', '-z', `${m}^1`, m, '--', ...scopes))) {
      const b = blobAt(m, f);
      if (parents.every((p) => blobAt(p, f) !== b)) out.push({ m, f });
    }
  }
  return out;
};
const laneCommits = (upTo, scopes) => git('log', '--first-parent', '--no-merges', '--format=%H', `${BASE}..${upTo}`, '--', ...scopes).trim().split('\n').filter(Boolean);
// --no-renames: a rename reports BOTH paths, so a server file moved into test/ still counts as a server change (Codex r1 P2-2)
const laneChanged = (upTo, scopes) => [...new Set(paths(git('log', '--first-parent', '--no-merges', '--no-renames', '--name-only', '-z', '--format=', `${BASE}..${upTo}`, '--', ...scopes)).map((f) => f.replace(/^\n+/, ''))
  .concat(resolutionEdits(upTo, scopes).map(({ f }) => f)))].sort();
const LEAK = /x_pizza|la_musa|xpizza|lamusa|X\.? ?Pizza|La Musa/i;
// sherpa-client.js is the shared PLATFORM module, synced byte-for-byte into every manifest site (npm run sync:client); it is
// not app code, so it is exempt from the literal scan ONLY while it stays identical to platform/client/sherpa-client.js
const SYNCED = 'sherpa-client.js';
// capp-confirm-quote.js (S2a, PLAN-capp-S2-r4 §5.1 Q6) is a BYTE-IDENTICAL port of the forms' form-confirm-quote.js — its only
// restaurant mention is a comment about the forms' chrome. Exempt ONLY while it stays identical to BOTH form copies.
// «Pedido recibido» (advisor rulings 2026-11-01, one source): the tracker's words and S5's window / order number, byte copies
const PORTED = { 'capp-confirm-quote.js': ['xpizza-orders/form-confirm-quote.js', 'la-musa-orders/form-confirm-quote.js'],
  'status-view.js': ['xpizza-track/status-view.js', 'xpizza-orders/status-view.js', 'la-musa-orders/status-view.js'],
  'form-live-status.js': ['xpizza-orders/form-live-status.js', 'la-musa-orders/form-live-status.js'],
  'form-order-number.js': ['xpizza-orders/form-order-number.js', 'la-musa-orders/form-order-number.js'] };
// PLAN-avail-identity: EVERY file tools/sync-client.js writes into customer-app/ (sherpa-client.js, avail-key.js,
// availability-reducer.js) is another surface's canonical copy — exempt from the literal scan, and pinned byte-identical to its
// source by the range guard below (syncedIntoApp), so the exemption can never hide an edit. Read lazily (syncedIntoApp is below).
const syncedNames = () => new Set(syncedIntoApp().map(({ dst }) => dst.replace(/^customer-app\//, '')));
const codeFiles = () => { const sy = syncedNames(); return readdirSync(join(ROOT, 'customer-app')).filter((f) => /\.(m?js|html|css)$/.test(f) && !/\.test\.m?js$/.test(f) && f !== SYNCED && !sy.has(f) && !(f in PORTED)); };

test('no restaurant id or name in customer-app/ code', () => {
  const files = codeFiles();
  assert.ok(files.length >= 4, `premise: the S1 modules exist (${files.join(', ')})`);
  for (const f of files) {
    const hit = readFileSync(join(ROOT, 'customer-app', f), 'utf8').match(LEAK);
    assert.equal(hit, null, `🔴 ${f} carries a restaurant literal: ${hit && hit[0]}`);
  }
  assert.ok(LEAK.test("rid === 'la_musa'") && LEAK.test('X. Pizza'), 'non-vacuity: the detector fires');
  assert.ok(sameBytes(`customer-app/${SYNCED}`, `platform/client/${SYNCED}`), `🔴 customer-app/${SYNCED} is not the platform copy — the literal-scan exemption no longer holds`);
  for (const [f, sources] of Object.entries(PORTED)) for (const src of sources) {
    assert.ok(sameBytes(`customer-app/${f}`, src), `🔴 customer-app/${f} is not byte-identical to (or is missing beside) ${src} — the literal-scan exemption no longer holds`);
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
  // PLAN-capp-desktop-website D-1 (advisor ruling 2026-11-01): the site is built by the ONE shell packager's WEB target (it stamps
  // + writes version.json itself), fail-closed, published from dist/. assert.ok (never assert.match): the toml carries the public
  // key omit list, and a failure must not dump it
  const toml = readFileSync(join(ROOT, 'customer-app', 'netlify.toml'), 'utf8');
  assert.ok(/command = "node \.\.\/platform\/native\/package-capp\.js --target web --env \$CONTEXT --sha \$COMMIT_REF --out dist --flags guestCardOnly"/.test(toml), '🔴 customer-app/netlify.toml must build with the shell packager\'s web target');
  assert.ok(/^\s*publish = "dist"$/m.test(toml), '🔴 customer-app/netlify.toml must publish dist/');
});

test(`the live forms are byte-unchanged by the capp range ${BASE}..${CAPP_TIP}`, () => {
  const [, tip] = capRange(), changed = laneChanged(tip, ['xpizza-orders', 'la-musa-orders']).join(', ');
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
// S3c module inverse (capp G7, added on top): the slice's test-only inverse of whatsapp.js (tools/s3c-module-inverse.js).
// Native shell N1/N1b/D3 (PLAN-capp-native-shell §1.1, advisor D1–D3; added on top): the manifest validator + its native / runtime
// blocks (platform-manifest.js, platform/sites.json — already listed) and the per-deployment version floor (client-floor.js).
// The FULL light chain's guard debts (advisor 11-02, added on top): the R3 applicability pin contract/region-applicability.json — a
// comment re-pin of chargeOnlineOrder's count in client-floor.js (its sibling contract/regions.json is already listed).
const S2TIP_SERVER = new Set(['address-area.js', 'create-order-build.js', 'contract/census.js', 'tools/area-inverse.js', 'tools/area-charge-inputs-inverse.js', 'catalog/charge-inputs.js', 'compute-server-net.js', 'createorder-classify.js', 'delivery/delivery-pricing.js',
  'delivery/delivery-wire.js', 'driver-ledger/ledger-core.js', 'factura/build-record.js', 'index.js', 'order-exists.js', 'payer-email.js',
  'pixelpay-hosted-charge.js', 'quote-issue.js', 'rewards-redeem-intake.js', 'stats/stats-api.js', 'stats/stats-build.js', 'tip.js', 'whatsapp.js',
  'tools/s2tip-inverse.js', 'tools/s2tip-module-inverse.js', 'tools/mutation-sweep.mutants.json',
  'contract/census-map.json', 'contract/census.json', 'contract/regions.json',
  'platform/sites.json', 'platform-manifest.js', 'pixelpay-return-url.js', 'tools/sync-client.js', 'tools/s2app-inverse.js',
  'tools/s3c-module-inverse.js', 'client-floor.js', 'contract/region-applicability.json'].map((f) => `xpizza-functions/${f}`));
test(`no server change beyond S2-srv-tip + S2-srv-app + colonia: the capp range ${BASE}..${CAPP_TIP} changes xpizza-functions/ only in tests, fixtures, generated inventories, the test chain and the slices' allowlist`, () => {
  const [, tip] = capRange();
  const changed = laneChanged(tip, ['xpizza-functions'])
    .concat(git('ls-files', '--others', '--exclude-standard', '--', 'xpizza-functions').trim().split('\n').filter(Boolean));
  const allowed = (p) => /\.test\.(m?js|cjs)$/.test(p) || /^xpizza-functions\/test\//.test(p) || /\.golden\.json$|\.expect\.json$/.test(p)
    || p === 'xpizza-functions/tools/form-source-inventory.json' || p === 'xpizza-functions/package.json' || S2TIP_SERVER.has(p);
  const bad = changed.filter((p) => !allowed(p));
  assert.deepEqual(bad, [], `🔴 production files changed: ${bad.join(', ')}`);
  if (changed.includes('xpizza-functions/package.json')) {
    const PKG = 'xpizza-functions/package.json', at = (rev) => { const b = blobAt(rev, PKG); return b ? JSON.parse(git('show', `${rev}:${PKG}`)) : null; };
    const strip = (j) => { if (!j) return null; const c = { ...j, scripts: { ...j.scripts } }; delete c.scripts.test; for (const k of Object.keys(c.scripts)) if (/^test:(capp-s1|s2tip$|capp-s2a$|capp-s2a-browser$|address-area$|capp-s4$)/.test(k)) delete c.scripts[k]; return c; };
    // each lane commit changes it only in the test chain / the capp test scripts; a merge resolution takes ONE parent's rest verbatim
    for (const c of laneCommits(tip, [PKG])) assert.deepEqual(strip(at(c)), strip(at(`${c}^1`)), `🔴 package.json changed beyond the test chain / the capp-s1 test scripts in ${c.slice(0, 8)}`);
    for (const { m } of resolutionEdits(tip, [PKG])) {
      const parents = git('log', '-1', '--format=%P', m).trim().split(' ').filter(Boolean), now = JSON.stringify(strip(at(m)));
      assert.ok(parents.some((p) => JSON.stringify(strip(at(p))) === now), `🔴 the merge ${m.slice(0, 8)} resolved package.json beyond the test chain (its rest matches no parent)`);
    }
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

// EVIL MERGES (advisor ruling 11-07): «later» skips merge commits (--no-merges), so a capp edit made INSIDE a merge resolution would
// escape it. For each first-parent merge in BASE..HEAD, a customer-app/ path whose blob differs from EVERY parent's was written by
// the resolution itself (equal to parent 2 = the merged-in line's own change; equal to parent 1 = untouched). The sync-client and
// PORTED copies are exempt (their byte-identity checks own them, re-asserted here); any other hit must sit in MERGE_ALLOW, keyed
// «<merge sha8> <path>», with a one-line reason — reviewed, and an entry that no longer hits is stale and fails.
const MERGE_ALLOW = {};
test(`no capp edit hidden in a merge resolution: first-parent merges in ${BASE}..HEAD`, () => {
  const synced = syncedIntoApp(), exempt = new Set([...synced.map(({ dst }) => dst), ...Object.keys(PORTED).map((f) => `customer-app/${f}`)]);
  for (const { src, dst } of synced) assert.ok(sameBytes(dst, src), `🔴 ${dst} differs from (or is missing beside) its source ${src} — the merge exemption no longer holds`);
  for (const [f, sources] of Object.entries(PORTED)) for (const src of sources) assert.ok(sameBytes(`customer-app/${f}`, src), `🔴 customer-app/${f} differs from (or is missing beside) ${src} — the merge exemption no longer holds`);
  const hits = resolutionEdits('HEAD', ['customer-app/']).filter(({ f }) => !exempt.has(f)).map(({ m, f }) => `${m.slice(0, 8)} ${f}`);
  const unlisted = hits.filter((h) => !(h in MERGE_ALLOW)), stale = Object.keys(MERGE_ALLOW).filter((k) => !hits.includes(k));
  assert.equal(unlisted.join('\n'), '', `🔴 customer-app/ edit(s) made in a merge resolution (differ from every parent; not in MERGE_ALLOW):\n${unlisted.join('\n')}`);
  assert.equal(stale.join('\n'), '', `🔴 stale MERGE_ALLOW entr(ies) — no longer a resolution edit:\n${stale.join('\n')}`);
});
