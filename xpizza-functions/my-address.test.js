'use strict';
// PLAN-3a-addr r0 S-ADDR-2 — useMyAddress, the «en uso» selection persisted as default_address (advisor Q1).
// The BOOK is written by the REAL writer (the frozen form's own saveAddress, lifted from xpizza-orders/account.js); the sweep's
// claim by the REAL signup-core.sweepClaim; the purge by the REAL account-lib.accountDeleteUpdates. The in-memory RTDB is
// my-favorites.test.js's model of production TRANSACTION semantics (a cold first null, re-run on a moved server, `undefined` aborts,
// a pause hook before the commit for an interleaving).
// PLAN-3a-addr-rev r0 (advisor GO 2026-11-18): the selection is a revision CAS — body { id, expected_rev }; a mismatch ⇒ 409
// stale_address with the projected current selection + rev, nothing written (the REV-* cells). r1 (advisor GO, Option B — rule 6b):
// the body also carries expected_default (the selection the client last saw), so a selection changed by the frozen form's own
// saveAddress / deleteAddress (which never touch the rev) is refused too (the FORM-* cells, through the REAL form writers). Run: node my-address.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { makeMyAddress, RATE } = require('./my-address');
const { sweepClaim } = require('./signup-core');
const ACCOUNT = require('./account-lib');
const AB = require('./address-book');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('🔴 my-address: FAILED — exited without completing (a hang)\n'); process.exitCode = 1; } });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);

function fakeDb() {
  const tree = {}; const reads = []; const writes = [];
  const parts = (p) => String(p).split('/').filter(Boolean);
  const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const set = (p, v) => {
    const ks = parts(p); if (!ks.length) throw new Error('root set');
    let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    if (v === null || v === undefined || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = clone(v);
  };
  const snapOf = (v, ordered = null) => { const c = clone(v); return {
    exists: () => c != null, val: () => (c == null ? null : clone(c)),
    forEach: (cb) => { for (const [k, x] of (ordered || Object.entries(c || {}))) { if (cb({ key: k, val: () => clone(x) }) === true) return true; } return false; },
  }; };
  const rank = (v) => (v == null ? 0 : v === false ? 1 : v === true ? 2 : typeof v === 'number' ? 3 : typeof v === 'string' ? 4 : 5);
  const cmp = (a, b) => (rank(a.v) - rank(b.v)) || (a.v < b.v ? -1 : a.v > b.v ? 1 : 0) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
  const query = (p, child) => {
    const q = { eq: undefined, last: null, first: null };
    const api = {
      equalTo: (v) => { q.eq = v; return api; }, limitToLast: (m) => { q.last = m; return api; }, limitToFirst: (m) => { q.first = m; return api; },
      startAt: () => api, endAt: () => api,
      once: async () => {
        reads.push({ kind: 'query', path: p, child, last: q.last });
        let rows = Object.entries(get(p) || {}).map(([k, x]) => ({ k, x, v: x && typeof x === 'object' ? x[child] : undefined }));
        if (q.eq !== undefined) rows = rows.filter((r) => r.v === q.eq);
        rows.sort((a, b) => cmp({ v: a.v, k: a.k }, { v: b.v, k: b.k }));
        if (q.last != null) rows = rows.slice(Math.max(0, rows.length - q.last));
        if (q.first != null) rows = rows.slice(0, q.first);
        return snapOf(rows.length ? Object.fromEntries(rows.map((r) => [r.k, r.x])) : null, rows.map((r) => [r.k, r.x]));
      },
    };
    return api;
  };
  const T = { cold: new Set(), pause: new Map(), txs: [] };   // txs: every transaction ATTEMPT (path), committed or not   // cold: a path whose NEXT transaction first sees null; pause: path → async fn run before the commit
  // Codex #163 P1 — the shared SDK of ONE instance: a transaction's proposal is a PENDING LOCAL write that an overlapping transaction
  // on the same path (same instance) is handed as its input; an `undefined` abort is local (never server-confirmed); a proposal the
  // server refuses is ROLLED BACK. `get()` / `once()` read the server (repoGetValue never returns a pending local write).
  const mkRef = (local) => (p = '') => ({
    get: async () => { reads.push({ kind: 'get', path: p }); return snapOf(get(p)); },
    once: async () => { reads.push({ kind: 'get', path: p }); return snapOf(get(p)); },
    set: async (v) => { writes.push(p); set(p, v); }, remove: async () => { writes.push(p); set(p, null); },
    update: async (m) => { for (const [k, v] of Object.entries(m)) { writes.push(p ? `${p}/${k}` : k); set(p ? `${p}/${k}` : k, v); } },
    orderByChild: (c) => query(p, c),
    transaction: async (fn) => {
      T.txs.push(p);
      let seen = local.has(p) ? clone(local.get(p)) : T.cold.has(p) ? null : (clone(get(p)) ?? null); T.cold.delete(p);
      for (let i = 0; i < 25; i++) {
        const next = fn(clone(seen));
        if (next === undefined) return { committed: false, snapshot: snapOf(get(p)) };   // a LOCAL abort: never checked against the server
        local.set(p, clone(next));   // pending: visible to an overlapping transaction of THIS instance
        if (T.pause.has(p)) { const f = T.pause.get(p); T.pause.delete(p); await f(); }
        const server = clone(get(p)) ?? null;
        if (!same(server, seen)) { local.delete(p); seen = server; continue; }   // rolled back; RE-RUN with the real node
        local.delete(p); writes.push(p); set(p, next); return { committed: true, snapshot: snapOf(get(p)) };
      }
      throw new Error('transaction: too many retries');
    },
  });
  const ref = mkRef(new Map());
  // another Functions instance: its own SDK (its own pending writes), the SAME server
  const instance = () => ({ tree, reads, writes, get, set, ref: mkRef(new Map()), T });
  return { tree, reads, writes, get, set, ref, T, instance };
}

const A = 'u_' + 'a'.repeat(24), B = 'u_' + 'b'.repeat(24);
const TOK = { [`tok-${A}`]: { uid: A, customer: true }, [`tok-${B}`]: { uid: B, customer: true }, 'tok-hh': { uid: A, customer: true, handheld: true }, 'tok-staff': { uid: 'staff1' } };
const auth = { verifyIdToken: async (t) => { if (!TOK[t]) throw new Error('bad token'); return TOK[t]; } };
let CLOCK = 1_800_000_000_000;
const quietly = async (f) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await f(); } finally { console.error = e; console.warn = w; } };

