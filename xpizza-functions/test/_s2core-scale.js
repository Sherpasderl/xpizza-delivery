'use strict';
// S2-core (PLAN-structure-S2core-r3 §4, T16) — a restaurant AT THE CAPS: 300 sellable dishes, 20 extras groups × 30 extras = 600, built
// from today's source. The extras and groups go in through the REAL Extras-page writer (exposure-transitions) and the REAL allocator
// (extras-allocate); the extra dishes are copies of today's plain dishes under new keys (dishes are not what S2-core authors).
const { buildSourceFromCode } = require('../tools/seed-source-store');
const XT = require('../catalog/exposure-transitions');
const { allocateExtras } = require('../catalog/extras-allocate');

const allocate = (s) => allocateExtras({ incoming: s, activeExtras: s.extras.filter((e) => typeof e.key === 'string'), activeItems: s.items, keyMode: s.key_mode, switchOn: true }).source;

function scaledSource(rid, { dishes = 300, groups = 20, perGroup = 30 } = {}) {
  let s = buildSourceFromCode(rid);
  const plain = s.items.filter((i) => i.display.variantOf == null && !s.items.some((o) => String(o.display.variantOf) === String(i.display.id)));
  for (let i = 0; s.items.length < dishes; i++) {
    const b = JSON.parse(JSON.stringify(plain[i % plain.length]));
    delete b.display.identity_id;
    if (s.key_mode === 'id') { b.key = `${b.key}_c${i}`; b.display.id = b.key; } else { b.display.name = `${b.display.name} C${i}`; b.key = b.display.name; b.display.id = 1000 + i; }
    s.items.push(b); s.structure.item_order.push(b.key);
  }
  for (const G of s.structure.extra_categories.slice()) {
    for (let n = s.extras.filter((e) => e.display.cat === G).length; n < perGroup; n++) {
      s = XT.apply(s, { op: 'extra.add', group: G, ref: `tmp:fill-${s.structure.extra_categories.indexOf(G)}-${n}-xx`, name: `${G.replace(/[^A-Za-zÀ-ÿ ]/g, '')} Extra ${n}`, price: 10 + n }).source;
    }
  }
  s = allocate(s);
  const cats = Object.keys(s.structure.exposure.category_allow);
  for (let g = s.structure.extra_categories.length; g < groups; g++) {
    const G = `Grupo ${g}`;
    s = allocate(XT.apply(s, { op: 'group.create', group: G, extras: Array.from({ length: perGroup }, (_, n) => ({ ref: `tmp:grp${g}-ex${n}-xx`, name: `${G} Extra ${n}`, price: 10 + n })), attach: { mode: 'cat', cat: cats[g % cats.length] } }).source);
  }
  return s;
}

module.exports = { scaledSource, allocate };
