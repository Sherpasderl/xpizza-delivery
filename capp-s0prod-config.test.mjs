// CUSTOMER APP S0-prod — THE LIVE RESTAURANT-CONFIG (PLAN-shared-order-form.FINAL §5 S0-prod).
//
// Each live order form now carries its restaurant's DATA as one inline <script id="restaurant-config"> block (the
// first script on the page), and the page code and account.js read their identity from it. This suite proves:
//   1. each block EXECUTES to a deep-frozen config that passes the strict live schema (no factura field, ever);
//   2. ZERO LIVE CHANGE: every value equals what the PREVIOUS forms (c9c0840b, the S0-test tip) did at RUNTIME —
//      their genOrderId prefix, the key their card path stashed under, their empty-cart copy, their HOURS/MIN_ORDER/
//      map, their account CONFIG — and the new pages do the same at runtime; the one approved change is §A1
//      (restaurant_id on every quote/order), pinned by the S0-test body goldens;
//   3. both account.js files are byte-identical, carry no brand literal in code, and FAIL LOUDLY on a page without
//      the block; every page in the repo that loads account.js carries the block before it.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync, readdirSync, statSync } from 'node:fs';
import { loadForm, closeAll, counter, settle, ORDER_FORM_DIRS } from './form-harness.mjs';
import { readInlineConfig, validateLiveConfig, deriveBrandConfig, observePendingPayKey } from './xpizza-functions/contract/capp/brand-config.mjs';
import { PREAMBLE } from './xpizza-functions/contract/capp/capture.mjs';

const { ok, count } = counter();
const ROOT = new URL('./', import.meta.url).pathname;
const BASE = 'c9c0840b';                         // the S0-test tip: the forms exactly as they are live today
const TMP = 'node_modules/.capp-s0prod';
const plain = (x) => JSON.parse(JSON.stringify(x));
const src = (dir, f) => readFileSync(`${ROOT}${dir}/${f}`, 'utf8');

function materializeBase(dir) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-tree', '--name-only', BASE, `${dir}/`], { encoding: 'utf8' }).split('\n').filter((f) => /\.(html|js)$/.test(f));
  mkdirSync(`${ROOT}${TMP}/base/${dir}`, { recursive: true });
  for (const f of files) writeFileSync(`${ROOT}${TMP}/base/${f}`, execFileSync('git', ['-C', ROOT, 'show', `${BASE}:${f}`], { maxBuffer: 1 << 27 }));
  return `${TMP}/base/${dir}`;
}
function probePage(name, dir, edit) {
  const d = `${TMP}/probe/${name}`;
  mkdirSync(ROOT + d, { recursive: true });
  for (const f of readdirSync(ROOT + dir)) if (statSync(`${ROOT}${dir}/${f}`).isFile()) writeFileSync(`${ROOT}${d}/${f}`, readFileSync(`${ROOT}${dir}/${f}`));
  writeFileSync(`${ROOT}${d}/index.html`, edit(readFileSync(`${ROOT}${d}/index.html`, 'utf8')));
  return d;
}

// What a page DOES today, read from its running window: the values the live config must reproduce.
async function runtimeFacts(dir) {
  const w = loadForm(dir, { preamble: PREAMBLE }); await settle();
  const A = w.__ACCOUNT.CONFIG, ev = (e) => w.eval(e);
  const d = await deriveBrandConfig(w, { dir, html: src(dir, 'index.html') });   // prefix, noun, payment methods, pending key (observed)
  return plain({
    restaurant_id: A.restaurant_id, display_name: A.brand, branding: { accent: A.accent, palette: A.palette },
    map: d.map, hours: d.hours, min_order_lempiras: ev('MIN_ORDER'), payment_methods: d.payment_methods,
    rewards: A.rewards, order_id_prefix: d.order_id.prefix, pending_pay: d.storage_keys.pending_pay, account_marker: A.MARKER,
    empty_cart_noun_tail: d.copy.error_noun,
  });
}
const factsOfConfig = (c) => plain({
  restaurant_id: c.rid, display_name: c.display_name, branding: c.branding, map: { lat: c.map.latitude, lng: c.map.longitude, radius_km: c.map.radius_km }, hours: c.hours,
  min_order_lempiras: c.min_order_lempiras, payment_methods: [...c.payment_methods].sort(), rewards: c.rewards, order_id_prefix: c.order_id_prefix,
  pending_pay: c.storage_keys.pending_pay, account_marker: c.storage_keys.account_marker, empty_cart_noun_tail: c.empty_cart_noun.split(' ').slice(1).join(' '),
});

