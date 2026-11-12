'use strict';
// D4 §A5 (PLAN-sdk-d4-r11) — the SDK intake is a BRANCH of chargeOnlineOrder's handler, and the mode comes ONLY from which export
// was invoked. Parsed (acorn) over the RAW index.js — this guard must SEE the SDK code (never composed with an inverse layer):
//   · the ONLY write to res.locals.sdkMode is the literal `= true` inside placeSdkApp's middleware, which reads nothing from req;
//   · exports.placeSdkOrder is bound to placeSdkApp, exports.chargeOnlineOrder to chargeOnlineApp;
//   · in the handler: ONE read (`const SDK_MODE = res.locals.sdkMode === true`), no alias / destructuring / computed access of
//     res.locals, and SDK_MODE is referenced only as the test of exactly FOUR if statements, at their pinned positions:
//     B1 before the intake-key compare (process.env.MAKE_SECRET); B2 before BR.probeBoundReuse; B3 whose ELSE holds exactly the
//     hosted-provider setup (resolvePixelPayConfig, resolveReturnBaseForCharge, PE.refusesFresh); B4 before acquireHostedAttempt,
//     its last statement a return;
//   · the runGate hoist: `const runGate = (recordedTotalCents, releaseHold) => …` in the handler, hosted passing releaseHoldIfOwned.
// Each failure message starts with SIB-<cell>. Run: node sdk-intake-branch.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');   // RAW — never an inverse layer
const AST = acorn.parse(SRC, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

function walk(node, fn, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const k of Object.keys(node)) {
    if (k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn, node)); else if (v && typeof v.type === 'string') walk(v, fn, node);
  }
}
const all = (root, pred) => { const out = []; walk(root, (x, p) => { if (pred(x, p)) out.push({ node: x, parent: p }); }); return out; };
const isMember = (x, obj, prop) => x && x.type === 'MemberExpression' && !x.computed && x.property.name === prop && (obj == null || (x.object.type === 'Identifier' && x.object.name === obj));
const isResLocals = (x) => x && x.type === 'MemberExpression' && !x.computed && x.property.name === 'locals' && x.object.type === 'Identifier' && x.object.name === 'res';
const src = (x) => SRC.slice(x.start, x.end);

// ── the wrapper: placeSdkApp and its one middleware ──
const writes = all(AST, (x) => x.type === 'AssignmentExpression' && x.left.type === 'MemberExpression' && !x.left.computed && x.left.property.name === 'sdkMode');
assert.strictEqual(writes.length, 1, `SIB-WRITER: exactly ONE write to *.sdkMode in index.js (found ${writes.length})`);
const w = writes[0].node;
assert.ok(isResLocals(w.left.object) && w.right.type === 'Literal' && w.right.value === true && w.operator === '=', `SIB-WRITER: the write is the literal res.locals.sdkMode = true (got ${src(w)})`);
const uses = all(AST, (x) => x.type === 'CallExpression' && isMember(x.callee, 'placeSdkApp', 'use'));
const mw = uses.map((u) => u.node.arguments[0]).find((f) => f && /FunctionExpression/.test(f.type) && f.start <= w.start && w.end <= f.end);
assert.ok(mw, 'SIB-WRITER: the write sits inside a function passed to placeSdkApp.use(...)');
assert.ok(mw.params.length === 3 && mw.params[0].type === 'Identifier', 'SIB-WRITER: the middleware is (req, res, next)');
const reqName = mw.params[0].name;
assert.strictEqual(all(mw.body, (x) => x.type === 'Identifier' && x.name === reqName).length, 0, 'SIB-WRITER: the middleware reads NOTHING from req (nothing request-derived decides the mode)');
assert.ok(uses.some((u) => u.node.arguments[0] && u.node.arguments[0].type === 'Identifier' && u.node.arguments[0].name === 'chargeOnlineApp'), 'SIB-WRITER: placeSdkApp mounts chargeOnlineApp');
assert.ok(all(AST, (x) => x.type === 'VariableDeclarator' && x.id.name === 'placeSdkApp' && x.init && x.init.type === 'CallExpression' && x.init.callee.name === 'express').length === 1, 'SIB-WRITER: placeSdkApp = express()');
// Codex handler r1 P2: the middleware SEQUENCE is exactly [the literal writer, chargeOnlineApp]; res.locals appears in index.js
// ONLY as the write's and the read's object (no Object.assign / defineProperty / any other mutation path)
assert.deepStrictEqual(uses.map((u) => (u.node.arguments[0] === mw ? 'writer' : u.node.arguments[0] && u.node.arguments[0].name)), ['writer', 'chargeOnlineApp'], 'SIB-WRITER: placeSdkApp.use is exactly [the literal writer, chargeOnlineApp], in that order');
assert.strictEqual(all(AST, (x) => isResLocals(x)).length, 2, 'SIB-WRITER: res.locals appears exactly twice in index.js — the write and the read (no Object.assign / other mutation path)');
ok('the ONLY sdkMode writer is the literal true in placeSdkApp\'s request-blind middleware');

