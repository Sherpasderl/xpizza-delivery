'use strict';
/* R3 P1 §3c — APPLICABILITY BINDING PRIMITIVES. P1-b moved applicability to the region-level, derived model
 * (contract/region-applicability.js + .json; the P1-a explicit exclusions were migrated and are regression-locked by
 * contract/p1a-frozen-exclusions.json). This module keeps the shared primitives:
 *   · bindOf(region)   — a region's call-site text + enclosing census scope (sha256);
 *   · bindGuard / guardStale — a GUARD binding: a census scope containing an exact text (scope sha256), or a repo file in
 *     which an exact text occurs exactly once (selection tables, static markup);
 *   · scopeTextOf, canon, sha.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sources, walk, parseUnit } = require('./census');

const REPO = path.join(__dirname, '..', '..');
const SCENARIOS = path.join(__dirname, 'p1-scenarios.json');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));

// census function scopes: 'file#fn' → [source text of every function the census names fn in that unit]
let SCOPES = null;
function scopes(units = null) {
  if (SCOPES && !units) return SCOPES;
  const map = new Map();
  for (const u of units || sources()) {
    const base = u.file.replace(/<script@\d+>$/, '');
    walk(parseUnit(u), (node, fn) => {
      if (!/Function/.test(node.type) || !fn) return;
      // one key when the unit IS its file (no duplicated text)
      for (const k of new Set([`${u.file}#${fn}`, `${base}#${fn}`])) { if (!map.has(k)) map.set(k, []); map.get(k).push(u.code.slice(node.start, node.end)); }
    });
  }
  if (!units) SCOPES = map;
  return map;
}
const scopeText = (key, units = null) => { const t = scopes(units).get(key); return t && t.length ? t.join('\n\u0000\n') : null; };
const lineText = (file, line) => { const f = path.join(REPO, file.replace(/<script@\d+>$/, '')); const ls = fs.readFileSync(f, 'utf8').split('\n'); return ls[line - 1] === undefined ? null : ls[line - 1].trim(); };

/* the binding of a region: its call site (consumer line) or, for an @self region, its own definition */
function bindOf(r) {
  if (r.consumer) {
    const i = r.consumer.lastIndexOf('#'); const file = r.consumer.slice(0, i);
    const site = lineText(file, r.line); const scope = scopeText(r.consumer);
    return { site, siteSha: site == null ? null : sha(site), scope: r.consumer, scopeSha: scope == null ? null : sha(scope) };
  }
  const scope = scopeText(r.output);
  return { site: scope == null ? null : scope.split('\n')[0].trim(), siteSha: scope == null ? null : sha(scope.split('\n')[0].trim()), scope: r.output, scopeSha: scope == null ? null : sha(scope) };
}
/* the GUARD binding (codex P1-a r1 P1-6): the DISPATCH / guarding source that decides a region is not reached — a
 * census function scope containing an exact text (the scope's sha256 is recorded: any change to that function re-opens the
 * exclusion), or a repo file in which an exact text occurs exactly once (a top-level table such as whatsapp.js RENDERERS,
 * a static markup handler). An exclusion with no guard is malformed. */
function bindGuard(g) {
  const [kind, where, text] = g;
  if (kind === 'S') { const t = scopeText(where); if (t == null) throw new Error(`guard scope ${where} not found`); if (!t.includes(text)) throw new Error(`guard text not in ${where}: ${text}`); return { kind, scope: where, text, scopeSha: sha(t) }; }
  if (kind === 'F') { const f = fs.readFileSync(path.join(REPO, where), 'utf8'); const k = f.split(text).length - 1; if (k !== 1) throw new Error(`guard text occurs ${k}× in ${where}: ${text}`); return { kind, file: where, text }; }
  // C — the CALLER SET of an output (every census region whose output it is, from contract/regions.json, which the region
  // guard keeps current): a region reachable only through these callers goes stale when a caller is added / removed
  // R — every REFERENCE to a function name (codex P1-b b12 r1 P1-2: aliases / callbacks escape the census caller set): the
  // word-boundary occurrence count of the name in EVERY census source unit (all deployable code). An alias
  // (`const f = name`), a callback (`arr.map(name)`), a new call or a new file mentioning it → stale
  if (kind === 'R') { const counts = refCounts(where); if (!Object.keys(counts).length) throw new Error(`no reference to ${where} in any source unit`); return { kind, name: where, counts }; }
  // K — a call TEXT's occurrence COUNT in a file (for a function with no census caller set): a new / removed call site → stale
  if (kind === 'K') { const f = fs.readFileSync(path.join(REPO, where), 'utf8'); const k = f.split(text).length - 1; if (!k) throw new Error(`guard text absent in ${where}: ${text}`); return { kind, file: where, text, count: k }; }
  if (kind === 'C') { const callers = callersOf(where); if (!callers.length) throw new Error(`no census caller of ${where}`); return { kind, output: where, callers }; }
  throw new Error(`unknown guard kind ${kind}`);
}
let _units = null;
const refCounts = (name, units = null) => {
  const us = units || (_units = _units || require('./census').sources());
  const re = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`, 'g');
  const out = {}; for (const u of us) { const k = (String(u.code).match(re) || []).length; if (k) out[`${u.file}#${u.scope || ''}`] = (out[`${u.file}#${u.scope || ''}`] || 0) + k; }
  return Object.fromEntries(Object.entries(out).sort());
};
const callersOf = (output, regionsDoc = JSON.parse(fs.readFileSync(path.join(__dirname, 'regions.json'), 'utf8'))) => [...new Set(regionsDoc.regions.filter((r) => r.output === output).map((r) => r.consumer || 'self'))].sort();
function guardStale(gb, { readFile = (f) => fs.readFileSync(path.join(REPO, f), 'utf8'), units = null, regionsDoc = null } = {}) {
  if (gb.kind === 'S') { const t = scopeText(gb.scope, units); if (t == null) return `guard scope ${gb.scope} is gone`; if (!t.includes(gb.text)) return `guard text no longer in ${gb.scope}: "${gb.text}"`; if (sha(t) !== gb.scopeSha) return `guard scope ${gb.scope} changed`; return null; }
  if (gb.kind === 'F') { let f; try { f = readFile(gb.file); } catch (_) { return `guard file ${gb.file} is gone`; } const k = f.split(gb.text).length - 1; return k === 1 ? null : `guard text occurs ${k}× in ${gb.file} (was exactly once): "${gb.text}"`; }
  if (gb.kind === 'R') { const now = refCounts(gb.name, units); return JSON.stringify(now) === JSON.stringify(gb.counts) ? null : `the references to ${gb.name} changed (an alias / callback / call site was added or removed): ${JSON.stringify(gb.counts)} → ${JSON.stringify(now)}`; }
  if (gb.kind === 'K') { let f; try { f = readFile(gb.file); } catch (_) { return `guard file ${gb.file} is gone`; } const k = f.split(gb.text).length - 1; return k === gb.count ? null : `call text occurs ${k}× in ${gb.file} (was ${gb.count}×): "${gb.text}"`; }
  if (gb.kind === 'C') { const now = callersOf(gb.output, regionsDoc || undefined); return JSON.stringify(now) === JSON.stringify(gb.callers) ? null : `the callers of ${gb.output} changed: ${JSON.stringify(gb.callers)} → ${JSON.stringify(now)}`; }
  return `unknown guard kind ${gb.kind}`;
}

module.exports = { scopeTextOf: (k) => scopeText(k), SCENARIOS, bindOf, bindGuard, guardStale, sha, canon };
