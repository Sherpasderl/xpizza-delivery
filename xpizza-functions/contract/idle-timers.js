'use strict';
/* R3 §5a — THE IDLE-TIMER ALLOWLIST, BOUND TO REVIEWED SOURCE (codex r4 P1-2).
 *
 * contract/idle-timers.json lists, per page dir, the periodic timers a page may leave pending while it counts as SETTLED.
 * An entry is NOT a name: it binds the reviewed BEHAVIOUR —
 *   · kind (interval | timeout), the delay (the literal or a resolved `const`), and the call site (enclosing function);
 *   · cbHash      = sha256 of the callback's FULL whitespace-normalized source (what String(fn) yields at runtime);
 *   · closureHash = sha256 over every page function the callback can reach by name (its static call / reference
 *                   closure across the page's scripts), so a changed HELPER voids the exemption too.
 * The page harness exempts a timer only when (kind, delay, cbHash) match an entry whose closureHash still equals the
 * current source; any change → NOT exempt (it blocks settling) and the static guard (idle-timers.guard.test.js) is RED
 * until the entry is re-reviewed (node contract/idle-timers.js --print <dir> shows the current bindings).
 *   · effects     = the RTDB / Firestore writes (the SDK's write functions under any local alias), fetch() and
 *                   sendBeacon() its EXECUTION closure (calls, method calls, iteration / promise callbacks) reaches; an
 *                   idle entry must have none (the guard requires effects == [] — "display-only" is checked, not asserted).
 * THE STATIC BINDING IS NOT THE LAST LINE (codex r5 P1-1): static analysis can be outrun (a reassigned helper, an object
 * method, a dynamic property, an event). contract/page-harness.js therefore ENFORCES at runtime: every SDK write / fetch /
 * sendBeacon / XHR send made while code runs on behalf of an idle-exempt callback (its continuations, the timers / frames it
 * schedules, the events it dispatches) fails the run, and settle() exercises every live exempt tick before it can certify
 * "settled". An exemption can only make a test fail.
 * The closure follows names (calls / references) resolved to page or page-module functions, and method CALLS `NS.fn()`
 * on a namespace import of the page's own module (`import * as XPD from './xpizza-delivery.js'`). A method call on any
 * other object (`el.classList.remove()`, `SherpaClient.fetch()`) is not followed — stated limit.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const acorn = require('acorn');

const REPO = path.join(__dirname, '..', '..');
const FILE = path.join(__dirname, 'idle-timers.json');
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

function parse(code) {
  for (const sourceType of ['script', 'module']) {
    try { return acorn.parse(code, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowReturnOutsideFunction: true, locations: true }); } catch (_) { /* next */ }
  }
  return null;
}

// the page's program: index.html's inline + local scripts, and the local modules they import (as the harness runs them)
// overrides: { '<repo-relative file>': code } — an in-memory edit (the guard's negatives), never written to disk
function pageProgram(dir, overrides = {}) {
  const pageDir = path.join(REPO, dir);
  const read = (abs) => { const r = path.relative(REPO, abs); return r in overrides ? overrides[r] : fs.readFileSync(abs, 'utf8'); };
  const html = read(path.join(pageDir, 'index.html'));
  const units = []; const seen = new Set();
  const addFile = (abs) => {
    if (seen.has(abs) || !fs.existsSync(abs)) return; seen.add(abs);
    const code = read(abs); add(path.relative(REPO, abs), code, path.dirname(abs));
  };
  const add = (file, code, base) => {
    const ast = parse(code); if (!ast) return;
    units.push({ file, code, ast });
    for (const n of ast.body) if ((n.type === 'ImportDeclaration' || n.type === 'ExportNamedDeclaration' || n.type === 'ExportAllDeclaration') && n.source && /^\.\.?\//.test(n.source.value)) addFile(path.resolve(base, n.source.value.split('?')[0]));
  };
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m; let i = 0;
  while ((m = re.exec(html))) {
    const attrs = m[1]; const src = /\bsrc\s*=\s*["']([^"']+)["']/.exec(attrs); const type = /\btype\s*=\s*["']([^"']+)["']/.exec(attrs);
    if (type && !/module|javascript/.test(type[1])) continue;
    if (src) { if (!/^https?:|^\/\//.test(src[1])) addFile(path.resolve(pageDir, src[1].split('?')[0])); continue; }
    add(`${dir}/index.html#script${i++}`, m[2], pageDir);
  }
  return units;
}

function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parents);
  const ps = parents.concat(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    const v = node[k];
    if (Array.isArray(v)) for (const c of v) walk(c, visit, ps); else if (v && typeof v.type === 'string') walk(v, visit, ps);
  }
}

// page-level named functions: name → [{ src (normalized), node, unit }]
function functionTable(units) {
  const t = new Map();
  const put = (name, node, unit) => { if (!t.has(name)) t.set(name, []); t.get(name).push({ node, unit, src: norm(unit.code.slice(node.start, node.end)) }); };
  for (const u of units) walk(u.ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) put(n.id.name, n, u);
    else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && /Function/.test(n.init.type)) put(n.id.name, n.init, u);
  });
  return t;
}

