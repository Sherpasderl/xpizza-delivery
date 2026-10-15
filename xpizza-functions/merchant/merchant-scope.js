'use strict';
// H1a C-3/C-4 — who may act for a location.
//   authorizeHandheld: a server-created device account (claims {handheld, rid}) with an unrevoked registry row under the
//     location — restaurants/{rid}/handhelds/{uid} = {kind:'handheld', revoked:false, …}. Checked on EVERY call, so a revoked
//     device is refused immediately even while its ID token is still valid.
//   authorizeManager: a human who may pair / revoke devices — an owner of brandOf(rid) or a manager of rid.
// The brand is resolved through an injected `resolveBrand(db, rid)` (F1's brandIdOf behind merchant-brand.js); 'unknown' is
// refused before any role or registry read. Every read failure is `unavailable` (fail closed), never a grant.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const deny = (code) => ({ ok: false, code });
async function readVal(db, path) { return (await db.ref(path).once('value')).val(); }

async function brandOrDeny(db, rid, resolveBrand) {
  try {
    const b = await resolveBrand(db, rid);
    return typeof b === 'string' && b !== 'unknown' ? { brand: b } : { denied: deny('forbidden') };
  } catch (_) { return { denied: deny('unavailable') }; }
}

async function authorizeHandheld(db, auth, rid, { resolveBrand }) {
  if (!auth || !auth.uid) return deny('unauthenticated');
  const t = auth.token || {};
  if (t.customer === true) return deny('forbidden');
  if (t.handheld !== true || t.rid !== rid) return deny('forbidden');
  const b = await brandOrDeny(db, rid, resolveBrand);
  if (b.denied) return b.denied;
  let row;
  try { row = await readVal(db, `restaurants/${rid}/handhelds/${auth.uid}`); } catch (_) { return deny('unavailable'); }
  if (!isObj(row) || row.kind !== 'handheld' || row.revoked === true) return deny('forbidden');
  return { ok: true, uid: auth.uid };
}

async function authorizeManager(db, auth, rid, { resolveBrand }) {
  if (!auth || !auth.uid) return deny('unauthenticated');
  const t = auth.token || {};
  if (t.customer === true || t.handheld === true) return deny('forbidden');
  const b = await brandOrDeny(db, rid, resolveBrand);
  if (b.denied) return b.denied;
  try {
    if ((await readVal(db, `restaurants/${b.brand}/owners/${auth.uid}`)) != null) return { ok: true, uid: auth.uid, tier: 'owner' };
    if ((await readVal(db, `restaurants/${rid}/managers/${auth.uid}`)) != null) return { ok: true, uid: auth.uid, tier: 'manager' };
  } catch (_) { return deny('unavailable'); }
  return deny('forbidden');
}

module.exports = { authorizeHandheld, authorizeManager };
