'use strict';
// PLAN-A §5 — the form-source inventory guard. Run: node form-source-inventory.guard.test.js
//   1. The committed tools/form-source-inventory.json equals a fresh build (regenerate: node tools/form-source-inventory.js --write).
//   2. No edited server module is hashed by a site without a registered inverse.
//   3. INDEPENDENT CROSS-CHECKS (not the tool's own graph): every test whose source literally names a form page, and
//      every test that requires/imports form-harness.mjs, is inventoried under BOTH forms / its form.
//   4. SENSITIVITY: a synthetic test reaching a form only through a helper is found (via_helper); a synthetic guard that
//      sha-pins an edited module with no inverse is reported unregistered.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { build, OUT, SEED } = require('./tools/form-source-inventory');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');
const inv = build();

assert.deepStrictEqual(JSON.parse(fs.readFileSync(OUT, 'utf8')), JSON.parse(JSON.stringify(inv)), '🔴 tools/form-source-inventory.json is stale — run node tools/form-source-inventory.js --write and commit the diff');
ok(`the committed inventory equals a fresh build (${Object.values(inv.surfaces).reduce((a, s) => a + s.tests.length, 0)} (test, surface) pairs, ${inv.helpers.length} helpers, ${inv.server_modules_edited.length} edited server modules)`);

assert.deepStrictEqual(inv.unregistered, [], `🔴 edited modules hashed with no registered inverse: ${JSON.stringify(inv.unregistered)}`);
assert.ok(inv.server_modules_edited.includes('index.js'), 'non-vacuity: the branch edits index.js');
assert.ok(inv.server['index.js'].pins.length >= 5 && inv.server['index.js'].pins.every((p) => p.inverses.length), 'every index.js pin names its inverse');
ok(`every hashing site of an edited module names a registered inverse (${Object.values(inv.server).reduce((a, v) => a + v.pins.length, 0)} sites)`);

