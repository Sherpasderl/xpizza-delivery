'use strict';
// PLAN 3 — formSignal handler (form-signal.js), unit level: a fake RTDB + a fake clock, no emulator.
// Run: node form-signal.test.js
//   "No write" = no COUNTER write (nothing under form_signals/). Each refusal asserts ITS class:
//     steps 0–2 (size / parse / validation / registry) → ZERO database calls of any kind;
//     step 3 (limiter 503 / 429) and a step-4 write failure → limiter bookkeeping only.
const assert = require('assert');
const FS = require('./form-signal');
const { createRestaurantRegistry } = require('./catalog/restaurant-registry');
const { rateLimitKey } = require('./order-dedup');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const HN = 6 * 3600 * 1000;
const T0 = Date.UTC(2026, 9, 26, 18, 0, 0);                    // 2026-10-26 12:00 Honduras
const SV = { increment: (k) => ({ __inc: k }) };

// ── a fake RTDB: every call recorded; transactions + multi-path updates applied to an in-memory tree ──
function fakeDb({ failTx = false, failUpdate = false } = {}) {
  const store = {}; const calls = [];
  const get = (p) => store[p];
  return {
    store, calls,
    ref(path = '') {
      calls.push({ op: 'ref', path });
      return {
        async transaction(fn) {
          calls.push({ op: 'transaction', path });
          if (failTx) throw new Error('tx down');
          const next = fn(get(path) === undefined ? null : JSON.parse(JSON.stringify(get(path))));
          if (next === undefined) return { committed: false, snapshot: { val: () => get(path) } };
          store[path] = next;
          return { committed: true, snapshot: { val: () => next } };
        },
        async update(obj) {
          calls.push({ op: 'update', path, obj });
          if (failUpdate) { const e = new Error('write down'); e.code = 'unavailable'; throw e; }
          for (const [k, v] of Object.entries(obj)) store[k] = (v && v.__inc) ? (store[k] || 0) + v.__inc : v;
        },
      };
    },
  };
}
const counterKeys = (db) => Object.keys(db.store).filter((k) => k.startsWith('form_signals/'));
const limiterKeys = (db) => Object.keys(db.store).filter((k) => k.startsWith('form_signal_limits/'));
const registryOf = (ids) => ({ ready: async () => {}, known: () => new Set(ids) });
const REG = registryOf(['x_pizza', 'la_musa', 'synthetic_3']);

