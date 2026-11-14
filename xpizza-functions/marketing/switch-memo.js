'use strict';
// Codex capp-offers r1 P1-3 — the marketing switches as the PUBLIC decorations see them (menu.offers, the directory's offer flag, the
// «Patrocinado» read): FAIL-CLOSED and independent of the decorations' data memos. Those memos keep a stale SUCCESS on a failed refresh
// (stale-while-revalidate, up to ~6 min) — right for decoration data, wrong for an OFF switch. So the switch has its own short memo:
//   switchOn(name, deps) is the LAST read of platform_config/marketing (config.js, the ONE reader), refreshed in the background once
//   older than SWITCH_TTL_MS (never awaited, one in flight). A FAILED / timed-out / unavailable read REPLACES it ⇒ false at once (never
//   a stale «on»); cold ⇒ false; a successful read older than SWITCH_STALE_MAX_MS ⇒ false. A failure is retried at most every RETRY_MS.
//   Between a successful read going stale and its refresh landing, that read stands (no flash-off pop-in on an idle instance: rule 7).
// ON → OFF reaches a warm instance with its next switch read (≤ SWITCH_TTL_MS under traffic), whatever the decoration memos hold.
const CFG = require('./config');

const SWITCH_TTL_MS = 10 * 1000;
const RETRY_MS = 2 * 1000;
const SWITCH_STALE_MAX_MS = 6 * 60 * 1000;   // = the decoration memos' own bound (60 s OK + 5 min stale)
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
    if ((r.ok && age >= SWITCH_TTL_MS) || (!r.ok && age >= RETRY_MS)) startRead(deps);
    return !!(r.ok && age < SWITCH_STALE_MAX_MS && r.cfg[name] === true);
  } catch (_) { return false; }
}

module.exports = { switchOn, SWITCH_TTL_MS, RETRY_MS, SWITCH_STALE_MAX_MS, SWITCH_TIMEOUT_MS, _state: STATE };
