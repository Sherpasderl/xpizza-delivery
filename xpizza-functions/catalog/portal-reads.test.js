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
    // BOUNDED to this handler. An unbounded slice runs to end-of-file and swallows every handler added
    // later — which is how "getFirestore() is absent" broke the moment the next endpoint (which legitimately
    // uses it) was appended. A block assertion needs an end as much as a start.
    const blockOf = (name) => {
      const start = CODE.indexOf(`exports.${name} = onRequest(`);
      assert.ok(start > -1, `the ${name} wrapper must exist`);
      const next = CODE.indexOf('\nexports.', start + 1);
      return CODE.slice(start, next === -1 ? CODE.length : next);
    };
    const block = blockOf('getMyRestaurants');
    assert.ok(block.length > 100, 'non-vacuity: the block was found');
    assert.ok(!block.includes('exports.getEditableCatalog'), 'and is bounded — it must not swallow the next handler');
    assert.ok(/db: getDatabase\(\)/.test(block), 'wired to getDatabase() — the ownership index is in RTDB, not Firestore');
    assert.ok(!/getFirestore\(\)/.test(block), 'and NOT to Firestore, where the index does not exist');
    assert.ok(/verifyIdToken: \(t\) => getAuth\(\)\.verifyIdToken\(t\)/.test(block), 'and to the REAL id-token verifier, not a stub');
    ok('the index.js wrapper is exported, delegates to the tested core, and is wired to RTDB + the real verifier');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // Task 3 — getEditableCatalog. The read that hands a merchant their live money data.
  //
  //   OWNER-ONLY, and this is the sharp edge. authorizeCatalogEdit grants a DISPATCHER any restaurant
  //   — that is correct for internal staff tooling and wrong here: a merchant portal read that accepted
  //   it would let internal staff pull any tenant's catalog through the tenant-facing surface.
  //
  //   VALIDATE ON READ, FAIL CLOSED. A malformed source must never be handed over as an editable
  //   baseline. The merchant would edit it, and 2b-2c would hand it straight back through the CAS —
  //   corruption laundered into a publish by way of a UI that showed it as normal.
  //
  //   THE CAS BASELINE MUST BE BYTE-IDENTICAL to editCatalog's, or every later save fails the
  //   precondition — the nanosecond bug from 2b-1 Task 6, one layer up.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  const { getEditableCatalogCore } = require('./portal-reads');
  const { encodeUpdateTime } = require('./edit-catalog-handler');

  // A brand-neutral source that really passes validateSource.
  //
  // NOT one of our restaurants' sources renamed: validateSource is BRAND-AWARE. extrasKeyOf returns
  // display.id for one brand and display.name for every other, so a document only validates under a rid
  // whose keying convention matches — renaming one to `merch_a` makes it fail, which is how this was
  // found. That hardcoded key strategy is the known prerequisite the relay flags for the WRITE slices;
  // a name-keyed fixture is what any new merchant gets by default, so it is also the honest one.
  const realSource = (rid) => ({
    restaurant_id: rid, schema_version: 1,
    items: [
      { key: 'Plato Uno', price: 250, display: { id: 1, cat: 'principales', name: 'Plato Uno', price: 250, desc: 'a dish' } },
      { key: 'Plato Dos', price: 310, display: { id: 2, cat: 'principales', name: 'Plato Dos', price: 310, desc: 'another' } },
    ],
    extras: [{ key: 'Queso', price: 40, display: { id: 'e1', name: 'Queso', price: 40 } }],
    structure: { schema_version: 2, item_order: ['Plato Uno', 'Plato Dos'], categories: [{ id: 'principales' }] },
  });
  const TS = { seconds: 1788754374, nanoseconds: 634000000 };
  function mkFs(source, { updateTime = TS, exists = true, throwOn = null } = {}) {
    const refs = [];
    return {
      refs,
      _sourceRefOf: (_fsdb, rid) => {
        refs.push(rid);
        return { get: async () => { if (throwOn) throw new Error(throwOn); return { exists, data: () => source, updateTime }; } };
      },
    };
  }
  const asOwner = async () => ({ ok: true, uid: 'uidOwner001', role: 'owner', actor: 'o@m.hn' });
  const gReq = (rid = 'merch_a', over = {}) => ({ method: 'GET', query: { restaurantId: rid }, get: () => 'Bearer tok', ...over });

  {
    const rid = 'merch_a';
    const src = realSource(rid);
    const fs2 = mkFs(src);
    const r = await getEditableCatalogCore({
      db: {}, fsdb: {}, authorize: asOwner, readActiveVersionId: async () => 'v-1788754374634', ...fs2,
    }, gReq(rid));
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.deepStrictEqual(r.body.source, src, 'the owner gets the real source document');
    assert.strictEqual(r.body.activeVersionId, 'v-1788754374634', 'and which version is currently live');
    // THE INTEGRATION PROPERTY: byte-identical to what editCatalog expects back as baseSourceUpdateTime.
    assert.strictEqual(r.body.sourceUpdateTime, '1788754374.634000000', 'seconds.nanoseconds, ns padded to 9');
    assert.strictEqual(r.body.sourceUpdateTime, encodeUpdateTime(TS), 'and produced by the SAME codec 2b-1 uses — not a second one that drifts');
    // the ref is built with the AUTHORIZED rid, not anything else the request carried
    assert.deepStrictEqual(fs2.refs, [rid], 'the source ref is built with the authorized restaurant id');
    ok('an OWNER gets the real source, the live version id, and a CAS baseline byte-identical to editCatalog\'s');
  }
  {
    // OWNER-ONLY. A dispatcher is legitimately authorized by authorizeCatalogEdit for ANY restaurant —
    // that is the cross-tenant internal path, and it must not open the tenant-facing read.
    for (const role of ['dispatcher', 'staff', undefined, null, 'admin', 'OWNER']) {
      const fs2 = mkFs(realSource('merch_a'));
      const r = await getEditableCatalogCore({
        db: {}, fsdb: {}, authorize: async () => ({ ok: true, uid: 'u', role }), readActiveVersionId: async () => 'v', ...fs2,
      }, gReq('merch_a'));
      assert.strictEqual(r.status, 403, `role ${JSON.stringify(role)} → 403`);
      assert.strictEqual(r.body.error, 'not_owner', `role ${JSON.stringify(role)} → not_owner`);
      assert.deepStrictEqual(fs2.refs, [], `role ${JSON.stringify(role)} → the source is never even read`);
    }
    ok('owner-only: dispatcher, staff and every non-owner role are refused BEFORE the source is read (case-sensitive)');
  }
  {
    // authorize's own refusals pass through verbatim — including 503, which must not become a 403.
    for (const a of [
      { ok: false, status: 401, error: 'missing_bearer_token' },
      { ok: false, status: 403, error: 'not_authorized' },
      { ok: false, status: 400, error: 'bad_restaurant_id' },
      { ok: false, status: 503, error: 'authorization_unavailable' },
    ]) {
      const fs2 = mkFs(realSource('merch_a'));
      const r = await getEditableCatalogCore({ db: {}, fsdb: {}, authorize: async () => a, readActiveVersionId: async () => 'v', ...fs2 }, gReq());
      assert.strictEqual(r.status, a.status, `authorize ${a.error} → ${a.status}`);
      assert.strictEqual(r.body.error, a.error, 'with its own typed error');
      assert.deepStrictEqual(fs2.refs, [], 'and nothing read');
    }
    ok('every authorize refusal passes through with its own status — an auth outage stays a 503, not a 403');
  }
  {
    // VALIDATE ON READ, FAIL CLOSED. A malformed source is not a normal load: handing it over as an
    // editable baseline means the merchant edits corruption and 2b-2c passes it back through the CAS.
    const broken = realSource('merch_a');
    broken.items[0].price = 0;                      // a price validateSource rejects
    const fs2 = mkFs(broken);
    const r = await getEditableCatalogCore({ db: {}, fsdb: {}, authorize: asOwner, readActiveVersionId: async () => 'v', ...fs2 }, gReq());
    assert.strictEqual(r.status, 503, 'a malformed source is a 503, never a normal 200');
    assert.strictEqual(r.body.error, 'source_unavailable', 'typed');
    assert.ok(!JSON.stringify(r.body).includes('"items"'), 'and the unvalidated source is NOT returned');
    // ...and it is the REAL validator, not a stub that always passes
    const good = await getEditableCatalogCore({ db: {}, fsdb: {}, authorize: asOwner, readActiveVersionId: async () => 'v', ...mkFs(realSource('merch_a')) }, gReq());
    assert.strictEqual(good.status, 200, 'non-vacuity: a VALID source still loads (the validator is not rejecting everything)');
    ok('a malformed source fails CLOSED as 503 and is never returned — validated by the real validator, on every read');
  }
  {
    // The source is validated against the AUTHORIZED rid. Validating against the document's own
    // restaurant_id would make a mis-filed document validate happily.
    const misfiled = realSource('merch_b');          // valid, but says merch_b while stored under merch_a
    const r = await getEditableCatalogCore({ db: {}, fsdb: {}, authorize: asOwner, readActiveVersionId: async () => 'v', ...mkFs(misfiled) }, gReq('merch_a'));
    assert.strictEqual(r.status, 503, 'a source whose restaurant_id does not match where it is stored fails closed');
    ok('the source is validated against the AUTHORIZED rid — a mis-filed document cannot self-certify');
  }
  {
    // Absent vs unreadable are different things and must not share a code.
    const absent = await getEditableCatalogCore({ db: {}, fsdb: {}, authorize: asOwner, readActiveVersionId: async () => 'v', ...mkFs(null, { exists: false }) }, gReq());
    assert.strictEqual(absent.status, 404, 'no source document yet → 404');
    assert.strictEqual(absent.body.error, 'source_absent', 'typed');
    const down = await getEditableCatalogCore({ db: {}, fsdb: {}, authorize: asOwner, readActiveVersionId: async () => 'v', ...mkFs(null, { throwOn: 'firestore down' }) }, gReq());
    assert.strictEqual(down.status, 503, 'an unreadable source → 503');
    const noVersion = await getEditableCatalogCore({ db: {}, fsdb: {}, authorize: asOwner, readActiveVersionId: async () => { throw new Error('pointer down'); }, ...mkFs(realSource('merch_a')) }, gReq());
    assert.strictEqual(noVersion.status, 503, 'an unreadable active-version pointer → 503');
    assert.notStrictEqual(absent.status, down.status, 'and "not there yet" is never confused with "cannot read it"');
    ok('absent (404), unreadable source (503) and unreadable pointer (503) are distinct — never conflated');
  }
  {
    // A restaurant with no published version yet is a legitimate state, not a failure: the draft exists
    // and can be shown. Only an actual read FAILURE is a 503.
    const r = await getEditableCatalogCore({ db: {}, fsdb: {}, authorize: asOwner, readActiveVersionId: async () => null, ...mkFs(realSource('merch_a')) }, gReq());
    assert.strictEqual(r.status, 200, 'never-published is still readable');
    assert.strictEqual(r.body.activeVersionId, null, 'and honestly reports that nothing is live');
    ok('a restaurant with nothing published yet loads, reporting activeVersionId null rather than failing');
  }
  {
    // Read-only, and non-GET is refused.
    const r = await getEditableCatalogCore({ db: {}, fsdb: {}, authorize: asOwner, readActiveVersionId: async () => 'v', ...mkFs(realSource('merch_a')) }, gReq('merch_a', { method: 'POST' }));
    assert.strictEqual(r.status, 405, 'non-GET is refused');
    const src = require('fs').readFileSync(require('path').join(__dirname, 'portal-reads.js'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
    for (const w of ['.set(', '.update(', '.delete(', '.create(', 'publishVersion', 'batch(']) {
      assert.ok(!src.includes(w), `portal-reads is READ-ONLY — it must not contain ${w}`);
    }
    ok('read-only: non-GET refused, and the module contains no write call of any kind');
  }
  {
    // Wiring.
    const CODE = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
    assert.ok(/\{[^}]*\bgetEditableCatalogCore\b[^}]*\}\s*=\s*require\('\.\/catalog\/portal-reads'\)/.test(CODE), 'index.js must import the core');
    assert.ok(/exports\.getEditableCatalog = onRequest\(/.test(CODE), 'and export the handler');
    const blockOf2 = (name) => {
      const start = CODE.indexOf(`exports.${name} = onRequest(`);
      assert.ok(start > -1, `the ${name} wrapper must exist`);
      const next = CODE.indexOf('\nexports.', start + 1);
      return CODE.slice(start, next === -1 ? CODE.length : next);
    };
    const block = blockOf2('getEditableCatalog');
    assert.ok(block.length > 100, 'non-vacuity: the wrapper block was found');
    assert.ok(/await getEditableCatalogCore\(\{/.test(block), 'delegating to the TESTED core');
    // owners are in RTDB, the source doc is in Firestore — mixing them up is the whole grill finding #4
    assert.ok(/authorizeCatalogEdit\(\{ db: getDatabase\(\)/.test(block), 'authorize must read owners from RTDB');
    assert.ok(/fsdb: getFirestore\(\)/.test(block), 'and the source doc from Firestore');
    // The production wrapper must inject NO test overrides. The previous form of this line —
    // `/sourceRefOf/.test(block) || /_sourceRefOf/.test(block) === false` — was a tautology: the
    // right-hand side is true whenever the left is false, so it could never fail. Production was
    // correct; the assertion simply was not guarding it. (Flagged by the codex gate.)
    for (const override of ['_sourceRefOf', '_validateSource']) {
      assert.ok(!block.includes(override), `the production wrapper must not inject ${override} — the real ${override.slice(1)} is the point`);
    }
    // non-vacuity: the detector really does fire on an injected override
    assert.ok(`${block}\n  _sourceRefOf: () => fake,`.includes('_sourceRefOf'), 'the check can see an override when one is present');
    ok('the getEditableCatalog wrapper is exported, delegates to the core, and reads owners from RTDB + the source from Firestore');
  }

  // ── (6) CORS: the portal is a different ORIGIN from the customer order sites ─────────────────
  {
    const CODE = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
    const blockOf = (name) => {
      const start = CODE.indexOf(`exports.${name} = onRequest(`);
      assert.ok(start > -1, `${name} must exist`);
      const next = CODE.indexOf('\nexports.', start + 1);
      return CODE.slice(start, next === -1 ? CODE.length : next);
    };
    for (const fn of ['getMyRestaurants', 'getEditableCatalog']) {
      const b = blockOf(fn);
      assert.ok(/cors: PORTAL_ORIGINS/.test(b), `${fn} must use the portal's own CORS list`);
      // ...and NOT the account list. Widening ACCOUNT_ORIGINS to include the portal would hand the
      // portal's origin access to the OTP and account endpoints, which it has no business calling.
      assert.ok(!/cors: ACCOUNT_ORIGINS/.test(b), `${fn} must not reuse the account-endpoint CORS list`);
    }
    // the account endpoints keep theirs, untouched
    assert.ok(/cors: ACCOUNT_ORIGINS/.test(blockOf('requestOtp')), 'the account endpoints still use ACCOUNT_ORIGINS');
    assert.ok(!/PORTAL_ORIGINS/.test(blockOf('requestOtp')), 'and did not inherit the portal list');
    // the two lists must be genuinely separate constants, not aliases
    assert.ok(/const PORTAL_ORIGINS = \[/.test(CODE) && /const ACCOUNT_ORIGINS = \[/.test(CODE), 'two distinct lists');
    assert.ok(!/PORTAL_ORIGINS = ACCOUNT_ORIGINS|ACCOUNT_ORIGINS\.concat/.test(CODE), 'neither derived from the other');
    ok('the portal reads use their own narrow CORS list; the account endpoints keep theirs, unwidened');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 2b-2b Task 2b — THE FISCAL CAPABILITY FLAG, and the CORS the write path needs.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  {
    // The portal must decide whether to show the SAR attestation. It must NOT decide that from the
    // restaurant id: `rid === 'x_pizza'` in a browser is a brand literal in the one place it cannot be
    // corrected without a redeploy, and it is wrong the day a third merchant joins the platform
    // factura. The server already owns this fact (factura/eligibility.js), so it says it.
    const asOwner2 = async () => ({ ok: true, uid: 'u1', role: 'owner', actor: 'o@m.hn' });
    const gReq2 = (rid) => ({ method: 'GET', query: { restaurantId: rid }, get: () => 'Bearer tok' });
    const nameKeyed = (rid) => ({
      restaurant_id: rid, schema_version: 1,
      items: [{ key: 'Plato Uno', price: 250, display: { id: 1, cat: 'principales', name: 'Plato Uno', price: 250 } }],
      extras: [{ key: 'Queso', price: 40, display: { id: 'e1', name: 'Queso', price: 40 } }],
      structure: { schema_version: 2, item_order: ['Plato Uno'], categories: [{ id: 'principales' }] },
    });
    // la_musa keys by id, so its fixture must too — otherwise validateSource rejects it and this would
    // be measuring the validator rather than the flag.
    const idKeyed = (rid) => ({
      restaurant_id: rid, schema_version: 1,
      items: [{ key: 'plato_01', price: 250, display: { id: 'plato_01', cat: 'principales', name: 'Plato Uno', price: 250 } }],
      extras: [{ key: 'queso', price: 40, display: { id: 'queso', name: 'Queso', price: 40 } }],
      structure: { schema_version: 2, item_order: ['plato_01'], categories: [{ id: 'principales' }] },
    });
    const srcFor = (rid) => (rid === 'la_musa' ? idKeyed(rid) : nameKeyed(rid));

    for (const [rid, expected, why] of [
      ['x_pizza', true,  'issues the SAR factura through this platform'],
      ['la_musa', false, 'files through its own Soft Restaurant POS'],
      ['merch_3', false, 'a config-only merchant is not on the platform factura'],
    ]) {
      const r = await getEditableCatalogCore({
        db: {}, fsdb: {}, authorize: asOwner2, readActiveVersionId: async () => 'v-1', ...mkFs(srcFor(rid)),
      }, gReq2(rid));
      assert.strictEqual(r.status, 200, `${rid}: expected 200, got ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
      assert.strictEqual(r.body.usesPlatformFactura, expected, `${rid} — ${why}`);
      assert.strictEqual(typeof r.body.usesPlatformFactura, 'boolean', `${rid}: a boolean, never undefined — the UI must not have to guess`);
    }
    // It must be the SERVER's fact, not a second copy of the rule living in this test.
    const { usesPlatformFactura } = require('../factura/eligibility');
    for (const rid of ['x_pizza', 'la_musa', 'merch_3']) {
      const r = await getEditableCatalogCore({ db: {}, fsdb: {}, authorize: asOwner2, readActiveVersionId: async () => 'v-1', ...mkFs(srcFor(rid)) }, gReq2(rid));
      assert.strictEqual(r.body.usesPlatformFactura, usesPlatformFactura(rid),
        `${rid}: the response must agree with factura/eligibility, not with a duplicate rule`);
    }
    // 🔴 THE DISCRIMINATOR. Everything above passes just as well against a hardcoded `rid === 'x_pizza'`
    // — the literal and the server's set agree on every restaurant that exists today, which is exactly
    // why a brand literal here would survive review and every test. So MOVE the server's fact and
    // require the response to move with it. A literal cannot follow.
    {
      const { FACTURA_PLATFORM_RESTAURANTS } = require('../factura/eligibility');
      FACTURA_PLATFORM_RESTAURANTS.add('merch_3');
      try {
        const r = await getEditableCatalogCore({
          db: {}, fsdb: {}, authorize: asOwner2, readActiveVersionId: async () => 'v-1', ...mkFs(srcFor('merch_3')),
        }, gReq2('merch_3'));
        assert.strictEqual(r.body.usesPlatformFactura, true,
          'a merchant ADDED to the platform-factura set must report true — a `rid === \'x_pizza\'` literal reports false here');
      } finally { FACTURA_PLATFORM_RESTAURANTS.delete('merch_3'); }
      // ...and it moves back, so the flag tracks the set rather than latching
      const back = await getEditableCatalogCore({
        db: {}, fsdb: {}, authorize: asOwner2, readActiveVersionId: async () => 'v-1', ...mkFs(srcFor('merch_3')),
      }, gReq2('merch_3'));
      assert.strictEqual(back.body.usesPlatformFactura, false, 'and false again once removed — the fixture cleaned up after itself');
    }
    ok('getEditableCatalog reports usesPlatformFactura from the server\'s own eligibility set — both brands, a config-only merchant, and one moved in and out of the set');
  }

  {
    // ADDITIVE ONLY. The existing fields carry the CAS baseline the write path depends on; a new field
    // must not disturb them, and must not appear on a refusal either — a 403 body that leaked a
    // capability flag would answer a question the caller was not allowed to ask.
    const asOwner2 = async () => ({ ok: true, uid: 'u1', role: 'owner', actor: 'o@m.hn' });
    const src = realSource('x_pizza');
    const gq = { method: 'GET', query: { restaurantId: 'x_pizza' }, get: () => 'Bearer tok' };
    const r = await getEditableCatalogCore({
      db: {}, fsdb: {}, authorize: asOwner2, readActiveVersionId: async () => 'v-9', ...mkFs(src),
    }, gq);
    assert.deepStrictEqual(Object.keys(r.body).sort(), ['activeVersionId', 'source', 'sourceUpdateTime', 'usesPlatformFactura'],
      'exactly the three existing fields plus the one new one — nothing else appeared');
    assert.deepStrictEqual(r.body.source, src, 'the source is untouched');
    assert.strictEqual(r.body.sourceUpdateTime, '1788754374.634000000', 'the CAS baseline is byte-identical to before');
    assert.strictEqual(r.body.activeVersionId, 'v-9', 'and the live version id');

    const denied = await getEditableCatalogCore({
      db: {}, fsdb: {}, authorize: async () => ({ ok: true, uid: 'u2', role: 'dispatcher' }), readActiveVersionId: async () => 'v', ...mkFs(src),
    }, gq);
    assert.strictEqual(denied.status, 403, 'a dispatcher is still refused by the tenant-facing read');
    assert.ok(!('usesPlatformFactura' in denied.body), 'and the refusal leaks no capability flag');
    ok('the new field is purely additive: the three existing fields are byte-identical and a refusal carries nothing new');
  }

  {
    // THE CORS FIX. editCatalog and publishEdited shipped with 2b-1 on 09-07, a day before
    // PORTAL_ORIGINS existed, so they took the then-default ACCOUNT_ORIGINS — the two CUSTOMER order
    // sites. The merchant portal could not call either: every request died at the preflight, and no
    // unit test would ever notice, because they all mock fetch.
    //
    // They move to PORTAL_ORIGINS *instead of*, not *in addition to*. The portal is their only browser
    // caller (verified across the tree), so this is strictly NARROWER — it also removes two money-write
    // endpoints from the reach of the customer order sites, where they never belonged.
    const CODE = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
    const blockOf2 = (name) => {
      const start = CODE.indexOf(`exports.${name} = onRequest(`);
      assert.ok(start > -1, `the ${name} wrapper must exist`);
      const next = CODE.indexOf('\nexports.', start + 1);
      return CODE.slice(start, next === -1 ? CODE.length : next);
    };
    for (const fn of ['editCatalog', 'publishEdited']) {
      const b = blockOf2(fn);
      assert.ok(b.length > 100, `non-vacuity: the ${fn} block was found`);
      assert.ok((b.match(/= onRequest\(/g) || []).length === 1, `the ${fn} block is bounded — it must not swallow the next handler`);
      assert.ok(/cors: PORTAL_ORIGINS/.test(b), `${fn} must accept the PORTAL origin — the portal is its only browser caller`);
      assert.ok(!/cors: ACCOUNT_ORIGINS/.test(b), `${fn} must NOT stay on the customer order sites' list`);
    }
    // and the account list is not widened to compensate — the point is that the two stay separate
    assert.ok(!/PORTAL_ORIGINS/.test(blockOf2('requestOtp')), 'the account endpoints did not inherit the portal list');
    assert.ok(/const ACCOUNT_ORIGINS = \[\s*'https:\/\/orders\.xpizza\.hn',\s*'https:\/\/orders\.lamusa\.hn',\s*\];/.test(CODE),
      'ACCOUNT_ORIGINS is unchanged — exactly the two customer order sites, never widened to reach the portal');
    ok('the two write endpoints accept the portal origin and only it; ACCOUNT_ORIGINS is untouched');
  }

  console.log(`portal-reads: OK (${n})`);
  FINISHED = true;
})().catch((e) => { console.error(e); process.exit(1); });
