// «Inicio» — the portal home (PLAN-portal-inicio-r0, APPROVED 11-13; MOCKUP-portal-map.html v3 s-inicio / s-inicio-ok). Built exact to
// the frames, with ONLY the sourced elements (rule 8): the date, the branch pill, the three per-branch figures with «el {día} pasado»
// (getSalesStats, compare previous_week), «Para revisar» = a paused branch + «Reanudar» (getMyBranches control → the ONE pause control),
// 1b «Todo en orden» over those kinds, and «Editar producto». Everything else waits (S1–S4, Marketing, hours editing); «Ayuda» = Sherpa support's WhatsApp (owner 11-14).
// The figures come from the REAL chain (stats-portal-composition's): orders ← stats-fixtures (the real createOrder writers), the
// nightly rollup ← stats-job.runStatsRollup, the answer ← stats-api.getSalesStatsCore behind the real authorizeCatalogEdit.
// Run: node --test inicio.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installDom, loadModules, okJson, errJson, settle, textOf } from './ventas-harness.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as IL from './inicio-logic.js';
import { _resetPauseStore } from './pause-control.js';
import { clock12 } from './portal-time.js';

// 5f's S2 server (getSalesStats over several branches, merged there): its functions tree at a PINNED ref, read-only (the S4_REF
// pattern) — switch to the repo copy once S2 rides the same train
export const S2_REF = 'd601ce505';
// a peer's functions tree at a PINNED ref, as `git archive` writes it, in a temp dir (node_modules linked), removed at exit — the
// s4Snapshot pattern of real-backend.mjs (feat/portal-structure-s3-ui); ASSEMBLY: fold into that helper when both branches meet
function refTree(ref) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'portal-s2ref-'));
  // the functions tree + the two order forms its seed reads (catalog/form-menu-source.js)
  execFileSync('tar', ['-x', '-C', dir], { input: execFileSync('git', ['archive', '--format=tar', ref, 'xpizza-functions', 'xpizza-orders/index.html', 'la-musa-orders/index.html'], { cwd: repo, maxBuffer: 1 << 28 }) });
  symlinkSync(join(repo, 'xpizza-functions', 'node_modules'), join(dir, 'xpizza-functions', 'node_modules'));
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
  return createRequire(join(dir, 'xpizza-functions', 'package.json'));
}
const freq = refTree(S2_REF);
const T = freq('./stats/stats-time');
const J = freq('./stats/stats-job');
const A = freq('./stats/stats-api');
const F = freq('./stats/stats-fixtures');
const { makeRtdb } = freq('./stats/stats-rtdb-fake');
const { makeDb } = freq('./catalog/firestore-fake');
const { makeCustomerKeyer } = freq('./stats/stats-identity');
const { authorizeCatalogEdit } = freq('./catalog/catalog-edit-auth');

const P = (k) => `⟦inicio.${k}⟧`;
const HN = 6 * 3600e3;
const hn = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) + HN;   // a Honduras wall clock → epoch ms

// ── pure ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('the greeting follows the Honduras clock: «Buenas tardes» as drawn; «Buenos días» 05:00–11:59 / «Buenas noches» 19:00–04:59 (owner 11-15); never a name', () => {
  assert.equal(IL.greeting(hn(2026, 11, 12, 15)), 'Buenas tardes', '🔴 the drawn greeting, no name (Q-I2)');
  assert.equal(IL.greeting(hn(2026, 11, 12, 12)), 'Buenas tardes');
  assert.equal(IL.greeting(hn(2026, 11, 12, 18, 59)), 'Buenas tardes');
  assert.equal(IL.greeting(hn(2026, 11, 12, 19)), 'Buenas noches');
  assert.equal(IL.greeting(hn(2026, 11, 12, 4, 59)), 'Buenas noches');
  assert.equal(IL.greeting(hn(2026, 11, 12, 5)), 'Buenos días');
  assert.equal(IL.greeting(hn(2026, 11, 12, 11, 59)), 'Buenos días');
});
test('the date line, Honduras time, exact to the frame', () => {
  assert.equal(IL.dateLine(hn(2026, 11, 12, 15)), 'Resumen de hoy · jueves 12 de noviembre', '🔴 «Resumen de hoy · jueves 12 de noviembre»');
  assert.equal(IL.dateLine(hn(2026, 11, 13, 0, 30)), 'Resumen de hoy · viernes 13 de noviembre');
  assert.equal(IL.dateLine(Date.UTC(2026, 10, 13, 5, 59)), 'Resumen de hoy · jueves 12 de noviembre', '05:59 UTC is still Thursday in Honduras');
});
test('the pause time: THE portal clock, the customer app\'s 12-hour «p. m.» form (advisor 11-13; the frame\'s «pm»)', () => {
  // 16b (owner 11-25 via the advisor): the time and «a. m.» are ONE non-breaking unit (SBS f5@390: «… desde las 10:59» / «a. m.» orphaned)
  assert.equal(clock12(hn(2026, 11, 12, 15, 10)), '3:10\u00a0p.\u00a0m.', '🔴 the one clock, one unit');
  assert.equal(clock12(hn(2026, 11, 12, 0, 5)), '12:05\u00a0a.\u00a0m.');
  assert.equal(clock12(hn(2026, 11, 12, 12, 0)), '12:00\u00a0p.\u00a0m.');
  assert.equal(clock12(hn(2026, 11, 12, 9, 7)), '9:07\u00a0a.\u00a0m.');
  for (let m = 0; m < 24 * 60; m += 7) assert.ok(!/\s/.test(clock12(hn(2026, 11, 12, 0, m)).replace(/\u00a0/g, '')), `🔴 16b: no breakable space at ${m} min`);
  assert.equal(IL.when(hn(2026, 11, 12, 15, 10)), 'desde\u00a0las\u00a03:10\u00a0p.\u00a0m.', '🔴 16b: «desde las h:mm a. m.» drops as ONE phrase');
});
test('«N pendientes» counts the rows drawn; one is singular', () => {
  assert.equal(IL.pendLabel(4), '4 pendientes');
  assert.equal(IL.pendLabel(1), '1 pendiente');
});

const CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
const branch = (rid, name, extra = {}) => ({ rid, brand_id: 'marca_v', role: 'owner', state: 'member', caps: CAPS, name,
  identity_version: 2, editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
  control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null, ...extra });
const PAUSED = (since) => ({ state: 'paused', paused_until: null, pause_reason: 'Cocina llena', pause_since: since });

