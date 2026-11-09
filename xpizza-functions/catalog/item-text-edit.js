'use strict';
// ---------------------------------------------------------------------------
// S1a (PLAN-portal-item-edit r6 §5, step 7) — the ONE platform switch for editing an existing product's text: name, description,
// category and subcategory (a required-choice group renames as one unit). There is NO per-brand value: it flips for every
// restaurant together, and only after the resolution stage and the clients that send item_key have shipped.
// OFF: every save, publish and assessment is judged exactly as before. Rollback = OFF; renames ALREADY recorded stay accepted
// (catalog/frozen-keys.js), so switching off never strands a menu.
// ---------------------------------------------------------------------------
const ITEM_TEXT_EDIT = false;

function textEditCapabilities() {
  return { enabled: ITEM_TEXT_EDIT === true };
}

module.exports = { textEditCapabilities };
