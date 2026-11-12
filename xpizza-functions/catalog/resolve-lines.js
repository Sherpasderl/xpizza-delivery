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
const { PRICING_KEY_STAMP, keyModeOfTables, availIdentityField, labelsOfTables, extraPricingKey } = require('../menu-pricing');

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const MENU_CHANGED_DETAIL = 'El menú se actualizó, recargá la página';

// One line's resolution: { key } or { code }. `field` is the legacy field ('name' | 'id'); `itemKeyField` names the line's
// item_key property (always 'item_key').
function resolveOne(line, field, menu, labels, strict = false) {
  const hasKey = own(line, 'item_key') && line.item_key !== undefined;   // an explicit null is malformed, not absent
  const hasLegacy = own(line, field) && line[field] !== undefined;
  if (hasKey && (typeof line.item_key !== 'string' || !line.item_key)) return { code: 'invalid_line' };
  if (hasLegacy && typeof line[field] !== 'string') return { code: 'invalid_line' };   // reached by reward lines only (a cart line is screened above)
  if (hasKey) {
    // S2 «item_key wins» (advisor 2026-11-10; reverses S1d Q2's agreement clause): a key the tables hold decides the line whatever
    // its legacy field says — the legacy field is advisory, price and description follow the key. A reward line stays STRICT
    // (S1d-R2): its legacy id must equal the key, so the reward calculators, which read the legacy id, see the resolved key.
    if (!own(menu, line.item_key)) return { code: 'menu_changed' };
    if (strict && hasLegacy && line[field] !== line.item_key) return { code: 'invalid_line' };
    return { key: line.item_key };
  }
  if (!hasLegacy) return { code: 'menu_changed' };
  const key = line[field];
  return own(menu, key) ? { key } : { code: 'menu_changed' };
}

// The reward lines of a body, as [line, field] pairs: redeem.items[] when it is an array, else the redeem object itself
// (its `item_id` read as the legacy field) when it names an item. A redeem naming no item is not judged.
function rewardLines(redeem, rid) {
  if (!isObj(redeem)) return [];
  // S2 A2: the line the brand's reward CALCULATOR consumes (rewards-redeem.js), by its reward model — never the body's shape
  const model = (require('../rewards-redeem-config').REDEMPTION_CONFIG[rid] || {}).reward;
  if (model === 'free_pizza_choice') return (own(redeem, 'item_id') || own(redeem, 'item_key')) ? [[redeem, 'item_id']] : [];
  if (model === 'points_ala_carte') return Array.isArray(redeem.items) ? redeem.items.map((it) => [it, 'id']) : [];
  if (Array.isArray(redeem.items)) return redeem.items.map((it) => [it, 'id']);
  if (own(redeem, 'item_id') || own(redeem, 'item_key')) return [[redeem, 'item_id']];
  return [];
}

// S2 A2 (Codex S2 code r1 P1-2): a KEYED reward line is judged FIRST and on its own — before any cart early return or the
// legacy-cart passthrough — against the namespace its CALCULATOR consumes (points_ala_carte: the dishes, then the extras;
// free_pizza_choice: the dishes). A malformed key, or a legacy id that is not the key → invalid_line; a key the namespace does
// not hold → menu_changed. Never discarded, so a keyed reward can never be fulfilled by its legacy id. A key-less reward line
// keeps today's passthrough (advisor ruling Q3).
function keyedRewardRefusal(rid, redeem, tables) {
  const model = (require('../rewards-redeem-config').REDEMPTION_CONFIG[rid] || {}).reward;
  const ns = model === 'points_ala_carte' ? { ...(isObj(tables.extras) ? tables.extras : {}), ...tables.menu } : tables.menu;
  const rls = rewardLines(redeem, rid);
  for (let i = 0; i < rls.length; i++) {
    const [line, f] = rls[i];
    if (!isObj(line) || !(own(line, 'item_key') && line.item_key !== undefined)) continue;
    const k = line.item_key;
    if (typeof k !== 'string' || !k) return { ok: false, code: 'invalid_line', at: 'redeem', index: i };
    if (own(line, f) && line[f] !== undefined && line[f] !== k) return { ok: false, code: 'invalid_line', at: 'redeem', index: i };
    if (!own(ns, k)) return { ok: false, code: 'menu_changed', at: 'redeem', index: i };
  }
  return null;
}

