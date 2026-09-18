'use strict';
/**
 * Portal 1D · D1 — THE NO-OP PROOF. Run: `node catalog/identity-noop.test.js`
 *
 * 🔴 THE ONE CLAIM D1 MAKES: identical legacy business outputs for identical legacy inputs, on every
 * path INCLUDING every failure path. Everything else D1 builds is only safe because this holds.
 *
 * So the shape here is always the same: compute a business answer with identity present and again with
 * it absent, and require the two to be the same object. Not "both look right" — the same. A test that
 * checked each side against an expectation would pass just as happily if identity shifted both.
 */
const assert = require('assert');
const { applyIdentityToServedBody } = require('./identity-overlay');
const { catalogSnapshot, generateFormBundle } = require('./generate-form-bundle');
const { computeServerTotal, MENU_BY_RESTAURANT, EXTRAS_BY_RESTAURANT, itemPricingKey } = require('../menu-pricing');
const { computeRedemption } = require('../rewards-redeem');
const { cartFingerprint, normalizeCartForFingerprint } = require('../quote-token');
const { fullRegistry, partialRegistry, registryStub, availabilityStub } = require('./identity-fixture');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

/* ── DID THE COMPARISON ACTUALLY RUN? ──────────────────────────────────────────────────────────
   🔴 THE DOMINANT FAILURE CLASS IN THIS BUILD, IN ITS THIRD FORM. First it was fakes laxer than
   production; then comparisons whose two sides were not actually different; now comparisons that never
   executed. The factura no-op was guarded by `if (!usesPlatformFactura(rid))` — flip that predicate to
   true for x_pizza and the fiscal comparison is skipped entirely while all 34 checks still report
   green. Pinning the predicate's ANSWER does not help: the answer being right does not prove the
   branch was taken.
   So every comparison below marks that it ran, and the audit at the end asserts the exact expected
   count for each. A comparison that is skipped, short-circuited, or quietly dropped in a refactor now
   fails loudly instead of disappearing into a passing suite. */
const RAN = Object.create(null);
const ran = (what) => { RAN[what] = (RAN[what] || 0) + 1; };
const ranCount = (what) => RAN[what] || 0;

const RIDS = ['x_pizza', 'la_musa'];
const tablesOf = (rid) => ({ restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] });

/* Build a real cart out of a served body, so the payloads below are the shape the form actually
   produces rather than one composed to make a point. */
function cartFrom(rid, body, withIds) {
  const d = body.dishes.find((x) => x.price > 0);
  const e = body.extras[0];
  const line = { name: d.name, id: d.id, qty: 2, price: d.price, extras: [{ name: e.name, id: e.id, qty: 1, price: e.price }] };
  if (withIds) {
    if (d.dish_id) line.dish_id = d.dish_id;
    if (e.extra_id) line.extras[0].extra_id = e.extra_id;
  }
  return [line];
}

/* ── THE FOUR BUSINESS ANSWERS, COMPUTED THE SAME WAY EVERY TIME ────────────────────────────────
   🔴 WHY THIS BECAME ONE FUNCTION. The happy path compared identity-present against identity-absent
   for price, 86, reward and factura; the FAILURE paths compared only price, and the fallback section
   compared an id-less cart against another id-less cart — which cannot fail for an identity reason no
   matter what identity does, because identity was absent on both sides. A no-op claim that holds only
   where the overlay succeeded is not the claim D1 makes: the failure paths are precisely where a
   half-applied enrichment would show up.
   So every comparison below runs through here, and every one of them is identity-PRESENT versus
   identity-ABSENT. The 86 gate is separate only because it is async. */
function redeemRawFor(rid, plainItems) {
  return rid === 'la_musa'
    ? { type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 1 }] }
    : { type: 'free_pizza_choice', item_id: plainItems[0].name };
}
function blockedKeyFor(rid, body) { return itemPricingKey(body.dishes.find((d) => d.price > 0), rid); }

function availDbFor(rid, blockedKey) {
  const { availKey } = require('../avail-key');
  return availabilityStub(rid, { [availKey(blockedKey)]: { available: false } }, assert);
}

function businessOutputs(rid, body, withIds, { redeemRaw }) {
  const { pricedLineItems } = require('../factura/pricing');
  const { usesPlatformFactura } = require('../factura/eligibility');
  const items = cartFrom(rid, body, withIds);
  const t = tablesOf(rid);
  return {
    price: computeServerTotal(items, rid, t),
    reward: computeRedemption({ redeem: redeemRaw, items, restaurantId: rid }),
    fingerprint: cartFingerprint(normalizeCartForFingerprint(items, rid), null),
    /* 🔴 THE FACTURA SKIP IS AN ASSERTION, NOT A BRANCH. `if (!usesPlatformFactura(rid))` on its own
       is a test that disappears the moment the predicate changes its mind: flip it to false for
       x_pizza and the comparison silently stops running while the suite still reports green. The
       expected value is stated per brand here, so a predicate that answers differently FAILS rather
       than skipping. */
    factura: usesPlatformFactura(rid)
      ? pricedLineItems(items, t.menu, t.extras)
      : '__brand_issues_its_own__',
  };
}
const PLATFORM_FACTURA = { x_pizza: true, la_musa: false };   // asserted below, per brand

