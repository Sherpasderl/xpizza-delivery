'use strict';
// ---------------------------------------------------------------------------
// Portal 1B Task 1 — getPublicMenu CORE. The live 1A catalog, in the shape the forms already read.
//
// 🔴 THE PROJECTION IS THE GENERATOR'S. generate-form-bundle already turns a catalog snapshot into
// the bundle the two order forms consume, and 1A holds that output byte-identical to the committed
// artifacts. Writing a second projection here would put two answers to "what does a dish look like"
// in the tree, diverging the first time either is edited — which is the exact disease this whole
// initiative exists to cure. So the body IS the generator's output.
//
// What this module adds is the handful of fields the generator deliberately left behind. The forms
// read EXTRAS_BY_CATEGORY / EXTRAS_BY_ITEM / TAG_BADGES as literals today; nothing served them, so 1A
// carried them in `structure` and kept them out of the committed bundle rather than churn an artifact
// for data no one read. 1B is what serves them, so they join the body here — CARRIED from the
// structure, never re-derived.
//
// They are composed here rather than added to rebuildFormMenu on purpose: the committed bundles and
// the spliced forms must stay byte-identical through 1B (the no-regression rule), and widening the
// generator would move both. Flagged for the gate, because "reuse the transform" could be read as
// "widen the transform" and this is the other reading.
//
// TWO TYPED FAILURES, AND THE DIFFERENCE IS THE CALLER'S TO ACT ON:
//   public_menu_bad_rid      — the REQUEST is wrong. 4xx, and it will be wrong again on retry.
//   public_menu_unavailable  — the CATALOG cannot be served right now. 5xx, retryable, and the
//                              endpoint must not cache it.
// Neither ever carries a partial body. A half-menu renders as a menu.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { getRestaurantMenu } = require('./catalog-menu');
const { generateFormBundle } = require('./generate-form-bundle');
const { canonicalJson } = require('./canonical-json');

// Bumped whenever THIS module's projection changes — a field added, a shape altered, a generator
// change that moves the bundle. It is inside the etag, so a redeploy that changes the body also
// changes every cache key; without it, browsers and the CDN would keep serving the old body under
// the old key until their TTL expired, for a change that was supposed to be immediate.
const REPRESENTATION_VERSION = '1b.1';

// EVERY field this endpoint serves, declared. A field that reaches the body without being listed is
// one nobody decided to serve, and the etag would start moving for reasons no one chose.
const PUBLIC_MENU_BODY_FIELDS = Object.freeze([
  'dishes', 'extras', 'categories',
  'variant_items', 'has_photo',                 // la_musa
  'pickup_only_cats', 'weekend_only_cats',      // x_pizza
  'extras_by_category', 'extras_by_item', 'badges',
]);

// Carried from `structure` — the fields the generator leaves there. Order fixed so the body's own
// key order is stable across builds (the etag is over canonical JSON, but a stable body is easier to
// diff by eye, and an operator comparing two responses is a real thing that happens).
const CARRIED_FROM_STRUCTURE = Object.freeze(['extras_by_category', 'extras_by_item', 'badges']);

// The rid the platform will serve. Deliberately NOT resolveRestaurantId(): that function defaults a
// blank id to x_pizza, which is right for a form that has always posted none and wrong here, where
// the rid IS the request. Defaulting would serve one brand's menu to anyone who asked badly.
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

function fail(code, detail) {
  const e = new Error(`${code}: ${detail}`);
  e.code = code;
  throw e;
}

