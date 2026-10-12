'use strict';
/* R3 §2 / §3a — GENERATE contract/matrix.json from contract/matrix-spec.json + contract/census.json.
 *
 *  · CELLS: for every R-site × its reviewed facts × every scenario in which it displays the order × brand × LP. A cell is
 *    `required` (must execute its designated assertion), `gap` (a §6a timing GAP or a third-brand surface that cannot
 *    serve r3_synth — reported as UNEXECUTED coverage with its reason, never counted as executed) or `absence` (the
 *    surface must NOT show the order at that LP). Each cell's designated assertion id = R3:<R>:<fact>:<S>:<brand>:<LP>.
 *  · OBLIGATIONS (static half of §3a): every census site mapped to an R-site yields obligations (site, fact) for
 *    fact ∈ FIELD_FACTS[field] ∩ reviewed facts(R). A site whose intersection is EMPTY is a DELTA (a fact the reviewed
 *    list does not cover) — reported; the guard requires the delta list to equal the reviewed `acceptedDeltas` (empty at
 *    P0 unless reviewed). Every (R, fact) obligation must join to ≥ 1 required cell.
 * `node contract/matrix-build.js --write` regenerates matrix.json.
 */
const fs = require('fs');
const path = require('path');

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'matrix-spec.json'), 'utf8'));
const CENSUS = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'census.json'), 'utf8'));
const OUT = path.join(__dirname, 'matrix.json');
const FACTS_OF = (r) => SPEC.readers[r].facts.map((f) => f.replace(/^census:/, ''));

function lpsFor(R, S) {
  const rd = SPEC.readers[R]; const sc = SPEC.scenarios[S];
  if (rd.fulfil && !rd.fulfil.includes(sc.fulfil) && sc.fulfil !== 'mixed') return [];
  const pick = rd.shows[S] || (SPEC.formScenarios.includes(S) ? rd.shows['*form'] : null) || rd.shows['*'];
  if (!pick) return [];
  const absent = new Set(rd.absent || []);
  if (pick === 'all') return sc.lps.slice();
  if (pick === 'all-except-absent') return sc.lps.filter((lp) => !absent.has(lp));
  if (pick === 'terminal') return sc.lps.filter((lp) => SPEC.terminalLps.includes(lp));
  return sc.lps.filter((lp) => pick.includes(lp));
}

