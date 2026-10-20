'use strict';
// PLAN-portal-membership (codex build r1 P1-1) — the slice's test-only index.js INVERSE. ONE same-line hunk (the membership:begin/end
// team block appended to the sendPaidAfterCloseRefund export line — no line shift, so no R3 region bind moves; not a portal-split
// fold site); unapplyMembershipIndex
// swaps it back, so the result === e8e77e24:index.js byte-for-byte (membership-wiring.guard). It is the NEWEST slice: every
// index.js fold applies it FIRST.
const BASE = 'e8e77e24';
const HUNKS = Object.freeze([
 {
  "file": "index.js",
  "now": "module.exports.sendPaidAfterCloseRefund = sendPaidAfterCloseRefund;   /* membership:begin team — PLAN-portal-membership (codex build r1 P1-1): the team endpoints, DARK behind platform_config/membership_writes_enabled */ const MEMBERSHIP_TEAM = require('./access/team-http'); exports.memberInvite = MEMBERSHIP_TEAM.memberInvite; exports.memberAcceptInvite = MEMBERSHIP_TEAM.memberAcceptInvite; exports.memberCancelInvite = MEMBERSHIP_TEAM.memberCancelInvite; exports.memberReissueInvite = MEMBERSHIP_TEAM.memberReissueInvite; exports.memberRevoke = MEMBERSHIP_TEAM.memberRevoke; exports.memberSetMenuPermission = MEMBERSHIP_TEAM.memberSetMenuPermission; exports.memberList = MEMBERSHIP_TEAM.memberList;   /* membership:end team */\n",
  "was": "module.exports.sendPaidAfterCloseRefund = sendPaidAfterCloseRefund;\n"
 }
]);
function unapply(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const k = out.split(h.now).length - 1;
    if (k !== 1) throw new Error(`membership-inverse: hunk occurs ${k} times in ${file} (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const unapplyMembershipIndex = (src) => unapply('index.js', src);
module.exports = { BASE, HUNKS, unapply, unapplyMembershipIndex };
