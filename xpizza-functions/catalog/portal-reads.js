'use strict';
// ---------------------------------------------------------------------------
// Portal Phase 2b-2a — the merchant portal's READ side. Writes nothing, ever.
//
// getMyRestaurants is the portal's front door: it answers "which restaurants am I allowed to see?", and
// every later call is scoped by its answer. Three properties carry it.
//
//   THE ANSWER COMES FROM THE TOKEN. The uid is whatever the verified ID token says and nothing else —
//   never a query parameter, a body field or a header. If a request could name its own uid, one
//   merchant could enumerate another's holdings.
//
//   AN OUTAGE IS NOT AN EMPTY LIST. "You own nothing" and "the lookup is down" look identical to a
//   merchant staring at an empty portal, but one is a fact and the other is a lie that reads as "your
//   restaurants were taken away". Every read failure is a 503, and a PARTIAL list is never returned
//   either: a list missing one restaurant is a confident, wrong answer about what someone owns.
//
//   A CUSTOMER IS NOT A MERCHANT. Rejected before any read, so a customer token cannot probe the index.
//
// Brand-agnostic: nothing here knows which restaurants exist.
// ---------------------------------------------------------------------------
const { readOwnerRestaurants } = require('./owner-index');
const { sourceRefOf, validateSource } = require('./source-store');
// The EXISTING codec from the 2b-1 write path, imported rather than reimplemented. `sourceUpdateTime`
// is what a later slice hands straight back to editCatalog as `baseSourceUpdateTime`, and Firestore
// evaluates that as a nanosecond-precise precondition. A second codec that drifted by even one digit
// would make every save fail the CAS — the exact bug the emulator e2e caught one layer down.
const { encodeUpdateTime } = require('./edit-catalog-handler');

const reply = (status, body) => ({ status, body });

// The display name only.
//
// NOT restaurant-config.js's getIdentity, deliberately: that is the ORDER path's reader, TTL-cached and
// fail-closed on a stale identity. Borrowing it would mean a merchant's restaurant disappears from
// their own portal because its config went stale — an availability decision that belongs to order
// intake, not to a list of names. Reading the single field also keeps the hub coordinates, phone and
// WhatsApp instance out of a process that has no business holding them.
async function displayName(db, rid) {
  const snap = await db.ref(`restaurants/${rid}/identity/name`).get();
  const name = snap && snap.val();
  // A restaurant with no name yet is still THEIRS. Label it by its id rather than dropping it or
  // showing a blank row — hiding a restaurant from the person who owns it is the worse failure.
  return (typeof name === 'string' && name.trim()) ? name : rid;
}

async function getMyRestaurantsCore({ db, verifyIdToken }, req) {
  if (!req || req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });

  const header = (req && typeof req.get === 'function' && req.get('authorization')) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return reply(401, { error: 'missing_bearer_token' });

  let decoded;
  try {
    decoded = await verifyIdToken(token);
  } catch (_) {
    return reply(401, { error: 'invalid_credentials' });   // an unverifiable token is never a caller
  }
  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) return reply(401, { error: 'invalid_credentials' });

  // BEFORE any read: a customer token must not be able to probe whether a uid owns anything.
  if (decoded.customer === true) return reply(403, { error: 'not_authorized' });

  try {
    // decoded.uid, and nothing the request could influence.
    const rids = (await readOwnerRestaurants(db, decoded.uid)).sort();   // sorted: the switcher must not
                                                                        // reorder itself between loads
    const restaurants = [];
    for (const rid of rids) restaurants.push({ rid, name: await displayName(db, rid) });
    return reply(200, { restaurants });
  } catch (e) {
    // ALL OR NOTHING. Returning the restaurants we did manage to read would be a confident, wrong
    // statement about what this person owns. 503 rather than 403: this says something about us, not
    // about the caller, and confusing the two sends a merchant to re-authenticate over an outage.
    console.warn('portal_read_unavailable', JSON.stringify({ fn: 'getMyRestaurants', error: String((e && e.message) || e).slice(0, 160) }));
    return reply(503, { error: 'read_unavailable', retryable: true });
  }
}

