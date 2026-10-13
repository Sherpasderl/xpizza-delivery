'use strict';
/* R3 P1 §12 C1 / §5b — PAGE TIMER INVENTORY vs the per-step HORIZONS (PLAN-R3-P1 rev 4). settle(horizon) fires every page
 * timer due within its horizon; a timer due LATER is untracked, so an assertion after settle() is only sound if every
 * longer timer either cannot reach the asserted output, or the step's horizon covers it. The census records no PAGE timer
 * sites, so this module inventories them from the census units of each asserted page: every setTimeout / setInterval call
 * (and the reviewed timer WRAPPERS, e.g. sherpa-client's setT / setI), its delay resolved statically (literals, consts,
 * arithmetic over them). contract/timer-bounds.json (reviewed) declares each page's step horizon and, for every site whose
 * delay EXCEEDS it or cannot be resolved, whether it reaches an asserted output — bound to the call's text (sha256).
 *   · a long / unresolved site with no reviewed entry → RED (a new long timer on an asserted page);
 *   · an entry that says it REACHES an asserted output while its bound is beyond the horizon or unresolved → RED (no
 *     declaration can clear an unresolved chain on an asserted path);
 *   · a stale entry (text changed / site gone) → RED.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sources, walk, parseUnit } = require('./census');

const FILE = path.join(__dirname, 'timer-bounds.json');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function ev(n, consts) {
  if (!n) return null;
  if (n.type === 'Literal' && typeof n.value === 'number') return n.value;
  if (n.type === 'Identifier' && consts.has(n.name)) return consts.get(n.name);
  if (n.type === 'BinaryExpression') { const l = ev(n.left, consts); const r = ev(n.right, consts); if (l == null || r == null) return null; const v = { '*': l * r, '+': l + r, '-': l - r, '/': l / r }[n.operator]; return v === undefined ? null : v; }
  return null;
}
function inventory(scopes, wrappers, units = sources()) {
  const out = [];
  for (const u of units.filter((x) => scopes.includes(x.scope))) {
    const ast = parseUnit(u); const consts = new Map();
    walk(ast, (node) => { if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) { const v = ev(node.init, consts); if (v != null) consts.set(node.id.name, v); } });
    const names = ['setTimeout', 'setInterval', ...(wrappers[u.file.replace(/<script@\d+>$/, '')] || [])];
    const seen = new Map();
    walk(ast, (node, fn) => {
      if (node.type !== 'CallExpression') return;
      const c = node.callee; const nm = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : null;
      if (!names.includes(nm)) return;
      const a = node.arguments[1]; const text = u.code.slice(node.start, node.end);
      const base = `${u.file}#${fn || '<top>'}:${nm}`; const k = (seen.get(base) || 0); seen.set(base, k + 1);
      const rec = { key: `${base}#${k}`, scope: u.scope, unit: u.file, kind: /Interval|^setI$/.test(nm) ? 'interval' : 'timeout', line: node.loc.start.line + u.lineOffset, delay: a ? ev(a, consts) : 0, delaySrc: a ? u.code.slice(a.start, a.end) : '0', sha: sha(text) };
      Object.defineProperty(rec, 'node', { value: node, enumerable: false }); Object.defineProperty(rec, 'start', { value: `${u.file}@${node.start}`, enumerable: false });
      out.push(rec);
    });
  }
  return out;
}
/* CHAINS (codex P1-a r1 P1-4): a timer whose callback — directly, or through functions it calls by name in the same unit
 * (transitively) — arms another timer forms a CHAIN; its cumulative delay is the sum along the path, and a path that
 * returns to a site already on it REPEATS. Every chain of ≥ 2 sites whose cumulative delay exceeds the page horizon, has
 * an unresolved delay, or repeats needs a reviewed, source-bound entry { cumulativeBoundMs, repeatLimit, reachesAsserted,
 * reason } (bound to the sha256 of its sites' call texts). reachesAsserted with a bound beyond the horizon or an
 * unbounded repeat → RED (no declaration clears it).
 * PERIODIC: every setInterval (or reviewed interval wrapper) on an asserted page whose period is within the horizon fires
 * during settle(): it needs a reviewed { periodMs, mayChange, changesAsserted:false } — what it may change; the journey's
 * §5b stability recapture checks its effect multiplicity on the asserted outputs. */
