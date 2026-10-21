// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5 §5 + §11 A1–A3) — the shell's ONE-selection-per-page contract, through
// the REAL app.js / ventas.js / shell.js modules (only auth.js is stubbed, as in ventas.test.mjs), with a fetch stub that
// COUNTS calls per function. A "reload" is a fresh DOM + fresh module instances over the SAME sessionStorage.
// Run: node --test xpizza-portal/shell.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, installFetch, loadModules, okJson, errJson, settle, hasClass, textOf } from './ventas-harness.mjs';

const MENU = () => okJson({ source: { restaurant_id: 'r_a', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
const STATS = () => okJson({ kpis: { sales_cents: 1, orders: 1, average_paid_ticket_cents: 1 }, deltas: {}, comparison: { range: { from: '2026-10-01', to: '2026-10-07' }, kpis: {}, series: [] }, series: [], days: [], missing_days: [] });
const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const MGR_CAPS = ['stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const branch = (rid, extra = {}) => ({ rid, brand_id: 'marca_s', role: 'owner', state: 'member', caps: OWNER_CAPS, name: rid.toUpperCase(),
  identity_version: 2, editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null, ...extra });
const E1 = (branches) => ({ brands: [{ brand_id: 'marca_s', name: 'Marca S' }], branches });

// sessionStorage that survives a "reload"; a reload counter
function installStorage() {
  const m = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; }, _m: m,
  };
  return m;
}
function page({ e1, e1Second, extra } = {}) {
  const byId = installDom();
  const reloads = { n: 0 };
  globalThis.window.location = { reload: () => { reloads.n += 1; } };
  globalThis.window.scrollTo = () => {};
  globalThis.__branchesDirect = true;
  let answered = 0;
  const calls = installFetch((fn, q) => {
    const x = extra && extra(fn, q);
    if (x) return x;
    if (fn === 'getMyBranches') { answered += 1; return okJson(answered > 1 && e1Second ? e1Second : e1); }
    if (fn === 'getEditableCatalog') return MENU();
    if (fn === 'getSalesStats') return STATS();
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  return { byId, calls, reloads, count: (fn) => calls.filter((c) => c.fn === fn).length };
}
async function signIn(uid) {
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(20);
}
const restaurantEvents = () => {
  const seen = [];
  const orig = document.dispatchEvent;
  document.dispatchEvent = (evt) => { if (evt.type === 'portal:restaurant') seen.push(evt.detail); return orig(evt); };
  return seen;
};

test('OWNER: boot makes ONE getEditableCatalog and ZERO getSalesStats; opening Ventas makes exactly one', async () => {
  installStorage();
  const P = page({ e1: E1([branch('r_a')]) });
  await loadModules();
  const ev = restaurantEvents();
  await signIn('uOwner0001');
  assert.equal(P.count('getMyBranches'), 1);
  assert.equal(P.count('getEditableCatalog'), 1, 'the editor opened once');
  assert.equal(P.count('getSalesStats'), 0, 'boot does not load Ventas');
  assert.deepEqual(ev, [{ rid: 'r_a', sales: true }], 'portal:restaurant fired exactly once, Ventas allowed');
  assert.ok(!hasClass(P.byId.get('navventas'), 'hidden'), 'the Ventas nav is shown to the owner');
  P.byId.get('navventas').click();
  await settle(20);
  assert.equal(P.count('getSalesStats'), 1, 'opening Ventas makes exactly one request');
  assert.equal(textOf(P.byId.get('shopname')), 'Marca S');
});

test('MANAGER without the editor: ZERO getEditableCatalog and ZERO getSalesStats, even when the hidden Ventas nav is forced', async () => {
  installStorage();
  const P = page({ e1: E1([branch('r_n', { role: 'manager', caps: MGR_CAPS })]) });
  await loadModules();
  const ev = restaurantEvents();
  await signIn('uManager001');
  assert.equal(P.count('getEditableCatalog'), 0, 'no editor request');
  assert.deepEqual(ev, [], 'portal:restaurant never fires for a manager without catalog.read_editor');
  for (const id of ['navventas', 'mnventas']) P.byId.get(id).click();
  await settle(20);
  assert.equal(P.count('getSalesStats'), 0, 'Ventas can never load');
  assert.ok(hasClass(P.byId.get('navventas'), 'hidden') && hasClass(P.byId.get('mnventas'), 'hidden'), 'and its nav stays hidden');
  assert.ok(P.count('getBranchAvailability') >= 1, 'Productos shows the read-only menu (E4) instead');
  assert.ok(!hasClass(P.byId.get('menulock'), 'hidden'), '«Solo lectura · agotados sí»');
  assert.equal(textOf(P.byId.get('navsuctext')), 'Mi sucursal');
  assert.ok(hasClass(P.byId.get('scopebtn'), 'locked'), 'a single-branch manager is locked to their branch');
});

test('MANAGER WITH the menu permission: the editor once, Ventas never (owner-only in 1a)', async () => {
  installStorage();
  const P = page({ e1: E1([branch('r_n', { role: 'manager', caps: [...MGR_CAPS, 'catalog.read_editor', 'catalog.edit'] })]) });
  await loadModules();
  const ev = restaurantEvents();
  await signIn('uManager002');
  assert.equal(P.count('getEditableCatalog'), 1);
  assert.deepEqual(ev, [{ rid: 'r_n', sales: false }]);
  for (const id of ['navventas', 'mnventas']) P.byId.get(id).click();
  await settle(20);
  assert.equal(P.count('getSalesStats'), 0, 'ventas.js refuses the event with sales:false — no request, even forced');
  assert.ok(hasClass(P.byId.get('navventas'), 'hidden'));
});

test('a persisted NON-default selection survives the real boot order after a reload (A2); owner A → manager-only B → owner A', async () => {
  const store = installStorage();
  const both = E1([branch('r_a'), branch('r_b', { role: 'manager', caps: MGR_CAPS })]);
  // the owner of r_a also manages r_b (another brand would work the same way); start on r_b
  store.set('sherpa.portal.sel.uMix00001', JSON.stringify({ brand_id: 'marca_s', scope: 'r_b' }));
  // a brand holding one owned + one managed branch is a mixed roster: isOwner is false, so the default would be r_a; r_b was stored
  let P = page({ e1: both });
  await loadModules();
  let ev = restaurantEvents();
  await signIn('uMix00001');
  assert.equal(JSON.parse(store.get('sherpa.portal.sel.uMix00001')).scope, 'r_b', 'the initial portal:auth did not clear the stored selection');
  assert.equal(P.count('getEditableCatalog'), 0, 'on B (no editor): zero editor requests');
  assert.equal(P.count('getSalesStats'), 0);
  assert.deepEqual(ev, []);
  // switch to A: persisted, then a reload
  store.set('sherpa.portal.sel.uMix00001', JSON.stringify({ brand_id: 'marca_s', scope: 'r_a' }));
  P = page({ e1: both });
  await loadModules();
  ev = restaurantEvents();
  await signIn('uMix00001');
  assert.equal(P.count('getEditableCatalog'), 1, 'on A: exactly one editor request');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].rid, 'r_a');
  // and back to B
  store.set('sherpa.portal.sel.uMix00001', JSON.stringify({ brand_id: 'marca_s', scope: 'r_b' }));
  P = page({ e1: both });
  await loadModules();
  ev = restaurantEvents();
  await signIn('uMix00001');
  assert.equal(P.count('getEditableCatalog'), 0);
  assert.deepEqual(ev, []);
});