test('«Para revisar» = a paused branch in scope (with since-when); «Reanudar» only with location.pause; open / other-scope branches never', async () => {
  const since = hn(2026, 11, 12, 15, 10); const f = await realPending('false');   // the menu settled (a REAL save undone): pause rows only
  const bs = [branch('r_a', 'Centro', { control: PAUSED(since), has_pending: f }), branch('r_b', 'Los Próceres', { has_pending: f }), branch('r_c', 'El Trapiche', { control: PAUSED(null), caps: ['stats.read'] })];
  assert.deepEqual(IL.reviewRows(bs, null), [
    { kind: 'pause', rid: 'r_a', text: 'Sucursal Centro está en pausa', when: 'desde\u00a0las\u00a03:10\u00a0p.\u00a0m.', resume: true },
    { kind: 'pause', rid: 'r_c', text: 'Sucursal El Trapiche está en pausa', when: '', resume: false },
  ], '🔴 one row per paused branch; «Reanudar» only where the member may resume');
  assert.deepEqual(IL.reviewRows(bs, 'r_b'), [], 'the pill scopes the list');
  assert.deepEqual(IL.reviewRows(bs, 'r_a').map((r) => r.rid), ['r_a']);
});

// ── S3 r1 has_pending (owner 11-23: NO number; mockup JfNRMF8L APPROVED, frames 1/3/4/5/6; advisor rulings 11-25 Q1–Q3) ─────────────
// The value comes from 5f's REAL writers in THIS tree: the real save (editCatalogCore via test/_s2core-harness) records it and the real
// readHasPending serves it — what getMyBranches puts on a branch with catalog.read_editor, read once per catalog id = the brand
// (5f PS-BRANCHES). WHO gets the key is the real getMyBranchesCore's call (absent without the menu permission). The rest of a row
// (control, names) is the shipped fixture: has_pending / caps are laid over it exactly as the server serves them.
const FQ = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'xpizza-functions', 'package.json'));
const quietly = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const REAL = new Map();
// kind 'true' (a real save that changes 2 prices) · 'false' (that save undone by the next real save: the review draws nothing) ·
// 'null' (no save recorded: the read cannot be fresh)
export async function realPending(kind) {
  if (REAL.has(kind)) return REAL.get(kind);
  const H = FQ('./test/_s2core-harness'); const PS = FQ('./catalog/pending-summary');
  H.SW.extrasCatalog = true;
  const w = H.world('la_musa');
  const reprice = (by) => (d) => { for (const it of d.items.filter((i) => i.display && i.display.variantOf == null).slice(0, 2)) { it.price += by; it.display.price = it.price; } };
  if (kind !== 'null') assert.equal((await quietly(() => w.save(reprice(7)))).status, 200, 'premise: the real save');
  if (kind === 'false') assert.equal((await quietly(() => w.save(reprice(-7)))).status, 200, 'premise: the real undoing save');
  const v = await PS.readHasPending(w.fs, 'la_musa', { warn() {} });
  assert.equal(String(v), kind, `premise: the real reader serves ${kind}`);
  REAL.set(kind, v);
  return v;
}
// the real getMyBranchesCore over a two-branch brand: an owner (menu permission) and a manager without it → { [rid]: { caps, has_pending? } }
export async function realServed(uid) {
  const { createFakeDb } = FQ('./merchant/_fake-db'); const R = FQ('./access/roster'); const PS = FQ('./catalog/pending-summary');
  const fake = createFakeDb({ brands: { tb: { name: 'Tercera', active: true, locations: { tb_centro: 'member', tb_sur: 'member' }, activation: { state: 'on', since: 1 } } },
    restaurants: { tb_centro: { identity: { brand_id: 'tb', name: 'Centro', active: true, prep_default_min: 20, version: 1 } }, tb_sur: { identity: { brand_id: 'tb', name: 'Sur', active: true, prep_default_min: 25, version: 1 } } } });
  const op = (o) => R.mutateRoster({ db: fake, now: () => 1 }, 'tb', { kind: 'cli', operator: 'op' }, o);
  await op({ type: 'bootstrap_owner', uid: 'ownerT1', profile: { name: 'Dueña', email: 'd@tb.hn' } });
  await op({ type: 'grant_manager', uid: 'mgrNoMenu', rids: ['tb_centro'], can_edit_menu: false });
  const fs = FQ('./catalog/firestore-fake').makeDb(); const meta = (id) => fs.collection('restaurants').doc('tb').collection('meta').doc(id);
  await meta('source').set({ v: 1 }); await meta('active_version').set({ version: 'v5', generation: 5 });
  await PS.record(fs, 'tb', { pending: true, sourceUpdateTime: PS.encodeUpdateTime((await meta('source').get()).updateTime), baseActiveVersion: 'v5' });
  const adminOf = (f) => ({ ref: (p) => { const x = f.ref(p); return { ...x, get: () => x.once() }; } });
  const out = await FQ('./portal/ops-core').getMyBranchesCore({ db: adminOf(fake), fs, verifyIdToken: async () => ({ uid }), now: () => Date.UTC(2026, 10, 12, 21), log: { warn() {}, log() {}, error() {} } },
    { method: 'GET', get: (h) => (h === 'authorization' ? 'Bearer t' : undefined) });
  assert.equal(out.status, 200, 'premise: the real getMyBranches');
  return Object.fromEntries(out.body.branches.map((b) => [b.rid, { caps: b.caps, ...(Object.prototype.hasOwnProperty.call(b, 'has_pending') ? { has_pending: b.has_pending } : {}) }]));
}
const SHORT = 'Tenés cambios sin publicar en el menú';
const NB = (s) => s.replace(/ /g, ' ');   // «de» + the brand name: ONE non-breaking unit (frame 6 note 11)

