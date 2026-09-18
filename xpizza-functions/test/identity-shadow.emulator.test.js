'use strict';
// Portal 1D · D3 — THE SHADOW VALIDATOR AGAINST A REAL, REALLY-BACKFILLED REGISTRY.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:identity-shadow
//
// 🔴 WHAT ONLY THIS FILE CAN PROVE. catalog/identity-shadow.test.js covers the verdict logic and the
// contract around it against a fixture — right for those claims, and it runs on every `npm test`. But
// two claims cannot be made against a fixture at all:
//   · that a check actually RESOLVES against a registry the real backfill wrote — the wrong-handle bug
//     produces "no mismatches" forever, and only a live read distinguishes that from a clean run;
//   · that two REAL exchanged ids read as `swapped` — a swap is the shape every field-level check
//     passes, so the ids have to come from the real writer rather than from a literal I chose.
// Uses the demo project id, which the Admin SDK cannot route to production however it is invoked.
const assert = require('assert');
const admin = require('firebase-admin');
const { backfillIdentities, liveKeys } = require('../catalog/identity-backfill');
const { lookupByLegacyKeys } = require('../catalog/identity-registry');
const { catalogSnapshot } = require('../catalog/generate-form-bundle');
const { shadowValidateIds } = require('../catalog/identity-shadow-validate');
const { keyOf } = require('../catalog/identity-overlay');

admin.initializeApp({ projectId: 'demo-xpizza' });     // FIRESTORE_EMULATOR_HOST set by emulators:exec
const fs = admin.firestore();
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-shadow(emulator): FAILED — exited without completing'); process.exitCode = 1; } });

/* A cart line in the shape D2 emits, built from a REAL catalog record so its legacy key is the one the
   backfill actually minted against — composed through the same resolver, never hand-keyed. */
const lineFor = (rid, rec, dishId) => {
  const d = rec.display;
  return { ...(rid === 'la_musa' ? { id: d.id, cat: d.cat } : {}), name: d.name, qty: 1, price: rec.price, extras: [],
    ...(dishId ? { dish_id: dishId } : {}) };
};

