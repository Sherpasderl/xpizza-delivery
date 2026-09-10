'use strict';
// ---------------------------------------------------------------------------
// AST enumeration of EVERY CONTROL PREDICATE. Test-harness only — never required by any function.
//
// 🔴 DENY BY DEFAULT, and this is the third time the same lesson has had to be learned here. The rule
// being enforced is that a presence test may gate REQUIREDNESS and never whether a present value is
// VALIDATED. A regex could not enumerate the tests to classify. Nor could an AST scanner that only
// recorded predicates matching a list of RECOGNISED presence shapes — because a spelling the list did
// not anticipate (`!!x`, `Boolean(x)`, `x?.y`, `x.length > 0`, `return x && f(x)`, a comma compound)
// was not classified as safe, it was never seen at all. A whitelist of recognised shapes fails open on
// everything outside it, which is the very defect the audit exists to prevent, one level up.
//
// So NOTHING here decides that a predicate is uninteresting. Every predicate acorn yields is
// enumerated and a human rules it — including as `not-a-presence-test`. A novel spelling is still a
// predicate, so it still has to be ruled, so it cannot slip.
// ---------------------------------------------------------------------------
const { parse } = require('acorn');

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

const childrenOf = (node) => {
  const out = [];
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') out.push(c); }
    else if (v && typeof v.type === 'string') out.push(v);
  }
  return out;
};

// The exact callee of a call expression — `Object.prototype.hasOwnProperty.call`, `Array.isArray`,
// `Boolean`. Resolved as a whole dotted name and compared EXACTLY: a substring match reported
// `isArrayOfValidPrices(x)` as `Array.isArray`, which is a different function with different meaning.
function calleeName(call) {
  const parts = [];
  let n = call.callee;
  if (n && n.type === 'ChainExpression') n = n.expression;
  while (n && n.type === 'MemberExpression') {
    if (n.computed || !n.property || !n.property.name) return null;
    parts.unshift(n.property.name);
    n = n.object;
  }
  if (!n || n.type !== 'Identifier') return null;
  parts.unshift(n.name);
  return parts.join('.');
}

// A stable, formatting-independent name: the enclosing function plus the normalised text of the
// predicate. Line numbers churn on every edit; the text of the test does not.
const normalise = (src, node) => src.slice(node.start, node.end).replace(/\s+/g, ' ').trim();

function enumeratePredicates(src) {
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  const found = [];
  const seen = new Map();
  const parents = new Map();

  // A `&&` that IS the test of an `if` is part of that predicate, not a second one. A short-circuit
  // standing anywhere else — a statement, a return, an initialiser, an argument — is its own.
  const isOwnPredicate = (node) => {
    let cur = node;
    let up = parents.get(cur);
    while (up && up.type === 'LogicalExpression') { cur = up; up = parents.get(cur); }
    if (!up) return true;
    const isTestOf = ['IfStatement', 'ConditionalExpression', 'WhileStatement', 'DoWhileStatement', 'ForStatement'];
    if (isTestOf.includes(up.type) && up.test === cur) return false;
    if (up.type === 'UnaryExpression') return false;
    return true;
  };

  const visit = (node, fnName) => {
    let name = fnName;
    if (FUNCTION_TYPES.has(node.type) && node.id) name = node.id.name;

    const record = (test, kind) => {
      if (!test) return;
      const text = normalise(src, test);
      const base = `${name || '<module>'} :: ${text}`;
      const nth = (seen.get(base) || 0) + 1;
      seen.set(base, nth);
      found.push({ key: nth === 1 ? base : `${base} #${nth}`, kind, line: test.loc.start.line, text });
    };

    // EVERY control predicate. No filter — the classification is the human's, not the scanner's.
    if (node.type === 'IfStatement') record(node.test, 'if');
    else if (node.type === 'ConditionalExpression') record(node.test, 'ternary');
    else if (node.type === 'WhileStatement' || node.type === 'DoWhileStatement') record(node.test, 'while');
    else if (node.type === 'ForStatement' && node.test) record(node.test, 'for');
    else if (node.type === 'LogicalExpression' && ['&&', '||', '??'].includes(node.operator) && isOwnPredicate(node)) {
      record(node.left, `short-circuit ${node.operator}`);
    }

    for (const c of childrenOf(node)) { parents.set(c, node); visit(c, name); }
  };
  visit(ast, null);
  return found;
}

// Every module the runtime can reach from an entrypoint, followed transitively. A parser that no
// deployed file requires DIRECTLY can still arrive through something one of them requires.
function runtimeImportGraph(entryFiles, resolveDir) {
  const { readFileSync, existsSync } = require('fs');
  const { join, dirname, resolve } = require('path');
  const seenFiles = new Set();
  const externals = new Set();
  const walk = (file) => {
    if (seenFiles.has(file) || !existsSync(file)) return;
    seenFiles.add(file);
    let code;
    try { code = readFileSync(file, 'utf8'); } catch (_) { return; }
    for (const m of code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) { externals.add(spec.split('/')[0]); continue; }
      const base = resolve(dirname(file), spec);
      for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
        if (existsSync(candidate) && !candidate.endsWith('/')) { walk(candidate); break; }
      }
    }
  };
  for (const f of entryFiles) walk(resolve(resolveDir, f));
  return { files: [...seenFiles], externals: [...externals] };
}

module.exports = { enumeratePredicates, calleeName, runtimeImportGraph };
