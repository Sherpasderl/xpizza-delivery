'use strict';
// Portal 2a Task 8 — the KNOWN-RESTAURANT set becomes registry-driven. Run: node catalog/restaurant-registry.test.js
//
// KNOWN_RESTAURANTS was `Object.keys(MENU_BY_RESTAURANT)` — a restaurant existed because it had a price
// table compiled into the deploy. That is the last hard block on merchant #3: onboarding one required a
// code change and a deploy, no matter how complete their catalog was.
//
// Two hard constraints shape this, and they pull in opposite directions:
//   • THE FLOOR IS ABSOLUTE. The registry may only ADD. If it could remove, a registry read failure
//     would make x_pizza unknown and 400 EVERY order — a total outage caused by a rarely-changing
//     lookup. De-listing is not this gate's job: getRestaurantIdentity's `active` check already
//     rejects a known-but-closed restaurant, which is how la_musa stayed dark pre-launch.
//   • NO PER-ORDER READ. This changes when a merchant is onboarded, not when an order is placed.
//     A cached set with a TTL, warmed once per instance, refreshed in the background.
const assert = require('assert');
const { createRestaurantRegistry } = require('./restaurant-registry');
const { resolveRestaurantId, KNOWN_RESTAURANTS, sameRestaurant } = require('../restaurant-id');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (code) => { if (code === 0 && !FINISHED) { console.error('restaurant-registry: FAILED — exited without completing'); process.exitCode = 1; } });

const FLOOR = [...KNOWN_RESTAURANTS].sort();

