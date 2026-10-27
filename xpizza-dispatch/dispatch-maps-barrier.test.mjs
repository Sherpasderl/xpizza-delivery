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

// Brace-matched slice of a top-level `[export] [async] function NAME(…) { … }`.
function sliceFn(src, header) {
  const start = src.indexOf(header);
  assert.ok(start !== -1, `source must contain: ${header}`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces for ${header}`);
}

// ── Lift the REAL barrier code (guard hook + guarded primitives + authedFetch + sendTestPush) over stubs. ──
function loadBarrier(opts = {}) {
  const calls = { fbSet: 0, fbUpdate: 0, fbRemove: 0, fbRunTransaction: 0, sherpaTrack: 0, sherpaFetch: 0, getIdToken: 0, onToken: null };
  const guardStart = SRC.indexOf('let authedRequestGuard = null;');
  const primEnd = SRC.indexOf('fbRunTransaction(...a));', guardStart);
  assert.ok(guardStart !== -1 && primEnd !== -1, 'barrier guard block must be present in source');
  const guardBlock = SRC.slice(guardStart, primEnd + 'fbRunTransaction(...a));'.length).replace(/\bexport\s+/g, '');
  let authedFetchSrc = sliceFn(SRC, 'async function authedFetch(');
  let sendTestPushSrc = sliceFn(SRC, 'export async function sendTestPush()').replace(/\bexport\s+/g, '');
  // Mutation hooks (prove the guards are load-bearing): strip them and the behavior must change.
  if (opts.stripSendTestPushGuards) sendTestPushSrc = sendTestPushSrc.replace(/\s*if \(authWriteBarred\(\)\) return \{ httpStatus: 0, reason: 'superseded' \};[^\n]*/g, '');
  if (opts.stripAuthedFetchRecheck) authedFetchSrc = authedFetchSrc.replace(/\s*if \(authWriteBarred\(\)\) throw supersededError\(\);\s*\/\/ re-check[^\n]*/g, '');

  const harness = `
    'use strict';
    const fbSet = (...a) => { calls.fbSet++; return Promise.resolve('set'); };
    const fbUpdate = (...a) => { calls.fbUpdate++; return Promise.resolve('update'); };
    const fbRemove = (...a) => { calls.fbRemove++; return Promise.resolve('remove'); };
    const fbRunTransaction = (...a) => { calls.fbRunTransaction++; return Promise.resolve('tx'); };
    const sherpaTrack = (p) => { calls.sherpaTrack++; return p; };
    const sherpaFetch = (u, o) => { calls.sherpaFetch++; return Promise.resolve({ ok: true, status: 200, json: async () => ({}), _url: u, _o: o }); };
    const functionUrl = (n) => 'https://fn/' + n;
    // getIdToken awaits; calls.onToken lets a test flip the session DURING the token await (P1-2 window).
    const auth = { currentUser: { getIdToken: async () => { calls.getIdToken++; if (calls.onToken) await calls.onToken(); return 'TOKEN'; } } };
    ${guardBlock}
    ${authedFetchSrc}
    ${sendTestPushSrc}
    return { set, update, remove, runTransaction, authedFetch, sendTestPush, setAuthedRequestGuard, authWriteBarred, supersededError };
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

test('P1-2 authedFetch: session barred DURING the token await ⇒ reject, ZERO network calls', async () => {
  const b = loadBarrier();
  let barred = false;
  b.setAuthedRequestGuard(() => barred);
  b.calls.onToken = () => { barred = true; };   // the session is superseded while getIdToken awaits
  await assert.rejects(b.authedFetch('https://fn/x', { a: 1 }), (e) => e.code === 'auth/session-superseded');
  assert.equal(b.calls.getIdToken, 1, 'the token await happened');
  assert.equal(b.calls.sherpaFetch, 0, 'NO request issued — the re-check after getIdToken caught it');
});
test('P1-2 MUTATION: remove authedFetch re-check ⇒ it issues the POST despite being barred mid-token', async () => {
  const b = loadBarrier({ stripAuthedFetchRecheck: true });
  let barred = false;
  b.setAuthedRequestGuard(() => barred);
  b.calls.onToken = () => { barred = true; };
  await b.authedFetch('https://fn/x', { a: 1 }).catch(() => {});
  assert.equal(b.calls.sherpaFetch, 1, 'mutant leaks a network call after barring (proves the re-check is load-bearing)');
});

test('sendTestPush barred from the start ⇒ {superseded}, no token, no network', async () => {
  const b = loadBarrier();
  b.setAuthedRequestGuard(() => true);
  const r = await b.sendTestPush();
  assert.deepEqual(r, { httpStatus: 0, reason: 'superseded' });
  assert.equal(b.calls.getIdToken, 0);
  assert.equal(b.calls.sherpaFetch, 0);
});
test('sendTestPush barred DURING the token await ⇒ {superseded}, ZERO network', async () => {
  const b = loadBarrier();
  let barred = false;
  b.setAuthedRequestGuard(() => barred);
  b.calls.onToken = () => { barred = true; };
  const r = await b.sendTestPush();
  assert.deepEqual(r, { httpStatus: 0, reason: 'superseded' });
  assert.equal(b.calls.getIdToken, 1);
  assert.equal(b.calls.sherpaFetch, 0, 'no push issued after barring mid-token');
});
test('MUTATION: strip BOTH sendTestPush guards ⇒ it issues the push even when barred', async () => {
  const b = loadBarrier({ stripSendTestPushGuards: true });
  b.setAuthedRequestGuard(() => true);
  await b.sendTestPush();
  assert.equal(b.calls.sherpaFetch, 1, 'mutant issues the push even when barred (proves both guards are load-bearing)');
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

test('tripwire: EVERY firebase-database import is allow-listed — only the four writes, each under its exact fb alias', () => {
  // The EXACT allowed write imports: original -> required local alias. Nothing else that can write may be imported.
  const ALLOWED = { set: 'fbSet', update: 'fbUpdate', remove: 'fbRemove', runTransaction: 'fbRunTransaction' };
  // Every firebase-database primitive that MUTATES the tree. Importing any of these other than the allow-listed
  // four — or an allow-listed one under a non-fb alias — is a bypass and must fail.
  const WRITE_PRIMS = new Set(['set', 'update', 'remove', 'runTransaction', 'push', 'setWithPriority', 'onDisconnect']);

  const imports = [...SRC.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'https:\/\/www\.gstatic\.com\/firebasejs\/[^']*firebase-database\.js'/g)];
  assert.ok(imports.length >= 1, 'at least one firebase-database import must be present');
  for (const imp of imports) {
    const specs = imp[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const spec of specs) {
      const parts = spec.split(/\s+as\s+/);
      const original = parts[0].trim();
      const local = (parts[1] || parts[0]).trim();
      if (!WRITE_PRIMS.has(original)) continue;                     // a read/query primitive — fine
      assert.ok(original in ALLOWED, `write primitive '${original}' may not be imported (only ${Object.keys(ALLOWED).join('/')})`);
      assert.equal(local, ALLOWED[original], `'${original}' must be imported as '${ALLOWED[original]}' (got '${local}') so raw calls can't bypass the guarded wrapper`);
    }
  }
});

test('tripwire: dismissDispatcherAlert routes its update through the guarded wrapper (no raw fbUpdate bypass)', () => {
  assert.doesNotMatch(SRC, /await\s+fbUpdate\s*\(/, 'no `await fbUpdate(` — the :636 bypass must route through guarded `update`');
});
