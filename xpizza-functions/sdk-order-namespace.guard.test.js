'use strict';
// D4 — the SDK order-id namespace (advisor ruling replacing gate 0; NOTE-sdk-d4-order-id-namespace.md). An SDK order can only be
// created under `sdk_…`, and NO other creator accepts an id in that namespace — so a cash / hosted request can never write over
// an SDK order (r10's double-benefit vector). Over the RAW index.js (acorn) and the R3 write inventory:
//   A. the creation sinks are exactly createOrderApp.all + chargeOnlineApp.all (a new creator fails here until it refuses too);
//   B. createOrder: the namespace refusal is its FIRST statement after the bearer check — before the floor probe's read, the
//      resolver, any read, reserve or write;
//   C. chargeOnlineOrder (hosted): the same refusal closes B1's hosted (else) branch, after the intake-key compare and before any
//      read; the SDK branch (B1) admits ONLY the namespace (intake.authorize; cells d4-intake SDK-D4-NAMESPACE-B1);
//   D. ONE definition: payments/sdk/order-id.js (no other file spells the prefix test).
// Each failure message starts with NS-<check>. Run: node sdk-order-namespace.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');   // RAW — never an inverse layer
const AST = acorn.parse(SRC, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const TYPE_REFUSAL = "if ((req.body || {}).order_id != null && typeof req.body.order_id !== 'string') return badRequest(res, 'order_id must be a string');";
const REFUSAL = "if (require('./payments/sdk/order-id').inSdkNamespace(req.body.order_id)) return badRequest(res, 'order_id_namespace');";

// A. the creation sinks (the same inventory order-creators.guard reads)
const census = JSON.parse(fs.readFileSync(path.join(__dirname, 'contract', 'census.json'), 'utf8'));
const fields = new Map();
for (const w of census.writes) { const [file, fn, field] = w.key.split('#'); const s = `${file}#${fn}`; if (!fields.has(s)) fields.set(s, new Set()); fields.get(s).add(field); }
const creators = [...fields].filter(([, f]) => f.has('order_id') || f.has('created_at')).map(([s]) => s).sort();
assert.deepStrictEqual(creators, ['xpizza-functions/index.js#chargeOnlineApp.all', 'xpizza-functions/index.js#createOrderApp.all'], `NS-A: the creation sinks are exactly createOrder + chargeOnlineOrder — a new creator must refuse the namespace too (got ${creators.join(', ')})`);
ok('A: the creation sinks are exactly createOrderApp.all + chargeOnlineApp.all');

function handler(app) {
  let h = null;
  (function walk(x) { if (!x || typeof x.type !== 'string' || h) return; if (x.type === 'CallExpression' && x.callee.type === 'MemberExpression' && x.callee.object.name === app && x.callee.property.name === 'all') { h = x.arguments[1]; return; } for (const k of Object.keys(x)) { const v = x[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); } })(AST);
  assert.ok(h, `NS: ${app}.all handler found`);
  return h;
}
const norm = (x) => SRC.slice(x.start, x.end).replace(/\s+/g, ' ').replace(/ \/\/.*$/, '').trim();
const firstOf = (h, re, from = h.start) => { const m = re.exec(SRC.slice(from, h.end)); return m ? from + m.index : Infinity; };

// B. createOrder: the first statement after the bearer check
{
  const h = handler('createOrderApp');
  const st = h.body.body;
  const i = st.findIndex((x) => x.type === 'IfStatement' && /!presented \|\| (presented !== SECRET|!constantTimeEqual\(presented, SECRET\))/.test(SRC.slice(x.start, x.end)));
  assert.ok(i !== -1, 'NS-B: the bearer check');
  // Codex handler r2 P1: «typeof === 'string' FIRST» — an array / object / number id never reaches the namespace test (which
  // must see EXACTLY the value persistence uses: String(order_id) of a string is itself)
  assert.strictEqual(norm(st[i + 1]).replace(/ \/\/.*/, ''), TYPE_REFUSAL, `NS-B: createOrder's FIRST statement after the bearer check is the non-string refusal (got ${norm(st[i + 1]).slice(0, 120)})`);
  assert.strictEqual(norm(st[i + 2]).replace(/ \/\/.*/, ''), REFUSAL, `NS-B: the SECOND is the namespace refusal (got ${norm(st[i + 2]).slice(0, 120)})`);
  const at = st[i + 1].start;
  for (const re of [/getDatabase\(\)/, /resolveRestaurantId\(/, /existingOrderProbe\(/, /reserveRedemption\(/, /checkRateLimit\(/]) assert.ok(at < firstOf(h, re), `NS-B: the refusal precedes ${re}`);
  ok('B: createOrder refuses a namespaced id first — before any read, reserve or write');
}
// C. chargeOnlineOrder (hosted): the refusal closes B1's hosted branch
{
  const h = handler('chargeOnlineApp');
  const b1 = h.body.body.find((x) => x.type === 'IfStatement' && x.test.type === 'Identifier' && x.test.name === 'SDK_MODE');
  assert.ok(b1 && b1.alternate && b1.alternate.type === 'BlockStatement', 'NS-C: B1 has the hosted (else) branch');
  const alt = b1.alternate.body;
  assert.strictEqual(norm(alt[alt.length - 2]).replace(/ \/\/.*/, ''), TYPE_REFUSAL, 'NS-C: the hosted branch refuses a non-string id (after the intake-key compare)');
  assert.strictEqual(norm(alt[alt.length - 1]).replace(/ \/\/.*/, ''), REFUSAL, 'NS-C: …then ends with the namespace refusal');
  for (const re of [/CF\.liveCheckoutProbe\(/, /resolveRestaurantId\(/, /reserveRedemption\(/, /checkRateLimit\(/, /acquireHostedAttempt\(db,/]) assert.ok(alt[alt.length - 2].start < firstOf(h, re, b1.end), `NS-C: on the hosted path the refusal precedes ${re}`);
  ok('C: hosted chargeOnlineOrder refuses a namespaced id before any read or write; the SDK branch admits only the namespace');
}
// D. one definition
{
  const files = require('child_process').execFileSync('git', ['ls-files', '*.js'], { cwd: __dirname, encoding: 'utf8' }).split('\n').filter((f) => f && !/test\.js$|guard\.test\.js$/.test(f));
  const spelled = files.filter((f) => /\^sdk_/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
  assert.deepStrictEqual(spelled, ['payments/sdk/order-id.js'], `NS-D: the namespace is spelled in ONE module (got ${spelled.join(', ')})`);
  ok('D: one definition (payments/sdk/order-id.js)');
}
console.log(`\nsdk-order-namespace.guard: OK (${n})`);
