# REVISE → EXECUTOR — factura print auto-recovery (advisor + codex integrity gate)

**Gate result: REVISE.** Strong build — the core is right and **fiscal integrity is fully intact**: no new número/CAI path, `decidePrintClaim` + every money/número file byte-unchanged, `reprint.js` touches only print flags, Map iteration safe, `retryCandidate`/`reprintDecision` correct (11/11 tests green). All findings are about **avoiding a DUPLICATE PHYSICAL PRINT of the same número** (wasteful/confusing — not a SAR violation) under race/failure paths the new auto-retry amplifies. All fixes stay inside `print_agent.js` + `tools/reprint.js` — **no new files, no scope change.** Branch `feat/factura-print-auto-recovery` @ `804efbf`.

Keep the guardrails from the build relay in force (do NOT modify `decidePrintClaim`; no `functions/index.js`/rules/renderer/número touches; `reprint.js` still refuses `printed:true`/`void`).

---

## 🔴 Fix A (HIGH) — don't auto-reprint a factura that physically printed but failed to record
**Problem** (`print_agent.js` ~90-101): the `try` prints on paper (`sendToPrinter`) THEN writes `printed:true`. If the print succeeds but that write throws, the `catch` runs `pendingRetry.set(...)` → the 60s timer **reprints the same número** (duplicate paper). The old code stranded it silently; the new timer makes it auto-duplicate.

**Fix** — distinguish "printed-but-ack-failed" (do NOT retry) from "print-failed" (safe to retry):
```js
    const record = tx.snapshot.val();
    let physicallyPrinted = false;
    try {
      await sendToPrinter(renderFactura(record, 2)); // two copies (D4)
      physicallyPrinted = true;
      await ref.update({ printed: true, printed_at: now, print_error: null, print_claim: null });
      pendingRetry.delete(orderId);
      console.log(`[print] ${record.factura_number} (${orderId}) OK`);
    } catch (e) {
      if (physicallyPrinted) {
        // Printed on paper but couldn't record it → DO NOT auto-reprint (would duplicate the número).
        // Drop from retry + flag for a manual eyeball.
        pendingRetry.delete(orderId);
        await ref.update({ print_error: `printed_ack_failed: ${String(e.message).slice(0, 260)}`, print_claim: null }).catch(() => {});
        console.error(`[print] ${orderId} PRINTED but ack failed — NOT retrying (manual check): ${e.message}`);
      } else {
        await ref.update({ print_error: String(e.message).slice(0, 300), print_claim: null });
        pendingRetry.set(orderId, record); // genuine print failure → retry until it prints
        console.error(`[print] ${orderId} FAILED: ${e.message}`);
      }
    }
```
**Known residual (leave as-is, document only):** a process CRASH between the physical print and the `printed:true` write still leaves `printed:false` → a reprint on the next startup `child_added`. This is **pre-existing** (unchanged by this PR) and a full fix needs a durable "print-attempting" marker written *before* `sendToPrinter` — heavier, out of scope for this change. Note it in the handback; don't build it here.

## 🔴 Fix B (HIGH) — `reprint.js` clobber race → make the clear transactional
**Problem** (`tools/reprint.js` ~31-41): `once('value')` then unconditional `update()`. If the agent prints (`printed:true`) between the read and the write, the CLI overwrites `printed:false` again → reprint of the same número. The `printed:true` refusal only reflects the initial read.

**Fix** — re-check `reprintDecision` on the LIVE value inside a transaction; abort (no write) if it's no longer reprintable:
```js
  const res = await ref.transaction((cur) => {
    const d = reprintDecision(cur);
    if (d.action !== 'reprint') return;                 // abort: no write
    return { ...cur, printed: false, printed_at: null, print_error: null, print_claim: null };
  });
  if (!res.committed) {
    const d = reprintDecision(res.snapshot.val());
    console.error(`refuse: ${d.reason || 'not_reprintable'} (${orderId})` +
      (d.reason === 'already_printed'
        ? ' — a reprint of an ISSUED+printed factura needs a fiscal COPIA decision; not done here.'
        : ''));
    process.exit(1);
  }
  console.log(`reprint queued: ${res.snapshot.val().factura_number} (${orderId}) — the print agent will print it shortly.`);
  process.exit(0);
```
(Drop the earlier separate `once`/`reprintDecision`/`update` block — the transaction replaces it. Keep the top-of-file usage/`orderId` guard.)

## 🟠 Fix C (MEDIUM, defensive) — prune `pendingRetry` on delete so a stale record can't resurrect
**Problem** (`print_agent.js` ~81 + timer): the timer passes the *stale* captured `record` as the null-first fallback (`rec == null ? known : rec`). If a factura node were **deleted**, the retry would use the stale record → `decidePrintClaim` → claim → **write it back + print** a resurrected factura. No `child_removed` prune. Low real-world likelihood (facturas are **voided, never deleted**), but a latent footgun.

**Fix** — add a `child_removed` listener in `start()` that drops the key:
```js
  root.on('child_removed', (snap) => pendingRetry.delete(snap.key));
```
This is sufficient for the realistic case. (The deeper in-flight-tick-races-deletion edge is an acceptable residual given deletion doesn't occur in the fiscal lifecycle — don't over-engineer.)

## 🟢 Nit — remove the dead import
`retryCandidate` is imported (`print_agent.js:19`) but never called (membership is driven entirely by `handle()`). Either **remove the import** (cleanest) or actually use it to seed `pendingRetry` from the `child_added`/`child_changed` snapshots. Your call; removal is fine.

---

## Confirmed clean (advisor + codex — no action)
No new número/CAI allocation · `decidePrintClaim`/`renderer.js`/`escpos.js`/`allocate.js`/`num-to-words.js`/`money.js`/`functions/index.js`/`database.rules.json` all byte-unchanged · same-process listener/timer overlap guarded by `inFlight` + the transactional claim · Map iteration not corrupted (async mutations after the loop yields) · no `Math.random`; `Date.now` only for claim TTL.

## Definition of done (REVISE)
Fixes A + B + C committed; `retryCandidate` import resolved; `node xpizza-factura/src/print-recovery.test.js` still green; `node --check` clean on `print_agent.js` + `tools/reprint.js`. Bench notes: (A) simulate a successful print with a forced ack-write failure → NOT reprinted, flagged; (B) `reprint.js` on a record that flips to `printed:true` mid-run → refuses, no clobber; (C) `child_removed` drops the entry. Handback (branch @ new SHA, files, test counts, bench results, + note the documented crash-mid-print residual) → advisor light re-verify of the deltas → owner deploys on the Surface (`git pull` + restart `XPizzaFacturaAgent`).
