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
 *  · APPLICABILITY (codex r3 P1-3): the join is EXPLICIT per (site, fact, scenario, brand, LP). Each site obligation
 *    carries `applies` — by default every cell of its (R, fact) group; narrowed ONLY by a reviewed
 *    spec.siteApplicability entry (with reason). Each agreement cell carries `sites`: the indexes (into siteObligations)
 *    of EVERY site obligation that applies to it — each (cell, site) pair is its own obligation. A (R, fact) group with
 *    cells but NO census site must be dispositioned in spec.unsitedFacts ('output' / 'not-in-source', named outputs
 *    checked to exist); its cells carry `outputs` instead. coverage(doc, executed) is the rule P1 enforces dynamically.
 * `node contract/matrix-build.js --write` regenerates matrix.json.
 */
const fs = require('fs');
const path = require('path');

const SPEC_FILE = path.join(__dirname, 'matrix-spec.json');
const CENSUS = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'census.json'), 'utf8'));
const OUT = path.join(__dirname, 'matrix.json');
const REPO = path.join(__dirname, '..', '..');
let SPEC;
const FACTS_OF = (r) => SPEC.readers[r].facts.map((f) => f.replace(/^census:/, ''));
// an output `file#fn` exists iff the file defines fn (function declaration, exports.fn =, or fn = / fn: function)
function outputExists(ref) {
  const [file, fn] = ref.split('#'); let src;
  try { src = fs.readFileSync(path.join(REPO, file), 'latin1'); } catch { return false; }
  return new RegExp(`(function\\s+${fn}\\b|exports\\.${fn}\\s*=|\\b${fn}\\s*[:=]\\s*(async\\s+)?(function\\b|\\())`).test(src);
}

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

