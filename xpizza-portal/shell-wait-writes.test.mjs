// PLAN-portal-shell-no-shift — Codex r3 P1 (DATA SAFETY): shell.js's recovery (portal:abandon) cancels ONLY the editor's abandoned
// catalog READ. A save or a publish already in flight ALWAYS settles, reconciles and runs its authoritative reload — even when a
// boot failure lands in between. Composed over a REAL DOM: jsdom over the shipped index.html with the REAL app.js, ventas.js
// and shell.js (auth.js stubbed; fetch stubbed per function, the same harness pattern as pubreq.test.mjs).
// Each cell: reveal from the CACHED discovery → load the menu → edit → hold the write → release the FRESH discovery, whose
// render throws (→ recovery + portal:abandon) → release the write → it must still be adopted.
// Run: node --test xpizza-portal/shell-wait-writes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DIR, installFetch, okJson, errJson } from './ventas-harness.mjs';

const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const { capsFor } = createRequire(import.meta.url)('../xpizza-functions/access/membership.js');
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 3000) { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) assert.fail(`timed out: ${what}`); await settle(10); } }
const ITEM = { key: 'Pepperoni', price: 245, display: { name: 'Pepperoni', cat: 'cl', price: 245 } };
const SOURCE = { restaurant_id: 'r_sw', schema_version: 1, items: [ITEM], extras: [], structure: { schema_version: 2, item_order: ['Pepperoni'], categories: [{ id: 'cl', name: 'Clásicas' }] } };
const MENU = { source: SOURCE, sourceUpdateTime: 'T1', activeVersionId: 'v1', usesPlatformFactura: false };
const DIFF = { added: [], removed: [], renamed: [], changed: [{ key: 'Pepperoni', surface: 'item', field: 'price', old: 245, new: 285 }], largeChangeSet: [] };
const OWNER = capsFor({ owner: true }, 'member');
const branch = { rid: 'r_sw', brand_id: 'marca_w', role: 'owner', state: 'member', caps: OWNER, name: 'Centro', identity_version: 2,
  editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null };
const E1 = () => ({ brands: [{ brand_id: 'marca_w', name: 'Marca W' }], branches: [{ ...branch }], membership_writes_enabled: false });

async function loadAll() {
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const auth = join(DIR, `__sww-auth-stub.${tag}.mjs`);
  writeFileSync(auth, 'export const token = async () => "TK-sw";\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n');
  const tmp = (n) => join(DIR, `__sww-under-test.${n}.${tag}.mjs`);
  const url = (n) => `./__sww-under-test.${n}.${tag}.mjs`;
  const files = [auth];
  const mods = {};
  try {
    for (const name of ['app', 'ventas', 'shell']) {
      const src = readFileSync(join(DIR, `${name}.js`), 'utf8')
        .replace(/from '\.\/auth\.js'/g, `from './__sww-auth-stub.${tag}.mjs'`)
        .replace(/from '\.\/app\.js'/g, `from '${url('app')}'`)
        .replace(/from '\.\/shell\.js'/g, `from '${url('shell')}'`);
      writeFileSync(tmp(name), src); files.push(tmp(name));
      mods[name] = await import(pathToFileURL(tmp(name)).href);
    }
    return mods;
  } finally { for (const f of files) { try { unlinkSync(f); } catch (_) { /* best effort */ } } }
}

// the page, revealed from the CACHED E1, with the FRESH discovery held; `on` overrides a function
async function page(on) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  globalThis.CSS = { escape: (s) => String(s) };
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  globalThis.__branchesDirect = true;
  w.sessionStorage.setItem('sherpa.portal.branches.uSwW', JSON.stringify(E1()));   // the cached discovery: the editor opens on it
  let releaseE1;
  const freshE1 = new Promise((r) => { releaseE1 = r; });
  const calls = installFetch((fn) => {
    if (on[fn]) return on[fn]();
    if (fn === 'getMyBranches') return freshE1;
    if (fn === 'getEditableCatalog') return okJson(MENU);
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  const mods = await loadAll();
  const d = w.document;
  d.dispatchEvent(new w.CustomEvent('portal:auth', { detail: { uid: 'uSwW' } }));
  d.dispatchEvent(new w.CustomEvent('portal:signed-in'));
  await until(() => d.querySelector('#detail .price input'), 'the menu from the cached boot');
  // the fresh answer whose render THROWS: renderChrome reads the brand name → the boot catch → recovery + portal:abandon
  const failFresh = async () => {
    const bad = E1();
    Object.defineProperty(bad.brands[0], 'name', { get() { throw new Error('render boom'); }, enumerable: true });
    const ce = console.error; console.error = () => {};
    try { releaseE1(okJson(bad)); await settle(40); } finally { console.error = ce; }
    assert.ok(d.querySelector('#detail .errbox'), 'premise: the recovery box is up (portal:abandon was dispatched)');
  };
  const n = (fn) => calls.filter((c) => c.fn === fn).length;
  return { w, d, mods, calls, n, failFresh };
}
const editPrice = async (d, w, v) => { const i = d.querySelector('#detail .price input'); i.value = String(v); i.dispatchEvent(new w.Event('input')); await settle(); };

test('r3 P1 — a SAVE in flight across a boot failure still settles: the server\'s revision (T2) is adopted, the review opens', async () => {
  let releaseSave;
  const held = new Promise((r) => { releaseSave = r; });
  const { w, d, mods, n, failFresh } = await page({ editCatalog: () => held.then(() => okJson({ diff: DIFF, token: 'ET-1', source: { ...SOURCE, items: [{ ...ITEM, price: 285, display: { ...ITEM.display, price: 285 } }] }, updateTime: 'T2' })) });
  await editPrice(d, w, 285);
  d.getElementById('review').click();
  await until(() => n('editCatalog') === 1, 'the save is on the wire');
  await failFresh();
  releaseSave(); await settle(60);
  assert.equal(mods.app.state.sourceUpdateTime, 'T2', 'the save is adopted — the next write is based on the server\'s revision');
  assert.ok(mods.app.state.review, 'the review the save opened is up');
});

test('r3 P1 — a PUBLISH in flight across a boot failure still settles: the receipt shows and the authoritative reload runs', async () => {
  let releasePub;
  const held = new Promise((r) => { releasePub = r; });
  const { w, d, n, failFresh } = await page({
    editCatalog: () => okJson({ diff: DIFF, token: 'ET-1', source: { ...SOURCE, items: [{ ...ITEM, price: 285, display: { ...ITEM.display, price: 285 } }] }, updateTime: 'T2' }),
    publishEdited: () => held.then(() => okJson({ ok: true, versionId: 'v2' })),
  });
  await editPrice(d, w, 285);
  d.getElementById('review').click();
  await until(() => !d.getElementById('pubbtn').disabled, 'the review is ready');
  d.getElementById('pubbtn').click();
  await until(() => n('publishEdited') === 1, 'the publish is on the wire');
  const reads = n('getEditableCatalog');
  await failFresh();
  releasePub(); await settle(80);
  assert.ok(d.querySelector('#mbody .receipt'), 'the receipt');
  assert.ok(n('getEditableCatalog') > reads, 'the authoritative reload ran');
});