// a WRITE / network effect inside a function: a modular RTDB / Firestore write (set(ref…), update, push, remove,
// runTransaction, setDoc / updateDoc / addDoc / deleteDoc), a namespaced ref write (x.ref(…).set / db.ref().update / a
// *Ref.set …), fetch() or navigator.sendBeacon(). A bare call resolving to a PAGE function of that name (a sessionStorage
// `remove`, a local `push`) is that function — followed through the closure — not the SDK's.
const WRITE_FN = new Set(['set', 'update', 'push', 'remove', 'runTransaction', 'setDoc', 'updateDoc', 'addDoc', 'deleteDoc', 'setWithPriority', 'fetch']);
const ITER = new Set(['forEach', 'map', 'filter', 'some', 'every', 'reduce', 'find', 'findIndex', 'flatMap', 'sort', 'then', 'catch', 'finally']);
const WRITE_M = new Set(['set', 'update', 'push', 'remove', 'transaction', 'setWithPriority', 'sendBeacon']);
// walk what RUNNING `node` executes: a nested function is entered only when it runs inline — an iteration / promise
// callback, an IIFE, a `new Promise` executor. A function only DEFINED there (an event handler, a menu action, a timer
// callback — tracked as its own timer) does not run with it.
function walkExec(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  if (parents.length && /Function/.test(node.type)) {
    const par = parents[parents.length - 1];
    const inline = par && ((par.type === 'CallExpression' && (par.callee === node || (par.arguments.includes(node) && par.callee.type === 'MemberExpression' && !par.callee.computed && ITER.has(par.callee.property.name))))
      || (par.type === 'NewExpression' && par.callee.type === 'Identifier' && par.callee.name === 'Promise'));
    if (!inline) return;
  }
  visit(node, parents);
  const ps = parents.concat(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    const v = node[k];
    if (Array.isArray(v)) for (const c of v) walkExec(c, visit, ps); else if (v && typeof v.type === 'string') walkExec(v, visit, ps);
  }
}

