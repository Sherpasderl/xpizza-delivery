'use strict';
// DRIVER C (PLAN-driver-server-C-llegue r3, Codex r4 APPROVE; OWNER-APPROVED mockup) — «Llegué · avisar a {Nombre}». The driver's
// tap creates tasks/{oid}_delivery/arrived = {at, by}; this core turns ONE valid arrival per order into a customer notice:
//   eligible → claim (arrived_notices/{oid}, the ONLY dedupe authority — the task leaf is replayable) → routing (fail-closed,
//   THIS handler only) → FULL recheck → tracker mirror (bound to the TAPPING driver) → WhatsApp → final outcome (winner only).
// At most once (retry:false, never a resend). Residuals accepted by the owner's simplicity rule: a cancel after the final recheck
// still sends; a crash after the claim leaves it `claimed` and silent (the driver falls back to contacting the customer).
const ACTIVE_TASK = new Set(['accepted', 'in_progress']);
const DELIVERY_SUFFIX = '_delivery';

const oidOf = (taskId) => (typeof taskId === 'string' && taskId.endsWith(DELIVERY_SUFFIX) && taskId.length > DELIVERY_SUFFIX.length
  ? taskId.slice(0, -DELIVERY_SUFFIX.length) : null);
const validArrival = (a) => !!a && typeof a === 'object' && Number.isFinite(a.at) && typeof a.by === 'string' && a.by !== '';
// a tracking token the link can carry (Codex r1 P2-2, r2): EXACTLY what the ONE production generator emits — index.js
// generateTrackingToken: 12 characters from TOKEN_ALPHABET (no 0/O/1/l/I). Every writer of tracking_token (createOrder for every
// brand, the online confirm, the hosted webhook, manual resolve, the scheduled release) takes it from that generator; drvc-wiring
// .guard pins this copy to index.js. Anything else ("undefined", a short / foreign token) → no link, no send (fail closed).
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const TOKEN_LENGTH = 12;
const validToken = (t) => typeof t === 'string' && t.length === TOKEN_LENGTH && [...t].every((c) => TOKEN_ALPHABET.includes(c));
const sameArrival = (x, a) => !!x && typeof x === 'object' && x.at === a.at && x.by === a.by && Object.keys(x).length === 2;

async function read(db, path) { return (await db.ref(path).once('value')).val(); }

// ONE predicate, evaluated on FRESH reads at the start and again IN FULL before the mirror + send (Codex r2 P1-2).
async function eligible(db, { taskId, oid, arrived }) {
  const [task, order, deactivated, cap] = await Promise.all([
    read(db, `tasks/${taskId}`), read(db, `orders/${oid}`), read(db, `driver_accounts/${arrived.by}/deactivated`), read(db, 'config/driver_caps/arrived_notify'),
  ]);
  if (cap !== true) return { ok: false, reason: 'cap_off' };
  if (!task || typeof task !== 'object') return { ok: false, reason: 'task_gone' };
  if (!sameArrival(task.arrived, arrived)) return { ok: false, reason: 'arrival_replaced' };
  if (task.type !== 'delivery' || task.order_id !== oid) return { ok: false, reason: 'task_mismatch' };
  if (task.assigned_driver_id !== arrived.by) return { ok: false, reason: 'not_owner' };
  const since = Number.isFinite(task.assigned_at) ? task.assigned_at : (Number.isFinite(task.accepted_at) ? task.accepted_at : null);
  if (since !== null && arrived.at < since) return { ok: false, reason: 'tap_before_assignment' };
  if (!ACTIVE_TASK.has(task.status)) return { ok: false, reason: 'task_inactive' };
  if (deactivated === true) return { ok: false, reason: 'deactivated' };
  if (!order || typeof order !== 'object') return { ok: false, reason: 'order_gone' };
  if (order.delivery_task_id !== taskId) return { ok: false, reason: 'task_mismatch' };   // EXACT pointer (Codex r1 P2-1): absent / malformed → skip
  if (order.status !== 'out_for_delivery') return { ok: false, reason: 'order_not_ofd' };
  if (order.cancel_claim_id != null || order.resolving_action === 'cancel') return { ok: false, reason: 'cancelling' };
  return { ok: true, task, order };
}

// Fail-closed routing for THIS handler only (Codex r1 P2-8): a routing-valid identity, an instance of its own, the global flag
// read STRICTLY (a read error → no send), and the per-restaurant switch for a non-default instance. Today's senders are unchanged.
async function routingOk(db, rid, wa) {
  if (typeof rid !== 'string' || !rid) return false;
  const inst = wa.instanceFor(rid);
  if (!inst) return false;
  const identity = await read(db, `restaurants/${rid}/identity`);
  if (!wa.isRoutingValid(identity)) return false;
  if ((await read(db, 'config/whatsapp_enabled')) === false) return false;
  if (inst !== 'default' && !(await wa.isEnabledForRestaurant(db, rid))) return false;
  return true;
}