function chainsOf(scopes, wrappers, inv, units = sources()) {
  const byStart = new Map(inv.map((t) => [t.start, t]));
  const out = [];
  for (const u of units.filter((x) => scopes.includes(x.scope))) {
    const ast = parseUnit(u); const fnDefs = new Map(); const sites = inv.filter((t) => t.unit === u.file);
    walk(ast, (node) => {
      if (node.type === 'FunctionDeclaration' && node.id) fnDefs.set(node.id.name, node);
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && /Function/.test(node.init.type)) fnDefs.set(node.id.name, node.init);
    });
    const within = (root) => { const found = []; const calls = []; walk(root, (n) => { if (n.type !== 'CallExpression') return; const t = byStart.get(`${u.file}@${n.start}`); if (t) found.push(t); else if (n.callee.type === 'Identifier' && fnDefs.has(n.callee.name)) calls.push(n.callee.name); }); return { found, calls }; };
    const reach = new Map();   // site key → timer sites its callback can arm
    for (const t of sites) {
      const cb = t.node.arguments[0]; let roots = [];
      if (cb && /Function/.test(cb.type)) roots = [cb]; else if (cb && cb.type === 'Identifier' && fnDefs.has(cb.name)) roots = [fnDefs.get(cb.name)];
      const seenFn = new Set(); const next = new Set(); const q = [...roots];
      while (q.length) { const r = q.shift(); const { found, calls } = within(r); for (const f of found) if (f.node !== t.node || r !== cb) next.add(f.key); for (const c of calls) if (!seenFn.has(c) && seenFn.size < 40) { seenFn.add(c); q.push(fnDefs.get(c)); } }
      reach.set(t.key, [...next].filter((k) => k !== t.key || roots.length));
    }
    const siteBy = new Map(sites.map((t) => [t.key, t]));
    const dfs = (path) => {
      const last = path[path.length - 1]; const nx = reach.get(last) || [];
      if (!nx.length && path.length >= 2) out.push({ path: [...path], repeats: false });
      for (const k of nx) { if (path.includes(k)) { out.push({ path: [...path, k], repeats: true }); continue; } if (path.length < 8) dfs([...path, k]); }
    };
    for (const t of sites) dfs([t.key]);
    for (const c of out) if (!c.sites) { c.sites = c.path.map((k) => siteBy.get(k)).filter(Boolean); }
  }
  // dedupe: a chain that is the suffix of another is covered by it
  const key = (c) => c.path.join(' → ');
  const uniq = [...new Map(out.map((c) => [key(c), c])).values()];
  return uniq.filter((c) => !uniq.some((o) => o !== c && key(o).endsWith(key(c)) && o.path.length > c.path.length)).map((c) => {
    const delays = c.sites.slice(0, c.repeats ? -1 : undefined).map((t) => t.delay);
    const cumulative = delays.some((d) => d == null) ? null : delays.reduce((a, d) => a + d, 0);
    return { key: key(c), scope: c.sites[0].scope, repeats: c.repeats, cumulative, sha: sha(c.sites.map((t) => t.sha).join('|')) };
  });
}

