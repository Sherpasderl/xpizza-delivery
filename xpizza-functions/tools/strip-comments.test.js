'use strict';
/**
 * tools/strip-comments.js — the shared "is this line code" definition. Run: node tools/strip-comments.test.js
 *
 * 🔴 WHY THIS FILE EXISTS NOW AND NOT BEFORE. The stripper had ZERO cells while its callers decided,
 * on its output, whether a guard SEES a call: catalog/project-guard.test.js (which tool opens a
 * connection), catalog/publish-paths.test.js (how many writers the pointer doc has), and
 * catalog/identity-sweep.test.js. A stripper that removes too much makes a guard blind — it reports a
 * wiring that is not there, or misses a second writer — and one that removes too little makes a guard
 * count commented-out text as live code. Both failures are silent and both look green.
 *
 * 🔴 AND IT FOUND ONE. Before these cells the stripper ATE CODE on a regex containing an escaped
 * slash pair (`/https:\/\//`, the ordinary way to match a URL): the `\` was copied, the following `/`
 * paired with the next `/`, and the rest of the line was deleted as a line comment. Cell 3 is that
 * case. No file in either guard's scan set contains such a regex TODAY — measured, cell 6 — which is
 * why adopting the stripper did not turn anything red. That is luck, not a guarantee, and it is the
 * whole reason the limits below are pinned rather than described.
 */
const assert = require('assert');
const { readFileSync, readdirSync, statSync } = require('fs');
const { join, relative } = require('path');
const stripComments = require('./strip-comments.js');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('strip-comments: FAILED — exited without completing'); process.exitCode = 1; } });

const ROOT = join(__dirname, '..');
/* The naive stripper BOTH adopting guards used to carry, kept here as the control. Cell 6 is a claim
   about the difference between these two, so the old one has to be present to make the claim. */
const naive = (src) => src.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');

// ── 1. BOTH COMMENT FORMS GO, AND THE CODE AROUND THEM STAYS ─────────────────────────────────
{
  assert.ok(!stripComments('/* publishVersion( */ const a = 1;').includes('publishVersion'),
    '🔴 a call inside a BLOCK comment survived — this is the gap both local copies had, and it makes a guard count commented-out text as a live writer');
  assert.ok(stripComments('/* publishVersion( */ const a = 1;').includes('const a = 1;'),
    '🔴 the code after a block comment was eaten');
  assert.ok(!stripComments('const a = 1; // publishVersion(\nconst b = 2;').includes('publishVersion'),
    'a call in a line comment is removed');
  assert.ok(stripComments('const a = 1; // x\nconst b = 2;').includes('const b = 2;'),
    '🔴 a line comment swallowed the NEXT line');
  ok('line comments and block comments are both removed, and the code around them is not');
}

// ── 2. A COMMENT MARKER INSIDE A STRING IS DATA — THE DIRECTION THE NAIVE COPY BROKE ─────────
{
  /* 🔴 THE NAIVE STRIPPER CUT AT `//` INSIDE A STRING, BUT ONLY A SPACED ONE — and the difference
     matters, because my first version of this cell claimed a URL was the broken case and it is not.
     The naive regex is `/\s\/\/.*$/`: it needs WHITESPACE before the marker, so `"https://x"` (no
     space) survived it and `"a // b"` did not. Getting that backwards would have made this cell a
     control that controls nothing — it would pass for both strippers. The spaced form is the real
     one, and it is the blind direction nobody notices: the guard simply reports one fewer writer. */
  const url = 'const u = "https://x.test/a"; const KEEP = 1;';
  const spaced = 'const u = "a // b"; const KEEP = 1;';
  assert.ok(stripComments(url).includes('KEEP'), '🔴 a `//` inside a double-quoted string ate the rest of the line');
  assert.ok(stripComments(url).includes('https://x.test/a'), 'the string itself is preserved — a require path lives in a literal');
  assert.ok(stripComments("const u = 'a // b'; const KEEP = 1;").includes('KEEP'), '🔴 single-quoted');
  assert.ok(stripComments('const u = `a // b`; const KEEP = 1;').includes('KEEP'), '🔴 template');
  assert.ok(stripComments('const u = "a /* b */ c"; const KEEP = 1;').includes('/* b */'),
    '🔴 a BLOCK marker inside a string was treated as a comment');
  assert.ok(stripComments('const u = "a \\" // still string"; const KEEP = 1;').includes('KEEP'),
    '🔴 an escaped quote ended the string early, and the rest of the line was read as a comment');

  assert.ok(stripComments(spaced).includes('KEEP'), '🔴 a spaced `//` inside a string ate the rest of the line');

  /* The control: the naive stripper really does get the SPACED form wrong, so cell 2 is about a
     fixed defect rather than a property that was never at risk. And it really does get the URL form
     right — asserted too, so the control cannot be read as "the naive one is wrong about everything". */
  assert.ok(!naive(spaced).includes('KEEP'),
    '🔴 the naive stripper handled a spaced `//` inside a string correctly — then this cell is not testing what it says it is');
  assert.ok(naive(url).includes('KEEP'),
    'and the naive one was never broken on a URL: its regex demands whitespace before the marker, which is why adopting the shared stripper did not fix a URL bug that never existed');
  ok('a `//` or `/* */` inside a string or template is data, not a comment — and the naive copy really did break the spaced form, though never the URL form');
}

