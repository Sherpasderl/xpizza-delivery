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

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const RIDS = ['x_pizza', 'la_musa'];
const tablesOf = (rid) => ({ restaurantId: rid, menu: MENU_BY_RESTAURANT[rid], extras: EXTRAS_BY_RESTAURANT[rid] });

/* A registry stub that resolves every key — the WORST case for a no-op claim, because it is the state
   in which identity is most present. Testing the no-op against an empty registry would prove only that
   absent ids change nothing, which is trivially true and not the claim. */
function fullRegistry(bodyByRid) {
  return {
    collection: (c) => ({
      doc: (rid) => ({
        collection: (c2) => ({
          doc: (kind) => ({
            collection: (c3) => ({
              doc: (encodedKey) => ({
                get: async () => {
                  const key = Buffer.from(encodedKey, 'base64url').toString('utf8');
                  return { exists: true, data: () => ({ canonical_id: `ID_${kind}_${key}` }) };
                },
              }),
            }),
          }),
        }),
      }),
    }),
  };
}

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

(async () => {
  for (const rid of RIDS) {
    const plain = generateFormBundle(rid, catalogSnapshot(rid));
    const enriched = (await applyIdentityToServedBody(fullRegistry(), rid, plain)).body;

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
      ok(`${rid}: pricing is byte-identical with and without identity (${without.total})`);
    }

    // ── 2. 🔴 THE PRICING KEY IS UNMOVED ───────────────────────────────────────────────────────
    // The one thing that would break every downstream consumer at once.
    {
      for (const d of enriched.dishes) {
        const plainRec = plain.dishes.find((p) => p.id === d.id);
        assert.strictEqual(itemPricingKey(d, rid), itemPricingKey(plainRec, rid),
          `${rid}: 🔴 the id changed which key a served dish resolves to`);
      }
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
        // …and the menu still prices, which is the only thing the customer needs.
        const priced = computeServerTotal(cartFrom(rid, out.body, false), rid, tablesOf(rid));
        assert.ok(!priced.error && priced.total > 0, `${rid}/${label}: 🔴 the menu still prices (${priced.error})`);
      }
      ok(`${rid}: ${Object.keys(failures).length} forced enrichment failures each serve the original body and still price`);
    }

    // ── 6. 🔴 IDENTITY NEVER ENTERS A NUMERIC TABLE ────────────────────────────────────────────
    {
      const tables = tablesOf(rid);
      await applyIdentityToServedBody(fullRegistry(), rid, plain);
      for (const [label, table] of [['menu', tables.menu], ['extras', tables.extras]]) {
        assert.ok(Object.values(table).every((v) => typeof v === 'number'),
          `${rid}: 🔴 the ${label} price table must stay numbers only — identity is metadata, never money data`);
        assert.ok(!Object.keys(table).some((k) => k.startsWith('ID_')),
          `${rid}: 🔴 …and no id became a key in it`);
      }
      ok(`${rid}: the numeric price tables are untouched — values still numbers, keys still legacy`);
    }
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

  console.log(`\nidentity-noop: ${n} checks passed across both brands`);
})().catch((e) => { console.error('identity-noop FAILED:', e && e.message); process.exit(1); });