function resolveLines(rid, body, tables) {
  if (!isObj(body) || !isObj(tables) || !isObj(tables.menu)) return { ok: true };
  { const rk = keyedRewardRefusal(rid, body.redeem, tables); if (rk) return rk; } { const xk = require('./extra-key-intake').extraKeyRefusal(rid, body, tables); if (xk) return xk; } { const xl = require('./extra-labels').extraLabelRefusal(rid, body, tables); if (xl) return xl; }   // S2b §2.1: a cart extra's extra_key, before any money step
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0 || !items.every(isObj)) return { ok: true };
  const field = availIdentityField(rid, keyModeOfTables(tables));
  const menu = tables.menu;
  const labels = labelsOfTables(tables);
  // advisor ruling (option A): only well-typed legacy keys are judged. A line whose legacy field is present but not a string
  // (null included), or that names nothing at all, is today's refusal (item_malformed with its customer copy, or pricing's
  // own 400) — the whole cart passes through unstamped so that refusal answers exactly as before this stage existed.
  // S2 A: only a cart with NO item_key anywhere (today's clients) may pass through; a keyed cart is judged line by line.
  const keyed = items.some((l) => own(l, 'item_key') && l.item_key !== undefined);
  if (!keyed && items.some((l) => (own(l, field) && l[field] !== undefined) ? typeof l[field] !== 'string' : !(own(l, 'item_key') && l.item_key !== undefined))) return { ok: true };
  const stamps = [];
  for (let i = 0; i < items.length; i++) {
    const r = resolveOne(items[i], field, menu, labels);
    if (r.code) return { ok: false, code: r.code, at: 'items', index: i };
    stamps.push([items[i], r.key]);
  }
  // S2-core (PLAN-structure-S2core-r3 §1.4): every cart EXTRA, by the key pricing reads (extraPricingKey). A well-typed key the served
  // tables do not hold (a removed extra) is menu_changed, like a removed dish; a malformed extra is left to today's refusal.
  { const xt = isObj(tables.extras) ? tables.extras : {}; const km = keyModeOfTables(tables);
    for (let i = 0; i < items.length; i++) {
      const exs = items[i].extras;
      if (!Array.isArray(exs)) continue;
      for (let j = 0; j < exs.length; j++) {
        const k = isObj(exs[j]) ? extraPricingKey(exs[j], rid, km) : undefined;
        if (typeof k === 'string' && k && !own(xt, k)) return { ok: false, code: 'menu_changed', at: 'extras', index: i, extra: j };
      }
    } }
  // reward lines (advisor ruling Q3): stamped only when they resolve. Any other reward line is NOT refused here — it falls
  // through to prepareRedemption and today's 409 redemption_invalid, which the frozen forms' classifyRedeemError handles.
  const rls = rewardLines(body.redeem, rid);
  for (let i = 0; i < rls.length; i++) {
    const [line, f] = rls[i];
    if (!isObj(line)) continue;
    const r = resolveOne(f === 'item_id' ? { item_key: line.item_key, item_id: line.item_id } : line, f === 'item_id' ? 'item_id' : field, menu, null, true);   // codex S1d r1 #2: reward lines are never widened by label (exact, as today)
    if (r.code === 'invalid_line' && own(line, 'item_key') && line.item_key !== undefined) return { ok: false, code: 'invalid_line', at: 'redeem', index: i };   // S2 A2: a KEYED reward mismatch is refused before preparation
    if (r.key && own(line, f) && line[f] !== undefined) stamps.push([line, r.key]);   // S1d: a reward line still needs its legacy field (today's refusal answers otherwise)
  }
  for (const [line, key] of stamps) line[PRICING_KEY_STAMP] = key;
  return { ok: true };
}

// S1d D3: true when a line (or the reward line) resolved to an OPAQUE key this route has no label for — such a key may never be
// a factura description, so the order endpoints of a platform-factura restaurant refuse it (retryable) before any write.
function labelGap(body, tables) {
  const { OPAQUE_SYNTAX } = require('./mint-opaque');
  const labels = labelsOfTables(tables);
  const menu = isObj(tables) && isObj(tables.menu) ? tables.menu : {};
  const gap = (k) => typeof k === 'string' && OPAQUE_SYNTAX.test(k) && own(menu, k) && !(labels && typeof labels[k] === 'string');
  const cart = (isObj(body) && Array.isArray(body.items)) ? body.items : [];
  // codex S1d r1 #3 / r2 #1: the reward actually CONSUMED, stamped or not — exactly the field this restaurant's calculator reads
  // (its configured reward model): free_pizza_choice → redeem.item_id; points_ala_carte → redeem.items[].id. Nothing else.
  const r = isObj(body) && isObj(body.redeem) ? body.redeem : {};
  const cfg = require('../rewards-redeem-config').REDEMPTION_CONFIG[isObj(tables) ? tables.restaurantId : undefined];
  const model = cfg && cfg.reward;
  const rewards = model === 'free_pizza_choice' ? [r.item_id] : model === 'points_ala_carte' ? (Array.isArray(r.items) ? r.items.map((it) => (isObj(it) ? it.id : undefined)) : []) : [];
  return cart.some((l) => isObj(l) && gap(l[PRICING_KEY_STAMP])) || rewards.some(gap);
}

// The order endpoints' refusal. (The quotes keep their own fail-soft envelope and read `code` directly.)
function resolutionRefusal(res) { if (res && res.code === 'labels_unavailable') return { status: 503, body: { error: 'labels_unavailable', retryable: true } };   // S2b §4.3: an affected extra's label is not served
  if (res && res.code === 'menu_changed') return { status: 409, body: { error: 'menu_changed', detail: MENU_CHANGED_DETAIL, retryable: false } };
  return { status: 400, body: { error: 'invalid_line', at: res && res.at, index: res && res.index } };
}

module.exports = { resolveLines, labelGap, resolutionRefusal, MENU_CHANGED_DETAIL };
