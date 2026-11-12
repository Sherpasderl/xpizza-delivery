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
// D4 row 16 (advisor 11-12): the reject's DEPLOY secrets, injected by index.js beside the cancel core (the reject reaches the SDK
// void through that core). Read at merchant-wiring's load; unbound ⇒ [] (an isolated loader) — sdk-config-bindings.guard enforces
// the production binding from the real manifest.
let rejectSecretList = null;
function bindRejectSecrets(list) {
  if (!Array.isArray(list)) throw new Error('merchant-core-binding: reject secrets must be an array');
  rejectSecretList = list.slice();
}
const rejectSecrets = () => (rejectSecretList ? rejectSecretList.slice() : []);
module.exports = { bindCancelCore, cancelCore, bindRejectSecrets, rejectSecrets };
