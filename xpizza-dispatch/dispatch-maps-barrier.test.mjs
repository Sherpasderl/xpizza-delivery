// dispatch-maps-barrier.test.mjs — PLAN-dispatch-maps-decouple §4 (r5-P2 + r6-P1).
//
// Proves the opt-in authed-write barrier on the REAL SDK code: when the host's registered predicate reports
// the session superseded, every authed write — the four RTDB primitives, the shared HTTP authedFetch — refuses
// with a typed `auth/session-superseded` rejection and issues NO underlying write/network. Default (no guard,
// or guard=false) passes straight through. Plus the static tripwire: the firebase write primitives appear
// exactly once each (their wrappers) and no new write primitive is imported.
//
// The SDK imports the Firebase CDN (not importable in node), so we lift the barrier section's source verbatim
// and run it over stubs — the same extract-and-run pattern the other dispatch suites use. Reverting any guard
// in the source makes these RED.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, 'xpizza-delivery.js'), 'utf8');

// ── Lift the real barrier code (guard hook + guarded primitives + authedFetch) and run it over stubs. ──
function loadBarrier() {
  const calls = { fbSet: 0, fbUpdate: 0, fbRemove: 0, fbRunTransaction: 0, sherpaTrack: 0, sherpaFetch: 0, getIdToken: 0 };
  // Extract the guard block through the four guarded primitive aliases.
  const guardStart = SRC.indexOf('let authedRequestGuard = null;');
  const primEnd = SRC.indexOf('fbRunTransaction(...a));', guardStart);
  assert.ok(guardStart !== -1 && primEnd !== -1, 'barrier guard block must be present in source');
  const guardBlock = SRC.slice(guardStart, primEnd + 'fbRunTransaction(...a));'.length).replace(/\bexport\s+/g, '');
  // Extract the authedFetch function.
  const afStart = SRC.indexOf('async function authedFetch(');
  const afEnd = SRC.indexOf('\n}', afStart);
  assert.ok(afStart !== -1 && afEnd !== -1, 'authedFetch must be present in source');
  const authedFetchSrc = SRC.slice(afStart, afEnd + 2);

  const harness = `
    'use strict';
    // stubs for the primitives/helpers the lifted code closes over
    const fbSet = (...a) => { calls.fbSet++; return Promise.resolve('set'); };
    const fbUpdate = (...a) => { calls.fbUpdate++; return Promise.resolve('update'); };
    const fbRemove = (...a) => { calls.fbRemove++; return Promise.resolve('remove'); };
    const fbRunTransaction = (...a) => { calls.fbRunTransaction++; return Promise.resolve('tx'); };
    const sherpaTrack = (p) => { calls.sherpaTrack++; return p; };
    const sherpaFetch = (u, o) => { calls.sherpaFetch++; return Promise.resolve({ ok: true, _url: u, _o: o }); };
    const auth = { currentUser: { getIdToken: async () => { calls.getIdToken++; return 'TOKEN'; } } };
    let exported;
    const __exportGuard = (fn) => { exported = fn; };   // capture setAuthedRequestGuard's effect indirectly
    ${guardBlock}
    ${authedFetchSrc}
    return { set, update, remove, runTransaction, authedFetch, setAuthedRequestGuard, authWriteBarred, supersededError };
  `;
  // eslint-disable-next-line no-new-func
  const api = new Function('calls', harness)(calls);
  return { ...api, calls };
}

test('RTDB primitives + authedFetch pass through when no guard is registered (inert default)', async () => {
  const b = loadBarrier();
  await b.set('refA', { x: 1 });
  await b.update('refB', { y: 2 });
  await b.remove('refC');
  await b.runTransaction('refD', () => {});
  const res = await b.authedFetch('https://fn/x', { a: 1 });
  assert.equal(b.calls.fbSet, 1);
  assert.equal(b.calls.fbUpdate, 1);
  assert.equal(b.calls.fbRemove, 1);
  assert.equal(b.calls.fbRunTransaction, 1);
  assert.equal(b.calls.sherpaFetch, 1);
  assert.equal(b.calls.getIdToken, 1);
  assert.equal(res.ok, true);
  // header carries the Bearer token
  assert.match(res._o.headers.Authorization, /^Bearer TOKEN$/);
});

