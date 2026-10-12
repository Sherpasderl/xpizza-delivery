'use strict';
// ---------------------------------------------------------------------------
// 1D add-product PHASE B (rev 6, UNIFORM, plan §0c.7) — the TWO platform-wide switches for required-choice groups.
// There is NO per-brand value here: what differs between restaurants is data, never group behaviour.
//
//   render    — the deployed customer forms can SHOW groups (the shared picker module). It turns on the platform
//               group RULES at intake / quote / redemption: a bare launcher is non-orderable and non-redeemable,
//               and a choice is available only if it AND its launcher are (§0d.4). GENERATED from the shipped forms
//               (catalog/platform-render.generated.js: true only when every form declares GROUP_PICKER_V1), so it
//               flips with the form barrier (§0b.3(b)/(c)). PB-1 ships it false (no form carries the picker yet).
//   authoring — SAVE / PUBLISH accept NEW groups. One platform constant, flipped in its own commit only with/after
//               the portal deploy (§0b.3(e)). Until then every brand's new group is refused (choices_not_supported_yet).
//
// FAIL-CLOSED: a present-but-malformed render artifact throws at read (a switch that cannot be read is not "on").
// ---------------------------------------------------------------------------
const AUTHORING = true;    // §0b.3(e): flipped AFTER the PB-3 portal deploy (2cb5a1c live: 5 portal functions + the portal)

// The artifact's shape, judged on its own (pure — the reader below only supplies it).
function parseRender(mod) {
  if (!mod || typeof mod !== 'object' || typeof mod.render !== 'boolean') {
    throw new Error('platform_groups_malformed: catalog/platform-render.generated.js must export { render: boolean }');
  }
  return mod.render;
}

function readRender() {
  return parseRender(require('./platform-render.generated'));
}

function groupCapabilities() {
  return { render: readRender(), authoring: AUTHORING === true };
}

module.exports = { groupCapabilities, parseRender };
