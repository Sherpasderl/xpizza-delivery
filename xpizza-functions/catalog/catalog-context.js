'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-a — THE RESOLVED CATALOG CONTEXT: the PURE builder.
//
// One version's raw payload (its record + items + extras + structure, exactly as read from Firestore,
// identity stamps included) → for every dish and extra its kind, legacy key, canonical id, price,
// factura label and policy memberships, all from that SAME version; plus the states a later slice
// needs before it may rely on any of it. D4-a only COMPUTES and REPORTS these. Nothing consumes them.
//
// 🔴 PURE AND TOTAL. No I/O, no clock, never throws: a payload that cannot be built is a context whose
// contentIntegrity is `mismatch` with the reason, because the publisher validated and hashed what it
// wrote, so a payload that no longer builds is not the payload that was published.
//
// 🔴 THE PERSISTED FORM IS RAW, NEVER DERIVED (plan step 7). The fallback path stores the raw payload
// and the pinned content_hash; `objects` are REBUILT here on every serve and re-checked. An edited
// derived field therefore has nowhere to live.
//
// 🔴 THE INTEGRITY CHECK IS THE EXISTING ONE. content_hash (content-hash.js) over the served payload,
// recomputed through the SAME buildMenu the display reader uses, against the hash the publisher pinned.
// It authenticates every label, category and policy field. It EXCLUDES identity stamps by design
// (content-hash.js:32-35), so a stamp swap stays `intact` here — that is the registry verifier's job
// (catalog-verifier.js), which compares each object's (kind, canonicalId, legacyKey) pair.
// ---------------------------------------------------------------------------
const { buildMenu, SCHEMA_VERSION } = require('./catalog-menu');
const { contentHash } = require('./content-hash');
const { validIdShape } = require('./identity-registry');
const { policyOf, membershipsFor, ruleSummary } = require('./policy-primitive');

// ── The raw payload ────────────────────────────────────────────────────────────────────────────
// { rid, versionId, record, items: [{id, data}], extras: [{id, data}], structure: object|null }
// `record` is the version record's data. Doc ids are kept so a snapshot can be rebuilt exactly.

// A Firestore-snapshot-shaped view of raw docs, so buildMenu (which takes snapshots) can run on a
// payload that came back from RTDB as easily as on one that came from Firestore.
function snapOf(rows) {
  const docs = (Array.isArray(rows) ? rows : []).map((r) => ({ id: r && r.id, data: () => (r ? r.data : undefined) }));
  return { docs, empty: docs.length === 0 };
}
const structureSnapOf = (structure) => ({ exists: structure !== null && structure !== undefined, data: () => structure });

const isLabel = (v) => typeof v === 'string' && v.length > 0;
const isStamp = (v) => typeof v === 'string' && v.length > 0;

// ── Coverage, counted over OBJECTS (never from identity_certified, which means ≥1 stamp) ────────
function coverageOf(objs, pick) {
  const total = objs.length;
  const covered = objs.filter((o) => pick(o)).length;
  const state = total > 0 && covered === total ? 'full' : covered === 0 ? 'none' : 'partial';
  return { state, covered, total };
}

// Exact {key: price} tables from objects — what attachment compares against the SERVED prices.
function pricesFromObjects(objects) {
  const menu = {}, extras = {};
  for (const o of objects) (o.kind === 'dish' ? menu : extras)[o.legacyKey] = o.price;
  return { menu, extras };
}

function failedContext(raw, reason, detail) {
  return {
    rid: raw && raw.rid, versionId: (raw && raw.versionId) || null,
    seq: raw && raw.record && Number.isInteger(raw.record.seq) ? raw.record.seq : null,
    built: false,
    contentIntegrity: { state: 'mismatch', reason, detail: String(detail || '').slice(0, 200) },
    objects: null, prices: null,
  };
}

