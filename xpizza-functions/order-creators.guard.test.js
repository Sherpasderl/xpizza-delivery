'use strict';
// PLATFORM F2 Q2 (PLAN-F2-query-rules §2 "FUTURE ownership"; codex F2q2 r1 P2-3) — every order a creator PERSISTS carries exactly the
// resolver's output as restaurant_id, so the KDS's exact-location feed can never miss a future order. Offline; wired into npm test.
//   A. The creation SINKS: from the R3 write inventory (contract/census.json), the sites writing an order's creation fields are
//      exactly createOrderApp.all + chargeOnlineApp.all (a new creator fails until reviewed here).
//   B. The PERSISTED VALUE (acorn over index.js, per handler):
//      - the rid is resolved by resolveRestaurantId(body.restaurant_id, restaurantRegistry().known()) into the binding `restaurantId`;
//      - `if (ridError) return …` precedes every persistence call (an unknown rid never persists);
//      - `restaurantId` is never reassigned and never shadowed inside the handler;
//      - every persisted record takes it from that binding: the inline record's `restaurant_id: restaurantId` (online) and the
//        builder calls' `restaurantId` argument (cash, scheduled) — no other restaurant_id source appears in a handler.
//   C. The BUILDERS persist exactly their argument (behavioural: a sentinel rid in → the orders/{id} record's restaurant_id out).
//   D. The resolver (behavioural): missing / blank / whitespace → the default location, never ''; unknown → an error (400).
//   E. CLIENT sinks: the only client whole-record order writer is the dead createOrderWithTasks, and NO deployed file (recursive,
//      SDK copies included) references it in any other way — any spelling containing "WithTasks", a call, a property access.
//   F. NEGATIVES: in-memory mutations of index.js (raw body.restaurant_id persisted; the resolver bypassed; the ridError return
//      removed; the binding reassigned; a builder fed the raw input) each FAIL check B.
// Run: node order-creators.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const ROOT = path.join(__dirname, '..');
const RESOLVE = 'resolveRestaurantId(body.restaurant_id, restaurantRegistry().known())';
const HANDLERS = ['createOrderApp', 'chargeOnlineApp'];
const BUILDERS = new Set(['buildCreateOrderUpdates', 'buildScheduledOrderRecord']);

// ── A: creation sinks from the R3 write inventory ──
const census = JSON.parse(fs.readFileSync(path.join(__dirname, 'contract', 'census.json'), 'utf8'));
const fields = new Map();
for (const w of census.writes) { const [file, fn, field] = w.key.split('#'); const s = `${file}#${fn}`; if (!fields.has(s)) fields.set(s, new Set()); fields.get(s).add(field); }
const creators = [...fields].filter(([, f]) => f.has('order_id') || f.has('created_at')).map(([s]) => s).sort();
assert.deepStrictEqual(creators, ['xpizza-functions/index.js#chargeOnlineApp.all', 'xpizza-functions/index.js#createOrderApp.all'], `creation sinks: ${creators.join(', ')}`);
for (const c of creators) assert.ok(fields.get(c).has('restaurant_id'), `${c} writes restaurant_id`);
ok('A: the R3 write inventory\'s creation sinks are exactly createOrder + chargeOnlineOrder, each writing restaurant_id');

