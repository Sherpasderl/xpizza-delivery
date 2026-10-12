'use strict';
// R3 §5a — THE HARNESS IS THE ONLY CAPABILITY PROVIDER (codex r8 narrow check). Static half: no test that boots a page may
// hand an unvirtualizable capability into it through a harness option — every bootPage(...) call's options object (and
// every local function it references, e.g. beforeScripts: (w) => installX(w)) — except the `html` page source — must not mention Worker, SharedWorker,
// MessageChannel, BroadcastChannel, worker_threads or child_process; and no page-booting file may load worker_threads /
// child_process at all. Runtime half (exercised here): page-harness refuses a Node global in the page realm, hardens
// every frame window at creation, and refuses worker_threads while a page is open.
// This guard file is the checker and is excluded from its own scan (its negatives are in-memory sources).
// Run: node --experimental-vm-modules contract/harness-capabilities.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-HARNESS-CAPS ${m}`;
const REPO = path.join(__dirname, '..', '..');
const SELF = path.relative(REPO, __filename);
const FORBIDDEN = /\b(Worker|SharedWorker|MessageChannel|BroadcastChannel|worker_threads|child_process)\b/;
const FORBIDDEN_LOAD = /(require\(\s*['"](node:)?(worker_threads|child_process)['"]\s*\)|from\s+['"](node:)?(worker_threads|child_process)['"])/;

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const k of Object.keys(node)) { if (k === 'loc') continue; const v = node[k]; if (Array.isArray(v)) v.forEach((c) => walk(c, visit)); else if (v && typeof v.type === 'string') walk(v, visit); }
}
function parse(code) {
  for (const sourceType of ['module', 'script']) { try { return acorn.parse(code, { ecmaVersion: 'latest', sourceType, allowHashBang: true, allowReturnOutsideFunction: true, locations: true }); } catch (_) { /* next */ } }
  return null;
}
// violations of one source: each bootPage(...) options object + the local functions / consts it references by name
function violations(file, code) {
  const out = [];
  if (FORBIDDEN_LOAD.test(code)) out.push(`${file}: a page-booting file loads worker_threads / child_process`);
  const ast = parse(code); if (!ast) { out.push(`${file}: unparseable`); return out; }
  const decls = new Map();
  walk(ast, (nd) => {
    if (nd.type === 'FunctionDeclaration' && nd.id) decls.set(nd.id.name, nd);
    if (nd.type === 'VariableDeclarator' && nd.id.type === 'Identifier' && nd.init) decls.set(nd.id.name, nd.init);
  });
  walk(ast, (nd) => {
    if (nd.type !== 'CallExpression' || !(nd.callee.type === 'Identifier' && nd.callee.name === 'bootPage')) return;
    let opt = nd.arguments[1]; if (!opt) return;
    if (opt.type === 'Identifier') opt = decls.get(opt.name) || opt;
    // the `html` option is PAGE source (it runs in the page realm, with no Node capability — exactly what the runtime
    // hardening covers); every OTHER option is harness-side code and is scanned, with the helpers it references
    const parts = opt.type === 'ObjectExpression' ? opt.properties.filter((pr) => !(pr.type === 'Property' && !pr.computed && ((pr.key.name || pr.key.value) === 'html'))) : [opt];
    const seen = new Set(); const queue = [...parts];
    while (queue.length) {
      const x = queue.shift(); const src = code.slice(x.start, x.end);
      const m = FORBIDDEN.exec(src);
      if (m) out.push(`${file}:${nd.loc.start.line}: a bootPage option references ${m[1]}`);
      walk(x, (id) => { if (id.type === 'Identifier' && decls.has(id.name) && !seen.has(id.name)) { seen.add(id.name); queue.push(decls.get(id.name)); } });
    }
  });
  return out;
}
const pageBooters = () => {
  const out = [];
  const visit = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) visit(f); else if (/\.(m?js)$/.test(e.name)) { const rel = path.relative(REPO, f); if (rel === SELF || rel.endsWith('contract/page-harness.js')) continue; const c = fs.readFileSync(f, 'utf8'); if (/\bbootPage\s*\(/.test(c)) out.push([rel, c]); }
  } };
  visit(path.join(REPO, 'xpizza-functions')); return out;
};

(async () => {
  const files = pageBooters();
  assert.ok(files.length >= 3, FAIL(`premise — page-booting files found: ${files.map((f) => f[0]).join(', ')}`));
  const v = files.flatMap(([f, c]) => violations(f, c));
  assert.deepStrictEqual(v, [], FAIL(`a test hands an unvirtualizable capability to a page:\n  ${v.join('\n  ')}`));
  ok(`${files.length} page-booting test files (${files.map((f) => path.basename(f[0])).join(', ')}): no bootPage option (or helper it references) mentions a channel / worker_threads / child_process; none loads them`);

  // negatives (in memory): codex's three installer shapes, and a helper referenced by beforeScripts
  const neg = [
    ['node installer', "bootPage('d', { beforeScripts: (w) => { w.__mk = () => new (require('worker_threads').Worker)('x'); } });"],
    ['fresh-frame installer', "bootPage('d', { beforeScripts: (w) => { w.__into = (t) => { t.Worker = NodeWorker; }; } });"],
    ['nested-frame helper', "function give(t) { t.MessageChannel = MC; }\nbootPage('d', { beforeScripts: (w) => { w.__give = give; } });"],
    ['options object by name', "const opts = { beforeScripts: (w) => { w.BroadcastChannel = BC; } };\nbootPage('d', opts);"],
    ['file loads child_process', "const cp = require('child_process');\nbootPage('d', {});"],
  ];
  for (const [label, code] of neg) assert.ok(violations('neg.js', code).length > 0, FAIL(`negative "${label}" passed the static guard`));
  ok(`static negatives refused: ${neg.map((x) => x[0]).join('; ')}`);

  // runtime half
  const { bootPage } = require('./page-harness');
  const page = '<!doctype html><html><body><div id="app"></div></body></html>';
  let refusedBoot = null;
  try { await bootPage('xpizza-functions', { html: page, beforeScripts: (w) => { w.require = require; } }); } catch (e) { refusedBoot = e.message; }
  assert.ok(refusedBoot && /Node global\(s\) require exposed/.test(refusedBoot), FAIL(`a Node global handed to the page realm did not refuse the boot (${refusedBoot})`));
  const p = await bootPage('xpizza-functions', { html: page });
  let loadRefused = null; try { require('node:' + 'worker_threads'); } catch (e) { loadRefused = e.message; }
  const settled = await p.settle(); const why = p.errors.find((e) => /worker_threads .*FAIL CLOSED/.test(e)); p.close();
  assert.ok(loadRefused && /may not be loaded while a page is open/.test(loadRefused) && settled === false && why, FAIL(`worker_threads loaded while a page was open (${JSON.stringify({ loadRefused, settled, why })})`));
  let afterClose = null; try { afterClose = typeof require('node:' + 'worker_threads').Worker; } catch (e) { afterClose = e.message; }
  assert.strictEqual(afterClose, 'function', FAIL('worker_threads stayed refused after every page closed'));
  ok('runtime: a Node global in the page realm refuses the boot; worker_threads required while a page is open → refused, recorded, settle() false; allowed again once no page is open');
  console.log(`\nr3-harness-capabilities guard: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('r3-harness-capabilities guard FAILED:', e && e.stack || e); process.exit(1); });