// ---------------------------------------------------------------------------
// getEditableCatalog — hand a merchant their own live money data, and nothing else.
//
// OWNER-ONLY, and this is the sharp edge. authorizeCatalogEdit deliberately grants a DISPATCHER any
// restaurant: that is right for internal staff tooling and wrong here. Accepting it on the
// tenant-facing surface would let internal staff pull any tenant's catalog through the merchant portal,
// so an authorized non-owner is refused — before the source is read, so a dispatcher cannot even
// confirm a restaurant exists through this endpoint.
//
// VALIDATED ON EVERY READ, FAIL CLOSED. A malformed source is never handed over as an editable
// baseline: the merchant would edit corruption, and the write slice would pass it straight back through
// the CAS — laundered into a publish by a UI that displayed it as normal. 503, and the document is not
// returned at all.
//
// READ-ONLY. Nothing in this module writes.
// ---------------------------------------------------------------------------
async function getEditableCatalogCore({ db, fsdb, authorize, readActiveVersionId, _sourceRefOf = sourceRefOf, _validateSource = validateSource }, req) {
  if (!req || req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });
  const rid = req.query && req.query.restaurantId;

  // authorizeCatalogEdit owns id validation, the customer rejection and the membership lookup, and its
  // statuses pass through verbatim — an authorization OUTAGE must stay a 503 rather than reading as a
  // permissions refusal.
  const auth = await authorize(rid, req);
  if (!auth || !auth.ok) return reply((auth && auth.status) || 403, { error: (auth && auth.error) || 'not_authorized' });
  if (auth.role !== 'owner') return reply(403, { error: 'not_owner', detail: 'the merchant portal serves restaurant owners' });

  let doc;
  try {
    doc = await _sourceRefOf(fsdb, rid).get();
  } catch (e) {
    console.warn('portal_read_unavailable', JSON.stringify({ fn: 'getEditableCatalog', rid, error: String((e && e.message) || e).slice(0, 160) }));
    return reply(503, { error: 'source_unavailable', retryable: true });
  }
  // "Not seeded yet" and "cannot be read" are different facts and get different codes: one is a state
  // to fix, the other is a state to retry.
  if (!doc || !doc.exists) return reply(404, { error: 'source_absent', detail: 'this restaurant has no catalog source yet' });

  const source = doc.data();
  try {
    // Against the AUTHORIZED rid, not the document's own restaurant_id — otherwise a mis-filed document
    // would certify itself and a merchant could be shown another restaurant's menu as their own.
    _validateSource(source, rid);
  } catch (e) {
    console.error('portal_source_invalid', JSON.stringify({ rid, error: String((e && e.message) || e).slice(0, 200) }));
    return reply(503, { error: 'source_unavailable', retryable: false, detail: 'the stored catalog failed validation and cannot be edited' });
  }

  let activeVersionId;
  try {
    activeVersionId = await readActiveVersionId(fsdb, rid);
  } catch (e) {
    console.warn('portal_read_unavailable', JSON.stringify({ fn: 'getEditableCatalog', rid, error: String((e && e.message) || e).slice(0, 160) }));
    return reply(503, { error: 'source_unavailable', retryable: true });
  }

  return reply(200, {
    source,
    // The CAS baseline. Byte-identical to editCatalog's baseSourceUpdateTime by construction.
    sourceUpdateTime: doc.updateTime ? encodeUpdateTime(doc.updateTime) : null,
    // null is an honest answer: a restaurant can have a draft and nothing published yet.
    activeVersionId: activeVersionId == null ? null : activeVersionId,
  });
}

module.exports = { getMyRestaurantsCore, getEditableCatalogCore, displayName };