function check(doc = JSON.parse(fs.readFileSync(FILE, 'utf8')), { units = sources() } = {}) {
  const p = []; const inv = inventory(Object.keys(doc.pages), doc.wrappers || {}, units);
  const entries = new Map(doc.sites.map((e) => [e.key, e]));
  const need = inv.filter((s) => s.delay == null || s.delay > doc.pages[s.scope].horizonMs);
  for (const s of need) {
    const e = entries.get(s.key);
    if (!e) { p.push(`${s.key} (line ${s.line}): delay ${s.delay == null ? `unresolved (${s.delaySrc})` : `${s.delay} ms`} exceeds the ${s.scope} horizon ${doc.pages[s.scope].horizonMs} ms — no reviewed entry`); continue; }
    if (e.sha !== s.sha) p.push(`${s.key}: the call text changed — re-review`);
    if (e.reachesAsserted && (s.delay == null || s.delay > doc.pages[s.scope].horizonMs)) p.push(`${s.key}: reaches an asserted output with ${s.delay == null ? 'an UNRESOLVED' : `a ${s.delay} ms`} delay beyond the horizon — RED (no declaration clears it)`);
    if (!(e.reason && e.reason.trim())) p.push(`${s.key}: needs a reason`);
  }
  const live = new Set(need.map((s) => s.key));
  for (const e of doc.sites) if (!live.has(e.key)) p.push(`${e.key}: stale entry (no such long / unresolved site)`);
  // chains
  const chains = chainsOf(Object.keys(doc.pages), doc.wrappers || {}, inv, units);
  const cneed = chains.filter((c) => c.repeats || c.cumulative == null || c.cumulative > doc.pages[c.scope].horizonMs);
  const centries = new Map((doc.chains || []).map((e) => [e.key, e]));
  for (const c of cneed) {
    const e = centries.get(c.key);
    if (!e) { p.push(`CHAIN ${c.key}: cumulative ${c.cumulative == null ? 'UNRESOLVED' : `${c.cumulative} ms`}${c.repeats ? ', REPEATS' : ''} beyond the ${c.scope} horizon ${doc.pages[c.scope].horizonMs} ms — no reviewed chain entry`); continue; }
    if (e.sha !== c.sha) p.push(`CHAIN ${c.key}: its call texts changed — re-review`);
    if (!(e.reason && e.reason.trim()) || e.repeatLimit === undefined) p.push(`CHAIN ${c.key}: needs repeatLimit and a reason`);
    const unbounded = e.repeatLimit === 'unbounded' || e.cumulativeBoundMs == null || e.cumulativeBoundMs > doc.pages[c.scope].horizonMs;
    if (e.reachesAsserted && unbounded) p.push(`CHAIN ${c.key}: reaches an asserted output with a cumulative bound beyond the horizon / unbounded repeat — RED (no declaration clears it)`);
  }
  const clive = new Set(cneed.map((c) => c.key));
  for (const e of doc.chains || []) if (!clive.has(e.key)) p.push(`CHAIN ${e.key}: stale chain entry`);
  // periodic
  const periodic = inv.filter((t) => t.kind === 'interval' && t.delay != null && t.delay <= doc.pages[t.scope].horizonMs);
  const pentries = new Map((doc.periodic || []).map((e) => [e.key, e]));
  for (const t of periodic) {
    const e = pentries.get(t.key);
    if (!e) { p.push(`PERIODIC ${t.key} (every ${t.delay} ms, line ${t.line}): fires within the ${t.scope} horizon — no reviewed periodic expectation`); continue; }
    if (e.sha !== t.sha) p.push(`PERIODIC ${t.key}: its call text changed — re-review`);
    if (!(e.mayChange && e.mayChange.trim())) p.push(`PERIODIC ${t.key}: needs mayChange`);
    if (e.changesAsserted) p.push(`PERIODIC ${t.key}: declared to change an asserted output within the horizon — RED (the assertion would race it)`);
  }
  const plive = new Set(periodic.map((t) => t.key));
  for (const e of doc.periodic || []) if (!plive.has(e.key)) p.push(`PERIODIC ${e.key}: stale periodic entry`);
  return { problems: p, inventory: inv, need, chains, cneed, periodic };
}
module.exports = { inventory, check, chainsOf, FILE, sha };
