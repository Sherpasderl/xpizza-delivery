'use strict';
// CONVERGENCE §1 (NOTE-convergence-server-lane-build + advisor rulings 2026-11-02) — the per-restaurant PLATFORM CONFIG schema, v1.
// The portal source store (Firestore restaurants/{rid}/meta/platform_source — server-only by the meta/* default-deny) is AUTHORITATIVE;
// RTDB restaurants/{rid}/platform_config is its generated, validated PROJECTION (server-only, the generator its ONLY writer).
// Every field is validated here, strictly — an unknown key, a wrong type or an out-of-range value REFUSES (fail-closed: a half-valid
// config is never projected). Sections (each consumer converts after step 0, rows 2.1+):
//   whatsapp_copy  { items_emoji, ready_line, ack_emoji }                       (row 2.3 — deployment URLs stay in the sites.json projection)
//   rewards        null | { earn, welcome, goal, redemption }                   (row 2.6 — null = the restaurant runs no rewards)
//                  earn: { kind:'punch' } | { kind:'points', points_per, per_cents }
//                  redemption: { kind:'punch', cost, reward } | { kind:'points', reward, rate:{ points, per_lempiras }, exclude:[glob] }
//                  (the rate is an exact RATIO — La Musa's 10/3 — never a float)
//   ready_time     { cold_start_min, has_items_schema }                         (row 2.7)
// NOT here (rulings): the pricing keying / extras model (CATALOG VERSION, G), the fiscal mode (factura_config/mode, E), WhatsApp
// credentials (the WHATSAPP_CREDENTIALS secret, C), hubs / hours / labels (identity, already data).
const SCHEMA_VERSION = 1;
const SECTIONS = ['whatsapp_copy', 'rewards', 'ready_time'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && !/[<>\u0000-\u001f\u007f]/.test(v);
const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const exact = (o, keys) => isObj(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));

function bad(path) { const e = new Error(`platform_config_invalid: ${path}`); e.code = 'platform_config_invalid'; return e; }

function checkWhatsappCopy(w) {
  if (!exact(w, ['items_emoji', 'ready_line', 'ack_emoji'])) throw bad('whatsapp_copy');
  if (!str(w.items_emoji, 1, 8)) throw bad('whatsapp_copy.items_emoji');
  if (!str(w.ready_line, 1, 120)) throw bad('whatsapp_copy.ready_line');
  if (!str(w.ack_emoji, 0, 8)) throw bad('whatsapp_copy.ack_emoji');
}
function checkRewards(r) {
  if (r === null) return;
  if (!exact(r, ['earn', 'welcome', 'goal', 'redemption'])) throw bad('rewards');
  const e = r.earn;
  if (isObj(e) && e.kind === 'punch') { if (!exact(e, ['kind'])) throw bad('rewards.earn'); }
  else if (isObj(e) && e.kind === 'points') { if (!exact(e, ['kind', 'points_per', 'per_cents']) || !int(e.points_per, 1, 10000) || !int(e.per_cents, 1, 10000000)) throw bad('rewards.earn'); }
  else throw bad('rewards.earn.kind');
  if (!int(r.welcome, 0, 100000)) throw bad('rewards.welcome');
  if (!int(r.goal, 1, 1000000)) throw bad('rewards.goal');
  const d = r.redemption;
  if (!isObj(d) || d.kind !== e.kind) throw bad('rewards.redemption.kind');   // earn and redeem are ONE unit (hand-synced today)
  if (d.kind === 'punch') {
    if (!exact(d, ['kind', 'cost', 'reward']) || !int(d.cost, 1, 1000) || !str(d.reward, 1, 60)) throw bad('rewards.redemption');
  } else {
    if (!exact(d, ['kind', 'reward', 'rate', 'exclude']) || !str(d.reward, 1, 60)) throw bad('rewards.redemption');
    if (!exact(d.rate, ['points', 'per_lempiras']) || !int(d.rate.points, 1, 100000) || !int(d.rate.per_lempiras, 1, 100000)) throw bad('rewards.redemption.rate');
    if (!Array.isArray(d.exclude) || d.exclude.length > 50 || !d.exclude.every((g) => typeof g === 'string' && /^[a-z0-9_]{1,40}\*?$/.test(g))) throw bad('rewards.redemption.exclude');
  }
}
function checkReadyTime(t) {
  if (!exact(t, ['cold_start_min', 'has_items_schema'])) throw bad('ready_time');
  if (!int(t.cold_start_min, 1, 180)) throw bad('ready_time.cold_start_min');
  if (typeof t.has_items_schema !== 'boolean') throw bad('ready_time.has_items_schema');
}

// the FIELDS of a config (the source's or the projection's payload): exactly the v1 sections, each valid. → the fields (a deep copy)
function validateFields(f) {
  if (!exact(f, SECTIONS)) throw bad('sections');
  checkWhatsappCopy(f.whatsapp_copy); checkRewards(f.rewards); checkReadyTime(f.ready_time);
  return JSON.parse(JSON.stringify(f));
}

module.exports = { SCHEMA_VERSION, SECTIONS, validateFields };
