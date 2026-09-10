// Syntax-tree analysis for the wiring guards. Test-harness only — never served, never imported by the
// portal. It exists because a TEXT scanner cannot be deny-by-default: to reject the unrecognised it
// must first recognise everything, and a regex classifier necessarily treats "context I could not
// parse" as safe. Three separate bypasses got through that way, each a syntax form the previous
// version had not been told about.
//
// This reads app.js the way JavaScript does. Every reference to `state` — or to any binding that
// aliases it, resolved through real lexical scopes — is classified by its position in the tree, and
// ONLY positions on an explicit allowlist are accepted. There is no "unknown context" branch that
// falls through to safe: the switch ends in a reject.
import { parse } from 'acorn';

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

// ── SCOPES ───────────────────────────────────────────────────────────────────────────────────────
// Real lexical scopes with real binding resolution. Brace depth was the previous approximation and it
// was wrong in both directions: it reported ordinary locals named `r` as aliases of state.review, and
// it could not have seen a genuine alias shadowed by an inner declaration.
class Scope {
  constructor(parent, node) { this.parent = parent; this.node = node; this.bindings = new Map(); }
  declare(name, info) { this.bindings.set(name, info); }
  lookup(name) { return this.bindings.has(name) ? this.bindings.get(name) : (this.parent ? this.parent.lookup(name) : null); }
}

function patternNames(pat, out = []) {
  if (!pat) return out;
  switch (pat.type) {
    case 'Identifier': out.push(pat.name); break;
    case 'ObjectPattern': for (const p of pat.properties) patternNames(p.type === 'RestElement' ? p.argument : p.value, out); break;
    case 'ArrayPattern': for (const e of pat.elements) patternNames(e, out); break;
    case 'AssignmentPattern': patternNames(pat.left, out); break;
    case 'RestElement': patternNames(pat.argument, out); break;
    default: break;
  }
  return out;
}

// Walk every child node, recording each node's parent and the scope it sits in.
export function analyse(src) {
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const parents = new Map();
  const scopeOf = new Map();
  const fnOf = new Map();
  const root = new Scope(null, ast);
  root.isFunctionScope = true;

  const children = (n) => {
    const out = [];
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc') continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') out.push(c); }
      else if (v && typeof v.type === 'string') out.push(v);
    }
    return out;
  };

  const visit = (node, parent, scope, fn) => {
    parents.set(node, parent);
    scopeOf.set(node, scope);
    fnOf.set(node, fn);
    let inner = scope, innerFn = fn;
    if (FUNCTION_TYPES.has(node.type)) {
      inner = new Scope(scope, node); innerFn = node;
      inner.isFunctionScope = true;
      for (const p of node.params) for (const nm of patternNames(p)) inner.declare(nm, { kind: 'param', node: p });
      if (node.type === 'FunctionDeclaration' && node.id) scope.declare(node.id.name, { kind: 'function', node });
      // A NAMED FUNCTION EXPRESSION binds its own name inside itself. Missing it made that name resolve
      // to whatever was outside — so `const f = function state() {...}` had `state` resolving to the
      // module's state object inside f.
      if (node.type === 'FunctionExpression' && node.id) inner.declare(node.id.name, { kind: 'self', node });
    } else if (node.type === 'BlockStatement' || node.type === 'ForStatement' || node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
      inner = new Scope(scope, node);
    } else if (node.type === 'CatchClause') {
      // A catch parameter is a binding like any other; without this it resolved outward.
      inner = new Scope(scope, node);
      for (const nm of patternNames(node.param)) inner.declare(nm, { kind: 'catch', node });
    }
    if (node.type === 'VariableDeclaration') {
      // `var` hoists to the nearest FUNCTION scope, not the block it is written in. Declaring it in the
      // block meant a var-declared alias was invisible to every reference outside that block.
      let target = scope;
      if (node.kind === 'var') { while (target.parent && !target.isFunctionScope) target = target.parent; }
      for (const d of node.declarations) for (const nm of patternNames(d.id)) target.declare(nm, { kind: node.kind, node: d });
    }
    if (node.type === 'ImportDeclaration') {
      for (const sp of node.specifiers) scope.declare(sp.local.name, { kind: 'import', node: sp, from: node.source.value });
    }
    for (const c of children(node)) visit(c, node, inner, innerFn);
  };
  // hoist module-level function declarations and variables before descending
  for (const n of ast.body) {
    const d = n.type === 'ExportNamedDeclaration' ? n.declaration : n;
    if (d && d.type === 'FunctionDeclaration' && d.id) root.declare(d.id.name, { kind: 'function', node: d });
    if (d && d.type === 'VariableDeclaration') for (const dd of d.declarations) for (const nm of patternNames(dd.id)) root.declare(nm, { kind: d.kind, node: dd });
  }
  visit(ast, null, root, null);
  return { ast, parents, scopeOf, fnOf, root, children };
}

