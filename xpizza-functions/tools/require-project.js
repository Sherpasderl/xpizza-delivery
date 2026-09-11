'use strict';
// ---------------------------------------------------------------------------
// THE PROJECT GUARD — which Firebase project is this CLI about to write to?
//
// 🔴 THE LANDMINE THIS CLOSES. Every tool here called
//     admin.initializeApp({ credential: applicationDefault() })
// with NO projectId, so firebase-admin resolved the project from the ambient gcloud default. That
// default is a machine-level setting nothing in this repo controls, and it had drifted to another
// project entirely. The migration's DRY RUN read that project quite happily — a stale
// active_version, a "missing" meta/source — and reported it as fact. An --apply would have published
// a catalog into the wrong project while real production sat un-migrated, and the only evidence
// would have been a dry-run whose output looked merely surprising.
//
// So the project is never INFERRED. It is stated by the operator and checked against the repo:
//
//   • .firebaserc IS the source of truth. One place already says which project this repo deploys to;
//     a second literal in a tool is a fact that can drift from it, which is the whole disease.
//   • THE OPERATOR MUST STATE IT — `--project <id>`, or GOOGLE_CLOUD_PROJECT. Defaulting to the
//     .firebaserc value would be convenient and would re-open the hole from the other side: the run
//     would still succeed without anyone having looked at which database it was about to touch.
//   • MISSING, UNPARSEABLE, AMBIGUOUS OR MISMATCHED ALL REFUSE, for dry runs exactly as for writes.
//     A dry run that reads the wrong project is not harmless — it is a confident wrong answer, and
//     acting on it is what an --apply is.
//
// The guard runs BEFORE initializeApp in every caller, so a refusal cannot have touched anything: no
// credential is resolved, no client is constructed, no read is issued.
// ---------------------------------------------------------------------------
const { readFileSync } = require('fs');
const { join } = require('path');

const FIREBASERC = join(__dirname, '..', '.firebaserc');

function refuse(detail) {
  const e = new Error(`project_guard_refused: ${detail}`);
  e.code = 'project_guard_refused';
  throw e;
}

// The project this repo deploys to, from the file that already knows.
function expectedProject(rcPath = FIREBASERC) {
  let raw;
  try { raw = readFileSync(rcPath, 'utf8'); } catch (_) { refuse(`cannot read ${rcPath} — the repo's own project is unknown, so nothing can be checked against it`); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { refuse(`${rcPath} is not valid JSON`); }
  const def = parsed && parsed.projects && parsed.projects.default;
  if (typeof def !== 'string' || !def) refuse(`${rcPath} declares no projects.default`);
  return def;
}

// EVERY DECLARED SOURCE, COLLECTED — not resolved between.
//
// 🔴 THIS USED TO PICK A WINNER, AND CALLED THAT "REFUSING AMBIGUITY". It read the last --project on
// the line and `GOOGLE_CLOUD_PROJECT || GCLOUD_PROJECT`, then compared those two. So
// `--project a --project b` silently took b, and a stale GCLOUD_PROJECT disagreeing with
// GOOGLE_CLOUD_PROJECT was never looked at at all. It happened to resolve to the right project in
// both cases — which is the worst way to be correct, because the property being advertised was
// simply not there, and the next refactor of the precedence order would have removed it silently.
//
// A guard against untrustworthy ambient values must not itself have a rule for which untrustworthy
// ambient value wins. So: gather them all, and let DISAGREEMENT be the answer rather than an input to
// one. Each is reported with the name it was given under, because an operator staring at a refusal
// needs to know which of the four to go and fix.
//
// An empty environment variable is NOT a declaration — that is how a shell says "unset".
function declaredProjects({ argv = process.argv, env = process.env } = {}) {
  const found = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) refuse('--project was given with no value');
      found.push({ source: '--project', value: next });
    } else if (a.startsWith('--project=')) {
      const v = a.slice('--project='.length);
      if (!v) refuse('--project= was given with no value');
      found.push({ source: '--project=', value: v });
    }
  }
  for (const name of ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) {
    if (env[name]) found.push({ source: name, value: env[name] });
  }
  return found;
}

// One agreed value, or a refusal. Never a winner.
function statedProject(opts = {}) {
  const found = declaredProjects(opts);
  const distinct = [...new Set(found.map((f) => f.value))];
  if (distinct.length > 1) {
    const where = found.map((f) => `${f.source}=${f.value}`).join(', ');
    refuse(`the project is stated more than once and the statements disagree (${where}); `
      + 'state it once, or clear the one that is stale');
  }
  return distinct.length === 1 ? distinct[0] : null;
}

// THE GUARD. Returns the project id, or throws. Never returns a project it was not given.
function resolveProject({ argv, env, rcPath } = {}) {
  const expected = expectedProject(rcPath);
  const stated = statedProject({ argv, env });
  if (!stated) {
    refuse(`no project was stated. Pass --project ${expected} (or set GOOGLE_CLOUD_PROJECT). `
      + 'This is deliberate: without it the project comes from whatever gcloud happens to be pointed at, '
      + 'which is how a catalog nearly went into the wrong database.');
  }
  if (stated !== expected) {
    refuse(`refusing to run against ${stated} — this repo deploys to ${expected} (.firebaserc). `
      + 'If the move is intended, change .firebaserc; do not pass a different project.');
  }
  return stated;
}

// What a CLI calls. Announces the database before anything touches it — the operator should be able
// to see which project a run is about to write to without reading the code.
//
// It EXITS rather than throwing, because the audience is different: resolveProject throws so a test
// can assert which rule fired, but an operator running a cutover at speed needs the reason on one
// line, not a stack trace with the reason somewhere in it. Exit code 2 — distinct from the 1 a tool
// uses for its own failures, so a script can tell "you pointed it at the wrong database" apart from
// "the work failed".
function requireProject(opts = {}) {
  let projectId;
  try {
    projectId = resolveProject(opts);
  } catch (e) {
    console.error(`\nREFUSED — ${String((e && e.message) || e).replace(/^project_guard_refused: /, '')}\n`);
    console.error('project_guard_refused: nothing was read and nothing was written.\n');
    process.exit(2);
  }
  console.log(`project: ${projectId}  (stated explicitly and matched against .firebaserc)`);
  return projectId;
}

module.exports = { requireProject, resolveProject, expectedProject, statedProject, declaredProjects, FIREBASERC };
