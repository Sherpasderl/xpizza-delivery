'use strict';
// S3 (D4c-grill/item-s1/S3-DESIGN.md D3; the owner's rule-40 exception for the two order forms, 11-08) — THE FORMS' S3 HUNKS, as data.
// unapplyItemS3Forms(key, text) removes exactly these hunks — key 'xpizza-orders' | 'la-musa-orders' (a form's index.html) or
// 'form-serial-order' (the shared pin module, both byte-identical copies) — and returns the bytes it had before S3, so a
// guard that pins a form byte-for-byte to an older base (avail-identity-forms-noop) keeps pinning EVERYTHING outside S3. Each hunk must
// occur EXACTLY once (an insertion with the newline before it) — a missing, duplicated or edited hunk throws, so a later edit to an
// S3 line is caught here, and a byte outside every hunk still fails the caller's pin. Generated from the slice's own diff; never hand-edit
// a hunk without its line in the form.
const HUNKS = {
 "xpizza-orders": [
  {
   "kind": "insert",
   "new": "/* S3 (D4c-grill/item-s1/S3-DESIGN.md D1/D3): the served { \"<dish id>\": item_key } map — the LIVE menu's only (the baked body never\n   carries it), applied with MENU all-or-nothing; a body without one empties it. liveItemKey: a dish's key, or null (no map ⇒ today's\n   lines). itemKeyFor: a pinned order's key AS FIRST SENT (form-serial-order.js), else the live map's. */\nlet ITEM_KEYS = {};\nfunction liveItemKey(p){ const k = p && ITEM_KEYS[String(p.id)]; return typeof k === 'string' && k ? k : null; }\nfunction itemKeyFor(p, lineKey){ const pinned = SERIAL.itemKey(lineKey, serialPinLive()); return pinned !== undefined ? pinned : liveItemKey(p); }",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "const LIVE_MENU_GLOBALS = ['MENU', 'EXTRAS', 'PICKUP_ONLY_CATS', 'WEEKEND_ONLY_CATS', 'VARIANT_ITEMS', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM', 'ITEM_KEYS'];   // PLAN 4 §8.4: + the option maps",
   "old": "const LIVE_MENU_GLOBALS = ['MENU', 'EXTRAS', 'PICKUP_ONLY_CATS', 'WEEKEND_ONLY_CATS', 'VARIANT_ITEMS', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM'];   // PLAN 4 §8.4: + the option maps"
  },
  {
   "kind": "replace",
   "new": "    : n === 'EXTRAS_BY_CATEGORY' ? EXTRAS_BY_CATEGORY : n === 'EXTRAS_BY_ITEM' ? EXTRAS_BY_ITEM : n === 'ITEM_KEYS' ? ITEM_KEYS : WEEKEND_ONLY_CATS;",
   "old": "    : n === 'EXTRAS_BY_CATEGORY' ? EXTRAS_BY_CATEGORY : n === 'EXTRAS_BY_ITEM' ? EXTRAS_BY_ITEM : WEEKEND_ONLY_CATS;"
  },
  {
   "kind": "insert",
   "new": "  else if (n === 'ITEM_KEYS') ITEM_KEYS = v;",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    // S3: the served item-key map — ABSENT EMPTIES it (never «keep in force»: an older snapshot's keys must never label a newer MENU)\n    ITEM_KEYS: isMap(body.item_keys) ? body.item_keys : {},",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "  const ik = liveItemKey(item); if (ik) { const k = window.availKey(ik); if (seen.indexOf(k) === -1) seen.push(k); }   // S3: the portal / KDS write the item_key",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "  return GroupPicker.rewardDishes(MENU, VARIANT_ITEMS, p=>p.cat==='individual').map(p=>({ key:liveItemKey(p)||p.name, name:p.name, price_cents:Math.round(p.price*100), icon:p.reward_icon||'star' }));   // PLAN 4 GATED: the published reward_icon (the name-keyed literal map is gone)",
   "old": "  return GroupPicker.rewardDishes(MENU, VARIANT_ITEMS, p=>p.cat==='individual').map(p=>({ key:p.name, name:p.name, price_cents:Math.round(p.price*100), icon:p.reward_icon||'star' }));   // PLAN 4 GATED: the published reward_icon (the name-keyed literal map is gone)"
  },
  {
   "kind": "insert",
   "new": "    const ik = itemKeyFor(p, line.key); if(ik) out.item_key = ik;   // S3 D1: appended LAST; a pinned order resends its first key (or none)",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "  const id = genOrderId(); SERIAL.mint(resolvedCartLines(), (l) => liveItemKey(l.record)); window.__pendingOrder = { id, sig }; return id;   // §3: pin this order's serialization",
   "old": "  const id = genOrderId(); SERIAL.mint(resolvedCartLines()); window.__pendingOrder = { id, sig }; return id;   // §3: pin this order's serialization"
  }
 ],
 "la-musa-orders": [
  {
   "kind": "insert",
   "new": "/* S3 (D4c-grill/item-s1/S3-DESIGN.md D1/D3): the served { \"<dish id>\": item_key } map — the LIVE menu's only (the baked body never\n   carries it), applied with MENU all-or-nothing; a body without one empties it. liveItemKey: a dish's key, or null (no map ⇒ today's\n   lines). itemKeyFor: a pinned order's key AS FIRST SENT (form-serial-order.js), else the live map's. */\nlet ITEM_KEYS = {};\nfunction liveItemKey(p){ const k = p && ITEM_KEYS[String(p.id)]; return typeof k === 'string' && k ? k : null; }\nfunction itemKeyFor(p, lineKey){ const pinned = SERIAL.itemKey(lineKey, serialPinLive()); return pinned !== undefined ? pinned : liveItemKey(p); }",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "const LIVE_MENU_GLOBALS = ['MENU', 'EXTRAS', 'CATEGORIES', 'VARIANT_ITEMS', 'HAS_PHOTO', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM', 'TAG_BADGES', 'BADGE_PRIORITY', 'ITEM_KEYS'];   // PLAN 4 §8.4: + the badges and their order",
   "old": "const LIVE_MENU_GLOBALS = ['MENU', 'EXTRAS', 'CATEGORIES', 'VARIANT_ITEMS', 'HAS_PHOTO', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM', 'TAG_BADGES', 'BADGE_PRIORITY'];   // PLAN 4 §8.4: + the badges and their order"
  },
  {
   "kind": "insert",
   "new": "    case 'ITEM_KEYS': return ITEM_KEYS;",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    case 'ITEM_KEYS': ITEM_KEYS = v; break;",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    // S3: the served item-key map — ABSENT EMPTIES it (never «keep in force»: an older snapshot's keys must never label a newer MENU)\n    ITEM_KEYS: (body.item_keys && typeof body.item_keys === 'object' && !Array.isArray(body.item_keys)) ? body.item_keys : {},",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "  const ik = liveItemKey(item); if (ik) { const k = window.availKey(ik); if (seen.indexOf(k) === -1) seen.push(k); }   // S3: the portal / KDS write the item_key",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "  GroupPicker.rewardDishes(MENU, VARIANT_ITEMS, p => String(p.id).indexOf('beer_')!==0 && !!CAT[p.cat]).forEach(p=>{ const c=CAT[p.cat]; out.push({ key:liveItemKey(p)||p.id, name:p.name, price_cents:Math.round(p.price*100), section:c, icon:p.reward_icon||'star' }); });   // PLAN 4 GATED: the published reward_icon (CAT keeps only the section)",
   "old": "  GroupPicker.rewardDishes(MENU, VARIANT_ITEMS, p => String(p.id).indexOf('beer_')!==0 && !!CAT[p.cat]).forEach(p=>{ const c=CAT[p.cat]; out.push({ key:p.id, name:p.name, price_cents:Math.round(p.price*100), section:c, icon:p.reward_icon||'star' }); });   // PLAN 4 GATED: the published reward_icon (CAT keeps only the section)"
  },
  {
   "kind": "insert",
   "new": "    const ik = itemKeyFor(p, line.key);   // S3 D1: appended LAST; the id stays only when it IS the key (a minted dish sends item_key alone)\n    if (ik) { if (String(p.id) !== ik) delete out.id; out.item_key = ik; }",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "  const id = genOrderId(); SERIAL.mint(resolvedCartLines(), (l) => liveItemKey(l.record)); window.__pendingOrder = { id, sig }; return id;   // §3: pin this order's serialization",
   "old": "  const id = genOrderId(); SERIAL.mint(resolvedCartLines()); window.__pendingOrder = { id, sig }; return id;   // §3: pin this order's serialization"
  }
 ],
 "form-serial-order": [
  {
   "kind": "insert",
   "new": "//   • S3 (D4c-grill/item-s1/S3-DESIGN.md, advisor Q3 ruling): beside its order, the pin keeps each pinned line's `item_key` AS FIRST\n//     SENT — the map's value at the mint, or exactly what the stashed item carried on a resume (present, or absent → null) — so a\n//     retried or resumed order resends its first body byte-identically whatever the live map says now.",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "  let iks = null;   // S3: line key → the item_key that line was first sent with (null = none); null = nothing recorded",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "  function mint(lines, itemKeyOf) {\n    const list = Array.isArray(lines) ? lines : [];\n    pin = list.map((l) => String(l.key));\n    iks = typeof itemKeyOf === \"function\" ? new Map(list.map((l) => [String(l.key), itemKeyOf(l) || null])) : null;\n  }",
   "old": "  function mint(lines) { pin = (Array.isArray(lines) ? lines : []).map((l) => String(l.key)); }"
  },
  {
   "kind": "insert",
   "new": "    const sent = new Map();",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "      if (hit) {\n        used.add(String(hit.key)); keys.push(String(hit.key));\n        sent.set(String(hit.key), Object.prototype.hasOwnProperty.call(it, \"item_key\") && typeof it.item_key === \"string\" && it.item_key ? it.item_key : null);\n      }",
   "old": "      if (hit) { used.add(String(hit.key)); keys.push(String(hit.key)); }"
  },
  {
   "kind": "insert",
   "new": "    iks = sent;",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "  function clear() { pin = null; iks = null; }",
   "old": "  function clear() { pin = null; }"
  },
  {
   "kind": "replace",
   "new": "  // S3: the item_key a pinned line was first sent with — a string, or null (sent without one); undefined when the pin does not\n  // hold that line or is not live (the caller then reads the live map)\n  function itemKey(key, live = true) { return pin && live && iks && iks.has(String(key)) ? iks.get(String(key)) : undefined; }\n  return { order, mint, resume, clear, current, itemKey };",
   "old": "  return { order, mint, resume, clear, current };"
  }
 ]
};

function unapplyItemS3Forms(dir, text) {
  const hunks = HUNKS[dir];
  if (!hunks) throw new Error(`item-s3-forms-inverse: no S3 hunks for ${dir}`);
  let out = String(text);
  for (const h of hunks) {
    const find = h.kind === 'insert' ? '\n' + h.new : h.new;
    const at = out.indexOf(find);
    if (at === -1) throw new Error(`item-s3-forms-inverse: an S3 hunk is missing from ${dir} (${h.new.slice(0, 60)})`);
    if (out.indexOf(find, at + 1) !== -1) throw new Error(`item-s3-forms-inverse: an S3 hunk occurs more than once in ${dir} (${h.new.slice(0, 60)})`);
    out = out.slice(0, at) + (h.kind === 'insert' ? '' : h.old) + out.slice(at + find.length);
  }
  return out;
}

module.exports = { unapplyItemS3Forms, HUNKS };
