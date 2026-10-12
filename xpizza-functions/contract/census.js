'use strict';
/* R3 §3a — THE CENSUS: every read site of an order fact, derived from source by AST (acorn), with inline <script> bodies
 * extracted by parse5 (never by regex). Deterministic; `npm run r3:census -- --write` regenerates contract/census.json,
 * and contract/census.guard.test.js fails on any NEW, STALE, UNMAPPED or UNCLASSIFIED entry.
 *
 * SCOPE: every *.js / *.mjs under xpizza-functions (index.js included; tests, tools, contract and node_modules excluded)
 * and every reader app dir (kitchen, dispatch, dispatch-mobile, driver, dashboard, track, orders, la-musa-orders, portal,
 * factura) — its local *.js / *.mjs and its index.html inline scripts. A page's inline scripts + its local modules = one
 * SCOPE (projection links are scoped). xpizza-catering / xpizza-reference are out of scope (not order readers; stated).
 *
 * SITES: member reads `x.f` / `x['f']`, destructuring (incl. parameters) of a canonical field f. The base object is NOT
 * required to be an order (deliberate over-approximation; false positives are EXEMPTED with a reason in census.json).
 * Site id = `${file}#${fn}#${field}#${ordinal}` (ordinal = occurrence of that field within that function) — stable
 * across unrelated edits, unlike line numbers (recorded too, informational).
 * OPAQUE: computed access with a non-literal key, Object.entries/keys/values, or spread, on an identifier whose name
 * marks it as an order value (order/orders/o/ord/snap/val/data/after/before) — needs an explicit mapping.
 * PROJECTIONS (§3a): an object-literal property `alias: <expr reading f>` (alias not canonical) links alias → f in that
 * scope; reads of `.alias` then become sites of f's facts. Repeated to a fixpoint, bounded at depth 3 — if the 3rd round
 * still adds links, the census FAILS (explicit mapping required), never truncates.
 * WRITE SENTINEL: in functions files, object-literal keys / string path segments matching tip* / delivery_fee* / *_email
 * on an order path; plus the inventory of keys WRITTEN into order objects by the order builders (a new key = a census
 * decision).
 * TIMERS: every setTimeout / setInterval / sleep(…) call in functions files, classified (application-sleep | io-deadline |
 * sdk-or-other) — classification proposed by rule, confirmed in census.json; an unconfirmed one fails.
 * CLOCKS: every Date.now() / new Date() / ServerValue.TIMESTAMP in functions files, proposed into a §6a row
 * (persisted-stamp | business-comparison | cache-ttl | io-deadline | display | unclassified).
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const parse5 = require('parse5');

const REPO = path.join(__dirname, '..', '..');
const FN_DIR = path.join(REPO, 'xpizza-functions');
const READER_DIRS = ['xpizza-kitchen', 'xpizza-dispatch', 'xpizza-dispatch-mobile', 'xpizza-driver', 'xpizza-dashboard', 'xpizza-track', 'xpizza-orders', 'la-musa-orders', 'xpizza-portal', 'xpizza-factura'];

// §1 — canonical persisted fields → the facts they carry
const FIELD_FACTS = {
  items_text: ['ITEMS'], summary_lines: ['ITEMS', 'MONEY'], factura_items: ['ITEMS', 'BREAKDOWN'], items: ['ITEMS'],
  total_cents: ['MONEY', 'COLLECT', 'CASH'], total: ['MONEY', 'COLLECT', 'CASH'],
  subtotal_cents: ['BREAKDOWN'], tax_cents: ['BREAKDOWN'], discount_cents: ['BREAKDOWN'], desc_rebaja_cents: ['BREAKDOWN'],
  cash_tendered_cents: ['TENDER'], cash_tendered: ['TENDER'],
  payment_method: ['COLLECT', 'PAYLIFE', 'ACCT', 'FACTELIG'], payment_status: ['COLLECT', 'PAYLIFE', 'ACCT', 'FACTELIG'], free_order: ['COLLECT'],
  status: ['STATUS', 'PAYLIFE', 'ACCT', 'FACTELIG'], refunded_at: ['PAYLIFE'], refund_ref: ['PAYLIFE'], blocked_reason: ['PAYLIFE'],
  order_type: ['FULFIL'], pickup_time: ['FULFIL'],
  scheduled_for: ['SCHED'], release_at: ['SCHED'], released_at: ['SCHED'], scheduled_blocked: ['SCHED'],
  address_detected: ['PLACE'], address_details: ['PLACE'], lat: ['PLACE'], lng: ['PLACE'], maps_link: ['PLACE'], hub_lat: ['PLACE'], hub_lng: ['PLACE'],
  restaurant_name: ['PLACE'], address_short: ['PLACE'], restaurant_id: ['BRAND'],
  display_number: ['NUM'], order_id: ['NUM'],
  delivered_by_uid: ['DRIVER'], delivered_by_name: ['DRIVER'], delivered_at: ['DRIVER', 'CASH'], fulfilled_offline_at: ['DRIVER'],
  cash_owed: ['CASH'], redemption: ['REWARD'], earn_preview: ['REWARD'], factura_status: ['FACTELIG'],
};
const FIELDS = new Set(Object.keys(FIELD_FACTS));
// tip / delivery fee / order email — snake AND camel case (codex r1 P1-1: `tipAmount` stayed green)
const SENTINEL = /^(tips?|tip_[a-z0-9_]*|tip[A-Z]\w*|delivery_?fee\w*|deliveryFee\w*|service_?charge\w*|serviceCharge\w*|[a-z0-9_]*_email|[a-z]+Email)$/;
const ORDERISH = /^(order|orders|o|ord|snap|val|data|after|before|order_?[a-z]*)$/i;

const rel = (abs) => path.relative(REPO, abs).split(path.sep).join('/');
function listFiles(dir, { skip = [] } = {}) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(e.name) || skip.some((s) => s(e.name, d))) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(m?js)$/.test(e.name)) out.push(p);
    }
  })(dir);
  return out.sort();
}
const isTestName = (n) => /\.test\.(m?js)$|\.guard\.test|\.measure\.|\.proof\./.test(n);

// every source unit: { file, scope, kind:'fn'|'page', code, lineOffset, module }
function sources() {
  const units = [];
  for (const f of listFiles(FN_DIR, { skip: [(n, d) => d === FN_DIR && ['test', 'tools', 'contract', 'deploy', 'scripts'].includes(n), (n) => isTestName(n)] })) {
    units.push({ file: rel(f), scope: 'functions', kind: 'fn', code: fs.readFileSync(f, 'utf8'), lineOffset: 0, module: f.endsWith('.mjs') });
  }
  for (const d of READER_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of listFiles(abs, { skip: [(n) => isTestName(n), (n) => n === 'sw.js'] })) {
      units.push({ file: rel(f), scope: d, kind: 'page', code: fs.readFileSync(f, 'utf8'), lineOffset: 0, module: true });
    }
    const html = path.join(abs, 'index.html');
    if (fs.existsSync(html)) {
      const doc = parse5.parse(fs.readFileSync(html, 'utf8'), { sourceCodeLocationInfo: true });
      let k = 0;
      (function walk(n) {
        if (n.nodeName === 'script' && !(n.attrs || []).some((a) => a.name === 'src')) {
          const type = ((n.attrs || []).find((a) => a.name === 'type') || {}).value || '';
          if (!type || type === 'module' || /javascript/.test(type)) {
            const t = (n.childNodes || []).find((c) => c.nodeName === '#text');
            if (t && t.value.trim()) units.push({ file: `${rel(html)}<script@${k}>`, scope: d, kind: 'page', code: t.value, lineOffset: (t.sourceCodeLocation ? t.sourceCodeLocation.startLine - 1 : 0), module: type === 'module' });
            k += 1;
          }
        }
        for (const c of n.childNodes || []) walk(c);
        if (n.content) walk(n.content);
      })(doc);
    }
  }
  return units;
}

function parseUnit(u) {
  const opts = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true, allowImportExportEverywhere: true, allowAwaitOutsideFunction: true };
  try { return acorn.parse(u.code, { ...opts, sourceType: u.module ? 'module' : 'script' }); }
  catch (e1) { try { return acorn.parse(u.code, { ...opts, sourceType: u.module ? 'script' : 'module' }); } catch (e2) { throw new Error(`census: cannot parse ${u.file}: ${e1.message}`); } }
}

// walk with the enclosing function name
function walk(ast, visit) {
  (function rec(node, fn, parent, gp) {
    if (!node || typeof node.type !== 'string') return;
    let name = fn;
    if (/Function/.test(node.type)) {
      // an export's handler: `exports.X = onValueWritten(opts, async (event) => …)` → X (the handler is the call's arg)
      const exportOfCall = parent && parent.type === 'CallExpression' && gp && gp.type === 'AssignmentExpression' && gp.left.type === 'MemberExpression' && gp.left.property && gp.left.property.name;
      // a callback registered on an object (`createOrderApp.post('/', async (req, res) => …)`) → `createOrderApp.post`
      const registered = parent && parent.type === 'CallExpression' && parent.callee.type === 'MemberExpression' && parent.callee.object.type === 'Identifier' && !parent.callee.computed && parent.arguments.includes(node)
        ? `${parent.callee.object.name}.${parent.callee.property.name}` : null;
      name = (node.id && node.id.name) || (parent && parent.type === 'VariableDeclarator' && parent.id.name) || (parent && parent.type === 'Property' && parent.key && (parent.key.name || parent.key.value)) || (parent && parent.type === 'MethodDefinition' && parent.key.name) || (parent && parent.type === 'AssignmentExpression' && parent.left.type === 'MemberExpression' && parent.left.property && parent.left.property.name) || (exportOfCall && fn === '<top>' ? exportOfCall : null) || (registered && fn === '<top>' ? registered : null) || `${fn}>anon`;
    }
    visit(node, name, parent);
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => rec(c, name, node, parent)); else if (v && typeof v === 'object' && typeof v.type === 'string') rec(v, name, node, parent);
    }
  })(ast, '<top>', null, null);
}

const propName = (m) => (m.computed ? (m.property.type === 'Literal' && typeof m.property.value === 'string' ? m.property.value : null) : m.property.name);
// a projection's value must be DIRECTLY derived from ONE field read: the read itself, or one simple wrapping of it —
// f(o.x) with that single argument, o.x || d / o.x ?? d / c ? o.x : d, `${o.x}` (one expression), String(o.x)
function directField(v, al) {
  if (!v) return null;
  if (v.type === 'MemberExpression') {
    const f = propName(v);
    if (f) return FIELDS.has(f) ? f : (al.has(f) ? al.get(f) : null);
    if (v.computed) return directField(v.property, al);   // a lookup table keyed by the read: STATUS_MAP[o.status]
    return null;
  }
  if (v.type === 'CallExpression' && v.arguments.length === 1) return directField(v.arguments[0], al);
  if (v.type === 'LogicalExpression') return directField(v.left, al);
  if (v.type === 'ConditionalExpression') return directField(v.consequent, al) || directField(v.alternate, al);
  if (v.type === 'TemplateLiteral' && v.expressions.length === 1) return directField(v.expressions[0], al);
  return null;
}
// projection scope: a page's inline scripts + local modules share one scope; a functions file is its own scope
const scopeOf = (u) => (u.kind === 'fn' ? u.file : u.scope);

// a path expression → its static shape: literals kept, every dynamic part '*' (null = not a path we can see)
function staticPath(n) {
  if (!n) return null;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral') return n.quasis.map((q, i) => q.value.cooked + (i < n.expressions.length ? '*' : '')).join('');
  if (n.type === 'BinaryExpression' && n.operator === '+') { const a = staticPath(n.left); const b = staticPath(n.right); return (a === null ? '*' : a) + (b === null ? '*' : b); }
  return null;
}
const normPath = (p) => String(p).replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
const WRITE_METHODS = new Set(['set', 'update', 'push', 'setWithPriority', 'transaction']);
// send boundaries (the server-side readers): callee name → R-site
const SEND = { sendMessage: 'R9', sendScheduledSlotClosed: 'R9', sendPaidAfterCloseRefund: 'R9', sendDriverPush: 'R5', sendStaffPush: 'R6', batchUpdate: 'R12', append: 'R12' };

function census({ explicit = [], extraUnits = [] } = {}) {
  const units = [...sources(), ...extraUnits];
  const parsed = units.map((u) => ({ u, ast: parseUnit(u) }));
  // ── projections, per scope, fixpoint ≤ 3 ──
  const aliases = new Map();   // scope → Map(alias → field)
  const projections = [];
  for (const e of explicit) {   // §3a explicit links (census-map.json) — seeded before the fixpoint
    const al = aliases.get(e.scope) || new Map(); aliases.set(e.scope, al); al.set(e.alias, e.field);
    projections.push({ scope: e.scope, file: '(explicit)', alias: e.alias, field: e.field, line: 0, round: 0, explicit: true });
  }
  let round = 0; let grew = true;
  while (grew) {
    round += 1; grew = false;
    for (const { u, ast } of parsed) {
      const sc = scopeOf(u);
      const al = aliases.get(sc) || new Map(); aliases.set(sc, al);
      walk(ast, (node) => {
        if (node.type !== 'Property' || node.computed) return;
        const alias = node.key && (node.key.name || node.key.value);
        if (!alias || FIELDS.has(alias) || al.has(alias)) return;
        const src = directField(node.value, al);
        if (src && /^[A-Za-z_$][\w$]*$/.test(alias) && alias.length > 2) {
          al.set(alias, src); grew = true;
          projections.push({ scope: sc, file: u.file, alias, field: src, line: node.loc.start.line + u.lineOffset, round });
        }
      });
    }
    if (round >= 3 && grew) {
      const last = projections.filter((p) => p.round === 3).slice(0, 10);
      throw new Error(`census: projection propagation still growing at depth 3 (${last.map((p) => `${p.scope}:${p.alias}←${p.field}`).join(', ')}) — map explicitly (§3a)`);
    }
    if (round >= 3) break;
  }
  // ── sites ──
  const sites = []; const opaque = []; const counters = new Map();
  for (const { u, ast } of parsed) {
    const al = aliases.get(scopeOf(u)) || new Map();
    const add = (fn, field, viaAlias, node, kind) => {
      const k = `${u.file}#${fn}#${field}`; const ord = counters.get(k) || 0; counters.set(k, ord + 1);
      sites.push({ id: `${k}#${ord}`, file: u.file, scope: u.scope, fn, field, ...(viaAlias ? { alias: viaAlias } : {}), kind, line: node.loc.start.line + u.lineOffset, facts: FIELD_FACTS[field], _pos: node.start });
    };
    walk(ast, (node, fn, parent) => {
      if (node.type === 'MemberExpression') {
        if (parent && parent.type === 'AssignmentExpression' && parent.left === node) return;   // a write, not a read
        const f = propName(node);
        if (f && FIELDS.has(f)) add(fn, f, null, node, node.computed ? 'computed' : 'member');
        else if (f && al.has(f)) add(fn, al.get(f), f, node, 'projection');
        else if (node.computed && !f && node.object.type === 'Identifier' && ORDERISH.test(node.object.name) && node.property.type !== 'NumericLiteral' && !(node.property.type === 'Literal' && typeof node.property.value === 'number')) {
          opaque.push({ file: u.file, fn, base: node.object.name, line: node.loc.start.line + u.lineOffset, how: 'computed' });
        }
      }
      if (node.type === 'ObjectPattern') {
        for (const p of node.properties) {
          if (p.type !== 'Property' || p.computed) continue;
          const f = p.key && (p.key.name || p.key.value);
          if (f && FIELDS.has(f)) add(fn, f, null, p, 'destructure');
          else if (f && al.has(f)) add(fn, al.get(f), f, p, 'projection-destructure');
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && node.callee.object.name === 'Object'
          && ['entries', 'keys', 'values', 'assign'].includes(node.callee.property.name)) {
        for (const a of node.arguments) if (a && a.type === 'Identifier' && ORDERISH.test(a.name)) opaque.push({ file: u.file, fn, base: a.name, line: node.loc.start.line + u.lineOffset, how: `Object.${node.callee.property.name}` });
      }
      // codex r1 P1-1: a SPREAD of an order value ({...order}) reads every field — opaque, needs a mapping
      if (node.type === 'SpreadElement' && node.argument.type === 'Identifier' && ORDERISH.test(node.argument.name)) {
        opaque.push({ file: u.file, fn, base: node.argument.name, line: node.loc.start.line + u.lineOffset, how: 'spread' });
      }
    });
  }
  const sentinel0 = [];
  // ── WRITE INVENTORY (codex r1 P1-1): every field written onto orders/<id>, from AST ──────────────────────────────────
  // sources: ref(...)/child(...) chains (through same-file variables) + set/update/push; multipath update keys;
  // `updates[`orders/${id}…`] = …` assignments; template / concatenated paths; one-hop object literals and
  // same-name builder returns. A spread or a non-static key in an order write is an OPAQUE WRITE (needs a decision).
  const writes = []; const opaqueWrites = [];
  const fnUnits = parsed.filter((x) => x.u.kind === 'fn');
  const returnsByName = new Map();
  const NODE_CODE = new WeakMap();   // node → its unit's source (a builder's object can live in another file)
  for (const { u, ast } of fnUnits) walk(ast, (node) => { NODE_CODE.set(node, u.code); });
  for (const { ast } of fnUnits) {
    // a function's returned object(s): `return {…}`, or `return x` where x is a same-function object literal
    const localObj = new Map();
    walk(ast, (node, fn) => { if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && node.init.type === 'ObjectExpression') localObj.set(`${fn}::${node.id.name}`, node.init); });
    walk(ast, (node, fn) => {
      if (node.type !== 'ReturnStatement' || !node.argument) return;
      const o = node.argument.type === 'ObjectExpression' ? node.argument : (node.argument.type === 'Identifier' ? localObj.get(`${fn}::${node.argument.name}`) : null);
      if (o) { const l = returnsByName.get(fn) || []; l.push(o); returnsByName.set(fn, l); }
    });
  }
  for (const { u, ast } of fnUnits) {
    const inits = new Map();
    walk(ast, (node) => { if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) { const l = inits.get(node.id.name) || []; l.push(node.init); inits.set(node.id.name, l); } });
    const refPathOf = (n, depth = 0) => {
      if (!n || depth > 4) return null;
      if (n.type === 'Identifier') { for (const i of inits.get(n.name) || []) { const r = refPathOf(i, depth + 1); if (r !== null) return r; } return null; }
      if (n.type === 'AwaitExpression') return refPathOf(n.argument, depth + 1);
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed) {
        const m = n.callee.property.name;
        if (m === 'ref') return n.arguments.length ? (staticPath(n.arguments[0]) === null ? null : normPath(staticPath(n.arguments[0]))) : '';
        if (m === 'child') { const b = refPathOf(n.callee.object, depth + 1); const c = staticPath(n.arguments[0]); return b === null ? null : normPath(`${b}/${c === null ? '*' : c}`); }   // a dynamic child(id) is a '*' segment
      }
      return null;
    };
    const objOf = (n, depth = 0) => {
      if (!n || depth > 3) return [];
      if (n.type === 'ObjectExpression') return [n];
      if (n.type === 'Identifier') return (inits.get(n.name) || []).flatMap((i) => objOf(i, depth + 1));
      if (n.type === 'AwaitExpression') return objOf(n.argument, depth + 1);
      if (n.type === 'ConditionalExpression') return [...objOf(n.consequent, depth + 1), ...objOf(n.alternate, depth + 1)];
      if (n.type === 'LogicalExpression') return [...objOf(n.left, depth + 1), ...objOf(n.right, depth + 1)];
      if (n.type === 'CallExpression') { const nm = n.callee.type === 'Identifier' ? n.callee.name : (n.callee.type === 'MemberExpression' && !n.callee.computed ? n.callee.property.name : null); return nm ? (returnsByName.get(nm) || []) : []; }
      return [];
    };
    // attributed to the WRITE CALL / assignment being analysed (a builder's object may live in another file)
    let AT = null;
    const record = (fn, field, how, node) => writes.push({ file: u.file, fn, field, how, line: (AT || node).loc.start.line });
    const opaqueW = (fn, how, node, detail) => opaqueWrites.push({ file: u.file, fn, how, line: (AT || node).loc.start.line, ...(detail ? { detail } : {}) });
    const objFields = (fn, objs, node, how) => {
      for (const o of objs) for (const p of o.properties) {
        if (p.type === 'SpreadElement') {   // resolved where it can be: a literal, a conditional branch, a variable, a builder's return
          const inner = objOf(p.argument);
          if (inner.length) objFields(fn, inner, p, `${how}/spread`); else opaqueW(fn, 'spread-in-order-write', p, p.argument.type === 'Identifier' ? p.argument.name : u.code.slice(p.argument.start, p.argument.end).slice(0, 60));
          continue;
        }
        if (p.computed) { const sp = staticPath(p.key); if (sp && !sp.includes('*') && !sp.includes('/')) record(fn, sp, how, p); else if (sp && sp.includes('/')) pathWrite(fn, sp, p.value, p, `${how}/multipath`); else opaqueW(fn, 'computed-key-in-order-write', p); continue; }
        const k = p.key && (p.key.name || p.key.value); if (typeof k === 'string') record(fn, k, how, p);
      }
    };
    // a write at a full path: orders → nothing; orders/<id> → the value object's keys; orders/<id>/<f>… → f
    // the value expression's source — binds an opaque-write RESOLUTION to its exact write site (codex r2 P1-1)
    const srcOf = (n) => (n ? (NODE_CODE.get(n) || u.code).slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 80) : '');
    function pathWrite(fn, full, value, node, how, depth = 0) {
      const p = normPath(full); const segs = p === '' ? [] : p.split('/');
      // codex r2 P1-1: a write ABOVE an order (the root, or /orders itself) is an order write too — descend its object
      if (segs.length === 0 || (segs[0] === 'orders' && segs.length === 1)) {
        if (depth > 3) return;
        const objs = objOf(value);
        // codex r3 P1-1: an UNRESOLVED payload at the root or /orders can carry any order field → opaque (RED unless bound)
        if (!objs.length) { opaqueW(fn, segs.length === 0 ? 'unresolved-root-write' : 'write-above-orders', node, `${p || '/'}: ${srcOf(value)}`); return; }
        // codex r4 P1-1: spreads are followed RECURSIVELY (a spread of a spread of …) — an unresolved spread or a
        // non-static key at ANY depth under the root / orders is opaque
        const above = (props, sd, h) => {
          for (const q of props) {
            if (q.type === 'SpreadElement') {
              const inner = sd < 6 ? objOf(q.argument) : [];
              if (!inner.length) { opaqueW(fn, segs.length === 0 ? 'spread-at-root' : 'spread-above-orders', q, srcOf(q.argument)); continue; }
              above(inner.flatMap((o) => o.properties), sd + 1, `${h}/spread`);
              continue;
            }
            const k = q.computed ? staticPath(q.key) : (q.key && (q.key.name || q.key.value));
            if (k === null || k === undefined) { opaqueW(fn, segs.length === 0 ? 'computed-key-at-root' : 'computed-key-above-orders', q, srcOf(q.key)); continue; }
            if (segs.length === 0 && !String(k).startsWith('orders')) continue;      // a root write of another tree
            pathWrite(fn, `${p}/${k}`, q.value, q, h, depth + 1);
          }
        };
        above(objs.flatMap((o) => o.properties), 0, `${how}/above`);
        return;
      }
      if (segs[0] !== 'orders') return;
      if (segs.length === 2) { const objs = objOf(value); if (objs.length) objFields(fn, objs, node, how); else opaqueW(fn, 'opaque-order-object', node, srcOf(value)); return; }
      if (segs[2] === '*' || segs[2] === '') opaqueW(fn, 'dynamic-field-segment', node, full); else record(fn, segs[2], how, node);
    }
    walk(ast, (node, fn) => {
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && WRITE_METHODS.has(node.callee.property.name)) {
        AT = node;
        const base = refPathOf(node.callee.object);
        if (base === null) return;
        const m = node.callee.property.name; const v = node.arguments[0];
        const updObjs = m === 'update' && v ? (v.type === 'ObjectExpression' ? [v] : objOf(v)) : [];
        if (m === 'update' && updObjs.length) {
          // codex r4 P1-1: ONE recursive rule for every depth — a spread (conditional / variable / literal / builder) is
          // resolved through its object(s) and its keys are paths under base; an unresolved spread or a non-static key
          // at ANY depth under the root or /orders is an opaque write (RED unless bound), never skipped
          const nb = normPath(base); const guarded = nb === '' || nb.startsWith('orders');
          const upd = (props, sd, how) => {
            for (const p of props) {
              if (p.type === 'SpreadElement') {
                const inner = sd < 6 ? objOf(p.argument) : [];
                if (inner.length) upd(inner.flatMap((o) => o.properties), sd + 1, 'update/spread');
                else if (guarded) opaqueW(fn, nb === '' ? 'spread-at-root' : 'spread-in-order-write', p, srcOf(p.argument));
                continue;
              }
              const key = p.computed ? staticPath(p.key) : (p.key && (p.key.name || p.key.value));
              if (key === null || key === undefined) { if (guarded) opaqueW(fn, nb === '' ? 'computed-key-at-root' : 'computed-key-in-order-write', p, srcOf(p.key)); continue; }
              pathWrite(fn, `${base}/${key}`, p.value, p, how);
            }
          };
          upd(updObjs.flatMap((o) => o.properties), 0, 'update');
          return;
        }
        if (m === 'transaction') {
          if (normPath(base).split('/')[0] !== 'orders') return;
          const segs = normPath(base).split('/');
          if (segs.length >= 3 && segs[2] !== '*') { record(fn, segs[2], 'transaction', node); return; }
          // the updater on the ORDER node: its new fields = object-literal keys built from the current value (a spread of
          // the param / a local copy is the existing order, not new fields) + `x.f = …` assignments on the param or a local
          const upd = v && /Function/.test(v.type) ? v : null;
          if (!upd) { opaqueW(fn, 'transaction-on-order', node, base); return; }
          // an updater that DELEGATES (`(cur) => C.claimDecision(cur, …)`): the helper's returned object(s)
          const delegate = upd.body.type === 'CallExpression' ? upd.body : null;
          if (delegate) {
            const nm = delegate.callee.type === 'Identifier' ? delegate.callee.name : (delegate.callee.type === 'MemberExpression' && !delegate.callee.computed ? delegate.callee.property.name : null);
            const objs = nm ? (returnsByName.get(nm) || []) : [];
            let n2 = 0;
            for (const o of objs) for (const q of o.properties) { if (q.type === 'SpreadElement' || q.computed) continue; const k = q.key && (q.key.name || q.key.value); if (typeof k === 'string') { record(fn, k, `transaction-delegate:${nm}`, q); n2 += 1; } }
            if (!n2) opaqueW(fn, 'transaction-on-order', node, `delegates to ${nm}`);
            return;
          }
          const param = upd.params[0] && upd.params[0].type === 'Identifier' ? upd.params[0].name : null;
          const locals = new Set(param ? [param] : []); let found = 0;
          walk(upd.body, (x) => {
            if (x.type === 'VariableDeclarator' && x.id.type === 'Identifier' && x.init && x.init.type === 'ObjectExpression') locals.add(x.id.name);
            if (x.type === 'ObjectExpression') for (const q of x.properties) { if (q.type === 'SpreadElement' || q.computed) continue; const k = q.key && (q.key.name || q.key.value); if (typeof k === 'string') { record(fn, k, 'transaction-updater', q); found += 1; } }
          });
          walk(upd.body, (x) => {
            if (x.type === 'AssignmentExpression' && x.left.type === 'MemberExpression' && !x.left.computed && x.left.object.type === 'Identifier' && locals.has(x.left.object.name)) { record(fn, x.left.property.name, 'transaction-updater', x); found += 1; }
          });
          if (!found) opaqueW(fn, 'transaction-on-order', node, base);
          return;
        }
        pathWrite(fn, m === 'push' ? `${base}/*` : base, v, node, m);
      }
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && node.left.computed) {
        AT = node;
        const key = staticPath(node.left.property);
        if (key && normPath(key).startsWith('orders/')) pathWrite(fn, key, node.right, node, 'multipath-assign');
      }
    });
  }
  for (const w of writes) if (SENTINEL.test(w.field)) sentinel0.push({ file: w.file, fn: w.fn, key: w.field, line: w.line, how: `write:${w.how}` });

  // ── SEND-BOUNDARY marking (codex r1 P1-2): a read that feeds a send call is a READER site ──────────────────────────
  for (const { u, ast } of fnUnits) {
    const ranges = []; const fnRanges = new Map(); const initsByFn = new Map();
    walk(ast, (node, fn, parent) => {
      if (/Function/.test(node.type)) { const nm = (node.id && node.id.name) || (parent && parent.type === 'VariableDeclarator' && parent.id.name); if (nm) fnRanges.set(nm, [node.start, node.end]); }
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) { const k = `${fn}::${node.id.name}`; (initsByFn.get(k) || initsByFn.set(k, []).get(k)).push([node.init.start, node.init.end]); }
      if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') { const k = `${fn}::${node.left.name}`; (initsByFn.get(k) || initsByFn.set(k, []).get(k)).push([node.right.start, node.right.end]); }
    });
    walk(ast, (node, fn) => {
      if (node.type !== 'CallExpression') return;
      const nm = node.callee.type === 'Identifier' ? node.callee.name : (node.callee.type === 'MemberExpression' && !node.callee.computed ? node.callee.property.name : null);
      const R = nm && SEND[nm];
      if (!R) return;
      if ((nm === 'append' || nm === 'batchUpdate') && !/sheets|values/.test(u.code.slice(node.callee.start, node.callee.end))) return;
      for (const a of node.arguments) {
        ranges.push([a.start, a.end, R]);
        walk(a, (x) => {
          if (x.type === 'Identifier') for (const r of initsByFn.get(`${fn}::${x.name}`) || []) ranges.push([r[0], r[1], R]);
          if (x.type === 'CallExpression' && x.callee.type === 'Identifier' && fnRanges.has(x.callee.name)) { const r = fnRanges.get(x.callee.name); ranges.push([r[0], r[1], R]); }
        });
      }
    });
    for (const s of sites) if (s.file === u.file && s._pos !== undefined) { const hit = ranges.find((r) => s._pos >= r[0] && s._pos < r[1]); if (hit) s.send = hit[2]; }
  }
  for (const s of sites) delete s._pos;

  // ── write sentinel + timers + clocks (functions only) ──
  const sentinel = sentinel0; const timers = []; const clocks = [];
  for (const { u, ast } of parsed.filter((x) => x.u.kind === 'fn')) {
    walk(ast, (node, fn, parent) => {
      if (node.type === 'Property' && !node.computed) { const k = node.key && (node.key.name || node.key.value); if (typeof k === 'string' && SENTINEL.test(k)) sentinel.push({ file: u.file, fn, key: k, line: node.loc.start.line, how: 'object-key' }); }
      { const sp = (node.type === 'Literal' && typeof node.value === 'string') || node.type === 'TemplateLiteral' ? staticPath(node) : null;   // literal AND template paths
        const m = sp && /orders\/[^/]+\/([A-Za-z0-9_]+)$/.exec(sp); if (m && SENTINEL.test(m[1])) sentinel.push({ file: u.file, fn, key: m[1], line: node.loc.start.line, how: 'path' }); }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && ['setTimeout', 'setInterval', 'sleep'].includes(node.callee.name)) {
        const delay = node.callee.name === 'sleep' ? node.arguments[0] : node.arguments[1];
        const dsrc = delay ? u.code.slice(delay.start, delay.end).slice(0, 60) : '';
        const cls = node.callee.name === 'sleep' ? 'application-sleep'
          : /deadline|timeout|Deadline|Timeout|DEADLINE|TIMEOUT/.test(`${fn} ${dsrc}`) ? 'io-deadline' : 'sdk-or-other';
        timers.push({ file: u.file, fn, call: node.callee.name, delay: dsrc, line: node.loc.start.line, proposed: cls });
      }
      const isNow = node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.name === 'Date' && node.callee.property.name === 'now';
      const isNewDate = node.type === 'NewExpression' && node.callee.name === 'Date';
      const isTs = node.type === 'MemberExpression' && !node.computed && node.property.name === 'TIMESTAMP';
      if (isNow || isNewDate || isTs) {
        let cls = 'unclassified';
        if (isTs) cls = 'persisted-stamp';
        else if (parent && parent.type === 'BinaryExpression' && ['<', '>', '<=', '>=', '-'].includes(parent.operator)) cls = /ttl|Ttl|TTL|cache|Cache/.test(u.code.slice(parent.start, parent.end)) ? 'cache-ttl' : (/deadline|Deadline|timeout|Timeout/.test(u.code.slice(parent.start, parent.end)) ? 'io-deadline' : 'business-comparison');
        else if (parent && parent.type === 'Property' && /(_at|_until|_ms|deadline|timestamp|ts)$/i.test(String(parent.key && (parent.key.name || parent.key.value)))) cls = 'persisted-stamp';
        else if (isNewDate) cls = 'display';
        else if (parent && parent.type === 'VariableDeclarator') cls = 'business-sample';   // `const now = Date.now()`: a real-time sample (§6a: real)
        if (cls === 'unclassified' && isNow) cls = 'business-sample';   // default rule: a real-time sample passed on (§6a: real) — reviewed in census-map
        clocks.push({ file: u.file, fn, what: isTs ? 'ServerValue.TIMESTAMP' : (isNow ? 'Date.now()' : 'new Date()'), line: node.loc.start.line, proposed: cls });
      }
    });
  }
  return { units: units.length, sites, opaque, projections, sentinel, timers, clocks, writes, opaqueWrites };
}

module.exports = { census, FIELD_FACTS, READER_DIRS, sources };

if (require.main === module) {
  const c = census();
  const counts = { units: c.units, sites: c.sites.length, opaque: c.opaque.length, projections: c.projections.length, sentinel: c.sentinel.length, timers: c.timers.length, clocks: c.clocks.length };
  console.log(JSON.stringify(counts));
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(__dirname, 'census.raw.json'), JSON.stringify(c, null, 1) + '\n');
    console.log('wrote contract/census.raw.json');
  }
}