function harness(db, { limited = false, getDatabase } = {}) {
  const rl = [];
  const h = makeMyAddress({ getDatabase: getDatabase || (() => db), getAuth: () => auth, now: () => CLOCK,
    checkRateLimit: async (_db, bucket, key, policy) => { assert.ok(policy && policy.windowMs > 0 && policy.max > 0, `🔴 ${bucket}: an explicit limiter policy`); rl.push({ bucket, key }); return limited ? { allowed: false, retryAfterSec: 9 } : { allowed: true, retryAfterSec: 0 }; } });
  const use = async (token, body, { method = 'POST', query = { context: 'platform' }, rawBody } = {}) => {
    const headers = token ? { 'x-firebase-id-token': token } : {};
    const req = { method, query, body, rawBody, headers, get: (x) => headers[String(x).toLowerCase()] };
    const res = { h: {}, set(k, v) { res.h[k] = v; return res; }, status(c) { res.code = c; return res; }, json(b) { res.body = b; return res; } };
    await h.useMyAddress(req, res); return res;
  };
  return { rl, use };
}

// the frozen form's OWN saveAddress (account.js), run against this db for uid
const ACC = fs.readFileSync(path.join(__dirname, '..', 'xpizza-orders', 'account.js'), 'utf8');
const liftFn = (head) => { const at = ACC.indexOf(head); assert.ok(at > 0, `premise: account.js defines ${head}`); return ACC.slice(at, ACC.indexOf('\n  }\n', at) + 4); };
const formSaveAddress = (db, uid) => new Function('ensureFirebase', 'heal', 'MAX_ADDRESSES', 'window', `${liftFn('function newAddrId()')}\n${liftFn('async function saveAddress(')}\nreturn saveAddress;`)(
  async () => ({ auth: { authStateReady: async () => {}, currentUser: { uid } }, db: null,
    dbMod: { ref: (_d, p) => p, get: async (p) => db.ref(p).get(), update: async (_r, u) => db.ref().update(u) } }), () => {}, 10, { crypto: require('crypto').webcrypto });
// the frozen form's OWN deleteAddress (account.js) — nulls default_address with the entry when it was the default
const formDeleteAddress = (db, uid) => new Function('ensureFirebase', 'heal', `${liftFn('async function deleteAddress(')}\nreturn deleteAddress;`)(
  async () => ({ auth: { authStateReady: async () => {}, currentUser: { uid } }, db: null,
    dbMod: { ref: (_d, p) => p, get: async (p) => db.ref(p).get(), update: async (_r, u) => db.ref().update(u) } }), () => {});
// a member A with a profile and a two-entry book (Casa = default, Trabajo), both through the real writer
async function bookOf(db) {
  db.set(`user_profiles/${A}`, { phone: '50499990000', phone_hash: 'ph', created_at: 5, last_login: 6, name: 'Ana' });
  const save = formSaveAddress(db, A);
  const casa = await save({ label: 'Casa', detected: 'Col. Palmira, Tegucigalpa', details: 'Casa azul, portón negro', lat: 14.09, lng: -87.18, makeDefault: true });
  await new Promise((r) => setTimeout(r, 2));
  const trab = await save({ label: 'Trabajo', detected: 'Blvd. Morazán', details: 'Torre 2, piso 5', lat: 14.1, lng: -87.19 });
  assert.ok(casa.ok && trab.ok, `premise: the form's own saveAddress wrote the book (${JSON.stringify([casa, trab])})`);
  db.writes.length = 0;
  return { casa: casa.addrId, trab: trab.addrId };
}
// exactly the three changes: default_address = id, default_address_rev = rev, addresses[id].last_used_at = now; every other byte kept
const expectUsed = (before, id, now, rev) => ({ ...before, default_address: id, default_address_rev: rev, addresses: { ...before.addresses, [id]: { ...before.addresses[id], last_used_at: now } } });

