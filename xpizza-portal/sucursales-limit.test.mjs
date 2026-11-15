// ENVÍO v3 §3b (PLAN-portal-envio-v3-ui r5; 5f r5 §5) — Sucursales shows each branch's EFFECTIVE app delivery limit (`app_max_km`) exactly
// where the identity radius showed: the card's «Radio {km} km», «Zona de entrega» (its schematic and «{km} km a la redonda»), the 1b
// card's «Zona». A malformed stored limit (`limit_invalid`) or no value → today's empty rendering («—»). No new string.
// The rows are 5f's REAL getMyBranchesCore output over a policy node committed by the REAL setDeliveryPricingCore (5f's own
// portal/sucursales-limit.test.js fixture), rendered through the REAL shell.js / branches-view.js (only auth.js is stubbed).
// Run: node --test xpizza-portal/sucursales-limit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installDom, installFetch, loadModules, okJson, errJson, settle, textOf, findAll } from './ventas-harness.mjs';

const require = createRequire(import.meta.url);
const F = (m) => require(`../xpizza-functions/${m}`);
const { createFakeDb } = F('merchant/_fake-db');
const { fakeRtdb } = F('test/_fake-rtdb-sdk');
const R = F('access/roster');
const C = F('portal/ops-core');
const A = F('delivery/pricing-admin-core');

const PATH = 'platform_config/delivery_pricing';
const BANDS = [{ max_km: 3, cents: 3000 }, { max_km: 9.5, cents: 7000 }];
const seed = () => ({
  brands: { tb: { name: 'Tercera Marca', active: true, locations: { tb_centro: 'member', tb_sur: 'member' }, activation: { state: 'on', since: 1 } } },
  restaurants: {
    tb_centro: { identity: { brand_id: 'tb', name: 'Centro', active: true, prep_default_min: 20, version: 1 } },
    tb_sur: { identity: { brand_id: 'tb', name: 'Sur', active: true, prep_default_min: 25, version: 1 } },
  },
});
const quiet = { warn() {}, log() {}, error() {} };
async function policy(limits) {
  const db = fakeRtdb({ platform_admins: { tbowner: true }, ...seed() }, { strict: true });
  const r = await A.setDeliveryPricingCore({ db, verifyIdToken: async () => ({ uid: 'tbowner' }), timestamp: () => 1762800000000, readRegistry: async () => ({ ok: true, fresh: true, ids: ['tb_centro', 'tb_sur'] }) },
    { get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer x' : null), body: { expected_policy_version: 0, bands: BANDS, ...(limits ? { limits } : {}) } });
  assert.equal(r.status, 200, `premise: the writer saved (${JSON.stringify(r.body)})`);
  return db.get(PATH);
}
async function served(node) {
  const fake = createFakeDb(seed());
  await R.mutateRoster({ db: fake, now: () => 1 }, 'tb', { kind: 'cli', operator: 'op' }, { type: 'bootstrap_owner', uid: 'ownerT1', profile: { name: 'Dueña Prueba', email: 'duena@tb.hn' } });
  if (node) fake.put(PATH, node);
  // 5f's own adapter (portal/sucursales-limit.test.js e1): the membership double answers once(); the core's one policy read is get()
  const db = { ref: (p) => { const r = fake.ref(p); return { ...r, once: (...x) => r.once(...x), get: () => r.once() }; } };
  const out = await C.getMyBranchesCore({ db, verifyIdToken: async () => ({ uid: 'ownerT1' }), now: () => Date.UTC(2026, 9, 20, 15), log: quiet },
    { method: 'GET', get: (h) => (h === 'authorization' ? 'Bearer t' : undefined) });
  assert.equal(out.status, 200, 'premise: the real getMyBranches answers');
  return out.body;
}
async function sucursales(body, rid = null) {
  installDom();
  globalThis.window.location = { reload: () => {} };
  globalThis.window.scrollTo = () => {};
  globalThis.__branchesDirect = true;
  const m = new Map();
  globalThis.sessionStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } };
  installFetch((fn) => {
    if (fn === 'getMyBranches') return okJson(body);
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  const mods = await loadModules();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'ownerT1' } }));
  document.dispatchEvent(new CustomEvent('portal:signed-in'));
  await settle(20);
  mods.shell.goto('suc', rid ? { rid } : {});
  await settle(10);
  return textOf(document.getElementById('viewsuc'));
}
const svgLabels = () => findAll(document.getElementById('viewsuc'), (n) => n.attrs && typeof n.attrs['aria-label'] === 'string' && n.attrs['aria-label'].startsWith('Mapa con el pin')).map((n) => n.attrs['aria-label']);

test('SUC-LIMIT list: each branch\'s card shows its EFFECTIVE app limit (the stored limit / the table top), never the identity radius', async () => {
  const body = await served(await policy([{ rid: 'tb_centro', km: 4 }]));
  assert.deepEqual(body.branches.map((b) => [b.rid, b.app_max_km]).sort(), [['tb_centro', 4], ['tb_sur', 9.5]], 'premise: the served values');
  const t = await sucursales(body);
  assert.ok(/(Radio|Zona) 4 km/.test(t), `the stored limit (${t.slice(0, 300)})`);
  assert.ok(/(Radio|Zona) 9\.5 km/.test(t), 'the table top for a branch with no limit of its own');
});

test('SUC-LIMIT detail: «Zona de entrega» shows the branch\'s app limit — the schematic\'s label and «{km} km a la redonda»', async () => {
  const body = await served(await policy([{ rid: 'tb_centro', km: 4 }]));
  const t = await sucursales(body, 'tb_centro');
  assert.ok(t.includes('4 km a la redonda'), `the app limit, exact (${t.slice(0, 300)})`);
  assert.ok(svgLabels().some((l) => l.includes('radio de entrega de 4 km')), 'the schematic says the same value');
});

test('SUC-LIMIT invalid: a malformed stored limit → «—» for that branch (today\'s empty rendering), the other branch normal', async () => {
  const node = await policy([{ rid: 'tb_sur', km: 4 }]); node.restaurants.tb_centro = { max_km: 'x' };
  const body = await served(node);
  assert.deepEqual(body.branches.map((b) => [b.rid, b.app_max_km, b.limit_invalid]).sort(), [['tb_centro', null, true], ['tb_sur', 4, false]], 'premise: the served flags');
  const t = await sucursales(body, 'tb_centro');
  assert.ok(t.includes('— km a la redonda'), `the flagged branch renders «—» (${t.slice(0, 300)})`);
  assert.ok(!/\b9\.5 km a la redonda/.test(t), 'never the table top for a malformed entry');
});
