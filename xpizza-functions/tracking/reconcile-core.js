'use strict';
// TRACKER FIXES (BUILD-tracker-fixes r1.5 §0 "Flag-transition protocol"; codex build r1 P1-2) — the core of the owner-run
// tools/tracker-reconcile.js. The flag takes effect within ~10 min (30 s cache + ≤ 540 s attempts), so each transition is a procedure:
//   OFF → ON:  set the flag true, wait 10 min, run --mode on: recompute EVERY order in the WINDOW (out_for_delivery + terminal within
//              24 h), erasing mixed legacy / new shapes written while the flag was propagating. Completion = a second run reports
//              0 CUSTOMER-VISIBLE changes (mx.mode, mx.name, is_active_drop, driver_name, driver_location, dest_*, status, step
//              timestamps — mx.seq and other fencing metadata are expected to move and do not count).
//   ON → OFF:  set the flag false, wait 10 min, run --mode off: delete `mx` from every order_tracking node in the window (gen-2 pages
//              fall back to the legacy fields, which today's OFF code keeps writing); legacy fields are left as they are. Completion =
//              a second run reports 0 nodes still carrying `mx` in the window.
// DRY RUN unless apply: a dry run READS only and reports what it would do. Discovery is bounded: out_for_delivery by the indexed
// status query; terminal orders by the order's OWN terminal timestamps (delivered_at / cancelled_at / completed_at, each indexed)
// within 24 h, with no creation-age cutoff — never a scan of every delivered order.
const TERMINAL = ['delivered', 'cancelled', 'completed'];
const WINDOW_MS = 24 * 60 * 60 * 1000;
const TERMINAL_AT = ['delivered_at', 'cancelled_at', 'completed_at'];

const visible = (n) => JSON.stringify({
  mode: n && n.mx ? n.mx.mode || null : null, name: n && n.mx ? n.mx.name || null : null,
  is_active_drop: n ? n.is_active_drop ?? null : null, driver_name: n ? n.driver_name ?? null : null,
  driver_location: n ? n.driver_location ?? null : null, dest_lat: n ? n.dest_lat ?? null : null, dest_lng: n ? n.dest_lng ?? null : null,
  status: n ? n.status ?? null : null, picked_up_at: n ? n.picked_up_at ?? null : null, delivered_at: n ? n.delivered_at ?? null : null,
  cancelled_at: n ? n.cancelled_at ?? null : null,
});

async function windowOrders(db, now) {
  const ofd = (await db.ref('orders').orderByChild('status').equalTo('out_for_delivery').once('value')).val() || {};
  const out = new Map();
  for (const [oid, o] of Object.entries(ofd)) if (o && o.status === 'out_for_delivery') out.set(oid, { order: o, why: 'out_for_delivery' });
  // terminal within 24 h — discovered by the order's OWN terminal timestamps (indexed: orders/.indexOn delivered_at / cancelled_at /
  // completed_at), with NO creation-age cutoff (codex build r2 P2-2: an order created long ago and terminal now is in the window)
  for (const f of TERMINAL_AT) {
    const hits = (await db.ref('orders').orderByChild(f).startAt(now - WINDOW_MS).once('value')).val() || {};
    for (const [oid, o] of Object.entries(hits)) {
      if (!o || !TERMINAL.includes(o.status) || out.has(oid)) continue;
      // the fields are read LITERALLY (not o[f]) so the R3 census sees exactly which order fields this reads
      const at = { delivered_at: o.delivered_at, cancelled_at: o.cancelled_at, completed_at: o.completed_at }[f];
      if (typeof at === 'number') out.set(oid, { order: o, why: `terminal (${o.status})` });   // startAt(number) also returns string-valued fields
    }
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([orderId, x]) => ({ orderId, ...x }));
}

// runReconcile({ db, mode: 'on'|'off', apply, now, log, recompute }) → summary (recompute injected: recomputeOrderTracker)
async function runReconcile({ db, mode, apply = false, now = Date.now(), log = () => {}, recompute }) {
  if (mode !== 'on' && mode !== 'off') throw new Error(`tracker-reconcile: --mode must be on|off (got ${mode})`);
  const orders = await windowOrders(db, now);
  const summary = { mode, apply, window: orders.length, outForDelivery: orders.filter((o) => o.why === 'out_for_delivery').length, terminal24h: 0, noToken: 0, visibleChanges: 0, mxPresent: 0, mxRemoved: 0, changed: [] };
  summary.terminal24h = summary.window - summary.outForDelivery;
  for (const { orderId, order } of orders) {
    const token = order.tracking_token;
    if (!token) { summary.noToken += 1; continue; }
    const before = (await db.ref(`order_tracking/${token}`).once('value')).val();
    if (mode === 'on') {
      if (!apply) { if (!before || !before.mx) summary.changed.push(`${orderId}: no mx yet (would recompute)`); continue; }
      await recompute(db, orderId);
      const after = (await db.ref(`order_tracking/${token}`).once('value')).val();
      if (visible(before) !== visible(after)) { summary.visibleChanges += 1; summary.changed.push(`${orderId}: ${visible(before)} → ${visible(after)}`); }
    } else {
      if (!before || !before.mx) continue;
      summary.mxPresent += 1;
      if (!apply) { summary.changed.push(`${orderId}: carries mx (would delete)`); continue; }
      await db.ref(`order_tracking/${token}/mx`).remove();
      summary.mxRemoved += 1; summary.changed.push(`${orderId}: mx deleted`);
    }
  }
  log(`tracker-reconcile --mode ${mode}${apply ? ' --apply' : ' (dry run)'}: window ${summary.window} (out_for_delivery ${summary.outForDelivery}, terminal ≤24h ${summary.terminal24h}, no token ${summary.noToken}); `
    + (mode === 'on' ? `customer-visible changes ${summary.visibleChanges}${apply ? '' : ` (dry run: ${summary.changed.length} without mx)`}` : `nodes carrying mx ${summary.mxPresent}, removed ${summary.mxRemoved}`));
  for (const c of summary.changed) log(`  ${c}`);
  return summary;
}

module.exports = { runReconcile, windowOrders, visible, WINDOW_MS, TERMINAL_AT };
