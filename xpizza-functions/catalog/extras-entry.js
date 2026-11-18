'use strict';
// S1 (per-dish extras; owner decision 2026-11-11 «the frozen forms keep offering every extra until they retire») — the mode a request's
// extras are judged under. An APP entry (delivery-wire's ONE isApp rule: entry_mode 'app') gets the runtime mode object from the caller's
// reader; any other request — a form cart — gets the reader FACTORY's own answer for an absent node ({ mode: 'off', … }, the exact shape
// extrasCheck reads — Codex S1 r1 P1: never a bare string), so it is skipped exactly as today, and the runtime mode is not even read.
const { createExtrasModeReader } = require('./extras-intake');
const OFF = createExtrasModeReader({ read: async () => null });   // a successful read of an absent node = off (the factory's rule)
async function modeFor(body, getRuntimeMode) {
  return require('../delivery/delivery-wire').isApp(body) ? getRuntimeMode() : OFF.getMode();
}
module.exports = { modeFor };