test('sign-out clears the persisted selection + cache; an account change ignores the previous uid\'s keys', async () => {
  const store = installStorage();
  const P = page({ e1: E1([branch('r_a'), branch('r_b')]) });
  await loadModules();
  await signIn('uOwner0002');
  assert.ok(store.has('sherpa.portal.sel.uOwner0002') && store.has('sherpa.portal.branches.uOwner0002'));
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: null } }));
  await settle();
  assert.ok(!store.has('sherpa.portal.sel.uOwner0002') && !store.has('sherpa.portal.branches.uOwner0002'), 'sign-out cleared them');
  void P;
  // an account change on a fresh page: the other uid's keys are never read
  store.set('sherpa.portal.sel.uSomeoneElse', JSON.stringify({ brand_id: 'marca_s', scope: 'r_b' }));
  const Q = page({ e1: E1([branch('r_a'), branch('r_b')]) });
  await loadModules();
  await signIn('uOwner0003');
  assert.equal(JSON.parse(store.get('sherpa.portal.sel.uOwner0003')).scope, 'all', 'a new uid starts from its own default');
  void Q;
});

test('a SECOND sign-in on the same page is a guarded reload, never a second portal:restaurant (A1)', async () => {
  installStorage();
  const P = page({ e1: E1([branch('r_a')]) });
  await loadModules();
  const ev = restaurantEvents();
  await signIn('uOwner0004');
  assert.equal(ev.length, 1);
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uOwner0004' } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle();
  assert.equal(P.reloads.n, 1, 'the page reloads');
  assert.equal(ev.length, 1, 'the OLD page dispatched nothing more');
  assert.equal(P.count('getMyBranches'), 1, 'and fetched nothing more');
});

test('a switch is BLOCKED while the editor has a focused field or an ops edit is unsaved (D13), and proceeds after', async () => {
  installStorage();
  const P = page({ e1: E1([branch('r_a'), branch('r_b')]) });
  const mods = await loadModules();
  await signIn('uOwner0005');
  const { select, canLeave } = mods.shell;
  // a focused INPUT: the editor's own self-update guard says no
  const input = document.createElement('INPUT');
  document.activeElement = input;
  input.tagName = 'INPUT';
  assert.equal(canLeave(), false, 'the editor guard (portalCanReload) blocks');
  assert.equal(select({ brand_id: 'marca_s', scope: 'r_b' }), false);
  assert.equal(P.reloads.n, 0, 'no reload');
  assert.ok(textOf(P.byId.get('scopenote')).includes('Guardá o descartá tus cambios'), 'D13 shows');
  document.activeElement = null;
  // an unsaved prep edit on the detail screen
  mods.shell.goto('suc', { rid: 'r_a' });
  const sec = (n) => (n.children || []).flatMap((c) => (c && typeof c === 'object' ? [c, ...sec(c)] : []));
  const plus = sec(P.byId.get('viewsuc')).find((n) => n.tag === 'button' && n.attrs['aria-label'] === 'Más 5 minutos');
  assert.ok(plus, 'the prep stepper is rendered');
  plus.click();
  assert.equal(canLeave(), false, 'a dirty detail blocks');
  assert.equal(select({ brand_id: 'marca_s', scope: 'r_b' }), false);
  assert.equal(P.reloads.n, 0);
  P.byId.get('sucdiscard').click();
  assert.equal(canLeave(), true, 'discarded → free');
  assert.equal(select({ brand_id: 'marca_s', scope: 'r_b' }), true);
  assert.equal(P.reloads.n, 1, 'the switch reloads');
  assert.equal(JSON.parse(globalThis.sessionStorage.getItem('sherpa.portal.sel.uOwner0005')).scope, 'r_b', 'with the new selection persisted');
});

test('a cached answer whose capabilities were revoked → exactly one reload when the fresh answer arrives', async () => {
  const store = installStorage();
  store.set('sherpa.portal.branches.uOwner0006', JSON.stringify(E1([branch('r_a')])));
  const P = page({ e1: E1([branch('r_a', { role: 'manager', caps: MGR_CAPS })]) });
  await loadModules();
  await signIn('uOwner0006');
  assert.equal(P.reloads.n, 1, 'the decision changed → one reload');
  assert.equal(JSON.parse(store.get('sherpa.portal.branches.uOwner0006')).branches[0].role, 'manager', 'the fresh answer is cached for the next page');
});

test('no branches → the plain «no administra ningún local» state, no editor, no ops nav', async () => {
  installStorage();
  const P = page({ e1: E1([]) });
  await loadModules();
  await signIn('uNobody001');
  assert.equal(P.count('getEditableCatalog'), 0);
  assert.ok(hasClass(P.byId.get('navsuc'), 'hidden'));
  assert.ok(textOf(P.byId.get('detail')).includes('no administra ningún local'));
});

// ── codex 1a r1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const all = (n) => (n && n.children ? n.children : []).flatMap((c) => (c && typeof c === 'object' ? [c, ...all(c)] : []));
const byAria = (root, a) => all(root).find((n) => n.tag === 'button' && n.attrs['aria-label'] === a);
const byText = (root, t) => all(root).find((n) => n.tag === 'button' && textOf(n).includes(t));
const hold = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('codex r1 P1-2: the self-update coordinator asks the COMPOSITE guard — an unsaved prep edit blocks the auto reload', async () => {
  installStorage();
  const P = page({ e1: E1([branch('r_a')]) });
  const adapters = [];
  globalThis.window.SherpaClient = { inert: false, registerAdapter: (a) => adapters.push(a) };
  try {
    const mods = await loadModules();
    await signIn('uOwner0101');
    assert.equal(adapters.length, 2, 'app.js registers its adapter, then shell.js replaces it');
    const [editorOnly, composite] = adapters;
    assert.equal(composite.blockedNotice, editorOnly.blockedNotice, 'same notice copy');
    mods.shell.goto('suc', { rid: 'r_a' });
    byAria(P.byId.get('viewsuc'), 'Más 5 minutos').click();
    assert.equal(editorOnly.canReload(), true, 'non-vacuity: the editor-only adapter would have reloaded over the prep edit');
    assert.equal(composite.canReload(), false, 'the registered (composite) adapter refuses');
    P.byId.get('sucdiscard').click();
    assert.equal(composite.canReload(), true, 'discarded → free');
  } finally { delete globalThis.window.SherpaClient; }
});

