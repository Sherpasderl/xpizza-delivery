'use strict';
// ---------------------------------------------------------------------------
// Portal 1D · D4-P1 — THE STAMP MAP, AND ITS RE-VERIFICATION AT THE WRITE POINT (§3.1, §4).
//
// 🔴 WHAT WAS MISSING, AND WHY IT WAS A LOCKOUT RATHER THAN A GAP. `writeVersion` has taken a `stamps`
// map since Slice A, and NOTHING has ever supplied one — not production, not a test, not a tool. So
// `identity_certified` was false on every publish path that exists, and the only thing that ever
// certified a version was bootstrap's one-time in-place update. Work that through post-cutover:
//   1. bootstrap certifies v1 and enriches the source, so the draft carries ids;
//   2. the merchant's FIRST publish is lawful — A is v1's certified set and the draft carries exactly
//      those — and produces v2 UNCERTIFIED;
//   3. their SECOND publish reads A from v2, which is certified-false, so A = ∅ while the draft still
//      carries ids from the stamped source. C ⊄ A, and the partition law REFUSES.
// One publish after cutover, then locked out of their own menu, with no way back: stripping the stamps
// from the source is refused by the same law. That is a production lockout on x_pizza, and it was
// latent in the built code rather than hypothetical.
//
// So this module is the missing half of the mechanism: the KNOWN→keep part of §4's pre-flip
// allocation. It mints nothing, moves nothing, retires nothing and writes nothing to the registry —
// the rename flag is OFF in P1a and Slice E owns allocation. It only says, for objects whose ids the
// partition law has ALREADY validated: this is the id the server certifies for this object.
//
// 🔴 AND THE MAP IS RE-VERIFIED RATHER THAN TRUSTED, WHICH IS THE POINT OF DOING IT HERE. The ids in
// a draft arrive through `display`, which round-trips losslessly through the merchant's editor — that
// is how a stamp survives an edit, and it is also how a merchant-controlled field could become server
// certification, the one thing inv #1 prohibits. The partition law checks that a carried id belongs to
// the active certified SET; it cannot check that THIS id belongs to THIS object. So a draft that moves
// one dish's id onto another dish satisfies the law by set membership and would stamp the wrong
// identity into an immutable version. The re-verification asks the registry per object, by name, and
// refuses any disagreement — after which the stamp is the server's answer, not the draft's claim.
// ---------------------------------------------------------------------------
const { STATUS_LIVE } = require('./identity-registry');

const isStr = (v) => typeof v === 'string' && v.length > 0;
const permit = (code, detail) => ({ ok: true, code, detail: detail || '' });
const refuse = (code, detail, extra) => ({ ok: false, code, detail, ...(extra || {}) });

/* THE MAP, DERIVED FROM WHAT THE DRAFT CARRIES. Pure, and deliberately NOT a registry read: this is
   the claim, and everything below is the check. Objects carrying no id are absent from the map — they
   are the `unidentified` bucket the partition law treats as minting, and P1a does not mint (E does).
   🔴 A VERSION IS STILL CERTIFIED WITH SOME OBJECTS UNSTAMPED, and that is deliberate rather than an
   oversight. `identity_certified` says "this version's stamps are the server's", not "every object has
   one". If a single newly-added dish decertified the whole version, the merchant's next publish would
   read A = ∅ and hit exactly the lockout above — a brand-new dish would lock the menu. The unstamped
   new object is simply not in A next time, carries no id, and stays lawful as `unidentified` until E
   mints it inside the atomic writer. */
const isEmptyMap = (stamps) => !stamps
  || (Object.keys(stamps.dish || {}).length === 0 && Object.keys(stamps.extra || {}).length === 0);

