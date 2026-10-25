// Customer app S1a1 (PLAN-capp-S1.FINAL §3.3–§3.4) — the serializer's items_text through the REAL reader code of every surface
// that shows or parses it, extracted from the shipped sources at this commit (no re-implementation):
//   KDS renderItems + escapeHtml (xpizza-kitchen/index.html) · rail-count.js · handheld model.js orderView · dispatch-mobile
//   renderOrderItems + escapeHtml · dispatch (both sites: the '|'-else-',' split) · driver (both sites: the ',' split) ·
//   order-dedup canonicalItemsText / legacyOrderOf / clientTextOf (the server's content-key parsers).
// Expected per reader: one row per configuration group with its quantity and its «A + B» extras intact (driver: ONE row, as for
// every pipe-delimited order today — never fragmented); a reward suffix is its own row.
// Run: node --test customer-app/capp-readers.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const { adaptMenu } = require('./capp-menu.js');
const { createCart } = require('./capp-cart.js');
const { serialize, ITEMS_TEXT_LIMIT } = require('./capp-serialize.js');
const { canonicalItemsText, legacyOrderOf, clientTextOf } = require(join(ROOT, 'xpizza-functions/order-dedup.js'));
const { railSplit, enumerateItems } = await import(pathToFileURL(join(ROOT, 'xpizza-kitchen/rail-count.js')).href);
const { orderView } = await import(pathToFileURL(join(ROOT, 'xpizza-handheld/model.js')).href);
const { provisionBrand } = await import(join(ROOT, 'xpizza-functions/contract/capp/capture.mjs'));

// a top-level `function name(...) {...}` from a shipped page, by brace matching (template literals in these bodies are balanced)
function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `premise: ${name} exists in the shipped source`);
  let depth = 0; let j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  return src.slice(i, j + 1);
}
const kdsSrc = read('xpizza-kitchen/index.html');
const kdsRender = new Function(`${extractFn(kdsSrc, 'escapeHtml')}\n${extractFn(kdsSrc, 'renderItems')}\nreturn renderItems;`)();
const dmSrc = read('xpizza-dispatch-mobile/index.html');
const dmRender = new Function(`${extractFn(dmSrc, 'escapeHtml')}\n${extractFn(dmSrc, 'renderOrderItems')}\nreturn renderOrderItems;`)();
// dispatch + driver split their text INLINE: take the exact shipped split expressions (count-pinned) and run them
const DISPATCH_SPLIT = "raw.split(raw.includes('|') ? '|' : ',').map(s => s.trim()).filter(Boolean)";
const DRIVER_SPLIT = "order.items_text.split(',').map(s =>";
assert.equal(read('xpizza-dispatch/index.html').split(DISPATCH_SPLIT).length - 1, 2, 'premise: dispatch splits at its two sites exactly so');
assert.equal(read('xpizza-driver/index.html').split(DRIVER_SPLIT).length - 1, 2, 'premise: the driver splits at its two sites exactly so');
const dispatchRows = new Function('raw', `return ${DISPATCH_SPLIT};`);
const driverRows = (t) => t.split(',').map((s) => s.trim());
const textOf = (html) => html.replace(/<[^>]+>/g, '|').split('|').map((s) => s.trim()).filter(Boolean);

