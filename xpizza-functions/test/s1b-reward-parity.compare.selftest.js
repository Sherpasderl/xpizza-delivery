'use strict';
// The compare's own negatives (advisor 2026-11-09; codex S1b r3 P2-2): a synthetic pin table and base/tip pair in the capture's
// shape. Each mutation must be refused AT its named check. Run: node test/s1b-reward-parity.compare.selftest.js
const assert = require('assert');
const fs = require('fs'); const path = require('path'); const os = require('os');
const { spawnSync } = require('child_process');
const COPY = 'Tu pedido tiene un producto o un extra que no reconocemos. Volvé a armarlo, por favor.';
const MU = '{"error":"menu_updating","detail":"El menú se está actualizando — probá de nuevo en un momento","retryable":true}';
const pins = {};
for (const rid of ['x_pizza', 'la_musa']) for (const ep of ['createOrder', 'chargeOnlineOrder']) {
  pins[`${rid}_unknown/${ep}`] = { status: 503, body: MU, written: false };
  pins[`${rid}_array/${ep}`] = { status: 409, body: `{"error":"redemption_invalid","reason":"bad_request","order_id":"rwp_${rid}_array_${ep}"}`, written: false };
}
for (const setting of ['off', 'enforce']) for (const [rid, f] of [['x_pizza', 'name'], ['la_musa', 'id']]) for (const kind of ['array', 'null']) for (const ep of ['createOrder', 'chargeOnlineOrder', 'quoteOrder', 'quoteRedemption']) {
  const order = ep === 'createOrder' || ep === 'chargeOnlineOrder';
  const body = setting === 'enforce' && kind === 'array' ? JSON.stringify({ error: 'item_malformed', detail: COPY })
    : kind === 'null' ? JSON.stringify({ error: 'Bad Request', detail: 'unknown menu item: null' }) : JSON.stringify({ ok: true, order_id: `rwp_${ep}`, tracking_token: '<volatile>' });
  pins[`mf_${setting}_${rid}_${f}_${kind}/${ep}`] = { status: body.includes('"ok":true') ? 200 : 400, body, written: false, ...(order ? { charged: 0, order: null } : {}) };
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rwp-selftest-'));
const run = (b, t, p = pins) => { const bf = path.join(dir, 'b.json'); const tf = path.join(dir, 't.json'); const pf = path.join(dir, 'p.json');
  fs.writeFileSync(bf, JSON.stringify(b)); fs.writeFileSync(tf, JSON.stringify(t)); fs.writeFileSync(pf, JSON.stringify(p));
  const r = spawnSync(process.execPath, [path.join(__dirname, 's1b-reward-parity.compare.js'), bf, tf, pf], { encoding: 'utf8' }); return { rc: r.status, out: r.stdout + r.stderr }; };
const clone = (o = pins) => JSON.parse(JSON.stringify(o));
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NULLK = 'mf_off_x_pizza_name_null/createOrder';
try {
  const g = run(clone(), clone());
  assert.strictEqual(g.rc, 0, `premise: captures equal to their pins pass (${g.out.slice(0, 300)})`);
  ok('base == pins and tip == base → passes');
  { const t = clone(); t['la_musa_unknown/createOrder'].status = 409; const r = run(clone(), t);
    assert.ok(r.rc !== 0 && r.out.includes('RWP la_musa_unknown/createOrder'), `NEG-DIFF (${r.out.slice(0, 300)})`); }
  ok('NEG-DIFF: a tip answer that differs from the base → refused at RWP');
  { const b = clone(); b['x_pizza_array/createOrder'].body = MU; const r = run(b, clone(b));
    assert.ok(r.rc !== 0 && r.out.includes('premise: the base answers x_pizza_array/createOrder exactly as pinned'), `NEG-PIN (${r.out.slice(0, 300)})`); }
  ok('NEG-PIN: a base answer that is not its pin (tip identical) → refused at the pin');
  { const b = clone(); b[NULLK].body = JSON.stringify({ error: 'Bad Request', detail: 'customer_phone is required' }); const r = run(b, clone(b));
    assert.ok(r.rc !== 0 && r.out.includes(`premise: the base answers ${NULLK} exactly as pinned`), `NEG-UNRELATED-400 (${r.out.slice(0, 300)})`); }
  ok('NEG-UNRELATED-400: base and tip both answer an unrelated 400 for a null key → refused at the pin');
  { const b = clone(); b[NULLK].body = '{"error":"invalid_line","at":"items","index":0}'; const r = run(b, clone(b));
    assert.ok(r.rc !== 0 && r.out.includes(`RWP-STAGE ${NULLK}`), `NEG-STAGE (${r.out.slice(0, 300)})`); }
  ok('NEG-STAGE: a malformed-key answer carrying the stage\'s invalid_line → refused at RWP-STAGE');
  { const p = clone(); const k = 'mf_enforce_la_musa_id_array/quoteOrder'; p[k].body = '{"ok":false,"error":"bad_cart"}'; p[k].status = 200; const b = clone(p); const r = run(b, clone(b), p);
    assert.ok(r.rc !== 0 && r.out.includes(`premise: the pin for ${k} is today's 400 item_malformed`), `NEG-ENFORCE (${r.out.slice(0, 300)})`); }
  ok('NEG-ENFORCE: a pin table whose enforce/array answer is not item_malformed + copy → refused');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\ns1b-reward-parity.compare selftest: OK (${n})`);
