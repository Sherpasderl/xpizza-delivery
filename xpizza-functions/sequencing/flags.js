'use strict';
// The ONE stop-order sequencing switch (Codex r1 P1 ruling): sequencing is ON only when config/stack_sequencing_enabled AND
// config/tracker_fixes_enabled are both `true` — each read fails OFF. A stack carrying stop_seq is therefore never served by
// the legacy tracker (the tracker-fixes OFF path), whose claims do not follow a moved pointer. Read ONCE per invocation by
// each caller. Operationally: switch tracker_fixes ON before stack_sequencing, and stack_sequencing OFF before tracker_fixes.
const { FLAG_PATH: TRACKER_FLAG_PATH } = require('../tracking/flag');
const SEQ_FLAG_PATH = 'config/stack_sequencing_enabled';

async function readSeqFlag(db) {
  try {
    if ((await db.ref(SEQ_FLAG_PATH).once('value')).val() !== true) return false;
    return (await db.ref(TRACKER_FLAG_PATH).once('value')).val() === true;
  } catch (e) { console.warn(`stackseq: flag read failed (${(e && e.message) || e}) — OFF`); return false; }
}
module.exports = { readSeqFlag, SEQ_FLAG_PATH, TRACKER_FLAG_PATH };
