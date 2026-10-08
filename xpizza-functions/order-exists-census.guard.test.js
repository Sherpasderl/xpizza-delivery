'use strict';
// D4-c5 phase 1 — the refusal-emitter CENSUS (PLAN-D4c5 rev 6 §2 "Guards", codex r5 SF2). Run: node order-exists-census.guard.test.js
//
// Over EXECUTABLE code (the acorn syntax tree — comments and log strings are not response construction):
//  · BASELINE: at the plan's citation base bb37684 and at the integration parent f17466e, exactly SEVEN response
//    constructions carry a self-heal literal (`order_conflict` / `Order conflict` / `Order closed`), all in index.js.
//  · CANDIDATE: across every runtime module, those literals appear in exactly ONE response construction — createOrder's
//    terminal-safe branch, gated by OE.decideCashExistingRefusal(...).legacy — and the seven logical refusal branches
//    each answer through OE.orderExistsBody. Any additional emitter of a self-heal literal fails.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parse } = require('acorn');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('order-exists-census FAILED: exited without completing'); process.exitCode = 1; } });

const ROOT = __dirname;
const LEGACY = new Set(['order_conflict', 'Order conflict', 'Order closed']);
const ast = (src) => parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true, locations: true });

// every node, with its ancestor chain
function walk(node, visit, anc = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, anc);
  const next = anc.concat([node]);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, visit, next));
    else if (v && typeof v.type === 'string') walk(v, visit, next);
  }
}
const literalText = (nd) => (nd.type === 'Literal' && typeof nd.value === 'string' ? nd.value
  : nd.type === 'TemplateLiteral' ? nd.quasis.map((q) => q.value.cooked).join('${}') : null);

// executable string literals that ARE a legacy literal (exact value), wherever they sit
function legacySites(src, file) {
  const out = [];
  walk(ast(src), (nd, anc) => {
    const t = literalText(nd);
    if (t !== null && LEGACY.has(t)) out.push({ file, line: nd.loc.start.line, value: t, anc });
  });
  return out;
}
// `X.status(409).json(...)` calls
const is409Json = (nd) => nd.type === 'CallExpression' && nd.callee.type === 'MemberExpression' && nd.callee.property.name === 'json'
  && nd.callee.object.type === 'CallExpression' && nd.callee.object.callee.type === 'MemberExpression'
  && nd.callee.object.callee.property.name === 'status' && nd.callee.object.arguments[0] && nd.callee.object.arguments[0].value === 409;

function runtimeFiles() {
  const out = [];
  const rec = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'test', '.git'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (/\.js$/.test(e.name) && !/\.test\.js$|\.guard\.test\.js$/.test(e.name)) out.push(p);
    }
  };
  rec(ROOT);
  return out;
}

