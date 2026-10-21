'use strict';
// H1a C-3/C-4 — device pairing, revocation and heartbeat.
//   pairDevice:   pairing gate ON (A1 sets it only after F2(c) narrowed the rules) + an owner/manager of the location →
//                 a fresh Auth user (server-chosen uid hh_{rid}_{rand}), the registry row, and a custom token carrying ONLY
//                 {handheld:true, rid}. A request that tries to choose the uid or claims is refused. PRECONDITION (advisor,
//                 prep base): the location has a valid identity.prep_default_min, so a paired device always has a base.
//                 H1c (codex H1c-server r3): every pairing takes a server-issued, strictly increasing pair_gen from ONE counter
//                 transaction (platform_config/handheld_pair_gen) and stores it on the row — the authoritative order of pairings
//                 that push registration fences on (never a client value, never a clock).
//   revokeDevice: never gated. The target must ALREADY be a kind:'handheld' row under the authorized rid — otherwise not-found,
//                 with no Auth call and no row created. Steps in order, each idempotent, so a retry recovers a partial failure:
//                 revoked:true (immediate denial via the registry + the F2 rule clause) → disable the user → revoke tokens.
//   heartbeat:    a registered, unrevoked device stamps last_seen (feeds the dispatch "dispositivo sin conexión" notice only).
const V = require('./merchant-validate');
const { pairingEnabled } = require('./merchant-gate');
const { authorizeHandheld, authorizeManager } = require('./merchant-scope');

const AUTH_CODE = { unauthenticated: 'unauthenticated', forbidden: 'permission-denied', unavailable: 'unavailable' };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function onlyKeys(data, allowed, HttpsError) {
  if (!isObj(data)) throw new HttpsError('invalid-argument', 'bad request');
  const extra = Object.keys(data).filter((k) => !allowed.includes(k));
  if (extra.length) throw new HttpsError('invalid-argument', `unexpected fields: ${extra.sort().join(', ')}`);
}
async function asManager({ db, resolveBrand, HttpsError }, auth, rid) {
  const a = await authorizeManager(db, auth, rid, { resolveBrand });
  if (!a.ok) throw new HttpsError(AUTH_CODE[a.code] || 'permission-denied', a.code);
  return a.uid;
}

// the next pairing generation. null-first safe: a null read proposes 1 and RTDB re-runs with the real value when the counter exists.
// A malformed counter is never "repaired" by restarting (that would re-issue generations): it aborts, and pairing is refused. Safe
// integers only: an exhausted counter (MAX_SAFE_INTEGER) refuses BEFORE incrementing, so a generation is never imprecise or repeated.
const nextPairGen = (cur) => (cur === null ? 1 : Number.isSafeInteger(cur) && cur >= 1 && cur < Number.MAX_SAFE_INTEGER ? cur + 1 : undefined);

async function pairDevice(deps, auth, data) {
  const { db, adminAuth, HttpsError, now, randomId } = deps;
  onlyKeys(data, ['rid', 'label'], HttpsError);
  const rid = V.vRid(data.rid); const label = V.vLabel(data.label);
  if (!rid || !label) throw new HttpsError('invalid-argument', 'bad rid/label');
  if (!(await pairingEnabled(db))) throw new HttpsError('failed-precondition', 'not_enabled');
  const by = await asManager(deps, auth, rid);
  let base;
  try { base = V.vPrepBase((await db.ref(`restaurants/${rid}/identity/prep_default_min`).once('value')).val()); } catch (_) { throw new HttpsError('unavailable', 'identity unreadable'); }
  if (base === null) throw new HttpsError('failed-precondition', 'no_prep_base');
  const uid = `hh_${rid}_${randomId()}`;
  let pairGen = null; let g;
  try { g = await db.ref('platform_config/handheld_pair_gen').transaction((cur) => { pairGen = nextPairGen(cur); return pairGen; }); }
  catch (_) { throw new HttpsError('unavailable', 'pair generation unavailable'); }
  if (!g || !g.committed || !Number.isInteger(pairGen) || g.snapshot.val() !== pairGen) throw new HttpsError('unavailable', 'pair generation unavailable');
  await adminAuth.createUser({ uid });
  await db.ref(`restaurants/${rid}/handhelds/${uid}`).set({ kind: 'handheld', label, paired_at: now(), paired_by: by, revoked: false, pair_gen: pairGen });
  const custom_token = await adminAuth.createCustomToken(uid, { handheld: true, rid });
  return { uid, custom_token };
}

