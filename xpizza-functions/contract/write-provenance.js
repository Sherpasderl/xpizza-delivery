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
 *  - A key that CONSTANT-FOLDS exactly to a literal is resolved provenance (advisor r2, amending r1) — see keyStatic. */

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
  const calleeName = (call) => { const c = call.callee; if (c.type === 'Identifier') return aliasName(c); if (c.type === 'MemberExpression' && !c.computed && !COMMON.has(c.property.name)) return c.property.name; return null; };
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
          if (id) declare(sc, id.name, { kind: 'param', index: i, fnNode: node, declNode: id });
          const pat = p.type === 'ObjectPattern' ? p : (p.type === 'AssignmentPattern' && p.left.type === 'ObjectPattern' ? p.left : null);
          // a DESTRUCTURED parameter `({ a, b: c })` — each name is the caller's argument property
          if (pat) for (const q of pat.properties) {
            const v = q.type === 'Property' ? (q.value.type === 'AssignmentPattern' ? q.value.left : q.value) : null;
            const key = q.type === 'Property' && !q.computed ? (q.key.name || String(q.key.value)) : null;
            if (v && v.type === 'Identifier' && key) { const b = declare(sc, v.name, { kind: 'param', index: i, fnNode: node, declNode: v }); b.propKey = key; }
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
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') declare(sc, node.id.name, { kind: 'var', init: node.init, declNode: node });
      // `const { a, b: c } = src` — a var whose value is src's property
      if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && node.init) for (const q of node.id.properties) {
        const v = q.type === 'Property' ? (q.value.type === 'AssignmentPattern' ? q.value.left : q.value) : null;
        const key = q.type === 'Property' && !q.computed ? (q.key.name || String(q.key.value)) : null;
        if (v && v.type === 'Identifier' && key) { const pick = { type: 'Pick', source: node.init, key, start: q.start, end: q.end, loc: q.loc }; FILE.set(pick, u); SCOPE.set(pick, sc); declare(sc, v.name, { kind: 'var', init: pick, declNode: node }); }
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
  const PURE_OBJ = new Set(['console', 'JSON', 'Object', 'Math', 'Number', 'String', 'Array', 'Boolean', 'Date', 'Promise']);
  const PURE_FN = new Set(['String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'isFinite', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'require']);
  const PURE_METHOD = new Set(['json', 'send', 'status', 'log', 'warn', 'error', 'info', 'includes', 'indexOf', 'has', 'get', 'then', 'catch', 'finally', 'toString', 'once', 'on', 'off', 'filter', 'map', 'some', 'every', 'find', 'reduce', 'forEach', 'equalTo', 'orderByChild', 'startAt', 'endAt', 'limitToFirst', 'limitToLast']);
  const pendingHeap = [];
  // the consumer an identifier's VALUE flows into, through wrappers that keep the same object (cond / logical / await)
  function heapEscape(id) {
    let x = id; let p = PARENT.get(x);
    while (p && ((p.type === 'ConditionalExpression' && p.test !== x) || p.type === 'LogicalExpression' || p.type === 'AwaitExpression' || p.type === 'ParenthesizedExpression')) { x = p; p = PARENT.get(x); }
    if (!p) return null;
    if (p.type === 'NewExpression' && p.arguments.includes(x)) return 'new';
    if (p.type === 'ArrayExpression') return 'array';
    if (p.type === 'AssignmentExpression' && p.right === x && p.left.type === 'MemberExpression' && !rootOf(p.left)) return 'stored-untracked';
    if (p.type === 'CallExpression' && p.arguments.includes(x)) {
      const c = p.callee;
      if (c.type === 'MemberExpression' && !c.computed) {
        const nm = c.property.name;
        if (c.object.type === 'Identifier' && PURE_OBJ.has(c.object.name)) return null;
        if (nm === 'assign' && c.object.type === 'Identifier' && c.object.name === 'Object') return null;
        if (WRITE_METHODS.has(nm) && refPathOf(c.object) !== null) return null;      // a database write: the sink itself
        if (PURE_METHOD.has(nm)) return null;
        if (/^(Object|Array|String|Number)\.prototype\./.test(srcOf(c))) return null;   // Object.prototype.hasOwnProperty.call(x, k)
        if (COMMON.has(nm)) return `call:.${nm}`;
      }
      if (c.type === 'Identifier' && PURE_FN.has(c.name)) return null;
      const fns = fnsFor(p);
      if (!fns.length) return `call:${srcOf(c).slice(0, 40)}`;
      return { pending: { fns, index: p.arguments.indexOf(x) } };     // our own function: escapes iff its param does
    }
    return null;
  }

  // ── contributions + escapes ─────────────────────────────────────────────────────────────────────────────────────
  for (const { ast } of files) {
    walk(ast, (node, fn, parent) => {
      if (node.type === 'AssignmentExpression' && node.operator === '=') {
        if (node.left.type === 'Identifier') { const b = resolve(node.left.name, node.left); if (b && b.kind === 'var') b.inits.push(node.right); }
        else if (node.left.type === 'MemberExpression') {
          const r = rootOf(node.left);
          if (r && r.steps.length) r.binding.contribs.push({ id: ++CID, steps: r.steps, value: node.right, at: node });
        }
      }
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
  for (let round = 0, moved = true; moved && round < 8; round++) {
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
  for (let round = 0, moved = true; moved && round < 6; round++) {
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
          if (b.carried.has(key) || r.binding.contribs.length > 4000) continue;
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
        if (!c.steps[i].keysOf) continue;
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
  function entriesOf(n, env = null, depth = 0, seen = new Set()) {
    if (!n) return [];
    if (n.type === 'Virtual') return n.entries;
    if (!env && MEMO.has(n)) return MEMO.get(n);
    const key = n;
    if (INPROG.has(key) || depth > 12) return [];
    INPROG.add(key);
    const r = entriesOf0(n, env, depth, seen);
    INPROG.delete(key);
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
      return n.properties.map((p) => (p.type === 'SpreadElement' ? { k: 'spread', arg: p.argument, env }
        : { k: 'prop', key: keyStatic(p.key, p.computed), keyNode: p.key, value: p.value, env }));
    }
    if (n.type === 'Identifier') {
      if (n.name === 'undefined' || n.name === 'NaN' || n.name === 'Infinity') return [];   // primitives (an updater's abort)
      const b = resolve(n.name, n);
      if (!b || b.kind === 'fn') return [{ k: 'unresolved', node: n }];
      const sk = `${allBindings.indexOf(b)}@${env ? env.call.start : ''}`;
      if (seen.has(sk)) return [];
      seen.add(sk); b.consumed = true;
      const own = contribEntries(b, env);
      // r2 P1-3: an object that escaped into the heap may be mutated out of view → its provenance is incomplete
      if (b.heap) own.push({ k: 'unresolved', node: n, why: `escapes (${b.heap})` });
      // r2 P1-1 / P2-5: a transaction updater's parameter IS the current value at the ref — spreading or returning it
      // writes no new field; only what is assigned onto it (its contributions) is new
      if (b.currentOrder) return own;
      if (b.kind === 'param') {
        for (let f = env; f; f = f.parent) {
          if (f.fnNode !== b.fnNode) continue;
          const a = argOf(f.call, b);
          let ents = a ? entriesOf(a, f.parent, d, seen) : [];
          if (b.propKey) ents = selectKey(ents, b.propKey, f.call);
          return [...ents, ...own];
        }
        return [{ k: 'param', b, node: n }, ...own];
      }
      const fromInits = b.inits.flatMap((i) => entriesOf(i, env, d, seen));
      return [...fromInits, ...own];
    }
    if (n.type === 'Pick') return selectKey(entriesOf(n.source, env, d, seen), n.key, n);
    if (n.type === 'MemberExpression') {
      const mc = memberChain(n);
      if (!mc) return [{ k: 'unresolved', node: n }];
      let cur = entriesOf(mc.root, env, d, seen);
      for (const s of mc.steps) cur = selectKey(cur, s.key, n);
      return cur;
    }
    if (n.type === 'ConditionalExpression') return [...entriesOf(n.consequent, env, d, seen), ...entriesOf(n.alternate, env, d, seen)];
    if (n.type === 'LogicalExpression') {
      // `cur || order` inside an updater: the fallback is the caller's snapshot of the SAME order (reviewed: it only runs
      // when the ref is empty) — the current value decides, as `cur` alone
      if (n.left.type === 'Identifier') { const lb = resolve(n.left.name, n.left); if (lb && lb.currentOrder) return entriesOf(n.left, env, d, seen); }
      return [...entriesOf(n.left, env, d, seen), ...entriesOf(n.right, env, d, seen)];
    }
    if (n.type === 'AwaitExpression' || n.type === 'ParenthesizedExpression') return entriesOf(n.argument || n.expression, env, d, seen);
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'Object' && c.property.name === 'assign') {
        return n.arguments.flatMap((a) => entriesOf(a, env, d, seen));
      }
      const fns = fnsFor(n);
      const out = [];
      for (const f of fns) for (const r of RETURNS.get(f) || []) out.push(...entriesOf(r, { fnNode: f, call: n, parent: env }, d, seen));
      if (!fns.some((f) => (RETURNS.get(f) || []).length)) return [{ k: 'unresolved', node: n }];
      return out;
    }
    // primitives write no field of their own; EVERYTHING else that is not modelled (arrays, `this`, `new`, …) is OPAQUE —
    // r2 ruling: a value reaching a write is fully resolved or carries an opaque marker, never empty provenance
    if (n.type === 'Literal' || n.type === 'TemplateLiteral' || n.type === 'UnaryExpression' || n.type === 'BinaryExpression') return [];
    return [{ k: 'unresolved', node: n }];
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
      if (e.k !== 'spread') { out.push(e); continue; }
      if (depth > 8) { out.push({ k: 'spread-unresolved', arg: e.arg, env: e.env }); continue; }
      const inner = entriesOf(e.arg, e.env);
      for (const x of expand(inner, depth + 1)) out.push(x.k === 'unresolved' ? { k: 'spread-unresolved', arg: e.arg, env: e.env } : x);
    }
    return out;
  }

  // ── recording ───────────────────────────────────────────────────────────────────────────────────────────────────
  const paramSinks = [];
  const record = (at, field, how) => { const u = FILE.get(at); writes.push({ file: u.file, fn: fnOf(at), field, how, line: at.loc.start.line }); };
  const opaqueW = (at, how, detail) => { const u = FILE.get(at); opaqueWrites.push({ file: u.file, fn: fnOf(at), how, line: at.loc.start.line, ...(detail ? { detail } : {}) }); };
  const dynamicField = (k) => k === null || k === undefined || k === '' || String(k).includes('*');
  // a path segment shape ('*' = dynamic) that could spell `orders`
  const couldBeOrders = (seg) => new RegExp(`^${String(seg).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test('orders');

  // a payload `entries` written at `base` (a static path shape); `at` is the write call (or the call site carrying it)
  function writeAt(base, entries, at, how, depth = 0) {
    const p = normPath(base); const segs = p === '' ? [] : p.split('/');
    if (depth > 8) return;
    const atRootOrOrders = segs.length === 0 || (segs[0] === 'orders' && segs.length === 1);
    if (!atRootOrOrders && segs[0] !== 'orders') { if (couldBeOrders(segs[0])) opaqueW(at, 'dynamic-root-path', p); return; }
    if (segs.length >= 3) { if (dynamicField(segs[2])) opaqueW(at, 'dynamic-field-segment', p); else record(at, segs[2], how); return; }
    const flat = expand(entries);
    for (const e of flat) {
      if (e.k === 'param') { paramSinks.push({ b: e.b, base: p, at, how, shape: atRootOrOrders ? (segs.length ? 'write-above-orders' : 'unresolved-root-write') : 'opaque-order-object' }); continue; }
      if (e.k === 'unresolved') { opaqueW(at, atRootOrOrders ? (segs.length ? 'write-above-orders' : 'unresolved-root-write') : 'opaque-order-object', `${p || '/'}: ${e.node ? (srcOf(e.node) || ('<' + e.node.type + '>')) : '?'}${e.why ? ` — ${e.why}` : ''}`); continue; }
      if (e.k === 'spread-unresolved') {
        const pr = e.arg.type === 'Identifier' ? resolve(e.arg.name, e.arg) : null;
        const bound = (() => { for (let f = e.env; f; f = f.parent) if (pr && f.fnNode === pr.fnNode) return true; return false; })();
        if (pr && pr.kind === 'param' && !bound) { paramSinks.push({ b: pr, base: p, at, how: `${how}/spread`, shape: atRootOrOrders ? (segs.length ? 'spread-in-order-write' : 'spread-at-root') : 'spread-in-order-write' }); continue; }
        opaqueW(at, atRootOrOrders ? (segs.length ? 'spread-in-order-write' : 'spread-at-root') : 'spread-in-order-write', e.arg.type === 'Identifier' ? e.arg.name : srcOf(e.arg).slice(0, 60));
        continue;
      }
      const k = e.key;
      if (atRootOrOrders) {
        if (k === null || k === undefined) { opaqueW(at, segs.length ? 'computed-key-in-order-write' : 'computed-key-at-root', srcOf(e.keyNode)); continue; }
        // a root key whose FIRST segment is dynamic could be `orders` → opaque; a literal other tree is not ours
        if (segs.length === 0 && couldBeOrders(String(k).split('/')[0])) { if (String(k).split('/')[0] !== 'orders') { opaqueW(at, 'computed-key-at-root', String(k)); continue; } }
        else if (segs.length === 0) continue;      // a root write of another tree
        writeAt(`${p}/${k}`, entriesOf(e.value, e.env), at, how, depth + 1);
        continue;
      }
      // segs.length === 2: the order object — keys are fields, or sub-paths
      if (k !== null && k !== undefined && String(k).includes('/')) { writeAt(`${p}/${k}`, entriesOf(e.value, e.env), at, how, depth + 1); continue; }
      if (dynamicField(k)) { opaqueW(at, 'dynamic-field-segment', `${p}/${k === null || k === undefined ? `[${srcOf(e.keyNode)}]` : k}`); continue; }   // any non-literal FIELD key
      record(at, String(k), how);
    }
  }

  // the ref path a write call targets: ref(...) / child(...) chains, through same-scope variables
  function refPathOf(n, depth = 0) {
    if (!n || depth > 4) return null;
    if (n.type === 'Identifier') {
      const b = resolve(n.name, n); if (!b) return null;
      for (const i of b.inits) { const r = refPathOf(i, depth + 1); if (r !== null) return r; }
      // a REF PARAMETER (`finalize(orderRef, …)`): the ref each call site passes
      if (b.kind === 'param') {
        for (const call of callsOf(b.fnNode)) {
          let a = call.arguments[b.index];
          if (a && b.propKey) { const q = a.type === 'ObjectExpression' ? a.properties.find((x) => x.type === 'Property' && !x.computed && (x.key.name || String(x.key.value)) === b.propKey) : null; a = q ? q.value : null; }
          const r = a ? refPathOf(a, depth + 1) : null; if (r !== null) return r;
        }
      }
      return null;
    }
    if (n.type === 'AwaitExpression') return refPathOf(n.argument, depth + 1);
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed) {
      const m = n.callee.property.name;
      if (m === 'ref') return n.arguments.length ? (staticPath(n.arguments[0]) === null ? refKey(n.arguments[0]) : normPath(staticPath(n.arguments[0]))) : '';
      if (m === 'child') { const b = refPathOf(n.callee.object, depth + 1); const c = staticPath(n.arguments[0]); return b === null ? null : normPath(`${b}/${c === null ? '*' : c}`); }
    }
    return null;
  }
  // a ref(path) whose path is a variable: its single const init (`const p = `orders/${id}``)
  function refKey(a) { if (a.type !== 'Identifier') return null; const k = keyStatic(a, true); return k === null ? null : normPath(k); }

  // the first parameter of every transaction updater is the CURRENT value at its ref
  for (const { ast } of files) walk(ast, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'transaction') {
      const upd = node.arguments[0];
      if (upd && /Function/.test(upd.type) && upd.params[0] && upd.params[0].type === 'Identifier') { const b = (SCOPE.get(upd) || { vars: new Map() }).vars.get(upd.params[0].name); if (b) b.currentOrder = true; }
    }
  });

  // ── sinks ───────────────────────────────────────────────────────────────────────────────────────────────────────
  for (const { ast } of files) {
    walk(ast, (node) => {
      // codex r5 P1-2, modular form: runTransaction(ref(db[, '' | '/' | 'orders']), …) — opaque, never analysed
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'runTransaction' && node.arguments[0] && node.arguments[0].type === 'CallExpression' && node.arguments[0].callee.type === 'Identifier' && node.arguments[0].callee.name === 'ref') {
        const ra = node.arguments[0].arguments; const rp = ra.length < 2 ? '' : staticPath(ra[1]);
        if (rp !== null && (normPath(rp) === '' || normPath(rp) === 'orders')) opaqueW(node, normPath(rp) === '' ? 'transaction-at-root' : 'transaction-above-orders', `${normPath(rp) || '/'}: ${srcOf(node.arguments[1])}`);
      }
      if (!(node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && WRITE_METHODS.has(node.callee.property.name))) return;
      const base = refPathOf(node.callee.object);
      if (base === null) return;
      const m = node.callee.property.name; const v = node.arguments[0];
      const nb = normPath(base); const segs = nb === '' ? [] : nb.split('/');
      if (m === 'remove') {
        if (segs.length === 0 || (segs[0] === 'orders' && segs.length === 1)) opaqueW(node, segs.length ? 'remove-above-orders' : 'remove-at-root', nb || '/');
        else if (segs[0] === 'orders' && segs.length >= 3) writeAt(nb, [], node, 'remove');
        return;   // removing a whole order writes no field
      }
      if (m === 'transaction') {
        // codex r5 P1-2: a transaction at the ROOT or on /orders can rewrite any order — OPAQUE, RED unless bound
        if (segs.length === 0 || (segs[0] === 'orders' && segs.length === 1)) { opaqueW(node, segs.length ? 'transaction-above-orders' : 'transaction-at-root', `${nb || '/'}: ${srcOf(v)}`); return; }
        if (segs[0] !== 'orders') return;
        if (segs.length >= 3) { writeAt(nb, [], node, 'transaction'); return; }
        const upd = v && /Function/.test(v.type) ? v : null;
        if (!upd) { opaqueW(node, 'transaction-on-order', `${nb}: ${srcOf(v)}`); return; }
        // r2 P1-1 / P2-5: provenance to the updater's RETURN value(s), as everywhere else — the parameter is the current
        // order (marked before this pass); a delegated return (`(cur) => C.claimDecision(cur, …)`) is a builder call whose
        // parameter binds to `cur`; an unresolved part of the return stays OPAQUE beside the resolved fields
        writeAt(nb, (RETURNS.get(upd) || []).flatMap((r) => entriesOf(r)), node, 'transaction-updater');
        return;
      }
      if (!v) return;
      writeAt(m === 'push' ? `${nb}/*` : nb, entriesOf(v), node, m);
    });
  }

  // ── param sinks: resolved at every call site of the function (by name, across files), as a fixpoint ───────────────
  const sinkSeen = new Set();
  for (let i = 0; i < paramSinks.length && i < 20000; i++) {
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
      writeAt(s.base, entries, call, `${s.how}/via:${nm}`);
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
  for (const { ast } of files) walk(ast, (node, fn, parent) => {
    if (!parent) return;
    let name = null;
    if (node.type === 'Identifier' && sinkFns.has(node.name)) {
      if ((parent.type === 'CallExpression' && parent.callee === node) || (parent.type === 'MemberExpression' && parent.property === node && !parent.computed)) return;
      if ((/Function/.test(parent.type) && (parent.id === node || parent.params.includes(node))) || (parent.type === 'VariableDeclarator' && parent.id === node)) return;
      if (parent.type === 'Property' && (parent.key === node && !parent.computed && parent.value !== node)) return;
      if (parent.type === 'Property' && PARENT.get(parent) && PARENT.get(parent).type === 'ObjectPattern') return;   // a destructured import
      if (parent.type === 'VariableDeclarator' && parent.init === node) return;                                       // an alias we follow
      if (parent.type === 'AssignmentExpression' && parent.left === node) return;
      if (isExportSlot(node)) return;
      const b = resolve(node.name, node); if (b && b.kind !== 'fn') return;                                           // another binding of that name
      name = node.name;
    } else if (node.type === 'MemberExpression' && !node.computed && sinkFns.has(node.property.name)) {
      if ((parent.type === 'CallExpression' && parent.callee === node) || (parent.type === 'VariableDeclarator' && parent.init === node)) return;
      if (parent.type === 'AssignmentExpression' && parent.left === node) return;
      name = node.property.name;
    }
    if (!name) return;
    const key = `${FILE.get(node).file}:${node.start}`; if (seenRef.has(key)) return; seenRef.add(key);
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
