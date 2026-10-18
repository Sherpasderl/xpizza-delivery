// H1b T5 — the read side (PLAN-H1b T5 + amendment A-2). Over an injected RTDB adapter (app.js implements it with the vendored
// Firebase SDK; tests with a fake):
//   rtdb.onQuery(path, child, value, {added(key, val), changed(key, val), removed(key), loaded(), error(e)}) → unsubscribe
//   rtdb.onValue(path, cb(val), err(e)) → unsubscribe
// ONE /orders query, orderByChild('restaurant_id').equalTo(rid) — the status filter runs on the client (model.queues); a cancelled
// order stays in the map so a pending reject resolves from the order itself. `loaded` = the query's first snapshot (until then the
// list shows the offline banner, never an empty state). ANY listener cancel (permission loss after a revoke, a bad session) →
// sessionLost: the app stops all actionable UI and goes to re-pair. stop() tears everything down; late events are ignored.
const clone = (v) => (v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)));

export function startFeeds({ rtdb, rid, brandId, onState }) {
  const st = { orders: {}, loaded: false, control: null, brand: null, menu: null, availability: null, offset: null, connected: false, sessionLost: false };
  let stopped = false;
  const emit = () => { if (!stopped) onState(clone(st)); };
  const guard = (fn) => (...a) => { if (!stopped) { fn(...a); emit(); } };
  const lost = guard(() => { st.sessionLost = true; });
  const put = guard((k, v) => { st.orders[k] = { ...(v || {}), id: k }; });

  const subs = [
    rtdb.onQuery('orders', 'restaurant_id', rid, {
      added: put, changed: put,
      removed: guard((k) => { delete st.orders[k]; }),
      loaded: guard(() => { st.loaded = true; }),
      error: lost,
    }),
    rtdb.onValue(`order_control/${rid}`, guard((v) => { st.control = v; }), lost),
    rtdb.onValue(`public/brands/${brandId}`, guard((v) => { st.brand = v; }), lost),
    rtdb.onValue(`menus/${brandId}`, guard((v) => { st.menu = v; }), lost),
    rtdb.onValue(`restaurants/${rid}/item_availability`, guard((v) => { st.availability = v; }), lost),
    rtdb.onValue('.info/serverTimeOffset', guard((v) => { st.offset = typeof v === 'number' && Number.isFinite(v) ? v : null; }), lost),
    rtdb.onValue('.info/connected', guard((v) => { st.connected = v === true; }), lost),
  ];

  return {
    stop() { stopped = true; for (const u of subs) { try { u(); } catch (_) { /* already gone */ } } },
    state: () => clone(st),
  };
}
