'use strict';
// MENU-ORDERING §3, codex serialization r1 — wiring guard. Run: node serial3-wiring.guard.test.js
//   1. PROOF: tools/serial3-inverse.js turns index.js back into its base BYTE-FOR-BYTE (8 delimited, byte-pinned blocks) and
//      the pinned materialize-guard.js back into its base (2 hunks). An edit inside a block / hunk, a missing or extra block
//      and a byte outside are each detected.
//   2. PLACEMENT: both factura sites (createOrder, chargeOnlineOrder) re-order the priced lines through
//      catalog/menu-order.js with the PRICING version (the tables' envelope) and the order_id, BEFORE the order record is
//      built from them; the createOrder content stamp and the materialize-side duplicate guard read BOTH content keys.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { unapplySerial3Index, unapplySerial3Module, BLOCKS, HUNKS, FILES, BASE } = require('./tools/serial3-inverse');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const baseOf = (f) => execFileSync('git', ['show', `${BASE}:xpizza-functions/${f}`], { cwd: __dirname, encoding: 'utf8', maxBuffer: 1 << 28 });

// ── 1a. index.js ──
// S1a (driver accounts) is the NEWEST index.js layer, folded on top of these serial3 blocks; its exact inverse
// (tools/s1a-inverse.js, proven byte-for-byte by s1a-wiring.guard) reverses FIRST so this guard isolates serial3's
// own delta back to BASE. S1a's hunks are disjoint from every serial3 block (reversal order is immaterial).
const { unapplyS1aIndex } = require('./tools/s1a-inverse');
{
  const real = require('./tools/h0-inverse').unapplyH0Index(unapplyS1aIndex(require('./tools/a1-inverse').unapplyA1Index(require('./tools/s1b-inverse').unapplyS1bIndex(require('./tools/s5-inverse').unapplyS5Index(require('./tools/h1-inverse').unapplyH1Index(require('./tools/h1c-inverse').unapplyH1cIndex(require('./tools/signup-inverse').unapplySignupIndex(require('./tools/unassign-inverse').unapplyUnassignIndex(require('./tools/tracker-fixes-inverse').unapplyTrackerFixesIndex(require('./tools/release-race-inverse').unapplyReleaseRaceIndex(require('./tools/brand-server-inverse').unapplyBrandServerIndex(require('./tools/dlite-push-inverse').unapplyDlitePushIndex(require('./tools/membership-inverse').unapplyMembershipIndex(require('./tools/portalui-inverse').unapplyPortalUiIndex(require('./tools/menu-warm-inverse').unapplyMenuWarmIndex(require('./tools/o1b-inverse').unapplyO1bIndex(require('./tools/stackseq-inverse').unapplyStackseqIndex(require('./tools/drvf-inverse').unapplyDrvfIndex(require('./tools/drvc-inverse').unapplyDrvcIndex(read('index.js')))))))))))))))))))));   // S1a (newest) reverses FIRST, then PLAN-H0 — leaving the serial3 layer
  const base = baseOf('index.js');
  assert.notStrictEqual(unapplySerial3Index(real), real, 'non-vacuity: the blocks are present and swapped back');
  assert.strictEqual(unapplySerial3Index(real), base, `🔴 index.js minus the serial3 blocks (after the S1a + H0 layers are reversed first) is not ${BASE}:index.js`);
  assert.strictEqual(BLOCKS.length, 10, '10 blocks');
  assert.throws(() => unapplySerial3Index(real.replace('orderId, bodyItems: body.items, priced: facturaPricedBody', 'orderId, bodyItems: body.items, priced: facturaPricedBody ')), /pinned bytes/, 'an edit INSIDE a block');
  assert.throws(() => unapplySerial3Index(real.replace('/* serial3:end wiring */', '')), /exactly 10/, 'a missing delimiter');
  assert.throws(() => unapplySerial3Index(real.replace('exports.verifyOtp', '/* serial3:begin x */\n/* serial3:end x */\nexports.verifyOtp')), /exactly 10/, 'an eleventh block');
  assert.notStrictEqual(unapplySerial3Index(real.replace('exports.verifyOtp', 'exports.verifyOtP')), base, 'a byte OUTSIDE the blocks survives (the base pin catches it)');
  ok(`index.js: unapplySerial3Index(unapplyH0Index(unapplyS1aIndex(·))) → ${BASE}:index.js byte-for-byte (10 blocks); an edit inside, a missing delimiter, an eleventh block and a byte outside are each caught`);
}
// ── 1b. the pinned module ──
{
  assert.deepStrictEqual([...FILES], ['materialize-guard.js']);
  const f = 'materialize-guard.js'; const src = read(f);
  assert.strictEqual(unapplySerial3Module(f, src), baseOf(f), `🔴 ${f} minus the serial3 hunks is not ${BASE}:${f}`);
  assert.throws(() => unapplySerial3Module(f, src.replace(HUNKS[1].now, HUNKS[1].now.replace('readContentStampByKeys(deps.db', 'readContentStampByKeys( deps.db'))), /occurs 0 times/, 'a byte INSIDE a hunk');
  assert.throws(() => unapplySerial3Module(f, src + HUNKS[0].now), /occurs 2 times/, 'a duplicated hunk');
  assert.notStrictEqual(unapplySerial3Module(f, src.replace("'use strict';", "'use strict'; ")), baseOf(f), 'a byte OUTSIDE every hunk is detected');
  ok(`module: unapplySerial3Module → ${BASE}:materialize-guard.js byte-for-byte (${HUNKS.length} hunks); inside / duplicate / outside each caught`);
}

