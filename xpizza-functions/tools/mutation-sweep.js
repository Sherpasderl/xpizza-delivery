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

// 🔴 AN EMPTY SELECTION IS NOT A PASS. A --slice that matches nothing reported "0/0 killed" and
// exited 0 — so a sweep that measured NOTHING read as a sweep that found nothing wrong. That happened:
// the script adding a slice failed with a syntax error, wrote no mutants, and the run that followed
// looked clean. Same class as ANCHOR MISSING: a measurement that measured nothing must never be
// reported as evidence.
if (!selected.length) {
  console.error(`mutation-sweep: no mutants matched${slice ? ` --slice=${slice}` : ''} — nothing was measured.`);
  console.error(`  known slices: ${[...new Set(MUTANTS.map((m) => m.slice))].join(', ') || '(none)'}`);
  process.exit(2);
}

if (process.argv.includes('--list')) {
  for (const m of selected) console.log(`${m.slice.padEnd(8)} ${m.id.padEnd(9)} ${m.label}${m.command ? `   [via ${m.command.slice(1).join(' ')}]` : ''}${EQUIVALENT.has(m.id) ? '   [equivalent]' : ''}`);
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

// 🔴 A MUTANT MUST BE RUN AGAINST A SUITE THAT CAN SEE IT. Some live in code only an EMULATOR suite
// exercises (the HTTP endpoint), and `npm test` cannot reach them — so sweeping them with the default
// command would report SURVIVED for every one, and the honest reading of that is not "the code is
// weak" but "the measurement was pointed at the wrong thing". A mutant may name its own command;
// omitting those mutants instead would be worse, because then the count silently covers less than it
// appears to.
const runSuite = (command) => {
  const [cmd, ...args] = command || ['npm', 'test'];
  try {
    /* 🔴 MUTATION_SWEEP TELLS THE SUITE THE TREE IS DELIBERATELY WRONG. The anchor guard reads every
       mutant's `from` out of the source, so while a mutant is applied its own anchor is — correctly —
       missing, and the guard fails. Under the default `npm test` command that failure is a NONZERO
       EXIT, which this harness reads as "the suite noticed", and 101 mutants would have been scored
       KILLED by the guard rather than by any behavioural test. A measurement that reports success
       because of the measuring instrument is worse than no measurement: it is indistinguishable from a
       real kill in the output. The guard still runs — on the pristine tree, below, before any mutant
       is applied — so nothing is lost by silencing it here. */
    /* maxBuffer explicitly, because the default is 1MB and this suite's output is ~216KB and grows with
       every task. Overflowing it throws ENOBUFS, which the catch below would read as "the suite
       noticed" and score a KILL — the measuring instrument manufacturing the result, the same failure
       the MUTATION_SWEEP note above exists to prevent. 64MB is far past any plausible growth. */
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, MUTATION_SWEEP: '1', PATH: `/opt/homebrew/opt/openjdk/bin:${process.env.PATH}` } });
    return { rc: 0, out: '' };
  } catch (e) {
    if (e && e.code === 'ENOBUFS') {
      console.error('mutation-sweep: suite output exceeded maxBuffer — raise it; refusing to score this run');
      process.exit(2);          // never let a harness failure masquerade as a kill
    }
    // The failing suite's own output is the evidence for WHICH assertion noticed — see kills_with.
    return { rc: 1, out: `${(e && e.stdout) || ''}${(e && e.stderr) || ''}` };
  }
};

/* 🔴 EVERY ANCHOR, CHECKED ONCE, AGAINST THE PRISTINE TREE — BEFORE A SINGLE MUTANT IS APPLIED.
   The per-mutant ANCHOR MISSING report below only ever sees the slice being run, which is how one
   mutant sat stale across several tasks of green sweeps. This runs over the WHOLE catalogue regardless
   of slice, and refuses to start rather than reporting counts that a stale anchor has already made
   meaningless. It is also what makes silencing the guard inside the per-mutant run safe. */
{
  const seen = new Map();
  const bad = [];
  for (const m of MUTANTS) {
    const f = m.file;
    if (!seen.has(f)) seen.set(f, readFileSync(join(ROOT, f), 'utf8'));
    const n = seen.get(f).split(m.from).length - 1;
    if (n !== 1) bad.push(`${m.id} (${m.slice}) anchors ${n}x in ${f} — ${m.label}`);
  }
  if (bad.length) {
    console.error(`mutation-sweep: ${bad.length} mutant(s) do not anchor live code exactly once:`);
    for (const b of bad) console.error(`  ${b}`);
    console.error('re-point them before trusting any count from this harness.');
    process.exit(2);
  }
  console.log(`anchors: all ${MUTANTS.length} mutants anchor live code exactly once (pristine tree)`);
}

let killed = 0, drifted = 0; let survived = 0; let missing = 0;
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
  const { rc, out } = runSuite(m.command);
  restoreAll();
  if (rc !== 0) {
    /* 🔴 KILLED IS NOT ENOUGH — IT MUST BE KILLED BY THE RIGHT ASSERTION. A mutant whose anchor moves
       during a refactor can land somewhere adjacent, still die, and keep scoring as a kill while the
       property it was written to defend has quietly lost its guard. That is worse than a missing
       mutant: a gap reads as a gap, but a drifted mutant reads as coverage. It happened here — three
       c4 mutants were re-pointed during T6 and two of them ended up testing a different property.
       `kills_with` records a distinctive fragment of the assertion the mutant is SUPPOSED to trip. The
       anchor guard can only see "missing"; this sees "drifted". Optional per mutant, so it can be
       adopted where it matters most without re-annotating the whole catalogue at once. */
    /* kills_with may be an ARRAY when the property is genuinely guarded in more than one place — then
       ANY of them tripping is a faithful kill. c4-15 is the real case: "confirmed_net_cents records the
       ceiling, not the charge" is asserted for a signed drop AND for the T6 unsigned ceiling, and which
       one fires first is an ordering detail, not a semantic one. Listing both keeps the check honest in
       both directions: it still fails if the mutant starts dying somewhere unrelated, and it does not
       raise a false alarm when one of two real guards is the one that happens to run first. */
    const want = m.kills_with ? [].concat(m.kills_with) : [];
    if (want.length && !want.some((w) => out.includes(w))) {
      drifted++;
      console.log(`  DRIFTED  ${m.id}: ${m.label}`);
      console.log(`           died, but NOT on any recorded assertion: ${JSON.stringify(want)}   <-- 🔴`);
    } else {
      killed++; console.log(`  KILLED   ${m.id}: ${m.label}`);
    }
  }
  else if (EQUIVALENT.has(m.id)) { console.log(`  EQUIVALENT ${m.id}: ${m.label} — ${m.why}`); }
  else { survived++; console.log(`  SURVIVED ${m.id}: ${m.label}   <-- 🔴`); }
}
const equivalents = selected.filter((m) => EQUIVALENT.has(m.id)).length;
console.log(`\n${killed}/${selected.length - equivalents} killed` +
  (equivalents ? ` (+${equivalents} documented equivalent)` : '') +
  (missing ? `  🔴 ${missing} ANCHOR MISSING — re-point before trusting this count` : '') +
  (drifted ? `  🔴 ${drifted} DRIFTED — died on the wrong assertion; the property is no longer guarded` : ''));
process.exit(survived || missing || drifted ? 1 : 0);
