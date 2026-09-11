// Portal 1B Task 3 — the shared live-menu COORDINATOR. Run: node --test xpizza-orders/form-live-menu.test.mjs
//
// 🔴 WHAT THIS PROTECTS. The form already has a menu — the bundle spliced into its HTML, which is
// correct as of the last deploy. Everything the coordinator does is an UPGRADE on that, so every
// failure mode has the same shape: it must leave the customer looking at a menu that is whole and
// coherent, even if it is older than the catalog. The outcomes that are NOT acceptable are a blank
// menu, a half-applied one, and an older snapshot overwriting a newer one — and each of those is a
// plausible result of ordinary network behaviour rather than of a bug, which is why they are tested
// rather than reasoned about.
//
// Pure logic: fetch and the clock are injected, so overlapping requests and slow responses are
// arranged deliberately instead of waited for.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { createLiveMenu } = require('./form-live-menu.js');

// A snapshot is whatever the adapter says it is; these tests use the endpoint's real envelope shape.
const envelope = (rid, dishes) => ({ rid, representation_version: '1b.1', menu: { dishes, extras: [], categories: [{ id: 'c' }] } });

// The brand seam, as Tasks 4-5 will fill it: validate returns the snapshot or refuses it.
const adapterFor = (rid) => ({
  validateSnapshot: (raw) => {
    if (!raw || raw.rid !== rid) return null;                       // the rid check lives HERE — the adapter knows its brand
    if (!raw.menu || !Array.isArray(raw.menu.dishes) || !raw.menu.dishes.length) return null;
    return raw.menu;
  },
  diff: (prev, next) => ({ changed: !prev ? 'all' : next.dishes.length - prev.dishes.length }),
});

// A fetch double whose responses are resolved by hand, so two requests can be in flight at once and
// finish in either order.
function fetchLab() {
  const calls = [];
  const impl = (url, opts) => {
    let resolve; let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ url, headers: (opts && opts.headers) || {}, resolve, reject });
    return promise;
  };
  const deferred = [];
  const reply = (i, status, body, headers = {}, opts = {}) => {
    // `deferJson` holds the BODY back: the response has arrived but has not finished being read. A
    // newer request can be issued and settle inside that window, which is the only way to exercise
    // the staleness guard that sits after json().
    let releaseJson = null;
    const jsonPromise = opts.deferJson
      ? new Promise((res) => { releaseJson = () => res(body); })
      : Promise.resolve(body);
    if (opts.deferJson) deferred[i] = releaseJson;
    calls[i].resolve({
      status, ok: status >= 200 && status < 300,
      headers: { get: (h) => headers[h.toLowerCase()] ?? null },
      json: () => jsonPromise,
    });
  };
  const releaseBody = (i) => deferred[i]();
  return { impl, calls, reply, releaseBody, fail: (i, e) => calls[i].reject(e || new Error('network down')) };
}

const mk = (over = {}) => {
  const lab = fetchLab();
  const applied = [];
  const live = createLiveMenu({
    url: '/menu/x_pizza',
    fetchImpl: lab.impl,
    onApply: (snapshot, diff) => applied.push({ snapshot, diff }),
    adapter: adapterFor('x_pizza'),
    ...over,
  });
  return { lab, applied, live };
};

test('a successful fetch applies the validated snapshot and moves bundle → live', async () => {
  const { lab, applied, live } = mk();
  assert.strictEqual(live.state().phase, 'bundle', 'before anything, the form is showing its bundle');
  const done = live.refresh();
  assert.strictEqual(live.state().phase, 'fetching');
  lab.reply(0, 200, envelope('x_pizza', [{ id: 1 }, { id: 2 }]), { etag: '"abc"' });
  await done;

  assert.strictEqual(applied.length, 1, 'onApply is called exactly once');
  assert.strictEqual(applied[0].snapshot.dishes.length, 2, '...with the VALIDATED snapshot, not the envelope');
  assert.deepStrictEqual(applied[0].diff, { changed: 'all' }, '...and the adapter\'s diff');
  assert.strictEqual(live.state().phase, 'live');
  assert.strictEqual(live.state().source, 'live');
  assert.strictEqual(live.state().etag, '"abc"', 'the validator is stored WITH the snapshot it validates');
});

