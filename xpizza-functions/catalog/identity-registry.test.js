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
const { memFirestore, fullRegistry, partialRegistry, availabilityStub } = require('./identity-fixture');
const { backfillIdentities, liveKeys } = require('./identity-backfill');
const { catalogSnapshot } = require('./generate-form-bundle');

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

    /* …and the enumeration dedupes. It used to ALSO drop unkeyable records, and this assertion said
       so approvingly — a test that had written the defect down as the specification. Dropping them is
       under-registration with the alarm removed: the survivors register, the report looks healthy, and
       the skipped objects serve id-less forever. Two objects that key the same really are one
       identity, so the dedupe stays; a record that keys to nothing is a fault, below. */
    const keys = liveKeys('x_pizza', {
      items: [xDish, { id: 3, name: 'Carnivora' }],
      extras: [{ id: 'e1', name: 'Salsa Roja' }, { id: 'e2', name: 'Salsa Roja' }],
    });
    assert.deepStrictEqual(keys.dish, ['Carnivora'], 'duplicates collapse to one identity');
    assert.deepStrictEqual(keys.extra, ['Salsa Roja'], '…for extras too');
    ok('the backfill keys through the pricing resolver — by NAME on x_pizza, by ID on la_musa, both kinds');
  }

  // ── 9. 🔴 THE FIXTURE ITSELF IS AS STRICT AS FIRESTORE ───────────────────────────────────────
  /* Three times in this build a stub turned out to be LAXER than the thing it stood in for — a
     registry that ignored kind, an RTDB stub offering .get() where the gate calls .once('value') so
     the gate failed open, and this transaction stub permitting a read after a write. Each one made a
     passing test prove nothing, which is worse than a missing test because it reads as coverage.
     So the fixture's own constraints are now asserted. A fake that silently permits what production
     forbids is not a fake of production, and the only way that stays true is if someone checks. */
  {
    const db = memFirestore();
    let threw = null;
    try {
      await db.runTransaction(async (tx) => {
        const ref = db.collection('restaurants').doc('x').collection('identity').doc('dish');
        tx.set(ref, { a: 1 });
        await tx.get(ref);                    // ← Firestore refuses this; so must the stub
      });
    } catch (e) { threw = (e && e.message) || String(e); }
    assert.ok(threw && /read_after_write/.test(threw),
      `🔴 the fixture must refuse a read after a write, as Firestore does — otherwise "every read first" is unenforced (got ${threw})`);

    // …and the ordinary shape — all reads, then all writes — still works, so the rule is not a blanket ban.
    const okOut = await db.runTransaction(async (tx) => {
      const ref = db.collection('restaurants').doc('x').collection('identity').doc('dish');
      const snap = await tx.get(ref);
      tx.set(ref, { seen: snap.exists });
      return 'committed';
    });
    assert.strictEqual(okOut, 'committed', 'non-vacuity: reads-then-writes is still permitted');
    ok('the transaction fixture enforces Firestore\'s read-before-write rule, and only that');
  }

  // ── THE BACKFILL, DRIVEN BY THE REAL CATALOG READER ───────────────────────────────────────────
  /* 🔴 THIS IS THE TEST THAT WAS MISSING, AND ITS ABSENCE MADE D1 A NO-OP. Every earlier backfill test
     built its own menu out of cart-shaped records — { name } / { id } — because that is the shape I
     pictured the function receiving. The real reader emits { key, price, display }. Fed that, every
     key resolved to null, nothing registered, and backfillIdentities returned a report full of zeros
     with no error: 24 dishes in, 0 out, "success". The fixtures agreed with the code because they were
     written from the same wrong picture of the producer.
     So this one takes its input from catalogSnapshot — the actual reader, the actual live catalog —
     and asserts NONZERO. A test that can only fail when the real producer's shape is handled. */
  {
    const brands = ['x_pizza', 'la_musa'];
    for (const rid of brands) {
      const menu = catalogSnapshot(rid);

      // Non-vacuity, and a standing description of the shape that broke this: these really are reader
      // records, not cart records. If the reader ever starts emitting top-level name/id, this stops
      // being the regression test it claims to be and says so rather than passing for a new reason.
      const sample = menu.items[0];
      assert.ok(sample && typeof sample.key === 'string' && sample.key,
        `${rid}: the reader record carries its legacy key at .key`);
      assert.strictEqual(sample.name, undefined,
        `🔴 ${rid}: the reader record has NO top-level name — this is exactly why itemPricingKey returned undefined`);
      assert.strictEqual(sample.id, undefined,
        `🔴 ${rid}: …and no top-level id either`);

      const expectDish = menu.items.length;
      const expectExtra = menu.extras.length;
      assert.ok(expectDish > 0 && expectExtra > 0, `${rid}: the live catalog is non-empty to begin with`);

      const db = memFirestore();
      const first = await backfillIdentities(db, rid, menu);

      // NONZERO — and not merely nonzero: every live record, so a half-read regression fails too.
      assert.strictEqual(first.dish.total, expectDish,
        `🔴 ${rid}: every live dish is registered (was 0 of ${expectDish} before the shape fix)`);
      assert.strictEqual(first.extra.total, expectExtra,
        `🔴 ${rid}: every live extra is registered (was 0 of ${expectExtra})`);
      assert.strictEqual(first.dish.created, expectDish, `${rid}: a first run mints every dish`);
      assert.strictEqual(first.extra.created, expectExtra, `${rid}: a first run mints every extra`);
      assert.strictEqual(first.dish.preserved, 0, `${rid}: nothing pre-existed`);

      // The ids are keyed by the SAME legacy key pricing would resolve, per brand.
      const keys = liveKeys(rid, menu);
      assert.deepStrictEqual(Object.keys(first.ids.dish).sort(), [...keys.dish].sort(),
        `${rid}: registered under the pricing legacy keys, not some parallel key space`);
      if (rid === 'la_musa') {
        for (const k of keys.dish) assert.strictEqual(first.ids.dish[k], k,
          '🔴 la_musa grandfathers its slug as its canonical id');
      } else {
        for (const k of keys.dish) {
          assert.ok(new RegExp(`^[${ALPHABET}]{${ID_LEN}}$`).test(first.ids.dish[k]),
            'x_pizza mints an opaque token for every dish');
          assert.ok(!first.ids.dish[k].includes(k), '…not derived from the name');
        }
      }

      // PRESERVATION ON RE-RUN — same store, same reader, second pass mints nothing.
      const second = await backfillIdentities(db, rid, menu);
      assert.strictEqual(second.dish.created, 0, `🔴 ${rid}: a re-run mints no dish`);
      assert.strictEqual(second.extra.created, 0, `🔴 ${rid}: a re-run mints no extra`);
      assert.strictEqual(second.dish.preserved, expectDish, `${rid}: it preserves every dish instead`);
      assert.strictEqual(second.extra.preserved, expectExtra, `${rid}: and every extra`);
      assert.deepStrictEqual(second.ids, first.ids,
        `🔴 ${rid}: identical ids across runs — a backfill that re-mints hands one object two identities`);

      ok(`${rid}: the REAL reader backfills ${expectDish} dishes + ${expectExtra} extras, and a re-run preserves all of them`);
    }
  }

  // ── A WHOLESALE MISS IS A FAULT, NOT AN EMPTY CATALOG ─────────────────────────────────────────
  /* The silent zero is what let the bug live. Records in, no key out, cheerful report. Now it throws,
     because "0 registered, no error" and "there was nothing to register" must not look the same. */
  {
    const db = memFirestore();
    const unreadable = { items: [{ sku: 'X1' }, { sku: 'X2' }], extras: [{ sku: 'E1' }] };
    await assert.rejects(
      () => backfillIdentities(db, 'x_pizza', unreadable),
      /identity_backfill_unkeyable/,
      '🔴 an input this cannot key is reported as a fault — the exact failure that previously returned a report of zeros',
    );
    // Non-vacuity: a genuinely empty catalog is NOT a fault, so the guard is about shape, not emptiness.
    const empty = await backfillIdentities(db, 'x_pizza', { items: [], extras: [] });
    assert.strictEqual(empty.dish.total, 0, 'an empty catalog still reports zero without throwing');
    ok('an unkeyable input throws where an empty one reports zero');
  }

  // ── THE FAKES REFUSE WHAT PRODUCTION REFUSES ──────────────────────────────────────────────────
  /* 🔴 A FAKE IS ONLY EVIDENCE WHERE IT IS AS STRICT AS THE THING IT STANDS IN FOR. Three of these
     were laxer: rid-blind, collection-name-blind, event-blind. Nothing failed — that is the point;
     each simply stopped checking a constraint while the suite went on reporting green. So the fakes
     now get their own tests, named, and each one asserts BOTH halves: the wrong shape is refused, and
     the right shape still resolves (otherwise a fake that refused everything would pass this too). */
  {
    const reg = fullRegistry('x_pizza');
    const keyOf = (k) => Buffer.from(k, 'utf8').toString('base64url');
    const at = (r, { top = 'restaurants', rid = 'x_pizza', mid = 'identity', kind = 'dish', leaf = 'keys', doc = keyOf('Carnivora') }) =>
      r.collection(top).doc(rid).collection(mid).doc(kind).collection(leaf).doc(doc).get();

    // The right path resolves — the non-vacuity half.
    const hit = await at(reg, {});
    assert.strictEqual(hit.exists, true, 'non-vacuity: the REAL lookup path still resolves');
    assert.strictEqual(hit.data().canonical_id, 'ID_dish_Carnivora', '…to the id it was asked for');

    const refusals = {
      'another restaurant': { rid: 'la_musa' },
      "a top collection that isn't 'restaurants'": { top: 'shops' },
      "a second collection that isn't 'identity'": { mid: 'catalog' },
      "the 'ids' reverse index read as if it were 'keys'": { leaf: 'ids' },
      'a kind outside dish|extra': { kind: 'combo' },
      'a raw, unencoded legacy key as the document id': { doc: 'Carnivora' },
    };
    for (const [what, over] of Object.entries(refusals)) {
      let threw = null;
      try { await at(reg, over); } catch (e) { threw = (e && e.message) || String(e); }
      assert.ok(threw && /registry_stub_refused/.test(threw),
        `🔴 the registry fake must refuse ${what} — Firestore answers nothing there, so a fake that answers hides the bug (got ${threw})`);
    }
    ok(`the registry fake refuses ${Object.keys(refusals).length} departures from the real path, and resolves the real one`);
  }
  {
    // partialRegistry: KIND-AWARE on the same string, and rid-scoped like its full sibling.
    const reg = partialRegistry({ dish: ['Salsa Roja'], extra: [] }, 'x_pizza');
    const doc = Buffer.from('Salsa Roja', 'utf8').toString('base64url');
    const look = (kind) => reg.collection('restaurants').doc('x_pizza').collection('identity').doc(kind).collection('keys').doc(doc).get();
    assert.strictEqual((await look('dish')).exists, true, 'the resolvable dish key resolves');
    assert.strictEqual((await look('extra')).exists, false,
      '🔴 …and the SAME string as an extra does not — the two kinds are separate collections');
    assert.throws(
      () => reg.collection('restaurants').doc('la_musa'),
      /registry_stub_refused/, 'the partial fake is rid-scoped too — refused as soon as the wrong restaurant is addressed');
    ok('the partial registry fake is kind-aware and rid-scoped — one string, two kinds, two answers');
  }
  {
    // The 86 stub: right path + right event only.
    const node = { some_key: { available: false } };
    const db = availabilityStub('x_pizza', node, assert);
    const got = await db.ref('restaurants/x_pizza/item_availability').once('value');
    assert.deepStrictEqual(got.val(), node, 'non-vacuity: the real read returns the node');
    assert.throws(() => db.ref('restaurants/la_musa/item_availability'),
      /item_availability/, "🔴 it refuses the other brand's node — a cross-brand 86 bug must not read as a pass");
    await assert.rejects(() => db.ref('restaurants/x_pizza/item_availability').once('child_added'),
      /'value'/, "🔴 …and refuses the wrong event — the gate calls .once('value')");
    ok('the 86 fake answers only this brand\'s node, and only the value event');
  }

  // ── A RETIRED SLUG IS NOT "PRESERVED" ─────────────────────────────────────────────────────────
  /* 🔴 THE RESERVATION MUST HOLD ON THE GRANDFATHERED PATH TOO. la_musa's id IS its slug, so a
     re-created object asks for the very id its predecessor retired. Retirement deletes the key row, so
     the request walks straight into the slug-collision branch — which used to compare legacy keys,
     find them equal, and hand the retired id back as { created: false }: a permanently-reserved id
     re-issued, reported as an ordinary idempotent re-run. */
  {
    const db = memFirestore();
    const first = await ensureIdentity(db, { rid: 'la_musa', kind: 'dish', legacyKey: 'dimsum_01' });
    assert.strictEqual(first.canonical_id, 'dimsum_01', 'premise — la_musa grandfathers the slug');
    const gone = await retireIdentity(db, { rid: 'la_musa', kind: 'dish', canonicalId: 'dimsum_01' });
    assert.strictEqual(gone.retired, true, 'premise — it really was retired');

    let out = null, threw = null;
    try { out = await ensureIdentity(db, { rid: 'la_musa', kind: 'dish', legacyKey: 'dimsum_01' }); }
    catch (e) { threw = (e && e.message) || String(e); }
    assert.strictEqual(out, null,
      `🔴 a retired slug must NOT come back as a preserved identity (got ${JSON.stringify(out)})`);
    assert.ok(threw && /identity_slug_retired/.test(threw),
      `🔴 …it is refused, by name, so the reservation is visible rather than silently spent (got ${threw})`);

    // Non-vacuity: a DIFFERENT, unretired slug on the same brand still registers normally, so the
    // refusal is about retirement and not about the grandfathered path being broken.
    const other = await ensureIdentity(db, { rid: 'la_musa', kind: 'dish', legacyKey: 'dimsum_02' });
    assert.strictEqual(other.canonical_id, 'dimsum_02', 'non-vacuity: an unretired slug still grandfathers');
    assert.strictEqual(other.created, true, '…and really is a fresh assignment');
    ok('a retired grandfathered slug is refused by name, not re-issued as a preserved id');
  }

  // ── ONE UNKEYABLE RECORD IS A FAULT, NOT A SKIP ───────────────────────────────────────────────
  /* 🔴 THE PARTIAL MISS IS THE HAZARD THAT OUTLIVES THE SHAPE BUG. The wholesale guard caught the
     failure that made this module a no-op — every record unkeyable — but a future record shape that
     breaks only SOME records would have slipped straight past it: the rest register, the report reads
     as success, and the unregistered objects serve id-less with nothing to indicate it. Same defect,
     quieter. So the guard is per-record, and these are the cases that distinguish the two. */
  {
    const db = memFirestore();
    const good = { key: 'Carnivora', price: 340, display: { id: 2, name: 'Carnivora', price: 340 } };

    // A MIXED batch — the case the wholesale guard could not see, since most records key fine.
    let threw = null;
    try {
      liveKeys('x_pizza', { items: [good, good, { sku: 'X9', price: 100 }], extras: [] });
    } catch (e) { threw = (e && e.message) || String(e); }
    assert.ok(threw && /identity_backfill_unkeyable/.test(threw),
      `🔴 one unkeyable record among keyable ones must fail the backfill, not be skipped (got ${threw})`);
    assert.ok(/dish\[2\]/.test(threw),
      `🔴 …and it must name WHICH record, or a third record shape is a hunt rather than a diagnosis (got ${threw})`);
    assert.ok(/sku,price/.test(threw),
      `…reporting the fields it actually found, which is what identifies the new shape (got ${threw})`);

    // The same rule on extras, and indexed independently of the dishes.
    let extraThrew = null;
    try {
      liveKeys('x_pizza', { items: [good], extras: [{ name: 'Salsa Roja' }, { sku: 'E9' }] });
    } catch (e) { extraThrew = (e && e.message) || String(e); }
    assert.ok(extraThrew && /extra\[1\]/.test(extraThrew),
      `🔴 an unkeyable EXTRA is the same fault, named by its own index (got ${extraThrew})`);

    // …and it reaches the caller through backfillIdentities, which is where an operator meets it.
    await assert.rejects(
      () => backfillIdentities(db, 'x_pizza', { items: [good, { sku: 'X9' }], extras: [] }),
      /identity_backfill_unkeyable/,
      '🔴 the backfill refuses a partially unkeyable catalog rather than registering the part it understood');

    /* NON-VACUITY, three ways — otherwise a guard that threw on everything would pass all of the
       above. A wholly keyable catalog still backfills, an empty one still reports zero, and the real
       reader is still accepted. */
    const okReport = await backfillIdentities(db, 'x_pizza', { items: [good], extras: [] });
    assert.strictEqual(okReport.dish.total, 1, 'non-vacuity: a keyable record still registers');
    const empty = await backfillIdentities(db, 'x_pizza', { items: [], extras: [] });
    assert.strictEqual(empty.dish.total, 0, 'non-vacuity: an empty catalog still reports zero without throwing');
    const real = liveKeys('la_musa', catalogSnapshot('la_musa'));
    assert.strictEqual(real.dish.length, 44, 'non-vacuity: the REAL reader passes the per-record guard on every record');
    ok('one unkeyable record fails the backfill by name and index — a partial miss is not a silent skip');
  }

  console.log(`\nidentity-registry: ${n} checks passed`);
})().catch((e) => { console.error('identity-registry FAILED:', e && e.message); process.exit(1); });
