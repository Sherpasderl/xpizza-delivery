'use strict';
/* THE PLATFORM RENDER PIN for the frozen call-sequence suites (1D add-product B, PB-2 advisor ruling (A)).
 *
 * 🔴 WHY. d4b-charge-trace, pselfupdate-quote-trace, order-exists and order-control compare the REAL handlers' DB call
 * sequences with goldens frozen BEFORE the platform render capability existed. PB-2 turns render ON (the generated
 * catalog/platform-render.generated.js), and with it the render-gated code is live: quote reads the intake gates, a reward
 * charge runs the bound-reuse probe, a reward order is written with its charge-input fingerprint. Those suites stay the
 * proof of the render-OFF path (the rollback path, still shipped), so each one PINS render off here, asserts the pin took
 * effect, and adds render-ON companion cells that assert the exact delta against the render-OFF trace of the SAME run.
 *
 * The switch is read per call (catalog/platform-groups.js readRender → require('./platform-render.generated')), so the
 * pin swaps the module's cached exports for a MUTABLE object and setRender() flips it between requests — no file edit,
 * no reload. Load this BEFORE ../index.js.
 */
const assert = require('assert');
const P = require.resolve('../catalog/platform-render.generated');
const SHIPPED = require(P).render;   // what the generated artifact really says (read before the pin replaces it)
const state = { render: false };
require.cache[P].exports = state;
const { groupCapabilities } = require('../catalog/platform-groups');

// flip the switch and prove the reader the handlers use now answers that value
function setRender(on) {
  state.render = on === true;
  assert.strictEqual(groupCapabilities().render, state.render, `render pin: groupCapabilities().render must read ${state.render}`);
  return state.render;
}
async function withRender(on, fn) {
  const prev = state.render;
  setRender(on);
  try { return await fn(); } finally { setRender(prev); }
}
setRender(false);

module.exports = { setRender, withRender, SHIPPED, render: () => state.render };