test('codex r1 P1-1: a prep save that settles AFTER an auth change releases its bookkeeping — the guarded reload proceeds', async () => {
  installStorage();
  const h = hold();
  const P = page({ e1: E1([branch('r_a')]), extra: (fn) => (fn === 'updateBranch' ? h.p : undefined) });
  const mods = await loadModules();
  await signIn('uOwner0102');
  mods.shell.goto('suc', { rid: 'r_a' });
  byAria(P.byId.get('viewsuc'), 'Más 5 minutos').click();
  P.byId.get('sucsave').click();
  await settle(5);
  assert.deepEqual([...mods.shell._shellState.busy], ['suc-save'], 'in flight');
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uOwner0102' } }));   // the generation bumps
  assert.equal(mods.shell.requestReload(), false, 'blocked while the write is in flight');
  h.release(okJson({ ok: true, identity_version: 3, editable: { prep_default_min: 25 } }));
  await settle(10);
  assert.equal(mods.shell._shellState.busy.size, 0, 'busy released on the obsolete settlement');
  assert.equal(mods.shell._shellState.dirty.size, 0, 'the written draft is no longer unsaved');
  await wait(1150);
  assert.equal(P.reloads.n, 1, 'the waiting guarded reload went through');
});

test('codex r1 P1-1: a pause request that FAILS after an auth change releases its bookkeeping too', async () => {
  installStorage();
  const h = hold();
  const paused = { state: 'paused', paused_until: Date.now() + 3600e3, pause_reason: 'Cocina llena', pause_since: Date.now() };
  const P = page({ e1: E1([branch('r_a', { control: paused })]), extra: (fn) => (fn === 'setBranchPause' ? h.p : undefined) });
  const mods = await loadModules();
  await signIn('uOwner0103');
  mods.shell.goto('pausas');
  byText(P.byId.get('viewpausas'), 'Reanudar pedidos').click();
  await settle(5);
  assert.equal(mods.shell._shellState.busy.size, 1, 'in flight');
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uOwner0103' } }));
  h.release(errJson(503, { error: 'unavailable', retryable: true }));
  await settle(10);
  assert.equal(mods.shell._shellState.busy.size, 0, 'released');
  assert.equal(mods.shell.canLeave(), true);
});

test('codex r1 P2-3: the CAS baseline is the version the draft STARTED on — a background refresh never replaces it', async () => {
  const store = installStorage();
  store.set('sherpa.portal.branches.uOwner0104', JSON.stringify(E1([branch('r_a')])));   // cached: version 2, prep 20
  const fresh = hold();
  let first = true;
  const P = page({ e1: null, extra: (fn) => {
    if (fn === 'getMyBranches' && first) { first = false; return fresh.p; }
    if (fn === 'updateBranch') return errJson(409, { error: 'stale_branch' });
    return undefined;
  } });
  const mods = await loadModules();
  await signIn('uOwner0104');
  mods.shell.goto('suc', { rid: 'r_a' });
  byAria(P.byId.get('viewsuc'), 'Más 5 minutos').click();                                // 20 → 25, on version 2
  fresh.release(okJson(E1([branch('r_a', { identity_version: 3, editable: { prep_default_min: 40 } })])));
  await settle(10);
  assert.equal(mods.shell._shellState.e1.branches[0].identity_version, 3, 'non-vacuity: the refresh landed under the draft');
  P.byId.get('sucsave').click();
  await settle(10);
  const req = P.calls.find((c) => c.fn === 'updateBranch');
  assert.deepEqual(req.body, { rid: 'r_a', expectedVersion: 2, patch: { prep_default_min: 25 } }, 'saved against version 2 → the server reports the conflict');
  assert.ok(textOf(P.byId.get('viewsuc')).includes('Alguien más cambió esta sucursal'), 'and the conflict is shown');
});

test('codex r1 P2-4: a degraded row never replaces the cached list or the selection; with nothing cached it is an outage, not «ningún local»', async () => {
  const store = installStorage();
  store.set('sherpa.portal.branches.uOwner0105', JSON.stringify(E1([branch('r_a'), branch('r_b')])));
  store.set('sherpa.portal.sel.uOwner0105', JSON.stringify({ brand_id: 'marca_s', scope: 'r_b' }));
  const before = store.get('sherpa.portal.branches.uOwner0105');
  const P = page({ e1: E1([branch('r_a'), { rid: 'r_b', brand_id: 'marca_s', degraded: true }]) });
  await loadModules();
  await signIn('uOwner0105');
  assert.equal(store.get('sherpa.portal.branches.uOwner0105'), before, 'cache untouched');
  assert.deepEqual(JSON.parse(store.get('sherpa.portal.sel.uOwner0105')), { brand_id: 'marca_s', scope: 'r_b' }, 'selection untouched');
  assert.equal(P.reloads.n, 0);

  installStorage();
  const Q = page({ e1: E1([{ rid: 'r_b', brand_id: 'marca_s', degraded: true }]) });
  await loadModules();
  await signIn('uOwner0106');
  const t = textOf(Q.byId.get('detail'));
  assert.ok(t.includes('Sin conexión con Sherpa') && !t.includes('ningún local'), t);
  assert.equal(globalThis.sessionStorage.getItem('sherpa.portal.branches.uOwner0106'), null, 'a partial answer is never cached');
});

test('codex r1 P2-5: a one-branch manager in two brands can still switch BRAND on mobile', async () => {
  installStorage();
  const mgr = (rid, brand) => branch(rid, { brand_id: brand, role: 'manager', caps: MGR_CAPS });
  const P = page({ e1: { brands: [{ brand_id: 'marca_s', name: 'Marca S' }, { brand_id: 'marca_t', name: 'Marca T' }], branches: [mgr('r_a', 'marca_s'), mgr('r_t', 'marca_t')] } });
  const mods = await loadModules();
  await signIn('uMgr000107');
  assert.equal(mods.shell._shellState.sel.locked, true, 'the branch is locked within its brand');
  const items = all(P.byId.get('mscopemenu')).filter((n) => n.tag === 'button');
  assert.deepEqual(items.map(textOf), ['Marca T'], 'the other brand is offered; no branch items');
  assert.ok(!hasClass(P.byId.get('mchev'), 'hidden'), 'the chevron leads somewhere');
});

