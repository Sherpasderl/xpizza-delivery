'use strict';
/* R3 P1 §3a — GATE B: the SITE-HIT RATCHET (PLAN-R3-P1 rev 4, Amendment A2: site coverage = the static census + a hit
 * ratchet). The tracer (contract/tracer.js) records which census sites each run context reached. The reviewed baseline
 * contract/p1-hits.json holds, per context, the sites an enforced slice reached when it was last reviewed. A later run must
 * reach every baseline site, except those named in the reviewed contract/p1-hits-shrink.json (with a reason):
 *   · a baseline site no longer reached, without a shrink entry → RED (coverage silently lost);
 *   · a shrink entry for a site that IS reached again, or that is not in the baseline → RED (stale shrink);
 *   · NEW sites are reported (growth) — they enter the baseline only by a reviewed rewrite (R3_RATCHET_WRITE=1).
 */
const fs = require('fs');
const path = require('path');

const BASELINE = path.join(__dirname, 'p1-hits.json');
const SHRINK = path.join(__dirname, 'p1-hits-shrink.json');

/* NONDETERMINISTIC (reviewed, p1-hits-shrink.json `nondeterministic`): a site whose reach is a deliberate race in the
 * product (e.g. createOrder's identity-shadow sample is read ONLY if the shadow check already settled — "collect only if
 * already settled") is neither required nor growth. Each entry needs a reason, may not also sit in the baseline, and
 * must name a current census site (ratchet.guard). */
/* codex P1-a r3 P1-2: the category is PINNED. An entry is accepted only if it is in this reviewed list (a code change,
 * reviewed — never a data edit) AND its race justification is still the source: the justification text occurs exactly
 * once in its census scope, the site belongs to that scope, and the site's own source line is unchanged. Anything else
 * (an unrelated site moved into the category, a stale justification) → RED: it could hide genuinely lost coverage. */
const APPROVED_NONDETERMINISTIC = Object.freeze([
  Object.freeze({
    context: 'S1/x_pizza/new',
    site: 'xpizza-functions/index.js#createOrderApp.all#status#23',
    scope: 'xpizza-functions/index.js#createOrderApp.all',
    justification: 'const shadowResult = (shadowCheck && shadowCheck.isSettled()) ? shadowCheck.value() : null;',
    siteLine: "outcome: shadowResult ? (shadowResult.status === 'ok' ? 'reported' : shadowResult.status) : 'dropped',",
  }),
]);
/* the justification is matched in EXECUTABLE source (codex P1-a r4): the reviewed text is parsed to its declarator
 * (name + init); the scope's own AST must hold EXACTLY ONE declarator of that name whose init has the same TOKENS
 * (comments and whitespace never count). A commented-out declaration, or one re-pointed on the same line
 * (`/* … *\/ const shadowResult = null;`), no longer matches → stale. */
