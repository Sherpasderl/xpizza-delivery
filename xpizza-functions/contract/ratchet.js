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
function ratchet({ baseline, shrink, current }) {
  const problems = []; const grown = {}; const shrunk = {};
  const nd = new Set((shrink.nondeterministic || []).map((e) => `${e.context}|${e.site}`));
  for (const e of shrink.nondeterministic || []) {
    if (!(e.reason && String(e.reason).trim())) problems.push(`nondeterministic entry ${e.context}|${e.site}: needs a reason`);
    if (((baseline.contexts || {})[e.context] || []).includes(e.site)) problems.push(`nondeterministic entry ${e.context}|${e.site} is also in the baseline — remove it from the baseline`);
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

module.exports = { ratchet, load, writeBaseline, BASELINE, SHRINK };