function build() {
  const cells = []; const problems = [];
  const gapOf = (S, lp) => SPEC.gaps.find((g) => g.scenario === S && g.lp === lp);
  for (const R of Object.keys(SPEC.readers)) {
    const facts = FACTS_OF(R);
    for (const S of Object.keys(SPEC.scenarios)) {
      const sc = SPEC.scenarios[S];
      const brands = sc.brands || SPEC.brands;
      const lps = lpsFor(R, S);
      const absentLps = (SPEC.readers[R].absent || []).filter((lp) => sc.lps.includes(lp));
      for (const brand of brands) {
        const third = brand === SPEC.thirdBrand.brand;
        const tgap = third && !SPEC.thirdBrand.canServe.includes(R) ? SPEC.thirdBrand.gap[R] || 'a third brand is not served by this surface (to confirm in P1)' : null;
        for (const lp of lps) {
          const g = gapOf(S, lp);
          for (const fact of facts) {
            cells.push({ cell: `R3:${R}:${fact}:${S}:${brand}:${lp}`, R, fact, S, brand, lp, kind: 'agreement', status: tgap || g ? 'gap' : 'required', ...(tgap || g ? { reason: tgap || g.reason } : {}) });
          }
        }
        for (const lp of absentLps) {
          cells.push({ cell: `R3:${R}:ABSENT:${S}:${brand}:${lp}`, R, fact: 'ABSENT', S, brand, lp, kind: 'absence', status: tgap ? 'gap' : 'required', ...(tgap ? { reason: tgap } : {}) });
        }
      }
    }
  }
  // obligations from the census
  const census = CENSUS();
  // codex r1 P1-3: obligations stay PER SITE. A site's OUTPUT = the function that implements the read (file#fn) — the
  // dispatch queue chip, drawer, alerts and comms header are distinct outputs — and each (R, output, fact) has its OWN
  // designated assertion id. One output's assertion can never satisfy another's.
  const deltas = []; const obligations = new Map(); const siteObligations = [];
  for (const s of census.sites.filter((x) => x.r)) {
    if (!SPEC.readers[s.r]) { problems.push(`census maps ${s.id} to ${s.r}, which the spec does not define`); continue; }
    const want = s.facts.filter((f) => FACTS_OF(s.r).includes(f));
    if (!want.length) { deltas.push({ site: s.id, R: s.r, facts: s.facts }); continue; }
    const output = s.id.split('#').slice(0, 2).join('#');
    for (const f of want) {
      obligations.set(`${s.r}:${f}`, (obligations.get(`${s.r}:${f}`) || 0) + 1);
      // codex r2 P1-4: the designated assertion is per SITE (file#fn#field#ordinal) — each independently implemented
      // read / branch (e.g. alertContent's no-driver vs payment-stale amounts) has its own
      siteObligations.push({ site: s.id, R: s.r, output, fact: f, group: `${s.r}:${f}`, assertion: `R3:${s.r}:${f}:#${s.id}` });
    }
  }
  const outputs = {};
  for (const o of siteObligations) { const k = `${o.R}|${o.output}`; (outputs[k] = outputs[k] || { R: o.R, output: o.output, facts: new Set(), sites: 0 }); outputs[k].facts.add(o.fact); outputs[k].sites += 1; }
  const outputList = Object.values(outputs).map((o) => ({ R: o.R, output: o.output, facts: [...o.facts].sort(), sites: o.sites, assertions: siteObligations.filter((x) => x.R === o.R && x.output === o.output).map((x) => x.assertion).sort() })).sort((a, b) => (a.R + a.output).localeCompare(b.R + b.output));
  // the JOIN carried into the cells: each cell names its (R, fact) group; groups list the site assertions it can execute.
  // P1's execution rule: every site assertion executes in ≥ 1 required cell of its group, every required cell executes ≥ 1.
  const groups = {};
  for (const o of siteObligations) (groups[o.group] = groups[o.group] || []).push(o.assertion);
  for (const k of Object.keys(groups)) groups[k].sort();
  for (const c of cells) if (c.kind === 'agreement') c.group = `${c.R}:${c.fact}`;
  const reqCells = new Set(cells.filter((c) => c.status === 'required' && c.kind === 'agreement').map((c) => `${c.R}:${c.fact}`));
  for (const k of obligations.keys()) if (!reqCells.has(k)) problems.push(`obligation ${k} (${obligations.get(k)} sites) joins to no REQUIRED cell`);
  const accepted = new Set((SPEC.acceptedDeltas || []).map((d) => d.site));
  const openDeltas = deltas.filter((d) => !accepted.has(d.site));
  const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    problems, openDeltas,
    doc: {
      _doc: 'GENERATED by contract/matrix-build.js from matrix-spec.json + census.json — do not edit by hand.',
      counts: { outputs: outputList.length, siteAssertions: siteObligations.length, groups: Object.keys(groups).length, siteObligations: siteObligations.length, cells: cells.length, byStatus: count(cells, (c) => c.status), byKind: count(cells, (c) => c.kind), byR: count(cells.filter((c) => c.status === 'required'), (c) => c.R), obligations: obligations.size, obligationSites: [...obligations.values()].reduce((a, b) => a + b, 0), deltas: deltas.length },
      gaps: cells.filter((c) => c.status === 'gap').reduce((m, c) => { const k = `${c.R} ${c.S} ${c.brand} ${c.lp}`; if (!m.find((x) => x.key === k)) m.push({ key: k, reason: c.reason }); return m; }, []),
      obligations: Object.fromEntries([...obligations.entries()].sort()),
      outputs: outputList,
      groups,
      siteObligations: siteObligations.sort((a, b) => (a.site + a.fact).localeCompare(b.site + b.fact)),
      deltas,
      cells,
    },
  };
}

module.exports = { build, OUT };

if (require.main === module) {
  const { problems, openDeltas, doc } = build();
  console.log(JSON.stringify(doc.counts, null, 1));
  if (openDeltas.length) {
    const byR = {}; for (const d of openDeltas) { const k = `${d.R} reads ${d.facts.join('/')}`; byR[k] = (byR[k] || 0) + 1; }
    console.log(`\n${openDeltas.length} open delta site(s) — census reads whose facts the reviewed list does not cover:\n  ${Object.entries(byR).map(([k, v]) => `${k}: ${v}`).join('\n  ')}`);
  }
  if (problems.length) { console.error(`\n${problems.length} problem(s):\n  ${problems.slice(0, 30).join('\n  ')}`); process.exitCode = 1; }
  if (process.argv.includes('--write')) { fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n'); console.log('wrote contract/matrix.json'); }
}
