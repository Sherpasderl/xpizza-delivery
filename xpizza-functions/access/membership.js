'use strict';
// PLAN-portal-membership r3 §2–§4 — the ONE membership resolver for the merchant surfaces (portal + handheld H1).
//
// STORAGE (authoritative = forward):
//   brand_members/{brandId}/owners/{uid}            = { granted_at, granted_by }   brand owner (every MEMBER location of the brand)
//   brand_members/{brandId}/managers/{rid}/{uid}    = { granted_at, granted_by }   location manager
//   restaurants/{rid}/kitchen_staff/{uid}           (unchanged — KDS rules depend on it)
//   dispatchers/{uid}                               (unchanged — platform ops)
//   member_of/{uid}/{brands|locations}/{id}         DISCOVERY ONLY — never authorizes (§4.1)
//
// resolveAccess takes a VERIFIED auth context ({ uid, token }) and refuses customer AND handheld tokens itself, before any
// read. It returns independent FACTS (never a single winner), the CAPABILITIES those facts grant at this location's state, a
// presentation tier, and the location's brand + state. A read that throws is `unavailable` — never a lower role.
//
// THE CAPABILITY TABLE below is the single place the owner's role decisions live (O1–O7, PLAN §0/§3.2). Every endpoint asks
// can(access, '<operation>'); none compares tiers.
const F1 = require('../brands/brand-model');

// columns: owner (member location) · owner_retired · manager («Gerente de sucursal», member location) · manager_menu (a
// manager whose per-manager setting brand_members/{b}/manager_perms/{uid}.can_edit_menu is on: «Puede editar el menú y los
// precios», toggled by the owner) · dispatcher · staff.
// Dispatcher and staff columns reproduce TODAY's behaviour exactly (they never depended on the brand record).
// FISCAL (advisor ruling): catalog.fiscal_ack stays OWNER-only — for a platform-factura brand every publish needs the owner's
// acknowledgement, so a permitted manager edits and saves a draft and the owner confirms the publish; elsewhere a permitted
// manager publishes directly.
const CAPABILITIES = Object.freeze({
  'catalog.read_editor': { owner: true, manager_menu: true },
  'catalog.edit':        { owner: true, dispatcher: true, staff: true, manager_menu: true },
  'catalog.add_product': { owner: true, manager_menu: true },
  'catalog.reset_draft': { owner: true, manager_menu: true },
  'catalog.publish':     { owner: true, dispatcher: true, staff: true, manager_menu: true },
  'catalog.fiscal_ack':  { owner: true },                                         // gate applies when usesPlatformFactura(rid)
  'stats.read':          { owner: true, owner_retired: true, manager: true },     // the manager's own branch; retired: history read-only
  'availability.set':    { owner: true, manager: true },                          // O1
  'device.pair':         { owner: true, manager: true },
  'device.revoke':       { owner: true, manager: true },
  'device.list':         { owner: true, manager: true },
  'location.hours':      { owner: true, manager: true },                          // O1
  'location.prep':       { owner: true, manager: true },                          // O1
  'location.pause':      { owner: true, manager: true },                          // O1
  'location.contact':    { owner: true, manager: true },                          // the branch WhatsApp (portal-ui, additive)
  'location.profile':    { owner: true },                                         // branch address / zone / name (portal-ui, additive)
  'team.invite':         { owner: true },                                         // only the owner invites / revokes / sets roles
  'team.revoke':         { owner: true },
  'brand.settings':      { owner: true },
});
const CAP_NAMES = Object.freeze(Object.keys(CAPABILITIES));

