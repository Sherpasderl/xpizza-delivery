'use strict';
// R1c — test/_catalog-clock.js, driven through the REAL factories (catalog.js, menu-gates.js, restaurant-registry.js),
// each cell in its own process: install() is once per process and rewrites module exports.
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const CELL = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REAL_NOW = Date.now.bind(Date);
// wall time jumping ahead WITHOUT the virtual clock moving: the hooked caches must not notice. The offset Date.now is
// installed NOW, before any factory is built — a factory default (`now = Date.now`) captures the function at construction,
// so reassigning Date.now later would move nothing an UNHOOKED reader sees and the wall checks would be vacuous (r1c-01).
let WALL_OFFSET = 0;
Date.now = () => REAL_NOW() + WALL_OFFSET;
const jumpWallClock = (ms) => { WALL_OFFSET += ms; };

const CELLS = {
  // the PRICING pointer (catalog.js, 45 s): frozen under wall time, refilled exactly at the virtual TTL
  async pricingPointer() {
    const C = require('./_catalog-clock').install();
    const { createCatalogReader } = require('../catalog/catalog');
    let pointerReads = 0;
    const r = createCatalogReader({
      getRestaurantDocs: async () => ({ versionId: 'v1', seq: 1, itemDocs: [], extraDocs: [] }),
      getActiveVersionId: async () => { pointerReads += 1; return 'v1'; },
    });
    await r.getTables('x_pizza'); await r.getTables('x_pizza');
    assert.strictEqual(pointerReads, 1, 'premise — one pointer read, then cached');
    jumpWallClock(10 * 60000);
    await r.getTables('x_pizza');
    assert.strictEqual(pointerReads, 1, '🔴 wall time moved 10 min and the hooked pricing pointer refilled — real time still drives it');
    C.advance(45000 - 1); await r.getTables('x_pizza');
    assert.strictEqual(pointerReads, 1, 'one ms short of the TTL: still cached');
    C.advance(1); await r.getTables('x_pizza');
    assert.strictEqual(pointerReads, 2, '🔴 advancing the virtual clock to the TTL did not refill the pricing pointer');
    assert.deepStrictEqual(C.built(), { createCatalogReader: 1 });
    return 'pricing pointer (45 s): wall time +10 min → no refill; virtual +44 999 ms → cached; +1 ms → exactly one refill';
  },
  // the GATE pointer (menu-gates.js, 45 s)
  async gatePointer() {
    const C = require('./_catalog-clock').install();
    const { createGateReader } = require('../catalog/menu-gates');
    let pointerReads = 0;
    const g = createGateReader({ getVersionId: async () => { pointerReads += 1; return null; }, getMenu: async () => null });
    await g.intakeGatesFor('x_pizza'); await g.intakeGatesFor('x_pizza');
    assert.strictEqual(pointerReads, 1, 'premise — one gate pointer read, then cached');
    jumpWallClock(10 * 60000);
    await g.intakeGatesFor('x_pizza');
    assert.strictEqual(pointerReads, 1, '🔴 wall time moved 10 min and the hooked gate pointer refilled');
    C.advance(45000); await g.intakeGatesFor('x_pizza');
    assert.strictEqual(pointerReads, 2, '🔴 advancing the virtual clock past the TTL did not refill the gate pointer');
    return 'gate pointer (45 s): wall time +10 min → no refill; virtual +45 s → exactly one refill';
  },
  // the RESTAURANT REGISTRY (5 min, background refresh)
  async registry() {
    const C = require('./_catalog-clock').install();
    const { createRestaurantRegistry } = require('../catalog/restaurant-registry');
    let lists = 0;
    const reg = createRestaurantRegistry({ listIds: async () => { lists += 1; return ['r3_synthetic']; } });
    reg.known(); await sleep(20); reg.known(); await sleep(20);
    assert.strictEqual(lists, 1, 'premise — one registry read, then cached');
    jumpWallClock(60 * 60000); reg.known(); await sleep(20);
    assert.strictEqual(lists, 1, '🔴 wall time moved 1 h and the hooked registry refreshed');
    C.advance(300000); reg.known(); await sleep(20);
    assert.strictEqual(lists, 2, '🔴 advancing the virtual clock past the TTL did not refresh the registry');
    return 'restaurant registry (5 min): wall time +1 h → no refresh; virtual +5 min → exactly one refresh';
  },
  // the DEADLINE-bearing factories keep the REAL clock; only their TTL is held
  async heldNotFrozen() {
    const seen = {};
    for (const [rel, name] of [['../catalog/context-source', 'createContextSource'], ['../catalog/catalog-verifier', 'createCatalogVerifier']]) {
      require(rel)[name] = (opts) => { seen[name] = opts; return {}; };   // a spy UNDER the hook: it sees exactly what the hook passes on
    }
    const { HOLD_MS } = require('./_catalog-clock');
    require('./_catalog-clock').install();
    require('../catalog/context-source').createContextSource({ db: 'D' });
    require('../catalog/catalog-verifier').createCatalogVerifier({ db: 'D' });
    assert.strictEqual(seen.createContextSource.recordTtlMs, HOLD_MS, 'context record TTL held');
    assert.strictEqual(seen.createContextSource.now, undefined, '🔴 the context source got a clock — its read deadline would freeze');
    assert.strictEqual(seen.createCatalogVerifier.ttlMs, HOLD_MS, 'verifier observation TTL held');
    assert.strictEqual(seen.createCatalogVerifier.now, undefined, '🔴 the verifier got a clock — its read timeout would freeze');
    assert.strictEqual(seen.createContextSource.db, 'D', 'the caller\'s options pass through');
    return 'context source + verifier: TTL held for the run, NO clock injected (their read deadlines stay on real time)';
  },
  // OBSERVED loads (codex R1c P2): the caller's own full-load / list sources are wrapped, not replaced — each call logged
  async observesLoads() {
    const C = require('./_catalog-clock').install();
    const { createCatalogReader } = require('../catalog/catalog');
    const { createRestaurantRegistry } = require('../catalog/restaurant-registry');
    let docs = 0;
    const r = createCatalogReader({ getRestaurantDocs: async (rid) => { docs += 1; return { versionId: `v-${rid}`, seq: 1, itemDocs: [], extraDocs: [] }; }, getActiveVersionId: async (rid) => `v-${rid}` });
    const m0 = C.loads().length;
    await r.getTables('x_pizza');
    assert.deepStrictEqual(C.coldSince(m0), ['x_pizza'], '🔴 the first (COLD) load of x_pizza was not observed');
    const m1 = C.loads().length;
    await r.getTables('x_pizza');
    assert.deepStrictEqual(C.coldSince(m1), [], '🔴 a WARM call was observed as a cold load');
    await r.getTables('la_musa');
    assert.deepStrictEqual(C.coldSince(m1), ['la_musa'], 'each restaurant\'s cold load is attributed to its rid');
    assert.strictEqual(docs, 2, 'the caller\'s own source still ran (wrapped, not replaced)');
    const reg = createRestaurantRegistry({ listIds: async () => ['r3_synthetic'] });
    reg.known(); await sleep(20);
    assert.deepStrictEqual(C.loads().filter((x) => x.kind === 'registry').length, 1, '🔴 the registry list read was not observed');
    return 'observed loads: a COLD load is attributed to its rid (a warm call is not); the registry list read is logged; the caller\'s sources still run';
  },
  // a caller that already passes the option is REFUSED (the hook would silently override production wiring)
  async refusesOverride() {
    require('./_catalog-clock').install();
    const { createCatalogReader } = require('../catalog/catalog');
    assert.throws(() => createCatalogReader({ getRestaurantDocs: async () => ({}), now: Date.now }), /was passed 'now' by its caller/);
    const { createContextSource } = require('../catalog/context-source');
    assert.throws(() => createContextSource({ recordTtlMs: 1 }), /was passed 'recordTtlMs'/);
    return 'a caller passing the injected option (now / recordTtlMs) is refused loudly';
  },
  // install AFTER index.js loaded would hook nothing the singletons use → refused; twice → refused
  async orderOfInstall() {
    const INDEX = require.resolve('../index.js');
    require.cache[INDEX] = { id: INDEX, filename: INDEX, loaded: true, exports: {} };   // index.js "already loaded"
    assert.throws(() => require('./_catalog-clock').install(), /index\.js is ALREADY loaded/);
    delete require.cache[INDEX];
    require('./_catalog-clock').install();
    assert.throws(() => require('./_catalog-clock').install(), /called twice/);
    return 'install() after index.js has loaded is refused; a second install() is refused';
  },
  // assertBuilt: a singleton NOT built through the hook (or built twice) is RED
  async assertBuilt() {
    const C = require('./_catalog-clock').install();
    assert.throws(() => C.assertBuilt(['createCatalogReader'], 'probe'), /built 0× through the clock hook/);
    const { createCatalogReader } = require('../catalog/catalog');
    createCatalogReader({ getRestaurantDocs: async () => ({}) });
    C.assertBuilt(['createCatalogReader'], 'probe');
    createCatalogReader({ getRestaurantDocs: async () => ({}) });
    assert.throws(() => C.assertBuilt(['createCatalogReader'], 'probe'), /built 2×/);
    return 'assertBuilt: 0 or 2 constructions through the hook are RED; exactly 1 (the singleton) is green';
  },
};

