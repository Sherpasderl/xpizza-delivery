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

console.log(`\nform-source-inventory.guard: OK (${n})`);