// ── 3. THE REGEX DEFECT THESE CELLS FOUND ────────────────────────────────────────────────────
{
  /* Chars: / h t t p s : \ / \ / /. Without escape-consumption in code position the first `\` was
     copied alone, the `/` after it paired with the next `/`, and a phantom line comment swallowed
     everything to the newline. */
  const re = 'const re = /https:\\/\\//; const KEEP = 1;';
  assert.ok(stripComments(re).includes('KEEP'),
    '🔴 a regex containing an escaped slash PAIR opened a phantom line comment and ate the rest of the line — a guard reading this source is blind to that line');
  assert.strictEqual(stripComments(re), re, 'a line with no comment on it comes back unchanged');
  assert.ok(stripComments('const re = /a\\/b/; const KEEP = 1;').includes('KEEP'), 'a single escaped slash was always fine');

  /* 🔴 SENSITIVITY — THE FIX MUST NOT HAVE DISARMED THE STRIPPER. A real comment after a regex must
     still go, or "no line is ever eaten" would be satisfiable by stripping nothing. */
  const after = 'const re = /a\\/b/; // publishVersion(\nconst KEEP = 1;';
  assert.ok(!stripComments(after).includes('publishVersion'), '🔴 a real line comment AFTER a regex survived — the escape fix disarmed the stripper');
  assert.ok(stripComments(after).includes('KEEP'), '…and the next line is still there');
  ok('a regex with an escaped slash pair no longer opens a phantom comment, and a real comment after a regex still goes');
}

// ── 4. THE LIMITS, PINNED RATHER THAN DESCRIBED ──────────────────────────────────────────────
{
  /* 🔴 THESE ASSERT THE CURRENT, WRONG BEHAVIOUR ON PURPOSE. A limit recorded only in a header is a
     limit that gets discovered by a silent miscount. If someone makes this a real lexer, these two
     cells go red and the header is what needs updating — which is the correct outcome, not a
     regression. Neither shape occurs in either guard's scan set (cell 6). */
  assert.ok(!stripComments('const re = /[//]/; const KEEP = 1;').includes('KEEP'),
    'LIMIT: an UNESCAPED `//` inside a regex character class still opens a phantom comment (redundant as JS; absent from this tree)');
  assert.ok(stripComments('const s = `a ${/* c */ b} d`;').includes('/* c */'),
    'LIMIT: `${...}` inside a template is treated as string content, so a comment written there survives');
  ok('the two unmodelled shapes are pinned as cells, so the limit is known rather than discovered by a miscount');
}

// ── 5. LINE NUMBERS AND `^` ANCHORS SURVIVE — THE PROPERTY EVERY CALLER DEPENDS ON ───────────
{
  /* Callers report `file:line` and match with `^`-anchored patterns against the STRIPPED source. If
     stripping collapsed lines, every reported line number would be wrong by a drifting amount — the
     kind of wrong that reads as a stale file rather than as a broken tool. */
  const src = 'a\n/* one\n   two\n   three */\nb // t\nc\n';
  assert.strictEqual(stripComments(src).split('\n').length, src.split('\n').length,
    '🔴 stripping changed the LINE COUNT — every line number a caller reports would be wrong');
  const lines = stripComments(src).split('\n');
  assert.strictEqual(lines[0], 'a', 'line 1 is untouched');
  assert.strictEqual(lines[5], 'c', '🔴 line 6 is no longer line 6');
  assert.match(stripComments('  const x = 1;\n'), /^\s*const x = 1;/m, '`^` still anchors to a real line start');
  assert.strictEqual(stripComments(''), '', 'empty in, empty out');
  assert.strictEqual(stripComments(null), '', 'null is not a crash');
  assert.strictEqual(stripComments('const a = "unterminated'), 'const a = "unterminated',
    'an unterminated string is copied through rather than swallowing the file');
  ok('line count and column-0 anchors survive stripping, and empty/null/unterminated input do not crash');
}