// The tracker mirror — bound to the TAPPING driver (Codex r2 P1-1, r3 P1): mx → its owner_tag must be tagOf(by); legacy → its
// displayed name must be the tapper's resolved name. Cold cache → null (the server re-runs with the real value; an absent node
// commits as absent — no partial public tracker is ever created).
function makeMirrorUpdater({ oid, arrived, expectedTag, expectedName }) {
  return (cur) => {
    if (cur === null || cur === undefined) return null;
    if (cur.order_id !== oid || cur.status !== 'out_for_delivery') return undefined;
    if (cur.mx) {
      if (cur.mx.mode !== 'live' || cur.mx.owner_tag !== expectedTag) return undefined;
      return { ...cur, arrived: { at: arrived.at, owner_tag: expectedTag, name: cur.mx.name || null } };
    }
    if (cur.is_active_drop !== true || !expectedName || cur.driver_name !== expectedName) return undefined;
    return { ...cur, arrived: { at: arrived.at, owner_tag: expectedTag, name: expectedName } };
  };
}

async function mirror(db, { token, oid, arrived, expectedTag, expectedName }) {
  if (!validToken(token)) return false;
  const r = await db.ref(`order_tracking/${token}`).transaction(makeMirrorUpdater({ oid, arrived, expectedTag, expectedName }));
  const snap = r && r.committed && r.snapshot ? r.snapshot.val() : null;
  const a = snap && snap.arrived;
  if (!a || a.at !== arrived.at || a.owner_tag !== expectedTag) return false;
  if (!snap.mx && a.name !== expectedName) return false;
  return true;
}

// deps: { wa: { sendMessage, isSendConfirmed, instanceFor, isEnabledForRestaurant, tplArrived, isRoutingValid },
//         resolveDriverName, tagOf, secret, log }
async function notifyArrived(db, { taskId, arrived, now }, deps) {
  const { wa, resolveDriverName, tagOf, secret, log = console } = deps;
  const oid = oidOf(taskId);
  if (!oid || !validArrival(arrived)) { log.warn(`arrived: malformed event ${taskId}`); return { outcome: 'malformed' }; }
  let first;
  try { first = await eligible(db, { taskId, oid, arrived }); } catch (e) { log.warn(`arrived: eligibility read failed ${oid}`, e && e.message); return { outcome: 'read_failed' }; }
  if (!first.ok) { log.warn(`arrived: ${oid} not eligible (${first.reason}) — no notice`); return { outcome: 'ineligible', reason: first.reason }; }

  // CLAIM — pure updater; the winner is decided ONLY by committed + the committed snapshot naming THIS arrival. Losers are silent.
  const claim = { state: 'claimed', by: arrived.by, arrival_at: arrived.at, task_id: taskId, claimed_at: now };
  let won = false;
  try {
    const r = await db.ref(`arrived_notices/${oid}`).transaction((cur) => (cur == null ? claim : undefined));
    const v = r && r.committed && r.snapshot ? r.snapshot.val() : null;
    won = !!v && v.by === arrived.by && v.arrival_at === arrived.at && v.state === 'claimed';
  } catch (e) { log.warn(`arrived: claim failed ${oid}`, e && e.message); return { outcome: 'claim_failed' }; }
  if (!won) return { outcome: 'lost' };

  let wa_ = 'skipped'; let tracker = false;
  try {
    const rid = first.order.restaurant_id;
    const routed = await routingOk(db, rid, wa).catch((e) => { log.warn(`arrived: routing read failed ${oid}`, e && e.message); return false; });
    const again = await eligible(db, { taskId, oid, arrived });   // the FULL recheck, immediately before the mirror + send
    if (again.ok) {
      const order = again.order;
      let expectedName = null;
      try { expectedName = await resolveDriverName(db, arrived.by); } catch (_) { expectedName = null; }
      try {
        tracker = await mirror(db, { token: order.tracking_token, oid, arrived, expectedTag: tagOf(secret, arrived.by), expectedName });
      } catch (e) { log.warn(`arrived: tracker mirror failed ${oid}`, e && e.message); tracker = false; }
      // the notice carries the tracking link: no valid token → no send (the driver keeps the contact fallback), never «/undefined»
      if (routed && order.restaurant_id === rid && typeof order.customer_phone === 'string' && order.customer_phone && validToken(order.tracking_token)) {
        let result = null;
        try {
          result = await wa.sendMessage(order.customer_phone, wa.tplArrived({ customerName: order.customer_name, trackingToken: order.tracking_token, restaurantId: rid }), rid);
        } catch (e) { log.warn(`arrived: send threw ${oid}`, e && e.message); result = null; }
        wa_ = wa.isSendConfirmed(result) ? 'sent' : 'unconfirmed';   // null / {} / a timeout is UNCONFIRMED, never "not sent"
      }
    } else {
      log.warn(`arrived: ${oid} no longer eligible at the recheck (${again.reason}) — no notice`);
    }
  } catch (e) { log.warn(`arrived: ${oid} failed before the notice`, e && e.message); }

  // FINAL — only the claim winner, only while the record still names this arrival (a diagnostic never overwrites another's)
  try {
    await db.ref(`arrived_notices/${oid}`).transaction((cur) => {
      if (cur == null) return null;   // cold cache: let the server re-run with the real value
      if (cur.state !== 'claimed' || cur.by !== arrived.by || cur.arrival_at !== arrived.at) return undefined;
      return { ...cur, state: 'final', wa: wa_, tracker, final_at: now };
    });
  } catch (e) { log.warn(`arrived: final outcome write failed ${oid}`, e && e.message); }
  return { outcome: 'final', wa: wa_, tracker };
}

module.exports = { notifyArrived, eligible, makeMirrorUpdater, oidOf, validArrival, validToken, TOKEN_ALPHABET, TOKEN_LENGTH };
