'use strict';
// lib/driver-admin-ops.js — S1b driver-account admin operations (PLAN-S1b-BUILD rev 5, codex r5 APPROVE).
//
// The RTDB account record /driver_accounts/{uid} is the SINGLE SOURCE OF TRUTH; Firebase Auth is a derived
// projection (syncAuthToAccount). Concurrency is optimistic via the integer `version` (compare-and-set inside a
// transaction). No locks, no operation journal, no recovery protocol.
//
// Pure logic with INJECTED deps { db, auth, HttpsError, now } so every op is unit-testable and constructs no Admin
// app itself. The index.js onCall wrappers inject getDatabase()/getAuth()/HttpsError/Date.now() and call the
// authorization gate (dispatcher gate here, or the shared driver guard for submitDriverProfile) INLINE before
// delegating — so the split coverage guard sees the gate in each wrapper body.

const ADMIN_FLAG = 'config/driver_admin_enabled';
const TERMINAL = new Set(['completed', 'cancelled']);
const MAXLEN = 120;

function normEmail(e) { return String(e == null ? '' : e).trim().toLowerCase(); }
function normalize(cur) {
  const r = cur || {};
  return Object.assign({}, r, {
    enabled: r.enabled === true,
    deactivated: r.deactivated === true,
    version: typeof r.version === 'number' ? r.version : 0,
  });
}
function previouslyApproved(r) { return r.approved_at != null || r.grandfathered === true; }
function lastOp(type, actorUid, now, extra) { return Object.assign({ type, actor_uid: actorUid, at: now }, extra || {}); }

function reqStr(v, label, HttpsError) {
  if (typeof v !== 'string' || !v.trim() || v.length > MAXLEN) {
    throw new HttpsError('invalid-argument', `${label} inválido.`);
  }
  return v.trim();
}

// ---------------------------------------------------------------------------
// Gates (injected deps)
// ---------------------------------------------------------------------------
async function assertAdminEnabled(db, HttpsError) {
  const snap = await db.ref(ADMIN_FLAG).once('value');
  if (snap.val() !== true) throw new HttpsError('failed-precondition', 'La administración de repartidores está deshabilitada.');
}

// Dispatcher gate — rejects customer tokens, non-dispatchers, and disabled/revoked callers.
async function assertDispatcherCaller(uid, authToken, { db, auth, HttpsError }) {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  if (authToken && authToken.customer === true) throw new HttpsError('permission-denied', 'Solo despacho.');
  const [dispSnap, user] = await Promise.all([
    db.ref(`dispatchers/${uid}`).once('value'),
    auth.getUser(uid),
  ]);
  if (!dispSnap.exists()) throw new HttpsError('permission-denied', 'Solo despacho.');
  if (user && user.disabled) throw new HttpsError('permission-denied', 'Tu cuenta está deshabilitada.');
  const validAfterMs = user && user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : 0;
  const authTimeMs = authToken && authToken.auth_time ? authToken.auth_time * 1000 : 0;
  if (validAfterMs && authTimeMs && authTimeMs < validAfterMs) throw new HttpsError('permission-denied', 'Sesión expirada, iniciá sesión de nuevo.');
}

// Dual-role / shared-identity detection (§11) — CROSS-BRAND: a uid that is ALSO a dispatcher, kitchen, or any
// restaurant's kitchen_staff. This is role DETECTION, not brand-scoping the driver account.
async function isSharedIdentity(uid, db) {
  const [disp, kitchen, restaurants] = await Promise.all([
    db.ref(`dispatchers/${uid}`).once('value'),
    db.ref(`kitchen/${uid}`).once('value'),
    db.ref('restaurants').once('value'), // admin-only, rare call; restaurant set is small
  ]);
  if (disp.exists() || kitchen.exists()) return true;
  let shared = false;
  restaurants.forEach((r) => { if (r.child(`kitchen_staff/${uid}`).exists()) shared = true; });
  return shared;
}

// Enumerate orders with a NONTERMINAL task owned by uid, on EITHER leg (each leg is its own /tasks entry — this is
// the exact enumeration the §5 sweep monitor uses at index.js:~6394, covering delivery-only and split claims).
async function ownedNonterminalTasks(uid, db) {
  const tasks = (await db.ref('tasks').once('value')).val() || {};
  const orders = new Set();
  for (const [tid, t] of Object.entries(tasks)) {
    if (t && t.assigned_driver_id === uid && !TERMINAL.has(t.status)) orders.add(t.order_id || tid);
  }
  return [...orders];
}

