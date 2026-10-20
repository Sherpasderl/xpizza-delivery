'use strict';
// access/writes-flag.js — the membership write freeze flag: ONLY the strict boolean true opens writes (fail closed otherwise).
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('../merchant/_fake-db');
const { writesEnabled } = require('./writes-flag');
const T = require('./team-core');

test('writesEnabled: true only for the strict boolean true; missing / other values / a read error → false', async () => {
  assert.strictEqual(await writesEnabled(createFakeDb({})), false, 'missing node');
  for (const v of [false, 'true', 1, {}, ['x']]) assert.strictEqual(await writesEnabled(createFakeDb({ platform_config: { membership_writes_enabled: v } })), false, JSON.stringify(v));
  assert.strictEqual(await writesEnabled(createFakeDb({ platform_config: { membership_writes_enabled: true } })), true);
  const down = createFakeDb({ platform_config: { membership_writes_enabled: true } }); down.failReads.add('platform_config');
  assert.strictEqual(await writesEnabled(down), false, 'a read error fails closed');
  assert.strictEqual(T.writesEnabled, writesEnabled, 'team-core re-exports the same function (one definition)');
});
