'use strict';
// R3 P1 §3d — THE TOKEN GUARD (static; npm test chain; PLAN §7). The failure line `R3-FAIL <cell token>` — what the mutation
// sweep credits with kill_line "^R3-FAIL " — is BUILT only by the designated formatter (contract/gate-a-run.js
// formatFailure). Any other contract source that builds the prefix in a string / template (a neighbor assertion that could
// print a token and earn a kill it did not make) is RED. Regex literals (checks that READ the line) and comments are fine.
// Run: node contract/token.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { walk } = require('./census');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-TOKEN ${m}`;
const PREFIX = 'R3-FAIL';
const DESIGNATED = 'gate-a-run.js';

function builders(code, file) {
  let ast; const opts = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
  try { ast = acorn.parse(code, { ...opts, sourceType: /\.mjs$/.test(file) ? 'module' : 'script' }); } catch (_) { ast = acorn.parse(code, { ...opts, sourceType: 'module' }); }
  const out = [];
  walk(ast, (node, fn) => {
    if (node.type === 'Literal' && typeof node.value === 'string' && node.value.includes(PREFIX)) out.push({ line: node.loc.start.line, fn });
    if (node.type === 'TemplateElement' && String(node.value.cooked).includes(PREFIX)) out.push({ line: node.loc.start.line, fn });
  });
  return out;
}
const SELF = path.basename(__filename);
const files = fs.readdirSync(__dirname).filter((f) => /\.(c?js|mjs)$/.test(f) && f !== SELF);
const found = files.flatMap((f) => builders(fs.readFileSync(path.join(__dirname, f), 'utf8'), f).map((b) => ({ file: f, ...b })));
const bad = found.filter((b) => !(b.file === DESIGNATED && b.fn === 'formatFailure'));
assert.deepStrictEqual(bad.map((b) => `${b.file}:${b.line} (${b.fn || '<top>'})`), [], FAIL('the R3-FAIL prefix is built outside the designated formatter'));
assert.ok(found.some((b) => b.file === DESIGNATED && b.fn === 'formatFailure'), FAIL('the designated formatter does not build the prefix'));
ok(`the "${PREFIX}" prefix is built only in ${DESIGNATED}#formatFailure (${files.length} contract sources scanned; regex readers and comments allowed)`);
// negatives (in memory)
assert.ok(builders("const x = `R3-FAIL ${t}`;", 'neg.js').length === 1 && builders("console.log('R3-FAIL ' + t)", 'neg.js').length === 1, FAIL('a template / string builder was not detected'));
assert.ok(builders("assert.ok(/^R3-FAIL /.test(l)); // R3-FAIL", 'neg.js').length === 0, FAIL('a regex reader / comment was flagged'));
ok('negative: a template or string building the prefix elsewhere is detected; a regex reader / comment is not');
console.log(`\nr3-token guard: OK (${n})`);