async function revokeDevice(deps, auth, data) {
  const { db, adminAuth, HttpsError, now } = deps;
  onlyKeys(data, ['rid', 'uid'], HttpsError);
  const rid = V.vRid(data.rid);
  const uid = typeof data.uid === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.uid) ? data.uid : null;
  if (!rid || !uid) throw new HttpsError('invalid-argument', 'bad rid/uid');
  const by = await asManager(deps, auth, rid);
  let row;
  try { row = (await db.ref(`restaurants/${rid}/handhelds/${uid}`).once('value')).val(); } catch (_) { throw new HttpsError('unavailable', 'registry unreadable'); }
  if (!isObj(row) || row.kind !== 'handheld') throw new HttpsError('not-found', 'no such handheld at this location');
  if (row.revoked !== true) await db.ref(`restaurants/${rid}/handhelds/${uid}`).update({ revoked: true, revoked_at: now(), revoked_by: by });
  await adminAuth.updateUser(uid, { disabled: true });
  await adminAuth.revokeRefreshTokens(uid);
  return { ok: true, uid };
}

async function heartbeat(deps, auth, data) {
  const { db, resolveBrand, HttpsError, now } = deps;
  const rid = V.vRid(data && data.rid);
  if (!rid) throw new HttpsError('invalid-argument', 'bad rid');
  const a = await authorizeHandheld(db, auth, rid, { resolveBrand });
  if (!a.ok) throw new HttpsError(AUTH_CODE[a.code] || 'permission-denied', a.code);
  await db.ref(`restaurants/${rid}/handhelds/${a.uid}`).update({ last_seen: now() });
  return { ok: true };
}

// merchantMyLocations (advisor O-2): the locations a HUMAN may pair a device for — every member location of a brand they own,
// plus each member location they manage (ORCHESTRATION O1a: STAGED locations count as members here). Retired locations are excluded. Reads /brands (small) and per-candidate owner /
// manager / location_name / prep_default_min nodes; never /orders. Devices and customers are refused; a read failure is `unavailable`.
async function myLocations(deps, auth, _data) {
  const { db, HttpsError } = deps;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'sign in');
  const t = auth.token || {};
  if (t.customer === true || t.handheld === true) throw new HttpsError('permission-denied', 'forbidden');
  const val = async (p) => (await db.ref(p).once('value')).val();
  const out = [];
  try {
    const brands = (await val('brands')) || {};
    for (const b of Object.keys(brands).sort()) {
      const locs = isObj(brands[b]) && isObj(brands[b].locations) ? brands[b].locations : {};
      const members = Object.keys(locs).filter((rid) => (locs[rid] === 'member' || locs[rid] === 'staged') && V.vRid(rid)).sort();   // O1a T9: staged too (pair + managers before opening)
      if (!members.length) continue;
      const owner = (await val(`restaurants/${b}/owners/${auth.uid}`)) != null;
      for (const rid of members) {
        if (!owner && (await val(`restaurants/${rid}/managers/${auth.uid}`)) == null) continue;
        const name = await val(`restaurants/${rid}/identity/location_name`);
        const base = V.vPrepBase(await val(`restaurants/${rid}/identity/prep_default_min`));
        out.push({ rid, brand_id: b, location_name: typeof name === 'string' ? name : null, prep_default_min: base });
      }
    }
  } catch (_) { throw new HttpsError('unavailable', 'locations unreadable'); }
  return out;
}

module.exports = { pairDevice, revokeDevice, heartbeat, myLocations };