test('codex r1 P2-6: in EDITOR mode a failed availability read shows the error + Reintentar; a failed branch is «—», never «0»', async () => {
  installStorage();
  let n = 0;
  const P = page({ e1: E1([branch('r_a')]), extra: (fn) => {
    if (fn !== 'getBranchAvailability') return undefined;
    n += 1;
    return n === 1 ? errJson(503, { error: 'unavailable', retryable: true }) : okJson({ branches: [{ rid: 'r_a', published: null, error: 'menu_unavailable', items: [] }] });
  } });
  const mods = await loadModules();
  await signIn('uOwner0108');
  assert.ok(mods.shell._shellState.editorRid, 'non-vacuity: editor mode');
  const strip = P.byId.get('availstrip');
  assert.ok(!hasClass(strip, 'hidden') && textOf(strip).includes('Sin conexión con Sherpa'), textOf(strip));
  byText(strip, 'Reintentar').click();
  await settle(10);
  assert.equal(n, 2, 'retried');
  assert.ok(textOf(strip).includes('No pudimos cargar el menú de R_A'), textOf(strip));
  const chip = all(strip).find((x) => x.tag === 'button' && String(x._class).includes('opsbchip'));
  assert.ok(chip && textOf(chip).includes('—') && !/\b0\b/.test(textOf(chip)), textOf(chip));
});

test('codex r1 P2-7: a settled publish re-reads availability (the published key set moved)', async () => {
  installStorage();
  const P = page({ e1: E1([branch('r_a')]), extra: (fn) => (fn === 'publishEdited' ? okJson({ ok: true }) : undefined) });
  const mods = await loadModules();
  await signIn('uOwner0109');
  assert.equal(P.count('getBranchAvailability'), 1);
  mods.shell._shellState.views.avail.render();
  await settle(5);
  assert.equal(P.count('getBranchAvailability'), 1, 'non-vacuity: a repaint alone does not re-read');
  const api = await import('./api.js');
  await api.publishEdited({ rid: 'r_a', editToken: 'e', acknowledgedChanges: [], fiscalAck: false, token: async () => 'TK' });
  await settle(10);
  assert.equal(P.count('getBranchAvailability'), 2, 're-read after the publish');
});

// ── codex 1a r2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('codex r2 P1: a prep save that FAILS after an auth change restores Guardar / Descartar — Descartar frees the page', async () => {
  installStorage();
  const h = hold();
  const P = page({ e1: E1([branch('r_a')]), extra: (fn) => (fn === 'updateBranch' ? h.p : undefined) });
  const mods = await loadModules();
  await signIn('uOwner0301');
  mods.shell.goto('suc', { rid: 'r_a' });
  byAria(P.byId.get('viewsuc'), 'Más 5 minutos').click();
  P.byId.get('sucsave').click();
  await settle(5);
  assert.ok(P.byId.get('sucsave').disabled && P.byId.get('sucdiscard').disabled, 'non-vacuity: disabled while in flight');
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uOwner0301' } }));
  h.release(errJson(503, { error: 'unavailable', retryable: true }));
  await settle(10);
  assert.equal(mods.shell._shellState.busy.size, 0);
  assert.equal(P.byId.get('sucsave').disabled, false, 'Guardar usable again');
  assert.equal(P.byId.get('sucdiscard').disabled, false, 'Descartar usable again');
  assert.equal(mods.shell.canLeave(), false, 'the failed draft is still unsaved');
  P.byId.get('sucdiscard').click();
  assert.equal(mods.shell.canLeave(), true, 'Descartar frees the page');
});

test('codex r2 P2: a publish during an in-flight availability read queues a refresh that really runs (2 requests)', async () => {
  installStorage();
  const h = hold();
  let n = 0;
  const P = page({ e1: E1([branch('r_a')]), extra: (fn) => {
    if (fn !== 'getBranchAvailability') return undefined;
    n += 1;
    return n === 1 ? h.p : okJson({ branches: [] });
  } });
  await loadModules();
  await signIn('uOwner0302');
  assert.equal(P.count('getBranchAvailability'), 1, 'the first read is in flight');
  document.dispatchEvent(new CustomEvent('portal:published', { detail: { rid: 'r_a' } }));
  h.release(okJson({ branches: [] }));
  await settle(10);
  assert.equal(P.count('getBranchAvailability'), 2, 'the queued refresh ran after the old response');
});

test('codex r2 P2: no cache + a partial reply whose degraded row IS the stored selection → the outage box, scope kept (no fallback)', async () => {
  const store = installStorage();
  store.set('sherpa.portal.sel.uOwner0303', JSON.stringify({ brand_id: 'marca_s', scope: 'r_b' }));
  const P = page({ e1: E1([branch('r_a'), { rid: 'r_b', brand_id: 'marca_s', degraded: true }]) });
  await loadModules();
  await signIn('uOwner0303');
  assert.ok(textOf(P.byId.get('detail')).includes('Sin conexión con Sherpa'), textOf(P.byId.get('detail')));
  assert.equal(P.count('getEditableCatalog'), 0, 'r_a\'s editor never opens in r_b\'s place');
  assert.deepEqual(JSON.parse(store.get('sherpa.portal.sel.uOwner0303')), { brand_id: 'marca_s', scope: 'r_b' }, 'the stored scope stays');

  // non-vacuity: the same partial reply with the HEALTHY row selected still opens that branch
  const s2 = installStorage();
  s2.set('sherpa.portal.sel.uOwner0304', JSON.stringify({ brand_id: 'marca_s', scope: 'r_a' }));
  const Q = page({ e1: E1([branch('r_a'), { rid: 'r_b', brand_id: 'marca_s', degraded: true }]) });
  await loadModules();
  await signIn('uOwner0304');
  assert.equal(Q.count('getEditableCatalog'), 1, 'the healthy selected branch opens');
});

// ── registerView / setNavBadge (PLAN-portal-team-invites §4.1) ─────────────────────────────────────────────────────────
function teamView(log, { leave = () => true } = {}) {
  return { id: 'equipo', group: 'Negocio', label: 'Equipo de trabajo',
    visible: (sel) => { log.push(['visible', sel]); return sel.role === 'owner' && sel.membership_writes_enabled === true; },
    mount: (elm, sel) => log.push(['mount', elm, sel]), unmount: () => log.push(['unmount']), canLeave: () => leave() };
}

