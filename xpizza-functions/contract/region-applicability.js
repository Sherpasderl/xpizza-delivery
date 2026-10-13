'use strict';
/* R3 P1-b — REGION-LEVEL APPLICABILITY, DERIVED FROM DECLARED PRECONDITIONS (PLAN-R3-P1 §3c; DESIGN-R3-P1B.md rev 2,
 * codex design r1 folded; advisor GO). contract/region-applicability.json (reviewed) holds ONE entry per region whose
 * applicability is reviewed; every other region is REQUIRED (unknown applicability = required).
 *
 * An entry:
 *   appliesWhenAny  [conjunction…]  — the region's output is shown iff the scenario vector (contract/scenario-state.js)
 *                                     satisfies ANY conjunction { field: [allowed values] }. [] = never by vector alone
 *                                     (then a `context` condition decides);
 *   context         [name…]         — run conditions (scenario-state CONTEXT) that must be ESTABLISHED for the exclusion;
 *   authority / whyFalseExcludes    — the CONTRACT text, and why a failing vector means the surface does not show it
 *                                     (a reader's visibility code is evidence, never authority);
 *   bind + guards                   — the region's call-site + scope, and its guarding / dispatch source (incl. selection
 *                                     tables) — any change → stale → required + RED (P1-a's bindOf / bindGuard);
 *   cases           { required:[S|brand|lp…], excluded:[…], note } — reviewed representative cases, evaluated by the guard.
 * scenarioBinding { S: sha } — a changed scenario definition / LP / vector re-opens every exclusion in it (RED until
 * re-recorded on review), even if the derived set is unchanged. A missing / invalid field value is INVALID, never false.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AP = require('./applicability');
const SS = require('./scenario-state');

const FILE = path.join(__dirname, 'region-applicability.json');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const load = (f = FILE) => JSON.parse(fs.readFileSync(f, 'utf8'));

/* the reviewed scenario binding: its path definition + every LP vector, canonical */
// + the EXECUTED definition (codex P1-b mech r1 P1-1): the journey's intent, steps and LP definitions in p1-scenarios.json
const EXEC = path.join(__dirname, 'p1-scenarios.json');
function scenarioSha(S, paths = SS.load(), exec = JSON.parse(fs.readFileSync(EXEC, 'utf8'))) {
  const sc = paths.scenarios[S]; if (!sc) return null;
  const vecs = Object.fromEntries((sc.brands || paths.defaultBrands).map((b) => [b, SS.vectorsOf(S, b, paths)]));
  return sha(AP.canon({ def: sc, defaults: paths.defaults, vectors: vecs, executed: (exec.scenarios || {})[S] || null }));
}

/* evaluate an entry's condition against a vector: 'applies' | 'excluded-by-vector' | 'invalid' (+ the fields used) */
function evaluate(entry, v) {
  const used = new Set();
  for (const conj of entry.appliesWhenAny || []) for (const f of Object.keys(conj)) used.add(f);
  for (const f of used) {
    if (!(f in SS.FIELDS)) return { result: 'invalid', reason: `undeclared field ${f}`, used: [...used] };
    if (!v || !(f in v)) return { result: 'invalid', reason: `the vector has no ${f}`, used: [...used] };
    const dom = SS.FIELDS[f]; if (Array.isArray(dom) && !dom.includes(v[f])) return { result: 'invalid', reason: `${f}=${JSON.stringify(v[f])} outside its domain`, used: [...used] };
  }
  const applies = (entry.appliesWhenAny || []).some((conj) => Object.entries(conj).every(([f, vals]) => Array.isArray(vals) && vals.includes(v[f])));
  return { result: applies ? 'applies' : 'excluded-by-vector', used: [...used] };
}

/* the static decision for one cell (no run evidence): { excluded, entry, reason } */
function staticDecision(doc, regionId, cell, paths = SS.load()) {
  const entry = doc.regions[regionId];
  if (!entry) return { excluded: false, reason: 'no reviewed entry — required' };
  let v; try { v = SS.vectorOf(cell.S, cell.brand, cell.lp, paths); } catch (e) { return { excluded: false, invalid: true, reason: `no vector: ${e.message}` }; }
  const ev = evaluate(entry, v);
  if (ev.result === 'invalid') return { excluded: false, invalid: true, reason: ev.reason };
  return { excluded: ev.result === 'excluded-by-vector', entry, used: ev.used, vector: v };
}

/* the RUN decision: the static exclusion applies only if every vector field it uses, and every context condition, is
 * ESTABLISHED by evidence. unknown → required (not excluded); contradicted → RED. */
function runDecision(doc, regionId, cell, evidence, paths = SS.load()) {
  const st = staticDecision(doc, regionId, cell, paths);
  if (!st.excluded) return { outcome: st.invalid ? 'invalid' : 'required', reason: st.reason };
  const vr = SS.assertVector(st.vector, evidence);
  // the LP's expected order STATUS is always asserted (codex mech r1 P1-3): the run must be AT the LP the vector describes;
  // and ANY vector field the evidence contradicts (e.g. a stray kitchen tap: kitchen / status) voids EVERY exclusion — the
  // run is not the scenario the vector describes
  const used = st.used.includes('status') ? st.used : [...st.used, 'status'];
  const contradicted = vr.failed;
  if (contradicted.length) return { outcome: 'contradicted', reason: `the run's evidence contradicts the scenario vector on ${contradicted.join(', ')}` };
  const unk = used.filter((f) => !vr.checked.includes(f));
  const ctx = (st.entry.context || []).map((c) => [c, SS.checkContext(c, evidence)]);
  const ctxBad = ctx.filter(([, x]) => x !== true);
  if (unk.length || ctxBad.length) return { outcome: 'required', reason: `not established by this run: ${[...unk, ...ctxBad.map(([c]) => c)].join(', ')}` };
  return { outcome: 'excluded', entry: st.entry, used, context: (st.entry.context || []) };
}

