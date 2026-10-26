'use strict';
// form-bundle-live-check — the pure comparison, driven from each form's REAL committed bundle (no network).
// Run: node tools/form-bundle-live-check.test.js
const assert = require('assert');
const { readFileSync } = require('fs');
const { FORMS } = require('./splice-form-bundle');
const { extractBundle } = require('../catalog/splice-form-bundle');
const { dirname, join } = require('path');
const http = require('http');
const { compareBundle, unregisteredForms, publicMenuUrl, selectForms, getJson } = require('./form-bundle-live-check');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const clone = (v) => JSON.parse(JSON.stringify(v));
// What getPublicMenu adds on top of the generated bundle: the platform identity keys, which the forms accept-and-ignore.
const served = (b) => {
  const m = clone(b);
  m.dishes.forEach((d, i) => { d.identity_id = `ID${i}`; d.dish_id = `ID${i}`; });
  m.extras.forEach((e, i) => { e.identity_id = `EX${i}`; e.extra_id = `EX${i}`; });
  return m;
};

const rids = Object.keys(FORMS);
assert.ok(rids.length >= 2, 'premise: the splice registry lists the forms');
for (const rid of rids) {
  const html = readFileSync(FORMS[rid], 'utf8');
  const baked = extractBundle(html);
  assert.ok(baked.dishes.length > 1 && baked.extras.length > 0, `${rid}: premise — a real bundle`);

  assert.deepStrictEqual(compareBundle(baked, served(baked)), { fail: [], warn: [] }, `${rid}: identical menus (+ identity keys) pass clean`);

  const repriced = served(baked); repriced.dishes[0].price += 26;
  const r1 = compareBundle(baked, repriced);
  assert.strictEqual(r1.fail.length, 1, `${rid}: a repriced dish fails`); assert.match(r1.fail[0], / price: baked \d+ \| published \d+/);

  const optionPrice = served(baked); optionPrice.extras[0].price += 5;
  assert.strictEqual(compareBundle(baked, optionPrice).fail.length, 1, `${rid}: a repriced option fails`);

  const renamed = served(baked); renamed.dishes[1].name += ' X';
  assert.strictEqual(compareBundle(baked, renamed).fail.length, 1, `${rid}: any other field change on a dish fails`);

  const removed = served(baked); removed.dishes.splice(1, 1);
  const r2 = compareBundle(baked, removed);
  assert.ok(r2.fail.some((f) => /baked but absent/.test(f)), `${rid}: a baked dish missing from the published menu fails`);

  const added = served(baked);
  added.dishes.push({ id: 'zz_new', cat: baked.dishes[0].cat, name: 'Nuevo', price: 100 });
  added.variant_items = { ...(added.variant_items || {}), zz_new: { label: 'Salsa', basePrice: 100, variantIds: [] } };
  const r3 = compareBundle(baked, added);
  assert.deepStrictEqual(r3.fail, [], `${rid}: a published-only dish does NOT fail`);
  assert.strictEqual(r3.warn.length, 2, `${rid}: …it is listed as a warning (dish + its variant group)`);

  assert.match(publicMenuUrl(html, rid), new RegExp(`/menu/${rid}$`), `${rid}: the URL is the form's own PUBLICMENU_URL`);
  ok(`${rid}: clean on equal menus; FAIL on a repriced dish, a repriced option, a changed field and a removed dish; WARN on a published-only addition`);
}
assert.deepStrictEqual(unregisteredForms(), [], 'every form that carries a baked menu is in the splice registry');
{ const [dropped, ...rest] = rids; const partial = Object.fromEntries(rest.map((r) => [r, FORMS[r]]));
  assert.deepStrictEqual(unregisteredForms(partial), [FORMS[dropped]], 'non-vacuity: a form missing from the registry is reported'); }
ok('every form folder with a baked menu is registered, so a new brand cannot ship unchecked');
for (const rid of rids) {
  assert.deepStrictEqual(selectForms(['--this-form'], dirname(FORMS[rid])).map(([r]) => r), [rid], `${rid}: --this-form in its folder checks ONLY that form`);
}
assert.strictEqual(selectForms(['--this-form'], __dirname), null, '--this-form outside a registered form folder selects nothing (the build fails)');
assert.deepStrictEqual(selectForms([], __dirname).map(([r]) => r), rids, 'without --this-form every registered form is checked');
ok('--this-form: a form\'s build checks only its own brand; an unregistered folder fails; the default checks every form');
// Every registered form's Netlify build runs the check for itself, after the stamp — a brand added to the registry without it fails here.
for (const rid of rids) {
  const toml = readFileSync(join(dirname(FORMS[rid]), 'netlify.toml'), 'utf8');
  const cmd = (toml.match(/^\s*command\s*=\s*"([^"]*)"/m) || [])[1] || '';
  assert.strictEqual(cmd, 'node ../platform/stamp-version.js && node ../xpizza-functions/tools/form-bundle-live-check.js --this-form',
    `${rid}: its Netlify build command stamps, then runs the baked-menu check for this form only`);
}
ok('every registered form\'s Netlify build runs the check (--this-form) after the version stamp');
// ── the GET can never pass a build it did not finish (codex guard r1 P1/P2) — driven against a LOOPBACK server ──
(async () => {
  const timers = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"menu":{"dishes":[]}}'); }
    if (req.url === '/500') { res.writeHead(500); return res.end('no'); }
    if (req.url === '/badjson') { res.writeHead(200); return res.end('{not json'); }
    if (req.url === '/truncated') { res.writeHead(200, { 'content-length': '5000' }); res.write('{"menu":{"dish'); return setTimeout(() => req.socket.destroy(), 20); }
    if (req.url === '/dribble') { res.writeHead(200); const t = setInterval(() => res.write(' '), 30); timers.add(t); req.on('close', () => clearInterval(t)); return; }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const opts = { get: http.get, timeoutMs: 5000, totalMs: 600 };
  const rejects = async (path, re, label) => {
    let err = null;
    const hang = new Promise((_, no) => { const t = setTimeout(() => no(new Error('did not settle within 3 s')), 3000); timers.add(t); });
    try { await Promise.race([getJson(base + path, opts), hang]); } catch (e) { err = e; }
    assert.ok(err, `${label}: rejects (never settles silently, never resolves)`);
    assert.match(err.message, re, `${label}: names the cause`);
  };
  try {
    assert.deepStrictEqual(await getJson(base + '/ok', opts), { menu: { dishes: [] } }, 'a complete 200 JSON body resolves');
    await rejects('/truncated', /closed before the response ended|aborted/, 'a response cut off after its headers');
    await rejects('/dribble', /did not complete within 600 ms/, 'a response that dribbles data forever');
    await rejects('/500', /answered 500/, 'a non-200');
    await rejects('/badjson', /non-JSON/, 'a 200 that is not JSON');
    ok('the GET settles on every path: a truncated response, a never-ending dribble (total deadline), a non-200 and non-JSON each REJECT; only a complete 200 JSON resolves');
  } finally {
    for (const t of timers) { clearInterval(t); clearTimeout(t); }
    server.closeAllConnections && server.closeAllConnections();
    server.close();
  }
  console.log(`\nform-bundle-live-check: OK (${n})`);
})().catch((e) => { console.error('form-bundle-live-check FAILED:', e); process.exit(1); });
