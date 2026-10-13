'use strict';
/* R3 P1 §3b — GATE A's EXECUTOR (PLAN-R3-P1 rev 4, Amendment A2: output-level enforcement is the hard bar).
 * Input: the required cells of an ENFORCED slice (contract/gate-a.js), the reviewed registry, the applicability table, the
 * run's evidence (intent / persisted / steps / routed / KDS actions) and the SNAPSHOTS each terminal observable captured.
 * Every cell ends in exactly one outcome:
 *   pass      — compared at its terminal observable, the oracle agrees ('shown' or asserted 'not-shown');
 *   pin       — compared, disagrees, and the disagreement EXACTLY matches a reviewed pin (a known divergence, contract/pins.json);
 *   excluded  — a bound, fresh exclusion whose contract preconditions were asserted true in this run;
 *   RED       — anything else: a pending region, a missing snapshot / comparator, a failed comparison, a stale pin (the
 *               surface now agrees — remove the pin), a stale exclusion, an unmet precondition.
 * Comparisons are computed once per (observable, fact) and shared by every cell that lands there; counts are by kind.
 */
const fs = require('fs');
const path = require('path');
const AP = require('./applicability');
const RA = require('./region-applicability');
const SS = require('./scenario-state');

const PINS = path.join(__dirname, 'pins.json');
const pinKey = (obs, fact, c) => `${obs}|${fact}|${c.S}|${c.brand}|${c.lp}`;

