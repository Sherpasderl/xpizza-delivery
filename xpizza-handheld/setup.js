// H1b T6 — setup (PLAN-H1b T6; advisor 6; codex P1-6; BC4; advisor prep-base ruling). All I/O is injected.
//   Pairing (mockup A1/A2): the owner/manager signs in (transient) → merchantMyLocations → zero: C-1 copy; one: the picker is
//   skipped; several: the picker → merchantPairDevice for the SELECTED location only → the human is signed out → the device signs in
//   with the custom token → {uid, rid, brand_id, location_name, prep_default_min} persisted device-local. A failed token exchange
//   returns to the picker (the device row stays for a manager to revoke — U3).
//   The prep base: persisted at pairing (pairing requires one, server-side); a VALID refresh from merchantOrderState updates it; a
//   null / invalid refresh KEEPS it — a paired device never has "no base".
//   PIN: PBKDF2-SHA-256 (WebCrypto), 100k iterations, random salt, device-local, never sent. 5 failures → 1 min lockout. BC4: the
//   attempt count and lockout_until (WALL clock) are persisted, so a restart cannot reset the lockout; within a session the local
//   monotonic clock also counts, so setting the wall clock back cannot shorten it.
//   signOut: gen bump FIRST (voids every in-flight result), then feeds, undo, ETA, the queue partition (discarded with a note), the
//   alarm, the Auth sign-out, the stored session.
export const C1_NO_LOCATIONS = 'No tenés sucursales para vincular. Pedile acceso al dueño de la marca.';
const SESSION_KEY = 'hh_session';
const PIN_KEY = 'hh_pin';
const LOCK_KEY = 'hh_pin_lock';
const PIN_ITER = 100000;
const MAX_FAILS = 5;
const LOCK_MS = 60000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validBase = (v) => Number.isInteger(v) && v >= 5 && v <= 120;
const strip = (c) => (typeof c === 'string' ? c.replace(/^functions\//, '') : 'error');

// ── session ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function createSessionStore(storage) {
  const read = () => { try { const v = JSON.parse(storage.get(SESSION_KEY) || 'null'); return isObj(v) && typeof v.uid === 'string' && typeof v.rid === 'string' ? v : null; } catch (_) { return null; } };
  return {
    load: read,
    save(s) { storage.set(SESSION_KEY, JSON.stringify(s)); },
    clear() { storage.remove(SESSION_KEY); },
    refreshBase(v) {
      const s = read();
      if (!s) return null;
      if (validBase(v) && v !== s.prep_default_min) { s.prep_default_min = v; try { storage.set(SESSION_KEY, JSON.stringify(s)); } catch (_) { /* keep in memory next time */ } }
      return s.prep_default_min;
    },
  };
}

// ── pairing ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function startPairing({ auth, call, store }, { email, password }) {
  await auth.signInHuman(email, password);
  const raw = await call('merchantMyLocations', {});
  const rows = (Array.isArray(raw) ? raw : []).filter((r) => isObj(r) && typeof r.rid === 'string' && typeof r.brand_id === 'string');
  const pair = async (sel, label) => {
    let res;
    try { res = await call('merchantPairDevice', { rid: sel.rid, label }); } catch (e) { return { ok: false, screen: 'branch', error: strip(e && e.code) }; }
    if (!isObj(res) || typeof res.custom_token !== 'string') return { ok: false, screen: 'branch', error: 'error' };
    await auth.signOut();                             // the human leaves BEFORE the device identity arrives
    let dev;
    try { dev = await auth.signInWithToken(res.custom_token, res.uid); } catch (_) { return { ok: false, screen: 'branch', error: 'token_exchange' }; }
    const session = { uid: (dev && dev.uid) || res.uid, rid: sel.rid, brand_id: sel.brand_id, location_name: sel.location_name || null,
      prep_default_min: validBase(sel.prep_default_min) ? sel.prep_default_min : null };
    store.save(session);
    return { ok: true, session };
  };
  if (!rows.length) return { screen: 'none', copy: C1_NO_LOCATIONS, rows, pair };
  if (rows.length === 1) return { screen: 'checks', selected: rows[0], rows, pair };
  return { screen: 'branch', rows, pair };
}

