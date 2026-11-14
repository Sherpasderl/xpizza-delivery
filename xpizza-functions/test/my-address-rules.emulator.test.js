/**
 * PLAN-3a-addr r0 S-ADDR-2 (the slot cell) — the node useMyAddress leaves behind is one the REAL database rules accept.
 * Run: npm run test:my-address-rules
 *   the book: written through the member's OWN client context by the frozen form's own saveAddress (xpizza-orders/account.js),
 *   under the rules; the selection: the REAL useMyAddress handler on the Admin (rules-off) database, as in production;
 *   then, as the member: the profile reads back, the server's exact diff re-validates as the member's own update, and the
 *   form's next saveAddress still succeeds on it. Synthetic uid only; no address field is logged.
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
    const res = await admin(async (db) => {
      const h = makeMyAddress({ getDatabase: () => db, getAuth: () => ({ verifyIdToken: async (t) => { if (!TOK[t]) throw new Error('bad token'); return TOK[t]; } }),
        checkRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }), now: () => NOW });
      const headers = { 'x-firebase-id-token': `tok-${A}` };
      const r = { set() { return r; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } };
      await h.useMyAddress({ method: 'POST', query: { context: 'platform' }, body: { id: trab.addrId }, headers, get: (x) => headers[String(x).toLowerCase()] }, r);
      return r;
    });
    assert.strictEqual(res.code, 200, `premise: useMyAddress answered 200 (got ${res.code} ${res.body && res.body.reason})`);
    const after = await read(`user_profiles/${A}`);

    // ── 3. the rules accept the resulting node, as the member ──
    const got = await member.ref(`user_profiles/${A}`).get().catch((e) => { throw new Error(`the member reads the resulting profile — ${e.message}`); });
    assert.deepStrictEqual(got.val(), after, 'the member reads the resulting profile');
    console.log(`  ✓ ${++n} the member reads the resulting profile (owner read)`);
    // (a whole-node client set can never pass: the write requires phone_hash and the schema has no phone_hash child, so the
    //  member's own path is a multipath update — the shape the form itself writes)
    await ok('the server\'s exact diff passes every rule as the member\'s own update (default names a book entry)',
      member.ref(`user_profiles/${A}`).update({ default_address: after.default_address, [`addresses/${trab.addrId}/last_used_at`]: after.addresses[trab.addrId].last_used_at }));
    await ok('the resulting entry passes the entry schema on its own', member.ref(`user_profiles/${A}/addresses/${trab.addrId}`).set(after.addresses[trab.addrId]));
    assert.deepStrictEqual(after, { ...before, default_address: trab.addrId, addresses: { ...before.addresses, [trab.addrId]: { ...before.addresses[trab.addrId], last_used_at: NOW } } },
      'exactly default_address + that last_used_at changed');
    console.log(`  ✓ ${++n} the handler's write is exactly the selection`);
    const next = await save({ label: 'Gym', detected: 'Col. Lomas', details: 'Portón 3', lat: 14.11, lng: -87.2 });
    assert.ok(next.ok, `the frozen form's next saveAddress still succeeds on the resulting node (${next.reason})`);
    console.log(`  ✓ ${++n} the frozen form's next saveAddress still succeeds on the resulting node`);

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