{
  const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (/\.test\.m?js$/.test(e.name)) out.push(p); } return out; };
  const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
  let literal = 0, harness = 0;
  for (const f of walk(ROOT).filter((x) => x !== __filename)) {   // not this guard (its synthetic sources name the harness)
    const s = fs.readFileSync(f, 'utf8');
    for (const d of ['xpizza-orders', 'la-musa-orders']) {
      if (s.includes(`${d}/index.html`) || s.includes(`'${d}', 'index.html'`)) { literal += 1; assert.ok(inv.surfaces[d].tests.includes(rel(f)), `🔴 ${rel(f)} names ${d}/index.html but is not inventoried`); }
    }
    if (/form-harness(\.mjs)?['"]/.test(s)) { harness += 1; assert.ok(inv.surfaces['xpizza-orders'].tests.includes(rel(f)) || inv.surfaces['la-musa-orders'].tests.includes(rel(f)), `🔴 ${rel(f)} uses form-harness but is not inventoried`); }
  }
  assert.ok(literal >= 10 && harness >= 5, `non-vacuity: ${literal} literal / ${harness} harness users`);
  ok(`independent cross-checks: ${literal} literal form-page references and ${harness} form-harness users are all inventoried`);
}

{
  // the ⊇ seed: codex's 40 (codex-menu-v5-plan-r1.txt finding 11) — every entry accounted for, none silently dropped
  assert.strictEqual(SEED.length, 40, 'the seed is exactly codex\'s 40 entries');
  assert.strictEqual(inv.seed.length, 40);
  assert.deepStrictEqual(inv.seed_problems, [], `🔴 seed entries not accounted for: ${JSON.stringify(inv.seed_problems)}`);
  for (const x of inv.seed) {
    if (x.status === 'reader') assert.ok(x.surfaces.length && x.surfaces.every((s) => inv.surfaces[s].tests.includes(x.file)), x.seed);
    else if (x.status === 'named-only') assert.ok(/:\d+: /.test(x.evidence), `${x.seed}: named-only needs its evidence line`);
    else assert.ok(x.evidence && x.evidence !== 'no deletion/rename commit found', `${x.seed}: removed/renamed needs git evidence`);
  }
  const counts = inv.seed.reduce((a, x) => ({ ...a, [x.status]: (a[x.status] || 0) + 1 }), {});
  ok(`the ⊇ seed (codex's 40): every entry accounted for — ${JSON.stringify(counts)}`);
}

{
  const viaHelper = build({ extra: { 'xpizza-functions/zz-synthetic.test.js': "const h = require('../form-harness.mjs');" } });
  const r = 'xpizza-functions/zz-synthetic.test.js';
  assert.ok(viaHelper.surfaces['xpizza-orders'].via_helper.includes(r) && viaHelper.surfaces['la-musa-orders'].via_helper.includes(r), '🔴 a test reaching the forms only through form-harness was missed');
  const pin = build({ extra: { 'xpizza-functions/zz-synthetic.guard.test.js': "const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');\nassert.strictEqual(sha(read('rewards-reserve.js')), 'x');" } });
  assert.ok(pin.unregistered.some((u) => u.module === 'rewards-reserve.js' && u.site === 'xpizza-functions/zz-synthetic.guard.test.js'), '🔴 an unregistered sha pin of an edited module was not reported');
  const withInv = build({ extra: { 'xpizza-functions/zz-synthetic.guard.test.js': "const { unapplyA1Module } = require('./tools/a1-inverse');\nconst sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');\nsha(unapplyA1Module('createorder-classify.js', read('createorder-classify.js')));" } });
  assert.ok(!withInv.unregistered.length, 'a pin that applies its registered inverse is accepted');
  ok('sensitivity: a helper-only form reader is found (via_helper, both forms); an unregistered sha pin of an edited module is reported; a pin applying its registered inverse is accepted');
}

{
  // PROVENANCE PINS (advisor 11-15, option 2): a fixture generator that hashes an EXTRACTED tree at a fixed sha is not a live pin —
  // but only when tools/provenance-pins.json registers it AND (a) it hashes under its argv root with a 40-hex sha argument,
  // (b) the fixture's recorded blob is the module's blob at that sha, (c) a consumer test asserts against that immutable sha.
  // Synthetic world: a generator, its fixture and its consumer, pinned to HEAD's my-orders.js (an edited module).
  const { execFileSync } = require('child_process');
  const { verdict } = require('./tools/form-source-inventory');
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  const M = 'my-orders.js';
  assert.ok(inv.server_modules_edited.includes(M), `premise: ${M} is an edited server module`);
  const HEAD = git('rev-parse', 'HEAD'), BLOB = git('rev-parse', `HEAD:xpizza-functions/${M}`);
  const OLD = git('log', '--format=%H', '-2', 'HEAD', '--', `xpizza-functions/${M}`).split('\n')[1];
  const SITE = 'customer-app/fixtures/zz-prov/gen-zz.mjs', FIX = 'customer-app/fixtures/zz-prov/zz.json', CON = 'customer-app/zz-prov.test.mjs';
  const gen = (root = 'FN') => "const FN = process.argv[2], SHA = process.argv[3];\nif (!/^[0-9a-f]{40}$/.test(SHA || '')) throw new Error('usage');\n"
    + `const blob = (rel) => { const b = readFileSync(join(${root}, rel)); return createHash('sha1').update(\`blob \${b.length}\\0\`).update(b).digest('hex'); };\nconst out = { sha: SHA, blobs: { '${M}': blob('${M}') } };\n`;
  const fix = (sha = HEAD, blob = BLOB) => JSON.stringify({ sha, blobs: { [M]: blob } });
  const con = "const Z = JSON.parse(readFileSync(new URL('./fixtures/zz-prov/zz.json', import.meta.url), 'utf8'));\n"
    + "for (const [r, b] of Object.entries(Z.blobs)) assert.equal(git('rev-parse', `${Z.sha}:xpizza-functions/${r}`), b, 'pin');\n";
  const ROW = { site: SITE, module: M, fixture: FIX, sha_field: 'sha', blobs_field: 'blobs', consumer: CON };
  const world = (o = {}) => build({ extra: { [SITE]: o.site ?? gen(), [FIX]: o.fix ?? fix(), ...(o.con === null ? {} : { [CON]: o.con ?? con }) }, provenance: o.rows ?? [ROW] });
  const pp = (w) => w.provenance_pins.find((p) => p.site === SITE);
  const isUnreg = (w) => w.unregistered.some((u) => u.module === M && u.site === SITE);

  // the real registry: the two rows, each reported (dormant until its generator is in the tree)
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'tools/provenance-pins.json'), 'utf8'));
  assert.deepStrictEqual(real.map((r) => `${r.site}|${r.module}`).sort(), ['customer-app/fixtures/c3r-v2/gen-c3r-v2.mjs|my-orders.js', 'customer-app/fixtures/offer-quote/gen-offer-quote.mjs|delivery/delivery-wire.js'], 'the registry is the two advisor-approved rows');
  assert.deepStrictEqual(inv.provenance_pins.map((p) => `${p.site}|${p.module}`).sort(), real.map((r) => `${r.site}|${r.module}`).sort(), '🔴 PROV-REPORT: every registry row is reported');

  const ctl = world({ rows: [] });
  assert.ok(isUnreg(ctl) && verdict(ctl) === 1, '🔴 PROV-CTL: an unregistered extracted-tree hash site still exits 1');
  const live = build({ extra: { 'xpizza-functions/zz-synthetic.guard.test.js': "const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');\nassert.strictEqual(sha(read('my-orders.js')), 'x');" }, provenance: [ROW] });
  assert.ok(live.unregistered.some((u) => u.module === M && u.site === 'xpizza-functions/zz-synthetic.guard.test.js') && verdict(live) === 1, '🔴 PROV-CTL: an unregistered LIVE-tree hash site still exits 1 beside a valid registry');
  const good = world();
  assert.ok(!isUnreg(good) && pp(good).status === 'ok' && verdict(good) === 0, `🔴 PROV-OK: a registered provenance pin passing (a)(b)(c) is accepted: ${JSON.stringify(pp(good))}`);
  assert.strictEqual(pp(good).live_differs, false, 'PROV-INFO: pinned at HEAD ⇒ the live blob is the pinned blob');
  const stale = world({ fix: fix(OLD, git('rev-parse', `${OLD}:xpizza-functions/${M}`)) });
  assert.ok(pp(stale).status === 'ok' && pp(stale).live_differs === true && verdict(stale) === 0, '🔴 PROV-INFO: a pin at an older sha is reported live_differs, never a failure');

  const a = world({ site: `${gen()}const liveSrc = readFileSync(join(ROOT, 'xpizza-functions', '${M}'));\n` });
  assert.ok(isUnreg(a) && pp(a).status === 'refused' && pp(a).check === 'a' && verdict(a) === 1, `🔴 PROV-A: a registered site hashing the LIVE tree is refused: ${JSON.stringify(pp(a))}`);
  const a2 = world({ site: gen().replace("if (!/^[0-9a-f]{40}$/.test(SHA || '')) throw new Error('usage');\n", '') });
  assert.ok(isUnreg(a2) && pp(a2).check === 'a' && verdict(a2) === 1, `🔴 PROV-A: a registered site without a 40-hex sha argument is refused: ${JSON.stringify(pp(a2))}`);
  const b = world({ fix: fix(HEAD, '0'.repeat(40)) });
  assert.ok(isUnreg(b) && pp(b).status === 'refused' && pp(b).check === 'b' && verdict(b) === 1, `🔴 PROV-B: a fixture blob that is not the module at its sha is refused: ${JSON.stringify(pp(b))}`);
  const c = world({ con: "const Z = JSON.parse(readFileSync(new URL('./fixtures/zz-prov/zz.json', import.meta.url), 'utf8'));\nassert.ok(Z.blobs);\n" });
  assert.ok(isUnreg(c) && pp(c).status === 'refused' && pp(c).check === 'c' && verdict(c) === 1, `🔴 PROV-C: a consumer that never asserts against the sha is refused: ${JSON.stringify(pp(c))}`);
  const c2 = world({ con: null });
  assert.ok(isUnreg(c2) && pp(c2).check === 'c' && verdict(c2) === 1, `🔴 PROV-C: a missing consumer is refused: ${JSON.stringify(pp(c2))}`);
  ok('provenance pins: the 2 registry rows reported; an unregistered site (extracted or live tree) exits 1; a registered pin passing (a)(b)(c) is accepted, a stale one only flagged live_differs; (a) live-tree / no-sha, (b) wrong blob, (c) no sha assertion / no consumer are each refused');
}

console.log(`\nform-source-inventory.guard: OK (${n})`);
