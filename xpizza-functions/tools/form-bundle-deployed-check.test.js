'use strict';
// PLAN 4 r2 (Codex r1 #6) — the DEPLOYED-ORIGIN comparison (`form-bundle-live-check.js --deployed`): the bundle the LIVE site
// serves against the published menu, both read fresh through the real transport (getText / getJson) against a LOOPBACK site.
// The checkout's own index.html supplies only the menu endpoint — a stale DEPLOY is caught even when the checkout is current.
// Run: node tools/form-bundle-deployed-check.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const { deployedCheck, getText, getJson } = require('./form-bundle-live-check');
const { FORMS } = require('./splice-form-bundle');
const { extractBundle, spliceBundle } = require('../catalog/splice-form-bundle');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('form-bundle-deployed-check: FAILED — exited without completing'); process.exitCode = 1; } });
const clone = (v) => JSON.parse(JSON.stringify(v));

(async () => {
  const checkout = fs.readFileSync(FORMS.x_pizza, 'utf8');
  const published = extractBundle(checkout);
  const state = { deployedBundle: clone(published), menu: clone(published), down: false, hits: [] };
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      state.hits.push({ url: req.url, cc: req.headers['cache-control'] });
      if (req.url.startsWith('/menu/')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ rid: 'x_pizza', representation_version: '1d.3', menu: state.menu })); }
      if (state.down) { res.writeHead(503); return res.end('down'); }
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(spliceBundle(checkout, state.deployedBundle, 'deployed'));
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  // the manifest names the real-shaped https origin; the transport is redirected to the loopback "live site"
  const sites = { deployments: [{ app: 'orders', context: 'x_pizza', origins: ['https://orders.test'] }] };
  const loop = (u) => u.replace('https://orders.test', base).replace(/^https:\/\/[^/]+(?=\/menu\/)/, base);
  const deps = { sites, fetchText: (u, o) => getText(loop(u), { ...o, get: http.get, timeoutMs: 3000, totalMs: 5000 }), fetchJson: (u, o) => getJson(loop(u), { ...o, get: http.get, timeoutMs: 3000, totalMs: 5000 }), now: () => 1761600000000 };
  const html = checkout.replace(/const PUBLICMENU_URL\s*=\s*'[^']+'/, "const PUBLICMENU_URL = 'https://menu.test'");
  try {
    let r = await deployedCheck('x_pizza', html, deps);
    assert.deepStrictEqual([r.origin, r.fail, r.warn], ['https://orders.test/', [], []], 'a deploy equal to published is clean');
    assert.ok(state.hits.some((h) => h.url === '/?_deployed=1761600000000' && h.cc === 'no-cache'), 'the DEPLOYED page is read fresh (unique query + no-cache)');
    assert.ok(state.hits.some((h) => h.url === '/menu/x_pizza?_check=1761600000000' && h.cc === 'no-cache'), 'and so is the published menu');
    ok('deployed == published: clean; both the live page and the menu are read fresh');

    state.menu.dishes[0].price += 9;                                   // published moved; the DEPLOY did not (the checkout is irrelevant)
    r = await deployedCheck('x_pizza', html, deps);
    assert.ok(r.fail.some((f) => /price: baked \d+ \| published \d+/.test(f)), `a stale DEPLOY fails (${JSON.stringify(r.fail)})`);
    state.deployedBundle = clone(state.menu); state.menu.dishes.push({ ...clone(state.menu.dishes[0]), id: 999, name: 'Nueva' });
    r = await deployedCheck('x_pizza', html, deps);
    assert.deepStrictEqual(r.fail, []); assert.ok(r.warn.some((w) => /999/.test(w)), 'a published-only addition is reported (the CLI treats it as stale)');
    ok('a stale deploy (a repriced published dish) FAILS; a published-only addition is reported — whatever the checkout holds');

    state.down = true;
    await assert.rejects(deployedCheck('x_pizza', html, deps), /answered 503/, 'an unreachable deployed site is a failure, not a pass');
    await assert.rejects(deployedCheck('x_pizza', html, { ...deps, sites: { deployments: [] } }), /no single orders origin/);
    ok('an unreachable deployed site or a brand with no single orders origin is a failure, never a pass');
  } finally { server.close(); }
  FINISHED = true;
  console.log(`\nform-bundle-deployed-check: OK (${n})`);
})().catch((e) => { console.error('form-bundle-deployed-check: FAILED', e); process.exit(1); });
