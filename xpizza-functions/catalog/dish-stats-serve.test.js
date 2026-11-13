'use strict';
// PLAN-3a-capp-member-reads (3) R2.10 / R3.3 — catalog/dish-stats-serve.js: the re-allowlist (the producer's own thresholds), the
// priority + cap, the WORST-CASE byte budget that SETS DISH_STATS_MAX (N fits, N + 1 does not), the 1.5 s deadline, in-flight dedupe,
// and the 10 min / 60 s memo. Entries come from the REAL producer (ratings/aggregate.js publish). Run: node catalog/dish-stats-serve.test.js
const assert = require('assert');
const DS = require('./dish-stats-serve');
const AG = require('../ratings/aggregate');
const { canonicalJson } = require('./canonical-json');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const quiet = (f) => { const w = console.warn; console.warn = () => {}; return Promise.resolve().then(f).finally(() => { console.warn = w; }); };
const bodyOf = (ids) => ({ dishes: ids.map((id, i) => ({ id: `d${i}`, name: `Dish ${i}`, dish_id: id })) });
const fresh = () => ({ memo: new Map(), inflight: new Map() });
const DAY = 86400000;

(async () => {
  // ── 1. the REAL producer's doc, served through the re-allowlist ──
  {
    const NOW = Date.UTC(2026, 10, 13, 12);
    const buckets = {};
    // 25 orders/day of A+B together and 21/day of C alone ⇒ orders_30d and a 125-co-order pair A~B
    for (const d of [...AG.windowDays(NOW, 30)].slice(0, 5)) buckets[d] = { v: AG.BUCKET_VERSION, orders: 46, dish: { AAAAAAAAAA: 25, BBBBBBBBBB: 25, CCCCCCCCCC: 21 }, pairs: { 'AAAAAAAAAA~BBBBBBBBBB': 25 }, cust: {} };
    const ratings = Array.from({ length: 22 }, (_, i) => ({ state: 'live', restaurant_id: 'r1', rated_at: NOW - DAY, dishes: { AAAAAAAAAA: i < 18 ? 1 : -1 } }));
    const doc = AG.publish({ rid: 'r1', nowMs: NOW, buckets, ratings, priceOf: () => 5000, firstServedAt: null });
    assert.ok(doc.dish_stats && doc.dish_stats.AAAAAAAAAA && doc.dish_stats.AAAAAAAAAA.pairs, `premise: the real producer published dish_stats (${JSON.stringify(doc.dish_stats)})`);
    const body = bodyOf(['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC']);
    const out = DS.selectDishStats(doc.dish_stats, body);
    assert.deepStrictEqual(out, doc.dish_stats, '🔴 a valid producer doc over served ids is served unchanged');
    assert.deepStrictEqual(Object.keys(out), ['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC'], 'priority order: top_rank 1, 2, 3');
  }
  ok('the REAL producer\'s doc (orders_30d, top_rank, up/down/votes, pairs) over served dish ids is served unchanged, in priority order');

  // ── 2. the re-allowlist: never trust the doc ──
  {
    const body = bodyOf(['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC']);
    const raw = {
      AAAAAAAAAA: { up: 15, down: 5, votes: 20, orders_30d: 40, top_rank: 1, pairs: [{ dishId: 'BBBBBBBBBB', count: 30 }, { dishId: 'ZZZZZZZZZZ', count: 30 }, { dishId: 'AAAAAAAAAA', count: 30 }, { dishId: 'CCCCCCCCCC', count: 14 }], secret: 'x', price: 1 },
      BBBBBBBBBB: { up: 10, down: 9, votes: 19, orders_30d: 19, top_rank: 4 },                    // below every threshold ⇒ absent
      CCCCCCCCCC: { up: 10, down: 10, votes: 21, orders_30d: '25', top_rank: 0, pairs: 'x' },     // votes ≠ up + down; non-int ⇒ absent
      ZZZZZZZZZZ: { orders_30d: 99, top_rank: 1 },                                                 // a FOREIGN id (not served)
      '__proto__': { orders_30d: 50 },
    };
    const out = DS.selectDishStats(raw, body);
    assert.deepStrictEqual(out, { AAAAAAAAAA: { up: 15, down: 5, votes: 20, orders_30d: 40, top_rank: 1, pairs: [{ dishId: 'BBBBBBBBBB', count: 30 }] } }, '🔴 re-allowlisted field by field');
    assert.strictEqual(DS.selectDishStats({ AAAAAAAAAA: { orders_30d: DS.COUNT_MAX + 1 } }, body), null, '🔴 a count wider than COUNT_MAX is malformed ⇒ dropped');
    assert.strictEqual(DS.selectDishStats({ AAAAAAAAAA: { votes: 20, up: 20, down: 0, orders_30d: 20 } }, { dishes: [{ id: 'x' }] }), null, '🔴 a body with no dish_id (overlay not applied) ⇒ nothing to join ⇒ none');
    for (const bad of [null, 'x', 7, [], [{ orders_30d: 30 }]]) assert.strictEqual(DS.selectDishStats(bad, body), null, `malformed doc ${JSON.stringify(bad)} ⇒ none`);
    const four = DS.allowEntry('AAAAAAAAAA', { pairs: ['BBBBBBBBBB', 'CCCCCCCCCC', 'DDDDDDDDDD', 'EEEEEEEEEE'].map((dishId) => ({ dishId, count: 20 })) }, new Set(['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC', 'DDDDDDDDDD', 'EEEEEEEEEE']));
    assert.strictEqual(four.pairs.length, AG.T.PAIRS_MAX, '🔴 ≤ PAIRS_MAX pairs');
    assert.strictEqual(DS.allowEntry('AAAAAAAAAA', { pairs: [{ dishId: 'BBBBBBBBBB', count: 20 }, { dishId: 'BBBBBBBBBB', count: 20 }] }, new Set(['BBBBBBBBBB'])).pairs.length, 1, 'a duplicated partner once');
  }
  ok('re-allowlist: only served ids; up/down/votes only when votes = up + down ≥ DISH_VOTES; orders_30d ≥ DISH_ORDERS; top_rank 1..TOP; pairs ≤ PAIRS_MAX, partner served, not self, once, count ≥ PAIR; forged keys, foreign ids, over-wide counts, malformed docs dropped');

  // ── 3. priority + cap ──
  {
    const ids = Array.from({ length: 40 }, (_, i) => `D${String(i).padStart(9, '0')}`);
    const raw = {};
    ids.forEach((id, i) => { raw[id] = { orders_30d: 20 + (i % 7) * 10, ...(i % 3 === 0 ? { up: 20, down: i % 5, votes: 20 + (i % 5) } : {}) }; });
    raw[ids[39]].top_rank = 1; raw[ids[38]].top_rank = 2; raw[ids[37]].top_rank = 3;
    const out = DS.selectDishStats(raw, bodyOf(ids));
    const keys = Object.keys(out);
    assert.strictEqual(keys.length, DS.DISH_STATS_MAX, '🔴 at most DISH_STATS_MAX dishes (short ids: the cap binds, not the budget)');
    assert.deepStrictEqual(keys.slice(0, 3), [ids[39], ids[38], ids[37]], '🔴 top_rank first');
    const rest = keys.slice(3).map((k) => raw[k]);
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i - 1], b = rest[i];
      assert.ok(a.orders_30d > b.orders_30d || (a.orders_30d === b.orders_30d && ((a.votes || 0) > (b.votes || 0) || ((a.votes || 0) === (b.votes || 0) && keys[i + 2] < keys[i + 3]))), `🔴 then orders_30d desc, votes desc, id (${i})`);
    }
  }
  ok(`priority + cap: top_rank first, then orders_30d desc, votes desc, dish id; at most DISH_STATS_MAX (${DS.DISH_STATS_MAX}) dishes`);

  // ── 4. R3.3: the WORST CASE sets DISH_STATS_MAX — N fits DISH_STATS_BYTES, N + 1 does not ──
  {
    const ID_LEN = 48;   // the catalog id maximum (catalog/add-product.js slugify slice(0, 48)); minted registry ids are 10
    const idOf = (i) => `w${String(i).padStart(ID_LEN - 1, '0')}`;
    const ids = Array.from({ length: 200 }, (_, i) => idOf(i));
    const W6 = DS.COUNT_MAX;   // every count at its max digit width (6)
    const worstEntry = (i) => ({ up: 500000, down: 499999, votes: W6, orders_30d: W6, ...(i < AG.T.TOP ? { top_rank: i + 1 } : {}),
      pairs: [1, 2, 3].map((k) => ({ dishId: idOf((i + k) % 200), count: W6 })) });
    const raw = Object.fromEntries(ids.map((id, i) => [id, worstEntry(i)]));
    const bytesFor = (k) => Buffer.byteLength(canonicalJson(Object.fromEntries(ids.slice(0, k).map((id, i) => [id, worstEntry(i)]))));
    let N = 0; while (bytesFor(N + 1) <= DS.DISH_STATS_BYTES) N += 1;
    assert.strictEqual(DS.DISH_STATS_MAX, N, `🔴 DISH_STATS_MAX must be the largest N whose worst case fits ${DS.DISH_STATS_BYTES} B: N = ${N} (${bytesFor(N)} B; N + 1 = ${bytesFor(N + 1)} B)`);
    const served = DS.selectDishStats(raw, bodyOf(ids));
    const b = Buffer.byteLength(canonicalJson(served));
    assert.strictEqual(Object.keys(served).length, N, '🔴 the worst case serves exactly N dishes');
    assert.ok(b <= DS.DISH_STATS_BYTES, `🔴 the served worst case is ${b} B ≤ ${DS.DISH_STATS_BYTES} B`);
    assert.ok(bytesFor(N + 1) > DS.DISH_STATS_BYTES, 'N + 1 does not fit (the constant cannot drift loose)');
  }
  ok(`R3.3 worst case (200 dishes, 48-char ids, every count at 6 digits, every field, 3 pairs each): DISH_STATS_MAX = ${DS.DISH_STATS_MAX} fits ≤ ${DS.DISH_STATS_BYTES} B; N + 1 does not`);

  // ── 5. never failing: deadline, rejection, dedupe, memo ──
  {
    const body = bodyOf(['AAAAAAAAAA']);
    const good = { AAAAAAAAAA: { orders_30d: 30, top_rank: 1 } };
    // a NEVER-SETTLING read ⇒ served within the deadline + ε, without dish_stats
    let s = fresh(); const t0 = Date.now();
    // bounded on the TEST's clock too, so a decoration that lost its deadline FAILS here instead of hanging the suite
    const r1 = await quiet(() => Promise.race([DS.withDishStats('r1', body, { ...s, timeoutMs: 150, read: () => new Promise(() => {}) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('🔴 no deadline: a never-settling read hung the decoration')), 3000))]));
    const took = Date.now() - t0;
    assert.ok(!('dish_stats' in r1) && took < 150 + 400, `🔴 a never-settling read ⇒ served in ${took} ms, without dish_stats`);
    // the default deadline is the plan's 1.5 s — well inside the 20 s function timeout
    assert.strictEqual(DS.DISH_STATS_TIMEOUT_MS, 1500);
    // a rejected read ⇒ omitted
    s = fresh();
    assert.ok(!('dish_stats' in await quiet(() => DS.withDishStats('r1', body, { ...s, read: async () => { throw new Error('boom'); } }))), '🔴 a rejected read ⇒ omitted');
    // 2 concurrent requests ⇒ 1 read
    s = fresh(); let reads = 0; let release; const gate = new Promise((res) => { release = res; });
    const read = async () => { reads += 1; await gate; return good; };
    const pa = DS.withDishStats('r1', body, { ...s, read }); const pb = DS.withDishStats('r1', body, { ...s, read });
    release(); const [a, b] = await Promise.all([pa, pb]);
    assert.strictEqual(reads, 1, '🔴 two concurrent requests share ONE read');
    assert.deepStrictEqual([a.dish_stats, b.dish_stats], [good, good]);
    // success memo: 10 min
    let now = 1000; const clock = () => now;
    s = fresh(); reads = 0; const r = async () => { reads += 1; return good; };
    await DS.withDishStats('r1', body, { ...s, read: r, now: clock });
    now += DS.OK_TTL_MS - 1; await DS.withDishStats('r1', body, { ...s, read: r, now: clock });
    assert.strictEqual(reads, 1, '🔴 a success is reused for 10 min');
    now += 2; await DS.withDishStats('r1', body, { ...s, read: r, now: clock });
    assert.strictEqual(reads, 2, 'after 10 min it re-reads');
    // failure memo: 60 s
    s = fresh(); reads = 0; now = 1000; const f = async () => { reads += 1; throw new Error('down'); };
    await quiet(() => DS.withDishStats('r1', body, { ...s, read: f, now: clock }));
    now += DS.FAIL_TTL_MS - 1; const again = await quiet(() => DS.withDishStats('r1', body, { ...s, read: f, now: clock }));
    assert.strictEqual(reads, 1, '🔴 a failure is NOT re-read within 60 s'); assert.ok(!('dish_stats' in again));
    now += 2; await quiet(() => DS.withDishStats('r1', body, { ...s, read: f, now: clock }));
    assert.strictEqual(reads, 2, 'after 60 s it retries');
    // per rid: another rid reads on its own
    s = fresh(); reads = 0;
    await DS.withDishStats('r1', body, { ...s, read: r }); await DS.withDishStats('r2', body, { ...s, read: r });
    assert.strictEqual(reads, 2, 'memo and dedupe are per rid');
    // the default reader is ONE point read of public_stats/{rid}/dish_stats
    const paths = []; const db = { ref: (p) => { paths.push(p); return { once: async () => ({ val: () => good }) }; } };
    s = fresh(); const viaDb = await DS.withDishStats('r9', body, { ...s, rtdb: db });
    assert.deepStrictEqual(paths, ['public_stats/r9/dish_stats'], '🔴 the default read is ONE point read of public_stats/{rid}/dish_stats');
    assert.deepStrictEqual(viaDb.dish_stats, good);
  }
  ok('never failing: a never-settling read serves within the deadline without dish_stats; a rejection ⇒ omitted; 2 concurrent ⇒ 1 read; success memo 10 min; failure memo 60 s; per rid; ONE point read of public_stats/{rid}/dish_stats');

  console.log(`\ndish-stats-serve: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\ndish-stats-serve: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
process.on('uncaughtException', (e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\ndish-stats-serve: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