test('registerView: hidden while membership_writes_enabled is off; shown (Negocio) when on, with a frozen brand-level sel', async () => {
  installStorage();
  const P = page({ e1: { ...E1([branch('r_a'), branch('r_b', { caps: MGR_CAPS })]), membership_writes_enabled: false } });
  const mods = await loadModules();
  const log = [];
  mods.shell.registerView(teamView(log));
  await signIn('uOwner0201');
  const [r] = mods.shell._registered;
  assert.ok(hasClass(r.nav, 'hidden') && hasClass(r.mn, 'hidden'), 'flag off → no nav item');
  const sel = log.find((x) => x[0] === 'visible')[1];
  assert.ok(Object.isFrozen(sel) && Object.isFrozen(sel.caps));
  assert.deepEqual({ ...sel, caps: [...sel.caps] }, { brandId: 'marca_s', role: 'owner', caps: [...new Set([...OWNER_CAPS, ...MGR_CAPS])].sort(), membership_writes_enabled: false, scope: null });
  mods.shell.goto('equipo');
  assert.ok(!log.some((x) => x[0] === 'mount'), 'a hidden view never mounts');
  assert.ok(P.byId.get('navprod').clicks >= 1, '…and a direct goto falls back to Productos');

  installStorage();
  const Q = page({ e1: { ...E1([branch('r_a')]), membership_writes_enabled: true } });
  const m2 = await loadModules();
  const log2 = [];
  m2.shell.registerView(teamView(log2));
  await signIn('uOwner0202');
  const [r2] = m2.shell._registered;
  assert.ok(!hasClass(r2.nav, 'hidden') && !hasClass(r2.mn, 'hidden'), 'flag on → nav item, desktop + mobile');
  assert.ok(!hasClass(Q.byId.get('navbiz'), 'hidden'), 'the Negocio label shows');
  assert.equal(textOf(r2.nav), 'Equipo de trabajo');
});

test('registerView: an optional icon (one SVG path d) is drawn like the built-ins; absent → label only; anything else refused', async () => {
  installStorage();
  page({ e1: { ...E1([branch('r_a')]), membership_writes_enabled: true } });
  const mods = await loadModules();
  const D = 'M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 21a8 8 0 0 1 16 0';
  mods.shell.registerView({ ...teamView([]), icon: D });
  mods.shell.registerView({ ...teamView([]), id: 'sin-icono' });
  for (const bad of ['<script>', 'M0 0" onload="x', 42, 'M'.repeat(513)]) assert.throws(() => mods.shell.registerView({ ...teamView([]), id: 'malo', icon: bad }), /icon/);
  const [withIcon, without] = mods.shell._registered;
  const s = withIcon.nav.children[0];
  assert.equal(s.tag, 'svg');
  assert.equal(s.attrs.viewBox, '0 0 24 24');
  assert.equal(s.children[0].tag, 'path');
  assert.equal(s.children[0].attrs.d, D);
  assert.equal(without.nav.children[0].tag, 'span', 'no icon → the label first');
});

test('registerView: goto mounts it (others hidden), leaving unmounts it; its canLeave() blocks a selection change only while mounted', async () => {
  installStorage();
  let dirty = true;
  const P = page({ e1: { ...E1([branch('r_a'), branch('r_b')]), membership_writes_enabled: true } });
  const mods = await loadModules();
  const log = [];
  mods.shell.registerView(teamView(log, { leave: () => !dirty }));
  await signIn('uOwner0203');
  const [r] = mods.shell._registered;
  assert.equal(mods.shell.canLeave(), true, 'not mounted → not consulted');
  r.nav.click();
  const mount = log.find((x) => x[0] === 'mount');
  assert.ok(mount && mount[1] === r.main && !hasClass(r.main, 'hidden'), 'mounted into its own main');
  assert.ok(hasClass(P.byId.get('viewsuc'), 'hidden') && hasClass(P.byId.get('viewmenu'), 'hidden'));
  assert.ok(hasClass(r.nav, 'on') && r.nav.attrs['aria-current'] === 'page');
  assert.equal(mods.shell.select({ brand_id: 'marca_s', scope: 'r_b' }), false, 'its unsaved state blocks the reload');
  assert.equal(P.reloads.n, 0);
  dirty = false;
  assert.equal(mods.shell.canLeave(), true);
  dirty = true;
  P.byId.get('navprod').click();
  assert.deepEqual(log.filter((x) => x[0] === 'unmount').length, 1, 'leaving unmounts');
  assert.ok(hasClass(r.main, 'hidden'));
  assert.equal(mods.shell.canLeave(), true, 'unmounted → no longer consulted');
});

test('registerView refuses a bad shape and any registration after the nav is drawn', async () => {
  installStorage();
  page({ e1: E1([branch('r_a')]) });
  const mods = await loadModules();
  const ok = teamView([]);
  for (const bad of [{ ...ok, id: 'suc' }, { ...ok, id: 'Bad Id' }, { ...ok, group: 'Otro' }, { ...ok, label: ' ' }, { ...ok, mount: null }, null]) {
    assert.throws(() => mods.shell.registerView(bad), /registerView/);
  }
  mods.shell.registerView(ok);
  assert.throws(() => mods.shell.registerView(ok), /duplicate/, 'one id once');
  await signIn('uOwner0204');
  assert.throws(() => mods.shell.registerView({ ...ok, id: 'tarde' }), /before the nav is first drawn/);
});

test('setNavBadge: text on Productos (desktop + mobile) through textContent; null removes it; an unknown id is a no-op', async () => {
  installStorage();
  const P = page({ e1: { ...E1([branch('r_a')]), membership_writes_enabled: true } });
  const mods = await loadModules();
  mods.shell.registerView(teamView([]));
  await signIn('uOwner0205');
  const badgeOf = (n) => (n.children || []).find((c) => c && c.dataset && c.dataset.navbadge === '1');
  mods.shell.setNavBadge('menu', 1);
  for (const id of ['navprod', 'mnprod']) { const b = badgeOf(P.byId.get(id)); assert.ok(b && b.textContent === '1' && !hasClass(b, 'hidden'), id); }
  mods.shell.setNavBadge('menu', '<b>x</b>');
  assert.equal(badgeOf(P.byId.get('navprod')).textContent, '<b>x</b>', 'set as text, never parsed');
  mods.shell.setNavBadge('menu', null);
  assert.ok(hasClass(badgeOf(P.byId.get('navprod')), 'hidden'), 'null hides it');
  mods.shell.setNavBadge('equipo', '2');
  assert.equal(badgeOf(mods.shell._registered[0].nav).textContent, '2', 'a registered view takes a badge too');
  assert.doesNotThrow(() => mods.shell.setNavBadge('nada', '3'));
});