test('a malformed snapshot is a failure, not a partial apply — and the bundle is retained', async () => {
  // 🔴 THE ONE OUTCOME WORSE THAN AN OLD MENU IS HALF A NEW ONE. A body that arrives 200 but does not
  // validate must be indistinguishable from a network failure: nothing applied, nothing half-applied,
  // and the customer still looking at the bundle.
  for (const [label, body] of [
    ['a body for the wrong restaurant', envelope('la_musa', [{ id: 1 }])],
    ['a body with no dishes', envelope('x_pizza', [])],
    ['a body with no menu at all', { rid: 'x_pizza' }],
    ['null', null],
  ]) {
    const { lab, applied, live } = mk();
    const done = live.refresh();
    lab.reply(0, 200, body, { etag: '"whatever"' });
    await done;
    assert.strictEqual(applied.length, 0, `🔴 ${label}: onApply was called`);
    assert.strictEqual(live.state().phase, 'retained', `${label}: a malformed body is a failure`);
    assert.strictEqual(live.state().source, 'bundle', `${label}: and the bundle is what remains`);
    assert.strictEqual(live.state().etag, null, `🔴 ${label}: a refused representation must not leave its validator behind`);
  }
});

test('the first failure retains the bundle; a later failure retains the last-good LIVE snapshot', async () => {
  // The distinction matters: reverting to the bundle after a successful upgrade would throw away a
  // newer menu the customer is already looking at, for no reason other than a later request failing.
  const { lab, applied, live } = mk();
  let done = live.refresh();
  lab.fail(0);
  await done;
  assert.strictEqual(live.state().source, 'bundle', 'first failure: nothing better exists yet');
  assert.strictEqual(live.state().phase, 'retained');

  done = live.refresh();
  lab.reply(1, 200, envelope('x_pizza', [{ id: 1 }, { id: 2 }, { id: 3 }]), { etag: '"v1"' });
  await done;
  assert.strictEqual(live.state().source, 'live');

  done = live.refresh();
  lab.fail(2);
  await done;
  assert.strictEqual(live.state().phase, 'retained', 'a later failure is still a failure');
  assert.strictEqual(live.state().source, 'live', '🔴 ...but it must NOT revert to the bundle');
  assert.strictEqual(live.state().etag, '"v1"', 'the last-good validator survives a failure');
  assert.strictEqual(applied.length, 1, 'and nothing was re-applied');
});

test('a 304 is a no-op ONLY when that representation is already applied', async () => {
  const { lab, applied, live } = mk();
  let done = live.refresh();
  assert.strictEqual(lab.calls[0].headers['If-None-Match'], undefined,
    '🔴 the first request has no applied body, so it must be unconditional');
  lab.reply(0, 200, envelope('x_pizza', [{ id: 1 }]), { etag: '"v1"' });
  await done;

  done = live.refresh();
  assert.strictEqual(lab.calls[1].headers['If-None-Match'], '"v1"', 'the stored validator is sent back');
  lab.reply(1, 304, null, { etag: '"v1"' });
  await done;
  assert.strictEqual(applied.length, 1, '🔴 a 304 for the applied representation must not re-apply');
  assert.strictEqual(live.state().phase, 'live', '...and it is a success, not a failure');
  assert.strictEqual(live.state().source, 'live');
});

test('a 304 for a representation we do NOT have applied is a failure, never an empty menu', async () => {
  // 🔴 The shape that produces a blank screen: a cache answering "not modified" for something this
  // client has never rendered. The coordinator only ever sends If-None-Match for a body it holds, so
  // reaching here means the server or a cache broke the contract — and the answer is to keep what we
  // have, not to apply nothing and call it success.
  const { lab, applied, live } = mk();
  const done = live.refresh();
  lab.reply(0, 304, null, { etag: '"v1"' });
  await done;
  assert.strictEqual(applied.length, 0);
  assert.strictEqual(live.state().phase, 'retained', 'an unexpected 304 is a failure');
  assert.strictEqual(live.state().source, 'bundle', 'and the bundle still stands');
});

