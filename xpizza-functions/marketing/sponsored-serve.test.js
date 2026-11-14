'use strict';
// PLAN-3a-capp-sponsored-read r0 (advisor APPROVED 11-14; Q6, DARK) — the «Patrocinado» read sponsoredOf → { rid } | null, over the
// REAL writers: the Anuncio world (test/_anuncio-world.js: roster, config writer, the REAL ratings pipeline + producer), the
// booking by the REAL anuncioBookCore / anuncioCancelCore, the pause by the REAL portal pause core (setBranchPauseCore). The branch
// identity is onboarding-seeded state (hours open 11:00–22:00 HN; open all day where the rollover needs it).
// Run: node marketing/sponsored-serve.test.js
const assert = require('assert');
const { at, OWNER, OTHER, verifyIdToken, world, rated, produce, req, depsAt, eligible, CFG } = require('../test/_anuncio-world');
const A = require('./anuncio-core');
const AM = require('./anuncio-model');
const OC = require('../portal/ops-core');
const S = require('./sponsored-serve');
const SW = require('./switch-memo');

let n = 0; let FINISHED = false;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ sponsored-serve: exited without completing (a hang)\n'); process.exitCode = 1; } });
const quiet = async (f) => { const w = console.warn; console.warn = () => {}; try { return await f(); } finally { console.warn = w; } };

const BOOK_AT = at('2027-03-03', 12);          // Wed 3 Mar: W2027-03-08 is bookable
const W = 'W2027-03-08', W2 = 'W2027-03-15';
const MON_NOON = at('2027-03-08', 12);         // inside W, inside 11:00–22:00
const book = async (db, tok, rid, week) => { const r = await A.anuncioBookCore(depsAt(db, BOOK_AT), req(tok, { rid, week })); assert.strictEqual(r.status, 200, `premise: ${rid} books ${week} (${JSON.stringify(r.body)})`); return r.body.booking; };
// the read as the directory calls it, with the memo settled (sponsoredOf never awaits: the first call starts the read)
async function served(db, t, memo = new Map(), sw = {}) {   // memo + sw: one instance's decoration memo and switch memo
  const inflight = new Map();
  const d = { rtdb: db, memo, inflight, switchState: sw, now: () => t };
  TRIGGER = S.sponsoredOf(d);   // the response that TRIGGERS the reads (Codex r2), kept for the cells
  await quiet(() => Promise.all([...inflight.values()]));
  return S.sponsoredOf(d);
}
let TRIGGER;
// the portal pause core's deps as production wires them (timestamp = the server time; a fresh op id per write)
let ops = 0;
const pauseDeps = (db, t) => ({ db, verifyIdToken, now: () => t, timestamp: () => t, newOpId: () => `op_sp${String(++ops).padStart(4, '0')}` });
const ALL_DAY = { open: true, start: '00:00', end: '24:00' };
const H24 = { sun: ALL_DAY, mon: ALL_DAY, tue: ALL_DAY, wed: ALL_DAY, thu: ALL_DAY, fri: ALL_DAY, sat: ALL_DAY };