function effectsIn(node, unit, table, sdkWrites) {
  const out = [];
  walkExec(node, (n) => {
    if (n.type !== 'CallExpression') return;
    const c = n.callee;
    if (c.type === 'Identifier' && sdkWrites.has(c.name)) out.push(`${c.name}() [SDK write] @${unit.file}:${n.loc.start.line}`);
    else if (c.type === 'Identifier' && WRITE_FN.has(c.name) && !table.has(c.name)) out.push(`${c.name}() @${unit.file}:${n.loc.start.line}`);
    else if (c.type === 'MemberExpression' && !c.computed && WRITE_M.has(c.property.name)) {
      const o = c.object; const os = unit.code.slice(o.start, o.end);
      if (c.property.name === 'sendBeacon' || /\bref\b|Ref\b|\.child\(|\bref\(/.test(os)) out.push(`${os.slice(0, 40)}.${c.property.name}() @${unit.file}:${n.loc.start.line}`);
    }
  });
  return out;
}

// module NAMESPACE imports of the page's own modules (`import * as XPD from './xpizza-delivery.js'`): `XPD.fn()` is fn
function nsLocalsOf(units) {
  const out = new Set();
  for (const u of units) for (const n of u.ast.body) if (n.type === 'ImportDeclaration' && /^\.\.?\//.test(n.source.value)) for (const sp of n.specifiers) if (sp.type === 'ImportNamespaceSpecifier') out.add(sp.local.name);
  return out;
}

// the SDK's write functions under their LOCAL names (`import { update as fbUpdate } from '…/firebase-database.js'`)
function sdkWritesOf(units) {
  const out = new Set();
  for (const u of units) for (const n of u.ast.body) {
    if (n.type !== 'ImportDeclaration' || !/firebasejs|firebase\//.test(n.source.value)) continue;
    for (const sp of n.specifiers) if (sp.type === 'ImportSpecifier' && WRITE_FN.has(sp.imported.name)) out.add(sp.local.name);
  }
  return out;
}

// the EXECUTION closure (what running the callback can execute): direct calls, method calls `X.fn()`, and functions handed
// to an array iteration / promise continuation. A function merely REFERENCED (an event handler wired up) is not executed
// by the tick — it is in the HASH closure (any change re-reviews) but not in the effects scan.
function execClosure(node, unit, table, sdkWrites, nsLocals) {
  const names = new Set(); const queue = [{ node, unit, chain: '' }]; const effects = [];
  while (queue.length) {
    const { node: n0, unit: u0, chain } = queue.shift();
    effects.push(...effectsIn(n0, u0, table, sdkWrites).map((e) => (chain ? `${e} via ${chain}` : e)));
    walkExec(n0, (n, ps) => {
      if (n.type !== 'Identifier' || !table.has(n.name) || names.has(n.name)) return;
      const par = ps[ps.length - 1]; const gp = ps[ps.length - 2];
      const called = par && par.type === 'CallExpression' && par.callee === n;
      const methodCalled = par && par.type === 'MemberExpression' && par.property === n && !par.computed && gp && gp.type === 'CallExpression' && gp.callee === par && par.object.type === 'Identifier' && nsLocals.has(par.object.name);
      const iterArg = par && par.type === 'CallExpression' && par.arguments.includes(n) && par.callee.type === 'MemberExpression' && !par.callee.computed && ITER.has(par.callee.property.name);
      if (!called && !methodCalled && !iterArg) return;
      names.add(n.name);
      for (const d of table.get(n.name)) queue.push({ node: d.node, unit: d.unit, chain: chain ? `${chain} > ${n.name}` : n.name });
    });
  }
  return { names: [...names].sort(), effects: [...new Set(effects)].sort() };
}

function closureOf(node, unit, table, nsLocals) {
  const names = new Set(); const queue = [{ node, unit }];
  while (queue.length) {
    const { node: n0, unit: u0 } = queue.shift();
    walk(n0, (n, ps) => {
      if (n.type !== 'Identifier' || !table.has(n.name) || names.has(n.name)) return;
      const par = ps[ps.length - 1]; const gp = ps[ps.length - 2];
      // a property NAME (x.key / { key: … }) is not a reference — EXCEPT a method CALL `X.fn(…)` whose name is a page /
      // module function (e.g. XPD.setOrderStatus from xpizza-delivery.js): followed, over-including rather than missing
      const memberProp = par && par.type === 'MemberExpression' && par.property === n && !par.computed;
      if (memberProp && !(gp && gp.type === 'CallExpression' && gp.callee === par && par.object.type === 'Identifier' && nsLocals.has(par.object.name))) return;
      if (par && (par.type === 'Property' || par.type === 'MethodDefinition' || par.type === 'PropertyDefinition') && par.key === n && !par.computed) return;
      names.add(n.name);
      for (const d of table.get(n.name)) queue.push({ node: d.node, unit: d.unit });
    });
  }
  const parts = [...names].sort().map((nm) => `${nm}:${table.get(nm).map((d) => d.src).join('\u0001')}`);
  return { names: [...names].sort(), hash: sha(parts.join('\u0000')) };
}

// every setInterval / setTimeout call site of the page, with its binding
function timerSites(dir, { overrides } = {}) {
  const units = pageProgram(dir, overrides); const table = functionTable(units); const sdkWrites = sdkWritesOf(units); const nsLocals = nsLocalsOf(units); const out = [];
  const consts = new Map();
  for (const u of units) walk(u.ast, (n) => { if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && n.init.type === 'Literal' && typeof n.init.value === 'number') consts.set(n.id.name, n.init.value); });
  for (const u of units) walk(u.ast, (n, parents) => {
    if (n.type !== 'CallExpression') return;
    const c = n.callee; const name = c.type === 'Identifier' ? c.name : (c.type === 'MemberExpression' && !c.computed && /^(window|globalThis|self)$/.test(c.object.name || '') ? c.property.name : null);
    if (name !== 'setInterval' && name !== 'setTimeout') return;
    const cb = n.arguments[0]; const d = n.arguments[1];
    if (!cb) return;
    let cbNode = cb; let cbUnit = u;
    if (cb.type === 'Identifier') { const decl = (table.get(cb.name) || [])[0]; if (!decl) return; cbNode = decl.node; cbUnit = decl.unit; }
    else if (!/Function/.test(cb.type)) return;
    const delay = !d ? 0 : d.type === 'Literal' ? d.value : d.type === 'Identifier' && consts.has(d.name) ? consts.get(d.name) : null;
    const encl = [...parents].reverse().find((p) => (p.type === 'FunctionDeclaration' && p.id) || (p.type === 'VariableDeclarator' && p.init && /Function/.test(p.init.type)));
    const site = encl ? (encl.id && encl.id.name) || '<fn>' : '<top>';
    const cbSrc = norm(cbUnit.code.slice(cbNode.start, cbNode.end));
    const cl = closureOf(cbNode, cbUnit, table, nsLocals); const ex = execClosure(cbNode, cbUnit, table, sdkWrites, nsLocals);
    out.push({ kind: name === 'setInterval' ? 'interval' : 'timeout', delay, site, file: u.file, line: n.loc.start.line, cbHash: sha(cbSrc), closureHash: cl.hash, closure: cl.names, executes: ex.names, effects: ex.effects, cb: cbSrc.slice(0, 100) });
  });
  return out;
}

function loadEntries(dir) {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8'))[dir] || []; } catch (_) { return []; }
}

// the entries that are LIVE for this page now: each must match exactly one current timer site on every bound field
function resolveEntries(dir, entries = loadEntries(dir), opts = {}) {
  const sites = timerSites(dir, opts); const active = []; const stale = [];
  for (const e of entries) {
    const hits = sites.filter((s) => s.kind === e.kind && s.delay === e.delay && s.site === e.site && s.cbHash === e.cbHash);
    if (hits.length !== 1) { stale.push({ entry: e, why: hits.length ? `${hits.length} call sites match` : 'no call site with this kind / delay / site / callback source (changed or removed)' }); continue; }
    if (hits[0].closureHash !== e.closureHash) { stale.push({ entry: e, why: `its callback's helper closure changed (${hits[0].closure.join(', ')})` }); continue; }
    active.push(e);
  }
  return { active, stale, sites };
}

module.exports = { timerSites, resolveEntries, loadEntries, sha, norm, FILE };

if (require.main === module) {
  const dir = process.argv[process.argv.indexOf('--print') + 1];
  for (const s of timerSites(dir)) console.log(JSON.stringify(s));
}
