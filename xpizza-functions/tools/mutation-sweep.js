'use strict';
// ---------------------------------------------------------------------------
// THE MUTATION HARNESS — run it, do not take the number on trust.
//
//   node tools/mutation-sweep.js                 # every mutant
//   node tools/mutation-sweep.js --slice=task7   # one slice
//   node tools/mutation-sweep.js --list          # what is in the list, without running it
//
// Every "N/M killed" claim in a commit message on this slice comes from here. A count nobody can
// reproduce is a count, not evidence — this file exists so the claim is checkable from the committed
// tree rather than from a scratch file on the machine that wrote it.
//
// How it works: for each mutant, copy the target file aside, apply ONE textual substitution, run the
// full `npm test`, restore. A non-zero exit means some test noticed — the mutant is KILLED. A zero
// exit means nothing in the suite can tell the difference, which is either a missing test or a
// genuinely equivalent mutation, and the difference between those two is a judgement someone has to
// make and write down (see EQUIVALENT below).
//
// ⚠️ WHILE THIS RUNS, THE WORKING TREE IS MUTATED. Do not edit a file or run the suite alongside it:
// you will read a mutant as if it were the code, and — worse — an edit made while a backup is
// outstanding is silently reverted when that mutant restores. Both happened. The `.bak` on disk is
// the signal in BOTH directions: this harness refuses to start when it finds one, and you should
// refuse to touch the tree when you see one.
//
// An ANCHOR MISSING result is not a pass. It means the code moved out from under the mutant and the
// mutant tested nothing — re-point it at the current source before believing any count.
// ---------------------------------------------------------------------------
const { execFileSync } = require('child_process');
const { copyFileSync, renameSync, readFileSync, writeFileSync, existsSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const MUTANTS = require('./mutation-sweep.mutants.json');

// Mutations nobody can kill, with the reason. Listed rather than quietly excluded: an unkillable
// mutant is a claim about the code's shape, and a claim belongs in writing where it can be argued
// with. Each of these must state WHY no input can distinguish the two behaviours.
const EQUIVALENT = new Set(MUTANTS.filter((m) => m.equivalent).map((m) => m.id));

// 🔴 IDS MUST BE UNIQUE ACROSS SLICES. The equivalence exemption is keyed by id, so a collision
// silently hands one slice's "no input can distinguish this" to an unrelated mutant in another —
// a survivor reported as expected. Checked here rather than trusted, because the whole point of
// this file is that its numbers are checkable.
{
  const ids = MUTANTS.map((m) => m.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) throw new Error(`mutation-sweep: duplicate mutant ids ${[...new Set(dupes)].join(', ')} — an equivalence exemption would leak between them`);
}

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const slice = arg('slice');
const selected = MUTANTS.filter((m) => !slice || m.slice === slice);

if (process.argv.includes('--list')) {
  for (const m of selected) console.log(`${m.slice.padEnd(8)} ${m.id.padEnd(4)} ${m.label}${EQUIVALENT.has(m.id) ? '   [equivalent]' : ''}`);
  console.log(`\n${selected.length} mutants${slice ? ` in slice ${slice}` : ''}`);
  process.exit(0);
}

// 🔴 A KILLED RUN MUST NOT LEAVE A MUTANT IN THE TREE. This harness edits real source files, so an
// interrupted run (Ctrl-C, a shell timeout, a crash) used to leave the last mutation applied and its
// backup orphaned — and the next sweep then measured a corrupted tree while reporting a number that
// looked ordinary. That happened: a timed-out run left `readSource` returning a null revision, the
// full suite still passed, and the sweep afterwards was measuring the wrong code.
//
// Two guards. First: refuse to start if a stray .bak exists — its presence is evidence a previous run
// died mid-mutation, and the right move is to look at it, never to write over it.
const STRAY = MUTANTS.map((m) => `${join(ROOT, m.file)}.bak`).filter((b) => existsSync(b));
if (STRAY.length) {
  console.error('mutation-sweep: refusing to run — a previous sweep died mid-mutation and left backups behind:');
  for (const b of STRAY) console.error(`  ${b}  → compare it against ${b.replace(/\.bak$/, '')} and restore by hand`);
  process.exit(2);
}

// Second: restore on the way out, however we leave. The `restore` list holds at most one entry, but
// it is a list because "at most one" is exactly the kind of assumption that stops being true.
const restore = [];
const restoreAll = () => { while (restore.length) { const t = restore.pop(); try { renameSync(`${t}.bak`, t); } catch (_) { /* already restored */ } } };
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restoreAll(); process.exit(130); });
process.on('uncaughtException', (e) => { restoreAll(); console.error(e); process.exit(1); });

const runSuite = () => {
  try {
    execFileSync('npm', ['test'], { cwd: ROOT, stdio: 'ignore' });
    return 0;
  } catch (_) { return 1; }
};

let killed = 0; let survived = 0; let missing = 0;
for (const m of selected) {
  const target = join(ROOT, m.file);
  const src = readFileSync(target, 'utf8');
  if (!src.includes(m.from)) {
    missing++;
    console.log(`  !! ${m.id} ANCHOR MISSING (tests nothing): ${m.label}`);
    continue;
  }
  copyFileSync(target, `${target}.bak`);
  restore.push(target);
  writeFileSync(target, src.replace(m.from, m.to));
  const rc = runSuite();
  restoreAll();
  if (rc !== 0) { killed++; console.log(`  KILLED   ${m.id}: ${m.label}`); }
  else if (EQUIVALENT.has(m.id)) { console.log(`  EQUIVALENT ${m.id}: ${m.label} — ${m.why}`); }
  else { survived++; console.log(`  SURVIVED ${m.id}: ${m.label}   <-- 🔴`); }
}
const equivalents = selected.filter((m) => EQUIVALENT.has(m.id)).length;
console.log(`\n${killed}/${selected.length - equivalents} killed` +
  (equivalents ? ` (+${equivalents} documented equivalent)` : '') +
  (missing ? `  🔴 ${missing} ANCHOR MISSING — re-point before trusting this count` : ''));
process.exit(survived || missing ? 1 : 0);
