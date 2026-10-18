'use strict';
// H1a A-R1 — the ONE slot through which index.js's h1 block hands the merchant reject the EXISTING cancel core
// (cancelOrderCore bound to cancelDeps). Nothing under merchant/ requires a money module (merchant-no-money.guard);
// merchant-wiring reads the slot at call time and refuses if it was never bound.
let core = null;
function bindCancelCore(fn) {
  if (typeof fn !== 'function') throw new Error('merchant-core-binding: cancel core must be a function');
  core = fn;
}
function cancelCore() {
  if (!core) throw new Error('merchant-core-binding: cancel core not bound');
  return core;
}
module.exports = { bindCancelCore, cancelCore };
