'use strict';
// PLAN-photos-public-bucket-config r5 §1 — the functions PREDEPLOY photos check, spawned exactly as firebase.json runs it, over temp
// functions roots: clean → 0; missing / drifted / invalid / no private entry for the DEPLOYING project / no project → 1; bucket values
// are never printed. Run: node tools/platform-photos-check.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const TOOL = path.join(__dirname, 'platform-photos-check.js');
const SECRETISH = 'tb-priv-value-never-printed';
const cfg = (over = {}) => JSON.stringify({ schema: 1, public_bucket: { 'tb-proj': '' }, private_bucket: { 'tb-proj': SECRETISH }, ...over }, null, 2) + '\n';

// a temp <repo>/{platform,fn/platform} pair; returns the functions root
function tree({ canon = cfg(), bundled = canon } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-pcheck-'));
  const fn = path.join(repo, 'fn');
  fs.mkdirSync(path.join(repo, 'platform'), { recursive: true }); fs.mkdirSync(path.join(fn, 'platform'), { recursive: true });
  if (canon !== null) fs.writeFileSync(path.join(repo, 'platform', 'photos.json'), canon);
  if (bundled !== null) fs.writeFileSync(path.join(fn, 'platform', 'photos.json'), bundled);
  return { repo, fn };
}
const run = (args, env = {}) => {
  const e = { ...process.env, ...env }; delete e.NODE_OPTIONS;
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: e });
};
const cases = [];
const check = (label, t, args, want, env) => {
  try {
    const r = run(args.map((a) => (a === '<fn>' ? t.fn : a)), env);
    assert.strictEqual(r.status, want, `${label}: exit ${r.status} (want ${want})\n${r.stdout}${r.stderr}`);
    assert.ok(!`${r.stdout}${r.stderr}`.includes(SECRETISH), `🔴 PCHECK-NEVER-PRINTS-VALUES ${label}`);
    cases.push(label);
  } finally { fs.rmSync(t.repo, { recursive: true, force: true }); }
};

check('PCHECK-CLEAN', tree(), ['--root', '<fn>', '--project', 'tb-proj'], 0);
check('PCHECK-CLEAN-PROJECT-FROM-GCLOUD_PROJECT', tree(), ['--root', '<fn>'], 0, { GCLOUD_PROJECT: 'tb-proj' });
check('PCHECK-PUBLIC-EMPTY-PASSES (codex r2 P2)', tree(), ['--root', '<fn>', '--project', 'tb-proj'], 0);
check('PCHECK-NO-PROJECT', tree(), ['--root', '<fn>'], 1, { GCLOUD_PROJECT: '' });
check('PCHECK-BUNDLED-MISSING', tree({ bundled: null }), ['--root', '<fn>', '--project', 'tb-proj'], 1);
check('PCHECK-CANONICAL-MISSING', tree({ canon: null, bundled: cfg() }), ['--root', '<fn>', '--project', 'tb-proj'], 1);
check('PCHECK-DRIFT', tree({ canon: cfg(), bundled: cfg({ public_bucket: { 'tb-proj': 'tb-pub' } }) }), ['--root', '<fn>', '--project', 'tb-proj'], 1);
check('PCHECK-INVALID', tree({ canon: '{"schema":2}\n' }), ['--root', '<fn>', '--project', 'tb-proj'], 1);
check('PCHECK-UNPARSEABLE', tree({ canon: '{not json' }), ['--root', '<fn>', '--project', 'tb-proj'], 1);
check('PCHECK-PRIVATE-EMPTY-FAILS (codex r2 P2)', tree({ canon: cfg({ private_bucket: { 'tb-proj': '' } }) }), ['--root', '<fn>', '--project', 'tb-proj'], 1);
check('PCHECK-EMPTY-MAPS-FAIL (codex r4 P1)', tree({ canon: cfg({ public_bucket: {}, private_bucket: {} }) }), ['--root', '<fn>', '--project', 'tb-proj'], 1);
check('PCHECK-OTHER-PROJECT-ENTRY-ONLY (codex r4 P1)', tree(), ['--root', '<fn>', '--project', 'tb-proj-other'], 1);
check('PCHECK-ROOT-MISSING', tree(), ['--root', '/nonexistent-tb-dir', '--project', 'tb-proj'], 1);
ok(`predeploy photos check: ${cases.length} cases — clean (flag or $GCLOUD_PROJECT) and public "" → 0; no project, missing either copy, drift, invalid / unparseable, private "", empty maps, only another project's entry, a bad root → 1; no bucket value ever printed`);

// the committed tree itself passes for the deploying project, as the real hook will run it
{
  const r = run(['--root', path.join(__dirname, '..'), '--project', 'xpizza-delivery']);
  assert.strictEqual(r.status, 0, `🔴 PCHECK-COMMITTED-TREE the real functions root fails its own predeploy photos check\n${r.stdout}${r.stderr}`);
  assert.ok(!/firebasestorage\.app/.test(`${r.stdout}${r.stderr}`), 'PCHECK-COMMITTED-NEVER-PRINTS-VALUES');
}
ok('the committed functions root passes for xpizza-delivery (both copies, the verified private entry), printing no bucket value');

// it is wired: firebase.json runs it as a functions predeploy step, after the env guard, for the deploying project
{
  const fb = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firebase.json'), 'utf8'));
  const fns = Array.isArray(fb.functions) ? fb.functions : [fb.functions];
  for (const f of fns) {
    const pre = f.predeploy || [];
    const i = pre.findIndex((c) => /tools\/platform-photos-check\.js/.test(c));
    assert.ok(i > 0 && /--root "\$RESOURCE_DIR"/.test(pre[i]) && /--project "\$GCLOUD_PROJECT"/.test(pre[i]), `🔴 PCHECK-WIRED firebase.json functions predeploy must run platform-photos-check after the env guard: ${JSON.stringify(pre)}`);
  }
}
ok('firebase.json runs it as a functions predeploy step (after the env guard) with --root "$RESOURCE_DIR" --project "$GCLOUD_PROJECT"');
console.log(`platform-photos-check: OK (${n})`);
