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
  // PROVENANCE PINS (advisor 11-15, option 2; r2 «reviewed content pins»): a fixture generator that hashes an EXTRACTED tree at a
  // fixed sha is not a live pin — but only when tools/provenance-pins.json registers it with the sha256 of the generator AND of its
  // consumer test as reviewed, both still byte-identical, and (b) the fixture's recorded blob is the module's blob at that sha.
  // Synthetic world: a generator, its fixture and its consumer, pinned to HEAD's my-orders.js (an edited module).
  const { execFileSync } = require('child_process');
  const crypto = require('crypto');
  const { verdict } = require('./tools/form-source-inventory');
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const M = 'my-orders.js';
  assert.ok(inv.server_modules_edited.includes(M), `premise: ${M} is an edited server module`);
  const HEAD = git('rev-parse', 'HEAD'), BLOB = git('rev-parse', `HEAD:xpizza-functions/${M}`);
  const OLD = git('log', '--format=%H', '-2', 'HEAD', '--', `xpizza-functions/${M}`).split('\n')[1];
  const SITE = 'customer-app/fixtures/zz-prov/gen-zz.mjs', FIX = 'customer-app/fixtures/zz-prov/zz.json', CON = 'customer-app/zz-prov.test.mjs';
  const GEN = "const FN = process.argv[2], SHA = process.argv[3];\nif (!/^[0-9a-f]{40}$/.test(SHA || '')) throw new Error('usage');\n"
    + `const blob = (rel) => { const b = readFileSync(join(FN, rel)); return createHash('sha1').update(\`blob \${b.length}\\0\`).update(b).digest('hex'); };\nconst out = { sha: SHA, blobs: { '${M}': blob('${M}') } };\n`;
  const fix = (sha = HEAD, blob = BLOB) => JSON.stringify({ sha, blobs: { [M]: blob } });
  // the consumer is pinned by REGION (advisor r2 tweak): only the bytes between its PROVENANCE-PIN markers, so the rest of a big suite can move
  const REGION = "const Z = JSON.parse(readFileSync(new URL('./fixtures/zz-prov/zz.json', import.meta.url), 'utf8'));\n"
    + "test('zz pin', () => { for (const [r, b] of Object.entries(Z.blobs)) assert.equal(git('rev-parse', `${Z.sha}:xpizza-functions/${r}`), b, 'pin'); });\n";
  const BEG = '// PROVENANCE-PIN:BEGIN zz\n', END = '// PROVENANCE-PIN:END zz\n';
  const CONSRC = `import assert from 'node:assert';\n${BEG}${REGION}${END}test('other cell', () => {});\n`;
  const ROW = { site: SITE, module: M, fixture: FIX, sha_field: 'sha', blobs_field: 'blobs', consumer: CON, consumer_region: 'zz', site_sha256: h(GEN), consumer_sha256: h(REGION) };
  // the real registry rows ride every synthetic world (advisor 11-15, merge resolution): once a real generator is in the tree (offers-r20:
  // gen-c3r-v2.mjs hashes my-orders.js) a world without its row reports it unregistered. PROV-REAL keeps the real rows ok.
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'tools/provenance-pins.json'), 'utf8'));
  const world = (o = {}) => build({ extra: { [SITE]: o.site ?? GEN, [FIX]: o.fix ?? fix(), ...(o.con === null ? {} : { [CON]: o.con ?? CONSRC }) }, provenance: { rows: o.rows ?? [...real.rows, ROW] }, only: [M], ...(o.revParse ? { revParse: o.revParse } : {}) });
  const pp = (w) => w.provenance_pins.find((p) => p.site === SITE);
  const isUnreg = (w) => w.unregistered.some((u) => u.module === M && u.site === SITE);
  const refused = (w, check, reason) => isUnreg(w) && pp(w).status === 'refused' && pp(w).check === check && (!reason || pp(w).reason === reason) && verdict(w) === 1;

  // the real registry: the two rows, each with both reviewed content hashes, each reported (dormant until its generator is in the tree)
  assert.ok(/re-register/i.test(real._doc || ''), 'the registry documents its re-register step');
  assert.deepStrictEqual(real.rows.map((r) => `${r.site}|${r.module}`).sort(), ['customer-app/fixtures/c3r-v2/gen-c3r-v2.mjs|my-orders.js', 'customer-app/fixtures/offer-quote/gen-offer-quote.mjs|delivery/delivery-wire.js'], 'the registry is the two advisor-approved rows');
  assert.ok(real.rows.every((r) => /^[0-9a-f]{64}$/.test(r.site_sha256) && /^[0-9a-f]{64}$/.test(r.consumer_sha256) && /^[\w-]+$/.test(r.consumer_region || '')), 'every row pins its generator (whole file) and its consumer region by sha256');
  assert.deepStrictEqual(inv.provenance_pins.map((p) => `${p.site}|${p.module}`).sort(), real.rows.map((r) => `${r.site}|${r.module}`).sort(), '🔴 PROV-REPORT: every registry row is reported');
  // Codex r2 P2-2: the REAL registry's verdict, not just its shape — every real row ok (or absent: its generator is not in this tree)
  const realOk = (w) => {
    assert.strictEqual(verdict(w), 0, `🔴 PROV-REAL: the real inventory's verdict is 0: ${JSON.stringify(w.provenance_pins)}`);
    for (const p of w.provenance_pins) assert.ok(p.status === 'ok' || p.status === 'absent', `🔴 PROV-REAL: real row ${p.site} is ok/absent: ${JSON.stringify(p)}`);
  };
  realOk(inv);
  const stubbed = build({ extra: { [real.rows[0].site]: 'export {};\n' }, only: [real.rows[0].module] });
  assert.throws(() => realOk(stubbed), /PROV-REAL/, '🔴 PROV-REAL-CELL: a stubbed registered generator turns the guard red');

  const ctl = world({ rows: [] });
  assert.ok(isUnreg(ctl) && verdict(ctl) === 1, '🔴 PROV-CTL: an unregistered extracted-tree hash site still exits 1');
  const live = build({ extra: { 'xpizza-functions/zz-synthetic.guard.test.js': "const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');\nassert.strictEqual(sha(read('my-orders.js')), 'x');" }, provenance: { rows: [ROW] }, only: [M] });
  assert.ok(live.unregistered.some((u) => u.module === M && u.site === 'xpizza-functions/zz-synthetic.guard.test.js') && verdict(live) === 1, '🔴 PROV-CTL: an unregistered LIVE-tree hash site still exits 1 beside a valid registry');
  const out = world({ con: `${CONSRC}test('a new cell after the region', () => { assert.ok(1); });\n`.replace("import assert from 'node:assert';\n", "import assert from 'node:assert';\nimport { x } from './y.mjs';\n") });
  assert.ok(!isUnreg(out) && pp(out).status === 'ok' && verdict(out) === 0, `🔴 PROV-CON-OUT: edits OUTSIDE the region (above and below) keep the pin ok: ${JSON.stringify(pp(out))}`);
  const good = world();
  assert.ok(!isUnreg(good) && pp(good).status === 'ok' && verdict(good) === 0, `🔴 PROV-OK: a registered pin with both reviewed hashes and the right blob is accepted: ${JSON.stringify(pp(good))}`);
  assert.strictEqual(pp(good).live_differs, false, 'PROV-INFO: pinned at HEAD ⇒ the live blob is the pinned blob');
  const stale = world({ fix: fix(OLD, git('rev-parse', `${OLD}:xpizza-functions/${M}`)) });
  assert.ok(pp(stale).status === 'ok' && pp(stale).live_differs === true && verdict(stale) === 0, '🔴 PROV-INFO: a pin at an older sha is reported live_differs, never a failure');

  const g = world({ site: `${GEN}// reviewed? no\n` });
  assert.ok(refused(g, 'generator_changed'), `🔴 PROV-GEN: an edited generator is refused until re-registered: ${JSON.stringify(pp(g))}`);
  const c = world({ con: CONSRC.replace("b, 'pin'", "b, 'pin2'") });
  assert.ok(refused(c, 'consumer_changed', 'region_bytes'), `🔴 PROV-CON: an edit INSIDE the consumer region is refused until re-registered: ${JSON.stringify(pp(c))}`);
  const c2 = world({ con: null });
  assert.ok(refused(c2, 'consumer_changed', 'marker_missing'), `🔴 PROV-CON: a missing consumer is refused: ${JSON.stringify(pp(c2))}`);
  const cm = world({ con: CONSRC.replace(END, '') });
  assert.ok(refused(cm, 'consumer_changed', 'marker_missing'), `🔴 PROV-MARK-MISSING: a consumer without its END marker is refused: ${JSON.stringify(pp(cm))}`);
  const cf = world({ con: CONSRC.replace(BEG, '// PROVENANCE-PIN:BEGIN zz (moved)\n') });
  assert.ok(refused(cf, 'consumer_changed', 'marker_malformed'), `🔴 PROV-MARK-MALFORMED: a marker that is not the bare line comment is refused: ${JSON.stringify(pp(cf))}`);
  const cd = world({ con: `${CONSRC}${BEG}${REGION}${END}` });
  assert.ok(refused(cd, 'consumer_changed', 'marker_duplicate'), `🔴 PROV-MARK-DUP: two regions with the same id are refused: ${JSON.stringify(pp(cd))}`);
  const co = world({ con: `import assert from 'node:assert';\n${END}${REGION}${BEG}` });
  assert.ok(refused(co, 'consumer_changed', 'marker_order'), `🔴 PROV-MARK-ORDER: END before BEGIN is refused: ${JSON.stringify(pp(co))}`);
  // Codex r2 P2-1: comments are read from the SYNTAX TREE (acorn), never lexically
  const cw = world({ con: `import assert from 'node:assert';\n/*/\n${BEG}${REGION}${END}*/\ntest('other cell', () => {});\n` });
  assert.ok(refused(cw, 'consumer_changed', 'region_commented'), `🔴 PROV-STUB-WRAP: the region wrapped in /*/ … */ (bytes unchanged) is refused: ${JSON.stringify(pp(cw))}`);
  const BODY = '/*\ntext\n*/\n';
  const cy = world({ con: `${BEG}${BODY}${END}`, rows: [{ ...ROW, consumer_sha256: h(BODY) }] });
  assert.ok(refused(cy, 'consumer_changed', 'region_commented'), `🔴 PROV-STUB-BODY: a registered /*…*/ body is refused: ${JSON.stringify(pp(cy))}`);
  const cb = world({ con: `import assert from 'node:assert';\n/*\n${BEG}${REGION}${END}*/\ntest('other cell', () => {});\n` });
  assert.ok(refused(cb, 'consumer_changed', 'region_commented'), `🔴 PROV-STUB: the reviewed region moved into a block comment (bytes unchanged) is refused: ${JSON.stringify(pp(cb))}`);
  const STUB = REGION.split('\n').filter(Boolean).map((l) => `// ${l}\n`).join('');
  const cs = world({ con: `${BEG}${STUB}${END}`, rows: [{ ...ROW, consumer_sha256: h(STUB) }] });
  assert.ok(refused(cs, 'consumer_changed', 'region_commented'), `🔴 PROV-STUB: a comment-only region is refused even if registered: ${JSON.stringify(pp(cs))}`);
  for (const NT of ['const zz = 1;\n', "test.skip('zz', () => {});\n", "if (false) test('zz', () => {});\n"]) {
    const cn = world({ con: `${BEG}${NT}${END}`, rows: [{ ...ROW, consumer_sha256: h(NT) }] });
    assert.ok(refused(cn, 'consumer_changed', 'no_test_call'), `🔴 PROV-NO-TEST: a registered region with no top-level test( call is refused (${NT.trim()}): ${JSON.stringify(pp(cn))}`);
  }
  const cu = world({ con: `${CONSRC}const = ;\n` });
  assert.ok(refused(cu, 'consumer_unparseable', 'consumer_unparseable'), `🔴 PROV-UNPARSEABLE: a consumer that does not parse is refused (fail closed): ${JSON.stringify(pp(cu))}`);
  // Codex r2 P2-3: the fixture sha is validated BEFORE git is invoked
  for (const bad of ['HEAD', 123, `${HEAD} `]) {
    const calls = [];
    const spy = (spec) => { calls.push(spec); try { return git('rev-parse', '-q', '--verify', spec); } catch (_) { return null; } };
    // the spy counts THIS row's git calls only: the synthetic row alone (the real rows make their own)
    const cx = world({ fix: fix(bad, BLOB), revParse: spy, rows: [ROW] });
    assert.ok(refused(cx, 'fixture_blob', 'sha_format') && calls.length === 0, `🔴 PROV-SHA: fixture sha ${JSON.stringify(bad)} is refused with git never invoked (calls ${JSON.stringify(calls)}): ${JSON.stringify(pp(cx))}`);
  }
  const spyCalls = []; const spyOk = (spec) => { spyCalls.push(spec); return git('rev-parse', '-q', '--verify', spec); };
  assert.ok(pp(world({ revParse: spyOk, rows: [ROW] })).status === 'ok' && spyCalls.length === 1, 'premise: the injected rev-parse is the one the tool uses');
  const b = world({ fix: fix(HEAD, '0'.repeat(40)) });
  assert.ok(refused(b, 'fixture_blob'), `🔴 PROV-B: a fixture blob that is not the module at its sha is refused: ${JSON.stringify(pp(b))}`);
  // Codex r1's four bypasses, each now a byte change to a reviewed file ⇒ refused by construction
  const attacks = {
    'stray read with a space': { site: `${GEN}const L = readFileSync (join(ROOT, 'xpizza-functions', '${M}'));\n` },
    'argv fallback to the live tree': { site: GEN.replace('process.argv[2]', "process.argv[2] || join(process.cwd(), 'xpizza-functions')") },
    'consumer by ${HEAD} / assert.ok(git)': { con: CONSRC.replace('${Z.sha}', '${HEAD}') },
    '40-hex only in a comment': { site: GEN.replace("if (!/^[0-9a-f]{40}$/.test(SHA || '')) throw new Error('usage');\n", '// [0-9a-f]{40}\n') },
  };
  for (const [k, o] of Object.entries(attacks)) { const w = world(o); assert.ok(isUnreg(w) && pp(w).status === 'refused' && verdict(w) === 1, `🔴 PROV-R1: Codex r1 bypass «${k}» is refused: ${JSON.stringify(pp(w))}`); }
  ok('provenance pins (reviewed content pins): the 2 registry rows reported with both hashes; an unregistered site (extracted or live tree) exits 1; a registered pin is accepted, a stale one only flagged live_differs; the consumer is pinned by its PROVENANCE-PIN region (edits outside it stay ok; an edit inside, a missing / malformed / duplicated / reversed marker, a region overlapping any comment (acorn) or with no top-level test( call, an unparseable consumer are refused); the real registry\'s verdict is 0; a non-40-hex fixture sha is refused before git runs; an edited generator and a wrong fixture blob are refused; Codex r1\'s 4 bypasses are refused');
}

console.log(`\nform-source-inventory.guard: OK (${n})`);
