'use strict';
/**
 * Portal 1D · D3 — placement guard for the shadow identity check in both order writers.
 * Run: `node identity-shadow-placement.test.js`
 *
 * 🔴 WHAT THIS PROVES AND WHAT IT DELIBERATELY DOES NOT — in the same style, and for the same reason,
 * as charge-gate-placement.test.js.
 *
 * The VERDICT and the contract around it are executed elsewhere: catalog/identity-shadow.test.js runs
 * the classifier, the read-failure semantics, the never-throws guarantee and the collect-if-settled
 * mechanism; test/identity-shadow.emulator.test.js proves a real check resolves against a real
 * backfilled registry and catches a real swap; hosted-charge-flow.test.js RUNS the accepted-fresh seam
 * and proves a refused or reused charge starts ZERO checks. None of that is re-litigated here.
 *
 * What this file locks is WHERE the calls sit inside the two ~500-line express handlers, which those
 * runtime tests do not execute. The placements carry real guarantees that are invisible to them:
 *   · the cash kickoff must sit AFTER the order write — a check must never precede the order existing;
 *   · the cash collection must sit AFTER the notify await — that await is what the reads ride under;
 *   · the card report must sit AFTER `if (flow.respond) return` — that single line is what makes a
 *     refusal, a reuse AND a checkout failure emit nothing, without it being a rule to remember;
 *   · nothing may be awaited, and the check must not be Promise.all-ed with the notify.
 * An edit that moved any of them would leave every runtime test green. This fails the build instead.
 * It locks the wiring; it does not execute the handler.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const at = (needle, from = 0) => { const i = src.indexOf(needle, from); assert.notStrictEqual(i, -1, `anchor not found: ${needle}`); return i; };

// ── CASH ────────────────────────────────────────────────────────────────────────────────────────
{
  const write = at('await db.ref().update(updates);');
  const kickoff = at('const shadowCheck = startShadowCheck(getFirestore,');
  const notify = at('await notifyWithinDeadline(', kickoff);
  const collect = at('const shadowResult = (shadowCheck && shadowCheck.isSettled())');
  const respond = at('return res.status(200).json({ ok: true, order_id: orderId, tracking_token: trackingToken });');

  assert.ok(write < kickoff, '🔴 the cash check is kicked off BEFORE the order is written — it must never precede the order existing');
  assert.ok(kickoff < notify, '🔴 …and before the notify await, which is the I/O its reads ride under');
  assert.ok(notify < collect, '🔴 the result is collected AFTER the notify await, not before it');
  assert.ok(collect < respond, '…and before the response goes out');
  ok('cash: kickoff after the write and before the notify; collect after the notify, before the response');
}

// ── CARD ────────────────────────────────────────────────────────────────────────────────────────
{
  const flowCall = at('const flow = await resolveAndIssueHostedCheckout({');
  const callback = at('onAcceptedFresh: () => {', flowCall);
  const respondGuard = at('if (flow.respond) return res.status(flow.respond.status).json(flow.respond.body);');
  const report = at('reportIdentityShadow(db, {', respondGuard);

  assert.ok(flowCall < callback && callback < respondGuard,
    '🔴 the card check must be passed INTO the flow as onAcceptedFresh — started at the accepted-fresh seam, not in the handler');
  assert.ok(!/startShadowCheck\([\s\S]{0,200}resolveAndIssueHostedCheckout/.test(src),
    '🔴 the card check must not be started before the flow — every refusal is still ahead of it there');
  assert.ok(respondGuard < report,
    '🔴 the card report sits BEFORE the flow.respond return — a refusal, a reuse or a checkout failure would report');
  /* 🔴 REPORTING IS GATED ON "THE CALLBACK FIRED", NOT ON "A CHECK EXISTS". If the kickoff itself
     threw, the flow swallows it and the check is null — indistinguishable from a refused request,
     which correctly reports nothing. Gating on the object would make a SUCCESSFUL issuance emit no
     heartbeat at all, understating coverage and hiding the very getFirestore failure the heartbeat
     exists to expose. */
  assert.ok(/if \(cardShadowStarted\) \{/.test(src),
    '🔴 the card report is gated on the check OBJECT rather than on whether the callback fired — a thrown kickoff would emit no heartbeat on a successful issuance');
  ok('card: the check is started by the seam callback, and reporting is gated on the callback having fired');
}

// ── CONTRACT B — NOTHING IS AWAITED ─────────────────────────────────────────────────────────────
{
  /* 🔴 THE LATENCY GUARANTEE, AS A SHAPE. One `await` in front of either of these and the response
     waits for a diagnostic — the exact thing the whole contract exists to prevent, and a change that
     no behavioural test in this repo would notice. */
  assert.ok(!/await\s+shadowValidateIds/.test(src), '🔴 shadowValidateIds is AWAITED — the response would wait for the check');
  assert.ok(!/await\s+reportIdentityShadow/.test(src), '🔴 reportIdentityShadow is AWAITED — the response would wait for reporting');
  assert.ok(!/await\s+shadowCheck/.test(src) && !/await\s+cardShadow/.test(src), '🔴 the tracked check is awaited somewhere');
  assert.ok(!/Promise\.all\([^)]*shadow/i.test(src),
    '🔴 the check is Promise.all-ed with other work — a fast, failed or disabled notify would then wait for it');
  assert.ok(!/Promise\.all\([^)]*notify[^)]*shadow|Promise\.all\([^)]*shadow[^)]*notify/i.test(src),
    '🔴 …specifically not with the WhatsApp notify');
  ok('neither the check nor its reporting is awaited, and neither is raced with the notify');
}

// ── THE HANDLE ──────────────────────────────────────────────────────────────────────────────────
{
  const calls = [...src.matchAll(/startShadowCheck\(([^,]+),/g)].map((m) => m[1].trim());
  assert.strictEqual(calls.length, 2, `expected exactly two guarded call sites, found ${calls.length}`);
  assert.ok(calls.every((a) => a === 'getFirestore'),
    `🔴 a call site passes ${calls.find((a) => a !== 'getFirestore')} — it must pass the GETTER, so a throwing handle is caught inside the guard instead of failing an already-written order`);
  assert.ok(!/shadowValidateIds\(/.test(src),
    '🔴 a handler calls the validator directly, bypassing the guard');
  ok('both call sites pass getFirestore as a getter through the guard; nothing calls the validator directly');
}

console.log(`\nidentity-shadow-placement: OK (${n})`);
