'use strict';
// S1c D4 (PLAN-portal-item-edit r6 §2.3; D4c-grill/item-s1/S1c-DESIGN.md + the owner addenda 2026-11-09) — OPAQUE MINTING.
// ONE platform switch, flipped ONCE (MINT_OPAQUE, a constant; OFF until S1d + S3 + the La Musa POS evidence). ON: a NEW product
// gets `i_` + 12 random [a-z2-7] as its pricing key — never derived from its name — and the server records it as a frozen key
// (display.id → key), so validation, the build and pricing accept it with no new rule. Its display.id is allocated exactly as
// today. A minted key never equals an active, saved, same-batch, extra, frozen or reserved key; three collisions in a row is a
// retryable 503. An addition named like a retired key is a NEW product with a fresh key (owner). If the switch is ever set back
// to OFF, minted products keep working. Run: node catalog/mint-opaque.test.js
const assert = require('assert');
const MO = require('./mint-opaque');
const AP = require('./add-product');
const { validateSource, canonicalize } = require('./source-store');
const { buildSourceCandidate } = require('./candidate-validate');
const { buildSourceFromCode } = require('../tools/seed-source-store');
const RK = require('./reserved-keys');

let n = 0; const ok = (m) => { n += 1; console.log(`  ✓ ${m}`); };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── the switch and the token ──
{
  assert.strictEqual(MO.mintCapabilities().enabled, false, '🔴 MO-OFF the platform ships with minting OFF (one-time flip after S1d + S3 + the La Musa POS evidence)');
  const seen = new Set();
  for (let i = 0; i < 2000; i++) { const k = MO.mintKey(); assert.match(k, /^i_[a-z2-7]{12}$/, 'MO-SYNTAX'); assert.ok(RK.OPAQUE_SYNTAX.test(k)); seen.add(k); }
  assert.strictEqual(seen.size, 2000, 'MO-RANDOM 2000 draws, no repeat');
  assert.strictEqual(MO.mintKey(() => Buffer.alloc(8, 0)), 'i_aaaaaaaaaaaa', 'MO-BITS all-zero bytes map to the first symbol');
  assert.strictEqual(MO.mintKey(() => Buffer.alloc(8, 0xff)), 'i_777777777777', 'MO-BITS all-one bytes map to the last symbol');
  ok('OFF by default; i_ + 12 symbols of [a-z2-7] from 60 random bits');
}

const addTo = (src, ref, name, cat) => { const s = clone(src); s.items.push({ ref, price: 150, display: { name, cat, desc: '' } }); s.structure.item_order.push(ref); return s; };
const seq = (...keys) => { let i = 0; return () => keys[Math.min(i++, keys.length - 1)]; };

// ── name-keyed (x_pizza): a fresh key, the id as today, the frozen entry recorded; the build and validation accept it ──
{
  const RID = 'x_pizza';
  const base = canonicalize(buildSourceFromCode(RID));
  const cat = base.items[0].display.cat;
  const incoming = addTo(base, 'tmp:mint0001', 'Pizza Nueva', cat);
  const off = AP.allocateAdditions({ incoming, stored: base, activeItems: base.items, keyMode: 'name', hwm: null, registryHasKey: () => false });
  const onRes = AP.allocateAdditions({ incoming, stored: base, activeItems: base.items, keyMode: 'name', hwm: null, registryHasKey: () => false, mint: { newKey: seq('i_aaaaaaaaaaab'), reserved: new Set() } });
  const a = onRes.source.items.find((i) => i.display.name === 'Pizza Nueva');
  const b = off.source.items.find((i) => i.display.name === 'Pizza Nueva');
  assert.strictEqual(b.key, 'Pizza Nueva', 'premise: OFF keys by name (today)');
  assert.strictEqual(a.key, 'i_aaaaaaaaaaab', 'MO-NAME ON: the key is minted, not the name');
  assert.strictEqual(a.display.id, b.display.id, 'MO-ID the display id is allocated exactly as today');
  assert.deepStrictEqual(onRes.source.frozen_keys, { [String(a.display.id)]: a.key }, 'MO-FROZEN the server records (display.id → minted key)');
  assert.strictEqual(off.source.frozen_keys, undefined, 'MO-OFF-IDENTICAL OFF records nothing');
  assert.deepStrictEqual(onRes.allocatedNow, [a.key]);
  assert.doesNotThrow(() => validateSource(onRes.source, RID), 'MO-VALID the minted product validates (frozen entry)');
  const built = buildSourceCandidate(RID, onRes.source).built;
  assert.ok(built.items.some((i) => i.key === a.key), 'MO-BUILD the build keys it by the minted key');
  ok('name-keyed: ON mints the key, keeps today\'s id, records the entry; it validates and builds');
}

// ── id-keyed (la_musa): the id stays the slug; the key is minted ──
{
  const RID = 'la_musa';
  const base = canonicalize(buildSourceFromCode(RID));
  const cat = base.items[0].display.cat;
  const incoming = addTo(base, 'tmp:mint0002', 'Bao Nuevo', cat);
  const r = AP.allocateAdditions({ incoming, stored: base, activeItems: base.items, keyMode: 'id', hwm: null, registryHasKey: () => false, mint: { newKey: seq('i_aaaaaaaaaaac'), reserved: new Set() } });
  const a = r.source.items.find((i) => i.display.name === 'Bao Nuevo');
  assert.deepStrictEqual([a.key, a.display.id], ['i_aaaaaaaaaaac', 'bao_nuevo'], 'MO-IDMODE the id is the slug as today; the key is minted');
  assert.deepStrictEqual(r.source.frozen_keys, { bao_nuevo: 'i_aaaaaaaaaaac' });
  assert.doesNotThrow(() => validateSource(r.source, RID), 'MO-IDMODE validates');
  ok('id-keyed: the id stays the slug; the key is minted and recorded');
}

