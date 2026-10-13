'use strict';
/* R3 §3a — apply contract/census-map.json to contract/census.js's inventory → the reviewed contract/census.json.
 * `node contract/census-build.js --write` regenerates it; census.guard.test.js recomputes and compares. */
const fs = require('fs');
const path = require('path');
const { census } = require('./census');
const { REVIEWED_SLEEPS } = require('./scheduler');

const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'census-map.json'), 'utf8'));
const OUT = path.join(__dirname, 'census.json');

// codex r1 P1-2: NO catch-all. A site is (1) a SEND-BOUNDARY reader (mapped to its send's R-site), (2) a server reader
// half listed narrowly by file / file#fn, (3) a page reader by the surface rules, or (4) EXEMPTED by an explicit per-
// FUNCTION entry carrying its category reason. Anything else is unmapped → RED.
const used = { serverFunctions: new Set(), pageFunctionExemptions: new Set(), serverReaders: new Set() };
function ruleFor(x) {
  const fileRel = x.file.replace(/^xpizza-functions\//, '');
  if (x.send) return { rule: 'send-boundary', map: x.send };
  if (x.scope === 'functions' || /^xpizza-functions\//.test(x.file)) {
    const rk = MAP.serverReaders[`${fileRel}#${x.fn}`] ? `${fileRel}#${x.fn}` : (MAP.serverReaders[fileRel] ? fileRel : null);
    if (rk) { used.serverReaders.add(rk); return { rule: `server-reader:${rk}`, map: MAP.serverReaders[rk] }; }
    const cat = MAP.serverFunctions[`${fileRel}#${x.fn}`];
    if (cat) { used.serverFunctions.add(`${fileRel}#${x.fn}`); return { rule: `server:${cat}`, exempt: MAP.serverCategories[cat] }; }
    return null;
  }
  for (const r of MAP.surfaces) {
    if (!new RegExp(r.file).test(x.file)) continue;
    if (r.fn && !new RegExp(r.fn).test(x.fn || '')) continue;
    if (r.field && !new RegExp(r.field).test(x.field || '')) continue;
    return r;
  }
  const pk = `${x.file}#${x.fn}`;
  if (MAP.pageFunctionExemptions[pk]) { used.pageFunctionExemptions.add(pk); return { rule: 'page-fn', exempt: MAP.pageFunctionExemptions[pk] }; }
  return null;
}

function build({ extraUnits = [] } = {}) {
  const c = census({ explicit: MAP.explicitProjections || [], extraUnits });
  const problems = [];
  for (const k of Object.keys(used)) used[k].clear();
  const sites = c.sites.map((s) => { const r = ruleFor(s); if (!r) problems.push(`unmapped site ${s.id}`); return { id: s.id, line: s.line, kind: s.kind, facts: s.facts, ...(s.alias ? { alias: s.alias } : {}), ...(s.send ? { send: s.send } : {}), rule: r ? r.rule : null, ...(r && r.map ? { r: r.map } : {}), ...(r && r.exempt ? { exempt: true } : {}) }; });
  const opaque = c.opaque.map((o) => { const r = ruleFor({ ...o, scope: /^xpizza-functions\//.test(o.file) ? 'functions' : 'page' }); if (!r) problems.push(`unmapped opaque ${o.file}#${o.fn}:${o.line} (${o.how})`); return { ...o, rule: r ? r.rule : null, ...(r && r.map ? { r: r.map } : {}) }; });
  // stale explicit entries (a listed function that no longer has a site) — the lists stay exact
  for (const k of Object.keys(MAP.serverFunctions)) if (!used.serverFunctions.has(k)) problems.push(`stale serverFunctions entry: ${k}`);
  for (const k of Object.keys(MAP.serverReaders)) if (!used.serverReaders.has(k)) problems.push(`stale serverReaders entry: ${k}`);
  // projection premise (the KDS card's known renames must be present)
  for (const [scope, want] of Object.entries(MAP.projectionPremise || {})) {
    const have = new Set(c.projections.filter((p) => p.scope === scope).map((p) => p.alias));
    for (const a of want) if (!have.has(a)) problems.push(`projection premise: ${scope} lacks alias ${a}`);
  }
  // sentinel: every hit must be exempted by key
  const exemptKeys = new Set((MAP.sentinelExemptions || []).map((e) => e.key));
  const sentinel = c.sentinel.map((s) => ({ ...s, exempt: exemptKeys.has(s.key) }));
  for (const s of sentinel.filter((x) => !x.exempt)) problems.push(`write sentinel: ${s.file} ${s.fn} writes '${s.key}' (${s.how}) — a tip / delivery fee / order email is not implemented (§1): decide`);
  // timers: reviewed class; the application-sleep set must equal the scheduler's reviewed set
  const timers = c.timers.map((t) => {
    const k1 = `${t.file}:${t.fn}:${t.call}`;
    const rev = (MAP.timerReview || {})[k1];
    const cls = rev ? rev.class : t.proposed;
    if (cls === 'sdk-or-other') problems.push(`timer unreviewed: ${k1} (${t.delay}) at line ${t.line}`);
    return { key: k1, line: t.line, delay: t.delay, class: cls, ...(rev ? { reviewed: rev.reason } : {}) };
  });
  const sleeps = timers.filter((t) => t.class === 'application-sleep').map((t) => t.delay).sort();
  if (JSON.stringify(sleeps) !== JSON.stringify([...REVIEWED_SLEEPS].sort())) problems.push(`application sleeps ${JSON.stringify(sleeps)} ≠ the scheduler's reviewed set ${JSON.stringify(REVIEWED_SLEEPS)}`);
  const clocks = c.clocks.map((k) => ({ key: `${k.file}:${k.fn}:${k.what}`, line: k.line, class: k.proposed }));
  // codex rebase-r1 P1 (generalized): an UNREGISTERED field read on an order-ish object inside a function that reads MONEY /
  // CASH / COLLECT is RED unless reviewed as a non-fact — a new identity / amount field on a money path cannot pass silently
  const moneyFns = new Set(c.sites.filter((s) => (s.facts || []).some((f) => ['CASH', 'MONEY', 'COLLECT'].includes(f))).map((s) => `${s.file}#${s.fn}`));
  const NF = MAP.moneyPathNonFactReads || {};
  const moneyPathReads = (c.unknownReads || []).filter((x) => moneyFns.has(`${x.file}#${x.fn}`));
  // codex rebase-r2 P1: a review is bound to its SITE (field@file#fn), never to the field name — a new money-path use of a
  // reviewed field elsewhere is RED until it is reviewed there
  const npKey = (x) => `${x.field}@${x.file}#${x.fn}`;
  for (const x of moneyPathReads) if (!Object.prototype.hasOwnProperty.call(NF, npKey(x))) problems.push(`unregistered field read on a money path: '${x.field}' (${x.file} ${x.fn} line ${x.line}, on '${x.base}') — register it as a fact (census FIELD_FACTS) or review THIS site as a non-fact (census-map moneyPathNonFactReads['${npKey(x)}'])`);
  for (const k of Object.keys(NF)) if (k !== '_doc' && !moneyPathReads.some((x) => npKey(x) === k)) problems.push(`moneyPathNonFactReads['${k}'] is stale — that money-path read no longer exists`);
  // ── WRITE INVENTORY (codex r1 P1-1): every written order field is reviewed; opaque writes must be resolved ──
  const resolved = [];
  // codex r2 P1-1: a resolution is bound to its EXACT write site — file, function, kind AND the value expression — and
  // to the NUMBER of such writes; a new write of the same shape, or any other opaque write, is RED
  const resCount = new Map();
  const opaqueWrites = c.opaqueWrites.map((o) => {
    const r = (MAP.opaqueWriteResolutions || []).find((x) => x.file === o.file && x.fn === o.fn && x.how === o.how && x.detail === o.detail);
    if (!r) problems.push(`opaque order write unresolved: ${o.file} ${o.fn} ${o.how} line ${o.line} (${o.detail || '-'}) — resolve its fields in census-map`);
    else { resolved.push(...r.fields.map((f) => ({ file: o.file, fn: o.fn, field: f, how: `resolved:${o.how}`, line: o.line }))); resCount.set(r, (resCount.get(r) || 0) + 1); }
    return { ...o, resolved: r ? r.fields : null };
  });
  for (const r of MAP.opaqueWriteResolutions || []) {
    const k = resCount.get(r) || 0;
    if (k !== r.count) problems.push(`opaque-write resolution ${r.file} ${r.fn} ${r.how} (${r.detail}) matches ${k} write(s), reviewed for ${r.count}`);
  }
  const allWrites = [...c.writes, ...resolved];
  const fieldsWritten = [...new Set(allWrites.map((w) => w.field))].sort();
  for (const f of fieldsWritten) {
    const cls = (MAP.writtenFields || {})[f];
    if (!cls || cls.class === 'UNCLASSIFIED') { const w = allWrites.find((x) => x.field === f); problems.push(`NEW order field written: '${f}' (${w.file} ${w.fn} ${w.how} line ${w.line}) — classify it (a contract fact §1, or a reviewed non-fact)`); }
  }
  for (const f of Object.keys(MAP.writtenFields || {})) if (!fieldsWritten.includes(f)) problems.push(`stale written-field entry: '${f}' is no longer written`);
  for (const k of clocks.filter((x) => x.class === 'unclassified')) problems.push(`clock unclassified: ${k.key} line ${k.line}`);
  const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    problems,
    doc: {
      _doc: 'GENERATED by contract/census-build.js from contract/census.js + contract/census-map.json — do not edit by hand. The guard recomputes it; any new / stale / unmapped entry is RED.',
      counts: { units: c.units, sites: sites.length, mapped: sites.filter((s) => s.r).length, exempt: sites.filter((s) => s.exempt).length, byR: count(sites.filter((s) => s.r), (s) => s.r), exemptByCategory: count(sites.filter((s) => s.exempt), (s) => s.rule.replace(/^server:/, 'server ').replace(/^page-fn$/, 'page-fn').replace(/^form-.*/, s.rule)), sendSites: sites.filter((s) => s.send).length, fieldsWritten: fieldsWritten.length, opaqueWrites: opaqueWrites.length, opaque: opaque.length, projections: c.projections.length, sentinel: sentinel.length, timers: count(timers, (t) => t.class), clocks: count(clocks, (k) => k.class) },
      sites, opaque, projections: c.projections, sentinel, timers, clocks,
      writes: allWrites.map((w) => ({ key: `${w.file}#${w.fn}#${w.field}#${w.how}` })).filter((w, i, a) => a.findIndex((y) => y.key === w.key) === i),
      fieldsWritten: fieldsWritten.map((f) => ({ field: f, class: (MAP.writtenFields[f] || {}).class || null })), opaqueWrites,
    },
  };
}

module.exports = { build, OUT };

if (require.main === module) {
  const { problems, doc } = build();
  console.log(JSON.stringify(doc.counts, null, 1));
  if (problems.length) { console.error(`\n${problems.length} problem(s):\n  ${problems.slice(0, 40).join('\n  ')}`); process.exitCode = 1; }
  if (process.argv.includes('--write')) { fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n'); console.log(`wrote ${path.relative(process.cwd(), OUT)}`); }
}