(async () => {
  // ── 1. the member predicate: guests / bad / non-customer / handheld ⇒ 401; each tombstone ⇒ 403; nothing written ──
  {
    for (const t of [undefined, 'nope', 'tok-staff', 'tok-hh']) {
      const db = fakeDb(); const { casa } = await bookOf(db); const before = clone(db.get(`user_profiles/${A}`));
      const r = await harness(db).use(t, { id: casa, expected_rev: 0, expected_default: casa });
      assert.strictEqual(r.code, 401, `🔴 ${t} ⇒ 401`); assert.deepStrictEqual(r.body, { ok: false, reason: 'unauthenticated' });
      assert.deepStrictEqual(db.get(`user_profiles/${A}`), before, `🔴 ${t}: nothing written`);
    }
    for (const tomb of [`deleted_uids/${A}`, `user_private/${A}/deleted_at`, 'sweep']) {
      const db = fakeDb(); const { casa, trab } = await bookOf(db);
      if (tomb === 'sweep') assert.strictEqual(await sweepClaim(db, A, CLOCK, 77), 'claimed', 'premise: the REAL sweep claimed the profile'); else db.set(tomb, 5);
      const before = clone(db.get(`user_profiles/${A}`));
      const r = await harness(db).use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
      assert.strictEqual(r.code, 403, `🔴 ${tomb} ⇒ 403`); assert.deepStrictEqual(r.body, { ok: false, reason: 'deleted' });
      assert.deepStrictEqual(db.get(`user_profiles/${A}`), before, `🔴 ${tomb}: nothing written`);
    }
  }
  ok('no / bad / non-customer / HANDHELD token ⇒ 401; each of the three tombstones (deleted_uids, user_private/deleted_at, the REAL sweep claim) ⇒ 403 deleted; nothing written');

  // ── 2. the request is STRICT: POST ?context=platform, body EXACTLY { id } with an address id; a uid or address content never accepted ──
  {
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const before = clone(db.get(`user_profiles/${A}`)); const { use } = harness(db);
    const r405 = await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa }, { method: 'GET' });
    assert.strictEqual(r405.code, 405, '🔴 GET ⇒ 405');
    const E = { expected_rev: 0, expected_default: null };
    const bad = [
      [{ id: trab, ...E }, { query: {} }], [{ id: trab, ...E }, { query: { context: 'web' } }], [{ id: trab, ...E }, { query: { context: 'platform', uid: B } }],
      [undefined], [null], [[trab]], ['a_x'], [{}], [E], [{ id: 'a_XYZ', ...E }], [{ id: 'a_12345', ...E }], [{ id: `b_${trab.slice(2)}`, ...E }], [{ id: 7, ...E }],
      [{ id: trab, uid: B, ...E }], [{ id: trab, context: 'platform', ...E }], [{ id: trab, label: 'Casa', ...E }], [{ id: trab, lat: 1, lng: 1, ...E }],
    ];
    for (const [body, o] of bad) {
      const r = await use(`tok-${A}`, body, o);
      assert.strictEqual(r.code, 400, `🔴 ${JSON.stringify(body)} ${JSON.stringify(o || {})} ⇒ 400`); assert.deepStrictEqual(r.body, { ok: false, reason: 'bad_request' });
    }
    // REV-REQUIRED (advisor ruling: strict, nothing has shipped): expected_rev present, a safe integer ≥ 0 — else 400, never a write
    const D = { expected_default: null };
    for (const body of [{ id: trab, ...D }, { id: trab, expected_rev: -1, ...D }, { id: trab, expected_rev: 1.5, ...D }, { id: trab, expected_rev: '0', ...D },
      { id: trab, expected_rev: null, ...D }, { id: trab, expected_rev: 2 ** 53, ...D }, { id: trab, expected_rev: true, ...D }, { id: trab, expected_rev: 0, rev: 0, ...D }]) {
      const r = await use(`tok-${A}`, body);
      assert.deepStrictEqual([r.code, r.body], [400, { ok: false, reason: 'bad_request' }], `🔴 REV-REQUIRED ${JSON.stringify(body)} ⇒ 400`);
    }
    // EXP-DEFAULT-REQUIRED (r1): expected_default present — null or an address id — else 400
    for (const body of [{ id: trab, expected_rev: 0 }, { id: trab, expected_rev: 0, expected_default: undefined }, { id: trab, expected_rev: 0, expected_default: '' },
      { id: trab, expected_rev: 0, expected_default: 'a_XYZ' }, { id: trab, expected_rev: 0, expected_default: 7 }, { id: trab, expected_rev: 0, expected_default: false },
      { id: trab, expected_rev: 0, expected_default: {} }, { id: trab, expected_rev: 0, expected_default: [trab] }]) {
      const r = await use(`tok-${A}`, body);
      assert.deepStrictEqual([r.code, r.body], [400, { ok: false, reason: 'bad_request' }], `🔴 EXP-DEFAULT-REQUIRED ${JSON.stringify(body)} ⇒ 400`);
    }
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), before, '🔴 a refused request writes nothing');
    assert.strictEqual(db.T.txs.length, 0, 'a refused request never opens the transaction');
  }
  ok('strict request: GET ⇒ 405; no / other / extra query, a non-object body, a missing or malformed id, any extra key (uid, context, address content), a missing or non-integer / negative expected_rev, a missing or malformed expected_default ⇒ 400; nothing written');

  // ── 2b. PLAN-3a-addr-rev: the selection is a revision CAS (an older write can never overwrite its successor) ──
  {
    // REV-LEGACY / REV-MINT: a forms-era row (the REAL writer set default_address, no rev) reads as rev 0; the first write mints 1
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use } = harness(db);
    assert.ok(!('default_address_rev' in db.get(`user_profiles/${A}`)), 'premise: the real writer leaves no rev');
    CLOCK += 1000;
    const r = await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
    assert.strictEqual(r.code, 200, `🔴 REV-LEGACY: a row with no rev is rev 0 (${JSON.stringify(r.body)})`);
    assert.deepStrictEqual(r.body, { ok: true, default_address: trab, default_address_rev: 1 }, '🔴 REV-MINT: the new rev is returned');
    assert.strictEqual(db.get(`user_profiles/${A}/default_address_rev`), 1, '🔴 REV-MINT: … and stored');
    // REV-STALE: a second writer still holding rev 0 ⇒ 409 stale_address + the projected CURRENT selection; the node is byte-identical
    const before = clone(db.get(`user_profiles/${A}`)); const w = db.writes.length;
    CLOCK += 1000;
    const st = await use(`tok-${A}`, { id: casa, expected_rev: 0, expected_default: casa });
    assert.deepStrictEqual([st.code, st.body], [409, { ok: false, reason: 'stale_address', default_address: trab, default_address_rev: 1 }], '🔴 REV-STALE: 409 + the current selection and rev');
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), before, '🔴 REV-STALE: nothing written (no selection, no rev, no last_used_at)');
    assert.strictEqual(db.writes.length, w, '🔴 REV-STALE: no write at all');
    // REV-ORDER: w1 (0→1 above), w2 (1→2), then the SLOW w1 replayed with 0 ⇒ refused; the newer selection stays
    CLOCK += 1000;
    const w2 = await use(`tok-${A}`, { id: casa, expected_rev: 1, expected_default: trab });
    assert.deepStrictEqual([w2.code, w2.body], [200, { ok: true, default_address: casa, default_address_rev: 2 }], '🔴 REV-ORDER: the current rev is accepted and bumped');
    const late = await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
    assert.deepStrictEqual([late.code, late.body.default_address, late.body.default_address_rev], [409, casa, 2], '🔴 REV-ORDER: the older write arriving late is refused');
    assert.deepStrictEqual([db.get(`user_profiles/${A}/default_address`), db.get(`user_profiles/${A}/default_address_rev`)], [casa, 2], '🔴 REV-ORDER: the newer selection survives');
  }
  {
    // REV-LOSTREPLY (advisor ruling): the 200 is lost and the client resends the SAME write ⇒ 409 carrying its own id at expected + 1
    // (the client counts it as success); the resend writes nothing
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use } = harness(db);
    CLOCK += 1000;
    assert.strictEqual((await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa })).code, 200, 'premise: the first write landed');
    const landed = clone(db.get(`user_profiles/${A}`));
    CLOCK += 1000;
    const again = await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
    assert.deepStrictEqual([again.code, again.body], [409, { ok: false, reason: 'stale_address', default_address: trab, default_address_rev: 1 }], '🔴 REV-LOSTREPLY: own id at expected + 1');
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), landed, '🔴 REV-LOSTREPLY: the resend writes nothing (last_used_at not re-bumped)');
  }
  {
    // the 409's selection is PROJECTED: a stored default naming an off-shape entry is served as null; a malformed stored rev reads as 0
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use } = harness(db);
    db.set(`user_profiles/${A}/addresses/${casa}/label`, '');
    db.set(`user_profiles/${A}/default_address_rev`, 3);
    const p = await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: null });
    assert.deepStrictEqual([p.code, p.body.default_address, p.body.default_address_rev], [409, null, 3], '🔴 REV-STALE: the 409 selection is projected (an off-shape default ⇒ null)');
    // PROJ-DEFAULT (r1): the comparison uses the PROJECTED default — the client that saw null (the stored default names an off-shape
    // entry) is accepted at the current rev; comparing the RAW stored id would refuse it forever
    assert.strictEqual(db.get(`user_profiles/${A}/default_address`), casa, 'premise: the RAW stored default still names the off-shape entry');
    const pj = await use(`tok-${A}`, { id: trab, expected_rev: 3, expected_default: null });
    assert.deepStrictEqual([pj.code, pj.body.default_address_rev], [200, 4], '🔴 PROJ-DEFAULT: the projected (null) default is the one compared');
    db.set(`user_profiles/${A}/default_address`, casa); db.set(`user_profiles/${A}/default_address_rev`, 3);
    for (const bad of ['3', -1, 2.5]) {
      db.set(`user_profiles/${A}/default_address_rev`, bad);
      const m = await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: AB.projectBook(db.get(`user_profiles/${A}`)).default_address });   // what getMyProfile serves
      assert.deepStrictEqual([m.code, m.body.default_address_rev], [200, 1], `🔴 REV-LEGACY: a malformed stored rev (${JSON.stringify(bad)}) reads as 0 — never a lockout`);
    }
  }
  {
    // REV-PRECEDENCE: 403 (the fence) before 409; 409 before 404 (a stale client pointing at a removed entry re-reads)
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use } = harness(db);
    db.set(`user_profiles/${A}/default_address_rev`, 4);
    const unknown = 'a_' + 'e'.repeat(12);
    assert.deepStrictEqual([(await use(`tok-${A}`, { id: unknown, expected_rev: 1, expected_default: casa })).code], [409], '🔴 REV-PRECEDENCE: stale + unknown entry ⇒ 409');
    assert.deepStrictEqual([(await use(`tok-${A}`, { id: unknown, expected_rev: 4, expected_default: casa })).code], [404], '🔴 REV-PRECEDENCE: current rev + unknown entry ⇒ 404');
    // the fence vs stale ORDER lives inside the transaction (a claim BEFORE the request is answered by member-auth, not here): the
    // request is current on its first run; between its read and its commit a REAL concurrent capp write moves the rev AND the REAL
    // sweep claims ⇒ the re-run is both fenced and stale ⇒ the fence wins ⇒ 403
    db.T.pause.set(`user_profiles/${A}`, async () => {
      assert.strictEqual((await harness(db.instance()).use(`tok-${A}`, { id: casa, expected_rev: 4, expected_default: casa })).code, 200, 'premise: the concurrent write (another instance) moved the rev');
      assert.strictEqual(await sweepClaim(db.instance(), A, CLOCK, 77), 'claimed', 'premise: the REAL sweep (another instance) claimed mid-transaction');
    });
    const fx = await use(`tok-${A}`, { id: trab, expected_rev: 4, expected_default: casa });
    assert.strictEqual(fx.code, 403, `🔴 REV-PRECEDENCE: fenced + stale (inside the transaction) ⇒ 403 (${fx.code})`);
  }
  {
    // REV-RACE: two writes in flight with the SAME expected_rev — the second lands while the first is between read and commit ⇒
    // the first re-runs on the moved node and is refused: exactly one 200, one 409, the winner's selection kept
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use } = harness(db);
    let second = null;
    db.T.pause.set(`user_profiles/${A}`, async () => { second = await harness(db.instance()).use(`tok-${A}`, { id: casa, expected_rev: 0, expected_default: casa }); });   // another instance
    const first = await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
    assert.deepStrictEqual([second.code, second.body.default_address_rev], [200, 1], 'premise: the interleaved write won');
    assert.deepStrictEqual([first.code, first.body], [409, { ok: false, reason: 'stale_address', default_address: casa, default_address_rev: 1 }], '🔴 REV-RACE: the loser is refused with the winner\'s selection');
    assert.deepStrictEqual([db.get(`user_profiles/${A}/default_address`), db.get(`user_profiles/${A}/default_address_rev`)], [casa, 1], '🔴 REV-RACE: the winner kept, rev 1');
  }
  ok('REV CAS: a rev-less (forms-era) or malformed rev reads as 0 and the first write mints 1; a stale expected_rev ⇒ 409 stale_address + the PROJECTED current selection + rev, nothing written; an older write landing late is refused and the newer kept; a lost-reply resend sees its own id at expected + 1; 403 before 409 before 404; two in flight ⇒ one 200, one 409');

  // ── 2c. r1 (Option B, rule 6b): the frozen form changes the selection WITHOUT touching the rev — the expected_default half of the
  // CAS refuses it; every form step below is the form's OWN saveAddress / deleteAddress (account.js), never a hand-built update ──
  const CONTENT = (label, details) => ({ label, detected: 'Blvd. Morazán', details, lat: 14.1, lng: -87.19 });
  {
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use } = harness(db);
    const save = formSaveAddress(db, A); const del = formDeleteAddress(db, A);
    CLOCK += 1000;
    assert.deepStrictEqual((await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa })).body, { ok: true, default_address: trab, default_address_rev: 1 }, 'premise: the capp selected trabajo (its view: trab @1)');
    // FORM-STALE: the form re-picks Casa as the default (saveAddress makeDefault) — the rev does not move
    assert.ok((await save({ addrId: casa, ...CONTENT('Casa', 'Casa azul, portón negro'), makeDefault: true })).ok, 'premise: the form saved Casa as default');
    assert.deepStrictEqual([db.get(`user_profiles/${A}/default_address`), db.get(`user_profiles/${A}/default_address_rev`)], [casa, 1], 'premise: the form moved the selection, not the rev');
    const before = clone(db.get(`user_profiles/${A}`)); const w = db.writes.length;
    CLOCK += 1000;
    const st = await use(`tok-${A}`, { id: trab, expected_rev: 1, expected_default: trab });
    assert.deepStrictEqual([st.code, st.body], [409, { ok: false, reason: 'stale_address', default_address: casa, default_address_rev: 1 }], '🔴 FORM-STALE: a form-changed selection ⇒ 409 with the form\'s selection');
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), before, '🔴 FORM-STALE: nothing written'); assert.strictEqual(db.writes.length, w, '🔴 FORM-STALE: no write');
    // FORM-CONVERGE: the client adopts the 409's pair and retries ⇒ accepted
    const cv = await use(`tok-${A}`, { id: trab, expected_rev: st.body.default_address_rev, expected_default: st.body.default_address });
    assert.deepStrictEqual([cv.code, cv.body.default_address_rev], [200, 2], '🔴 FORM-CONVERGE: the re-read pair is accepted');
    // FORM-CONTENT (scope pinned): the form edits the CONTENT of the selected entry (no makeDefault) — the selection is unchanged, so the
    // capp write on its current pair is ACCEPTED (the CAS guards the selection, not the entries' content)
    assert.ok((await save({ addrId: trab, ...CONTENT('Trabajo', 'Torre 3, piso 1') })).ok, 'premise: the form edited Trabajo\'s content');
    assert.deepStrictEqual([db.get(`user_profiles/${A}/default_address`), db.get(`user_profiles/${A}/addresses/${trab}/details`)], [trab, 'Torre 3, piso 1'], 'premise: same selection, new content');
    CLOCK += 1000;
    const ct = await use(`tok-${A}`, { id: casa, expected_rev: 2, expected_default: trab });
    assert.deepStrictEqual([ct.code, ct.body.default_address_rev], [200, 3], '🔴 FORM-CONTENT: a content edit of the selected entry is not a selection change ⇒ accepted');
    // FORM-DELETE: the form deletes the selected entry (deleteAddress nulls default_address) ⇒ the old pair is refused; null converges
    assert.ok((await del(casa)).ok, 'premise: the form deleted Casa');
    assert.strictEqual(db.get(`user_profiles/${A}/default_address`), undefined, 'premise: the form nulled the default');
    const dl = await use(`tok-${A}`, { id: trab, expected_rev: 3, expected_default: casa });
    assert.deepStrictEqual([dl.code, dl.body], [409, { ok: false, reason: 'stale_address', default_address: null, default_address_rev: 3 }], '🔴 FORM-DELETE: the deleted selection ⇒ 409 (null)');
    const dc = await use(`tok-${A}`, { id: trab, expected_rev: 3, expected_default: null });
    assert.deepStrictEqual([dc.code, dc.body.default_address_rev], [200, 4], '🔴 FORM-DELETE: … and the null pair converges');
  }
  {
    // FORM-LEGACY: the window before any capp write (a forms-era row, no rev at all): the client read (rev 0, Casa), then the form
    // picks Trabajo ⇒ the capp write on (0, Casa) is refused
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use } = harness(db);
    assert.ok((await formSaveAddress(db, A)({ addrId: trab, ...CONTENT('Trabajo', 'Torre 2, piso 5'), makeDefault: true })).ok, 'premise: the form picked Trabajo');
    assert.ok(!('default_address_rev' in db.get(`user_profiles/${A}`)), 'premise: still no rev');
    const lg = await use(`tok-${A}`, { id: casa, expected_rev: 0, expected_default: casa });
    assert.deepStrictEqual([lg.code, lg.body], [409, { ok: false, reason: 'stale_address', default_address: trab, default_address_rev: 0 }], '🔴 FORM-LEGACY: the no-rev window is covered');
  }
  {
    // FORM-ABA (accepted by ruling): the form moves Casa → Trabajo → Casa; the client that saw Casa @0 is accepted — its view IS the
    // current selection, so nothing newer is lost
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use } = harness(db); const save = formSaveAddress(db, A);
    assert.ok((await save({ addrId: trab, ...CONTENT('Trabajo', 'Torre 2, piso 5'), makeDefault: true })).ok && (await save({ addrId: casa, ...CONTENT('Casa', 'Casa azul, portón negro'), makeDefault: true })).ok, 'premise: A → B → A by the form');
    const ab = await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
    assert.deepStrictEqual([ab.code, ab.body.default_address_rev], [200, 1], '🔴 FORM-ABA: back to the client\'s view ⇒ accepted');
  }
  {
    // FORM-MID-SAVE (Codex #163 P3): the request is CURRENT on its first run; between its read and its commit the form's OWN
    // saveAddress(makeDefault) picks a third address — the rev does not move, so only the selection half, re-checked on the RE-RUN,
    // refuses it: 409 with the form's pick, and the handler writes nothing
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use } = harness(db); const save = formSaveAddress(db, A);
    CLOCK += 1000;
    assert.strictEqual((await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa })).code, 200, 'premise: (trab, 1)');
    let gym = null; let afterForm = null;
    db.T.pause.set(`user_profiles/${A}`, async () => {
      const g = await save({ ...CONTENT('Gym', 'Portón 3'), makeDefault: true }); assert.ok(g.ok, 'premise: the form picked Gym mid-transaction');
      gym = g.addrId; afterForm = clone(db.get(`user_profiles/${A}`));
    });
    const mid = await use(`tok-${A}`, { id: casa, expected_rev: 1, expected_default: trab });
    assert.deepStrictEqual([mid.code, mid.body], [409, { ok: false, reason: 'stale_address', default_address: gym, default_address_rev: 1 }], '🔴 FORM-MID-SAVE: a form pick between read and commit ⇒ 409 with the form\'s pick');
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), afterForm, '🔴 FORM-MID-SAVE: the handler wrote nothing over the form\'s pick');
  }
  {
    // FORM-MID-DELETE (P3): the form's OWN deleteAddress removes the selected entry between read and commit ⇒ 409 (null), nothing written
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use } = harness(db); const del = formDeleteAddress(db, A);
    let afterForm = null;
    db.T.pause.set(`user_profiles/${A}`, async () => { assert.ok((await del(casa)).ok, 'premise: the form deleted the selected Casa mid-transaction'); afterForm = clone(db.get(`user_profiles/${A}`)); });
    const md = await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
    assert.deepStrictEqual([md.code, md.body], [409, { ok: false, reason: 'stale_address', default_address: null, default_address_rev: 0 }], '🔴 FORM-MID-DELETE: the selection deleted between read and commit ⇒ 409 (null)');
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), afterForm, '🔴 FORM-MID-DELETE: the handler wrote nothing');
  }
  {
    // SERIAL-LOSTREPLY (Codex #163 P1): ONE instance. W1 proposes (trab, 1) — a PENDING local write — and, before it commits, the
    // client's resend W2 (the same body) arrives on the same instance while the form picks Gym on the server. W1's proposal is rolled
    // back (409, Gym). W2 must never be handed W1's uncommitted pair as «own id at expected + 1» (the client would count it as a
    // success that never happened): same-uid writes are serialized in the instance and every 409 pair is a SERVER read
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use } = harness(db); const save = formSaveAddress(db, A);
    let w2 = null; let gym = null;
    db.T.pause.set(`user_profiles/${A}`, async () => {
      w2 = use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });   // the resend, NOT awaited (it queues behind W1)
      await new Promise((r) => setImmediate(r));
      const g = await save({ ...CONTENT('Gym', 'Portón 3'), makeDefault: true }); assert.ok(g.ok, 'premise: the form picked Gym'); gym = g.addrId;
    });
    const w1 = await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
    const r2 = await w2;
    assert.deepStrictEqual([w1.code, w1.body.default_address, w1.body.default_address_rev], [409, gym, 0], 'premise: W1 was rolled back to the form\'s pick');
    assert.ok(!(r2.code === 409 && r2.body.default_address === trab && r2.body.default_address_rev === 1), `🔴 SERIAL-LOSTREPLY: the resend is never told «own id at expected + 1» for a pair that never committed (${JSON.stringify(r2.body)})`);
    assert.deepStrictEqual([r2.code, r2.body], [409, { ok: false, reason: 'stale_address', default_address: gym, default_address_rev: 0 }], '🔴 SERIAL-LOSTREPLY: the resend sees the COMMITTED pair');
    assert.deepStrictEqual([db.get(`user_profiles/${A}/default_address`), db.get(`user_profiles/${A}/default_address_rev`)], [gym, undefined], '🔴 SERIAL-LOSTREPLY: trab was never committed');
  }
  ok('FORM (Option B, the REAL form writers): a form-changed selection — before the request or BETWEEN its read and commit (save or delete) — ⇒ 409 with the form\'s pick, nothing written; a same-instance resend never sees an uncommitted pair; the re-read pair converges; a content edit of the selected entry is accepted (scope: the selection); a form delete of the selection ⇒ 409 (null) then converges; the no-rev window is covered; A → B → A back to the client\'s view is accepted');

  // ── 3. the happy path: exactly default_address + that entry's last_used_at change; the profile is otherwise byte-equal ──
  {
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use, rl } = harness(db);
    const before = clone(db.get(`user_profiles/${A}`));
    assert.strictEqual(before.default_address, casa, 'premise: Casa is the default (the real writer\'s makeDefault)');
    CLOCK += 1000;
    const r = await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
    assert.strictEqual(r.code, 200, `🔴 use ⇒ 200 (${JSON.stringify(r.body)})`);
    assert.deepStrictEqual(r.body, { ok: true, default_address: trab, default_address_rev: 1 }, '🔴 the response is { ok, default_address, default_address_rev } only');
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), expectUsed(before, trab, CLOCK, 1), '🔴 ONLY default_address, its rev and that entry\'s last_used_at change');
    assert.deepStrictEqual(db.writes, [`user_profiles/${A}`], 'ONE write: the parent transaction');
    assert.strictEqual(r.h['Cache-Control'], 'no-store', 'no-store');
    assert.deepStrictEqual(rl, [{ bucket: 'use_address', key: A }], '🔴 its own rate-limit bucket, keyed by the VERIFIED uid');
    assert.ok(RATE.windowMs > 0 && RATE.max > 0, 'an explicit policy');
    // idempotent re-use of the default: same two fields, a newer last_used_at
    CLOCK += 1000; const mid = clone(db.get(`user_profiles/${A}`));
    assert.strictEqual((await use(`tok-${A}`, { id: trab, expected_rev: 1, expected_default: trab })).code, 200);
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), expectUsed(mid, trab, CLOCK, 2), 'a re-use bumps last_used_at and the rev');
  }
  ok('happy path (a book from the REAL writer): 200 { ok, default_address, default_address_rev }; exactly default_address + its rev + that entry\'s last_used_at change, every other byte kept; one parent-transaction write; own bucket use_address by the verified uid; no-store');

  // ── 4. an unknown id, another member's id, or a malformed stored entry ⇒ 404 not_found, nothing written ──
  {
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const { use } = harness(db);
    const before = clone(db.get(`user_profiles/${A}`));
    for (const id of ['a_' + 'f'.repeat(12)]) {
      const r = await use(`tok-${A}`, { id, expected_rev: 0, expected_default: casa });
      assert.strictEqual(r.code, 404, `🔴 unknown ${id} ⇒ 404`); assert.deepStrictEqual(r.body, { ok: false, reason: 'not_found' });
    }
    const rb = await use(`tok-${B}`, { id: trab, expected_rev: 0, expected_default: null });
    assert.strictEqual(db.get(`user_profiles/${B}`), undefined, '🔴 B (no profile) naming A\'s address id: B\'s profile is never created');
    assert.strictEqual(rb.code, 404, '🔴 B naming A\'s address id ⇒ 404 (B has no such entry)');
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), before, '🔴 nothing written to A');
    for (const bad of [{ label: '' }, { lat: 91 }, { secret: 1 }, { last_used_at: 'x' }]) {
      db.set(`user_profiles/${A}/addresses/${trab}`, { ...before.addresses[trab], ...bad });
      const mal = clone(db.get(`user_profiles/${A}`));
      const r = await use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
      assert.strictEqual(r.code, 404, `🔴 a stored entry off the rules' shape (${JSON.stringify(bad)}) ⇒ 404`);
      assert.deepStrictEqual(db.get(`user_profiles/${A}`), mal, `🔴 ${JSON.stringify(bad)}: never repaired, never selected`);
    }
  }
  ok('an unknown id, another member\'s id (B\'s profile never created) or a stored entry off the rules\' shape ⇒ 404 not_found; nothing written, never repaired');

  // ── 5. the transaction: a COLD null never aborts; a purge during it never resurrects; a sweep claim during it ⇒ 403 ──
  {
    // cold: the SDK's uncached first run sees null while the server holds the profile ⇒ re-run with the real node ⇒ committed
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const before = clone(db.get(`user_profiles/${A}`));
    db.T.cold.add(`user_profiles/${A}`);
    const r = await harness(db).use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
    assert.strictEqual(r.code, 200, `🔴 a COLD first null never aborts (${JSON.stringify(r.body)})`);
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), expectUsed(before, trab, CLOCK, 1), '🔴 cold: committed on the re-run, exactly the three fields');
  }
  {
    // purge: the REAL deletion's update lands between the transaction's read and its commit ⇒ re-run on null ⇒ nothing written
    const db = fakeDb(); const { casa, trab } = await bookOf(db);
    db.T.pause.set(`user_profiles/${A}`, async () => { await db.ref().update(ACCOUNT.accountDeleteUpdates(A, 'ph', 4242)); });
    const r = await harness(db).use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
    assert.strictEqual(db.get(`user_profiles/${A}`), undefined, '🔴 a purged profile is NEVER resurrected');
    assert.strictEqual(r.code, 404, `a purged profile ⇒ 404 (${r.code})`);
  }
  {
    // the sweep's claim (REAL sweepClaim) between the read and the commit ⇒ the fence is observed ⇒ abort ⇒ 403
    const db = fakeDb(); const { casa, trab } = await bookOf(db);
    db.T.pause.set(`user_profiles/${A}`, async () => { assert.strictEqual(await sweepClaim(db.instance(), A, CLOCK, 99), 'claimed', 'premise: the sweep (another instance) claimed mid-transaction'); });
    const mid = clone(db.get(`user_profiles/${A}`));
    const r = await harness(db).use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
    assert.strictEqual(r.code, 403, `🔴 deleting_at observed inside the transaction ⇒ 403 (${r.code})`);
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), { ...mid, deleting_at: 99 }, '🔴 … and the claimed profile keeps its default (only the sweep wrote)');
  }
  ok('the parent transaction: a COLD first null re-runs and commits exactly the three fields; the REAL purge mid-transaction ⇒ nothing resurrected (404); the REAL sweep claim mid-transaction ⇒ abort, 403, the profile untouched');

  // ── 6. 429 and 503 ──
  {
    const db = fakeDb(); const { casa, trab } = await bookOf(db); const before = clone(db.get(`user_profiles/${A}`));
    const r = await harness(db, { limited: true }).use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa });
    assert.strictEqual(r.code, 429, '🔴 limited ⇒ 429'); assert.strictEqual(r.h['Retry-After'], '9', 'Retry-After');
    assert.deepStrictEqual(r.body, { ok: false, reason: 'rate_limited' });
    assert.deepStrictEqual(db.get(`user_profiles/${A}`), before, 'nothing written');
    const boom = await quietly(() => harness(db, { getDatabase: () => { throw new Error('secret detail /path'); } }).use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa }));
    assert.strictEqual(boom.code, 503, '🔴 an unexpected failure ⇒ 503');
    assert.deepStrictEqual(boom.body, { ok: false, reason: 'unavailable', retryable: true }, '🔴 no message or stack leaves');
    const orig = db.ref; db.ref = (p) => (String(p).startsWith('user_profiles/') && !String(p).endsWith('deleting_at') ? { ...orig(p), transaction: async () => { throw new Error('tx'); } } : orig(p));
    const tx = await quietly(() => harness(db).use(`tok-${A}`, { id: trab, expected_rev: 0, expected_default: casa }));
    assert.strictEqual(tx.code, 503, '🔴 a failed transaction ⇒ 503');
  }
  ok('rate-limited ⇒ 429 + Retry-After, nothing written; an unexpected failure (database or transaction) ⇒ 503 { reason: unavailable, retryable } with no message or stack');

  FINISHED = true;
  console.log(`\nmy-address: OK (${n})`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\nmy-address: FAILED — ${(e && e.stack) || e}\n`); process.exit(1); });