test('frame 1 — has_pending true (a REAL save), one branch in scope: the short row «Tenés cambios sin publicar en el menú», no number', async () => {
  const t = await realPending('true');
  const bs = [branch('r_a', 'Centro', { has_pending: t })];
  assert.deepEqual(IL.reviewRows(bs, 'r_a', 'Pizzería Del Valle'), [{ kind: 'menu', rid: 'r_a', text: SHORT }], '🔴 the drawn row, no digit');
  assert.deepEqual(IL.reviewRows(bs, null, 'Pizzería Del Valle'), [{ kind: 'menu', rid: 'r_a', text: SHORT }], 'a one-branch brand under «Todas» keeps the short line');
  assert.ok(!/\d/.test(IL.reviewRows(bs, 'r_a', 'X')[0].text), 'never a number (owner 11-23)');
});
test('frame 6 — one brand menu: «Todas» with 2+ branches ⇒ ONE row naming the brand («de» + name one non-breaking unit), never one per branch', async () => {
  const t = await realPending('true');
  const bs = [branch('r_a', 'Centro', { has_pending: t }), branch('r_b', 'Col. Trejo', { has_pending: t }), branch('r_c', 'Bulevar del Norte', { has_pending: t })];
  assert.deepEqual(IL.reviewRows(bs, null, 'Pizzería Del Valle'), [{ kind: 'menu', rid: 'r_a', text: `${SHORT} de ${NB('Pizzería Del Valle')}` }], '🔴 frame 6: one row for the brand');
  assert.deepEqual(IL.reviewRows(bs, 'r_b', 'Pizzería Del Valle'), [{ kind: 'menu', rid: 'r_b', text: SHORT }], 'one branch in the pill: the short line, that branch\'s «Revisar»');
});
test('frame 3 — has_pending null (no fresh read) or ABSENT on an editor branch ⇒ the quiet invitation «Revisá si hay algo sin publicar»; «Todas» 2+ names the brand (advisor Q3)', async () => {
  const n = await realPending('null');
  for (const extra of [{ has_pending: n }, {}, { pending_count: 3 }]) {   // a legacy pending_count is never trusted after the switch
    assert.deepEqual(IL.reviewRows([branch('r_a', 'Centro', extra)], 'r_a', 'Pizzería Del Valle'), [{ kind: 'menu', quiet: true, rid: 'r_a', text: 'Revisá si hay algo sin publicar' }], `🔴 ${JSON.stringify(extra)}: the invitation`);
  }
  const bs = [branch('r_a', 'Centro', { has_pending: n }), branch('r_b', 'Col. Trejo', { has_pending: n })];
  assert.deepEqual(IL.reviewRows(bs, null, 'Pizzería Del Valle'), [{ kind: 'menu', quiet: true, rid: 'r_a', text: `Revisá si hay algo sin publicar en el menú de ${NB('Pizzería Del Valle')}` }], 'Q3: named, one row');
});
test('has_pending false (a REAL save undone) ⇒ no menu row; a branch WITHOUT catalog.read_editor (the REAL getMyBranches serves no key) ⇒ no menu row, no invitation (advisor Q2)', async () => {
  const f = await realPending('false');
  assert.deepEqual(IL.reviewRows([branch('r_a', 'Centro', { has_pending: f })], 'r_a', 'X'), [], '🔴 false: nothing to review');
  const mgr = (await realServed('mgrNoMenu')).tb_centro;
  assert.ok(!('has_pending' in mgr) && !mgr.caps.includes('catalog.read_editor'), 'premise: the real server serves no key to a member without the menu permission');
  assert.deepEqual(IL.reviewRows([branch('r_a', 'Centro', mgr)], 'r_a', 'X'), [], '🔴 Q2: not applicable — never the invitation to a menu they cannot open');
  const own = await realServed('ownerT1');
  assert.deepEqual([own.tb_centro.has_pending, own.tb_sur.has_pending], [true, true], 'premise: one catalog id ⇒ both branches carry the brand\'s value');
});
test('frame 5 — pause rows first, then the one menu row; the invitation joins a pause row when the menu state is unknown', async () => {
  const t = await realPending('true'); const n = await realPending('null');
  assert.deepEqual(IL.reviewRows([branch('r_a', 'Centro', { has_pending: t, control: PAUSED(null) })], 'r_a', 'X').map((r) => [r.kind, !!r.quiet]), [['pause', false], ['menu', false]], '🔴 the frame\'s order');
  assert.deepEqual(IL.reviewRows([branch('r_a', 'Centro', { has_pending: n, control: PAUSED(null) })], 'r_a', 'X').map((r) => [r.kind, !!r.quiet]), [['pause', false], ['menu', true]], 'pause + invitation');
});
test('allKnown (frame 4): every in-scope control known AND every EDITOR branch\'s has_pending a boolean; a non-editor branch\'s menu is n/a (Q2); null / absent / legacy pending_count ⇒ not known', async () => {
  const f = await realPending('false'); const n = await realPending('null');
  const mgr = (await realServed('mgrNoMenu')).tb_centro;
  assert.equal(IL.allKnown([branch('r_a', 'Centro', { has_pending: f })], null), true, '🔴 false + open ⇒ known');
  assert.equal(IL.allKnown([branch('r_a', 'Centro', mgr)], null), true, '🔴 Q2: a non-editor reaches «Todo en orden» on its controls alone');
  for (const extra of [{ has_pending: n }, {}, { pending_count: 0 }]) assert.equal(IL.allKnown([branch('r_a', 'Centro', extra)], null), false, `🔴 ${JSON.stringify(extra)} ⇒ unknown`);
  assert.equal(IL.allKnown([branch('r_a', 'Centro', { has_pending: f, control: { state: 'unknown' } })], null), false, 'an unknown control ⇒ unknown');
});

// ── the real stats chain (a Thursday; last Thursday is the comparison) ───────────────────────────────────────────────
const TODAY = '2026-11-12';
const NOW = T.dayStartMs(TODAY) + 15 * 3600000;   // 15:00 Honduras
const at = (date, h, m = 0) => T.dayStartMs(date) + h * 3600000 + m * 60000;
const keyer = makeCustomerKeyer('s'.repeat(40));
export async function statsWorld() {
  const orders = {};
  const add = (o) => { orders[o.order_id] = o; return o; };
  add(F.deliver(F.pickup(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-11-05', 19), phone: '88880001', totalCents: 31000, items: [{ name: 'Pepperoni 12″', qty: 2, unit: 155 }] }), at('2026-11-05', 19, 20)), at('2026-11-05', 19, 40)));
  add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at(TODAY, 11), phone: '88880009', totalCents: 15000, items: [{ name: 'Margherita 12″', qty: 1, unit: 150 }] }));
  add(F.cashOrder({ rid: 'r_a', pm: 'card_delivery', now: at(TODAY, 13), phone: '88880002', totalCents: 27000, items: [{ name: 'Carnívora 18″', qty: 1, unit: 270 }] }));
  add(F.cashOrder({ rid: 'r_b', pm: 'cash', now: at(TODAY, 12), phone: '88880003', totalCents: 99900 }));   // another branch: never in r_a's figures
  const fsdb = makeDb();
  const rtdb = makeRtdb(orders);
  await J.runStatsRollup({ rtdb, fsdb, keyer, listRestaurants: async () => ['r_a', 'r_b'], log: () => {} }, { nowMs: NOW, mode: 'range', from: '2026-11-01', to: '2026-11-11', commit: true });
  const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
  const MEMBERS = new Map([['brands/r_a', legacy('r_a')], ['brands/r_b', legacy('r_b')], ['brands/r_c', legacy('r_c')], ['brand_members/r_c/owners/uA', { granted_at: 1, granted_by: 'x' }], ['brand_members/r_a/owners/uA', { granted_at: 1, granted_by: 'x' }], ['brand_members/r_b/owners/uA', { granted_at: 1, granted_by: 'x' }]]);
  const memberDb = { ref: (p) => ({ once: async () => { const v = MEMBERS.has(p) ? MEMBERS.get(p) : null; return { exists: () => v !== null, val: () => v }; } }) };
  const liveCache = A.makeLiveCache();
  return async (query, authz) => {
    const req = { method: 'GET', query, get: (h) => (h.toLowerCase() === 'authorization' ? authz : undefined) };
    return A.getSalesStatsCore({ authorize: (rid) => authorizeCatalogEdit({ db: memberDb, verifyIdToken: async (t) => { if (t !== 'TK-test') throw new Error('bad'); return { uid: 'uA' }; } }, req, rid),
      fsdb, rtdb, getKeyer: () => keyer, nowMs: NOW, liveCache }, req);
  };
}

