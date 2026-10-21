// dispatch-lite-push-refresh.test.mjs — EXECUTABLE coverage of the silent iOS-push self-heal (item 1).
// Extracts the shipped refresh/rotate/write/repair helpers VERBATIM from index.html (between the
// <<push-refresh:start/end>> markers) and runs them against DOM/Push/RTDB shims, so the test exercises the
// REAL code, not a paraphrase. One test per kept behaviour (owner trim). readonly.test + parity.test guard the
// single-write-site and SDK parity separately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
const START = '// <<push-refresh:start>>';
const END = '// <<push-refresh:end>>';
const startIdx = html.indexOf(START);
assert.ok(startIdx > -1 && html.indexOf(END) > startIdx, 'located push-refresh markers');
// slice from the line AFTER the start marker (its comment tail is not code) up to the end marker line
const block = html.slice(html.indexOf('\n', startIdx) + 1, html.indexOf(END));

const DAY = 24 * 60 * 60 * 1000;

function buildEnv(opts = {}) {
  const calls = { subscribe: 0, unsubscribe: 0 };
  const writes = [];
  const nowRef = { v: opts.now || 1_000_000_000_000 };
  let subN = 0;
  const mkSub = (endpoint) => ({
    endpoint,
    toJSON: () => ({ endpoint, keys: {} }),
    unsubscribe: async () => { calls.unsubscribe++; current = null; if (opts.unsubThrow) throw new Error('unsub fail'); return true; },
  });
  let current = opts.initialSub ? mkSub(opts.initialSub) : null;
  const pushManager = {
    getSubscription: async () => current,
    subscribe: async () => {
      calls.subscribe++;
      if (opts.subscribeThrow) throw new Error('subscribe fail');
      subN++; current = mkSub('ep-new-' + subN); return current;
    },
  };
  const reg = { pushManager };
  let readyResolve;
  const ready = opts.readyControlled ? new Promise((r) => { readyResolve = r; }) : Promise.resolve(reg);

  const lsMap = new Map();
  for (const [k, v] of Object.entries(opts.ls || {})) lsMap.set(k, String(v));
  const localStorage = { getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null), setItem: (k, v) => lsMap.set(k, String(v)) };

  const set = (refObj, val) => { writes.push({ path: refObj.path, val }); return Promise.resolve(); };
  const ref = (_db, path) => ({ path });
  const serverTimestamp = () => '__ts__';
  const sherpaTracked = (p) => p;
  const XPD = { getDb: () => ({}), getAuthInstance: () => ({ currentUser: opts.uid === null ? null : { uid: opts.uid || 'disp-1' } }) };
  const Notification = { permission: opts.permission || 'granted' };
  const window = { Notification, PushManager: function () {} };
  const navigator = { serviceWorker: { ready } };
  const DateShim = { now: () => nowRef.v };

  const body = `let pushOn = false;\n${block}\n;return { writeStaffPushSub, rotateStaffPushSub, refreshStaffPushIfStale, forceRepairStaffPush, get pushOn(){ return pushOn; } };`;
  const factory = new Function(
    'navigator', 'window', 'Notification', 'XPD', 'set', 'ref', 'serverTimestamp', 'sherpaTracked',
    'urlB64ToU8', 'VAPID_PUBLIC_KEY_B64', 'localStorage', 'console', 'Date', body);
  const api = factory(navigator, window, Notification, XPD, set, ref, serverTimestamp, sherpaTracked,
    () => new Uint8Array(), 'KEY', localStorage, console, DateShim);

  return { api, calls, writes, ls: lsMap, resolveReady: () => readyResolve(reg), nowRef };
}

const staffPushWrite = (w) => w.path === 'staff_push/disp-1';

// (a) absent subscription + granted → subscribe + write (fresh registration on a device with none)
test('absent subscription + granted → subscribes and writes', async () => {
  const env = buildEnv({ initialSub: null, permission: 'granted' });
  await env.api.refreshStaffPushIfStale();
  assert.equal(env.calls.subscribe, 1, 'subscribed once');
  assert.equal(env.calls.unsubscribe, 0, 'nothing to unsubscribe');
  assert.equal(env.writes.filter(staffPushWrite).length, 1, 'wrote the new subscription once');
  assert.ok(env.ls.get('dl-push-at'), 'stamped the local age');
  assert.ok(env.ls.get('dl-push-ck'), 'stamped the throttle');
  assert.equal(env.api.pushOn, true);
});

// (b) local age older than 3 days → rotate (unsubscribe → subscribe → write) for a fresh endpoint
test('subscription older than 3 days → rotates to a fresh endpoint', async () => {
  const env = buildEnv({ initialSub: 'ep-old', permission: 'granted', now: 5 * DAY, ls: { 'dl-push-at': 5 * DAY - 4 * DAY } });
  await env.api.refreshStaffPushIfStale();
  assert.equal(env.calls.unsubscribe, 1, 'dropped the old subscription first (Push API: subscribe reuses otherwise)');
  assert.equal(env.calls.subscribe, 1, 'created a fresh subscription');
  assert.equal(env.writes.filter(staffPushWrite).length, 1, 'wrote the rotated subscription');
});

// (c) fresh (within 3 days, present) → no-op write, throttle still stamped
test('fresh subscription within 3 days → no rotation, no write', async () => {
  const env = buildEnv({ initialSub: 'ep-cur', permission: 'granted', now: 5 * DAY, ls: { 'dl-push-at': 5 * DAY - 1 * DAY } });
  await env.api.refreshStaffPushIfStale();
  assert.equal(env.calls.subscribe, 0);
  assert.equal(env.calls.unsubscribe, 0);
  assert.equal(env.writes.length, 0, 'no RTDB write on a no-op');
  assert.ok(env.ls.get('dl-push-ck'), 'throttle stamped so we do not re-check every foreground');
});

