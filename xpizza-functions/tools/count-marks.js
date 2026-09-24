'use strict';
/* Count a suite's assertion marks FROM INSIDE THE SUITE'S OWN PROCESS.
 *
 * 🔴 WHY THIS IS A PRELOAD AND NOT A PARSER. gate-all used to count marks by pattern-matching a
 * subprocess's combined output, and that output is not only the suite's. The firebase CLI writes
 * "✔  Script exited successfully", "✔  firestore: Firestore Emulator was started", "✔  Rules
 * updated.", "✔  Export complete" — at line start, with the SAME U+2714 node --test uses for a real
 * assertion. Stripping those one at a time is a denylist that grew every round and would keep
 * growing, in both directions, forever.
 *
 * The chrome is written by a DIFFERENT PROCESS. A counter living in the suite's process cannot see
 * it — not by denylist, by isolation. That makes this immune to CLI output nobody has met yet, which
 * is the failure that recurred twice: emulator rows inflated by one, and one suite's own summary line
 * under-reporting by nine.
 *
 * 🔴 THE ABSENCE OF THE TRAILER IS A FAILURE, NOT A ZERO. A count that can go missing silently is
 * the thing the zero-assertion rule exists to replace, so gate-all treats "no ##CELLS line" as a
 * suite that cannot be trusted rather than one that asserted nothing. That also means a MISSED
 * injection fails loudly: if a script shape ever stops receiving the preload, the trailer disappears
 * and the gate says so, instead of quietly reverting to an inferred number.
 *
 * Every node process that loads this emits its own trailer and gate-all SUMS them, so the npm and
 * runner processes in the chain contribute 0 and need no argv guard — a guard that must know which
 * process it is in is exactly the kind of thing that is subtly wrong in the permissive direction.
 */
const MARK = /^\s*(?:✓|✔|ok \d)/;
const TRAILER = '##CELLS';

let count = 0;
let pending = '';

const real = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, enc, cb) {
  try {
    const text = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '');
    if (text) {
      /* Writes are not line-aligned, so a mark can arrive split across two chunks. The remainder is
         carried rather than counted, and settled at exit — counting a partial line would make the
         number depend on how the stream happened to flush. */
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const l of lines) if (MARK.test(l) && !l.startsWith(TRAILER)) count += 1;
    }
  } catch (_) { /* counting must never break the suite it is measuring */ }
  return real(chunk, enc, cb);
};

process.on('exit', () => {
  try {
    if (pending && MARK.test(pending) && !pending.startsWith(TRAILER)) count += 1;
    real(`${TRAILER} ${count}\n`);
  } catch (_) { /* nothing useful to do while exiting */ }
});