test('the figures model from the REAL answer: Ventas / Pedidos with «el jueves pasado», Ticket promedio without one', async () => {
  const serve = await statsWorld();
  const out = await serve({ restaurantId: 'r_a', ...IL.statsQuery(TODAY) }, 'Bearer TK-test');
  assert.equal(out.status, 200, `premise: the real core accepts the home's query ${JSON.stringify(out.body).slice(0, 120)}`);
  const k = out.body.kpis, c = out.body.comparison.kpis;
  assert.ok(k.orders > 0 && c.orders > 0, 'non-vacuity: today and last Thursday both have sales');
  assert.deepEqual(IL.figures(out.body, TODAY), {
    sales: { value: IL.money(k.sales_cents), vs: `${IL.money(c.sales_cents)} el jueves pasado` },
    orders: { value: String(k.orders), vs: `${c.orders} el jueves pasado` },
    ticket: { value: IL.money(k.average_paid_ticket_cents) },
  }, '🔴 the server\'s own numbers, «el jueves pasado» = the same weekday last week');
  assert.deepEqual(IL.statsQuery(TODAY), { from: TODAY, to: TODAY, granularity: 'day', compare: 'previous_week' });
});

// ── the page, through the REAL shell (+ app.js / ventas.js), with inicio.js loaded as index.html loads it ────────────
function storage(m = new Map()) {
  globalThis.sessionStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  return m;
}
const MENU = () => okJson({ source: { restaurant_id: 'r_a', schema_version: 1, items: [], extras: [], structure: { schema_version: 2, item_order: [], categories: [] } }, sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
const pinClock = (s) => s.replace(/Date\.now\(\)/g, `(globalThis.__inicioNow ?? ${NOW})`);   // NOW, or a test's moved clock
const all = (n) => (n && n.children ? n.children : []).flatMap((c) => (c && typeof c === 'object' ? [c, ...all(c)] : []));
const cls = (root, c) => all(root).filter((n) => String(n._class || '').split(/\s+/).includes(c));
const btnText = (root, t) => all(root).find((n) => n.tag === 'button' && textOf(n) === t);
const has = (n, c) => String(n._class).split(/\s+/).includes(c);
// opts (Codex backfill cells): `store` (a sessionStorage Map to reuse / preset), `hold` ({ getSalesStats, getMyBranches }: one-shot held
// answers — a Promise each), branches may be a function (the fresh E1 changes between reads); `reloads` counts window.location.reload()
async function page(branches, { withInicio = true, pause = null, statsFail = false, store, hold = {}, writes = false } = {}) {
  _resetPauseStore();   // a fresh page session per cell
  const sess = storage(store);
  const byId = installDom();
  let reloads = 0;
  globalThis.window.location = { reload: () => { reloads += 1; } };
  globalThis.window.scrollTo = () => {};
  globalThis.__branchesDirect = true;
  const serve = await statsWorld();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const fn = u.pathname.split('/').pop();
    const query = Object.fromEntries(u.searchParams);
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    calls.push({ fn, query, body });
    if (hold[fn]) { const h = hold[fn]; delete hold[fn]; await h; }
    if (fn === 'getSalesStats') {
      if (statsFail) return errJson(503, { error: 'unavailable' });
      const out = await serve(query, (opts && opts.headers && opts.headers.Authorization) || '');
      return { ok: out.status === 200, status: out.status, json: async () => out.body, text: async () => JSON.stringify(out.body), headers: { get: () => null } };
    }
    if (fn === 'setBranchPause') return pause ? pause(body) : errJson(404, {});
    if (fn === 'getMyBranches') return okJson({ brands: [{ brand_id: 'marca_v', name: 'Pizzería Del Valle' }], branches: typeof branches === 'function' ? branches() : branches, ...(writes ? { membership_writes_enabled: true } : {}) });
    if (fn === 'getEditableCatalog') return MENU();
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  };
  const mods = await loadModules(withInicio ? ['app', 'ventas', 'shell', 'inicio'] : ['app', 'ventas', 'shell'], { inicio: pinClock });
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uA' } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(40);
  return { byId, calls, mods, sess, hold, reloads: () => reloads, view: byId.get('viewinicio'), stats: () => calls.filter((c) => c.fn === 'getSalesStats') };
}

test('LANDING: with inicio.js loaded (index.html), the portal opens on Inicio — first in the nav, current; Productos hidden', async () => {
  const p = await page([branch('r_a', 'Centro')]);
  assert.ok(!has(p.view, 'hidden'), '🔴 Inicio is the landing page (owner 11-13)');
  assert.ok(has(p.byId.get('viewmenu'), 'hidden'), 'Productos waits behind it');
  assert.ok(has(p.byId.get('navinicio'), 'on') && p.byId.get('navinicio').getAttribute('aria-current') === 'page', 'the nav item is current');
  assert.ok(!has(p.byId.get('navinicio'), 'hidden') && !has(p.byId.get('mninicio'), 'hidden'), 'offered on desktop and phone');
  assert.ok(!has(p.byId.get('navprod'), 'on'), 'Productos is not current');
});
test('without inicio.js (any suite that does not load it) the shell is today\'s: Productos lands, no Inicio item', async () => {
  const p = await page([branch('r_a', 'Centro')], { withInicio: false });
  assert.ok(!has(p.byId.get('viewmenu'), 'hidden'), '🔴 no home registered → today\'s landing');
  assert.ok(has(p.byId.get('navinicio'), 'hidden'), 'no Inicio item');
});
test('s-inicio — the greeting, the date, the pill, the three REAL figures; one getSalesStats for the branch (compare previous_week)', async () => {
  const p = await page([branch('r_a', 'Centro')]);
  assert.equal(textOf(p.view.querySelector('h1')), 'Buenas tardes');
  assert.equal(textOf(p.view.querySelector('.in-lede')), 'Resumen de hoy · jueves 12 de noviembre');
  const pill = p.view.querySelector('.in-pill');
  assert.equal(textOf(pill), 'Centro', 'one branch: its name');
  const reqs = p.stats();
  assert.equal(reqs.length, 1, '🔴 one read for the scope');
  assert.deepEqual([reqs[0].query.restaurantId, reqs[0].query.from, reqs[0].query.to, reqs[0].query.compare], ['r_a', TODAY, TODAY, 'previous_week'], '🔴 today vs the same weekday last week');
  const serve = await statsWorld();
  const truth = IL.figures((await serve({ restaurantId: 'r_a', ...IL.statsQuery(TODAY) }, 'Bearer TK-test')).body, TODAY);
  const figs = cls(p.view, 'in-fig').map((f) => [textOf(f.querySelector('.in-fl')), textOf(f.querySelector('.in-fn')), f.querySelector('.in-fs') ? textOf(f.querySelector('.in-fs')) : null]);
  assert.deepEqual(figs, [['Ventas', truth.sales.value, truth.sales.vs], ['Pedidos', truth.orders.value, truth.orders.vs], ['Ticket promedio', truth.ticket.value, null]],
    '🔴 the page draws the server\'s figures, labels as drawn');
});
test('1b — nothing paused, every result KNOWN (Codex backfill item 6): «Todo en orden»; ONE branch ⇒ «No hay nada pendiente en {Sucursal}.» (owner 11-15); no count; «Editar producto» is the one quick action', async () => {
  const p = await page([branch('r_a', 'Centro', { has_pending: await realPending('false') })]);
  const ok = p.view.querySelector('.in-ok');
  assert.ok(ok, '🔴 the calm empty state');
  assert.equal(textOf(ok.querySelector('b')), 'Todo en orden');
  assert.equal(textOf(all(ok).find((n) => n.tag === 'span' && !has(n, 'in-okico'))), 'No hay nada pendiente en Centro.', 'ONE branch: the claim exactly as wide as the scope (owner 11-15)');
  assert.equal(cls(p.view, 'in-cnt').length, 0, 'no «N pendientes» on an empty list');
  assert.deepEqual(cls(p.view, 'in-quick').map(textOf), ['Editar producto', 'Ayuda'], '🔴 only the sourced quick actions, in the mockup\'s order (Crear oferta / Editar horario wait)');
});
test('«Ayuda» (owner 11-14): a plain row that opens WhatsApp with Sherpa support, +504 9795 2893, in a new tab — never a dead link', async () => {
  const p = await page([branch('r_a', 'Centro')]);
  const a = cls(p.view, 'in-quick').find((n) => textOf(n) === 'Ayuda');
  assert.ok(a, 'the row is there');
  // the ONE source (advisor 11-14): platform/sites.json runtime.support_whatsapp → sync-client → support-contact.js (generated)
  const fq = createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'xpizza-functions', 'package.json'));
  const GEN = fq('./tools/support-contact-gen.js');
  const SITES = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'platform', 'sites.json'), 'utf8'));
  const e164 = GEN.supportWhatsappOf(SITES);
  assert.ok(e164, 'premise: the manifest carries the support number');
  assert.equal(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'support-contact.js'), 'utf8'), GEN.supportContactSource(SITES), '🔴 support-contact.js is exactly what sync-client generates from the manifest (run node xpizza-functions/tools/sync-client.js)');
  assert.deepEqual([a.tag.toLowerCase(), a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')],
    ['a', `https://wa.me/${e164.slice(1)}`, '_blank', 'noopener noreferrer'], '🔴 a real link to Sherpa support\'s WhatsApp, from the manifest (no restaurant data in the URL)');
  assert.equal(IL.SUPPORT_WA, e164.slice(1));
  assert.doesNotMatch(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'inicio-logic.js'), 'utf8'), /9795\s?2893/, '🔴 no literal number in inicio-logic.js (rule 4: one source)');
  for (const bad of [null, undefined, '', '97952893', '+504 9795 2893', 50497952893]) assert.equal(IL.supportDigits(bad), null, `malformed ${JSON.stringify(bad)} ⇒ no «Ayuda» link, never a guess`);
  assert.ok(a.children.some((n) => n.tag.toLowerCase() === 'svg'), 'the row\'s chevron');
});
test('a paused branch: «Sucursal Centro está en pausa desde las 3:10 pm» + «Reanudar» → the REAL pause request; the row goes and 1b shows', async () => {
  const since = NOW - 3600e3 + 10 * 60e3;   // 14:10
  const p = await page([branch('r_a', 'Centro', { control: PAUSED(since), has_pending: await realPending('false') })], { pause: (b) => okJson({ ok: true, control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null } }) });
  const row = p.view.querySelector('.in-row');
  assert.ok(row, '🔴 the pause row');
  assert.equal(textOf(row.querySelector('.in-rt')), `Sucursal Centro está en pausa ${IL.when(since)}`.replace(/\u00a0/g, ' '));
  assert.equal(row.querySelector('.in-when').textContent, IL.when(since), '🔴 16b: the raw DOM keeps «2:10\u00a0p.\u00a0m.» one unit');
  assert.equal(IL.when(since), 'desde\u00a0las\u00a02:10\u00a0p.\u00a0m.');
  assert.equal(textOf(cls(p.view, 'in-cnt')[0]), '1 pendiente');
  btnText(p.view, 'Reanudar').click(); await settle(20);
  const sent = p.calls.filter((c) => c.fn === 'setBranchPause');
  assert.equal(sent.length, 1, '🔴 one request'); assert.deepEqual([sent[0].body.op, sent[0].query.restaurantId || sent[0].body.rid || sent[0].query.rid], ['resume', 'r_a']);
  assert.equal(p.view.querySelector('.in-row'), null, '🔴 the row is gone (acts in place)');
  assert.ok(p.view.querySelector('.in-ok'), 'and 1b shows');
});
test('frame 1 — the menu row: «Tenés cambios sin publicar en el menú» + «Revisar» → Productos; «1 pendiente» counts the ROW, never changes (advisor Q1)', async () => {
  const p = await page([branch('r_a', 'Centro', { has_pending: await realPending('true') })]);
  const row = p.view.querySelector('.in-row');
  assert.ok(row, '🔴 the row'); assert.equal(textOf(row.querySelector('.in-rt')), 'Tenés cambios sin publicar en el menú');
  assert.ok(!has(row, 'in-quiet'), 'a real row, not the invitation');
  assert.equal(textOf(cls(p.view, 'in-cnt')[0]), '1 pendiente');
  btnText(p.view, 'Revisar').click(); await settle(5);
  assert.ok(!has(p.byId.get('viewmenu'), 'hidden') && has(p.view, 'hidden'), '🔴 «Revisar» opens Productos');
});
test('«Editar producto» opens Productos; Rendimiento hides Inicio; coming back re-reads NOTHING (cached-first)', async () => {
  const p = await page([branch('r_a', 'Centro')]);
  btnText(p.view, 'Editar producto').click(); await settle(5);
  assert.ok(!has(p.byId.get('viewmenu'), 'hidden') && has(p.view, 'hidden'), '🔴 Productos');
  p.byId.get('navventas').click(); await settle(5);
  assert.ok(has(p.view, 'hidden'), 'Rendimiento hides Inicio');
  p.byId.get('navinicio').click(); await settle(5);
  assert.ok(!has(p.view, 'hidden'), 'back on Inicio');
  assert.equal(p.stats().filter((c) => c.query.restaurantId === 'r_a' && c.query.compare === 'previous_week').length, 1, '🔴 cached: no second read inside the session');
});
test('several branches (Codex backfill item 4): ONE authorized branch is the default (per-branch first, DECISIONS 11-13) — one read for it; «Todas» stays offered: ONE merged read (S2 restaurantIds), the REAL merged figures; the list spans every branch', async () => {
  const f = await realPending('false');   // the menu settled: the list is the pause rows
  const p = await page([branch('r_a', 'Centro', { has_pending: f }), branch('r_b', 'Los Próceres', { control: PAUSED(null), has_pending: f })]);
  const opts = all(cls(p.view, 'in-menu')[0]).filter((n) => n.tag === 'button').map(textOf);
  assert.deepEqual(opts, ['Todas las sucursales', 'Centro', 'Los Próceres'], 'the frame\'s options');
  assert.equal(textOf(p.view.querySelector('.in-pill')), 'Centro', '🔴 item 4: one authorized branch by default, never the merged «Todas»');
  assert.deepEqual(p.stats().map((r) => [r.query.restaurantId, r.query.restaurantIds]), [['r_a', undefined]], 'item 4: one per-branch read');
  btnText(cls(p.view, 'in-menu')[0], 'Todas las sucursales').click(); await settle(30);
  const reqs = p.stats();
  assert.equal(reqs.length, 2, 'then one merged read');
  assert.deepEqual([reqs[1].query.restaurantIds, reqs[1].query.restaurantId, reqs[1].query.compare], ['r_a,r_b', undefined, 'previous_week'], '🔴 the merged form, never restaurantId with it');
  const serve = await statsWorld();
  const out = await serve({ restaurantIds: 'r_a,r_b', ...IL.statsQuery(TODAY) }, 'Bearer TK-test');
  assert.equal(out.status, 200, 'premise: the real S2 core merges');
  assert.equal(out.body.customers, undefined, 'premise: no customers in the merged form');
  const truth = IL.figures(out.body, TODAY);
  const figs = cls(p.view, 'in-fig').map((f) => textOf(f.querySelector('.in-fn')));
  assert.deepEqual(figs, [truth.sales.value, truth.orders.value, truth.ticket.value], '🔴 the server\'s merged figures (its one avgPaidTicket)');
  assert.deepEqual(cls(p.view, 'in-row').map((r) => textOf(r.querySelector('.in-rt'))), ['Sucursal Los Próceres está en pausa'], 'the list covers every branch under «Todas»');
});
test('picking one branch reads THAT branch alone; its list is its own', async () => {
  const f = await realPending('false');
  const p = await page([branch('r_a', 'Centro', { has_pending: f }), branch('r_b', 'Los Próceres', { control: PAUSED(null), has_pending: f })]);
  all(cls(p.view, 'in-menu')[0]).filter((n) => n.tag === 'button')[1].click(); await settle(20);
  assert.equal(textOf(p.view.querySelector('.in-pill')), 'Centro');
  assert.ok(p.stats().some((c) => c.query.restaurantId === 'r_a' && c.query.restaurantIds === undefined), '🔴 the single form for one branch');
  assert.equal(cls(p.view, 'in-row').length, 0, 'Centro is not paused');
});
test('«Todas» where the member cannot read every branch: no merged figures (absent), the list still shows', async () => {
  const p = await page([branch('r_a', 'Centro', { has_pending: await realPending('false') }), branch('r_b', 'Los Próceres', { caps: ['location.pause'], control: PAUSED(null) })]);
  assert.equal(textOf(p.view.querySelector('.in-pill')), 'Centro', 'premise: the readable branch is the default');
  btnText(cls(p.view, 'in-menu')[0], 'Todas las sucursales').click(); await settle(30);
  assert.equal(cls(p.view, 'in-figs').length, 0, '🔴 no figure without a source for every branch');
  assert.equal(p.stats().filter((r) => r.query.restaurantIds).length, 0, 'no merged read');
  assert.equal(cls(p.view, 'in-row').length, 1, 'the pause row');
});
test('the figures cannot be read: no number is invented — the three slots keep their labels, the values read «—»', async () => {
  const p = await page([branch('r_a', 'Centro')], { statsFail: true });
  const figs = cls(p.view, 'in-fig').map((f) => [textOf(f.querySelector('.in-fl')), textOf(f.querySelector('.in-fn'))]);
  assert.deepEqual(figs, [['Ventas', '—'], ['Pedidos', '—'], ['Ticket promedio', '—']], '🔴 honest, no reflow');
});

