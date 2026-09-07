'use strict';
// Portal 2b-2a Task 1 — the owner→restaurants reverse index. Run: node catalog/owner-index.test.js
//
// `restaurants/{rid}/owners/{uid}` answers "is this person the owner of THAT restaurant?" — which is
// all the fiscal gate needed. The portal asks the opposite question: "which restaurants does this
// person own?", and RTDB cannot answer that without scanning every restaurant. So a grant writes BOTH
// directions, atomically, and the reverse index becomes load-bearing: it decides which catalogs a
// merchant can even see.
//
// That makes two properties matter more than the mapping itself:
//   • BOTH paths or NEITHER. A half-applied grant leaves an owner who cannot see their own restaurant
//     (harmless) or, in the other direction, a reverse index naming a restaurant they do not own
//     (a tenant-isolation hole). One multi-path update, never two writes.
//   • The uid and rid build RTDB PATHS. Anything that can steer a path can grant ownership of something
//     else, so both are validated as identifiers before they are interpolated.
//
// Plain node + assert, matching every other suite here (the plan sketched these in Jest, which this
// repo does not use — see the handback).
const assert = require('assert');
const { ownerGrantPaths, readOwnerRestaurants, RID_RE, UID_RE } = require('./owner-index');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('owner-index: FAILED — exited without completing'); process.exitCode = 1; } });

// A stub RTDB that records the paths read, so a test can assert what was NOT looked at.
function stubDb(tree, { throwOn = null } = {}) {
  const reads = [];
  return {
    reads,
    ref: (path) => ({
      get: async () => {
        reads.push(path);
        if (throwOn && path.includes(throwOn)) throw new Error('rtdb unavailable');
        return { val: () => (Object.prototype.hasOwnProperty.call(tree, path) ? tree[path] : null) };
      },
    }),
  };
}

