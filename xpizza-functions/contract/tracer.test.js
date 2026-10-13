'use strict';
// R3 P1 §3a — THE TRACER's acceptance (static; npm test chain). The rewrite is semantics-preserving on its supported form,
// leaves every other form untraced (reported), keeps line numbers, is bound to the census text, and cannot be bypassed by
// the module cache. Run: node contract/tracer.test.js
const assert = require('assert');
const vm = require('vm');
const acorn = require('acorn');
const { spawnSync } = require('child_process');
const path = require('path');
const { transform, rewrite, censusIndex, TracerMismatch, installServer } = require('./tracer');
const { sources } = require('./census');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-TRACER ${m}`;

// synthetic sites: every member read of one of `fields` (dot or literal bracket), numbered in source order
function sitesFor(code, fields) {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script' }); const out = [];
  (function rec(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'MemberExpression') { const f = node.computed ? (node.property.type === 'Literal' ? node.property.value : null) : node.property.name; if (fields.includes(f)) out.push({ n: out.length, id: `syn#${f}#${out.length}`, pos: node.start, kind: 'member', field: f }); }
    for (const k of Object.keys(node)) { if (k === 'loc') continue; const v = node[k]; if (Array.isArray(v)) v.forEach(rec); else if (v && typeof v.type === 'string') rec(v); }
  })(ast);
  return out;
}
// run code in a fresh context; returns { result, hits[] }
function run(code, extra = {}) {
  const hits = [];
  const ctx = vm.createContext({ __r3hit: (k) => hits.push(k), log: [], ...extra });
  const result = vm.runInContext(code, ctx);
  return { result, hits, log: ctx.log };
}
const both = (code, fields, extra) => { const sites = sitesFor(code, fields); const r = rewrite(code, sites, false); return { sites, r, orig: run(code, extra), traced: run(r.code, extra) }; };

