'use strict';
/* R3 P1-b — the compact REVIEW REPORT for region-level applicability (codex P1-b design r1): grouped by condition, each
 * group showing its contract authority, why false excludes, its regions, guard references, the reviewed cases and the
 * derived exclusion contexts over P1. `node contract/applicability-report.js [--out file.md]` */
const fs = require('fs');
const RA = require('./region-applicability');
const SS = require('./scenario-state');
const { gateA } = require('./gate-a');

function report() {
  const doc = RA.load(); const paths = SS.load();
  const P1 = Object.keys(paths.scenarios);
  const cells = gateA({ scenarios: P1 }).cells;
  const der = RA.derive(doc, cells, paths);
  const ctxBy = new Map(); for (const d of der) { if (!ctxBy.has(d.region)) ctxBy.set(d.region, new Set()); ctxBy.get(d.region).add(`${d.cell.S}|${d.cell.brand}|${d.cell.lp}`); }
  const groups = new Map();
  for (const [id, e] of Object.entries(doc.regions)) { const k = JSON.stringify({ any: e.appliesWhenAny, ctx: e.context || [], auth: e.authority }); if (!groups.has(k)) groups.set(k, []); groups.get(k).push([id, e]); }
  const L = [`# R3 P1-b — region applicability review report`, '', `${Object.keys(doc.regions).length} reviewed regions in ${groups.size} condition groups; ${der.length} P1 cells statically excluded (each applies only when the run establishes its fields). Every other region is REQUIRED.`, ''];
  for (const [k, members] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const { any, ctx } = JSON.parse(k); const e0 = members[0][1];   // one group per (condition, authority)
    const cond = any.length ? any.map((c) => Object.entries(c).map(([f, v]) => `${f} ∈ {${v.join(', ')}}`).join(' ∧ ')).join('  ∨  ') : '(never by vector)';
    L.push(`## applies when: ${cond}${ctx.length ? ` · excluded only when context established: ${ctx.join(', ')}` : ''}`, '');
    L.push(`- **authority:** ${e0.authority}`, `- **why false excludes:** ${e0.whyFalseExcludes}`);
    const contexts = new Set(); for (const [id] of members) for (const c of ctxBy.get(id) || []) contexts.add(c);
    const byS = {}; for (const c of contexts) { const [S, b, lp] = c.split('|'); ((byS[S] = byS[S] || new Set())).add(`${b}/${lp}`); }
    L.push(`- **derived exclusion contexts:** ${Object.entries(byS).map(([S, v]) => `${S} (${v.size})`).join(', ') || 'none'}`);
    L.push(`- **regions (${members.length}):**`);
    for (const [id, e] of members) L.push(`  - \`${id}\` — guards: ${e.guards.map((g) => (g.kind === 'S' ? `${g.scope} ∋ \`${g.text.slice(0, 60)}\`` : `${g.file} ∋ \`${g.text.slice(0, 60)}\``)).join('; ')} — cases: required ${JSON.stringify(e.cases.required || [])}, excluded ${JSON.stringify(e.cases.excluded)}${e.cases.note ? ` (${e.cases.note})` : ''}`);
    L.push('');
  }
  return L.join('\n');
}
module.exports = { report };
if (require.main === module) { const r = report(); const i = process.argv.indexOf('--out'); if (i > 0) { fs.writeFileSync(process.argv[i + 1], r); console.log(`wrote ${process.argv[i + 1]}`); } else console.log(r); }
