'use strict';
// S1 (per-dish extras; owner decision 2026-11-11 «the frozen forms keep offering every extra until they retire») — the mode a request's
// extras are judged under: an APP entry (delivery-wire's ONE isApp rule: entry_mode 'app') keeps the runtime mode (off | shadow |
// enforce | unknown); any other request — a form cart — is judged as 'off', today's behaviour whatever the mode. Pure.
function modeForEntry(mode, body) {
  return require('../delivery/delivery-wire').isApp(body) ? mode : 'off';
}
module.exports = { modeForEntry };