// ONE SCALAR. A query string yields an array when a parameter is repeated (`?rid=a&rid=b`), and
// `String(['a','b'])` is 'a,b' — which fails the pattern, but only by luck. Refusing the array
// outright means the rule does not depend on how a joined string happens to look.
async function assertServableRid(rid, { known, isActive }) {
  if (Array.isArray(rid)) fail('public_menu_bad_rid', 'the restaurant was stated more than once');
  if (typeof rid !== 'string') fail('public_menu_bad_rid', `expected one restaurant id, got ${rid === null ? 'null' : typeof rid}`);
  const trimmed = rid.trim();
  if (!trimmed) fail('public_menu_bad_rid', 'no restaurant was named');
  if (!RID_RE.test(trimmed)) fail('public_menu_bad_rid', `malformed restaurant id: ${trimmed.slice(0, 40)}`);
  const set = typeof known === 'function' ? known() : known;
  if (!set || typeof set.has !== 'function' || !set.has(trimmed)) {
    fail('public_menu_bad_rid', `unknown restaurant: ${trimmed.slice(0, 40)}`);
  }
  // INACTIVE IS NOT SERVABLE, and neither is "we cannot tell". A restaurant that has not launched
  // (la_musa, once) or has been switched off must not have its menu handed out, and an identity read
  // that fails is not evidence that it is on.
  let live = false;
  try {
    live = await isActive(trimmed);
  } catch (e) {
    fail('public_menu_bad_rid', `cannot confirm ${trimmed} is active: ${String((e && e.message) || e).slice(0, 80)}`);
  }
  if (!live) fail('public_menu_bad_rid', `${trimmed} is not currently serving`);
  return trimmed;
}

// The default activity check: the config-plane identity, which is the same gate order intake uses.
// Injected in tests, and by the endpoint, so this module needs no RTDB handle of its own.
const defaultIsActive = (rtdb) => async (rid) => {
  const { getIdentity } = require('../restaurant-config');
  const identity = await getIdentity(rtdb, rid);
  return !!(identity && identity.active);
};

async function buildPublicMenu(db, rid, deps = {}) {
  const { known, isActive, representationVersion = REPRESENTATION_VERSION, generate = generateFormBundle } = deps;
  const restaurantId = await assertServableRid(rid, { known, isActive });

  // THE LIVE CATALOG, through the 1A reader — which fails closed on an absent pointer, an incomplete
  // read, a torn version or a content-hash mismatch. Every one of those becomes "unavailable" here:
  // the distinction between them matters to an alarm, not to a customer, and the endpoint's job is to
  // not serve half a menu.
  let menu;
  try {
    menu = await getRestaurantMenu(db, restaurantId);
  } catch (e) {
    fail('public_menu_unavailable', `${restaurantId}: ${String((e && e.message) || e).slice(0, 160)}`);
  }

  // ATOMIC. The transform either produces a whole bundle or it throws — there is no path that returns
  // a body missing a collection. A menu with live dishes and bundled structure is the one outcome
  // worse than no menu, because it renders.
  let body;
  try {
    body = generate(restaurantId, menu);
    for (const f of CARRIED_FROM_STRUCTURE) {
      if (menu.structure[f] !== undefined) body[f] = menu.structure[f];
    }
  } catch (e) {
    fail('public_menu_unavailable', `${restaurantId}: the live catalog does not project to a servable menu — ${String((e && e.message) || e).slice(0, 160)}`);
  }

  const undeclared = Object.keys(body).filter((f) => !PUBLIC_MENU_BODY_FIELDS.includes(f));
  if (undeclared.length) {
    fail('public_menu_unavailable', `${restaurantId}: the projection produced undeclared fields (${undeclared.join(', ')})`);
  }

  // THE ETAG IS OVER THE REPRESENTATION — this rid, this projection version, this body. Not 1A's
  // content_hash: that identifies the VERSION, and what a cache holds is this module's projection of
  // it. Change the projection and the version hash has not moved, so every cache would keep serving
  // the old body under the old key. The rid is in it so two brands can never collide on one key.
  const etag = `"${crypto.createHash('sha256')
    .update(`${restaurantId} ${representationVersion} ${canonicalJson(body)}`)
    .digest('hex')}"`;

  // `seq` rides ALONGSIDE the body, not inside it. It moves on every publish — including ones that
  // change nothing a customer sees — so a body carrying it would produce a new etag for an identical
  // menu, and every cache would miss for no reason.
  return { rid: restaurantId, seq: menu.identity.seq, representation_version: representationVersion, body, etag };
}

module.exports = { buildPublicMenu, defaultIsActive, REPRESENTATION_VERSION, PUBLIC_MENU_BODY_FIELDS };
