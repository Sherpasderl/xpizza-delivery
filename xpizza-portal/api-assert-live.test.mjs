// Stats S2 codex r2 — api.js's OPTIONAL `assertLive`, proven not to change the Menú/catalog calls.
// Run: node --test xpizza-portal/api-assert-live.test.mjs
//
// DIFFERENTIAL, against the BASE api.js (git 13f441e, before the assertion existed): every call the Menú page makes
// (getMyRestaurants, getEditableCatalog, editCatalog, publishEdited — all through apiFetch) and the two stats calls
// without the assertion are run through BOTH modules under identical stubs, and the recorded fetch requests (url +
// options) and the outcomes (resolved body, or the typed ApiError kind/status/code/body) must be deep-equal — success,
// server error, network failure and not-signed-in alike. Then: a passing assertion changes nothing; a throwing one
// withholds the request; and it runs AFTER the token await, immediately before fetch.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cur from './api.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const baseSrc = execFileSync('git', ['show', '13f441e:xpizza-portal/api.js'], { cwd: DIR, encoding: 'utf8' });
const basePath = join(DIR, `__api-base.${process.pid}.mjs`);
writeFileSync(basePath, baseSrc);
const base = await import(pathToFileURL(basePath).href);
unlinkSync(basePath);

function stubFetch(mode) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options: JSON.parse(JSON.stringify(options)) });
    if (mode === 'network') throw new TypeError('Failed to fetch');
    if (mode === 'ok') return { ok: true, status: 200, json: async () => ({ restaurants: [{ rid: 'r', name: 'R' }] }), text: async () => 'a,b\r\n', headers: { get: () => null } };
    return { ok: false, status: mode, json: async () => ({ error: `e${mode}` }), text: async () => '', headers: { get: () => null } };
  };
  return calls;
}
async function outcome(fn) {
  try { return { ok: await fn() }; } catch (e) { return { err: { name: e.constructor.name, kind: e.kind, status: e.status, code: e.code, body: e.body, msg: e.message } }; }
}
const token = async () => 'TK';
const noToken = async () => null;
const CALLS = (api, tk) => ({
  getMyRestaurants: () => api.apiFetch('getMyRestaurants', { token: tk }),
  getEditableCatalog: () => api.apiFetch('getEditableCatalog', { rid: 'x_pizza', token: tk }),
  editCatalog: () => api.editCatalog({ rid: 'x_pizza', source: { a: 1 }, baseSourceUpdateTime: 'T', token: tk }),
  publishEdited: () => api.publishEdited({ rid: 'x_pizza', editToken: 'ET', acknowledgedChanges: [], fiscalAck: true, token: tk }),
  getSalesStats: () => api.getSalesStats({ rid: 'x_pizza', from: '2026-10-01', to: '2026-10-06', granularity: 'day', compare: 'previous', token: tk }),
  fetchSalesCsv: () => api.fetchSalesCsv({ rid: 'x_pizza', from: '2026-10-01', to: '2026-10-06', kind: 'orders', cursor: 'C1', token: tk }),
});

test('🔴 without the assertion, every Menú/catalog (and stats) call is byte-identical to the BASE api.js — requests and outcomes', async () => {
  let compared = 0;
  for (const mode of ['ok', 400, 403, 409, 503, 'network']) {
    for (const tk of [token, noToken]) {
      for (const name of Object.keys(CALLS(cur, tk))) {
        const bc = stubFetch(mode); const bo = await outcome(CALLS(base, tk)[name]);
        const cc = stubFetch(mode); const co = await outcome(CALLS(cur, tk)[name]);
        assert.deepStrictEqual(cc, bc, `${name} ${mode} ${tk === token ? 'signed-in' : 'no-token'}: identical fetch requests`);
        assert.deepStrictEqual(co, bo, `${name} ${mode}: identical outcome`);
        compared += 1;
      }
    }
  }
  assert.strictEqual(compared, 6 * 2 * 6);
  // non-vacuity: the stubs do record requests, and the outcomes differ across modes
  const c = stubFetch('ok'); await CALLS(cur, token).editCatalog();
  assert.strictEqual(c.length, 1); assert.ok(JSON.parse(c[0].options.body).restaurantId === 'x_pizza');
});

test('a PASSING assertion changes nothing; a THROWING one withholds the request (JSON and CSV)', async () => {
  for (const name of ['getSalesStats', 'fetchSalesCsv']) {
    const plain = stubFetch('ok'); const po = await outcome(CALLS(cur, token)[name]);
    const pass = stubFetch('ok');
    const args = name === 'getSalesStats'
      ? () => cur.getSalesStats({ rid: 'x_pizza', from: '2026-10-01', to: '2026-10-06', granularity: 'day', compare: 'previous', token, assertLive: () => {} })
      : () => cur.fetchSalesCsv({ rid: 'x_pizza', from: '2026-10-01', to: '2026-10-06', kind: 'orders', cursor: 'C1', token, assertLive: () => {} });
    assert.deepStrictEqual(await outcome(args), po); assert.deepStrictEqual(pass, plain);
    const none = stubFetch('ok');
    const dead = () => { throw Object.assign(new Error('ended'), { kind: 'ended' }); };
    const o = name === 'getSalesStats'
      ? await outcome(() => cur.getSalesStats({ rid: 'x_pizza', from: 'a', to: 'b', token, assertLive: dead }))
      : await outcome(() => cur.fetchSalesCsv({ rid: 'x_pizza', from: 'a', to: 'b', token, assertLive: dead }));
    assert.deepStrictEqual([none.length, o.err && o.err.kind], [0, 'ended'], `${name}: withheld`);
  }
});

test('ordering: the assertion runs AFTER the token await and immediately before fetch — a microtask queued during token() is seen', async () => {
  for (const name of ['apiFetch', 'fetchSalesCsv']) {
    let alive = true;
    const tk = async () => { queueMicrotask(() => { alive = false; }); return 'TK'; };   // the auth change lands between token and fetch
    const calls = stubFetch('ok');
    const assertLive = () => { if (!alive) throw Object.assign(new Error('ended'), { kind: 'ended' }); };
    const o = name === 'apiFetch'
      ? await outcome(() => cur.apiFetch('getSalesStats', { rid: 'r', token: tk, assertLive }))
      : await outcome(() => cur.fetchSalesCsv({ rid: 'r', from: 'a', to: 'b', token: tk, assertLive }));
    assert.deepStrictEqual([calls.length, o.err && o.err.kind], [0, 'ended'], `${name}: 🔴 no request after the queued change`);
  }
});
