'use strict';
/* A stable anchor for tools/sweep-baseline.test.js, which drives the real sweep with a synthetic
   catalogue. Its mutants must anchor LIVE code or the anchor guard refuses before the baseline runs
   — which would prove nothing about the baseline. Nothing else uses this. */
const ANCHOR_ONE = 1;
module.exports = { ANCHOR_ONE };
