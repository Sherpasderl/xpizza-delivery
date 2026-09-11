'use strict';
// THE PROJECT GUARD — a CLI must never infer which database it is about to write to.
//
// 🔴 WHAT THIS EXISTS FOR. Every tool called admin.initializeApp({ credential: applicationDefault() })
// with no projectId, so firebase-admin took the project from the ambient gcloud default — a
// machine-level setting nothing in this repo controls, which had drifted to a different project. The
// migration's DRY RUN read that project and reported what it found as fact: a stale active_version, a
// "missing" meta/source. An --apply would have published a catalog into the wrong project while real
// production sat un-migrated.
//
// Caught at the dry run, by a human noticing the output looked wrong. That is not a control.
//
// Run: node catalog/project-guard.test.js
const assert = require('assert');
const { execFileSync } = require('child_process');
const { readFileSync, readdirSync, writeFileSync, mkdtempSync } = require('fs');
const { join, dirname } = require('path');
const { tmpdir } = require('os');
const { resolveProject, expectedProject, FIREBASERC } = require('../tools/require-project');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('project-guard: FAILED — exited without completing'); process.exitCode = 1; } });

const ROOT = join(__dirname, '..');
const TOOLS = join(ROOT, 'tools');
const stripComments = (src) => src.split('\n')
  .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, ''))
  .join('\n');

// ── 1. THE GUARD ITSELF — the real arg parse, the real .firebaserc ──────────────────────────────
{
  const EXPECTED = expectedProject();
  assert.strictEqual(EXPECTED, JSON.parse(readFileSync(FIREBASERC, 'utf8')).projects.default,
    'the guard must read the repo\'s own .firebaserc, not a literal of its own');

  // THE REASON IS PART OF THE CONTRACT, not decoration. An operator who stated the project in four
  // places and is told "no project was stated" will go and state it a fifth time; what they need is
  // WHICH of the four is stale. It is also what makes these cases falsifiable: without pinning the
  // reason, deleting the disagreement rule still "refuses" — two distinct values collapse to null and
  // fall into the nothing-stated branch — so the test passes while the rule it names is gone. That is
  // exactly how the first version of this suite let a precedence bug through.
  const refuses = (label, opts, because) => assert.throws(() => resolveProject(opts), (e) => {
    assert.strictEqual(e.code, 'project_guard_refused', `${label}: got ${e.code}`);
    if (because) assert.match(e.message, because, `${label}: refused for the WRONG reason — ${e.message}`);
    return true;
  }, `🔴 ${label} was ACCEPTED`);
  const DISAGREE = /stated more than once and the statements disagree/;
  const NOT_STATED = /no project was stated/;
  const WRONG = /refusing to run against/;

  refuses('no project stated at all', { argv: ['node', 'x'], env: {} }, NOT_STATED);
  refuses('a different project by flag', { argv: ['node', 'x', '--project', 'lamusa-social'], env: {} }, WRONG);
  refuses('a different project by environment', { argv: ['node', 'x'], env: { GOOGLE_CLOUD_PROJECT: 'lamusa-social' } }, WRONG);
  refuses('a different project by the OTHER environment name', { argv: ['node', 'x'], env: { GCLOUD_PROJECT: 'lamusa-social' } }, WRONG);
  refuses('--project with no value', { argv: ['node', 'x', '--project'], env: {} });
  refuses('--project= with no value', { argv: ['node', 'x', '--project='], env: {} });
  // 🔴 AMBIGUITY IS A REFUSAL, NOT A PRECEDENCE PUZZLE — and this claim was FALSE when first written.
  // The guard read the LAST --project and `GOOGLE_CLOUD_PROJECT || GCLOUD_PROJECT`, so a repeated flag
  // silently took the later one and a stale GCLOUD_PROJECT disagreeing with GOOGLE_CLOUD_PROJECT was
  // never compared at all. Both happened to resolve to the right project, which is the worst way to be
  // correct: the advertised property was absent, and only the precedence order was keeping it true.
  //
  // A guard against untrustworthy ambient values must not have a rule for which one wins. Every
  // spelling of disagreement, including the two that used to pass:
  refuses('a flag and an environment that disagree', { argv: ['node', 'x', '--project', EXPECTED], env: { GOOGLE_CLOUD_PROJECT: 'lamusa-social' } }, DISAGREE);
  refuses('a flag and the OTHER environment alias that disagree', { argv: ['node', 'x', '--project', EXPECTED], env: { GCLOUD_PROJECT: 'lamusa-social' } }, DISAGREE);
  refuses('two environment aliases that disagree with each other', { argv: ['node', 'x'], env: { GOOGLE_CLOUD_PROJECT: EXPECTED, GCLOUD_PROJECT: 'lamusa-social' } }, DISAGREE);
  refuses('a repeated --project whose later value is the right one', { argv: ['node', 'x', '--project', 'lamusa-social', '--project', EXPECTED], env: {} }, DISAGREE);
  refuses('a repeated --project whose later value is the wrong one', { argv: ['node', 'x', '--project', EXPECTED, '--project', 'lamusa-social'], env: {} }, DISAGREE);
  refuses('a flag and an = flag that disagree', { argv: ['node', 'x', '--project', EXPECTED, '--project=lamusa-social'], env: {} }, DISAGREE);

  // NON-VACUITY: the correct project must REACH THE WORK, in every spelling an operator would use.
  for (const [label, opts] of [
    ['--project <id>', { argv: ['node', 'x', '--project', EXPECTED], env: {} }],
    ['--project=<id>', { argv: ['node', 'x', `--project=${EXPECTED}`], env: {} }],
    ['GOOGLE_CLOUD_PROJECT', { argv: ['node', 'x'], env: { GOOGLE_CLOUD_PROJECT: EXPECTED } }],
    ['both, agreeing', { argv: ['node', 'x', '--project', EXPECTED], env: { GOOGLE_CLOUD_PROJECT: EXPECTED } }],
    // REPETITION IS NOT DISAGREEMENT. Refusing every repeat would make the guard unusable in a script
    // that exports the variable AND passes the flag — which is what a careful operator does.
    ['all four sources, agreeing', { argv: ['node', 'x', '--project', EXPECTED, `--project=${EXPECTED}`], env: { GOOGLE_CLOUD_PROJECT: EXPECTED, GCLOUD_PROJECT: EXPECTED } }],
    ['an EMPTY environment variable is not a declaration', { argv: ['node', 'x', '--project', EXPECTED], env: { GOOGLE_CLOUD_PROJECT: '', GCLOUD_PROJECT: '' } }],
  ]) {
    assert.strictEqual(resolveProject(opts), EXPECTED, `🔴 the correct project must pass: ${label}`);
  }

  // And the repo's own answer is fail-closed too: a missing or empty .firebaserc leaves nothing to
  // check against, which is a refusal rather than a free pass.
  const tmp = mkdtempSync(join(tmpdir(), 'pg-'));
  refuses('an absent .firebaserc', { argv: ['node', 'x', '--project', EXPECTED], env: {}, rcPath: join(tmp, 'nope.json') });
  writeFileSync(join(tmp, 'empty.json'), '{}');
  refuses('a .firebaserc declaring no default', { argv: ['node', 'x', '--project', EXPECTED], env: {}, rcPath: join(tmp, 'empty.json') });
  writeFileSync(join(tmp, 'bad.json'), 'not json');
  refuses('an unparseable .firebaserc', { argv: ['node', 'x', '--project', EXPECTED], env: {}, rcPath: join(tmp, 'bad.json') });
  ok(`the guard refuses 14 ways to not-state ${EXPECTED} — including every spelling of disagreement — and accepts it in all 6 an operator would use`);
}

