'use strict';
// Portal 2b-2a Task 2 — getMyRestaurants. Run: node catalog/portal-reads.test.js
//
// This is the portal's front door: it answers "which restaurants am I allowed to see?", and every later
// call is scoped by its answer. Three properties carry it.
//
//   THE ANSWER COMES FROM THE TOKEN. The uid is whatever the verified ID token says and nothing else.
//   If a request could name its own uid, one merchant could enumerate another's holdings.
//
//   AN OUTAGE IS NOT AN EMPTY LIST. "You own nothing" and "the lookup is down" look identical to a
//   merchant staring at an empty portal — one is a fact, the other is a lie that makes them think their
//   restaurants were taken away. Any read failure is a 503, and never a partial list either: a list
//   missing one restaurant is a confident, wrong answer about what someone owns.
//
//   A CUSTOMER IS NOT A MERCHANT. Rejected before any read, so a customer token cannot probe the index.
const assert = require('assert');
const { getMyRestaurantsCore } = require('./portal-reads');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('portal-reads: FAILED — exited without completing'); process.exitCode = 1; } });

// An RTDB stub that records every path read, so a test can assert what was NOT looked at.
function mkDb(map, { throwOn = null } = {}) {
  const reads = [];
  return {
    reads,
    ref: (p) => ({
      get: async () => {
        reads.push(p);
        if (throwOn && p.includes(throwOn)) throw new Error('rtdb down');
        return { val: () => (Object.prototype.hasOwnProperty.call(map, p) ? map[p] : null) };
      },
    }),
  };
}
const req = (over = {}) => ({ method: 'GET', get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer tok' : undefined), ...over });
const asUid = (uid, extra = {}) => async () => ({ uid, ...extra });

// Brand-agnostic throughout: nothing here knows our restaurants exist.
const TWO = {
  'owner_restaurants/uidOwner001': { merch_b: true, merch_a: true },
  'restaurants/merch_a/identity/name': 'Merchant A',
  'restaurants/merch_b/identity/name': 'Merchant B',
};

(async () => {
  // ── (1) THE HAPPY PATH ───────────────────────────────────────────────────────────────────────
  {
    const db = mkDb(TWO);
    const r = await getMyRestaurantsCore({ db, verifyIdToken: asUid('uidOwner001') }, req());
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepStrictEqual(r.body.restaurants, [
      { rid: 'merch_a', name: 'Merchant A' },
      { rid: 'merch_b', name: 'Merchant B' },
    ], 'both owned restaurants, with display names, SORTED by rid (the switcher must not reorder itself between loads)');
    // least privilege: only the name field is read, not the whole identity node (which carries the
    // hub coordinates, phone and WhatsApp instance the portal has no business holding)
    assert.ok(db.reads.every((p) => !/identity$/.test(p)), 'reads identity/name, never the whole identity node');
    ok('an owner gets exactly their restaurants, named and sorted, reading only the name field');
  }
  {
    // A third merchant that did not exist when this was written works unchanged — no code knows it.
    const db = mkDb({ 'owner_restaurants/uidThird0001': { any_merchant_3: true }, 'restaurants/any_merchant_3/identity/name': 'Pupusería Lupe' });
    const r = await getMyRestaurantsCore({ db, verifyIdToken: asUid('uidThird0001') }, req());
    assert.deepStrictEqual(r.body.restaurants, [{ rid: 'any_merchant_3', name: 'Pupusería Lupe' }], 'a config-only third merchant resolves identically');
    ok('brand-agnostic: a merchant that did not exist when this was written needs no code change');
  }
  {
    // A restaurant with no name yet is still THEIRS — it must appear, labelled by its id. Falling back
    // is right; dropping it would hide a restaurant from the person who owns it.
    const db = mkDb({ 'owner_restaurants/uidOwner001': { merch_a: true, merch_b: true, merch_c: true },
      'restaurants/merch_a/identity/name': '', 'restaurants/merch_b/identity/name': '   ', 'restaurants/merch_c/identity/name': { not: 'a string' } });
    const r = await getMyRestaurantsCore({ db, verifyIdToken: asUid('uidOwner001') }, req());
    assert.deepStrictEqual(r.body.restaurants.map((x) => x.name), ['merch_a', 'merch_b', 'merch_c'],
      'a blank, whitespace or non-string name falls back to the rid — never a blank row, never a dropped restaurant');
    ok('an unnamed restaurant still appears, labelled by its id (a missing name is not a missing restaurant)');
  }
  {
    // Owning nothing is a valid answer, not an error. A dispatcher with no grants sees an empty portal —
    // the portal is for merchants, and internal staff are not merchants by default.
    const r = await getMyRestaurantsCore({ db: mkDb({}), verifyIdToken: asUid('uidNobody001') }, req());
    assert.strictEqual(r.status, 200, 'owning nothing is a 200');
    assert.deepStrictEqual(r.body.restaurants, [], 'with an empty list');
    ok('owning nothing is an empty list with a 200 — not an error, and not a special case');
  }

  // ── (2) THE UID COMES FROM THE TOKEN, FULL STOP ──────────────────────────────────────────────
  {
    // Everything a caller can control is offered here at once. If any of it reached the lookup, one
    // merchant could enumerate another's holdings.
    const db = mkDb(TWO);
    const r = await getMyRestaurantsCore({ db, verifyIdToken: asUid('uidNobody001') },
      req({ query: { uid: 'uidOwner001' }, body: { uid: 'uidOwner001' }, params: { uid: 'uidOwner001' } }));
    assert.deepStrictEqual(r.body.restaurants, [], 'a caller-supplied uid must be ignored entirely');
    assert.ok(db.reads.every((p) => !p.includes('uidOwner001')), 'and must never reach a read path');
    ok('the uid comes only from the verified token — a caller-supplied uid is ignored and never read');
  }

  // ── (3) WHO IS TURNED AWAY ───────────────────────────────────────────────────────────────────
  {
    const cases = [
      ['no authorization header', asUid('u'), req({ get: () => undefined }), 401],
      ['a bare token without Bearer', asUid('u'), req({ get: () => 'tok' }), 401],
      ['a token that does not verify', async () => { throw new Error('expired'); }, req(), 401],
      ['a verifier returning null', async () => null, req(), 401],
      ['a verified token with no uid', async () => ({ email: 'a@b.hn' }), req(), 401],
      ['a non-GET method', asUid('uidOwner001'), req({ method: 'POST' }), 405],
    ];
    for (const [label, verify, rq, status] of cases) {
      const db = mkDb(TWO);
      const r = await getMyRestaurantsCore({ db, verifyIdToken: verify }, rq);
      assert.strictEqual(r.status, status, `${label} → ${status}`);
      assert.ok(r.body.error, `${label} → a typed error`);
      assert.deepStrictEqual(db.reads, [], `${label} → and nothing is read`);
    }
    ok(`all ${cases.length} unauthenticated / malformed cases are refused before any read`);
  }
  {
    // The customer claim, rejected BEFORE the lookup — with a uid that WOULD have resolved, so a check
    // placed after the read would have answered with someone's restaurant list.
    const db = mkDb(TWO);
    const r = await getMyRestaurantsCore({ db, verifyIdToken: asUid('uidOwner001', { customer: true }) }, req());
    assert.strictEqual(r.status, 403, 'a customer token is a 403');
    assert.deepStrictEqual(db.reads, [], 'and is rejected BEFORE any read — it cannot probe the index');
    assert.ok(!JSON.stringify(r.body).includes('merch_'), 'and learns nothing about what that uid owns');
    ok('a customer-claim token is refused before the lookup, using a uid that WOULD have resolved');
  }

  // ── (4) AN OUTAGE IS A 503 — never a 403, never a partial list ───────────────────────────────
  {
    // The reverse index is down.
    const r = await getMyRestaurantsCore({ db: mkDb(TWO, { throwOn: 'owner_restaurants' }), verifyIdToken: asUid('uidOwner001') }, req());
    assert.strictEqual(r.status, 503, 'a reverse-index outage is a 503');
    assert.strictEqual(r.body.error, 'read_unavailable', 'typed');
    assert.ok(r.body.retryable, 'and marked retryable — the caller should try again, not re-authenticate');

    // ONE restaurant's name read is down. The tempting answer is to return the other one; that is a
    // confident, WRONG statement about what this person owns. All or nothing.
    const partial = await getMyRestaurantsCore({ db: mkDb(TWO, { throwOn: 'merch_b' }), verifyIdToken: asUid('uidOwner001') }, req());
    assert.strictEqual(partial.status, 503, 'a single failed name read fails the whole request');
    assert.ok(!JSON.stringify(partial.body).includes('merch_a'), 'and returns NO partial list — a short list is a lie about what you own');
    ok('any read outage is a 503 (retryable), and a partial list is never returned');
  }
  {
    // 403 is a statement about the caller; 503 is a statement about us. Confusing them sends a merchant
    // to re-authenticate over an outage, or makes a real permissions problem look transient.
    const outage = await getMyRestaurantsCore({ db: mkDb(TWO, { throwOn: 'owner_restaurants' }), verifyIdToken: asUid('uidOwner001') }, req());
    const forbidden = await getMyRestaurantsCore({ db: mkDb(TWO), verifyIdToken: asUid('uidOwner001', { customer: true }) }, req());
    assert.notStrictEqual(outage.status, forbidden.status, 'an outage and a refusal must not share a status code');
    assert.strictEqual(outage.status, 503, 'outage → 503');
    assert.strictEqual(forbidden.status, 403, 'refusal → 403');
    ok('an outage (503) and a refusal (403) are distinguishable — never the same code');
  }

  // ── (5) THE WRAPPER. index.js cannot be imported here, so its wiring is asserted structurally. ─
  {
    const CODE = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
    assert.ok(/\{[^}]*\bgetMyRestaurantsCore\b[^}]*\}\s*=\s*require\('\.\/catalog\/portal-reads'\)/.test(CODE),
      'index.js must import the core — a missing require is a runtime ReferenceError node --check cannot see');
    assert.ok(/exports\.getMyRestaurants = onRequest\(/.test(CODE), 'and export the handler, or nothing can call it');
    assert.ok(/await getMyRestaurantsCore\(\{/.test(CODE), 'and delegate to the TESTED core');
    // SCOPED TO THIS HANDLER'S OWN BLOCK. A file-wide search finds `db: getDatabase()` in the
    // publishEdited wrapper too, so the check passed against a getMyRestaurants wired to Firestore —
    // which would find nothing and show every merchant an empty portal, indistinguishable from
    // "you own no restaurants". The mutation survived on exactly that.
    const block = CODE.slice(CODE.indexOf('exports.getMyRestaurants = onRequest('));
    assert.ok(block.length > 100, 'non-vacuity: the wrapper block was found');
    assert.ok(/db: getDatabase\(\)/.test(block), 'wired to getDatabase() — the ownership index is in RTDB, not Firestore');
    assert.ok(!/getFirestore\(\)/.test(block), 'and NOT to Firestore, where the index does not exist');
    assert.ok(/verifyIdToken: \(t\) => getAuth\(\)\.verifyIdToken\(t\)/.test(block), 'and to the REAL id-token verifier, not a stub');
    ok('the index.js wrapper is exported, delegates to the tested core, and is wired to RTDB + the real verifier');
  }

  console.log(`portal-reads: OK (${n})`);
  FINISHED = true;
})().catch((e) => { console.error(e); process.exit(1); });
