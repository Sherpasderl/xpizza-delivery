// The REAL stats world the «Ventas» tests share (rend-data.test.mjs, ventas-tab.test.mjs): 5f's stats cores at the PINNED S2 ref
// (getSalesStatsCore + its multi form), orders built by the REAL fixtures, the REAL nightly roll-up, reached through the portal's api.js.
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refTree } from './ref-tree.mjs';

export const S2_REF = 'd601ce505071e4ea00ff38367abf231897a39df8';
export const BLOB = 'xpizza-functions/stats/stats-api.js';
export const DIR = dirname(fileURLToPath(import.meta.url));
export const git = (...a) => execFileSync('git', a, { cwd: DIR, encoding: 'utf8' }).trim();
const rq = refTree(S2_REF);
export const T = rq('./stats/stats-time');
export const J = rq('./stats/stats-job');
export const A = rq('./stats/stats-api');
export const F = rq('./stats/stats-fixtures');
const { makeRtdb } = rq('./stats/stats-rtdb-fake');
const { makeDb } = rq('./catalog/firestore-fake');
const { makeCustomerKeyer } = rq('./stats/stats-identity');
const { authorizeCatalogEdit } = rq('./catalog/catalog-edit-auth');

export const TODAY = '2026-11-12';
export const NOW = T.dayStartMs(TODAY) + 15 * 3600000;   // 15:00 Honduras
export const at = (date, h, m = 0) => T.dayStartMs(date) + h * 3600000 + m * 60000;
const keyer = makeCustomerKeyer('s'.repeat(40));
export const OLD = { from: '2026-11-02', to: '2026-11-08' };   // fully rolled up: no live day
// the real world: orders by the REAL fixtures, the REAL nightly roll-up over 1–11 Nov, the REAL core answering (Inicio's statsWorld)
export async function world({ extra = [], keyerFails = false } = {}) {
  const orders = {};
  const add = (o) => { orders[o.order_id] = o; return o; };
  add(F.deliver(F.pickup(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at('2026-11-05', 19), phone: '88880001', totalCents: 31000, items: [{ name: 'Pepperoni 12″', qty: 2, unit: 155 }] }), at('2026-11-05', 19, 20)), at('2026-11-05', 19, 40)));
  add(F.cashOrder({ rid: 'r_a', pm: 'card_delivery', now: at('2026-11-06', 13), phone: '88880002', totalCents: 27000, items: [{ name: 'Carnívora 18″', qty: 1, unit: 270 }] }));
  add(F.cashOrder({ rid: 'r_b', pm: 'cash', now: at('2026-11-06', 12), phone: '88880003', totalCents: 15000, items: [{ name: 'Margherita 12″', qty: 1, unit: 150 }] }));
  add(F.cashOrder({ rid: 'r_a', pm: 'cash', now: at(TODAY, 11), phone: '88880009', totalCents: 15000, items: [{ name: 'Margherita 12″', qty: 1, unit: 150 }] }));
  for (const o of extra) add(o);
  const fsdb = makeDb();
  const rtdb = makeRtdb(orders);
  await J.runStatsRollup({ rtdb, fsdb, keyer, listRestaurants: async () => ['r_a', 'r_b'], log: () => {} }, { nowMs: NOW, mode: 'range', from: '2026-11-01', to: '2026-11-11', commit: true });
  const legacy = (rid) => ({ name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } });
  const MEMBERS = new Map([['brands/r_a', legacy('r_a')], ['brands/r_b', legacy('r_b')], ['brand_members/r_a/owners/uA', { granted_at: 1, granted_by: 'x' }], ['brand_members/r_b/owners/uA', { granted_at: 1, granted_by: 'x' }]]);
  const memberDb = { ref: (p) => ({ once: async () => { const v = MEMBERS.has(p) ? MEMBERS.get(p) : null; return { exists: () => v !== null, val: () => v }; } }) };
  const liveCache = A.makeLiveCache();
  return async (query, authz) => {
    const req = { method: 'GET', query, get: (h) => (h.toLowerCase() === 'authorization' ? authz : undefined) };
    return A.getSalesStatsCore({ authorize: (rid) => authorizeCatalogEdit({ db: memberDb, verifyIdToken: async (t) => { if (t !== 'TK-test') throw new Error('bad'); return { uid: 'uA' }; } }, req, rid),
      fsdb, rtdb, getKeyer: () => { if (keyerFails) throw new Error('no secret'); return keyer; }, nowMs: NOW, liveCache }, req);
  };
}
// the portal's api.js → the real core (the functions.js handler: status + json)
// `extra(fn, query)` answers the page's other calls (getMyBranches …); the stats calls reach the real core
export function route(serveRef, extra = null) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    const query = Object.fromEntries(u.searchParams);
    calls.push({ fn: u.pathname.split('/').pop(), query });
    if (extra) { const x = await extra(u.pathname.split('/').pop(), query); if (x) return x; }
    const out = await serveRef.serve(query, (opts && opts.headers && opts.headers.Authorization) || '');
    const ok = out.status >= 200 && out.status < 300;
    if (out.contentType) {   // a CSV answer, as portal/functions.js serves it: the text, Content-Disposition, the core's headers (X-Next-Cursor)
      const hs = { 'content-disposition': out.filename ? `attachment; filename="${out.filename}"` : null };
      for (const [k, v] of Object.entries(out.headers || {})) hs[k.toLowerCase()] = v;
      return { ok, status: out.status, text: async () => out.body, json: async () => { throw new Error('not json'); }, headers: { get: (n) => hs[String(n).toLowerCase()] ?? null } };
    }
    const text = JSON.stringify(out.body);
    return { ok, status: out.status, json: async () => JSON.parse(text), text: async () => text, headers: { get: () => null } };
  };
  return calls;
}