// 1. opposite ternary arms on ONE line are two sites; only the evaluated one is hit
{
  const code = "const o = { restaurant_id: 'la_musa' }; const flag = true; flag ? o.restaurant_id : o.restaurant_id;";
  const { sites, r, orig, traced } = both(code, ['restaurant_id']);
  assert.ok(sites.length === 2 && r.traced.length === 2 && traced.result === orig.result && JSON.stringify(traced.hits) === JSON.stringify([0]), FAIL(`ternary arms: ${JSON.stringify({ sites: sites.length, traced: r.traced, hits: traced.hits })}`));
  ok('opposite ternary arms on one line: two distinct site ids; only the evaluated arm (site 0) is hit; value unchanged');
}
// 2. a repeated read is ONE site hit three times — never inferred as several sites
{
  const code = "const o = { total: 5 }; let s = 0; for (let i = 0; i < 3; i++) s += o.total; s;";
  const { sites, orig, traced } = both(code, ['total']);
  assert.ok(sites.length === 1 && traced.result === orig.result && traced.hits.length === 3 && new Set(traced.hits).size === 1, FAIL('repeated read'));
  ok('a repeated read: one site id, three hits — identity is static, never from counts');
}
// 3. getter call count AND order unchanged
{
  const code = "const o = { get total() { log.push('total'); return 7; }, get name() { log.push('name'); return 'x'; } }; [o.total, o.name, o.total];";
  const { orig, traced } = both(code, ['total', 'name']);
  assert.ok(JSON.stringify(orig.log) === JSON.stringify(traced.log) && JSON.stringify(orig.result) === JSON.stringify(traced.result), FAIL(`getters: ${JSON.stringify({ o: orig.log, t: traced.log })}`));
  ok(`getters: call count and order identical (${orig.log.join(',')})`);
}
// 4. nested member reads: each traced, values unchanged; the receiver of a method call on a traced read is preserved
{
  const code = "const o = { items: { list: [1,2,3] } }; [o.items.list.length, o.items.list.map(function (x) { return x * 2; }).join('|')];";
  const { sites, r, orig, traced } = both(code, ['items', 'list']);
  assert.ok(sites.length === 4 && r.traced.length === 4 && JSON.stringify(orig.result) === JSON.stringify(traced.result), FAIL(`nested / receiver: ${JSON.stringify({ sites: sites.length, traced: r.traced.length, o: orig.result, t: traced.result })}`));
  ok('nested member reads traced (4 sites); a method called ON a traced read keeps its receiver; results identical');
}
// 5. optional chains: the WHOLE chain is wrapped (short-circuit preserved); an inner link is untraced
{
  const code = "const a = null; const b = { total: 3, inner: { total: 4 } }; [a?.total, b?.total, b?.inner.total];";
  const { r, orig, traced } = both(code, ['total', 'inner']);   // `b?.inner` is an inner link of the chain `b?.inner.total`
  assert.ok(JSON.stringify(orig.result) === JSON.stringify(traced.result) && r.untraced.some((u) => /inside an optional chain/.test(u.reason)), FAIL(`optional: ${JSON.stringify({ o: orig.result, t: traced.result, un: r.untraced })}`));
  ok(`optional chains: short-circuit preserved (${JSON.stringify(traced.result)}); an inner chain link is reported untraced`);
}
// 6. untraced forms: call callee (incl. parenthesized), tagged-template tag, assignment / update / delete targets
{
  const code = "const o = { fmt: function () { return this.v; }, v: 9, tag: function (s) { return s[0]; }, total: 1 }; const r1 = o.fmt(); const r2 = (o.fmt)(); const r3 = o.tag`x`; o.total = 2; o.total++; delete o.total; [r1, r2, r3];";
  const { r, orig, traced } = both(code, ['fmt', 'tag', 'total']);
  const reasons = r.untraced.map((u) => u.reason).sort();
  assert.ok(JSON.stringify(orig.result) === JSON.stringify(traced.result) && r.traced.length === 0 && ['assignment target', 'call callee', 'call callee', 'delete target', 'tagged-template tag', 'update target'].every((x) => reasons.includes(x)), FAIL(`untraced forms: ${JSON.stringify({ traced: r.traced, reasons })}`));
  ok(`untraced (reported, still covered by gate A): ${[...new Set(reasons)].join(', ')} — receivers and results unchanged`);
}
// 7. EVERY real census unit: transforms, still parses, line count unchanged; the untraced inventory is reported
{
  const idx = censusIndex(); let tr = 0; let un = 0; const why = {};
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, allowImportExportEverywhere: true, allowAwaitOutsideFunction: true };
  for (const u of sources()) {
    if (!idx.byFile.has(u.file)) continue;
    const r = transform(u.file, u.code, { module: u.module });
    tr += r.traced.length; un += r.untraced.length; r.untraced.forEach((x) => { why[x.reason] = (why[x.reason] || 0) + 1; });
    let parsed = false; for (const st of ['module', 'script']) { try { acorn.parse(r.code, { ...opts, sourceType: st }); parsed = true; break; } catch (_) { /* next */ } }
    assert.ok(parsed, FAIL(`${u.file}: the traced text does not parse`));
    assert.strictEqual(r.code.split('\n').length, u.code.split('\n').length, FAIL(`${u.file}: line count changed`));
  }
  assert.strictEqual(tr + un, idx.ids.length, FAIL('every census site is either traced or reported untraced'));
  ok(`every census unit (${idx.byFile.size}) transforms, parses and keeps its line count: ${tr} sites traced, ${un} untraced (${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(', ')})`);
}
// 8. the binding: a loaded text that is not the census text is REFUSED
{
  const u = sources().find((x) => x.file === 'xpizza-functions/whatsapp.js');
  assert.throws(() => transform(u.file, u.code + '\n// drift'), TracerMismatch, FAIL('a drifted unit was instrumented'));
  ok('binding: a unit whose loaded text differs from the reviewed census text → TracerMismatch (never instrumented against other text)');
}
// 9. module-cache bypass refused; and a real server install records hits (child process: a clean module cache)
{
  require('../whatsapp');   // a census unit now sits in the require cache
  assert.throws(() => installServer({ hit() {} }), /module cache would bypass the tracer/, FAIL('installServer accepted an already-loaded census unit'));
  const child = spawnSync(process.execPath, ['-e', `
    const { installServer, createRecorder } = require(${JSON.stringify(path.join(__dirname, 'tracer.js'))});
    const rec = createRecorder(); const t = installServer(rec); rec.setContext('probe');
    require(${JSON.stringify(path.join(__dirname, '..', 'whatsapp.js'))});
    const ap = require(${JSON.stringify(path.join(__dirname, '..', 'alert-prune.js'))});
    const ids = ap.alertOrderIds({ detail: { order_id: 'o1', breaches: [{ order_id: 'o2' }] } });
    const h = rec.hitsByContext().probe; console.log(JSON.stringify({ hits: h ? h.size : 0, ids, units: t.manifest.map((m) => m.unit) }));
  `], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  const out = JSON.parse((child.stdout || '').trim().split('\n').pop() || '{}');
  assert.ok(child.status === 0 && out.hits >= 2 && JSON.stringify(out.ids) === JSON.stringify(['o1', 'o2']) && out.units.includes('xpizza-functions/whatsapp.js') && out.units.includes('xpizza-functions/alert-prune.js'), FAIL(`server install: ${child.status} ${child.stderr} ${child.stdout}`));
  ok(`module cache: installServer refuses once a census unit is loaded; a clean install transforms the loaded census units (whatsapp.js, alert-prune.js); alertOrderIds returns the same ids and records ${out.hits} distinct site hits`);
}
console.log(`\nr3-tracer: OK (${n})`);
