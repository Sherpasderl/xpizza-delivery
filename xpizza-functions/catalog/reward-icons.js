'use strict';
// PLAN 4 (bake from published, r3 §8.1, OWNER RULING (a) 2026-10-26) — the CLOSED set a dish's `reward_icon` may name.
//
// The reward picker draws `<use href="#rk-i-<icon>">` from the sprite both forms' account.js carry. An icon outside the
// sprite draws NOTHING, silently — so the catalog may only name an icon the sprite actually has. The sprite's two chrome
// symbols (check, gift) are UI and are not offered; `star` is a row icon today (la_musa's house specials). On a dish, and
// on an extra the picker offers (la_musa's acompañamientos). plan4-display-fields.test.js reads both forms' sprites and
// fails if this list and the sprite's row symbols ever differ, so the set cannot drift from what renders.
const REWARD_ICONS = Object.freeze([
  'bacon', 'cheese', 'chili', 'dumpling', 'fish', 'glass', 'leaf', 'meat', 'mushroom', 'noodle', 'rice', 'skewer',
  'slice', 'soup', 'star', 'tomato',
]);

module.exports = { REWARD_ICONS };
