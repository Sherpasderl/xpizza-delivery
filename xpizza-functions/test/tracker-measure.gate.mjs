#!/usr/bin/env node
// TRACKER FIXES r2.10.1 §8.4 — `npm run test:tracker-measure`: measure OFF and ON on the current tree (each in its own child process)
// and compare against the FROZEN limits in test/fixtures/tracker-measure.limits.json (every scenario present, zero handler failures,
// the retention checks, zero residual LIVE claims, each limit). Outputs go to a temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-measure-'));
// Each step gets this process's preloads (execArgv): under the gate that is the egress guard, the NULL guard and the
// cell counter, which emulator-run puts on argv only (not NODE_OPTIONS) — a step spawned without it prints marks nobody counts.
const run = (args) => { const r = spawnSync(process.execPath, [...process.execArgv, ...args], { stdio: 'inherit', env: process.env }); if (r.status !== 0) { console.error(`tracker-measure gate: FAIL — ${path.basename(args[0])} ${args.slice(1, 3).join(' ')} exited ${r.status}`); process.exit(1); } };
try {
  for (const f of ['off', 'on']) run([path.join(here, 'tracker-measure.mjs'), '--flag', f, '--out', path.join(tmp, `${f}.json`)]);
  run([path.join(here, 'tracker-measure.mjs'), '--compare', path.join(tmp, 'off.json'), path.join(tmp, 'on.json')]);
  console.log('tracker-measure gate: OK');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