// ── PIN ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function derive(pin, salt, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return b64(new Uint8Array(bits));
}
export async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { v: 1, iter: PIN_ITER, salt: b64(salt), hash: await derive(String(pin), salt, PIN_ITER) };
}
export async function verifyPin(pin, rec) {
  if (!isObj(rec) || typeof rec.salt !== 'string' || typeof rec.hash !== 'string' || !Number.isInteger(rec.iter)) return false;
  try {
    const got = await derive(String(pin), unb64(rec.salt), rec.iter);
    if (got.length !== rec.hash.length) return false;
    let diff = 0; for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ rec.hash.charCodeAt(i);
    return diff === 0;
  } catch (_) { return false; }
}

export function createPinGate({ storage, wall = () => Date.now(), mono = () => performance.now() }) {
  const readLock = () => { try { const v = JSON.parse(storage.get(LOCK_KEY) || 'null'); return isObj(v) ? v : { fails: 0, lockout_until: null }; } catch (_) { return { fails: 0, lockout_until: null }; } };
  const writeLock = (v) => { try { storage.set(LOCK_KEY, JSON.stringify(v)); return true; } catch (_) { return false; } };
  let session = null;                                 // {monoStart, ms} for the lock started in THIS session
  // within a session: remaining = min(wall-based, mono-based) — elapsed is the max of the two clocks (T2's rule), so neither a
  // suspended monotonic clock nor a wall clock set back stretches it; after a restart only the persisted wall deadline exists
  const remaining = (lk) => {
    const wallRem = typeof lk.lockout_until === 'number' ? lk.lockout_until - wall() : 0;
    let r = wallRem;
    if (session) {
      const monoRem = session.ms - (mono() - session.monoStart);
      r = session.closed ? monoRem : Math.min(wallRem, monoRem);   // closed = the lockout could not be persisted: mono alone holds it
    }
    return Math.max(0, Math.min(LOCK_MS, r));
  };
  const lockNow = () => { session = { monoStart: mono(), ms: LOCK_MS, closed: !writeLock({ fails: 0, lockout_until: wall() + LOCK_MS }) }; return { ok: false, locked: true, remainingMs: LOCK_MS }; };
  // codex H1b r1 P1-5: attempts are SERIALIZED (a chain), each attempt is COUNTED and persisted BEFORE the slow PBKDF2 verify (a kill
  // mid-verify still counts), and a count / lockout that cannot be persisted FAILS CLOSED (locked for the full minute in-session).
  let chain = Promise.resolve();
  async function attempt(pin, rec) {
    const lk = readLock();
    const rem = remaining(lk);
    if (rem > 0) return { ok: false, locked: true, remainingMs: rem };
    const fails = (lk.lockout_until !== null && rem === 0 ? 0 : (lk.fails || 0)) + 1;
    if (!writeLock({ fails, lockout_until: null })) return lockNow();
    if (await verifyPin(pin, rec)) { writeLock({ fails: 0, lockout_until: null }); session = null; return { ok: true }; }
    if (fails >= MAX_FAILS) return lockNow();
    return { ok: false, locked: false };
  }
  return {
    setRecord(rec) { storage.set(PIN_KEY, JSON.stringify(rec)); writeLock({ fails: 0, lockout_until: null }); session = null; },
    record() { try { return JSON.parse(storage.get(PIN_KEY) || 'null'); } catch (_) { return null; } },
    clear() { storage.remove(PIN_KEY); storage.remove(LOCK_KEY); session = null; },
    try(pin) {
      const run = chain.then(() => attempt(pin, this.record()));
      chain = run.catch(() => {});
      return run;
    },
  };
}

// ── sign-out / Cambiar sucursal / Olvidé el PIN (O-1: local) ─────────────────────────────────────────────────────────────────
export async function signOut({ session, feeds, queue, undoStop, eta, bridge, auth, store }, reason) {
  session.bump();                                     // FIRST: every in-flight send / result is now void
  if (feeds) feeds.stop();
  if (undoStop) undoStop();
  if (eta) eta.stopAll();
  const note = queue ? queue.discard(reason) : { discarded: 0, reason };
  if (bridge) bridge.alarm.stop();
  await auth.signOut();
  if (store) store.clear();
  return note;
}
