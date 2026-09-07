'use strict';
// Portal 2b-1 Task 2 — the FRONT DOOR to a money-and-factura-affecting write path.
// Run: node catalog/catalog-edit-auth.test.js
//
// Everything downstream (validate, diff, token, fiscal-ack) assumes the caller had the right to be
// there. This helper is the only thing establishing that, so its failure modes matter more than its
// success case: an auth check that says "yes" when the backend is merely unreachable is not an auth
// check. Every path that is not an affirmative, verified membership must deny.
const assert = require('assert');
const { authorizeCatalogEdit } = require('./catalog-edit-auth');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('catalog-edit-auth: FAILED — exited without completing'); process.exitCode = 1; } });

// ── stubs ──────────────────────────────────────────────────────────────────────────────────────
const reqWith = (auth) => ({ get: (h) => (h.toLowerCase() === 'authorization' ? auth : undefined) });
// RTDB stub that records every path read, so a test can assert what was NOT looked at.
function stubDb(present, { throwOn = null } = {}) {
  const reads = [];
  return {
    reads,
    ref: (path) => ({
      once: async () => {
        reads.push(path);
        if (throwOn && path.includes(throwOn)) throw new Error('rtdb unavailable');
        return { exists: () => present.includes(path) };
      },
    }),
  };
}
const DISPATCHER = 'dispatchers/u_disp';
const STAFF = 'restaurants/la_musa/kitchen_staff/u_staff';
const OWNER = 'restaurants/x_pizza/owners/u_owner';
const verifierFor = (decoded) => async () => decoded;