(async () => {
  try {
    // ── 1. booked, eligible, open ⇒ { rid }, nothing else ──
    {
      const db = await world();
      await eligible(db, 'tb_centro');
      await book(db, `t-${OWNER}`, 'tb_centro', W);
      const s = await served(db, MON_NOON);
      assert.deepStrictEqual(s, { rid: 'tb_centro' }, 'the week\'s booked, visible branch is sponsored');
      assert.strictEqual(JSON.stringify(s), '{"rid":"tb_centro"}', 'never a booking id, price, week or name');
      assert.strictEqual(await served(db, at('2027-03-03', 12)), null, 'before its week (the booking is only reserved) ⇒ nothing');
      ok('a booked week, rated and open ⇒ { rid } only (no id / price / name); not before its week');
    }

    // ── 2. OFF: the owner turns the Anuncio off (the REAL config writer) with an active booking ⇒ null ──
    {
      const db = await world();
      await eligible(db, 'tb_centro');
      await book(db, `t-${OWNER}`, 'tb_centro', W);
      assert.deepStrictEqual(await served(db, MON_NOON), { rid: 'tb_centro' }, 'premise: on ⇒ sponsored');
      assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: 1, config: { offers_enabled: false, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 2 })).ok, true, 'premise: the owner turned the Anuncio off');
      assert.strictEqual(await served(db, MON_NOON), null, 'the Anuncio off ⇒ nothing sponsored');
      db.set('platform_config/marketing', 'garbage');
      assert.strictEqual(await served(db, MON_NOON), null, 'a malformed config ⇒ off ⇒ nothing');
      ok('the Anuncio off (or a malformed config) with an active booking ⇒ null');
    }

    // ── 2b. Codex r1 P1-3: a WARM instance (its memo fresh, holding the sponsor) — the Anuncio turned OFF, or the switch read failing,
    //        ⇒ null at the next switch read, whatever the memo holds ──
    for (const how of ['turned off', 'switch read fails']) {
      const db = await world();
      await eligible(db, 'tb_centro');
      await book(db, `t-${OWNER}`, 'tb_centro', W);
      const memo = new Map(); const sw = {};
      assert.deepStrictEqual(await served(db, MON_NOON, memo, sw), { rid: 'tb_centro' }, 'premise: a warm instance sponsors');
      let rdb = db;
      if (how === 'turned off') assert.strictEqual((await CFG.writeMarketingConfig(db, { expected: 1, config: { offers_enabled: false, anuncio_enabled: false, collections_enabled: false, anuncio_price_cents: 45000, thresholds: { rating_min: 4.5, min_ratings: 10 } }, actor: 'cli:op', now: 2 })).ok, true, 'premise: off');
      else rdb = { ...db, ref: (p) => (p === 'platform_config/marketing' ? { once: async () => { throw new Error('config down'); } } : db.ref(p)) };
      const t1 = MON_NOON + SW.SWITCH_TTL_MS;
      const r = await served(rdb, t1, memo, sw);
      assert.strictEqual(TRIGGER, null, `WARM memo, the switch ON read EXPIRED (hard, at SWITCH_TTL) ⇒ the TRIGGERING response is already null (${how})`);
      const m = [...memo.values()][0];
      assert.ok(m.ok && t1 - m.at < S.OK_TTL_MS && m.raw.on === true, 'premise: the memo is still FRESH and still holds «on»');
      assert.strictEqual(r, null, `WARM memo, the Anuncio ${how} ⇒ null at the next switch read`);
    }
    ok('a WARM instance: the Anuncio turned off, or the switch read failing, ⇒ null at the next switch read, whatever the memo holds');

    // ── 3. no booking this week (only next week's) ⇒ null ──
    {
      const db = await world();
      await eligible(db, 'tb_centro');
      await book(db, `t-${OWNER}`, 'tb_centro', W2);
      assert.strictEqual(await served(db, MON_NOON), null, 'no booking this week ⇒ nothing');
      ok('no booking for the current week ⇒ null');
    }

    // ── 4. closed by its hours / paused by the owner / a malformed control ⇒ null (the ONE operational reading) ──
    {
      const db = await world();
      await eligible(db, 'tb_centro');
      await book(db, `t-${OWNER}`, 'tb_centro', W);
      assert.strictEqual(await served(db, at('2027-03-08', 23)), null, 'outside its hours (23:00 HN) ⇒ closed ⇒ nothing');
      assert.strictEqual(await served(db, at('2027-03-08', 10.99)), null, 'before opening ⇒ nothing');
      const memo = new Map();
      assert.deepStrictEqual(await served(db, MON_NOON, memo), { rid: 'tb_centro' }, 'premise: open ⇒ sponsored');
      const p = await OC.setBranchPauseCore(pauseDeps(db, MON_NOON + 1000), req(`t-${OWNER}`, { rid: 'tb_centro', op: 'pause', dur_min: null, reason: 'Cocina llena' }));
      assert.deepStrictEqual([p.status, p.body.control && p.body.control.state], [200, 'paused'], `premise: the owner paused the branch (${JSON.stringify(p.body)})`);
      assert.strictEqual(await served(db, MON_NOON + 2000), null, 'paused ⇒ nothing (a fresh read)');
      const r = await OC.setBranchPauseCore(pauseDeps(db, MON_NOON + 3000), req(`t-${OWNER}`, { rid: 'tb_centro', op: 'resume' }));
      assert.strictEqual(r.status, 200, 'premise: resumed');
      assert.deepStrictEqual(await served(db, MON_NOON + 4000), { rid: 'tb_centro' }, 'resumed ⇒ sponsored again');
      db.set('order_control/tb_centro/current', { paused: 'yes' });   // a corrupt node: no writer produces it
      assert.strictEqual(await served(db, MON_NOON + 5000), null, 'a malformed control ⇒ unknown ⇒ nothing');
      ok('closed by its hours, paused by the owner, or a malformed control ⇒ null; resumed ⇒ sponsored again');
    }

    // ── 5. hidden by rating: the serve and the hidden-day recorder agree ──
    {
      const db = await world();
      await eligible(db, 'tb_centro');
      const b = await book(db, `t-${OWNER}`, 'tb_centro', W);
      await produce(db, 'tb_centro', at('2027-03-10', 4.5));
      assert.deepStrictEqual(await served(db, at('2027-03-10', 12)), { rid: 'tb_centro' }, 'premise: rated ≥ 4.5 ⇒ sponsored');
      await rated(db, 'tb_centro', '2027-03-10', Array(8).fill(1));
      await produce(db, 'tb_centro', at('2027-03-11', 4.5));
      assert.strictEqual(await served(db, at('2027-03-11', 12)), null, 'the public rating fell under 4.5 ⇒ hidden ⇒ nothing');
      assert.deepStrictEqual(db.get(`anuncio_bookings/tb_centro/${b.id}/days/2027-03-10`), { state: 'hidden', reason: 'rating' }, 'the recorder judged the same day hidden (rating): the serve and the recorder agree');
      ok('hidden by rating ⇒ null, and the hidden-day recorder records that day hidden (rating)');
    }

    // ── 6. a cancelled booking whose slot was left behind (the cancel's slot step failed) ⇒ null ──
    {
      const db = await world();
      await eligible(db, 'tb_centro');
      const b = await book(db, `t-${OWNER}`, 'tb_centro', W);
      const slot = db.get(`anuncio_slots/${W}`);
      assert.strictEqual((await A.anuncioCancelCore(depsAt(db, BOOK_AT), req(`t-${OWNER}`, { rid: 'tb_centro', booking_id: b.id }))).status, 200, 'premise: cancelled');
      assert.strictEqual(await served(db, MON_NOON), null, 'cancelled (its slot freed) ⇒ nothing');
      db.set(`anuncio_slots/${W}`, slot);   // the documented leftover: the record cancelled, the slot step failed
      assert.strictEqual(await served(db, MON_NOON), null, 'a slot naming a CANCELLED booking ⇒ nothing');
      ok('a cancelled booking is never sponsored, even with its slot left behind');
    }

    // ── 7. the week rollover at Monday 00:00 HN: never last week's sponsor ──
    {
      const db = await world({ hours: H24 });
      await eligible(db, 'tb_centro'); await eligible(db, 'zt_uno');
      await book(db, `t-${OWNER}`, 'tb_centro', W);
      await book(db, `t-${OTHER}`, 'zt_uno', W2);
      const monStart = AM.weekBounds(W2).start;
      const memo = new Map(); const sw = {};
      assert.deepStrictEqual(await served(db, monStart - 1, memo, sw), { rid: 'tb_centro' }, 'Sun 14 Mar 23:59:59.999 HN ⇒ this week\'s sponsor');
      const d = { rtdb: db, memo, inflight: new Map(), switchState: sw, now: () => monStart };
      assert.strictEqual(S.sponsoredOf(d), null, 'Mon 00:00 HN, 1 ms later: never last week\'s sponsor (the memo is per week)');
      await quiet(() => Promise.all([...d.inflight.values()]));
      assert.deepStrictEqual(S.sponsoredOf(d), { rid: 'zt_uno' }, 'and the new week\'s sponsor once its read lands');
      ok('the rollover at Monday 00:00 HN switches to the new week at once (never last week\'s sponsor)');
    }

    // ── 8. never failing: an outage / a timeout ⇒ null, never a throw ──
    {
      const db = await world();
      for (const [why, read] of [['an outage', async () => { throw new Error('down'); }], ['a timeout', () => new Promise(() => {})], ['a malformed read', async () => 'garbage']]) {
        const d = { rtdb: db, memo: new Map(), inflight: new Map(), switchState: {}, now: () => MON_NOON, read, timeoutMs: 20 };
        assert.strictEqual(S.sponsoredOf(d), null, `${why}: the cold call ⇒ null`);
        await quiet(() => Promise.all([...d.inflight.values()]));
        assert.strictEqual(S.sponsoredOf(d), null, `${why} ⇒ null`);
      }
      const down = { ...db, ref: (p) => (p === 'platform_config/marketing' ? { once: async () => { throw new Error('config down'); } } : db.ref(p)) };
      assert.strictEqual(await served(down, MON_NOON), null, 'a config outage ⇒ null (never a guessed «on»)');
      ok('an outage, a timeout, a malformed read or a config outage ⇒ null; it never throws');
    }

    FINISHED = true;
    console.log(`sponsored-serve: ${n}/${n} ok`);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
  }
})();