test('only the LATEST response applies — a slow older one is discarded', async () => {
  // 🔴 TWO REQUESTS IN FLIGHT IS NORMAL: a visibility change, a manual refresh, a timer. If the older
  // one lands last and wins, the customer's menu goes BACKWARDS — and nothing about that looks like
  // an error to anyone.
  const { lab, applied, live } = mk();
  const first = live.refresh();
  const second = live.refresh();
  assert.strictEqual(lab.calls.length, 2, 'both requests really were issued');

  lab.reply(1, 200, envelope('x_pizza', [{ id: 1 }, { id: 2 }]), { etag: '"newer"' });
  await second;
  lab.reply(0, 200, envelope('x_pizza', [{ id: 9 }]), { etag: '"older"' });
  await first;

  assert.strictEqual(applied.length, 1, '🔴 the older response applied on top of the newer one');
  assert.strictEqual(applied[0].snapshot.dishes.length, 2, 'the newer snapshot is what is showing');
  assert.strictEqual(live.state().etag, '"newer"', 'and its validator is what will be revalidated');
});

test('a stale FAILURE cannot move the state either', async () => {
  // The mirror of the above, and easier to get wrong: an older request that fails after a newer one
  // succeeded must not report the menu as retained when a fresh one is applied.
  const { lab, applied, live } = mk();
  const first = live.refresh();
  const second = live.refresh();
  lab.reply(1, 200, envelope('x_pizza', [{ id: 1 }]), { etag: '"newer"' });
  await second;
  lab.fail(0);
  await first;
  assert.strictEqual(live.state().phase, 'live', '🔴 a stale failure downgraded a live menu to retained');
  assert.strictEqual(applied.length, 1);
});

test('the adapter is required — a coordinator that cannot validate must not exist', () => {
  assert.throws(() => createLiveMenu({ url: '/x', fetchImpl: () => {}, onApply: () => {} }),
    /adapter/i, '🔴 without a validator every response would be applied unchecked');
  assert.throws(() => createLiveMenu({ url: '/x', fetchImpl: () => {}, onApply: () => {}, adapter: {} }),
    /validateSnapshot/i, 'an adapter without the one hook that matters is not an adapter');
});

test('a non-2xx is a failure, and onApply is never reached', async () => {
  for (const status of [400, 404, 500, 503]) {
    const { lab, applied, live } = mk();
    const done = live.refresh();
    lab.reply(0, status, { error: 'nope' });
    await done;
    assert.strictEqual(applied.length, 0, `${status}: nothing applied`);
    assert.strictEqual(live.state().phase, 'retained', `${status}: a failure`);
  }
});

test('an exception inside onApply does not leave the coordinator wedged', async () => {
  // The form's own render can throw. If that left the coordinator stuck in `fetching`, every later
  // refresh would be a no-op and the menu would freeze silently for the rest of the session.
  const lab = fetchLab();
  const live = createLiveMenu({
    url: '/menu/x_pizza', fetchImpl: lab.impl, adapter: adapterFor('x_pizza'),
    onApply: () => { throw new Error('render blew up'); },
  });
  const done = live.refresh();
  lab.reply(0, 200, envelope('x_pizza', [{ id: 1 }]), { etag: '"v1"' });
  await done;
  assert.notStrictEqual(live.state().phase, 'fetching', '🔴 the coordinator is wedged in fetching');
  const again = live.refresh();
  assert.strictEqual(lab.calls.length, 2, 'a later refresh still issues a request');
  lab.reply(1, 200, envelope('x_pizza', [{ id: 1 }]), { etag: '"v2"' });
  await again;
});

test('a non-2xx is refused by the STATUS, even when its body is a perfectly good menu', async () => {
  // 🔴 THE GUARD IS THE ONLY THING STANDING HERE. Today an error body does not validate, so the
  // !res.ok check looks redundant and a mutation removing it survives — right up until a 500 or a 503
  // returns menu-shaped JSON (a proxy's error page, a gateway that echoes, a future error envelope
  // that carries a fallback). Then the status is the ONLY signal that this is not a menu, and a
  // customer is shown a menu that the server was in the middle of failing to produce.
  for (const status of [500, 503, 404, 400]) {
    const { lab, applied, live } = mk();
    const done = live.refresh();
    lab.reply(0, status, envelope('x_pizza', [{ id: 1 }, { id: 2 }]), { etag: '"looks-real"' });
    await done;
    assert.strictEqual(applied.length, 0, `🔴 ${status} with a valid body was APPLIED`);
    assert.strictEqual(live.state().phase, 'retained', `${status}: a failure whatever the body says`);
    assert.strictEqual(live.state().etag, null, `${status}: and it leaves no validator`);
  }
});

