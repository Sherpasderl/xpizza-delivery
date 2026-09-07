// Portal 2b-2a Task 5 — restaurant resolution. Run: node --test xpizza-portal/app.test.mjs
// Only the pure decisions; the DOM rendering is Task 6's surface.
import { test } from 'node:test';
import assert from 'node:assert';
import { pickRid, messageFor } from './portal-logic.js';
import { ApiError } from './api.js';

test('a remembered restaurant is honoured only while it is still owned', () => {
  const owned = [{ rid: 'merch_a', name: 'A' }, { rid: 'merch_b', name: 'B' }];
  assert.strictEqual(pickRid(owned, 'merch_b'), 'merch_b', 'the remembered one, when still owned');
  // Ownership can be REVOKED. A stale localStorage entry must never decide what gets loaded — the
  // server would refuse it anyway, so honouring it would just show an error instead of the restaurant
  // they do still own.
  assert.strictEqual(pickRid(owned, 'merch_gone'), 'merch_a', 'a revoked restaurant falls back to the first owned one');
  assert.strictEqual(pickRid(owned, null), 'merch_a', 'nothing remembered → the first');
  for (const junk of ['', '../merch_a', 42, {}, undefined]) {
    assert.strictEqual(pickRid(owned, junk), 'merch_a', `junk (${JSON.stringify(junk)}) falls back rather than being trusted`);
  }
});

test('owning nothing yields no selection — never a guess', () => {
  for (const empty of [[], null, undefined, 'not an array']) {
    assert.strictEqual(pickRid(empty, 'merch_a'), null, 'with nothing owned there is nothing to open');
  }
});

test('failures become sentences a merchant can act on, and an outage is not a permissions problem', () => {
  const outage = messageFor(new ApiError('Unavailable', 503));
  const denied = messageFor(new ApiError('NotAuthorized', 403));
  assert.notDeepStrictEqual(outage, denied, 'these must not read the same');
  assert.match(outage[1], /problema nuestro/i, 'an outage says it is ours, so nobody re-authenticates over it');
  assert.match(denied[0], /acceso/i, 'a refusal says it is about access');
  // every kind produces a real pair, and an unknown error never leaks a stack or an object
  for (const e of [new ApiError('NotSignedIn', 401), new ApiError('NotFound', 404), new Error('boom'), null, undefined]) {
    const [t, d] = messageFor(e);
    assert.ok(typeof t === 'string' && t.length > 4, 'a title');
    assert.ok(typeof d === 'string' && d.length > 4, 'and a detail');
    assert.ok(!/\[object|undefined|Error:/.test(t + d), 'never a JS artefact on screen');
  }
});