(async () => {
  // ── (1) THE TWO WAYS IN ──────────────────────────────────────────────────────────────────────
  {
    const r = await authorizeCatalogEdit({ db: stubDb([DISPATCHER]), verifyIdToken: verifierFor({ uid: 'u_disp', email: 'd@x.hn' }) }, reqWith('Bearer tok'), 'x_pizza');
    assert.deepStrictEqual([r.ok, r.uid, r.role], [true, 'u_disp', 'dispatcher'], 'a global dispatcher may edit either brand');
    const r2 = await authorizeCatalogEdit({ db: stubDb([DISPATCHER]), verifyIdToken: verifierFor({ uid: 'u_disp' }) }, reqWith('Bearer tok'), 'la_musa');
    assert.strictEqual(r2.ok, true, 'on both brands');
  }
  {
    const db = stubDb([STAFF]);
    const r = await authorizeCatalogEdit({ db, verifyIdToken: verifierFor({ uid: 'u_staff' }) }, reqWith('Bearer tok'), 'la_musa');
    assert.deepStrictEqual([r.ok, r.uid, r.role], [true, 'u_staff', 'staff'], 'own-restaurant kitchen staff may edit THEIR brand');
    // ...and only theirs. Membership is per-restaurant; the same uid on another brand is a stranger.
    const other = await authorizeCatalogEdit({ db: stubDb([STAFF]), verifyIdToken: verifierFor({ uid: 'u_staff' }) }, reqWith('Bearer tok'), 'x_pizza');
    assert.strictEqual(other.ok, false, 'la_musa staff must NOT be able to edit x_pizza');
    assert.strictEqual(other.status, 403, 'and that is a 403, not a 401');
  }
  ok('the two ways in: a global dispatcher (either brand) and own-restaurant kitchen staff (their brand only)');

  // ── (1b) THE OWNER TIER — a level ABOVE dispatcher, and it must not collapse into one ─────────
  // Only an owner may acknowledge that a menu edit changes the SAR factura. That acknowledgement is
  // worthless if any dispatcher can produce it, so the tiers have to stay genuinely distinct.
  {
    const r = await authorizeCatalogEdit({ db: stubDb([OWNER]), verifyIdToken: verifierFor({ uid: 'u_owner', email: 'o@x.hn' }) }, reqWith('Bearer tok'), 'x_pizza');
    assert.deepStrictEqual([r.ok, r.uid, r.role], [true, 'u_owner', 'owner'], 'an owner of this restaurant is role owner');

    // THE COLLAPSE. A dispatcher who is NOT in the owners node must come back as `dispatcher`. If the
    // owner check ever read the dispatchers node — or fell back to it — every dispatcher would silently
    // gain fiscal authority and the gate would be decorative.
    const d = await authorizeCatalogEdit({ db: stubDb([DISPATCHER]), verifyIdToken: verifierFor({ uid: 'u_disp' }) }, reqWith('Bearer tok'), 'x_pizza');
    assert.deepStrictEqual([d.ok, d.role], [true, 'dispatcher'], 'a dispatcher is NOT promoted to owner');
    const st = await authorizeCatalogEdit({ db: stubDb([STAFF]), verifyIdToken: verifierFor({ uid: 'u_staff' }) }, reqWith('Bearer tok'), 'la_musa');
    assert.strictEqual(st.role, 'staff', 'and kitchen staff are not either');

    // OWNERSHIP IS PER-RESTAURANT: the x_pizza owner is not the la_musa owner. A global tier would let
    // one merchant's owner acknowledge another merchant's fiscal document.
    const cross = await authorizeCatalogEdit({ db: stubDb([OWNER]), verifyIdToken: verifierFor({ uid: 'u_owner' }) }, reqWith('Bearer tok'), 'la_musa');
    assert.notStrictEqual(cross.role, 'owner', 'the x_pizza owner is not an owner of la_musa');

    // OWNER SUPERSEDES: someone who is both reads as owner, so the higher tier is what the fiscal gate sees.
    const both = await authorizeCatalogEdit({ db: stubDb([OWNER, 'dispatchers/u_owner']), verifyIdToken: verifierFor({ uid: 'u_owner' }) }, reqWith('Bearer tok'), 'x_pizza');
    assert.strictEqual(both.role, 'owner', 'owner outranks dispatcher when a uid is both');

    // ...and the owner tier grants edit access on its own, without needing a dispatcher entry too
    assert.strictEqual(r.ok, true, 'an owner who is ONLY an owner can still edit');
    ok('the owner tier is distinct (a dispatcher is never promoted), per-restaurant, and outranks dispatcher');
  }
  {
    // The owner node must be a DIFFERENT path from dispatchers — structurally, so the two can never be
    // wired to the same read by a later edit.
    const src = require('fs').readFileSync(require('path').join(__dirname, 'catalog-edit-auth.js'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
    assert.ok(/restaurants\/\$\{restaurantId\}\/owners\/\$\{decoded\.uid\}/.test(src), 'the owner read must be restaurants/{rid}/owners/{uid}');
    assert.ok(!/owners[^\n]*dispatchers|dispatchers[^\n]*owners/.test(src), 'and must not share a line — or a read — with the dispatchers path');
    // it is checked FIRST, so a uid in both resolves to the higher tier
    const owners = src.indexOf('/owners/');
    const disp = src.indexOf('dispatchers/');
    assert.ok(owners > 0 && disp > 0 && owners < disp, 'the owner check must come FIRST (highest tier wins)');
    ok('structurally: the owner node is its own path, read first — the tiers cannot be collapsed by a later edit');
  }

  // ── (2) THE CUSTOMER CLAIM — rejected BEFORE any membership lookup ───────────────────────────
  {
    const db = stubDb([DISPATCHER, STAFF]);   // deliberately: this uid WOULD pass membership
    const r = await authorizeCatalogEdit({ db, verifyIdToken: verifierFor({ uid: 'u_disp', customer: true }) }, reqWith('Bearer tok'), 'x_pizza');
    assert.strictEqual(r.ok, false, 'a customer-claim token must never reach the edit path');
    assert.strictEqual(r.status, 403, 'as a 403');
    // PLACEMENT: the rejection must come before the reads. A customer token must not even be able to
    // probe whether a given uid is staff — and a check placed after the lookup would have granted
    // access here, since this uid is present in both membership paths.
    assert.deepStrictEqual(db.reads, [], 'and it must be rejected BEFORE any membership read (no probing, no accidental grant)');
  }
  ok('a customer-claim token is rejected before any membership lookup (it cannot probe, and cannot slip through)');

  // ── (3) EVERY NON-AFFIRMATIVE PATH DENIES ────────────────────────────────────────────────────
  {
    const cases = [
      ['no authorization header', { db: stubDb([DISPATCHER]), verifyIdToken: verifierFor({ uid: 'u_disp' }) }, reqWith(undefined), 401],
      ['empty header', { db: stubDb([DISPATCHER]), verifyIdToken: verifierFor({ uid: 'u_disp' }) }, reqWith(''), 401],
      ['bare token, no Bearer prefix', { db: stubDb([DISPATCHER]), verifyIdToken: verifierFor({ uid: 'u_disp' }) }, reqWith('tok'), 401],
      ['Bearer with nothing after it', { db: stubDb([DISPATCHER]), verifyIdToken: verifierFor({ uid: 'u_disp' }) }, reqWith('Bearer   '), 401],
      ['verifyIdToken THROWS', { db: stubDb([DISPATCHER]), verifyIdToken: async () => { throw new Error('expired'); } }, reqWith('Bearer tok'), 401],
      ['verifier returns null', { db: stubDb([DISPATCHER]), verifyIdToken: verifierFor(null) }, reqWith('Bearer tok'), 401],
      ['verified token carries no uid', { db: stubDb([DISPATCHER]), verifyIdToken: verifierFor({ email: 'x@y.hn' }) }, reqWith('Bearer tok'), 401],
      ['a stranger (verified, no membership)', { db: stubDb([]), verifyIdToken: verifierFor({ uid: 'u_nobody' }) }, reqWith('Bearer tok'), 403],
    ];
    for (const [label, deps, req, status] of cases) {
      const r = await authorizeCatalogEdit(deps, req, 'x_pizza');
      assert.strictEqual(r.ok, false, `${label} → denied`);
      assert.strictEqual(r.status, status, `${label} → ${status}`);
      assert.ok(typeof r.error === 'string' && r.error.length, `${label} → a typed error`);
    }
    ok(`all ${cases.length} non-affirmative paths deny with a typed error (no header, bad prefix, throw, null, no uid, stranger)`);
  }

  // ── (4) AN UNREACHABLE BACKEND IS NOT AN AUTHORIZATION ───────────────────────────────────────
  // The dangerous shape: a membership read that throws, swallowed into "not a dispatcher, try staff",
  // then "not staff either" — which is indistinguishable from a real denial but for the wrong reason,
  // and the mirror-image bug (swallowing into a grant) is a total bypass.
  {
    for (const [label, throwOn] of [['the owner read', '/owners/'], ['the dispatcher read', 'dispatchers/'], ['the staff read', 'kitchen_staff']]) {
      const r = await authorizeCatalogEdit({ db: stubDb([STAFF], { throwOn }), verifyIdToken: verifierFor({ uid: 'u_staff' }) }, reqWith('Bearer tok'), 'la_musa');
      // an owner-read failure must NOT quietly degrade the caller to a lower tier either — that would
      // turn an outage into a silent demotion, and a demoted owner cannot publish x_pizza at all
      assert.strictEqual(r.ok, false, `${label} failing must DENY — an unreachable backend is not an authorization`);
      assert.strictEqual(r.status, 503, `${label} → 503, distinct from 403: the credentials may be fine, the lookup is not`);
      assert.ok(/unavailable/.test(r.error), 'and named as an availability failure so an outage is not misread as a permissions bug');
    }
    ok('a membership read that fails DENIES as 503 — distinct from 403, so an outage is not misdiagnosed');
  }

  // ── (5) THE RESTAURANT ID BUILDS AN RTDB PATH, so it must not be able to steer one ────────────
  {
    const hostile = ['x_pizza/../../dispatchers', '../dispatchers', 'x_pizza/kitchen_staff', 'a b', '', '   ', null, undefined, 42, {}, 'X_PIZZA', 'x'.repeat(200)];
    for (const rid of hostile) {
      const db = stubDb([DISPATCHER, STAFF]);
      const r = await authorizeCatalogEdit({ db, verifyIdToken: verifierFor({ uid: 'u_staff' }) }, reqWith('Bearer tok'), rid);
      assert.strictEqual(r.ok, false, `a malformed restaurant id (${JSON.stringify(rid)}) must be refused outright`);
      assert.strictEqual(r.status, 400, 'as a 400 — it is a bad request, not a permissions decision');
      assert.ok(!db.reads.some((p) => p.includes('..')), `and must never reach the database with a traversal path (${JSON.stringify(rid)})`);
    }
    // non-vacuity: a well-formed id is of course accepted
    assert.strictEqual((await authorizeCatalogEdit({ db: stubDb([STAFF]), verifyIdToken: verifierFor({ uid: 'u_staff' }) }, reqWith('Bearer tok'), 'la_musa')).ok, true, 'while a normal id works');
    ok(`all ${hostile.length} malformed restaurant ids are refused before touching the database (the id builds a ref path)`);
  }

  // ── (6) NO SHARED-SECRET BACK DOOR ───────────────────────────────────────────────────────────
  // authorizeDispatcherAction accepts RECON_SECRET as a bearer for server-to-server use. That is NOT
  // copied here on purpose: a static secret that can rewrite live prices and the SAR factura has a far
  // larger blast radius than a reconciliation action, and it authenticates no PERSON — the fiscal-ack
  // in Task 4 is meaningless if a script can hold the credential.
  {
    const before = process.env.RECON_SECRET;
    process.env.RECON_SECRET = 'super-secret-value';
    const r = await authorizeCatalogEdit({ db: stubDb([DISPATCHER]), verifyIdToken: async () => { throw new Error('not a jwt'); } }, reqWith('Bearer super-secret-value'), 'x_pizza');
    assert.strictEqual(r.ok, false, 'the recon secret must NOT authorize a catalog edit');
    if (before === undefined) delete process.env.RECON_SECRET; else process.env.RECON_SECRET = before;
    const src = require('fs').readFileSync(require('path').join(__dirname, 'catalog-edit-auth.js'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
    assert.ok(!/RECON_SECRET|process\.env\./.test(src), 'and no env-var credential path may exist in this helper at all');
    ok('no shared-secret back door: a catalog edit always identifies a PERSON (the fiscal-ack depends on it)');
  }

  console.log(`catalog-edit-auth: OK (${n})`);
  FINISHED = true;
})().catch((e) => { console.error(e); process.exit(1); });