// ---------------------------------------------------------------------------
// Auth projection — the derived side (findings 4/5/6/7, N2)
// ---------------------------------------------------------------------------
// CAS set onboarding_state 'void'. Commit only if version unchanged; a losing CAS is skipped quietly. Never throws.
async function voidAccount(uid, expectedVersion, { db, now }) {
  await db.ref(`driver_accounts/${uid}`).transaction((cur) => {
    if (cur === null) return; // nothing to void
    const v = typeof cur.version === 'number' ? cur.version : 0;
    if (expectedVersion != null && v !== expectedVersion) return; // lost CAS → skip, retry next sweep
    return Object.assign({}, cur, { onboarding_state: 'void', version: v + 1, updated_at: now });
  });
}

// Project the record onto Auth. disabled ⟺ deactivated===true; revoke whenever the session predates revoke_after.
// Identity verification + collision→void happen BEFORE any Auth mutation, and ONLY for S1b-provisioned records
// (those with a persisted email). A grandfathered record (S1a backfill, no email) reconciles by uid ALONE — it is
// never provisioned and never voided (r4/r5 fix).
async function syncAuthToAccount(uid, { db, auth, now }) {
  const rec = (await db.ref(`driver_accounts/${uid}`).once('value')).val();
  if (!rec) return;
  if (rec.onboarding_state === 'void') return; // skip quietly, never throw/enable
  const provisioned = rec.email != null && rec.email !== '';
  let user = null;
  try {
    user = await auth.getUser(uid);
  } catch (notFound) {
    if (!provisioned) return; // legacy/grandfathered w/o email: never provision, never void
    try {
      await auth.createUser({ uid, email: rec.email, disabled: true });
      user = await auth.getUser(uid);
    } catch (collision) {
      try { user = await auth.getUser(uid); } // re-read by uid and classify below
      catch (stillMissing) { await voidAccount(uid, normalize(rec).version, { db, now }); return; } // email taken by another uid → void
    }
  }
  if (provisioned && normEmail(user.email) !== normEmail(rec.email)) {
    await voidAccount(uid, normalize(rec).version, { db, now }); return; // existing ≠ persisted identity → void
  }
  const want = rec.deactivated === true;
  if (user.disabled !== want) await auth.updateUser(uid, { disabled: want });
  const validAfterMs = user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : 0;
  if (rec.revoke_after && validAfterMs < rec.revoke_after) await auth.revokeRefreshTokens(uid);
}

