// Portal 2b-2a Task 4 — the login error map. Run: node --test xpizza-portal/auth-errors.test.mjs
//
// A login form is an anonymous surface: anyone can type an address into it. If it answers differently
// for "no account" than for "wrong password", it becomes an account-enumeration oracle — type an email,
// learn whether that person is a merchant. Firebase merges the two into auth/invalid-credential on
// current SDKs, but still emits auth/user-not-found on older paths, so the map has to merge them again
// rather than trusting the SDK to have done it.
import { test } from 'node:test';
import assert from 'node:assert';
import { authErrorMessage } from './auth-errors.js';

test('every credential-shaped failure returns the SAME message (no account enumeration)', () => {
  const codes = ['auth/invalid-credential', 'auth/user-not-found', 'auth/wrong-password', 'auth/invalid-email'];
  const msgs = new Set(codes.map(authErrorMessage));
  assert.strictEqual(msgs.size, 1, `these must be indistinguishable, got: ${[...msgs].join(' | ')}`);
  // and the shared message must not hint at which one it was
  const [msg] = [...msgs];
  for (const leak of ['no existe', 'not found', 'no encontrad', 'contraseña incorrecta', 'usuario']) {
    assert.ok(!msg.toLowerCase().includes(leak), `the shared message must not hint at the cause ("${leak}")`);
  }
});

test('conditions that say nothing about whether an account exists DO get their own message', () => {
  // These change what the person should do next, and none of them reveals whether the address is a
  // merchant — so distinguishing them is useful rather than leaky.
  const distinct = ['auth/too-many-requests', 'auth/network-request-failed', 'auth/user-disabled'];
  const shared = authErrorMessage('auth/invalid-credential');
  for (const c of distinct) {
    assert.notStrictEqual(authErrorMessage(c), shared, `${c} should be actionable, not merged`);
    assert.ok(authErrorMessage(c).length > 10, `${c} should say something useful`);
  }
  assert.strictEqual(new Set(distinct.map(authErrorMessage)).size, 3, 'and they differ from each other');
});

test('an unknown or absent code falls back to a generic message, never to undefined or a raw code', () => {
  for (const c of ['auth/something-new-in-a-future-sdk', '', null, undefined, 42, {}]) {
    const m = authErrorMessage(c);
    assert.strictEqual(typeof m, 'string', `a ${typeof c} code still yields a string`);
    assert.ok(m.length > 10, 'and a real sentence');
    assert.ok(!m.includes('auth/'), 'never echoing the raw error code back at the merchant');
    assert.ok(!/undefined|null|\[object/.test(m), 'and never leaking a JS artefact into the UI');
  }
});

test('an operator-misconfiguration code is generic AND never echoes the URL it contains', () => {
  // A real code observed against production: the API key is HTTP-referrer restricted, so an
  // un-allowlisted origin gets
  //   auth/requests-from-referer-http://127.0.0.1:8791-are-blocked.
  // Two things matter. The merchant cannot act on it, so it must read as the generic failure — and the
  // code EMBEDS AN ORIGIN, so echoing raw codes to the screen (a tempting shortcut while debugging)
  // would put an internal URL in front of them.
  const code = 'auth/requests-from-referer-http://127.0.0.1:8791-are-blocked.';
  const m = authErrorMessage(code);
  assert.strictEqual(m, authErrorMessage('some/unknown-code'), 'it falls back to the generic message');
  assert.ok(!m.includes('127.0.0.1') && !m.includes('http'), 'and never leaks the origin the code carries');
});

test('messages are in Spanish, like the rest of the product', () => {
  const all = ['auth/invalid-credential', 'auth/too-many-requests', 'auth/network-request-failed', 'auth/user-disabled', 'zzz'].map(authErrorMessage);
  for (const m of all) assert.ok(/[áéíóúñ¿]|de |la |el |no /i.test(m), `expected Spanish, got: ${m}`);
});
