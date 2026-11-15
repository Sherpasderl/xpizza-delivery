'use strict';
// S2b (PLAN-structure-S2b-r3 owner decision 11-12) — the DARK switch for extra identities: extra renames (the key kept) and the reuse of
// a retired extra name under a fresh server-minted key. ONE value for every restaurant, OFF at ship; turned ON only after the old order
// forms retire (rule 40), behind the admission gate (§6). Its own module (not mint-opaque.js) so the MINT flip's one-line commit and this
// switch never touch the same lines. FROZEN_FORM_SOURCES: the frozen forms' sources in the tree — the repo guard
// (mint-extras-forms.guard) fails while the switch is ON and any of them is still present.
const MINT_OPAQUE_EXTRAS = false;
const FROZEN_FORM_SOURCES = Object.freeze(['xpizza-orders/index.html', 'la-musa-orders/index.html']);

function extraIdentityCapabilities() {
  return { mintExtras: MINT_OPAQUE_EXTRAS === true };
}

module.exports = { extraIdentityCapabilities, FROZEN_FORM_SOURCES };