// ── THE ALLOWLIST ────────────────────────────────────────────────────────────────────────────────
// Calls that may RECEIVE a state reference, in any argument position. Each is a pure reader or one of
// the editor's guarded setters, which enforce the canEdit boundary themselves.
export const ALLOWED_CONSUMERS = new Set([
  'setItemPrice', 'setExtraPrice', 'discard', 'commit', 'commitTo',
  'draftSource', 'pendingChanges', 'pendingCount', 'isPublishable', 'canEditDraft', 'createDraft',
  'optionGroups', 'groupUsage', 'reviewModel', 'attestationModel', 'canPublish', 'pickRid',
  'releaseEditLock', 'loadMenu', 'publisher.run',
  // The view modules. Licensed by an executable guard below: render.js, review.js and portal-logic.js
  // contain no reference to `state` at all, so a reference handed to them cannot be written through.
  'renderRail', 'renderDetail', 'renderReview', 'renderAttestation', 'renderOutcome', 'receiptFor',
  // A WeakSet membership test. It cannot reach the object's properties, let alone write one.
  'mintedReviews.has',
]);
// Method calls on a state property, by FULL CHAIN — so a mutating method is permitted on exactly the
// collection it was ruled for and nowhere else.
export const ALLOWED_METHOD_CHAINS = new Set([
  'state.restaurants.find', 'state.restaurants.some',
  'state.groups.find', 'state.groups.some',
  'state.openGroups.has', 'state.openGroups.add', 'state.openGroups.delete',
]);
// 🔴 PROPERTIES WHOSE VALUE IS A PRIMITIVE, and therefore cannot be retained or mutated by whoever
// receives it. Reading one yields a copy of a string, number, boolean or null, so the escape rules
// below do not apply to it — `editCatalog({ rid: state.draftRid })` hands over a string, not a handle.
//
// The polarity matters: anything NOT listed here is treated as a REFERENCE and gets the strict rules.
// A new field is therefore strict until somebody rules it primitive, rather than lax until somebody
// notices it is not.
export const PRIMITIVE_PROPS = new Set([
  'currentRid', 'draftRid', 'sourceUpdateTime', 'usesPlatformFactura', 'menuLoading',
  'selectedCat', 'drawerKey', 'uid', 'publishGen', 'reviewLock',
  'editToken', 'acknowledged', 'rid', 'length', 'id', 'name',
]);

// Parent contexts in which a state reference is being READ and cannot escape: the value is consumed to
// produce a decision or a primitive, not handed to anything that could retain or mutate it.
const READ_CONTEXTS = new Set([
  'BinaryExpression', 'LogicalExpression', 'ConditionalExpression',
  'IfStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'SwitchCase',
  'ExpressionStatement', 'ForOfStatement',
]);
// A plain template literal stringifies its expressions and cannot retain them. A TAGGED one passes
// them to the tag function as live values, so it is an escape, not a read.
const isPlainTemplate = (parent, parents) => parent.type === 'TemplateLiteral'
  && !(parents.get(parent) && parents.get(parent).type === 'TaggedTemplateExpression');

const chainString = (node) => {
  const parts = [];
  let n = node;
  while (n && n.type === 'MemberExpression') { if (n.computed) return null; parts.unshift(n.property.name); n = n.object; }
  if (!n || n.type !== 'Identifier') return null;
  parts.unshift(n.name);
  return parts.join('.');
};
const calleeName = (callee) => (callee.type === 'Identifier' ? callee.name : chainString(callee));

