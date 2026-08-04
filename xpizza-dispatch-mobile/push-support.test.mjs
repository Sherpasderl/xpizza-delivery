import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushSupport } from './push-support.js';

const base = { standalone: true, iosVersion: 16.4, hasServiceWorker: true, hasPushManager: true, permission: 'default' };
test('all good → ok', () => assert.equal(pushSupport(base).reason, 'ok'));
test('not installed (iOS) → not-installed', () =>
  assert.equal(pushSupport({ ...base, standalone: false }).reason, 'not-installed'));
test('iOS < 16.4 → ios-too-old', () =>
  assert.equal(pushSupport({ ...base, iosVersion: 16.1 }).reason, 'ios-too-old'));
test('no PushManager → unsupported', () =>
  assert.equal(pushSupport({ ...base, hasPushManager: false }).reason, 'unsupported'));
test('permission denied → denied', () =>
  assert.equal(pushSupport({ ...base, permission: 'denied' }).reason, 'denied'));
test('granted counts as ok', () =>
  assert.equal(pushSupport({ ...base, permission: 'granted' }).ok, true));
