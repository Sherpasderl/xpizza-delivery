'use strict';
// PLAN-brand-agnostic-convergence §3-E (advisor ruling c): the cert-path tools spell the restaurant two ways — backfill-identities,
// bootstrap-identity and rollback-version take `--rid=<rid>`; record-evidence-boundary takes `--rid <rid>`. The runbooks depend on
// both, so they are not unified; instead NO tool may run with the other tool's form. Each `=`-form tool refuses a bare `--rid`
// (the space form) with exit 1 and «use --rid=<rid>», BEFORE any client exists (the boundary tool's refusal of `--rid=` is
// pinned in record-evidence-boundary-args.test.js). Spawned for real with a nonexistent credential and dead-port hosts.
// Each failure message starts with its cell label. Run: node tools/cert-rid-form.test.js
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { expectedProject } = require('./require-project');

const env = { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/never', FIRESTORE_EMULATOR_HOST: '127.0.0.1:1', FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:1', GOOGLE_CLOUD_PROJECT: '', GCLOUD_PROJECT: '' };
const cli = (tool, args) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, tool), ...args], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

let pass = 0; const fails = [];
function cell(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { fails.push(name); console.error(`  ✗ ${name}: ${String((e && e.message) || e).split('\n')[0]}`); } }

for (const tool of ['backfill-identities.js', 'bootstrap-identity.js', 'rollback-version.js']) {
  cell(`RF-SPACE-FORM-REFUSED-${tool}`, () => {
    for (const args of [['--rid', 'la_musa'], ['--rid'], ['--rid=la_musa', '--rid', 'x_pizza']]) {
      const r = cli(tool, [...args, '--project', expectedProject()]);
      assert.strictEqual(r.code, 1, `${JSON.stringify(args)}: exit 1 (got ${r.code}) — ${r.out.replace(/\s+/g, ' ').slice(0, 200)}`);
      assert.match(r.out, /REFUSED — .*use --rid=<rid>/, `${JSON.stringify(args)}: the refusal names the right form`);
      assert.ok(!/credential/i.test(r.out), `${JSON.stringify(args)}: refused BEFORE any client (never reached the credential)`);
    }
  });
  cell(`RF-EQUALS-FORM-PROCEEDS-${tool}`, () => {
    const r = cli(tool, ['--rid=la_musa', '--project', expectedProject()]);
    assert.ok(!/use --rid=<rid>/.test(r.out), `non-vacuity: the right form is not refused as the wrong one — ${r.out.replace(/\s+/g, ' ').slice(0, 200)}`);
  });
}

// Codex cert r1 #1: a repeated --rid= silently picked the FIRST; unknown flags were ignored, so `--apply --dry-run` WROTE and
// rollback `--to=v2 --dry-run` moved the pointer. Every unknown argument, a repeated option and an empty value are refused
// (exit 1 — exit 2 stays the project guard's alone in these tools) BEFORE any client.
for (const [tool, extra] of [['backfill-identities.js', []], ['bootstrap-identity.js', []], ['rollback-version.js', ['--to=v2']]]) {
  cell(`RF-STRICT-ARGS-${tool}`, () => {
    for (const args of [['--rid=la_musa', '--rid=x_pizza'], ['--rid=la_musa', '--apply', '--dry-run'], ['--rid=la_musa', '--dryrun'], ['--rid=la_musa', '--to=v2', '--to=v3'],
                        ['--rid=', '--apply'], ['--rid=la_musa', 'positional'], ['--rid=la_musa', '--apply', '--apply']]) {
      const a = tool === 'rollback-version.js' ? args.filter((x) => x !== '--apply') : args.filter((x) => !x.startsWith('--to='));
      if (tool === 'rollback-version.js' && a.length === args.length && args.includes('--apply')) continue;
      const r = cli(tool, [...a, ...(tool === 'rollback-version.js' && !a.some((x) => x.startsWith('--to=')) ? extra : []), '--project', expectedProject()]);
      assert.strictEqual(r.code, 1, `${JSON.stringify(a)}: exit 1 (got ${r.code}) — ${r.out.replace(/\s+/g, ' ').slice(0, 200)}`);
      assert.match(r.out, /REFUSED — /, `${JSON.stringify(a)}: a REFUSED line`);
      assert.ok(!/credential/i.test(r.out), `${JSON.stringify(a)}: refused BEFORE any client`);
    }
  });
}
cell('RF-STRICT-ARGS-APPLY-NOT-ACCEPTED-BY-ROLLBACK', () => {
  const r = cli('rollback-version.js', ['--rid=la_musa', '--to=v2', '--apply', '--project', expectedProject()]);
  assert.ok(r.code === 1 && /REFUSED — /.test(r.out), `rollback has no --apply: refused (got ${r.code})`);
});

console.log(fails.length ? `\nFAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\ncert-rid-form: OK (${pass})`);
process.exit(fails.length ? 1 : 0);
