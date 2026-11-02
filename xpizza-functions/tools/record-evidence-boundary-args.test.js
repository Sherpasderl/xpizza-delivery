'use strict';
// PLAN-brand-agnostic-convergence §3-E (La Musa certification prerequisite): the WRITE-ONCE boundary CLI must be told exactly ONE
// restaurant. An absent `--rid`, the `--rid=<rid>` form (never parsed — it left rid null), an empty, flag-like or repeated rid, or
// any unrecognised argument is REFUSED with exit 2 before any client exists; a null rid must never fan the boundary across the
// whole record. Spawned for real, the same way identity-integrity-guards spawns it: no credential resolves, both data hosts are a
// dead port, never --apply. Each failure message starts with its cell label. Run: node tools/record-evidence-boundary-args.test.js
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RECORD = 'tools/identity-boundary-records/2026-10-09.json';
const SCRUB = ['FUNCTIONS_EMULATOR', 'FIREBASE_FIRESTORE_EMULATOR_ADDRESS', 'FIREBASE_EMULATOR_HUB', 'XPIZZA_EMU_OFFSET', 'XPIZZA_EMU_SERVICES',
  'XPIZZA_EMU_DEAD', 'XPIZZA_EMU_RUN', 'FUNCTION_TARGET', 'FIREBASE_CONFIG', 'FB_DATABASE_URL', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT'];
function cli(args, timeout = 20000) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  Object.assign(env, { GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/never', FIRESTORE_EMULATOR_HOST: '127.0.0.1:1', FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1' });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'record-evidence-boundary.js'), '--project', 'xpizza-delivery', ...args], { cwd: ROOT, encoding: 'utf8', timeout, env, killSignal: 'SIGKILL' });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

let pass = 0; const fails = [];
function cell(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { fails.push(name); console.error(`  ✗ ${String((e && e.message) || e).split('\n')[0]}`); } }
const refused = (L, args, re) => {
  const r = cli(args);
  assert.strictEqual(r.code, 2, `${L}: exit 2 (got ${r.code}) — ${r.out.replace(/\s+/g, ' ').slice(0, 200)}`);
  assert.match(r.out, /record-evidence-boundary: REFUSED — /, `${L}: a REFUSED line`);
  if (re) assert.match(r.out, re, `${L}: the refusal names the cause`);
  assert.ok(!/DRY RUN|APPLY —/.test(r.out), `${L}: refused BEFORE the run header (no client, no read)`);
};

cell('REB-RID-ABSENT', () => refused('REB-RID-ABSENT', ['--from-rollout-record', RECORD], /--rid/));
cell('REB-RID-EQUALS-FORM', () => refused('REB-RID-EQUALS-FORM', ['--from-rollout-record', RECORD, '--rid=la_musa'], /--rid=/));
cell('REB-RID-NO-VALUE', () => refused('REB-RID-NO-VALUE', ['--from-rollout-record', RECORD, '--rid'], /--rid/));
cell('REB-RID-FLAG-AS-VALUE', () => refused('REB-RID-FLAG-AS-VALUE', ['--from-rollout-record', RECORD, '--rid', '--apply'], /--rid/));
cell('REB-RID-EMPTY', () => refused('REB-RID-EMPTY', ['--from-rollout-record', RECORD, '--rid', ''], /--rid/));
cell('REB-RID-REPEATED', () => refused('REB-RID-REPEATED', ['--from-rollout-record', RECORD, '--rid', 'la_musa', '--rid', 'x_pizza'], /more than once/));
cell('REB-RECORD-EQUALS-FORM', () => refused('REB-RECORD-EQUALS-FORM', [`--from-rollout-record=${RECORD}`, '--rid', 'la_musa'], /--from-rollout-record/));
cell('REB-UNKNOWN-ARG', () => refused('REB-UNKNOWN-ARG', ['--from-rollout-record', RECORD, '--rid', 'la_musa', '--aply'], /unrecognised argument/));
cell('REB-RECORD-ABSENT-UNCHANGED', () => {
  const L = 'REB-RECORD-ABSENT-UNCHANGED';
  const r = cli(['--rid', 'la_musa']);
  assert.strictEqual(r.code, 2, `${L}: exit 2 (got ${r.code})`);
  assert.ok(r.out.includes("record-evidence-boundary: REFUSED — --from-rollout-record <file> is required (G0 is never derived from today's pointer)"), `${L}: the existing refusal text is unchanged`);
});
cell('REB-ONE-RID-PROCEEDS', () => {
  const L = 'REB-ONE-RID-PROCEEDS';
  // non-vacuity: a single space-separated rid passes the arguments and reaches client construction, where the deliberately
  // nonexistent credential stops it (no credential ever resolves here, so nothing is read)
  const r = cli(['--from-rollout-record', RECORD, '--rid', 'la_musa'], 15000);
  assert.notStrictEqual(r.code, 2, `${L}: not refused as an argument error (exit ${r.code})`);
  assert.ok(!/REFUSED — /.test(r.out), `${L}: no REFUSED line`);
  assert.ok(/credential/i.test(r.out), `${L}: it got as far as the credential (got ${r.out.replace(/\s+/g, ' ').slice(0, 200)})`);
});

cell('REB-MAIN-PASSES-ONE-RID', () => {
  const L = 'REB-MAIN-PASSES-ONE-RID';
  // the accepted run stops at the credential before run(), so pin the wiring in source: the rid run() receives is the parsed
  // one, and no other reader of --rid exists (a rid that fell back to null would fan out across the record)
  const src = require('fs').readFileSync(path.join(ROOT, 'tools', 'record-evidence-boundary.js'), 'utf8').replace(/\/\/.*$/gm, '');
  const main = src.slice(src.indexOf('if (require.main === module)'));
  assert.match(main, /const \{ file, rid, apply \} = args;/, `${L}: main takes rid from the strict parse`);
  assert.match(main, /record: JSON\.parse\(fs\.readFileSync\(file, 'utf8'\)\), rid, apply \}\)/, `${L}: and hands exactly that rid to run()`);
  assert.ok(!/indexOf\('--rid'\)|argv\.includes\('--apply'\)|\bval\(/.test(src), `${L}: no second reader of the arguments`);
});

console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nrecord-evidence-boundary-args: OK (${pass})`);
process.exit(fails.length ? 1 : 0);
