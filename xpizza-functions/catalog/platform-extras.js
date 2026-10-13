'use strict';
// ---------------------------------------------------------------------------
// PER-PRODUCT EXTRAS (PLAN-per-product-extras rev 2.1) — the platform AUTHORING switch. Platform-wide, never per brand:
// what differs between restaurants is data.
//
//   authoring — SAVE / PUBLISH accept a change to which extras a product takes: the typed, key-only
//               `exposure.item_overrides[item].deny_extras` and the `extras_policy` toggle on an EXISTING product
//               (compareToActive's ONE narrow exception). OFF until the portal checklist ships (§13 step 5). Enforced on
//               BOTH save and publish, so a draft saved while ON cannot publish such a change after it turns OFF.
//
// The customer-facing ENFORCEMENT mode (off | shadow | enforce) is a separate, runtime-read switch — not this constant.
// ---------------------------------------------------------------------------
const AUTHORING = false;   // §13 step 5: flipped with the portal checklist, after the forms + floor, in its own commit

function extrasCapabilities() {
  return { authoring: AUTHORING === true };
}

module.exports = { extrasCapabilities };
