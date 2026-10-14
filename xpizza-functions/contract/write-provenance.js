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
 * Flow-insensitive on purpose: a contribution anywhere in scope counts, before or after the write (fail-closed). */

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
  const CALLS = new Map();          // callee name → [call node]
  const RETURNS = new Map();        // fn node → [returned expression]
  const allBindings = [];
  let CID = 0;

  // ── scopes and bindings ──────────────────────────────────────────────────────────────────────────────────────────
  const calleeName = (call) => { const c = call.callee; if (c.type === 'Identifier') return c.name; if (c.type === 'MemberExpression' && !c.computed && !COMMON.has(c.property.name)) return c.property.name; return null; };
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
      SCOPE.set(node, sc); FILE.set(node, u);
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') declare(sc, node.id.name, { kind: 'var', init: node.init, declNode: node });
      // `const { a, b: c } = src` — a var whose value is src's property
      if (node.type === 'VariableDeclarator' && node.id.type === 'ObjectPattern' && node.init) for (const q of node.id.properties) {
        const v = q.type === 'Property' ? (q.value.type === 'AssignmentPattern' ? q.value.left : q.value) : null;
        const key = q.type === 'Property' && !q.computed ? (q.key.name || String(q.key.value)) : null;
        if (v && v.type === 'Identifier' && key) { const pick = { type: 'Pick', source: node.init, key, start: q.start, end: q.end, loc: q.loc }; FILE.set(pick, u); SCOPE.set(pick, sc); declare(sc, v.name, { kind: 'var', init: pick, declNode: node }); }
      }
      if (node.type === 'ReturnStatement' && node.argument && sc.fnNode) { const l = RETURNS.get(sc.fnNode) || []; l.push(node.argument); RETURNS.set(sc.fnNode, l); }
      if (/Function/.test(node.type) && node.expression && node.body && sc.fnNode === node) { const l = RETURNS.get(node) || []; l.push(node.body); RETURNS.set(node, l); }
      if (node.type === 'CallExpression') {
        const nm = calleeName(node);
        if (nm) { const l = CALLS.get(nm) || []; l.push(node); CALLS.set(nm, l); }
      }
      for (const k of Object.keys(node)) {
        if (k === 'loc' || k === 'start' || k === 'end') continue;
        const v = node[k];
        if (Array.isArray(v)) v.forEach((c) => rec(c, sc, node)); else if (v && typeof v === 'object' && typeof v.type === 'string') rec(v, sc, node);
      }
    })(ast, root, null);
  }
  const resolve = (name, from) => { for (let s = SCOPE.get(from); s; s = s.parent) { const b = s.vars.get(name); if (b) return b; } return null; };
  const srcOf = (n) => { const u = FILE.get(n); return n && u ? u.code.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 80) : ''; };
  const fnOf = (n) => FN.get(n) || '<top>';

  // a KEY expression → its static string, or null (dynamic). An identifier key resolves through a single const init.
  function keyStatic(k, computed) {
    if (!computed) return k.type === 'Identifier' ? k.name : (k.type === 'Literal' ? String(k.value) : null);
    if (k.type === 'Literal') return typeof k.value === 'string' || typeof k.value === 'number' ? String(k.value) : null;
    if (k.type === 'Identifier') { const b = resolve(k.name, k); if (b && b.kind === 'var' && b.inits.length === 1) return keyStatic(b.inits[0], true); return null; }
    const sp = staticPath(k);
    return sp === null ? null : sp;
  }
  // `a.b[c].d` → { root: Identifier a, steps: [b, c, d] } (null if not rooted at an identifier)
  function memberChain(e) {
    const steps = []; let x = e;
    while (x && x.type === 'MemberExpression') { steps.unshift({ key: keyStatic(x.property, x.computed), node: x.property }); x = x.object; }
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
        const asArg = parent.type === 'CallExpression' && parent.arguments.includes(node);
        const asRet = parent.type === 'ReturnStatement' || (/Function/.test(parent.type) && parent.body === node);
        const asVal = (parent.type === 'Property' && parent.value === node) || (parent.type === 'AssignmentExpression' && parent.right === node && parent.left.type === 'MemberExpression') || parent.type === 'ArrayExpression';
        if (asArg || asRet || asVal) { const b = resolve(node.name, node); if (b) b.escapes = true; }
      }
    });
  }
  // a helper mutating its PARAMETER → the contribution lands on the caller's argument (fixpoint over helper chains)
  for (let round = 0, moved = true; moved && round < 6; round++) {
    moved = false;
    for (const b of allBindings) {
      if (b.kind !== 'param' || !b.contribs.length) continue;
      const nm = FN.get(b.fnNode); if (!nm || !IDENT.test(nm)) continue;
      b.carried = b.carried || new Set();
      for (const call of CALLS.get(nm) || []) {
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
  function contribEntries(b, env) {
    return b.contribs.map((c) => {
      let e = c.spread ? { k: 'spread', arg: c.spread, env } : null;
      const st = c.steps;
      if (!e) { const last = st[st.length - 1]; e = { k: 'prop', key: last.key, keyNode: last.node, value: c.value, env }; }
      const upto = c.spread ? st.length : st.length - 1;
      for (let i = upto - 1; i >= 0; i--) e = { k: 'prop', key: st[i].key, keyNode: st[i].node, value: virtual([e]), env };
      return e;
    });
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
      const b = resolve(n.name, n);
      if (!b || b.kind === 'fn') return [{ k: 'unresolved', node: n }];
      const sk = `${allBindings.indexOf(b)}@${env ? env.call.start : ''}`;
      if (seen.has(sk)) return [];
      seen.add(sk); b.consumed = true;
      const own = contribEntries(b, env);
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
    if (n.type === 'LogicalExpression') return [...entriesOf(n.left, env, d, seen), ...entriesOf(n.right, env, d, seen)];
    if (n.type === 'AwaitExpression' || n.type === 'ParenthesizedExpression') return entriesOf(n.argument || n.expression, env, d, seen);
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'Object' && c.property.name === 'assign') {
        return n.arguments.flatMap((a) => entriesOf(a, env, d, seen));
      }
      const nm = calleeName(n);
      const fns = nm ? FUNCS.get(nm) || [] : [];
      const out = [];
      for (const f of fns) for (const r of RETURNS.get(f) || []) out.push(...entriesOf(r, { fnNode: f, call: n, parent: env }, d, seen));
      if (!fns.some((f) => (RETURNS.get(f) || []).length)) return [{ k: 'unresolved', node: n }];
      return out;
    }
    if (n.type === 'Literal' || n.type === 'TemplateLiteral' || n.type === 'ArrayExpression' || n.type === 'UnaryExpression' || n.type === 'BinaryExpression') return [];
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

  // a payload `entries` written at `base` (a static path shape); `at` is the write call (or the call site carrying it)
  function writeAt(base, entries, at, how, depth = 0) {
    const p = normPath(base); const segs = p === '' ? [] : p.split('/');
    if (depth > 8) return;
    const atRootOrOrders = segs.length === 0 || (segs[0] === 'orders' && segs.length === 1);
    if (!atRootOrOrders && segs[0] !== 'orders') return;
    if (segs.length >= 3) { if (dynamicField(segs[2])) opaqueW(at, 'dynamic-field-segment', p); else record(at, segs[2], how); return; }
    const flat = expand(entries);
    for (const e of flat) {
      if (e.k === 'param') { paramSinks.push({ b: e.b, base: p, at, how, shape: atRootOrOrders ? (segs.length ? 'write-above-orders' : 'unresolved-root-write') : 'opaque-order-object' }); continue; }
      if (e.k === 'unresolved') { opaqueW(at, atRootOrOrders ? (segs.length ? 'write-above-orders' : 'unresolved-root-write') : 'opaque-order-object', `${p || '/'}: ${srcOf(e.node)}`); continue; }
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
        if (segs.length === 0 && !String(k).startsWith('orders')) continue;      // a root write of another tree
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
        const nm = FN.get(b.fnNode);
        for (const call of (nm && IDENT.test(nm) ? CALLS.get(nm) || [] : [])) {
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

  // a value derived from the transaction updater's parameter (the current order) — its spread is the existing order
  function fromParam(n, param, depth = 0) {
    if (!n || depth > 6) return false;
    if (n.type === 'Identifier') { if (n.name === param) return true; const b = resolve(n.name, n); return !!(b && b.kind === 'var' && b.inits.some((i) => fromParam(i, param, depth + 1))); }
    if (n.type === 'MemberExpression') return fromParam(n.object, param, depth + 1);
    if (n.type === 'LogicalExpression') return fromParam(n.left, param, depth + 1) || fromParam(n.right, param, depth + 1);
    if (n.type === 'ConditionalExpression') return fromParam(n.consequent, param, depth + 1) || fromParam(n.alternate, param, depth + 1);
    return false;
  }

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
        if (!upd) { opaqueW(node, 'transaction-on-order', nb); return; }
        // an updater that DELEGATES (`(cur) => C.claimDecision(cur, …)`): the helper's returned object(s)
        if (upd.body.type === 'CallExpression') {
          const fl = expand(entriesOf(upd.body));
          const named = fl.filter((e) => e.k === 'prop' && !dynamicField(e.key));
          for (const e of named) record(node, String(e.key), `transaction-delegate:${(upd.body.callee.property || upd.body.callee).name}`);
          if (!named.length) opaqueW(node, 'transaction-on-order', `delegates to ${(upd.body.callee.property || upd.body.callee).name}`);
          return;
        }
        const param = upd.params[0] && upd.params[0].type === 'Identifier' ? upd.params[0].name : null;
        let found = 0;
        walk(upd.body, (x) => {
          if (x.type === 'ObjectExpression') for (const q of x.properties) {
            if (q.type === 'SpreadElement') {
              if (param && fromParam(q.argument, param)) continue;   // the current order itself
              const before = writes.length + paramSinks.length + opaqueWrites.length;
              writeAt(nb, [{ k: 'spread', arg: q.argument }], node, 'transaction-updater/spread');
              found += (writes.length + paramSinks.length + opaqueWrites.length) > before ? 1 : 0;
              continue;
            }
            const k = keyStatic(q.key, q.computed);
            if (dynamicField(k)) { if (q.computed) opaqueW(node, 'dynamic-field-segment', `${nb}/${k === null ? srcOf(q.key) : k}`); continue; }
            record(node, String(k), 'transaction-updater'); found += 1;
          }
          if (x.type === 'AssignmentExpression' && x.left.type === 'MemberExpression' && x.left.object.type === 'Identifier') {
            const b = resolve(x.left.object.name, x.left.object);
            const local = (x.left.object.name === param) || (b && b.kind === 'var' && SCOPE.get(b.declNode) && SCOPE.get(b.declNode).fnNode === upd);
            if (local) { const k = keyStatic(x.left.property, x.left.computed); if (dynamicField(k)) opaqueW(node, 'dynamic-field-segment', `${nb}/${k === null ? srcOf(x.left.property) : k}`); else { record(node, String(k), 'transaction-updater'); found += 1; } }
          }
        });
        if (!found) opaqueW(node, 'transaction-on-order', nb);
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
    const calls = nm && IDENT.test(nm) ? (CALLS.get(nm) || []).filter((c) => c.arguments.length > s.b.index || (s.b.fnNode.params[s.b.index] && s.b.fnNode.params[s.b.index].type === 'AssignmentPattern')) : [];
    if (!calls.length) { opaqueW(s.at, s.shape, s.b.name); continue; }
    for (const call of calls) {
      const arg = call.arguments[s.b.index];
      let entries = arg ? entriesOf(arg) : entriesOf(s.b.fnNode.params[s.b.index].right);
      if (s.b.propKey) entries = selectKey(entries, s.b.propKey, call);
      writeAt(s.base, entries, call, `${s.how}/via:${nm}`);
    }
  }

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
