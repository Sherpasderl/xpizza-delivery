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
const { applyIdentityToServedBody } = require('./identity-overlay');

// Bumped whenever THIS module's projection changes — a field added, a shape altered, a generator
// change that moves the bundle. It is inside the etag, so a redeploy that changes the body also
// changes every cache key; without it, browsers and the CDN would keep serving the old body under
// the old key until their TTL expired, for a change that was supposed to be immediate.
/* 1D D1: bumped because the served body can now carry dish_id/extra_id. The marker is inside the
   etag, so without the bump a cache would keep serving the id-less body under the old key — and a
   change that is supposed to be additive-and-immediate would instead be invisible for a TTL. */
const REPRESENTATION_VERSION = '1d.1';

// EVERY field this endpoint serves, and what has to be true of it. One table, because the list of
// what may appear and the rules for what must appear are the same fact — kept apart they drift, and
// the drift is invisible until a body is served with a collection missing.
//
// 🔴 BOTH DIRECTIONS. The first version checked only that nothing UNDECLARED appeared, and a
// projection returning a body with `extras` deleted sailed through with a valid etag — the
// "half-menu renders as a menu" outcome this module's own comment warns about. Asking "is anything
// here that shouldn't be" is half a question.
//
//   required     — every catalog has these. dishes and categories must be non-empty (a version
//                  cannot have zero items, and a dish's category must be declared), extras may be
//                  legitimately empty: a restaurant that sells no add-ons is a restaurant.
//   fromSource   — required IF THE CATALOG HAS IT, which is stronger than "optional" and needs no
//                  brand literal. Only la_musa has variant launchers and only x_pizza has gate
//                  categories today, but the rule is not about the brand: it is that a collection
//                  the catalog carries must reach the body. A generator that quietly drops la_musa's
//                  variant_items would otherwise pass, and every launcher would vanish from the form.
const BODY_CONTRACT = Object.freeze({
  dishes: { required: true, type: 'array', nonEmpty: true },
  extras: { required: true, type: 'array' },
  categories: { required: true, type: 'array', nonEmpty: true },
  variant_items: { type: 'object', fromSource: (menu) => menu.structure.variant_items !== undefined },
  has_photo: { type: 'array', fromSource: (menu) => menu.items.some((i) => i.has_photo !== undefined) },
  pickup_only_cats: { type: 'array', fromSource: (menu) => menu.structure.pickup_only_cats !== undefined },
  weekend_only_cats: { type: 'array', fromSource: (menu) => menu.structure.weekend_only_cats !== undefined },
  extras_by_category: { type: 'object', fromSource: (menu) => menu.structure.extras_by_category !== undefined },
  extras_by_item: { type: 'object', fromSource: (menu) => menu.structure.extras_by_item !== undefined },
  badges: { type: 'object', fromSource: (menu) => menu.structure.badges !== undefined },
});
const PUBLIC_MENU_BODY_FIELDS = Object.freeze(Object.keys(BODY_CONTRACT));

const isType = (v, t) => (t === 'array' ? Array.isArray(v) : (!!v && typeof v === 'object' && !Array.isArray(v)));

// The body is whole, or it is not served. Presence is by KEY: a collection explicitly set to
// undefined is absent, and reading it as "no opinion" is how a missing menu becomes a rendered one.
function assertWholeBody(restaurantId, body, menu) {
  const problems = [];
  for (const [field, rule] of Object.entries(BODY_CONTRACT)) {
    const present = Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined;
    const needed = rule.required || (rule.fromSource && rule.fromSource(menu));
    if (!present) {
      if (needed) problems.push(`${field} is missing${rule.required ? '' : ' although the catalog carries it'}`);
      continue;
    }
    if (!isType(body[field], rule.type)) problems.push(`${field} is not ${rule.type === 'array' ? 'an array' : 'an object'}`);
    else if (rule.nonEmpty && body[field].length === 0) problems.push(`${field} is empty`);
  }
  const undeclared = Object.keys(body).filter((f) => !PUBLIC_MENU_BODY_FIELDS.includes(f));
  for (const f of undeclared) problems.push(`${f} is served but undeclared`);
  if (problems.length) {
    fail('public_menu_unavailable', `${restaurantId}: the projection is not a whole menu — ${problems.join('; ')}`);
  }
}

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

  assertWholeBody(restaurantId, body, menu);

  /* ── 1D D1 — IDENTITY, APPLIED LAST AND ABLE TO FAIL ALONE ──────────────────────────────────────
     The body is already whole and already correct at this point: the version's hash was verified by
     the reader, the projection succeeded, and assertWholeBody has passed. Only now are ids laid on
     top, by registry lookup, on the customer-serving projection only.
     Placed HERE rather than inside the reader on purpose. The reader is shared with the gate read
     (previewVersion → gateReader), and enrichment trouble there could flip authored weekend or reward
     eligibility to a static fallback — a business answer changed by a decoration. Down here it cannot
     reach that path at all.
     applyIdentityToServedBody never throws and never blocks: on a registry error or a slow read it
     returns the body it was given, unchanged, and the customer is served a menu with no ids — which is
     exactly the menu served today, because in D1 nothing reads them. */
  const enriched = await applyIdentityToServedBody(db, restaurantId, body);
  body = enriched.body;
  if (!enriched.applied) {
    // A diagnostic, never a decision — no caller branches on it and no response changes shape.
    console.warn('public_menu_identity_absent', JSON.stringify({ rid: restaurantId, reason: enriched.reason }));
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

// HOW A FAILURE BECOMES AN HTTP RESPONSE. Pure, and here rather than in index.js, because the
// unexpected branch is otherwise unreachable from a test: nothing in the endpoint can be made to
// throw an untyped error on demand, so the one path that decides what an UNKNOWN failure looks like
// would be the only one nobody had ever seen run. A guard with no reachable test is a guard nobody
// has watched work.
//
// Every branch is no-store. The two typed ones differ in what a cached copy would cost — a cached
// 400 outlives a fixed link; a cached 503 keeps a restaurant dark for the TTL after it recovers —
// and the unknown one is no-store because "we do not know what went wrong" is never cacheable.
function publicMenuErrorResponse(e) {
  const code = e && e.code;
  if (code === 'public_menu_bad_rid') {
    return { status: 400, log: null, payload: { error: code, detail: String((e && e.message) || e).slice(0, 200) } };
  }
  if (code === 'public_menu_unavailable') {
    // Retryable, and logged: a menu that cannot be served is an incident even though the customer
    // only sees a form that did not refresh.
    return { status: 503, log: 'public_menu_unavailable', payload: { error: code, retryable: true } };
  }
  // An untyped failure says nothing to a customer and everything to a log.
  return { status: 500, log: 'public_menu_failed', payload: { error: 'error' } };
}

module.exports = { buildPublicMenu, defaultIsActive, assertWholeBody, publicMenuErrorResponse, REPRESENTATION_VERSION, PUBLIC_MENU_BODY_FIELDS, BODY_CONTRACT };
