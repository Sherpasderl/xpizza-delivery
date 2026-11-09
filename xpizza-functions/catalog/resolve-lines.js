'use strict';
// ---------------------------------------------------------------------------
// S1b (PLAN-portal-item-edit r6 §2.4; design D4c-grill/item-s1/S1b-DESIGN.md + the advisor's rulings) — THE RESOLUTION STAGE.
// Every cart endpoint runs it before any check, price, reward step or fingerprint: each line (and each reward line) must name
// a key the request's own tables hold, by EXACT string equality on that key — never by coercion — and the key it resolved to
// is stamped on the line (PRICING_KEY_STAMP), which every accessor-reading consumer already prefers.
// STRICT in S1b: a line carrying `item_key` must ALSO carry its legacy field (name on a name-keyed menu, id on an id-keyed one)
// and the two must be equal. So every accepted line resolves to exactly the key it priced by before this stage existed — a
// no-op on money by construction. S1d widens the agreement to the version's label (and only then may a key differ from it).
// A cart this stage does not judge (not a non-empty array of objects, or no tables) passes through untouched, so the
// validator keeps today's errors. Pure: reads nothing; the only write is the stamp, and only on full success.
// ---------------------------------------------------------------------------
const { PRICING_KEY_STAMP, keyModeOfTables, availIdentityField } = require('../menu-pricing');

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const MENU_CHANGED_DETAIL = 'El menú se actualizó, recargá la página';

// One line's resolution: { key } or { code }. `field` is the legacy field ('name' | 'id'); `itemKeyField` names the line's
// item_key property (always 'item_key').
function resolveOne(line, field, menu) {
  const hasKey = own(line, 'item_key') && line.item_key !== undefined && line.item_key !== null;
  const hasLegacy = own(line, field) && line[field] !== undefined && line[field] !== null;
  if (hasKey && (typeof line.item_key !== 'string' || !line.item_key)) return { code: 'invalid_line' };
  if (hasLegacy && typeof line[field] !== 'string') return { code: 'invalid_line' };
  if (hasKey && hasLegacy && line.item_key !== line[field]) return { code: 'invalid_line' };
  if (hasKey && !hasLegacy) return { code: 'menu_changed' };      // S1b: no label to judge it by yet — never priced
  if (!hasLegacy) return { code: 'menu_changed' };
  const key = line[field];
  return own(menu, key) ? { key } : { code: 'menu_changed' };
}

// The reward lines of a body, as [line, field] pairs: redeem.items[] when it is an array, else the redeem object itself
// (its `item_id` read as the legacy field) when it names an item. A redeem naming no item is not judged.
function rewardLines(redeem) {
  if (!isObj(redeem)) return [];
  if (Array.isArray(redeem.items)) return redeem.items.map((it) => [it, 'id']);
  if (own(redeem, 'item_id') || own(redeem, 'item_key')) return [[redeem, 'item_id']];
  return [];
}

function resolveLines(rid, body, tables) {
  if (!isObj(body) || !isObj(tables) || !isObj(tables.menu)) return { ok: true };
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0 || !items.every(isObj)) return { ok: true };
  const field = availIdentityField(rid, keyModeOfTables(tables));
  const menu = tables.menu;
  const stamps = [];
  for (let i = 0; i < items.length; i++) {
    const r = resolveOne(items[i], field, menu);
    if (r.code) return { ok: false, code: r.code, at: 'items', index: i };
    stamps.push([items[i], r.key]);
  }
  const rewards = rewardLines(body.redeem);
  for (let i = 0; i < rewards.length; i++) {
    const [line, f] = rewards[i];
    if (!isObj(line)) return { ok: false, code: 'invalid_line', at: 'redeem', index: i };
    // a reward line's legacy field is item_id (x_pizza style) or items[].id; it agrees with item_key exactly as a cart line
    const r = resolveOne(f === 'item_id' ? { item_key: line.item_key, item_id: line.item_id } : line, f === 'item_id' ? 'item_id' : field, menu);
    if (r.code) return { ok: false, code: r.code, at: 'redeem', index: i };
  }
  for (const [line, key] of stamps) line[PRICING_KEY_STAMP] = key;
  return { ok: true };
}

// The order endpoints' refusal. (The quotes keep their own fail-soft envelope and read `code` directly.)
function resolutionRefusal(res) {
  if (res && res.code === 'menu_changed') return { status: 409, body: { error: 'menu_changed', detail: MENU_CHANGED_DETAIL, retryable: false } };
  return { status: 400, body: { error: 'invalid_line', at: res && res.at, index: res && res.index } };
}

module.exports = { resolveLines, resolutionRefusal, MENU_CHANGED_DETAIL };
