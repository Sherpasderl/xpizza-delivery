'use strict';
// The compare's own negatives (advisor, 2026-11-09): a synthetic base/tip pair in the capture's shape. Each must be refused AT its
// named check. Run: node test/s1b-reward-parity.compare.selftest.js
const assert = require('assert');
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawnSync } = require('child_process');
const COPY = 'Tu pedido tiene un producto o un extra que no reconocemos. Volvé a armarlo, por favor.';
const MU = '{"error":"menu_updating","detail":"El menú se está actualizando — probá de nuevo en un momento","retryable":true}';
const cap = {};
for (const rid of ['x_pizza', 'la_musa']) for (const ep of ['createOrder', 'chargeOnlineOrder']) {
  cap[`${rid}_unknown/${ep}`] = { status: 503, body: MU, written: false };
  cap[`${rid}_array/${ep}`] = { status: 409, body: `{"error":"redemption_invalid","reason":"bad_request","order_id":"rwp_${rid}_array_${ep}"}`, written: false };
}
for (const [rid, f] of [['x_pizza', 'name'], ['la_musa', 'id']]) for (const kind of ['array', 'null']) for (const ep of ['createOrder', 'chargeOnlineOrder', 'quoteOrder', 'quoteRedemption']) {
  cap[`mf_${rid}_${f}_${kind}/${ep}`] = { status: 400, body: JSON.stringify(kind === 'array' ? { error: 'item_malformed', detail: COPY } : { error: 'unknown menu item: null' }), written: false, ...(ep.endsWith('Order') && ep !== 'quoteOrder' ? { charged: 0 } : {}) };
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwp-selftest-'));
const run = (b, t) => { const bf = path.join(dir, 'b.json'); const tf = path.join(dir, 't.json'); fs.writeFileSync(bf, JSON.stringify(b)); fs.writeFileSync(tf, JSON.stringify(t));
  const r = spawnSync(process.execPath, [path.join(__dirname, 's1b-reward-parity.compare.js'), bf, tf], { encoding: 'utf8' }); return { rc: r.status, out: r.stdout + r.stderr }; };
const clone = () => JSON.parse(JSON.stringify(cap));
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
try {
  const g = run(clone(), clone());
  assert.strictEqual(g.rc, 0, `premise: identical, pinned captures pass (${g.out.slice(0, 300)})`);
  ok('identical captures with each base answer pinned pass');
  const t = clone(); t['la_musa_unknown/createOrder'].status = 409;
  const d = run(clone(), t);
  assert.ok(d.rc !== 0 && d.out.includes('RWP la_musa_unknown/createOrder'), `NEG-DIFF a tip that answers differently is refused by the byte-identity check (${d.out.slice(0, 300)})`);
  ok('NEG-DIFF: a tip answer that differs from the base → refused at RWP');
  const b = clone(); b['x_pizza_array/createOrder'].body = MU; const t2 = clone(); t2['x_pizza_array/createOrder'].body = MU;
  const w = run(b, t2);
  assert.ok(w.rc !== 0 && w.out.includes('premise: the base refuses x_pizza_array/createOrder'), `NEG-PIN a base answer that is not today's refusal is refused by the pin even when the tip matches (${w.out.slice(0, 300)})`);
  ok('NEG-PIN: a base answer with the wrong code (tip identical) → refused at the pin');
  const m = clone(); m['mf_x_pizza_name_null/createOrder'].body = '{"error":"invalid_line","at":"items","index":0}'; const m2 = JSON.parse(JSON.stringify(m));
  const s = run(m, m2);
  assert.ok(s.rc !== 0 && s.out.includes('premise: the base refuses mf_x_pizza_name_null/createOrder'), `NEG-STAGE a null-key answer carrying the stage's code is refused (${s.out.slice(0, 300)})`);
  ok('NEG-STAGE: a malformed-key answer carrying the stage\'s invalid_line → refused at the pin');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\ns1b-reward-parity.compare selftest: OK (${n})`);
