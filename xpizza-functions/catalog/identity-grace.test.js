'use strict';
/**
 * Portal 1D · D4-grace — the forward resolver, the money no-op, and the registry self-heal.
 * Run: `node catalog/identity-grace.test.js`
 *
 * 🔴 THE ONE CLAIM THIS STAGE MAKES: it changes nothing a customer pays. Everything else it does —
 * resolving forward, bounding the fan-out, capping staleness, adopting orphans — is in service of
 * proving the machinery *enforce* will later depend on, while a mistake in it is still free. So the
 * money assertions here are byte-equality against the same order with no identity at all, and the rest
 * are about the distinctions that only matter later: read_error vs unresolved, adopt vs mint.
 */
const assert = require('assert');
const { applyGraceResolution, resolveGraceKeys, reportForwardCoverage, rawLegacyKey } = require('./identity-grace');
const { resolveLegacyByIds, resolveAcrossKinds, validIdShape, _resetResolveCache, ensureIdentity, retireIdentity,
  RESOLVE_CACHE_TTL_MS, RESOLVE_MAX_LOOKUPS } = require('./identity-registry');
const { sweepIdentityIntegrity } = require('./identity-sweep');
const { memFirestore } = require('./identity-fixture');
const { itemPricingKey, PRICING_KEY_STAMP, computeServerTotal, MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT } = require('../menu-pricing');
const { computeServerNet } = require('../compute-server-net');
const { pricedLineItems } = require('../factura/pricing');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-grace: FAILED — exited without completing'); process.exitCode = 1; } });

const tablesOf = (rid) => ({ restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] });
const keysCol = (db, rid, kind) => db.collection('restaurants').doc(rid).collection('identity').doc(kind).collection('keys');
const idsCol = (db, rid, kind) => db.collection('restaurants').doc(rid).collection('identity').doc(kind).collection('ids');
const enc = (k) => Buffer.from(String(k), 'utf8').toString('base64url');

/* A cart in the shape D2 emits, for each brand, with the legacy fields the server prices by. */
const CART = {
  x_pizza: () => [{ name: 'Carnivora', qty: 2, price: 340, subtotal: 680, extrasTotal: 39,
    extras: [{ instance: 0, name: 'Salsa Roja', price: 39 }] }],
  la_musa: () => [{ id: 'dimsum_01', name: 'Sichuan Spicy Wonton', cat: 'dim_sum', qty: 2, price: 223, subtotal: 496,
    extrasTotal: 50, extras: [{ id: 'rice_white', name: 'Arroz Blanco', price: 50, qty: 1 }] }],
};

async function seedRegistry(db, rid) {
  const cart = CART[rid]();
  const dishKey = rawLegacyKey(rid, cart[0]);
  const extraKey = rawLegacyKey(rid, cart[0].extras[0]);
  const d = await ensureIdentity(db, { rid, kind: 'dish', legacyKey: dishKey });
  const e = await ensureIdentity(db, { rid, kind: 'extra', legacyKey: extraKey });
  return { dishKey, extraKey, dishId: d.canonical_id, extraId: e.canonical_id };
}
const withIds = (rid, ids) => {
  const c = CART[rid]();
  c[0].dish_id = ids.dishId;
  c[0].extras[0].extra_id = ids.extraId;
  return c;
};

