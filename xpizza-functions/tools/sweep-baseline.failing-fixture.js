'use strict';
/* A suite that fails with a distinctive line, for tools/sweep-baseline.test.js.
   🔴 THE SENTINEL LIVES IN THIS FILE, NOT IN THE COMMAND. An earlier version of that cell used
   `node -e "console.error('SENTINEL…')"` — and the sweep's refusal ECHOES THE COMMAND, so the
   sentinel appeared whether or not the suite's own output was shown. The cell passed while unable to
   detect the thing it existed to detect, and only a mutant surfaced it. The text must be producible
   ONLY by running the suite. */
console.error('EMULATOR-REFUSED-SENTINEL: this line exists only inside the failing suite');
process.exit(1);
