// Customer app S1 (PLAN-capp-S1.FINAL §0, §1, §5 Guards) — the slice's standing constraints, checked against the pinned base:
//   1. no restaurant id / name in customer-app/ code (brand-agnostic: restaurants differ only in DATA)
//   2. (S2-srv-app, PLAN-capp-S2-r4 §2.2) customer-app/ is the ONE `context:"platform"` orders deployment, with exactly the
//      approved SHAPE — asserted from the manifest, never a host literal (the host is config: §2.1a)
//   3. the live forms are byte-unchanged by the capp range (both whole directories)
//   4. NO server change — nothing under xpizza-functions/ changes except tests, fixtures, generated inventories and the
//      package.json test chain (whose dependencies stay identical)
// 3 and 4 are proven over the capp lane's OWN commit range, never the live tree (the portal/slice2-untouched precedent): at an
// assembled tip, other approved slices legitimately change those files, and that is not this lane's change.
//   RANGE: BASE 1d862e17 → CAPP_TIP (the D4 client lane, feat/capp-d4-client). BASE was 2ce3198d through the S1–S4 / S3 lanes; that whole
//   range (to 1cd083e4) has LANDED on main, and on main's first-parent line the old base now spans other lanes' own non-merge commits
//   (asm trains, sdk-d4), which are not this lane's change — so a lane forked from main re-bases the range at its fork point (advisor
//   ruling 11-12, option (a); proven to still bite with planted form / payments commits). A later capp commit that touches the live
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
import { readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import * as nodePath from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// BASE → 31f05c8a4 (advisor 11-18, ruling (A); feat/capp-direcciones-r2, rebuilt on it): a capp lane cut from post-asm11 main pins its OWN range — BASE = its merge base with
// origin/main as a LITERAL sha (never computed at run time, so the guard cannot drift lax), CAPP_TIP = the lane tip. The offers-r20 /
// push pins (827373d6..2b4aae89) and their merges landed on main with asm11 and sit below BASE now (MERGE_ALLOW pruned to above BASE).
// BASE → fd205309a (asm14, advisor ruling (A) 11-24): feat/capp-asm14 is cut from the asm13 tip fd205309a (train 18efaf24a + the asm13
// re-pin), so it pins its OWN range from that cut point — a pin on the train line would pull the asm12/asm13 trains into the lane range.
// Both are FULL commit ids, never a prefix (Codex #288: an 8-char prefix can name two commits or be shadowed by a ref).
// BASE → eb177fe58 (asm14 rebase, advisor 11-24): asm13 FINAL (ALL GREEN) is eb177fe58 (fd205309a + the cell-23 peel 26bc641f3 + its
// inventory regen); the lane is rebased onto it (no file overlap) and pins its range from that new cut point, same shape.
// CAPP_TIP → 47a90c9b1: C-7 multi-tab (feat/capp-c7-multitab), a capp commit after the pin.
const BASE = 'eb177fe58002bde86dfa29247229284ecf449eca';
const CAPP_TIP = '47a90c9b186a95f7c8f97bb809760a2b88ca162b';
// ASSEMBLY STEPS (asm11 step 4, advisor 11-17): a capp commit made ON THE TRAIN line, before the lane's merge — it can't be the pin (a pin on
// the train line pulls the train into the lane range). Each is listed by full sha with its EXACT file set: excused from the «after the pin» walk
// only while that set is unchanged, and only while it is in HEAD's history (a step that left the tree is a stale entry). None touches a live
// form or xpizza-functions/ code (the mutant registry is test data), so the range cells (live forms, server change) lose nothing. The same
// shape holds a capp commit stacked on MAIN after a deploy (advisor 11-17: fix/capp-pay-labels from 31f05c8a4): main's first-parent line is the train.
// Lanes cut from 31f05c8a4 each carry their own BASE / CAPP_TIP: at the train their pins collide — assembly resolves them here, per
// ASSEMBLY_STEPS, and the NEWEST lane tip wins the pin (advisor 11-18).
const ASSEMBLY_STEPS = {
  '792a3dde73e0bff5181c4082c0e0a6a291afbd02': ['customer-app/capp-s7a2.test.mjs', 'customer-app/fixtures/s7a2/directory.json', 'customer-app/fixtures/s7a2/gen-directory.mjs', 'review/capp-sbs/scenes-fx.mjs'],
  '275dcaf2668dd980f8ef15dd11382524c746f7b8': ['customer-app/capp-ui.test.mjs', 'customer-app/capp.css', 'xpizza-functions/tools/mutation-sweep.mutants.json'],   // pay labels (MOCKUP-capp-pay-labels r0)
  'b1a95926a59c50fd3a79e9b39f2dd5198d5e2602': ['customer-app/capp-s7a2.test.mjs', 'customer-app/fixtures/s7a2/directory.json', 'customer-app/fixtures/s7a2/gen-directory.mjs'],   // s7a2 alignment (the real pricing writer + view)
  'cfc688d868156e7b0c6e6af5039a2ea8d3da9c04': ['customer-app/capp-s7a2.test.mjs'],   // Codex #127 P2 (the counterfactual containment)
};
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
// git paths NUL-delimited (-z): a quoted non-ASCII path would never match a blob lookup (Codex r1 P2-3)
const paths = (out) => out.split('\0').filter(Boolean);
// byte identity, null-safe: a missing copy is a named failure, not an ENOENT before the named assertion (Codex r1 P3)
const sameBytes = (a, b) => existsSync(join(ROOT, a)) && existsSync(join(ROOT, b)) && readFileSync(join(ROOT, a)).equals(readFileSync(join(ROOT, b)));
const isAncestor = (a, b) => { try { git('merge-base', '--is-ancestor', a, b); return true; } catch (_) { return false; } };
// the files tools/sync-client.js copies INTO customer-app/ — read from sync-client itself (run against a recording fs; nothing written)
const syncedIntoApp = () => {
  const tool = join(ROOT, 'xpizza-functions', 'tools', 'sync-client.js'), real = createRequire(tool), copies = [];
  // asm13 merge (cross-lane, test-only): Ayuda db1ad78b1 made sync-client also GENERATE xpizza-portal/support-contact.js (writeFileSync);
  // the recording fs records that write too (nothing is written) and a generated write into customer-app/ is refused below
  const writes = [];
  const fsRec = { copyFileSync: (src, dst) => copies.push([String(src), String(dst)]), writeFileSync: (dst) => writes.push(String(dst)) };
  vm.runInNewContext(readFileSync(tool, 'utf8'), { require: (id) => (id === 'fs' || id === 'node:fs' ? fsRec : id === 'path' || id === 'node:path' ? nodePath : real(id)),
    __dirname: dirname(tool), __filename: tool, module: { exports: {} }, exports: {}, console: { log() {} } }, { filename: tool });
  const rel = (p) => relative(ROOT, p).split(sep).join('/');
  assert.ok(copies.length > 0, 'premise: sync-client was read (it copies files)');
  const into = copies.map(([s, d]) => ({ src: rel(s), dst: rel(d) })).filter(({ dst }) => dst.startsWith('customer-app/'));
  assert.deepEqual(writes.map(rel).filter((d) => d.startsWith('customer-app/')), [], '🔴 sync-client GENERATES a file into customer-app/ (not a byte copy): name it here before it ships');
  assert.ok(into.some(({ dst }) => dst === 'customer-app/sherpa-client.js'), 'non-vacuity: sync-client writes customer-app/sherpa-client.js');
  return into;
};
const capRange = (head = 'HEAD') => {
  for (const sha of [BASE, CAPP_TIP]) assert.equal(git('cat-file', '-t', sha).trim(), 'commit', `🔴 ${sha} is not a commit`);
  assert.ok(isAncestor(BASE, CAPP_TIP), `🔴 ${BASE} is not an ancestor of ${CAPP_TIP} — not the capp range`);
  assert.ok(isAncestor(CAPP_TIP, head), `🔴 ${CAPP_TIP} is not in ${head}'s history — the capp range is not part of this tree`);
  const synced = syncedIntoApp();
  for (const { src, dst } of synced) assert.ok(sameBytes(dst, src), `🔴 ${dst} is a sync-client copy but differs from (or is missing beside) its source ${src} — an edit hidden in a synced file`);
  // the lane's first-parent commits AND every descendant of the pin (--ancestry-path): a lane commit after the pin that comes in as a
  // merge's SECOND parent (the assembly shape) is off the first-parent chain, and the merge equals that parent, so neither the
  // first-parent walk nor the evil-merge cell would see it (Codex r1 P2-1). Main's own merged-in history is not a descendant of the pin.
  // Both ranges are listed WITHOUT a pathspec (Codex r2 P2-1): a path-limited walk applies git's history simplification, which drops a
  // merge's side when the merge is TREESAME to a parent for that path; each listed commit's OWN paths are then filtered here.
  const skip = new Set(['customer-app/capp-guards.test.mjs', ...synced.map(({ dst }) => dst)]);
  for (const sha of Object.keys(ASSEMBLY_STEPS)) assert.ok(isAncestor(sha, 'HEAD'), `🔴 stale ASSEMBLY_STEPS entry ${sha.slice(0, 9)} — not in HEAD's history`);
  const stepOk = (sha, files) => !!ASSEMBLY_STEPS[sha] && [...files].sort().join('\n') === [...ASSEMBLY_STEPS[sha]].sort().join('\n');
  const touched = (range) => git('log', '--no-merges', '--no-renames', '--name-only', '-z', '--format=%x01%H %s', ...range).split('\x01').filter(Boolean)
    .map((rec) => { const [head, ...files] = rec.split('\0'); const [line, first] = head.split('\n'); const sha = line.slice(0, 40);
      return { sha, subject: `${sha.slice(0, 9)}${line.slice(40)}`, files: [first, ...files].map((f) => (f || '').replace(/^\n+/, '')).filter(Boolean) }; })
    .filter(({ sha, files }) => !stepOk(sha, files) && files.some((f) => f.startsWith('customer-app/') && !skip.has(f))).map(({ subject }) => subject);
  const later = [...new Set([...touched(['--first-parent', `${CAPP_TIP}..${head}`]), ...touched(['--ancestry-path', `${CAPP_TIP}..${head}`])])].join('\n');
  assert.equal(later, '', `🔴 capp commit(s) after CAPP_TIP ${CAPP_TIP} — re-point CAPP_TIP to the newest of them:\n${later}`);
  return [BASE, CAPP_TIP];
};
// THIS LANE's changes (advisor ruling 11-07, after the merge of main): the range cells take their changed-file set from the lane only —
// every NON-merge commit on the first-parent chain BASE..upTo, plus every path a first-parent MERGE's resolution wrote itself (its blob
// differs from EVERY parent's: equal to parent 2 = the merged-in line's own change, equal to parent 1 = untouched). ONE helper, shared
// with the evil-merge cell below. A plain BASE..CAPP_TIP diff would count all of main's merged-in work as this lane's.
const blobAt = (rev, f) => { try { return git('rev-parse', '-q', '--verify', `${rev}:${f}`).trim(); } catch (_) { return null; } };
const resolutionEdits = (upTo, scopes, range = ['--first-parent', `${BASE}..${upTo}`]) => {
  const out = [];
  for (const m of git('rev-list', '--merges', ...range).trim().split('\n').filter(Boolean)) {
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

// PLAN-capp-picker-served-countries r1: phone-countries.js (the dual-mode tail only — PS-0 pins its node exports) is ALSO the app's
// served list: a sync-client copy (byte-pinned by capRange), loaded by the shell BEFORE capp-phone.js reads its global
test('PS-sync: the pickers\' served list is the server\'s phone-countries.js, synced byte for byte and loaded before capp-phone.js', () => {
  assert.ok(syncedIntoApp().some(({ src, dst }) => src === 'xpizza-functions/phone-countries.js' && dst === 'customer-app/phone-countries.js'), '🔴 PS-sync: sync-client copies the server list into the app');
  assert.ok(sameBytes('customer-app/phone-countries.js', 'xpizza-functions/phone-countries.js'), '🔴 PS-sync: the copy is byte-identical');
  const src = [...readFileSync(join(ROOT, 'customer-app/shell.html'), 'utf8').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(src.includes('phone-countries.js') && src.indexOf('phone-countries.js') < src.indexOf('capp-phone.js'), '🔴 PS-sync: the shell loads it before capp-phone.js');
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
  // owner 11-14 (PLAN-capp-web-signin r0, accepted): members sign in on the WEBSITE — the web build carries `signup` (phone + WhatsApp)
  assert.ok(/command = "node \.\.\/platform\/native\/package-capp\.js --target web --env \$CONTEXT --sha \$COMMIT_REF --out dist --flags guestCardOnly,signup"/.test(toml), '🔴 customer-app/netlify.toml must build with the shell packager\'s web target, member sign-in ON (owner 11-14)');
  assert.ok(/^\s*publish = "dist"$/m.test(toml), '🔴 customer-app/netlify.toml must publish dist/');
});

// S3 (the owner's rule-40 exception for the two order forms, 11-08; D4c-grill/item-s1/S3-DESIGN.md D3): the ONLY form change the capp
// range may carry is the item_key slice, and EXACTLY its hunks — every lane commit that touches the forms changes only S3_FORM_FILES,
// and at the tip each such file minus the S3 hunks (xpizza-functions/tools/item-s3-forms-inverse.js: each hunk once, or it throws) is
// byte-identical to that file just before the FIRST S3 commit. Anything else in the forms is still a red.
const S3_FORM_FILES = { 'xpizza-orders/index.html': 'xpizza-orders', 'la-musa-orders/index.html': 'la-musa-orders',
  'xpizza-orders/form-serial-order.js': 'form-serial-order', 'la-musa-orders/form-serial-order.js': 'form-serial-order',
  'xpizza-orders/account.js': 'account', 'la-musa-orders/account.js': 'account',
  'xpizza-orders/form-identity-strip.copy.test.mjs': 'identity-strip-copy' };   // r3: the guard counts the payload check's projection
test(`the live forms are byte-unchanged by the capp range ${BASE}..${CAPP_TIP} — except EXACTLY the S3 item_key hunks`, () => {
  const [, tip] = capRange(), changed = laneChanged(tip, ['xpizza-orders', 'la-musa-orders']);
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', 'xpizza-orders', 'la-musa-orders').trim();
  assert.equal(changed.filter((f) => !(f in S3_FORM_FILES)).join(', '), '', `🔴 live form files changed: ${changed.join(', ')}`);
  assert.equal(untracked, '', `🔴 new files in the live forms: ${untracked}`);
  const commits = laneCommits(tip, ['xpizza-orders', 'la-musa-orders']);
  if (!commits.length) return;
  const { unapplyItemS3Forms } = createRequire(import.meta.url)(join(ROOT, 'xpizza-functions/tools/item-s3-forms-inverse.js'));
  const before = `${commits[commits.length - 1]}^1`;   // just before the FIRST S3 commit (git log lists newest first)
  for (const f of changed) {
    assert.equal(unapplyItemS3Forms(S3_FORM_FILES[f], git('show', `${tip}:${f}`)), git('show', `${before}:${f}`), `🔴 ${f} changed beyond EXACTLY the S3 hunks`);
  }
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
// Tip step FULL light (advisor 11-09, added on top): the inventory generator skips the repo-root review/ tree (= train asm4 908df7df's
// tool hunk), so review/capp-sbs never reaches the generated inventory (test tooling; never deployed).
// S3 item_key (D4c-grill/item-s1/S3-DESIGN.md D3, added on top): the forms' exact-hunk inverse (test tooling) and the timer-bounds
// pins of the form timers the S3 lines moved (contract/timer-bounds.json; call texts and bounds unchanged) and the reviewed region
// registry's entries for the S3 call sites (contract/outputs/registry.json).
const S2TIP_SERVER = new Set(['address-area.js', 'create-order-build.js', 'contract/census.js', 'tools/area-inverse.js', 'tools/area-charge-inputs-inverse.js', 'catalog/charge-inputs.js', 'compute-server-net.js', 'createorder-classify.js', 'delivery/delivery-pricing.js',
  'delivery/delivery-wire.js', 'driver-ledger/ledger-core.js', 'factura/build-record.js', 'index.js', 'order-exists.js', 'payer-email.js',
  'pixelpay-hosted-charge.js', 'quote-issue.js', 'rewards-redeem-intake.js', 'stats/stats-api.js', 'stats/stats-build.js', 'tip.js', 'whatsapp.js',
  'tools/s2tip-inverse.js', 'tools/s2tip-module-inverse.js', 'tools/mutation-sweep.mutants.json',
  'contract/census-map.json', 'contract/census.json', 'contract/regions.json',
  'platform/sites.json', 'platform-manifest.js', 'pixelpay-return-url.js', 'tools/sync-client.js', 'tools/s2app-inverse.js',
  'tools/s3c-module-inverse.js', 'client-floor.js', 'phone-countries.js', 'contract/region-applicability.json', 'tools/form-source-inventory.js', 'tools/item-s3-forms-inverse.js', 'contract/timer-bounds.json', 'contract/outputs/registry.json'].map((f) => `xpizza-functions/${f}`));
test(`no server change beyond S2-srv-tip + S2-srv-app + colonia: the capp range ${BASE}..${CAPP_TIP} changes xpizza-functions/ only in tests, fixtures, generated inventories, the test chain and the slices' allowlist`, () => {
  const [, tip] = capRange();
  const changed = laneChanged(tip, ['xpizza-functions'])
    .concat(git('ls-files', '--others', '--exclude-standard', '--', 'xpizza-functions').trim().split('\n').filter(Boolean));
  const allowed = (p) => /\.test\.(m?js|cjs)$/.test(p) || /^xpizza-functions\/test\//.test(p) || /\.golden\.json$|\.expect\.json$/.test(p)
    || p === 'xpizza-functions/tools/form-source-inventory.json' || p === 'xpizza-functions/package.json' || S2TIP_SERVER.has(p)
    || p === 'xpizza-functions/tools/provenance-pins.json'   // the reviewed provenance REGISTRY: read only by tools/form-source-inventory.js, never shipped (advisor 11-18, dish-stats option A)
    || p === 'xpizza-functions/tools/app-suites.js';   // the test:apps RUNNER (never shipped): its KNOWN_RED holds the rule-20 url-token guard (advisor 11-13)
  const bad = changed.filter((p) => !allowed(p));
  assert.deepEqual(bad, [], `🔴 production files changed: ${bad.join(', ')}`);
  if (changed.includes('xpizza-functions/package.json')) {
    const PKG = 'xpizza-functions/package.json', at = (rev) => { const b = blobAt(rev, PKG); return b ? JSON.parse(git('show', `${rev}:${PKG}`)) : null; };
    const strip = (j) => { if (!j) return null; const c = { ...j, scripts: { ...j.scripts } }; delete c.scripts.test; for (const k of Object.keys(c.scripts)) if (/^test:(capp-s1|s2tip$|capp-s2a$|capp-s2a-browser$|address-area$|capp-s4$|item-s3-rename$)/.test(k)) delete c.scripts[k]; return c; };
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
// escape it. Every merge in BASE..HEAD is judged by git's own re-merge (c7Hits above, PLAN-capp-guards-cell7 r0): a customer-app/ path
// the resolution wrote by hand. The sync-client and PORTED copies are exempt (their byte-identity checks own them, re-asserted here);
// any other hit must sit in MERGE_ALLOW, keyed «<merge FULL id> <path>» (compared exactly — Codex #288), with a one-line reason —
// reviewed, and an entry that no longer hits is stale and fails. The guard file's own pin conflicts are listed too, never exempt
// (advisor 11-23 Q1: a hand-resolved guard is the weakest point). Git's CLEAN merges never hit, so they need no entry.
const MERGE_ALLOW = {
  // none above BASE eb177fe58 (asm14 rebase re-pin; was fd205309a, and fd205309a..eb177fe58 holds no merge; advisor ruling (A) 11-24, the asm11 «pruned to above BASE» precedent): the 17 entries re-derived
  // in f995943d2, rebased as 44b3f867d (rider 6fe745ff ×2, dish-stats 0895a17c ×6, asm12 aa5cde11 / 45f1aebb / 520614c6 ×2 / 6dccdf27, asm13 5a9d5538 ×3, r3
  // d13a0bb7) all sit below the lane's cut point now; their proofs stay in that commit's message
};
// The walk + the criterion (PLAN-capp-guards-cell7 r0, advisor 11-23; Codex #288). The walk is EVERY merge reachable from the head and
// not from BASE: the lane-line + after-the-pin walk never saw a train merge made BEFORE the lane came in (asm12 13–15). A shallow repository
// is refused first (its boundary can end a merged-in line and hide the merges below it). A hit is a path the resolution decided BY HAND,
// against git's own re-merge of the two parents (merge-tree --write-tree, directory renames pinned to «conflict» so a relocation always
// surfaces): (a) the recorded tree differs from git's reconstructed tree (--no-renames; content AND mode), or (b) git left it conflicted —
// a stage entry, or a CONFLICT / directory-rename message — however it was resolved (a modify/delete or binary conflict kept as one side
// leaves git's tree equal to the result, so (a) alone cannot see it). Output the parser cannot map FAILS (C7-UNMAPPABLE), and so does an
// octopus merge (two parents only). The old «blob differs from every parent» flagged git's clean merges and missed d13a0bb7's own pin
// conflict (kept as one side); --remerge-diff --name-only missed the header-only conflicts (Codex #288 P1).
const C7_INFO = new Set(['Auto-merging', 'Fast forwarding submodule']);   // git's own outcome: nothing left to a person
const C7_DIR = new Set(['Path updated due to directory rename', 'Directory rename skipped since directory was renamed on both sides']);
// `git merge-tree --write-tree -z --messages` → { tree, hits }: the tree id, NUL; one «<mode> <oid> <stage>\t<path>» per conflicted stage;
// an empty field; then per message «<n>», n paths, «<type>», «<text>» — each NUL-ended. Anything else is unmappable.
const c7ParseMergeTree = (out) => {
  const t = out.split('\0'), hits = [], bad = (why) => { throw new Error(`🔴 C7-UNMAPPABLE: git merge-tree output not understood (${why}) — review the merge by hand`); };
  let i = 0; const tree = t[i++];
  if (!/^[0-9a-f]{40}$/.test(tree)) bad('no tree id');
  for (; t[i] !== ''; i++) { if (i >= t.length) bad('no section end'); const e = /^[0-7]{6} [0-9a-f]{40} [123]\t([^]+)$/.exec(t[i]); if (!e) bad(`conflict entry «${t[i]}»`); hits.push(e[1]); }
  for (i++; i < t.length && t[i] !== '';) {
    const n = Number(t[i++]);
    if (!/^[1-9]\d*$/.test(t[i - 1]) || i + n + 2 > t.length) bad(`message path count «${t[i - 1]}»`);
    const ps = t.slice(i, i + n), type = t[i + n]; i += n + 2;
    if (C7_INFO.has(type)) continue;
    if (/^CONFLICT ?\(/.test(type) || C7_DIR.has(type)) { hits.push(...ps); continue; }
    bad(`message type «${type}»`);
  }
  if (i !== t.length - 1) bad('trailing fields');
  return { tree, hits };
};
const c7MergeTree = (p1, p2) => {
  let out;
  try { out = execFileSync('git', ['-c', 'merge.directoryRenames=conflict', 'merge-tree', '--write-tree', '-z', '--messages', p1, p2], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { if (e.status !== 1 || typeof e.stdout !== 'string') throw new Error(`🔴 C7-UNMAPPABLE: git merge-tree failed (status ${e.status}) for ${p1} ${p2}`); out = e.stdout; }   // 1 = conflicts
  return c7ParseMergeTree(out);
};
const c7Walk = (head) => git('rev-list', '--merges', `${BASE}..${head}`).trim().split('\n').filter(Boolean);
const c7HandPaths = (m, scopes) => {
  const [p1, p2] = git('log', '-1', '--format=%P', m).trim().split(' '), r = c7MergeTree(p1, p2), inScope = (f) => scopes.some((s) => f.startsWith(s));
  const diff = paths(git('diff-tree', '-r', '--no-renames', '--name-only', '-z', r.tree, m, '--', ...scopes));
  return [...new Set([...diff, ...r.hits.filter(inScope)])].sort();
};
const c7Hits = (head, { scopes = ['customer-app/'], shallow = () => git('rev-parse', '--is-shallow-repository').trim() } = {}) => {
  assert.equal(shallow(), 'false', '🔴 C7-SHALLOW: a shallow repository can end a merged-in line early and hide its merges — run on a full clone');
  return c7Walk(head).flatMap((m) => {
    const n = git('log', '-1', '--format=%P', m).trim().split(' ').filter(Boolean).length;
    assert.equal(n, 2, `🔴 octopus merge ${m.slice(0, 8)} (${n} parents): git's re-merge judges two-parent merges only — review it by hand`);
    return c7HandPaths(m, scopes).map((f) => ({ m, f }));
  });
};
// one key for a hit, the live cell's and C7-PLANT's alike (Codex #288 P2): «<full merge id> <path>», never a prefix — so the full-id keying
// is proven on planted merges even when the lane range holds none (asm14 rebase: BASE..HEAD has no merge, MERGE_ALLOW is empty)
const c7Key = ({ m, f }) => `${m} ${f}`;
test(`no capp edit hidden in a merge resolution: every merge in ${BASE}..HEAD, judged by git's own re-merge`, () => {
  capRange(); const synced = syncedIntoApp(), exempt = new Set([...synced.map(({ dst }) => dst), ...Object.keys(PORTED).map((f) => `customer-app/${f}`)]);
  for (const { src, dst } of synced) assert.ok(sameBytes(dst, src), `🔴 ${dst} differs from (or is missing beside) its source ${src} — the merge exemption no longer holds`);
  for (const [f, sources] of Object.entries(PORTED)) for (const src of sources) assert.ok(sameBytes(`customer-app/${f}`, src), `🔴 customer-app/${f} differs from (or is missing beside) ${src} — the merge exemption no longer holds`);
  const hits = c7Hits('HEAD').filter(({ f }) => !exempt.has(f)).map(c7Key);
  const unlisted = hits.filter((h) => !(h in MERGE_ALLOW)), stale = Object.keys(MERGE_ALLOW).filter((k) => !hits.includes(k));
  assert.equal(unlisted.join('\n'), '', `🔴 customer-app/ edit(s) made in a merge resolution (differ from every parent; not in MERGE_ALLOW):\n${unlisted.join('\n')}`);
  assert.equal(stale.join('\n'), '', `🔴 stale MERGE_ALLOW entr(ies) — no longer a resolution edit:\n${stale.join('\n')}`);
});

// PLAN-capp-guards-cell7 r0 (advisor 11-23): cell 7 driven over PLANTED history — objects only (git commit-tree over a scratch index; no
// ref, no worktree change), as the cell below plants. The planted merges sit on a train line BEFORE the lane comes in (J's second parent
// is HEAD), the asm12 13–15 shape: an evil resolution (M1), git's own clean merge (M2), a conflict kept as one side (M3).
const plantCommit = (parents, from, edits, msg) => {
  const idx = join(tmpdir(), `capp-c7-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.idx`), env = { ...process.env, GIT_INDEX_FILE: idx, GIT_AUTHOR_NAME: 'plant', GIT_AUTHOR_EMAIL: 'plant@invalid', GIT_COMMITTER_NAME: 'plant', GIT_COMMITTER_EMAIL: 'plant@invalid' };
  const g = (args, input) => execFileSync('git', args, { cwd: ROOT, env, input, encoding: 'utf8' }).trim();
  try { g(['read-tree', from]);
    for (const [f, e] of Object.entries(edits)) {   // a string = the body (100644) · { body, mode } · null = deleted
      if (e === null) { g(['update-index', '--force-remove', f]); continue; }
      const { body, mode = '100644' } = typeof e === 'string' ? { body: e } : e;
      g(['update-index', '--add', '--cacheinfo', `${mode},${g(['hash-object', '-w', '--stdin'], body)},${f}`]); }
    return g(['commit-tree', g(['write-tree']), ...parents.flatMap((p) => ['-p', p]), '-m', msg]); } finally { rmSync(idx, { force: true }); } };
const C7_CSS = 'customer-app/capp.css', C7_MD = 'customer-app/c7-plant-md.txt', C7_BIN = 'customer-app/c7-plant.bin';
const c7Plant = () => {
  const base = git('rev-parse', `${BASE}^{commit}`).trim(), head = git('rev-parse', 'HEAD').trim(), c0 = git('show', `${base}:${C7_CSS}`);
  const s1 = plantCommit([base], base, { [C7_CSS]: `${c0}\n/* s1 */\n` }, 'side'), c1 = `${c0}\n/* s1 */\n/* evil */\n`;
  const m1 = plantCommit([base, s1], s1, { [C7_CSS]: c1 }, 'train merge: a hand-added line in the resolution');
  const a2 = plantCommit([m1], m1, { [C7_CSS]: `/* a2 */\n${c1}` }, 'a2'), b2 = plantCommit([m1], m1, { [C7_CSS]: `${c1}/* b2 */\n` }, 'b2');
  const c2 = `/* a2 */\n${c1}/* b2 */\n`, m2 = plantCommit([a2, b2], a2, { [C7_CSS]: c2 }, "train merge: git's own clean result");
  const a3 = plantCommit([m2], m2, { [C7_CSS]: `${c2}/* a3 */\n` }, 'a3'), b3 = plantCommit([m2], m2, { [C7_CSS]: `${c2}/* b3 */\n` }, 'b3');
  const m3 = plantCommit([a3, b3], a3, {}, 'train merge: a conflict resolved to one side (b3 dropped)'), c3 = `${c2}/* a3 */\n`;
  // Codex #288 P1: the resolutions a content diff of git's re-merge cannot see — a modify/delete kept as modified, a binary conflict kept
  // as one side (git's own tree holds that side), and a mode changed by hand on an otherwise clean merge
  const s4 = plantCommit([m3], m3, { [C7_MD]: 'one\ntwo\n', [C7_BIN]: 'bin\0base\0' }, 'seed: a text file and a binary');
  const x4 = plantCommit([s4], s4, { [C7_MD]: 'one\ntwo\nthree\n' }, 'x4 modifies'), y4 = plantCommit([s4], s4, { [C7_MD]: null }, 'y4 deletes');
  const m4 = plantCommit([x4, y4], x4, {}, 'train merge: modify/delete kept as modified');
  const x5 = plantCommit([m4], m4, { [C7_BIN]: 'bin\0ours\0' }, 'x5'), y5 = plantCommit([m4], m4, { [C7_BIN]: 'bin\0theirs\0' }, 'y5');
  const m5 = plantCommit([x5, y5], x5, {}, 'train merge: a binary conflict kept as one side');
  const a6 = plantCommit([m5], m5, { [C7_MD]: 'zero\none\ntwo\nthree\n' }, 'a6'), b6 = plantCommit([m5], m5, { [C7_CSS]: `${c3}/* b6 */\n` }, 'b6');
  const m6 = plantCommit([a6, b6], a6, { [C7_CSS]: { body: `${c3}/* b6 */\n`, mode: '100755' } }, 'train merge: clean contents, a mode set by hand');
  return { base, head, s1, a2, m1, m2, m3, m4, m5, m6, j: plantCommit([m6, head], head, {}, 'the lane comes in') };
};
test('C7-PLANT: cell 7 walks EVERY merge in range and judges it by git\'s own re-merge (PLAN-capp-guards-cell7 r0)', () => {
  const P = c7Plant(), hits = c7Hits(P.j).map(c7Key), walked = c7Walk(P.j);
  assert.ok(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].every((k) => walked.includes(P[k])), '🔴 C7-WALK: a train merge made BEFORE the lane is not walked');
  assert.ok(hits.length > 0 && hits.every((h) => /^[0-9a-f]{40} customer-app\//.test(h)), `🔴 C7-HITKEY: a cell-7 hit is not keyed «<full merge id> <path>»:\n${hits.join('\n')}`);
  assert.ok(hits.includes(`${P.m1} ${C7_CSS}`), '🔴 C7-EVIL: a line added by hand in a clean merge\'s resolution is not seen');
  assert.ok(!hits.includes(`${P.m2} ${C7_CSS}`) && !hits.includes(`${P.m6} ${C7_MD}`), "🔴 C7-CLEAN: git's own clean merge is flagged as a hand resolution");
  assert.ok(hits.includes(`${P.m3} ${C7_CSS}`), "🔴 C7-ONE-SIDE: a conflict resolved to one side (the other side's change dropped) is not seen");
  assert.ok(hits.includes(`${P.m4} ${C7_MD}`), '🔴 C7-MODDEL: a modify/delete conflict kept as modified (the deletion dropped) is not seen');
  assert.ok(hits.includes(`${P.m5} ${C7_BIN}`), '🔴 C7-BINARY: a binary conflict kept as one side is not seen');
  assert.ok(hits.includes(`${P.m6} ${C7_CSS}`), '🔴 C7-MODE: a file mode changed by hand in a resolution is not seen');
});
// Codex #288 P2: a shallow clone can end a merged-in line at its boundary and hide the merges below it — refused before any walk
test('C7-SHALLOW: cell 7 refuses a shallow repository', () => {
  assert.throws(() => c7Hits('HEAD', { shallow: () => 'true' }), /C7-SHALLOW/, '🔴 C7-SHALLOW: a shallow repository is walked');
});
// Codex #288 P1: the parser over git's REAL output for a planted conflict (M4), then that output with ONE record appended — the kinds git
// cannot be driven to emit here (an ERROR type, a type this git does not know, a relocation by directory rename), so the fail-closed
// branch is exercised and a directory-rename message is proven a hit
test('C7-UNMAPPABLE: merge-tree output the parser cannot map fails; a directory-rename message is a hit', () => {
  const P = c7Plant(), [p1, p2] = git('log', '-1', '--format=%P', P.m4).trim().split(' ');
  let real; try { real = execFileSync('git', ['merge-tree', '--write-tree', '-z', '--messages', p1, p2], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { real = e.stdout; }
  const add = (n, ps, type) => `${real}${n}\0${ps.map((p) => `${p}\0`).join('')}${type}\0text\n\0`;
  assert.ok(c7ParseMergeTree(real).hits.includes(C7_MD), "premise: git's real output parses and names the modify/delete path");
  assert.ok(c7ParseMergeTree(add(1, ['customer-app/moved.js'], 'Path updated due to directory rename')).hits.includes('customer-app/moved.js'), '🔴 C7-DIRMSG: a path relocated by a directory rename is not a hit');
  for (const [label, out] of [['an ERROR type', add(1, ['customer-app/x.js'], 'ERROR (object read failed)')], ['an unknown type', add(1, ['customer-app/x.js'], 'SOMETHING (new)')],
    ['a zero path count', add(0, [], 'Auto-merging')], ['trailing fields', `${real}junk`]])
    assert.throws(() => c7ParseMergeTree(out), /C7-UNMAPPABLE/, `🔴 C7-UNMAPPABLE: ${label} is accepted`);
});
// Codex #288 P2: an 8-char prefix can name two commits (or be shadowed by a ref) — the pins and MERGE_ALLOW keys are FULL ids, compared exactly
test('C7-FULLID: BASE, CAPP_TIP and every MERGE_ALLOW key name a commit by its full id', () => {
  for (const [k, v] of Object.entries({ BASE, CAPP_TIP })) assert.match(v, /^[0-9a-f]{40}$/, `🔴 C7-FULLID: ${k} is not a full commit id`);
  for (const k of Object.keys(MERGE_ALLOW)) assert.match(k, /^[0-9a-f]{40} customer-app\/\S/, `🔴 C7-FULLID: MERGE_ALLOW key «${k}» is not «<full id> <path>»`);
});
test('C7-OCTOPUS: a merge of more than two parents fails cell 7 (never silently skipped)', () => {
  const P = c7Plant(), o = plantCommit([P.base, P.s1, P.a2], P.a2, {}, 'octopus'), j = plantCommit([o, P.head], P.head, {}, 'the lane comes in');
  assert.throws(() => c7Hits(j), /octopus/, '🔴 C7-OCTOPUS: a 3-parent merge is not refused');
});

// The re-based pin still BITES (advisor 11-18): a planted, unreviewed customer-app/ commit on top of HEAD — objects only (git commit-tree
// over a scratch index; no ref, no worktree file changes) — must fail the range; the same plant touching ONLY this guard file is the
// exempt re-pin and passes.
test('capp-guards still bites after the 11-18 re-base: a planted capp commit after CAPP_TIP goes RED', () => {
  const plant = (f, extra) => { const idx = join(tmpdir(), `capp-plant-${process.pid}-${Date.now()}.idx`), env = { ...process.env, GIT_INDEX_FILE: idx, GIT_AUTHOR_NAME: 'plant', GIT_AUTHOR_EMAIL: 'plant@invalid', GIT_COMMITTER_NAME: 'plant', GIT_COMMITTER_EMAIL: 'plant@invalid' };
    const g = (args, input) => execFileSync('git', args, { cwd: ROOT, env, input, encoding: 'utf8' }).trim();
    try { g(['read-tree', 'HEAD']); const blob = g(['hash-object', '-w', '--stdin'], g(['show', `HEAD:${f}`]) + extra); g(['update-index', '--cacheinfo', `100644,${blob},${f}`]);
      return g(['commit-tree', g(['write-tree']), '-p', 'HEAD', '-m', 'planted unreviewed capp commit']); } finally { rmSync(idx, { force: true }); } };
  assert.doesNotThrow(() => capRange('HEAD'), 'premise: the committed tip is in range');
  assert.throws(() => capRange(plant('customer-app/capp.css', '\n/* planted */\n')), /capp commit\(s\) after CAPP_TIP/, '🔴 GUARD-BITES: an unreviewed capp commit after the pin fails');
  assert.doesNotThrow(() => capRange(plant('customer-app/capp-guards.test.mjs', '\n// planted re-pin\n')), 'the guard file alone is the exempt re-pin');
});

// S2 SBS method (A), advisor 11-09: the side-by-side harness renders the SDK checkout with TWO stated injections — runtime mode 'native'
// (applied per page by review/capp-sbs/sbs.mjs) and the stand-in pay binding (review/capp-sbs/standin-paysdk.mjs). Both live ONLY in
// the harness: no tracked code file outside review/ carries the stand-in or names the harness, and the packaged bundle (web AND
// native, every flag) carries neither; the web bundle's runtime says 'web' (the injection is never packaged). The marker is built
// here, never written whole, so this file cannot match itself.
test('S2 SBS: the stand-in pay binding and the native-mode injection live ONLY in review/capp-sbs — no production file, no packaged bundle', () => {
  const MARK = ['SBS', 'STANDIN', 'PAYSDK'].join('-'), HARNESS = ['capp', 'sbs/'].join('-');
  const standin = readFileSync(join(ROOT, 'review/capp-sbs/standin-paysdk.mjs'), 'utf8'), sbs = readFileSync(join(ROOT, 'review/capp-sbs/sbs.mjs'), 'utf8');
  assert.ok(standin.includes(MARK), '🔴 premise: the stand-in carries its marker (else this guard is vacuous)');
  assert.ok(sbs.includes(`'"mode":"native"'`), '🔴 premise: the native-mode injection is the harness\'s');
  const code = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
    .filter((f) => f && !f.startsWith('review/') && /\.(m?js|cjs|html|json)$/.test(f) && f !== 'customer-app/capp-guards.test.mjs' && existsSync(join(ROOT, f)));
  assert.ok(code.length > 100 && code.includes('customer-app/capp-ui.js'), `🔴 premise: the scan reads the tree (${code.length} files)`);
  const leaks = code.filter((f) => { const s = readFileSync(join(ROOT, f), 'utf8'); return s.includes(MARK) || s.includes(HARNESS); });
  assert.deepEqual(leaks, [], `🔴 SBS-1: a production/test file carries the stand-in or names the harness:\n${leaks.join('\n')}`);
  const P = createRequire(import.meta.url)('../platform/native/package-capp.js');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  for (const target of P.TARGETS) {
    const B = P.build({ sha: head, target, env: 'production', flags: [...P.FLAGS] });
    const bad = [...B.files].filter(([, buf]) => { const s = Buffer.from(buf).toString('latin1'); return s.includes(MARK) || s.includes(HARNESS); }).map(([f]) => f);
    assert.deepEqual(bad, [], `🔴 SBS-2: the packaged ${target} bundle carries the stand-in / the harness: ${bad.join(', ')}`);
    const rt = {}; new Function('self', B.files.get('capp-runtime.js').toString('utf8'))(rt);
    assert.equal(rt.CAPP_RUNTIME && rt.CAPP_RUNTIME.mode, target, `🔴 SBS-3: the packaged ${target} runtime says its own mode (no injected mode)`);
  }
});

// PLAN-capp-virtual-clock step 9 (advisor 11-14): the customer-app suites never WAIT on a fixed real sleep — a Promise settled by a real
// setTimeout races the work it waits for under load (the 2e flakes); the virtual clock (test-clock.mjs) drains instead. Real = a bare,
// window or jsdom-window setTimeout — any receiver that is not a virtual clock (fail closed). A waiver names its reason and pins its
// count (a second sleep in a waived file is never hidden by the first). The premises split «set»+«Timeout» so this file scans clean
const SLEEP_WAIVED = {
  'capp-s7a1-shell.test.mjs': [1, 'popTick: an EVENT-based wait for jsdom\'s popstate — its 1 s timer is a hang cap only (advisor 11-14)'],
};
const VIRTUAL_RECV = /^(VC|vc|c|POP)\.$/;
function realSleeps(src) {
  const out = [];
  for (const m of src.matchAll(/new Promise\(\s*(?:\(\s*(\w+)[^)]*\)|(\w+))\s*=>/g)) {
    const r = m[1] || m[2], body = src.slice(m.index, m.index + 400);
    const settles = new RegExp(`([\\w.]*?)setTimeout\\)?\\(\\s*(?:${r}\\s*[,)]|\\(\\)\\s*=>\\s*\\{?\\s*${r}\\()`, 'g');
    for (const t of body.matchAll(settles)) if (!VIRTUAL_RECV.test(t[1])) { out.push(src.slice(0, m.index).split('\n').length); break; }
  }
  return out;
}
test('no fixed real sleep in the customer-app suites: no Promise settled by a real setTimeout — the virtual clock drains instead (PLAN-capp-virtual-clock step 9)', () => {
  const dir = join(ROOT, 'customer-app'), files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs'));
  assert.ok(files.length >= 30 && files.includes('capp-s7a2.test.mjs') && files.includes('capp-ui.test.mjs'), `🔴 premise: the scan reads the suites (${files.length})`);
  const ST = 'set' + 'Timeout';
  assert.deepEqual(realSleeps(`const s = () => new Promise((r) => ${ST}(r, 30));`), [1], '🔴 premise: the scanner sees a bare sleep');
  assert.deepEqual(realSleeps(`const s = () => new Promise((res) => w.${ST}(() => res(), 30));`), [1], '🔴 premise: the scanner sees a jsdom-window sleep');
  assert.deepEqual(realSleeps(`const s = () => new Promise((r) => VC.${ST}(r, 30));`), [], '🔴 premise: a virtual-clock wait is not a sleep');
  const found = Object.fromEntries(files.map((f) => [f, realSleeps(readFileSync(join(dir, f), 'utf8'))]).filter(([, l]) => l.length));
  const bad = Object.entries(found).filter(([f, l]) => !SLEEP_WAIVED[f] || l.length !== SLEEP_WAIVED[f][0]).map(([f, l]) => `${f}:${l.join(',')}`);
  assert.deepEqual(bad, [], '🔴 SLEEP: a fixed real sleep in a customer-app suite (wait on the virtual clock, or on an event)');
  assert.deepEqual(Object.keys(SLEEP_WAIVED).filter((f) => !found[f]), [], '🔴 SLEEP: a stale waiver (its sleep is gone — drop it)');
});

// rule 20 (owner; PLAN-capp-web-signin r0 — the WEBSITE now signs members in): NO script the web shell loads builds a URL that carries a
// token — an ID / custom / access token goes in a HEADER, never a query (a URL lands in browser history, devtools, proxy logs). The
// scan covers every <script src> of shell.html (the packager's web file list, package-capp.js) — a token-shaped query parameter fed
// from code (`?auth=${…}`, `&token=' + …`) is red; TIP-F4 (capp-ui) pins the one historical offender (last_tip) dynamically
test('rule 20 (web sign-in): no script of the web shell puts a token in a URL query', () => {
  const shell = readFileSync(join(ROOT, 'customer-app', 'shell.html'), 'utf8');
  const scripts = [...shell.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]).filter((f) => !/^https?:/.test(f));
  assert.ok(scripts.length >= 10 && scripts.includes('capp-api.js') && scripts.includes('capp-signup-api.js'), 'premise: the shell\'s scripts');
  const TOKQ = /[?&](?:auth|token|id_?token|access_?token|custom_?token|tok)=(?:\$\{|['"`]\s*\+)/i;
  const hits = [];
  for (const f of scripts) {
    const src = readFileSync(join(ROOT, 'customer-app', f), 'utf8');
    src.split('\n').forEach((ln, i) => { if (TOKQ.test(ln) && !/^\s*\/\//.test(ln)) hits.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(hits, [], '🔴 R20-URL: a token built into a URL query');
  assert.ok(TOKQ.test("fetch(`${base}/x.json?auth=${encodeURIComponent(tok)}`)") && TOKQ.test("u + '&token=' + t"), 'non-vacuity: the former offender\'s shape is caught');
});

// Codex #197 (P1, the CLASS): a member's ID token is read from the SDK in ONE place — the shell's sdkTokenAnswer (the token WITH the
// user it belongs to), under ownedMemberToken(uid) for every member request and the transport's member delegate (capp-api memberToken,
// whose sink checks the token's user). PARSED (acorn): any call of idToken / idTokenOwned / getIdToken / getIdTokenOwned — dotted,
// computed, optional, through .call/.apply/.bind, an alias or a destructured binding — outside those places FAILS. Allowed by name: the
// adapter's own idTokenOwned body (the SDK user's getIdToken) and the Google sign-in credential (o.google.getIdToken, not a member token).
const acornG = createRequire(join(ROOT, 'xpizza-functions/x.js'))('acorn');
const TOKEN_READS = new Set(['idToken', 'idTokenOwned', 'getIdToken', 'getIdTokenOwned']);
const TOKEN_HOMES = { 'capp-shell-ui.js': ['sdkTokenAnswer'], 'capp-api.js': ['memberToken'], 'capp-auth-firebase.js': ['idTokenOwned'] };
function tokenReadViolations(file, src) {
  let ast; try { ast = acornG.parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true }); } catch (_) { ast = acornG.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); }
  const bad = [], homes = TOKEN_HOMES[file] || [];
  const propName = (m) => (m && m.type === 'MemberExpression' ? (!m.computed && m.property.type === 'Identifier' ? m.property.name : m.computed && m.property.type === 'Literal' && typeof m.property.value === 'string' ? m.property.value : null) : null);
  const text = (n) => src.slice(n.start, n.end);
  const fnName = (n, parent) => (n.type === 'FunctionDeclaration' && n.id ? n.id.name : parent && parent.type === 'Property' && parent.value === n && !parent.computed && parent.key.type === 'Identifier' ? parent.key.name : parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier' ? parent.id.name : null);
  (function walk(n, parent, inHome) {
    if (/Function/.test(n.type) && homes.includes(fnName(n, parent))) inHome = true;
    const at = () => `${file}:${n.loc.start.line} ${text(n).slice(0, 60)}`;
    if (!inHome) {
      const callee = n.type === 'CallExpression' ? (n.callee.type === 'ChainExpression' ? n.callee.expression : n.callee) : null;
      const google = (m) => m && m.type === 'MemberExpression' && text(m.object) === 'o.google' && propName(m) === 'getIdToken';
      if (callee && TOKEN_READS.has(propName(callee)) && !google(callee)) bad.push('call ' + at());
      // a method read off as a VALUE (an alias, .call / .apply / .bind, passed along) — the cached field m.idToken is data, not a read
      if (n.type === 'MemberExpression' && TOKEN_READS.has(propName(n)) && propName(n) !== 'idToken' && !(parent && parent.type === 'CallExpression' && parent.callee === n) && !(parent && parent.type === 'ChainExpression' && parent.expression === n) && !(parent && parent.type === 'UnaryExpression' && parent.operator === 'typeof') && !google(n)) bad.push('value ' + at());
      if (n.type === 'MemberExpression' && propName(n) === 'idToken' && parent && parent.type === 'MemberExpression' && parent.object === n && ['call', 'apply', 'bind'].includes(propName(parent))) bad.push('value ' + at());
      // a destructured read off a value (const / assignment); a function's parameter named idToken is the token handed IN (data)
      if (n.type === 'ObjectPattern' && parent && (parent.type === 'VariableDeclarator' || parent.type === 'AssignmentExpression')) for (const p of n.properties) if (p.type === 'Property' && TOKEN_READS.has(p.key.type === 'Identifier' ? p.key.name : p.key.value)) bad.push('destructured ' + at());
    }
    for (const [k, v] of Object.entries(n)) if (k !== 'loc') for (const c of (Array.isArray(v) ? v : [v])) if (c && typeof c.type === 'string') walk(c, n, inHome);
  })(ast, null, false);
  return bad;
}
test('Codex #197 (P1): a member\'s ID token is read from the SDK ONLY through the shell\'s one owned accessor — every other read FAILS the guard (parsed)', () => {
  const shell = readFileSync(join(ROOT, 'customer-app', 'shell.html'), 'utf8');
  const scripts = [...shell.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]).filter((f) => !/^https?:/.test(f));
  assert.ok(scripts.includes('capp-shell-ui.js') && scripts.includes('capp-signup.js') && scripts.includes('capp-api.js') && scripts.includes('capp-auth-firebase.js'), 'premise: the shell\'s scripts');
  const all = [];
  for (const f of scripts) all.push(...tokenReadViolations(f, readFileSync(join(ROOT, 'customer-app', f), 'utf8')));
  assert.deepEqual(all, [], '🔴 C197-CENSUS: a member token read outside the one accessor');
  // non-vacuity: the guard SEES each bypass form, planted where Codex found the instance (togglePromos)
  const ui = readFileSync(join(ROOT, 'customer-app', 'capp-shell-ui.js'), 'utf8'), K = 'async function togglePromos() {';
  assert.equal(ui.split(K).length, 2, 'premise: the plant point exists once');
  for (const plant of ['fbAuth.idToken();', 'fbAuth.idTokenOwned();', "fbAuth['idTokenOwned']();", 'fbAuth?.idToken?.();', 'fbAuth.idToken.call(fbAuth);', 'const f = fbAuth.idTokenOwned; f();', 'const { idTokenOwned } = fbAuth;', 'const { idToken } = fbAuth; idToken();', 'S.member.getIdTokenOwned();'])
    assert.ok(tokenReadViolations('capp-shell-ui.js', ui.replace(K, `${K} ${plant}`)).length > 0, `🔴 C197-CENSUS control: «${plant}» fails the guard`);
  assert.deepEqual(tokenReadViolations('capp-signup.js', 'async function g(o) { return o.google.getIdToken({}); }'), [], 'the Google sign-in credential is allowed by name');
});
