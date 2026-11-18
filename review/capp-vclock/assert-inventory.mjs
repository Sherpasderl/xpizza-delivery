// Review tooling (the capp's virtual-clock migration evidence). PLAN-capp-virtual-clock r0 §4.1 — the assertion inventory: per test(name), the ORDERED list of assert.* calls with their exact
// source text. A migration chunk may change harness lines only; the inventories before and after must be IDENTICAL.
//   node review/capp-vclock/assert-inventory.mjs <file.test.mjs> [<rev>]   → JSON on stdout (rev: read the file at a git revision instead of the tree)
//   node review/capp-vclock/assert-inventory.mjs --diff <file> <revA> [<revB>|WT]  → exit 0 iff identical; prints the differing tests otherwise
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const acorn = createRequire(join(ROOT, 'xpizza-functions/x.js'))('acorn');
// a minimal full walk (acorn-walk is not installed): every node, depth-first, parents before children
const walk = { full(node, cb) { const go = (n) => { if (!n || typeof n.type !== 'string') return; cb(n); for (const k of Object.keys(n)) { if (k === 'start' || k === 'end') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(go); else if (v && typeof v === 'object' && typeof v.type === 'string') go(v); } }; go(node); } };

function source(file, rev) {
  if (!rev || rev === 'WT') return readFileSync(file, 'utf8');
  return execFileSync('git', ['show', `${rev}:${relative(ROOT, resolve(file))}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 });
}
const isAssert = (n) => n.type === 'CallExpression' && ((n.callee.type === 'MemberExpression' && n.callee.object.type === 'Identifier' && n.callee.object.name === 'assert')
  || (n.callee.type === 'Identifier' && n.callee.name === 'assert'));
const norm = (s) => s.replace(/\s+/g, ' ').trim();

export function inventory(src) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
  const tests = [], seen = new Map(), asserts = [];
  walk.full(ast, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'test' && n.arguments.length) {
      const a0 = n.arguments[0];
      const name = a0.type === 'Literal' ? String(a0.value) : a0.type === 'TemplateLiteral' ? norm(src.slice(a0.start, a0.end)) : `<expr ${a0.start}>`;
      const k = seen.has(name) ? `${name} #${seen.set(name, seen.get(name) + 1).get(name)}` : (seen.set(name, 1), name);
      tests.push({ k, start: n.start, end: n.end });
    }
    if (isAssert(n)) asserts.push(n);
  });
  // every assert belongs to its innermost test(); one outside every test (a shared helper: boot, until, held helpers) is listed
  // under «(helpers)» — a chunk may not weaken a helper's assertion either
  const out = new Map([['(helpers)', []], ...tests.map((t) => [t.k, []])]);
  for (const m of asserts) {
    const owner = tests.filter((t) => t.start <= m.start && m.end <= t.end).sort((x, y) => (y.start - x.start))[0];
    out.get(owner ? owner.k : '(helpers)').push(norm(src.slice(m.start, m.end)));
  }
  return out;
}

const args = process.argv.slice(2);
if (args[0] === '--diff') {
  const [, file, a, b = 'WT'] = args;
  const A = inventory(source(file, a)), B = inventory(source(file, b));
  const bad = [];
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const x = A.get(k), y = B.get(k);
    if (!x || !y) bad.push(`${x ? 'REMOVED' : 'ADDED'} test: ${k}`);
    else if (JSON.stringify(x) !== JSON.stringify(y)) bad.push(`CHANGED asserts in: ${k} (${x.length} → ${y.length})`);
  }
  const n = [...A.values()].reduce((s, v) => s + v.length, 0);
  console.log(bad.length ? bad.join('\n') : `IDENTICAL: ${A.size} tests, ${n} assertions (${a} vs ${b})`);
  process.exit(bad.length ? 1 : 0);
} else {
  const [file, rev] = args;
  console.log(JSON.stringify(Object.fromEntries(inventory(source(file, rev))), null, 1));
}
