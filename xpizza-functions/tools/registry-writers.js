'use strict';
/* Enumerate every site that WRITES the identity registry, and every entry point that REACHES one —
 * from the source's SYNTAX TREE, never from a list and never from a regex.
 *
 * 🔴 WHY AN AST, AFTER A REGEX VERSION SHIPPED AND WAS WRONG IN BOTH DIRECTIONS. The first version
 * matched text. Review found it counted a write that existed only inside a STRING LITERAL, and missed
 * five legitimate spellings that a reviewer produced in minutes: the receiver form
 * `idsColOf(...).doc(id).set({})`, computed access `tx['set'](ref, …)`, a differently-named
 * transaction argument `transaction.set(ref, …)`, an aliased builder `const { idsColOf: mk } = …`,
 * and arguments split across lines. Every one of those is a real write the fence must cover, and
 * every regex fix would have been another spelling somebody thought of.
 *
 * A parser does not have spellings. `acorn` is already a declared devDependency, so this costs no new
 * dependency: a string is a Literal and can never be a CallExpression, and a call is a call however
 * it is written or wrapped. Same move as putting the cell counter inside the suite's own process —
 * stop pattern-matching the surface, use the structure.
 *
 * THE REGISTRY IS: restaurants/{rid}/identity/{kind}/ids/{id}   and   .../keys/{key}
 * built by idsColOf()/keysColOf() in catalog/identity-registry.js.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.join(__dirname, '..');
const BUILDERS = ['idsColOf', 'keysColOf'];
const WRITE_VERBS = new Set(['set', 'update', 'delete', 'create']);
const ROOTS = [ROOT, path.join(ROOT, '..', 'xpizza-dispatch'), path.join(ROOT, '..', 'xpizza-orders')];

function jsFilesUnder(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) jsFilesUnder(full, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

function parse(src) {
  for (const sourceType of ['script', 'module']) {
    try { return acorn.parse(src, { ecmaVersion: 'latest', sourceType, locations: true, allowReturnOutsideFunction: true }); }
    catch (_) { /* try the other */ }
  }
  return null;
}

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, visit, node); }
    else if (v && typeof v.type === 'string') walk(v, visit, node);
  }
}

/* The enclosing named function for a node, by span. Declarations, expressions and methods all count;
   an anonymous callback is attributed to whatever named function encloses IT, which is the frame a
   reader would name. */
function functionSpans(ast) {
  const spans = [];
  walk(ast, (n, parent) => {
    let name = null;
    if (n.type === 'FunctionDeclaration' && n.id) name = n.id.name;
    else if ((n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') && parent) {
      if (parent.type === 'VariableDeclarator' && parent.id && parent.id.type === 'Identifier') name = parent.id.name;
      else if (parent.type === 'Property' && parent.key) name = parent.key.name || parent.key.value;
      else if (parent.type === 'AssignmentExpression' && parent.left.type === 'Identifier') name = parent.left.name;
    }
    /* 🔴 exports.NAME = onSchedule({…}, async () => {…}) — the handler is an ANONYMOUS arrow passed
       as an argument, so without this the scheduled sweep is attributed to "(module scope)" and the
       entry point a reader would name (sweepIdentityRegistry) never appears. The assignment's span
       covers its callbacks, which is exactly the frame that deserves the name. */
    if (!name && n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression') {
      const l = n.left;
      const isExports = (l.object.type === 'Identifier' && l.object.name === 'exports')
        || (l.object.type === 'MemberExpression' && l.object.object.name === 'module' && l.object.property.name === 'exports');
      if (isExports && l.property) spans.push({ name: l.property.name || l.property.value, start: n.start, end: n.end });
    }
    if (name) spans.push({ name, start: n.start, end: n.end });
  });
  spans.sort((a, b) => (b.end - b.start) - (a.end - a.start));      // widest first; innermost wins below
  return spans;
}
const fnAt = (spans, pos) => {
  let best = null;
  for (const s of spans) if (pos >= s.start && pos < s.end) best = s;   // later = narrower
  return best ? best.name : '(module scope)';
};

/* Names bound to a registry path builder, including aliases:
     const { idsColOf } = require(…)          → idsColOf
     const { idsColOf: mk } = require(…)      → mk
     const idsColOf = require(…).idsColOf     → idsColOf
   plus the local definitions in identity-registry.js itself. */
function builderNames(ast) {
  const names = new Set();
  walk(ast, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern') {
      for (const p of n.id.properties) {
        if (p.type !== 'Property' || !p.key) continue;
        const from = p.key.name || p.key.value;
        if (BUILDERS.includes(from) && p.value.type === 'Identifier') names.add(p.value.name);
      }
    }
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && BUILDERS.includes(n.id.name)) names.add(n.id.name);
    if (n.type === 'FunctionDeclaration' && n.id && BUILDERS.includes(n.id.name)) names.add(n.id.name);
  });
  return names;
}