function res() {
  const r = { statusCode: 0, headers: {}, body: undefined, ended: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.json = (b) => { r.body = b; r.ended = true; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}
const body = (o = {}) => JSON.stringify({ rid: 'la_musa', event: 'send', reasons: ['repriced'], ...o });
const req = (b, { method = 'POST', ct = 'text/plain;charset=UTF-8', xff = '203.0.113.9', rawBody } = {}) => ({
  method, body: b, rawBody, headers: { 'content-type': ct, ...(xff ? { 'x-forwarded-for': xff } : {}) },
});
async function call(r, { db = fakeDb(), registry = REG, now = () => T0 } = {}) {
  const out = res();
  await FS.handleSignal(r, out, { db, ServerValue: SV, registry, now });
  return { out, db };
}

(async () => {
  // ── 1. a valid signal: ONE update call, exactly the expected paths ──
  {
    const { out, db } = await call(req(body({ reasons: ['repriced', 'unavailable'] })));
    assert.strictEqual(out.statusCode, 204); assert.strictEqual(out.body, undefined, 'the body is empty');
    const ups = db.calls.filter((c) => c.op === 'update');
    assert.strictEqual(ups.length, 1, 'ONE update call');
    assert.deepStrictEqual(Object.keys(ups[0].obj).sort(), ['form_signals/2026-10-26/la_musa/send/_count', 'form_signals/2026-10-26/la_musa/send/repriced', 'form_signals/2026-10-26/la_musa/send/unavailable']);
    assert.ok(Object.values(ups[0].obj).every((v) => v.__inc === 1), 'every path is increment(1)');
    ok('valid: 204, empty body, ONE multi-path update — _count + one increment per reason, under the server HN day');
  }
  // ── 2. duplicates collapse ──
  {
    const { db } = await call(req(body({ reasons: ['repriced', 'repriced', 'option', 'repriced'] })));
    assert.deepStrictEqual(db.store, { ...db.store, 'form_signals/2026-10-26/la_musa/send/_count': 1, 'form_signals/2026-10-26/la_musa/send/repriced': 1, 'form_signals/2026-10-26/la_musa/send/option': 1 });
    assert.strictEqual(counterKeys(db).length, 3);
    // the write's object keys would collapse duplicates on their own — the validated signal itself is deduped too
    assert.deepStrictEqual(FS.validateStructure({ rid: 'la_musa', event: 'send', reasons: ['repriced', 'repriced', 'option', 'repriced'] }).signal.reasons, ['repriced', 'option']);
    ok('duplicate reasons count once each for the refusal (two repriced lines = one "repriced"); the validated signal is deduped');
  }
  // ── 3. steps 0–2: every refusal → 204 (or 405/413) and ZERO database calls ──
  {
    const cases = [
      ['unknown key', req(JSON.stringify({ rid: 'la_musa', event: 'send', reasons: ['empty'], x: 1 }))],
      ['missing key', req(JSON.stringify({ rid: 'la_musa', event: 'send' }))],
      ['unknown event', req(body({ event: 'paid' }))],
      ['unknown reason', req(body({ reasons: ['bogus'] }))],
      ['MIXED valid + invalid reasons (all or nothing)', req(body({ reasons: ['repriced', 'bogus'] }))],
      ['a reason that is not a string', req(body({ reasons: ['repriced', 7] }))],
      ['reasons not an array', req(body({ reasons: 'repriced' }))],
      ['0 reasons', req(body({ reasons: [] }))],
      ['9 reasons', req(body({ reasons: Array(9).fill('repriced') }))],
      ['blank rid', req(body({ rid: '' }))],
      ['array rid', req(body({ rid: ['la_musa'] }))],
      ['ill-formed rid (uppercase)', req(body({ rid: 'La_Musa' }))],
      ['1-character rid', req(body({ rid: 'a' }))],
      ['41-character rid', req(body({ rid: 'r' + 'x'.repeat(40) }))],
      ['unregistered rid', req(body({ rid: 'ghost_4' }))],
      ['malformed JSON', req('{"rid":')],
      ['a JSON array body', req(JSON.stringify([{ rid: 'la_musa' }]))],
      ['application/json (not the beacon shape)', req(body(), { ct: 'application/json' })],
      ['no content type', req(body(), { ct: '' })],
    ];
    for (const [label, r] of cases) {
      const { out, db } = await call(r);
      assert.strictEqual(out.statusCode, 204, label); assert.strictEqual(out.body, undefined, `${label}: empty body`);
      assert.strictEqual(db.calls.length, 0, `🔴 ${label}: a database call`);
    }
    const g = await call(req(body(), { method: 'GET' }));
    assert.strictEqual(g.out.statusCode, 405); assert.strictEqual(g.db.calls.length, 0, 'GET: no database call');
    ok(`steps 0–2: ${cases.length} refusals (incl. mixed reasons, 0/9 reasons, rid 1/41 chars, unregistered, non-beacon content type) + a GET → no database call of ANY kind`);
  }
  // ── 4. exact boundaries ──
  {
    const pad = (s, bytes) => s.slice(0, -1) + ' '.repeat(bytes - Buffer.byteLength(s)) + '}';
    const b512 = pad(body(), 512), b513 = pad(body(), 513);
    assert.strictEqual(Buffer.byteLength(b512), 512);
    let r = await call(req(b512));
    assert.strictEqual(r.out.statusCode, 204); assert.strictEqual(counterKeys(r.db).length, 2, 'a valid 512-byte body is COUNTED');
    r = await call(req(b513));
    assert.strictEqual(r.out.statusCode, 413); assert.strictEqual(r.db.calls.length, 0, '513 bytes → 413, no call');
    // rawBody wins over the parsed body when the wrapper kept it
    r = await call(req(body(), { rawBody: Buffer.from(b513) }));
    assert.strictEqual(r.out.statusCode, 413, 'the size is the RAW bytes (rawBody), not the parsed body');
    // a multi-byte character counts as its bytes: 511 characters / 512 bytes passes the size gate, 512 / 513 does not
    const mb = (chars) => 'é' + 'x'.repeat(chars - 1);
    assert.strictEqual(Buffer.byteLength(mb(511)), 512);
    r = await call(req(mb(511))); assert.strictEqual(r.out.statusCode, 204, '512 bytes with a 2-byte char → past the size gate');
    r = await call(req(mb(512))); assert.strictEqual(r.out.statusCode, 413, '512 chars = 513 bytes → 413');
    r = await call(req(body({ reasons: ['repriced', 'repriced', 'option', 'option', 'empty', 'choice', 'removed', 'renamed'] })));
    assert.strictEqual(r.out.statusCode, 204); assert.strictEqual(counterKeys(r.db).length, 7, '8 reasons (with duplicates) accepted → 6 unique + _count');
    const reg = registryOf(['ab', 'r' + 'x'.repeat(39)]);
    for (const rid of ['ab', 'r' + 'x'.repeat(39)]) {
      r = await call(req(body({ rid })), { registry: reg });
      assert.strictEqual(counterKeys(r.db).length, 2, `rid of ${rid.length} chars accepted`);
    }
    const biggest = JSON.stringify({ rid: 'r' + 'x'.repeat(39), event: 'restore', reasons: [...FS.REASONS] });
    assert.ok(Buffer.byteLength(biggest) < 160, `the largest valid body is ${Buffer.byteLength(biggest)} B — the 512 cap never refuses a real signal`);
    ok('boundaries: 512 B counted / 513 B → 413 (rawBody measured; a multi-byte char counts its bytes); 8 reasons accepted; rid 2 and 40 chars accepted');
  }
  // ── 5. text/plain with a charset parameter, and an already-parsed object body ──
  {
    let r = await call(req(body(), { ct: 'TEXT/PLAIN; charset=utf-8' }));
    assert.strictEqual(counterKeys(r.db).length, 2, 'text/plain with a charset (any case) accepted');
    r = await call(req(JSON.parse(body())));
    assert.strictEqual(counterKeys(r.db).length, 2, 'an already-parsed object body takes the same path');
    r = await call(req(Buffer.from(body())));
    assert.strictEqual(counterKeys(r.db).length, 2, 'a raw Buffer body takes the same path');
    ok('parse: text/plain + charset accepted; string, object and Buffer bodies decide identically');
  }
  // ── 6. the limiter: fail-CLOSED, 429, the rightmost XFF ──
  {
    let r = await call(req(body()), { db: fakeDb({ failTx: true }) });
    assert.strictEqual(r.out.statusCode, 503); assert.deepStrictEqual(r.out.body, { dropped: true });
    assert.strictEqual(r.db.calls.filter((c) => c.op === 'update').length, 0, '🔴 limiter failed → no counter write');
    r = await call(req(body(), { xff: '' }));
    assert.strictEqual(r.out.statusCode, 503, 'no XFF → no key → dropped (never req.ip)');
    assert.strictEqual(counterKeys(r.db).length, 0);
    const db = fakeDb();
    for (let i = 0; i < FS.SIGNAL_LIMIT.max; i += 1) assert.strictEqual((await call(req(body(), { xff: `10.0.0.${i}, 198.51.100.7` }), { db })).out.statusCode, 204);
    const before = JSON.stringify(counterKeys(db).map((k) => [k, db.store[k]]));
    r = await call(req(body(), { xff: '6.6.6.6, 198.51.100.7' }), { db });
    assert.strictEqual(r.out.statusCode, 429); assert.ok(Number(r.out.headers['Retry-After']) >= 1);
    assert.strictEqual(JSON.stringify(counterKeys(db).map((k) => [k, db.store[k]])), before, '429 → no counter write');
    assert.deepStrictEqual(limiterKeys(db), [`form_signal_limits/${rateLimitKey('198.51.100.7')}`], 'ONE key: the rightmost hop; every forged leftmost entry mapped to it');
    assert.strictEqual(db.store[`form_signal_limits/${rateLimitKey('198.51.100.7')}`].count, FS.SIGNAL_LIMIT.max, 'limiter bookkeeping is present (allowed by "no write")');
    assert.strictEqual(FS.ipKeyOf({ headers: { 'x-forwarded-for': ' 1.1.1.1 ,  2.2.2.2 ' } }), '2.2.2.2');
    ok(`limiter: failed → 503 {dropped:true}, no counter write; no XFF → dropped; ${FS.SIGNAL_LIMIT.max}/10 min then 429 with no counter write; forged leftmost XFF entries share the rightmost hop's key`);
  }
  // ── 7. the registry decides membership; a COLD registry is awaited (r3 #3) ──
  {
    let r = await call(req(body({ rid: 'synthetic_3' })), { registry: registryOf(['x_pizza', 'la_musa', 'synthetic_3']) });
    assert.strictEqual(counterKeys(r.db).length, 2, 'a synthetic third rid present in the registry is counted');
    r = await call(req(body({ rid: 'synthetic_3' })), { registry: registryOf(['x_pizza', 'la_musa']) });
    assert.strictEqual(r.db.calls.length, 0, '…and the same rid absent from it is refused');
    let release;
    const cold = createRestaurantRegistry({ listIds: () => new Promise((resolve) => { release = () => resolve(['x_pizza', 'la_musa', 'synthetic_3']); }) });
    assert.ok(!cold.known().has('synthetic_3'), 'premise: a cold registry\'s known() is the compiled floor only');
    const pending = call(req(body({ rid: 'synthetic_3' })), { registry: cold });
    await new Promise((s) => setImmediate(s)); release();
    r = await pending;
    assert.strictEqual(counterKeys(r.db).length, 2, '🔴 the FIRST request on a cold instance is counted: ready() was awaited, the floor did not decide');
    const down = createRestaurantRegistry({ listIds: async () => { throw new Error('firestore down'); } });
    r = await call(req(body({ rid: 'x_pizza' })), { registry: down });
    assert.strictEqual(counterKeys(r.db).length, 2, 'a registry that cannot read still knows its floor (x_pizza counted)');
    r = await call(req(body({ rid: 'synthetic_3' })), { registry: down });
    assert.strictEqual(r.db.calls.length, 0, '…and never counts an unverified rid');
    r = await call(req(body()), { registry: { ready: async () => { throw new Error('boom'); }, known: () => new Set(['la_musa']) } });
    assert.strictEqual(r.db.calls.length, 0, 'ready() rejecting → dropped, never decided by known() alone');
    let readyCalls = 0;
    const spy = { ready: async () => { readyCalls += 1; }, known: () => new Set(['la_musa', 'La_Musa', 'r' + 'x'.repeat(40)]) };
    for (const rid of ['La_Musa', 'r' + 'x'.repeat(40), '']) await call(req(body({ rid })), { registry: spy });
    assert.strictEqual(readyCalls, 0, '🔴 an ill-formed rid reached the registry: the structural check must run FIRST (and refuse even a rid the registry would list)');
    await call(req(body()), { registry: spy });
    assert.strictEqual(readyCalls, 1, 'premise: a well-formed rid does consult it');
    r = await call(req(body()), { registry: null });
    assert.strictEqual(r.db.calls.length, 0, 'no registry → dropped');
    ok('registry: structural rid check FIRST (an ill-formed rid never reaches it); present counted / absent refused; a COLD registry is awaited (first request counted); read failure keeps the floor; ready() rejecting or no registry → dropped');
  }
  // ── 8. midnight rollover: D is the server's Honduras day at write time ──
  {
    const db = fakeDb();
    const lastMs = Date.UTC(2026, 9, 27, 5, 59, 59, 999);          // 2026-10-26 23:59:59.999 Honduras
    await call(req(body()), { db, now: () => lastMs });
    await call(req(body()), { db, now: () => lastMs + 1 });
    assert.strictEqual(db.store['form_signals/2026-10-26/la_musa/send/_count'], 1);
    assert.strictEqual(db.store['form_signals/2026-10-27/la_musa/send/_count'], 1);
    assert.strictEqual(new Date(lastMs - HN).toISOString(), '2026-10-26T23:59:59.999Z', 'premise: the HN wall clock');
    ok('midnight rollover: 23:59:59.999 and 00:00:00.000 Honduras land under two D keys, _count 1 each');
  }
  // ── 9. a write failure: 204, one log line, limiter-only ──
  {
    const logs = []; const orig = console.error; console.error = (...a) => logs.push(a);
    let r;
    try { r = await call(req(body()), { db: fakeDb({ failUpdate: true }) }); } finally { console.error = orig; }
    assert.strictEqual(r.out.statusCode, 204); assert.strictEqual(r.out.body, undefined);
    assert.deepStrictEqual(logs, [['form_signal_write_failed', 'unavailable']], 'exactly one log line, the error CODE, no input echoed');
    assert.strictEqual(counterKeys(r.db).length, 0, 'no counter write');
    assert.strictEqual(limiterKeys(r.db).length, 1, 'the limiter window was consumed (bookkeeping only)');
    ok('write failure: 204 with an empty body, one form_signal_write_failed log (code only), no counter, limiter bookkeeping present');
  }
  console.log(`\nform-signal: OK (${n})`);
})().catch((e) => { console.error('form-signal: FAILED', e); process.exit(1); });