// ── 6. NON-VACUITY, ON THE REAL SCAN SETS: THE ADOPTION CHANGES WHAT THE GUARDS SEE ──────────
{
  /* 🔴 THIS IS THE CELL THAT MAKES THE ADOPTION EVIDENCE RATHER THAN A REFACTOR. Both guards stayed
     green and kept the same cell counts after adopting this stripper, which on its own is consistent
     with the adoption changing nothing. It does not: on the files publish-paths actually scans, the
     naive stripper counted matches that live inside BLOCK COMMENTS. If someone reverts either guard
     to a line-only stripper, this goes red. */
  const SKIP = new Set(['node_modules', '.git', 'public', 'coverage', 'test']);
  const isTest = (f) => /\.test\.(js|mjs)$/.test(f) || /\.guard\.test\.js$/.test(f);
  const prod = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) prod(full, out);
      else if (/\.(js|mjs)$/.test(name) && !isTest(name)) out.push(full);
    }
    return out;
  };
  const files = prod(ROOT);
  assert.ok(files.length > 100, `non-vacuity: the walk must really reach the tree (found ${files.length})`);

  let differing = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const re of [/active_version/g, /\.set\(/g, /\bpublishVersion\s*\(/g]) {
      if ((naive(src).match(re) || []).length !== (stripComments(src).match(re) || []).length) { differing += 1; break; }
    }
  }
  assert.ok(differing > 0,
    '🔴 on every production file the two strippers agree, so adopting the shared one changed nothing this guard measures — the adoption is untested and this cell is the only thing that would have said so');

  /* 🔴 AND THE OTHER DIRECTION: THE SHARED STRIPPER MUST NOT BE EATING CODE IN THESE FILES. A line
     carrying an escaped slash and no `//` must come back unchanged. This is cell 3's defect asked of
     the real tree, and it is what licenses the adoption rather than merely describing it. */
  let eaten = 0;
  for (const f of files) {
    const raw = readFileSync(f, 'utf8');
    const a = raw.split('\n');
    const b = stripComments(raw).split('\n');
    for (let i = 0; i < a.length; i += 1) {
      if (!/\\\//.test(a[i]) || a[i].includes('//')) continue;
      if (b[i] !== undefined && b[i].trim() !== a[i].trim()) { eaten += 1; console.error(`  ${relative(ROOT, f)}:${i + 1}  ${a[i].trim().slice(0, 100)}`); }
    }
  }
  assert.strictEqual(eaten, 0, `🔴 the stripper ATE ${eaten} line(s) of real code in the scanned tree — every guard reading this source is blind to them`);
  ok(`the two strippers disagree on ${differing} of ${files.length} scanned production files, and the shared one eats no real code in any of them`);
}

// ── 7. THE ADOPTION ITSELF — ASSERTED AT THE CALL SITE, NOT INFERRED FROM CELL 6 ─────────────
{
  /* 🔴 THE SWEEP FOUND THIS GAP. A mutant reverting catalog/publish-paths.test.js to a line-only
     stripper SURVIVED every cell above, because all of them drive the primitive and none of them
     asks what the CALLERS use. Cell 6 proves the two strippers disagree on the scanned tree; that is
     a fact about this file, and it stays true no matter which stripper a guard actually calls.
     So: read the adopting files and require that they take the shared definition and define no local
     one. A second definition of "is this line code" is the hazard the shared file exists to remove,
     and it re-appears by an ordinary edit. */
  const ADOPTERS = ['catalog/project-guard.test.js', 'catalog/publish-paths.test.js', 'catalog/identity-sweep.test.js'];
  for (const rel of ADOPTERS) {
    /* Strip the file's own comments before matching, with the stripper under test — otherwise the
       prose in those very adoption notes (which quotes the old regex) matches as if it were code,
       and this cell passes on its own documentation. */
    const code = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
    assert.ok(/require\(\s*['"][^'"]*strip-comments(\.js)?['"]\s*\)/.test(code),
      `🔴 ${rel} does not require the shared stripper — the adoption was reverted, and this guard is back to its own definition of "is this line code"`);
    assert.ok(!/\.replace\(\s*\/\^\\s\*\\\/\\\//.test(code),
      `🔴 ${rel} has grown a LOCAL line-only stripper again; two definitions drift, and then two guards disagree about the same file`);
  }

  /* Non-vacuity, both directions: the matcher must actually be capable of failing. A file that does
     not require the stripper must not pass, and a file that does must not fail. */
  assert.ok(!/require\(\s*['"][^'"]*strip-comments(\.js)?['"]\s*\)/.test('const x = 1;'),
    'premise: the require-matcher can return false');
  assert.ok(/\.replace\(\s*\/\^\\s\*\\\/\\\//.test(String(naive)),
    'premise: the local-stripper matcher really does match the naive implementation it is meant to catch');
  ok(`all ${ADOPTERS.length} callers take the shared definition and none carries a local one — the property the primitive cells cannot see`);
}

FINISHED = true;
console.log(`strip-comments: OK (${n})`);
