'use strict';
/**
 * Portal 1D · D3 — the shadow validator's semantics. Run: `node catalog/identity-shadow.test.js`
 *
 * 🔴 WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY IS NOT. The claims here are about the VERDICT and
 * the contract around it — which occurrences are read for, what a read failure means, that the thing
 * cannot throw, that the response never waits. Those are properties of this code's shape, provable
 * against a store that answers; they do not need a real Firestore.
 * The claims that DO need one — that a check actually resolves against a registry the real backfill
 * wrote, and that an exchanged pair of real ids reads as `swapped` — live in
 * test/identity-shadow.emulator.test.js. Splitting them is deliberate: this file runs on every
 * `npm test`, the emulator file proves the part a fixture cannot.
 */
const assert = require('assert');
const { shadowValidateIds, occurrencesOf, trackSettled, reportIdentityShadow } = require('./identity-shadow-validate');
const { classifyClaim, validateClaim } = require('./identity-registry');
const { memFirestore } = require('./identity-fixture');
const { ensureIdentity } = require('./identity-registry');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
let FINISHED = false;
process.on('exit', (c) => { if (c === 0 && !FINISHED) { console.error('identity-shadow: FAILED — exited without completing'); process.exitCode = 1; } });

// A cart in the shape D2 actually emits — dish line with a nested extra, ids at both levels.
const cart = (over = {}) => [{
  name: 'Carnivora', qty: 2, price: 340, subtotal: 680, extrasTotal: 39,
  extras: [{ instance: 0, name: 'Salsa Roja', price: 39, ...(over.extraId !== undefined ? { extra_id: over.extraId } : {}) }],
  ...(over.dishId !== undefined ? { dish_id: over.dishId } : {}),
}];