(async () => {
  for (const rid of ['x_pizza', 'la_musa']) {
    const menu = catalogSnapshot(rid);
    const report = await backfillIdentities(fs, rid, menu);
    assert.ok(report.dish.total > 0, `${rid}: premise — the REAL backfill registered ${report.dish.total} dishes`);
    const keys = liveKeys(rid, menu);
    const ids = await lookupByLegacyKeys(fs, { rid, kind: 'dish', legacyKeys: keys.dish });
    const extraIds = await lookupByLegacyKeys(fs, { rid, kind: 'extra', legacyKeys: keys.extra });

    // ── 1. 🔴 LIVENESS — A REAL CHECK RESOLVES AGAINST THE REAL REGISTRY ──────────────────────
    /* THE TEST THE WRONG-HANDLE DEFECT WOULD HAVE FAILED. Passing RTDB makes every read fail, and
       because a read failure is deliberately not a mismatch, the validator reports a clean "no
       mismatches" forever. `resolved > 0` is the only thing that distinguishes a validator that is
       working from one that is silently checking nothing. */
    {
      const rec = menu.items[0];
      const key = keyOf(rid, rec.display);
      const items = [lineFor(rid, rec, ids.get(key))];
      const r = await shadowValidateIds(fs, rid, items);
      assert.strictEqual(r.status, 'ok', `${rid}: the check resolved (${r.status})`);
      assert.ok(r.checked > 0, `${rid}: it checked something`);
      assert.ok(r.resolved > 0, `🔴 ${rid}: it RESOLVED against the registry — this is the liveness proof`);
      assert.deepStrictEqual(r.mismatches, [], `${rid}: a correctly-claimed id is not a mismatch`);
      ok(`${rid}: a real id-carrying cart resolves against the real registry (checked ${r.checked}, resolved ${r.resolved})`);
    }

    // ── 2. 🔴 THE SWAP — TWO REAL OBJECTS' REAL IDS, EXCHANGED ────────────────────────────────
    /* The load-bearing case, and the reason the reverse lookup exists. Both ids are genuine registry
       values, both lines are genuine catalog records, every field is individually valid — a
       field-level check passes both. Only asking the registry what each KEY maps to sees it. */
    {
      const [a, b] = [menu.items[0], menu.items[1]];
      const ka = keyOf(rid, a.display); const kb = keyOf(rid, b.display);
      const idA = ids.get(ka); const idB = ids.get(kb);
      assert.ok(idA && idB && idA !== idB, `${rid}: premise — two REAL, distinct registry ids`);
      const swapped = [lineFor(rid, a, idB), lineFor(rid, b, idA)];   // exchanged
      const r = await shadowValidateIds(fs, rid, swapped);
      assert.strictEqual(r.mismatches.length, 2, `🔴 ${rid}: BOTH exchanged lines are caught`);
      assert.ok(r.mismatches.every((m) => m.reason === 'swapped'), `${rid}: …as swapped, not unregistered`);
      assert.strictEqual(r.mismatches[0].registry_id, idA, `${rid}: the report names what the registry actually holds`);
      assert.strictEqual(r.mismatches[0].id, idB, `${rid}: …and what was claimed`);
      ok(`${rid}: an exchanged pair of REAL ids is caught as swapped on both lines`);
    }

    // ── 3. KEY AGREEMENT — DISH AND NESTED EXTRA, THROUGH THE REAL RESOLVER ───────────────────
    /* A line keyed by the helper must resolve the SAME row the backfill wrote. A hand-rolled key
       (`extra.name || extra.id`) would miss on one brand and report every option as unregistered —
       a validator manufacturing the anomaly it exists to detect. */
    {
      const rec = menu.items[0]; const ex = menu.extras[0];
      const dishKey = keyOf(rid, rec.display); const extraKey = keyOf(rid, ex.display);
      const line = lineFor(rid, rec, ids.get(dishKey));
      line.extras = [{ ...(rid === 'la_musa' ? { id: ex.display.id, qty: 1 } : { instance: 0 }),
        name: ex.display.name, price: ex.price, extra_id: extraIds.get(extraKey) }];
      const r = await shadowValidateIds(fs, rid, [line]);
      assert.strictEqual(r.checked, 2, `${rid}: the dish AND its nested option are both checked`);
      assert.strictEqual(r.resolved, 2, `🔴 ${rid}: both resolve — the helper's key matches the backfill's on both levels`);
      assert.deepStrictEqual(r.mismatches, [], `${rid}: and neither is a mismatch`);
      ok(`${rid}: dish and nested extra both key to the rows the real backfill wrote`);
    }

    // ── 4. AN UNREGISTERED KEY IS A REPORTABLE GAP, NOT A SWAP ────────────────────────────────
    {
      const fake = { display: { id: 'never_seeded_99', name: 'Never Seeded Dish', cat: 'x' }, price: 100 };
      const r = await shadowValidateIds(fs, rid, [lineFor(rid, fake, 'SOMEIDXXXX')]);
      assert.strictEqual(r.mismatches.length, 1, `${rid}: the gap is reported`);
      assert.strictEqual(r.mismatches[0].reason, 'unregistered_key',
        `🔴 ${rid}: a key the registry never saw is unregistered_key — NOT swapped, which would send staff hunting a swap that never happened`);
      assert.strictEqual(r.mismatches[0].registry_id, null, `${rid}: with nothing on the registry side`);
      ok(`${rid}: a post-backfill dish reports unregistered_key, distinct from a swap`);
    }

    // ── 5. absent IS SILENT EVEN WITH A LIVE REGISTRY ─────────────────────────────────────────
    {
      const rec = menu.items[0];
      const r = await shadowValidateIds(fs, rid, [lineFor(rid, rec, null)]);   // no dish_id
      assert.deepStrictEqual({ checked: r.checked, absent: r.absent, mismatches: r.mismatches, status: r.status },
        { checked: 0, absent: 1, mismatches: [], status: 'ok' },
        `🔴 ${rid}: an id-less line is counted absent and reported nowhere — D1 serves id-less by design`);
      ok(`${rid}: an id-less line against a live registry is silent`);
    }
  }

  // ── 6. la_musa's NEAR-TAUTOLOGY IS `ok`, NOT SPURIOUS ────────────────────────────────────────
  /* la_musa grandfathers its slug, so legacy key == canonical id == dish_id and the assertion is
     nearly circular. Worth asserting anyway: the value of D3 is on x_pizza, where the id is a minted
     token and the key is a name, and a validator that mis-handled the degenerate case would look
     broken on the brand where it matters least and be trusted on the one where it matters most. */
  {
    const menu = catalogSnapshot('la_musa');
    const keys = liveKeys('la_musa', menu);
    const ids = await lookupByLegacyKeys(fs, { rid: 'la_musa', kind: 'dish', legacyKeys: keys.dish });
    const rec = menu.items[0]; const key = keyOf('la_musa', rec.display);
    assert.strictEqual(ids.get(key), key, 'premise — the slug IS the canonical id on la_musa');
    const r = await shadowValidateIds(fs, 'la_musa', [lineFor('la_musa', rec, key)]);
    assert.deepStrictEqual(r.mismatches, [], '🔴 the grandfathered claim classifies ok, not spuriously mismatched');
    assert.strictEqual(r.resolved, 1, '…and it really resolved');
    ok('la_musa\'s slug==id claim is ok, not a false mismatch');
  }

  FINISHED = true;
  console.log(`identity-shadow(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('IDENTITY SHADOW (EMULATOR) FAILED:', (e && e.stack) || e); process.exit(1); });
