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
const { sourceRefOf, validateSource, rendererContract } = require('./source-store');
const { assessDraft } = require('./draft-assess');   // 1D add-product A
const { readPlatformPending, gapsIn } = require('./platform-pending');   // F-1: the Sherpa-written-fields flag (read-only here)
const { groupCapabilities } = require('./platform-groups');   // 1D add-product B: the ONE platform authoring switch (no brand)
const { usesPlatformFactura } = require('../factura/eligibility');   // 2b-2b: the fiscal capability, server-owned
// The EXISTING codec from the 2b-1 write path, imported rather than reimplemented. `sourceUpdateTime`
// is what a later slice hands straight back to editCatalog as `baseSourceUpdateTime`, and Firestore
// evaluates that as a nanosecond-precise precondition. A second codec that drifted by even one digit
// would make every save fail the CAS — the exact bug the emulator e2e caught one layer down.
const { encodeUpdateTime } = require('./edit-catalog-handler');

const { can, myLocations, resolveAccess } = require('../access/membership');   // PLAN-portal-membership r3 §3.2 — the ONE capability table
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

  // BEFORE any read: a customer token must not be able to probe whether a uid owns anything. PLAN-portal-membership r3
  // §3.1: nor a handheld device token.
  if (decoded.customer === true || decoded.handheld === true) return reply(403, { error: 'not_authorized' });

  try {
    // PLAN-portal-membership r3 §4.2 — the EXACT portal shape { restaurants: [{ rid, name }] } over the ONE "my locations":
    // member_of discovers, the forward grants (brand_members) authorize, each location validated through its brand. Every
    // location where the caller holds ANY capability (owner: member + retired history; manager: member). Sorted by rid
    // (the switcher must not reorder itself between loads); the uid comes from the verified token and nothing else.
    const locs = await myLocations({ db, onStale: (x) => console.warn('member_of_stale', JSON.stringify({ fn: 'getMyRestaurants', kind: x.kind })) },
      { uid: decoded.uid, token: decoded });
    const restaurants = [];
    for (const l of locs) if (l.caps.length) restaurants.push({ rid: l.rid, name: await displayName(db, l.rid) });
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
// READ-ONLY. Nothing in this module writes catalog or merchant state. (F-1: the ONE exception is a best-effort, deduped owner ALERT
// when a platform-pending stamp is malformed — a permanent lock must never be silent; injected as `alertMalformed`.)
// ---------------------------------------------------------------------------
async function getEditableCatalogCore({ db, fsdb, authorize, readActiveVersionId, readActiveBuilt = null, photoReads = null, readReservedKeys = null, _sourceRefOf = sourceRefOf, _validateSource = validateSource, _readPublishRequest = null, alertMalformed = null, _resolveAccess = resolveAccess, now = () => Date.now() }, req) {
  if (!req || req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });
  const rid = req.query && req.query.restaurantId;

  // authorizeCatalogEdit owns id validation, the customer rejection and the membership lookup, and its
  // statuses pass through verbatim — an authorization OUTAGE must stay a 503 rather than reading as a
  // permissions refusal.
  const auth = await authorize(rid, req);
  if (!auth || !auth.ok) return reply((auth && auth.status) || 403, { error: (auth && auth.error) || 'not_authorized' });
  if (!can(auth, 'catalog.read_editor')) return reply(403, { error: 'not_owner', detail: 'the merchant portal serves restaurant owners' });

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
    // 1D add-product A §0.1: still a 503 (it cannot be edited), but now it says WHY and carries the revision, so
    // the portal can offer "Volver al menú publicado" (resetDraftToLive) instead of a dead end.
    return reply(503, { error: 'source_unavailable', retryable: false, detail: 'the stored catalog failed validation and cannot be edited',
      draft_unpublishable: { code: 'invalid_source', detail: String((e && e.message) || e).slice(0, 300) },
      sourceUpdateTime: doc.updateTime ? encodeUpdateTime(doc.updateTime) : null });
  }

  let activeVersionId;
  try {
    activeVersionId = await readActiveVersionId(fsdb, rid);
  } catch (e) {
    console.warn('portal_read_unavailable', JSON.stringify({ fn: 'getEditableCatalog', rid, error: String((e && e.message) || e).slice(0, 160) }));
    return reply(503, { error: 'source_unavailable', retryable: true });
  }

  /* 1D add-product A — what the "Agregar producto" drawer and the recovery path need, from DATA:
     • renderedCategories: the sections this brand's order page draws (renderer contract) — the only ones a
       product can be added to;
     • restaurantName: for the fiscal note, never a literal;
     • pendingAdditions: the saved draft's unpublished new products (keys), present only when there are some;
     • pendingRenames / pendingOther (PLAN-public-menu-display T1): the saved draft's unpublished section names
       ([{id, from, to}]) and whether anything besides a name is unpublished — each present only when there is something;
     • draft_unpublishable: present ONLY when the saved draft cannot publish against what is serving (a
       structural drift or an unbuildable draft) — the portal then offers "Volver al menú publicado".
     An assessment that cannot be made (the live read failed) is simply omitted: the editor still loads. */
  let renderedCategories = [];
  try { renderedCategories = rendererContract(rid).renderedCategories; } catch (_) { renderedCategories = []; }
  /* 1D add-product B (§0b.3(e), §0c.7) — may the drawer OFFER "Elección requerida"? The SAME platform constant editCatalog
     and publishEdited enforce, so the portal never shows a control the server would refuse (off ⇒ the Phase A drawer,
     unchanged). choiceBadges: the badges this brand's picker draws on an option (e.g. "recommended"), from the generated
     renderer contract — data, never a brand literal. Both fail CLOSED (off / none) when they cannot be read. */
  let groupAuthoring = false;
  try { groupAuthoring = groupCapabilities().authoring === true; } catch (_) { groupAuthoring = false; }
  let choiceBadges = [];
  try { choiceBadges = [...rendererContract(rid).choiceBadges]; } catch (_) { choiceBadges = []; }
  let restaurantName = rid;
  try { restaurantName = await displayName(db, rid); } catch (_) { restaurantName = rid; }
  /* S2-5 (S2-DESIGN §1.1; advisor rulings 2 + 3): the item_text_edit switch, ALWAYS stated (fail-closed like groupAuthoring) —
     false ⇒ today's drawer; while it is on, THIS restaurant's reserved names, normalized exactly as the server judges them
     (the reserved-key doc ∪ the draft's frozen values), for the drawer's live «Ese nombre no está disponible». Advisory: the
     save and the publish re-judge. Unreadable ⇒ absent (declared degraded mode: C5 on «Guardar»), never a failed read. */
  /* S1 (per-dish extras): the platform EXTRAS-AUTHORING switch, ALWAYS stated and fail-closed like groupAuthoring — the SAME constant
     editCatalog and publishEdited enforce, so the portal keeps the per-dish checklist and «Sin extras» dark while it is off. */
  let extrasAuthoring = false;
  try { extrasAuthoring = require('./platform-extras').extrasCapabilities().authoring === true; } catch (_) { extrasAuthoring = false; }
  let textEditEnabled = false;
  try { textEditEnabled = require('./item-text-edit').textEditCapabilities().enabled === true; } catch (_) { textEditEnabled = false; }
  /* S2-core (the Extras page): the platform extrasCatalog switch, ALWAYS stated and fail-closed — the SAME constant the save's allocator,
     compareToActive (save / draft check / publish) and the structure gate enforce, so the portal keeps the Extras page dark while it is off. */
  let extrasCatalog = false;
  try { extrasCatalog = require('./platform-structure').structureCapabilities().extrasCatalog === true; } catch (_) { extrasCatalog = false; }
  /* S2-core (S2 UI plan review #1): what the save requires to remove an existing extra — the deletion baseline the save checks
     deleted_ids_loaded_base against (the SAME pointer read: catalog-firestore getActivePointer; null when unreadable, and the save then
     refuses deleted_ids_unbound) and the adopted claim's ids, normalized (the store keeps an object { ids, base_version, … }; a client may
     have sent an array). */
  let deletionBase = null;
  try { const p = await require('./catalog-firestore').getActivePointer(fsdb, rid); if (p && typeof p.version === 'string' && p.version && Number.isInteger(p.generation)) deletionBase = { version: p.version, generation: p.generation }; } catch (_) { deletionBase = null; }
  let reservedNames = null;
  if (textEditEnabled) {
    try {
      const { normalizeName } = require('./add-product'); const RK = require('./reserved-keys');
      const set = readReservedKeys ? await readReservedKeys(rid) : RK.reservedKeySet((await RK.reservedRefOf(fsdb, rid).get()).data());   // the restaurant's own reserved-key doc (production reads it through fsdb)
      const frozen = source && source.frozen_keys && typeof source.frozen_keys === 'object' ? Object.values(source.frozen_keys) : [];
      reservedNames = [...new Set([...set.keys(), ...frozen].filter((k) => typeof k === 'string').map(normalizeName))].sort();
    } catch (e) {
      console.warn('portal_reserved_names_unavailable', JSON.stringify({ rid, error: String((e && e.message) || e).slice(0, 160) }));
      reservedNames = null;
    }
  }
  let pendingTexts = null;
  let draftUnpublishable = null;
  let pendingAdditions = null;
  let pendingRenames = null;
  let pendingOther = false;
  let liveRead = null;   // F-1: the same live read answers the platform-pending question below (no second read)
  if (readActiveBuilt && activeVersionId != null) {
    try {
      liveRead = await readActiveBuilt(rid); const activeRes = liveRead;   // asm5: F-1's liveRead and S1c's activeRes name the SAME one read
      const a = assessDraft(rid, source, liveRead);
      if (!a.publishable) draftUnpublishable = { code: a.code, detail: a.detail, ...(a.key ? { key: a.key } : {}) };
      // the saved draft's products that are NOT published yet (keys), so a reloaded editor still marks them NUEVO
      // and lets the owner remove them ("Quitar") — present only when there are some
      else {
        if (Array.isArray(a.additions) && a.additions.length) pendingAdditions = a.additions;
        // PLAN-public-menu-display T1 (portal r1 #3): what the saved draft has pending against the published menu, so a
        // reloaded editor keeps «a rename publishes alone» from SERVER truth — the section names that differ, and whether
        // anything else does. Present only when there is something, exactly like pendingAdditions.
        if (Array.isArray(a.renames) && a.renames.length) pendingRenames = a.renames;
        if (a.other === true) pendingOther = true;
        // S2-4 (§1.1, G5): the saved-but-unpublished TEXT edits per product against live — a launcher or plain product, never an
        // option row; served only for a publishable draft and only while the switch is on (pendingOther keeps its meaning)
        if (textEditEnabled) {
          const liveByKey = new Map(((activeRes && activeRes.built && activeRes.built.items) || []).map((it) => [it && it.key, it]));
          const texts = [];
          for (const it of Array.isArray(source && source.items) ? source.items : []) {
            if (!it || !it.display || typeof it.key !== 'string' || it.display.variantOf != null) continue;
            const was = liveByKey.get(it.key); if (!was || !was.display) continue;
            const norm = (v) => (v === undefined ? null : v);
            const fields = ['name', 'desc', 'cat', 'subcat'].filter((f) => norm(it.display[f]) !== norm(was.display[f]));
            if (fields.length) texts.push({ key: it.key, fields });
          }
          if (texts.length) pendingTexts = texts;
        }
      }
    } catch (e) {
      console.warn('portal_draft_assessment_unavailable', JSON.stringify({ rid, error: String((e && e.message) || e).slice(0, 160) }));
    }
  }

  /* F-1 (BRIEF-portal-stale-draft-clobber, ruled 2026-11-07) — platform_changes_pending: a SHERPA tool wrote fields into this draft
     (the platform-pending stamp) that live does not carry yet. The portal then shows the calm notice INSTEAD of «Volver al menú
     publicado», which resetDraftToLive refuses anyway (the server decides). READ-ONLY here: the stamp is only read, never cleared
     (clearing is the reset's / Sherpa's publish tools'). Undeterminable ⇒ a retryable 503 (below), never a silent unlock. */
  let platformPending = null;
  // Codex r1 P2-1: the stamp is read ON ITS OWN (not inside the live read's success), and an existing stamp UNLOCKS only after a
  // SUCCESSFUL gap evaluation. Undeterminable (the stamp or live unreadable) ⇒ a retryable 503, never a silent unlock. No stamp ⇒
  // today's response exactly.
  let st;
  try { st = await readPlatformPending(fsdb, rid); } catch (e) {
    console.warn('portal_platform_pending_unavailable', JSON.stringify({ rid, error: String((e && e.message) || e).slice(0, 160) }));
    return reply(503, { error: 'source_unavailable', retryable: true });
  }
  if (st) {
    if (st.malformed) {
      platformPending = { fields: [] };   // fails CLOSED, and never silent
      if (alertMalformed) { try { await alertMalformed(rid); } catch (_) { console.error('platform_pending_alert_failed', JSON.stringify({ rid })); } }
    } else if (activeVersionId == null) {
      platformPending = { fields: st.fields };   // nothing is published: live carries none of them
    } else if (!liveRead || !liveRead.built) {
      console.warn('portal_platform_pending_undeterminable', JSON.stringify({ rid }));
      return reply(503, { error: 'live_version_unavailable', retryable: true });
    } else {
      const gaps = gapsIn({ items: liveRead.built.items, extras: liveRead.extraRecords, structure: liveRead.built.structure }, st.fields);
      if (gaps.length) platformPending = { fields: gaps };
    }
  }

  /* PLAN-portal-team-invites G3 — «Enviar al dueño para publicar»: on a platform-factura brand the OWNER (the one who holds
     catalog.fiscal_ack) also receives the manager's pending request, its state DERIVED against this very draft + pointer
     (fresh / draft_changed; a published or stale one is never sent). Nobody else ever receives the field. Best effort: a
     failed read omits it and the editor still loads. */
  let publishRequest = null;
  if (can(auth, 'catalog.fiscal_ack') && usesPlatformFactura(rid)) {
    try {
      publishRequest = await (_readPublishRequest || require('./publish-request').readRequestForOwner)(fsdb, rid, {
        sourceUpdateTime: doc.updateTime ? encodeUpdateTime(doc.updateTime) : null, sourceHash: require('./catalog-edit').sha256(source),
        activeVersionId: activeVersionId == null ? null : activeVersionId, now: now() });
    } catch (e) {
      console.warn('portal_publish_request_unavailable', JSON.stringify({ rid, error: String((e && e.message) || e).slice(0, 160) }));
    }
  }

  /* T-d — «Enviar al dueño para publicar»: does THIS caller send instead of publish? Decided by the SAME predicate
     catalogRequestPublish enforces (publish-request.js canRequestPublish), never guessed by the client from caps (dispatchers
     and staff also hold catalog.publish). Only a non-owner on a platform-factura brand can qualify, so only that caller pays
     the one extra resolve (the caller was verified and context-checked by authorize above). Fail CLOSED (false): the editor
     then shows today's path, and the server's fiscal gate still decides any publish. */
  let publishViaRequest = false;
  if (usesPlatformFactura(rid) && !can(auth, 'catalog.fiscal_ack') && typeof auth.uid === 'string') {
    try { publishViaRequest = require('./publish-request').canRequestPublish(await _resolveAccess({ db }, { uid: auth.uid, token: {} }, rid), rid); }
    catch (_) { publishViaRequest = false; }
  }

  /* DISH PHOTOS A2 step 9 (E-P3) — photos / photoPreviews / legacyPreviews / photosEnabled, each OMITTED when empty or off (a restaurant
     without photo data gets today's response byte-for-byte). Best effort: a failed photo read omits them and the editor still loads
     (the draft map is in `source` regardless). A pending photo change counts as «something besides a name» (pendingOther). */
  let photoOut = {};
  if (photoReads) {
    try {
      const { photosPending, ...fields } = (await photoReads.fieldsFor({ rid, source, activeVersionId: activeVersionId == null ? null : activeVersionId })) || {};
      photoOut = fields;
      if (photosPending === true && !draftUnpublishable) pendingOther = true;
    } catch (e) {
      console.warn('portal_photo_fields_unavailable', JSON.stringify({ rid, error: String((e && e.message) || e).slice(0, 160) }));
    }
  }

  return reply(200, {
    renderedCategories,
    groupAuthoring,
    ...(publishRequest ? { publish_request: publishRequest } : {}),
    publish_via_request: publishViaRequest,
    choiceBadges,
    restaurantName,
    ...(draftUnpublishable ? { draft_unpublishable: draftUnpublishable } : {}),
    ...(platformPending ? { platform_changes_pending: platformPending } : {}),   // F-1
    ...(pendingAdditions ? { pendingAdditions } : {}),
    ...(pendingRenames ? { pendingRenames } : {}),
    ...(pendingOther ? { pendingOther: true } : {}),
    ...(pendingTexts ? { pendingTexts } : {}),
    textEditEnabled,
    extrasAuthoring,
    ...(reservedNames ? { reservedNames } : {}),
    extrasCatalog,
    deletionBase,
    deletionClaim: { ids: (Array.isArray(source && source.deleted_ids) ? source.deleted_ids : (source && source.deleted_ids && Array.isArray(source.deleted_ids.ids) ? source.deleted_ids.ids : [])).map(String).sort() },
    ...photoOut,   // DISH PHOTOS A2 step 9 (E-P3)
    source,
    // The CAS baseline. Byte-identical to editCatalog's baseSourceUpdateTime by construction.
    sourceUpdateTime: doc.updateTime ? encodeUpdateTime(doc.updateTime) : null,
    // null is an honest answer: a restaurant can have a draft and nothing published yet.
    activeVersionId: activeVersionId == null ? null : activeVersionId,
    // THE FISCAL CAPABILITY, so the portal never has to ask `rid === 'x_pizza'`. Whether an edit
    // touches a SAR factura is a fact this system already owns (factura/eligibility.js), and a browser
    // is the worst place to keep a second copy of it: a brand literal shipped to a client is wrong the
    // day a third merchant joins the platform factura, and cannot be corrected without a redeploy.
    //
    // Reported for every restaurant, always a boolean — an absent field would make the UI guess, and
    // the safe guess and the correct guess are not the same for a merchant who does owe a factura.
    usesPlatformFactura: usesPlatformFactura(rid),
  });
}

module.exports = { getMyRestaurantsCore, getEditableCatalogCore, displayName };
