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

  const refuses = (label, opts) => assert.throws(() => resolveProject(opts), (e) => {
    assert.strictEqual(e.code, 'project_guard_refused', `${label}: got ${e.code}`);
    return true;
  }, `🔴 ${label} was ACCEPTED`);

  refuses('no project stated at all', { argv: ['node', 'x'], env: {} });
  refuses('a different project by flag', { argv: ['node', 'x', '--project', 'lamusa-social'], env: {} });
  refuses('a different project by environment', { argv: ['node', 'x'], env: { GOOGLE_CLOUD_PROJECT: 'lamusa-social' } });
  refuses('a different project by the OTHER environment name', { argv: ['node', 'x'], env: { GCLOUD_PROJECT: 'lamusa-social' } });
  refuses('--project with no value', { argv: ['node', 'x', '--project'], env: {} });
  refuses('--project= with no value', { argv: ['node', 'x', '--project='], env: {} });
  // 🔴 AMBIGUITY IS A REFUSAL, NOT A PRECEDENCE PUZZLE. A flag and an environment that disagree is
  // exactly the situation that produced this bug: two sources for one fact, one of them invisible.
  refuses('a flag and an environment that disagree', { argv: ['node', 'x', '--project', EXPECTED], env: { GOOGLE_CLOUD_PROJECT: 'lamusa-social' } });

  // NON-VACUITY: the correct project must REACH THE WORK, in every spelling an operator would use.
  for (const [label, opts] of [
    ['--project <id>', { argv: ['node', 'x', '--project', EXPECTED], env: {} }],
    ['--project=<id>', { argv: ['node', 'x', `--project=${EXPECTED}`], env: {} }],
    ['GOOGLE_CLOUD_PROJECT', { argv: ['node', 'x'], env: { GOOGLE_CLOUD_PROJECT: EXPECTED } }],
    ['both, agreeing', { argv: ['node', 'x', '--project', EXPECTED], env: { GOOGLE_CLOUD_PROJECT: EXPECTED } }],
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
  ok(`the guard refuses 9 ways to not-state ${EXPECTED}, and accepts it in all 4 spellings an operator would use`);
}

// ── 2. EVERY CLI THAT OPENS A CONNECTION IS GUARDED ─────────────────────────────────────────────
// Deny-by-default over the whole tools directory rather than a list: the gap was in SEVEN tools and
// the report named four, so a list is exactly what must not be trusted here.
{
  const opensAConnection = [];
  for (const f of readdirSync(TOOLS).filter((x) => x.endsWith('.js'))) {
    const code = stripComments(readFileSync(join(TOOLS, f), 'utf8'));
    if (!code.includes('admin.initializeApp(')) continue;
    opensAConnection.push(f);
    const guard = code.indexOf('requireProject()');
    const init = code.indexOf('admin.initializeApp(');
    assert.ok(guard > 0, `🔴 ${f} opens a Firebase connection and never states which project`);
    assert.ok(guard < init, `🔴 ${f} resolves its project AFTER initializeApp — too late to refuse`);
    assert.ok(/projectId:\s*PROJECT_ID/.test(code),
      `🔴 ${f} must pass projectId explicitly; without it firebase-admin falls back to the ambient gcloud default`);
    assert.ok(!/applicationDefault\(\)\s*\}\)/.test(code.replace(/projectId:[^,}]*/g, '')),
      `${f}: sanity — the init call must still carry a credential`);
  }
  assert.ok(opensAConnection.length >= 8,
    `non-vacuity: the sweep must find the tools that connect (found ${opensAConnection.length})`);
  ok(`${opensAConnection.length} tools open a Firebase connection; every one states its project BEFORE the connection exists`);
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
