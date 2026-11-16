'use strict';
// Codex capp-offers r1 P1-3 — the marketing switches as the PUBLIC decorations see them (menu.offers, the directory's offer flag, the
// «Patrocinado» read): FAIL-CLOSED and independent of the decorations' data memos. Those memos keep a stale SUCCESS on a failed refresh
// (stale-while-revalidate, up to ~6 min) — right for decoration data, wrong for an OFF switch. So the switch has its own short memo:
//   switchOn(name, deps) is true ONLY from a successful read of platform_config/marketing (config.js, the ONE reader) YOUNGER than
//   SWITCH_TTL_MS — a HARD expiry, even while a refresh is in flight (advisor ruling, Codex r2: correctness beats pop-in for the OFF
//   gate; a rare flash-off on an idle instance is accepted). Cold, failed, timed out, unavailable or expired ⇒ false. A refresh starts
//   AHEAD of the expiry (REFRESH_AT_MS, never awaited, one in flight) so steady traffic never sees the gap; a failed read REPLACES the
//   last success (OFF at once) and is retried at most every RETRY_MS.
// ON → OFF reaches a warm instance within SWITCH_TTL_MS, whatever the decoration memos hold.
const CFG = require('./config');

const SWITCH_TTL_MS = 10 * 1000;
const RETRY_MS = 2 * 1000;
const REFRESH_AT_MS = 8 * 1000;   // refresh ahead of the hard expiry
const SWITCH_TIMEOUT_MS = 1500;
const STATE = { rec: null, inflight: null };
const INFLIGHT_KEY = '__marketing_switch';
const nowOf = (deps) => (deps.now ? deps.now() : Date.now());

function startRead(deps) {
  const st = deps.switchState || STATE;
  if (st.inflight) return st.inflight;
  const db = deps.rtdb || require('firebase-admin/database').getDatabase();
  let timer = null;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('switch_timeout')), deps.switchTimeoutMs || SWITCH_TIMEOUT_MS); });
  const p = Promise.race([Promise.resolve().then(() => CFG.readMarketingConfig(db)), timeout])
    .then((cfg) => (cfg && !cfg.unavailable ? { ok: true, cfg } : { ok: false, cfg: null }), () => ({ ok: false, cfg: null }))
    .then((r) => {
      if (timer) clearTimeout(timer);
      st.rec = { ...r, at: nowOf(deps) }; st.inflight = null;
      if (deps.inflight) deps.inflight.delete(INFLIGHT_KEY);
      return st.rec;
    });
  st.inflight = p;
  if (deps.inflight) deps.inflight.set(INFLIGHT_KEY, p);   // a caller that settles its decoration reads settles this one too
  return p;
}

// is the switch `name` ON now? → boolean. Never throws, never awaits.
function switchOn(name, deps = {}) {
  try {
    const st = deps.switchState || STATE;
    const r = st.rec;
    if (!r) { startRead(deps); return false; }
    const age = nowOf(deps) - r.at;
    if ((r.ok && age >= REFRESH_AT_MS) || (!r.ok && age >= RETRY_MS)) startRead(deps);
    return !!(r.ok && age < SWITCH_TTL_MS && r.cfg[name] === true);   // HARD expiry: never a success older than the TTL
  } catch (_) { return false; }
}

module.exports = { switchOn, SWITCH_TTL_MS, REFRESH_AT_MS, RETRY_MS, SWITCH_TIMEOUT_MS, _state: STATE };