test('a stale NON-OK response cannot downgrade a live menu — the post-fetch guard is alone on this path', async () => {
  // A stale network REJECTION is caught by the guard inside the catch. A stale non-ok RESPONSE never
  // reaches that, and never reaches the post-json guard either, because there is no body to read:
  // the check immediately after fetch is the only thing between it and fail(). Without it, an older
  // 503 landing after a newer 200 turns a live menu into `retained` for no reason.
  const { lab, applied, live } = mk();
  const first = live.refresh();
  const second = live.refresh();
  lab.reply(1, 200, envelope('x_pizza', [{ id: 1 }]), { etag: '"newer"' });
  await second;
  assert.strictEqual(live.state().phase, 'live');

  lab.reply(0, 503, { error: 'nope' });
  await first;
  assert.strictEqual(live.state().phase, 'live', '🔴 a stale 503 downgraded a live menu to retained');
  assert.strictEqual(live.state().etag, '"newer"', 'and the newer validator still stands');
  assert.strictEqual(applied.length, 1);
});

test('a stale 304 changes nothing either', async () => {
  const { lab, applied, live } = mk();
  const first = live.refresh();
  const second = live.refresh();
  lab.reply(1, 200, envelope('x_pizza', [{ id: 1 }]), { etag: '"newer"' });
  await second;
  lab.reply(0, 304, null, { etag: '"older"' });
  await first;
  assert.strictEqual(live.state().etag, '"newer"', 'a stale 304 must not touch the applied validator');
  assert.strictEqual(live.state().phase, 'live');
  assert.strictEqual(applied.length, 1);
});

test('a body still being READ when a newer response applies is discarded', async () => {
  // 🔴 THE THIRD STALENESS POINT. A response can arrive first and finish being read LAST — a large
  // body, a slow parse, a busy main thread. The guard after json() is the only one that sees this,
  // and without it the older menu overwrites the newer one after the newer one has already painted.
  const { lab, applied, live } = mk();
  const first = live.refresh();
  lab.reply(0, 200, envelope('x_pizza', [{ id: 99 }]), { etag: '"older"' }, { deferJson: true });

  // 🔴 LET REQUEST 0 REACH json() BEFORE A NEWER ONE IS ISSUED. Without this tick the older request
  // is still parked on its fetch, so the staleness check right AFTER fetch catches it and the body is
  // never read — the guard after json() is never reached, and a mutation deleting it survives. The
  // first version of this test did exactly that: it looked like it covered the third staleness point
  // and covered the first one twice.
  await new Promise((r) => setImmediate(r));

  const second = live.refresh();
  lab.reply(1, 200, envelope('x_pizza', [{ id: 1 }, { id: 2 }]), { etag: '"newer"' });
  await second;
  assert.strictEqual(live.state().etag, '"newer"', 'premise: the newer one applied first');

  lab.releaseBody(0);                                  // the older body finally finishes reading
  await first;
  assert.strictEqual(applied.length, 1, '🔴 the older body applied after the newer one');
  assert.strictEqual(live.state().etag, '"newer"');
  assert.strictEqual(live.state().snapshot.dishes.length, 2, 'the newer snapshot is what is showing');
});

test('a validator that THROWS is a refusal, not an exception escaping the coordinator', async () => {
  // An adapter is brand code written by whoever owns the form. It will throw one day — on a shape it
  // did not expect, on a null it did not guard. That must land as "this snapshot is refused", not as
  // an unhandled rejection that takes the refresh with it and leaves the phase wherever it was.
  const lab = fetchLab();
  const applied = [];
  const live = createLiveMenu({
    url: '/menu/x_pizza', fetchImpl: lab.impl, onApply: (s) => applied.push(s),
    adapter: { validateSnapshot: () => { throw new TypeError("Cannot read properties of undefined (reading 'dishes')"); } },
  });
  const done = live.refresh();
  lab.reply(0, 200, envelope('x_pizza', [{ id: 1 }]), { etag: '"v1"' });
  await assert.doesNotReject(() => done, '🔴 the adapter\'s throw escaped the coordinator');
  assert.strictEqual(applied.length, 0, 'nothing applied');
  assert.strictEqual(live.state().phase, 'retained', 'a throwing validator is a refusal');
  assert.strictEqual(live.state().source, 'bundle', 'and the bundle is retained');
  assert.match(live.state().lastError, /snapshot refused/, '...with a reason a developer can act on');
});
