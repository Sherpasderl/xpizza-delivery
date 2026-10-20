#!/usr/bin/env node
// TRACKER FIXES T9 — `npm run test:tracker-golden`: the golden GATE on the current tree (run under tools/emulator-run.js).
//   1. candidate flag OFF (key absent) → must EQUAL test/fixtures/tracker-golden.baseline.json (captured on the base d88dcdf1);
//   2. candidate flag ON → must equal it EXCEPT the reviewed, value-pinned delta list test/fixtures/tracker-golden.on-deltas.json.
// Each capture runs in its own child process (the flag cache and the triggers are per process); outputs go to a temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-golden-'));
const run = (args) => { const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env }); if (r.status !== 0) { console.error(`tracker-golden gate: FAIL — ${args.join(' ')} exited ${r.status}`); process.exit(1); } };
try {
  for (const [mode, extra] of [['off', []], ['on', ['--allow', path.join(here, 'fixtures', 'tracker-golden.on-deltas.json')]]]) {
    const out = path.join(tmp, `${mode}.json`);
    run([path.join(here, 'tracker-golden.mjs'), '--root', ROOT, '--out', out, '--flag', mode]);
    const report = path.join(tmp, `${mode}.report.json`);
    run([path.join(here, 'tracker-golden-compare.mjs'), path.join(here, 'fixtures', 'tracker-golden.baseline.json'), out, ...extra, '--report', report]);
    // one ✓ per journey ACTUALLY compared — printed only after the comparison passed, from its per-journey report (a journey with
    // a step-count change, an unexpected difference or a missing reviewed delta can never reach this line: run() exits first)
    const rep = JSON.parse(fs.readFileSync(report, 'utf8'));
    const names = Object.keys(rep.journeys);
    if (!rep.equal || names.length === 0) { console.error(`tracker-golden gate: FAIL — ${mode} report not equal / empty`); process.exit(1); }
    for (const j of names) {
      const r = rep.journeys[j];
      if (r.unexpected || r.missing || r.steps_expected !== r.steps_actual || r.steps_expected === 0) { console.error(`tracker-golden gate: FAIL — ${mode} journey ${j} ${JSON.stringify(r)}`); process.exit(1); }
      console.log(`  ✓ ${mode}: journey ${j} — ${r.steps_actual} step capture(s) equal to the baseline${r.allowed ? ` (${r.allowed} reviewed delta(s), all present)` : ''}`);
    }
  }
  console.log('tracker-golden gate: OK (OFF == baseline; ON == baseline + the reviewed deltas)');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