test('SHIP GATE: no placeholder ships — every Inicio string is owner-approved text', () => {
  const pending = Object.entries(IL.INICIO_COPY).filter(([, v]) => typeof v !== 'string').map(([k]) => k);
  assert.deepEqual(pending, [], `🔴 placeholders still pending owner approval: ${pending.join(', ')}`);
});

// S3 EQUIVALENCE — RETIRED with pending_count (owner 11-23: no number). has_pending === «the review screen draws lines» is now proven in
// THIS tree by 5f's PS-REVIEW-PARITY (xpizza-functions/catalog/pending-review-parity.test.mjs: jsdom over the portal's real renderReview,
// real saves) and PS-SAVE / PS-NET-ZERO / PS-STRUCTURE-ONLY (catalog/pending-summary.test.js); this file takes its values from those
// same real writers (realPending above).

// ── the rendered «Para revisar» on has_pending (mockup JfNRMF8L frames 3 / 6; advisor Q1–Q3 11-25) ──
const paraRevisar = (view) => all(view).find((n) => (n.children || []).some((c) => c && typeof c === 'object' && has(c, 'in-sect') && all(c).some((h) => h.tag === 'h2' && textOf(h) === 'Para revisar')));
test('frame 3 — null renders the quiet invitation (.in-quiet): «Revisar» opens the menu; no «N pendientes», no «Todo en orden»', async () => {
  const p = await page([branch('r_a', 'Centro', { has_pending: await realPending('null') })]);
  const row = p.view.querySelector('.in-row');
  assert.ok(row && has(row, 'in-quiet'), '🔴 the invitation row, muted');
  assert.equal(textOf(row.querySelector('.in-rt')), 'Revisá si hay algo sin publicar');
  assert.deepEqual([cls(p.view, 'in-cnt').length, p.view.querySelector('.in-ok')], [0, null], '🔴 an invitation is not a pending item, and never a claim');
  btnText(p.view, 'Revisar').click(); await settle(5);
  assert.ok(!has(p.byId.get('viewmenu'), 'hidden'), '«Revisar» opens Productos, where the real state is read live');
});
test('frame 6 — «Todas» over a two-branch brand, has_pending true: ONE row naming the brand (getMyBranches brands[].name); «1 pendiente»', async () => {
  const t = await realPending('true');
  const p = await page([branch('r_a', 'Centro', { has_pending: t }), branch('r_b', 'Col. Trejo', { has_pending: t })]);
  btnText(cls(p.view, 'in-menu')[0], 'Todas las sucursales').click(); await settle(30);
  const rows = cls(p.view, 'in-row');
  assert.equal(rows.length, 1, '🔴 one brand menu ⇒ one row, never one per branch');
  assert.equal(rows[0].querySelector('.in-rt').textContent, `Tenés cambios sin publicar en el menú de\u00a0Pizzería\u00a0Del\u00a0Valle`, '🔴 «de» + the brand name: one non-breaking unit');
  assert.equal(textOf(cls(p.view, 'in-cnt')[0]), '1 pendiente', 'Q1: the count counts rows');
});
test('16c — «Para revisar» is NEVER a bare heading: has_pending true / false / null / absent × paused or not × one branch or «Todas»', async () => {
  const v = { true: await realPending('true'), false: await realPending('false'), null: await realPending('null') };
  for (const k of ['true', 'false', 'null', 'absent']) for (const paused of [false, true]) for (const scopeAll of [false, true]) {
    const ex = (over) => ({ ...(k === 'absent' ? {} : { has_pending: v[k] }), ...(paused ? { control: PAUSED(null) } : {}), ...over });
    const p = await page([branch('r_a', 'Centro', ex()), branch('r_b', 'Col. Trejo', ex())]);
    if (scopeAll) { btnText(cls(p.view, 'in-menu')[0], 'Todas las sucursales').click(); await settle(30); }
    const col = paraRevisar(p.view);
    assert.ok(col, 'premise: the column');
    const body = col.children.filter((n) => n && typeof n === 'object' && !has(n, 'in-sect'));
    assert.ok(body.some((n) => has(n, 'in-row') || has(n, 'in-ok')), `🔴 ${k} · paused ${paused} · ${scopeAll ? 'Todas' : 'one'}: something under «Para revisar»`);
  }
});

