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
    // only a `const` binds a value; a `let` / `var` (a loop's `attempt`) varies — never resolved (unresolved = reviewed)
    walk(ast, (node, _fn, parent) => { if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && parent && parent.kind === 'const') { const v = ev(node.init, consts); if (v != null) consts.set(node.id.name, v); } });
    const names = ['setTimeout', 'setInterval', ...(wrappers[u.file.replace(/<script@\d+>$/, '')] || [])];
    const seen = new Map();
    /* the CONTROLLING SCOPE of a timer call (codex P1-a r3 P1-1): the OUTERMOST function enclosing it (its loops, retries
     * and local constants — e.g. submitOrder's `MAX_TRIES` and retry loop) plus the DECLARATION texts of every identifier
     * in its delay expression and in the tests / updates of the loops around it (wherever in the unit they are declared).
     * A reviewed bound is bound to this hash: any change to what controls the timer's cumulative behaviour → re-review. */
    const decls = new Map();
    walk(ast, (n) => { if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') { if (!decls.has(n.id.name)) decls.set(n.id.name, []); decls.get(n.id.name).push(u.code.slice(n.start, n.end)); } });
    const idsIn = (n, acc = new Set()) => { if (!n || typeof n.type !== 'string') return acc; if (n.type === 'Identifier') acc.add(n.name); for (const k2 of Object.keys(n)) { if (k2 === 'loc') continue; const v = n[k2]; if (Array.isArray(v)) v.forEach((x) => idsIn(x, acc)); else if (v && typeof v.type === 'string') idsIn(v, acc); } return acc; };
    const ctrl = new Map();
    (function rec(n, stack) {
      if (!n || typeof n.type !== 'string') return;
      const st = /Function|Statement$/.test(n.type) ? [...stack, n] : stack;
      if (n.type === 'CallExpression') {
        const c = n.callee; const nm2 = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : null;
        if (names.includes(nm2)) {
          const outer = stack.find((x) => /Function/.test(x.type)) || null;
          const loops = stack.filter((x) => /^(For|ForIn|ForOf|While|DoWhile)Statement$/.test(x.type));
          const ids = new Set(); idsIn(n.arguments[1], ids); for (const L of loops) { idsIn(L.test, ids); idsIn(L.update, ids); idsIn(L.init, ids); idsIn(L.right, ids); }
          const declText = [...ids].sort().map((id) => `${id}=${(decls.get(id) || []).join(' | ')}`).join('\n');
          ctrl.set(n.start, sha(`${outer ? u.code.slice(outer.start, outer.end) : '<top>'}\n--\n${declText}`));
        }
      }
      for (const k2 of Object.keys(n)) { if (k2 === 'loc') continue; const v = n[k2]; if (Array.isArray(v)) v.forEach((x) => rec(x, st)); else if (v && typeof v.type === 'string') rec(v, st); }
    })(ast, []);
    walk(ast, (node, fn) => {
      if (node.type !== 'CallExpression') return;
      const c = node.callee; const nm = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : null;
      if (!names.includes(nm)) return;
      const a = node.arguments[1]; const text = u.code.slice(node.start, node.end);
      const base = `${u.file}#${fn || '<top>'}:${nm}`; const k = (seen.get(base) || 0); seen.set(base, k + 1);
      const rec = { key: `${base}#${k}`, scope: u.scope, unit: u.file, kind: /Interval|^setI$/.test(nm) ? 'interval' : 'timeout', line: node.loc.start.line + u.lineOffset, delay: a ? ev(a, consts) : 0, delaySrc: a ? u.code.slice(a.start, a.end) : '0', sha: sha(text), ctrlSha: ctrl.get(node.start) };
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
    // functions by NAME, and METHODS by property name (codex r2 P1-3: a chain continued through obj.method() — over-
    // approximated by property name, fail closed: an unrelated method of the same name only adds a chain to review)
    const methodDefs = new Map(); const addM = (k, f) => { if (!methodDefs.has(k)) methodDefs.set(k, []); methodDefs.get(k).push(f); };
    walk(ast, (node) => {
      if (node.type === 'FunctionDeclaration' && node.id) fnDefs.set(node.id.name, node);
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && /Function/.test(node.init.type)) fnDefs.set(node.id.name, node.init);
      if (node.type === 'Property' && node.key && /Function/.test((node.value || {}).type || '')) addM(node.key.name || node.key.value, node.value);
      if (node.type === 'MethodDefinition' && node.key) addM(node.key.name, node.value);
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed && /Function/.test(node.right.type)) addM(node.left.property.name, node.right);
    });
    const within = (root) => { const found = []; const calls = []; walk(root, (n) => { if (n.type !== 'CallExpression') return; const t = byStart.get(`${u.file}@${n.start}`); if (t) found.push(t); else if (n.callee.type === 'Identifier' && fnDefs.has(n.callee.name)) calls.push(fnDefs.get(n.callee.name)); else if (n.callee.type === 'MemberExpression' && !n.callee.computed && methodDefs.has(n.callee.property.name)) calls.push(...methodDefs.get(n.callee.property.name)); }); return { found, calls }; };
    const reach = new Map();   // site key → timer sites its callback can arm
    for (const t of sites) {
      const cb = t.node.arguments[0]; let roots = [];
      if (cb && /Function/.test(cb.type)) roots = [cb]; else if (cb && cb.type === 'Identifier' && fnDefs.has(cb.name)) roots = [fnDefs.get(cb.name)];
      if (cb && cb.type === 'MemberExpression' && !cb.computed && methodDefs.has(cb.property.name)) roots = methodDefs.get(cb.property.name);
      const seenFn = new Set(); const next = new Set(); const q = [...roots];
      while (q.length) { const r = q.shift(); const { found, calls } = within(r); for (const f of found) if (f.node !== t.node || r !== cb) next.add(f.key); for (const c of calls) if (!seenFn.has(c) && seenFn.size < 60) { seenFn.add(c); q.push(c); } }
      reach.set(t.key, [...next].filter((k) => k !== t.key || roots.length));
    }
    const siteBy = new Map(sites.map((t) => [t.key, t]));
    const dfs = (path) => {
      const last = path[path.length - 1]; const nx = reach.get(last) || [];
      if (!nx.length && path.length >= 2) out.push({ path: [...path], repeats: false });
      for (const k of nx) { if (path.includes(k)) { out.push({ path: [...path, k], repeats: true }); continue; } if (path.length < 8) dfs([...path, k]); }
    };
    for (const t of sites) dfs([t.key]);
    // AWAITED SLEEPS (codex r2 P1-3): inside one function, each `await <something that arms a timer>` in source order is a
    // step of a chain — even when the function's promise is never returned to anyone; an awaited sleep inside a loop
    // REPEATS. The awaited expression's timer is found lexically, or through the function / method it calls.
    const timersIn = (root) => { const acc = []; const seen = new Set(); const q = [root]; while (q.length) { const r = q.shift(); if (!r || seen.has(r)) continue; seen.add(r); const { found, calls } = within(r); acc.push(...found); q.push(...calls); } return acc; };
    (function scan(node, fnNode, loopDepth) {
      if (!node || typeof node.type !== 'string') return;
      if (/Function/.test(node.type) && node !== fnNode) {
        const awaits = [];
        (function inner(n, ld) {
          if (!n || typeof n.type !== 'string') return;
          if (/Function/.test(n.type) && n !== node) return;   // a nested function is its own scope
          if (n.type === 'AwaitExpression') { const ts = timersIn(n.argument); if (ts.length) awaits.push({ site: ts[0], inLoop: ld > 0 }); }
          const isLoop = /^(For|ForIn|ForOf|While|DoWhile)Statement$/.test(n.type);
          for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach((x) => inner(x, ld + (isLoop ? 1 : 0))); else if (v && typeof v.type === 'string') inner(v, ld + (isLoop ? 1 : 0)); }
        })(node.body, 0);
        if (awaits.length >= 2 || awaits.some((a) => a.inLoop)) {
          const repeats = awaits.some((a) => a.inLoop);
          out.push({ path: [`await@${u.file}:${node.loc.start.line + u.lineOffset}`, ...awaits.map((a) => a.site.key)], repeats, sites: awaits.map((a) => a.site), awaitChain: true, hostSha: sha(u.code.slice(node.start, node.end)) });
        }
      }
      for (const k of Object.keys(node)) { if (k === 'loc') continue; const v = node[k]; if (Array.isArray(v)) v.forEach((x) => scan(x, /Function/.test(node.type) ? node : fnNode, loopDepth)); else if (v && typeof v.type === 'string') scan(v, /Function/.test(node.type) ? node : fnNode, loopDepth); }
    })(ast, null, 0);
    for (const c of out) if (!c.sites) { c.sites = c.path.map((k) => siteBy.get(k)).filter(Boolean); }
  }
  // dedupe: a chain that is the suffix of another is covered by it
  const key = (c) => c.path.join(' → ');
  const uniq = [...new Map(out.map((c) => [key(c), c])).values()];
  return uniq.filter((c) => !uniq.some((o) => o !== c && key(o).endsWith(key(c)) && o.path.length > c.path.length)).map((c) => {
    const delays = (c.awaitChain ? c.sites : c.sites.slice(0, c.repeats ? -1 : undefined)).map((t) => t.delay);
    const cumulative = delays.some((d) => d == null) ? null : delays.reduce((a, d) => a + d, 0);
    return { key: key(c), scope: c.sites[0].scope, repeats: c.repeats, cumulative, sha: sha(c.sites.map((t) => t.sha).join('|')), ctrlSha: sha(c.sites.map((t) => t.ctrlSha).join('|') + (c.hostSha ? `|host:${c.hostSha}` : '')) };
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
    if (e.ctrlSha !== s.ctrlSha) p.push(`${s.key}: its CONTROLLING scope changed (the enclosing function, its loops or the declarations its delay / loops reference) — re-review the bound (RED)`);
    // an unresolved delay is bounded only by its REVIEWED bound; a declared bound below a computed delay is a contradiction
    if (s.delay != null && e.bound != null && e.bound < s.delay) p.push(`${s.key}: declared bound ${e.bound} ms is BELOW the computed delay ${s.delay} ms — a contradiction (RED)`);
    const eff = s.delay != null ? Math.max(s.delay, e.bound == null ? 0 : e.bound) : e.bound;
    if (e.reachesAsserted && (eff == null || eff > doc.pages[s.scope].horizonMs)) p.push(`${s.key}: reaches an asserted output with ${eff == null ? 'an UNRESOLVED (unreviewed-bound)' : `a ${eff} ms`} delay beyond the horizon — RED (no declaration clears it)`);
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
    if (e.ctrlSha !== c.ctrlSha) p.push(`CHAIN ${c.key}: its CONTROLLING scope changed (an enclosing function, loop, retry limit or referenced declaration) — re-review the bound (RED)`);
    if (!(e.reason && e.reason.trim()) || e.repeatLimit === undefined) p.push(`CHAIN ${c.key}: needs repeatLimit and a reason`);
    // a declaration can never be BELOW what the scanner computed (codex r2 P1-3): the computed bound overrides; a contradiction → RED
    if (c.cumulative != null && e.cumulativeBoundMs != null && e.cumulativeBoundMs < c.cumulative) p.push(`CHAIN ${c.key}: declared cumulativeBoundMs ${e.cumulativeBoundMs} is BELOW the computed ${c.cumulative} ms — a contradiction (RED)`);
    if (c.repeats && typeof e.repeatLimit === 'number' && e.repeatLimit < 2) p.push(`CHAIN ${c.key}: the chain REPEATS but repeatLimit ${e.repeatLimit} < 2 — a contradiction (RED)`);
    const effBound = c.cumulative == null ? e.cumulativeBoundMs : Math.max(c.cumulative, e.cumulativeBoundMs == null ? 0 : e.cumulativeBoundMs);
    const unbounded = e.repeatLimit === 'unbounded' || effBound == null || effBound > doc.pages[c.scope].horizonMs;
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
    if (e.ctrlSha !== t.ctrlSha) p.push(`PERIODIC ${t.key}: its CONTROLLING scope changed — re-review (RED)`);
    if (!(e.mayChange && e.mayChange.trim())) p.push(`PERIODIC ${t.key}: needs mayChange`);
    if (e.changesAsserted) p.push(`PERIODIC ${t.key}: declared to change an asserted output within the horizon — RED (the assertion would race it)`);
  }
  const plive = new Set(periodic.map((t) => t.key));
  for (const e of doc.periodic || []) if (!plive.has(e.key)) p.push(`PERIODIC ${e.key}: stale periodic entry`);
  return { problems: p, inventory: inv, need, chains, cneed, periodic };
}
module.exports = { inventory, check, chainsOf, FILE, sha };
