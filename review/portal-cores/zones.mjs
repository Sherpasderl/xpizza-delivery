// REVIEW ONLY — the «Envío · Zonas sin entrega» addendum SBS backend (advisor 11-15): every call the Envío page makes is answered by the
// REAL cores of the worktree under review over ONE strict faithful RTDB fake (test/_fake-rtdb-sdk) —
//   getMyBranches       5f's getMyBranchesCore (portal/ops-core.js); the signed-in person is a platform admin (platform_admins) AND the
//                       owner of one brand, bootstrapped by the REAL roster writer (as portal/ops-core.test.js)
//   getDeliveryPricing  5f's getDeliveryPricingCore with production's lock deps (delivery/pricing-admin-functions.js: the REAL
//   setDeliveryPricing  getIdentity, the REAL strict grace read, a registry read) and setDeliveryPricingCore
// The policy (bands + the stored zones) is WRITTEN by the real setDeliveryPricingCore while every restaurant is closed; only then are the
// scenario's hours applied (the order a real platform reaches the state in). Hours are absolute (closed every day / open 00:00–23:59), so
// the real clock judges them the same way at any shoot time.
// Scenarios (a frame's leading `scn:` step):
//   closed         every restaurant closed → zones_editable (A, F, G-rename)
//   open           Restaurante 2 + La Musa open → zones_lock open (B, H-B, I)
//   hours          Restaurante 8 has no valid hours → zones_lock hours_unknown (C)
//   opens_at_save  loads closed; the first save finds 4 restaurants opened and one without hours → the real 409
//                  zones_locked_while_open, five blocking branches (D, H-D, I-D)
//   hours_at_save  loads closed; the registry cannot be read fresh at the save → the real 503 hours_unavailable (E)
//   eight          8 zones stored (the cap) → «8 de 8», «Dibujar zona» off (G)
import { createRequire } from 'node:module';
import path from 'node:path';

const ADMIN = 'uShootAdmin';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const hoursAll = (d) => Object.fromEntries(DAYS.map((k) => [k, d]));
const CLOSED = hoursAll({ open: false }), OPEN = hoursAll({ open: true, start: '00:00', end: '23:59' });
// the platform's restaurants (the addendum's names: «Restaurante 2 · Sucursal 1», «La Musa», «Restaurante 8 · Sucursal 1», «y 2 más»)
const RESTS = [
  ['r_xp', 'b_xp', 'X. Pizza', 'Centro', 15.5075, -88.0398],
  ['r_lm', 'b_lm', 'La Musa', 'Centro', 15.5041, -88.0385],
  ['r_r2', 'b_r2', 'Restaurante 2', 'Sucursal 1', 15.512, -88.025],
  ['r_r5', 'b_r5', 'Restaurante 5', 'Sucursal 1', 15.49, -88.01],
  ['r_r6', 'b_r6', 'Restaurante 6', 'Sucursal 1', 15.53, -88.04],
  ['r_r8', 'b_r8', 'Restaurante 8', 'Sucursal 1', 15.47, -88.05],
];
const BANDS = [{ max_km: 3, cents: 4000 }, { max_km: 6, cents: 6000 }, { max_km: 10, cents: 8000 }];
// the addendum's two zones: «Sector A · 5 puntos», «Sector B · 4 puntos» ({ lat, lng } — the callable's own input shape)
const P = (pts) => pts.map(([lat, lng]) => ({ lat, lng }));
const SECTOR_A = { id: 'z_aaaaaaaa', name: 'Sector A', points: P([[15.540, -88.020], [15.545, -88.010], [15.552, -88.012], [15.553, -88.022], [15.546, -88.028]]) };
const SECTOR_B = { id: 'z_bbbbbbbb', name: 'Sector B', points: P([[15.430, -87.980], [15.430, -87.968], [15.440, -87.968], [15.440, -87.980]]) };
const sq = (n) => ({ id: `z_cccccc${String(n).padStart(2, '0')}`, name: `Sector ${String.fromCharCode(67 + n)}`,
  points: P([[15.40 + n * 0.02, -88.10], [15.40 + n * 0.02, -88.09], [15.41 + n * 0.02, -88.09], [15.41 + n * 0.02, -88.10]]) });
const quiet = { warn() {}, log() {}, error() {} };

