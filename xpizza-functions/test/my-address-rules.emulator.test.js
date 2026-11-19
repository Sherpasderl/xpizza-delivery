/**
 * PLAN-3a-addr r0 S-ADDR-2 (the slot cell) — the node useMyAddress leaves behind is one the REAL database rules accept.
 * Run: npm run test:my-address-rules
 *   the book: written through the member's OWN client context by the frozen form's own saveAddress (xpizza-orders/account.js),
 *   under the rules; the selection: the REAL useMyAddress handler on the Admin (rules-off) database, as in production;
 *   then, as the member: the profile reads back, the server's exact diff re-validates as the member's own update, and the
 *   form's next saveAddress still succeeds on it. Synthetic uid only; no address field is logged.
 * PLAN-3a-addr-rev r1 (+ Codex #163 P2): the server-only default_address_rev is refused to the member's client — a value by $other's
 *   .validate:false, a DELETION (where .validate is skipped) by the parent .write's «rev unchanged» clause; the form's saveAddress still writes a node that carries it; and a selection the form changes UNDER THE RULES makes the
 *   handler's next write on the old pair a 409, while the re-read pair is accepted.
 */
require('./_emulator-required')('database');

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { makeMyAddress } = require('../my-address');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');
const A = 'u_' + 'a'.repeat(24);
const TOK = { [`tok-${A}`]: { uid: A, customer: true } };
const NOW = 1_800_000_000_000;

let n = 0; let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { process.stderr.write('  ✗ my-address-rules: exited without completing (a hang)\n'); process.exitCode = 1; } });