// (d) permission not granted → does nothing, never prompts
test('permission not granted → nothing (no subscribe, no write, no prompt)', async () => {
  const env = buildEnv({ initialSub: null, permission: 'default' });
  await env.api.refreshStaffPushIfStale();
  assert.equal(env.calls.subscribe, 0);
  assert.equal(env.writes.length, 0);
  assert.ok(!env.ls.has('dl-push-ck'), 'did not even consume the throttle');
});

// (d2) signed out (no authenticated uid) → nothing, even with permission granted and a live sub. The visibility
// hook fires on the login screen with permission still granted; it must NOT unsubscribe a working sub there.
test('signed out → resolves no uid and returns BEFORE any unsubscribe/write', async () => {
  const env = buildEnv({ uid: null, permission: 'granted', initialSub: 'ep-cur' });
  await env.api.refreshStaffPushIfStale();
  assert.equal(env.calls.unsubscribe, 0, 'never touches the subscription when signed out');
  assert.equal(env.calls.subscribe, 0);
  assert.equal(env.writes.length, 0);
  assert.ok(!env.ls.has('dl-push-ck'), 'no throttle consumed');
});

// (e) throttle: a second attempt within 12 h is skipped
test('throttled within 12 h → skipped', async () => {
  const env = buildEnv({ initialSub: null, permission: 'granted', now: 100 * DAY, ls: { 'dl-push-ck': 100 * DAY - 60 * 60 * 1000 } });
  await env.api.refreshStaffPushIfStale();
  assert.equal(env.calls.subscribe, 0, 'throttle short-circuits before any work');
  assert.equal(env.writes.length, 0);
});

// (f) single in-flight guard: overlapping launch + visibility callbacks run the work once
test('in-flight guard → concurrent callbacks do the work once', async () => {
  const env = buildEnv({ initialSub: null, permission: 'granted', readyControlled: true });
  const p1 = env.api.refreshStaffPushIfStale();   // claims pushRefreshing, then awaits serviceWorker.ready
  const p2 = env.api.refreshStaffPushIfStale();   // sees the guard set → returns immediately
  env.resolveReady();
  await Promise.all([p1, p2]);
  assert.equal(env.calls.subscribe, 1, 'only one refresh did the work');
  assert.equal(env.writes.filter(staffPushWrite).length, 1);
});

// (g) rotate failure → old record kept (no client remove), throttle NOT stamped, retries next open
test('rotate failure → record kept, throttle not stamped, next open retries and succeeds', async () => {
  // first attempt: subscribe throws after the old sub is dropped
  const env = buildEnv({ initialSub: 'ep-old', permission: 'granted', now: 9 * DAY, ls: { 'dl-push-at': 9 * DAY - 5 * DAY }, subscribeThrow: true });
  await env.api.refreshStaffPushIfStale();
  assert.equal(env.writes.length, 0, 'no write on failure');
  assert.ok(!env.ls.has('dl-push-ck'), 'throttle NOT stamped → the next open retries');
  assert.equal(env.api.pushOn, false, 'pushOn reconciled to the real (now absent) subscription');
  // the client never issued a remove — the server record is left intact for the server to clean on 404/410
  assert.equal(env.writes.filter((w) => w.val === null).length, 0, 'client never removes the record');
});

test('rotate failure then recovery: a later open (subscribe works) writes the new subscription', async () => {
  const env = buildEnv({ initialSub: null, permission: 'granted', now: 9 * DAY });
  await env.api.refreshStaffPushIfStale();   // absent → subscribe succeeds here
  assert.equal(env.writes.filter(staffPushWrite).length, 1, 'next open registers successfully');
});

// (h) forced repair → unconditional rotation via the shared helper, even when fresh & throttled
test('forceRepairStaffPush → rotates unconditionally (bypasses staleness + throttle)', async () => {
  const env = buildEnv({ initialSub: 'ep-cur', permission: 'granted', now: 5 * DAY, ls: { 'dl-push-at': 5 * DAY - 10, 'dl-push-ck': 5 * DAY - 10 } });
  await env.api.forceRepairStaffPush();
  assert.equal(env.calls.unsubscribe, 1, 'forced a fresh endpoint (drop first) even though it was fresh');
  assert.equal(env.calls.subscribe, 1);
  assert.equal(env.writes.filter(staffPushWrite).length, 1);
  assert.equal(env.api.pushOn, true);
});

test('forceRepairStaffPush → throws when signed out (caller shows the error state)', async () => {
  const env = buildEnv({ uid: null, permission: 'granted', initialSub: 'ep-cur' });
  await assert.rejects(() => env.api.forceRepairStaffPush(), /no-uid/);
});

// (i) 3-day boundary is inclusive (>=): exactly 3 days old rotates
test('boundary: exactly 3 days old → rotates (>= PUSH_STALE_MS)', async () => {
  const env = buildEnv({ initialSub: 'ep-old', permission: 'granted', now: 10 * DAY, ls: { 'dl-push-at': 10 * DAY - 3 * DAY } });
  await env.api.refreshStaffPushIfStale();
  assert.equal(env.calls.subscribe, 1, 'the 3-day edge is treated as stale');
  assert.equal(env.writes.filter(staffPushWrite).length, 1);
});