/* staleness: region binding, guards, scenario bindings, entry shape */
function problems(doc, regionsDoc, paths = SS.load(), exec = undefined) {
  const p = []; const byId = new Map(regionsDoc.regions.map((r) => [r.region, r]));
  for (const [S, h] of Object.entries(doc.scenarioBinding || {})) if (scenarioSha(S, paths, exec) !== h) p.push(`scenario ${S}: its definition / LPs / vectors changed — every derived exclusion in it is required again (re-review, then re-record the binding)`);
  for (const S of Object.keys(paths.scenarios)) if (!(doc.scenarioBinding || {})[S]) p.push(`scenario ${S}: no reviewed binding`);
  for (const [id, e] of Object.entries(doc.regions)) {
    const r = byId.get(id);
    if (!r) { p.push(`${id}: not a region (stale)`); continue; }
    const b = AP.bindOf(r);
    if (!e.bind || b.siteSha !== e.bind.siteSha || b.scopeSha !== e.bind.scopeSha) p.push(`${id}: its call site / scope changed — re-review`);
    if (!Array.isArray(e.guards) || !e.guards.length) p.push(`${id}: needs at least one GUARD binding (its guarding / dispatch source)`);
    for (const g of e.guards || []) { const st = AP.guardStale(g); if (st) p.push(`${id}: ${st}`); }
    if (!Array.isArray(e.appliesWhenAny)) p.push(`${id}: appliesWhenAny must be a list of conjunctions`);
    for (const conj of e.appliesWhenAny || []) for (const [f, vals] of Object.entries(conj)) {
      if (!(f in SS.FIELDS)) p.push(`${id}: condition uses undeclared field ${f}`);
      else if (!Array.isArray(vals) || !vals.length || (Array.isArray(SS.FIELDS[f]) && vals.some((x) => !SS.FIELDS[f].includes(x)))) p.push(`${id}: condition ${f} ∈ ${JSON.stringify(vals)} is outside the field's domain`);
    }
    for (const c of e.context || []) if (!SS.CONTEXT[c]) p.push(`${id}: unknown context ${c}`);
    // an empty condition is "never by vector": only a nonempty, validated context may decide it (codex mech r1 P1-4) —
    // otherwise it would be an UNCONDITIONAL exclusion
    if (Array.isArray(e.appliesWhenAny) && !e.appliesWhenAny.length && !((e.context || []).length && (e.context || []).every((c) => SS.CONTEXT[c]))) p.push(`${id}: an empty appliesWhenAny needs a nonempty, validated context (else it is an unconditional exclusion)`);
    if (!(e.authority && e.authority.trim()) || !(e.whyFalseExcludes && e.whyFalseExcludes.trim())) p.push(`${id}: needs authority + whyFalseExcludes`);
    const cs = e.cases || {};
    if (!Array.isArray(cs.excluded) || !cs.excluded.length) p.push(`${id}: needs ≥ 1 reviewed EXCLUDED case`);
    for (const k of cs.excluded || []) { const [S, brand, lp] = k.split('|'); let v; try { v = SS.vectorOf(S, brand, lp, paths); } catch (_) { p.push(`${id}: case ${k} is not a scenario LP`); continue; } if (evaluate(e, v).result !== 'excluded-by-vector') p.push(`${id}: reviewed EXCLUDED case ${k} evaluates as ${evaluate(e, v).result}`); }
    for (const k of cs.required || []) { const [S, brand, lp] = k.split('|'); let v; try { v = SS.vectorOf(S, brand, lp, paths); } catch (_) { p.push(`${id}: case ${k} is not a scenario LP`); continue; } if (evaluate(e, v).result !== 'applies') p.push(`${id}: reviewed REQUIRED case ${k} evaluates as ${evaluate(e, v).result}`); }
    if (!(cs.required || []).length && !(cs.note && cs.note.trim())) p.push(`${id}: no reviewed REQUIRED case — name where the region applies (a P2 scenario / an action) in cases.note`);
  }
  return p;
}

/* the derived exclusions over a set of gate A cells (static) — for the guard, the lock and the report */
function derive(doc, cells, paths = SS.load()) {
  const out = [];
  for (const c of cells) { const st = staticDecision(doc, c.viaFrom || c.region, c, paths); if (st.excluded) out.push({ cell: c, region: c.viaFrom || c.region, entry: st.entry, used: st.used }); }
  return out;
}
/* absence / display can never be waived: per (cell, output) at least one region stays required (the terminal rule) */
function waivedObligations(doc, cells, paths = SS.load()) {
  const by = new Map();
  for (const c of cells) { if (c.kind !== 'absence' && c.kind !== 'display') continue; const k = `${c.cell}|${c.output}`; if (!by.has(k)) by.set(k, []); by.get(k).push(c); }
  const p = [];
  for (const [k, cs] of by) if (cs.every((c) => staticDecision(doc, c.viaFrom || c.region, c, paths).excluded)) p.push(`${k}: every region of this ${cs[0].kind} obligation is excluded — absence / display are assertions, never exclusions`);
  return p;
}

module.exports = { FILE, load, evaluate, staticDecision, runDecision, problems, derive, waivedObligations, scenarioSha, sha };
