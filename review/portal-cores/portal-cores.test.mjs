// The REAL-core worlds behind the portal font census's newer states (PLAN-portal-fonts-census-gaps-r0 §2–§4), checked WITHOUT Chrome: each
// state's backend (review/portal-cores/<cores>.mjs, the SBS backends moved in-repo) is reset to the state's scenario over THIS tree's harnesses,
// and the page's OWN calls (the query shapes xpizza-portal/api.js builds) answer 200 — where the state's premise string is server DATA, it is
// in the body. The census tool's STATES are read from its source, so a state added or re-pointed there without a world here goes red.
// Run: node --test review/portal-cores/portal-cores.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(path.join(ROOT, 'portal-fonts.cdp.mjs'), 'utf8');
// the census states that name a backend: { state: [cores, scn, text] } from the tool's own source
const CORE_STATES = Object.fromEntries([...SRC.matchAll(/^ {2}'([A-Z]+-[A-Za-z-]+)':\s*\{[^\n]*?cores: '([a-z0-9]+)', scn: '([a-z-]+)'[^\n]*?text: '([^']+)'/gm)].map((m) => [m[1], [m[2], m[3], m[4]]]));
// the page's calls per backend (api.js shapes) and whether the premise text is DATA the body must carry
const CALLS = {
  ventas: [['getMyBranches', {}], ['getSalesStats', { restaurantId: 'r_centro', from: '2026-10-30', to: '2026-11-12', granularity: 'day' }],
    ['getSalesStats', { restaurantId: 'r_centro', from: '2026-11-12', to: '2026-11-12', granularity: 'day', compare: 'previous_week' }]],
  calificaciones2: [['getMyBranches', {}], ['getMerchantReviews', { rids: 'x_pizza', weeks: '4' }], ['getMerchantReviews', { rids: 'x_pizza,xp_sur', weeks: '4' }],
    ['getMerchantRatingComments', { rid: 'x_pizza' }]],
  ofertas: [['getMyBranches', {}], ['getMarketing', { rid: 'pv_centro' }]],
  zones: [['getMyBranches', {}], ['getDeliveryPricing', {}]],
};
const DATA_TEXT = new Set(['Ana P.', 'Almuerzo: 15 % en todo el menú', 'Centro']);   // the rest are UI copy (headings, buttons)

test('the census tool names exactly the 11 core states of the plan, each on a backend this file can drive', () => {
  assert.deepEqual(Object.keys(CORE_STATES).sort(), ['C-calif', 'C-earlier', 'C-filters', 'IN-inicio', 'M-builder', 'M-detail', 'M-ofertas', 'M-review', 'N-envio', 'V-detail', 'V-rend'],
    'the core states read from portal-fonts.cdp.mjs');
  for (const [s, [cores]] of Object.entries(CORE_STATES)) assert.ok(CALLS[cores], `${s}: backend ${cores} has its page calls here`);
});

const pairs = [...new Set(Object.values(CORE_STATES).map(([c, scn]) => `${c}|${scn}`))];
for (const pair of pairs) {
  const [cores, scn] = pair.split('|');
  test(`${cores}:${scn} — the REAL world answers every page call 200; the states' data premises are in the bodies`, async () => {
    const { backend } = await import(pathToFileURL(path.join(ROOT, 'review', 'portal-cores', `${cores}.mjs`)).href);
    const b = await backend(ROOT); await b.reset(scn);
    // a backend with a clock pins the page to it; zones has none BY DESIGN (absolute hours: the real clock judges them the same at any time)
    if (cores === 'zones') assert.equal(b.clock, undefined, 'zones: no clock (absolute hours)'); else assert.ok(Number.isFinite(b.clock), `${cores}: the backend states its clock (the page runs on it)`);
    const bodies = [];
    for (const [fn, query] of CALLS[cores]) {
      const r = await b.call({ fn, method: 'GET', query, headers: { authorization: 'Bearer T' } });
      assert.ok(r, `${fn}: served by the backend (never a gap)`);
      assert.equal(r.status, 200, `${fn} ${JSON.stringify(query)} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      bodies.push(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    }
    const all = bodies.join('\n');
    for (const [s, [c, sc, text]] of Object.entries(CORE_STATES)) if (c === cores && sc === scn && DATA_TEXT.has(text)) assert.ok(all.includes(text), `${s}: «${text}» is in the real answers`);
  });
}