(async () => {
  // ── (1) A GRANT IS BOTH DIRECTIONS, IN ONE UPDATE ────────────────────────────────────────────
  {
    assert.deepStrictEqual(ownerGrantPaths('any_merchant_3', 'uidABC123'), {
      'restaurants/any_merchant_3/owners/uidABC123': true,
      'owner_restaurants/uidABC123/any_merchant_3': true,
    }, 'a grant names both the forward and the reverse path');
    // Deliberately brand-agnostic: nothing here knows our two restaurants exist.
    const third = ownerGrantPaths('pupuseria_lupe', 'ZzQq0011');
    assert.deepStrictEqual(Object.keys(third).sort(), ['owner_restaurants/ZzQq0011/pupuseria_lupe', 'restaurants/pupuseria_lupe/owners/ZzQq0011'],
      'and works unchanged for a merchant that did not exist when this was written');
    ok('a grant is a single multi-path update covering BOTH directions (brand-agnostic)');
  }

  // ── (2) THE IDS BUILD PATHS, so they are validated before interpolation ──────────────────────
  {
    // A `/` in either field would relocate the write. `restaurants/a/owners/x/../../dispatchers/x`
    // is not a hypothetical — it is the same class the 2b-1 auth helper already guards.
    const badRids = ['', '   ', 'a', 'A_Pizza', 'has space', 'has/slash', '../dispatchers', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'x'.repeat(60), null, undefined, 42, {}, []];
    for (const rid of badRids) {
      assert.throws(() => ownerGrantPaths(rid, 'uidABC123'), /bad_rid/, `a malformed rid must be refused: ${JSON.stringify(rid)}`);
    }
    const badUids = ['', '   ', 'short', 'has/slash', 'has space', 'a.b', 'a#b', 'a$b', 'a[b', 'a]b', 'x'.repeat(200), null, undefined, 42, {}, []];
    for (const uid of badUids) {
      assert.throws(() => ownerGrantPaths('merch_a', uid), /bad_uid/, `a malformed uid must be refused: ${JSON.stringify(uid)}`);
    }
    // non-vacuity: the shapes we DO expect are accepted
    assert.doesNotThrow(() => ownerGrantPaths('merch_a', 'AbCdEf123456'), 'an ordinary grant is accepted');
    assert.doesNotThrow(() => ownerGrantPaths('a1', 'AbCdEf'), 'and the boundary-length ones');
    // ...and RTDB's own forbidden path characters can never reach a path
    for (const ch of ['.', '#', '$', '[', ']', '/']) {
      assert.strictEqual(RID_RE.test(`ab${ch}cd`), false, `RTDB forbids ${ch} in a key — the rid pattern must reject it`);
      assert.strictEqual(UID_RE.test(`abcdef${ch}gh`), false, `and the uid pattern must too (${ch})`);
    }
    ok(`${badRids.length} malformed rids and ${badUids.length} malformed uids are refused; no RTDB-forbidden character can reach a path`);
  }

  // ── (3) READING THE REVERSE INDEX ────────────────────────────────────────────────────────────
  {
    const db = stubDb({ 'owner_restaurants/uidABC123': { merch_a: true, merch_b: true } });
    assert.deepStrictEqual((await readOwnerRestaurants(db, 'uidABC123')).sort(), ['merch_a', 'merch_b'], 'an owner of two restaurants gets both');
    assert.deepStrictEqual(db.reads, ['owner_restaurants/uidABC123'], 'read from the reverse index only — one read, no scan of every restaurant');

    // An owner of nothing gets nothing — and an ABSENT node is not an error, it is an empty answer.
    assert.deepStrictEqual(await readOwnerRestaurants(stubDb({}), 'uidNOBODY01'), [], 'a uid with no grants gets an empty list');
    ok('the reverse index answers "which restaurants do I own?" in ONE read; no grants is an empty list, not an error');
  }
  {
    // TRUTHY IS NOT TRUE. The index is written as `true`; anything else is a value nobody granted —
    // a stray write, a partial delete, a migration artefact — and must not confer access.
    const db = stubDb({ 'owner_restaurants/uidABC123': {
      merch_a: true, revoked: false, stale: null, weird: 1, alsoweird: 'true', nested: { a: 1 },
    } });
    assert.deepStrictEqual(await readOwnerRestaurants(db, 'uidABC123'), ['merch_a'],
      'only entries that are exactly `true` count — a revoked (false) or oddly-typed entry grants nothing');
    // ...and a malformed KEY in the index cannot smuggle a restaurant in either
    const db2 = stubDb({ 'owner_restaurants/uidABC123': { merch_a: true, 'BAD/ID': true, '': true, 'X_Pizza': true } });
    assert.deepStrictEqual(await readOwnerRestaurants(db2, 'uidABC123'), ['merch_a'], 'and a structurally invalid rid in the index is ignored');
    ok('only exactly-true entries with valid rids count — revoked, oddly-typed and malformed entries confer nothing');
  }
  {
    // A malformed uid must not even reach the database: it would build the read path.
    for (const uid of ['', 'has/slash', 'a.b', null, undefined, 42]) {
      const db = stubDb({});
      assert.deepStrictEqual(await readOwnerRestaurants(db, uid), [], `a malformed uid returns nothing: ${JSON.stringify(uid)}`);
      assert.deepStrictEqual(db.reads, [], 'and never touches the database');
    }
    ok('a malformed uid returns an empty list without touching the database (the uid builds the read path)');
  }
  {
    // AN OUTAGE IS NOT AN ANSWER. If the read fails, "you own nothing" is a plausible-looking lie that
    // would show a merchant an empty portal as though their restaurants had been taken away. It must
    // propagate so the caller can answer 503 rather than render a confident emptiness.
    const db = stubDb({ 'owner_restaurants/uidABC123': { merch_a: true } }, { throwOn: 'owner_restaurants' });
    await assert.rejects(() => readOwnerRestaurants(db, 'uidABC123'), /rtdb unavailable/,
      'a read failure must PROPAGATE — an empty list would be indistinguishable from "you own nothing"');
    ok('a read outage propagates instead of returning an empty list (503, never a confident "you own nothing")');
  }

  // ── (7) THE GRANT TOOL. Owner-run, never executed by a test, and the ONLY writer of either path —
  //        so its wiring is asserted structurally, as with every other CLI in this repo.
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'tools', 'seed-owner.js'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
    for (const id of ['ownerGrantPaths', 'readOwnerRestaurants', 'RID_RE', 'UID_RE', 'RTDB_URL']) {
      assert.ok(new RegExp(`\\{[^}]*\\b${id}\\b[^}]*\\}\\s*=\\s*require`).test(src),
        `seed-owner uses ${id} but never imports it — node --check is blind to this, and the first run IS the grant`);
    }
    // ONE atomic multi-path update. Two writes could half-apply, and the dangerous half is a reverse
    // index naming a restaurant the forward index does not.
    assert.ok(/await db\.ref\(\)\.update\(update\)/.test(src), 'the grant must be a single root-level multi-path update (atomic)');
    assert.strictEqual((src.match(/\.set\(/g) || []).length, 0, 'and must not use per-path set() — that is the half-apply shape');
    // The paths come from the shared helper, so a revoke can never clear a different set than a grant writes.
    assert.ok(/const paths = ownerGrantPaths\(RID, UID\)/.test(src), 'the tool must derive its paths from ownerGrantPaths');
    assert.ok(/update\[p\] = REVOKE \? null : true/.test(src), 'and revoke must clear exactly those same paths');
    // Validation precedes any write, and the read-only listing returns before it.
    //
    // `before` asserts BOTH markers exist first. A bare indexOf comparison is a trap: deleting the
    // earlier marker makes indexOf return -1, and -1 is less than any index — so the ordering check
    // passes exactly when the thing it orders has been removed. Three mutations survived on that.
    const before = (a, b, why) => {
      assert.ok(src.includes(a), `${why} — but "${a}" is not in the tool at all`);
      assert.ok(src.includes(b), `${why} — but "${b}" is not in the tool at all`);
      assert.ok(src.indexOf(a) < src.indexOf(b), why);
    };
    before('UID_RE.test(UID)', 'db.ref().update', 'the uid is validated before any write');
    before('RID_RE.test(RID)', 'db.ref().update', 'and so is the rid');
    before('nothing changed.', 'db.ref().update', 'listing (uid only) returns BEFORE the write path');
    // and the listing branch really does exit rather than falling through
    assert.ok(/nothing changed[\s\S]{0,120}process\.exit\(0\)/.test(src), 'the listing branch exits — it never continues into the grant');
    assert.ok(/databaseURL: RTDB_URL/.test(src), 'and databaseURL is pinned — admin.database() throws without it');
    ok('the grant tool imports what it uses, writes ONE atomic multi-path update, and validates before writing');
  }

  console.log(`owner-index: OK (${n})`);
  FINISHED = true;
})().catch((e) => { console.error(e); process.exit(1); });