try {
  // ── 1. BASELINE: seven executable legacy-literal response sites, at bb37684 and at f17466e ───────────────────────
  for (const rev of ['bb37684', 'f17466e']) {
    const src = execFileSync('git', ['show', `${rev}:xpizza-functions/index.js`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
    const sites = legacySites(src, 'index.js');
    assert.strictEqual(sites.length, 7, `${rev}: exactly seven executable legacy literals (got ${sites.map((s) => s.line)})`);
    assert.ok(sites.every((s) => s.anc.some(is409Json)), `${rev}: each is inside a 409 response construction`);
    assert.deepStrictEqual(sites.map((s) => s.value), ['order_conflict', 'order_conflict', 'Order conflict', 'Order conflict', 'Order conflict', 'Order conflict', 'Order closed']);
    if (rev === 'bb37684') assert.deepStrictEqual(sites.map((s) => s.line), [808, 822, 1494, 1688, 1696, 1803, 1807], 'the plan §2 citation lines');
    if (rev === 'f17466e') assert.deepStrictEqual(sites.map((s) => s.line), [818, 832, 1504, 1698, 1706, 1813, 1817], 'the same seven, +10 after the portal split');
  }
  ok('baseline: exactly SEVEN executable legacy-literal 409 constructions in index.js at bb37684 (808/822/1494/1688/1696/1803/1807) and at f17466e (+10)');

  // ── 2. CANDIDATE: the literals survive ONLY in createOrder's terminal-safe branch ─────────────────────────────────
  {
    const all = [];
    for (const f of runtimeFiles()) all.push(...legacySites(fs.readFileSync(f, 'utf8'), path.relative(ROOT, f)));
    assert.strictEqual(all.length, 1, `🔴 exactly ONE executable legacy literal remains anywhere in the runtime (got ${all.map((s) => `${s.file}:${s.line} ${s.value}`)})`);
    const [only] = all;
    assert.strictEqual(only.file, 'index.js'); assert.strictEqual(only.value, 'order_conflict');
    assert.ok(only.anc.some(is409Json), 'it is a 409 response');
    // its nearest enclosing `if` tests `<x>.legacy`, and <x> was assigned from OE.decideCashExistingRefusal(cls.reason, ev)
    const ifs = only.anc.filter((a) => a.type === 'IfStatement');
    const gate = ifs[ifs.length - 1];
    assert.ok(gate && gate.test.type === 'MemberExpression' && gate.test.property.name === 'legacy', 'gated by `.legacy`');
    const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    const decl = new RegExp(`const ${gate.test.object.name} = OE\\.decideCashExistingRefusal\\(cls\\.reason, ev\\);`);
    assert.ok(decl.test(src), 'the gate is the pure decision over the classifier reason and the snapshot already read');
    assert.strictEqual(src.match(new RegExp(decl.source, 'g')).length, 1);
  }
  ok('candidate: across EVERY runtime module exactly ONE executable legacy literal remains — createOrder\'s `order_conflict`, gated by OE.decideCashExistingRefusal(cls.reason, ev).legacy');

  // ── 3. the seven logical branches answer through orderExistsBody; nothing else builds an existing-order 409 ─────
  {
    const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    const calls = [];
    walk(ast(src), (nd, anc) => {
      if (nd.type === 'CallExpression' && nd.callee.type === 'MemberExpression' && nd.callee.object.name === 'OE' && nd.callee.property.name === 'orderExistsBody') {
        assert.ok(anc.some(is409Json), `orderExistsBody at ${nd.loc.start.line} feeds a 409 response`);
        calls.push(src.slice(nd.arguments[0].start, nd.arguments[0].end));
      }
    });
    assert.deepStrictEqual(calls, ['oe.reason', "'client_update_race'", "'binding_format_invalid'", "'conflict'", "'binding_format_invalid'", "acq.reason || 'conflict'", "'closed'"],
      'exactly seven typed sites, in source order: 818 classifier, 832 race, 1504 classify-binding, 1698 restaurant, 1706 degraded-binding, 1813 acquire-conflict, 1817 acquire-closed');
    // no 409 anywhere in the runtime builds a literal whose error looks like an existing-order refusal
    for (const f of runtimeFiles()) {
      walk(ast(fs.readFileSync(f, 'utf8')), (nd) => {
        if (!is409Json(nd)) return;
        const a = nd.arguments[0];
        if (!a || a.type !== 'ObjectExpression') return;
        const err = a.properties.find((p) => p.key && (p.key.name === 'error' || p.key.value === 'error'));
        const v = err && literalText(err.value);
        if (v && /conflict|closed/i.test(v)) {
          assert.ok(v === 'order_conflict' && path.relative(ROOT, f) === 'index.js', `🔴 an unguarded existing-order emitter: ${path.relative(ROOT, f)}:${nd.loc.start.line} ${v}`);
        }
      });
    }
  }
  ok('the seven logical refusal branches each answer through OE.orderExistsBody with the ruled reason; no other 409 in the runtime builds a conflict/closed error');

  // ── 4. sensitivity: the scanner sees a planted emitter and ignores comments / log strings ─────────────────────────
  {
    const planted = "function h(res){ return res.status(409).json({ error: 'Order closed', order_id: 1 }); }";
    assert.strictEqual(legacySites(planted, 'x').length, 1, 'a planted emitter is found');
    assert.strictEqual(legacySites("// error: 'order_conflict'\nconsole.warn(`409 order_conflict (${r})`);", 'x').length, 0, 'comments and log text are not response construction');
    assert.strictEqual(legacySites('const e = `Order conflict`;', 'x').length, 1, 'a template literal counts');
  }
  ok('sensitivity: a planted emitter (and a template-literal spelling) is found; comments and log text are not');

  FINISHED = true;
  console.log(`\norder-exists-census: OK (${n})`);
} catch (e) { console.error('order-exists-census FAILED:', e && e.stack || e); process.exit(1); }
