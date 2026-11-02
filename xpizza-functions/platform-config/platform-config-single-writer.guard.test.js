'use strict';
// CONVERGENCE §1 — the projection has ONE writer (plan §0: "the generator is the ONLY writer of a projection"). The RTDB path segment
// restaurants/{rid}/platform_config may be NAMED only by platform-config/projection.js (the generator writes and the reader reads through
// its projectionRef). The detector reads STRING PIECES with a real parser (acorn): literals and template quasis in source order, their
// in-order join included, so a concatenation or a split template is caught; comments prove nothing. Run: node platform-config/platform-config-single-writer.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const acorn = require('acorn');
const FN = path.join(__dirname, '..');
const OWNER = 'platform-config/projection.js';
const SEG = /restaurants\/[^\s'"`]*\/\s*platform_config\b/;   // UNDER restaurants/ only — the top-level node platform_config/* (customer_app, legal, service_bounds…) is a different node
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// every STRING EXPRESSION, evaluated on its own: each literal, each template literal (quasis joined over its ${…} slots), and each
// top-level `+` chain (its literal / template operands joined, a non-string operand as an empty slot) — so a split concatenation or a
// template is caught, while unrelated literals elsewhere in the file are never glued together
function strings(src) {
  let ast; const o = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
  try { ast = acorn.parse(src, { ...o, sourceType: 'script' }); } catch (_) { ast = acorn.parse(src, { ...o, sourceType: 'module' }); }
  const out = [];
  const flat = (nd) => {
    if (nd.type === 'Literal') return typeof nd.value === 'string' ? nd.value : '';
    if (nd.type === 'TemplateLiteral') return nd.quasis.map((q) => (q.value.cooked == null ? q.value.raw : q.value.cooked)).join('');
    if (nd.type === 'BinaryExpression' && nd.operator === '+') return flat(nd.left) + flat(nd.right);
    return '';
  };
  (function walk(nd, inPlus) { if (!nd || typeof nd !== 'object') return; if (Array.isArray(nd)) { nd.forEach((x) => walk(x, inPlus)); return; }
    const plus = nd.type === 'BinaryExpression' && nd.operator === '+';
    if ((plus && !inPlus) || nd.type === 'TemplateLiteral' || (nd.type === 'Literal' && typeof nd.value === 'string')) out.push(flat(nd));
    for (const [k, v] of Object.entries(nd)) if (k !== 'type' && v && typeof v === 'object') walk(v, plus); }(ast, false));
  return out;
}
const offends = (src) => strings(src).some((p) => SEG.test(p));
for (const [why, src] of [['a template', 'db.ref(`restaurants/${rid}/platform_config`).set(x);'], ['a concatenation', "db.ref('restaurants/' + rid + '/platform' + '_config');"],
  ['a literal', "db.ref('restaurants/x_pizza/platform_config').set(1);"]]) assert.ok(offends(src), `🔴 bypass not caught: ${why}`);
for (const [why, src] of [['the top-level node', "db.ref('platform_config/customer_app')"], ['an unrelated slash before the top-level node', "const a = '/'; read('platform_config/service_bounds');"], ['a comment', '// restaurants/{rid}/platform_config\nconst a = 1;']]) assert.ok(!offends(src), `not tripped by ${why}`);
ok('the detector: a literal, a template, a split concatenation are caught; the top-level platform_config/* node and comments are not');
const files = execFileSync('git', ['ls-files', '--', '.'], { cwd: FN, encoding: 'utf8' }).split('\n').concat([OWNER])
  .filter((f, i, a) => a.indexOf(f) === i && /\.(js|mjs|cjs)$/.test(f) && !/node_modules\//.test(f) && !/\.test\.(js|mjs|cjs)$/.test(f) && !/^test\//.test(f) && fs.existsSync(path.join(FN, f)));
assert.ok(offends(fs.readFileSync(path.join(FN, OWNER), 'utf8')), 'premise: the owning module names the path');
const bad = files.filter((f) => f !== OWNER && offends(fs.readFileSync(path.join(FN, f), 'utf8')));
assert.deepStrictEqual(bad, [], `🔴 non-test source naming restaurants/{rid}/platform_config outside ${OWNER}: ${bad.join(', ')}`);
ok(`single writer: ${OWNER} is the ONLY non-test source (of ${files.length}) naming the projection path; the generator writes and the reader reads through it`);
console.log(`platform-config-single-writer.guard: OK (${n})`);