// UID_RE gates NEW membership grants (writers). The resolver accepts any verified uid that is safe to put in a path
// (dispatchers / kitchen staff are authorized today whatever their uid shape — no regression).
const UID_RE = /^[A-Za-z0-9]{6,128}$/;
const isUid = (v) => typeof v === 'string' && UID_RE.test(v);
const isPathUid = (v) => typeof v === 'string' && /^[^.#$[\]/\s]{1,128}$/.test(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isLoc = (v) => F1.isBrandId(v);   // PLAN §9: supported location ids = the full isBrandId (reserved names, no all-digit)

// The capabilities a set of facts grants at a location state. Pure.
function capsFor(facts, state) {
  const cols = [];
  if (facts.owner && state === 'member') cols.push('owner');
  if (facts.owner && state === 'retired') cols.push('owner_retired');
  if (facts.manager && state === 'member') cols.push('manager');
  if (facts.manager && facts.manager_menu && state === 'member') cols.push('manager_menu');
  if (facts.dispatcher) cols.push('dispatcher');
  if (facts.staff) cols.push('staff');
  return CAP_NAMES.filter((c) => cols.some((col) => CAPABILITIES[c][col] === true));
}

// For an authorization result that carries only a legacy `role` (test stubs, older callers): the role's column at a member
// location. Keeps every core on can() while a stub still says { ok, role }.
const ROLE_COLUMN = { owner: 'owner', dispatcher: 'dispatcher', staff: 'staff', manager: 'manager' };   // a role-only stub never implies manager_menu
function can(auth, cap) {
  if (!auth || !auth.ok) return false;
  if (Array.isArray(auth.caps)) return auth.caps.includes(cap);
  const col = ROLE_COLUMN[auth.role];
  return !!(col && CAPABILITIES[cap] && CAPABILITIES[cap][col] === true);
}

const deny = (code) => ({ ok: false, code });
const val = async (db, p) => (await db.ref(p).once('value')).val();

// A location's brand and its state in that brand's roster: F1's brandIdOf over the identity + the legacy singleton record,
// then the resolved brand record must validate and list the location (checkMembership), the identity naming that brand.
// Same derivation as merchant/merchant-brand.js, plus the roster STATE. → { brandId, state: 'member'|'retired'|'unknown', rec }
async function resolveLocation(db, rid) {
  if (!isLoc(rid)) return { brandId: F1.UNKNOWN, state: 'unknown', rec: null };
  // least privilege: only the brand_id leaf (never the identity node — it carries the hub, phone and WhatsApp instance)
  const bid = await val(db, `restaurants/${rid}/identity/brand_id`);
  const identity = bid === null ? {} : { brand_id: bid };
  const own = await val(db, `brands/${rid}`);
  const b = F1.brandIdOf(rid, identity, own === null ? {} : { [rid]: own });
  if (b === F1.UNKNOWN) return { brandId: F1.UNKNOWN, state: 'unknown', rec: null };
  const rec = b === rid ? own : await val(db, `brands/${b}`);
  if (rec === null) return { brandId: F1.UNKNOWN, state: 'unknown', rec: null };
  const findings = F1.checkMembership({ [b]: rec }, { [rid]: identity })
    .filter((f) => f.code === 'brand_invalid' || f.rid === rid);
  if (findings.length) return { brandId: F1.UNKNOWN, state: 'unknown', rec: null };
  const st = isObj(rec.locations) ? rec.locations[rid] : undefined;
  return { brandId: b, state: st === 'member' || st === 'retired' ? st : 'unknown', rec };
}

// The verified-context precondition, shared by every entry point. Before any read.
function refuseContext(ctx) {
  if (!ctx || typeof ctx.uid !== 'string' || !ctx.uid) return deny('unauthenticated');
  if (!isPathUid(ctx.uid)) return deny('forbidden');
  const t = ctx.token || {};
  if (t.customer === true || t.handheld === true) return deny('forbidden');
  return null;
}

const TIER_ORDER = ['owner', 'manager', 'dispatcher', 'staff'];   // manager_menu is a permission on the manager, not a tier

async function resolveAccess({ db }, ctx, rid) {
  const refused = refuseContext(ctx);
  if (refused) return refused;
  const uid = ctx.uid;
  try {
    const loc = await resolveLocation(db, rid);
    const known = loc.brandId !== F1.UNKNOWN;
    const grant = known ? await val(db, `brand_members/${loc.brandId}/managers/${rid}/${uid}`) : null;
    // «Puede editar el menú y los precios» is ONE per-manager setting (codex build r1 P2-3), never per branch grant
    const perms = grant != null ? await val(db, `brand_members/${loc.brandId}/manager_perms/${uid}`) : null;
    const facts = {
      owner: known ? (await val(db, `brand_members/${loc.brandId}/owners/${uid}`)) != null : false,
      manager: grant != null,
      manager_menu: isObj(perms) && perms.can_edit_menu === true,
      dispatcher: (await val(db, `dispatchers/${uid}`)) != null,
      staff: typeof rid === 'string' && rid ? (await val(db, `restaurants/${rid}/kitchen_staff/${uid}`)) != null : false,
    };
    const caps = capsFor(facts, loc.state);
    const tier = TIER_ORDER.find((t) => facts[t]) || null;
    return { ok: true, uid, facts, caps, tier, brandId: loc.brandId, state: loc.state };
  } catch (_) {
    return deny('unavailable');
  }
}

// "My locations" (PLAN §4.1): member_of DISCOVERS candidates (one read); the FORWARD grants authorize them; each location is
// validated through resolveLocation (brand record + reciprocal roster + identity). Stale index entries are dropped and
// reported via onStale (never an authorization). Owner + manager of the same location → one entry (owner wins).
// → [{ rid, brand_id, role: 'owner'|'manager', state, caps }] sorted by rid. A failure THROWS (callers map it to 503 /
// 'unavailable' — an empty list is a confident answer, never an outage).
async function myLocations({ db, onStale = () => {} }, ctx) {
  const refused = refuseContext(ctx);
  if (refused) { const e = new Error(refused.code); e.code = refused.code; throw e; }
  const uid = ctx.uid;
  const idx = (await val(db, `member_of/${uid}`)) || {};
  const out = new Map();
  const brands = isObj(idx.brands) ? idx.brands : {};
  for (const b of Object.keys(brands).sort()) {
    if (!F1.isBrandId(b) || brands[b] !== 'owner') { onStale({ kind: 'malformed_brand_entry', id: b }); continue; }
    if ((await val(db, `brand_members/${b}/owners/${uid}`)) == null) { onStale({ kind: 'stale_owner', id: b }); continue; }
    const rec = await val(db, `brands/${b}`);
    if (!rec || !F1.validateBrand(b, rec).ok) { onStale({ kind: 'invalid_brand', id: b }); continue; }
    for (const rid of Object.keys(rec.locations).sort()) {
      const loc = await resolveLocation(db, rid);
      if (loc.brandId !== b || loc.state === 'unknown') { onStale({ kind: 'roster_mismatch', id: rid }); continue; }
      out.set(rid, { rid, brand_id: b, role: 'owner', state: loc.state, caps: capsFor({ owner: true }, loc.state) });
    }
  }
  const locs = isObj(idx.locations) ? idx.locations : {};
  for (const rid of Object.keys(locs).sort()) {
    if (!isLoc(rid) || locs[rid] !== 'manager') { onStale({ kind: 'malformed_location_entry', id: rid }); continue; }
    const loc = await resolveLocation(db, rid);
    if (loc.brandId === F1.UNKNOWN) { onStale({ kind: 'roster_mismatch', id: rid }); continue; }
    const grant = await val(db, `brand_members/${loc.brandId}/managers/${rid}/${uid}`);
    if (grant == null) { onStale({ kind: 'stale_manager', id: rid }); continue; }
    if (out.has(rid)) continue;                       // owner already lists it (dedup; owner wins)
    if (loc.state !== 'member') continue;             // a manager of a retired location has no capability there
    const perms = await val(db, `brand_members/${loc.brandId}/manager_perms/${uid}`);
    out.set(rid, { rid, brand_id: loc.brandId, role: 'manager', state: loc.state,
      caps: capsFor({ manager: true, manager_menu: isObj(perms) && perms.can_edit_menu === true }, loc.state) });
  }
  return [...out.values()].sort((a, z) => (a.rid < z.rid ? -1 : a.rid > z.rid ? 1 : 0));
}

module.exports = { CAPABILITIES, CAP_NAMES, capsFor, can, resolveAccess, resolveLocation, myLocations, refuseContext, isUid, isPathUid, UID_RE };
