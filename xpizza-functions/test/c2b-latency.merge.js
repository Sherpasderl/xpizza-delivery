'use strict';
/* 1D D4-c2b §8 — MERGE the latency jobs' raw reports into the final per-row verdicts (PREREG job split: a row may run as several
   jobs, each a contiguous block range on a fresh emulator). Every row must have EXACTLY the design's blocks 0…K−1, each once, with
   one A/B and one A/A pair per block; the verdict is test/_c2b-latency-verdict.js's — the same code the single-job harness uses.
     node test/c2b-latency.merge.js <report.json> [<report.json> …]  > final.json */
const fs = require('fs');
const { verdictRow, BARS } = require('./_c2b-latency-verdict');
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: c2b-latency.merge.js <report.json>…'); process.exit(2); }
const reports = files.map((f) => { const line = fs.readFileSync(f, 'utf8').split('\n').find((l) => l.startsWith('{"block_range"') || l.startsWith('{"design"')); if (!line) throw new Error(`${f}: no report line`); return JSON.parse(line); });
const K = reports[0].design.blocks; const SAMPLES = reports[0].design.samples;
for (const r of reports) if (r.design.blocks !== K || r.design.samples !== SAMPLES || JSON.stringify(r.design.bars) !== JSON.stringify(BARS)) throw new Error('reports disagree on the design');
const merged = {};
for (const r of reports) for (const [key, R] of Object.entries(r.raw)) {
  const M = merged[key] || (merged[key] = { ab: [], aa: [] });
  M.ab.push(...R.ab); M.aa.push(...R.aa);
}
const rows = [];
for (const [key, M] of Object.entries(merged)) {
  const ks = M.ab.map((b) => b.k).sort((a, b) => a - b); const ka = M.aa.map((b) => b.k).sort((a, b) => a - b);
  const want = Array.from({ length: K }, (_, i) => i);
  if (JSON.stringify(ks) !== JSON.stringify(want) || JSON.stringify(ka) !== JSON.stringify(want)) throw new Error(`${key}: blocks ${JSON.stringify(ks)} / ${JSON.stringify(ka)} ≠ 0…${K - 1} exactly once`);
  M.ab.sort((a, b) => a.k - b.k); M.aa.sort((a, b) => a.k - b.k);
  const overlap = key.endsWith('/other') ? 'other' : (key.endsWith('/same') ? 'same' : 'same+others');
  rows.push(verdictRow({ key, overlap }, M, SAMPLES));
}
console.log(JSON.stringify({ design: reports[0].design, jobs: files, rows }));