// ── B: the persisted value, per handler ──
function walk(node, fn, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parent);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn, node)); else if (v && typeof v.type === 'string') walk(v, fn, node);
  }
}
function checkPersistedRid(src) {
  const errs = [];
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  for (const app of HANDLERS) {
    let handler = null;
    walk(ast, (nd) => {
      if (nd.type === 'CallExpression' && nd.callee.type === 'MemberExpression' && nd.callee.object.name === app && nd.callee.property.name === 'all'
        && nd.arguments[0] && nd.arguments[0].value === '*') handler = nd.arguments[1];
    });
    if (!handler) { errs.push(`${app}: handler not found`); continue; }
    const text = src.slice(handler.start, handler.end);
    // the resolver binding
    let resolver = null; let errorReturnAt = null; const persistAt = []; let rebinds = 0; let shadows = 0; const ridSources = [];
    walk(handler.body, (nd, parent) => {
      if (nd.type === 'VariableDeclarator' && nd.id.type === 'ObjectPattern' && nd.init && src.slice(nd.init.start, nd.init.end) === RESOLVE
        && nd.id.properties.some((p) => p.key.name === 'restaurantId' && p.value.name === 'restaurantId')) resolver = nd;
      if (nd.type === 'IfStatement' && nd.test.type === 'Identifier' && nd.test.name === 'ridError' && /^return\b|^\{?\s*return\b/.test(src.slice(nd.consequent.start, nd.consequent.end).trim())) errorReturnAt = errorReturnAt === null ? nd.start : Math.min(errorReturnAt, nd.start);
      if (nd.type === 'AssignmentExpression' && nd.left.type === 'Identifier' && nd.left.name === 'restaurantId') rebinds += 1;
      if (nd.type === 'VariableDeclarator' && nd !== resolver && JSON.stringify(src.slice(nd.id.start, nd.id.end)).match(/\brestaurantId\b/) && !(nd.id.type === 'ObjectPattern' && nd.init && src.slice(nd.init.start, nd.init.end) === RESOLVE)) shadows += 1;
      if (nd.type === 'CallExpression') {
        const callee = src.slice(nd.callee.start, nd.callee.end);
        if ((/\.(update|set|transaction|push)$/.test(callee) && !/^res\./.test(callee)) || BUILDERS.has(callee)) persistAt.push(nd.start);   // res.set = an HTTP header, not persistence
        if (BUILDERS.has(callee)) {
          const arg = nd.arguments[0];
          const prop = arg && arg.type === 'ObjectExpression' && arg.properties.find((p) => p.key && p.key.name === 'restaurantId');
          ridSources.push({ where: callee, ok: !!prop && prop.value.type === 'Identifier' && prop.value.name === 'restaurantId' });
        }
      }
      if (nd.type === 'Property' && nd.key && (nd.key.name === 'restaurant_id' || nd.key.value === 'restaurant_id') && parent && parent.type === 'ObjectExpression') {
        ridSources.push({ where: `restaurant_id: ${src.slice(nd.value.start, nd.value.end).slice(0, 40)}`, ok: nd.value.type === 'Identifier' && nd.value.name === 'restaurantId' });
      }
    });
    if (!resolver) errs.push(`${app}: the rid is not resolved by ${RESOLVE} into \`restaurantId\``);
    if (errorReturnAt === null) errs.push(`${app}: no \`if (ridError) return …\``);
    else if (persistAt.some((p) => p < errorReturnAt)) errs.push(`${app}: a persistence call precedes the ridError return`);
    if (resolver && errorReturnAt !== null && errorReturnAt < resolver.start) errs.push(`${app}: the ridError return precedes the resolver`);
    if (rebinds) errs.push(`${app}: restaurantId is reassigned (${rebinds})`);
    if (shadows) errs.push(`${app}: restaurantId is re-declared / shadowed (${shadows})`);
    if (!ridSources.length) errs.push(`${app}: no persisted restaurant_id source found`);
    for (const s of ridSources) if (!s.ok) errs.push(`${app}: persisted rid not from the resolver binding at ${s.where}`);
    void text;
  }
  return errs;
}
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
assert.deepStrictEqual(checkPersistedRid(SRC), [], 'index.js: every persisted restaurant_id is the resolver binding');
ok('B: in both handlers the rid is resolveRestaurantId(body.restaurant_id, registry) → `restaurantId`, the ridError return precedes every persistence call, the binding is never reassigned or shadowed, and every persisted restaurant_id (inline record + builder arguments) is that binding');

// ── C: the builders persist exactly their argument ──
const B = require('./create-order-build');
const SENT = 'rid_sentinel_q2';
const args = (extra = {}) => ({ orderId: 'O1', orderType: 'pickup', now: 1, trackingToken: 'tok', total: 100, lat: null, lng: null,
  fields: { customer_name: 'A', customer_phone: '1', items_text: 'x', payment_method: 'cash', notes: '' }, hubSnap: { hub_lat: 14.1, hub_lng: -87.2 }, restaurantId: SENT,
  priceBreakdown: { total_cents: 10000, subtotal_cents: 10000, tax_cents: 0 }, facturaPriced: {}, cashTenderedCents: 0, freeOrder: false, rewardStamp: {}, paymentFingerprint: 'fp', ...extra });
const cash = B.buildCreateOrderUpdates(args());
assert.strictEqual(cash['orders/O1'].restaurant_id, SENT, 'buildCreateOrderUpdates persists its restaurantId argument');
const held = B.buildScheduledOrderRecord(args({ scheduledFor: 2, releaseAt: 3 }));
const heldRec = held['orders/O1'] || held;
assert.strictEqual(heldRec.restaurant_id, SENT, 'buildScheduledOrderRecord persists its restaurantId argument');
ok('C: both builders persist EXACTLY their restaurantId argument on the orders/{id} record (sentinel in → sentinel out)');

// ── D: the resolver ──
const { resolveRestaurantId } = require('./restaurant-id');
const known = new Set(['x_pizza', 'la_musa']);
for (const raw of [undefined, null, '', '   ']) { const r = resolveRestaurantId(raw, known); assert.ok(r.restaurantId && known.has(r.restaurantId) && !r.error, `missing/blank ${JSON.stringify(raw)} → a known default, never '' (${JSON.stringify(r)})`); }
assert.ok(resolveRestaurantId('bogus', known).error && resolveRestaurantId('bogus', known).restaurantId === null, 'unknown → error (400), no rid');
assert.strictEqual(resolveRestaurantId(' la_musa ', known).restaurantId, 'la_musa', 'trimmed');
ok('D: the resolver maps missing / blank / whitespace input to a known default (never \'\') and an unknown rid to an error');

// ── E: client sinks ──
const sites = JSON.parse(fs.readFileSync(path.join(ROOT, 'platform', 'sites.json'), 'utf8'));
const folders = [...new Set(sites.deployments.map((d) => d.folder))];
const DEF = /export\s+async\s+function\s+createOrderWithTasks\s*\(/g;
const offenders = []; const wholeRecord = []; let files = 0; let insideDead = 0;
for (const folder of folders) {
  (function rec(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { rec(p); continue; }
      if (!/\.(html|js|mjs)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      files += 1;
      const t = fs.readFileSync(p, 'utf8');
      // code only: block comments and line comments (not the // of a URL) are stripped before counting references
      const code = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      const mentions = (code.match(/WithTasks/g) || []).length; const defs = (code.match(DEF) || []).length;
      if (mentions !== defs) offenders.push(`${path.relative(ROOT, p)} (${mentions} "WithTasks" mention(s), ${defs} definition(s))`);
      // any whole-record client order write (an update-map key orders/${…} set to an object literal, or set(ref(…`orders/${…}`)))
      const re = /\[`orders\/\$\{[^}]+\}`\]\s*=\s*\{|set\(\s*ref\(\s*\w+\s*,\s*`orders\/\$\{[^}]+\}`\s*\)\s*,\s*\{/g; let m;
      while ((m = re.exec(t))) {
        const before = t.slice(0, m.index); const fnStart = before.lastIndexOf('export async function createOrderWithTasks(');
        const nextFn = fnStart >= 0 ? before.slice(fnStart + 10).search(/\nexport (async )?function /) : -1;
        if (fnStart < 0 || nextFn >= 0) wholeRecord.push(`${path.relative(ROOT, p)}@${before.split('\n').length}`); else insideDead += 1;
      }
    }
  })(path.join(ROOT, folder));
}
assert.ok(files > 20, `premise: the recursive scan saw the deployed files (${files})`);
assert.ok(insideDead >= 4, `non-vacuity: the whole-record pattern matches the dead creator's own write in the SDK copies (${insideDead})`);
assert.deepStrictEqual(offenders, [], `createOrderWithTasks is referenced only by its own definition in deployed files: ${offenders.join('; ')}`);
assert.deepStrictEqual(wholeRecord, [], `the only client whole-record order write is inside the dead createOrderWithTasks: ${wholeRecord.join(', ')}`);
ok(`E: client sinks — ${files} deployed files scanned recursively (SDK copies included): the only whole-record order write is inside createOrderWithTasks, which nothing references under any spelling containing "WithTasks"`);

// ── F: negatives — each mutation must FAIL check B ──
const NEG = [
  ['raw body.restaurant_id persisted (online record)', (s) => s.replace('    restaurant_id: restaurantId,\n    factura_status:', '    restaurant_id: body.restaurant_id,\n    factura_status:')],
  ['resolver bypassed', (s) => s.split(RESOLVE).join('({ restaurantId: body.restaurant_id, error: null, defaulted: false })')],
  ['ridError return removed', (s) => s.split('  if (ridError) return badRequest(res, ridError);\n').join('')],
  ['binding reassigned to raw input', (s) => s.split('  if (ridError) return badRequest(res, ridError);\n').join('  if (ridError) return badRequest(res, ridError);\n  restaurantId = body.restaurant_id || restaurantId;\n')],
  ['builder fed the raw input', (s) => s.replace('    restaurantId, priceBreakdown, facturaPriced, cashTenderedCents, freeOrder, rewardStamp,\n    paymentFingerprint: storeFp,', '    restaurantId: body.restaurant_id, priceBreakdown, facturaPriced, cashTenderedCents, freeOrder, rewardStamp,\n    paymentFingerprint: storeFp,')],
];
for (const [label, mut] of NEG) {
  const m = mut(SRC);
  assert.notStrictEqual(m, SRC, `negative "${label}" applied`);
  assert.ok(checkPersistedRid(m).length > 0, `negative "${label}" must FAIL check B`);
}
ok(`F: ${NEG.length} negatives (raw body.restaurant_id persisted; resolver bypassed; ridError return removed; binding reassigned; builder fed raw input) each FAIL`);

console.log(`order-creators.guard: OK (${n})`);