// the frozen form's OWN saveAddress (account.js), bound to a client database for uid (my-address.test.js's lift)
const ACC = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-orders', 'account.js'), 'utf8');
const liftFn = (head) => { const at = ACC.indexOf(head); assert.ok(at > 0, `premise: account.js defines ${head}`); return ACC.slice(at, ACC.indexOf('\n  }\n', at) + 4); };
const formSaveAddress = (db, uid) => new Function('ensureFirebase', 'heal', 'MAX_ADDRESSES', 'window', `${liftFn('function newAddrId()')}\n${liftFn('async function saveAddress(')}\nreturn saveAddress;`)(
  async () => ({ auth: { authStateReady: async () => {}, currentUser: { uid } }, db: null,
    dbMod: { ref: (_d, p) => p, get: async (p) => db.ref(p).get(), update: async (_r, u) => db.ref().update(u) } }), () => {}, 10, { crypto: require('crypto').webcrypto });

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-xpizza-addr', database: { rules: RULES } });
  const ok = async (label, pr) => { try { await assertSucceeds(pr); } catch (e) { throw new Error(`${label} — ${e && e.message}`); } console.log(`  ✓ ${++n} ${label}`); };
  const no = async (label, pr) => { try { await assertFails(pr); } catch (e) { throw new Error(`${label} — ${e && e.message}`); } console.log(`  ✓ ${++n} ${label}`); };
  const admin = async (fn) => { let v; await env.withSecurityRulesDisabled(async (ctx) => { v = await fn(ctx.database()); }); return v; };
  const read = (p) => admin(async (db) => (await db.ref(p).get()).val());
  const member = env.authenticatedContext(A, { customer: true }).database();
  try {
    await admin((db) => db.ref('/').set(null));
    await admin((db) => db.ref(`user_profiles/${A}`).set({ phone: '50499990000', phone_hash: 'ph', created_at: 5, last_login: 6, name: 'Ana' }));

    // ── 1. the book, through the member's own client under the rules ──
    const save = formSaveAddress(member, A);
    const casa = await save({ label: 'Casa', detected: 'Col. Palmira, Tegucigalpa', details: 'Casa azul', lat: 14.09, lng: -87.18, makeDefault: true });
    const trab = await save({ label: 'Trabajo', detected: 'Blvd. Morazán', details: 'Torre 2', lat: 14.1, lng: -87.19 });
    assert.ok(casa.ok && trab.ok, `premise: the form's saveAddress wrote the book under the rules (${JSON.stringify([casa.ok, trab.ok])})`);
    const before = await read(`user_profiles/${A}`);
    assert.strictEqual(before.default_address, casa.addrId, 'premise: Casa is the default');

    // ── 2. the REAL handler selects Trabajo on the Admin database ──
    const use = (body) => admin(async (db) => {
      const h = makeMyAddress({ getDatabase: () => db, getAuth: () => ({ verifyIdToken: async (t) => { if (!TOK[t]) throw new Error('bad token'); return TOK[t]; } }),
        checkRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }), now: () => NOW });
      const headers = { 'x-firebase-id-token': `tok-${A}` };
      const r = { set() { return r; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } };
      await h.useMyAddress({ method: 'POST', query: { context: 'platform' }, body, headers, get: (x) => headers[String(x).toLowerCase()] }, r);
      return r;
    });
    const res = await use({ id: trab.addrId, expected_rev: 0, expected_default: casa.addrId });
    assert.strictEqual(res.code, 200, `premise: useMyAddress answered 200 (got ${res.code} ${res.body && res.body.reason})`);
    const after = await read(`user_profiles/${A}`);

    // ── 3. the rules accept the resulting node, as the member ──
    const got = await member.ref(`user_profiles/${A}`).get().catch((e) => { throw new Error(`the member reads the resulting profile — ${e.message}`); });
    assert.deepStrictEqual(got.val(), after, 'the member reads the resulting profile');
    console.log(`  ✓ ${++n} the member reads the resulting profile (owner read)`);
    // (a whole-node client set can never pass: the write requires phone_hash and the schema has no phone_hash child, so the
    //  member's own path is a multipath update — the shape the form itself writes)
    await ok('the server\'s selection diff (minus its server-only rev) passes every rule as the member\'s own update (default names a book entry)',
      member.ref(`user_profiles/${A}`).update({ default_address: after.default_address, [`addresses/${trab.addrId}/last_used_at`]: after.addresses[trab.addrId].last_used_at }));
    // r1: the rev is SERVER-ONLY — the existing $other:false refuses it to the member's client (no rules change)
    await no('a client write of default_address_rev is DENIED (update)', member.ref(`user_profiles/${A}`).update({ default_address_rev: 99 }));
    await no('a client write of default_address_rev is DENIED (set)', member.ref(`user_profiles/${A}/default_address_rev`).set(99));
    // Codex #163 P2: .validate is skipped on a deletion — the PARENT .write pins the rev (newData === data), so the owner can never
    // DELETE it either (a deleted rev would read as 0 and let an old (A, 0) request overwrite the newer pick)
    await no('a client remove() of default_address_rev is DENIED', member.ref(`user_profiles/${A}/default_address_rev`).remove());
    await no('a client set(null) of default_address_rev is DENIED', member.ref(`user_profiles/${A}/default_address_rev`).set(null));
    await no('a client multipath null of default_address_rev is DENIED', member.ref(`user_profiles/${A}`).update({ default_address_rev: null }));
    await no('a client multipath null of the rev beside a legal field is DENIED', member.ref(`user_profiles/${A}`).update({ default_address_rev: null, name: 'Ana B' }));
    assert.strictEqual(await read(`user_profiles/${A}/default_address_rev`), 1, 'the rev survived every client attempt');
    console.log(`  ✓ ${++n} the rev survived every client attempt`);
    await ok('the resulting entry passes the entry schema on its own', member.ref(`user_profiles/${A}/addresses/${trab.addrId}`).set(after.addresses[trab.addrId]));
    assert.deepStrictEqual(res.body, { ok: true, default_address: trab.addrId, default_address_rev: 1 }, 'the 200 carries the minted rev');
    assert.deepStrictEqual(after, { ...before, default_address: trab.addrId, default_address_rev: 1, addresses: { ...before.addresses, [trab.addrId]: { ...before.addresses[trab.addrId], last_used_at: NOW } } },
      'exactly default_address + its rev + that last_used_at changed');
    console.log(`  ✓ ${++n} the handler's write is exactly the selection`);
    const next = await save({ label: 'Gym', detected: 'Col. Lomas', details: 'Portón 3', lat: 14.11, lng: -87.2 });
    assert.ok(next.ok, `the frozen form's next saveAddress still succeeds on the resulting node (${next.reason})`);
    console.log(`  ✓ ${++n} the frozen form's next saveAddress still succeeds on the resulting node (it carries the rev)`);
    // r1: the form re-picks Casa UNDER THE RULES (the member's own client) — the rev does not move; the handler's write on the old
    // pair (rev 1, Trabajo) is refused with the form's pick; the re-read pair is accepted
    const repick = await save({ addrId: casa.addrId, label: 'Casa', detected: 'Col. Palmira, Tegucigalpa', details: 'Casa azul', lat: 14.09, lng: -87.18, makeDefault: true });
    assert.ok(repick.ok, `premise: the form re-picked Casa under the rules (${repick.reason})`);
    assert.strictEqual(await read(`user_profiles/${A}/default_address_rev`), 1, 'premise: the form leaves the rev');
    const stale = await use({ id: trab.addrId, expected_rev: 1, expected_default: trab.addrId });
    assert.deepStrictEqual([stale.code, stale.body], [409, { ok: false, reason: 'stale_address', default_address: casa.addrId, default_address_rev: 1 }], 'a form-changed selection ⇒ 409 with the form\'s pick');
    console.log(`  ✓ ${++n} a selection the form changed under the rules ⇒ the handler's old-pair write is 409 stale_address`);
    const conv = await use({ id: trab.addrId, expected_rev: 1, expected_default: casa.addrId });
    assert.deepStrictEqual([conv.code, conv.body.default_address_rev], [200, 2], 'the re-read pair converges');
    console.log(`  ✓ ${++n} the re-read pair is accepted (rev 2)`);

    // the checks bite: an off-schema entry, or a default naming no entry, is refused by the same rules
    await no('premise: a default naming no book entry is DENIED', member.ref(`user_profiles/${A}`).update({ default_address: 'a_ffffff' }));
    await no('premise: an entry with an extra key is DENIED (the schema check is not vacuous)', member.ref(`user_profiles/${A}/addresses/${trab.addrId}`).set({ ...after.addresses[trab.addrId], used: true }));

    FINISHED = true;
    console.log(`my-address-rules: ${n}/${n} ok`);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    await env.cleanup();
  }
})();