const tokensOf = (code) => { const acorn = require('acorn'); const out = []; for (const t of acorn.tokenizer(code, { ecmaVersion: 'latest' })) out.push(t.value === undefined ? t.type.label : `${t.type.label}:${t.value}`); return out.join(' '); };
function executableDeclarators(scope, name, units) {
  const { sources, walk, parseUnit } = require('./census');
  const found = [];
  for (const u of units || sources()) {
    const base = u.file.replace(/<script@\d+>$/, '');
    walk(parseUnit(u), (node, fn) => {
      if (!/Function/.test(node.type) || !fn || (`${u.file}#${fn}` !== scope && `${base}#${fn}` !== scope)) return;
      (function rec(n, top) {
        if (!n || typeof n.type !== 'string') return;
        if (/Function/.test(n.type) && !top) return;   // a nested function is its own scope
        if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === name) found.push(n.init ? tokensOf(u.code.slice(n.init.start, n.init.end)) : '');
        for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach((x) => rec(x, false)); else if (v && typeof v.type === 'string') rec(v, false); }
      })(node, true);
    });
  }
  return found;
}
function justificationProblems(e, { readFile = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8'), units = null } = {}) {
  const a = APPROVED_NONDETERMINISTIC.find((x) => x.context === e.context && x.site === e.site);
  if (!a) return [`nondeterministic entry ${e.context}|${e.site} is NOT in the reviewed APPROVED_NONDETERMINISTIC list (contract/ratchet.js) — a category entry is a reviewed code change, never a data edit`];
  const p = [];
  if (e.scope !== a.scope || e.justification !== a.justification || e.siteLine !== a.siteLine) p.push(`nondeterministic entry ${e.context}|${e.site}: its recorded justification differs from the reviewed one`);
  const decl = require('acorn').parse(a.justification, { ecmaVersion: 'latest' }).body[0].declarations[0];
  const want = tokensOf(a.justification.slice(decl.init.start, decl.init.end));
  const got = executableDeclarators(a.scope, decl.id.name, units);
  if (!got.length) p.push(`nondeterministic ${e.site}: no EXECUTABLE declaration of ${decl.id.name} in ${a.scope} (stale)`);
  else if (got.length !== 1 || got[0] !== want) p.push(`nondeterministic ${e.site}: the race justification no longer occurs exactly once in ${a.scope} as executable code (stale): ${a.justification}`);
  if (!e.site.startsWith(`${a.scope}#`)) p.push(`nondeterministic ${e.site}: the site is not in its justification scope ${a.scope}`);
  const c = JSON.parse(readFile('xpizza-functions/contract/census.json')).sites.find((x) => x.id === e.site);
  if (!c) p.push(`nondeterministic ${e.site}: not a current census site (stale)`);
  else { const file = e.site.slice(0, e.site.indexOf('#')).replace(/<script@\d+>$/, ''); const line = (readFile(file).split('\n')[c.line - 1] || '').trim(); if (line !== a.siteLine) p.push(`nondeterministic ${e.site}: its source line changed (stale) — now "${line.slice(0, 120)}"`); }
  return p;
}
function ratchet({ baseline, shrink, current, justify = justificationProblems }) {
  const problems = []; const grown = {}; const shrunk = {};
  const nd = new Set((shrink.nondeterministic || []).map((e) => `${e.context}|${e.site}`));
  for (const e of shrink.nondeterministic || []) {
    if (!(e.reason && String(e.reason).trim())) problems.push(`nondeterministic entry ${e.context}|${e.site}: needs a reason`);
    if (((baseline.contexts || {})[e.context] || []).includes(e.site)) problems.push(`nondeterministic entry ${e.context}|${e.site} is also in the baseline — remove it from the baseline`);
    problems.push(...justify(e));
  }
  const shr = new Map((shrink.entries || []).map((e) => [`${e.context}|${e.site}`, e]));
  for (const [ctx, sites] of Object.entries(baseline.contexts || {})) {
    const now = new Set(current[ctx] || []);
    for (const s of sites) {
      if (now.has(s)) continue;
      if (shr.has(`${ctx}|${s}`)) { (shrunk[ctx] = shrunk[ctx] || []).push(s); continue; }
      problems.push(`${ctx}: baseline site ${s} is no longer reached (no reviewed shrink entry)`);
    }
    const base = new Set(sites);
    for (const s of now) if (!base.has(s) && !nd.has(`${ctx}|${s}`)) (grown[ctx] = grown[ctx] || []).push(s);
  }
  for (const ctx of Object.keys(current)) if (!(ctx in (baseline.contexts || {}))) problems.push(`${ctx}: a run context with no baseline (review it: R3_RATCHET_WRITE=1)`);
  for (const e of shrink.entries || []) {
    const base = new Set((baseline.contexts || {})[e.context] || []);
    if (!base.has(e.site)) problems.push(`stale shrink entry ${e.context}|${e.site}: not in the baseline`);
    else if (new Set(current[e.context] || []).has(e.site)) problems.push(`stale shrink entry ${e.context}|${e.site}: the site is reached again — remove the entry`);
    if (!(e.reason && String(e.reason).trim())) problems.push(`shrink entry ${e.context}|${e.site}: needs a reason`);
  }
  return { problems, grown, shrunk };
}
const load = () => ({ baseline: JSON.parse(fs.readFileSync(BASELINE, 'utf8')), shrink: JSON.parse(fs.readFileSync(SHRINK, 'utf8')) });
function writeBaseline(current, note, shrink = null) {
  const nd = new Set(((shrink || load().shrink).nondeterministic || []).map((e) => `${e.context}|${e.site}`));
  const contexts = Object.fromEntries(Object.entries(current).sort().map(([k, v]) => [k, [...v].filter((x) => !nd.has(`${k}|${x}`)).sort()]));
  fs.writeFileSync(BASELINE, `{\n "_doc": ${JSON.stringify(`R3 P1 gate B baseline — the census sites each run context reached (contract/ratchet.js). Reviewed; rewritten only with R3_RATCHET_WRITE=1. ${note || ''}`.trim())},\n "contexts": {\n${Object.entries(contexts).map(([k, v]) => `  ${JSON.stringify(k)}: [\n${v.map((s) => `   ${JSON.stringify(s)}`).join(',\n')}\n  ]`).join(',\n')}\n }\n}\n`);
}

module.exports = { ratchet, load, writeBaseline, justificationProblems, APPROVED_NONDETERMINISTIC, BASELINE, SHRINK };