(async () => {
  // ── (1) TODAY, UNCHANGED. Every existing answer is byte-identical with a registry in play. ────
  {
    const reg = createRestaurantRegistry({ listIds: async () => ['x_pizza', 'la_musa'] });
    await reg.ready();
    const k = reg.known();
    assert.deepStrictEqual([...k].sort(), FLOOR, 'the registry returns exactly today\'s set for today\'s data');
    for (const [raw, want] of [
      [undefined, { restaurantId: 'x_pizza', error: null, defaulted: true }],
      ['', { restaurantId: 'x_pizza', error: null, defaulted: true }],
      ['   ', { restaurantId: 'x_pizza', error: null, defaulted: true }],
      ['x_pizza', { restaurantId: 'x_pizza', error: null, defaulted: false }],
      ['la_musa', { restaurantId: 'la_musa', error: null, defaulted: false }],
    ]) {
      assert.deepStrictEqual(resolveRestaurantId(raw, k), want, `injected set must not change the answer for ${JSON.stringify(raw)}`);
      assert.deepStrictEqual(resolveRestaurantId(raw, k), resolveRestaurantId(raw), 'and must match the un-injected (code) answer exactly');
    }
    assert.strictEqual(resolveRestaurantId('taco_bell', k).error, 'unknown restaurant_id: taco_bell', 'an unknown id is still a 400, never priced or persisted');
    assert.strictEqual(resolveRestaurantId({}, k).error, 'unknown restaurant_id: [object Object]', 'and a non-string is still coerced and rejected, not crashed');
    ok('store == code: every existing verdict is byte-identical with the registry wired');
  }

  // ── (2) MERCHANT #3 — the point of the task ───────────────────────────────────────────────────
  {
    const reg = createRestaurantRegistry({ listIds: async () => ['x_pizza', 'la_musa', 'pupuseria_lupe'] });
    await reg.ready();
    assert.deepStrictEqual(resolveRestaurantId('pupuseria_lupe', reg.known()),
      { restaurantId: 'pupuseria_lupe', error: null, defaulted: false }, 'a registered merchant is accepted with NO code change');
    assert.strictEqual(resolveRestaurantId('pupuseria_lupe').error, 'unknown restaurant_id: pupuseria_lupe',
      'while the code-static set 400s them — the last hard block on onboarding');
    ok('a registered merchant #3 is accepted with no code change (code-static 400s them)');
  }

  // ── (3) THE FLOOR IS ABSOLUTE — the registry may only ADD ─────────────────────────────────────
  {
    const cases = [
      ['read throws',        async () => { throw new Error('firestore down'); }],
      ['read hangs',         () => new Promise(() => {})],
      ['registry EMPTY',     async () => []],
      ['registry omits x_pizza', async () => ['la_musa', 'pupuseria_lupe']],
      ['not an array',       async () => ({ x_pizza: true })],
      ['null',               async () => null],
      ['garbage entries',    async () => [null, 42, '', '   ', {}, [], 'x'.repeat(500)]],
    ];
    for (const [label, listIds] of cases) {
      const reg = createRestaurantRegistry({ listIds, deadlineMs: 30 });
      await reg.ready();
      const k = reg.known();
      for (const rid of FLOOR) {
        assert.ok(k.has(rid), `${label}: ${rid} must STAY known — losing it 400s every order for a frozen brand`);
        assert.deepStrictEqual(resolveRestaurantId(rid, k), { restaurantId: rid, error: null, defaulted: false }, `${label}: ${rid} still resolves`);
      }
      assert.strictEqual(resolveRestaurantId('taco_bell', k).error, 'unknown restaurant_id: taco_bell', `${label}: and an unknown id is still rejected (no fail-open)`);
      // garbage must not enter the set either
      for (const junk of ['', '   ', '[object Object]', 'x'.repeat(500)]) assert.strictEqual(k.has(junk), false, `${label}: junk "${junk.slice(0, 12)}" must not become a restaurant`);
    }
    ok(`the floor survives all ${cases.length} registry failure modes, and none of them opens the gate`);
  }
  {
    // A LATER read must not drop a merchant the registry already confirmed. Both ways it can go wrong:
    // an outright failure, and a read that comes back EMPTY (which must read as "no news", never as
    // "everyone was de-listed"). ttlMs is deliberately long here — with ttlMs:0 the assertion's own
    // known() call kicks off a background refresh, and refresh() then hands back that in-flight
    // SUCCESS rather than starting the failing read the test intends. It passed for the wrong reason.
    for (const [label, bad] of [['throws', async () => { throw new Error('down'); }], ['returns empty', async () => []], ['returns junk', async () => [null, 7]]]) {
      let mode = null;
      const reg = createRestaurantRegistry({ listIds: async () => (mode ? mode() : ['x_pizza', 'la_musa', 'pupuseria_lupe']), ttlMs: 600000 });
      await reg.ready();
      assert.ok(reg.known().has('pupuseria_lupe'), 'premise: the merchant was seen');
      mode = bad;
      await reg.refresh();                                   // no refresh is in flight — this one really runs
      assert.ok(reg.known().has('pupuseria_lupe'), `a later read that ${label} must not un-onboard a live merchant`);
      for (const rid of FLOOR) assert.ok(reg.known().has(rid), `and the floor holds when a read ${label}`);
    }
    ok('a later read that fails, empties or returns junk keeps the LAST-GOOD set — it never un-onboards');
  }

  // ── (3b) THE SANITIZER, directly. A malformed payload must not be able to INVENT a restaurant id.
  {
    const { sanitize } = require('./restaurant-registry');
    assert.deepStrictEqual(sanitize(['x_pizza', 'la_musa', 'pupuseria_lupe']), ['x_pizza', 'la_musa', 'pupuseria_lupe'], 'non-vacuity: valid ids pass through unchanged');
    assert.deepStrictEqual(sanitize(['  x_pizza  ']), ['x_pizza'], 'and are trimmed');
    for (const notArray of [null, undefined, 0, 'x_pizza', { x_pizza: true }, new Set(['x_pizza'])]) {
      assert.deepStrictEqual(sanitize(notArray), [], `a non-array payload (${typeof notArray}) yields nothing — never a coerced entry`);
    }
    assert.deepStrictEqual(sanitize([null, undefined, 42, true, {}, [], () => {}, Symbol('x')]), [], 'non-string entries are dropped, not stringified');
    assert.deepStrictEqual(sanitize(['', '   ', 'A', 'X_Pizza', 'has space', 'has/slash', 'has.dot', '_lead', 'x'.repeat(500)]), [],
      'blank, single-char, upper-case, and structurally invalid ids are all rejected');
    ok('the sanitizer rejects every malformed payload shape and cannot invent an id');
  }

  // ── (4) NO PER-ORDER READ ─────────────────────────────────────────────────────────────────────
  {
    let reads = 0;
    let t = 1000;
    const reg = createRestaurantRegistry({ listIds: async () => { reads++; return ['x_pizza', 'la_musa']; }, ttlMs: 60000, now: () => t });
    await reg.ready();
    for (let i = 0; i < 200; i++) { reg.known(); await reg.ready(); }
    assert.strictEqual(reads, 1, '200 orders inside the TTL → ONE read (this changes at onboarding, not per order)');
    t += 60001;
    reg.known();                                   // stale → kicks off a BACKGROUND refresh
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(reads, 2, 'past the TTL it refreshes');
    ok('200 orders inside the TTL cost ONE read; the refresh happens on expiry, not on the order');
  }
  {
    // The stale refresh must not BLOCK the order that noticed it, and must not stampede.
    let started = 0, release;
    const gate = new Promise((r) => { release = r; });
    let t = 1000;
    const reg = createRestaurantRegistry({ listIds: async () => { started++; await gate; return ['x_pizza', 'la_musa']; }, ttlMs: 10, now: () => t });
    reg.known(); reg.known(); reg.known(); reg.known();
    assert.strictEqual(started, 1, 'concurrent callers share ONE in-flight refresh (no stampede on a cold instance)');
    assert.deepStrictEqual([...reg.known()].sort(), FLOOR, 'and callers are served the floor immediately rather than waiting');
    release([]);
    await new Promise((r) => setImmediate(r));
    ok('a refresh never blocks the caller that triggered it, and concurrent callers do not stampede');
  }

  // ── (5) COLD START + BOUNDED ──────────────────────────────────────────────────────────────────
  {
    // ready() is what makes the FIRST request on a cold instance correct for a new merchant: without
    // it, request #1 would see the floor only and 400 a legitimately-registered merchant.
    const reg = createRestaurantRegistry({ listIds: async () => ['x_pizza', 'la_musa', 'pupuseria_lupe'] });
    assert.strictEqual(reg.known().has('pupuseria_lupe'), false, 'premise: before ready(), only the floor is known');
    await reg.ready();
    assert.strictEqual(reg.known().has('pupuseria_lupe'), true, 'ready() warms the registry so request #1 is already correct');
    ok('ready() makes the FIRST request on a cold instance correct for a newly-registered merchant');
  }
  {
    const t0 = Date.now();
    const reg = createRestaurantRegistry({ listIds: () => new Promise(() => {}), deadlineMs: 30 });
    await reg.ready();                              // must not hang, must not throw
    assert.ok(Date.now() - t0 < 2000, 'a hung registry read must not hang the order');
    assert.deepStrictEqual([...reg.known()].sort(), FLOOR, 'and the floor still stands');
    ok('bounded: a hung registry read times out into the floor instead of hanging an order');
  }

  // ── (6) sameRestaurant is untouched (legacy orders still compare) ─────────────────────────────
  {
    assert.strictEqual(sameRestaurant(null, 'x_pizza'), true, 'a pre-Phase-0 order with no restaurant_id still matches x_pizza');
    assert.strictEqual(sameRestaurant('la_musa', 'x_pizza'), false, 'and a real mismatch still 409s');
    ok('sameRestaurant is unchanged — legacy idempotent retries still compare correctly');
  }
  {
    // A malformed knownSet (a forgotten await, an array) must degrade to the code floor. This runs at
    // the very TOP of the order handler, so a TypeError here is not a 400 — it is a 500 on every order.
    for (const bad of [Promise.resolve(new Set()), ['x_pizza'], 'x_pizza', {}, 0, true]) {
      assert.deepStrictEqual(resolveRestaurantId('x_pizza', bad), { restaurantId: 'x_pizza', error: null, defaulted: false },
        `a malformed knownSet (${typeof bad}) must fall back to the code floor, not throw`);
      assert.strictEqual(resolveRestaurantId('taco_bell', bad).error, 'unknown restaurant_id: taco_bell', 'and must not open the gate either');
    }
    ok('a malformed injected set degrades to the code floor instead of 500-ing every order');
  }

  // ── (7) WIRING — every call site must consult the registry ────────────────────────────────────
  {
    const CODE = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    // Balanced-paren scan, not a regex: the arguments nest arbitrarily deep — one site passes
    // `(await otpRef.child('rid').get()).val()`. A regex that stops at the first `)` silently reads a
    // truncated argument list and would pass a call site that was never wired.
    const calls = [];
    for (let i = CODE.indexOf('resolveRestaurantId('); i !== -1; i = CODE.indexOf('resolveRestaurantId(', i + 1)) {
      let depth = 0, j = i + 'resolveRestaurantId'.length;
      const start = j + 1;
      for (; j < CODE.length; j++) {
        if (CODE[j] === '(') depth++;
        else if (CODE[j] === ')' && --depth === 0) break;
      }
      calls.push(CODE.slice(start, j));
    }
    assert.ok(calls.every((c) => c.split('(').length === c.split(')').length), 'the scanner must extract balanced argument lists');
    assert.strictEqual(calls.length, 6, `expected exactly the 6 known call sites, found ${calls.length} — a new one would need wiring too`);
    for (const args of calls) {
      assert.ok(/,\s*restaurantRegistry\(\)\.known\(\)\s*$/.test(args.trim()),
        `every call site must pass the LIVE registry set — found resolveRestaurantId(${args})`);
    }
    // the two ORDER handlers must WARM it first, or request #1 on a cold instance 400s a real merchant
    const warms = (CODE.match(/await restaurantRegistry\(\)\.ready\(\);/g) || []).length;
    assert.strictEqual(warms, 2, `both order handlers must warm the registry before resolving (found ${warms})`);
    for (const m of CODE.matchAll(/await restaurantRegistry\(\)\.ready\(\);/g)) {
      const after = CODE.slice(m.index, m.index + 400);
      assert.ok(after.includes('resolveRestaurantId(body.restaurant_id, restaurantRegistry().known())'), 'the warm must immediately precede the resolve it exists for');
    }
    assert.ok(/let _restaurantRegistry = null;/.test(CODE), 'the registry must be a module-level singleton — its cache IS the "no per-order read" property');
    ok(`all ${calls.length} call sites consult the registry, and both order handlers warm it first`);
  }

  console.log(`restaurant-registry: OK (${n})`);
  FINISHED = true;
})().catch((e) => { console.error(e); process.exit(1); });
