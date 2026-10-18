// PLATFORM F2 Q2 (owner decision 2026-10-18; RUNBOOK-F2-Q3 §4): the KDS sidebar label is the per-terminal evidence for the Q2
// switch — a terminal showing "v2.3.0" runs Q2-or-later code, one still showing "v2.2.1" runs old code (FAIL). The label is a
// MANUAL constant, so this guard keeps it from being lost in a re-stack: EVERY kitchen deployment in platform/sites.json serves an
// entrypoint whose sidebar carries exactly one label, and it is v2.3.0. Run: node xpizza-kitchen/kds-version-label.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'v2.3.0';
const sites = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform', 'sites.json'), 'utf8'));
const kitchens = sites.deployments.filter((d) => d.app === 'kitchen');
assert.deepStrictEqual(kitchens.map((d) => d.id).sort(), ['kitchen-lamusa', 'kitchen-xpizza'], 'both kitchen sites are in the manifest');
let n = 0;
for (const d of kitchens) {
  for (const e of d.entrypoints) {
    const html = fs.readFileSync(path.join(ROOT, d.folder, e), 'utf8');
    const labels = [...html.matchAll(/<div class="kds-version">([^<]*)<\/div>/g)].map((m) => m[1]);
    assert.deepStrictEqual(labels, [LABEL], `${d.id} ${d.folder}/${e}: the sidebar carries exactly one label, ${LABEL} (found ${JSON.stringify(labels)})`);
    n += 1;
  }
}
console.log(`kds-version-label: OK (${n} kitchen entrypoints carry ${LABEL})`);
