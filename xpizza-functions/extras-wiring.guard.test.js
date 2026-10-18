'use strict';
// PER-PRODUCT EXTRAS, stage 2 — wiring guard (PLAN-per-product-extras rev 2.2 §4/§5).
//   1. PROOF: tools/extras-inverse.js turns index.js back into its base (6f353ed) BYTE-FOR-BYTE (8 delimited, byte-pinned blocks: 7 pure
//      insertions + the acquire call); tools/extras-module-inverse.js does the same for the pinned modules it touches. An edit
//      inside a block, a missing / extra block and a byte outside are each detected.
//   2. PLACEMENT: the check runs at all four money intakes, AFTER the group rules and BEFORE any write / reserve / quote
//      issuance; the card path refuses a FRESH issuance up front and otherwise arms the acquire guard, which sits after the
//      reuse return and before the CAS (bound reuse is never re-judged).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplyExtrasIndex, BLOCKS } = require('./tools/extras-inverse');
const { unapplyExtrasModule, FILES, HUNKS } = require('./tools/extras-module-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
// index.js: the extras slice sits on 6f353ed (main, which added the WhatsApp-cancel block); the pinned MODULES are byte-identical
// at 537bbbc and 6f353ed, and keep the slice's original base
const BASE = '537bbbc';
const INDEX_BASE = '6f353ed';
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const baseOf = (f, at = BASE) => execFileSync('git', ['show', `${at}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });

// ── 1a. index.js ──
{
  const real = require('./tools/serial3-inverse').unapplySerial3Index(require('./tools/h0-inverse').unapplyH0Index(require('./tools/s1a-inverse').unapplyS1aIndex(require('./tools/a1-inverse').unapplyA1Index(require('./tools/s1b-inverse').unapplyS1bIndex(require('./tools/s5-inverse').unapplyS5Index(require('./tools/h1-inverse').unapplyH1Index(require('./tools/h1c-inverse').unapplyH1cIndex(read('index.js')))))))));   // the newer §3 serial3 blocks are reversed FIRST
  const base = baseOf('index.js', INDEX_BASE);
  assert.notStrictEqual(unapplyExtrasIndex(real), real, 'non-vacuity: the blocks are present and swapped back');
  assert.strictEqual(unapplyExtrasIndex(real), base, `🔴 index.js minus the extras blocks is not ${INDEX_BASE}:index.js`);
  assert.strictEqual(BLOCKS.length, 8, '8 blocks');
  assert.throws(() => unapplyExtrasIndex(real.replace('EI.logShadow(\'createOrder\'', 'EI.logShadow(\'createorder\'')), /pinned bytes/, 'an edit INSIDE a block');
  assert.throws(() => unapplyExtrasIndex(real.replace('/* extras:end cash */', '')), /exactly 8/, 'a missing delimiter');
  assert.throws(() => unapplyExtrasIndex(real.replace('exports.verifyOtp', '/* extras:begin x */\n/* extras:end x */\nexports.verifyOtp')), /exactly 8/, 'a ninth block');
  assert.notStrictEqual(unapplyExtrasIndex(real.replace('exports.verifyOtp', 'exports.verifyOtP')), base, 'a byte OUTSIDE the blocks survives (the base pin catches it)');
  ok(`index.js: unapplyExtrasIndex → ${INDEX_BASE}:index.js byte-for-byte (8 blocks); an edit inside, a missing delimiter, a ninth block and a byte outside are each caught`);
}
// ── 1b. the pinned modules ──
{
  assert.deepStrictEqual([...FILES].sort(), ['catalog/catalog-publish.js', 'catalog/source-store.js', 'menu-pricing.js']);
  for (const f of FILES) assert.strictEqual(unapplyExtrasModule(f, read(f)), baseOf(f), `🔴 ${f} minus the extras hunks is not ${BASE}:${f}`);
  const f = 'catalog/source-store.js'; const src = read(f);
  const h = HUNKS.find((x) => x.file === f && x.now.includes('deny_extras'));
  assert.throws(() => unapplyExtrasModule(f, src.replace(h.now, h.now.replace('deny_extras', 'deny_extraz'))), /occurs 0 times/, 'a byte INSIDE a hunk');
  assert.throws(() => unapplyExtrasModule(f, src + h.now), /occurs 2 times/, 'a duplicated hunk');
  assert.notStrictEqual(unapplyExtrasModule(f, src.replace("'use strict';", "'use strict'; ")), baseOf(f), 'a byte OUTSIDE every hunk is detected');
  ok(`modules: unapplyExtrasModule → ${BASE} byte-for-byte for ${FILES.join(', ')} (${HUNKS.length} hunks); inside / duplicate / outside each caught`);
}

// ── 2. placement ──
const idx = read('index.js');
const at = (s, needle, from = 0) => s.indexOf(needle, from);
{
  const co = idx.slice(at(idx, 'createOrderApp.all('), at(idx, 'createOrderApp.use('));
  const grp = at(co, 'if (groupRefusal)'); const xc = at(co, '/* extras:begin cash */'); const wk = at(co, 'weekendOnlyViolation(body.items');
  const write = at(co, '.update(updates)');
  assert.ok(grp > 0 && xc > grp && wk > xc && write > xc, `cash: group rules (${grp}) < extras (${xc}) < weekend (${wk}) < the write`);
  ok('cash createOrder: the extras check runs after the group rules and before the weekend check and any write');
}
{
  const ch = idx.slice(at(idx, 'chargeOnlineApp.all('));
  const gd = at(ch, 'GI.chargeDecision('); const xc = at(ch, '/* extras:begin card */'); const reserve = at(ch, 'reserveRedemption('); const acq = at(ch, 'acquireHostedAttempt(db, orderId');
  assert.ok(gd > 0 && xc > gd && reserve > xc && acq > xc, `card: group decision (${gd}) < extras (${xc}) < reserve (${reserve}) < acquire (${acq})`);
  assert.ok(/choiceArmed, extrasArmed[,)]/.test(ch), 'the extras guard reaches acquireHostedAttempt');   // PLAN-A A-1 passes one more argument (textBinding) after it
  assert.ok(/acq\.reason === 'extra_not_allowed' \|\| acq\.reason === 'eligibility_unavailable'/.test(ch), 'the guard’s conflicts map to their typed refusals');
  const hc = read('pixelpay-hosted-charge.js');
  const reuseRet = at(hc, "return { outcome: 'reuse'"); const guard = at(hc, "if (extrasRefuseFresh === 'extra_not_allowed'"); const cas = at(hc, 'const tx = await orderRef.transaction(');
  assert.ok(reuseRet > 0 && guard > reuseRet && cas > guard, `acquire: reuse returns (${reuseRet}) < extras guard (${guard}) < CAS (${cas}) — bound reuse is never re-judged`);
  ok('card chargeOnlineOrder: after the group decision, before reserve and acquire; the acquire guard sits after the reuse return and before the CAS');
}
for (const [ep, block, before] of [['exports.quoteOrder = onRequest(', '/* extras:begin quote */', 'computeServerTotal(body.items'], ['exports.quoteRedemption = onRequest(', '/* extras:begin quote-redemption */', 'quoteRedemptionCore(']]) {
  const q = idx.slice(at(idx, ep), at(idx, ep) + 9000);
  const xc = at(q, block); const b = at(q, before);
  assert.ok(xc > 0 && b > xc, `${ep}: extras (${xc}) < ${before} (${b})`);
}
ok('quoteOrder / quoteRedemption: the extras check runs before pricing and before a (signed) quote is issued');
console.log(`\nextras-wiring.guard: OK (${n})`);
