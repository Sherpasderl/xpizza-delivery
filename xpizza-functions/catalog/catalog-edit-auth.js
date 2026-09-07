'use strict';
// ---------------------------------------------------------------------------
// Portal Phase 2b-1 Task 2 — the FRONT DOOR to the catalog write path.
//
// Everything downstream (validate → diff → token → publish) assumes the caller had the right to be
// there, and nothing else establishes that. So this helper is written around its failure modes rather
// than its success case: an authorization check that answers "yes" because a backend was unreachable is
// not an authorization check. Only an affirmative, verified membership grants; every other path denies.
//
// Three tiers, owner ⊇ dispatcher ⊇ staff:
//   • the RESTAURANT'S OWNER (`/restaurants/{rid}/owners/{uid}`) — the person legally responsible for
//     that restaurant's SAR fiscal representation, and the ONLY tier that may acknowledge a menu edit
//     which changes the factura
//   • a GLOBAL dispatcher (`/dispatchers/{uid}`) — our own staff, either brand
//   • OWN-RESTAURANT kitchen staff (`/restaurants/{rid}/kitchen_staff/{uid}`) — that brand only
//
// THE OWNER NODE IS DELIBERATELY NOT MODELLED ON THE OTHERS. `dispatchers/{uid}` and
// `kitchen_staff/{uid}` are both DISPATCHER-WRITABLE in database.rules.json, so copying that pattern
// would let any dispatcher add themselves as an owner and then sign their own fiscal acknowledgement —
// the gate would read as enforced while being fully bypassable. `restaurants/{rid}/owners` has no rule
// at all, which under RTDB's deny-by-default makes it server/console-write-only. That is the correct
// state and it needs NO rules change; ADDING a rule here would be the mistake.
//
// It is PER-RESTAURANT, not global: a fiscal acknowledgement is a statement by the party responsible
// for one taxpayer's documents. A platform-wide owner is not merchant #3's fiscal representative. It
// sits beside factura_config, which is already per-restaurant and locked to {read:false, write:false}.
//
// DOGFOOD NOTE: per-rid staff membership is not curated yet (the seed puts all staff in both brands),
// so for our two brands the dispatcher-global path is the operative one. The per-rid branch is written
// and tested now because it is what a real merchant will use, and retrofitting an authorization
// boundary after onboarding starts is how boundaries get skipped. Curation + a merchant claim is
// merchant-#3 work.
//
// NO SHARED-SECRET PATH, deliberately. authorizeDispatcherAction accepts RECON_SECRET as a bearer for
// server-to-server use; that is not copied here. A static secret able to rewrite live prices and the
// SAR factura has a far larger blast radius than a reconciliation action, and it authenticates no
// PERSON — which would make the Task 4 fiscal acknowledgement meaningless, since a script could hold
// the credential. A catalog edit always identifies a human.
// ---------------------------------------------------------------------------

// The restaurant id is interpolated into an RTDB path, so it is validated as an identifier before it
// gets anywhere near a ref. Same shape the 2a registry accepts, so a merchant the registry can onboard
// is a merchant this can authorize.
const RID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

const deny = (status, error) => ({ ok: false, status, error });

async function authorizeCatalogEdit({ db, verifyIdToken }, req, restaurantId) {
  if (typeof restaurantId !== 'string' || !RID_RE.test(restaurantId)) {
    return deny(400, 'bad_restaurant_id');            // a bad request, not a permissions decision
  }

  const header = (req && typeof req.get === 'function' && req.get('authorization')) || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return deny(401, 'missing_bearer_token');

  let decoded;
  try {
    decoded = await verifyIdToken(token);
  } catch (_) {
    return deny(401, 'invalid_credentials');          // fail-closed: an unverifiable token is never a caller
  }
  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid) return deny(401, 'invalid_credentials');

  // BEFORE any membership read, and the order matters. A customer token must not be able to probe
  // whether some uid is staff, and if this ran after the lookup it would GRANT for any uid that happens
  // to sit in both namespaces. Customers are minted through the OTP path with this claim; they have no
  // business on a path that moves prices.
  if (decoded.customer === true) return deny(403, 'not_authorized');

  // A read that THROWS must never fall through to "not a member". That is the shape where an outage
  // reads as a clean denial — or, one small edit later, as a grant. Denied explicitly, and as 503 rather
  // than 403 so an outage is not misdiagnosed as a permissions problem.
  const exists = async (path) => {
    const snap = await db.ref(path).once('value');
    return !!(snap && snap.exists());
  };
  try {
    // HIGHEST TIER FIRST, so a uid that is both an owner and a dispatcher resolves to owner — the fiscal
    // gate must see the higher tier, not whichever was checked first by accident.
    if (await exists(`restaurants/${restaurantId}/owners/${decoded.uid}`)) {
      return { ok: true, uid: decoded.uid, role: 'owner', actor: decoded.email || decoded.uid };
    }
    if (await exists(`dispatchers/${decoded.uid}`)) {
      return { ok: true, uid: decoded.uid, role: 'dispatcher', actor: decoded.email || decoded.uid };
    }
    if (await exists(`restaurants/${restaurantId}/kitchen_staff/${decoded.uid}`)) {
      return { ok: true, uid: decoded.uid, role: 'staff', actor: decoded.email || decoded.uid };
    }
  } catch (e) {
    console.warn('catalog_edit_auth_unavailable', JSON.stringify({ restaurantId, error: String((e && e.message) || e).slice(0, 160) }));
    return deny(503, 'authorization_unavailable');
  }
  return deny(403, 'not_authorized');
}

module.exports = { authorizeCatalogEdit, RID_RE };