test('guard returning FALSE still passes through', async () => {
  const b = loadBarrier();
  b.setAuthedRequestGuard(() => false);
  await b.set('r', {});
  await b.authedFetch('https://fn/y', {});
  assert.equal(b.calls.fbSet, 1);
  assert.equal(b.calls.sherpaFetch, 1);
});

test('guard returning TRUE bars every RTDB write — typed rejection, NO underlying write', async () => {
  const b = loadBarrier();
  b.setAuthedRequestGuard(() => true);
  for (const [name, fn] of [['set', () => b.set('r', {})], ['update', () => b.update('r', {})],
                            ['remove', () => b.remove('r')], ['runTransaction', () => b.runTransaction('r', () => {})]]) {
    await assert.rejects(fn(), (e) => e.code === 'auth/session-superseded', `${name} must reject when barred`);
  }
  assert.equal(b.calls.fbSet, 0, 'no fbSet issued');
  assert.equal(b.calls.fbUpdate, 0, 'no fbUpdate issued');
  assert.equal(b.calls.fbRemove, 0, 'no fbRemove issued');
  assert.equal(b.calls.fbRunTransaction, 0, 'no fbRunTransaction issued');
});

test('guard returning TRUE bars authedFetch BEFORE token/network', async () => {
  const b = loadBarrier();
  b.setAuthedRequestGuard(() => true);
  await assert.rejects(b.authedFetch('https://fn/z', { a: 1 }), (e) => e.code === 'auth/session-superseded');
  assert.equal(b.calls.getIdToken, 0, 'no ID token minted when barred');
  assert.equal(b.calls.sherpaFetch, 0, 'no network request issued when barred');
});

test('a guard that flips mid-operation bars the LATER write (re-checked per write, not at entry)', async () => {
  const b = loadBarrier();
  let superseded = false;
  b.setAuthedRequestGuard(() => superseded);
  await b.runTransaction('claim', () => {});   // claim succeeds under A
  assert.equal(b.calls.fbRunTransaction, 1);
  superseded = true;                           // session replaced between the claim and the finalize/rollback
  await assert.rejects(b.update('finalize', {}), (e) => e.code === 'auth/session-superseded');
  assert.equal(b.calls.fbUpdate, 0, 'the post-await finalize/rollback write is barred under B');
});

// ── Static tripwire: no write can bypass the four wrappers, and no new write primitive is imported. ──
test('tripwire: each firebase write primitive is referenced exactly once (its wrapper)', () => {
  for (const fn of ['fbSet', 'fbUpdate', 'fbRemove', 'fbRunTransaction']) {
    const n = (SRC.match(new RegExp('\\b' + fn + '\\s*\\(', 'g')) || []).length;
    assert.equal(n, 1, `${fn}( must appear exactly once (its guarded wrapper); found ${n}`);
  }
});

test('tripwire: the firebase-database import pulls in NO un-aliased or extra write primitive', () => {
  // Grab the firebase-database import block.
  const m = SRC.match(/import\s*\{([\s\S]*?)\}\s*from\s*'https:\/\/www\.gstatic\.com\/firebasejs\/[^']*firebase-database\.js'/);
  assert.ok(m, 'firebase-database import block must be present');
  const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  // Any write-capable primitive must be imported ONLY under its fb* alias (so raw calls can't bypass the guard).
  const WRITE_PRIMS = ['set', 'update', 'remove', 'runTransaction', 'push', 'setWithPriority', 'onDisconnect', 'child'];
  for (const spec of names) {
    const [orig, , alias] = spec.split(/\s+as\s+|\s+/);
    const imported = spec.includes(' as ') ? spec.split(/\s+as\s+/)[0].trim() : spec;
    if (WRITE_PRIMS.includes(imported)) {
      const localName = spec.includes(' as ') ? spec.split(/\s+as\s+/)[1].trim() : imported;
      assert.match(localName, /^fb[A-Z]/, `write primitive '${imported}' must be imported as fb*… (got '${localName}') so it cannot bypass the guarded wrappers`);
    }
  }
});

test('tripwire: dismissDispatcherAlert routes its update through the guarded wrapper (no raw fbUpdate bypass)', () => {
  assert.doesNotMatch(SRC, /await\s+fbUpdate\s*\(/, 'no `await fbUpdate(` — the :636 bypass must route through guarded `update`');
});
