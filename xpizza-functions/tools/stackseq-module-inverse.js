'use strict';
// STACKED-DELIVERY SEQUENCING (BUILD-stacked-seq-server r5 T8/T9) — the test-only INVERSE of this slice's footprint in the PINNED
// modules cancel-order-core.js (the flag-gated cancel promotion's two lines at the top of cleanupTasksAndDriver; OFF = the
// base body verbatim) and retention-sweep.js (the isolated stacks/ retention pass, T9). unapplyStackseqModule(f, src) ===
// acf32fc8:f byte-for-byte for each; any other file passes through unchanged. Newest layer → applied INNERMOST wherever that module is pinned:
// unapplyBrandServerModule(f, unapplyStackseqModule(f, <source>)).
const FILES = ['cancel-order-core.js', 'retention-sweep.js'];
const HUNKS = [
 {
  "file": "cancel-order-core.js",
  "now": "  const SEQ_CANCEL = require('./sequencing/cancel-promotion');   // stacked-seq r5 T8 (D11 a): the flag-gated cancel promotion; OFF = the body below, verbatim\n  if (order && order.order_type === 'delivery' && await SEQ_CANCEL.readSeqFlagSafe(db)) return SEQ_CANCEL.cleanupWithPromotion(db, orderId);\n",
  "was": ""
 },
 {
  "file": "retention-sweep.js",
  "now": "  // stacked-seq r5 T9 (D10): the stacks/ retention pass — isolated in its own try/catch, never affects the passes above\n  try {\n    const s = await require('./sequencing/retention').runStackPass(db, Date.now());\n    if (s.deleted) console.log(`retentionSweepTasks: stacks — deleted ${s.deleted}, kept ${s.kept} of ${s.scanned}`);\n  } catch (e) { console.warn('retentionSweepTasks: stack retention pass failed (task pass unaffected)', e && e.message); }\n",
  "was": ""
 }
];

function unapplyStackseqModule(file, src) {
  if (!FILES.includes(file)) return src;
  let out = src;
  for (const h of HUNKS.filter((x) => x.file === file)) {
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`stackseq-module-inverse: ${file}: a hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}

module.exports = { unapplyStackseqModule, FILES, HUNKS };