// ── slice 2 «Equipos» (PLAN-portal-ui-slice2-equipos r1.1 §4–§5) ───────────────────────────────────────────────────────
const DEV_CAPS = [...OWNER_CAPS, 'device.pair', 'device.list', 'device.revoke'];
const ebranch = (rid, extra = {}) => branch(rid, { caps: DEV_CAPS, devices: 1, ...extra });
const T0 = Date.UTC(2026, 9, 20, 18, 0);
const dev = (uid, n, extra = {}) => ({ uid, n, paired_at: T0 - 86400000 * 10, last_seen: T0 - 60000, paired_by_name: null, paired_by_owner: true, ...extra });
const e6 = (branches, extra = {}) => okJson({ fetched_at: T0, pairing_enabled: true, branches, ...extra });
const btnText = (root, t) => all(root).find((n) => n.tag === 'button' && textOf(n) === t);

test('Equipos: nav shown with the linked count; EVERY entry re-fetches; «Actualizar» re-fetches; rows labelled «Equipo N»', async () => {
  installStorage();
  let k = 0;
  const P = page({ e1: E1([ebranch('r_a', { devices: 2 }), ebranch('r_b', { devices: 1 })]), extra: (fn, q) => {
    if (fn !== 'getBranchDevices') return undefined;
    k += 1;
    assert.deepEqual(q, { brandId: 'marca_s' }, 'the brand query for «Todas»');
    return e6([{ rid: 'r_a', prep_ok: true, order_surface: 'handheld', devices: [dev('hh_1', 1), dev('hh_2', 2, { last_seen: T0 - 3600000 })] },
      { rid: 'r_b', prep_ok: true, order_surface: 'kds', devices: [dev('hh_3', 1, { last_seen: null })] }]);
  } });
  const mods = await loadModules();
  await signIn('uOwner0401');
  assert.ok(!hasClass(P.byId.get('navequipos'), 'hidden') && !hasClass(P.byId.get('mnequipos'), 'hidden'));
  assert.equal(textOf(P.byId.get('navequiposcount')), '3');
  assert.equal(k, 0, 'nothing fetched before the screen is opened');
  P.byId.get('navequipos').click();
  await settle(10);
  assert.equal(k, 1);
  const v = P.byId.get('viewequipos');
  const t = textOf(v);
  for (const s of ['Equipo 1', 'Equipo 2', 'Vinculado el 10 oct por el dueño', 'hace 1 min', 'hace 1 h', 'Nunca', 'En línea', 'Sin señal', 'Actualizado 12:00', '3 equipos']) assert.ok(t.includes(s), `shows ${s}`);
  btnText(v, 'Actualizar').click();
  await settle(10);
  assert.equal(k, 2, '«Actualizar» re-fetches');
  P.byId.get('navprod').click();
  P.byId.get('navequipos').click();
  await settle(10);
  assert.equal(k, 3, 're-entry re-fetches (no page-lifetime cache)');
  void mods;
});

test('Equipos: an OBSOLETE reply is dropped (a newer fetch owns the screen); a per-branch failure is an error, never «Ningún equipo»', async () => {
  installStorage();
  const first = hold();
  let k = 0;
  const P = page({ e1: E1([ebranch('r_a'), ebranch('r_b')]), extra: (fn) => {
    if (fn !== 'getBranchDevices') return undefined;
    k += 1;
    if (k === 1) return first.p;
    return e6([{ rid: 'r_a', prep_ok: true, order_surface: 'kds', devices: [dev('hh_new', 1)] }, { rid: 'r_b', error: 'devices_unavailable' }]);
  } });
  await loadModules();
  await signIn('uOwner0402');
  P.byId.get('navequipos').click();
  await settle(5);
  P.byId.get('navprod').click();
  P.byId.get('navequipos').click();
  await settle(10);
  first.release(e6([{ rid: 'r_a', prep_ok: true, order_surface: 'kds', devices: [dev('hh_old', 1), dev('hh_old2', 2)] }, { rid: 'r_b', prep_ok: true, order_surface: 'kds', devices: [] }]));
  await settle(10);
  const t = textOf(P.byId.get('viewequipos'));
  assert.ok(t.includes('1 equipo') && !t.includes('2 equipos'), 'the newer reply stays');
  assert.ok(t.includes('No pudimos cargar los equipos de R_B'), 'the failed branch is named');
  assert.ok(!t.includes('Ningún equipo vinculado'), 'never rendered as empty');
});

test('Equipos: pairing off → one line instead of «Lista»; a branch without prep gets the warning + «Definirlo»', async () => {
  installStorage();
  const P = page({ e1: E1([ebranch('r_a', { devices: 0 })]), extra: (fn) => (fn === 'getBranchDevices'
    ? e6([{ rid: 'r_a', prep_ok: false, order_surface: 'handheld', devices: [] }], { pairing_enabled: false }) : undefined) });
  const mods = await loadModules();
  await signIn('uOwner0403');
  P.byId.get('navequipos').click();
  await settle(10);
  const v = P.byId.get('viewequipos');
  const t = textOf(v);
  assert.ok(t.includes('La vinculación de equipos todavía no está habilitada en Sherpa.') && !t.includes('Lista'));
  assert.ok(t.includes('R_A no puede vincular equipos todavía.') && t.includes('Ningún equipo vinculado en R_A'));
  assert.ok(!t.includes('kiosco') && !t.includes('Caja'), 'the dropped claims (E-D1 / E-D2) are gone');
  btnText(v, 'Definirlo').click();
  assert.equal(mods.shell._shellState.view, 'suc', '«Definirlo» opens the branch (prep)');
});

test('Equipos: «Desvincular» → E7 → row gone, count patched, toast; the modal says the TRUE boundary', async () => {
  installStorage();
  let gone = false;   // the stub server: after E7, E6 no longer lists the device
  const P = page({ e1: E1([ebranch('r_a', { devices: 2 })]), extra: (fn) => {
    if (fn === 'getBranchDevices') return e6([{ rid: 'r_a', prep_ok: true, order_surface: 'handheld', devices: [dev('hh_1', 1), ...(gone ? [] : [dev('hh_2', 2)])] }]);
    if (fn === 'revokeBranchDevice') { gone = true; return okJson({ ok: true, uid: 'hh_2', paused: false }); }
    return undefined;
  } });
  await loadModules();
  await signIn('uOwner0404');
  P.byId.get('navequipos').click();
  await settle(10);
  const v = P.byId.get('viewequipos');
  all(v).filter((n) => n.tag === 'button' && textOf(n) === 'Desvincular')[1].click();
  const m = P.byId.get('devmodal');
  const mt = textOf(m);
  assert.ok(mt.includes('¿Desvincular «Equipo 2»?') && mt.includes('Una acción que ya estaba en proceso puede completarse') && mt.includes('los siguen atendiendo los otros equipos'));
  assert.ok(!mt.includes('Es el único equipo'), 'not the last one');
  btnText(m, 'Desvincular').click();
  await settle(10);
  assert.deepEqual(P.calls.find((c) => c.fn === 'revokeBranchDevice').body, { rid: 'r_a', uid: 'hh_2' });
  const t = textOf(v);
  assert.ok(t.includes('Equipo 1') && !t.includes('Equipo 2'), 'the row is gone');
  assert.equal(P.count('getBranchDevices'), 2, 'a successful revoke reconciles with a fresh list');
  assert.equal(textOf(P.byId.get('navequiposcount')), '1', 'E1 count patched');
  assert.ok(textOf(P.byId.get('opstoast')).includes('«Equipo 2» desvinculado'));
});

