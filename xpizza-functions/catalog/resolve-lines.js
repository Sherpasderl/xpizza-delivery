'use strict';
// ---------------------------------------------------------------------------
// S1b (PLAN-portal-item-edit r6 §2.4; design D4c-grill/item-s1/S1b-DESIGN.md + the advisor's rulings) — THE RESOLUTION STAGE.
// Every cart endpoint runs it before any check, price, reward step or fingerprint: each line (and each reward line) must name
// a key the request's own tables hold, by EXACT string equality on that key — never by coercion — and the key it resolved to
// is stamped on the line (PRICING_KEY_STAMP), which every accessor-reading consumer already prefers. Reward lines are stamped
// when they resolve and otherwise left to today's reward refusal (advisor ruling Q3; the frozen forms key on it).
// STRICT in S1b: a line carrying `item_key` must ALSO carry its legacy field (name on a name-keyed menu, id on an id-keyed one)
// and the two must be equal. So every accepted line resolves to exactly the key it priced by before this stage existed — a
// no-op on money by construction. S1d widens the agreement to the version's label (and only then may a key differ from it).
// A cart this stage does not judge (not a non-empty array of objects, no tables, or a line whose legacy field is not a
// well-typed string — advisor ruling, option A) passes through untouched, so today's refusals keep their codes and copy. Pure: reads nothing; the only write is the stamp, and only on full success.
// ---------------------------------------------------------------------------
const { PRICING_KEY_STAMP, keyModeOfTables, availIdentityField, labelsOfTables } = require('../menu-pricing');

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const MENU_CHANGED_DETAIL = 'El menú se actualizó, recargá la página';

// One line's resolution: { key } or { code }. `field` is the legacy field ('name' | 'id'); `itemKeyField` names the line's
// item_key property (always 'item_key').
function resolveOne(line, field, menu, labels) {
  const hasKey = own(line, 'item_key') && line.item_key !== undefined;   // an explicit null is malformed, not absent
  const hasLegacy = own(line, field) && line[field] !== undefined;
  if (hasKey && (typeof line.item_key !== 'string' || !line.item_key)) return { code: 'invalid_line' };
  if (hasLegacy && typeof line[field] !== 'string') return { code: 'invalid_line' };   // reached by reward lines only (a cart line is screened above)
  if (hasKey) {
    // S1d (ruling Q2): the key must be held by the tables; a legacy field, when present, must equal the key or — when this
    // route carries labels — the key's label (a renamed dish). An item_key alone resolves.
    if (!own(menu, line.item_key)) return { code: 'menu_changed' };
    if (hasLegacy && line[field] !== line.item_key && !(labels && own(labels, line.item_key) && labels[line.item_key] === line[field])) return { code: 'invalid_line' };
    return { key: line.item_key };
  }
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
  const labels = labelsOfTables(tables);
  // advisor ruling (option A): only well-typed legacy keys are judged. A line whose legacy field is present but not a string
  // (null included), or that names nothing at all, is today's refusal (item_malformed with its customer copy, or pricing's
  // own 400) — the whole cart passes through unstamped so that refusal answers exactly as before this stage existed.
  if (items.some((l) => (own(l, field) && l[field] !== undefined) ? typeof l[field] !== 'string' : !(own(l, 'item_key') && l.item_key !== undefined))) return { ok: true };
  const stamps = [];
  for (let i = 0; i < items.length; i++) {
    const r = resolveOne(items[i], field, menu, labels);
    if (r.code) return { ok: false, code: r.code, at: 'items', index: i };
    stamps.push([items[i], r.key]);
  }
  // reward lines (advisor ruling Q3): stamped only when they resolve. Any other reward line is NOT refused here — it falls
  // through to prepareRedemption and today's 409 redemption_invalid, which the frozen forms' classifyRedeemError handles.
  for (const [line, f] of rewardLines(body.redeem)) {
    if (!isObj(line)) continue;
    const r = resolveOne(f === 'item_id' ? { item_key: line.item_key, item_id: line.item_id } : line, f === 'item_id' ? 'item_id' : field, menu, labels);
    if (r.key && own(line, f) && line[f] !== undefined) stamps.push([line, r.key]);   // S1d: a reward line still needs its legacy field (today's refusal answers otherwise)
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
