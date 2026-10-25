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

// The pre-reserve check: refuse only when the read-only classification says this call would issue a FRESH checkout URL. A
// failed classification (null) is left to the acquire's own fresh-issuance check (unconfigured()), which is authoritative.
const refusesFresh = (cls, body, env) => !!cls && cls.willIssueFreshUrl === true && !payerEmail(body, env);
const unconfigured = (body, env) => !payerEmail(body, env);

module.exports = { validEmail, payerEmail, refusesFresh, unconfigured };