// Every reference to `state` or to a binding aliased from it, classified by where it sits in the tree.
// Returns the violations; an empty array means every reference reduced to a proven-safe shape.
export function stateViolations(src, label = 'app.js') {
  const { ast, parents, scopeOf, root, children } = analyse(src);
  const stateBinding = root.lookup('state');
  if (!stateBinding) return [];
  const bad = [];
  const at = (n) => `${label}:${n.loc.start.line}`;

  // ── TAINT, to a fixpoint. A binding is tainted when its initializer reaches state; an alias of an
  // alias is reached on the next pass. Escapes are NOT propagated through — they are rejected, so
  // there is nothing to follow.
  const tainted = new Set([stateBinding]);

  // 🔴 ONE VALUE-FLOW RULE, used by BOTH taint and classification. They disagreed: classification
  // followed conditionals, logicals and comma sequences (so `f(c ? state.review : x)` was caught as an
  // escape), while taint followed only member chains — so `const r = c ? state.review : x` bound a live
  // reference that the analysis then treated as an ordinary local. An escape rule and a taint rule that
  // describe different languages leave exactly the gap between them.
  //
  // Methods that hand back an ELEMENT of a state collection propagate too: `state.groups.find(...)`
  // returns the group itself, not a copy of it.
  const REFERENCE_RETURNING = new Set(['find', 'at', 'pop', 'shift', 'get']);
  const reaches = (node, scope) => {
    if (!node) return false;
    switch (node.type) {
      case 'Identifier': { const b = scope && scope.lookup(node.name); return !!b && tainted.has(b); }
      case 'MemberExpression':
        // A chain ending in a ruled PRIMITIVE yields a value, not a reference — `const held =
        // state.reviewLock` binds a number. Propagating taint through it would report every ticket
        // variable in the file as a live handle on state.
        if (!node.computed && PRIMITIVE_PROPS.has(node.property.name)) return false;
        return reaches(node.object, scope);
      case 'ChainExpression': return reaches(node.expression, scope);
      case 'ConditionalExpression': return reaches(node.consequent, scope) || reaches(node.alternate, scope);
      case 'LogicalExpression': return reaches(node.left, scope) || reaches(node.right, scope);
      case 'SequenceExpression': return reaches(node.expressions[node.expressions.length - 1], scope);
      case 'AssignmentExpression': return reaches(node.right, scope);
      case 'TSNonNullExpression': return reaches(node.expression, scope);
      case 'CallExpression':
        return node.callee.type === 'MemberExpression' && !node.callee.computed
          && REFERENCE_RETURNING.has(node.callee.property.name) && reaches(node.callee.object, scope);
      default: return false;
    }
  };
  // A REAL FIXED POINT. The previous version capped the passes at an arbitrary number, so a long alias
  // chain would simply stop being followed — silently, with no signal that the answer was partial.
  // The set only ever grows and is bounded by the number of bindings, so this terminates; the cap that
  // remains is a loop-safety backstop that ASSERTS rather than shrugs.
  let passes = 0;
  for (;;) {
    let grew = false;
    const scan = (node) => {
      const sc = scopeOf.get(node);
      if (node.type === 'VariableDeclarator' && node.init && node.id.type === 'Identifier') {
        const b = sc && sc.lookup(node.id.name);
        if (b && !tainted.has(b) && reaches(node.init, scopeOf.get(node.init))) { tainted.add(b); grew = true; }
      }
      // ITERATION HANDS OUT ELEMENT REFERENCES. `for (const g of state.groups) g.price = 1` writes
      // straight through the state object, and the loop variable is the only place to notice.
      if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && node.left) {
        const decl = node.left.type === 'VariableDeclaration' ? node.left.declarations[0] : null;
        const nm = decl && decl.id.type === 'Identifier' ? decl.id.name : (node.left.type === 'Identifier' ? node.left.name : null);
        if (nm && node.type === 'ForOfStatement' && reaches(node.right, scopeOf.get(node.right))) {
          const b = scopeOf.get(node.body) && scopeOf.get(node.body).lookup(nm);
          if (b && !tainted.has(b)) { tainted.add(b); grew = true; }
        }
      }
      for (const c of children(node)) scan(c);
    };
    scan(ast);
    if (!grew) break;
    if (++passes > 500) throw new Error('taint analysis did not converge — the guard cannot vouch for this file');
  }

  // ── CLASSIFY every identifier that resolves to a tainted binding.
  const visit = (node) => {
    if (node.type === 'Identifier') {
      const scope = scopeOf.get(node);
      const b = scope && scope.lookup(node.name);
      if (b && tainted.has(b)) {
        // skip the binding site itself: `const r = state.review` declares r, it does not write through it
        const p = parents.get(node);
        const isBindingSite = p && ((p.type === 'VariableDeclarator' && p.id === node) || FUNCTION_TYPES.has(p.type));
        if (!isBindingSite) classify(node, b === stateBinding);
      }
    }
    for (const c of children(node)) visit(c);
  };

  function classify(id, isRoot) {
    // climb the member chain this identifier roots
    let node = id, hasComputed = false, computedProps = [];
    for (;;) {
      const p = parents.get(node);
      if (p && p.type === 'MemberExpression' && p.object === node) {
        if (p.computed) { hasComputed = true; computedProps.push(p.property); }
        node = p; continue;
      }
      break;
    }
    // 🔴 LOOK THROUGH VALUE-FORWARDING NODES. A conditional, a logical, an optional chain and the last
    // element of a comma sequence all FORWARD the value they were given, so `f(c ? state.review : x)`
    // and `f((0, state.review))` hand the reference to `f` just as plainly as `f(state.review)` does.
    // Treating those nodes as terminal read contexts — which they syntactically are — would have let a
    // reference escape through any one of them.
    const chainNode = node;                 // the member chain itself, before any forwarding climb
    for (;;) {
      const up = parents.get(node);
      if (!up) break;
      if (up.type === 'ChainExpression'
        || (up.type === 'ConditionalExpression' && (up.consequent === node || up.alternate === node))
        || (up.type === 'LogicalExpression' && (up.right === node || up.operator !== '&&'))
        || (up.type === 'SequenceExpression' && up.expressions[up.expressions.length - 1] === node)) { node = up; continue; }
      break;
    }
    // 🔴 IS THIS A WRITE TARGET? `({ acknowledged: state.review.acknowledged } = obj)` puts the chain in
    // a Property, which reads exactly like the harmless `{ x: state.review.acknowledged }` — same node
    // type, same position, opposite meaning. The difference is only visible by climbing out of the
    // pattern and asking what it belongs to. This was admitted until the fixture caught it.
    {
      const target = chainString(chainNode) || `${id.name}[…]`;
      let t = chainNode, up = parents.get(t);
      while (up && (up.type === 'Property' || up.type === 'ObjectPattern' || up.type === 'ArrayPattern'
                 || up.type === 'AssignmentPattern' || up.type === 'RestElement')) { t = up; up = parents.get(t); }
      const isTarget = up && ((up.type === 'AssignmentExpression' && up.left === t)
                           || (up.type === 'VariableDeclarator' && up.id === t)
                           || (up.type === 'ForOfStatement' && up.left === t)
                           || (up.type === 'ForInStatement' && up.left === t));
      if (isTarget && t !== chainNode) {
        bad.push(`${at(id)}: \`${target}\` is a destructuring assignment target — state is written through a pattern, which no check that names the field can see`);
        return;
      }
      if (isTarget && (up.type === 'ForOfStatement' || up.type === 'ForInStatement')) {
        bad.push(`${at(id)}: \`${target}\` is assigned by a for-of/for-in binding — state is written outside any ruled shape`);
        return;
      }
    }
    const parent = parents.get(node);
    const shown = chainString(node) || `${id.name}[…]`;
    // Is the VALUE this chain yields a primitive? Only when the chain is a plain member chain whose
    // final property was ruled primitive. Everything else is a reference until proven otherwise.
    // A numeric index in the middle of a chain is fine — it was already validated above — so what
    // decides primitiveness is the FINAL property, not whether any computed step occurred.
    const lastProp = chainNode.type === 'MemberExpression' && !chainNode.computed ? chainNode.property.name : null;
    const isPrimitiveRead = lastProp !== null && PRIMITIVE_PROPS.has(lastProp)
      && !(parent.type === 'AssignmentExpression' && parent.left === chainNode)
      && parent.type !== 'UpdateExpression';
    if (!parent) { bad.push(`${at(id)}: \`${shown}\` appears in no context the analysis understands`); return; }

    // computed access: an array index is a read; a computed PROPERTY NAME is how a write hides from
    // every check that names the field.
    if (hasComputed) {
      const numericOnly = computedProps.every((pr) => pr.type === 'Literal' && typeof pr.value === 'number');
      if (!numericOnly || !isRoot) { bad.push(`${at(id)}: computed access on \`${id.name}\` is not a ruled shape`); return; }
      if (parent.type === 'AssignmentExpression' && parent.left === node) { bad.push(`${at(id)}: assignment through computed access on \`${id.name}\``); return; }
    }

    switch (parent.type) {
      case 'AssignmentExpression':
        if (parent.left === node) {
          if (!isRoot) { bad.push(`${at(id)}: written through the alias \`${id.name}\` — write through state.<field> directly`); return; }
          if (parent.operator !== '=') { bad.push(`${at(id)}: \`${shown} ${parent.operator}\` — only plain assignment to a state property is a ruled shape`); return; }
          if (node.type !== 'MemberExpression') { bad.push(`${at(id)}: \`state\` itself is assigned`); return; }
          const depth = shown.split('.').length;
          if (depth < 2 || depth > 3) { bad.push(`${at(id)}: \`${shown} =\` reaches deeper than a state field and its property`); return; }
          // 🔴 AND IT MUST STAND ALONE AS A STATEMENT. `${state.review.acknowledged = true}` inside a
          // template, or buried in a comma sequence, an argument list or a return, is a write wearing
          // the clothes of an expression — legal JavaScript, legible to nobody, and the shape someone
          // reaches for precisely when they do not want the write noticed. A write is a statement.
          const owner = parents.get(parent);
          if (!owner || owner.type !== 'ExpressionStatement') {
            bad.push(`${at(id)}: \`${shown} =\` is a write used as an EXPRESSION (inside a ${owner ? owner.type : 'unknown node'}) — a state write must stand alone as a statement`);
            return;
          }
          return;                                                  // ALLOWED: the declared write
        }
        if (isPrimitiveRead) return;                               // ALLOWED: a copied primitive
        // Assigning a state reference into a ruled state write target keeps it inside state — it has
        // not escaped anywhere, and the destination is itself counted by the field census.
        if (chainString(parent.left) && chainString(parent.left).startsWith('state.')) return;
        bad.push(`${at(id)}: \`${shown}\` is assigned INTO another location — a state reference must not escape`);
        return;
      case 'VariableDeclarator':
        if (parent.init === node && parent.id.type === 'Identifier') return;   // ALLOWED: an alias
        bad.push(`${at(id)}: \`${shown}\` is destructured — the binding escapes every check that names the field`);
        return;
      case 'CallExpression':
      case 'NewExpression': {
        if (parent.callee === node) {
          if (!ALLOWED_METHOD_CHAINS.has(shown)) { bad.push(`${at(id)}: \`${shown}(\` is not a ruled method on state`); return; }
          return;                                                  // ALLOWED: a ruled method
        }
        const name = calleeName(parent.callee);
        if (isPrimitiveRead && parent.type === 'CallExpression') return;   // ALLOWED: a copied primitive
        if (parent.type === 'NewExpression' || !name || !ALLOWED_CONSUMERS.has(name)) {
          bad.push(`${at(id)}: \`${shown}\` is passed to \`${name || '<expression>'}(\`, which is not a ruled consumer of state`);
          return;
        }
        // 🔴 THE NAME IS NOT THE FUNCTION. `setItemPrice` on the allowlist authorises the imported
        // guarded setter — not a local of the same name, which is a different function with different
        // effects and would have inherited the authorisation for free. Resolve the binding and require
        // it to be the module-level import or declaration the ruling actually meant.
        const rootId = parent.callee.type === 'Identifier' ? parent.callee
          : (parent.callee.type === 'MemberExpression' && parent.callee.object.type === 'Identifier' ? parent.callee.object : null);
        if (!rootId) { bad.push(`${at(id)}: \`${shown}\` is passed to a computed callee, which cannot be authorised`); return; }
        const cb = scopeOf.get(parent.callee) && scopeOf.get(parent.callee).lookup(rootId.name);
        if (!cb) { bad.push(`${at(id)}: \`${shown}\` is passed to \`${rootId.name}(\`, which resolves to no binding in this module`); return; }
        if (cb.kind !== 'import' && cb.kind !== 'function' && !(cb.kind === 'const' && root.bindings.get(rootId.name) === cb)) {
          bad.push(`${at(id)}: \`${shown}\` is passed to \`${rootId.name}(\`, which resolves to a ${cb.kind} binding, not the module-level function the ruling authorises`);
          return;
        }
        return;                                                    // ALLOWED: a ruled consumer
      }
      case 'UpdateExpression':
        bad.push(`${at(id)}: \`${shown}${parent.operator}\` — only plain assignment to a state property is a ruled shape`);
        return;
      case 'Property':
        if (isPrimitiveRead) return;                               // ALLOWED: a copied primitive
        bad.push(`${at(id)}: \`${shown}\` is placed into an object literal — the reference escapes into a container nothing tracks`);
        return;
      case 'ArrayExpression':
      case 'SpreadElement':
      case 'ReturnStatement':
      case 'ArrowFunctionExpression':
      case 'YieldExpression':
      case 'AwaitExpression':
        if (isPrimitiveRead) return;                               // ALLOWED: a copied primitive
        bad.push(`${at(id)}: \`${shown}\` escapes its scope (${parent.type}) — a state reference must not be handed out`);
        return;
      case 'UnaryExpression':
        // `delete state.review` removes the field outright — and on the minted review record it would
        // be an attempt to strip the accessor that locks the acknowledgement.
        if (parent.operator === 'delete') { bad.push(`${at(id)}: \`delete ${shown}\` — state properties may not be deleted`); return; }
        return;                                                    // ALLOWED: !x, typeof x, void x
      case 'MemberExpression':
        if (parent.property === node) return;                      // ALLOWED: used as a key, a read
        bad.push(`${at(id)}: \`${shown}\` in an unrecognised member position`);
        return;
      default:
        if (READ_CONTEXTS.has(parent.type)) return;                // ALLOWED: read
        if (isPlainTemplate(parent, parents)) return;              // ALLOWED: stringified, not handed over
        // 🔴 THE DEFAULT IS REJECT. Not "probably a read" — unproven.
        bad.push(`${at(id)}: \`${shown}\` sits in a ${parent.type}, which is not a ruled context for a state reference`);
    }
  }

  visit(ast);
  return bad;
}

