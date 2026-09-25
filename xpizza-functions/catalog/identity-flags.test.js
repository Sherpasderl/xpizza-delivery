'use strict';
/**
 * renameEnabled — §7's staging switch. Run: node catalog/identity-flags.test.js
 *
 * 🔴 A FAIL-SAFE FLAG'S FAILURE MODES ARE THE PRODUCT. The happy path is one line; everything that
 * matters is what it does when the document is missing, the field is the wrong type, or the read
 * throws. Each of those is a way a staging switch silently arrives in the wrong position, and the one
 * that matters most is the throw: a flag that fails OPEN turns an outage into a rename.
 */
const assert = require('assert');
const { renameEnabled, flagRefOf, FLAG_DOC, FLAG_FIELD } = require('./identity-flags');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-flags: FAILED — exited without completing'); process.exitCode = 1; } });

/* A Firestore double narrow enough to be honest: it answers .get() for exactly the one document this
   module reads, and records the path so a cell can assert WHICH document was asked for. */
const fakeDb = (behaviour) => {
  const asked = [];
  const doc = (path) => ({
    _path: path,
    get: async () => {
      asked.push(path);
      if (typeof behaviour === 'function') return behaviour();
      return behaviour;
    },
  });
  return {
    asked,
    collection: (c1) => ({ doc: (d1) => ({ collection: (c2) => ({ doc: (d2) => doc(`${c1}/${d1}/${c2}/${d2}`) }) }) }),
  };
};
const snap = (data) => ({ exists: data !== undefined, data: () => data });

(async () => {
  // ── 1. THE NON-VACUITY FLOOR: IT CAN ACTUALLY RETURN ON ─────────────────────────────────────
  {
    /* Without this every cell below passes trivially for a function that returns false always — which
       is exactly the shape a fail-safe default invites. */
    const db = fakeDb(snap({ [FLAG_FIELD]: true }));
    assert.strictEqual(await renameEnabled(db, 'x_pizza'), true,
      '🔴 an explicit boolean true did not turn the flag ON — the switch cannot be flipped at all, and every OFF assertion below is vacuous');
    assert.deepStrictEqual(db.asked, [`restaurants/x_pizza/meta/${FLAG_DOC}`],
      `🔴 it read the wrong document: ${JSON.stringify(db.asked)}`);
    ok(`an explicit boolean true turns it ON, read from restaurants/{rid}/meta/${FLAG_DOC}.${FLAG_FIELD}`);
  }

  // ── 2. EVERY NOT-EXACTLY-TRUE VALUE IS OFF ──────────────────────────────────────────────────
  {
    /* 🔴 `=== true`, NOT TRUTHINESS. The string "true" is what a console edit produces, and 1 is what
       a JSON round-trip through a spreadsheet produces. Either turning renames on would be a staging
       switch flipped by a typo. */
    for (const v of ['true', 'TRUE', 1, 'yes', {}, [], 'on', 0.0000001]) {
      assert.strictEqual(await renameEnabled(fakeDb(snap({ [FLAG_FIELD]: v })), 'x_pizza'), false,
        `🔴 ${JSON.stringify(v)} turned renames ON — only an explicit boolean true may`);
    }
    for (const v of [false, null, undefined, 0, '']) {
      assert.strictEqual(await renameEnabled(fakeDb(snap({ [FLAG_FIELD]: v })), 'x_pizza'), false,
        `${JSON.stringify(v)} is off, as expected`);
    }
    ok('only an explicit boolean true is ON — the string "true", 1, and every other truthy value are OFF');
  }

  // ── 3. ABSENT DOCUMENT AND ABSENT FIELD ARE BOTH OFF ────────────────────────────────────────
  {
    assert.strictEqual(await renameEnabled(fakeDb(snap(undefined)), 'x_pizza'), false,
      '🔴 a MISSING flag document turned renames on — which is the state of every restaurant that has never been staged');
    assert.strictEqual(await renameEnabled(fakeDb(snap({})), 'x_pizza'), false,
      '🔴 a document with no such field turned renames on');
    assert.strictEqual(await renameEnabled(fakeDb(snap({ some_other_flag: true })), 'x_pizza'), false,
      '🔴 a NEIGHBOURING flag turned renames on — the field name is not being read');
    assert.strictEqual(await renameEnabled(fakeDb({ exists: true, data: () => null }), 'x_pizza'), false,
      '🔴 a document whose data() is null crashed or turned it on');
    ok('a missing document, a missing field, a neighbouring field and a null body are each OFF');
  }

  // ── 4. 🔴 A READ THAT THROWS IS OFF — THE ONE THAT MATTERS MOST ─────────────────────────────
  {
    /* A fail-safe flag that fails OPEN is worse than no flag: it converts a config-read outage into a
       rename, at the exact moment nobody is watching the thing that broke. */
    const boom = () => { throw new Error('UNAVAILABLE: config read failed'); };
    assert.strictEqual(await renameEnabled(fakeDb(boom), 'x_pizza'), false,
      '🔴 A FAILED READ TURNED RENAMES ON. A fail-safe flag that fails OPEN turns an outage into a rename.');

    const reject = () => Promise.reject(new Error('DEADLINE_EXCEEDED'));
    assert.strictEqual(await renameEnabled(fakeDb(reject), 'x_pizza'), false,
      '🔴 a rejected promise turned renames on');

    /* And a handle that is not a database at all — the shape a wiring mistake produces. */
    assert.strictEqual(await renameEnabled(null, 'x_pizza'), false, '🔴 a null db turned renames on');
    assert.strictEqual(await renameEnabled({}, 'x_pizza'), false, '🔴 a handle with no collection() turned renames on');
    ok('a throwing read, a rejected promise, a null handle and a non-database handle are each OFF — the flag cannot fail open');
  }

  // ── 5. IT IS SCOPED PER RESTAURANT, WHICH IS WHAT MAKES §10's STAGING EXECUTABLE ────────────
  {
    /* 🔴 NOT BECAUSE IT PROTECTS la_musa — certification does that, and la_musa is never certified.
       Because §10 says to flip P1b on AFTER the coverage watch is clean, and a watch you cannot scope
       is a watch you cannot act on: a global flag makes the first rename in production every
       restaurant's first rename, simultaneously. */
    const db = fakeDb(snap({ [FLAG_FIELD]: true }));
    await renameEnabled(db, 'x_pizza');
    await renameEnabled(db, 'la_musa');
    assert.deepStrictEqual(db.asked, [
      `restaurants/x_pizza/meta/${FLAG_DOC}`,
      `restaurants/la_musa/meta/${FLAG_DOC}`,
    ], '🔴 the two restaurants did not read DIFFERENT documents — the flag is global and §10 cannot be staged');

    assert.strictEqual(flagRefOf(fakeDb(snap({})), 'x_pizza')._path, `restaurants/x_pizza/meta/${FLAG_DOC}`,
      'the exported ref builder agrees with what the reader asks for — a deploy runbook uses it to write the flag');
    ok('each restaurant reads its OWN flag document, so P1b can be enabled for one and observed before widening');
  }

  FINISHED = true;
  console.log(`identity-flags: OK (${n})`);
})().catch((e) => { console.error('identity-flags FAILED:', (e && e.message) || e); process.exit(1); });