// ── 2. A LINT OVER THE CURRENT INIT SPELLING — NOT A PROOF THAT NOTHING ELSE CONNECTS ───────────
//
// 🔴 WHAT CARRIES THE GUARANTEE IS THE EIGHT GUARDED TOOLS, not this scan. Stated plainly because the
// scan reads like more than it is:
//
//   • it matches the literal text `admin.initializeApp(` in immediate tools/*.js files, so an aliased
//     or destructured init, a modular `initializeApp` import, a getFirestore() on an app someone else
//     created, a direct GCP/REST client, a spawned `gcloud`, a .mjs/.cjs tool or a nested script all
//     walk past it;
//   • for a file that DOES match it checks the first occurrence and accepts `projectId: PROJECT_ID`
//     anywhere in the file, so it cannot prove execution order or that the RIGHT init is the guarded
//     one — only that both strings are present, in that order, in the text.
//
// It earns its place anyway: it fails when a NINTH tool is added with today's spelling and no guard,
// which is the realistic regression. That is defense in depth, and it is the same census-as-lint
// boundary this repo has settled on repeatedly — the code is the airtight part, the scan is a strong
// lint that a different spelling can evade.
{
  const opensAConnection = [];
  for (const f of readdirSync(TOOLS).filter((x) => x.endsWith('.js'))) {
    const code = stripComments(readFileSync(join(TOOLS, f), 'utf8'));
    if (!code.includes('admin.initializeApp(')) continue;
    opensAConnection.push(f);
    const guard = code.indexOf('requireProject()');
    const init = code.indexOf('admin.initializeApp(');
    assert.ok(guard > 0, `🔴 ${f} opens a Firebase connection (in today's spelling) and never states which project`);
    assert.ok(guard < init, `🔴 ${f} resolves its project AFTER initializeApp — too late to refuse`);
    assert.ok(/projectId:\s*PROJECT_ID/.test(code),
      `🔴 ${f} must pass projectId explicitly; without it firebase-admin falls back to the ambient gcloud default`);
    assert.ok(!/applicationDefault\(\)\s*\}\)/.test(code.replace(/projectId:[^,}]*/g, '')),
      `${f}: sanity — the init call must still carry a credential`);
  }
  assert.ok(opensAConnection.length >= 8,
    `non-vacuity: the sweep must find the tools that connect (found ${opensAConnection.length})`);
  ok(`lint (bounded — the literal \`admin.initializeApp(\` in tools/*.js, order by text position): all ${opensAConnection.length} matches state their project first; the GUARANTEE is those ${opensAConnection.length} guarded tools, not this scan`);
}

