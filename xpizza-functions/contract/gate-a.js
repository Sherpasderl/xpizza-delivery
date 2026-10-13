'use strict';
/* R3 P1 §3b — GATE A's denominator (PLAN-R3-P1 rev 4, Amendment A2). A gate A cell is
 *     (scenario variant, LP, brand, output, REGION, fact) — one oracle comparison at one terminal observable.
 * It is derived — never hand-listed — from matrix.json (required cells and their site / listed outputs), regions.json (every
 * consumer call site of an output) and the reviewed outputs/registry.json:
 *   · terminal region → its own cell;
 *   · via region      → the cell is compared at the region it targets (its effect is not separately visible);
 *   · pending region  → a REQUIRED cell whose adapter is not built yet (in an enforced slice that is RED, never skipped).
 * The cell's kind (agreement / not-in-source / display / absence) is carried, so counts stay separate.
 */
const fs = require('fs');
const path = require('path');

const load = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const outputOfAssertion = (a) => { const m = /:[@!]([^:]*)$/.exec(a); return m ? m[1] : null; };

function gateA({ scenarios = null, brands = null, lps = null, matrix = load('matrix.json'), regions = load('regions.json'), registry = load('outputs/registry.json') } = {}) {
  const regionsOf = new Map();
  for (const r of regions.regions) { if (!regionsOf.has(r.output)) regionsOf.set(r.output, []); regionsOf.get(r.output).push(r.region); }
  const cells = []; const problems = [];
  for (const c of matrix.cells) {
    if (c.status !== 'required') continue;
    if (scenarios && !scenarios.includes(c.S)) continue;
    if (brands && !brands.includes(c.brand)) continue;
    if (lps && !lps.includes(c.lp)) continue;
    const outs = new Set((c.sites || []).map((i) => matrix.siteObligations[i].output));
    for (const a of c.outputs || []) { const o = outputOfAssertion(a); if (o) outs.add(o); }
    for (const o of outs) {
      const rs = regionsOf.get(o);
      if (!rs || !rs.length) { problems.push(`output ${o} (cell ${c.cell}) has no region in the inventory`); continue; }
      for (const rid of rs) {
        const e = registry.regions[rid];
        if (!e) { problems.push(`region ${rid} has no registry entry`); continue; }
        const at = e.status === 'via' ? e.target : rid;
        cells.push({ id: `${c.cell}|${o}|${at}`, cell: c.cell, R: c.R, fact: c.fact, S: c.S, brand: c.brand, lp: c.lp, kind: c.kind, output: o, region: at, viaFrom: e.status === 'via' ? rid : undefined, status: e.status === 'via' ? (registry.regions[at] || {}).status || 'missing' : e.status, ...(c.expect ? { expect: c.expect } : {}) });
      }
    }
  }
  // de-duplicate: two via regions of one output targeting the same region are ONE comparison
  const seen = new Set(); const uniq = cells.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
  const count = (f) => uniq.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  return { cells: uniq, problems, counts: { cells: uniq.length, byKind: count((x) => x.kind), byStatus: count((x) => x.status), regions: new Set(uniq.map((x) => x.region)).size } };
}

module.exports = { gateA, outputOfAssertion };

if (require.main === module) {
  const P1 = ['S1', 'S1t-a', 'S1t-b', 'S1t-c', 'S1a-on', 'S1a-off', 'S2', 'S3', 'S4', 'S13', 'S14-omitted', 'S14-empty', 'S14-efectivo', 'S14-bitcoin', 'S17d', 'S17p'];
  const all = gateA(); const p1 = gateA({ scenarios: P1 });
  console.log(JSON.stringify({ all: all.counts, P1: p1.counts, problems: all.problems.slice(0, 5) }, null, 1));
}
