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
function inventory(scopes, wrappers) {
  const out = [];
  for (const u of sources().filter((x) => scopes.includes(x.scope))) {
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
      out.push({ key: `${base}#${k}`, scope: u.scope, line: node.loc.start.line + u.lineOffset, delay: a ? ev(a, consts) : 0, delaySrc: a ? u.code.slice(a.start, a.end) : '0', sha: sha(text) });
    });
  }
  return out;
}
function check(doc = JSON.parse(fs.readFileSync(FILE, 'utf8'))) {
  const p = []; const inv = inventory(Object.keys(doc.pages), doc.wrappers || {});
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
  return { problems: p, inventory: inv, need };
}
module.exports = { inventory, check, FILE, sha };
