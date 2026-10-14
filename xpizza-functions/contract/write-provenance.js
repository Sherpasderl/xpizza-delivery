'use strict';
/* R3 census — the WRITE INVENTORY by PROVENANCE (B4 r1, advisor ruling on codex R3-B4 r1).
 *
 * 🔴 WHY. The previous inventory matched SHAPES: an object literal handed straight to a write call, a one-hop variable, a
 * `updates[`orders/…`] = …` assignment anywhere. Real writers built their payloads in ways no shape covered — fields
 * assigned onto a record before it goes into the multipath map (create-order-build.js), a sub-object ALIAS mutated by a
 * helper (attachCustomerAttribution's orderRec), a record mutated and Object.assign'ed and then spread into an order
 * TRANSACTION in another file (chargeOnlineOrder → acquireHostedAttempt), props added to a patch after its literal,
 * `.remove()` — and a purely LOCAL `{ 'orders/x': … }` that never persists was reported as a write. One root cause:
 * the field list of a write must come from WHERE ITS PAYLOAD CAME FROM.
 *
 * MODEL (per file, lexically scoped):
 *  - BINDINGS: every var / let / const / param / function in its function scope. A binding's object = its initialisers
 *    (object literals, builder calls, conditionals) + every CONTRIBUTION made to it anywhere in scope:
 *      x.f = v · x['f'] = v · x[k] = v (k unresolved → a dynamic key) · x.f.g = v (→ f, nested) · Object.assign(x, src…)
 *    through ALIASES (`const r = x`, `const r = x[`orders/${id}`]` — r's contributions land on x under that key).
 *  - PARAMS: a contribution to a parameter (a helper mutating its argument) is carried to every CALL SITE of that
 *    function (by name, across files) onto the argument; a payload that IS a parameter (or spreads one) is a PARAM SINK,
 *    resolved at every call site against the argument the caller passes. No call site → the write stays OPAQUE.
 *  - SINKS: <ref>.set / update / push / setWithPriority / transaction / remove (and modular runTransaction at the root).
 *    Fields are recorded ONLY for payloads that reach a sink — so a local object that never persists is quiet.
 *  - OVER-APPROXIMATION (explicit, reviewed): a multipath map (a top-level key `orders…`) that never reaches a sink in
 *    view but ESCAPES (returned, passed to a call, stored) is recorded as written (`escaped-multipath`) — never dropped.
 *  - DYNAMIC: any non-literal key expression (a variable, `'surcharge_' + kind`, a template) in a FIELD position is an
 *    OPAQUE write (`dynamic-field-segment`), RED unless bound in census-map opaqueWriteResolutions. Order-ID positions
 *    may be dynamic (`orders/${id}`).
 * Flow-insensitive on purpose: a contribution anywhere in scope counts, before or after the write (fail-closed).
 *
 * B4 r2 — FAIL CLOSED (advisor ruling on codex R3-B4 r2): every value that reaches a write is either fully resolved or
 * carries an explicit OPAQUE marker for the part that is not — an empty provenance is never a result.
 *  - Unmodelled constructions (arrays, `this`, `new`, any other expression) are UNRESOLVED, never empty; primitives
 *    (literals, templates, unary / binary, `undefined`) write no field of their own.
 *  - HEAP ESCAPE: an object handed to a constructor, put in an array, stored on an untracked object (`this.x = o`) or
 *    passed to a call we do not follow (not a pure library read, not our own function whose parameter stays put) can be
 *    mutated out of view → every write it reaches carries an opaque `… — escapes (<why>)` marker.
 *  - TRANSACTIONS: provenance runs to the updater's RETURN value(s), as everywhere else; the updater's first parameter is
 *    the CURRENT value at the ref (spreading / returning it writes no new field; assignments onto it do). `cur || snap`
 *    is the current value (reviewed: the fallback is the caller's snapshot of the same order). A delegated return is a
 *    builder call whose parameter binds to `cur`.
 *  - CALLS: a call resolves to the local function by scope, an imported one in ITS module file (require / destructured
 *    require / require-then-assign alias), else by name. A function whose parameter reaches a write and that is
 *    referenced as a VALUE (callback, array, re-export under another name) has callers out of view → OPAQUE
 *    (`function-escapes`).
 *  - KEYS: `for (const k in src)` ranges over src's resolved keys (unknown → dynamic). A root key whose FIRST segment is
 *    dynamic and could spell `orders` is opaque, as is a write path whose first segment could.
 *  - A key that CONSTANT-FOLDS exactly to a literal is resolved provenance (advisor r2, amending r1) — see keyStatic.
 *
 * B4 r4 — DEFAULT-DENY (advisor ruling on codex R3-B4 r4; closed by construction, not by finding empty sites): every
 * dispatch has an explicit handled list, and its DEFAULT is an opaque `unmodelled-<kind>` — never a skip, never empty.
 *  - EXPRESSIONS (entriesOf0): object / identifier / pick / member / conditional / logical / await / parens / call
 *    (Object.assign, JSON & structuredClone clones, snapshot `.val()`, our functions) / primitives; anything else → opaque.
 *  - OBJECT PROPERTIES: spread, init, shorthand, computed (folded or opaque), method, getter, setter — all kept.
 *  - ASSIGNMENTS: `=` `||=` `&&=` `??=` flow their value (logical ones as the union of old and new); every other operator
 *    and `x.f++` give an UNMODELLED value (the field is still written); destructuring targets receive unmodelled values;
 *    a member target rooted at a builder's call result marks what it returns as mutated out of view.
 *  - PATTERNS: a pure key path destructures (nested Picks); array / rest / computed / nested-parameter leaves → unmodelled.
 *  - CALLEES: `x.update` and `x['update']` alike; a ref's write method used other than as a direct call (`.call` /
 *    `.bind` / extracted) or named by a non-literal key → opaque.
 * The guarantee is the SEMANTIC corpus in census.negative.test.js (every handled kind and a sample of unhandled ones, on a
 * real writer, must surface its field or an opaque).
 *
 * B4 r5 — TYPED EMPTY (advisor ruling on codex R3-B4 r5: "unknown" may never be ABSENCE):
 *  - ONE CHOKE POINT (entriesOf): every resolved value — a binding's value, a property lookup, a spread, a builder's return —
 *    passes through it. An answer with no entries is OPAQUE (`no-provenance-<kind>`); "this writes no field" is only the
 *    explicit EMPTY entry ({ k:'empty', why }), produced where emptiness is PROVEN (a primitive, `{}`, an absent argument,
 *    a declared-and-never-assigned variable, a cycle whose union the outer frame already holds). A missing property of a
 *    resolved object is therefore opaque too.
 *  - SINKS: `db['ref'](…)` / `['child']` resolve like their dotted forms; a conditional / logical / sequence receiver is the
 *    UNION of its branches (segment-wise: differing segments → '*'); a snapshot `.ref` is a fully dynamic ref; a write-method
 *    call whose receiver is REF-LIKE but does not resolve is an OPAQUE write (`unresolved-ref-receiver`), never skipped.
 *  - BINDINGS: every binding has a modelled source or an opaque one — for-of / for-in (non-key) / catch parameters are
 *    unmodelled; a DEFAULT (`{ a: r = d }`, `(r = d)`) adds d to the binding's values (the union); a nested default is
 *    unmodelled.
 *  - MEMBER BASES: `(c ? a : b).f = v` lands on each branch; any base we cannot follow (and that is not a global / `this`,
 *    whose reads are already opaque at a write) is an OPAQUE write on the enclosing function (`unmodelled-member-base`). */

const WRITE_METHODS = new Set(['set', 'update', 'push', 'setWithPriority', 'transaction', 'remove']);
const IDENT = /^[A-Za-z_$][\w$]*$/;
// a METHOD call by one of these names is a library / SDK call, never matched to a same-named function of ours
// (`db.ref(p).update(patch)` is not a call of identity-integrity-state's `update`)
const COMMON = new Set([...WRITE_METHODS, 'get', 'ref', 'child', 'once', 'on', 'off', 'then', 'catch', 'finally', 'map', 'filter', 'reduce', 'forEach',
  'find', 'some', 'every', 'join', 'split', 'slice', 'splice', 'includes', 'has', 'add', 'delete', 'clear', 'call', 'apply', 'bind', 'assign', 'keys',
  'values', 'entries', 'send', 'json', 'status', 'end', 'log', 'warn', 'error', 'info', 'toString', 'valueOf', 'parse', 'stringify', 'concat', 'sort',
  'replace', 'trim', 'test', 'exec', 'match', 'resolve', 'reject', 'all', 'race', 'next', 'emit', 'write', 'read', 'run', 'start', 'stop', 'close', 'open']);

