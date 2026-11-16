'use strict';
// OFFER AUDIENCE (PLAN-5f-offer-audience r4.1) — the audience layer's own pin: every owned file minus the audience hunks === BASE:<file>
// byte-for-byte; the layer is non-vacuous, detects a tampered or duplicated hunk, passes other files through; and every reader that peels
// mktprice peels the audience layer first, directly inside it (some audience hunks edit mktprice lines). Run: node audience-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyAudienceModule } = require('./tools/audience-module-inverse');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const git = (args) => execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 27 });
{
  // the handlers' audience hooks (PLAN r4.1 §2 / §3 / §5) — every site, exactly once each; the live handlers end to end run in the emulator suite
  const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const count = (needle) => idx.split(needle).length - 1;
  const want = [
    ['placementAud: OFW.placementAudOf(body.quote_token, process.env.QUOTE_TOKEN_SECRET, Date.now()), placingUid: customer_uid', 2, 'both placements (cash createOrder + card chargeOnlineOrder / placeSdkApp) read the token\'s audience evidence, bound to the placing customer'],
    ["require('./marketing/audience-place').stampCash(heldUpdates, orderId, dq, Date.now());", 1, 'the held cash order freezes the codes + the deadline index'],
    ["require('./marketing/audience-place').stampCash(updates, orderId, dq, Date.now());", 1, 'the cash order freezes the codes + the deadline index'],
    ["await require('./marketing/audience-place').stampCard(db, pendingOrderRecord, orderId, dq, Date.now());", 1, 'the card pending record: the index first, then the codes'],
    ["audience: { member: require('./marketing/audience-place').memberOf(req, db, { knownUid: dq.uid, getAuth, attributionUid }), key: audienceKey }", 1, 'the quote resolves the member lazily, with the key'],
    ['customerId: dqo.aud ? dqo.aud_uid : dq.uid, nowMs: Date.now(), ...(dqo.aud ? { aud: dqo.aud } : {})', 1, 'the quote signs aud + its member'],
    ["secrets: [AUDIENCE_KEY_V1]", 2, 'the key is bound to quoteOrder and the fulfilment writer ONLY'],
    ["exports.markAudienceOnStatus = onValueWritten(\n  { ref: '/orders/{orderId}/status', region: 'us-central1', retry: true, timeoutSeconds: 60, secrets: [AUDIENCE_KEY_V1] },", 1, 'the writer: its own status trigger, retried'],
    ["catch (e) { console.error('markAudienceOnStatus', e && e.code ? String(e.code).slice(0, 40) : 'error'); throw e; }", 1, 'the writer\'s failures propagate (retry) and log a code only'],
    ["defineSecret('AUDIENCE_KEY_V1')", 1, 'one secret definition'],
  ];
  for (const [needle, k, why] of want) assert.strictEqual(count(needle), k, `AUDIENCE: 🔴 AUD-SITES ${why} (${count(needle)} × ${needle.slice(0, 60)})`);
  ok(`the handler hooks: ${want.length} sites, each exactly where it belongs`);
}
assert.ok(FILES.length >= 1 && HUNKS.length >= 1, 'AUDIENCE: non-vacuity — the layer owns files');
for (const F of FILES) {
  const disk = fs.readFileSync(path.join(__dirname, F), 'utf8');
  const base = git(['show', `${BASE}:xpizza-functions/${F}`]);
  assert.notStrictEqual(disk, base, `AUDIENCE: non-vacuity — ${F} carries the audience hunks`);
  assert.strictEqual(unapplyAudienceModule(F, disk), base, `AUDIENCE: 🔴 ${F} minus the audience hunks is not ${BASE}:${F}`);
  for (const h of HUNKS.filter((x) => x.file === F)) {
    const k = Math.floor(h.now.length / 2);
    assert.throws(() => unapplyAudienceModule(F, disk.replace(h.now, h.now.slice(0, k) + '\u0000' + h.now.slice(k + 1))), /occurs 0 times/, `AUDIENCE: ${F}: a byte inside a hunk`);
    assert.throws(() => unapplyAudienceModule(F, disk + h.now), /occurs 2 times/, `AUDIENCE: ${F}: a duplicated hunk`);
  }
}
assert.strictEqual(unapplyAudienceModule('tb-unowned.js', 'x\n'), 'x\n', 'AUDIENCE: an unowned file passes through');
ok(`${FILES.length} file(s) minus the ${HUNKS.length} audience hunks === ${BASE.slice(0, 9)} byte-for-byte; tamper / duplicate detected; other files pass through`);
{
  const files = git(['grep', '-l', 'unapplyMktPriceModule(', '--', ':(top)*.js', ':(top)*.mjs']).split('\n').filter(Boolean)
    .filter((f) => !/(^|\/)tools\/mktprice-module-inverse\.js$|(^|\/)mktprice-wiring\.guard\.test\.js$|(^|\/)audience-wiring\.guard\.test\.js$/.test(f));
  const bare = [];
  for (const f of files) {
    const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const re = /require\('[./]*tools\/mktprice-module-inverse'\)\.unapplyMktPriceModule\(/g; let m;
    while ((m = re.exec(s))) if (!/^[^,]+, require\('[./]*tools\/audience-module-inverse'\)\.unapplyAudienceModule\(/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 200))) bare.push(`${f}@${m.index}`);
  }
  assert.ok(files.length > 50, `AUDIENCE: non-vacuity (${files.length} readers)`);
  assert.deepStrictEqual(bare, [], `AUDIENCE: 🔴 a mktprice peel whose argument is not the audience peel: ${bare.join(', ')}`);
  ok(`every mktprice peel in ${files.length} readers peels the audience layer first (directly inside it)`);
}
console.log(`audience-wiring guard: OK (${n})`);
