'use strict';
// PLAN-S5 — the slice's test-only INVERSE. Byte-exact HUNKS over index.js (the ready_at branch in the status writer; the
// prepStatsDaily require + export at the end); unapplyS5Index swaps each back, so the result === 9947464c:index.js
// byte-for-byte (s5-wiring.guard). It is the NEWEST slice: every index.js fold and every pin chain applies it FIRST.
const BASE = '9947464c';
const HUNKS = Object.freeze([
 {
  "file": "index.js",
  "now": "        trackingUpdates[`order_tracking/${trackingToken}/picked_up_at`] = ServerValue.TIMESTAMP;\n      /* s5:begin ready-at */\n      } else if (after === 'ready') {\n        trackingUpdates[`order_tracking/${trackingToken}/ready_at`] = ServerValue.TIMESTAMP;   // S5 §4.6: the forms' ready-stage window (a recall overwrites: the latest ready)\n      /* s5:end ready-at */\n      } else if (after === 'delivered') {\n",
  "was": "        trackingUpdates[`order_tracking/${trackingToken}/picked_up_at`] = ServerValue.TIMESTAMP;\n      } else if (after === 'delivered') {\n"
 },
 {
  "file": "index.js",
  "now": "\n/* s5:begin prep-stats */\n// S5 §5 — the daily measured-prep summary behind the order forms' arrival window (prep-stats.js): one bounded, paged\n// order_timelines query + two leaf reads per candidate → ONE multipath update of restaurants/{rid}/public/prep_stats.\nconst { runPrepStats } = require('./prep-stats');\nexports.prepStatsDaily = onSchedule(\n  { schedule: 'every day 04:00', timeZone: 'America/Tegucigalpa', region: 'us-central1', timeoutSeconds: 300, memory: '256MiB' },\n  async () => { await runPrepStats({ db: getDatabase(), nowMs: Date.now(), log: console }); },\n);\n/* s5:end prep-stats */\n",
  "was": ""
 }
]);
function unapply(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`s5-inverse: ${file}: an s5 hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const unapplyS5Index = (src) => unapply('index.js', src);
module.exports = { unapplyS5Index, HUNKS, BASE };
