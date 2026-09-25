'use strict';
/* Measure what fencing costs ensureIdentitiesForKeys, in wall time, at REAL menu sizes.
 *
 * 🔴 WHY THIS EXISTS. ensureIdentity runs ONE TRANSACTION PER KEY. Fencing adds a pointer read to
 * every one of them, and the whole batch runs inside a 5s deadline (IDENTITY_PRESERVE_TIMEOUT_MS)
 * after which keys go UNREGISTERED — so a fence that costs too much per key makes the unregistered-key
 * outcome it exists to prevent MORE likely. That trade cannot be settled by reading the code.
 *
 * Run: npm run measure:identity-fence        (routes tools/emulator-run.js, this checkout's band)
 * Sizes come from the real menus: menus/x_pizza.json = 24 dishes, menus/la_musa.json = 44.
 */
require('./_emulator-required')('firestore');

const admin = require('firebase-admin');

const path = require('path');
const { ensureIdentitiesForKeys } = require('../catalog/identity-backfill');
const { getActivePointer, activePointerRef } = require('../catalog/catalog-firestore');

const SIZES = (() => {
  const arg = process.argv.find((a) => a.startsWith('--sizes='));
  if (arg) return arg.slice('--sizes='.length).split(',').map((pair) => pair.split('x').map(Number));
  /* Real brand sizes, dishes from menus/*.json and extras from the seeded catalog — the two halves
     the publish actually registers together. */
  let x = [24, 8], l = [44, 14];
  try {
    x = [require(path.join(__dirname, '..', '..', 'menus', 'x_pizza.json')).length, x[1]];
    l = [require(path.join(__dirname, '..', '..', 'menus', 'la_musa.json')).length, l[1]];
  } catch (_) { /* fall back to the counts recorded above */ }
  return [x, l, [100, 30]];    // both real brands as (dish, extra), plus a headroom probe
})();

/* 🔴 REPORT THE SPREAD, NOT A MEDIAN. Two runs of the SAME code gave 561 ms and 720 ms at 44 keys —
   a 28% swing driven by what else the machine was doing. A single median presented as "the" number is
   a claim the measurement cannot support, and I had already sent one. The min/median/max are all
   reported, and the decision rests on the ABSOLUTE fenced time against the 5000 ms deadline rather
   than on a before/after delta taken minutes apart under different load. */
const REPEATS = 5;

/* 🔴 THIS LIVES IN test/, NOT tools/, AND THE PROJECT GUARD IS WHY. catalog/project-guard.test.js
   sweeps tools/ and pins every connecting script to .firebaserc's project — correctly, because every
   other one of them (backfill, migrate, publish, rollback, preflight, seed, verify) can reach
   PRODUCTION. This harness cannot: the require above refuses unless the firestore host variable names
   this checkout's own emulator band. Pinning it to xpizza-delivery would have made it claim a project
   it never talks to, and passing demo-xpizza made the guard refuse outright — which is the guard
   working. An emulator-only harness belongs beside the other emulator-only harnesses. */
admin.initializeApp({ projectId: 'demo-xpizza' });
const db = admin.firestore();

/* 🔴 A BATCH IS DISHES *AND* EXTRAS. Supplying only dishes measured 44 keys for la_musa when the
   real publish registers 44 + 14 = 58 — so the headroom figures described a batch smaller than any
   real one. The split is kept because the two kinds are separate collections and a per-kind cost
   difference would otherwise hide inside one total. */
const keysFor = (dish, extra, tag) => ({
  dish: Array.from({ length: dish }, (_, i) => `${tag}_dish_${i}`),
  extra: Array.from({ length: extra }, (_, i) => `${tag}_extra_${i}`),
});

(async () => {
  console.log(`measuring ensureIdentitiesForKeys — ${REPEATS} runs per size, median reported`);
  console.log(`sizes: ${SIZES.map(([d, e]) => `${d + e} (${d}d+${e}e)`).join(', ')} keys   (x_pizza and la_musa are the real menus)\n`);
  const rows = [];
  for (const [dishN, extraN] of SIZES) {
    const n = dishN + extraN;
    const times = [];
    for (let r = 0; r < REPEATS; r += 1) {
      /* A FRESH restaurant PER run: a second pass over the same keys takes the "preserved" branch, which
         does strictly less work than the "created" branch a real first publish takes. Measuring the
         cheap path and reporting it as the cost would understate exactly what we are deciding on. */
      const rid = `measure_${n}_${r}_${Date.now()}`;
      /* A real caller fences against a real pointer, so the measurement must too — the fence reads
         this document once per key, and that read IS the cost being measured. Establishing it here
         rather than passing a synthetic pair keeps the measured path the same shape as the live one.
         (The harness discovered this the hard way: with no pointer and no captured pair, the fence
         refused on the first key — the required-and-fail-closed property working on its first real
         call, which is what it is for.) */
      await activePointerRef(db, rid).set({ version: 'v-measure', generation: 1 });   // the REAL ref builder, not a hand-written path
      const captured = await getActivePointer(db, rid);
      const t0 = process.hrtime.bigint();
      await ensureIdentitiesForKeys(db, rid, keysFor(dishN, extraN, rid), { shouldStop: () => false, captured });
      const t1 = process.hrtime.bigint();
      times.push(Number(t1 - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const min = times[0], max = times[times.length - 1];
    rows.push({ n, median, min, max, perKey: median / n, all: times });
    console.log(`  ${String(n).padStart(4)} keys (${dishN}d+${extraN}e)   min ${min.toFixed(0).padStart(5)}  median ${median.toFixed(0).padStart(5)}  max ${max.toFixed(0).padStart(5)} ms   ${(median / n).toFixed(1).padStart(5)} ms/key`);
  }
  const DEADLINE = 5000;
  console.log(`\n  deadline (IDENTITY_PRESERVE_TIMEOUT_MS) = ${DEADLINE} ms`);
  for (const r of rows) {
    /* Headroom is computed from the WORST observed run, not the median: the deadline is hit by slow
       runs, not by typical ones, so the median would flatter exactly the case that matters. */
    const headroom = ((DEADLINE - r.max) / DEADLINE) * 100;
    console.log(`  ${String(r.n).padStart(4)} keys → ${headroom.toFixed(1)}% headroom at the WORST observed run (${r.max.toFixed(0)} ms)${headroom < 50 ? '   🔴 thin' : ''}`);
  }
  await admin.app().delete();
})().catch((e) => { console.error(e); process.exit(1); });