// buildContext(raw) → the context's version-bound projection. Never throws.
function buildContext(raw) {
  try {
    if (!raw || typeof raw !== 'object' || !raw.record || typeof raw.record !== 'object') {
      return failedContext(raw, 'no_record', 'the version record is absent');
    }
    const { rid, versionId, record } = raw;
    const where = `${rid}/versions/${versionId}`;
    let built;
    try {
      built = buildMenu(snapOf(raw.items), snapOf(raw.extras), structureSnapOf(raw.structure), where);
    } catch (e) {
      return failedContext(raw, (e && e.code) || 'build_failed', e && e.message);
    }

    // (a) contentIntegrity — the existing content_hash, recomputed over what this context was built from.
    let contentIntegrity;
    if (record.version !== versionId) {
      contentIntegrity = { state: 'mismatch', reason: 'version_identity_mismatch', detail: `${where} calls itself ${JSON.stringify(record.version)}` };
    } else if (record.schema_version !== SCHEMA_VERSION) {
      contentIntegrity = { state: 'mismatch', reason: 'version_schema_unsupported', detail: `${where} schema_version ${JSON.stringify(record.schema_version)}` };
    } else if (typeof record.content_hash !== 'string' || !record.content_hash) {
      contentIntegrity = { state: 'unknown', reason: 'no_pinned_hash', detail: `${where} pins no content hash` };
    } else {
      const got = contentHash({ rid, schema_version: SCHEMA_VERSION, items: built.items, extras: built.extras, structure: built.structure });
      contentIntegrity = got === record.content_hash
        ? { state: 'intact', contentHash: got }
        : { state: 'mismatch', reason: 'catalog_content_mismatch', detail: `${where} read ${got.slice(0, 12)} != pinned ${record.content_hash.slice(0, 12)}` };
    }

    const certified = record.identity_certified === true;
    const policy = policyOf(built);
    const objectOf = (kind) => (r) => {
      const stamp = r.display ? r.display.identity_id : undefined;
      return {
        kind,
        legacyKey: r.key,
        // Owner D4-a Q2: ids ONLY from the version's own stamps, and only on a CERTIFIED version.
        canonicalId: certified && isStamp(stamp) ? stamp : null,
        price: r.price,
        label: r.display && isLabel(r.display.name) ? r.display.name : null,
        policy: membershipsFor(policy, kind, r.key),
        _rawStamp: isStamp(stamp) ? stamp : null,
      };
    };
    const withRaw = [...built.items.map(objectOf('dish')), ...built.extras.map(objectOf('extra'))];
    const dishes = withRaw.filter((o) => o.kind === 'dish');
    const extrasObjs = withRaw.filter((o) => o.kind === 'extra');

    const coverage = {
      dish: coverageOf(dishes, (o) => o.canonicalId !== null),
      extra: coverageOf(extrasObjs, (o) => o.canonicalId !== null),
    };
    // Reported SEPARATELY and never as canonicalId (owner Q2): stamps present on an uncertified version.
    const rawStampCoverage = {
      dish: coverageOf(dishes, (o) => o._rawStamp !== null),
      extra: coverageOf(extrasObjs, (o) => o._rawStamp !== null),
    };

    // Ids well-formed + unique PER KIND.
    const idProblems = [];
    for (const [kind, objs] of [['dish', dishes], ['extra', extrasObjs]]) {
      const seen = new Map();
      for (const o of objs) {
        if (o.canonicalId === null) continue;
        if (!validIdShape(o.canonicalId)) idProblems.push({ kind, legacyKey: o.legacyKey, problem: 'malformed' });
        if (seen.has(o.canonicalId)) idProblems.push({ kind, legacyKey: o.legacyKey, problem: 'duplicate', with: seen.get(o.canonicalId) });
        else seen.set(o.canonicalId, o.legacyKey);
      }
    }

    // Labels: a COMPLETENESS condition, reported apart from integrity ("not ready", not "corrupt").
    const missingLabels = withRaw.filter((o) => o.label === null).map((o) => ({ kind: o.kind, legacyKey: o.legacyKey }));

    const objects = withRaw.map(({ _rawStamp, ...o }) => o);   // eslint-disable-line no-unused-vars
    const labels = { state: missingLabels.length === 0 ? 'complete' : 'incomplete', missing: missingLabels };
    const ids = { wellFormed: !idProblems.some((p) => p.problem === 'malformed'), unique: !idProblems.some((p) => p.problem === 'duplicate'), problems: idProblems };

    // (c) — the completeness half of usable-as-identity.
    const complete = certified && coverage.dish.state === 'full' && coverage.extra.state === 'full'
      && ids.wellFormed && ids.unique && labels.state === 'complete';

    return {
      rid, versionId, seq: Number.isInteger(record.seq) ? record.seq : null,
      built: true, certified, contentIntegrity, objects, prices: pricesFromObjects(objects),
      coverage, rawStampCoverage, ids, labels, complete, policyRules: ruleSummary(policy),
    };
  } catch (e) {
    return failedContext(raw, 'builder_exception', e && e.message);
  }
}

// The (kind, canonicalId, legacyKey) pairs the registry verifier compares. Only objects that HAVE an
// id are pairs; an id-less object is a coverage fact, not a registry question.
function identityPairs(context) {
  if (!context || !Array.isArray(context.objects)) return [];
  return context.objects.filter((o) => o.canonicalId !== null)
    .map((o) => ({ kind: o.kind, canonicalId: o.canonicalId, legacyKey: o.legacyKey }));
}

module.exports = { buildContext, identityPairs, pricesFromObjects, snapOf };
