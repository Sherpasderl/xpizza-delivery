'use strict';
// PLAN-3a-order-owner (advisor GO Option 1, rule 6c) — the post-asm11 layers hook's own pin. tools/post-asm11-layers.js holds the
// exact-text hunks landed after the asm11 tip (BASE); ledgers1-module-inverse peels them FIRST, so every fold guard that peels ledgers1
// peels them too. This guard pins:
//   · each owned file (index.js; r1: pixelpay-hosted-charge.js; uid-path: delivery/pricing-admin-core.js) minus the hook's hunks === BASE byte-for-byte (non-vacuous);
//   · every hunk occurs EXACTLY once; a byte inside a hunk (tamper) or a second copy (duplicate) is refused;
//   · the hunks are the CURRENT `git diff -U0 BASE -- <file>`, in diff order (a drifted hunk or a missed edit is refused);
//   · the ORDER: HUNKS grouped by layer in the declared landing order, peeled newest-first;
//   · ledgers1's unapply calls the hook first, and a file the hook does not own passes through.
// Run: node post-asm11-layers.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./tools/post-asm11-layers');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

// r1 (Codex #172 P1-b): the hook owns index.js AND pixelpay-hosted-charge.js — each owned file is pinned the same way
const rawOf = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
// asm12 step 07 (advisor H3 = A, 11-19): the train's PER-SITE layers on the hook's files are peeled first — fix/privacy-gaps-5f (innermost
// on the raw read) and addr-rev's memberreads insertion (unapplyAfter 099c280e4) — so the hook's pins (=== BASE, = the current diff) see a
// raw read minus only the post-asm11 hunks. The hook stays order-owner-only; a file those layers do not own passes through unchanged.
const perSite = (f, src) => require('./tools/memberreads-module-inverse').unapplyAfter(f, require('./tools/mrr-module-inverse').unapplyMrrModule(f, require('./tools/cpark-module-inverse').unapplyCparkModule(f, require('./tools/ratt-module-inverse').unapplyRattModule(f, require('./tools/privacy-module-inverse').unapplyPrivacyModule(f, src)))), '099c280e4');   // asm13 (advisor A′): + 5f review's mrr / cpark / ratt (disjoint on index.js), inside the member-reads peel as in ledgers1-wiring
const diskOf = (f) => perSite(f, rawOf(f));
assert.ok(L.HUNKS.length >= 1 && L.FILES.length >= 1, 'POST-ASM11: non-vacuity — the hook owns hunks');
assert.deepStrictEqual([...L.FILES].sort(), ['delivery/pricing-admin-core.js', 'index.js', 'pixelpay-hosted-charge.js'], '🔴 POST-ASM11: the owned files (a new one is added here deliberately)');   // uid-path (Codex C 11-23): + pricing-admin-core.js
for (const f of L.FILES) {
  const disk = diskOf(f), base = git(['show', `${L.BASE}:xpizza-functions/${f}`]);
  assert.notStrictEqual(disk, base, `POST-ASM11: non-vacuity — ${f} carries the post-asm11 hunks`);
  assert.strictEqual(L.stripPostAsm11(f, disk), base, `🔴 POST-ASM11: ${f} minus the post-asm11 hunks is not ${L.BASE.slice(0, 9)}:${f}`);
}
ok(`each owned file (${L.FILES.join(', ')}) minus its post-asm11 hunks (${L.HUNKS.length} in all) === ${L.BASE.slice(0, 9)} byte-for-byte`);