(async () => {
  // ── 1. THE CLASSIFIER'S ABSENT PREDICATE IS PRODUCTION'S EXACT ONE ─────────────────────────────
  /* 🔴 THE NON-STRING CASES ARE THE WHOLE POINT. A truthy non-string — 123, true, {}, [] — is absent
     today, which means no read and no report. A laxer `!claimedId` would let all four through to be
     compared against a registry they cannot possibly match, and every one would surface as a
     fabricated mismatch on a real customer's order. It would also make classifyClaim disagree with
     validateClaim, which is the fake-laxer-than-production failure in its purest form: two functions
     that must agree, differing on exactly the inputs nobody writes a test for. */
  {
    for (const weird of [123, true, {}, [], 0, '', null, undefined, NaN]) {
      assert.strictEqual(classifyClaim({ actual: 'ANY', claimedId: weird }).reason, 'absent',
        `🔴 a claim of ${JSON.stringify(weird)} (${typeof weird}) must be ABSENT — no read, no report`);
    }
    // …and a real string id is NOT absent, so the predicate is not simply always-absent.
    assert.strictEqual(classifyClaim({ actual: 'A', claimedId: 'A' }).reason, 'ok', 'non-vacuity: a real id classifies');
    ok(`the absent predicate is typeof-exact — 9 non-string/empty claims are absent, a real id is not`);
  }

  // ── 2. THE TWO APIS NEVER DISAGREE ON THE REASON ───────────────────────────────────────────────
  /* They keep different external shapes on purpose — validateClaim omits `actual` on absent and omits
     `reason` on ok — so this compares the REASON only, each through its own API. Asserting one returns
     the other's shape would be asserting a contract change nobody asked for. */
  {
    const db = memFirestore();
    await ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Carnivora' });
    const realId = (await ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Carnivora' })).canonical_id;

    const cases = [
      ['absent (non-string)', 'Carnivora', 123, 'absent'],
      ['absent (empty)', 'Carnivora', '', 'absent'],
      ['unregistered key', 'Not In Registry', 'SOMEID1234', 'unregistered_key'],
      ['swapped', 'Carnivora', 'OTHERID999', 'swapped'],
      ['ok', 'Carnivora', realId, 'ok'],
    ];
    for (const [label, legacyKey, claimedId, expected] of cases) {
      const v = await validateClaim(db, { rid: 'x_pizza', kind: 'dish', legacyKey, claimedId });
      const vReason = v.ok ? 'ok' : v.reason;
      const lookup = expected === 'absent' ? null : (legacyKey === 'Carnivora' ? realId : null);
      const c = classifyClaim({ actual: lookup, claimedId }).reason;
      assert.strictEqual(vReason, expected, `${label}: validateClaim says ${vReason}`);
      assert.strictEqual(c, expected, `${label}: classifyClaim says ${c}`);
    }

    // 🔴 THE EXTERNAL SHAPE, BYTE-UNCHANGED BY THE REFACTOR — the thing a caller or an older test may
    // depend on. `absent` carries no `actual`; `ok` carries no `reason`.
    const absent = await validateClaim(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Carnivora', claimedId: 123 });
    assert.deepStrictEqual(absent, { ok: false, reason: 'absent' }, '🔴 absent must not gain an `actual`');
    const good = await validateClaim(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Carnivora', claimedId: realId });
    assert.deepStrictEqual(good, { ok: true, actual: realId }, '🔴 ok must not gain a `reason`');
    ok('classifyClaim and validateClaim agree on every reason, and validateClaim\'s four shapes are unchanged');
  }

  // ── 3. ONLY ID-CARRYING OCCURRENCES ARE READ FOR ───────────────────────────────────────────────
  /* absent is SILENT and costs nothing: no read, no log, no alert. A menu served before the backfill —
     or during a D1 overlay failure, which serves id-less by design — produces a cart entirely of
     these, and none of them is an anomaly. */
  {
    let reads = 0;
    const spy = { collection: (c) => { reads += 1; return memFirestore().collection(c); } };
    const r = await shadowValidateIds(spy, 'x_pizza', cart());          // no ids at all
    assert.strictEqual(reads, 0, '🔴 an id-less cart performs ZERO registry reads');
    assert.deepStrictEqual({ checked: r.checked, absent: r.absent, mismatches: r.mismatches, status: r.status },
      { checked: 0, absent: 2, mismatches: [], status: 'ok' },
      'the dish and its extra are both counted absent');
    // non-vacuity: the same spy DOES count a read when an id is present
    await shadowValidateIds(spy, 'x_pizza', cart({ dishId: 'ABC1234567' }));
    assert.ok(reads > 0, 'non-vacuity: the spy really does see reads when there is an id to check');
    ok('an id-less cart is silent and reads nothing; an id-carrying one reads');
  }

  // ── 4. A READ FAILURE IS NOT A MISMATCH, AND IT IS VISIBLE ─────────────────────────────────────
  /* 🔴 THE WRONG-HANDLE BUG HAS A SHAPE, AND THIS IS IT. Passing the RTDB handle makes every read
     fail; because a read failure is deliberately not a mismatch, the validator would report "no
     mismatches" forever while checking nothing. What makes that detectable is `checked > 0` beside
     `resolved: 0` — the counts, not the mismatch list. A version that returned checked:0 here would
     make a broken validator indistinguishable from a cart that carried no ids. */
  {
    const rtdbLike = { ref: () => ({ once: async () => ({ val: () => null }) }) };   // no .collection at all
    // Caught here too: this is the FIRST place a rethrowing validator would escape, and a throw must
    // read as the stated failure rather than as an unexplained TypeError from inside a stub.
    let threw4 = null; let r = null;
    try { r = await shadowValidateIds(rtdbLike, 'x_pizza', cart({ dishId: 'ABC1234567', extraId: 'XYZ7654321' })); } catch (e) { threw4 = e; }
    assert.strictEqual(threw4, null,
      `🔴 the validator THREW into the order path on a wrong handle — it must return a status (${threw4 && threw4.message})`);
    assert.strictEqual(r.status, 'read_error', '🔴 a non-Firestore handle is a read_error');
    assert.deepStrictEqual(r.mismatches, [], '🔴 …and NEVER a mismatch — no false swap from a broken read');
    assert.strictEqual(r.checked, 2, '🔴 checked survives the failure — this is the liveness signal');
    assert.strictEqual(r.resolved, 0, '🔴 …and resolved is 0, which is what makes "broken" legible');
    ok('a wrong/broken handle yields read_error with checked>0 and resolved=0 — never a false mismatch');
  }

  // ── 5. IT NEVER THROWS ─────────────────────────────────────────────────────────────────────────
  /* It runs inside an order handler after the order exists. A throw here would turn a diagnostic into
     a failed order, which is the one thing a shadow feature may never do. */
  {
    const hostile = [
      [null, 'a null handle'],
      [{ collection: () => { throw new Error('boom'); } }, 'a handle that throws'],
      [{ collection: () => ({ doc: () => { throw new Error('mid-path boom'); } }) }, 'a handle that throws mid-path'],
    ];
    for (const [fs, label] of hostile) {
      /* CAUGHT EXPLICITLY, so "it did not throw" is an ASSERTION rather than the absence of a crash.
         Letting a rejection escape would fail the run too, but it would fail it as an unhandled error
         with no statement of what was expected — and a mutant that made the validator throw would then
         die for a reason no one could read back. */
      let threw = null; let r = null;
      try { r = await shadowValidateIds(fs, 'x_pizza', cart({ dishId: 'A1' })); } catch (e) { threw = e; }
      assert.strictEqual(threw, null,
        `🔴 ${label}: the validator THREW into the order path — it runs after the order exists, so a throw here turns a diagnostic into a failed order`);
      assert.strictEqual(r.status, 'read_error', `${label}: becomes a status, not an exception`);
      assert.deepStrictEqual(r.mismatches, [], `${label}: and no mismatch`);
    }
    for (const bad of [null, undefined, 'nope', 42, {}]) {
      const r = await shadowValidateIds(memFirestore(), 'x_pizza', bad);
      assert.ok(r && Array.isArray(r.mismatches), `a cart of ${JSON.stringify(bad)} is survived`);
    }
    ok('no handle, a throwing handle, or a malformed cart all become a status — it never throws');
  }

  // ── 6. THE INTERNAL TIMER BOUNDS THE RESULT, AND timed_out ≠ read_error ────────────────────────
  {
    /* A SELF-REFERENTIAL node, so the stub cannot be the wrong DEPTH. The registry path is
       restaurants/{rid}/identity/{kind}/keys/{key} — seven chained calls — and a hand-built stub one
       level short throws part-way down, which surfaces as read_error and would have been read as "the
       timeout does not work". It was: that is how this cell first failed. */
    const hangingFs = (() => { const node = { get: () => new Promise(() => {}) }; node.collection = () => node; node.doc = () => node; return node; })();
    const t0 = Date.now();
    const r = await shadowValidateIds(hangingFs, 'x_pizza', cart({ dishId: 'A1' }), { internalTimeoutMs: 40 });
    const took = Date.now() - t0;
    assert.strictEqual(r.status, 'timed_out', '🔴 a hanging registry is timed_out, DISTINCT from read_error');
    assert.deepStrictEqual(r.mismatches, [], '…and still no mismatch');
    assert.strictEqual(r.checked, 1, 'the count of what it tried to check survives');
    assert.ok(took < 2000, `…and it settled on its own timer (${took}ms), not on the read`);
    ok(`a hanging registry settles timed_out in ${took}ms with zero mismatches`);
  }

  // ── 7. CONTRACT B — THE BOUNDARY NEVER WAITS ───────────────────────────────────────────────────
  /* 🔴 THE LATENCY GUARANTEE IN ONE CELL. isSettled() must be answerable synchronously, because the
     handler asks it at the response boundary and must not await. A sample still outstanding is dropped
     — and a later settlement must change nothing, because by then the response has gone. */
  {
    let release;
    const gated = new Promise((r) => { release = r; });
    const t = trackSettled(gated);
    assert.strictEqual(t.isSettled(), false, '🔴 an outstanding check is NOT settled at the boundary');
    assert.strictEqual(t.value(), null, '…and has no value to collect');

    release({ mismatches: [], checked: 1, resolved: 1, absent: 0, status: 'ok' });
    await t.promise;
    assert.strictEqual(t.isSettled(), true, 'once it lands it is settled');

    // A rejection counts as settled too — otherwise it would hang as "outstanding" forever and every
    // such order would silently become a drop.
    const rejected = trackSettled(Promise.reject(new Error('nope')));
    await rejected.promise;
    assert.strictEqual(rejected.isSettled(), true, '🔴 a rejection settles rather than hanging the sample');
    assert.strictEqual(rejected.value(), null, '…with no value');
    ok('trackSettled answers synchronously, treats a rejection as settled, and holds nothing');
  }

  // ── 8. REPORTING — HEARTBEAT ALWAYS, MISMATCH LOGS ONLY FOR REAL ANOMALIES ─────────────────────
  {
    const logs = []; const warns = []; const writes = [];
    const origLog = console.log; const origWarn = console.warn;
    console.log = (...a) => { if (String(a[0]).startsWith('order_identity_shadow')) logs.push(a); else origLog(...a); };
    console.warn = (...a) => { if (String(a[0]).startsWith('order_identity_shadow')) warns.push(a); else origWarn(...a); };
    const db = { ref: (path) => ({ set: (v) => { writes.push({ path, v }); return Promise.resolve(); } }) };
    try {
      // a clean run: heartbeat, no warn, no alert
      reportIdentityShadow(db, { rid: 'x_pizza', orderId: 'O1', outcome: 'reported',
        result: { mismatches: [], checked: 3, resolved: 3, absent: 1, status: 'ok' } });
      assert.strictEqual(logs.length, 1, '🔴 exactly ONE heartbeat');
      assert.strictEqual(warns.length, 0, 'a clean run warns about nothing');
      assert.strictEqual(writes.length, 0, '…and raises no alert');
      const hb = JSON.parse(logs[0][1]);
      assert.deepStrictEqual({ ...hb }, { rid: 'x_pizza', order_id: 'O1', attempt_id: null, checked: 3, resolved: 3, absent: 1, mismatches: 0, outcome: 'reported' },
        'the heartbeat carries the counts and the outcome');

      // a dropped sample: still exactly one heartbeat, saying so
      reportIdentityShadow(db, { rid: 'x_pizza', orderId: 'O2', outcome: 'dropped', result: null });
      assert.strictEqual(logs.length, 2, 'a dropped sample still emits its heartbeat');
      assert.strictEqual(JSON.parse(logs[1][1]).outcome, 'dropped', '🔴 …and the drop is VISIBLE, not silent coverage loss');

      // a mismatch: heartbeat + one warn per line + one keyed alert
      reportIdentityShadow(db, { rid: 'x_pizza', orderId: 'O3', attemptId: 'AT9', outcome: 'reported',
        result: { checked: 2, resolved: 2, absent: 0, status: 'ok', mismatches: [
          { line: 0, kind: 'dish', id: 'A', expected_legacy_key: 'Carnivora', registry_id: 'B', reason: 'swapped' },
          { line: 1, kind: 'extra', id: 'C', expected_legacy_key: 'Salsa Roja', registry_id: null, reason: 'unregistered_key' },
        ] } });
      assert.strictEqual(warns.length, 2, '🔴 one synchronous log per mismatched line — the authoritative record');
      assert.strictEqual(writes.length, 1, 'ONE keyed alert row per order, not one per line');
      assert.strictEqual(writes[0].path, 'dispatcher_alerts/identity_mismatch_O3', 'keyed by order id');
      assert.strictEqual(writes[0].v.worst, 'swapped', 'the worst reason is surfaced for triage');
      assert.strictEqual(writes[0].v.detail.order_id, 'O3',
        '🔴 the order_id lives inside `detail` — alert-prune scans detail, so anywhere else it is an orphan that never prunes');
      assert.strictEqual(JSON.parse(logs[2][1]).attempt_id, 'AT9', 'the heartbeat carries the attempt id');
    } finally { console.log = origLog; console.warn = origWarn; }
    ok('a clean run logs only a heartbeat; a mismatch adds one warn per line and ONE keyed alert with order_id in detail');
  }

  // ── 9. A BROKEN ALERT NEVER BREAKS AN ORDER ────────────────────────────────────────────────────
  /* The order already exists by the time any of this runs. The alert is a convenience over the log,
     and a convenience that can throw is a liability. */
  {
    const origLog = console.log; const origWarn = console.warn;
    const warns = [];
    /* 🔴 AN UNHANDLED REJECTION IS ITS OWN FAILURE MODE, SO IT IS ASSERTED RATHER THAN LEFT TO CRASH
       THE RUN. The alert write is detached — nothing awaits it — which means a rejected write has no
       one to catch it unless the .catch is attached at the call site. In a Cloud Function an unhandled
       rejection can take the instance down, so dropping that .catch would turn a best-effort
       convenience into an outage on the one path where a mismatch was found. Collected here so the
       property fails as a statement instead of as an unreadable crash. */
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    console.log = () => {}; console.warn = (...a) => { warns.push(a); };
    try {
      const throwing = { ref: () => { throw new Error('rtdb down'); } };
      const rejecting = { ref: () => ({ set: () => Promise.reject(new Error('write failed')) }) };
      const mism = { checked: 1, resolved: 1, absent: 0, status: 'ok',
        mismatches: [{ line: 0, kind: 'dish', id: 'A', expected_legacy_key: 'K', registry_id: 'B', reason: 'swapped' }] };
      for (const [db, label] of [[throwing, 'a throwing db'], [rejecting, 'a rejecting write']]) {
        reportIdentityShadow(db, { rid: 'x_pizza', orderId: 'O4', outcome: 'reported', result: mism });
        assert.ok(true, `${label} did not throw`);
      }
      assert.strictEqual(warns.length, 2, '🔴 …and the synchronous mismatch LOG was still emitted both times — log authoritative, alert best-effort');
    } finally { console.log = origLog; console.warn = origWarn; }
    await new Promise((r) => setTimeout(r, 20));   // give a rejected detached write time to surface
    process.removeListener('unhandledRejection', onUnhandled);
    assert.strictEqual(unhandled.length, 0,
      `🔴 the detached alert write produced an UNHANDLED REJECTION (${unhandled.map((e) => e && e.message).join(', ')}) — in a Cloud Function that can take the instance down, on the one path where a mismatch was actually found`);
    ok('a throwing or rejecting alert never throws, and the authoritative log is emitted regardless');
  }

  // ── 10. PER-OCCURRENCE CLASSIFICATION, KEYED THROUGH THE REAL RESOLVER ─────────────────────────
  {
    // Two lines of the SAME dish claiming DIFFERENT ids — the read is deduped, the verdict is not.
    const db = memFirestore();
    const real = (await ensureIdentity(db, { rid: 'x_pizza', kind: 'dish', legacyKey: 'Carnivora' })).canonical_id;
    const two = [
      { name: 'Carnivora', qty: 1, price: 340, extras: [], dish_id: real },
      { name: 'Carnivora', qty: 1, price: 340, extras: [], dish_id: 'WRONGID999' },
    ];
    const r = await shadowValidateIds(db, 'x_pizza', two);
    assert.strictEqual(r.checked, 2, 'both occurrences are checked');
    assert.strictEqual(r.mismatches.length, 1, '🔴 the second line is caught — a per-KEY verdict would have collapsed them');
    assert.strictEqual(r.mismatches[0].line, 1, '…and it names the right line');
    assert.strictEqual(r.mismatches[0].reason, 'swapped');

    // occurrencesOf keys through keyOf: x_pizza by NAME for dish AND extra.
    const occ = occurrencesOf('x_pizza', cart({ dishId: 'A', extraId: 'B' }));
    assert.deepStrictEqual(occ.map((o) => [o.kind, o.key]), [['dish', 'Carnivora'], ['extra', 'Salsa Roja']],
      '🔴 both levels keyed through the pricing resolver — x_pizza by name');
    const lm = occurrencesOf('la_musa', [{ id: 'dimsum_01', name: 'Wonton', extras: [{ id: 'rice_white', name: 'Arroz' }] }]);
    assert.deepStrictEqual(lm.map((o) => [o.kind, o.key]), [['dish', 'dimsum_01'], ['extra', 'rice_white']],
      '🔴 …and la_musa by slug id — the same asymmetry itemPricingKey owns');
    ok('each OCCURRENCE is classified (repeated line caught) and both levels key through the real resolver');
  }

  // ── 11. 🔴 THE CALL SITES PASS THE FIRESTORE HANDLE ───────────────────────────────────────────
  /* THE DEFECT THIS WHOLE FEATURE IS ONE IDENTIFIER AWAY FROM. Both handlers have an RTDB `db` in
     scope; the registry lives in Firestore. Passing `db` makes every read fail, and because a read
     failure is deliberately NOT a mismatch, the validator would report "no mismatches" forever while
     checking nothing — and D4 would be authorised on that silence.
     🔴 STATED HONESTLY: this is a STRUCTURAL check, not a runtime one. The handlers are not driven
     here, so what is asserted is that every call site passes `getFirestore()` and that none passes the
     bare `db`. The runtime half is cell 4 (a non-Firestore handle produces read_error with
     resolved:0, never a silent clean result) and the emulator suite's liveness cell (a real check
     really resolves). Between them: the helper behaves correctly on a wrong handle, a real handle
     works, and the call sites pass the right one. */
  {
    const fsrc = require('fs');
    const path = require('path');
    const idx = fsrc.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const calls = [...idx.matchAll(/shadowValidateIds\(([^,]+),/g)].map((m) => m[1].trim());
    assert.strictEqual(calls.length, 2, `🔴 expected exactly two call sites (cash + card), found ${calls.length}`);
    for (const arg of calls) {
      assert.strictEqual(arg, 'getFirestore()',
        `🔴 a shadow check is reading from \`${arg}\` — it must be getFirestore(); the handler's \`db\` is RTDB and every read would fail silently`);
    }
    // non-vacuity: the detector can see the defect it guards against
    assert.ok(/shadowValidateIds\(([^,]+),/.exec('shadowValidateIds(db, rid, items)')[1] === 'db',
      'non-vacuity: the detector reads the first argument');
    ok(`both shadow call sites (cash + card) pass getFirestore(), never the RTDB db`);
  }

  // ── 12. 🔴 SHADOW — NOTHING READS THE VERDICT INTO A DECISION ─────────────────────────────────
  /* The one invariant that makes D3 safe to ship at all: it reports and authorizes nothing. A census
     over the modules that decide money, availability, rewards, fiscal documents, reservations and
     dedup — none may mention the verdict, its counts, or the shadow module. */
  {
    const fsrc = require('fs');
    const path = require('path');
    const ROOT = path.join(__dirname, '..');
    const DECIDERS = [
      'menu-pricing.js', 'compute-server-net.js', 'quote-token.js', 'token-gate.js', 'order-dedup.js',
      'availability-gate.js', 'rewards-redeem.js', 'rewards-reserve.js', 'factura/pricing.js',
      'factura/eligibility.js', 'pixelpay-charge.js', 'hosted-charge-flow.js', 'catalog/public-menu.js',
    ];
    const present = DECIDERS.filter((f) => fsrc.existsSync(path.join(ROOT, f)));
    assert.ok(present.length >= 12, `premise — the census covers the deciding modules (${present.length})`);
    for (const f of present) {
      const code = fsrc.readFileSync(path.join(ROOT, f), 'utf8');
      for (const forbidden of ['shadowValidateIds', 'identity-shadow-validate', 'reportIdentityShadow']) {
        assert.ok(!code.includes(forbidden),
          `🔴 ${f} references ${forbidden} — a money/gate/artifact module must never see the shadow verdict`);
      }
    }
    /* hosted-charge-flow is the one module that TOUCHES the seam, and it must touch only the opaque
       callback — never the verdict, never the module. Asserted rather than assumed, because that file
       is the obvious place for the leak to start. */
    const flow = fsrc.readFileSync(path.join(ROOT, 'hosted-charge-flow.js'), 'utf8');
    assert.ok(flow.includes('onAcceptedFresh'), 'premise — the flow does carry the kickoff callback');
    assert.ok(!/mismatch|verdict|resolved/i.test(flow.split('onAcceptedFresh')[1].slice(0, 400)),
      '🔴 the flow must know nothing about what the callback does — it invokes an opaque hook, nothing more');
    ok(`shadow census: none of ${present.length} deciding modules references the validator or its verdict`);
  }

  FINISHED = true;
  console.log(`\nidentity-shadow: ${n} checks passed`);
})().catch((e) => { console.error('identity-shadow FAILED:', (e && e.stack) || e); process.exit(1); });
