'use strict';
// S2-core (PLAN-structure-S2core-r3 §1.1) — the platform switches for menu-STRUCTURE authoring, ONE value for every restaurant (never per
// brand). Each is read on BOTH save and publish (editCatalog, publishEdited, catalogRequestPublish): a draft saved while a switch was on
// cannot publish its structure change after it is turned off. Flipped in its own commit, after its portal ships.
//   extrasCatalog — the «Extras» page: add / remove / reprice extras, create a group, attach / detach groups, the one group order (S2-core)
//   choiceEdit    — the required choice on an existing dish (S3)
//   sections      — categories / subcategories, moves, reorders (S4)
const EXTRAS_CATALOG = true; const CHOICE_EDIT = false;   // S3 (PLAN-structure-S3-r3): choiceEdit OFF at ship; flipped in its own commit after the portal's choice editor ships
function structureCapabilities() {
  return { extrasCatalog: EXTRAS_CATALOG === true, choiceEdit: CHOICE_EDIT === true, sections: false };
}
// LEGACY-FORM reward pickers (Codex #119 P2): while the legacy order forms remain, a frozen form's reward picker offers EVERY extra of a
// group that holds a reward-eligible extra (la-musa-orders buildRedeemCatalog), and no new extra is ever server-eligible — so a NEW extra
// in such a group is refused (reward_group_add_blocked, add-product extrasCatalogClaims). RETIRE with the legacy forms (owner 11-01), beside
// the S2b renames switch (extra-identity MINT_OPAQUE_EXTRAS): set false, then delete the guard.
const LEGACY_FORM_REWARD_PICKERS = true;
const legacyFormRewardPickers = () => LEGACY_FORM_REWARD_PICKERS === true;
module.exports = { structureCapabilities, legacyFormRewardPickers };