if (CELL) {
  CELLS[CELL]().then((label) => { console.log(`CELL-OK ${label}`); }).catch((e) => { console.error(e && e.stack || e); process.exit(1); });
} else {
  // HERMETIC child env: the cells need none of the parent's NODE_OPTIONS, so it is DROPPED, never parsed. The gate runs
  // every suite under NODE_OPTIONS="--require <abs>/tools/count-marks.js"; token-filtering that (R1c's first version kept
  // only the short `-r <path>` pair in mind) left a dangling `--require` and every child died at startup.
  const childEnv = (env) => { const e = { ...env }; delete e.NODE_OPTIONS; return e; };
  const runCell = (name, env) => spawnSync(process.execPath, [__filename, name], { encoding: 'utf8', env: childEnv(env), cwd: path.join(__dirname, '..') });
  let n = 0;
  for (const name of Object.keys(CELLS)) {
    const r = runCell(name, process.env);
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('CELL-OK '));
    assert.ok(r.status === 0 && line, `🔴 cell ${name} failed:\n${r.stdout}\n${r.stderr}`);
    console.log(`  ✓ ${++n} ${line.slice('CELL-OK '.length)}`);
  }
  // the gate's inherited preload, in every spelling: a cell spawned through childEnv still boots and passes
  {
    const CM = path.join(__dirname, '..', 'tools', 'count-marks.js');
    assert.ok(require('fs').existsSync(CM), 'premise — tools/count-marks.js exists (the gate preload)');
    const shapes = [`--require ${CM}`, `-r ${CM}`, `--require=${CM}`, `--max-old-space-size=4096 --require ${CM}`];
    for (const NODE_OPTIONS of shapes) {
      const r = runCell('assertBuilt', { ...process.env, NODE_OPTIONS });
      assert.ok(r.status === 0 && /CELL-OK /.test(r.stdout || ''), `🔴 a cell spawned under the inherited gate preload NODE_OPTIONS="${NODE_OPTIONS}" did not boot:\n${r.stdout}\n${r.stderr}`);
    }
    console.log(`  ✓ ${++n} hermetic child env: a cell spawned under the gate's inherited count-marks preload (${shapes.length} spellings, incl. --require <abs>) boots and passes`);
  }
  console.log(`\ncatalog-clock: OK (${n})`);
}
