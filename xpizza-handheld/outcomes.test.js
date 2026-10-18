// H1b T3 — outcomes.classify: ONE table over H1a's application results ({ok:false, code}) and HttpsErrors (error.code, with any
// 'functions/' prefix stripped). Unknown → terminal, fail closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './outcomes.js';

const err = (code, name = 'FirebaseError') => Object.assign(new Error(code), { code, name });

test('ok: a fresh result and a receipt replay', () => {
  assert.deepEqual(classify({ ok: true }), { class: 'ok', code: null });
  assert.deepEqual(classify({ ok: true, replay: true, state: 'cancelled' }), { class: 'ok', code: null });
});

test('retry: network failure, unavailable, deadline-exceeded, internal (prefixed or not)', () => {
  for (const c of ['unavailable', 'deadline-exceeded', 'internal', 'functions/unavailable', 'functions/deadline-exceeded', 'functions/internal']) {
    assert.equal(classify(err(c)).class, 'retry', c);
  }
  assert.equal(classify(new TypeError('Failed to fetch')).class, 'retry', 'a fetch-level network failure');
  assert.equal(classify({ ok: false, code: 'unavailable' }).class, 'retry');
});

test('terminal: every listed code, as a result or an error', () => {
  for (const c of ['stale_state', 'op_conflict', 'driver_assigned', 'cap_reached', 'not_served', 'not_found', 'bad_stored_state', 'already_requested',
    'bad_input', 'not_enabled']) assert.deepEqual(classify({ ok: false, code: c }), { class: 'terminal', code: c });
  for (const c of ['invalid-argument', 'permission-denied', 'failed-precondition', 'functions/permission-denied', 'functions/failed-precondition']) {
    assert.equal(classify(err(c)).class, 'terminal', c);
  }
  assert.equal(classify({ ok: false, code: 'forbidden' }).class, 'terminal');
});

test('auth: unauthenticated', () => {
  assert.deepEqual(classify(err('functions/unauthenticated')), { class: 'auth', code: 'unauthenticated' });
  assert.equal(classify({ ok: false, code: 'unauthenticated' }).class, 'auth');
});

test('anything unknown fails CLOSED as terminal "error"', () => {
  for (const x of [{ ok: false, code: 'weird' }, { ok: false }, err('functions/resource-exhausted'), null, undefined, 42, 'x', {}, { ok: 'yes' }]) {
    assert.deepEqual(classify(x), { class: 'terminal', code: 'error' }, JSON.stringify(x));
  }
});
