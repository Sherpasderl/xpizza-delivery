// Portal 1D · D4-b — CAPTURE today's 86 decisions from the FOUR UNMODIFIED readers. Run ONCE:
//   node d4b-capture-availability-goldens.mjs
// Refuses unless every reader file is byte-identical to main 717f97e — a golden captured from a modified
// reader would certify the modification, which is what it exists to catch.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { computeDecisions } from './d4b-availability-readers.mjs';

const BASE = '717f97e911774aa03fa285b54ee5af576067ba1a';
const READERS = ['xpizza-functions/availability-gate.js', 'xpizza-functions/avail-key.js', 'xpizza-orders/index.html', 'xpizza-orders/avail-key.js',
  'la-musa-orders/index.html', 'la-musa-orders/avail-key.js', 'xpizza-kitchen/index.html', 'xpizza-kitchen/avail-key.js', 'form-harness.mjs'];

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const changed = git('diff', '--name-only', BASE, '--', ...READERS);
const dirty = git('status', '--porcelain', '--', ...READERS);
if (changed || dirty) { console.error(`refusing: a reader differs from ${BASE}:\n${changed}\n${dirty}`); process.exit(1); }
const decisions = await computeDecisions();
const golden = { _provenance: { captured_at_commit: BASE, readers_byte_identical_to_base: READERS, captured_by: 'd4b-capture-availability-goldens.mjs',
  captured_on: new Date().toISOString().slice(0, 10) }, decisions };
writeFileSync(new URL('./xpizza-functions/catalog/d4b-availability-parity.golden.json', import.meta.url), `${JSON.stringify(golden, null, 2)}\n`);
console.log('wrote xpizza-functions/catalog/d4b-availability-parity.golden.json');
process.exit(0);