// ── the exports ──
const exp = (name) => all(AST, (x) => x.type === 'AssignmentExpression' && isMember(x.left, 'exports', name)).map((e) => e.node.right);
for (const [name, app] of [['placeSdkOrder', 'placeSdkApp'], ['chargeOnlineOrder', 'chargeOnlineApp']]) {
  const r = exp(name);
  assert.ok(r.length === 1 && r[0].type === 'CallExpression' && r[0].callee.name === 'onRequest' && r[0].arguments[1] && r[0].arguments[1].name === app, `SIB-EXPORTS: exports.${name} = onRequest(…, ${app})`);
}
ok('placeSdkOrder → placeSdkApp; chargeOnlineOrder → chargeOnlineApp');

// ── the handler ──
const allCall = all(AST, (x) => x.type === 'CallExpression' && isMember(x.callee, 'chargeOnlineApp', 'all'));
assert.strictEqual(allCall.length, 1, 'SIB-HANDLER: one chargeOnlineApp.all handler');
const H = allCall[0].node.arguments[1];
const reads = all(AST, (x) => x.type === 'MemberExpression' && !x.computed && x.property.name === 'sdkMode');
assert.strictEqual(reads.length, 2, `SIB-READ: sdkMode appears exactly twice in index.js — the one write and the one read (found ${reads.length})`);
const decl = all(H.body, (x) => x.type === 'VariableDeclarator' && x.id.type === 'Identifier' && x.id.name === 'SDK_MODE');
assert.ok(decl.length === 1 && src(decl[0].node.init) === 'res.locals.sdkMode === true', `SIB-READ: const SDK_MODE = res.locals.sdkMode === true (got ${decl.map((d) => src(d.node)).join(' | ')})`);
assert.strictEqual(all(AST, (x) => x.type === 'VariableDeclarator' && x.init && isResLocals(x.init)).length, 0, 'SIB-ALIAS: no `x = res.locals` alias / destructuring');
assert.strictEqual(all(AST, (x) => x.type === 'MemberExpression' && x.computed && isResLocals(x.object)).length, 0, 'SIB-ALIAS: no computed res.locals[...] access');
assert.strictEqual(all(AST, (x) => x.type === 'AssignmentExpression' && x.right && isResLocals(x.right)).length, 0, 'SIB-ALIAS: no assignment of res.locals');
ok('ONE read of the mode; no alias, destructuring or computed access of res.locals');
const refs = all(H.body, (x, p) => x.type === 'Identifier' && x.name === 'SDK_MODE' && !(p && p.type === 'VariableDeclarator' && p.id === x));
const ifs = all(H.body, (x) => x.type === 'IfStatement' && x.test.type === 'Identifier' && x.test.name === 'SDK_MODE').map((i) => i.node).sort((a, b) => a.start - b.start);
assert.ok(refs.length === 4 && ifs.length === 4 && refs.every((r) => ifs.some((i) => i.test === r.node)), `SIB-BRANCHES: SDK_MODE is referenced ONLY as the test of exactly FOUR if statements (refs ${refs.length}, ifs ${ifs.length})`);
const at = (re) => { const m = re.exec(SRC.slice(H.start, H.end)); assert.ok(m, `SIB-POSITIONS: anchor ${re} present in the handler`); return H.start + m.index; };
const [b1, b2, b3, b4] = ifs;
assert.ok(b1.start < at(/process\.env\.MAKE_SECRET/), 'SIB-POSITIONS: B1 before the intake-key compare');
assert.ok(b2.start < at(/BR\.probeBoundReuse\(/), 'SIB-POSITIONS: B2 before BR.probeBoundReuse');
assert.ok(b3.alternate, 'SIB-POSITIONS: B3 has an ELSE (the hosted-provider setup)');
for (const call of [/resolvePixelPayConfig\(\)/, /resolveReturnBaseForCharge\(/, /PE\.refusesFresh\(/]) {
  const p = at(call);
  assert.ok(b3.alternate.start < p && p < b3.alternate.end, `SIB-POSITIONS: ${call} lives in B3's else (skipped in SDK mode)`);
}
assert.ok(b4.start < at(/acquireHostedAttempt\(db,/), 'SIB-POSITIONS: B4 before acquireHostedAttempt');
const last = b4.consequent.type === 'BlockStatement' ? b4.consequent.body[b4.consequent.body.length - 1] : b4.consequent;
assert.ok(last && last.type === 'ReturnStatement', 'SIB-POSITIONS: B4\'s last statement is a return');
assert.ok(b1.start < b2.start && b2.start < b3.start && b3.start < b4.start, 'SIB-POSITIONS: B1 < B2 < B3 < B4');
// Codex handler r1 P2: the branch CONTENTS (never an empty branch; B3's hosted side is EXACTLY its four statements)
const body = (st) => (st && st.type === 'BlockStatement' ? st.body : st ? [st] : []);
const txt = (st) => src(st).replace(/\s+/g, ' ');
{ const c = body(b1.consequent);
  assert.ok(c.length === 2 && /^const b1 = await require\('\.\/payments\/sdk\/intake'\)\.authorize\(req, \{/.test(txt(c[0])) && /^if \(b1\.refuse\) return res\.status\(b1\.refuse\.status\)\.json\(b1\.refuse\.body\);$/.test(txt(c[1])), 'SIB-B1: B1 is exactly the intake authorize + its refusal return');
  assert.ok(b1.alternate && /process\.env\.MAKE_SECRET/.test(src(b1.alternate)), 'SIB-B1: the hosted intake-key compare is B1\'s else'); }
{ const c = body(b2.consequent); const t = c.map(txt).join(' ');
  assert.ok(/SDKI\.replay\(sdkDeps,/.test(t) && /SDKI\.admit\(sdkDeps,/.test(t) && /^if \(b2\) return res\.status\(b2\.status\)\.json\(b2\.body\);$/.test(txt(c[c.length - 1])), 'SIB-B2: B2 is the replay lookup then the admit, returning its answer'); }
{ assert.strictEqual(body(b3.consequent).length, 0, 'SIB-B3: B3\'s SDK side does nothing (it only SKIPS the hosted-provider setup)');
  const a = body(b3.alternate).map(txt);
  assert.ok(a.length === 4 && /^try \{ pp = resolvePixelPayConfig\(\);/.test(a[0]) && /^returnBase = await resolveReturnBaseForCharge\(/.test(a[1]) && /^if \(returnBase\.error\) \{/.test(a[2]) && /^if \(await PE\.refusesFresh\(/.test(a[3]), `SIB-B3: B3\'s hosted side is EXACTLY the four provider statements (got ${a.length})`); }
{ const c = body(b4.consequent);
  assert.ok(c.length === 2 && /^const fin = await require\('\.\/payments\/sdk\/finish'\)\.finishSdk\(/.test(txt(c[0])) && c[1].type === 'ReturnStatement', 'SIB-B4: B4 is exactly the SDK finish + its return'); }
ok('B1 / B2 / B3 / B4 at their pinned positions; B3 skips exactly the hosted-provider setup; B4 returns');
ok('the branch CONTENTS are pinned (no empty branch; B3\'s hosted side is exactly its four statements)');

// ── the runGate hoist (r7: the release is a parameter; hosted passes releaseHoldIfOwned) ──
const rg = all(H.body, (x) => x.type === 'VariableDeclarator' && x.id.name === 'runGate' && x.init && x.init.type === 'ArrowFunctionExpression');
assert.ok(rg.length === 1 && rg[0].node.init.params.length === 2, 'SIB-RUNGATE: const runGate = (recordedTotalCents, releaseHold) => … in the handler');
assert.ok(/runGate: \(recordedTotalCents\) => runGate\(recordedTotalCents, releaseHoldIfOwned\)/.test(SRC.slice(H.start, H.end)), 'SIB-RUNGATE: hosted passes releaseHoldIfOwned');
ok('runGate hoisted with the release as a parameter');
console.log(`\nsdk-intake-branch.guard: OK (${n})`);
