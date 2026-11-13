'use strict';
// S2b (PLAN-structure-S2b-r3 §6, Codex r2 P1-1) — the ADMISSION GATE. While MINT_OPAQUE_EXTRAS is ON (catalog/extra-identity.js), the 4
// identity intakes admit only the customer app: X-Client-App = the orders app AND X-Client-Deployment one of the manifest's platform
// orders deployment + its declared native deployment (PLATFORM.isAppDeployment — manifest DATA, no brand literal). Everything else — every
// restaurant-context orders deployment (the frozen forms), a header-less request (an unstamped / cached form), an unknown or foreign
// deployment — is refused client_retired (410), on the client_version log line, before the floor read and any reservation, charge or
// write. NOT authentication: X-Client-* are client-asserted; the gate retires HONEST frozen clients, and every payload rule applies
// independently of it. OFF → null for every request (no check). Pure; reads nothing (the manifest is module data).
const { PLATFORM } = require('../platform-manifest');
const RETIRED = Object.freeze({ status: 410, body: Object.freeze({ error: 'client_retired' }) });

function retiredClientRefusal(h) {
  if (!require('./extra-identity').extraIdentityCapabilities().mintExtras) return null;
  return h && h.app === 'orders' && PLATFORM.isAppDeployment(h.deployment) ? null : RETIRED;
}

module.exports = { retiredClientRefusal };