/* 🔴 ONE WALK OVER THE DRAFT, PRODUCING EVERYTHING THAT IS DERIVED FROM IT. The partition law needs
   `carried` and `unidentified`; the writer needs the stamp map. Deriving those in two traversals —
   which is what this module used to do, with the law walking the rows and `deriveStampMap` walking
   them again afterwards — means two places to change and a comment claiming they are "the same walk"
   that is not true. The D-5a gate called that exactly right: one derivation site, no downstream
   re-derivation, but not the thing the comment said.
   So the walk itself is the shared thing. The set the law validates and the map that gets written are
   filled from the same row in the same iteration, which is the property the claim rested on.

   🔴 NULL WHEN NOTHING IS STAMPED, NOT AN EMPTY MAP. `writeVersion` reads `!!stamps` as "this version
   is certified", and an empty object is truthy — so a pre-cutover draft, which carries no ids at all,
   would have produced a version marked CERTIFIED with zero stamps. That version's active certified set
   is empty, which is the A = ∅ state the publish lockout is made of: it would have moved the bug
   rather than fixed it. Null is the value the parameter has always defaulted to, so every pre-cutover
   path stays byte-for-byte what it was.

   🔴 A VERSION IS STILL CERTIFIED WITH SOME OBJECTS UNSTAMPED, deliberately. `identity_certified` says
   "this version's stamps are the server's", not "every object has one". If a single newly-added dish
   decertified the whole version, the merchant's next publish would read A = ∅ and hit exactly the
   lockout above — a brand-new dish would lock the menu. The unstamped new object is simply not in A
   next time, carries no id, and stays lawful as `unidentified` until E mints it in the atomic writer. */
function walkDraftIdentities(input) {
  const carried = { dish: [], extra: [] };
  const unidentified = { dish: [], extra: [] };
  const stamps = { dish: {}, extra: {} };
  for (const [kind, rows] of [['dish', input && input.items], ['extra', input && input.extraRecords]]) {
    for (const o of (Array.isArray(rows) ? rows : [])) {
      const id = o && o.display && o.display.identity_id;
      if (!isStr(id)) { unidentified[kind].push({}); continue; }
      carried[kind].push(id);
      if (isStr(o.key)) stamps[kind][o.key] = id;
    }
  }
  return { carried, unidentified, stamps: isEmptyMap(stamps) ? null : stamps };
}

/* ONE OBJECT'S STAMP, JUDGED AGAINST THE REGISTRY.
   `inCandidate` — whether the version being written actually contains this key. A map naming a key
                   this candidate does not have was resolved against a different draft.
   `keyRowId`    — `keys/{encode(key)}.canonical_id`, the registry's forward answer for this NAME.
   `idRow`       — `ids/{claimedId}` as {status, legacy_key}, or null. Read as well as the key row for
                   the reason bootstrap reads both (`assertKeyRowAgrees`): a forward row is a pointer,
                   and a pointer at a retired or re-keyed id would certify a dead identity into an
                   immutable version, where it can never be corrected. */
function stampVerdict({ kind, key, claimedId, inCandidate = false, keyRowId = null, idRow = null } = {}) {
  if (!isStr(kind) || !isStr(key) || !isStr(claimedId)) {
    return refuse('stamp_input_malformed',
      `a stamp needs a kind, a key and the id claimed for it; got ${JSON.stringify(kind)} / ${JSON.stringify(key)} / ${JSON.stringify(claimedId)}`);
  }
  if (inCandidate !== true) {
    return refuse('stamp_not_in_candidate',
      `${kind}/${key}: the stamp map names an object this version does not contain, so it was resolved against a different draft`);
  }
  if (!isStr(keyRowId)) {
    return refuse('stamp_unregistered',
      `${kind}/${key}: the registry has no mapping for this name, so the server never issued the id the draft carries`);
  }
  /* 🔴 THE ONE THAT MATTERS MOST. The draft says this object is ${claimedId}; the registry says this
     NAME is ${keyRowId}. The partition law cannot catch it — moving one live object's id onto another
     object still satisfies C ⊆ A, because both ids are in the active certified set — so without this
     a merchant-controlled field becomes server certification for the wrong object, written into an
     immutable version. */
  if (keyRowId !== claimedId) {
    return refuse('stamp_registry_disagrees',
      `${kind}/${key}: the draft carries ${claimedId} but the registry maps this name to ${keyRowId}; a carried id is a claim, and only the registry certifies`,
      { claimed: claimedId, registry: keyRowId });
  }
  if (!idRow) {
    return refuse('stamp_id_row_missing',
      `${kind}/${key}: ${claimedId} has a key row but no id row; the registry disagrees with itself and a version must not freeze that`);
  }
  if (idRow.status !== STATUS_LIVE) {
    return refuse('stamp_id_retired',
      `${kind}/${key}: ${claimedId} is ${JSON.stringify(idRow.status)}, not live; certifying a retired id into an immutable version can never be corrected`);
  }
  if (idRow.legacy_key !== key) {
    return refuse('stamp_id_claims_other_name',
      `${kind}/${key}: ${claimedId} claims ${JSON.stringify(idRow.legacy_key)}; the forward and reverse rows disagree and the id has moved since the key row was written`);
  }
  return permit('verified', `${kind}/${key} → ${claimedId}`);
}

