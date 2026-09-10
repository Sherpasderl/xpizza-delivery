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
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT THIS IS, AND WHAT IT IS NOT. This is a STRONG LINT over predicate nodes. It is not a proof
// that no validation is gated on presence, and it should not be mistaken for one.
//
// It sees every control predicate — if / ternary / while / for tests, and standalone && || ?? — and
// forces each to be classified. What it does NOT see is validation gated through something that is
// not a predicate at all:
//
//     [x].filter(Boolean).forEach(validate)     gating via a collection operation
//     void (x && f(x))                          the guard swallowed by an expression
//     x &&= f(x)                                a logical ASSIGNMENT, not a logical expression
//     switch (Boolean(x)) { case true: ... }    a switch discriminant rather than a test
//
// Those are out of scope BY DESIGN. Chasing them is an arms race with no end state — every form
// closed suggests another — and the thing that actually protects a customer is the validator itself,
// which is exhaustively covered elsewhere: the FIELD CENSUS plants absent / wrong-type / null /
// invalid / dangling-reference / duplicate / collection-absent values into every field of the REAL
// SEED and requires each to be refused. That census tests BEHAVIOUR and does not care how a rule is
// spelled, so helper-mediated gating shows up there as an accepted bad value.
//
// This lint's job is narrower and worth having: it stops the ordinary `if (x !== undefined) {
// validate(x) }` from being written without someone thinking about it, which is the shape that
// actually occurred, twice. Read it as that, and do not reopen the arms race on the strength of it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
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
//
// Two bugs this replaces, both of which made the walk quietly incomplete:
//   • the require sites were found by a regex that demanded `require(` with no space, so
//     `require ('acorn')` was invisible. Imports are now discovered from the SYNTAX TREE.
//   • resolution accepted a bare directory path, then failed to read it as a file and returned —
//     so `require('./somedir')` terminated that branch of the walk silently. Resolution is now
//     Node's own, and an edge that cannot be resolved FAILS rather than ending the walk.
function runtimeImportGraph(entryFiles, resolveDir) {
  const { readFileSync } = require('fs');
  const { dirname, resolve } = require('path');
  const files = new Set();
  const externals = new Set();
  const unresolved = [];
  const dynamic = [];

  const requiresIn = (code, file) => {
    const specs = [];
    let ast;
    try { ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true }); }
    catch (e) { unresolved.push(`${file}: unparseable (${e.message})`); return specs; }
    const walkNode = (node) => {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
        const arg = node.arguments[0];
        if (arg && arg.type === 'Literal' && typeof arg.value === 'string') specs.push(arg.value);
        // A computed specifier cannot be followed, so it is REPORTED rather than skipped — an
        // unfollowable edge is exactly where something unexpected would hide.
        else dynamic.push(`${file}:${node.loc.start.line}`);
      }
      for (const c of childrenOf(node)) walkNode(c);
    };
    walkNode(ast);
    return specs;
  };

  const walk = (file) => {
    if (files.has(file)) return;
    files.add(file);
    let code;
    try { code = readFileSync(file, 'utf8'); } catch (e) { unresolved.push(`${file}: unreadable`); return; }
    for (const spec of requiresIn(code, file)) {
      if (!spec.startsWith('.')) { externals.add(spec.split('/')[0]); continue; }
      let target;
      // Node's OWN resolution — directories, index.js, package.json "main", extensions and all.
      try { target = require.resolve(spec, { paths: [dirname(file)] }); }
      catch (e) { unresolved.push(`${file} -> ${spec}`); continue; }
      walk(target);
    }
  };
  for (const f of entryFiles) {
    let entry;
    try { entry = require.resolve(resolve(resolveDir, f)); }
    catch (e) { unresolved.push(`entry ${f}`); continue; }
    walk(entry);
  }
  return { files: [...files], externals: [...externals], unresolved, dynamic };
}

module.exports = { enumeratePredicates, calleeName, runtimeImportGraph };