try {
  // 1 — each live block executes, validates, is deep-frozen, and is the first script.
  const cfg = {};
  for (const dir of ORDER_FORM_DIRS) {
    const { config } = readInlineConfig(src(dir, 'index.html'), dir);
    assert.deepStrictEqual(validateLiveConfig(config), [], `${dir}: the live config passes the strict schema`);
    cfg[dir] = plain(config);
  }
  assert.ok(validateLiveConfig({ ...cfg['xpizza-orders'], uses_platform_factura: true }).some((m) => /factura-like field uses_platform_factura/.test(m)), 'the schema refuses a factura field by NAME, at any depth');
  assert.ok(validateLiveConfig({ ...cfg['xpizza-orders'], map: { ...cfg['xpizza-orders'].map, isv_rate: 0.15 } }).some((m) => /factura-like field map\.isv_rate/.test(m)), '…including nested');
  assert.ok(validateLiveConfig(JSON.parse(JSON.stringify(cfg['la-musa-orders']))).includes('not deep-frozen'), 'an unfrozen config is refused');
  ok(`${ORDER_FORM_DIRS.length} live configs execute, validate, are deep-frozen and first; a factura-like field is refused at any depth`);
  {
    const h = src('xpizza-orders', 'index.html'); const ls = h.split('\n');
    const bi = ls.findIndex((l) => l.startsWith('/* RESTAURANT-CONFIG:BEGIN'));
    assert.strictEqual(ls[bi - 1], '<script>', 'premise: the block opens the first inline script');
    const withLine = (i, l) => { const c = ls.slice(); c.splice(i, 0, l); return c.join('\n'); };
    assert.throws(() => readInlineConfig(withLine(bi, 'var early = 1;'), 'probe'), /not the first statement/);
    assert.throws(() => readInlineConfig(withLine(bi - 1, '<script>var r = window.RESTAURANT_CONFIG;</script>'), 'probe'), /not the first statement|a reader precedes/);
    assert.throws(() => readInlineConfig(ls.map((l, i) => (i === bi + 1 ? l.replace('Object.freeze({schema', 'Object.freeze({ schema') : l)).join('\n'), 'probe'), /canonical emitter/);
    assert.throws(() => readInlineConfig(ls.map((l, i) => (i === bi + 1 ? l.replace('branding:Object.freeze({', 'branding:({') : l)).join('\n'), 'probe'), /canonical emitter|single frozen assignment/);
  }
  ok('the block must be the FIRST statement of the first inline script with no reader before it, and the canonical emitter\'s output (a hand edit or an unfrozen branch is refused)');

  // 2 — ZERO LIVE CHANGE: the config equals what the previous forms did at runtime, and the new pages still do it.
  for (const dir of ORDER_FORM_DIRS) {
    const before = await runtimeFacts(materializeBase(dir));
    const after = await runtimeFacts(dir);
    assert.deepStrictEqual(factsOfConfig(cfg[dir]), before, `${dir}: the live config reproduces the ${BASE} page's runtime values exactly`);
    assert.deepStrictEqual(after, before, `${dir}: the new page behaves identically at runtime (prefix, stash key, copy, hours, map, rewards, account)`);
  }
  ok(`zero live change: each config equals the ${BASE} pages' RUNTIME values (genOrderId prefix, observed stash key, empty-cart copy, hours, map, min order, account CONFIG), and the new pages reproduce them`);

  // The account-intent key and the reorder item key: today's values, unchanged (cutover renames are listed, not done).
  for (const dir of ORDER_FORM_DIRS) {
    const baseAcct = execFileSync('git', ['-C', ROOT, 'show', `${BASE}:${dir}/account.js`], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.strictEqual(baseAcct.split("'xpizza_acct_intent'").length - 1, 4, `${dir}: premise — the ${BASE} account.js used the literal intent key at its 4 sites`);
    assert.strictEqual(cfg[dir].storage_keys.account_intent, 'xpizza_acct_intent', `${dir}: account_intent is today's literal, unchanged for every brand (rename listed for cutover)`);
    assert.strictEqual(baseAcct.split("const laMusa = CONFIG.restaurant_id === 'la_musa';").length - 1, 1, `${dir}: premise — the ${BASE} reorder keyed on the brand`);
    assert.strictEqual(cfg[dir].item_key, cfg[dir].rid === 'la_musa' ? 'id' : 'name', `${dir}: item_key reproduces the ${BASE} brand check exactly (deleted in S1)`);
  }
  ok("account_intent = 'xpizza_acct_intent' for every brand and item_key = the old brand check's answer — today's behaviour as data");

  // 3 — account.js: one file, no brand literal in code, loud without its config.
  const acct = ORDER_FORM_DIRS.map((d) => src(d, 'account.js'));
  assert.ok(acct.every((a) => a === acct[0]), 'every order form ships a byte-identical account.js');
  const code = acct[0].split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).map((l) => l.replace(/\/\/.*$/, '').replace(/xpizza-delivery/g, '')).join('\n');
  const lit = /x_pizza|la_musa|xpizza_|lamusa|X\.? ?Pizza|La Musa/.exec(code);
  assert.strictEqual(lit, null, `account.js code carries a brand literal: ${lit && lit[0]}`);
  for (const [name, edit] of [
    ['no-config', (h) => { const ls = h.split('\n'); const i = ls.findIndex((l) => l.startsWith('/* RESTAURANT-CONFIG:BEGIN')); assert.ok(i > 0, 'premise: the block exists'); ls.splice(i, 3); return ls.join('\n'); }],
    ['malformed-config', (h) => { const n = h.replace(/storage_keys:Object\.freeze\(\{[^}]*\}\),/, ''); assert.notStrictEqual(n, h, 'premise: the probe removed storage_keys'); return n; }],
  ]) {
    const w = loadForm(probePage(name, 'xpizza-orders', edit)); await settle();
    assert.ok(w.__jsdomErrors.some((m) => /account\.js: window\.RESTAURANT_CONFIG is missing or malformed/.test(m)), `${name}: account.js fails LOUDLY (got ${JSON.stringify(w.__jsdomErrors.slice(0, 2))})`);
    assert.strictEqual(w.__ACCOUNT, undefined, `${name}: and does not install itself with a guessed restaurant`);
  }
  ok('account.js is byte-identical across forms, has no brand literal in code, and THROWS on a page with no or a malformed config');

  // Every page in the repo that loads account.js carries the config block BEFORE it.
  const pages = [];
  (function walk(d) { for (const e of readdirSync(ROOT + d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue; const p = d ? `${d}/${e.name}` : e.name; if (e.isDirectory()) walk(p); else if (/\.html$/.test(e.name)) pages.push(p); } })('');
  const loaders = pages.filter((p) => /<script[^>]*src="[^"]*account\.js"/.test(readFileSync(ROOT + p, 'utf8')));
  assert.deepStrictEqual(loaders.sort(), ORDER_FORM_DIRS.map((d) => `${d}/index.html`).sort(), `the pages that load account.js are exactly the order forms (found ${JSON.stringify(loaders)})`);
  for (const p of loaders) {
    const h = readFileSync(ROOT + p, 'utf8');
    readInlineConfig(h, p);   // throws unless the block is the FIRST statement of the first inline script and no reader precedes it
    assert.ok(h.indexOf('RESTAURANT-CONFIG:END') < h.indexOf('src="account.js"'), `${p}: the config block precedes account.js`);
  }
  ok(`every page that loads account.js (${loaders.length}) carries the config block before it`);
} finally {
  closeAll();
  rmSync(ROOT + TMP, { recursive: true, force: true });
  try { rmdirSync(ROOT + 'node_modules'); } catch (_) {}
}
console.log(`\ncapp-s0prod-config: ${count()} passed`);
