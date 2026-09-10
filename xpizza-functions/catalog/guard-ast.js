'use strict';
// ---------------------------------------------------------------------------
// AST enumeration of PRESENCE / EMPTINESS GUARDS. Test-harness only — never required by any function.
//
// 🔴 WHY NOT A REGEX. The rule this enforces is that a presence test may gate REQUIREDNESS and never
// whether a present value is VALIDATED. A text scanner cannot enumerate the tests it has to classify:
// it misses truthiness (`if (x)`, `if (x.length)`), formatting (`if(x!==undefined)`), tests split over
// lines, and guards that are not `if` statements at all — `x && validate(x)`, `x ? validate(x) : y`.
// Anything it fails to see is silently unruled, which is the same fail-open shape one level up.
//
// So the guards are read the way JavaScript reads them, and every one must be classified.
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

// Is this expression asking "is there a value here?" rather than "is this value correct?"
function isPresenceTest(node) {
  if (!node) return false;
  switch (node.type) {
    // x !== undefined / x == null / x === null …
    case 'BinaryExpression':
      if (!['===', '!==', '==', '!='].includes(node.operator)) return false;
      return [node.left, node.right].some((side) => (
        (side.type === 'Identifier' && side.name === 'undefined')
        || (side.type === 'Literal' && side.value === null)
      ));
    case 'UnaryExpression':
      return node.operator === '!' && isReference(node.argument);       // !x, !x.y
    case 'LogicalExpression':
      return isPresenceTest(node.left) || isPresenceTest(node.right);
    case 'CallExpression':
      return /hasOwnProperty|isArray/.test(sourceOfCallee(node));
    case 'Identifier':
      return true;                                                      // bare truthiness: if (x)
    case 'MemberExpression':
      return true;                                                      // if (x.y), if (x.length)
    default:
      return false;
  }
}
const isReference = (n) => n && (n.type === 'Identifier' || n.type === 'MemberExpression');
const sourceOfCallee = (call) => {
  const parts = [];
  let n = call.callee;
  while (n && n.type === 'MemberExpression') { parts.unshift(n.property.name || '?'); n = n.object; }
  if (n && n.type === 'Identifier') parts.unshift(n.name);
  return parts.join('.');
};

// A stable, formatting-independent name for one guard: the function it sits in plus the normalised
// text of its test. Line numbers would churn on every edit; the text of the test does not.
const normalise = (src, node) => src.slice(node.start, node.end).replace(/\s+/g, ' ').trim();

function enumerateGuards(src) {
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  const guards = [];
  const seen = new Map();

  const parents = new Map();
  // A `&&` that IS the test of an `if` is part of that guard, not a second one. Only a short-circuit
  // standing on its own — `x && validate(x);` as a statement, or as an initialiser — is its own guard.
  const isOwnGuard = (node) => {
    let cur = node;
    let up = parents.get(cur);
    while (up && up.type === 'LogicalExpression') { cur = up; up = parents.get(cur); }
    if (!up) return true;
    if ((up.type === 'IfStatement' || up.type === 'ConditionalExpression' || up.type === 'WhileStatement') && up.test === cur) return false;
    if (up.type === 'UnaryExpression' || up.type === 'ReturnStatement') return false;
    return true;
  };

  const visit = (node, fnName) => {
    let name = fnName;
    if (node.type === 'FunctionDeclaration' && node.id) name = node.id.name;
    else if (FUNCTION_TYPES.has(node.type) && node.id) name = node.id.name;

    const record = (test, kind) => {
      if (!isPresenceTest(test)) return;
      const text = normalise(src, test);
      const base = `${name || '<module>'} :: ${text}`;
      const nth = (seen.get(base) || 0) + 1;
      seen.set(base, nth);
      guards.push({ key: nth === 1 ? base : `${base} #${nth}`, kind, line: test.loc.start.line, text });
    };

    if (node.type === 'IfStatement') record(node.test, 'if');
    if (node.type === 'ConditionalExpression') record(node.test, 'ternary');
    // `x && validate(x)` / `x || fail()` — a short-circuit IS a guard when its right side does work.
    if (node.type === 'LogicalExpression' && ['&&', '||'].includes(node.operator)) {
      const rightDoesWork = node.right && (node.right.type === 'CallExpression' || node.right.type === 'AssignmentExpression');
      if (rightDoesWork && isOwnGuard(node)) record(node.left, `short-circuit ${node.operator}`);
    }
    for (const c of childrenOf(node)) { parents.set(c, node); visit(c, name); }
  };
  visit(ast, null);
  return guards;
}

module.exports = { enumerateGuards, isPresenceTest };