/* Does this expression evaluate to a registry ref? A builder call, anything chained off one, or a
   variable assigned from one. Chains are followed through .doc()/.collection()/member access, which
   is what makes `idsColOf(...).doc(id)` and `ref.doc(id)` both resolve. */
function registryExprFactory(ast, names) {
  const refVars = new Set();
  const isRegistry = (node) => {
    let cur = node;
    for (let i = 0; i < 24 && cur; i += 1) {
      if (cur.type === 'CallExpression') {
        if (cur.callee.type === 'Identifier' && names.has(cur.callee.name)) return true;
        cur = cur.callee; continue;
      }
      if (cur.type === 'MemberExpression') { cur = cur.object; continue; }
      if (cur.type === 'Identifier') return refVars.has(cur.name);
      if (cur.type === 'AwaitExpression') { cur = cur.argument; continue; }
      return false;
    }
    return false;
  };
  // two passes: assignments can precede or follow their use in source order
  for (let pass = 0; pass < 2; pass += 1) {
    walk(ast, (n) => {
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && isRegistry(n.init)) refVars.add(n.id.name);
      if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && isRegistry(n.right)) refVars.add(n.left.name);
    });
  }
  return isRegistry;
}

const verbOf = (prop, computed) => {
  if (!computed && prop.type === 'Identifier') return prop.name;
  if (computed && prop.type === 'Literal') return String(prop.value);
  return null;
};

function scanFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = parse(src);
  if (!ast) return { file, writes: [], calls: [], exported: new Set(), parseFailed: true };
  const spans = functionSpans(ast);
  const names = builderNames(ast);
  const isRegistry = registryExprFactory(ast, names);

  const exported = new Set();
  walk(ast, (n) => {
    if (n.type !== 'AssignmentExpression') return;
    const l = n.left;
    if (l.type === 'MemberExpression' && l.object.type === 'Identifier' && l.object.name === 'module'
        && l.property.name === 'exports') {
      if (n.right.type === 'ObjectExpression') {
        for (const p of n.right.properties) if (p.key) exported.add(p.key.name || p.key.value);
      }
    }
    if (l.type === 'MemberExpression' && l.object.type === 'MemberExpression'
        && l.object.object.name === 'module' && l.object.property.name === 'exports' && l.property) {
      exported.add(l.property.name || l.property.value);
    }
  });

  const writes = [];
  const calls = [];
  walk(ast, (n) => {
    if (n.type !== 'CallExpression') return;
    const fn = fnAt(spans, n.start);

    // every call, for the reachability graph
    if (n.callee.type === 'Identifier') calls.push({ file, fn, callee: n.callee.name, line: n.loc.start.line });
    else if (n.callee.type === 'MemberExpression' && n.callee.property && !n.callee.computed) {
      calls.push({ file, fn, callee: n.callee.property.name, line: n.loc.start.line });
    }

    if (n.callee.type !== 'MemberExpression') return;
    const verb = verbOf(n.callee.property, n.callee.computed);
    if (!verb || !WRITE_VERBS.has(verb)) return;

    // receiver form:  <registry expr>.set(…)
    if (isRegistry(n.callee.object)) {
      writes.push({ file, line: n.loc.start.line, fn, verb, shape: 'receiver', exported: exported.has(fn) });
      return;
    }
    // argument form:  tx.set(<registry expr>, …) — any receiver name, including computed access
    if (n.arguments.length && isRegistry(n.arguments[0])) {
      writes.push({ file, line: n.loc.start.line, fn, verb, shape: 'arg', exported: exported.has(fn) });
    }
  });
  return { file, writes, calls, exported, parseFailed: false };
}

