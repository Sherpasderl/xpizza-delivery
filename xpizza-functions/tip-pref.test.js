'use strict';
// PLAN-capp-tip-step r6 §1 — the member's last tip (a UX hint, not money): the pure decision + the newer-only updater +
// the best-effort recorder over a strict RTDB double (read-back of the resolved created_at; a transaction that keeps the
// newer `at`). The endpoint wiring is proven in the emulator (test/s2tip.emulator.test.js §8).
// Run: node tip-pref.test.js
const assert = require('assert');
const TP = require('./tip-pref');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

(async () => {
  // ── 1. prefOf: only a verified member, a delivery, an explicit tip_choice:true, a valid normalized tip ──
  {
    const base = { uid: 'u_ana', body: { tip_choice: true, tip_cents: 2000 }, orderType: 'delivery' };
    assert.deepStrictEqual(TP.prefOf(base), { cents: 2000 }, '🔴 PREF-1: member + delivery + tip_choice ⇒ the tip');
    assert.deepStrictEqual(TP.prefOf({ ...base, body: { tip_choice: true } }), { cents: 0 }, '🔴 PREF-1: «Sin propina» (absent tip_cents) is an explicit 0');
    assert.deepStrictEqual(TP.prefOf({ ...base, body: { tip_choice: true, tip_cents: 0 } }), { cents: 0 }, 'PREF-1: tip_cents 0 ⇒ 0');
    for (const [what, args] of [
      ['a guest (no verified uid)', { ...base, uid: null }],
      ['an empty uid', { ...base, uid: '' }],
      ['pickup', { ...base, orderType: 'pickup' }],
      ['tip_choice absent', { ...base, body: { tip_cents: 2000 } }],
      ['tip_choice "true" (a string)', { ...base, body: { tip_choice: 'true', tip_cents: 2000 } }],
      ['tip_choice 1', { ...base, body: { tip_choice: 1, tip_cents: 2000 } }],
      ['a malformed tip', { ...base, body: { tip_choice: true, tip_cents: '2000' } }],
      ['a tip over the cap', { ...base, body: { tip_choice: true, tip_cents: 200001 } }],
      ['no body', { ...base, body: null }],
    ]) assert.strictEqual(TP.prefOf(args), null, `🔴 PREF-1: ${what} ⇒ no preference`);
    // a body uid is never consulted (Codex: the verified-token uid only)
    assert.deepStrictEqual(TP.prefOf({ ...base, body: { ...base.body, uid: 'u_evil', customer_uid: 'u_evil' } }), { cents: 2000 }, 'PREF-1: body uid fields are ignored (the caller passes the verified uid)');
    ok('prefOf: verified member + delivery + tip_choice === true + a valid tip (absent = 0); guest / pickup / no or non-boolean tip_choice / malformed ⇒ none');
  }

  // ── 2. newer: the stored value is replaced only by a strictly newer `at` ──
  {
    const next = { cents: 4000, at: 2000 };
    assert.deepStrictEqual(TP.newer(null, next), next, 'PREF-2: nothing stored ⇒ write');
    assert.deepStrictEqual(TP.newer({ cents: 2000, at: 1000 }, next), next, 'PREF-2: an older stored value ⇒ replaced');
    assert.strictEqual(TP.newer({ cents: 2000, at: 3000 }, next), undefined, '🔴 PREF-2: a NEWER stored value is never replaced (an old-order retry is a no-op)');
    assert.strictEqual(TP.newer({ cents: 2000, at: 2000 }, next), undefined, 'PREF-2: an equal `at` ⇒ no-op');
    assert.deepStrictEqual(TP.newer({ junk: true }, next), next, 'PREF-2: a malformed stored value is replaced');
    ok('newer: write when nothing / older / malformed is stored; a newer or equal stored `at` is kept (abort)');
  }

  // ── 3. recordLastTip over a strict RTDB double: the resolved created_at, the transaction, best-effort ──
  {
    function rtdb(init = {}, { failRead = false, failTx = false } = {}) {
      const data = JSON.parse(JSON.stringify(init)); const log = [];
      const get = (p) => p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), data);
      const set = (p, v) => { const ks = p.split('/'); let o = data; for (const k of ks.slice(0, -1)) o = o[k] = o[k] || {}; o[ks[ks.length - 1]] = v; };
      return { data, log, ref: (p) => ({
        once: async (ev) => { assert.strictEqual(ev, 'value'); log.push(['read', p]); if (failRead) throw new Error('read failed'); const v = get(p); return { val: () => (v === undefined ? null : v) }; },
        transaction: async (fn) => { log.push(['tx', p]); if (failTx) throw new Error('tx failed'); const cur = get(p); const out = fn(cur === undefined ? null : cur); if (out === undefined) return { committed: false }; set(p, out); return { committed: true }; },
        set: async () => { throw new Error('recordLastTip must not use set (a transaction keeps the newer value)'); },
        update: async () => { throw new Error('recordLastTip must not use update'); },
      }) };
    }
    const req = { uid: 'u_ana', body: { tip_choice: true, tip_cents: 4000 }, orderType: 'delivery', orderId: 'XP-1' };

    const a = rtdb({ orders: { 'XP-1': { created_at: 1762560000000 } } });
    const r1 = await TP.recordLastTip(a, req);
    assert.deepStrictEqual(r1, { written: true }, '🔴 PREF-3: an absent user_private parent is WRITTEN (the R3.4 updater null-normalizes; never a swallowed throw)');
    assert.deepStrictEqual(a.data.user_private.u_ana.last_tip, { cents: 4000, at: 1762560000000 }, '🔴 PREF-3: written at user_private/{uid}/last_tip with the RESOLVED created_at');
    assert.deepStrictEqual(r1, { written: true }, 'PREF-3: reported written');
    assert.deepStrictEqual(a.log.map((x) => x.join(' ')), ['read orders/XP-1/created_at', 'tx user_private/u_ana'], 'PREF-3: exactly one read-back and one transaction — on the PARENT user_private/{uid} (R2.5: fenced against deletion)');

    const b = rtdb({ orders: { 'XP-1': { created_at: 1000 } }, user_private: { u_ana: { last_tip: { cents: 2000, at: 5000 } } } });
    await TP.recordLastTip(b, req);
    assert.deepStrictEqual(b.data.user_private.u_ana.last_tip, { cents: 2000, at: 5000 }, '🔴 PREF-3: an OLDER order (retry) never overwrites a newer choice');

    const c = rtdb({ orders: { 'XP-1': { created_at: { '.sv': 'timestamp' } } } });
    const r3 = await TP.recordLastTip(c, req);
    assert.ok(!c.data.user_private, '🔴 PREF-3: a non-numeric created_at (the ServerValue placeholder) ⇒ nothing written');
    assert.deepStrictEqual(r3, { written: false, reason: 'no_created_at' }, 'PREF-3: reported');

    for (const [what, db] of [['a failed read-back', rtdb({}, { failRead: true })], ['a failed transaction', rtdb({ orders: { 'XP-1': { created_at: 1 } } }, { failTx: true })]]) {
      const r = await TP.recordLastTip(db, req);
      assert.deepStrictEqual([r.written, r.reason], [false, 'error'], `🔴 PREF-3: ${what} is NON-FATAL (resolves, never throws)`);
    }
    const g = rtdb({ orders: { 'XP-1': { created_at: 1 } } });
    assert.deepStrictEqual(await TP.recordLastTip(g, { ...req, uid: null }), { written: false, reason: 'not_eligible' }, 'PREF-3: a guest ⇒ no read, no write');
    assert.deepStrictEqual(g.log, [], 'PREF-3: not eligible ⇒ zero RTDB calls');
    ok('recordLastTip: reads back the resolved numeric created_at, writes {cents, at} by a newer-only transaction; a placeholder / failure / guest ⇒ nothing written and never a throw');
  }

  // ── 4. PLAN-3a-capp-member-reads R2.5 / R3.4 (Codex r1 #4, a pre-existing race): the transaction is on the PARENT user_private/{uid}, so the
  //       deletion's atomic replacement of that node ({ deleted_at }) serializes against it — a late accepted-order write can never resurrect
  //       last_tip under a deleted account. The updater null-normalizes (an absent parent / a cold cache never throws or loses siblings).
  //       The double models production transactions: a COLD first call sees null; a non-undefined result commits ONLY if the server still
  //       equals what the updater saw, else it re-runs with the real node; a pause hook runs just before the commit.
  {
    const SE = require('./signup-endpoints'); const ACCOUNT = require('./account-lib');
    function fake(init = {}) {
      const tree = JSON.parse(JSON.stringify(init)); const T = { cold: new Set(), pause: new Map() };
      const parts = (p) => String(p).split('/').filter(Boolean);
      const get = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
      const set = (p, v) => { const ks = parts(p); let o = tree; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; } if (v == null) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = JSON.parse(JSON.stringify(v)); };
      const snap = (v) => ({ exists: () => v != null, val: () => (v == null ? null : JSON.parse(JSON.stringify(v))), forEach: () => false });
      const q = { equalTo: () => q, limitToFirst: () => q, limitToLast: () => q, startAt: () => q, endAt: () => q, once: async () => snap(null) };
      const ref = (p = '') => ({
        once: async () => snap(get(p)), get: async () => snap(get(p)), set: async (v) => set(p, v), remove: async () => set(p, null),
        update: async (m) => { for (const [k, v] of Object.entries(m)) set(p ? `${p}/${k}` : k, v); }, orderByChild: () => q,
        transaction: async (fn) => {
          let seen = T.cold.has(p) ? null : (get(p) === undefined ? null : JSON.parse(JSON.stringify(get(p)))); T.cold.delete(p);
          for (let i = 0; i < 20; i++) {
            const next = fn(seen === null ? null : JSON.parse(JSON.stringify(seen)));
            if (next === undefined) return { committed: false, snapshot: snap(get(p)) };
            if (T.pause.has(p)) { const f = T.pause.get(p); T.pause.delete(p); await f(); }
            const server = get(p) === undefined ? null : get(p);
            if (JSON.stringify(server) !== JSON.stringify(seen)) { seen = server === null ? null : JSON.parse(JSON.stringify(server)); continue; }
            set(p, next); return { committed: true, snapshot: snap(get(p)) };
          }
          throw new Error('too many retries');
        },
      });
      return { tree, get, ref, T };
    }
    const req = { uid: 'u_ana', body: { tip_choice: true, tip_cents: 4000 }, orderType: 'delivery', orderId: 'XP-1' };
    const quiet = async (f) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await f(); } finally { console.error = e; console.warn = w; } };

    // 4a. the interleaving: the account is deleted between the order's acceptance and the recorder's commit ⇒ { deleted_at } stays EXACTLY that
    const a = fake({ orders: { 'XP-1': { created_at: 1000 } }, user_private: { u_ana: { consent: { x_pizza: { terms: true } } } }, user_profiles: { u_ana: { phone: '1', created_at: 1, last_login: 1 } } });
    a.T.pause.set('user_private/u_ana', async () => { await quiet(() => SE.deleteAccountCore(a, ACCOUNT, { uid: 'u_ana', phoneHash: null, now: 9000, revoke: async () => {} })); });
    const r = await TP.recordLastTip(a, req);
    assert.deepStrictEqual(a.get('user_private/u_ana'), { deleted_at: 9000 }, '🔴 R2.5: a deletion landing mid-write leaves user_private EXACTLY { deleted_at } — last_tip is never resurrected');
    assert.strictEqual(r.written, false, 'reported not written');
    // 4b. already deleted before the recorder runs ⇒ unchanged
    const b = fake({ orders: { 'XP-1': { created_at: 1000 } }, user_private: { u_ana: { deleted_at: 5 } } });
    await TP.recordLastTip(b, req);
    assert.deepStrictEqual(b.get('user_private/u_ana'), { deleted_at: 5 }, '🔴 R2.5: a deleted account is never written');
    // 4c. absent parent ⇒ exactly { last_tip }
    const c = fake({ orders: { 'XP-1': { created_at: 1000 } } });
    assert.deepStrictEqual(await TP.recordLastTip(c, req), { written: true }, '🔴 R3.4: an absent parent is WRITTEN (the updater null-normalizes, never throws)');
    assert.deepStrictEqual(c.get('user_private/u_ana'), { last_tip: { cents: 4000, at: 1000 } }, '🔴 R3.4: an absent parent ⇒ exactly { last_tip }');
    // 4d. cold cache: the first call sees null while the server holds consent ⇒ consent kept, last_tip added
    const d = fake({ orders: { 'XP-1': { created_at: 1000 } }, user_private: { u_ana: { consent: { x_pizza: { terms: true } } } } });
    d.T.cold.add('user_private/u_ana');
    assert.deepStrictEqual(await TP.recordLastTip(d, req), { written: true }, '🔴 R3.4: a cold cache is WRITTEN after the re-run');
    assert.deepStrictEqual(d.get('user_private/u_ana'), { consent: { x_pizza: { terms: true } }, last_tip: { cents: 4000, at: 1000 } }, '🔴 R3.4: a cold cache never loses a sibling (consent kept)');
    // 4e. an older at ⇒ unchanged, siblings untouched
    const e = fake({ orders: { 'XP-1': { created_at: 1000 } }, user_private: { u_ana: { consent: { y: 1 }, last_tip: { cents: 2000, at: 5000 } } } });
    await TP.recordLastTip(e, req);
    assert.deepStrictEqual(e.get('user_private/u_ana'), { consent: { y: 1 }, last_tip: { cents: 2000, at: 5000 } }, 'an older order never replaces a newer choice');
    ok('R2.5 / R3.4: the transaction is on the PARENT user_private/{uid} — a deletion landing mid-write (the real deleteAccountCore) leaves exactly { deleted_at }; a deleted account is never written; an absent parent ⇒ { last_tip }; a cold cache keeps consent; an older at is kept');
  }

  console.log(`\ntip-pref: ${n} passed`);
})().catch((e) => { process.stderr.write(`  ✗ ${(e && e.message) || e}\n`); console.error('tip-pref FAILED:', e); process.exit(1); });
