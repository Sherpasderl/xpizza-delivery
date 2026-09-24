'use strict';
/* Enumerate every site that WRITES the identity registry — walked from disk, never from a list.
 *
 * 🔴 WHY A WALK AND NOT A LIST. A written-down list of writers is right on the day it is written and
 * silently wrong afterwards: the next writer is added by someone who never reads it. The spec's own
 * rationale for this area named callers this tree does not have, which is the same failure one level
 * up. So the set is derived from the source every time it is needed, and a cell asserts what the walk
 * finds — an empty walk being the one result that must never read as success.
 *
 * THE REGISTRY IS: restaurants/{rid}/identity/{kind}/ids/{id}     (canonical id rows)
 *                  restaurants/{rid}/identity/{kind}/keys/{key}   (legacy-key -> canonical id)
 * built by idsColOf()/keysColOf() in catalog/identity-registry.js, which exports them.
 *
 * 🔴 THE REF IS USUALLY AN ARGUMENT, NOT A RECEIVER. Firestore transaction writes are
 * `tx.set(ref, …)` / `tx.update(ref, …)` / `tx.delete(ref)`, so a walker looking for `.set(` on a
 * registry-shaped receiver finds almost nothing here. Both shapes are matched, and refs are traced
 * through the local variables they are assigned to — `const idRef = idsColOf(db, rid, kind).doc(id)`
 * followed later by `tx.set(idRef, …)` is the dominant spelling in this tree.
 */
const fs = require('fs');
const path = require('path');
const stripComments = require('./strip-comments.js');

const ROOT = path.join(__dirname, '..');
const BUILDERS = ['idsColOf', 'keysColOf'];
const WRITE_VERBS = ['set', 'update', 'delete', 'create'];

/* Directories walked. Kept explicit and asserted by the cell: a root silently dropped would shrink
   the walk without shrinking the claim. */
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

/* The enclosing top-level function for a line. This codebase declares them at column 0, as
   `function f(`, `async function f(` or `const f = (… ) =>`. */
function enclosingFns(lines) {
  const owner = [];
  let current = '(module scope)';
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(lines[i])
      || /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/.exec(lines[i])
      || /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function/.exec(lines[i]);
    if (m) current = m[1];
    owner[i] = current;
  }
  return owner;
}

function exportedNames(code) {
  const out = new Set();
  const m = /module\.exports\s*=\s*\{([\s\S]*?)\}/.exec(code);
  if (m) for (const part of m[1].split(',')) {
    const n = part.split(':')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(n)) out.add(n);
  }
  for (const mm of code.matchAll(/module\.exports\.([A-Za-z_$][\w$]*)\s*=/g)) out.add(mm[1]);
  return out;
}

function scanFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const lines = code.split('\n');
  const owner = enclosingFns(lines);
  const exported = exportedNames(code);

  /* Variables holding a registry ref: `const x = idsColOf(...)…` (any trailing .doc()/.where()). */
  const refVars = new Set();
  for (const m of code.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n]*\\b(?:${BUILDERS.join('|')})\\s*\\(`, 'g'))) {
    refVars.add(m[1]);
  }

  const isRegistryExpr = (expr) => {
    const e = String(expr || '').trim();
    if (BUILDERS.some((b) => new RegExp(`\\b${b}\\s*\\(`).test(e))) return true;
    const head = /^([A-Za-z_$][\w$]*)/.exec(e);
    return !!(head && refVars.has(head[1]));
  };

  const writes = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // tx.set(ref, …) / batch.update(ref, …) / tx.delete(ref)
    for (const m of line.matchAll(new RegExp(`\\b(?:tx|t|batch|writer)\\s*\\.\\s*(${WRITE_VERBS.join('|')})\\s*\\(([^,)]*)`, 'g'))) {
      if (isRegistryExpr(m[2])) writes.push({ file, line: i + 1, fn: owner[i], verb: m[1], shape: 'arg', exported: exported.has(owner[i]) });
    }
    // ref.set(…) — receiver form
    for (const m of line.matchAll(new RegExp(`([A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*\\([^)]*\\))*)\\s*\\.\\s*(${WRITE_VERBS.join('|')})\\s*\\(`, 'g'))) {
      if (isRegistryExpr(m[1])) writes.push({ file, line: i + 1, fn: owner[i], verb: m[2], shape: 'receiver', exported: exported.has(owner[i]) });
    }
  }
  return { file, writes, exported, code, owner, lines };
}

/* Exported functions that reach a writer without writing themselves — ensureIdentity's callers are
   registry entry points even though the write is one frame down. */
function callersOf(names, files) {
  const hits = [];
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    const lines = code.split('\n');
    const owner = enclosingFns(lines);
    const exported = exportedNames(code);
    for (let i = 0; i < lines.length; i += 1) {
      for (const n of names) {
        if (new RegExp(`\\b${n}\\s*\\(`).test(lines[i]) && !new RegExp(`(?:function|const)\\s+${n}\\b`).test(lines[i])) {
          hits.push({ file: f, line: i + 1, fn: owner[i], calls: n, exported: exported.has(owner[i]) });
        }
      }
    }
  }
  return hits;
}

function enumerate() {
  const files = ROOTS.flatMap((r) => jsFilesUnder(r));
  const prod = files.filter((f) => !/\.test\.(js|mjs)$/.test(f) && !/\/tools\/registry-writers\.js$/.test(f));
  const scanned = prod.map(scanFile);
  const writes = scanned.flatMap((s) => s.writes);

  const writerFns = [...new Set(writes.map((w) => `${path.relative(ROOT, w.file)}::${w.fn}`))].sort();
  /* 🔴 CALLERS OF *EVERY* WRITER, NOT ONLY THE EXPORTED ONES. retireOrphanFenced() is a module-private
     writer, so scanning for callers of exported writers alone missed reconcileLegacyOrphans() — an
     exported entry point whose write is one frame down and behind a name nothing outside the file can
     see. Fencing the exported surface while a private writer has its own caller is exactly the gap
     this enumeration exists to find. */
  const directNames = [...new Set(writes.map((w) => w.fn))];
  const indirect = callersOf(directNames, prod).filter((h) => !writes.some((w) => w.file === h.file && w.fn === h.fn));

  return { files: files.length, scanned: prod.length, writes, writerFns, directNames, indirect };
}

module.exports = { enumerate, scanFile, jsFilesUnder, enclosingFns, exportedNames, ROOTS, BUILDERS };

if (require.main !== module) return;
const r = enumerate();
console.log(`walked ${r.scanned} production files under ${ROOTS.length} roots\n`);
console.log('DIRECT REGISTRY WRITE SITES');
for (const w of r.writes) console.log(`  ${path.relative(ROOT, w.file)}:${w.line}  ${w.fn}()  ${w.verb} [${w.shape}]${w.exported ? '  ← EXPORTED' : ''}`);
console.log(`\n${r.writes.length} write sites in ${r.writerFns.length} functions`);
console.log('\nEXPORTED FUNCTIONS THAT REACH A WRITER WITHOUT WRITING DIRECTLY');
for (const h of r.indirect) console.log(`  ${path.relative(ROOT, h.file)}:${h.line}  ${h.fn}()  → calls ${h.calls}()${h.exported ? '  ← EXPORTED' : ''}`);
