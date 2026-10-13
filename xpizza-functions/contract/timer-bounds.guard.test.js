'use strict';
// R3 P1 §12 C1 — THE TIMER-BOUNDS GUARD (static; npm test chain). Every page timer on an asserted page whose delay exceeds
// that page's step horizon (or cannot be resolved) has a reviewed entry showing it does not reach an asserted output; the
// enforced journey settles with exactly the declared horizon. Run: node contract/timer-bounds.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('./timer-bounds');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FAIL = (m) => `🔴 R3-TIMER-BOUNDS ${m}`;
const doc = JSON.parse(fs.readFileSync(T.FILE, 'utf8'));
const r = T.check(doc);
assert.deepStrictEqual(r.problems, [], FAIL(r.problems.join('\n  ')));
ok(`${r.inventory.length} timer sites on the asserted pages (${Object.entries(doc.pages).map(([p, v]) => `${p} horizon ${v.horizonMs} ms`).join(', ')}); ${r.need.length} long / unresolved, each reviewed with a bound (one reaching an asserted output must stay within the horizon)`);
const j = fs.readFileSync(path.join(__dirname, 'p1a-journey.emulator.test.mjs'), 'utf8');
{ // every step settles with the declared horizon: the standard, or — for exactly the confirmation steps — the page's exception
  const confSettles = [...j.matchAll(/settled\(form, fhost, HORIZON\.formConfirmation, '([^']+)'\)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(confSettles, ['form.confirmation', 'form.pay', 'stability.form'], FAIL(`the exception horizon settles steps other than the confirmation's: ${JSON.stringify(confSettles)}`));
  assert.ok(/formConfirmation: TB\.pages\['xpizza-orders'\]\.exception\.horizonMs/.test(j) && /settled\(form, fhost, HORIZON\.form,/.test(j) && /settled\(kds, khost, HORIZON\.kds,/.test(j) && /pg\.settle\(horizon\)/.test(j) && !/\.settle\(\)/.test(j) && (j.match(/\.settle\(/g) || []).length === 1, FAIL('the journey does not settle every step with a declared horizon'));
}
ok('the enforced journey settles every step with the declared horizon — the standard, or the page exception for exactly the confirmation steps (pay, confirmation, its stability recapture)');
const clone = () => JSON.parse(JSON.stringify(doc));
const has = (d, re) => T.check(d).problems.some((p) => re.test(p));
// the mechanism negatives below are fixed-size probes (9 s timers): run them at a 10 s xpizza-orders horizon, independent of
// the reviewed page horizon (raised to 46 s at 6f353ed for the order-number poll)
const D10 = (() => { const d = JSON.parse(JSON.stringify(doc)); d.pages['xpizza-orders'].horizonMs = 10000; return d; })();
{ const d = clone(); d.sites.shift(); assert.ok(has(d, /no reviewed entry/), FAIL('a long timer without an entry passed')); }
{ const d = clone(); d.pages['xpizza-orders'].horizonMs = 1000; assert.ok(has(d, /no reviewed entry/), FAIL('a shorter horizon exposed no new long timer')); }
{ const d = clone(); d.sites[0].sha = T.sha('x'); assert.ok(has(d, /call text changed/), FAIL('a changed timer call passed')); }
{ const d = clone(); d.sites[5].reachesAsserted = true; assert.ok(has(d, /RED \(no declaration clears it\)/), FAIL('a long timer reaching an asserted output passed')); }
{ const d = clone(); d.sites.push({ ...d.sites[0], key: 'xpizza-orders/gone.js#f:setTimeout#0' }); assert.ok(has(d, /stale entry/), FAIL('a stale entry passed')); }
// codex P1-a r1 P1-4: three chained 9 s timers on an asserted page (27 s > the 10 s horizon) — each delay is under the
// horizon, the CHAIN is not → RED; a self-re-arming (repeating) timer → RED; a periodic interval within the horizon → RED
{
  const { sources } = require('./census');
  const probe = (code) => [...sources(), { file: 'xpizza-orders/zz-r3-probe.js', scope: 'xpizza-orders', kind: 'page', code, lineOffset: 0, module: false }];
  const r1 = T.check(D10, { units: probe("function a(){ setTimeout(() => { setTimeout(() => { setTimeout(() => { document.getElementById('cart-total').textContent = 'L 999.00'; }, 9000); }, 9000); }, 9000); }") });
  assert.ok(r1.problems.some((p) => /^CHAIN xpizza-orders\/zz-r3-probe\.js#a:setTimeout#0 → .* cumulative 27000 ms/.test(p)), FAIL(`the 3 × 9 s chain was not RED: ${JSON.stringify(r1.problems.filter((p) => /zz-r3/.test(p)))}`));
  const r2 = T.check(D10, { units: probe('function poll(){ setTimeout(poll, 500); }') });
  assert.ok(r2.problems.some((p) => /^CHAIN xpizza-orders\/zz-r3-probe\.js#poll.*REPEATS/.test(p)), FAIL('a self-re-arming timer was not RED'));
  const r3 = T.check(D10, { units: probe('function t(){ setInterval(() => {}, 2000); }') });
  assert.ok(r3.problems.some((p) => /^PERIODIC xpizza-orders\/zz-r3-probe\.js#t:setInterval#0/.test(p)), FAIL('an unreviewed periodic interval was not RED'));
  // codex r2 P1-3 form 1: an UNRETURNED async function with three sequential awaited 9 s sleeps (27 s)
  const r4 = T.check(D10, { units: probe("function go(){ (async () => { await new Promise((r) => setTimeout(r, 9000)); await new Promise((r) => setTimeout(r, 9000)); await new Promise((r) => setTimeout(r, 9000)); document.getElementById('cart-total').textContent = 'L 999.00'; })(); }") });
  assert.ok(r4.problems.some((p) => /^CHAIN await@xpizza-orders\/zz-r3-probe\.js:1 .*cumulative 27000 ms/.test(p)), FAIL(`the unreturned awaited-sleeps chain was not RED: ${JSON.stringify(r4.problems.filter((p) => /zz-r3/.test(p)))}`));
  // codex r2 P1-3 form 2: a timer chain continued through OBJECT METHODS
  const r5 = T.check(D10, { units: probe("const o = { a() { setTimeout(() => this.b(), 9000); }, b() { setTimeout(() => this.c(), 9000); }, c() { setTimeout(() => { document.getElementById('cart-total').textContent = 'L 999.00'; }, 9000); } }; o.a();") });
  assert.ok(r5.problems.some((p) => /^CHAIN xpizza-orders\/zz-r3-probe\.js#a:setTimeout#0 → .*#b:setTimeout#0 → .*#c:setTimeout#0: cumulative 27000 ms/.test(p)), FAIL(`the method-chained timers were not RED: ${JSON.stringify(r5.problems.filter((p) => /zz-r3/.test(p)))}`));
  // codex r2 P1-3: a declaration BELOW the computed bound is a contradiction → RED (computed overrides)
  {
    const pd = JSON.parse(JSON.stringify(D10)); const c27 = r5.cneed.find((c) => /zz-r3-probe\.js#a:setTimeout#0/.test(c.key));
    pd.chains.push({ key: c27.key, cumulativeBoundMs: 1000, repeats: false, repeatLimit: 1, reachesAsserted: true, reason: 'contradictory declaration', sha: c27.sha });
    const rc = T.check(pd, { units: probe("const o = { a() { setTimeout(() => this.b(), 9000); }, b() { setTimeout(() => this.c(), 9000); }, c() { setTimeout(() => { document.getElementById('cart-total').textContent = 'L 999.00'; }, 9000); } }; o.a();") });
    assert.ok(rc.problems.some((p) => /declared cumulativeBoundMs 1000 is BELOW the computed 27000 ms — a contradiction/.test(p)) && rc.problems.some((p) => /zz-r3-probe/.test(p) && /reaches an asserted output with a cumulative bound beyond the horizon/.test(p)), FAIL(`a contradictory declaration cleared the 27 s chain: ${JSON.stringify(rc.problems.filter((p) => /zz-r3/.test(p)))}`));
    const ps = clone(); const s0 = ps.sites.find((e) => r.inventory.some((t) => t.key === e.key && t.delay != null)); s0.bound = 1;
    assert.ok(T.check(ps).problems.some((p) => /BELOW the computed delay/.test(p)), FAIL('a site bound below its computed delay passed'));
  }
  // codex r3 P1-1: the reviewed bound is bound to its CONTROLLING scope — submitOrder's MAX_TRIES 3 → 5 (backoffs alone
  // ≤ 15 s) re-opens the reviewed 6000 ms submit chain and its backoff site; a declaration elsewhere in an unrelated
  // function does not
  {
    const real = sources(); const form = real.find((x) => x.file === 'xpizza-orders/index.html<script@2>');
    assert.ok(form && form.code.includes('const MAX_TRIES = 3;'), FAIL('premise — submitOrder declares MAX_TRIES = 3'));
    const mutated = real.map((x) => (x === form ? { ...form, code: form.code.replace('const MAX_TRIES = 3;', 'const MAX_TRIES = 5;') } : x));
    const rm = T.check(doc, { units: mutated }).problems;
    assert.ok(rm.some((p) => /^CHAIN await@xpizza-orders\/index\.html<script@2>:\d+ → .*submitOrder.*CONTROLLING scope changed/.test(p)) && rm.some((p) => /submitOrder>anon:setTimeout#2: its CONTROLLING scope changed/.test(p)), FAIL(`codex's MAX_TRIES 3 → 5 did not re-open the reviewed submit bound: ${JSON.stringify(rm.slice(0, 4))}`));
  }
  const d = clone(); d.chains[0].reachesAsserted = true; d.chains[0].repeatLimit = 'unbounded';
  assert.ok(T.check(d).problems.some((p) => /reaches an asserted output with a cumulative bound beyond the horizon/.test(p)), FAIL('a reviewed chain reaching an asserted output past the horizon passed'));
  const d2 = clone(); d2.periodic[0].changesAsserted = true;
  assert.ok(T.check(d2).problems.some((p) => /declared to change an asserted output/.test(p)), FAIL('a periodic changing an asserted output passed'));
}
ok(`chains + periodic: ${r.chains.length} chains (${r.cneed.length} reviewed beyond-horizon / unresolved / repeating), ${r.periodic.length} reviewed periodic intervals; negatives: codex's 3 × 9 s chain → RED, codex r2's UNRETURNED awaited-sleeps and METHOD-chained forms → RED, a declared bound below the computed one → RED (contradiction), codex r3's MAX_TRIES 3 → 5 re-opens the reviewed submit bound (controlling-scope binding), a self-re-arming timer → RED, an unreviewed interval → RED, a chain or interval reaching an asserted output → RED`);
ok('negatives: a long timer with no entry (or a shorter horizon exposing one), a changed call, a long timer reaching an asserted output, a stale entry → RED');
{ // the confirmation-horizon EXCEPTION is page- and output-scoped (advisor 2026-10-13): no other timer, output or page inherits it
  const X = (f) => { const d = clone(); f(d); return T.check(d).problems; };
  assert.ok(X((d) => { d.pages['xpizza-orders'].horizonMs = 46000; }).some((p) => /≠ the standard 10000 ms/.test(p)), FAIL('raising a page\'s base horizon passed'));
  assert.ok(X((d) => { d.pages['xpizza-kitchen'].horizonMs = 46000; }).some((p) => /page xpizza-kitchen: horizon 46000/.test(p)), FAIL('raising the KDS horizon passed'));
  // a non-exception timer reaching an asserted output beyond the standard horizon does NOT inherit the 46 s
  assert.ok(X((d) => { const e = d.sites.find((x) => x.key.endsWith('locPickPred>anon:setTimeout#0')); e.reachesAsserted = true; e.bound = 20000; }).some((p) => /locPickPred.*reaches an asserted output/.test(p)), FAIL('a non-exception timer inherited the exception horizon'));
  // an exception key declaring another output, or a key of another page, or an output without being a key → RED
  assert.ok(X((d) => { d.sites.find((x) => x.key.endsWith('form-order-number.js#start:setTimeout#0')).output = 'form.payStep'; }).some((p) => /must reach exactly one of the exception's outputs/.test(p)), FAIL('an exception key reaching another output passed'));
  assert.ok(X((d) => { d.pages['xpizza-orders'].exception.keys.push(d.chains.find((c) => /xpizza-kitchen/.test(c.key)).key); }).some((p) => /is not a timer of this page/.test(p)), FAIL('an exception key of another page passed'));
  assert.ok(X((d) => { const e = d.sites.find((x) => x.key.endsWith('locPickPred>anon:setTimeout#0')); e.output = 'form.confirmation'; }).some((p) => /declares an exception output but is not an exception key/.test(p)), FAIL('an output declared outside the exception passed'));
  assert.ok(X((d) => { d.pages['xpizza-orders'].exception.keys = d.pages['xpizza-orders'].exception.keys.filter((k) => !/start:setTimeout#0$/.test(k)); }).some((p) => /form-order-number\.js#start:setTimeout#0.*reaches an asserted output with a 45000 ms delay beyond the horizon/.test(p)), FAIL('the deadline reached its output beyond the standard horizon without the exception'));
}
ok('the confirmation-horizon exception is scoped: a raised base horizon (any page) → RED; a non-exception timer reaching an asserted output beyond 10 s → RED; an exception key naming another output / another page, or an output declared outside the exception → RED; without the exception the 45 s deadline → RED');
console.log(`\nr3-timer-bounds guard: OK (${n})`);
