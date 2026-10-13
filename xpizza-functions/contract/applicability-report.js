'use strict';
/* R3 P1-b — the compact REVIEW REPORT for region-level applicability (codex P1-b design r1): grouped by condition, each
 * group showing its contract authority, why false excludes, its regions, guard references, the reviewed cases and the
 * derived exclusion contexts over P1. With --since <rev>, a BATCH section first: the entries added / changed since that
 * revision, by reader, then the S1 / x_pizza / new exclusions outside P1-a's locked slice.
 * `node contract/applicability-report.js [--since <rev>] [--out file.md]` */
const fs = require('fs');
const RA = require('./region-applicability');
const SS = require('./scenario-state');
const { gateA } = require('./gate-a');
const { execFileSync } = require('child_process');
const fmtGuard = (g) => (g.kind === 'S' ? `${g.scope} ∋ \`${g.text.slice(0, 60)}\`` : g.kind === 'C' ? `callers(${g.output}) = {${g.callers.join(', ')}}` : g.kind === 'R' ? `references(${g.name}) pinned in ${Object.keys(g.counts).length} unit(s) (${Object.values(g.counts).reduce((x, y) => x + y, 0)}×)` : g.kind === 'K' ? `${g.file} ∋ \`${g.text}\` ×${g.count}` : `${g.file} ∋ \`${g.text.slice(0, 60)}\``);
const fmtCond = (any, ctx) => `${any.length ? any.map((c) => Object.entries(c).map(([f, v]) => `${f} ∈ {${v.join(', ')}}`).join(' ∧ ')).join('  ∨  ') : '(never by vector)'}${ctx.length ? ` · excluded only when context established: ${ctx.join(', ')}` : ''}`;

function report({ since = null } = {}) {
  const doc = RA.load(); const paths = SS.load();
  const P1 = Object.keys(paths.scenarios);
  const cells = gateA({ scenarios: P1 }).cells;
  const der = RA.derive(doc, cells, paths);
  const ctxBy = new Map(); for (const d of der) { if (!ctxBy.has(d.region)) ctxBy.set(d.region, new Set()); ctxBy.get(d.region).add(`${d.cell.S}|${d.cell.brand}|${d.cell.lp}`); }
  const groups = new Map();
  for (const [id, e] of Object.entries(doc.regions)) { const k = JSON.stringify({ any: e.appliesWhenAny, ctx: e.context || [], auth: e.authority }); if (!groups.has(k)) groups.set(k, []); groups.get(k).push([id, e]); }
  const L = [`# R3 P1-b — region applicability review report`, '', `${Object.keys(doc.regions).length} reviewed regions in ${groups.size} condition groups; ${der.length} P1 cells statically excluded (each applies only when the run establishes its fields). Every other region is REQUIRED.`, ''];
  if (since) {
    const old = JSON.parse(execFileSync('git', ['show', `${since}:xpizza-functions/contract/region-applicability.json`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 << 20 })).regions;
    const strip = (e) => JSON.stringify({ ...e, cases: undefined });
    const batch = Object.entries(doc.regions).filter(([id, e]) => !old[id] || strip(old[id]) !== strip(e));
    const readerOf = new Map(); for (const c of cells) { const r = c.viaFrom || c.region; if (!readerOf.has(r)) readerOf.set(r, new Set()); readerOf.get(r).add(c.R); }
    L.push(`## BATCH under review: ${batch.length} entries added / changed since ${since}`, '');
    const byR = new Map(); for (const [id, e] of batch) { const k = [...(readerOf.get(id) || ['(no P1 cell)'])].sort().join(','); if (!byR.has(k)) byR.set(k, []); byR.get(k).push([id, e]); }
    for (const [R, members] of [...byR].sort()) {
      L.push(`### readers ${R} (${members.length})`, '');
      for (const [id, e] of members) L.push(`- \`${id}\` ${old[id] ? '(CHANGED)' : '(NEW)'}`, `  - applies when: ${fmtCond(e.appliesWhenAny, e.context || [])}`, `  - authority: ${e.authority}`, `  - why false excludes: ${e.whyFalseExcludes}`, `  - guards: ${e.guards.map(fmtGuard).join('; ')}`, `  - derived exclusion contexts: ${(ctxBy.get(id) || new Set()).size} P1 (S|brand|LP) — cases: required ${JSON.stringify(e.cases.required || [])}, excluded ${JSON.stringify(e.cases.excluded)}${e.cases.note ? ` (${e.cases.note})` : ''}`);
      L.push('');
    }
    const fr = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'p1a-frozen-exclusions.json'), 'utf8'));
    const out = der.filter((d) => d.cell.S === 'S1' && d.cell.brand === 'x_pizza' && d.cell.lp === 'new' && !fr.readers.includes(d.cell.R));
    L.push(`## S1 / x_pizza / new exclusions OUTSIDE P1-a's locked slice (${fr.readers.join(' ')}): ${new Set(out.map((d) => d.region)).size} regions, ${out.length} cells`, '');
    for (const r of [...new Set(out.map((d) => d.region))].sort()) L.push(`- \`${r}\` (${[...new Set(out.filter((d) => d.region === r).map((d) => d.cell.R))].join(', ')})`);
    L.push('', '## ALL reviewed entries, by condition', '');
  }
  for (const [k, members] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const { any, ctx } = JSON.parse(k); const e0 = members[0][1];   // one group per (condition, authority)
    L.push(`### applies when: ${fmtCond(any, ctx)}`, '');
    L.push(`- **authority:** ${e0.authority}`, `- **why false excludes:** ${e0.whyFalseExcludes}`);
    const contexts = new Set(); for (const [id] of members) for (const c of ctxBy.get(id) || []) contexts.add(c);
    const byS = {}; for (const c of contexts) { const [S, b, lp] = c.split('|'); ((byS[S] = byS[S] || new Set())).add(`${b}/${lp}`); }
    L.push(`- **derived exclusion contexts:** ${Object.entries(byS).map(([S, v]) => `${S} (${v.size})`).join(', ') || 'none'}`);
    L.push(`- **regions (${members.length}):**`);
    for (const [id, e] of members) L.push(`  - \`${id}\` — guards: ${e.guards.map(fmtGuard).join('; ')} — cases: required ${JSON.stringify(e.cases.required || [])}, excluded ${JSON.stringify(e.cases.excluded)}${e.cases.note ? ` (${e.cases.note})` : ''}`);
    L.push('');
  }
  return L.join('\n');
}
module.exports = { report };
if (require.main === module) { const si = process.argv.indexOf('--since'); const r = report({ since: si > 0 ? process.argv[si + 1] : null }); const i = process.argv.indexOf('--out'); if (i > 0) { fs.writeFileSync(process.argv[i + 1], r); console.log(`wrote ${process.argv[i + 1]}`); } else console.log(r); }