(async () => {
  for (const rid of RIDS) {
    const plain = generateFormBundle(rid, catalogSnapshot(rid));
    const enriched = (await applyIdentityToServedBody(fullRegistry(rid), rid, plain)).body;

    // ── 0. NON-VACUITY: identity really is present on the enriched side ─────────────────────────
    assert.ok(enriched.dishes.every((d) => typeof d.dish_id === 'string' && d.dish_id),
      `${rid}: premise — every served dish carries an id, or the comparisons below prove nothing`);
    assert.ok(enriched.extras.every((e) => typeof e.extra_id === 'string' && e.extra_id),
      `${rid}: premise — and every served extra does too`);
    assert.strictEqual(plain.dishes[0].dish_id, undefined, `${rid}: …and the un-enriched side has none`);
    ok(`${rid}: the overlay carries ids for dishes AND extras (${enriched.dishes.length} + ${enriched.extras.length})`);

    // ── 1. 🔴 PRICING IS THE SAME NUMBER ───────────────────────────────────────────────────────
    {
      const tables = tablesOf(rid);
      const withIds = computeServerTotal(cartFrom(rid, enriched, true), rid, tables);
      const without = computeServerTotal(cartFrom(rid, plain, false), rid, tables);
      assert.ok(!without.error, `${rid}: premise — the id-less cart prices cleanly (${without.error})`);
      assert.deepStrictEqual(withIds, without, `${rid}: 🔴 identity changed the PRICE`);
      assert.ok(without.total > 0, `${rid}: …of a real amount (${without.total})`);
      ran(`pricing:${rid}`);
      ok(`${rid}: pricing is byte-identical with and without identity (${without.total})`);
    }

    // ── 1b. 🔴 THE 86 GATE BLOCKS THE SAME LINES ───────────────────────────────────────────────
    /* Availability resolves a line through the SAME key resolver pricing does, deliberately, so the
       two can never disagree about which object a line is. That makes it the second place an identity
       mistake would show up — and the first place a customer would feel one, as a dish that cannot be
       ordered or an 86'd dish that can. */
    {
      const { checkItemAvailability } = require('../availability-gate');
      /* An RTDB stub that 86s ONE real dish. A gate asked about an empty 86 list would answer
         "nothing blocked" for any input at all, including a broken one — so something is genuinely
         unavailable here, and the assertion is that the SAME line is blocked either way. */
      const blockedKey = itemPricingKey(plain.dishes.find((d) => d.price > 0), rid);
      const { availKey } = require('../avail-key');
      const node = { [availKey(blockedKey)]: { available: false } };
      // The shared stub: path-checked, .once()-shaped and event-checked. See identity-fixture.
      const db = availabilityStub(rid, node, assert);

      const withIds = await checkItemAvailability(db, cartFrom(rid, enriched, true), rid);
      const without = await checkItemAvailability(db, cartFrom(rid, plain, false), rid);
      assert.deepStrictEqual(withIds, without, `${rid}: 🔴 identity changed which lines the 86 gate BLOCKS`);
      assert.deepStrictEqual(without.blocked.length ? true : false, true,
        `${rid}: non-vacuity — the gate really did block something (${JSON.stringify(without.blocked)})`);
      ran(`86:${rid}`);
      ok(`${rid}: the 86 gate blocks exactly the same lines with and without identity`);
    }

    // ── 1c. 🔴 THE FACTURA LINES ARE THE SAME LINES ────────────────────────────────────────────
    /* The SAR factura is the one output with a legal consequence attached, and it is priced from the
       same tables by the same keys. An identity field leaking into a fiscal line would be a document
       that no longer matches the order it describes. */
    {
      const { pricedLineItems } = require('../factura/pricing');
      const { usesPlatformFactura } = require('../factura/eligibility');
      /* 🔴 ONLY WHERE THE PLATFORM ISSUES THE FACTURA, and asserted rather than assumed. la_musa
         issues its own fiscal documents through its POS, so there is no platform factura to compare —
         and pricedLineItems keys by NAME, which la_musa does not use. Running it there would fail for
         a reason that has nothing to do with identity; SKIPPING it silently would be worse, because
         the day la_musa is onboarded to platform factura this comparison would quietly not exist. So
         the eligibility is read from the real predicate and the skip is explicit. */
      /* 🔴 THE PREDICATE'S ANSWER IS PINNED, so forcing this branch the wrong way FAILS instead of
         quietly skipping the comparison. Previously the branch was taken on trust: a predicate that
         returned false for x_pizza would have skipped the fiscal no-op check and still reported a
         passing test. */
      assert.strictEqual(usesPlatformFactura(rid), PLATFORM_FACTURA[rid],
        `${rid}: 🔴 platform-factura eligibility moved — the fiscal comparison below would silently stop running`);
      if (!usesPlatformFactura(rid)) {
        ok(`${rid}: no platform factura to compare — this brand issues its own (asserted, not assumed)`);
      } else {
      const tables = tablesOf(rid);
      const withIds = pricedLineItems(cartFrom(rid, enriched, true), tables.menu, tables.extras);
      const without = pricedLineItems(cartFrom(rid, plain, false), tables.menu, tables.extras);
      assert.ok(!without.error, `${rid}: premise — the id-less cart produces fiscal lines (${without.error})`);
      assert.ok(Array.isArray(without.items) && without.items.length > 0, `${rid}: …and there are lines to compare`);
      assert.deepStrictEqual(withIds, without, `${rid}: 🔴 identity changed the FACTURA lines`);
      assert.ok(!JSON.stringify(withIds).includes('ID_'), `${rid}: 🔴 …and no id reached a fiscal line`);
      ran(`factura:${rid}`);   // 🔴 INSIDE the branch — the whole point of the counter
      ok(`${rid}: the factura lines are identical with and without identity (${without.items.length} lines)`);
      }
    }

    // ── 2. 🔴 THE PRICING KEY IS UNMOVED ───────────────────────────────────────────────────────
    // The one thing that would break every downstream consumer at once.
    {
      for (const d of enriched.dishes) {
        const plainRec = plain.dishes.find((p) => p.id === d.id);
        assert.strictEqual(itemPricingKey(d, rid), itemPricingKey(plainRec, rid),
          `${rid}: 🔴 the id changed which key a served dish resolves to`);
      }
      ran(`key:${rid}`);
      ok(`${rid}: every served record still resolves to the same pricing key`);
    }

    // ── 3. 🔴 THE REWARD RESOLVES THE SAME ─────────────────────────────────────────────────────
    {
      const items = cartFrom(rid, enriched, true);
      const itemsPlain = cartFrom(rid, plain, false);
      const raw = rid === 'la_musa'
        ? { type: 'points_ala_carte', items: [{ id: 'dimsum_01', qty: 1 }] }
        : { type: 'free_pizza_choice', item_id: itemsPlain[0].name };
      const a = computeRedemption({ redeem: raw, items, restaurantId: rid });
      const b = computeRedemption({ redeem: raw, items: itemsPlain, restaurantId: rid });
      assert.ok(b && b.ok, `${rid}: premise — the reward resolves without identity (${b && b.reason})`);
      assert.deepStrictEqual(a, b, `${rid}: 🔴 identity changed the REWARD resolution`);
      /* And the canonical — the thing a reservation is bound to — must not have grown a field.
         A canonical that differs between a pre-backfill and post-backfill client would make the same
         reward reserve under two different fingerprints. */
      assert.deepStrictEqual(a.canonical, b.canonical, `${rid}: 🔴 the redemption CANONICAL gained identity`);
      assert.ok(!JSON.stringify(a.canonical).includes('ID_'), `${rid}: …no id reached it`);
      ran(`reward:${rid}`);
      ok(`${rid}: the reward and its canonical are identical with and without identity`);
    }

    // ── 4. 🔴 THE QUOTE FINGERPRINT IS UNMOVED ─────────────────────────────────────────────────
    // A field inside a fingerprint is not shadow: it would make two clients disagree about the same
    // cart across the backfill.
    {
      const withIds = normalizeCartForFingerprint(cartFrom(rid, enriched, true), rid);
      const without = normalizeCartForFingerprint(cartFrom(rid, plain, false), rid);
      assert.ok(withIds && without, `${rid}: premise — both carts fingerprint`);
      assert.strictEqual(cartFingerprint(withIds, null), cartFingerprint(without, null),
        `${rid}: 🔴 identity changed the QUOTE FINGERPRINT`);
      ran(`fingerprint:${rid}`);
      ok(`${rid}: the quote fingerprint is unchanged by identity`);
    }

    // ── 5. 🔴 EVERY FORCED FAILURE SERVES THE BODY IT WAS GIVEN ────────────────────────────────
    // The overlay's whole licence to exist is that it cannot make anything worse.
    {
      const failures = {
        'a registry that throws': { collection() { throw new Error('registry down'); } },
        'a registry that rejects': { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ get: () => Promise.reject(new Error('read failed')) }) }) }) }) }) }) },
        'a registry that hangs': { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ get: () => new Promise(() => {}) }) }) }) }) }) }) },
        'a registry returning junk': { collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ canonical_id: null }) }) }) }) }) }) }) }) },
      };
      /* The identity-PRESENT baseline every failure below is measured against, plus the reward
         request and 86 stub held constant so the only thing varying across the comparison is whether
         identity made it onto the body. */
      const redeemRaw = redeemRawFor(rid, cartFrom(rid, plain, false));
      const blockedKey5 = blockedKeyFor(rid, plain);
      const avail5 = availDbFor(rid, blockedKey5);
      const { checkItemAvailability: checkAvail5 } = require('../availability-gate');
      const checkItemAvailability5 = (body, withIds) => checkAvail5(avail5, cartFrom(rid, body, withIds), rid);

      const ok5Baseline = businessOutputs(rid, enriched, true, { redeemRaw });
      const ok5Blocked = await checkItemAvailability5(enriched, true);
      assert.ok(!ok5Baseline.price.error && ok5Baseline.price.total > 0,
        `${rid}: premise — the identity-PRESENT baseline prices (${ok5Baseline.price.error})`);
      assert.ok(ok5Blocked.blocked.length > 0,
        `${rid}: premise — the baseline 86 gate really blocks a line, so "same verdict" is not two empty answers`);

      for (const [label, badDb] of Object.entries(failures)) {
        /* 🔴 IT MUST NOT THROW. Caught here rather than left to escape, because an overlay that
           rethrows would otherwise surface as a crashed test run — evidence that something is wrong,
           but not evidence of WHICH property broke. The whole licence for this code is that it cannot
           make a serve worse, and "does not throw" is the first half of that. */
        let out;
        try {
          /* 🔴 AND IT MUST RETURN PROMPTLY. Bounded on the TEST's own clock, independently of the
             overlay's: without this, an overlay that lost its timeout would simply hang here and the
             suite would stall rather than fail — a test that cannot finish is not a test that passes,
             but it is also not one that tells you what broke. The bound is generous next to the
             overlay's own 60ms, so this fails only when the overlay has no bound at all. */
          out = await Promise.race([
            applyIdentityToServedBody(badDb, rid, plain, { timeoutMs: 60 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('__test_bound__')), 2000)),
          ]);
        } catch (e) {
          const why = (e && e.message) || String(e);
          if (why === '__test_bound__') {
            assert.fail(`${rid}/${label}: 🔴 the overlay did NOT return — an unbounded enrichment becomes an unbounded menu`);
          }
          assert.fail(`${rid}/${label}: 🔴 the overlay THREW — an enrichment problem must never become a failed menu (${why})`);
        }
        assert.strictEqual(out.applied, false, `${rid}/${label}: reports that nothing was applied`);
        assert.deepStrictEqual(out.body.dishes, plain.dishes, `${rid}/${label}: 🔴 the served dishes must be exactly what came in`);
        assert.deepStrictEqual(out.body.extras, plain.extras, `${rid}/${label}: 🔴 …and the extras too`);
        assert.strictEqual(out.body.dishes[0].dish_id, undefined, `${rid}/${label}: id-absent continuation`);
        /* 🔴 AND ALL FOUR BUSINESS ANSWERS ARE THE ONES THE SUCCESSFUL OVERLAY PRODUCES. Checking
           only that the failed body "still prices" leaves the interesting half unproven: a customer on
           a failed-enrichment serve must get the same price, the same 86 verdict, the same reward and
           the same fiscal lines as one on a successful serve. This is identity-PRESENT (enriched)
           against identity-ABSENT (what the failure served) — the comparison a failure path is
           actually for. */
        const failed = businessOutputs(rid, out.body, false, { redeemRaw });
        assert.ok(!failed.price.error && failed.price.total > 0,
          `${rid}/${label}: 🔴 the menu still prices (${failed.price.error})`);
        assert.deepStrictEqual(failed, ok5Baseline,
          `${rid}/${label}: 🔴 a failed enrichment changed a business answer — price, 86, reward or factura`);

        ran(`failure:${rid}`);
        const failed86 = await checkItemAvailability5(out.body, false);
        assert.deepStrictEqual(failed86, ok5Blocked,
          `${rid}/${label}: 🔴 a failed enrichment changed which lines the 86 gate blocks`);
      }
      ok(`${rid}: ${Object.keys(failures).length} forced enrichment failures each serve the original body and leave price, 86, reward and factura identical to a SUCCESSFUL overlay`);
    }

    // ── 5b. 🔴 THE FALLBACK SERVE IS IDENTITY-FREE BY CONSTRUCTION — ASSERTED, NOT ARGUED ─────
    /* The fallback ladder returns the NUMERIC price tables, not display records, so identity cannot
       reach it: the overlay decorates a projection the ladder never produces. That is a structural
       argument, and this turns it into an observation — because "cannot by construction" is exactly
       the kind of claim that stops being true when someone later enriches one more thing. */
    {
      const { createSnapshotFallback } = require('./snapshot-fallback');
      const tables = tablesOf(rid);
      const mirror = { version: 'v9', seq: 9, rid, menu: tables.menu, extras: tables.extras };
      const fb = createSnapshotFallback({ mirrorReader: async () => mirror, alarm: () => {} });
      /* 🔴 THREE ARGUMENTS, NOT AN OBJECT. recordActive(rid, versionId, seq) ignores a non-integer
         seq, so passing { versionId, seq } recorded NOTHING: the ladder never learned the active
         ordinal and silently dropped to the mirror_cold rung — the one that serves without a second
         opinion. The freshness comparison this section meant to exercise was never running. */
      fb.recordActive(rid, 'v9', 9);
      const served = await fb.snapshotFor(rid);
      assert.ok(served && served.menu, `${rid}/fallback: premise — the ladder served something (${served && served.source})`);
      assert.strictEqual(served.source, 'mirror',
        `${rid}/fallback: premise — the version-checked rung, not the cold one (got ${served.source})`);

      const flat = JSON.stringify({ menu: served.menu, extras: served.extras });
      assert.ok(!/dish_id|extra_id|ID_dish|ID_extra/.test(flat),
        `${rid}/fallback: 🔴 identity reached the FALLBACK serve — it must return numeric tables only`);
      assert.ok(Object.values(served.menu).every((v) => typeof v === 'number'),
        `${rid}/fallback: the served menu is still a numeric table`);
      // …and an order priced off the fallback tables is the same order.
      /* 🔴 IDENTITY-PRESENT ON ONE SIDE. This compared an id-less cart against another id-less cart,
         which is an assertion about the fallback TABLES and says nothing whatever about identity — it
         would pass unchanged if the overlay wrote ids into every cart line, because neither side had
         any. The live-tables side now carries ids, so the claim is the real one: a customer holding an
         enriched cart, served off the fallback ladder, pays what the live tables would charge. */
      assert.deepStrictEqual(
        computeServerTotal(cartFrom(rid, enriched, true), rid, { restaurantId: rid, menu: served.menu, extras: served.extras }),
        computeServerTotal(cartFrom(rid, plain, false), rid, tables),
        `${rid}/fallback: 🔴 an identity-bearing cart priced off the fallback differs from an id-less one off the live tables`);
      ran(`fallback:${rid}`);
      ok(`${rid}: the fallback serve carries no identity and prices identically (source: ${served.source})`);
    }

    // ── 6. 🔴 IDENTITY NEVER ENTERS A NUMERIC TABLE ────────────────────────────────────────────
    {
      const tables = tablesOf(rid);
      await applyIdentityToServedBody(fullRegistry(rid), rid, plain);
      for (const [label, table] of [['menu', tables.menu], ['extras', tables.extras]]) {
        assert.ok(Object.values(table).every((v) => typeof v === 'number'),
          `${rid}: 🔴 the ${label} price table must stay numbers only — identity is metadata, never money data`);
        assert.ok(!Object.keys(table).some((k) => k.startsWith('ID_')),
          `${rid}: 🔴 …and no id became a key in it`);
      }
      ok(`${rid}: the numeric price tables are untouched — values still numbers, keys still legacy`);
    }

    // ── 5c. 🔴 THE READER'S OWN FAILURE CLASSES, THROUGH THE REAL SERVE PATH ───────────────────
    /* Section 5 forces the OVERLAY to fail. These force the layer BELOW it — the ones the gate named:
       a content-hash mismatch and a torn read. Both make getRestaurantMenu fail closed before the
       overlay is reached, which is the argument for why identity cannot affect them; this turns the
       argument into a measurement by running the identical break twice over the SAME store, once with
       an empty registry and once with every object backfilled, and demanding the two failures be the
       same failure. One store, so the version ids in the messages are comparable. */
    {
      const { makeDb } = require('./firestore-fake');
      const { publishVersion } = require('./catalog-publish');
      const { buildPublishCandidate } = require('../tools/publish-version');
      const { buildPublicMenu } = require('./public-menu');
      const { backfillIdentities, liveKeys: liveKeysOf } = require('./identity-backfill');
      const { lookupByLegacyKeys } = require('./identity-registry');
      const known = new Set(RIDS);
      const active = { isActive: async () => true };

      const capture = async (db) => {
        try { await buildPublicMenu(db, rid, { known, ...active }); return { served: true }; }
        catch (e) { return { served: false, code: e.code, message: e.message, hasBody: e.body !== undefined }; }
      };
      const activeVid = async (db) => (await db.collection('restaurants').doc(rid)
        .collection('meta').doc('active_version').get()).data().version;

      const breakers = {
        'the content hash no longer matches': async (db) => {
          const r = await db.collection('restaurants').doc(rid).collection('versions').doc(await activeVid(db)).get();
          await r.ref.set({ ...r.data(), content_hash: 'f'.repeat(64) });
        },
        'a torn read — an extra stripped of its display record': async (db) => {
          const snap = await db.collection('restaurants').doc(rid).collection('versions')
            .doc(await activeVid(db)).collection('extras').get();
          const d = snap.docs[0];
          await d.ref.set({ key: d.data().key, price: d.data().price });
        },
      };

      /* 🔴 THE "EMPTY" SIDE WAS NEVER EMPTY. publishVersion's own preserve-on-write registers every
         published key, so by the time the first capture ran the registry already held 24/14 on
         x_pizza and 44/14 on la_musa — and the backfill that followed created ZERO rows, preserving
         what the publish had already written. Both captures were therefore identity-PRESENT, and the
         comparison could not have failed for an identity reason no matter what identity did.
         So the registry is cleared after the publish and its emptiness ASSERTED, not assumed; and the
         backfill afterwards must CREATE every row, not merely find them. A precondition that is only
         believed is the same bug as a fake that is only trusted. */
      const liveFor = (r) => liveKeysOf(r, catalogSnapshot(r));
      const resolvable = async (db, r) => {
        const k = liveFor(r);
        const d = await lookupByLegacyKeys(db, { rid: r, kind: 'dish', legacyKeys: k.dish });
        const e = await lookupByLegacyKeys(db, { rid: r, kind: 'extra', legacyKeys: k.extra });
        return d.size + e.size;
      };
      const clearRegistry = async (db, r) => {
        for (const kind of ['dish', 'extra']) {
          for (const leaf of ['keys', 'ids']) {
            const col = db.collection('restaurants').doc(r).collection('identity').doc(kind).collection(leaf);
            const snap = await col.get();
            for (const d of snap.docs) await d.ref.delete();
          }
        }
      };

      for (const [label, breaker] of Object.entries(breakers)) {
        const db = makeDb();
        const { input, expected } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: '1d' });
        await publishVersion(db, rid, input, { expected });

        // Premise first: intact, this store serves. Otherwise the two failures below could agree for
        // a reason that has nothing to do with the break.
        assert.strictEqual((await capture(db)).served, true, `${rid}/${label}: premise — intact, it serves`);

        // Non-vacuity of the clear itself: the publish really did register things, so "0 after" is
        // the clear working rather than the lookup being broken.
        const seeded = await resolvable(db, rid);
        assert.ok(seeded > 0, `${rid}/${label}: premise — publish's preserve-on-write registered ${seeded} objects, which is why the clear below is necessary`);
        await clearRegistry(db, rid);
        assert.strictEqual(await resolvable(db, rid), 0,
          `${rid}/${label}: 🔴 the identity-ABSENT side must actually be absent — this is the precondition that silently was not true`);

        await breaker(db);
        const idAbsent = await capture(db);                       // registry genuinely empty, asserted
        const report = await backfillIdentities(db, rid, catalogSnapshot(rid));
        assert.strictEqual(report.dish.created, report.dish.total,
          `${rid}/${label}: 🔴 the identity-PRESENT side must be freshly CREATED, not preserved from a registry that was never cleared (created ${report.dish.created} of ${report.dish.total})`);
        assert.strictEqual(report.extra.created, report.extra.total, `${rid}/${label}: …extras too`);
        assert.ok(report.dish.total > 0, `${rid}/${label}: premise — there was something to register`);
        assert.strictEqual(await resolvable(db, rid), report.dish.total + report.extra.total,
          `${rid}/${label}: …and every one of them now resolves`);
        const idPresent = await capture(db);                      // every object registered

        assert.strictEqual(idAbsent.served, false, `${rid}/${label}: premise — the break really closes the serve`);
        assert.strictEqual(idAbsent.code, 'public_menu_unavailable', `${rid}/${label}: it fails with the reader's code (${idAbsent.code})`);
        assert.strictEqual(idAbsent.hasBody, false, `${rid}/${label}: 🔴 a failure carries no partial body`);
        ran(`readerfail:${rid}`);
        assert.deepStrictEqual(idPresent, idAbsent,
          `${rid}/${label}: 🔴 a populated registry changed HOW the reader fails — identity must not reach a closed serve at all`);
      }
      ok(`${rid}: ${Object.keys(breakers).length} reader failure classes fail identically with the registry empty and full`);
    }

    // ── 5d. 🔴 A PRICING-READER TIMEOUT, AND A MIRROR TOO STALE TO SERVE ───────────────────────
    /* The last two states the gate asked for. The pricing resolver reads the numeric tables through a
       path of its own, under its own deadline; the overlay decorates the served projection and is
       deliberately nowhere near it. Under a hung pricing read the resolver drops to the ladder — and a
       customer holding an identity-bearing cart must still be charged the live amount. */
    {
      const { createPricingResolver } = require('./pricing-tables');
      const { createSnapshotFallback } = require('./snapshot-fallback');
      const tables = tablesOf(rid);
      const mirror = { version: 'v9', seq: 9, rid, menu: tables.menu, extras: tables.extras };

      const alarms = [];
      const warm = createSnapshotFallback({ mirrorReader: async () => mirror, alarm: (k) => alarms.push(k) });
      warm.recordActive(rid, 'v9', 9);
      const resolver = createPricingResolver({
        reader: { getTables: () => new Promise(() => {}) },     // hangs forever
        alarm: (k) => alarms.push(k),
        deadlineMs: 25,
        ladder: warm,
      });
      const got = await resolver.getPricingTables(rid);
      assert.ok(alarms.includes('catalog_read_timeout'),
        `${rid}/pricing-timeout: premise — the catalog read really timed out (${alarms.join(',')})`);
      assert.deepStrictEqual(
        computeServerTotal(cartFrom(rid, enriched, true), rid, { restaurantId: rid, menu: got.menu, extras: got.extras }),
        computeServerTotal(cartFrom(rid, plain, false), rid, tables),
        `${rid}/pricing-timeout: 🔴 an identity-bearing cart priced off the timed-out ladder differs from the live amount`);
      assert.ok(!/ID_dish|ID_extra|dish_id|extra_id/.test(JSON.stringify({ menu: got.menu, extras: got.extras })),
        `${rid}/pricing-timeout: 🔴 identity reached the pricing tables`);

      // …and a mirror further behind than K is refused outright — the overlay has no say in that either.
      const staleAlarms = [];
      const stale = createSnapshotFallback({
        mirrorReader: async () => ({ ...mirror, version: 'v7', seq: 7 }),
        alarm: (k) => staleAlarms.push(k),
      });
      stale.recordActive(rid, 'v12', 12);                        // distance 5, K = 1
      await assert.rejects(() => stale.snapshotFor(rid), /snapshot_fallback_unavailable/,
        `${rid}/stale-mirror: a mirror too far behind must be refused, not decorated and served`);
      assert.ok(staleAlarms.includes('catalog_mirror_too_stale'),
        `${rid}/stale-mirror: premise — it was refused for STALENESS (${staleAlarms.join(',')})`);
      ran(`pricingtimeout:${rid}`);
      ok(`${rid}: a pricing-reader timeout prices an identity-bearing cart at the live amount, and a mirror past K is refused`);
    }
  }

  // ══ §7 MATRIX — THE STATES D1 IS ONLY "SAFE BY CONSTRUCTION" IN ═══════════════════════════════
  /* Each of these was argued safe rather than demonstrated, and an argument is what a gate is supposed
     to be able to stop trusting. They are real operational states: a migration that stopped halfway, a
     rollback, a client that predates the field, a portal tab left open across a republish. */
  {
    const { memFirestore } = require('./identity-fixture');
    const { ensureIdentitiesForKeys } = require('./identity-backfill');
    const { lookupByLegacyKeys } = require('./identity-registry');

    for (const rid of RIDS) {
      const plain = generateFormBundle(rid, catalogSnapshot(rid));
      const tables = tablesOf(rid);
      const dishKeys = plain.dishes.map((d) => itemPricingKey(d, rid)).filter(Boolean);
      const extraKeys = plain.extras.map((e) => itemPricingKey(e, rid)).filter(Boolean);

      // ── ROW A: AN INTERRUPTED BACKFILL ────────────────────────────────────────────────────────
      /* Half the dishes registered, the rest not. The failure to guard against is ALL-OR-NOTHING
         behaviour in either direction: refusing to serve because some keys are missing, or stamping a
         wrong id because one was. Tolerance has to be PER RECORD. */
      {
        const half = dishKeys.slice(0, Math.max(1, Math.floor(dishKeys.length / 2)));
        const out = await applyIdentityToServedBody(partialRegistry({ dish: half, extra: [] }, rid), rid, plain);
        const withId = out.body.dishes.filter((d) => d.dish_id);
        const withoutId = out.body.dishes.filter((d) => !d.dish_id);
        assert.strictEqual(withId.length, half.length, `${rid}/interrupted: exactly the registered dishes carry an id`);
        assert.ok(withoutId.length > 0, `${rid}/interrupted: premise — some dishes are genuinely unregistered`);
        for (const d of withId) {
          assert.strictEqual(d.dish_id, `ID_dish_${itemPricingKey(d, rid)}`,
            `${rid}/interrupted: 🔴 a registered dish must carry ITS id, not a neighbour's`);
        }
        assert.ok(out.body.extras.every((e) => !e.extra_id), `${rid}/interrupted: unregistered extras stay id-absent`);
        // …and the half-migrated menu prices exactly as the un-migrated one does.
        assert.deepStrictEqual(
          computeServerTotal(cartFrom(rid, out.body, true), rid, tables),
          computeServerTotal(cartFrom(rid, plain, false), rid, tables),
          `${rid}/interrupted: 🔴 a half-finished migration changed the price`);
        ran(`interrupted:${rid}`);
        ok(`${rid}: an interrupted backfill decorates per-record and prices identically (${withId.length} of ${dishKeys.length})`);
      }

      // ── ROW B: ROLLBACK, THEN REPUBLISH ───────────────────────────────────────────────────────
      /* The registry is version-independent and the overlay runs after the read, so a version change
         cannot move an id. The thing to prove is that a rollback does not LOSE identity and a
         republish does not RE-MINT it — an object whose id changed across a rollback would make every
         record written before it point at a stranger. */
      {
        const db = memFirestore();
        const before = await ensureIdentitiesForKeys(db, rid, { dish: dishKeys, extra: extraKeys });
        const idsBefore = await lookupByLegacyKeys(db, { rid, kind: 'dish', legacyKeys: dishKeys });
        assert.strictEqual(before.dish.created, dishKeys.length, `${rid}/rollback: premise — the first publish minted`);

        // roll back to an older version carrying a SUBSET, then republish the full set
        const subset = dishKeys.slice(0, Math.max(1, dishKeys.length - 2));
        await ensureIdentitiesForKeys(db, rid, { dish: subset, extra: extraKeys });
        const republished = await ensureIdentitiesForKeys(db, rid, { dish: dishKeys, extra: extraKeys });
        assert.strictEqual(republished.dish.created, 0,
          `${rid}/rollback: 🔴 a republish after a rollback RE-MINTED ${republished.dish.created} ids`);
        const idsAfter = await lookupByLegacyKeys(db, { rid, kind: 'dish', legacyKeys: dishKeys });
        assert.deepStrictEqual([...idsAfter.entries()].sort(), [...idsBefore.entries()].sort(),
          `${rid}/rollback: 🔴 an id moved across a rollback+republish`);
        ran(`rollback:${rid}`);
        ok(`${rid}: rollback then republish preserves every id and mints none (${idsAfter.size} objects)`);
      }

      // ── ROW C: A MIXED FLEET OF READERS ───────────────────────────────────────────────────────
      /* A cached form from before D1 simply does not know the field. What must hold is that a reader
         which ignores identity sees EXACTLY the pre-D1 menu — so the new field cannot change a menu
         for someone who never looks at it. Modelled by stripping the field back off, which is what
         such a reader effectively does. */
      {
        const { stripIdentity } = require('../../xpizza-orders/form-identity-strip');
        const applied = await applyIdentityToServedBody(fullRegistry(rid), rid, plain);
        const enrichedFull = applied.body;
        /* 🔴 THE PRECONDITION, ASSERTED. This whole row is "strip the field back off and you get the
           pre-D1 menu" — which is trivially true if the field was never applied. An overlay that
           silently enriched nothing would make stripIdentity a no-op comparing plain against plain,
           and the row would pass while testing nothing. Same shape as the empty-vs-backfilled defect:
           the two sides have to actually differ before their equality means anything. */
        assert.strictEqual(applied.applied, true, `${rid}/mixed-readers: premise — the overlay reports it applied`);
        const decorated = enrichedFull.dishes.filter((d) => d.dish_id).length
          + enrichedFull.extras.filter((e) => e.extra_id).length;
        assert.strictEqual(decorated, enrichedFull.dishes.length + enrichedFull.extras.length,
          `${rid}/mixed-readers: premise — every record really carries an id before it is stripped (${decorated})`);
        assert.notDeepStrictEqual(enrichedFull.dishes, plain.dishes,
          `${rid}/mixed-readers: 🔴 …so the two sides genuinely differ — otherwise stripping proves nothing`);

        assert.deepStrictEqual(stripIdentity(enrichedFull.dishes), plain.dishes,
          `${rid}/mixed-readers: 🔴 an old reader must see exactly the pre-D1 dishes`);
        assert.deepStrictEqual(stripIdentity(enrichedFull.extras), plain.extras,
          `${rid}/mixed-readers: 🔴 …and the pre-D1 options`);
        // a NEW reader and an OLD reader must also agree about the money, which is the point.
        assert.deepStrictEqual(
          computeServerTotal(cartFrom(rid, enrichedFull, true), rid, tables),
          computeServerTotal(cartFrom(rid, plain, false), rid, tables),
          `${rid}/mixed-readers: 🔴 old and new readers disagree about the price`);
        ran(`mixedreaders:${rid}`);
        ok(`${rid}: an old reader sees exactly the pre-D1 menu, and both price the same`);
      }

      // ── ROW D: A STALE PORTAL SUBMISSION ──────────────────────────────────────────────────────
      /* A portal tab open across a republish submits records carrying whatever it last saw. The rule
         is that preserve-on-write RE-DERIVES from the registry and never adopts what was handed to it,
         so a stale — or hostile — echoed id cannot become the object's identity. */
      {
        const db = memFirestore();
        await ensureIdentitiesForKeys(db, rid, { dish: dishKeys.slice(0, 3), extra: [] });
        const trueIds = await lookupByLegacyKeys(db, { rid, kind: 'dish', legacyKeys: dishKeys.slice(0, 3) });
        assert.strictEqual(trueIds.size, 3, `${rid}/stale-portal: premise — three objects are registered`);

        /* The submission echoes the keys back with ids attached — one stale, one belonging to another
           object. ensureIdentitiesForKeys takes KEYS only; it has no parameter through which an echoed
           id could enter, which is the structural half of the guarantee. */
        const republish = await ensureIdentitiesForKeys(db, rid, { dish: dishKeys.slice(0, 3), extra: [] });
        assert.strictEqual(republish.dish.created, 0, `${rid}/stale-portal: a republish of known keys mints nothing`);
        const after = await lookupByLegacyKeys(db, { rid, kind: 'dish', legacyKeys: dishKeys.slice(0, 3) });
        assert.deepStrictEqual([...after.entries()].sort(), [...trueIds.entries()].sort(),
          `${rid}/stale-portal: 🔴 a stale submission changed an identity`);
        // …and the claim-checker names the mismatch rather than silently accepting it.
        const [k0, id0] = [...trueIds.entries()][0];
        const [, id1] = [...trueIds.entries()][1];
        const { validateClaim } = require('./identity-registry');
        assert.strictEqual((await validateClaim(db, { rid, kind: 'dish', legacyKey: k0, claimedId: id1 })).reason, 'swapped',
          `${rid}/stale-portal: 🔴 an echoed id belonging to another object is reported as a swap`);
        assert.strictEqual((await validateClaim(db, { rid, kind: 'dish', legacyKey: k0, claimedId: id0 })).ok, true,
          `${rid}/stale-portal: non-vacuity — the honest claim still passes`);
        ran(`staleportal:${rid}`);
        ok(`${rid}: a stale portal submission cannot move an identity — the write re-derives, it never adopts`);
      }
    }
  }

  // ══ THE PUBLISH PRESERVE-HOOK DEADLINE ACTUALLY ABANDONS ═════════════════════════════════════
  /* 🔴 A Promise.race BOUNDS THE WAIT, NOT THE WORK — and the difference is the whole claim. The hook
     said "on timeout the keys simply go unregistered"; what actually happened was that the deadline
     fired, the publish returned, and the registry loop went on transacting underneath, landing its
     entire key set whenever the store came back. Every row eventually written, minutes after the
     publish reported none of them. Not corrupting — the writes are the right writes — but the stated
     semantic was false, and a deadline nobody enforces is a log line.
     This measures the abandonment directly: block the first registry transaction, let the deadline
     fire, then RELEASE the store and give the abandoned loop every chance to finish. */
  {
    const { memFirestore } = require('./identity-fixture');
    const { ensureIdentitiesForKeys } = require('./identity-backfill');
    const { liveKeys } = require('./identity-backfill');
    const rid = 'x_pizza';
    const keys = liveKeys(rid, catalogSnapshot(rid));
    const expectedRows = (keys.dish.length + keys.extra.length) * 2;   // an id row and a key row each
    assert.ok(expectedRows > 20, `premise — there is a substantial key set to abandon (${expectedRows} rows)`);

    /* 🔴 THE BLOCK IS MID-TRANSACTION, NOT BEFORE IT. The first version of this gate held the call
       back BEFORE runTransaction ever started, which is the easy case: nothing had begun, so nothing
       had to be abandoned. The state that actually loses the race is a transaction already INSIDE its
       reads when the deadline fires — that one used to finish and write whenever its store came back.
       So the gate now blocks on the first tx.get, exactly where a slow registry stalls, and the wrapped
       tx delegates to the real one so the fixture's read-before-write rule still applies. */
    const gated = () => {
      const base = memFirestore();
      let release; const blocked = new Promise((r) => { release = r; });
      let reads = 0;
      let started = 0;
      const db = {
        _docs: base._docs,
        started: () => started,
        collection: (c) => base.collection(c),
        runTransaction: (fn, opts) => (started += 1, base.runTransaction(async (tx) => fn({
          get: async (ref) => { reads += 1; if (reads === 1) await blocked; return tx.get(ref); },
          set: (ref, v) => tx.set(ref, v),
          delete: (ref) => tx.delete(ref),
        }), opts)),
      };
      return { db, base, release: () => release() };
    };

    const run = async (withStop) => {
      const { db, base, release } = gated();
      let expired = false;
      let threw = null;
      try {
        await Promise.race([
          ensureIdentitiesForKeys(db, rid, keys, withStop ? { shouldStop: () => expired } : {}),
          new Promise((_, rej) => setTimeout(() => { expired = true; rej(new Error('identity_preserve_timeout')); }, 40)),
        ]);
      } catch (e) { threw = (e && e.message) || String(e); }
      const atTimeout = base._docs.size;
      release();
      // Every chance to land: the blocked transaction is now completely unobstructed.
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 50));
      return { threw, atTimeout, after: base._docs.size, started: db.started() };
    };

    const stopped = await run(true);
    assert.strictEqual(stopped.threw, 'identity_preserve_timeout', 'premise — the deadline fired');
    assert.strictEqual(stopped.atTimeout, 0, 'premise — nothing had been written when it fired');
    assert.strictEqual(stopped.after, 0,
      `🔴 ZERO rows after the deadline — including from the transaction that was already mid-read when it fired. Permitting "at most the one in flight" was the earlier, weaker contract: it let a publish report identity_preserve_timeout and then land rows anyway once its store came back (landed ${stopped.after})`);

    /* 🔴 AND IT STOPS STARTING TRANSACTIONS, not merely stops committing them. The in-transaction
       abandonment above makes every late write impossible, but on its own it would let the loop open a
       transaction for all 38 remaining keys and abort each one — 38 pointless round trips aimed at a
       registry that is already struggling, which is how a slow dependency becomes a failing one. The
       loop's own check is what prevents that, and this is the assertion that makes it load-bearing
       rather than belt-and-braces nobody would notice losing. */
    assert.ok(stopped.started <= 2,
      `🔴 after the deadline the loop must stop OPENING transactions too — ${stopped.started} were started against a registry that had already timed out`);

    /* 🔴 THE PRESERVE-ONLY RUN, WHICH THE IN-TRANSACTION CHECK CANNOT BOUND AT ALL. ensureIdentity
       returns as soon as it finds an existing key row — before it ever reaches the abandonment check,
       because there is nothing to write and nothing to abandon. That is the ORDINARY case: almost
       every publish preserves rather than mints. So on a normal publish the in-transaction check is
       never consulted, and the loop's own check is the only thing that stops the run at all. Without
       it a timed-out preserve-on-write keeps reading every remaining key, one round trip each, against
       a registry that has already failed its deadline.
       This is the case the mutation sweep found unguarded: disabling the loop check changed nothing
       any test could see, because every existing test minted. */
    {
      const base = memFirestore();
      let started = 0;
      const db = {
        _docs: base._docs,
        collection: (c) => base.collection(c),
        runTransaction: (fn, opts) => (started += 1, base.runTransaction(fn, opts)),
      };
      // Pre-register everything, so the run below is pure preservation — the normal publish.
      await ensureIdentitiesForKeys(db, rid, keys);
      const preRegistered = started;
      assert.ok(preRegistered >= keys.dish.length, `premise — the first pass really registered (${preRegistered} transactions)`);

      // The deadline fires after the first key of the second pass.
      let seen = 0;
      const second = await ensureIdentitiesForKeys(db, rid, keys, { shouldStop: () => seen++ >= 1 });
      const usedAfter = started - preRegistered;

      /* The substantive assertion FIRST, so that when this breaks the failure names the property
         rather than the bookkeeping. `stopped` is a flag a mutant could set while still reading
         everything; the transaction count is the behaviour itself. */
      assert.ok(usedAfter <= 2,
        `🔴 a timed-out PRESERVE run must stop reading too — it opened ${usedAfter} transactions against a registry that had already missed its deadline, and the in-transaction check never fires on this path because a preserved key writes nothing`);
      assert.ok(second.dish.total < keys.dish.length,
        `🔴 …and it must not have walked the whole key set (${second.dish.total} of ${keys.dish.length})`);
      assert.strictEqual(second.stopped, true, 'the preserve-only run reports that it stopped');
      ok(`a preserve-only run stops at the deadline after ${usedAfter} transactions, not ${keys.dish.length + keys.extra.length}`);
    }

    /* NON-VACUITY, and the reproduction of the original defect in the same breath: the identical
       setup WITHOUT the stop signal writes the whole key set after the deadline. Without this the
       assertion above could be passing because the fixture never writes anything. */
    const unstopped = await run(false);
    assert.strictEqual(unstopped.threw, 'identity_preserve_timeout', 'the unbounded run times out identically');
    assert.ok(unstopped.started > 20,
      `non-vacuity: with no stop signal the loop really does open a transaction per key (${unstopped.started})`);
    assert.strictEqual(unstopped.after, expectedRows,
      `🔴 non-vacuity: with no stop signal the abandoned loop lands ALL ${expectedRows} rows after the deadline — the defect this fixes (got ${unstopped.after})`);
    ok(`the preserve-hook deadline abandons mid-transaction: ${stopped.after} rows land after timeout where an unbounded loop lands ${unstopped.after}`);
  }

  // ══ THE COMMIT STALL — WHERE "ZERO LATE WRITES" IS NOT ACHIEVABLE, AND THE CONTRACT SAYS SO ═══
  /* 🔴 THE HONEST LIMIT OF THE DEADLINE, STATED AND MEASURED RATHER THAN OVERCLAIMED.
     The block above stalls a READ, and that one is genuinely abandonable: the callback is still
     running, so re-checking before the first write aborts the whole transaction and nothing commits.
     A stalled COMMIT is a different animal. By then the callback has returned and the commit is with
     the server; there is no callback left to re-check and no client-side way to cancel a submitted
     Firestore commit. Reproduced here: reads finish and writes queue before the deadline, the deadline
     fires with zero rows, and when the commit finally lands the rows appear — late.
     The wrong fixes are worth naming. Deleting the late rows to "clean up" is forbidden outright: a
     retired id stays reserved forever, and a registry that deletes rows to tidy a timeout is a registry
     that can hand a reused id to a different object. Blocking longer just moves the deadline. So the
     contract is bounded abandonment plus idempotent correctness, and this proves both halves:
       · AT MOST the one transaction already committing lands — nothing further is started;
       · what it lands is the CORRECT canonical id, identical to what a normal preserve would write —
         never wrong, only late;
       · and the next publish or backfill finds that row and PRESERVES it, so there is no double-mint
         and no divergence between the registry and the timed-out publish's report.
     Nothing in D1 reads the id, and at D4 the registry is the source of truth rather than any
     publish's report, so a late-but-correct row is harmless. A late-but-WRONG row would not be, which
     is why correctness is asserted here and not assumed. */
  for (const rid of RIDS) {
    const { memFirestore } = require('./identity-fixture');
    const { ensureIdentitiesForKeys, ensureIdentity: _unused, liveKeys } = require('./identity-backfill');
    const { ensureIdentity } = require('./identity-registry');
    const { backfillIdentities } = require('./identity-backfill');
    const { isGrandfathered, encodeKey } = require('./identity-registry');

    const keys = liveKeys(rid, catalogSnapshot(rid));
    const total = keys.dish.length + keys.extra.length;
    const firstKey = keys.dish[0];

    const base = memFirestore();
    let release; const blocked = new Promise((r) => { release = r; });
    let commits = 0, started = 0;
    /* A BUFFERED-COMMIT ADAPTER: reads go through the real transaction, so read-before-write and the
       conflict check still apply; writes are held and applied at commit time, which is the point where
       Firestore is beyond the client's reach. The first commit stalls. */
    const db = {
      _docs: base._docs,
      collection: (c) => base.collection(c),
      runTransaction: async (fn, opts) => {
        started += 1;
        let queued = [];
        const out = await base.runTransaction(async (tx) => {
          queued = [];
          return fn({ get: (r) => tx.get(r), set: (r, v) => queued.push(() => r._set(v)), delete: (r) => queued.push(() => r._delete()) });
        }, opts);
        commits += 1;
        if (commits === 1) await blocked;         // the COMMIT is in flight and cannot be recalled
        queued.forEach((w) => w());
        return out;
      },
    };

    let expired = false, threw = null;
    try {
      await Promise.race([
        ensureIdentitiesForKeys(db, rid, keys, { shouldStop: () => expired }),
        new Promise((_, rej) => setTimeout(() => { expired = true; rej(new Error('identity_preserve_timeout')); }, 40)),
      ]);
    } catch (e) { threw = (e && e.message) || String(e); }

    assert.strictEqual(threw, 'identity_preserve_timeout', `${rid}/commit-stall: premise — the deadline fired`);
    assert.strictEqual(base._docs.size, 0, `${rid}/commit-stall: premise — nothing had landed when it fired`);
    const startedAtDeadline = started;

    release();
    for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 60));

    // ── BOUNDED: at most the one in-flight transaction, and nothing new was ever started ──────────
    /* Captured HERE, before the reconciling backfill below adds the rest — otherwise the number
       reported in the ok() line is the post-reconcile total (76) rather than what actually landed
       late (2), which is exactly the kind of figure that reads as evidence and is not. */
    const landedLate = base._docs.size;
    assert.strictEqual(landedLate, 2,
      `🔴 ${rid}/commit-stall: exactly ONE object's rows may land late — its id row and its key row. ${landedLate} docs landed, against ${total * 2} for an unbounded run`);
    assert.strictEqual(started, startedAtDeadline,
      `🔴 ${rid}/commit-stall: no transaction may be STARTED after the deadline (${started} vs ${startedAtDeadline} at the deadline)`);

    // ── WELL-FORMED: a late identity, not half of one ────────────────────────────────────────────
    const idRows = [...base._docs.keys()].filter((k) => k.includes(`/identity/dish/ids/`));
    const keyRows = [...base._docs.keys()].filter((k) => k.includes(`/identity/dish/keys/`));
    assert.strictEqual(idRows.length, 1, `${rid}/commit-stall: one id row`);
    assert.strictEqual(keyRows.length, 1, `${rid}/commit-stall: one key row`);
    const landedId = idRows[0].split('/').pop();
    const landedKeyDoc = keyRows[0].split('/').pop();
    assert.strictEqual(landedKeyDoc, encodeKey(firstKey),
      `${rid}/commit-stall: the key row is the one for the object that was mid-commit`);
    assert.strictEqual(base._docs.get(keyRows[0]).canonical_id, landedId,
      `🔴 ${rid}/commit-stall: the key row must point at the id row that landed with it — a half-written identity is worse than a late one`);
    assert.strictEqual(base._docs.get(idRows[0]).legacy_key, firstKey,
      `🔴 ${rid}/commit-stall: …and the id row must name the object it belongs to`);

    // ── CORRECT, NOT MERELY BOUNDED: it is the canonical id, not some other id ───────────────────
    if (isGrandfathered(rid, 'dish')) {
      /* The strongest form of the claim, available on the brand where the canonical id is
         deterministic: the late row IS the id this object must have, independently computable. */
      assert.strictEqual(landedId, firstKey,
        `🔴 ${rid}/commit-stall: the late row must carry the canonical id (the grandfathered slug), not an arbitrary one`);
    }
    const resolved = await ensureIdentity(db, { rid, kind: 'dish', legacyKey: firstKey });
    assert.strictEqual(resolved.created, false,
      `🔴 ${rid}/commit-stall: the late row is authoritative — a later call must PRESERVE it, never mint a second identity for the same object`);
    assert.strictEqual(resolved.canonical_id, landedId,
      `🔴 ${rid}/commit-stall: …and resolve to exactly the id that landed late`);

    // ── IDEMPOTENT RECONCILIATION: the next backfill closes the gap and does not disturb it ──────
    const reconcile = await backfillIdentities(db, rid, catalogSnapshot(rid));
    assert.strictEqual(reconcile.dish.total + reconcile.extra.total, total,
      `${rid}/commit-stall: the reconciling run covers every object`);
    assert.strictEqual(reconcile.dish.preserved + reconcile.extra.preserved, 1,
      `🔴 ${rid}/commit-stall: exactly the late lander is preserved — proof the timed-out publish left no duplicate and no orphan`);
    assert.strictEqual(reconcile.dish.created + reconcile.extra.created, total - 1,
      `${rid}/commit-stall: …and everything the deadline abandoned is registered now`);
    assert.strictEqual(reconcile.ids.dish[firstKey], landedId,
      `🔴 ${rid}/commit-stall: the reconciled registry still carries the late row's id — reconciliation must not re-mint`);

    ran(`commitstall:${rid}`);
    ok(`${rid}: a stalled COMMIT lands at most its own ${landedLate} rows (not ${total * 2}), carrying the canonical id, and the next backfill preserves it (${reconcile.dish.created + reconcile.extra.created} created, 1 preserved)`);
  }

  // ══ …AND THROUGH THE REAL PUBLISHER, WHICH IS WHERE THE DEADLINE ACTUALLY LIVES ══════════════
  /* The block above drives ensureIdentitiesForKeys directly. This drives publishVersion — the real
     caller, its real 5s deadline, its real finally — because that is where the late write was
     observed: the publish returned, logged identity_preserve_timeout, and rows appeared afterwards
     when the registry came back. The gate blocks the first read on an /identity/ path specifically, so
     the publish's own transactions (lease, version docs, pointer flip) run untouched and only the
     registry stalls, which is the real outage shape.
     Note this fake writes through immediately rather than buffering to a commit, so "no rows" here is
     not resting on rollback: the abandonment check runs before the transaction's first write, so there
     is no write to roll back. The buffered-commit case is covered by the memFirestore block above and
     by the real engine in test/identity-registry.emulator.test.js. */
  {
    const { makeDb } = require('./firestore-fake');
    const { publishVersion } = require('./catalog-publish');
    const { buildPublishCandidate } = require('../tools/publish-version');
    const rid = 'x_pizza';

    const base = makeDb();
    let release; const blocked = new Promise((r) => { release = r; });
    let identityReads = 0;
    const db = {
      ...base,
      collection: (c) => base.collection(c),
      runTransaction: (fn) => base.runTransaction(async (tx) => fn({
        get: async (ref) => {
          if (ref && typeof ref.path === 'string' && ref.path.includes('/identity/')) {
            identityReads += 1;
            if (identityReads === 1) await blocked;      // the registry stalls; the publish does not
          }
          return tx.get(ref);
        },
        set: (ref, v) => tx.set(ref, v),
        delete: (ref) => tx.delete(ref),
      })),
    };

    const idRows = () => [...base._raw.keys()].filter((k) => k.includes('/identity/')).length;

    const { input, expected } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: '1d' });
    const t0 = Date.now();
    const out = await publishVersion(db, rid, input, { expected });
    const elapsed = Date.now() - t0;

    assert.ok(out && out.versionId, 'premise — the publish itself succeeded; only the registry was stalled');
    assert.ok(identityReads >= 1, 'premise — the registry read really was reached, and really was blocked');
    assert.ok(elapsed >= 4000,
      `premise — the publish waited out the identity deadline rather than skipping it (${elapsed}ms)`);
    assert.strictEqual(idRows(), 0, `🔴 no identity row may exist when the publish returns (found ${idRows()})`);

    release();
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 100));

    assert.strictEqual(idRows(), 0,
      `🔴 THE LATE WRITE: the stalled transaction resumed after the publish had already reported the keys unregistered, and wrote ${idRows()} rows anyway. After the deadline fires, nothing lands.`);
    ok(`the real publisher's identity deadline abandons mid-transaction: 0 rows at return (${elapsed}ms) and 0 after the registry recovers`);
  }

  // ══ THE PROD BACKFILL READS WHAT IS LIVE, NEVER THE CODE TABLES ══════════════════════════════
  /* 🔴 TWO THINGS IN THIS REPO LOOK LIKE "THE MENU" AND ONLY ONE OF THEM IS LIVE.
     catalogSnapshot(rid) BUILDS a snapshot from the code tables; getRestaurantMenu(db, rid) READS the
     published version out of Firestore. They agree today only because the live version was published
     from those same tables — so a tool keyed from code passes every check anyone would think to run,
     right up until a merchant edits through the portal. Then they diverge, and a backfill from code
     mints ids for objects that are not live while the ones that are serve id-less: the same
     wrong-source defect migrate-catalog-display names for prices, in the identity plane.
     The tests in this file legitimately use catalogSnapshot — they have no Firestore. The PROD CLI
     must not, and that is a property of a file nobody runs in this suite, so it is asserted by
     reading it. */
  {
    const fs = require('fs');
    const path = require('path');
    const CLI = path.join(__dirname, '..', 'tools', 'backfill-identities.js');
    assert.ok(fs.existsSync(CLI), '🔴 there is no prod invocation path for the backfill — D1 cannot be deployed without one');
    const src = fs.readFileSync(CLI, 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    assert.ok(/getRestaurantMenu\(db,\s*RID\)/.test(code),
      '🔴 the prod backfill must read the LIVE catalog through getRestaurantMenu');
    assert.ok(!/catalogSnapshot/.test(code),
      '🔴 the prod backfill must NOT build its key set from the code tables — a portal edit would make it register the wrong objects');
    assert.ok(/requireProject\(\)/.test(code) && code.indexOf('requireProject()') < code.indexOf('initializeApp'),
      '🔴 the project guard must run BEFORE initializeApp, so a refusal cannot have touched a byte');
    assert.ok(/--apply/.test(code) && /DRY RUN/.test(code),
      'the tool defaults to a dry run — an apply is stated, never the default');
    // non-vacuity: the detectors can see what they are guarding against
    assert.ok(/catalogSnapshot/.test('const m = catalogSnapshot(rid);'), 'non-vacuity: the code-table detector works');
    assert.ok(!/catalogSnapshot/.test('const m = getRestaurantMenu(db, RID);'), 'non-vacuity: …and does not fire on the live reader');
    ok('the prod backfill CLI exists, reads the LIVE catalog, guards the project before connecting, and dry-runs by default');
  }

  // ── 7. 🔴 THE SHADOW PROOF — grep + runtime ───────────────────────────────────────────────────
  /* D1's licence is that nothing business-critical READS the id. That is a claim about the whole
     repository, not about the paths this file happens to exercise, so it is checked as a census over
     the source AND then confirmed at runtime by the comparisons above.
     A census is a lint, not a proof — it cannot see a field read through a variable — which is exactly
     why it is paired with the identical-output assertions rather than standing in for them. */
  {
    const fs = require('fs');
    const path = require('path');
    const ROOT = path.join(__dirname, '..');
    /* Every module that decides money, availability, rewards or the factura. If the id is read in any
       of these, it is not shadow any more, whatever the behaviour happens to be today. */
    const BUSINESS = [
      'menu-pricing.js', 'availability-gate.js', 'rewards-redeem.js', 'rewards-redeem-pricing.js',
      'compute-server-net.js', 'quote-token.js', 'token-gate.js', 'quote-issue.js',
      'order-money.js', 'factura/pricing.js', 'factura/eligibility.js',
      'catalog/pricing-tables.js', 'catalog/menu-gates.js', 'catalog/snapshot-fallback.js',
    ];
    const offenders = [];
    for (const rel of BUSINESS) {
      const f = path.join(ROOT, rel);
      if (!fs.existsSync(f)) continue;
      // comments stripped: several of these files will discuss identity in prose, and a census that
      // reads its own documentation as evidence is the failure this repo has hit twice.
      const code = fs.readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      if (/\bdish_id\b|\bextra_id\b/.test(code)) offenders.push(rel);
    }
    assert.deepStrictEqual(offenders, [],
      `🔴 a business-deciding module READS the catalog id — it is no longer shadow: ${offenders.join(', ')}`);
    // non-vacuity: the census can see the thing it is looking for
    assert.ok(/\bdish_id\b/.test('const x = rec.dish_id;'), 'non-vacuity: the shadow census detects a read');
    assert.ok(!/\bdish_id\b/.test('const x = rec.dishid;'), 'non-vacuity: …and is not fooled by a near-miss');
    assert.ok(BUSINESS.filter((r) => fs.existsSync(path.join(ROOT, r))).length >= 10,
      `non-vacuity: the census actually inspected the business modules`);
    ok(`shadow: none of ${BUSINESS.length} business-deciding modules reads dish_id/extra_id`);
  }

  // ══ THE AUDIT: EVERY COMPARISON ABOVE ACTUALLY EXECUTED ══════════════════════════════════════
  /* 🔴 THE LAST GAP IN A NO-OP PROOF IS A COMPARISON THAT NEVER RAN. Everything above can be correct,
     falsifiable and non-vacuous and still prove nothing if the branch holding it was skipped — which is
     exactly what happened to the factura check: `if (!usesPlatformFactura(rid))` flipped to true
     printed "no platform factura to compare" and the suite reported all green, one fiscal comparison
     lighter. Asserting the predicate's ANSWER did not catch it, because the answer being right is not
     the same claim as the branch being taken.
     These are exact counts, not minimums. A comparison that stops running fails here; so does one that
     silently starts running twice, which usually means a loop boundary moved. */
  {
    const expected = {
      'pricing:x_pizza': 1, 'pricing:la_musa': 1,
      '86:x_pizza': 1, '86:la_musa': 1,
      'key:x_pizza': 1, 'key:la_musa': 1,
      'reward:x_pizza': 1, 'reward:la_musa': 1,
      'fingerprint:x_pizza': 1, 'fingerprint:la_musa': 1,
      'fallback:x_pizza': 1, 'fallback:la_musa': 1,
      'pricingtimeout:x_pizza': 1, 'pricingtimeout:la_musa': 1,
      'failure:x_pizza': 4, 'failure:la_musa': 4,          // four forced enrichment failures each
      'readerfail:x_pizza': 2, 'readerfail:la_musa': 2,    // content-hash mismatch + torn read
      /* 🔴 THE ONE THE GATE FOUND. x_pizza is the only brand the platform issues factura for, so this
         comparison must run EXACTLY ONCE overall — and la_musa's absence is asserted too, so a
         predicate that started returning true there would also be caught rather than quietly adding a
         comparison that cannot work (pricedLineItems keys by NAME, which la_musa does not use). */
      'factura:x_pizza': 1, 'factura:la_musa': 0,
      // …and the §7 operational-state rows, which are comparisons like any other.
      'interrupted:x_pizza': 1, 'interrupted:la_musa': 1,
      'rollback:x_pizza': 1, 'rollback:la_musa': 1,
      'mixedreaders:x_pizza': 1, 'mixedreaders:la_musa': 1,
      'staleportal:x_pizza': 1, 'staleportal:la_musa': 1,
      'commitstall:x_pizza': 1, 'commitstall:la_musa': 1,
    };
    for (const [what, want] of Object.entries(expected)) {
      assert.strictEqual(ranCount(what), want,
        `🔴 the "${what}" comparison ran ${ranCount(what)} times, expected ${want} — a no-op comparison that does not execute is not a proof, it is a printed line`);
    }
    // Non-vacuity of the audit itself: the counter can tell a run from a skip.
    assert.strictEqual(ranCount('never:registered'), 0, 'non-vacuity: an unrun comparison counts zero');
    ok(`${Object.keys(expected).length} no-op comparisons each executed exactly the expected number of times`);
  }

  console.log(`\nidentity-noop: ${n} checks passed across both brands`);
})().catch((e) => { console.error('identity-noop FAILED:', e && e.message); process.exit(1); });