export async function backend(root) {
  const req = createRequire(path.join(root, 'xpizza-functions', 'package.json'));
  const { fakeRtdb } = req('./test/_fake-rtdb-sdk');
  const CORE = req('./delivery/pricing-admin-core');
  const RC = req('./restaurant-config');
  const ZL = req('./delivery/zones-lock');
  const R = req('./access/roster');
  const C = req('./portal/ops-core');
  let db = null, at = 0, onSave = null;
  const reg = { fresh: true };
  const verifyIdToken = async () => ({ uid: ADMIN });
  const rq = (method, body) => ({ method, body, get: (h) => (String(h).toLowerCase() === 'authorization' ? 'Bearer shoot' : undefined) });
  // production's lock deps (pricing-admin-functions.js): the REAL getIdentity, the REAL strict grace read, a registry read
  const deps = () => ({ db, verifyIdToken, timestamp: () => Date.now() + (++at), now: () => Date.now(),
    readRegistry: async () => ({ ok: true, fresh: reg.fresh, ids: RESTS.map((r) => r[0]) }),
    getIdentity: (d, rid, now) => RC.getIdentity(d, rid, now), readGrace: (d) => ZL.readGraceMinutesStrict(d) });
  const adminOf = (d) => ({ ref: (p) => { const r = d.ref(p); return { ...r, once: (...x) => r.once(...x), get: () => r.once() }; } });
  const setHours = async (rid, hours) => { await db.ref(`restaurants/${rid}/identity/hours`).set(hours); RC._cache.clear(); };
  const dropHours = async (rid) => { await db.ref(`restaurants/${rid}/identity/hours`).remove(); RC._cache.clear(); };

  async function reset(scn) {
    RC._cache.clear(); at = 0; onSave = null; reg.fresh = true;
    db = fakeRtdb({
      platform_admins: { [ADMIN]: true },
      restaurants: Object.fromEntries(RESTS.map(([rid, bid, name, loc, lat, lng]) => [rid, { identity: { brand_id: bid, name, location_name: loc,
        phone: '+50499990000', active: true, version: 1, hub_lat: lat, hub_lng: lng, delivery_radius_km: 8, prep_default_min: 20, hours: CLOSED } }])),
      brands: Object.fromEntries(RESTS.map(([rid, bid, name]) => [bid, { name, active: true, locations: { [rid]: 'member' }, activation: { state: 'on', since: 1 } }])),
    }, { strict: true });
    const b = await R.mutateRoster({ db, now: () => 1 }, 'b_xp', { kind: 'cli', operator: 'shoot' }, { type: 'bootstrap_owner', uid: ADMIN, profile: { name: 'Admin Sherpa', email: 'admin@sherpa.hn' } });
    if (!b || b.ok === false) throw new Error(`premise: the roster writer bootstrapped the admin's brand (${JSON.stringify(b)})`);
    // the policy, written by the REAL writer while every restaurant is closed
    const zones = scn === 'eight' ? [SECTOR_A, SECTOR_B, ...Array.from({ length: 6 }, (_, n) => sq(n))] : [SECTOR_A, SECTOR_B];
    const w = await CORE.setDeliveryPricingCore(deps(), rq('POST', { expected_policy_version: 0, bands: BANDS, no_delivery_zones: zones }));
    if (w.status !== 200) throw new Error(`premise: the real writer stored the policy (${w.status} ${JSON.stringify(w.body)})`);
    if (scn === 'open') { await setHours('r_r2', OPEN); await setHours('r_lm', OPEN); }
    if (scn === 'hours') await dropHours('r_r8');
    if (scn === 'opens_at_save') onSave = async () => { for (const rid of ['r_r2', 'r_lm', 'r_r5', 'r_r6']) await setHours(rid, OPEN); await dropHours('r_r8'); };
    if (scn === 'hours_at_save') onSave = async () => { reg.fresh = false; };
  }
  async function call({ fn, method, body }) {
    if (fn === 'getMyBranches') return C.getMyBranchesCore({ db: adminOf(db), verifyIdToken, log: quiet }, rq(method));
    if (fn === 'getDeliveryPricing') return CORE.getDeliveryPricingCore(deps(), rq(method));
    if (fn === 'setDeliveryPricing') {
      if (onSave) { const f = onSave; onSave = null; await f(); }   // the world moves between the page's read and its save (one-shot)
      return CORE.setDeliveryPricingCore(deps(), rq(method, body));
    }
    return null;   // a gap (logged by the fixture), never a canned answer
  }
  return { reset, call, _db: () => db };
}