function build(spec) {
  SPEC = spec || JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'));
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
  // codex P1 plan r1 P1-7: DISPLAY cells (approved §1) — kind display, counted separately; expect = shown | absent
  for (const [id, d] of Object.entries(SPEC.displayCells || {})) {
    if (id === '_doc') continue;
    for (const R of d.readers) {
      for (const ref of (d.outputs[R] || [])) if (!outputExists(ref)) problems.push(`displayCells.${id}: output ${ref} does not exist in source`);
      for (const S of Object.keys(SPEC.scenarios)) {
        const fulfil = SPEC.scenarios[S].fulfil; if (!(fulfil in d.show)) continue;
        for (const brand of (SPEC.scenarios[S].brands || SPEC.brands).filter((b) => d.brands.includes(b))) {
          for (const lp of lpsFor(R, S).filter((x) => d.lps.includes(x))) {
            cells.push({ cell: `R3:${R}:DISPLAY:${id}:${S}:${brand}:${lp}`, R, fact: `DISPLAY:${id}`, S, brand, lp, kind: 'display', status: 'required', expect: d.show[fulfil] ? 'shown' : 'absent', outputs: (d.outputs[R] || []).map((ref) => `R3:${R}:DISPLAY:${id}:@${ref}`) });
          }
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
  // codex r3 P1-3 — EXPLICIT applicability: (cell, site) pairs, never an unrestricted group join
  siteObligations.sort((a, b) => (a.site + a.fact).localeCompare(b.site + b.fact));
  const cellsOf = {};
  for (const c of cells) if (c.kind === 'agreement') (cellsOf[c.group] = cellsOf[c.group] || []).push(c);
  const SA = (SPEC.siteApplicability && SPEC.siteApplicability.entries) || [];
  SA.forEach((e, i) => {
    if (!e.reason || !String(e.reason).trim()) problems.push(`siteApplicability[${i}] (${e.site} ${e.fact}) has no reason`);
    if (!siteObligations.some((o) => o.site === e.site && o.fact === e.fact)) problems.push(`siteApplicability[${i}] (${e.site} ${e.fact}) matches no site obligation (stale)`);
  });
  const within = (e, c) => (!e.scenarios || e.scenarios.includes(c.S)) && (!e.brands || e.brands.includes(c.brand)) && (!e.lps || e.lps.includes(c.lp));
  for (const c of cells) if (c.kind === 'agreement') c.sites = [];
  siteObligations.forEach((o, i) => {
    const rs = SA.filter((e) => e.site === o.site && e.fact === o.fact);
    const app = (cellsOf[o.group] || []).filter((c) => rs.every((e) => within(e, c)));
    for (const c of app) c.sites.push(i);
    const uniq = (f) => [...new Set(app.map(f))].sort();
    o.applies = { scenarios: uniq((c) => c.S), brands: uniq((c) => c.brand), lps: uniq((c) => c.lp), narrowed: rs.length ? rs.map((e) => e.reason) : undefined };
    if (!o.applies.narrowed) delete o.applies.narrowed;
    o.requiredCells = app.filter((c) => c.status === 'required').length;
    if (!o.requiredCells) problems.push(`site obligation ${o.assertion} applies to no REQUIRED cell`);
  });
  // site-less groups: an explicit, reviewed disposition (never a silent join)
  const US = SPEC.unsitedFacts || {};
  const unsited = [];
  for (const [g, cs] of Object.entries(cellsOf)) {
    if (groups[g]) { if (US[g]) problems.push(`unsitedFacts.${g} is stale — the group has census sites`); continue; }
    const d = US[g];
    if (!d) { problems.push(`${g}: ${cs.filter((c) => c.status === 'required').length} required cell(s) with NO census site and no unsitedFacts disposition`); continue; }
    // codex r4 P1-4: a disposition may SPLIT by fulfilment / scenario / LP (e.g. R9:PLACE — pickup messages state the
    // restaurant, delivery messages state no address); every cell must match EXACTLY ONE part
    const parts = d.split || [d];
    const [R, fact] = g.split(':');
    const matches = (w, c) => !w || ((!w.fulfil || w.fulfil.includes(SPEC.scenarios[c.S].fulfil)) && (!w.scenarios || w.scenarios.includes(c.S)) && (!w.lps || w.lps.includes(c.lp)));
    let bad = false;
    parts.forEach((pt, i) => {
      if (!['output', 'not-in-source'].includes(pt.kind) || !pt.reason || !(pt.outputs || []).length) { problems.push(`unsitedFacts.${g}${d.split ? `.split[${i}]` : ''}: needs kind output|not-in-source, outputs and a reason`); bad = true; }
      for (const ref of pt.outputs || []) if (!outputExists(ref)) problems.push(`unsitedFacts.${g}: output ${ref} does not exist in source`);
      // advisor ruling 2026-10-12: a not-in-source part is a RECONCILED PLAN fact — it must carry the ruling
      if (pt.kind === 'not-in-source' && !(pt.ruling && String(pt.ruling).trim())) { problems.push(`unsitedFacts.${g}${d.split ? `.split[${i}]` : ''}: not-in-source without a PLAN-reconciliation ruling`); bad = true; }
    });
    if (bad) continue;
    const per = parts.map(() => []);
    for (const c of cs) {
      const hit = parts.map((pt, i) => (matches(pt.when, c) ? i : -1)).filter((i) => i >= 0);
      if (hit.length !== 1) { problems.push(`unsitedFacts.${g}: cell ${c.cell} matches ${hit.length} part(s) — every cell must match exactly one`); continue; }
      const pt = parts[hit[0]]; per[hit[0]].push(c);
      c.outputs = pt.outputs.map((ref) => `R3:${R}:${fact}:${pt.kind === 'not-in-source' ? '!' : '@'}${ref}`);
      c.unsited = pt.kind;
      // codex r4 P1-4: a PLAN fact the outputs do NOT display is not an agreement — its own kind, reported apart
      if (pt.kind === 'not-in-source') c.kind = 'not-in-source';
    }
    parts.forEach((pt, i) => { if (!per[i].length) problems.push(`unsitedFacts.${g}${d.split ? `.split[${i}]` : ''} matches no cell (stale)`); });
    parts.forEach((pt, i) => unsited.push({ group: g, ...(d.split ? { part: i, when: pt.when } : {}), kind: pt.kind, ...(pt.ruling ? { ruling: pt.ruling } : {}), outputs: pt.outputs, assertions: pt.outputs.map((ref) => `R3:${R}:${fact}:${pt.kind === 'not-in-source' ? '!' : '@'}${ref}`), reason: pt.reason, requiredCells: per[i].filter((c) => c.status === 'required').length }));
  }
  for (const g of Object.keys(US)) if (g !== '_doc' && !cellsOf[g]) problems.push(`unsitedFacts.${g} names a group with no cells (stale)`);
  // codex r4 P1-3: ABSENCE cells carry designated assertions too — the reviewed output(s) that must NOT show the order
  const AO = SPEC.absenceOutputs || {};
  for (const c of cells.filter((x) => x.kind === 'absence')) {
    const a = AO[c.R];
    if (!a || !(a.outputs || []).length || !a.reason) { problems.push(`absence cell ${c.cell}: no reviewed absenceOutputs.${c.R} (outputs + reason)`); continue; }
    c.outputs = a.outputs.map((ref) => `R3:${c.R}:ABSENT:!${ref}`);
  }
  for (const [R, a] of Object.entries(AO)) {
    if (R === '_doc') continue;
    if (!cells.some((c) => c.kind === 'absence' && c.R === R)) problems.push(`absenceOutputs.${R} names a reader with no absence cell (stale)`);
    for (const ref of a.outputs || []) if (!outputExists(ref)) problems.push(`absenceOutputs.${R}: output ${ref} does not exist in source`);
  }
  for (const c of cells) if (c.status === 'required' && !(c.sites || []).length && !(c.outputs || []).length) problems.push(`required cell ${c.cell} has NO designated assertion`);
  const accepted = new Set((SPEC.acceptedDeltas || []).map((d) => d.site));
  const openDeltas = deltas.filter((d) => !accepted.has(d.site));
  const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    problems, openDeltas,
    doc: {
      _doc: 'GENERATED by contract/matrix-build.js from matrix-spec.json + census.json — do not edit by hand. cells[].sites = indexes into siteObligations: EVERY site obligation applicable to that (R, fact, scenario, brand, LP) — each (cell, site) pair is an obligation; cells[].outputs = the reviewed output assertions of a site-less group (unsited).',
      counts: { cellSitePairs: cells.reduce((a, c) => a + (c.sites || []).length, 0), requiredCellSitePairs: cells.reduce((a, c) => a + (c.status === 'required' ? (c.sites || []).length : 0), 0), unsitedGroups: new Set(unsited.map((u) => u.group)).size, unsitedParts: unsited.length, unsitedRequiredCells: unsited.reduce((a, u) => a + u.requiredCells, 0), notInSourceRequiredCells: cells.filter((c) => c.kind === 'not-in-source' && c.status === 'required').length, absenceRequiredCells: cells.filter((c) => c.kind === 'absence' && c.status === 'required').length, outputs: outputList.length, siteAssertions: siteObligations.length, groups: Object.keys(groups).length, siteObligations: siteObligations.length, cells: cells.length, byStatus: count(cells, (c) => c.status), byKind: count(cells, (c) => c.kind), byR: count(cells.filter((c) => c.status === 'required'), (c) => c.R), obligations: obligations.size, obligationSites: [...obligations.values()].reduce((a, b) => a + b, 0), deltas: deltas.length },
      gaps: cells.filter((c) => c.status === 'gap').reduce((m, c) => { const k = `${c.R} ${c.S} ${c.brand} ${c.lp}`; if (!m.find((x) => x.key === k)) m.push({ key: k, reason: c.reason }); return m; }, []),
      obligations: Object.fromEntries([...obligations.entries()].sort()),
      outputs: outputList,
      groups,
      siteObligations,
      unsited,
      // codex r4 P1-4: PLAN facts the named outputs do NOT display — reported apart from agreement; each must be reconciled
      // with the PLAN (fact removed, or the product fixed) by an advisor ruling BEFORE P1 executes the matrix
      planReconciliation: unsited.filter((u) => u.kind === 'not-in-source').map((u) => ({ group: u.group, ...(u.when ? { when: u.when } : {}), ruling: u.ruling, outputs: u.outputs, reason: u.reason, requiredCells: u.requiredCells })),
      deltas,
      cells,
    },
  };
}

// THE COVERAGE RULE (P1 enforces it over the executed set; P0 defines and guards it). `executed` = Set of
// `${cell}|${assertion}` pairs that ran. EVERY REQUIRED cell — agreement × each applicable site assertion (or reviewed
// output assertion), ABSENCE × its absence assertions, NOT-IN-SOURCE × its outputs — must have run; GAP cells are
// reported, never counted.
function coverage(doc, executed) {
  const missing = [];
  for (const c of doc.cells) {
    if (c.status !== 'required') continue;   // codex r4 P1-3: EVERY required cell — agreement, absence, not-in-source
    const want = (c.sites || []).length ? c.sites.map((i) => doc.siteObligations[i].assertion) : (c.outputs || []);
    for (const a of want) if (!executed.has(`${c.cell}|${a}`)) missing.push(`${c.cell}|${a}`);
  }
  return missing;
}

module.exports = { build, coverage, OUT, SPEC_FILE };

if (require.main === module) {
  const { problems, openDeltas, doc } = build();
  console.log(JSON.stringify(doc.counts, null, 1));
  if (openDeltas.length) {
    const byR = {}; for (const d of openDeltas) { const k = `${d.R} reads ${d.facts.join('/')}`; byR[k] = (byR[k] || 0) + 1; }
    console.log(`\n${openDeltas.length} open delta site(s) — census reads whose facts the reviewed list does not cover:\n  ${Object.entries(byR).map(([k, v]) => `${k}: ${v}`).join('\n  ')}`);
  }
  if (problems.length) { console.error(`\n${problems.length} problem(s):\n  ${problems.slice(0, 30).join('\n  ')}`); process.exitCode = 1; }
  if (process.argv.includes('--write')) {
    // one cell / one site obligation per line (the cell→site index lists would otherwise put every index on a line)
    const rows = (arr) => `[\n${arr.map((x) => JSON.stringify(x)).join(',\n')}\n]`;
    const text = JSON.stringify({ ...doc, siteObligations: '\u0000SO', cells: '\u0000CELLS' }, null, 1).replace('"\\u0000SO"', () => rows(doc.siteObligations)).replace('"\\u0000CELLS"', () => rows(doc.cells));
    fs.writeFileSync(OUT, text + '\n'); console.log('wrote contract/matrix.json');
  }
}
