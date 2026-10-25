'use strict';
// S2 P-C — THE PIXELPAY PAYER EMAIL, FAIL-CLOSED (PLAN-capp-S2-r4 §4.1).
//
// PixelPay requires a valid payer email. A customer-supplied valid email is used unchanged; otherwise the fallback is the
// env PIXELPAY_MERCHANT_EMAIL ONLY (no brand literal). With neither, a FRESH checkout is refused 503
// payer_email_unconfigured BEFORE any reward reserve, attempt or gateway call; an existing checkout's recovery (reuse /
// in_progress / already_paid / closed) never needs a new email and is never refused for it.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;   // the same check the charge path has always applied to customer_email

const validEmail = (v) => (typeof v === 'string' && EMAIL_RE.test(v.trim()) ? v.trim() : null);

// The email the hosted charge sends, or null when there is none to send.
const payerEmail = (body, env) => validEmail(body && body.customer_email) || validEmail(env && env.PIXELPAY_MERCHANT_EMAIL);

// The pre-reserve check (async): refuse when this call would issue a FRESH checkout URL and there is no payer email. When the
// handler's read-only classification FAILED (cls null), fresh-versus-recovery is established AGAIN here, before any reserve,
// through the same read-only classifier (`reclassify`); only a PROVEN non-fresh outcome (reuse / in_progress / already_paid /
// closed — a real existing checkout) skips the refusal. If it still cannot be established, it is treated as FRESH and refused,
// so no reward hold is ever reserved for a checkout that cannot be issued (codex S2-srv-tip r1 P2). The acquire keeps its own
// fresh-issuance check (unconfigured()) for the classify→acquire race.
async function refusesFresh(cls, body, env, reclassify) {
  if (payerEmail(body, env)) return false;
  if (cls) return cls.willIssueFreshUrl === true;
  let again = null;
  try { again = typeof reclassify === 'function' ? await reclassify() : null; } catch (_) { again = null; }
  return !(again && again.willIssueFreshUrl === false);
}
const unconfigured = (body, env) => !payerEmail(body, env);

// The handler's response for both refusal points (pre-reserve and the acquire's fresh-issuance conflict).
const refuse = (res, orderId) => res.status(503).json({ error: 'payer_email_unconfigured', order_id: orderId });

module.exports = { validEmail, payerEmail, refusesFresh, unconfigured, refuse };