test('Equipos owner ruling (b): a handheld branch\'s ONLY device → «Desvincular y pausar sucursal»; paused → branch patched', async () => {
  installStorage();
  const P = page({ e1: E1([ebranch('r_a')]), extra: (fn) => {
    if (fn === 'getBranchDevices') return e6([{ rid: 'r_a', prep_ok: true, order_surface: 'handheld', devices: [dev('hh_1', 1)] }]);
    if (fn === 'revokeBranchDevice') return okJson({ ok: true, uid: 'hh_1', paused: true });
    return undefined;
  } });
  const mods = await loadModules();
  await signIn('uOwner0405');
  P.byId.get('navequipos').click();
  await settle(10);
  btnText(P.byId.get('viewequipos'), 'Desvincular').click();
  const m = P.byId.get('devmodal');
  assert.ok(textOf(m).includes('Es el único equipo de esta sucursal. Al desvincularlo, la sucursal se pausa para que ningún pedido quede sin atender.'));
  btnText(m, 'Desvincular y pausar sucursal').click();
  await settle(10);
  assert.equal(mods.shell._shellState.e1.branches[0].control.state, 'paused', 'the branch shows paused (as Pausar would)');
  assert.ok(textOf(P.byId.get('opstoast')).includes('«Equipo 1» desvinculado · R_A pausada'));
});

test('Equipos: the pause FAILED after the revoke → a panel with «Pausar sucursal» (E3 «Otro», until resumed), never a toast', async () => {
  installStorage();
  const P = page({ e1: E1([ebranch('r_a')]), extra: (fn) => {
    if (fn === 'getBranchDevices') return e6([{ rid: 'r_a', prep_ok: true, order_surface: 'handheld', devices: [dev('hh_1', 1)] }]);
    if (fn === 'revokeBranchDevice') return okJson({ ok: true, uid: 'hh_1', paused: false, pause_error: 'unavailable' });
    if (fn === 'setBranchPause') return okJson({ ok: true, noop: false, control: { state: 'paused', paused_until: null, pause_reason: 'Otro', pause_since: T0 } });
    return undefined;
  } });
  const mods = await loadModules();
  await signIn('uOwner0406');
  P.byId.get('navequipos').click();
  await settle(10);
  const v = P.byId.get('viewequipos');
  btnText(v, 'Desvincular').click();
  btnText(P.byId.get('devmodal'), 'Desvincular y pausar sucursal').click();
  await settle(10);
  assert.ok(textOf(v).includes('Desvinculamos el equipo, pero no pudimos pausar R_A.'));
  btnText(v, 'Pausar sucursal').click();
  await settle(10);
  assert.deepEqual(P.calls.find((c) => c.fn === 'setBranchPause').body, { rid: 'r_a', op: 'pause', dur_min: null, reason: 'Otro' });
  assert.equal(mods.shell._shellState.e1.branches[0].control.state, 'paused');
  assert.ok(!textOf(v).includes('no pudimos pausar'), 'the panel clears once paused');
});

test('Equipos: a kds branch\'s only device → plain «Desvincular» (no pause wording); an E7 failure is a panel, not a toast', async () => {
  installStorage();
  const P = page({ e1: E1([ebranch('r_a')]), extra: (fn) => {
    if (fn === 'getBranchDevices') return e6([{ rid: 'r_a', prep_ok: true, order_surface: 'kds', devices: [dev('hh_1', 1)] }]);
    if (fn === 'revokeBranchDevice') return errJson(503, { error: 'unavailable', retryable: true });
    return undefined;
  } });
  await loadModules();
  await signIn('uOwner0407');
  P.byId.get('navequipos').click();
  await settle(10);
  const v = P.byId.get('viewequipos');
  btnText(v, 'Desvincular').click();
  const m = P.byId.get('devmodal');
  assert.ok(!textOf(m).includes('Es el único equipo') && !btnText(m, 'Desvincular y pausar sucursal'));
  const toastBefore = textOf(P.byId.get('opstoast'));
  btnText(m, 'Desvincular').click();
  await settle(10);
  assert.ok(textOf(v).includes('No se pudo desvincular el equipo') || textOf(v).includes('Sin conexión con Sherpa'));
  assert.equal(textOf(P.byId.get('opstoast')), toastBefore, 'no toast on failure');
  assert.ok(textOf(v).includes('Equipo 1'), 'the row stays');
});

test('Equipos: S2\'s «Equipos · N» opens Equipos for THAT branch (rid query)', async () => {
  installStorage();
  let q = null;
  const P = page({ e1: E1([ebranch('r_a', { devices: 3 }), ebranch('r_b')]), extra: (fn, query) => {
    if (fn === 'getBranchDevices') { q = query; return e6([{ rid: 'r_b', prep_ok: true, order_surface: 'kds', devices: [] }]); }
    return undefined;
  } });
  const mods = await loadModules();
  await signIn('uOwner0408');
  mods.shell.goto('suc', { rid: 'r_b' });
  btnText(P.byId.get('viewsuc'), 'Equipos · 1').click();
  await settle(10);
  assert.deepEqual(q, { restaurantId: 'r_b' });
  assert.ok(textOf(P.byId.get('viewequipos')).includes('Ningún equipo vinculado en R_B'));
});

// ── codex build r1 (Equipos): server-decided recovery, retained retry, visible refresh errors, fetch generations, empty header ──
test('Equipos (r1 P1): a STALE two-device list + the server says pause_error → the recovery panel still shows', async () => {
  installStorage();
  const P = page({ e1: E1([ebranch('r_a', { devices: 2 })]), extra: (fn) => {
    if (fn === 'getBranchDevices') return e6([{ rid: 'r_a', prep_ok: true, order_surface: 'handheld', devices: [dev('hh_1', 1), dev('hh_2', 2)] }]);
    // meanwhile another session revoked hh_1, so THIS revoke was the last device and its auto-pause failed
    if (fn === 'revokeBranchDevice') return okJson({ ok: true, uid: 'hh_2', paused: false, pause_error: 'unavailable' });
    return undefined;
  } });
  await loadModules();
  await signIn('uOwner0410');
  P.byId.get('navequipos').click();
  await settle(10);
  const v = P.byId.get('viewequipos');
  all(v).filter((n) => n.tag === 'button' && textOf(n) === 'Desvincular')[1].click();
  const m = P.byId.get('devmodal');
  assert.ok(!textOf(m).includes('Es el único equipo'), 'non-vacuity: the stale list predicted no pause');
  btnText(m, 'Desvincular').click();
  await settle(10);
  assert.ok(textOf(v).includes('Desvinculamos el equipo, pero no pudimos pausar R_A.'), 'the server result decides');
  assert.ok(btnText(v, 'Pausar sucursal'));
});