const quiet = async (fn) => { const w = console.warn, l = console.log; console.warn = console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const PROV = { x_pizza: await quiet(() => provisionBrand('x_pizza')), la_musa: await quiet(() => provisionBrand('la_musa')) };
const MENU = { x_pizza: adaptMenu(PROV.x_pizza.envelope), la_musa: adaptMenu(PROV.la_musa.envelope) };
const menuNames = (rid) => MENU[rid].dishes.map((d) => d.name);

// the reader cases: multiple extras, one dish in two configurations, a plain dish, a reward suffix (the server's own append)
function cases(rid) {
  const m = MENU[rid]; const d = m.dishes.find((x) => !x.launcher && m.extrasFor(x.key).length >= 2); const [e1, e2] = m.extrasFor(d.key);
  const p = m.dishes.find((x) => !x.launcher && x.key !== d.key);
  const c = createCart(m); c.add(d.key, [e1.key, e2.key], 2); c.add(d.key, [e1.key], 1); c.inc(p.key);
  const s = serialize(c, m);
  const ext2 = [e1, e2].sort((a, b) => (a.key < b.key ? -1 : 1)).map((e) => e.name).join(' + ');
  const groups = [{ qty: 2, name: d.name, mod: ext2 }, { qty: 1, name: d.name, mod: e1.name }, { qty: 1, name: p.name, mod: '' }];
  return { s, groups, reward: ` | 1x ${p.name} (Recompensa)` };
}

for (const rid of ['x_pizza', 'la_musa']) {
  test(`${rid}: KDS / rail / handheld / dispatch-mobile — one row per configuration group, quantity + «A + B» intact`, () => {
    const { s, groups, reward } = cases(rid);
    for (const [text, expect] of [[s.items_text, groups], [s.items_text + reward, [...groups, { qty: 1, name: `${groups[2].name} (Recompensa)`, mod: '' }]]]) {
      const rail = enumerateItems(text);
      assert.deepEqual(rail.map((r) => [r.qty, r.name]), expect.map((g) => [g.qty, g.name.replace(/ \(Recompensa\)$/, ' (Recompensa)')]), 'rail-count');
      assert.equal(railSplit(text).length, expect.length);
      const hv = orderView({ id: 'o1', items_text: text }).items;
      assert.deepEqual(hv.map((i) => [i.q, i.name, i.mod]), expect.map((g) => [`${g.qty}×`, g.name, g.mod]), 'handheld');
      for (const [label, html] of [['KDS', kdsRender(text)], ['dispatch-mobile', dmRender({ items_text: text })]]) {
        const rows = html.split(/<div class="(?:card-item|dl-item)"/).slice(1);
        assert.equal(rows.length, expect.length, `${label}: one row per group`);
        expect.forEach((g, i) => {
          const t = textOf(rows[i]).join(' ');
          assert.ok(t.includes(g.name) && t.includes(String(g.qty)), `${label} row ${i}: ${t}`);
          if (g.mod) assert.ok(t.includes(g.mod.replace(/&/g, '&amp;')), `${label} row ${i} keeps its extras intact: ${t}`);
        });
      }
    }
  });

  test(`${rid}: dispatch — one row per group (+ the reward row); driver — ONE row, never fragmented`, () => {
    const { s, groups, reward } = cases(rid);
    const rows = groups.map((g) => `${g.qty}x ${g.name} (L${MENU[rid].dishes.find((d) => d.name === g.name).price})${g.mod ? ` [${g.mod}]` : ''}`);
    assert.deepEqual(dispatchRows(s.items_text), rows);
    assert.deepEqual(dispatchRows(s.items_text + reward), [...rows, reward.replace(/^ \| /, '')]);
    assert.deepEqual(driverRows(s.items_text), [s.items_text], 'driver: one row (no comma anywhere), as for every pipe-delimited order today');
    assert.deepEqual(driverRows(s.items_text + reward), [s.items_text + reward]);
  });

  test(`${rid}: the server's content-key parsers — sorted top-level lines, the legacy order resolvable, the reward suffix stripped`, () => {
    const { s, reward } = cases(rid);
    const canon = canonicalItemsText(s.items_text);
    assert.deepEqual(canon.split(' | ').sort(), s.items_text.split(' | ').sort(), 'canonical = the same groups, sorted');
    assert.notEqual(legacyOrderOf(s.items_text, menuNames(rid)), null, 'every group resolves to a catalog dish (the legacy content order)');
    assert.equal(clientTextOf(s.items_text + reward, reward), s.items_text);
    // reordered configurations of the same cart → the same canonical text (the retap key)
    const m = MENU[rid]; const d = m.dishes.find((x) => !x.launcher && m.extrasFor(x.key).length >= 2); const [e1, e2] = m.extrasFor(d.key);
    const p = m.dishes.find((x) => !x.launcher && x.key !== d.key);
    const c = createCart(m); c.inc(p.key); c.add(d.key, [e1.key], 1); c.add(d.key, [e2.key, e1.key], 2);
    assert.equal(canonicalItemsText(serialize(c, m).items_text), canon);
  });
}

test('a cart at the 1,500-character limit reads through every reader (no truncation is ever produced)', () => {
  const env = JSON.parse(JSON.stringify(PROV.x_pizza.envelope));
  const m0 = adaptMenu(env); const d = m0.dishes.find((x) => !x.launcher);
  const base = `1x ${d.name} (L${d.price})`;
  env.menu.dishes.find((x) => String(x.id) === String(d.id)).name = 'N'.repeat(ITEMS_TEXT_LIMIT - base.length + d.name.length);
  const m = adaptMenu(env); const c = createCart(m); c.inc(d.key);
  const t = serialize(c, m).items_text;
  assert.equal(t.length, ITEMS_TEXT_LIMIT);
  assert.equal(enumerateItems(t).length, 1); assert.equal(orderView({ id: 'o', items_text: t }).items.length, 1);
  assert.equal(dispatchRows(t).length, 1); assert.equal(driverRows(t).length, 1);
  assert.equal(kdsRender(t).split('<div class="card-item"').length - 1, 1);
});