// ── HELPER EFFECTS, TRANSITIVELY ─────────────────────────────────────────────────────────────────
// "Does this listener write?" is not answerable by looking at the listener. `onPrice` writes; a
// callback that merely CALLS onPrice writes just as much, and the previous guard knew that only
// because the name was typed into a hand-maintained list. A name is not an effect: rename the
// function and the list silently stops describing the code.
//
// This computes the writer set instead. Seeds are the imported mutators and any function containing a
// direct state write; the set then closes under "calls a writer", resolved through real scopes so a
// local shadowing a module function does not count as calling it.
const MUTATING_IMPORTS = new Set(['setItemPrice', 'setExtraPrice', 'discard', 'commit', 'commitTo']);

export function writerFunctions(src) {
  const { ast, parents, scopeOf, fnOf, root, children } = analyse(src);
  const stateBinding = root.lookup('state');
  const writes = new Set();          // function nodes that write, directly or transitively
  const calls = new Map();           // function node -> Set of module-level function nodes it calls
  const nameOf = new Map();          // function node -> its module-level name, when it has one
  for (const [nm, info] of root.bindings) {
    if (info.kind === 'function') { nameOf.set(info.node, nm); }
    else if (info.node && info.node.init && FUNCTION_TYPES.has(info.node.init.type)) nameOf.set(info.node.init, nm);
  }

  const scan = (node) => {
    const fn = fnOf.get(node);
    // a direct write: assignment or update whose target is rooted at the state binding
    if ((node.type === 'AssignmentExpression' && node.left) || node.type === 'UpdateExpression') {
      let t = node.type === 'UpdateExpression' ? node.argument : node.left;
      while (t && t.type === 'MemberExpression') t = t.object;
      if (t && t.type === 'Identifier') {
        const b = scopeOf.get(node) && scopeOf.get(node).lookup(t.name);
        if (b && b === stateBinding && fn) writes.add(fn);
      }
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && fn) {
      const b = scopeOf.get(node) && scopeOf.get(node).lookup(node.callee.name);
      if (b) {
        if (b.kind === 'import' && MUTATING_IMPORTS.has(node.callee.name)) writes.add(fn);
        const target = b.kind === 'function' ? b.node : (b.node && b.node.init && FUNCTION_TYPES.has(b.node.init.type) ? b.node.init : null);
        if (target) { if (!calls.has(fn)) calls.set(fn, new Set()); calls.get(fn).add(target); }
      }
    }
    for (const c of children(node)) scan(c);
  };
  scan(ast);

  // Close under "calls a writer", to a REAL fixed point. The previous cap of 32 passes would have
  // silently stopped following a deeper call chain and returned a partial writer set — which reads
  // exactly like a complete one.
  let rounds = 0;
  for (;;) {
    let grew = false;
    for (const [fn, targets] of calls) {
      if (writes.has(fn)) continue;
      for (const t of targets) if (writes.has(t)) { writes.add(fn); grew = true; break; }
    }
    if (!grew) break;
    if (++rounds > 1000) throw new Error('writer analysis did not converge — the guard cannot vouch for this file');
  }
  const names = new Set();
  for (const fn of writes) if (nameOf.has(fn)) names.add(nameOf.get(fn));
  return { writes, names, nameOf, parents, fnOf, ast, children, scopeOf };
}
