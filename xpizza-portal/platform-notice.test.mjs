// F-2 (owner-approved mockup ENrjdkJmw3mzy9PkFCy4D1, N1 / N2 / P1) — «Sherpa está actualizando tu menú» under a REAL DOM: jsdom over the
// shipped index.html with the REAL app.js, ventas.js and shell.js (auth stubbed). The draft is the REAL x_pizza seed (the functions'
// seed-source-store); getEditableCatalog / resetDraftToLive answered in the server's exact shapes (F-1: platform_changes_pending is
// { fields } on the read, and 409 { error:'platform_changes_pending', fields } on the reset).
// Run: node --test xpizza-portal/platform-notice.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { DIR, installFetch, okJson, errJson } from './ventas-harness.mjs';

const req = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = req('jsdom');
const { buildSourceFromCode } = req('./tools/seed-source-store');
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');
const SRC = buildSourceFromCode('x_pizza');
const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'catalog.fiscal_ack', 'catalog.add_product', 'catalog.reset_draft', 'stats.read',
  'availability.set', 'location.prep', 'location.pause', 'location.hours', 'team.invite', 'team.revoke', 'brand.settings'];
const E1 = () => ({ brands: [{ brand_id: 'x_pizza', name: 'X. Pizza' }], membership_writes_enabled: false,
  branches: [{ rid: 'x_pizza', brand_id: 'x_pizza', role: 'owner', state: 'member', caps: OWNER_CAPS, name: 'Centro', identity_version: 2, editable: { prep_default_min: 20 },
    readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' }, control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null }] });
const PENDING = { fields: ['structure.badge_priority', 'item[Nutella].display.extras_policy'] };
const COPY = {
  title: 'Sherpa está actualizando tu menú',
  body: 'Estamos actualizando cómo se ve tu menú. Mientras tanto podés verlo, pero no guardar ni publicar cambios. Si necesitás cambiar un precio ya, escribinos.',
  bar: 'Publicar se habilita cuando Sherpa termine.',
  lock: 'Solo lectura mientras Sherpa actualiza',
  panel: 'No se guardó ni se publicó nada. Cuando Sherpa termine vas a poder publicar de nuevo; tus cambios de precio podés hacerlos después.',
};
const editable = (over = {}) => ({ source: JSON.parse(JSON.stringify(SRC)), sourceUpdateTime: '1700000000.000000001', activeVersionId: 'v-live', usesPlatformFactura: false,
  renderedCategories: [], restaurantName: 'X. Pizza', publish_via_request: false, groupAuthoring: false, choiceBadges: [], ...over });
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function loadAll() {
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const auth = join(DIR, `__pn-auth-stub.${tag}.mjs`);
  writeFileSync(auth, 'export const token = async () => "TK-pn";\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n');
  const tmp = (n) => join(DIR, `__pn-under-test.${n}.${tag}.mjs`);
  const url = (n) => `./__pn-under-test.${n}.${tag}.mjs`;
  const files = [auth]; const mods = {};
  try {
    for (const name of ['app', 'ventas', 'shell']) {
      const src = readFileSync(join(DIR, `${name}.js`), 'utf8')
        .replace(/from '\.\/auth\.js'/g, `from './__pn-auth-stub.${tag}.mjs'`)
        .replace(/from '\.\/app\.js'/g, `from '${url('app')}'`)
        .replace(/from '\.\/shell\.js'/g, `from '${url('shell')}'`);
      writeFileSync(tmp(name), src); files.push(tmp(name));
      mods[name] = await import(pathToFileURL(tmp(name)).href);
    }
    return mods;
  } finally { for (const f of files) { try { unlinkSync(f); } catch (_) { /* best effort */ } } }
}

async function page({ read = () => editable({ platform_changes_pending: PENDING }), on = {} } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  globalThis.__branchesDirect = true;
  const st = { read };
  const calls = installFetch((fn) => {
    const last = calls[calls.length - 1];
    if (on[fn]) { const r = on[fn](last); if (r) return r; }
    if (fn === 'getMyBranches') return okJson(E1());
    if (fn === 'getEditableCatalog') return okJson(st.read());
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  const mods = await loadAll();
  const d = w.document;
  const n = (fn) => calls.filter((c) => c.fn === fn);
  const signIn = async () => {
    d.dispatchEvent(new w.CustomEvent('portal:auth', { detail: { uid: 'uOwnerPN' } }));
    d.dispatchEvent(new w.CustomEvent('portal:signed-in'));
    await settle(80);
  };
  const detail = () => d.getElementById('detail');
  const btnIn = (root, label) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  return { dom, w, d, mods, st, calls, n, signIn, detail, btnIn };
}

test('N1: a flagged draft → the calm notice first in the card, NO reset offer, prices read-only, the bar disabled with its reason, the header lock', async () => {
  const p = await page({ read: () => editable({ platform_changes_pending: PENDING, draft_unpublishable: { code: 'structure_changed', detail: 'x' } }) });
  await p.signIn();
  assert.ok(p.n('getEditableCatalog').length >= 1, 'premise: the editor loaded');
  const first = p.detail().firstElementChild;
  assert.ok(first && first.classList.contains('callout') && first.classList.contains('calloutquiet1b'), 'the portal\'s own quiet callout, first in the card');
  assert.equal(first.getAttribute('role'), 'status');
  assert.equal(first.textContent.replace(/\s+/g, ' ').trim(), `${COPY.title}. ${COPY.body}`);
  assert.equal(first.querySelectorAll('button').length, 0, 'no button: nothing for the merchant to do');
  assert.equal(p.detail().querySelector('.unpub'), null, 'the red reset box is NOT offered — even with draft_unpublishable also present');
  assert.ok(!p.detail().textContent.includes('Volver al menú publicado'));
  const prices = [...p.detail().querySelectorAll('.price input')];
  assert.ok(prices.length > 0, 'premise: the real seed renders price inputs');
  assert.ok(prices.every((i) => i.disabled), 'every price read-only');
  const rev = p.d.getElementById('review');
  assert.ok(rev.disabled, 'the review entry is disabled');
  assert.equal(rev.title, COPY.bar);
  assert.equal(p.d.getElementById('rbtxt').textContent, COPY.bar);
  assert.ok(p.d.getElementById('discard').classList.contains('hidden'));
  const lock = p.d.getElementById('menulock');
  assert.ok(!lock.classList.contains('hidden'));
  assert.equal(lock.querySelector('.lock').textContent.trim(), COPY.lock);
});

test('read-only is REAL, not only drawn: a price typed into the draft is refused at the state boundary, and nothing is saved', async () => {
  const p = await page();
  await p.signIn();
  const input = p.detail().querySelector('.price input');
  const before = input.value;
  assert.ok(before && before !== '999', 'premise');
  input.disabled = false; input.value = '999'; input.dispatchEvent(new p.w.Event('input'));   // a stray dispatch past the disabled look
  await settle();
  // the DRAWER keeps its field listeners (the hold only disables them): a stray dispatch there must be refused by the DRAFT itself
  p.detail().querySelector('.rowchev').click(); await settle();
  const dIn = p.d.getElementById('drawer').querySelector('input');
  assert.ok(dIn, 'premise: the drawer price field');
  dIn.disabled = false; dIn.value = '999'; dIn.dispatchEvent(new p.w.Event('input')); dIn.dispatchEvent(new p.w.Event('change'));
  await settle();
  p.d.getElementById('drawer').querySelector('.dwx').click(); await settle();
  // repaint from the DRAFT (switch sections and back): the draft never took the value
  const rail = [...p.d.querySelectorAll('#rail .railitem')];
  assert.ok(rail.length >= 2, 'premise: the seed has several sections');
  rail[1].click(); await settle(); rail[0].click(); await settle();
  assert.equal(p.detail().querySelector('.price input').value, before, 'the draft refused the write (canEdit is false while Sherpa updates)');
  assert.equal(p.n('editCatalog').length, 0, 'no save leaves');
  assert.ok(p.d.getElementById('review').disabled, 'still not reviewable');
});

test('the drawer is held too: opening a dish shows it, but its price field is locked (the rename hold\u2019s own mechanism)', async () => {
  const p = await page();
  await p.signIn();
  p.detail().querySelector('.rowchev').click(); await settle();
  const dr = p.d.getElementById('drawer');
  assert.ok(dr.classList.contains('show'), 'a dish can still be opened to look at');
  const inputs = [...dr.querySelectorAll('input')];
  assert.ok(inputs.length > 0, 'premise: the drawer has its price field');
  assert.ok(inputs.every((i) => i.disabled), 'every drawer field locked');
  const close = dr.querySelector('.dwx');
  assert.ok(close && !close.disabled, 'its close stays usable');
});

test('a photo is content like a price: with uploads ON, a flagged draft offers no row camera (and an unflagged one does — non-vacuity)', async () => {
  const p = await page({ read: () => editable({ platform_changes_pending: PENDING, photosEnabled: true }) });
  await p.signIn();
  const cams = (q) => [...q.detail().querySelectorAll('button.thumb')].filter((b) => b.querySelector('svg'));
  assert.equal(cams(p).length, 0, 'no upload affordance while Sherpa updates');
  const q = await page({ read: () => editable({ photosEnabled: true }) });
  await q.signIn();
  assert.ok(cams(q).length > 0, 'premise: with uploads on, rows offer the camera');
});

test('Codex r1 P2-2: a click DISPATCHED on the disabled review entry is refused at ADMISSION — owner (review) and manager («Enviar al dueño»)', async () => {
  const p = await page();
  await p.signIn();
  const rev = p.d.getElementById('review');
  assert.ok(rev.disabled, 'premise: disabled');
  rev.disabled = false; rev.click(); await settle(60);   // past the disabled look
  assert.equal(p.n('editCatalog').length, 0, 'owner: no save leaves');
  assert.ok(!p.d.getElementById('scrim').classList.contains('show'), 'and no review opened');
  // a manager on a platform-factura brand SENDS instead of publishing (publish_via_request): the same refusal
  const q = await page({ read: () => editable({ platform_changes_pending: PENDING, publish_via_request: true }) });
  await q.signIn();
  const rq = q.d.getElementById('review');
  rq.disabled = false; rq.click(); await settle(60);
  assert.equal(q.n('editCatalog').length, 0, '«Enviar al dueño»: no save leaves');
  assert.equal(q.n('catalogRequestPublish').length, 0, 'and no publish request');
  // non-vacuity: the same forced click WITHOUT the flag does reach the server
  const r = await page({ read: () => editable({}), on: { editCatalog: () => errJson(503, { error: 'store_unavailable', retryable: true }) } });
  await r.signIn();
  const rr = r.d.getElementById('review');
  rr.disabled = false; rr.click(); await settle(60);
  assert.ok(r.n('editCatalog').length >= 1, 'premise: unflagged, the click saves');
});

test('no regression: a merchant\'s OWN unpublishable draft (no flag) still gets today\'s red box and «Volver al menú publicado»; editing as today', async () => {
  const p = await page({ read: () => editable({ draft_unpublishable: { code: 'structure_changed', detail: 'x' } }) });
  await p.signIn();
  const box = p.detail().querySelector('.unpub');
  assert.ok(box && p.btnIn(box, 'Volver al menú publicado'), 'today\'s reset offer');
  assert.equal(p.detail().querySelector('.calloutquiet1b'), null);
  assert.ok([...p.detail().querySelectorAll('.price input')].some((i) => !i.disabled), 'prices editable as today');
  assert.ok(p.d.getElementById('menulock').classList.contains('hidden'), 'no header lock');
  assert.notEqual(p.d.getElementById('rbtxt').textContent, COPY.bar);
});

test('N2: a stale page\'s reset is refused 409 platform_changes_pending → the designed panel (info, «Entendido» only closes), the notice behind it', async () => {
  let flagged = false;
  const p = await page({
    read: () => editable(flagged ? { platform_changes_pending: PENDING } : { draft_unpublishable: { code: 'structure_changed', detail: 'x' } }),
    on: { resetDraftToLive: () => errJson(409, { error: 'platform_changes_pending', detail: 'Sherpa is updating this menu', fields: PENDING.fields }) },
  });
  await p.signIn();
  const reads = p.n('getEditableCatalog').length;
  p.btnIn(p.detail().querySelector('.unpub'), 'Volver al menú publicado').click();
  await settle(60);
  assert.equal(p.n('resetDraftToLive').length, 1, 'premise: the reset reached the server');
  const mbody = p.d.getElementById('mbody');
  assert.ok(mbody.textContent.includes(COPY.title) && mbody.textContent.includes(COPY.panel), 'the panel\'s exact copy');
  assert.ok(mbody.querySelector('.cicon.info'), 'the info icon, not the warning');
  assert.ok(p.d.getElementById('scrim').classList.contains('show'));
  assert.ok(p.detail().querySelector('.calloutquiet1b') && !p.detail().querySelector('.unpub'), 'behind it, the notice replaced the reset offer');
  p.btnIn(mbody, 'Entendido').click();
  await settle(40);
  assert.ok(!p.d.getElementById('scrim').classList.contains('show'), '«Entendido» closes');
  assert.equal(p.n('resetDraftToLive').length, 1, 'no second reset');
  assert.equal(p.n('getEditableCatalog').length, reads, 'no reload either');
  assert.equal(p.n('editCatalog').length, 0, 'and no review / save was opened');
  flagged = true;
});

test('the state ends with the flag: a reload without it restores the editor, the header lock\'s own text and today\'s bar', async () => {
  let flag = true;
  const p = await page({ read: () => editable(flag ? { platform_changes_pending: PENDING } : {}) });
  await p.signIn();
  const original = (() => { const m = /<div class="topact ops hidden" id="menulock"><span class="lock">[\s\S]*?<\/svg>([^<]*)<\/span>/.exec(HTML); return m ? m[1].trim() : null; })();
  assert.ok(original, 'premise: index.html carries the lock\'s own line');
  flag = false;
  await p.mods.app.loadMenu('x_pizza'); await settle(60);
  assert.equal(p.detail().querySelector('.calloutquiet1b'), null);
  assert.ok([...p.detail().querySelectorAll('.price input')].some((i) => !i.disabled));
  const lock = p.d.getElementById('menulock');
  assert.ok(lock.classList.contains('hidden'));
  assert.equal(lock.querySelector('.lock').textContent.trim(), original, 'the shared lock line is restored for the screens that own it');
  assert.ok(!p.d.getElementById('review').disabled || p.d.getElementById('review').title !== COPY.bar);
});