for (const h of L.HUNKS) {
  const disk = L.stripInner(h.file, diskOf(h.file));   // the HUNKS live in (disk − INNER) (advisor ruling (A))
  assert.strictEqual(disk.split(h.now).length - 1, 1, `🔴 POST-ASM11: «${h.label}» occurs exactly once`);
  const k = h.now.search(/[A-Za-z]/);
  assert.throws(() => L.stripHunks(h.file, disk.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `🔴 POST-ASM11: a byte inside «${h.label}» is refused`);
  assert.throws(() => L.stripHunks(h.file, disk + h.now), /occurs 2 times/, `🔴 POST-ASM11: a duplicated «${h.label}» is refused`);
}
ok('every hunk occurs exactly once; tamper (a byte inside) and duplicate are refused');

// the hunks ARE the current diff (one hunk per `@@` of `git diff -U0 BASE -- <file>`, in diff order)
for (const f of L.FILES) {
  // asm12 H3 (A): the diff of the per-site-peeled file against BASE (a no-index diff of two temp files), not of the raw tree
  const os = require('os'); const d = fs.mkdtempSync(path.join(os.tmpdir(), 'post-asm11-'));
  fs.writeFileSync(path.join(d, 'base'), git(['show', `${L.BASE}:xpizza-functions/${f}`])); fs.writeFileSync(path.join(d, 'now'), L.stripInner(f, diskOf(f)));
  const r = require('child_process').spawnSync('git', ['diff', '--no-index', '-U0', path.join(d, 'base'), path.join(d, 'now')], { encoding: 'utf8', maxBuffer: 1 << 27 });
  fs.rmSync(d, { recursive: true, force: true });
  assert.ok(r.status === 0 || r.status === 1, `POST-ASM11: the no-index diff ran (${r.status})`);
  const lines = r.stdout.split('\n');
  const got = []; let cur = null;
  for (const l of lines) {
    if (l.startsWith('@@')) { cur = { now: '', was: '' }; got.push(cur); }
    else if (cur && l.startsWith('+') && !l.startsWith('+++')) cur.now += l.slice(1) + '\n';
    else if (cur && l.startsWith('-') && !l.startsWith('---')) cur.was += l.slice(1) + '\n';
  }
  assert.deepStrictEqual(L.HUNKS.filter((h) => h.file === f).map((h) => ({ now: h.now, was: h.was })), got, `🔴 POST-ASM11: ${f}'s hunks are exactly the current diff vs ${L.BASE.slice(0, 9)} (regenerate the hook)`);
}
ok('the hook\'s hunks are exactly the current `git diff -U0 BASE` of each owned file minus INNER, in diff order');

// INNER (advisor ruling (A), 11-25): the newest layer's exact-line swaps, peeled FIRST. Each occurs exactly once on disk (a byte inside
// or a duplicate is refused); INNER is EXACTLY the line diff of disk vs (disk − INNER), in diff order; its layer is declared LAST in
// ORDER (newest) and owns no HUNKS; stripPostAsm11 peels INNER before the HUNKS.
assert.ok(L.INNER.length >= 1, 'POST-ASM11 INNER: non-vacuity');
for (const h of L.INNER) {
  const disk = diskOf(h.file);
  assert.strictEqual(disk.split(h.now).length - 1, 1, `🔴 POST-ASM11 INNER: «${h.label}» occurs exactly once`);
  const k = h.now.search(/[A-Za-z]/);
  assert.throws(() => L.stripInner(h.file, disk.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `🔴 POST-ASM11 INNER: a byte inside «${h.label}» is refused`);
  assert.throws(() => L.stripInner(h.file, disk + h.now), /occurs 2 times/, `🔴 POST-ASM11 INNER: a duplicated «${h.label}» is refused`);
}
for (const f of L.INNER_FILES) {
  const os = require('os'); const d = fs.mkdtempSync(path.join(os.tmpdir(), 'post-asm11-inner-'));
  const disk = diskOf(f); fs.writeFileSync(path.join(d, 'was'), L.stripInner(f, disk)); fs.writeFileSync(path.join(d, 'now'), disk);
  const r = require('child_process').spawnSync('git', ['diff', '--no-index', '-U0', path.join(d, 'was'), path.join(d, 'now')], { encoding: 'utf8', maxBuffer: 1 << 27 });
  fs.rmSync(d, { recursive: true, force: true });
  const got = []; let cur = null;
  for (const l of r.stdout.split('\n')) {
    if (l.startsWith('@@')) { cur = { now: '', was: '' }; got.push(cur); }
    else if (cur && l.startsWith('+') && !l.startsWith('+++')) cur.now += `\n${l.slice(1)}\n`;
    else if (cur && l.startsWith('-') && !l.startsWith('---')) cur.was += `\n${l.slice(1)}\n`;
  }
  assert.deepStrictEqual(L.INNER.filter((h) => h.file === f).map((h) => ({ now: h.now, was: h.was })), got, `🔴 POST-ASM11 INNER: ${f}'s swaps are exactly the diff of disk vs (disk − INNER), one line each, in diff order`);
}
const innerLayers = [...new Set(L.INNER.map((h) => h.layer))];
assert.ok(innerLayers.every((x) => L.ORDER.includes(x) && !L.HUNKS.some((h) => h.layer === x)) && L.ORDER.slice(-innerLayers.length).join() === innerLayers.join(), '🔴 POST-ASM11 INNER: its layer is declared LAST in ORDER (newest) and owns no HUNKS');
assert.ok(/const inner = INNER_FILES\.includes\(file\) \? stripInner\(file, src\) : src;\n  return FILES\.includes\(file\) \? stripHunks\(file, inner\) : inner;/.test(fs.readFileSync(require.resolve('./tools/post-asm11-layers'), 'utf8')), '🔴 POST-ASM11 INNER: stripPostAsm11 peels INNER first');
ok(`INNER (${L.INNER.length} swaps, ${innerLayers.join(', ')}): each once, tamper + duplicate refused, exactly the remaining diff, newest in ORDER, peeled first`);

// the ORDER: layers appear grouped, in the declared landing order; the peel walks HUNKS newest-first
const seq = L.HUNKS.map((h) => h.layer).filter((x, i, a) => i === 0 || a[i - 1] !== x);
assert.deepStrictEqual(seq, L.ORDER.filter((x) => seq.includes(x)), '🔴 POST-ASM11: HUNKS are grouped by layer in the declared landing ORDER');
assert.ok(new Set(seq).size === seq.length && L.HUNKS.every((h) => L.ORDER.includes(h.layer)), '🔴 POST-ASM11: every layer is declared once in ORDER');
assert.ok(/for \(let i = HUNKS\.length - 1; i >= 0; i--\)/.test(fs.readFileSync(require.resolve('./tools/post-asm11-layers'), 'utf8')), '🔴 POST-ASM11: the peel walks HUNKS newest-first');
ok(`the landing ORDER (${L.ORDER.join(' → ')}) is declared, HUNKS follow it, and the peel is newest-first`);

// ledgers1 peels the hook FIRST (innermost of every chain); a file the hook does not own passes through
const l1src = fs.readFileSync(require.resolve('./tools/ledgers1-module-inverse'), 'utf8');
const body = l1src.slice(l1src.indexOf('function unapplyLedgerS1Module('));
assert.ok(/^function unapplyLedgerS1Module\(file, src\) \{\n(?:\s*\/\/[^\n]*\n)*\s*src = require\('\.\/post-asm11-layers'\)\.stripPostAsm11\(file, src\);/.test(body), '🔴 POST-ASM11: ledgers1\'s unapply calls the hook FIRST');
assert.strictEqual(L.stripPostAsm11('tb-unowned.js', 'x\n'), 'x\n', 'POST-ASM11: an unowned file passes through');
ok('ledgers1-module-inverse calls the hook first (so every guard peeling ledgers1 peels it innermost); an unowned file passes through');

console.log(`\npost-asm11-layers.guard: OK (${n})`);
