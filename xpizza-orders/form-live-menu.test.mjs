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
  const reply = (i, status, body, headers = {}) => calls[i].resolve({
    status, ok: status >= 200 && status < 300,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    json: async () => body,
  });
  return { impl, calls, reply, fail: (i, e) => calls[i].reject(e || new Error('network down')) };
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

test('the la_musa copy is byte-identical to the canonical one', () => {
  // 🔴 THE SAME DISCIPLINE avail-key.js CARRIES, AND FOR THE SAME REASON. Two copies of a rule that
  // decides what a customer sees is two rules the moment one is edited — and the drift would show up
  // as one brand behaving correctly and the other not, on a code path nobody thinks of as shared.
  // The forms have no build step, so a copy is the only way to share; a test is the only way to keep
  // it honest.
  const canonical = readFileSync(new URL('./form-live-menu.js', import.meta.url), 'utf8');
  const copy = readFileSync(new URL('../la-musa-orders/form-live-menu.js', import.meta.url), 'utf8');
  assert.strictEqual(copy, canonical,
    'la-musa-orders/form-live-menu.js has drifted — copy xpizza-orders/form-live-menu.js over it');
  assert.ok(canonical.includes('function createLiveMenu'), 'non-vacuity: the file really is the coordinator');
  // COMMENT-STRIPPED. The first version of this matched the word `export` inside the file's own
  // comment explaining that it uses no `export` keyword — a guard reading its own documentation as
  // evidence, which is the failure this repo's other censuses already carry warnings about. Checked
  // against ESM syntax at the start of a line, in code only.
  const code = canonical.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.ok(!/^\s*export[\s{]/m.test(code) && !/^\s*import[\s{]/m.test(code),
    'no ESM syntax — the same bytes must load as a Node module AND a classic browser script');
  assert.ok(/module\.exports/.test(code) && /window\.createLiveMenu/.test(code),
    '...and it must publish itself to BOTH worlds');
  // non-vacuity: the detector really fires on ESM
  assert.ok(/^\s*export[\s{]/m.test('export function x() {}'), 'the detector can see an export');
});