// applicability = the REVIEWED region-level doc (contract/region-applicability.json); paths = the scenario paths (P1-b)
function runGateA({ cells, registry, applicability, regionsDoc, paths = SS.load(), evidence, snapshots, facts, ctx, observables, pins = JSON.parse(fs.readFileSync(PINS, 'utf8')).pins }) {
  const probs = RA.problems(applicability, regionsDoc, paths);
  const staleRegion = new Set(probs.filter((p) => !/^scenario /.test(p)).map((p) => p.slice(0, p.indexOf(': '))));
  const staleScenario = new Set(probs.filter((p) => /^scenario /.test(p)).map((p) => p.split(' ')[1].replace(/:$/, '')));
  const cmp = new Map(); const results = []; const usedPins = new Set(); const deferred = [];
  const compare = (obs, fact) => {
    const k = `${obs}|${fact}`;
    if (cmp.has(k)) return cmp.get(k);
    const O = observables[obs]; let r;
    if (!O) r = { ok: false, detail: `no observable ${obs}` };
    else if (!(obs in snapshots)) r = { ok: false, detail: `observable ${obs} was not captured in this run` };
    else if (!O.compare[fact]) r = { ok: false, missing: true, detail: `observable ${obs} has NO comparator for ${fact} — a missing comparison` };
    else if (!snapshots[obs].exposed || !snapshots[obs].exposed.ok) r = { ok: false, detail: `the terminal region was not EXPOSED when captured (${snapshots[obs].exposed ? snapshots[obs].exposed.detail : 'no exposed state recorded'}) — its action did not show it` };
    else { try { r = O.compare[fact](snapshots[obs], facts, ctx); } catch (e) { r = { ok: false, detail: `comparator threw: ${e && e.message}` }; } }
    cmp.set(k, r); return r;
  };
  for (const c of cells) {
    const region = c.viaFrom || c.region;
    const base = { id: c.id, cell: c.cell, output: c.output, kind: c.kind, fact: c.fact, region: c.region, viaFrom: c.viaFrom, fromRegions: c.fromRegions || [c.viaFrom || c.region] };
    // P1-b: the DERIVED decision — the region's reviewed appliesWhen against the cell's scenario vector, then the run's
    // evidence must ESTABLISH every field / context it depends on (unknown → required; contradicted → RED)
    const st = RA.staticDecision(applicability, region, c, paths);
    if (st.invalid) { results.push({ ...base, outcome: 'RED', detail: `applicability INVALID for this cell (${st.reason}) — never read as excluded` }); continue; }
    if (st.excluded) {
      const isStale = staleRegion.has(region) || staleScenario.has(c.S);
      const rd = RA.runDecision(applicability, region, c, evidence, paths);
      const u = rd.outcome === 'excluded' ? [] : [rd.reason];
      if (c.kind === 'absence' || c.kind === 'display') { deferred.push({ c, base, x: { preconditions: st.used }, u, stale: isStale }); continue; }
      if (isStale) { results.push({ ...base, outcome: 'RED', detail: `exclusion is STALE (source or scenario changed) — the cell is required again` }); continue; }
      if (rd.outcome === 'contradicted') { results.push({ ...base, outcome: 'RED', detail: `exclusion precondition(s) UNMET in this run: ${rd.reason}` }); continue; }
      if (rd.outcome === 'excluded') { results.push({ ...base, outcome: 'excluded', preconditions: [...st.used, ...(rd.context || [])] }); continue; }
      // not established by this run → the cell is REQUIRED: fall through to the comparison (a pending region is RED)
    }
    const e = registry.regions[c.region];
    if (!e || e.status !== 'terminal') { results.push({ ...base, outcome: 'RED', detail: `region ${c.region} is ${e ? e.status : 'unregistered'} in an enforced slice (unknown applicability = required)` }); continue; }
    const r = compare(e.observable, c.fact);
    const pk = pinKey(e.observable, c.fact, c); const pin = pins.find((p) => p.key === pk);
    if (r.ok && pin) { results.push({ ...base, observable: e.observable, outcome: 'RED', detail: `STALE PIN ${pin.D}: the surface now agrees (${r.detail}) — remove the pin` }); continue; }
    if (r.ok) { results.push({ ...base, observable: e.observable, outcome: 'pass', mode: r.mode, detail: r.detail }); continue; }
    if (pin && r.shape !== undefined && r.shape === pin.observedShape) { usedPins.add(pin.key); results.push({ ...base, observable: e.observable, outcome: 'pin', D: pin.D, detail: r.detail }); continue; }
    results.push({ ...base, observable: e.observable, outcome: 'RED', detail: pin ? `${r.detail} (pin ${pin.D} expects shape "${pin.observedShape}", observed "${r.shape}")` : r.detail });
  }
  /* an absence / display obligation is an ASSERTION, never waived: an unreachable sibling call site of its output may be
   * excluded ONLY when the same obligation (matrix cell) is asserted and PASSES at a reached region in this run. If every
   * region of the cell is excluded, the exclusions would waive the obligation → RED. */
  for (const { c, base, x, u, stale: st } of deferred) {
    // the SAME obligation = same matrix cell AND same output, discharged at that output's TERMINAL region (codex r1 P1-7)
    const at = results.find((y) => y.cell === c.cell && y.output === c.output && (y.outcome === 'pass' || y.outcome === 'pin') && registry.regions[y.region] && registry.regions[y.region].status === 'terminal');
    if (!at) { results.push({ ...base, outcome: 'RED', detail: `the ${c.kind} obligation ${c.cell} on output ${c.output} is not discharged at a reached terminal of the SAME output — an exclusion cannot waive a ${c.kind} assertion` }); continue; }
    if (st) { results.push({ ...base, outcome: 'RED', detail: `exclusion is STALE (source or scenario changed) — the cell is required again` }); continue; }
    if (u.length) { results.push({ ...base, outcome: 'RED', detail: `exclusion precondition(s) UNMET in this run: ${u.join(', ')}` }); continue; }
    results.push({ ...base, outcome: 'excluded', preconditions: x.preconditions, dischargedAt: at.region });
  }
  const tally = (f) => results.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  const comparisons = [...cmp.entries()].map(([k, r]) => ({ key: k, ok: r.ok, mode: r.mode, detail: r.detail }));
  return {
    results, red: results.filter((x) => x.outcome === 'RED'),
    counts: { cells: results.length, regions: new Set(results.flatMap((x) => x.fromRegions)).size, terminals: new Set(results.filter((x) => x.observable).map((x) => x.region)).size, byOutcome: tally((x) => x.outcome), byKindOutcome: tally((x) => `${x.kind}/${x.outcome}${x.mode ? `/${x.mode}` : ''}`),
      comparisons: comparisons.length, comparisonsByMode: comparisons.reduce((m, x) => { const k = x.ok ? x.mode : 'failed'; m[k] = (m[k] || 0) + 1; return m; }, {}), pinsUsed: [...usedPins] },
    comparisons,
  };
}

/* THE designated failure formatter (token.guard): the ONLY place an `R3-FAIL` line is built. One line, starting with the
 * prefix, carrying the cell's token (the matrix cell id R3:<R>:<fact>:<S>:<brand>:<lp>) — what tools/mutation-sweep.js
 * credits with kill_line "^R3-FAIL ". */
const formatFailure = (x) => `R3-FAIL ${x.cell} region=${x.viaFrom || x.region}${x.observable ? ` observable=${x.observable}` : ''} — ${String(x.detail).replace(/\s*\n\s*/g, ' ')}`;

module.exports = { runGateA, formatFailure, PINS, pinKey };
