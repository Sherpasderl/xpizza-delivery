'use strict';
// ORCHESTRATION O1a T6 (PLAN-multi-location-orchestration r3.1 §2, §4; advisor ruling 2026-10-20 "every identity write bumps
// version") — STATIC guard over xpizza-reference/database.rules.json + the client bundles. The behaviour is proved in the emulator
// (test/branches-rules.emulator.test.js); this pins the shapes so a later edit cannot drop them silently.
//   1. server-only: branch_ops, branch_op_ids, rid_reservations, brand_branch_names, route_pins (root) and restaurants/{rid}/draft
//      are explicit {.read:false, .write:false} with NO grant beneath.
//   2. identity: a client (dispatcher) write is allowed only for an un-branded identity or a LEGACY brand's own branch; every
//      non-admin write must bump version by EXACTLY 1; hub ranges; address / active_changed_at / same-day 7-day hours validators.
//   3. NO live client identity writer: no client app source writes (set / update / transaction / remove / push) a path containing
//      `/identity` — the premise that lets rule 2 ship without breaking anything live (sensitivity: a planted writer is caught).
// Run: node branches-rules.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const REPO = path.join(__dirname, '..');
const rules = JSON.parse(fs.readFileSync(path.join(REPO, 'xpizza-reference', 'database.rules.json'), 'utf8')).rules;

const grants = (node, at = '') => {
  const out = [];
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if ((k === '.read' || k === '.write') && v !== false) out.push(`${at}/${k}`);
    else if (v && typeof v === 'object') out.push(...grants(v, `${at}/${k}`));
  }
  return out;
};
for (const k of ['branch_ops', 'branch_op_ids', 'rid_reservations', 'brand_branch_names', 'route_pins']) {
  assert.ok(rules[k], `FAIL: /${k} rule missing`);
  assert.deepStrictEqual([rules[k]['.read'], rules[k]['.write']], [false, false], `FAIL: /${k} must be an explicit server-only deny`);
  assert.deepStrictEqual(grants(rules[k]), [], `FAIL: /${k} has a grant beneath`);
}
const R = rules.restaurants.$restaurant_id;
assert.ok(R.draft && R.draft['.read'] === false && R.draft['.write'] === false && !grants(R.draft).length, 'FAIL: restaurants/{rid}/draft must be server-only');
assert.ok(!('.write' in R) && !('.read' in R), 'FAIL: restaurants/{rid} must not grant (a parent grant would cascade into draft)');
assert.ok(!('.write' in rules) && !('.write' in rules.restaurants), 'FAIL: no root / restaurants cascade');
ok('server-only: the 5 orchestration roots + restaurants/{rid}/draft are explicit denies with no grant beneath; no cascading parent grant');

const id = R.identity;
assert.ok(id['.write'].endsWith("&& (!data.child('brand_id').exists() || root.child('brands').child($restaurant_id).child('activation').child('state').val() === 'legacy')"),
  'FAIL: identity .write must end with the legacy-state guard (a client writes only an un-branded or a legacy brand\'s own identity)');
assert.ok(id['.validate'].endsWith("&& (!data.exists() || newData.child('version').val() === data.child('version').val() + 1)"),
  'FAIL: identity .validate must require version + 1 on every non-admin write');
assert.strictEqual(id.version['.validate'], "newData.isNumber() && (!data.exists() || newData.val() === data.val() + 1)");
assert.strictEqual(id.hub_lat['.validate'], 'newData.isNumber() && newData.val() >= -90 && newData.val() <= 90');
assert.strictEqual(id.hub_lng['.validate'], 'newData.isNumber() && newData.val() >= -180 && newData.val() <= 180');
assert.strictEqual(id.active_changed_at['.validate'], 'newData.isNumber()');
assert.match(id.address_line['.validate'], /length >= 1 && newData\.val\(\)\.length <= 120/);
assert.match(id.address_reference['.validate'], /length <= 120/);
const day = id.hours.$day;
for (const d of ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']) assert.ok(day['.validate'].includes(`$day === '${d}'`), `FAIL: hours admits ${d}`);
assert.ok(/start'\)\.val\(\) < newData\.child\('end'\)\.val\(\)/.test(day['.validate']), 'FAIL: hours are same-day (start < end)');
assert.strictEqual(day.$other['.validate'], false, 'FAIL: a day carries only open / start / end');
ok('identity: legacy-state write guard; version EXACTLY +1 on every non-admin write (node + leaf); hub ranges; address / active_changed_at / same-day 7-day hours validators');

// 3. no live client identity writer
const CLIENT_DIRS = ['xpizza-dashboard', 'xpizza-dispatch', 'xpizza-dispatch-mobile', 'xpizza-portal', 'xpizza-kitchen', 'xpizza-handheld', 'xpizza-orders',
  'xpizza-track', 'xpizza-driver', 'xpizza-catering', 'xpizza-factura', 'la-musa-orders', 'platform'];
const WRITE = /\b(set|update|runTransaction|transaction|remove|push)\s*\(/;
function scan(files) {
  const hits = [];
  for (const [f, src] of files) src.split('\n').forEach((line, i) => { if (/\/identity\b/.test(line) && WRITE.test(line)) hits.push(`${f}:${i + 1}`); });
  return hits;
}
const sources = [];
const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p); } else if (/\.(m?js|html)$/.test(e.name) && !/\.test\./.test(e.name)) sources.push([path.relative(REPO, p), fs.readFileSync(p, 'utf8')]);
  }
};
for (const d of CLIENT_DIRS) walk(path.join(REPO, d));
sources.push(['index.html', fs.readFileSync(path.join(REPO, 'index.html'), 'utf8')]);
assert.ok(sources.length > 50, `premise: the client sources were found (${sources.length})`);
assert.deepStrictEqual(scan(sources), [], 'FAIL: a client app writes an identity path — the version-bump rule would break it');
const readers = sources.filter(([, s]) => /restaurants\/\$\{rid\}\/identity\/name/.test(s)).map(([f]) => f).sort();
assert.deepStrictEqual(readers, ['xpizza-dispatch-mobile/xpizza-delivery.js', 'xpizza-dispatch/xpizza-delivery.js'], 'premise: the known identity READERS are seen (banner name)');
assert.deepStrictEqual(scan([['planted.js', "await update(ref(db, `restaurants/${rid}/identity`), { hours });"]]), ['planted.js:1'], 'sensitivity: a planted client writer is caught');
ok(`NO live client identity writer across ${sources.length} client sources (only the dispatch banner reads identity/name); a planted writer is caught`);

console.log(`\nbranches-rules.guard: OK (${n})`);