function writeInventory({ parsed, walk, staticPath, normPath }) {
  const writes = []; const opaqueWrites = [];
  const files = parsed.filter((x) => x.u.kind === 'fn');
  const FN = new Map();             // node → enclosing function name (the census naming)
  const SCOPE = new Map();          // node → its innermost function scope
  const FILE = new Map();           // node → unit
  const FUNCS = new Map();          // function name → [fn node]
  const RETURNS = new Map();        // fn node → [returned expression]
  const PARENT = new Map();         // node → parent node
  const allBindings = [];
  let CID = 0;

  // ── scopes and bindings ──────────────────────────────────────────────────────────────────────────────────────────
  // the function a call names: an identifier (through an ALIAS — `const f = require('./m').g` / `const { g: f } = …` /
  // `const f = g` → g), or a non-library method name. r2 P1-2: a call through an alias is a call site like any other.
  function aliasName(id, depth = 0) {
    const b = resolve(id.name, id);
    if (!b || depth > 4 || b.kind !== 'var' || b.inits.length !== 1) return id.name;
    const i = b.inits[0];
    if (i.type === 'MemberExpression' && !i.computed) return i.property.name;
    if (i.type === 'Pick') return i.key;
    if (i.type === 'Identifier') return aliasName(i, depth + 1);
    return id.name;
  }
  // r4: a member's method NAME — `x.update` and `x['update']` alike; null for a non-literal computed key
  const methodName = (m) => (!m.computed ? m.property.name : (m.property.type === 'Literal' && typeof m.property.value === 'string' ? m.property.value : (m.property.type === 'TemplateLiteral' && !m.property.expressions.length ? m.property.quasis[0].value.cooked : null)));
  const calleeName = (call) => { const c = call.callee; if (c.type === 'Identifier') return aliasName(c); if (c.type === 'MemberExpression') { const nm = methodName(c); if (nm && !COMMON.has(nm)) return nm; } return null; };
  // r4 DEFAULT-DENY: a value we do not model is an explicit UNMODELLED marker (→ opaque wherever it reaches a write)
  const unmodelled = (why, at, u) => { const m = { type: 'Unmodelled', why, node: at, start: at.start, end: at.end, loc: at.loc }; FILE.set(m, u); return m; };
  // every binding LEAF of a pattern: [{ node, path: [key…] | null }] — path null = not modelled (nested / array / rest /
  // computed key / default on a nested pattern); member leaves (assignment targets) are returned as nodes too
  function patternLeaves(pat, path = [], out = []) {
    if (!pat) return out;
    if (pat.type === 'Identifier' || pat.type === 'MemberExpression') { out.push({ node: pat, path }); return out; }
    // r5: a DEFAULT on a leaf — the value may also be the default (`def`, unioned by the binder); on a nested pattern → unmodelled
    if (pat.type === 'AssignmentPattern') {
      if (pat.left.type === 'Identifier' || pat.left.type === 'MemberExpression') { out.push({ node: pat.left, path, def: pat.right }); return out; }
      return patternLeaves(pat.left, null, out);
    }
    if (pat.type === 'ObjectPattern') {
      for (const q of pat.properties) {
        if (q.type === 'RestElement') { patternLeaves(q.argument, null, out); continue; }
        const key = !q.computed ? (q.key.name || String(q.key.value)) : (q.key.type === 'Literal' ? String(q.key.value) : null);
        patternLeaves(q.value, path && key !== null ? [...path, key] : null, out);
      }
      return out;
    }
    if (pat.type === 'ArrayPattern') { for (const el of pat.elements) patternLeaves(el && el.type === 'RestElement' ? el.argument : el, null, out); return out; }
    if (pat.type === 'RestElement') return patternLeaves(pat.argument, null, out);
    out.push({ node: pat, path: null }); return out;
  }
  const declare = (scope, name, info) => {
    let b = scope.vars.get(name);
    if (!b) { b = { name, scope, kind: info.kind, inits: [], contribs: [], index: info.index, fnNode: info.fnNode, declNode: info.declNode, consumed: false, escapes: false, aliasDone: false }; scope.vars.set(name, b); allBindings.push(b); }
    if (info.init) b.inits.push(info.init);
    return b;
  };
  for (const { u, ast } of files) {
    walk(ast, (node, fn) => { FN.set(node, fn); });
    const root = { node: ast, parent: null, vars: new Map(), u, fnNode: null };
    (function rec(node, scope, parent) {
      if (!node || typeof node.type !== 'string') return;
      let sc = scope;
      if (/Function/.test(node.type)) {
        if (node.type === 'FunctionDeclaration' && node.id) declare(scope, node.id.name, { kind: 'fn', fnNode: node });
        sc = { node, parent: scope, vars: new Map(), u, fnNode: node };
        node.params.forEach((p, i) => {
          const id = p.type === 'Identifier' ? p : (p.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? p.left : null);
          // r5: a default (`(r = d)`) is one of the parameter's values (the union with the caller's argument)
          if (id) declare(sc, id.name, { kind: 'param', index: i, fnNode: node, declNode: id, init: p.type === 'AssignmentPattern' ? p.right : null });
          // a DESTRUCTURED parameter: `({ a, b: c })` — each name is the caller's argument property (propKey); every other
          // pattern leaf (nested / array / rest / computed) is UNMODELLED (r4 default-deny)
          if (!id) for (const lf of patternLeaves(p.type === 'AssignmentPattern' ? p.left : p)) {
            if (lf.node.type !== 'Identifier') continue;   // EMPTY-OK: a parameter pattern has no member targets
            if (lf.path && lf.path.length === 1) { const b = declare(sc, lf.node.name, { kind: 'param', index: i, fnNode: node, declNode: lf.node, init: lf.def || null }); b.propKey = lf.path[0]; }
            else declare(sc, lf.node.name, { kind: 'var', init: unmodelled(`param-pattern`, lf.node, u), declNode: lf.node });
            if (p.type === 'AssignmentPattern') declare(sc, lf.node.name, { kind: 'var', init: unmodelled('param-pattern-default', lf.node, u) });
          }
        });
        const nm = FN.get(node);
        if (nm && IDENT.test(nm)) { const l = FUNCS.get(nm) || []; l.push(node); FUNCS.set(nm, l); }
      }
      SCOPE.set(node, sc); FILE.set(node, u); if (parent) PARENT.set(node, parent);
      // `for (const k in src)` — k ranges over src's KEYS (r2: the graduation loop's paths are resolved, not reviewed)
      if (node.type === 'ForInStatement' && node.left.type === 'VariableDeclaration' && node.left.declarations[0] && node.left.declarations[0].id.type === 'Identifier') {
        const ko = { type: 'KeysOf', source: node.right, start: node.right.start, end: node.right.end, loc: node.right.loc }; FILE.set(ko, u); SCOPE.set(ko, sc);
        declare(sc, node.left.declarations[0].id.name, { kind: 'var', init: ko, declNode: node.left.declarations[0] });
      }
      // r5: every binding has a SOURCE — a for-of (or a non-key for-in) binding is unmodelled; a declared, never-initialised
      // variable is explicitly undefined (proven empty; its assignments add its other values)
      const loop = node.type === 'VariableDeclarator' && parent && PARENT.get(parent);
      const loopLeft = !!(loop && /^For(Of|In)Statement$/.test(loop.type) && loop.left === parent);
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && !(loopLeft && loop.type === 'ForInStatement')) {
        const b = declare(sc, node.id.name, { kind: 'var', init: node.init || (loopLeft ? unmodelled(`${loop.type === 'ForOfStatement' ? 'for-of' : 'for-in'}-binding`, node.id, u) : null), declNode: node });
        if (!node.init && !loopLeft) b.declaredUndef = true;   // not an init: aliases (`let r; r = x`) stay single-valued
      }
      if (node.type === 'CatchClause' && node.param) for (const lf of patternLeaves(node.param)) if (lf.node.type === 'Identifier') declare(sc, lf.node.name, { kind: 'var', init: unmodelled('catch-param', lf.node, u), declNode: node });
      // `const { a, b: c } = src` — a var whose value is src's property
      // `const { a, b: { c } } = src` — a leaf on a pure key path is src's property (nested Picks); array / rest / computed
      // leaves are UNMODELLED (r4 default-deny); a pattern with no init (for-of / catch) is unmodelled too
      if (node.type === 'VariableDeclarator' && node.id.type !== 'Identifier') for (const lf of patternLeaves(node.id)) {
        if (lf.node.type !== 'Identifier') continue;   // EMPTY-OK: a declaration pattern has no member targets
        let init = null;
        if (node.init && lf.path && lf.path.length) { init = node.init; for (const k of lf.path) { const pick = { type: 'Pick', source: init, key: k, start: lf.node.start, end: lf.node.end, loc: lf.node.loc }; FILE.set(pick, u); SCOPE.set(pick, sc); init = pick; } if (lf.def) init.hasDefault = true; }
        declare(sc, lf.node.name, { kind: 'var', init: init || unmodelled('declaration-pattern', lf.node, u), declNode: node });
        if (lf.def) declare(sc, lf.node.name, { kind: 'var', init: lf.def });   // r5: the default is one of its values
      }
      if (node.type === 'ReturnStatement' && node.argument && sc.fnNode) { const l = RETURNS.get(sc.fnNode) || []; l.push(node.argument); RETURNS.set(sc.fnNode, l); }
      if (/Function/.test(node.type) && node.expression && node.body && sc.fnNode === node) { const l = RETURNS.get(node) || []; l.push(node.body); RETURNS.set(node, l); }
      for (const k of Object.keys(node)) {
        if (k === 'loc' || k === 'start' || k === 'end') continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach((c) => rec(c, sc, node)); else if (v && typeof v === 'object' && typeof v.type === 'string') rec(v, sc, node);
      }
    })(ast, root, null);
  }
  const resolve = (name, from) => { for (let s = SCOPE.get(from); s; s = s.parent) { const b = s.vars.get(name); if (b) return b; } return null; };
  // the module file a `require('./x')` names (relative to the requiring file), or null
  const pathMod = require('path');
  function requiredFile(init, from) {
    const call = init && init.type === 'CallExpression' ? init : (init && init.type === 'MemberExpression' && init.object.type === 'CallExpression' ? init.object : (init && init.type === 'Pick' && init.source.type === 'CallExpression' ? init.source : null));
    if (!call || call.callee.type !== 'Identifier' || call.callee.name !== 'require' || !call.arguments[0] || call.arguments[0].type !== 'Literal' || !/^\./.test(String(call.arguments[0].value))) return null;
    const f = pathMod.posix.normalize(pathMod.posix.join(pathMod.posix.dirname(FILE.get(from).file), String(call.arguments[0].value)));
    return /\.m?js$/.test(f) ? f : `${f}.js`;
  }
  const inFile = (fns, file) => { const l = fns.filter((f) => FILE.get(f).file === file); return l.length ? l : null; };
  // the function node(s) a call invokes: a local function by scope; an imported one in ITS module file; else by name
  function fnsFor(call) {
    const nm = calleeName(call); if (!nm) return [];
    const all = FUNCS.get(nm) || [];
    const c = call.callee;
    if (c.type === 'Identifier') {
      const b = resolve(c.name, c);
      if (b && b.kind === 'fn') return [b.fnNode];
      if (b && b.kind === 'var' && b.inits.length === 1) {
        const i = b.inits[0];
        if (/Function/.test(i.type)) return [i];
        const mf = requiredFile(i, c); if (mf) return inFile(all, mf) || [];
      }
      return inFile(all, FILE.get(call).file) || all;
    }
    if (c.type === 'MemberExpression' && c.object.type === 'Identifier') {
      const b = resolve(c.object.name, c.object);
      if (b && b.kind === 'var' && b.inits.length === 1) { const mf = requiredFile(b.inits[0], c); if (mf) return inFile(all, mf) || []; }
    }
    return all;
  }
  const CALLSITES = new Map();      // fn node → [call node]
  for (const { ast } of files) walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    for (const f of fnsFor(node)) { const l = CALLSITES.get(f) || []; l.push(node); CALLSITES.set(f, l); }
  });
  const callsOf = (fnNode) => CALLSITES.get(fnNode) || [];
  const srcOf = (n) => { const u = FILE.get(n); return n && u ? u.code.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 80) : ''; };
  const fnOf = (n) => FN.get(n) || '<top>';
  const record = (at, field, how) => { const u = FILE.get(at); writes.push({ file: u.file, fn: fnOf(at), field, how, line: at.loc.start.line }); };
  const opaqueW = (at, how, detail) => { const u = FILE.get(at); opaqueWrites.push({ file: u.file, fn: fnOf(at), how, line: at.loc.start.line, ...(detail ? { detail } : {}) }); };

  // a KEY expression → its static string, or null (dynamic). Advisor ruling (r2, amending r1): a key that CONSTANT-FOLDS
  // exactly to a literal — a single-init const (`const k = 'lat'`), a literal concatenation ('l' + 'at'), a template with
  // no expressions (`lat`) — IS resolved provenance and is recorded as that field. Only a key that cannot be folded to a
  // literal (a dynamic part → '*' in the static shape, or null) is OPAQUE (dynamic-field-segment).
  function keyStatic(k, computed) {
    if (!computed) return k.type === 'Identifier' ? k.name : (k.type === 'Literal' ? String(k.value) : null);
    if (k.type === 'Literal') return typeof k.value === 'string' || typeof k.value === 'number' ? String(k.value) : null;
    if (k.type === 'Identifier') { const b = resolve(k.name, k); if (b && b.kind === 'var' && b.inits.length === 1) return keyStatic(b.inits[0], true); return null; }
    const sp = staticPath(k);
    return sp === null ? null : sp;
  }
  // a computed key that is a `for … in src` variable → src (its value ranges over src's keys)
  function keysOfInit(k) { if (k.type !== 'Identifier') return null; const b = resolve(k.name, k); return b && b.kind === 'var' && b.inits.length === 1 && b.inits[0].type === 'KeysOf' ? b.inits[0].source : null; }
  // `a.b[c].d` → { root: Identifier a, steps: [b, c, d] } (null if not rooted at an identifier)
  function memberChain(e) {
    const steps = []; let x = e;
    while (x && x.type === 'MemberExpression') { steps.unshift({ key: keyStatic(x.property, x.computed), node: x.property, keysOf: x.computed ? keysOfInit(x.property) : null }); x = x.object; }
    return x && x.type === 'Identifier' ? { root: x, steps } : null;
  }
  // the binding a contribution lands on, through ALIASES: `const r = x` / `const r = x.k` → (x, [k, …steps])
  function rootOf(e, depth = 0) {
    const mc = e.type === 'Identifier' ? { root: e, steps: [] } : memberChain(e);
    if (!mc) return null;
    const b = resolve(mc.root.name, mc.root);
    if (!b) return null;
    if (depth < 6 && b.kind === 'var' && b.inits.length === 1 && b.inits[0] && (b.inits[0].type === 'Identifier' || b.inits[0].type === 'MemberExpression')) {
      const up = rootOf(b.inits[0], depth + 1);
      if (up) return { binding: up.binding, steps: [...up.steps, ...mc.steps] };
    }
    return { binding: b, steps: mc.steps };
  }

  // ── heap escapes ───────────────────────────────────────────────────────────────────────────────────────────────
  // A pure library call reads its argument and keeps no reference that a later write could follow.
  // r3 P1-3: an EXPLICIT pure allowlist, per object — anything else on a tracked value is a possible mutator (heap escape).
  // Object.assign is modelled (a contribution onto its target; its sources are read).
  const PURE_STATIC = {
    console: null,   // any method
    JSON: null, Math: null, Number: null, String: null, Boolean: null, Date: null,
    Object: new Set(['keys', 'values', 'entries', 'getOwnPropertyNames', 'getOwnPropertySymbols', 'getPrototypeOf', 'is', 'isFrozen', 'isSealed', 'isExtensible', 'hasOwn', 'freeze']),
    Array: new Set(['isArray', 'from']),
  };
  const PURE_FN = new Set(['String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isFinite', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'require']);
  const PURE_METHOD = new Set(['json', 'send', 'status', 'log', 'warn', 'error', 'info', 'includes', 'indexOf', 'has', 'get', 'then', 'catch', 'finally', 'toString', 'once', 'on', 'off', 'filter', 'map', 'some', 'every', 'find', 'reduce', 'forEach', 'equalTo', 'orderByChild', 'startAt', 'endAt', 'limitToFirst', 'limitToLast']);
  const pendingHeap = [];
  // the consumer an identifier's VALUE flows into, through wrappers that keep the same object (cond / logical / await)
  function heapEscape(id) {
    let x = id; let p = PARENT.get(x);
    while (p && ((p.type === 'ConditionalExpression' && p.test !== x) || p.type === 'LogicalExpression' || p.type === 'AwaitExpression' || p.type === 'ParenthesizedExpression')) { x = p; p = PARENT.get(x); }
    if (!p) return null;   // EMPTY-OK: no consumer — the value goes nowhere
    if (p.type === 'NewExpression' && p.arguments.includes(x)) return 'new';
    if (p.type === 'ArrayExpression') return 'array';
    if (p.type === 'AssignmentExpression' && p.right === x && p.left.type === 'MemberExpression' && !rootOf(p.left)) return 'stored-untracked';
    if (p.type === 'CallExpression' && p.arguments.includes(x)) {
      const c = p.callee;
      if (c.type === 'MemberExpression' && !c.computed) {
        const nm = c.property.name;
        if (c.object.type === 'Identifier' && Object.prototype.hasOwnProperty.call(PURE_STATIC, c.object.name) && !resolve(c.object.name, c.object)) {
          const ok = PURE_STATIC[c.object.name];
          if (!ok || ok.has(nm)) return null;   // EMPTY-OK: an allowlisted pure static read (console / JSON / Math / … / Object.keys …)
          if (!(c.object.name === 'Object' && nm === 'assign')) return `call:${c.object.name}.${nm}`;   // defineProperty, setPrototypeOf, …
        }
        if (nm === 'assign' && c.object.type === 'Identifier' && c.object.name === 'Object') return null;   // EMPTY-OK: Object.assign is modelled (its target's contribution; its sources are read)
        if (WRITE_METHODS.has(nm) && refPathOf(c.object) !== null) return null;      // EMPTY-OK: a database write: the sink itself (its payload is analysed there) — a database write: the sink itself
        if (PURE_METHOD.has(nm)) return null;   // EMPTY-OK: an allowlisted pure method read (json / send / log / includes / map …)
        if (/^(Object|Array|String|Number)\.prototype\./.test(srcOf(c))) return null;   // EMPTY-OK: Object.prototype.*.call(x, k) — a read — Object.prototype.hasOwnProperty.call(x, k)
        if (COMMON.has(nm)) return `call:.${nm}`;
      }
      if (c.type === 'Identifier' && PURE_FN.has(c.name)) return null;   // EMPTY-OK: an allowlisted pure global (String / Number / parseInt …)
      const fns = fnsFor(p);
      if (!fns.length) return `call:${srcOf(c).slice(0, 40)}`;
      return { pending: { fns, index: p.arguments.indexOf(x) } };     // our own function: escapes iff its param does
    }
    return null;   // EMPTY-OK: any other consumer keeps the SAME object in view (a tracked store / object literal / return / await)
  }

  // a ref expression's SIGNATURE: the same ref (variable, or identical path expression) gives the same text
  function refSig(n, depth = 0) {
    if (!n || depth > 4) return null;   // EMPTY-OK: no ref signature → never equal to a write's → the snapshot is OPAQUE at writeAt
    if (n.type === 'AwaitExpression') return refSig(n.argument, depth + 1);
    if (n.type === 'Identifier') { const b = resolve(n.name, n); if (b && b.kind === 'var' && b.inits.length === 1) return refSig(b.inits[0], depth + 1); return b ? `param:${b.name}@${b.fnNode ? b.fnNode.start : 0}` : null; }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && methodName(n.callee)) {
      const m = methodName(n.callee);
      if (m === 'ref') return `ref:${n.arguments[0] ? srcOf(n.arguments[0]).replace(/\s+/g, '') : ''}`;
      if (m === 'child') { const b = refSig(n.callee.object, depth + 1); return b && `${b}/child:${srcOf(n.arguments[0]).replace(/\s+/g, '')}`; }
    }
    return null;   // EMPTY-OK: no ref signature → never equal → OPAQUE at writeAt
  }
  // a snapshot VALUE read from the database (`(await ref.once('value')).val()`, `snap.val()` with snap = await ref.get()):
  // the ref it was read from, or null
  function snapshotRef(callee, depth = 0) {
    let o = callee; while (o && (o.type === 'AwaitExpression' || o.type === 'ParenthesizedExpression')) o = o.argument || o.expression;
    if (!o || depth > 4) return null;   // EMPTY-OK: not a snapshot read → the caller falls through to UNRESOLVED
    if (o.type === 'Identifier') { const b = resolve(o.name, o); return b && b.kind === 'var' && b.inits.length === 1 ? snapshotRef(b.inits[0], depth + 1) : null; }
    if (o.type === 'CallExpression' && o.callee.type === 'MemberExpression' && !o.callee.computed && (o.callee.property.name === 'once' || o.callee.property.name === 'get')) return o.callee.object;
    // a transaction RESULT's snapshot (`(await ref.transaction(fn)).snapshot`) is the committed value at that ref
    if (o.type === 'MemberExpression' && !o.computed && o.property.name === 'snapshot') {
      let t = o.object; while (t && (t.type === 'AwaitExpression' || t.type === 'ParenthesizedExpression')) t = t.argument || t.expression;
      if (t && t.type === 'Identifier') { const b = resolve(t.name, t); t = b && b.kind === 'var' && b.inits.length === 1 ? b.inits[0] : null; while (t && t.type === 'AwaitExpression') t = t.argument; }
      if (t && t.type === 'CallExpression' && t.callee.type === 'MemberExpression' && !t.callee.computed && t.callee.property.name === 'transaction') return t.callee.object;
    }
    return null;   // EMPTY-OK: not a snapshot read → the caller falls through to UNRESOLVED
  }

  // a member ASSIGNMENT target: a contribution onto its tracked root; a root we cannot track (a call result, `this`, …)
  // marks what that call may return as mutated out of view (heap) — never a silent drop
  // r5 (d): a base that is a conditional / logical / sequence lands on each branch; any other base we cannot follow is an
  // OPAQUE write on the enclosing function — except a global or `this`, whose every read is already opaque at a write
  function assignMember(target, val, at, depth = 0) {
    const r = rootOf(target);
    if (r && r.steps.length) { r.binding.contribs.push({ id: ++CID, steps: r.steps, value: val, at }); return; }
    const chain = []; let base = target; while (base && base.type === 'MemberExpression') { chain.unshift(base); base = base.object; }
    while (base && (base.type === 'AwaitExpression' || base.type === 'ParenthesizedExpression')) base = base.argument || base.expression;
    const branches = !base ? [] : base.type === 'ConditionalExpression' ? [base.consequent, base.alternate] : base.type === 'LogicalExpression' ? [base.left, base.right]
      : base.type === 'SequenceExpression' ? [base.expressions[base.expressions.length - 1]] : base.type === 'AssignmentExpression' && base.operator === '=' ? [base.left] : null;
    if (branches && depth < 6) {
      for (const br of branches) { let t = br; for (const m of chain) t = { type: 'MemberExpression', object: t, property: m.property, computed: m.computed, start: m.start, end: m.end, loc: m.loc }; assignMember(t, val, at, depth + 1); }
      return;
    }
    if (base && base.type === 'CallExpression') {
      const fns = fnsFor(base); let open = !fns.length;
      for (const f of fns) for (const ret of RETURNS.get(f) || []) {
        const rr = ret.type === 'Identifier' ? rootOf(ret) : null;
        if (rr) rr.binding.heap = rr.binding.heap || 'mutated-via-call-result';
        else if (!['Literal', 'TemplateLiteral', 'UnaryExpression', 'BinaryExpression'].includes(ret.type)) open = true;
      }
      if (open) opaqueW(at, 'unmodelled-member-base', srcOf(target));
      return;
    }
    if (base && ((base.type === 'Identifier' && !resolve(base.name, base)) || base.type === 'ThisExpression' || base.type === 'Super')) return;   // a global / this: every read of it is opaque at a write
    opaqueW(at, 'unmodelled-member-base', srcOf(target));
  }

  // ── contributions + escapes ─────────────────────────────────────────────────────────────────────────────────────
  for (const { ast } of files) {
    walk(ast, (node, fn, parent) => {
      // r4 DEFAULT-DENY over assignment OPERATORS and TARGETS. `=`, `||=`, `&&=`, `??=` are modelled (the logical ones as
      // the UNION of old and new — flow-insensitive, every value it may hold); any other compound operator makes the
      // value UNMODELLED; every destructuring target is unmodelled unless it is a pure key path.
      if (node.type === 'AssignmentExpression') {
        const FLOWS = ['=', '||=', '&&=', '??='];
        const val = FLOWS.includes(node.operator) ? node.right : unmodelled(`assign-${node.operator}`, node, FILE.get(node));
        if (node.left.type === 'Identifier') { const b = resolve(node.left.name, node.left); if (b && (b.kind === 'var' || b.kind === 'param')) b.inits.push(val); }
        else if (node.left.type === 'MemberExpression') assignMember(node.left, val, node);
        else for (const lf of patternLeaves(node.left)) {   // a destructuring assignment: each leaf receives an unmodelled value
          const uv = unmodelled('destructuring-assign', lf.node, FILE.get(node));
          if (lf.node.type === 'Identifier') { const b = resolve(lf.node.name, lf.node); if (b && (b.kind === 'var' || b.kind === 'param')) b.inits.push(uv); }
          else if (lf.node.type === 'MemberExpression') assignMember(lf.node, uv, node);
        }
      }
      // r5: `for (x of …)` / `for (x.f in …)` with an existing target: each leaf receives an unmodelled value
      if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && node.left.type !== 'VariableDeclaration') for (const lf of patternLeaves(node.left)) {
        const uv = unmodelled(node.type === 'ForOfStatement' ? 'for-of-assign' : 'for-in-assign', lf.node, FILE.get(node));
        if (lf.node.type === 'Identifier') { const b = resolve(lf.node.name, lf.node); if (b && (b.kind === 'var' || b.kind === 'param')) b.inits.push(uv); }
        else if (lf.node.type === 'MemberExpression') assignMember(lf.node, uv, node);
      }
      // `x.f++` / `--x.f`: field f is written (its value unmodelled)
      if (node.type === 'UpdateExpression' && node.argument.type === 'MemberExpression') assignMember(node.argument, unmodelled('update-expression', node, FILE.get(node)), node);
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.object.type === 'Identifier'
          && node.callee.object.name === 'Object' && node.callee.property.name === 'assign' && node.arguments[0]) {
        const r = rootOf(node.arguments[0]);
        if (r) for (const src of node.arguments.slice(1)) r.binding.contribs.push({ id: ++CID, steps: r.steps, spread: src, at: node });
      }
      // escapes: returned, passed to a call, or stored as a value (an over-approximation input, see header)
      if (node.type === 'Identifier' && parent) {
        const asArg = (parent.type === 'CallExpression' || parent.type === 'NewExpression') && parent.arguments.includes(node);
        const asRet = parent.type === 'ReturnStatement' || (/Function/.test(parent.type) && parent.body === node);
        const asVal = (parent.type === 'Property' && parent.value === node) || (parent.type === 'AssignmentExpression' && parent.right === node && parent.left.type === 'MemberExpression') || parent.type === 'ArrayExpression';
        if (asArg || asRet || asVal) { const b = resolve(node.name, node); if (b) b.escapes = true; }
        // r2 P1-3, FAIL CLOSED: an object that leaves our view into the HEAP (a constructor, an array, `this.x = obj`,
        // an untracked call) can be mutated where no contribution is seen — its provenance is incomplete → OPAQUE at
        // every write it reaches
        if (parent.type !== 'MemberExpression' || parent.object !== node) {
          const b = resolve(node.name, node);
          if (b && (b.kind === 'var' || b.kind === 'param')) { const why = heapEscape(node); if (why) { if (why.pending) pendingHeap.push({ b, ...why.pending }); else b.heap = b.heap || why; } }
        }
      }
    });
  }
  for (let round = 0, moved = true; moved; round++) {
    if (round > pendingHeap.length + 1) throw new Error('write-provenance: heap-escape fixpoint did not converge (analysis limit)');
    moved = false;
    for (const ph of pendingHeap) {
      if (ph.b.heap) continue;
      for (const f of ph.fns) {
        const pbs = [...(SCOPE.get(f) || { vars: new Map() }).vars.values()].filter((x) => x.kind === 'param' && x.fnNode === f && x.index === ph.index);
        const rest = f.params.some((q, i) => q.type === 'RestElement' && i <= ph.index);   // `(...args)`: not followed → escapes
        if (rest || pbs.some((pb) => pb.heap)) { ph.b.heap = `via:${FN.get(f)}${rest ? '(rest)' : ''}`; moved = true; break; }
      }
    }
  }
  // a helper mutating its PARAMETER → the contribution lands on the caller's argument (fixpoint over helper chains)
  for (let round = 0, moved = true; moved; round++) {
    if (round > 64) throw new Error('write-provenance: parameter-contribution fixpoint did not converge (analysis limit)');
    moved = false;
    for (const b of allBindings) {
      if (b.kind !== 'param' || !b.contribs.length) continue;
      const nm = FN.get(b.fnNode);
      b.carried = b.carried || new Set();
      for (const call of callsOf(b.fnNode)) {
        let arg = call.arguments[b.index]; if (!arg) continue;
        if (b.propKey) { const q = arg.type === 'ObjectExpression' ? arg.properties.find((x) => x.type === 'Property' && !x.computed && (x.key.name || String(x.key.value)) === b.propKey) : null; arg = q ? q.value : null; if (!arg) continue; }
        const r = rootOf(arg); if (!r || r.binding === b) continue;            // a recursive self-call carries nothing new
        for (const c of b.contribs.slice()) {
          const key = `${call.start}@${FILE.get(call).file}#${c.root || c.id}`;
          if (b.carried.has(key)) continue;   // EMPTY-OK: already carried to this call site
          if (r.binding.contribs.length > 4000) throw new Error(`write-provenance: contribution limit on ${r.binding.name} (analysis limit)`);
          b.carried.add(key);
          r.binding.contribs.push({ ...c, id: ++CID, root: c.root || c.id, steps: [...r.steps, ...c.steps], via: nm });
          moved = true;
        }
      }
    }
  }

  // ── an expression → its entries: { k:'prop', key, value } | { k:'spread', arg } | { k:'param', b } | { k:'unresolved', node } ──
  // ENV: the call frames a builder's return is evaluated in — a callee PARAMETER reads the caller's argument
  // ({ fnNode, call, parent }); without a frame a parameter stays a PARAM entry (resolved later at every call site)
  const virtual = (entries) => ({ type: 'Virtual', entries });
  // the keys a `for … in src` variable ranges over: src's resolved keys, or [null] (unknown → dynamic → opaque)
  function keysOfSource(src) {
    const flat = expand(entriesOf(src));
    if (!flat.length || flat.some((e) => e.k !== 'prop' || e.key === null || e.key === undefined)) return [null];
    return [...new Set(flat.map((e) => e.key))];
  }
  function contribEntries(b, env) {
    const out = [];
    for (const c of b.contribs) {
      // a step keyed by a for-in variable stands for each key of its source (cartesian, bounded; unknown → null key)
      let variants = [c.steps];
      for (let i = 0; i < c.steps.length; i++) {
        if (!c.steps[i].keysOf) continue;   // EMPTY-OK: this step is a literal key (no for-in expansion needed)
        const ks = keysOfSource(c.steps[i].keysOf);
        variants = variants.flatMap((st) => ks.map((k) => st.map((x, j) => (j === i ? { ...x, key: k, keysOf: null } : x))));
        if (variants.length > 200) variants = [c.steps.map((x) => (x.keysOf ? { ...x, key: null, keysOf: null } : x))];
      }
      for (const st of variants) {
        let e = c.spread ? { k: 'spread', arg: c.spread, env } : null;
        if (!e) { const last = st[st.length - 1]; e = { k: 'prop', key: last.key, keyNode: last.node, value: c.value, env }; }
        const upto = c.spread ? st.length : st.length - 1;
        for (let i = upto - 1; i >= 0; i--) e = { k: 'prop', key: st[i].key, keyNode: st[i].node, value: virtual([e]), env };
        out.push(e);
      }
    }
    return out;
  }
  const MEMO = new Map(); const INPROG = new Set();
  // r5 TYPED EMPTY: the explicit "writes no field" — produced only where emptiness is PROVEN
  const EMPTY = (why) => ({ k: 'empty', why });
  // r5 THE CHOKE POINT: every value's entries pass here; an answer with NO entries is OPAQUE (never absence)
  function entriesOf(n, env = null, depth = 0, seen = new Set()) {
    if (!n) return [{ k: 'unresolved', node: null, why: 'no-value' }];
    if (n.type === 'Virtual') return n.entries.length ? n.entries : [{ k: 'unresolved', node: null, why: 'no-provenance-virtual' }];
    if (!env && MEMO.has(n)) return MEMO.get(n);
    const key = n;
    // r3 P1-4: an analysis LIMIT is never an empty answer
    if (depth > 24) return [{ k: 'unresolved', node: n, why: 'analysis-limit (depth > 24)' }];
    if (INPROG.has(key)) return [EMPTY('cycle')];   // the frame that entered this node holds its entries (the union)
    INPROG.add(key);
    const r0 = entriesOf0(n, env, depth, seen);
    INPROG.delete(key);
    const r = Array.isArray(r0) && r0.length ? r0 : [{ k: 'unresolved', node: n, why: `no-provenance-${n.type}` }];
    if (!env && depth === 0) MEMO.set(n, r);
    return r;
  }
  const argOf = (call, b) => {
    let a = call.arguments[b.index];
    if (!a && b.fnNode.params[b.index] && b.fnNode.params[b.index].type === 'AssignmentPattern') a = b.fnNode.params[b.index].right;
    return a || null;
  };
  function entriesOf0(n, env, depth, seen) {
    const d = depth + 1;
    if (n.type === 'ObjectExpression') {
      if (!n.properties.length) return [EMPTY('empty-object')];
      // r4: EVERY property kind is kept — spread; init / shorthand / computed (its key folded or null → opaque at the
      // write); method / getter / setter (the key is a written field whatever its value); anything else → unmodelled
      return n.properties.map((p) => {
        if (p.type === 'SpreadElement') return { k: 'spread', arg: p.argument, env };
        if (p.type === 'Property') return { k: 'prop', key: keyStatic(p.key, p.computed), keyNode: p.key, value: p.kind === 'init' && !p.method ? p.value : null, env };
        return { k: 'unresolved', node: p, why: `unmodelled-property-${p.type}` };
      });
    }
    if (n.type === 'Unmodelled') return [{ k: 'unresolved', node: n.node, why: `unmodelled-${n.why}` }];
    if (n.type === 'Identifier') {
      if ((n.name === 'undefined' || n.name === 'NaN' || n.name === 'Infinity') && !resolve(n.name, n)) return [EMPTY('primitive')];   // an updater's abort
      const b = resolve(n.name, n);
      if (!b || b.kind === 'fn') return [{ k: 'unresolved', node: n }];
      const sk = `${allBindings.indexOf(b)}@${env ? env.call.start : ''}`;
      if (seen.has(sk)) return [EMPTY('cycle')];   // this binding's entries are already in this same evaluation (the union)
      seen.add(sk); b.consumed = true;
      const own = contribEntries(b, env);
      // r2 P1-3: an object that escaped into the heap may be mutated out of view → its provenance is incomplete
      if (b.heap) own.push({ k: 'unresolved', node: n, why: `escapes (${b.heap})` });
      // r2 P1-1 / P2-5: a transaction updater's parameter IS the current value at the ref ({ k:'current' } — spreading or
      // returning it writes no new field there); what is assigned onto it, or REASSIGNED to it (r3), is new
      if (b.currentOrder) return [{ k: 'current', path: b.currentOrder.path, sig: b.currentOrder.sig, node: n }, ...b.inits.flatMap((i) => entriesOf(i, env, d, seen)), ...own];
      if (b.kind === 'param') {
        for (let f = env; f; f = f.parent) {
          if (f.fnNode !== b.fnNode) continue;   // EMPTY-OK: a frame of another function — keep looking
          const a = argOf(f.call, b);
          let ents = a ? entriesOf(a, f.parent, d, seen) : [EMPTY('absent-argument')];   // an absent argument is undefined
          if (b.propKey) ents = selectKey(ents, b.propKey, f.call);
          return [...ents, ...b.inits.flatMap((i) => entriesOf(i, env, d, seen)), ...own];
        }
        return [{ k: 'param', b, node: n }, ...b.inits.flatMap((i) => entriesOf(i, env, d, seen)), ...own];
      }
      const fromInits = b.inits.flatMap((i) => entriesOf(i, env, d, seen));
      return [...(b.declaredUndef ? [EMPTY('declared-undefined')] : []), ...fromInits, ...own];
    }
    // r5: a missing property is OPAQUE (the choke point) — unless the leaf has a DEFAULT, which is then its value (proven)
    if (n.type === 'Pick') { const r = selectKey(entriesOf(n.source, env, d, seen), n.key, n); return r.length || !n.hasDefault ? r : [EMPTY('default-applies')]; }
    if (n.type === 'MemberExpression') {
      const mc = memberChain(n);
      if (!mc) return [{ k: 'unresolved', node: n }];
      let cur = entriesOf(mc.root, env, d, seen);
      for (const s of mc.steps) cur = selectKey(cur, s.key, n);
      return cur;
    }
    if (n.type === 'ConditionalExpression') return [...entriesOf(n.consequent, env, d, seen), ...entriesOf(n.alternate, env, d, seen)];
    // r3 P1-1: `a || b`, `a && b`, `a ?? b` may be either operand — the UNION, always
    if (n.type === 'LogicalExpression') return [...entriesOf(n.left, env, d, seen), ...entriesOf(n.right, env, d, seen)];
    if (n.type === 'AwaitExpression' || n.type === 'ParenthesizedExpression') return entriesOf(n.argument || n.expression, env, d, seen);
    if (n.type === 'SequenceExpression') return entriesOf(n.expressions[n.expressions.length - 1], env, d, seen);
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'Object' && c.property.name === 'assign') {
        return n.arguments.flatMap((a) => entriesOf(a, env, d, seen));
      }
      // a deep CLONE (`JSON.parse(JSON.stringify(x))`, `structuredClone(x)`) has x's provenance
      if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'JSON' && c.property.name === 'parse' && n.arguments.length === 1
          && n.arguments[0].type === 'CallExpression' && n.arguments[0].callee.type === 'MemberExpression' && !n.arguments[0].callee.computed && n.arguments[0].callee.object.type === 'Identifier'
          && n.arguments[0].callee.object.name === 'JSON' && n.arguments[0].callee.property.name === 'stringify' && n.arguments[0].arguments.length === 1) return entriesOf(n.arguments[0].arguments[0], env, d, seen);
      if (c.type === 'Identifier' && c.name === 'structuredClone' && !resolve(c.name, c) && n.arguments.length === 1) return entriesOf(n.arguments[0], env, d, seen);
      // a database SNAPSHOT value: the persisted value at its ref ({ k:'current' }) — the same order it is written back to
      // writes no new field; any other ref's snapshot is opaque at the write (writeAt)
      if (c.type === 'MemberExpression' && !c.computed && c.property.name === 'val' && !n.arguments.length) {
        const r = snapshotRef(c.object);
        if (r) { const pth = refPathOf(r); return pth === null ? [{ k: 'unresolved', node: n }] : [{ k: 'current', path: normPath(pth), sig: refSig(r), node: n }]; }
      }
      const fns = fnsFor(n);
      const out = [];
      for (const f of fns) for (const r of RETURNS.get(f) || []) out.push(...entriesOf(r, { fnNode: f, call: n, parent: env }, d, seen));
      if (!fns.some((f) => (RETURNS.get(f) || []).length)) return [{ k: 'unresolved', node: n }];
      return out;
    }
    // primitives write no field of their own; EVERYTHING else that is not modelled (arrays, `this`, `new`, …) is OPAQUE —
    // r2 ruling: a value reaching a write is fully resolved or carries an opaque marker, never empty provenance
    if (n.type === 'Literal' || n.type === 'TemplateLiteral' || n.type === 'UnaryExpression' || n.type === 'BinaryExpression') return [EMPTY('primitive')];
    return [{ k: 'unresolved', node: n, why: `unmodelled-${n.type}` }];   // r4 DEFAULT-DENY: every other expression kind
  }
  // the entries of property `key` of an object given by its entries (absent → nothing; an unknown part → unresolved,
  // since it may hold the key). A null key (dynamic) selects nothing it can name → unresolved.
  function selectKey(entries, key, at) {
    const flat = expand(entries);
    const out = [];
    if (key === null || key === undefined || flat.some((e) => e.k !== 'prop')) out.push({ k: 'unresolved', node: at });
    for (const e of flat) if (e.k === 'prop' && (e.key === key || e.key === null)) out.push(...entriesOf(e.value, e.env));
    return out;
  }
  // spreads flattened where they resolve (an unresolved one stays as 'spread-unresolved' with its argument)
  function expand(entries, depth = 0) {
    const out = [];
    for (const e of entries) {
      if (e.k === 'empty') continue;   // a proven empty contributes nothing
      if (e.k !== 'spread') { out.push(e); continue; }
      if (depth > 8) { out.push({ k: 'spread-unresolved', arg: e.arg, env: e.env }); continue; }
      const inner = entriesOf(e.arg, e.env);
      for (const x of expand(inner, depth + 1)) out.push(x.k === 'unresolved' ? { k: 'spread-unresolved', arg: e.arg, env: e.env } : x);
    }
    return out;
  }

  // ── recording ───────────────────────────────────────────────────────────────────────────────────────────────────
  const paramSinks = [];
  const dynamicField = (k) => k === null || k === undefined || k === '' || String(k).includes('*');
  // a path segment shape ('*' = dynamic) that could spell `orders`
  const couldBeOrders = (seg) => new RegExp(`^${String(seg).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test('orders');

  // a payload `entries` written at `base` (a static path shape); `at` is the write call (or the call site carrying it)
  function writeAt(base, entries, at, how, depth = 0, wsig = null) {
    const p = normPath(base); const segs = p === '' ? [] : p.split('/');
    if (depth > 8) { opaqueW(at, 'analysis-limit', `${p}: nesting > 8`); return; }
    const atRootOrOrders = segs.length === 0 || (segs[0] === 'orders' && segs.length === 1);
    if (!atRootOrOrders && segs[0] !== 'orders') { if (couldBeOrders(segs[0])) opaqueW(at, 'dynamic-root-path', p); return; }
    if (segs.length >= 3) { if (dynamicField(segs[2])) opaqueW(at, 'dynamic-field-segment', p); else record(at, segs[2], how); return; }
    const flat = expand(entries);
    for (const e of flat) {
      if (e.k === 'current') {
        // the persisted value of THE SAME ref written back (same path shape AND same ref signature) adds no field
        if (normPath(e.path) === p && e.sig && e.sig === wsig) continue;   // EMPTY-OK: the current value of this very ref
        opaqueW(at, 'snapshot-spread', `${p || '/'}: the value of ${e.path} (${srcOf(e.node)})`);
        continue;   // EMPTY-OK: accounted above: the current value of this very ref, or an opaque
      }
      if (e.k === 'param') { paramSinks.push({ b: e.b, base: p, at, how, wsig, shape: atRootOrOrders ? (segs.length ? 'write-above-orders' : 'unresolved-root-write') : 'opaque-order-object' }); continue; }
      if (e.k === 'unresolved') { opaqueW(at, atRootOrOrders ? (segs.length ? 'write-above-orders' : 'unresolved-root-write') : 'opaque-order-object', `${p || '/'}: ${e.node ? (srcOf(e.node) || ('<' + e.node.type + '>')) : '?'}${e.why ? ` — ${e.why}` : ''}`); continue; }
      if (e.k === 'spread-unresolved') {
        const pr = e.arg.type === 'Identifier' ? resolve(e.arg.name, e.arg) : null;
        const bound = (() => { for (let f = e.env; f; f = f.parent) if (pr && f.fnNode === pr.fnNode) return true; return false; })();
        if (pr && pr.kind === 'param' && !bound) { paramSinks.push({ b: pr, base: p, at, wsig, how: `${how}/spread`, shape: atRootOrOrders ? (segs.length ? 'spread-in-order-write' : 'spread-at-root') : 'spread-in-order-write' }); continue; }
        opaqueW(at, atRootOrOrders ? (segs.length ? 'spread-in-order-write' : 'spread-at-root') : 'spread-in-order-write', e.arg.type === 'Identifier' ? e.arg.name : srcOf(e.arg).slice(0, 60));
        continue;   // EMPTY-OK: accounted on the line above (param sink or opaque)
      }
      const k = e.key;
      if (atRootOrOrders) {
        if (k === null || k === undefined) { opaqueW(at, segs.length ? 'computed-key-in-order-write' : 'computed-key-at-root', srcOf(e.keyNode)); continue; }
        // a root key whose FIRST segment is dynamic could be `orders` → opaque; a literal other tree is not ours
        if (segs.length === 0 && couldBeOrders(String(k).split('/')[0])) { if (String(k).split('/')[0] !== 'orders') { opaqueW(at, 'computed-key-at-root', String(k)); continue; } }
        else if (segs.length === 0) continue;      // EMPTY-OK: a literal root key of another tree (first segment cannot spell orders) — a root write of another tree
        writeAt(`${p}/${k}`, entriesOf(e.value, e.env), at, how, depth + 1, null);
        continue;   // EMPTY-OK: accounted on the line above (recursive writeAt)
      }
      // segs.length === 2: the order object — keys are fields, or sub-paths
      if (k !== null && k !== undefined && String(k).includes('/')) { writeAt(`${p}/${k}`, entriesOf(e.value, e.env), at, how, depth + 1, null); continue; }
      if (dynamicField(k)) { opaqueW(at, 'dynamic-field-segment', `${p}/${k === null || k === undefined ? `[${srcOf(e.keyNode)}]` : k}`); continue; }   // any non-literal FIELD key
      record(at, String(k), how);
    }
  }

  // the ref path a write call targets: ref(...) / child(...) chains, through same-scope variables
  function refPathOf(n, depth = 0) {
    if (!n) return null;   // EMPTY-OK: no receiver expression
    if (depth > 4) return '*';   // r3 P1-4: an analysis limit is a fully DYNAMIC path (opaque at an order-capable write), never "not a ref"
    if (n.type === 'Identifier') {
      const b = resolve(n.name, n); if (!b) return null;   // EMPTY-OK: an unbound global (e.g. a library namespace) is not a ref
      for (const i of b.inits) { const r = refPathOf(i, depth + 1); if (r !== null) return r; }
      // a REF PARAMETER (`finalize(orderRef, …)`): the ref each call site passes
      if (b.kind === 'param') {
        for (const call of callsOf(b.fnNode)) {
          let a = call.arguments[b.index];
          if (a && b.propKey) { const q = a.type === 'ObjectExpression' ? a.properties.find((x) => x.type === 'Property' && !x.computed && (x.key.name || String(x.key.value)) === b.propKey) : null; a = q ? q.value : null; }
          const r = a ? refPathOf(a, depth + 1) : null; if (r !== null) return r;
        }
      }
      return null;   // EMPTY-OK: not a ref shape (crypto hash / Firestore tx / Map …)
    }
    if (n.type === 'AwaitExpression') return refPathOf(n.argument, depth + 1);
    if (n.type === 'ParenthesizedExpression') return refPathOf(n.expression, depth + 1);
    if (n.type === 'SequenceExpression') return refPathOf(n.expressions[n.expressions.length - 1], depth + 1);
    // r5: a conditional / logical receiver is the UNION of its branches that are refs (segment-wise; differing → '*')
    if (n.type === 'ConditionalExpression' || n.type === 'LogicalExpression') {
      const ps = (n.type === 'ConditionalExpression' ? [n.consequent, n.alternate] : [n.left, n.right]).map((x) => refPathOf(x, depth + 1)).filter((x) => x !== null);
      return ps.length ? ps.reduce(mergePaths) : null;
    }
    // r5: a snapshot's `.ref` is a ref whose path we do not follow (fully dynamic); `.parent` / `.root` of a known ref
    if (n.type === 'MemberExpression' && methodName(n) === 'ref') return '*';
    if (n.type === 'MemberExpression' && (methodName(n) === 'parent' || methodName(n) === 'root')) {
      const b = refPathOf(n.object, depth + 1); if (b === null) return null;
      return methodName(n) === 'root' ? '' : (b === '*' || b === '' ? '*' : normPath(b).split('/').slice(0, -1).join('/'));
    }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && methodName(n.callee)) {
      const m = methodName(n.callee);   // r5: `db['ref'](…)` is `db.ref(…)`
      // r3: a ref whose path cannot be resolved is a fully DYNAMIC path ('*' — could be orders → opaque at the write)
      if (m === 'ref') return n.arguments.length ? pathOfExpr(n.arguments[0]) : '';
      if (m === 'child') { const b = refPathOf(n.callee.object, depth + 1); const c = staticPath(n.arguments[0]); return b === null ? null : normPath(`${b}/${c === null ? '*' : c}`); }
      if (m === 'push') { const b = refPathOf(n.callee.object, depth + 1); return b === null ? null : normPath(`${b}/*`); }   // r5: a pushed child ref
    }
    return null;   // EMPTY-OK: not a ref shape (crypto hash / Firestore tx / Map …)
  }
  // r5: the union of two path shapes, segment-wise — equal segments kept, differing ones '*'; different depths → '*'
  function mergePaths(a, b) {
    if (a === b) return a;
    const x = normPath(a).split('/'); const y = normPath(b).split('/');
    if (x.length !== y.length || a === '*' || b === '*') return '*';
    return x.map((s, i) => (s === y[i] ? s : '*')).join('/');
  }
  // r5: a receiver that is REF-LIKE — a ref / child / database call (any key form), a snapshot `.ref`, a call by a dynamic
  // method — through variables and branches; a write method on one whose path does not resolve is an OPAQUE write
  function refLike(n, depth = 0) {
    if (!n || depth > 6) return !!n;
    if (n.type === 'AwaitExpression' || n.type === 'ParenthesizedExpression') return refLike(n.argument || n.expression, depth + 1);
    if (n.type === 'SequenceExpression') return refLike(n.expressions[n.expressions.length - 1], depth + 1);
    if (n.type === 'ConditionalExpression') return refLike(n.consequent, depth + 1) || refLike(n.alternate, depth + 1);
    if (n.type === 'LogicalExpression') return refLike(n.left, depth + 1) || refLike(n.right, depth + 1);
    if (n.type === 'Identifier') { const b = resolve(n.name, n); return !!b && b.kind === 'var' && b.inits.some((i) => refLike(i, depth + 1)); }
    if (n.type === 'MemberExpression') return ['ref', 'parent', 'root'].includes(methodName(n));
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression') { const m = methodName(n.callee); return m === null || ['ref', 'child', 'database', 'push', 'orderByChild', 'equalTo'].includes(m); }
    return false;
  }
  // r3: a PATH expression's static shape — a literal / template / concatenation, a const, a path BUILDER's return
  // (`statusPath(oid)` → `orders/*/factura_status`), an object member (`decision.path`). Several shapes → the one that
  // could be orders; anything unresolved → '*' (fully dynamic: opaque at an order-capable write)
  function pathOfExpr(a, depth = 0) {
    if (!a || depth > 6) return '*';
    const sp = staticPath(a); if (sp !== null) return normPath(sp);
    const shapes = [];
    if (a.type === 'Identifier') { const k = refKey(a); if (k !== null) return k; const b = resolve(a.name, a); if (b && b.kind === 'var') for (const i of b.inits) shapes.push(pathOfExpr(i, depth + 1)); }
    else if (a.type === 'CallExpression') { for (const f of fnsFor(a)) for (const r of RETURNS.get(f) || []) shapes.push(pathOfExpr(r, depth + 1)); }
    else if (a.type === 'MemberExpression') {
      const mc = memberChain(a);
      if (mc && mc.steps.length) {
        let cur = entriesOf(mc.root);
        for (const st of mc.steps.slice(0, -1)) cur = selectKey(cur, st.key, a);
        const last = mc.steps[mc.steps.length - 1].key;
        const flat = expand(cur);
        if (flat.every((e) => e.k === 'prop')) for (const e of flat) if (e.key === last) shapes.push(pathOfExpr(e.value, depth + 1));
      }
    }
    const uniq = [...new Set(shapes)];
    if (uniq.length === 1) return uniq[0];
    if (!uniq.length) return '*';
    return uniq.find((x) => couldBeOrders(x.split('/')[0])) ? '*' : uniq[0];
  }
  // a ref(path) whose path is a variable: its single const init (`const p = `orders/${id}``)
  function refKey(a) { if (a.type !== 'Identifier') return null; const k = keyStatic(a, true); return k === null ? null : normPath(k); }

  // the first parameter of every transaction updater is the CURRENT value at its ref
  for (const { ast } of files) walk(ast, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'transaction') {
      const upd = node.arguments[0];
      if (upd && /Function/.test(upd.type) && upd.params[0] && upd.params[0].type === 'Identifier') {
        const b = (SCOPE.get(upd) || { vars: new Map() }).vars.get(upd.params[0].name);
        const pth = refPathOf(node.callee.object);
        if (b && pth !== null) b.currentOrder = { path: normPath(pth), sig: refSig(node.callee.object) };
      }
    }
  });

  // ── sinks ───────────────────────────────────────────────────────────────────────────────────────────────────────
  for (const { ast } of files) {
    walk(ast, function sinkVisit(node) {
      // codex r5 P1-2, modular form: runTransaction(ref(db[, '' | '/' | 'orders']), …) — opaque, never analysed
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'runTransaction' && node.arguments[0] && node.arguments[0].type === 'CallExpression' && node.arguments[0].callee.type === 'Identifier' && node.arguments[0].callee.name === 'ref') {
        const ra = node.arguments[0].arguments; const rp = ra.length < 2 ? '' : staticPath(ra[1]);
        if (rp !== null && (normPath(rp) === '' || normPath(rp) === 'orders')) opaqueW(node, normPath(rp) === '' ? 'transaction-at-root' : 'transaction-above-orders', `${normPath(rp) || '/'}: ${srcOf(node.arguments[1])}`);
      }
      // r4 DEFAULT-DENY over CALLEE forms: a ref's write method used any way but a direct call (`.call` / `.apply` / `.bind`,
      // extracted as a value) or named by a non-literal computed key is OPAQUE; a literal computed key (`['update']`) is
      // the method itself
      if (node.type === 'MemberExpression') {
        const par = PARENT.get(node);
        const direct = par && par.type === 'CallExpression' && par.callee === node;
        const nm = methodName(node);
        if (!direct && nm && WRITE_METHODS.has(nm) && refPathOf(node.object) !== null) opaqueW(node, 'unmodelled-write-method-use', `${srcOf(node)}`);
        if (direct && nm === null && node.computed && refPathOf(node.object) !== null) opaqueW(node, 'unmodelled-computed-method', srcOf(node));
      }
      if (!(node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && WRITE_METHODS.has(methodName(node.callee)))) return;   // EMPTY-OK: not a write-method call (a non-literal computed method on a ref is opaque above)
      const base = refPathOf(node.callee.object);
      // the receiver is not a database ref (crypto hashes, Firestore tx / batch, Maps) — unless it is REF-LIKE (r5: OPAQUE)
      if (base === null) { if (refLike(node.callee.object)) opaqueW(node, 'unresolved-ref-receiver', srcOf(node.callee.object)); return; }
      const m = methodName(node.callee); const v = node.arguments[0];
      const nb = normPath(base); const segs = nb === '' ? [] : nb.split('/');
      if (m === 'remove') {
        if (segs.length === 0 || (segs[0] === 'orders' && segs.length === 1)) opaqueW(node, segs.length ? 'remove-above-orders' : 'remove-at-root', nb || '/');
        else if (segs[0] === 'orders' && segs.length >= 3) writeAt(nb, [], node, 'remove');
        return;   // EMPTY-OK: removing a whole order writes no field — removing a whole order writes no field
      }
      if (m === 'transaction') {
        // codex r5 P1-2: a transaction at the ROOT or on /orders can rewrite any order — OPAQUE, RED unless bound
        if (segs.length === 0 || (segs[0] === 'orders' && segs.length === 1)) { opaqueW(node, segs.length ? 'transaction-above-orders' : 'transaction-at-root', `${nb || '/'}: ${srcOf(v)}`); return; }
        if (segs[0] !== 'orders') return;   // EMPTY-OK: a transaction on another tree
        if (segs.length >= 3) { writeAt(nb, [], node, 'transaction'); return; }   // EMPTY-OK: accounted (writeAt of the field path)
        const upd = v && /Function/.test(v.type) ? v : null;
        if (!upd) { opaqueW(node, 'transaction-on-order', `${nb}: ${srcOf(v)}`); return; }
        // r2 P1-1 / P2-5: provenance to the updater's RETURN value(s), as everywhere else — the parameter is the current
        // order (marked before this pass); a delegated return (`(cur) => C.claimDecision(cur, …)`) is a builder call whose
        // parameter binds to `cur`; an unresolved part of the return stays OPAQUE beside the resolved fields
        writeAt(nb, (RETURNS.get(upd) || []).flatMap((r) => entriesOf(r)), node, 'transaction-updater', 0, refSig(node.callee.object));   // EMPTY-OK: no return = abort
        return;   // EMPTY-OK: accounted (writeAt of the updater's returns)
      }
      if (!v) return;   // EMPTY-OK: a write call with no payload argument
      writeAt(m === 'push' ? `${nb}/*` : nb, entriesOf(v), node, m, 0, m === 'push' ? null : refSig(node.callee.object));
    });
  }

  // ── param sinks: resolved at every call site of the function (by name, across files), as a fixpoint ───────────────
  const sinkSeen = new Set();
  for (let i = 0; i < paramSinks.length; i++) {
    if (i > 20000) throw new Error('write-provenance: parameter-sink limit (analysis limit)');
    const s = paramSinks[i];
    const nm = FN.get(s.b.fnNode);
    const sk = `${FILE.get(s.b.fnNode).file}:${s.b.fnNode.start}:${s.b.index}|${s.base}|${s.at.start}`;
    if (sinkSeen.has(sk) || (nm && s.how.includes(`/via:${nm}`))) continue;   // once per (param, path, write); a recursion adds nothing
    sinkSeen.add(sk);
    const calls = callsOf(s.b.fnNode).filter((c) => c.arguments.length > s.b.index || (s.b.fnNode.params[s.b.index] && s.b.fnNode.params[s.b.index].type === 'AssignmentPattern'));
    if (!calls.length) { opaqueW(s.at, s.shape, s.b.name); continue; }
    for (const call of calls) {
      const arg = call.arguments[s.b.index];
      let entries = arg ? entriesOf(arg) : entriesOf(s.b.fnNode.params[s.b.index].right);
      if (s.b.propKey) entries = selectKey(entries, s.b.propKey, call);
      writeAt(s.base, entries, call, `${s.how}/via:${nm}`, 0, s.wsig);
    }
  }

  // r2 P1-2: a function whose PARAMETER reaches a write may only be invoked where we see it. Any VALUE reference to it
  // (passed as a callback, stored, re-exported under another name — anything but a call, its declaration, an alias we
  // follow, or its own export) means callers we cannot see → OPAQUE (RED unless bound).
  const sinkFns = new Set(paramSinks.map((s) => FN.get(s.b.fnNode)).filter((n) => n && IDENT.test(n)));
  const isExportSlot = (x) => {
    let p = PARENT.get(x);
    if (p && p.type === 'Property' && p.value === x) { const o = PARENT.get(p); const a = o && PARENT.get(o); return !!(a && a.type === 'AssignmentExpression' && a.right === o && /^(module\.)?exports$/.test(srcOf(a.left))); }
    if (p && p.type === 'AssignmentExpression' && p.right === x) return /^(module\.)?exports\.\w+$/.test(srcOf(p.left));
    return false;
  };
  const seenRef = new Set();
  for (const { ast } of files) walk(ast, function escapeVisit(node, fn, parent) {
    if (!parent) return;   // EMPTY-OK: the program root is not a reference
    let name = null;
    // r3 P1-2: an ALIAS (`const f = require('./m').g`, `const { g: f } = …`, `const f = g`) carries the function's identity
    const target = node.type === 'Identifier' ? (() => { const b = resolve(node.name, node); return b && b.kind === 'var' ? aliasName(node) : node.name; })() : null;
    if (node.type === 'Identifier' && target !== node.name && sinkFns.has(target)) {
      if (parent.type === 'CallExpression' && parent.callee === node) return;   // EMPTY-OK: a direct call through the alias — a call site
      if ((parent.type === 'VariableDeclarator' && parent.id === node) || (parent.type === 'Property' && PARENT.get(parent) && PARENT.get(parent).type === 'ObjectPattern')) return;   // EMPTY-OK: the alias's declaration
      name = target;
    } else if (node.type === 'Identifier' && sinkFns.has(node.name)) {
      if ((parent.type === 'CallExpression' && parent.callee === node) || (parent.type === 'MemberExpression' && parent.property === node && !parent.computed)) return;   // EMPTY-OK: a direct call, or a member name — not a value reference
      if ((/Function/.test(parent.type) && (parent.id === node || parent.params.includes(node))) || (parent.type === 'VariableDeclarator' && parent.id === node)) return;   // EMPTY-OK: the function's own declaration / a parameter
      if (parent.type === 'Property' && (parent.key === node && !parent.computed && parent.value !== node)) return;   // EMPTY-OK: a property key, not a value
      if (parent.type === 'Property' && PARENT.get(parent) && PARENT.get(parent).type === 'ObjectPattern') return;   // EMPTY-OK: a destructured import (the alias is followed) — a destructured import
      if (parent.type === 'VariableDeclarator' && parent.init === node) return;                                       // EMPTY-OK: an alias declaration (its uses are checked) — an alias we follow
      if (parent.type === 'AssignmentExpression' && parent.left === node) return;   // EMPTY-OK: an assignment target
      if (isExportSlot(node)) return;   // EMPTY-OK: its own export slot (other modules' calls are matched by name)
      const b = resolve(node.name, node);
      const isAlias = b && b.kind === 'var' && b.inits.length === 1 && ['MemberExpression', 'Pick', 'Identifier'].includes(b.inits[0].type);
      if (b && b.kind !== 'fn' && !isAlias) return;                                                                // EMPTY-OK: another binding of that name
      name = node.name;
    } else if (node.type === 'MemberExpression' && !node.computed && sinkFns.has(node.property.name)) {
      if ((parent.type === 'CallExpression' && parent.callee === node) || (parent.type === 'VariableDeclarator' && parent.init === node)) return;   // EMPTY-OK: a direct call, or an alias declaration
      if (parent.type === 'AssignmentExpression' && parent.left === node) return;   // EMPTY-OK: an assignment target
      name = node.property.name;
    }
    if (!name) return;   // EMPTY-OK: not a reference to a param-sink function
    const key = `${FILE.get(node).file}:${node.start}`; if (seenRef.has(key)) return; seenRef.add(key);   // EMPTY-OK: already reported
    opaqueW(node, 'function-escapes', name);
  });

  // ── over-approximation: a multipath map that ESCAPES without reaching a sink in view is recorded as written ─────────
  for (const b of allBindings) {
    if (b.kind !== 'var' || b.consumed || !b.escapes) continue;
    const own = [...b.inits.flatMap((i) => (i && i.type === 'ObjectExpression' ? entriesOf(i) : [])), ...contribEntries(b)];
    if (!own.some((e) => e.k === 'prop' && e.key !== null && /^\/?orders(\/|$)/.test(String(e.key)))) continue;
    writeAt('', own, b.declNode, 'escaped-multipath');
  }
  return { writes, opaqueWrites };
}

module.exports = { writeInventory, WRITE_METHODS };
