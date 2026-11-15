'use strict';
// Calificaciones v2 (PLAN-3a-merchant-reviews-v2 r1 §0 B1, r6.1 §1, r6.2 §1) — platform_config/ratings, ONE module for its writer and
// its readers. Server-only node (platform_config is closed to clients):
//   { disclosure_v: 0|1, policy_ack: { at: <ms>, by, policy_url }, disclosure_cutover_at: <ms> }
// - disclosure_v 1 (the switch) needs a well-formed policy_ack (the published privacy policy names first name + last initial + order
//   details), and the FIRST enable stamps disclosure_cutover_at in the SAME transaction: disclosure_v 1 never exists without it.
// - The cut-over is IMMUTABLE: every write carries it forward (update, disable, re-enable, a stale whole-node replacement); a payload
//   that names a different one, or removes it, is refused (cutover_immutable) and writes nothing.
// - The writers (rateOrder, the legacy thumb) read the node ONCE before their rating transaction: readWriteGate.
const PATH = 'platform_config/ratings';
// r6.1 §1: ratings first submitted in the last hour before the cut-over are never served as anonymous (an instance clock may lag the
// activation). ONE committed constant, never runtime config, so it cannot be narrowed after go-live.
const CUTOVER_MARGIN_MS = 60 * 60 * 1000;
const KEYS = ['disclosure_v', 'policy_ack', 'disclosure_cutover_at'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

const validCutover = (v) => Number.isSafeInteger(v) && v > 0;
const validAck = (a) => isObj(a) && Number.isSafeInteger(a.at) && a.at > 0 && nonEmpty(a.by) && nonEmpty(a.policy_url);

// The rating writers' gate, from ONE read of the node (an RTDB transaction cannot read another path):
//   disclose    ⇔ disclosure_v === 1 AND a well-formed policy_ack (else the request's disclosure is ignored: anonymous, the safe side);
//   postCutover ⇔ a cut-over EXISTS at this read — no clock is trusted (r6.2 §1). An unreadable config or a malformed cut-over ⇒ the
//                 rating is still written, stamped post_cutover (never served as anonymous) and undisclosed (public_stats only).
async function readWriteGate(db) {
  let cfg;
  try { cfg = (await db.ref(PATH).once('value')).val(); } catch (_) { return { disclose: false, postCutover: true }; }
  if (cfg === null || cfg === undefined) return { disclose: false, postCutover: false };
  if (!isObj(cfg)) return { disclose: false, postCutover: true };
  const cut = cfg.disclosure_cutover_at;
  return { disclose: cfg.disclosure_v === 1 && validAck(cfg.policy_ack), postCutover: cut !== undefined && cut !== null };
}

// The owner's write as ONE transaction updater. payload = the desired node (a whole-node replacement: an omitted cut-over is carried
// forward); stamp = the value a FIRST enable writes as the cut-over (the owner CLI passes the server timestamp). out: { outcome:
// 'written' | 'refused', error?: bad_payload | policy_ack_required | cutover_immutable, node? }. Never returns undefined (the Admin SDK
// aborts on it): a refusal returns the current value unchanged.
function configUpdater({ payload, stamp }, out) {
  return (raw) => {
    const refuse = (error) => { out.outcome = 'refused'; out.error = error; delete out.node; return raw; };
    const cur = isObj(raw) ? raw : {};
    const p = payload;
    if (!isObj(p) || Object.keys(p).some((k) => !KEYS.includes(k)) || (p.disclosure_v !== 0 && p.disclosure_v !== 1)) return refuse('bad_payload');
    if (own(p, 'policy_ack') && p.policy_ack !== null && !validAck(p.policy_ack)) return refuse(p.disclosure_v === 1 ? 'policy_ack_required' : 'bad_payload');
    const has = cur.disclosure_cutover_at !== undefined && cur.disclosure_cutover_at !== null;
    if (own(p, 'disclosure_cutover_at') && (!has || p.disclosure_cutover_at !== cur.disclosure_cutover_at)) return refuse('cutover_immutable');
    if (p.disclosure_v === 1 && !validAck(p.policy_ack)) return refuse('policy_ack_required');
    if (!has && p.disclosure_v === 1 && stamp === undefined) return refuse('bad_payload');
    const next = { disclosure_v: p.disclosure_v, ...(validAck(p.policy_ack) ? { policy_ack: p.policy_ack } : {}) };
    if (has) next.disclosure_cutover_at = cur.disclosure_cutover_at;
    else if (p.disclosure_v === 1) next.disclosure_cutover_at = stamp;
    out.outcome = 'written'; delete out.error; out.node = next;
    return next;
  };
}
const result = (out) => (out.outcome === 'written' ? { ok: true, node: out.node } : { ok: false, error: out.error });

// the write: ONE transaction on the whole node
async function writeRatingsConfig(db, { payload, stamp }) {
  const out = {};
  await db.ref(PATH).transaction(configUpdater({ payload, stamp }, out));
  return result(out);
}
// the dry run: the SAME rule on the value just read, nothing written
function planRatingsConfig(current, { payload, stamp }) {
  const out = {};
  configUpdater({ payload, stamp }, out)(current === undefined ? null : current);
  return result(out);
}

module.exports = { PATH, CUTOVER_MARGIN_MS, validCutover, validAck, readWriteGate, configUpdater, writeRatingsConfig, planRatingsConfig };
