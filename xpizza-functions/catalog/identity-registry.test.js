'use strict';
/**
 * Portal 1D · D1 — the registry's own guarantees. Run: `node catalog/identity-registry.test.js`
 *
 * 🔴 WHAT NEEDS PROVING HERE, and why a fixture is enough for it. The registry's claims are about
 * CONCURRENCY and PERMANENCE — one id per object under simultaneous seeds, a retired id never handed
 * out again, a swap detected rather than adopted. Those are properties of the transaction shape, not
 * of Firestore, so they are provable against a store that models the one behaviour that matters: a
 * transaction that observed a document which then changed must re-run. The emulator test covers the
 * real driver; this covers the reasoning, and it covers it on every run rather than when Java is
 * installed.
 */
const assert = require('assert');
const { ensureIdentity, lookupByLegacyKeys, retireIdentity, validateClaim, encodeKey, ALPHABET, ID_LEN } = require('./identity-registry');
const { memFirestore } = require('./identity-fixture');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  // ── 1. ONE OBJECT, ONE ID — including on a re-run ─────────────────────────────────────────────
  {
    const db = memFirestore();
    const a = await ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Carnivora' });
    const b = await ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Carnivora' });
    assert.strictEqual(a.created, true, 'the first assignment mints');
    assert.strictEqual(b.created, false, '🔴 the second preserves — a backfill that re-mints hands one object two identities');
    assert.strictEqual(a.canonical_id, b.canonical_id);
    assert.ok(new RegExp(`^[${ALPHABET}]{${ID_LEN}}$`).test(a.canonical_id), 'x_pizza mints an opaque token');
    assert.ok(!a.canonical_id.includes('Carnivora'), '🔴 …that is not derived from the name');
    ok('one object gets one id, and a re-run preserves it');
  }

  // ── 2. 🔴 CONCURRENT FIRST-ASSIGNMENT YIELDS EXACTLY ONE ID ───────────────────────────────────
  // The reason first-assignment transacts on the KEY row: two seeds reserving two random id rows
  // would not contend at all, and both would "succeed" with different ids for the same dish.
  {
    const db = memFirestore();
    let retries = 0; db._onRetry = () => { retries += 1; };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Margherita' })),
    );
    const ids = new Set(results.map((r) => r.canonical_id));
    assert.strictEqual(ids.size, 1, `🔴 six concurrent seeds produced ${ids.size} ids — one object must have one identity`);
    assert.strictEqual(results.filter((r) => r.created).length, 1, 'exactly one of them did the minting');
    assert.ok(retries > 0, 'non-vacuity: the contention was real — transactions actually retried');
    ok(`concurrent first-assignment yields ONE id (${retries} genuine retries)`);
  }

  // ── 3. GRANDFATHERED vs MINTED, per the rule ──────────────────────────────────────────────────
  {
    const db = memFirestore();
    for (const [rid, kind, key, expectSame] of [
      ['la_musa', 'dish', 'dimsum_01', true],
      ['la_musa', 'extra', 'rice_white', true],
      ['x_pizza', 'dish', 'Carnivora', false],
      ['x_pizza', 'extra', 'Salsa Roja', false],
    ]) {
      const r = await ensureIdentity(db, { rid, kind, legacyKey: key });
      if (expectSame) assert.strictEqual(r.canonical_id, key, `${rid}/${kind}: an already-stable slug is grandfathered, not re-minted`);
      else assert.notStrictEqual(r.canonical_id, key, `${rid}/${kind}: 🔴 a DISPLAY NAME must never become the id`);
    }
    ok('a stable slug is grandfathered; a display name mints a fresh token');
  }

  // ── 4. 🔴 THE TWO NAMESPACES ARE SEPARATE ─────────────────────────────────────────────────────
  // "extra = distinct type" is a namespace guarantee: the same string may be a dish id and an extra
  // id. If the kinds shared a space, grandfathering la_musa would make them collide constantly.
  {
    const db = memFirestore();
    const d = await ensureIdentity(db, { rid: 'la_musa', kind: 'dish', legacyKey: 'shared_slug' });
    const e = await ensureIdentity(db, { rid: 'la_musa', kind: 'extra', legacyKey: 'shared_slug' });
    assert.strictEqual(d.canonical_id, 'shared_slug');
    assert.strictEqual(e.canonical_id, 'shared_slug');
    assert.strictEqual(d.created && e.created, true, '🔴 both minted independently — the kinds do not collide');
    const dishMap = await lookupByLegacyKeys(db, { rid: 'la_musa', kind: 'dish', legacyKeys: ['shared_slug'] });
    const extraMap = await lookupByLegacyKeys(db, { rid: 'la_musa', kind: 'extra', legacyKeys: ['shared_slug'] });
    assert.strictEqual(dishMap.get('shared_slug'), 'shared_slug');
    assert.strictEqual(extraMap.get('shared_slug'), 'shared_slug');
    ok('dish and extra ids live in separate namespaces — the same string can be both');
  }

  // ── 5. 🔴 A RETIRED ID IS RESERVED FOREVER ────────────────────────────────────────────────────
  // A freed id handed to a new object makes old records — an order snapshot, a factura line — resolve
  // to a dish nobody meant. Unrepairable after the fact, so it is never freed.
  {
    const db = memFirestore();
    const first = await ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Temporal' });
    const r = await retireIdentity(db, { rid: 'x_pizza', kind: 'dish', canonicalId: first.canonical_id });
    assert.strictEqual(r.retired, true);
    const gone = await lookupByLegacyKeys(db, { rid: 'x_pizza', kind: 'dish', legacyKeys: ['Temporal'] });
    assert.strictEqual(gone.size, 0, 'the key no longer resolves — the object is retired');
    const idDoc = db._docs.get(`restaurants/x_pizza/identity/dish/ids/${first.canonical_id}`);
    assert.ok(idDoc, '🔴 the ID ROW MUST REMAIN — a deleted row is a freed id, and a freed id is alias reuse');
    assert.strictEqual(idDoc.status, 'retired', '🔴 …reserved rather than live');
    // …and a new object with the same name gets a DIFFERENT id.
    const again = await ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Temporal' });
    assert.notStrictEqual(again.canonical_id, first.canonical_id,
      '🔴 a re-created object must not inherit the retired id — that is alias reuse');
    ok('a retired id stays reserved; a re-created object gets a new one');
  }

  // ── 6. 🔴 A SUBMITTED ID IS CHECKED, NEVER ADOPTED — INCLUDING A SWAP ─────────────────────────
  {
    const db = memFirestore();
    const a = await ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Uno' });
    const b = await ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Dos' });
    assert.deepStrictEqual(await validateClaim(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Uno', claimedId: a.canonical_id }),
      { ok: true, actual: a.canonical_id }, 'the honest claim passes');
    /* THE SWAP: two VALID ids exchanged between two REAL objects. Every field-level check passes —
       both ids exist, both are this merchant's, both are this kind — and only asking the registry what
       the key maps to catches it. */
    const swapped = await validateClaim(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Uno', claimedId: b.canonical_id });
    assert.strictEqual(swapped.ok, false, '🔴 a SWAP of two valid ids must be detected');
    assert.strictEqual(swapped.reason, 'swapped');
    assert.strictEqual(swapped.actual, a.canonical_id, '…and the registry says what it should have been');
    const foreign = await validateClaim(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Nunca', claimedId: a.canonical_id });
    assert.strictEqual(foreign.reason, 'unregistered_key', 'an id claimed for an unregistered key is refused');
    ok('a claimed id is validated against the registry — a swap of two valid ids is detected');
  }

  // ── 7. KEYS THAT WOULD BREAK A DOCUMENT PATH ─────────────────────────────────────────────────
  // x_pizza keys are merchant-typed display names, so they contain whatever a merchant types.
  {
    const db = memFirestore();
    for (const key of ['Pizza / Media', 'Café con leche.', 'Ñoquis #1', 'a'.repeat(120)]) {
      const r = await ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: key });
      const back = await lookupByLegacyKeys(db, { rid: 'x_pizza', kind: 'dish', legacyKeys: [key] });
      assert.strictEqual(back.get(key), r.canonical_id, `${JSON.stringify(key)} round-trips`);
      assert.ok(!encodeKey(key).includes('/'), '🔴 …and never puts a slash in the document path');
    }
    // …and two keys that a sanitiser would collapse stay distinct.
    const a = await ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Salsa Roja' });
    const b = await ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Salsa/Roja' });
    assert.notStrictEqual(a.canonical_id, b.canonical_id,
      '🔴 keys that a sanitiser would collapse must stay two identities');
    ok('merchant-typed keys round-trip encoded — slashes, dots, accents, length, and near-collisions');
  }

  // ── 8. 🔴 THE BACKFILL KEYS THROUGH THE PRICING RESOLVER ─────────────────────────────────────
  /* The registry is only correct if it is keyed the way the MONEY path keys. x_pizza resolves a line
     by name and la_musa by id — and a backfill that got that backwards would register every object
     under a key nothing ever looks up: the overlay would then resolve nothing, on both brands, and
     look exactly like "the backfill has not run yet".
     Asserted against the real resolver rather than against literals, so if the rule ever moves this
     fails instead of silently disagreeing with pricing. */
  {
    const { liveKeys, dishKey, extraKey } = require('./identity-backfill');
    const { itemPricingKey } = require('../menu-pricing');

    // A record carrying BOTH an id and a name, so getting the brand backwards is visible.
    const xDish = { id: 2, name: 'Carnivora' };
    const lDish = { id: 'dimsum_01', name: 'Sichuan Spicy Wonton' };
    assert.strictEqual(dishKey('x_pizza', xDish), 'Carnivora', '🔴 x_pizza keys a dish by NAME');
    assert.strictEqual(dishKey('la_musa', lDish), 'dimsum_01', '🔴 la_musa keys a dish by ID');
    assert.strictEqual(dishKey('x_pizza', xDish), itemPricingKey(xDish, 'x_pizza'), '…the same answer the money path gives');
    assert.strictEqual(dishKey('la_musa', lDish), itemPricingKey(lDish, 'la_musa'), '…on both brands');

    // Extras key the way their brand's dishes do — checked in menu-pricing's own extras branches.
    assert.strictEqual(extraKey('x_pizza', { id: 'e1', name: 'Salsa Roja' }), 'Salsa Roja', '🔴 x_pizza keys an extra by NAME, not its UI handle e1');
    assert.strictEqual(extraKey('la_musa', { id: 'rice_white', name: 'Arroz Blanco' }), 'rice_white', '🔴 la_musa keys an extra by ID');

    // …and the enumeration dedupes and drops unkeyable records rather than registering junk.
    const keys = liveKeys('x_pizza', {
      items: [xDish, { id: 3, name: 'Carnivora' }, { id: 4 }],
      extras: [{ id: 'e1', name: 'Salsa Roja' }, { id: 'e2' }],
    });
    assert.deepStrictEqual(keys.dish, ['Carnivora'], 'duplicates collapse to one identity; an unkeyable record is skipped');
    assert.deepStrictEqual(keys.extra, ['Salsa Roja']);
    ok('the backfill keys through the pricing resolver — by NAME on x_pizza, by ID on la_musa, both kinds');
  }

  console.log(`\nidentity-registry: ${n} checks passed`);
})().catch((e) => { console.error('identity-registry FAILED:', e && e.message); process.exit(1); });