// Scheduled convergence — ALL accounts (no time window), runs regardless of the kill switch (N3). Per-account
// errors are swallowed so one bad record never halts the sweep.
async function sweepAuthSync({ db, auth, now }) {
  const snap = await db.ref('driver_accounts').once('value');
  const uids = [];
  snap.forEach((c) => { uids.push(c.key); });
  const out = { total: uids.length, synced: 0, errors: 0 };
  for (const uid of uids) {
    try { await syncAuthToAccount(uid, { db, auth, now }); out.synced++; }
    catch (e) { out.errors++; console.error('sweepAuthSync: account failed', uid, e && e.message); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The CAS transition core (optimistic `version`)
// ---------------------------------------------------------------------------
// Admin-SDK transaction reflects true server state (always online — same pattern as the S1a backfill). `cur===null`
// means the account is genuinely absent → abort. buildPatch(normalizedCur) returns the field patch or throws an
// HttpsError (aborts the transaction; we re-throw it). Always bumps version and stamps updated_at.
async function casTransition(uid, { db, HttpsError, now }, buildPatch) {
  let thrown = null;
  const res = await db.ref(`driver_accounts/${uid}`).transaction((cur) => {
    thrown = null;
    if (cur === null) { thrown = new HttpsError('failed-precondition', 'No existe la cuenta del repartidor.'); return; }
    const norm = normalize(cur);
    let patch;
    try { patch = buildPatch(norm); } catch (e) { thrown = e; return; }
    return Object.assign({}, cur, patch, { version: norm.version + 1, updated_at: now });
  });
  if (thrown) throw thrown;
  if (!res.committed) throw new HttpsError('aborted', 'El estado del repartidor cambió, reintentá.');
  return res.snapshot.val();
}

// ---------------------------------------------------------------------------
// The six operations
// ---------------------------------------------------------------------------
async function inviteDriver(params, deps) {
  const { db, auth, HttpsError, now } = deps;
  const actorUid = params.actorUid;

  if (params.uid) { // RE-INVITE by uid
    const rec = (await db.ref(`driver_accounts/${params.uid}`).once('value')).val();
    if (!rec) throw new HttpsError('failed-precondition', 'No existe el registro a reinvitar.');
    if (!rec.invited_by || !(rec.onboarding_state === 'pending' || rec.onboarding_state === 'profile_submitted')) {
      throw new HttpsError('failed-precondition', 'Solo se puede reinvitar un registro pendiente creado por despacho.');
    }
    const link = await auth.generatePasswordResetLink(normEmail(rec.email));
    appendOpLog(db, params.uid, lastOp('invite', actorUid, now, { reinvite: true }));
    return { ok: true, uid: params.uid, link }; // link NEVER persisted/logged (bearer credential)
  }

  // NEW invite
  const name = reqStr(params.name, 'Nombre', HttpsError);
  const phone = reqStr(params.phone, 'Teléfono', HttpsError);
  const email = normEmail(params.email);
  if (!email || email.length > MAXLEN || email.indexOf('@') < 1) throw new HttpsError('invalid-argument', 'Email inválido.');

  // duplicate-email check FIRST
  let existing = null;
  try { existing = await auth.getUserByEmail(email); } catch (e) { existing = null; }
  if (existing) {
    const rec = (await db.ref(`driver_accounts/${existing.uid}`).once('value')).val();
    if (rec && rec.invited_by && normEmail(rec.email) === email &&
        (rec.onboarding_state === 'pending' || rec.onboarding_state === 'profile_submitted')) {
      const link = await auth.generatePasswordResetLink(email); // re-invite the proven pending record
      appendOpLog(db, existing.uid, lastOp('invite', actorUid, now, { reinvite: true }));
      return { ok: true, uid: existing.uid, link };
    }
    throw new HttpsError('already-exists', 'Ese correo ya tiene cuenta.'); // zero Auth change
  }

  const uid = db.ref('driver_accounts').push().key; // server-chosen uid (never a random Firebase uid)
  await db.ref(`driver_accounts/${uid}`).set({
    enabled: false, deactivated: false, onboarding_state: 'pending',
    email, name, phone, invited_by: actorUid, invited_at: now, grandfathered: false,
    version: 0, last_op: lastOp('invite', actorUid, now), updated_at: now,
  }); // persist the record BEFORE createUser (durable, resumable by the reconciler)
  try {
    await auth.createUser({ uid, email, disabled: true });
  } catch (e) {
    await voidAccount(uid, 0, { db, now }); // uid/email collision for a different identity → void, never enable
    throw new HttpsError('already-exists', 'Ese correo ya tiene cuenta.');
  }
  await syncAuthToAccount(uid, deps); // converge: pending (not deactivated) ⇒ Auth enabled, driver can sign in
  const link = await auth.generatePasswordResetLink(email);
  appendOpLog(db, uid, lastOp('invite', actorUid, now));
  return { ok: true, uid, link };
}

async function submitDriverProfile(params, deps) {
  const { HttpsError } = deps;
  const uid = params.uid;
  const name = reqStr(params.name, 'Nombre', HttpsError);
  const phone = reqStr(params.phone, 'Teléfono', HttpsError);
  const vehicle = reqStr(params.vehicle, 'Vehículo', HttpsError);
  const plate = reqStr(params.plate, 'Placa', HttpsError);
  await casTransition(uid, deps, (r) => {
    if (r.onboarding_state !== 'pending') throw new HttpsError('failed-precondition', 'Tu perfil no está pendiente de envío.');
    return {
      onboarding_state: 'profile_submitted',
      profile: { name, phone, vehicle, plate, submitted_at: deps.now },
      last_op: lastOp('submit', uid, deps.now),
    };
  });
  return { ok: true };
}

async function approveDriver(params, deps) {
  const { HttpsError } = deps; const uid = params.uid; const actorUid = params.actorUid;
  await casTransition(uid, deps, (r) => {
    if (r.onboarding_state !== 'profile_submitted') throw new HttpsError('failed-precondition', 'El repartidor no tiene un perfil enviado para aprobar.');
    return { onboarding_state: 'active', enabled: true, approved_by: actorUid, approved_at: deps.now, last_op: lastOp('approve', actorUid, deps.now) };
  });
  await syncAuthToAccount(uid, deps); // ensure Auth enabled
  appendOpLog(deps.db, uid, lastOp('approve', actorUid, deps.now));
  return { ok: true };
}

async function setDriverSuspended(params, deps) {
  const { db, HttpsError } = deps; const uid = params.uid; const actorUid = params.actorUid;
  if (await isSharedIdentity(uid, db)) throw new HttpsError('failed-precondition', 'Esta identidad también es de despacho o cocina. Separá las identidades antes de suspender.');
  await casTransition(uid, deps, (r) => {
    if (!(r.enabled === true && r.onboarding_state === 'active' && r.deactivated !== true)) throw new HttpsError('failed-precondition', 'Solo se puede suspender a un repartidor activo.');
    return { enabled: false, suspended_at: deps.now, last_op: lastOp('suspend', actorUid, deps.now) };
  });
  await syncAuthToAccount(uid, deps); // no Auth change (deactivated false) — suspended drivers keep Auth
  appendOpLog(db, uid, lastOp('suspend', actorUid, deps.now));
  return { ok: true };
}

async function setDriverDeactivated(params, deps) {
  const { db, HttpsError, now } = deps; const uid = params.uid; const actorUid = params.actorUid;
  if (await isSharedIdentity(uid, db)) throw new HttpsError('failed-precondition', 'Cuenta con doble rol — separá las identidades antes de desactivar.');

  const rec0 = normalize((await db.ref(`driver_accounts/${uid}`).once('value')).val());
  if (!rec0 || rec0.onboarding_state === undefined) throw new HttpsError('failed-precondition', 'No existe la cuenta del repartidor.');
  if (rec0.onboarding_state === 'void') throw new HttpsError('failed-precondition', 'Registro inválido.');
  if (!(rec0.enabled === false && rec0.deactivated !== true && previouslyApproved(rec0))) {
    throw new HttpsError('failed-precondition', 'Primero suspendé al repartidor.');
  }
  const v = rec0.version;

  // precondition reads (server is the authority; the UI also pre-checks)
  const reasons = [];
  const drv = (await db.ref(`drivers/${uid}`).once('value')).val() || {};
  if (drv.active === true || (drv.current_shift_id !== undefined && drv.current_shift_id !== null)) reasons.push('open_shift');
  const openOrders = await ownedNonterminalTasks(uid, db);
  if (openOrders.length) reasons.push('open_tasks');
  if (params.cashAttested !== true) reasons.push('cash');
  if (reasons.length) throw new HttpsError('failed-precondition', 'No se puede desactivar todavía.', { reasons, open_orders: openOrders });

  await casTransition(uid, deps, (r) => {
    if (r.version !== v || !(r.enabled === false && r.deactivated !== true)) throw new HttpsError('aborted', 'El estado del repartidor cambió, reintentá.');
    return { deactivated: true, revoke_after: now, last_op: lastOp('deactivate', actorUid, now, { cash_confirmed: true }) };
  });
  await syncAuthToAccount(uid, deps); // disable + revoke (revoke_after = now)
  appendOpLog(db, uid, lastOp('deactivate', actorUid, now, { cash_confirmed: true }));
  return { ok: true };
}

async function reactivate(params, deps) {
  const { db, HttpsError } = deps; const uid = params.uid; const actorUid = params.actorUid;
  await casTransition(uid, deps, (r) => {
    const isSuspended = r.enabled === false && r.deactivated !== true && r.onboarding_state === 'active';
    const isDeactivated = r.deactivated === true;
    if (!((isSuspended || isDeactivated) && previouslyApproved(r))) throw new HttpsError('failed-precondition', 'Solo se puede reactivar una cuenta suspendida o desactivada.');
    return { enabled: true, deactivated: false, onboarding_state: 'active', suspended_at: null, last_op: lastOp('reactivate', actorUid, deps.now) };
    // NB: revoke_after is intentionally NOT touched (monotonic — a pre-deactivation session stays fenced).
  });
  await syncAuthToAccount(uid, deps); // re-enable; revoke_after still fences the old session
  appendOpLog(db, uid, lastOp('reactivate', actorUid, deps.now));
  return { ok: true };
}

// Best-effort human audit log; never throws, never blocks the op; never stores a reset link.
function appendOpLog(db, uid, entry) {
  try { db.ref('driver_account_ops').push(Object.assign({ uid }, entry)).catch(() => {}); } catch (e) { /* best-effort */ }
}

module.exports = {
  ADMIN_FLAG,
  normEmail, normalize, previouslyApproved, lastOp,
  assertAdminEnabled, assertDispatcherCaller, isSharedIdentity, ownedNonterminalTasks,
  voidAccount, syncAuthToAccount, sweepAuthSync, casTransition,
  inviteDriver, submitDriverProfile, approveDriver, setDriverSuspended, setDriverDeactivated, reactivate,
};
