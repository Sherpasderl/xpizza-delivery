'use strict';
// Unit cells for test/_config-warm.js: the hook injects its clock into the REAL factories, warm() forces exactly one fresh
// read per live reader (and a value written meanwhile is the one served), and a caller passing `now` is refused.
const assert = require('assert');
const CF = require('../client-floor');
const EI = require('../catalog/extras-intake');
const CFG = require('./_config-warm').install();

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  let floorReads = 0; let floorVal = null;
  const db = { ref: () => ({ get: async () => { floorReads += 1; return { val: () => floorVal }; } }) };
  const floor = CF.createFloorReader({ getDb: () => db, log: { error() {} } });
  let modeReads = 0; let modeVal = 'off';
  const extras = EI.createExtrasModeReader({ read: async () => { modeReads += 1; return modeVal; } });
  assert.deepStrictEqual(CFG.built(), { floor: 1, extras: 1 }, 'both readers built through the hook');

  await floor.floorFor('orders'); await floor.floorFor('orders');
  await extras.getMode(); await extras.getMode();
  assert.deepStrictEqual([floorReads, modeReads], [1, 1], 'premise: inside the TTL each reader reads once (cached after)');
  ok('premise: the hooked readers cache within their TTL');

  floorVal = 2; modeVal = 'enforce';
  await CFG.warm();
  assert.deepStrictEqual([floorReads, modeReads], [2, 2], 'warm() forces exactly one fresh read per reader');
  assert.deepStrictEqual(await floor.floorFor('orders'), { floor: 2, source: 'cache' }, 'after warm the NEW floor is served from cache');
  assert.deepStrictEqual(await extras.getMode(), { mode: 'enforce', stale: false }, 'after warm the NEW mode is served from cache');
  assert.deepStrictEqual([floorReads, modeReads], [2, 2], 'and the request after warm reads nothing');
  ok('warm(): one fresh read per reader, outside the request; a value written before it is what the next request sees, from cache');

  assert.throws(() => CF.createFloorReader({ getDb: () => db, now: Date.now }), /passed 'now'/, 'a caller passing now is refused');
  assert.throws(() => EI.createExtrasModeReader({ read: async () => 'off', now: Date.now }), /passed 'now'/, 'a caller passing now is refused');
  ok('a caller that passes its own clock is refused (the hook never silently overrides production wiring)');

  CF.createFloorReader({ getDb: () => db });
  await assert.rejects(CFG.warm(), /built 2×/, 'a second live floor reader makes warm() refuse');
  ok('warm() refuses when a reader was built more than once (an unhooked second instance would stay cold)');
  console.log('config-warm: OK');
})().catch((e) => { console.error(e); process.exit(1); });