function enumerate() {
  const files = ROOTS.flatMap((r) => jsFilesUnder(r));
  /* Production only. `test/` holds suites AND harnesses (control rigs, the measurement rig) — none of
     them is a path a merchant's publish takes, and listing them as entry points would pad a claim that
     is supposed to be about production reachability. Excluded by DIRECTORY rather than by filename,
     because the harnesses are not named *.test.js and the first version therefore counted them. */
  const prod = files.filter((f) => !/\.test\.(js|mjs)$/.test(f)
    && !/(^|\/)test\//.test(path.relative(ROOT, f))
    && !/\/tools\/registry-writers\.js$/.test(f));
  const scanned = prod.map(scanFile);
  const writes = scanned.flatMap((s) => s.writes);
  const parseFailures = scanned.filter((s) => s.parseFailed).map((s) => path.relative(ROOT, s.file));

  /* 🔴 REACHABILITY IS TRANSITIVE, NOT ONE FRAME. The first version reported only DIRECT callers of a
     writer, and therefore missed publishVersion — which reaches ensureIdentity through
     ensureIdentitiesForKeys, and is THE LIVE PUBLISH PATH — and the scheduled sweep in index.js. An
     entry-point claim that stops one call short is worse than no claim, because it reads as complete. */
  const writerNames = new Set(writes.map((w) => w.fn));
  const callGraph = new Map();                      // "file::fn" -> Set(callee names)
  const fnsByName = new Map();                      // name -> [{file, fn, exported}]
  for (const s of scanned) {
    for (const c of s.calls) {
      const key = `${c.file}::${c.fn}`;
      if (!callGraph.has(key)) callGraph.set(key, new Set());
      callGraph.get(key).add(c.callee);
    }
    for (const name of s.exported) {
      if (!fnsByName.has(name)) fnsByName.set(name, []);
      fnsByName.get(name).push({ file: s.file, exported: true });
    }
  }
  const reaches = new Map();                        // "file::fn" -> {via, depth}
  let frontier = new Set(writerNames);
  for (let depth = 1; depth <= 8 && frontier.size; depth += 1) {
    const next = new Set();
    for (const [key, callees] of callGraph) {
      const fn = key.split('::')[1];
      if (writerNames.has(fn) || reaches.has(key)) continue;
      for (const target of frontier) {
        if (!callees.has(target)) continue;
        reaches.set(key, { via: target, depth });
        next.add(fn);
        break;
      }
    }
    frontier = next;
  }

  const indirect = [...reaches.entries()].map(([key, v]) => {
    const [file, fn] = key.split('::');
    return { file, fn, calls: v.via, depth: v.depth };
  }).sort((a, b) => (a.depth - b.depth) || a.file.localeCompare(b.file) || a.fn.localeCompare(b.fn));

  return { files: files.length, scanned: prod.length, writes, indirect, parseFailures, writerNames: [...writerNames].sort() };
}

module.exports = { enumerate, scanFile, jsFilesUnder, parse, ROOTS, BUILDERS };

if (require.main !== module) return;
const r = enumerate();
console.log(`walked ${r.scanned} production files under ${ROOTS.length} roots (AST, not regex)\n`);
if (r.parseFailures.length) console.log(`🔴 ${r.parseFailures.length} file(s) did not parse: ${r.parseFailures.join(', ')}\n`);
console.log('DIRECT REGISTRY WRITE SITES');
for (const w of r.writes) console.log(`  ${path.relative(ROOT, w.file)}:${w.line}  ${w.fn}()  ${w.verb} [${w.shape}]${w.exported ? '  ← EXPORTED' : ''}`);
console.log(`\n${r.writes.length} write sites in ${r.writerNames.length} functions: ${r.writerNames.join(', ')}`);
console.log('\nFUNCTIONS THAT REACH A WRITER (transitively)');
for (const h of r.indirect) console.log(`  ${String(h.depth)}  ${path.relative(ROOT, h.file)}  ${h.fn}()  → ${h.calls}()`);
