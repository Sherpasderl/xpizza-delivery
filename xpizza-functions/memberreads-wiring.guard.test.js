'use strict';
// PLAN-3a-capp-member-reads (1)+(2) + PLAN-3a-addr S-ADDR-2 — index.js wiring guard for 3a's member exports (advisor ruling 2026-11-13, option 2).
// PROOF: tools/memberreads-module-inverse.js removes EXACTLY 3a's index.js insertions (5a84271f3: getMyFavorites + setFavorite;
// 32a4ce6e2: getMyLastTip; S-ADDR-2: useMyAddress), so index.js minus them === 604e96ab5:index.js byte-for-byte. Sensitivity: a byte inside a hunk, a duplicated
// hunk and a byte outside every hunk are each detected; a one-byte change to an export breaks the proof (and every fold guard that
// composes this layer). Registration: every fold guard that pins index.js to a fixed train revision composes this layer.
// Run: node memberreads-wiring.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BASE, HUNKS, FILES, unapplyMemberReadsModule } = require('./tools/memberreads-module-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
assert.strictEqual(BASE, '604e96ab5', 'the base is train asm9 (the RC asm9b branches from)');
assert.deepStrictEqual([...FILES], ['index.js', 'catalog/public-menu.js'], 'the owned files');
const src = require('./tools/mktprice-module-inverse').unapplyMktPriceModule('index.js', require('./tools/audience-module-inverse').unapplyAudienceModule('index.js', require('./tools/ledgers1-module-inverse').unapplyLedgerS1Module('index.js', require('./tools/dirwire-module-inverse').unapplyDirwireModule('index.js', fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')))));   // marketing price (5f, the newest layer) peeled first
const b = execFileSync('git', ['show', `${BASE}:xpizza-functions/index.js`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });
assert.notStrictEqual(src, b, 'non-vacuity: index.js differs from the base');
assert.strictEqual(unapplyMemberReadsModule('index.js', src), b, `🔴 index.js minus the member-reads hunks is not ${BASE}:index.js`);
ok(`index.js minus the ${HUNKS.length} member-reads insertions === ${BASE}:index.js byte-for-byte`);

// (3) dish_stats (5014e1295): catalog/public-menu.js minus its hunks === the base, byte-for-byte
const pmSrc = fs.readFileSync(path.join(__dirname, 'catalog/public-menu.js'), 'utf8');
const pmBase = execFileSync('git', ['show', `${BASE}:xpizza-functions/catalog/public-menu.js`], { cwd: __dirname, encoding: 'utf8' });
assert.notStrictEqual(pmSrc, pmBase, 'non-vacuity: public-menu.js differs from the base');
assert.strictEqual(unapplyMemberReadsModule('catalog/public-menu.js', pmSrc), pmBase, `🔴 catalog/public-menu.js minus the (3) hunks is not ${BASE}:catalog/public-menu.js`);
ok(`catalog/public-menu.js minus the ${HUNKS.filter((h) => h.file === 'catalog/public-menu.js').length} (3) hunks === ${BASE}:catalog/public-menu.js byte-for-byte`);
const fileSrc = { 'index.js': src, 'catalog/public-menu.js': pmSrc };

for (const h of HUNKS) {
  const src = fileSrc[h.file];
  const k = h.now.search(/[A-Za-z]/);
  assert.throws(() => unapplyMemberReadsModule(h.file, src.replace(h.now, h.now.slice(0, k) + '#' + h.now.slice(k + 1))), /occurs 0 times/, `${h.commit}: a byte inside a hunk`);
  assert.throws(() => unapplyMemberReadsModule(h.file, src + h.now), /occurs 2 times/, `${h.commit}: a duplicated hunk`);
}
assert.notStrictEqual(unapplyMemberReadsModule('index.js', '\n' + src), b, 'a byte OUTSIDE every hunk survives');
assert.notStrictEqual(unapplyMemberReadsModule('catalog/public-menu.js', '\n' + pmSrc), pmBase, 'public-menu.js: a byte OUTSIDE every hunk survives');
{ // the (3) VERSION mutant: 1d.4 → 1d.5 ⇒ the layer refuses (and so would every public-menu.js fold)
  const mut = pmSrc.replace("const REPRESENTATION_VERSION = '1d.4';", "const REPRESENTATION_VERSION = '1d.5';");
  assert.notStrictEqual(mut, pmSrc, 'premise: the 1d.4 marker is present');
  assert.throws(() => unapplyMemberReadsModule('catalog/public-menu.js', mut), /occurs 0 times/, '🔴 a one-byte change to the (3) marker is detected');
}
assert.strictEqual(unapplyMemberReadsModule('tb-unowned.js', 'x\n'), 'x\n', 'an unowned file passes through');
// the ONE-BYTE EXPORT MUTANT: the getMyLastTip export's handler name changed by one byte ⇒ the layer refuses (and so would every fold)
{
  const mut = src.replace("require('./my-last-tip').makeMyLastTip(", "require('./my-last-tip').makeMyLastTiP(");
  assert.notStrictEqual(mut, src, 'premise: the export is present');
  assert.throws(() => unapplyMemberReadsModule('index.js', mut), /occurs 0 times/, '🔴 a one-byte change to an export is detected');
}
ok('a byte inside a hunk, a duplicated hunk, a byte outside, an unowned file and a ONE-BYTE export change are each detected');

// wired: the four exports exist where the hunks say, through the member-auth modules
for (const [name, mod] of [['getMyFavorites', 'my-favorites'], ['setFavorite', 'my-favorites'], ['getMyLastTip', 'my-last-tip'], ['useMyAddress', 'my-address']]) {
  assert.ok(new RegExp(`exports\\.${name} = onRequest\\(`).test(src), `🔴 ${name} onRequest missing`);
  assert.ok(src.includes(`require('./${mod}')`), `🔴 ${mod} require missing`);
}
ok('wired: getMyFavorites, setFavorite, getMyLastTip and useMyAddress are onRequest exports over my-favorites / my-last-tip / my-address');
// PLAN-3a-capp-push-tokens r0 §2 (advisor GO 11-16): the 4 customer-push endpoints the capp's api calls by name, each an onRequest over the
// ONE makeCustomerPush factory with the account origins (the over-HTTP behaviour: test/customer-push-wiring.emulator.test.js)
{
  const PUSH = ['registerCustomerPushToken', 'unregisterCustomerPushToken', 'setCustomerPushPrefs', 'getCustomerPushPrefs'];
  const made = src.match(/require\('\.\/customer-push'\)\.makeCustomerPush\(\{ getDatabase, getAuth, checkRateLimit \}\)/g) || [];
  assert.strictEqual(made.length, 1, '🔴 PW-FACTORY: index.js builds the customer-push handlers ONCE, from makeCustomerPush with its own getDatabase / getAuth / checkRateLimit');
  for (const name of PUSH) {
    const re = new RegExp(`exports\\.${name} = onRequest\\(\\n  \\{ region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 \\},\\n  CUSTOMER_PUSH\\.${name},\\n\\);`);
    assert.ok(re.test(src), `🔴 PW-EXPORT ${name}: an onRequest (account origins) over CUSTOMER_PUSH.${name}`);
  }
  ok('wired: the 4 customer-push endpoints are onRequest exports (account origins) over ONE makeCustomerPush');
}
// unapplyAfter (the later-pinned guards, mktprice @aaeb8f277): peels EXACTLY the hunks marked after that revision — the push block — and
// nothing else; an unknown revision peels nothing. S-ADDR-2 (merged forward onto 31f05c8a4): the useMyAddress export postdates BOTH
// later pins — aaeb8f277 (mktprice / audience / dirwire) and 099c280e4 (ledgers1) — so it is marked after each; the push block only after aaeb8f277
{
  const { HUNKS: H, unapplyAfter } = require('./tools/memberreads-module-inverse');
  const marked = (rev) => H.filter((h) => [].concat(h.after || []).includes(rev));
  const after = marked('aaeb8f277');
  assert.deepStrictEqual(after.map((h) => h.commit), ['b08f3c30e', 'capp-push-wiring'], 'premise: the address export + the push block are marked after aaeb8f277');
  assert.deepStrictEqual(marked('099c280e4').map((h) => h.commit), ['b08f3c30e'], 'premise: only the address export is marked after 099c280e4');
  const peel = (s, hs) => hs.reduce((o, h) => o.replace(h.now, ''), s);
  assert.strictEqual(unapplyAfter('index.js', src, 'aaeb8f277'), peel(src, after), '🔴 PW-AFTER: unapplyAfter(aaeb8f277) peels exactly the address export + the push block');
  assert.strictEqual(unapplyAfter('index.js', src, '099c280e4'), peel(src, marked('099c280e4')), '🔴 ADDR-AFTER: unapplyAfter(099c280e4) peels exactly the address export');
  assert.ok(unapplyAfter('index.js', src, '099c280e4').includes(after[1].now), '🔴 ADDR-AFTER: the push block (in 099c280e4) is NOT peeled at that pin');
  assert.strictEqual(unapplyAfter('index.js', src, 'f00ba4'), src, '🔴 PW-AFTER: an unknown revision peels nothing');
  for (const h of after) assert.throws(() => unapplyAfter('index.js', src + h.now, 'aaeb8f277'), /occurs 2 times/, `🔴 PW-AFTER: a duplicated ${h.commit} hunk is detected`);
  ok('unapplyAfter peels exactly the hunks a pin lacks (aaeb8f277: address + push; 099c280e4: address only); an unknown revision peels nothing; a duplicate is detected');
}

// registration: the fold guards that pin index.js to a fixed train revision compose this layer (the s2bext / s1srv pattern)
{
  const MUST = ['confirmretire', 'd4', 'dpao', 'envlim', 'hostedrace', 'keymode', 'p5a', 's1d', 's1srv', 's2', 's2bext', 'sdkpay', 'tippref', 'zones'];
  for (const g of MUST) {
    const s = fs.readFileSync(path.join(__dirname, `${g}-wiring.guard.test.js`), 'utf8');
    assert.ok(/memberreads-module-inverse'\)\.unapplyMemberReadsModule\(/.test(s), `🔴 ${g}-wiring does not compose the member-reads layer`);
  }
  ok(`registration: all ${MUST.length} train-pinned index.js fold guards compose the member-reads layer`);
  // (3): the 9 guards that fold catalog/public-menu.js to a fixed revision compose it too
  const PM = ['directory-wiring.guard', 'keymode-wiring.guard', 's1d-wiring.guard', 'formbake-module-wiring.guard', 'avail-identity-wiring.guard', 'photos-module-wiring.guard', 's2bext-wiring.guard', 's2core-wiring.guard', 'catalog/identity-integrity-guards'];
  for (const g of PM) {
    const s = fs.readFileSync(path.join(__dirname, `${g}.test.js`), 'utf8');
    assert.ok(/memberreads-module-inverse'\)\.unapplyMemberReadsModule\(/.test(s), `🔴 ${g} (public-menu.js fold) does not compose the member-reads layer`);
  }
  ok(`registration (3): the ${PM.length} catalog/public-menu.js folds compose the member-reads layer`);
}
console.log(`\nmemberreads-wiring.guard: OK (${n})`);