test('Equipos (r1 P2): an E7 failure keeps the operation — «Reintentar» re-sends the SAME rid + uid, and survives «Actualizar»', async () => {
  installStorage();
  let fail = true;
  const P = page({ e1: E1([ebranch('r_a', { devices: 2 })]), extra: (fn) => {
    if (fn === 'getBranchDevices') return e6([{ rid: 'r_a', prep_ok: true, order_surface: 'handheld', devices: [dev('hh_1', 1), dev('hh_2', 2)] }]);
    if (fn === 'revokeBranchDevice') return fail ? errJson(503, { error: 'unavailable', retryable: true }) : okJson({ ok: true, uid: 'hh_2', paused: false });
    return undefined;
  } });
  await loadModules();
  await signIn('uOwner0411');
  P.byId.get('navequipos').click();
  await settle(10);
  const v = P.byId.get('viewequipos');
  all(v).filter((n) => n.tag === 'button' && textOf(n) === 'Desvincular')[1].click();
  btnText(P.byId.get('devmodal'), 'Desvincular').click();
  await settle(10);
  assert.ok(btnText(v, 'Reintentar'), 'the failure offers «Reintentar»');
  btnText(v, 'Actualizar').click();
  await settle(10);
  assert.equal(P.count('getBranchDevices'), 2);
  assert.ok(btnText(v, 'Reintentar'), 'a list refresh never drops the failed operation');
  fail = false;
  btnText(v, 'Reintentar').click();
  await settle(10);
  const sent = P.calls.filter((c) => c.fn === 'revokeBranchDevice').map((c) => c.body);
  assert.deepEqual(sent, [{ rid: 'r_a', uid: 'hh_2' }, { rid: 'r_a', uid: 'hh_2' }], 'the SAME operation re-sent');
  assert.ok(textOf(P.byId.get('opstoast')).includes('«Equipo 2» desvinculado'));
  assert.ok(!btnText(v, 'Reintentar'), 'the panel clears on success');
});

test('Equipos (r1 P2): a failed REFRESH is shown above the retained list with «Reintentar» (outage and 403 alike)', async () => {
  installStorage();
  let mode = 'ok';
  const P = page({ e1: E1([ebranch('r_a')]), extra: (fn) => {
    if (fn !== 'getBranchDevices') return undefined;
    if (mode === '503') return errJson(503, { error: 'unavailable' });
    if (mode === '403') return errJson(403, { error: 'not_authorized' });
    return e6([{ rid: 'r_a', prep_ok: true, order_surface: 'handheld', devices: [dev('hh_1', 1)] }]);
  } });
  await loadModules();
  await signIn('uOwner0412');
  P.byId.get('navequipos').click();
  await settle(10);
  const v = P.byId.get('viewequipos');
  mode = '503';
  btnText(v, 'Actualizar').click();
  await settle(10);
  assert.ok(textOf(v).includes('Equipo 1'), 'the last good list is kept');
  assert.ok(btnText(v, 'Reintentar'), 'the outage is said, with its retry');
  mode = '403';
  btnText(v, 'Reintentar').click();
  await settle(10);
  assert.ok(textOf(v).includes('No tenés acceso a estos equipos') && btnText(v, 'Reintentar'), 'an authorization failure too');
  mode = 'ok';
  btnText(v, 'Reintentar').click();
  await settle(10);
  assert.ok(!btnText(v, 'Reintentar') && !textOf(v).includes('No tenés acceso'), 'cleared by a good refresh');
});

test('Equipos (r1 P2): a list fetch begun BEFORE a successful revoke can never restore the revoked row', async () => {
  installStorage();
  const old = hold();
  let k = 0; let gone = false;
  const P = page({ e1: E1([ebranch('r_a', { devices: 2 })]), extra: (fn) => {
    const both = () => e6([{ rid: 'r_a', prep_ok: true, order_surface: 'handheld', devices: [dev('hh_1', 1), ...(gone ? [] : [dev('hh_2', 2)])] }]);
    if (fn === 'getBranchDevices') { k += 1; return k === 2 ? old.p : both(); }
    if (fn === 'revokeBranchDevice') { gone = true; return okJson({ ok: true, uid: 'hh_2', paused: false }); }
    return undefined;
  } });
  await loadModules();
  await signIn('uOwner0413');
  P.byId.get('navequipos').click();
  await settle(10);
  const v = P.byId.get('viewequipos');
  btnText(v, 'Actualizar').click();                       // fetch #2: held (its snapshot predates the revoke)
  await settle(5);
  all(v).filter((n) => n.tag === 'button' && textOf(n) === 'Desvincular')[1].click();
  btnText(P.byId.get('devmodal'), 'Desvincular').click();
  await settle(10);
  old.release(e6([{ rid: 'r_a', prep_ok: true, order_surface: 'handheld', devices: [dev('hh_1', 1), dev('hh_2', 2)] }]));
  await settle(10);
  assert.equal(k, 3, 'non-vacuity: the held fetch AND the reconcile fetch both ran');
  assert.ok(!textOf(v).includes('Equipo 2'), 'the pre-revoke snapshot is discarded');
  assert.equal(textOf(P.byId.get('navequiposcount')), '1');
});

test('Equipos (r1 P3): an empty list keeps «Actualizar» and the fetch time', async () => {
  installStorage();
  const P = page({ e1: E1([ebranch('r_a', { devices: 0 })]), extra: (fn) => (fn === 'getBranchDevices'
    ? e6([{ rid: 'r_a', prep_ok: true, order_surface: 'handheld', devices: [] }]) : undefined) });
  await loadModules();
  await signIn('uOwner0414');
  P.byId.get('navequipos').click();
  await settle(10);
  const v = P.byId.get('viewequipos');
  const t = textOf(v);
  assert.ok(t.includes('Ningún equipo vinculado') && t.includes('Actualizado 12:00') && t.includes('0 equipos'));
  btnText(v, 'Actualizar').click();
  await settle(10);
  assert.equal(P.count('getBranchDevices'), 2);
});