// ── collisions: every source is avoided; three in a row is a retryable 503 ──
{
  const RID = 'x_pizza';
  const base = canonicalize(buildSourceFromCode(RID));
  const cat = base.items[0].display.cat;
  const liveKey = base.items[0].key; const extraKey = base.extras[0].key;
  const stored = { ...base, frozen_keys: { 9999: 'i_frozenfrozen' } };
  const two = addTo(addTo(stored, 'tmp:mint0003', 'Pizza Uno', cat), 'tmp:mint0004', 'Pizza Dos', cat);
  const r = AP.allocateAdditions({ incoming: two, stored, activeItems: base.items, keyMode: 'name', hwm: null, registryHasKey: () => false,
    mint: { newKey: seq(liveKey, extraKey, 'i_frozenfrozen', 'i_reservedkey2', 'i_bbbbbbbbbbbb', 'i_bbbbbbbbbbbb', 'i_cccccccccccc'), reserved: new Set(['i_reservedkey2']) } });
  const keys = ['Pizza Uno', 'Pizza Dos'].map((nm) => r.source.items.find((i) => i.display.name === nm).key);
  assert.deepStrictEqual(keys, ['i_bbbbbbbbbbbb', 'i_cccccccccccc'], `MO-COLLIDE active, extra, frozen, reserved and same-batch keys are redrawn (${keys})`);
  let err = null;
  try { AP.allocateAdditions({ incoming: addTo(stored, 'tmp:mint0005', 'Pizza Tres', cat), stored, activeItems: base.items, keyMode: 'name', hwm: null, registryHasKey: () => false, mint: { newKey: () => liveKey, reserved: new Set() } }); } catch (e) { err = e; }
  assert.ok(err && err.code === 'mint_unavailable' && err.status === 503, 'MO-503 three collisions in a row: a retryable 503, never a reused key');
  ok('a minted key avoids active, extra, frozen, reserved and same-batch keys; three collisions → 503 mint_unavailable');
}

// ── owner: an addition named like a retired / reserved key is a NEW product under a fresh key ──
{
  const RID = 'x_pizza';
  const base = canonicalize(buildSourceFromCode(RID));
  const cat = base.items[0].display.cat;
  const stored = { ...base, frozen_keys: { 9999: 'Pizza Retirada' } };
  const incoming = addTo(stored, 'tmp:mint0006', 'Pizza Retirada', cat);
  assert.throws(() => AP.allocateAdditions({ incoming, stored, activeItems: base.items, keyMode: 'name', hwm: null, registryHasKey: () => false }), /name_previously_used/, 'premise: OFF refuses it (today)');
  const r = AP.allocateAdditions({ incoming, stored, activeItems: base.items, keyMode: 'name', hwm: null, registryHasKey: (k) => k === 'Pizza Retirada', mint: { newKey: seq('i_dddddddddddd'), reserved: new Set(['Pizza Retirada']) } });
  const a = r.source.items.find((i) => i.display.name === 'Pizza Retirada');
  assert.strictEqual(a.key, 'i_dddddddddddd', 'MO-READD ON: the retired name is a new product with a fresh key, never the old identity');
  const caps = AP.textCapProblems({ draft: r.source, live: base, mint: true });
  assert.ok(!caps.some((c) => c.code === 'name_previously_used'), 'MO-READD-CAPS with minting on, the text caps do not refuse an addition by a retired name');
  assert.ok(AP.textCapProblems({ draft: r.source, live: base }).some((c) => c.code === 'name_previously_used'), 'premise: without minting the caps still refuse it (today)');
  ok('owner: with minting on, a retired name is re-added as a NEW product under a fresh key');
}

// ── the one emergency property: switched back OFF, a minted product keeps working ──
{
  const RID = 'x_pizza';
  const base = canonicalize(buildSourceFromCode(RID));
  const r = AP.allocateAdditions({ incoming: addTo(base, 'tmp:mint0007', 'Pizza Minted', base.items[0].display.cat), stored: base, activeItems: base.items, keyMode: 'name', hwm: null, registryHasKey: () => false, mint: { newKey: seq('i_eeeeeeeeeeee'), reserved: new Set() } });
  // nothing below takes the switch: validation, the build, and a later allocation with minting OFF
  assert.doesNotThrow(() => validateSource(r.source, RID), 'MO-EMERGENCY validates with minting OFF');
  assert.ok(buildSourceCandidate(RID, r.source).built.items.some((i) => i.key === 'i_eeeeeeeeeeee'), 'MO-EMERGENCY builds with minting OFF');
  const later = AP.allocateAdditions({ incoming: addTo(r.source, 'tmp:mint0008', 'Pizza Later', base.items[0].display.cat), stored: r.source, activeItems: base.items, keyMode: 'name', hwm: null, registryHasKey: () => false });
  assert.ok(later.source.items.some((i) => i.key === 'i_eeeeeeeeeeee'), 'MO-EMERGENCY a later OFF save keeps the minted product');
  ok('switched back OFF, a minted product still validates, builds and survives later saves');
}

console.log(`\nmint-opaque: OK (${n})`);
