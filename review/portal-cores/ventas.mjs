// REVIEW ONLY — the «Ventas» SBS backend (advisor 11-15). Every call the page makes is answered by REAL cores:
//   getSalesStats (single, «Todas» multi, both CSVs)  5f's getSalesStatsCore at the portal's PINNED S2 ref (stats-harness.mjs S2_REF),
//                     over orders written by the REAL fixtures (createOrder's own update builder) and rolled up by the REAL nightly job
//                     (runStatsRollup), behind the REAL authorizer (authorizeCatalogEdit) — the composition stats-harness.mjs world() uses
//   getMyBranches     5f's getMyBranchesCore of the worktree under review, the owner bootstrapped by the REAL roster writer
// The page runs on the harness clock (manifest `clock` = NOW, 12 nov 2026 15:00 Honduras — the mockup's «today»).
// Scenarios: populated (default) · missing (two nights not rolled up) · long (1 may → 12 nov) · empty (24–25 dic 2025 rolled up, no
// orders) · error (one branch's stats store unreadable ⇒ the real «Todas» 503) · hold (every stats answer held) · hold-after-first
// (the first stats answer served, later ones held — the period-change dim). A hold is transport only: the real core still answers
// after 90 s (never a canned body).
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OWNER = 'uOwnerShoot';
const ROWS = [['r_centro', 'Centro'], ['r_proceres', 'Los Próceres'], ['r_trapiche', 'El Trapiche']];
// the mockup's sample products (P_ALL) at their drawn unit prices, lempiras
const MENU = [['Pizza Margarita grande', 245, 5], ['Pizza Pepperoni grande', 235, 4], ['Lasaña de carne', 120, 4], ['Calzone de jamón', 160, 2], ['Tres leches', 70, 3]];
// orders per day, 30 oct → 12 nov (the mockup's D14 counts; 12 nov up to 15:00)
const D14 = [27, 33, 36, 35, 24, 26, 27, 32, 39, 37, 26, 25, 27, 37];
const ALL_DAY = { open: true, start: '00:00', end: '23:59' };
const quiet = { warn() {}, log() {}, error() {} };

