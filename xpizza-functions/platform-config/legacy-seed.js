'use strict';
// CONVERGENCE §1 — the BREAK-GLASS seed (plan §0): today's code constants for the two founding restaurants, as v1 platform-config
// fields. It exists to populate the portal source ONCE (tools/seed-platform-source.js, owner-run, dry-run first, REFUSES to overwrite
// an existing source) and as the both-brands GOLDEN: each field is read from the very constant its consumer uses today, so the
// projection provably encodes today's behaviour. Any other restaurant has NO legacy seed (null) — its config is portal-authored.
const W = require('../whatsapp');
const WI = require('../whatsapp_inbound');
const { REWARDS_CONFIG } = require('../rewards-core');
const { REDEMPTION_CONFIG } = require('../rewards-redeem-config');
const { DEFAULT_COLD_START_MIN } = require('../ready-time-predict');

const FOUNDING = ['x_pizza', 'la_musa'];
// the ready-time model walks the rings for x_pizza only (ready-time-predict.js `restaurant !== 'x_pizza'` ⇒ cold start)
const HAS_ITEMS_SCHEMA = { x_pizza: true, la_musa: false };
// La Musa's rate is 10/3 points per lempira (rewards-redeem-config REDEEM_POINTS_PER_LEMPIRA) — carried as the exact ratio
const RATE = { la_musa: { points: 10, per_lempiras: 3 } };

function legacyFieldsFor(rid) {
  if (!FOUNDING.includes(rid)) return null;
  const rc = REWARDS_CONFIG[rid], dc = REDEMPTION_CONFIG[rid];
  const earn = rc.kind === 'punch' ? { kind: 'punch' } : { kind: 'points', points_per: rc.pointsPer, per_cents: rc.perCents };
  const redemption = dc.kind === 'punch' ? { kind: 'punch', cost: dc.cost, reward: dc.reward }
    : { kind: 'points', reward: dc.reward, rate: RATE[rid], exclude: [...dc.exclude] };
  return {
    whatsapp_copy: { items_emoji: W.itemsEmojiFor(rid), ready_line: W.readyLineFor(rid), ack_emoji: WI.configFor(rid).ackEmoji },
    rewards: { earn, welcome: rc.welcome, goal: rc.goal, redemption },
    ready_time: { cold_start_min: DEFAULT_COLD_START_MIN[rid], has_items_schema: HAS_ITEMS_SCHEMA[rid] },
  };
}

module.exports = { legacyFieldsFor, FOUNDING };
