'use strict';
// PLAN 4 (bake from published, r3 §8.1, OWNER RULING (a) 2026-10-26) — the CLOSED set a dish's `reward_icon` may name.
//
// The reward picker draws `<use href="#rk-i-<icon>">` from the sprite both forms' account.js carry. An icon outside the
// sprite draws NOTHING, silently — so the catalog may only name a dish icon the sprite actually has. The sprite's chrome
// symbols (check, gift, star) are UI, not dishes, and are not offered. reward-icons.test.js reads both forms' sprites and
// fails if this list names a symbol either one lacks, so the set cannot drift from what renders.
const REWARD_ICONS = Object.freeze([
  'bacon', 'cheese', 'chili', 'dumpling', 'fish', 'glass', 'leaf', 'meat', 'mushroom', 'noodle', 'rice', 'skewer',
  'slice', 'soup', 'tomato',
]);

module.exports = { REWARD_ICONS };
