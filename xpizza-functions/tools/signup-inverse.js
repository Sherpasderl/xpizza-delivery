'use strict';
// PLAN-signup-email-social phase 1 (r3 + BC1–BC3) — the slice's test-only index.js INVERSE. Byte-exact HUNKS (the five
// signup:begin/end blocks + the verifyOtp consume line + the deleteAccount call); unapplySignupIndex swaps each back, so the
// result === fdf9d21c:index.js byte-for-byte (signup-wiring.guard). It is the NEWEST slice: every index.js fold applies it FIRST.
const BASE = 'fdf9d21c';
const HUNKS = Object.freeze([
 {
  "file": "index.js",
  "now": "\n/* signup:begin endpoints */\n// Customer signup phase 1 (PLAN-signup-email-social r3, BC1–BC3): Google as a LOGIN METHOD on the phone account, the email +\n// per-brand consent, deletion tombstones. Handlers + hooks: signup-endpoints.js; every decision: signup-core.js.\nconst SE = require('./signup-endpoints');\nconst SIGNUP_H = SE.makeSignup({ getDatabase, getAuth, checkRateLimit, resolveRid: (raw) => resolveRestaurantId(raw, restaurantRegistry().known()) });\nconst SIGNUP_OPTS = { region: 'us-central1', cors: ACCOUNT_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 };\nexports.googleStart = onRequest(SIGNUP_OPTS, SIGNUP_H.googleStart);\nexports.googleSignIn = onRequest(SIGNUP_OPTS, SIGNUP_H.googleSignIn);\nexports.completeProfile = onRequest(SIGNUP_OPTS, SIGNUP_H.completeProfile);\nexports.setPromos = onRequest(SIGNUP_OPTS, SIGNUP_H.setPromos);\nexports.getSignupConfig = onRequest(SIGNUP_OPTS, SIGNUP_H.getSignupConfig);\n/* signup:end endpoints */\n\nexports.requestOtp = onRequest(\n",
  "was": "\nexports.requestOtp = onRequest(\n"
 },
 {
  "file": "index.js",
  "now": "      try { await db.ref('otp/' + pHash + '/rid').set(restaurantId); } catch (_) {}\n      /* signup:begin request-otp */\n      if (req.body.link_ticket != null) await SE.bindOtpTicket(db, { body: req.body, restaurantId, phoneHash: pHash, otpRecord: tx.snapshot.val(), now });   // only with a ticket\n      /* signup:end request-otp */\n      /* d12b:begin */\n",
  "was": "      try { await db.ref('otp/' + pHash + '/rid').set(restaurantId); } catch (_) {}\n      /* d12b:begin */\n"
 },
 {
  "file": "index.js",
  "now": "      let outcome = 'fail';\n      const otpTx = await otpRef.transaction((v) => { const r = OTP.verifyConsume(v, now, String(code)); outcome = r.outcome; return r.next; });   // signup: the consumed record names the OTP challenge\n      if (outcome !== 'ok') return res.status(200).json({ ok: false });   // wrong/expired/capped → generic, no mint\n",
  "was": "      let outcome = 'fail';\n      await otpRef.transaction((v) => { const r = OTP.verifyConsume(v, now, String(code)); outcome = r.outcome; return r.next; });\n      if (outcome !== 'ok') return res.status(200).json({ ok: false });   // wrong/expired/capped → generic, no mint\n"
 },
 {
  "file": "index.js",
  "now": "      catch (e) { console.warn('verifyOtp: welcome credit fail-open —', e && e.message); }\n      /* signup:begin verify-otp */\n      await SE.refreshActivity(db, uid, now2);   // BC3: user_private/{uid}/last_active — aborts on a tombstone; bounded, fail-open\n      if (req.body.link_ticket != null) {   // only with a ticket: redeem + link (the phone login succeeds whatever the link outcome)\n        const link = await SE.redeemOtpTicket(db, { body: req.body, uid, phoneHash: pHash, rid, consumedOtp: otpTx.snapshot.val(), now: now2 });\n        return res.status(200).json({ ok: true, token, is_new: !prof, name: (prof && prof.name) || null, link });\n      }\n      /* signup:end verify-otp */\n      return res.status(200).json({ ok: true, token, is_new: !prof, name: (prof && prof.name) || null });\n",
  "was": "      catch (e) { console.warn('verifyOtp: welcome credit fail-open —', e && e.message); }\n      return res.status(200).json({ ok: true, token, is_new: !prof, name: (prof && prof.name) || null });\n"
 },
 {
  "file": "index.js",
  "now": "      const pHash = (await db.ref(`user_profiles/${uid}/phone_hash`).get()).val();\n      await SE.deleteAccountCore(db, ACCOUNT, { uid, phoneHash: pHash, now: Date.now() });   // signup BC2: tombstone first, today's removals, auth_links\n      console.log(`deleteAccount: cleared account ${uid}`);\n",
  "was": "      const pHash = (await db.ref(`user_profiles/${uid}/phone_hash`).get()).val();\n      await db.ref().update(ACCOUNT.accountDeleteUpdates(uid, pHash, Date.now()));\n      console.log(`deleteAccount: cleared account ${uid}`);\n"
 },
 {
  "file": "index.js",
  "now": "    const snap = await db.ref('user_profiles').get();\n    /* signup:begin prune-residual */\n    if (!snap.exists()) {   // codex build r1 P2-10: the residual cleanup runs even when no profiles remain\n      const resid = await SE.pruneResidual(db);\n      console.log(`pruneInactiveAccounts: no profiles (residual: ${resid.deadLinks} dead link(s), ${resid.expired} expired row(s))`);\n      return;\n    }\n    /* signup:end prune-residual */\n    const cutoff = Date.now() - ACCOUNT.INACTIVE_MS;\n    /* signup:begin prune */\n    // each account: its BC2 tombstone first — it aborts when a login refreshed last_active since the read above — then removal\n    let count = 0;\n    for (const c of ACCOUNT.pruneCandidates(snap.val(), cutoff)) {\n      if (await SE.deleteAccountCore(db, ACCOUNT, { uid: c.uid, phoneHash: c.phoneHash, now: Date.now(), sweepCutoff: cutoff })) count++;\n    }\n    const resid = await SE.pruneResidual(db);   // links that raced a deletion (inert at login) + expired challenges / tickets\n    if (resid.deadLinks || resid.expired) console.log(`pruneInactiveAccounts: residual ${resid.deadLinks} dead link(s), ${resid.expired} expired row(s)`);\n    /* signup:end prune */\n    console.log(`pruneInactiveAccounts: removed ${count} inactive profile(s) (cutoff ${new Date(cutoff).toISOString()})`);\n",
  "was": "    const snap = await db.ref('user_profiles').get();\n    if (!snap.exists()) { console.log('pruneInactiveAccounts: no profiles'); return; }\n    const cutoff = Date.now() - ACCOUNT.INACTIVE_MS;\n    const { updates, count } = ACCOUNT.pruneUpdates(snap.val(), cutoff);\n    if (count) await db.ref().update(updates);\n    console.log(`pruneInactiveAccounts: removed ${count} inactive profile(s) (cutoff ${new Date(cutoff).toISOString()})`);\n"
 }
]);
function unapply(file, src) {
  let out = src;
  for (const h of HUNKS) {
    if (h.file !== file) continue;
    const n = out.split(h.now).length - 1;
    if (n !== 1) throw new Error(`signup-inverse: ${file}: a signup hunk occurs ${n} times (expected exactly 1)`);
    out = out.replace(h.now, () => h.was);
  }
  return out;
}
const unapplySignupIndex = (src) => unapply('index.js', src);
const unapplySignupModule = (file, src) => unapply(file, src);
const FILES = Object.freeze([...new Set(HUNKS.map((h) => h.file))].filter((f) => f !== 'index.js'));
module.exports = { unapplySignupIndex, unapplySignupModule, HUNKS, FILES, BASE };