// ── 3. THE CLIs ACTUALLY REFUSE — spawned, not reasoned about ───────────────────────────────────
// The guard is only worth what the CLI does with it. These run the real files.
//
// Safe by construction, twice over: a wrong project is refused before any credential is resolved,
// and GOOGLE_APPLICATION_CREDENTIALS is pointed at a path that does not exist, so even a
// mis-wired guard could not reach a real project. No --apply, no publish flag, anywhere.
{
  const MUTATING = ['migrate-catalog-display.js', 'publish-version.js', 'rollback-version.js', 'seed-source-store.js',
    'seed-catalog.js', 'backfill-snapshot.js', 'seed-owner.js', 'verify-catalog.js'];
  const run = (file, args, env) => {
    try {
      const out = execFileSync(process.execPath, [join(TOOLS, file), ...args], {
        cwd: ROOT, encoding: 'utf8', timeout: 20000,
        env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/never', GOOGLE_CLOUD_PROJECT: '', GCLOUD_PROJECT: '', ...env },
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status === undefined ? -1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };
  for (const file of MUTATING) {
    for (const [label, args] of [['no project', []], ['the wrong project', ['--project', 'lamusa-social']]]) {
      const r = run(file, args, {});
      // Exit 2 SPECIFICALLY: distinct from the 1 a tool uses for its own failures, so "you pointed it
      // at the wrong database" is distinguishable from "the work failed" by a script and by a person.
      assert.strictEqual(r.code, 2, `🔴 ${file} with ${label} exited ${r.code} — a project refusal must be exit 2`);
      assert.match(r.out, /project_guard_refused/,
        `🔴 ${file} with ${label} failed for some OTHER reason; the guard must be what stopped it:\n${r.out.slice(0, 300)}`);
      // A refusal cannot have got as far as a client: these only appear once firebase-admin is live.
      assert.ok(!/Firestore|database\(\)|ENOENT.*nonexistent/i.test(r.out),
        `🔴 ${file} with ${label} reached the SDK before refusing:\n${r.out.slice(0, 300)}`);
    }
  }
  ok(`all ${MUTATING.length} CLIs refuse both an absent and a wrong project — spawned for real, exiting 2 before any client exists`);
}

// ── 4. AND THE CORRECT PROJECT GETS PAST THE GUARD ──────────────────────────────────────────────
// Non-vacuity for the spawn half: with the right project the guard must NOT be what stops the run.
// verify-catalog is chosen deliberately — it is the only read-only tool of the eight, so getting
// past the guard here cannot write anything. With no usable credential it fails at the SDK instead,
// which is precisely the evidence wanted: the guard let it through.
{
  const r = (() => {
    try {
      execFileSync(process.execPath, [join(TOOLS, 'verify-catalog.js'), '--project', expectedProject()], {
        cwd: ROOT, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/never', GOOGLE_CLOUD_PROJECT: '', GCLOUD_PROJECT: '' },
      });
      return { code: 0, out: '' };
    } catch (e) { return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
  })();
  assert.ok(!/project_guard_refused/.test(r.out),
    `🔴 the CORRECT project was refused — the guard would block the cutover itself:\n${r.out.slice(0, 300)}`);
  assert.match(r.out, new RegExp(`project: ${expectedProject()}`),
    '🔴 the run must announce which database it is about to touch, before touching it');
  ok(`the correct project passes the guard and announces itself ("project: ${expectedProject()}"), then fails only for want of a credential`);
}

FINISHED = true;
console.log(`project-guard: OK (${n})`);
