// H1b — boot.js: the serialized boot decision and the device-auth watch, across every notification ordering codex r2 reproduced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideBoot, createAuthWatch } from './boot.js';

const saved = { uid: 'hh_tb_norte_a', rid: 'tb_norte' };
const later = (v, ms) => new Promise((r) => setTimeout(() => r(v), ms));
const browserSt = { native: false, blocked: false };
const nativeBlocked = { native: true, blocked: true };

test('decideBoot waits for BOTH the status and the first Auth state, whichever resolves first (P1-1)', async () => {
  // Auth first, status later — the reproduced race: still ONE decision, from both inputs
  assert.deepEqual(await decideBoot({ saved, hasPin: true, statusP: later(nativeBlocked, 20), firstAuthP: later({ uid: saved.uid }, 1) }),
    { route: 'checks', signOut: false, status: nativeBlocked });
  // status first, Auth later
  assert.equal((await decideBoot({ saved, hasPin: true, statusP: later(browserSt, 1), firstAuthP: later({ uid: saved.uid }, 20) })).route, 'main');
});

test('decideBoot routes: foreign uid → sign out; paired + PIN → main / checks; paired no PIN → checks; else login', async () => {
  const d = (o) => decideBoot({ statusP: Promise.resolve(browserSt), firstAuthP: Promise.resolve(null), saved: null, hasPin: false, ...o });
  assert.deepEqual(await d({ saved, hasPin: true, firstAuthP: Promise.resolve({ uid: 'someone_else' }) }), { route: 'login', signOut: true, status: browserSt },
    'a different authenticated uid never reaches the list (P1-1)');
  assert.equal((await d({ saved, hasPin: true })).route, 'main', 'offline cold start: Auth not restored yet (null) → the list, banner until the snapshot');
  assert.equal((await d({ saved, hasPin: true, statusP: Promise.resolve(nativeBlocked) })).route, 'checks', 'the native guard on every boot');
  assert.equal((await d({ saved, hasPin: false, firstAuthP: Promise.resolve({ uid: saved.uid }) })).route, 'checks');
  assert.equal((await d({ saved, hasPin: false })).route, 'login');
  assert.equal((await d({})).route, 'login');
});

test('auth watch: the device sign-in notification BEFORE the controller assigns its session still counts; a later null is a loss (P1-2)', () => {
  const losses = [];
  const w = createAuthWatch({ onLoss: (why) => losses.push(why) });
  w.expect('hh_new');                                  // set BEFORE signInWithCustomToken (pairing)
  w.observe(null);                                     // the pre-sign-in state: not a loss
  w.observe({ uid: 'hh_new' });                        // the sign-in lands (possibly before doPair assigns sess)
  assert.deepEqual(losses, []);
  w.observe(null);                                     // the device identity disappears
  assert.deepEqual(losses, ['signed_out']);
  w.observe(null);
  assert.deepEqual(losses, ['signed_out'], 'reported once');
});

test('auth watch: a different uid is a loss; nothing is watched before expect() or after clear()', () => {
  const losses = [];
  const w = createAuthWatch({ onLoss: (why) => losses.push(why) });
  w.observe({ uid: 'x' }); w.observe(null);
  assert.deepEqual(losses, [], 'not expecting anything yet');
  w.expect('hh_a');
  w.observe({ uid: 'hh_b' });
  assert.deepEqual(losses, ['other_uid']);
  w.clear(); w.observe(null); w.observe({ uid: 'z' });
  assert.deepEqual(losses, ['other_uid'], 'cleared at sign-out');
  w.expect('hh_c'); w.observe({ uid: 'hh_c' }); w.observe(null);
  assert.deepEqual(losses, ['other_uid', 'signed_out'], 're-armed by the next expect()');
});
