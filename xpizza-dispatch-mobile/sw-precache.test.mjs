import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const swSrc = readFileSync(join(here, 'sw.js'), 'utf8');
const HELPER = './dispatch-h0-dismiss.js?v=1';   // the exact query xpizza-delivery.js imports
const ALERTS = './dispatch-alerts.js?v=4';       // the exact query index.html imports (shared alert module)

// 1) static: the versioned helper is precached and the shell version was bumped so existing installs re-cache.
test('sw precaches the exact versioned helper URL and bumps the shell version', () => {
  const shell = (swSrc.match(/const SHELL = '([^']+)'/) || [])[1];
  assert.ok(shell && shell !== 'dl-shell-v5', `SHELL must be bumped past v5 (got ${shell})`);
  const assets = swSrc.slice(swSrc.indexOf('const ASSETS = ['), swSrc.indexOf('];', swSrc.indexOf('const ASSETS')));
  assert.ok(assets.includes(`'${HELPER}'`), 'ASSETS must precache the exact ./dispatch-h0-dismiss.js?v=1 URL (with the query)');
  assert.ok(assets.includes(`'${ALERTS}'`), 'ASSETS must precache the exact ./dispatch-alerts.js?v=4 URL (the shared alert module the page imports)');
});

// 2) lifecycle: install precaches, then an OFFLINE fetch of the helper is served from cache (not the network).
//    Also proves query-sensitivity: the un-versioned URL is NOT served (caches.match keys on the full URL).
test('offline boot: the SW serves the cached versioned helper; the un-versioned URL misses', async () => {
  // minimal mocks. Relative ASSETS resolve against the SW scope (as the browser does); requests are absolute.
  const BASE = 'https://torre.local/';
  const abs = (u) => new URL(u, BASE).href;
  const store = new Map();                       // cache: key = absolute url -> a Response-ish
  const cache = {
    addAll: async (urls) => { for (const u of urls) store.set(abs(u), { url: abs(u), body: `cached:${u}` }); },
    match: async (req) => store.get(typeof req === 'string' ? abs(req) : req.url),   // query-sensitive exact match
  };
  const caches = { open: async () => cache, keys: async () => [], delete: async () => true, match: (req) => cache.match(req) };
  const fetchFn = async () => { throw new Error('offline'); };   // network down
  const handlers = {};
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => {}, clients: { claim: async () => {} }, registration: {},
  };
  // eval the SW body with our environment (it registers handlers on `self`)
  new Function('self', 'caches', 'fetch', 'URL', swSrc)(self, caches, fetchFn, URL);

  // install → precache ASSETS
  let installDone;
  handlers.install({ waitUntil: (p) => { installDone = p; } });
  await installDone;
  assert.ok(store.has(abs(HELPER)), 'install precached the versioned helper into the shell cache');
  assert.ok(store.has(abs(ALERTS)), 'install precached the versioned dispatch-alerts.js into the shell cache');
  // offline fetch of the shared alert module → served from cache (would break module loading if omitted)
  let servedAl; handlers.fetch({ request: { url: abs(ALERTS) }, respondWith: (p) => { servedAl = p; } });
  const hitAl = await servedAl;
  assert.ok(hitAl && hitAl.body === `cached:${ALERTS}`, 'offline: the versioned dispatch-alerts.js is served from cache');

  // offline fetch of the versioned helper → served from cache
  let served;
  handlers.fetch({ request: { url: abs(HELPER) }, respondWith: (p) => { served = p; } });
  const hit = await served;
  assert.ok(hit && hit.body === `cached:${HELPER}`, 'offline: the versioned helper is served from cache, not the network');

  // query-sensitivity: the un-versioned URL is a cache MISS (why the exact ?v=1 precache is required)
  let served2;
  handlers.fetch({ request: { url: abs('./dispatch-h0-dismiss.js') }, respondWith: (p) => { served2 = p; } });
  assert.equal(await served2, undefined, 'the un-versioned URL is not cached (caches.match is query-sensitive)');
});