export async function backend(root) {
  const H = await import(pathToFileURL(path.join(root, 'xpizza-portal', 'stats-harness.mjs')).href);
  const { refTree } = await import(pathToFileURL(path.join(root, 'xpizza-portal', 'ref-tree.mjs')).href);
  const { T, J, A, F, NOW, at, S2_REF } = H;
  const rq = refTree(S2_REF);
  const { makeRtdb } = rq('./stats/stats-rtdb-fake');
  const { makeDb } = rq('./catalog/firestore-fake');
  const { makeCustomerKeyer } = rq('./stats/stats-identity');
  const { authorizeCatalogEdit } = rq('./catalog/catalog-edit-auth');
  const keyer = makeCustomerKeyer('s'.repeat(40));
  // the portal's branch list: the REAL E1 of the tree under review
  const req = createRequire(path.join(root, 'xpizza-functions', 'package.json'));
  const { createFakeDb } = req('./merchant/_fake-db');
  const R = req('./access/roster');
  const C = req('./portal/ops-core');
  const e1db = createFakeDb({
    brands: { pv: { name: 'Pizzería Del Valle', active: true, locations: Object.fromEntries(ROWS.map(([rid]) => [rid, 'member'])), activation: { state: 'on', since: 1 } } },
    restaurants: Object.fromEntries(ROWS.map(([rid, name]) => [rid, { identity: { brand_id: 'pv', name, active: true, prep_default_min: 20, version: 1,
      hub_lat: 15.5, hub_lng: -88.03, delivery_radius_km: 4, phone: '+50497128830', hours: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((k) => [k, ALL_DAY])) } }])),
  });
  const boot = await R.mutateRoster({ db: e1db, now: () => 1 }, 'pv', { kind: 'cli', operator: 'shoot' }, { type: 'bootstrap_owner', uid: OWNER, profile: { name: 'Marcela Pineda', email: 'duena@pv.hn' } });
  if (!boot || boot.ok === false) throw new Error(`premise: the roster writer bootstrapped the owner (${JSON.stringify(boot)})`);
  const adminOf = (f) => ({ ref: (p) => { const r = f.ref(p); return { ...r, get: () => r.once() }; } });

  // the order book (deterministic): each order 1–2 dishes from MENU, spread over 11:00–21:00 (today: up to 14:50), three branches
  let n = 0;
  const order = (date, h, m, i) => {
    const a = MENU[i % MENU.length], b = i % 3 === 0 ? MENU[(i + 2) % MENU.length] : null;
    const items = [{ name: a[0], qty: 1, unit: a[1] }, ...(b ? [{ name: b[0], qty: 1, unit: b[1] }] : [])];
    return F.cashOrder({ rid: ROWS[i % 3][0], pm: i % 4 === 0 ? 'card_delivery' : 'cash', now: at(date, h, m), phone: `8888${String(1000 + (i % 260)).padStart(4, '0')}`, items });
  };
  const fourteen = () => {
    const out = [];
    D14.forEach((cnt, d) => {
      const date = T.addDays('2026-10-30', d), last = date === '2026-11-12';
      for (let k = 0; k < cnt; k++) { const mins = last ? Math.floor((k * 230) / cnt) : Math.floor((k * 600) / cnt); out.push(order(date, 11 + Math.floor(mins / 60), mins % 60, n++)); }
    });
    return out;
  };
  const longBook = () => { const out = []; for (let date = '2026-05-01'; date <= '2026-11-12'; date = T.addDays(date, 1)) for (let k = 0; k < 30; k++) out.push(order(date, 11 + (k % 9), (k * 7) % 60, n++)); return out; };
  // a store whose `bad` branch documents cannot be read (an outage): the REAL core turns it into its own 503
  const outage = (db, bad) => {
    const fail = async () => { throw new Error(`injected outage: restaurants/${bad}`); };
    const sub = { doc: () => ({ get: fail, collection: () => sub }), get: fail, where: () => sub, orderBy: () => sub, limit: () => sub };
    const o = Object.create(db);
    o.collection = (name) => { const c = db.collection(name); if (name !== 'restaurants') return c; const w = Object.create(c); w.doc = (id) => (id === bad ? { collection: () => sub, get: fail } : c.doc(id)); return w; };
    return o;
  };
  let W = null;
  async function reset(scn) {
    const book = scn === 'long' ? longBook() : scn === 'empty' ? [] : fourteen();
    const orders = Object.fromEntries(book.map((o) => [o.order_id, o]));
    const fsdb = makeDb(), rtdb = makeRtdb(orders);
    const roll = (from, to) => J.runStatsRollup({ rtdb, fsdb, keyer, listRestaurants: async () => ROWS.map(([rid]) => rid), log: () => {} }, { nowMs: NOW, mode: 'range', from, to, commit: true });
    if (scn === 'long') { for (let f = '2026-05-01'; f <= '2026-11-11'; f = T.addDays(f, 14)) { const t = T.addDays(f, 13); await roll(f, t < '2026-11-11' ? t : '2026-11-11'); } }   // two-week runs: the real job's lease bounds one run
    else if (scn === 'empty') await roll('2025-12-24', '2025-12-25');
    else if (scn === 'missing') { await roll('2026-10-29', '2026-11-08'); await roll('2026-11-11', '2026-11-11'); }   // 9 and 10 nov never rolled up
    else await roll('2026-10-29', '2026-11-11');
    const MEMBERS = new Map(ROWS.flatMap(([rid]) => [[`brands/${rid}`, { name: rid, active: true, locations: { [rid]: 'member' }, activation: { state: 'legacy', since: 1 } }],
      [`brand_members/${rid}/owners/${OWNER}`, { granted_at: 1, granted_by: 'x' }]]));
    const memberDb = { ref: (p) => ({ once: async () => { const v = MEMBERS.has(p) ? MEMBERS.get(p) : null; return { exists: () => v !== null, val: () => v }; } }) };
    W = { scn, fsdb: scn === 'error' ? outage(fsdb, 'r_proceres') : fsdb, rtdb, memberDb, liveCache: A.makeLiveCache(), served: 0 };
  }
  async function call({ fn, method, query, headers }) {
    if (fn === 'getMyBranches') return C.getMyBranchesCore({ db: adminOf(e1db), verifyIdToken: async () => ({ uid: OWNER }), now: () => NOW, log: quiet },
      { method, get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer shoot' : undefined) });
    if (fn !== 'getSalesStats' && fn !== 'getSalesOrdersCsv') return null;
    // hold-after-first = the VENTAS TAB's first answer is served, its later ones held (the period-change dim). Inicio — the shell's
    // landing view — asks for TODAY (a single-day range, from === to) before the tab exists; counting that call held the tab's own first
    // answer, so the tab never had a body and a period change showed the loading skeleton, not the dim (slot 11-15 root cause)
    const multiDay = !(query && query.from && query.from === query.to);
    const held = W.scn === 'hold' || (W.scn === 'hold-after-first' && multiDay && W.served > 0);
    if (multiDay) W.served += 1;
    if (held) await new Promise((r) => setTimeout(r, 90000).unref());
    const authz = headers.authorization || 'Bearer shoot';
    const r = { method, query, get: (h) => (h.toLowerCase() === 'authorization' ? authz : undefined) };
    const out = await A.getSalesStatsCore({ authorize: (rid) => authorizeCatalogEdit({ db: W.memberDb, verifyIdToken: async () => ({ uid: OWNER }) }, r, rid),
      fsdb: W.fsdb, rtdb: W.rtdb, getKeyer: () => keyer, nowMs: NOW, liveCache: W.liveCache }, r);
    if (out.contentType) return { status: out.status, body: out.body, contentType: out.contentType,
      headers: { ...(out.filename ? { 'content-disposition': `attachment; filename="${out.filename}"` } : {}), ...(out.headers || {}) } };
    return { status: out.status, body: out.body };
  }
  return { reset, call, clock: NOW };
}