/* THE FENCE THE WHOLE MAP HANGS FROM. The map is resolved against the baseline captured when the
   candidate was built; if the pointer has moved since, every membership decision behind it was made
   against a menu that is no longer live. The flip's CAS would refuse the activation later anyway —
   this refuses BEFORE an immutable version is written, which is the difference between a refused
   publish and a permanent retained version nobody can activate.
   🔴 THE SAME PAIR FEEDS THE ACTIVATION RECORD. `writeVersion` stamps `identity_activation` with this
   baseline, so the fence this map was verified against and the fence the record claims are one value
   by construction, not two reads that can disagree. */
function fenceVerdict({ baseline = null, live = null, resolvedAgainst = undefined } = {}) {
  if (!baseline || typeof baseline !== 'object' || !Number.isInteger(baseline.generation) || baseline.generation < 0) {
    return refuse('stamp_fence_unbound',
      'a stamped version must record the {version, generation} pair its ids were resolved against');
  }
  if (!live || typeof live !== 'object' || !Number.isInteger(live.generation)) {
    return refuse('stamp_fence_unreadable',
      'the live pointer pair could not be read, so the stamp map cannot be bound to a baseline');
  }
  const pair = (p) => `${p && p.version !== undefined ? p.version : null}@${p ? p.generation : '?'}`;
  /* 🔴 THE PRE-LEASE WINDOW, WHICH IS A THIRD PAIR AND NOT A REPEAT OF THE SECOND. The partition law
     runs BEFORE the lease is taken — deliberately, so an invalid draft costs no lease — so another
     publish can land between the law's pointer read and the candidate's. The map's membership
     decisions were made against the LAW's pair; the activation record claims the CANDIDATE's. If
     those two differ, the map was resolved against a menu that had already been replaced by the time
     this candidate existed, and every id in it was checked against the wrong active set. */
  if (resolvedAgainst !== undefined) {
    if (!resolvedAgainst || !Number.isInteger(resolvedAgainst.generation)) {
      return refuse('stamp_fence_unbound',
        'the pair the stamp map was resolved against must be recorded, not inferred');
    }
    if (pair(resolvedAgainst) !== pair(baseline)) {
      return refuse('stamp_fence_resolved_elsewhere',
        `the stamp map was resolved against ${pair(resolvedAgainst)} but this candidate was built against ${pair(baseline)}; an activation landed between validating the draft and building the version`,
        { resolved_against: pair(resolvedAgainst), candidate: pair(baseline) });
    }
  }
  const b = pair(baseline);
  const l = pair(live);
  if (b !== l) {
    return refuse('stamp_fence_moved',
      `the stamp map was resolved against ${b} but ${l} is live; something activated while this candidate was being built`,
      { resolved_against: b, live: l });
  }
  return permit('fence_current', b);
}

/* THE WHOLE MAP. Returns every verdict, in kind then key order, so a refusal can name everything that
   is wrong rather than whichever object happened to be read first — a merchant told about one bad
   object at a time learns nothing about the shape of the problem.
   An EMPTY map is not verified and not fenced: it certifies nothing, so there is nothing to bind. That
   is the pre-cutover path and it must stay frictionless, or every unstamped publish starts paying for
   machinery it does not use. */
function judgeStampMap({ stamps, candidateKeys = {}, registry = {}, baseline = null, live = null, resolvedAgainst = undefined } = {}) {
  if (isEmptyMap(stamps)) return { empty: true, fence: permit('no_stamps', 'nothing certified, nothing to bind'), stamps: [] };

  const fence = fenceVerdict({ baseline, live, resolvedAgainst });
  const out = [];
  for (const kind of ['dish', 'extra']) {
    const claimed = (stamps && stamps[kind]) || {};
    const have = candidateKeys[kind] instanceof Set ? candidateKeys[kind] : new Set(candidateKeys[kind] || []);
    const reg = registry[kind] instanceof Map ? registry[kind] : new Map(Object.entries(registry[kind] || {}));
    for (const key of Object.keys(claimed).sort()) {
      const r = reg.get(key) || {};
      out.push({ kind, key, claimedId: claimed[key],
        verdict: stampVerdict({ kind, key, claimedId: claimed[key], inCandidate: have.has(key), keyRowId: r.keyRowId || null, idRow: r.idRow || null }) });
    }
  }
  return { empty: false, fence, stamps: out };
}

module.exports = { walkDraftIdentities, stampVerdict, fenceVerdict, judgeStampMap };