(async () => {
  _resetResolveCache();

  for (const rid of ['x_pizza', 'la_musa']) {
    // ── 1. 🔴 THE MONEY NO-OP ─────────────────────────────────────────────────────────────────
    /* The whole licence for this stage. An id-bearing order under grace must price byte-identically
       to the same order with no identity at all — total, 1C net, and the fiscal lines where they
       apply. Not "close", not "the same number": the same objects. */
    {
      const db = memFirestore();
      const ids = await seedRegistry(db, rid);
      const graced = withIds(rid, ids);
      const legacy = CART[rid]();

      const g = await applyGraceResolution(db, rid, graced, { stamp: PRICING_KEY_STAMP });
      assert.strictEqual(g.coverage.agree, 2, `${rid}: premise — both lines resolved AND agreed (${JSON.stringify(g.coverage)})`);
      assert.ok(graced[0][PRICING_KEY_STAMP], `${rid}: premise — the dish line really was stamped`);

      assert.deepStrictEqual(computeServerTotal(graced, rid, tablesOf(rid)), computeServerTotal(legacy, rid, tablesOf(rid)),
        `🔴 ${rid}: grace moved the CHARGED TOTAL`);
      assert.deepStrictEqual(computeServerNet({ items: graced, reward: null, rid, tables: tablesOf(rid) }),
        computeServerNet({ items: legacy, reward: null, rid, tables: tablesOf(rid) }),
        `🔴 ${rid}: grace moved the 1C NET`);
      if (rid === 'x_pizza') {
        assert.deepStrictEqual(pricedLineItems(graced, tablesOf(rid).menu, tablesOf(rid).extras),
          pricedLineItems(legacy, tablesOf(rid).menu, tablesOf(rid).extras), `🔴 ${rid}: grace moved the FISCAL LINES`);
      }
      // SENSITIVITY: the pricing these compare through is not a constant.
      const dearer = JSON.parse(JSON.stringify(legacy)); dearer[0].qty += 1;
      assert.notStrictEqual(computeServerTotal(dearer, rid, tablesOf(rid)).total, computeServerTotal(legacy, rid, tablesOf(rid)).total,
        `${rid}: non-vacuity — the total responds to a real change`);
      ok(`${rid}: an id-bearing order under grace prices byte-identically to an id-less one`);
    }

    // ── 2. 🔴 A DISAGREEMENT NEVER REPRICES ───────────────────────────────────────────────────
    /* The case grace exists to survive: the id resolves cleanly but to a DIFFERENT object — D3's swap
       shape, or a stale id after a rename. The line must be priced by its own legacy key, which is
       what the customer was shown, and the id's object must not get a look in. */
    {
      const db = memFirestore();
      const ids = await seedRegistry(db, rid);
      const otherKey = rid === 'la_musa' ? 'dimsum_02' : 'Hawaiana';
      const other = await ensureIdentity(db, { rid, kind: 'dish', legacyKey: otherKey });

      const cart = withIds(rid, ids);
      cart[0].dish_id = other.canonical_id;                 // this line now claims ANOTHER dish's id
      const g = await applyGraceResolution(db, rid, cart, { stamp: PRICING_KEY_STAMP });

      assert.strictEqual(g.coverage.disagree, 1, `${rid}: the disagreement is counted`);
      assert.strictEqual(cart[0][PRICING_KEY_STAMP], undefined, '🔴 a disagreeing line must NOT be stamped');
      assert.strictEqual(itemPricingKey(cart[0], rid), rawLegacyKey(rid, CART[rid]()[0]),
        '🔴 …and it prices by its OWN legacy key, never the id\'s object');
      assert.deepStrictEqual(computeServerTotal(cart, rid, tablesOf(rid)), computeServerTotal(CART[rid](), rid, tablesOf(rid)),
        '🔴 a disagreement REPRICED the order');
      assert.strictEqual(g.disagreements[0].registry_key, otherKey, 'the log names what the registry actually said');
      ok(`${rid}: a line claiming another dish's id is priced by its own key and logged, never repriced`);
    }

    // ── 3. TRICHOTOMY — read_error IS NOT unresolved ──────────────────────────────────────────
    /* Invisible today and decisive later: under enforce, `unresolved` is grounds to refuse an order
       and `read_error` must never be, or one Firestore hiccup starts rejecting paid carts. */
    {
      const db = memFirestore();
      const ids = await seedRegistry(db, rid);
      const live = await resolveLegacyByIds(db, rid, 'dish', [ids.dishId]);
      assert.strictEqual(live.byId.get(ids.dishId).outcome, 'resolved', `${rid}: a live id resolves`);
      assert.strictEqual(live.byId.get(ids.dishId).legacyKey, ids.dishKey, `${rid}: …to its legacy key`);

      _resetResolveCache();
      await retireIdentity(db, { rid, kind: 'dish', canonicalId: ids.dishId });
      const dead = await resolveLegacyByIds(db, rid, 'dish', [ids.dishId]);
      assert.strictEqual(dead.byId.get(ids.dishId).outcome, 'unresolved', `${rid}: a RETIRED id is cleanly unresolved`);
      assert.strictEqual(dead.byId.get(ids.dishId).reason, 'retired', '…and says why');

      const absent = await resolveLegacyByIds(db, rid, 'dish', ['NEVERMINTED']);
      assert.strictEqual(absent.byId.get('NEVERMINTED').outcome, 'unresolved', 'an absent id is cleanly unresolved');

      /* Cache cleared first: the id above is now cached as `unresolved`, and a cache hit would be
         SERVED rather than reaching the broken handle — correct behaviour, and it would have made
         this cell assert nothing about failures. (That is how it first failed.) */
      _resetResolveCache();
      const broken = { collection: () => { throw new Error('firestore down'); } };
      const err = await resolveLegacyByIds(broken, rid, 'dish', [ids.dishId]);
      assert.strictEqual(err.byId.get(ids.dishId).outcome, 'read_error',
        '🔴 an operational failure is read_error — NEVER unresolved, which enforce would refuse on');
      assert.strictEqual(err.incomplete, true, '…and marks the coverage incomplete');

      _resetResolveCache();
      const invalid = await resolveLegacyByIds(db, rid, 'dish', ['a/b']);
      assert.strictEqual(invalid.byId.get('a/b').outcome, 'unresolved', 'a malformed id is unresolved');
      assert.strictEqual(invalid.byId.get('a/b').reason, 'invalid_id', '…without a read');
      ok(`${rid}: resolved / unresolved(retired, absent, invalid) / read_error are four distinct answers`);
    }
  }

  // ── 4. 🔴 THE CLIENT CANNOT SUPPLY THE KEY ──────────────────────────────────────────────────
  /* The security half of the money invariant. If a client could name the key its cart prices by, it
     would choose which catalog row to be charged from. The stamp is a SYMBOL: JSON has no
     representation for one, so a line parsed from a request body cannot carry it — forgery is
     impossible rather than filtered, which is the stronger guarantee and needs no ingress strip to be
     remembered on every error path. */
  {
    const forged = JSON.parse(JSON.stringify({
      name: 'Carnivora', qty: 1, price: 340, extras: [],
      _pricingKey: 'Hawaiana', pricingKey: 'Hawaiana', 'Symbol(xpizza.d4.pricingKeyStamp)': 'Hawaiana',
    }));
    assert.strictEqual(itemPricingKey(forged, 'x_pizza'), 'Carnivora',
      '🔴 a client-supplied key influenced pricing — the cart could choose what it is charged for');
    assert.deepStrictEqual(computeServerTotal([forged], 'x_pizza', tablesOf('x_pizza')),
      computeServerTotal([{ name: 'Carnivora', qty: 1, price: 340, extras: [] }], 'x_pizza', tablesOf('x_pizza')),
      '🔴 …and it did not move the charge either');
    // …and the real stamp, placed server-side, IS read — so the check above is not passing because
    // the stamp is simply ignored everywhere.
    const stamped = { name: 'Carnivora', qty: 1, price: 340, extras: [] };
    stamped[PRICING_KEY_STAMP] = 'Carnivora';
    assert.strictEqual(itemPricingKey(stamped, 'x_pizza'), 'Carnivora', 'non-vacuity: a server stamp is read');
    ok('a client cannot forge the pricing key — the stamp is a Symbol and has no wire form');
  }

  // ── 4b. 🔴 THE AGREEMENT CHECK READS CLIENT FIELDS, NOT THE STAMP ───────────────────────────
  /* It must compare the registry's answer against the RAW accessor over what the client sent — never
     through itemPricingKey, which PREFERS a stamp. Today those coincide, because the only stamp that
     exists is one already proven equal to the raw key, so an implementation that compared via
     itemPricingKey would behave identically and the mutant for it would be "equivalent".
     🔴 IT IS ONLY EQUIVALENT WHILE THAT HOLDS. The next stage in this programme (canonical re-key)
     stamps a key that DELIBERATELY differs from the legacy one — at which point comparing through the
     stamp means comparing the answer against itself, every line agrees, and the money invariant this
     whole stage rests on evaporates silently. So rather than bank it as equivalent, the property is
     staged directly: a line arrives ALREADY carrying a stamp that disagrees with its own fields, and
     the check must still notice the disagreement. */
  {
    const rid = 'x_pizza';
    const db = memFirestore();
    const ids = await seedRegistry(db, rid);
    _resetResolveCache();

    const cart = withIds(rid, ids);
    // A pre-existing stamp naming a DIFFERENT dish — what a later canonical stamp would look like to
    // a comparison that read it instead of the client's fields.
    cart[0][PRICING_KEY_STAMP] = 'Hawaiana';

    const g = await applyGraceResolution(db, rid, cart, { stamp: PRICING_KEY_STAMP });
    assert.strictEqual(g.coverage.agree, 2,
      '🔴 the agreement check read the STAMP rather than the client fields — against a stamp that says "Hawaiana" while the line says "Carnivora", the registry\'s "Carnivora" must still AGREE');
    assert.strictEqual(g.coverage.disagree, 0, '…and nothing disagreed');
    assert.strictEqual(itemPricingKey(cart[0], rid), 'Carnivora',
      'and the line is left priced by its own key');
    ok('the agreement check compares the registry against RAW client fields, not against a stamp');
  }

  // ── 5. 🔴 THE FRESHNESS BOUND IS ANCHORED AT THE READ'S START ───────────────────────────────
  /* The subtle one. Anchoring the cache entry at WRITE time does not bound staleness: a read can
     observe `live`, the retirement can commit while that read is still in flight, and the read can
     then land before its own deadline and cache `live` for another full TTL — total staleness
     TTL + latency, and worse the slower Firestore is. Anchoring at the instant the read STARTED caps
     it at the TTL however long the read took. This drives exactly that race. */
  {
    const rid = 'x_pizza';
    const db = memFirestore();
    const ids = await seedRegistry(db, rid);
    _resetResolveCache();

    let clock = 1_000_000;
    const now = () => clock;
    // A store whose read takes 5s of wall-clock — during which the retirement commits.
    const slow = {
      collection: (c) => ({
        doc: (d) => ({
          collection: (c2) => ({
            doc: (d2) => ({
              collection: (c3) => ({
                doc: (d3) => ({
                  get: async () => {
                    const snap = await db.collection(c).doc(d).collection(c2).doc(d2).collection(c3).doc(d3).get();
                    clock += 5000;                                   // the read took 5 seconds
                    await retireIdentity(db, { rid, kind: 'dish', canonicalId: ids.dishId });   // …and it was retired meanwhile
                    return snap;                                     // but THIS read observed `live`
                  },
                }),
              }),
            }),
          }),
        }),
      }),
    };
    const first = await resolveLegacyByIds(slow, rid, 'dish', [ids.dishId], { now });
    assert.strictEqual(first.byId.get(ids.dishId).outcome, 'resolved', 'premise — the in-flight read observed live');

    /* Now sit just inside the TTL measured from the READ'S START. A write-anchored cache would still
       be serving `live` here (its clock started 5s later); a read-start-anchored one has expired. */
    clock = 1_000_000 + RESOLVE_CACHE_TTL_MS - 1;
    const stillCached = await resolveLegacyByIds(db, rid, 'dish', [ids.dishId], { now });
    assert.strictEqual(stillCached.byId.get(ids.dishId).outcome, 'resolved', 'inside the TTL it is still served from cache');

    clock = 1_000_000 + RESOLVE_CACHE_TTL_MS + 1;
    const expired = await resolveLegacyByIds(db, rid, 'dish', [ids.dishId], { now });
    assert.strictEqual(expired.byId.get(ids.dishId).outcome, 'unresolved',
      `🔴 staleness exceeded ${RESOLVE_CACHE_TTL_MS}ms from READ-START — a write-anchored entry would have survived another ${RESOLVE_CACHE_TTL_MS}ms here`);
    assert.strictEqual(expired.byId.get(ids.dishId).reason, 'retired', '…and the fresh read sees the retirement');
    ok(`a live→retired flip is served stale for at most ${RESOLVE_CACHE_TTL_MS}ms from the READ's start, even with a 5s read`);
  }

  // ── 6. read_error IS NEVER CACHED ───────────────────────────────────────────────────────────
  /* Negative-caching a transient outage would pin a false "no id" for a full TTL — and under enforce
     that is a refusal, minutes after the outage ended. */
  {
    const rid = 'x_pizza';
    const db = memFirestore();
    const ids = await seedRegistry(db, rid);
    _resetResolveCache();
    const broken = { collection: () => { throw new Error('down'); } };
    const bad = await resolveLegacyByIds(broken, rid, 'dish', [ids.dishId]);
    assert.strictEqual(bad.byId.get(ids.dishId).outcome, 'read_error', 'premise — it failed');
    const good = await resolveLegacyByIds(db, rid, 'dish', [ids.dishId]);
    assert.strictEqual(good.byId.get(ids.dishId).outcome, 'resolved',
      '🔴 the read_error was CACHED — a transient outage would pin a false "no id" for a whole TTL');
    ok('a read_error is never cached: the next read answers from the registry');
  }

  // ── 7. 🔴 THE FAN-OUT BUDGET ────────────────────────────────────────────────────────────────
  /* Deduping and Promise.all bounds nothing — a cart with hundreds of distinct ids would issue
     hundreds of concurrent reads on the charge path. Beyond the cap the remainder degrades to grace
     and the coverage is marked INCOMPLETE, so a partially-resolved order is never counted as clean
     evidence for enforce. */
  {
    const rid = 'x_pizza';
    const db = memFirestore();
    _resetResolveCache();
    let reads = 0;
    const counting = {
      collection: (c) => {
        const wrap = (o) => ({
          doc: (d) => {
            const inner = o.doc(d);
            return { collection: (c2) => wrap(inner.collection(c2)), get: async () => { reads += 1; return inner.get(); } };
          },
        });
        return wrap(db.collection(c));
      },
    };
    const many = Array.from({ length: RESOLVE_MAX_LOOKUPS + 12 }, (_, i) => `IDX${String(i).padStart(6, '0')}`);
    const r = await resolveLegacyByIds(counting, rid, 'dish', many);
    assert.strictEqual(reads, RESOLVE_MAX_LOOKUPS,
      `🔴 the budget did not bound the reads — ${reads} issued for ${many.length} ids`);
    const overflow = many.slice(RESOLVE_MAX_LOOKUPS).map((id) => r.byId.get(id));
    assert.ok(overflow.every((o) => o.outcome === 'read_error'),
      '🔴 overflow must degrade to read_error → grace, not to unresolved (which enforce would refuse on)');
    assert.strictEqual(r.incomplete, true, '🔴 …and the coverage is marked INCOMPLETE');
    ok(`an order with ${many.length} distinct ids issues exactly ${RESOLVE_MAX_LOOKUPS} reads and reports INCOMPLETE`);
  }

  // ── 8. 🔴 SELF-HEAL, WRITER — ADOPT, NEVER MINT A DUPLICATE ─────────────────────────────────
  /* Two live ids for one dish is split identity: orders written either side of the mint disagree
     about what they were, permanently. x_pizza mints a random token, so nothing finds the orphan
     unless it is looked for. */
  {
    const rid = 'x_pizza';
    const db = memFirestore();
    const first = await ensureIdentity(db, { rid, kind: 'dish', legacyKey: 'Carnivora' });
    await keysCol(db, rid, 'dish').doc(enc('Carnivora'))._delete();          // the reverse row is lost
    const before = (await idsCol(db, rid, 'dish').get()).docs.length;

    const second = await ensureIdentity(db, { rid, kind: 'dish', legacyKey: 'Carnivora' });
    assert.strictEqual(second.canonical_id, first.canonical_id, '🔴 a SECOND id was minted for one dish — split identity');
    assert.strictEqual(second.adopted, true, 'and it reports the adoption');
    assert.strictEqual((await idsCol(db, rid, 'dish').get()).docs.length, before, 'the id row count is unchanged');
    assert.strictEqual((await keysCol(db, rid, 'dish').doc(enc('Carnivora')).get()).data().canonical_id, first.canonical_id,
      'the reverse row is restored to the EXISTING id');

    // Racing callers converge on one adoption rather than one adopting and one minting.
    const db2 = memFirestore();
    const orig = await ensureIdentity(db2, { rid, kind: 'dish', legacyKey: 'Hawaiana' });
    await keysCol(db2, rid, 'dish').doc(enc('Hawaiana'))._delete();
    const raced = await Promise.all([1, 2, 3].map(() => ensureIdentity(db2, { rid, kind: 'dish', legacyKey: 'Hawaiana' })));
    assert.strictEqual(new Set(raced.map((r) => r.canonical_id)).size, 1, '🔴 racing adoptions produced more than one id');
    assert.ok(raced.every((r) => r.canonical_id === orig.canonical_id), '…and it is the original');

    // A RETIRED id is never revived — the reservation is the whole point.
    const db3 = memFirestore();
    const r3 = await ensureIdentity(db3, { rid, kind: 'dish', legacyKey: 'Pepperoni' });
    await retireIdentity(db3, { rid, kind: 'dish', canonicalId: r3.canonical_id });
    const after3 = await ensureIdentity(db3, { rid, kind: 'dish', legacyKey: 'Pepperoni' });
    assert.notStrictEqual(after3.canonical_id, r3.canonical_id, '🔴 a RETIRED id was revived — it is reserved forever');

    // Two LIVE ids for one key is refused, not arbitrated.
    const db4 = memFirestore();
    const a = await ensureIdentity(db4, { rid, kind: 'dish', legacyKey: 'Vegetariana' });
    await idsCol(db4, rid, 'dish').doc('SECONDLIVE1')._set({ legacy_key: 'Vegetariana', status: 'live', kind: 'dish', created_at: 'x' });
    await keysCol(db4, rid, 'dish').doc(enc('Vegetariana'))._delete();
    await assert.rejects(() => ensureIdentity(db4, { rid, kind: 'dish', legacyKey: 'Vegetariana' }),
      /identity_conflicting_live_ids/, '🔴 two live ids for one key must be REFUSED, not silently arbitrated');
    assert.ok(a.canonical_id, 'premise — the original was real');
    ok('the writer adopts an orphan, races converge, a retired id is never revived, and a two-live conflict is refused');
  }

  // ── 9. SELF-HEAL, SWEEP — IDEMPOTENT AND NARROW ─────────────────────────────────────────────
  /* The durable half: an orphan whose object is served id-less generates no lookup and no write, so
     traffic-driven repair never visits it. */
  {
    const rid = 'la_musa';
    const db = memFirestore();
    const a = await ensureIdentity(db, { rid, kind: 'dish', legacyKey: 'dimsum_01' });
    await ensureIdentity(db, { rid, kind: 'dish', legacyKey: 'dimsum_02' });
    const healthy = (await keysCol(db, rid, 'dish').doc(enc('dimsum_02')).get()).data();
    await keysCol(db, rid, 'dish').doc(enc('dimsum_01'))._delete();

    const r1 = await sweepIdentityIntegrity(db, rid, 'dish');
    /* EXACTLY one — the message names both failure directions, because this number is wrong in two
       ways: zero means the orphan was missed, and two means the sweep rewrote a HEALTHY row as well
       and has stopped being narrow. */
    assert.strictEqual(r1.repaired, 1,
      `🔴 the sweep repaired ${r1.repaired} rows — exactly ONE orphan exists, so 0 means it was missed and >1 means it rewrote a healthy row too`);
    assert.strictEqual((await keysCol(db, rid, 'dish').doc(enc('dimsum_01')).get()).data().canonical_id, a.canonical_id,
      '…to the EXISTING id, not a new one');
    assert.deepStrictEqual((await keysCol(db, rid, 'dish').doc(enc('dimsum_02')).get()).data(), healthy,
      '🔴 a healthy row was rewritten — the sweep must be narrow');

    const r2 = await sweepIdentityIntegrity(db, rid, 'dish');
    assert.strictEqual(r2.repaired, 0, '🔴 the sweep is not idempotent — a re-run repaired again');
    assert.strictEqual(r2.scanned, r1.scanned, 'and it still scanned the same rows');
    ok('the sweep repairs an orphan to its existing id, leaves healthy rows alone, and re-runs as a no-op');
  }

  // ── 10. THE FORWARD COVERAGE HEARTBEAT IS HONEST ────────────────────────────────────────────
  /* Same reasoning as D3's: "zero disagreements" is not evidence. A resolver reading the wrong place,
     or one starved by the budget, reports zero too. What separates clean from broken is `resolved`
     beside `read_error`, and the INCOMPLETE flag. */
  {
    const logs = []; const origLog = console.log; const origWarn = console.warn; const warns = [];
    console.log = (...a) => { if (String(a[0]).startsWith('order_identity_forward')) logs.push(a); else origLog(...a); };
    console.warn = (...a) => { if (String(a[0]).startsWith('order_identity_forward')) warns.push(a); else origWarn(...a); };
    try {
      reportForwardCoverage('O1', 'x_pizza', { checked: 2, resolved: 2, agree: 2, disagree: 0, absent: 0, read_error: 0, unresolved: 0, incomplete: false }, []);
      reportForwardCoverage('O2', 'x_pizza', { checked: 2, resolved: 0, agree: 0, disagree: 0, absent: 0, read_error: 2, unresolved: 0, incomplete: true },
        []);
      reportForwardCoverage('O3', 'x_pizza', { checked: 1, resolved: 1, agree: 0, disagree: 1, absent: 0, read_error: 0, unresolved: 0, incomplete: false },
        [{ line: 0, kind: 'dish', id: 'A', raw_key: 'Carnivora', registry_key: 'Hawaiana' }]);
    } finally { console.log = origLog; console.warn = origWarn; }
    assert.strictEqual(logs.length, 3, 'one heartbeat per order');
    const clean = JSON.parse(logs[0][1]); const broken = JSON.parse(logs[1][1]);
    assert.strictEqual(clean.disagree, 0); assert.strictEqual(broken.disagree, 0);
    assert.notStrictEqual(clean.resolved, broken.resolved,
      '🔴 a clean order and a wholly-failed one must NOT look alike — both show zero disagreements');
    assert.strictEqual(broken.incomplete, true, 'and the failed one says it is incomplete');
    assert.strictEqual(warns.length, 1, 'a disagreement gets its own line');
    ok('the forward heartbeat distinguishes clean from broken — zero disagreements alone is not a signal');
  }

  // ── 11. THE GUARDED ENTRY CANNOT THROW INTO A HANDLER ───────────────────────────────────────
  {
    const boom = () => { throw new Error('getFirestore exploded'); };
    let threw = null; let out = null;
    try { out = await resolveGraceKeys(boom, 'x_pizza', CART.x_pizza(), { stamp: PRICING_KEY_STAMP }); } catch (e) { threw = e; }
    assert.strictEqual(threw, null, '🔴 a throwing handle getter escaped into the order handler');
    assert.strictEqual(out.coverage.incomplete, true, '…and it is recorded as incomplete rather than clean');
    const works = await resolveGraceKeys(() => memFirestore(), 'x_pizza', CART.x_pizza(), { stamp: PRICING_KEY_STAMP });
    assert.strictEqual(works.coverage.incomplete, false, 'non-vacuity: a working getter resolves normally');
    ok('a throwing handle getter degrades to grace and is marked incomplete, never thrown');
  }

  // ── 12. 🔴 ONE DEADLINE AND ONE BUDGET FOR THE ORDER — NOT ONE PER KIND ─────────────────────
  /* Both bounds were silently multiplied by the number of kinds, because grace called the resolver
     once per kind: a mixed cart got 800ms for its dishes and a FRESH 800ms for its extras, so the
     worst case it could add to a charge was ~1.6s rather than the 800ms the constant advertises; and
     it got 40 reads for dishes and another 40 for extras, so an 80-read order called itself COMPLETE.
     🔴 DRIVEN THROUGH applyGraceResolution, NOT THE RESOLVER. The defect lived in the CALL SITE — the
     resolver was always correctly bounded for the one call it was given. A cell that drove the
     resolver directly passed against the broken call site, which is how the first version of this
     test let the mutant live. */
  const mixedCart = (nDish, nExtra) => {
    const items = [];
    for (let i = 0; i < nDish; i += 1) {
      items.push({ name: `Dish ${i}`, qty: 1, price: 100, dish_id: `MDS${String(i).padStart(7, '0')}`, extras: [] });
    }
    for (let j = 0; j < nExtra; j += 1) {
      items[j % Math.max(1, items.length)].extras.push({ name: `Extra ${j}`, price: 10, extra_id: `MEX${String(j).padStart(7, '0')}` });
    }
    return items;
  };
  const countingFsOver = (db, onGet) => ({
    collection: (c) => {
      const wrap = (o) => ({
        doc: (d) => {
          const inner = o.doc(d);
          return { collection: (c2) => wrap(inner.collection(c2)), get: () => onGet(() => inner.get()) };
        },
      });
      return wrap(db.collection(c));
    },
  });
  {
    _resetResolveCache();
    const db = memFirestore();
    let reads = 0;
    const hanging = countingFsOver(db, () => { reads += 1; return new Promise(() => {}); });
    const TIMEOUT = 120;
    const t0 = Date.now();
    const g = await applyGraceResolution(hanging, 'x_pizza', mixedCart(3, 3), { stamp: PRICING_KEY_STAMP, timeoutMs: TIMEOUT });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < TIMEOUT * 1.8,
      `🔴 a mixed cart waited ${elapsed}ms against a ${TIMEOUT}ms bound — the deadline is per-KIND, so it doubles the latency added to a charge`);
    assert.strictEqual(g.coverage.incomplete, true, 'a wholly-hung resolve is INCOMPLETE');
    assert.strictEqual(g.coverage.read_error, 6, 'every occurrence degraded to read_error → grace');
    ok(`one deadline covers the whole ORDER: a mixed hung cart settled in ${elapsed}ms against a ${TIMEOUT}ms bound`);
  }
  {
    _resetResolveCache();
    const db = memFirestore();
    let reads = 0;
    const counting = countingFsOver(db, (run) => { reads += 1; return run(); });
    /* Split so NEITHER kind alone exceeds the budget — the per-kind allowance would pass both through
       untouched and report COMPLETE. Only a shared allowance can see this order is over. */
    const per = Math.ceil((RESOLVE_MAX_LOOKUPS + 10) / 2);
    assert.ok(per < RESOLVE_MAX_LOOKUPS, 'premise — each kind on its own is UNDER the budget');
    const g = await applyGraceResolution(counting, 'x_pizza', mixedCart(per, per), { stamp: PRICING_KEY_STAMP });
    assert.strictEqual(reads, RESOLVE_MAX_LOOKUPS,
      `🔴 ${reads} reads for a ${per * 2}-id order against a ${RESOLVE_MAX_LOOKUPS} budget — the allowance is per-KIND, so it multiplies`);
    assert.strictEqual(g.coverage.incomplete, true,
      '🔴 a budget-starved order reported COMPLETE — it would count as clean evidence for the enforce-go');
    ok(`one budget covers the whole ORDER: ${per}+${per} ids issue exactly ${RESOLVE_MAX_LOOKUPS} reads and report INCOMPLETE`);
  }

  // ── 13. 🔴 PAST THE DEADLINE THE BATCH IS INERT — NO NEW READ, NO MUTATION, NO CACHE ────────
  /* Firestore cannot cancel a read, so after the race settles the workers are still alive. They used
     to keep going: taking further QUEUED ids, writing answers into the map the caller had already been
     handed, and populating the cache — so an id reported `read_error` could turn `resolved` behind the
     caller's back, and a LATER request could be served an entry written by a read nobody awaited.
     🔴 THE READS MUST COMPLETE DURING THE WINDOW, not merely hang: a worker blocked on a read never
     reaches the top of its loop, so a cell where nothing lands cannot tell whether the guard that
     stops it TAKING NEW WORK is there at all. Each read here resolves quickly and the queue is long,
     so workers really do loop while the deadline falls. */
  {
    _resetResolveCache();
    const rid = 'x_pizza';
    const db = memFirestore();
    await ensureIdentity(db, { rid, kind: 'dish', legacyKey: 'Carnivora' });
    const real = (await keysCol(db, rid, 'dish').doc(enc('Carnivora')).get()).data().canonical_id;

    let reads = 0;
    const READ_MS = 8;
    const slow = countingFsOver(db, (run) => { reads += 1; return new Promise((res) => setTimeout(async () => res(await run()), READ_MS)); });
    const ids = [real, ...Array.from({ length: 59 }, (_, i) => `LAT${String(i).padStart(7, '0')}`)];
    const r = await resolveAcrossKinds(slow, rid, [{ kind: 'dish', ids }], { timeoutMs: 40 });
    const readsAtDeadline = reads;
    assert.ok(readsAtDeadline > 8, `premise — workers really did loop during the window (${readsAtDeadline} reads issued)`);
    assert.ok(readsAtDeadline < ids.length, `premise — the deadline landed with work still queued (${readsAtDeadline} of ${ids.length})`);

    /* The caller has its answer; snapshot it, then let every abandoned read land. The map must be
       exactly what it was — a result handed out and then edited is worse than a wrong one, because
       nothing downstream re-reads it. */
    const handedOver = JSON.stringify([...r.byKind.get('dish').entries()].sort());
    await new Promise((res) => setTimeout(res, READ_MS * 8));      // let every abandoned read land

    assert.strictEqual(reads, readsAtDeadline,
      `🔴 ${reads - readsAtDeadline} further reads were issued AFTER the deadline — abandoned workers kept draining the queue`);
    assert.strictEqual(JSON.stringify([...r.byKind.get('dish').entries()].sort()), handedOver,
      '🔴 a late answer mutated the result the caller was already handed');

    /* And nothing landed in the cache from an abandoned read: the next request must go back to the
       registry rather than be served an answer produced by a read nobody was waiting for. */
    const unread = ids[ids.length - 1];
    if (!r.byKind.get('dish').has(unread) || r.byKind.get('dish').get(unread).outcome === 'read_error') {
      let secondReads = 0;
      const counting = countingFsOver(db, (run) => { secondReads += 1; return run(); });
      await resolveAcrossKinds(counting, rid, [{ kind: 'dish', ids: [unread] }]);
      assert.strictEqual(secondReads, 1, '🔴 the next request was served a CACHE entry written by an abandoned read');
    }
    ok(`past the deadline the batch is inert — ${readsAtDeadline} reads issued, none after, nothing cached from an abandoned read`);
  }

  // ── 14. 🔴 THE ADOPTION IS A WRITE, SO THE ABANDONMENT DEADLINE BINDS IT TOO ────────────────
  /* The adoption path returned before ever reaching the mint path's shouldStop check, so a slow orphan
     query could commit an adoption after the publisher's deadline had passed and it had already
     reported the key unregistered. */
  {
    const rid = 'x_pizza';
    const db = memFirestore();
    const first = await ensureIdentity(db, { rid, kind: 'dish', legacyKey: 'Carnivora' });
    await keysCol(db, rid, 'dish').doc(enc('Carnivora'))._delete();          // orphan staged

    await assert.rejects(
      () => ensureIdentity(db, { rid, kind: 'dish', legacyKey: 'Carnivora', shouldStop: () => true }),
      /identity_abandoned/,
      '🔴 an adoption committed after the caller\'s deadline had passed',
    );
    assert.strictEqual((await keysCol(db, rid, 'dish').doc(enc('Carnivora')).get()).exists, false,
      '🔴 …and it WROTE — the transaction must abort with nothing committed');

    // SENSITIVITY: the same call without the deadline does adopt, so the refusal above is the guard
    // biting and not the adoption being broken.
    const after = await ensureIdentity(db, { rid, kind: 'dish', legacyKey: 'Carnivora', shouldStop: () => false });
    assert.strictEqual(after.adopted, true, 'non-vacuity: with no deadline the same state adopts');
    assert.strictEqual(after.canonical_id, first.canonical_id, '…to the same id');
    ok('a passed deadline aborts the ADOPTION write too, committing nothing — and without it the adoption still works');
  }

  // ── 15. 🔴 THE SWEEP RE-VALIDATES ITS CLAIMANT, PAGINATES, AND ONLY FILLS A MISSING ROW ─────
  {
    const rid = 'la_musa';
    // (a) retired between the scan and the repair — the sweep must NOT restore a pointer to it.
    {
      const db = memFirestore();
      const a = await ensureIdentity(db, { rid, kind: 'dish', legacyKey: 'dimsum_01' });
      await keysCol(db, rid, 'dish').doc(enc('dimsum_01'))._delete();        // orphan staged
      let raced = false;
      const racing = {
        collection: (c) => db.collection(c),
        runTransaction: async (fn) => {
          /* The scan has happened; the repair has not. This is the whole window, and retirement is the
             one thing that must survive it — the key row is the registry's fast path, so restoring a
             pointer to a retired id hands a permanently-reserved id back out on the very next call. */
          if (!raced) { raced = true; await retireIdentity(db, { rid, kind: 'dish', canonicalId: a.canonical_id }); }
          return db.runTransaction(fn);
        },
      };
      const r = await sweepIdentityIntegrity(racing, rid, 'dish');
      assert.ok(raced, 'premise — the retirement really did land between the scan and the repair');
      assert.strictEqual((await keysCol(db, rid, 'dish').doc(enc('dimsum_01')).get()).exists, false,
        '🔴 THE SWEEP RESURRECTED A RETIRED ID — the next ensureIdentity would hand it back out via the key fast path');
      assert.strictEqual(r.repaired, 0, '…and it reported no repair, because none was legitimate');
    }
    // (b) a conflict whose two claimants straddle a PAGE boundary is still a conflict.
    {
      const db = memFirestore();
      await idsCol(db, rid, 'dish').doc('aaa_first')._set({ legacy_key: 'dimsum_09', status: 'live', kind: 'dish', created_at: 'x' });
      await idsCol(db, rid, 'dish').doc('zzz_second')._set({ legacy_key: 'dimsum_09', status: 'live', kind: 'dish', created_at: 'x' });
      const r = await sweepIdentityIntegrity(db, rid, 'dish', { pageSize: 1 });   // one claimant per page
      assert.strictEqual(r.scanned, 2, '🔴 pagination stopped at the first page — later rows are never visited on ANY run');
      assert.strictEqual(r.conflicts, 1,
        '🔴 the two claimants were split across pages and read as one — the sweep would have ARBITRATED');
      assert.strictEqual(r.repaired, 0, '🔴 a conflicted key must never be repaired toward either side');
      assert.strictEqual((await keysCol(db, rid, 'dish').doc(enc('dimsum_09')).get()).exists, false, 'and no winner was written');
    }
    // (c) an EXISTING but malformed reverse row is evidence of a fault, not a slot to overwrite.
    {
      const db = memFirestore();
      const a = await ensureIdentity(db, { rid, kind: 'dish', legacyKey: 'dimsum_01' });
      await keysCol(db, rid, 'dish').doc(enc('dimsum_01'))._set({ canonical_id: '', kind: 'dish' });
      const r = await sweepIdentityIntegrity(db, rid, 'dish');
      assert.strictEqual(r.repaired, 0, '🔴 the sweep overwrote a row that EXISTS — it repairs missing rows only');
      assert.deepStrictEqual((await keysCol(db, rid, 'dish').doc(enc('dimsum_01')).get()).data(), { canonical_id: '', kind: 'dish' },
        '🔴 the malformed row was rewritten, destroying the evidence of the fault that produced it');
      assert.ok(a.canonical_id, 'premise — a real id did exist to overwrite it with');
    }
    ok('the sweep refuses a retired claimant, sees conflicts across page boundaries, and only ever fills a MISSING row');
  }

  FINISHED = true;
  console.log(`\nidentity-grace: ${n} checks passed`);
})().catch((e) => { console.error('identity-grace FAILED:', (e && e.stack) || e); process.exit(1); });
