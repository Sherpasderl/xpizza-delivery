'use strict';
// MENU-ORDERING §3, codex serialization r1 — wiring guard. Run: node serial3-wiring.guard.test.js
//   1. PROOF: tools/serial3-inverse.js turns index.js back into its base BYTE-FOR-BYTE (7 delimited, byte-pinned blocks) and
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
{
  const real = read('index.js');
  const base = baseOf('index.js');
  assert.notStrictEqual(unapplySerial3Index(real), real, 'non-vacuity: the blocks are present and swapped back');
  assert.strictEqual(unapplySerial3Index(real), base, `🔴 index.js minus the serial3 blocks is not ${BASE}:index.js`);
  assert.strictEqual(BLOCKS.length, 7, '7 blocks');
  assert.throws(() => unapplySerial3Index(real.replace('orderId, bodyItems: body.items, priced: facturaPricedBody', 'orderId, bodyItems: body.items, priced: facturaPricedBody ')), /pinned bytes/, 'an edit INSIDE a block');
  assert.throws(() => unapplySerial3Index(real.replace('/* serial3:end wiring */', '')), /exactly 7/, 'a missing delimiter');
  assert.throws(() => unapplySerial3Index(real.replace('exports.verifyOtp', '/* serial3:begin x */\n/* serial3:end x */\nexports.verifyOtp')), /exactly 7/, 'an eighth block');
  assert.notStrictEqual(unapplySerial3Index(real.replace('exports.verifyOtp', 'exports.verifyOtP')), base, 'a byte OUTSIDE the blocks survives (the base pin catches it)');
  ok(`index.js: unapplySerial3Index → ${BASE}:index.js byte-for-byte (7 blocks); an edit inside, a missing delimiter, an eighth block and a byte outside are each caught`);
}
// ── 1b. the pinned module ──
{
  assert.deepStrictEqual([...FILES], ['materialize-guard.js']);
  const f = 'materialize-guard.js'; const src = read(f);
  assert.strictEqual(unapplySerial3Module(f, src), baseOf(f), `🔴 ${f} minus the serial3 hunks is not ${BASE}:${f}`);
  assert.throws(() => unapplySerial3Module(f, src.replace(HUNKS[1].now, HUNKS[1].now.replace('readContentStamp(deps.db', 'readContentStamp( deps.db'))), /occurs 0 times/, 'a byte INSIDE a hunk');
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
  const mg = read('materialize-guard.js');
  assert.ok(/const stamp = await readContentStamp\(deps\.db, \{ phone: order\.customer_phone, itemsText: order\.items_text, orderType: order\.order_type,/.test(mg), 'the materialize-side duplicate guard reads BOTH keys');
  ok('wiring: the item_order is the PRICING version\'s menu_structure (module deadline); createOrder\'s prior stamp and the materialize guard read both content keys');
}
console.log(`\nserial3-wiring.guard: OK (${n})`);