// ═══ Codex backfill FULL HIGH (advisor 11-15) on 1da090e00..f905f5171 — REVISE: the cells (RED at 84e949b18), the real stats chain ═══
const ABC = () => [branch('r_a', 'Centro'), branch('r_b', 'Los Próceres'), branch('r_c', 'El Trapiche')];
test('N2a a removed branch never stays in a cached «Todas»: the fresh list (A,B) lands while unsaved work defers the reload (the shell\'s applyDeferred repaint) ⇒ a NEW merged read for A,B', async () => {
  const store = new Map([['sherpa.portal.branches.uA', JSON.stringify({ brands: [{ brand_id: 'marca_v', name: 'Pizzería Del Valle' }], branches: ABC(), membership_writes_enabled: true })]]);
  let release; const fresh = new Promise((r) => { release = r; });
  const p = await page(() => ABC().slice(0, 2), { store, hold: { getMyBranches: fresh }, writes: true });   // W on: the shell's applyDeferred repaints in place
  btnText(cls(p.view, 'in-menu')[0], 'Todas las sucursales').click(); await settle(30);
  assert.deepEqual(p.stats().at(-1).query.restaurantIds.split(',').sort(), ['r_a', 'r_b', 'r_c'], 'premise: «Todas» over the cached list');
  p.mods.shell._shellState.dirty.add('test-unsaved');   // the reload waits for unsaved work: the fresh list repaints the views in place
  try {
    release(); await settle(40);
    assert.equal(p.reloads(), 0, 'premise: no page reload (deferred)');
    assert.deepEqual(p.stats().at(-1).query.restaurantIds.split(',').sort(), ['r_a', 'r_b'], 'N2a: the fresh scope (C removed) is read anew — never the cached A,B,C total');
  } finally {
    p.mods.shell._shellState.dirty.delete('test-unsaved');   // the shell's wait-to-reload interval then fires once and stops (no hang)
    await new Promise((r) => setTimeout(r, 1100));
  }
});
test('N2b after Honduras midnight yesterday\'s figures never show under today: the new day starts with empty slots and its own read', async () => {
  globalThis.__inicioNow = NOW;
  try {
    const p = await page([branch('r_a', 'Centro')]);
    assert.ok(cls(p.view, 'in-fn').some((n) => !has(n, 'wait') && textOf(n).startsWith('L ')), 'premise: today\'s figures');
    globalThis.__inicioNow = T.dayStartMs('2026-11-13') + 60e3;   // 00:01 HN, the next day
    let release; p.hold.getSalesStats = new Promise((r) => { release = r; });
    p.mods.shell.goto('suc'); await settle(5); p.mods.shell.goto('inicio'); await settle(20);
    assert.ok(cls(p.view, 'in-fn').every((n) => has(n, 'wait')), 'N2b: the new day\'s slots wait (no yesterday under today)');
    release(); await settle(30);
    assert.equal(p.stats().at(-1).query.from, '2026-11-13', 'its own read');
  } finally { delete globalThis.__inicioNow; }
});
test('N3 an account change while the read is in flight: the stale answer is never applied nor cached — the new context reads its own', async () => {
  let release; const held = new Promise((r) => { release = r; });
  const p = await page([branch('r_a', 'Centro')], { hold: { getSalesStats: held } });
  assert.equal(p.stats().length, 1, 'premise: the first read is in flight');
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'uA' } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(40);
  p.mods.shell.goto('inicio'); await settle(20);   // the new context opens the home while the stale read is still in flight
  release(); await settle(40);
  assert.equal(p.stats().length, 2, 'N3: the new context read its own figures (the stale read neither blocked nor filled it)');
  p.mods.shell.goto('suc'); await settle(5); p.mods.shell.goto('inicio'); await settle(20);
  assert.equal(p.stats().length, 2, 'N3: and the stale answer was never cached as the new context\'s (no third read needed, none sent)');
});
test('N5 a day the roll-up never computed is UNAVAILABLE («—»), never «L 0» / «0»; a COMPUTED day with no sales is the fact «L 0» — the REAL core', async () => {
  const serve = await statsWorld();
  const miss = await serve({ restaurantId: 'r_a', ...IL.statsQuery('2026-10-08') }, 'Bearer TK-test');
  assert.ok(miss.body.missing_days.includes('2026-10-08') && miss.body.kpis.sales_cents === 0, 'premise: the real core answers zeros + the day missing');
  assert.deepEqual(IL.figures(miss.body, '2026-10-08'), IL.NO_FIGURES, 'N5: unavailable');
  const zero = await serve({ restaurantId: 'r_b', ...IL.statsQuery('2026-11-10') }, 'Bearer TK-test');
  assert.deepEqual([zero.body.missing_days, IL.figures(zero.body, '2026-11-10').sales.value, IL.figures(zero.body, '2026-11-10').orders.value], [[], 'L 0', '0'], 'a computed empty day is the fact');
});
test('N6 «Todo en orden» only over KNOWN results: has_pending absent on an editor branch or a control «unknown» ⇒ no claim; «Todas» all known ⇒ the sentence', async () => {
  const f = await realPending('false');
  const a = await page([branch('r_a', 'Centro')]);
  assert.equal(a.view.querySelector('.in-ok'), null, 'N6: has_pending unknown ⇒ no claim');
  const b = await page([branch('r_a', 'Centro', { has_pending: f, control: { state: 'unknown' } })]);
  assert.equal(b.view.querySelector('.in-ok'), null, 'N6: control unknown ⇒ no claim');
  const c = await page([branch('r_a', 'Centro', { has_pending: f }), branch('r_b', 'Los Próceres', { has_pending: f })]);
  btnText(cls(c.view, 'in-menu')[0], 'Todas las sucursales').click(); await settle(30);
  const ok = c.view.querySelector('.in-ok');
  assert.ok(ok && textOf(ok).includes('No hay nada pendiente en tus sucursales.'), 'N6: «Todas», every result known ⇒ the sentence');
});
test('N7 «Revisar» opens THAT branch\'s menu: its own editor ⇒ Productos; another branch ⇒ the guarded select + a one-shot landing; refused ⇒ nothing', async () => {
  const n = await realPending('true');
  const own = await page([branch('r_a', 'Centro', { has_pending: n }), branch('r_b', 'Los Próceres')]);
  btnText(own.view, 'Revisar').click(); await settle(10);
  assert.ok(!has(own.byId.get('viewmenu'), 'hidden'), 'N7: the row\'s own branch (the editor\'s) ⇒ Productos');
  const other = await page([branch('r_a', 'Centro'), branch('r_b', 'Los Próceres', { has_pending: n })]);
  btnText(cls(other.view, 'in-menu')[0], 'Los Próceres').click(); await settle(20);
  btnText(other.view, 'Revisar').click(); await settle(10);
  const read = (m, k) => (m.has(k) ? JSON.parse(m.get(k)) : null);
  assert.deepEqual([(read(other.sess, 'sherpa.portal.sel.uA') || {}).scope, read(other.sess, 'sherpa.portal.land.uA'), other.reloads()], ['r_b', 'menu', 1], 'N7: Los Próceres selected through the guarded reload, landing on Productos');
  const blocked = await page([branch('r_a', 'Centro'), branch('r_b', 'Los Próceres', { has_pending: n })]);
  btnText(cls(blocked.view, 'in-menu')[0], 'Los Próceres').click(); await settle(20);
  blocked.mods.shell._shellState.dirty.add('test-unsaved');   // canLeave refuses (unsaved edits)
  btnText(blocked.view, 'Revisar').click(); await settle(10);
  assert.deepEqual([blocked.sess.has('sherpa.portal.land.uA'), blocked.reloads()], [false, 0], 'N7: refused ⇒ no landing marker, no reload');
});
test('N7b the landing marker is consumed EXACTLY ONCE: the next page opens on Productos, the one after on Inicio', async () => {
  const store = new Map([['sherpa.portal.land.uA', JSON.stringify('menu')]]);
  const first = await page([branch('r_a', 'Centro')], { store });
  assert.ok(!has(first.byId.get('viewmenu'), 'hidden') && has(first.view, 'hidden'), 'N7b: the marked page lands on Productos');
  assert.equal(store.has('sherpa.portal.land.uA'), false, 'N7b: consumed');
  const second = await page([branch('r_a', 'Centro')], { store });
  assert.ok(!has(second.view, 'hidden'), 'N7b: the next page lands on Inicio again');
});

test('N6r2 «Todo en orden» only for a control state in the SERVER\'s enum (control-state.js, Codex r2): «bogus» or «» ⇒ no claim', async () => {
  for (const state of ['bogus', '']) {
    const p = await page([branch('r_a', 'Centro', { has_pending: await realPending('false'), control: { state, paused_until: null, pause_reason: null, pause_since: null } })]);
    assert.equal(p.view.querySelector('.in-ok'), null, `N6r2: control.state «${state}» ⇒ no claim`);
  }
  const ok = await page([branch('r_a', 'Centro', { has_pending: await realPending('false') })]);
  assert.ok(ok.view.querySelector('.in-ok'), 'premise: a known «open» + a known count ⇒ the claim');
});