// ── 2. placement ──
const idx = read('index.js');
const at = (s, needle, from = 0) => s.indexOf(needle, from);
for (const [label, start, end, tag, recordUse] of [
  ['createOrder', 'createOrderApp.all(', 'createOrderApp.use(', 'cash', 'facturaPriced, cashTenderedCents'],
  ['chargeOnlineOrder', 'chargeOnlineApp.all(', 'chargeOnlineApp.use(', 'card', '...(facturaPriced.items ? { items: facturaPriced.items } : {})'],
]) {
  const h = idx.slice(at(idx, start), at(idx, end));
  const head = at(h, `/* serial3:begin factura-${tag}-head */`), order = at(h, `/* serial3:begin factura-${tag}-order */`), use = at(h, recordUse, order);
  assert.ok(head > 0 && order > head && use > order, `${label}: the priced lines (${head}) → the menu-order step (${order}) → the order record (${use})`);
  const blk = h.slice(order, at(h, `/* serial3:end factura-${tag}-order */`));
  assert.ok(/MO\.facturaInMenuOrder\(\{ source: menuOrderSource\(\), restaurantId, versionId: menuOrderVersionOf\(pricingTables\),\s+orderId, bodyItems: body\.items, priced: facturaPricedBody \}\)/.test(blk),
    `${label}: the step gets the PRICING tables' version, the order_id, the body's lines and the priced result`);
  assert.strictEqual((h.match(/facturaPricedBody/g) || []).length, 2, `${label}: the un-ordered result is used ONLY by the step`);
  ok(`${label}: the factura's priced lines go through the menu-order step (pricing version + order_id) before the order record is built`);
}
{
  const wiring = idx.slice(at(idx, '/* serial3:begin wiring */'), at(idx, '/* serial3:end wiring */'));
  assert.ok(/require\('\.\/catalog\/pricing-tables'\)\.envelopeOf\(tables\)/.test(wiring) && /e \? e\.versionId : null/.test(wiring), 'the version is the pricing envelope\'s');
  assert.ok(/MO\.createMenuOrderSource\(\{ readStructure: MO\.fromGateReader\(gateReader\) \}\)/.test(wiring), 'the item_order comes from the gate reader\'s cached snapshot of that version (no read of its own; emulator-tested)');
  assert.ok(/peekItemOrder: \(rid, versionId\) => \{ const g = cache\.get\(/.test(read('catalog/menu-gates.js')) && /itemOrder: built\.structure && Array\.isArray\(built\.structure\.item_order\)/.test(read('catalog/menu-gates.js')), '…which only PEEKS (never reads) the version\'s item_order from the intake gates\' cached snapshot');
  assert.ok(!/deadlineMs/.test(wiring), 'the module\'s own tight default deadline applies');
  const co = idx.slice(at(idx, 'createOrderApp.all('), at(idx, 'createOrderApp.use('));
  const stamp = co.slice(at(co, '/* serial3:begin create-stamp */'), at(co, '/* serial3:end create-stamp */'));
  assert.ok(/const rec = await readContentStamp\(db, \{ phone: fields\.customer_phone, itemsText: fields\.items_text, orderType,/.test(stamp), 'createOrder reads its prior content stamp under BOTH keys');
  assert.ok(/\{ menuNames: menuNamesOf\(restaurantId, pricingTables\), orderId \}\);/.test(stamp), 'createOrder: the legacy key is rebuilt in the PRICING version\'s menu order (r2)');
  assert.ok(/const menuNamesOf = \(rid, tables\) => gateReader\(\)\.peekMenuNames\(rid, menuOrderVersionOf\(tables\)\);/.test(wiring), 'menuNamesOf peeks the cached snapshot of the pricing version');
  // r3 (codex r3 P1): the keys are computed at chargeOnlineOrder's intake (warm snapshot) and PERSISTED on the pending order;
  // confirmDeps supplies NO menu names (its handlers run cold), and the guard reads the persisted keys
  const cd = idx.slice(at(idx, 'function confirmDeps(db)'), at(idx, 'function runConfirm('));
  assert.ok(!/menuNamesFor|peekActiveMenuNames|serial3:begin confirm-deps/.test(cd), 'confirmDeps carries no menu-name dependency (r3)');
  assert.ok(!/peekActiveMenuNames/.test(read('catalog/menu-gates.js')), '…and the gate reader no longer offers the cold-cache peek');
  const ch = idx.slice(at(idx, 'chargeOnlineApp.all('), at(idx, 'chargeOnlineApp.use('));
  const keys = ch.slice(at(ch, '/* serial3:begin card-content-keys */'), at(ch, '/* serial3:end card-content-keys */'));
  assert.ok(/Object\.assign\(pendingOrderRecord, contentKeysRecord\(\{ phone: fields\.customer_phone, itemsText: fields\.items_text, orderType, scheduledFor: isScheduled \? scheduledForRaw : null \},\s*\{ menuNames: menuNamesOf\(restaurantId, pricingTables\), orderId, suffix: rewardSuffix \}\)\);/.test(keys), 'chargeOnlineOrder persists the content keys of the FINAL items_text (the record\'s own) in the PRICING version\'s menu order');
  assert.ok(ch.indexOf('/* serial3:begin card-content-keys */') > ch.indexOf('const pendingOrderRecord = {') && ch.indexOf('/* serial3:begin card-content-keys */') < ch.indexOf('acquireHostedAttempt('), '…onto the pending record before it is written');
  const mg = read('materialize-guard.js');
  assert.ok(/const persisted = typeof order\.content_key === 'string' && order\.content_key === ck;/.test(mg), 'the materialize-side guard trusts the persisted keys only when they are THIS content\'s');
  // r6 (codex r6, the structural ruling): hold(X) = MAIN_PATH(X) OR NEW_PATH(X) — two functions, OR-ed, main's lookup kept
  assert.ok(/const dec = \(await mainPathSibling\(deps, orderId, order, args\)\) \|\| \(await newPathSibling\(deps, orderId, order, args\)\);/.test(mg), 'the guard is MAIN_PATH OR NEW_PATH');
  const mainFn = mg.slice(mg.indexOf('async function mainPathSibling('), mg.indexOf('async function newPathSibling('));
  const baseMg = execFileSync('git', ['show', `${BASE}:xpizza-functions/materialize-guard.js`], { cwd: __dirname, encoding: 'utf8' });
  for (const line of ["    const stamp = (await deps.db.ref(`recent_order_content/${rateLimitKey(order.customer_phone)}/${ck}`).once('value')).val();",
    "    if (!stamp || !stamp.order_id || stamp.order_id === orderId || stamp.payment_method !== 'cash') return false;".replace('return false;', 'return null;'),
    "    const siblingOrder = (await deps.db.ref(`orders/${stamp.order_id}`).once('value')).val();",
    "    const dec = duplicateSiblingDecision(orderId, stamp, siblingOrder, 'cash');   // PIN 1: no 2-min gate — liveness of Y decides"]) {
    assert.ok(mainFn.includes(line), `MAIN_PATH keeps main's lookup byte-recognisable: ${line.trim().slice(0, 60)}…`);
    assert.ok(baseMg.includes(line.replace('return null;', 'return false;')), `…and that line IS main's (${BASE})`);
  }
  assert.ok(/const ck = orderContentKeyVerbatim\(args\);/.test(mainFn) && !/legacyKey|content_key|readContentStampByKeys/.test(mainFn), 'MAIN_PATH keys the incoming VERBATIM text (main\'s key) and nothing else');
  assert.ok(/if \(c\.known && !sameCart\(siblingOrder, c\.text, orderContentKey\(args\)\)\) \{ logRefused\(orderId, stamp\.order_id, 'main', 'sibling_content_mismatch'\); return null; \}/.test(mainFn), 'MAIN_PATH refuses ONLY a PROVABLE mismatch (known client content), logged');
  const newFn = mg.slice(mg.indexOf('async function newPathSibling('), mg.indexOf('async function holdIfDuplicateSibling('));
  assert.ok(/const persisted = typeof order\.content_key === 'string' && order\.content_key === ck;/.test(newFn) && /legacyKey = legacyKeyByOrder\(args, order\.content_legacy_order, ownSuffix\)/.test(newFn) && !/order\.content_key_legacy\b(?!_reason)/.test(newFn), 'NEW_PATH: persisted keys trusted only for THIS content; the legacy key REBUILT (never stored)');
  assert.ok(/const stamp = await readContentStampByKeys\(deps\.db, order\.customer_phone, \[key\]\);/.test(newFn) && !/menuNames/.test(mg), 'NEW_PATH evaluates EACH key on its own (no cross-key latest-wins), never from menu names');
  assert.ok(/if \(!c\.known\) \{ logRefused\(orderId, stamp\.order_id, 'new', c\.reason\); continue; \}/.test(newFn) && /if \(!sameCart\(siblingOrder, c\.text, ck\)\) \{ logRefused\(orderId, stamp\.order_id, 'new', 'sibling_content_mismatch'\); continue; \}/.test(newFn), 'NEW_PATH holds ONLY on a VERIFIED same cart (unknown / mismatch → no hold, logged)');
  // r5 (codex r5 P1): server-appended reward text by PROVENANCE only — persisted where the server appends it, read exactly
  assert.ok(/const rewardSuffixOf = \(freeItems, itemsText\) => \{ const t = freeItems && freeItems\.length \? rewardAppendText\(freeItems\) : ''; return t && String\(itemsText\)\.endsWith\(t\) \? t : null; \};/.test(idx), 'the provenance is the server\'s OWN formatter output, persisted only when the text ends with it');
  // the pinned prepareRedemption appends with EXACTLY the template order-dedup.rewardAppendText uses (byte-identical)
  const TPL = '` | ${fi.qty}x ${fi.name} (Recompensa)`';
  assert.ok(read('rewards-redeem-intake.js').includes(`const appends = freeItems.map((fi) => ${TPL}).join('');`), 'prepareRedemption still appends with the template');
  assert.ok(read('order-dedup.js').includes(`.map((fi) => ${TPL}).join('');`), '…and order-dedup.rewardAppendText uses the byte-identical template');
  const coAll = idx.slice(at(idx, 'createOrderApp.all('), at(idx, 'createOrderApp.use('));
  for (const id of ['cash-reward-provenance-held', 'cash-reward-provenance']) {
    const blk = coAll.slice(at(coAll, `/* serial3:begin ${id} */`), at(coAll, `/* serial3:end ${id} */`));
    assert.ok(/\.reward_text_appended = rewardSuffixOf\(redemptionFreeItems, fields\.items_text\);/.test(blk), `createOrder (${id}) persists reward_text_appended`);
  }
  assert.ok(/if \(rewardSuffix\) pendingOrderRecord\.reward_text_appended = rewardSuffix;/.test(keys) && /orderId, suffix: rewardSuffix \}\)\);/.test(keys), 'chargeOnlineOrder persists it and builds the permutation over the CLIENT lines (provenance)');
  assert.ok(!/SERVER_LINE|\(Recompensa\)\\\$/.test(read('order-dedup.js')), 'order-dedup decides NOTHING by a "(Recompensa)" pattern');
  assert.ok(/if \(suffix\) \{ const t = clientTextOf\(sib\.items_text, suffix\);/.test(mg) && /if \(sib\.redemption\) return \{ known: false, reason: 'no_reward_provenance' \};/.test(mg), 'the guard strips the sibling\'s reward text by provenance only; a reward without provenance is unverifiable (today\'s behaviour, logged)');
  assert.ok(/: 'legacy_order_absent';/.test(mg), 'r5 P2: an absent permutation is an explicit, logged fallback');
  ok('wiring: the item_order is the PRICING version\'s menu_structure (module deadline); createOrder\'s prior stamp reads both keys; chargeOnlineOrder persists both and the materialize guard reads them (r3, no cold-cache dependency)');
}
console.log(`\nserial3-wiring.guard: OK (${n})`);
