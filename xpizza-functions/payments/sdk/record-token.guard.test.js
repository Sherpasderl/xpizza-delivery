'use strict';
// owner 11-18 «airtight» (advisor, Codex #150 REVISE) — payment_sdk/{orderId}.token has ONE owner, payments/sdk/record-token.js. Over EVERY
// tracked non-test JS file of xpizza-functions (tools/sdk-token-census, AST), this guard pins by file + exact line text, each with a
// reviewed reason: (1) every `token` key access — any receiver, dotted, computed ('token' / `token`), destructured, an object key, a bare
// 'token' literal; (2) every whole-record escape of a value read from payment_sdk (spread, Object.assign, JSON.stringify, structuredClone,
// Object.values/entries, for-in, a non-literal key, a property value / array element, a forward to code the census cannot follow);
// (3) every call into the owner. A new, moved or planted site fails until it is reviewed. Negative cells plant Codex's bypasses
// (argument-only helper, whole-record forward) and the earlier alias / outside readers, and each planted line must surface.
// Run: node payments/sdk/record-token.guard.test.js
const assert = require('assert');
const fs = require('fs'); const path = require('path');
const C = require('../../tools/sdk-token-census');
const FN = path.join(__dirname, '..', '..');
let pass = 0; const fails = [];
const cell = (L, fn) => { try { fn(L); pass += 1; console.log(`  ✓ ${L}`); } catch (e) { fails.push(L); console.log(`  ✗ ${L}: ${String((e && e.message) || e).split('\n')[0]}`); } };
const real = (f) => fs.readFileSync(path.join(FN, f), 'utf8');
const FILES = C.trackedFiles(FN);
const R = C.census(FILES, real);
const sites = (rows) => rows.map(([s]) => s).sort();
  const REVIEWED_TOKEN = [   // 132 sites: file | exact line (one entry per occurrence), reason
    ["access/invites.js | const verifiedEmail = (ctx) => (ctx && ctx.token && ctx.token.email_verified === true && typeof ctx.token.email === 'string' ? normEmail(ctx.token.email) : null);", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["access/invites.js | const verifiedEmail = (ctx) => (ctx && ctx.token && ctx.token.email_verified === true && typeof ctx.token.email === 'string' ? normEmail(ctx.token.email) : null);", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["access/invites.js | const verifiedEmail = (ctx) => (ctx && ctx.token && ctx.token.email_verified === true && typeof ctx.token.email === 'string' ? normEmail(ctx.token.email) : null);", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["access/invites.js | const verifiedEmail = (ctx) => (ctx && ctx.token && ctx.token.email_verified === true && typeof ctx.token.email === 'string' ? normEmail(ctx.token.email) : null);", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["access/membership-admin-core.js | const auth = { uid, token: {} };", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["access/membership-admin-core.js | const body = { restaurantId: f.frid, token: v.token, acknowledgedChanges: v.ack, ...(fiscalAck ? { fiscalAck: true } : {}) };", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["access/membership-admin-core.js | const body = { restaurantId: f.frid, token: v.token, acknowledgedChanges: v.ack, ...(fiscalAck ? { fiscalAck: true } : {}) };", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["access/membership-admin-core.js | return { draft, token: issueEditToken({ rid: frid, baseActiveVersionId: V, sourceUpdateTime: T, sourceHash: sha256(draft), diff }),", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["access/membership-admin-core.js | try { return await D.myLocations({ db, HttpsError }, { uid, token: {} }, {}); } catch (e) { return { error: e.code }; }", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["access/membership.js | const t = ctx.token || {};", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["access/team-core.js | const tok = (ctx && ctx.token) || {};", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["access/team-core.js | if (!isUid(ctx.uid) || !(ctx.token && ctx.token.email_verified === true)) return fail('forbidden');", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["access/team-core.js | if (!isUid(ctx.uid) || !(ctx.token && ctx.token.email_verified === true)) return fail('forbidden');", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["access/team-http-core.js | const ctx = { uid: decoded.uid, token: decoded };", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["arrived-notify.js | tracker = await mirror(db, { token: order.tracking_token, oid, arrived, expectedTag: tagOf(secret, arrived.by), expectedName });", "order tracking token (order.tracking_token) — not a card token"],
    ["branches/branch-store.js | const brandId = op.brand_id; const { rid, patch, token } = op.inputs || {};", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["branches/branch-store.js | const inputs = bind === true ? { rid, bind: true, ...(typeof token === 'string' ? { token } : {}) } : { rid };", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["branches/branch-store.js | edit_draft: (i) => isObj(i) && isStr(i.rid) && isObj(i.patch) && isStr(i.token),   // O1b T3c", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["branches/branch-store.js | if (op.inputs.bind === true && typeof op.inputs.token === 'string' && P.draftToken(d) !== op.inputs.token) return fail(db, op, callId, 'stale_branch');", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["branches/branch-store.js | if (op.inputs.bind === true && typeof op.inputs.token === 'string' && P.draftToken(d) !== op.inputs.token) return fail(db, op, callId, 'stale_branch');", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["branches/branch-store.js | return runOp(db, brandId, { kind: 'edit_draft', inputs: { rid, patch: isObj(patch) ? patch : {}, token: expected }, at: now }, callId, now, clock, { live: true });", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["catalog/catalog-edit-auth.js | const a = await resolveAccess({ db }, { uid: decoded.uid, token: decoded }, restaurantId);", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["catalog/edit-catalog-handler.js | return reply(200, { updateTime: writeTime, baseActiveVersionId, sourceHash, diff, token, source: next, ...(Object.keys(extraRefs).length ? { extraRefs } : {}), ...(require('./catalog-edit').fiscalAckWaived({ live, draftBuilt, draft: next, diff, liveExtraRecords: liveRes.extraRecords, draftExtraRecords, activePhotos, draftPhotos: photoMap }) ? { fiscalAckRequired: false } : {}) });   // S2-core (P-6): { tmp ref: key } for the extras this save allocated   // Q-12 (RULED): the publish gate's own answer, never re-derived by the portal; absent ⇒ today", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["catalog/portal-reads.js | try { publishViaRequest = require('./publish-request').canRequestPublish(await _resolveAccess({ db }, { uid: auth.uid, token: {} }, rid), rid); }", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["catalog/portal-reads.js | { uid: decoded.uid, token: decoded });", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["catalog/publish-edited-handler.js | const token = body && body.token;", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["catalog/publish-request.js | const token = body && body.token;", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["checkout-guest-gate.js | return { grant: { token, expires_at: payload.exp } };", "guest checkout grant token — not a card token"],
    ["checkout-otp.js | const params = new URLSearchParams({ token, to: toDigits, body: tpl.split('{code}').join(code) });", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["contract/rtdb-adapter.js | const authUser = { uid: user.uid, email: user.email, getIdToken: async () => `r3-token:${user.uid}`, getIdTokenResult: async () => ({ token: `r3-token:${user.uid}`, claims: { ...claims } }) };", "contract harness fake ID token — not a card token"],
    ["customer-push.js | await a.db.ref(`${TOKENS}/${hashOf(b.token)}`).transaction((cur) => {", "FCM device push token — not a card token"],
    ["customer-push.js | const hash = hashOf(b.token);", "FCM device push token — not a card token"],
    ["customer-push.js | if (!exactKeys(b, ['token', 'platform', 'app_build', 'install_id', 'pedidos', 'promociones']) || !vToken(b.token) || !PLATFORMS.includes(b.platform)", "FCM device push token — not a card token"],
    ["customer-push.js | if (!exactKeys(b, ['token', 'platform', 'app_build', 'install_id', 'pedidos', 'promociones']) || !vToken(b.token) || !PLATFORMS.includes(b.platform)", "FCM device push token — not a card token"],
    ["customer-push.js | if (!exactKeys(b, ['token']) || !vToken(b.token)) return BAD;", "FCM device push token — not a card token"],
    ["customer-push.js | if (!exactKeys(b, ['token']) || !vToken(b.token)) return BAD;", "FCM device push token — not a card token"],
    ["customer-push.js | return { uid, token: b.token, platform: b.platform, app_build: b.app_build, install_id: b.install_id, at: t, claim };", "FCM device push token — not a card token"],
    ["customer-push.js | return { uid, token: b.token, platform: b.platform, app_build: b.app_build, install_id: b.install_id, at: t, claim };", "FCM device push token — not a card token"],
    ["driver-ledger/pay-gate.js | const token = request && request.auth && request.auth.token;", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["driver-push.js | token,", "FCM device push token — not a card token"],
    ["index.js | await adminOps.assertDispatcherCaller(uid, request.auth?.token, { db, auth, HttpsError });   // S1b §2.0 dispatcher gate", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["index.js | await adminOps.assertDispatcherCaller(uid, request.auth?.token, { db, auth, HttpsError });   // S1b §2.0 dispatcher gate", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["index.js | await adminOps.assertDispatcherCaller(uid, request.auth?.token, { db, auth, HttpsError });   // S1b §2.0 dispatcher gate", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["index.js | await adminOps.assertDispatcherCaller(uid, request.auth?.token, { db, auth, HttpsError });   // S1b §2.0 dispatcher gate", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["index.js | await adminOps.assertDispatcherCaller(uid, request.auth?.token, { db, auth, HttpsError });   // S1b §2.0 dispatcher gate", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["index.js | await assertDriverCallerActive(uid, request.auth?.token, { db, auth, HttpsError });   // S1b §2.2 shared driver guard", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["index.js | await assertDriverCallerActive(uid, request.auth?.token, { db: getDatabase(), auth: getAuth(), HttpsError });   // S1a §6", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["index.js | await assertDriverCallerActive(uid, request.auth?.token, { db: getDatabase(), auth: getAuth(), HttpsError });   // S1a §6", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["index.js | await assertDriverCallerActive(uid, request.auth?.token, { db: getDatabase(), auth: getAuth(), HttpsError });   // S1a §6", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["index.js | await assertDriverCallerActive(uid, request.auth?.token, { db: getDatabase(), auth: getAuth(), HttpsError });   // S1a §6", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["index.js | const fcmToken = validateTokenOwner(uid, tok) ? tok.token : null;", "FCM device push token — not a card token"],
    ["index.js | const fcmToken = validateTokenOwner(uid, tokRec) ? tokRec.token : null;", "FCM device push token — not a card token"],
    ["index.js | const r = await claimOrderCore(db, { uid, orderId, token: token || null, now: Date.now() });", "order claim token (claim-order) — not a card token"],
    ["index.js | const token = String((req.body && req.body.token) || '').trim();", "request body/query token of a sign-in, claim or push-registration endpoint — not a card token"],
    ["index.js | const token = String((req.body && req.body.token) || '').trim();", "request body/query token of a sign-in, claim or push-registration endpoint — not a card token"],
    ["index.js | const token = String((req.query && (req.query.t || req.query.token)) || (req.body && req.body.token) || '').trim();", "request body/query token of a sign-in, claim or push-registration endpoint — not a card token"],
    ["index.js | const token = String((req.query && (req.query.t || req.query.token)) || (req.body && req.body.token) || '').trim();", "request body/query token of a sign-in, claim or push-registration endpoint — not a card token"],
    ["index.js | const token = String(request.data?.token || '').trim();", "request body/query token of a sign-in, claim or push-registration endpoint — not a card token"],
    ["index.js | if (request.auth?.token?.customer === true) throw new HttpsError('permission-denied', 'Solo repartidores.');", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["index.js | return res.status(200).json({ ok: true, token, is_new: !prof, name: (prof && prof.name) || null });", "sign-in custom auth token returned to the app — not a card token"],
    ["index.js | return res.status(200).json({ ok: true, token, is_new: !prof, name: (prof && prof.name) || null, link });", "sign-in custom auth token returned to the app — not a card token"],
    ["index.js | token,", "FCM device push token — not a card token"],
    ["lib/svc-assigner.js | const SVC_AUTH = Object.freeze({ uid: 'svc-assigner', token: Object.freeze({ svc_assigner: true }) });", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["merchant/merchant-devices.js | const locs = await M.myLocations({ db }, { uid: auth.uid, token: t });", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["merchant/merchant-devices.js | const t = auth.token || {};", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["merchant/merchant-push-io.js | const entry = { rid, uid: a.uid, epoch, token, claim: deps.newClaim(), gen };", "FCM device push token — not a card token"],
    ["merchant/merchant-push-io.js | const rid = V.vRid(data.rid); const token = P.vToken(data.token); const epoch = P.vEpoch(data.epoch);", "FCM device push token — not a card token"],
    ["merchant/merchant-push-io.js | onlyKeys(data, ['rid', 'token', 'epoch'], HttpsError);", "FCM device push token — not a card token"],
    ["merchant/merchant-push.js | .filter(({ e }) => isObj(e) && e.rid === rid && typeof e.uid === 'string' && vToken(e.token) && vEpoch(e.epoch) && vClaim(e.claim))", "FCM device push token — not a card token"],
    ["merchant/merchant-push.js | .map(({ hash, e }) => ({ hash, uid: e.uid, token: e.token, epoch: e.epoch, claim: e.claim }));", "FCM device push token — not a card token"],
    ["merchant/merchant-push.js | .map(({ hash, e }) => ({ hash, uid: e.uid, token: e.token, epoch: e.epoch, claim: e.claim }));", "FCM device push token — not a card token"],
    ["merchant/merchant-push.js | return { token: target.token, data: { type, order_id: String(orderId), rid: String(rid), at: String(at), epoch: String(target.epoch) }, android: { priority: 'high', ttl: PUSH_TTL_MS } };", "FCM device push token — not a card token"],
    ["merchant/merchant-push.js | return { token: target.token, data: { type, order_id: String(orderId), rid: String(rid), at: String(at), epoch: String(target.epoch) }, android: { priority: 'high', ttl: PUSH_TTL_MS } };", "FCM device push token — not a card token"],
    ["merchant/merchant-scope.js | const a = await resolveAccess({ db }, { uid: auth.uid, token: t }, rid);", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["merchant/merchant-scope.js | const t = auth.token || {};", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["merchant/merchant-scope.js | const t = auth.token || {};", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["payments/sdk/cards.js | c.cards = { ...(isObj(c.cards) ? c.cards : {}), [id]: { token, token_hash: h, brand: display.brand, last4: display.last4, exp_month: display.exp_month, exp_year: display.exp_year, display_source: 'client', created_at: now, last_used_at: now } };", "SAVED card row (customer_cards) written by completeVault from its own argument"],
    ["payments/sdk/cards.js | const r = ok ? await completeVault(deps, { uid: order.customer_uid, token, token_hash: att.token_hash, display: att.display, vault_gen: att.vault_gen }) : { outcome: 'skipped' };", "the vault step hands completeVault the token it read through record-token.tokenOf"],
    ["payments/sdk/cards.js | if (!isObj(c) || typeof c.token !== 'string' || expiredNow(c, deps.clock())) return null;", "SAVED card (customer_cards) read for admission — not the payment_sdk record"],
    ["payments/sdk/cards.js | return { card_id: cardId, token: c.token, token_hash: c.token_hash, display: { brand: c.brand, last4: c.last4, exp_month: c.exp_month, exp_year: c.exp_year } };", "SAVED card (customer_cards) read for admission — not the payment_sdk record"],
    ["payments/sdk/cards.js | return { card_id: cardId, token: c.token, token_hash: c.token_hash, display: { brand: c.brand, last4: c.last4, exp_month: c.exp_month, exp_year: c.exp_year } };", "SAVED card (customer_cards) read for admission — not the payment_sdk record"],
    ["payments/sdk/coordinator.js | call: (opId) => deps.psp.pspAuthorize({ token, amount_cents, op_id: opId, ref, authentication_identifier, payer: payerOf(order) }),", "the claim: placeOriginal's own token argument (the client's tokenization) to the PSP"],
    ["payments/sdk/coordinator.js | call: (opId) => deps.psp.pspAuthorize({ token: T.tokenOf(rec), amount_cents: need, op_id: opId, ref: orderId }),", "decrease re-authorize / increase refusal: the key of the PSP request, its value from record-token.tokenOf"],
    ["payments/sdk/coordinator.js | call: (opId) => deps.psp.pspAuthorize({ token: T.tokenOf(rec), amount_cents: new_total_cents, op_id: opId, ref: orderId }),", "decrease re-authorize / increase refusal: the key of the PSP request, its value from record-token.tokenOf"],
    ["payments/sdk/endpoints.js | return typeof v.instance_id === 'string' && v.instance_id && typeof v.token === 'string' && v.token ? { instance_id: v.instance_id, token: v.token } : null;", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["payments/sdk/endpoints.js | return typeof v.instance_id === 'string' && v.instance_id && typeof v.token === 'string' && v.token ? { instance_id: v.instance_id, token: v.token } : null;", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["payments/sdk/endpoints.js | return typeof v.instance_id === 'string' && v.instance_id && typeof v.token === 'string' && v.token ? { instance_id: v.instance_id, token: v.token } : null;", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["payments/sdk/endpoints.js | return typeof v.instance_id === 'string' && v.instance_id && typeof v.token === 'string' && v.token ? { instance_id: v.instance_id, token: v.token } : null;", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["payments/sdk/finish.js | await C.placeOriginal(deps, { orderId: c.orderId, attempt_id: c.attemptId, token, amount_cents: stored.total_cents, authentication_identifier: authenticationIdentifier, card });", "finish hands placeOriginal the client's / resolved saved card token (its own argument)"],
    ["payments/sdk/finish.js | token = s.token; card = { display: s.display, save: false, card_ref: `saved:${s.card_id}` };", "a SAVED card resolved by cards.resolveSavedCard (customer_cards)"],
    ["payments/sdk/fixtures/redact-pixelpay.js | 'address', 'bin', 'city', 'country', 'hash', 'last', 'mask', 'phone', 'state', 'token', 'zip']);", "the fixture REDACTOR's key list: it strips `token` fields from captured PixelPay payloads"],
    ["payments/sdk/psp-adapter.js | const r = await settleCall(() => impl.pspAuthorize({ token, amount_cents, op_id, ref, authentication_identifier, payer }), null);", "the PSP adapter forwards its own pspAuthorize argument"],
    ["payments/sdk/recovery.js | const ok = !!cfg && typeof cfg.instance_id === 'string' && cfg.instance_id && typeof cfg.token === 'string' && cfg.token;", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["payments/sdk/recovery.js | const ok = !!cfg && typeof cfg.instance_id === 'string' && cfg.instance_id && typeof cfg.token === 'string' && cfg.token;", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["payments/sdk/recovery.js | return ok ? { ULTRAMSG_INSTANCE_ID_PLATFORM: cfg.instance_id, ULTRAMSG_TOKEN_PLATFORM: cfg.token, RECOVERY_OTP_TEMPLATE } : null;", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["portal/branch-lifecycle-core.js | try { r = await S.deleteBranchDraft(db, { rid, brandId, now: (deps.now || Date.now)(), clock: deps.clock, bind: true, token: expectedVersion }); } catch (e) { return refuse('unavailable', { retryable: true }); }", "catalog / branch edit-concurrency token (optimistic version) — not a card token"],
    ["portal/ops-core.js | const auth = { uid: v.ctx.uid, token: v.ctx.token };", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["portal/ops-core.js | const auth = { uid: v.ctx.uid, token: v.ctx.token };", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["portal/ops-core.js | return { ctx: { uid: decoded.uid, token: decoded } };", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["ratings/merchant-comments.js | const ctx = { uid: dec.uid, token: dec };", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["ratings/merchant-reviews.js | const ctx = { uid: dec.uid, token: dec };", "Firebase Auth ID-token claims (ctx/auth/request.auth .token) — not a card token"],
    ["signup-endpoints.js | return res.status(200).json({ ok: true, linked: true, token, name });", "sign-in custom auth token returned to the app — not a card token"],
    ["signup-endpoints.js | return res.status(200).json({ ok: true, linked: true, token, name, completion, profile });", "sign-in custom auth token returned to the app — not a card token"],
    ["signup-platform.js | const out = { ok: true, token, is_new: created, name: (!created && prof && prof.name) || null, completion, profile };", "sign-in custom auth token returned to the app — not a card token"],
    ["signup-platform.js | return res.status(200).json({ ok: true, token, is_new: isNew, name: typeof nm === 'string' ? nm : null, completion: 'complete' });", "sign-in custom auth token returned to the app — not a card token"],
    ["stats/stats-job.js | const r = await S.publishChunk(fsdb, rid, { summaries, dates: parts[i], token: leases.get(rid), readStartedAt, pendingAfter, limits });", "stats publish lease token — not a card token"],
    ["token-gate.js | token: body.quote_token,                     // the signed proof, when the client has one", "signed delivery-quote proof (quote_token) — not a card token"],
    ["tools/handheld-push-probe.js | const id = await require('firebase-admin/messaging').getMessaging(app).send(buildProbeMessage(args.token, args.trial, Date.now()));", "FCM device push token — not a card token"],
    ["tools/handheld-push-probe.js | if (!out.token || out.token.length < 32) throw new Error('--token <the probe screen\\'s token> is required');", "FCM device push token — not a card token"],
    ["tools/handheld-push-probe.js | if (!out.token || out.token.length < 32) throw new Error('--token <the probe screen\\'s token> is required');", "FCM device push token — not a card token"],
    ["tools/handheld-push-probe.js | return { token, data: { type: 'probe', sent_at: String(now), trial }, android: { priority: 'high', ttl: 10 * 60 * 1000 } };", "FCM device push token — not a card token"],
    ["tools/order-control.js | const t = token && (token.token || token);", "Google access token (owner CLI) — not a card token"],
    ["tools/sdk-token-census.js | const KEY = 'token';", "the census itself: the key it looks for"],
    ["tools/sdk-token-census.js | const out = { token: [], escape: [], accessor: [] };", "the census itself: the key it looks for"],
    ["tools/sdk-token-census.js | if (n.type === 'Literal' && n.value === KEY && !(parent && ((parent.type === 'MemberExpression' && parent.property === n) || (parent.type === 'Property' && parent.key === n)))) site('token', n);", "the census itself: the key it looks for"],
    ["tools/sdk-token-census.js | if (n.type === 'MemberExpression' && isKey(n.property, n.computed)) site('token', n);", "the census itself: the key it looks for"],
    ["tools/sdk-token-census.js | if (n.type === 'ObjectPattern') for (const q of n.properties) if (q.type === 'Property' && isKey(q.key, q.computed)) site('token', q);", "the census itself: the key it looks for"],
    ["tools/sdk-token-census.js | if (n.type === 'Property' && parent && parent.type === 'ObjectExpression' && isKey(n.key, n.computed)) site('token', n);", "the census itself: the key it looks for"],
    ["tools/sdk-token-census.js | return { token: out.token.sort(), escape: out.escape.sort(), accessor: out.accessor.sort(), sources: [...K.src].sort(), params: [...K.params].map(([k, v]) => `${k}(${[...v].sort()})`).sort() };", "the census itself: the key it looks for"],
    ["tools/sdk-token-census.js | return { token: out.token.sort(), escape: out.escape.sort(), accessor: out.accessor.sort(), sources: [...K.src].sort(), params: [...K.params].map(([k, v]) => `${k}(${[...v].sort()})`).sort() };", "the census itself: the key it looks for"],
    ["tools/setup-identity-alerts.js | const api = boundedApi(makeApi(PROJECT_ID, { token: async () => { const t = await (await auth.getClient()).getAccessToken(); return t.token || t; } }), 2 * MIN);   // every API call bounded", "Google access token (owner CLI) — not a card token"],
    ["tools/setup-identity-alerts.js | const api = boundedApi(makeApi(PROJECT_ID, { token: async () => { const t = await (await auth.getClient()).getAccessToken(); return t.token || t; } }), 2 * MIN);   // every API call bounded", "Google access token (owner CLI) — not a card token"],
    ["tracking/recompute.js | return { s, mode: derived.mode, committed: true, claimOwner: claims ? O : null, owner: O, token };", "tracking claim token — not a card token"],
    ["whatsapp.js | if (!cfg || !cfg.apiBase || !cfg.token) {", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["whatsapp.js | return { apiBase: API_BASE, token: TOKEN, trackingBase: TRACKING_BASE };", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["whatsapp.js | return { apiBase: `https://api.ultramsg.com/${instanceId}`, token, trackingBase };", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["whatsapp.js | token: cfg.token,", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["whatsapp.js | token: cfg.token,", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["whatsapp/instance-health.js | const g = byInstance.get(cfg.apiBase) || { apiBase: cfg.apiBase, token: cfg.token, rids: [] };", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["whatsapp/instance-health.js | const g = byInstance.get(cfg.apiBase) || { apiBase: cfg.apiBase, token: cfg.token, rids: [] };", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["whatsapp/instance-health.js | const res = await fetchImpl(`${g.apiBase}/instance/status?token=${encodeURIComponent(g.token)}`, { method: 'GET', redirect: 'manual', timeout: timeoutMs, signal });", "UltraMsg WhatsApp API token (config) — not a card token"],
    ["whatsapp/instance-health.js | if (!cfg || !cfg.apiBase || !cfg.token) continue;          // not configured for this restaurant → nothing to check", "UltraMsg WhatsApp API token (config) — not a card token"],
  ];
  const REVIEWED_ESCAPE = [   // 4 whole-record escapes, reason
    ["payments/sdk/coordinator.js | if (!j.applied) return { dispatched: false, record: j.record };", "dispatch returns the record in its result object; the census follows `.record` into every caller (K.props)"],
    ["payments/sdk/coordinator.js | return { dispatched: true, out, opId, record: done.record };", "dispatch returns the record in its result object; the census follows `.record` into every caller (K.props)"],
    ["payments/sdk/record.js | const next = fn.call(null, JSON.parse(JSON.stringify(cur)));   // invoked as a library call: the record is never an order", "casRecord: the deep clone handed to its own callback inside the payment_sdk transaction (the callback is a census source)"],
    ["payments/sdk/record.js | const next = fn.call(null, JSON.parse(JSON.stringify(cur)));   // invoked as a library call: the record is never an order", "casRecord: the deep clone handed to its own callback inside the payment_sdk transaction (the callback is a census source)"],
  ];
const REVIEWED_ACCESSOR = [   // the six reviewed readers / writers of the record's token
  ['payments/sdk/coordinator.js | T.setToken(rec, token);', 'the claim: placeOriginal stores the winning attempt\'s token'],
  ['payments/sdk/coordinator.js | call: (opId) => deps.psp.pspAuthorize({ token: T.tokenOf(rec), amount_cents: new_total_cents, op_id: opId, ref: orderId }),', 'decrease re-authorize (open record only)'],
  ['payments/sdk/coordinator.js | call: (opId) => deps.psp.pspAuthorize({ token: T.tokenOf(rec), amount_cents: need, op_id: opId, ref: orderId }),', 'increase (refused by policy, owner 11-10; the path still reads it)'],
  ['payments/sdk/cards.js | const token = require(\'./record-token\').tokenOf(rec);', 'the vault step (completeVaultForOrder; owed ⇒ the null keeps it)'],
  ['payments/sdk/cards.js | if (typeof T.tokenOf(x) !== \'string\') return undefined;', 'the null: anything to null?'],
  ['payments/sdk/cards.js | T.dropToken(x); out = \'nulled\';', 'the null itself (nullSpentToken)'],
];

cell('RT-OWNER', (L) => {
  assert.ok(fs.existsSync(path.join(FN, C.OWNER)), `${L}: premise — the owner module exists`);
  const ex = Object.keys(require(path.join(FN, C.OWNER))).sort();
  assert.deepStrictEqual(ex, ['dropToken', 'setToken', 'tokenOf'], `${L}: the owner exports exactly tokenOf / setToken / dropToken (a new export is a new reviewed surface)`);
  assert.ok(R.sources.includes('payments/sdk/coordinator.js#readRecord') && R.params.some((p) => p.startsWith('payments/sdk/record.js#legsOfRecord(')), `${L}: premise — the taint reaches readRecord and the record helpers (${R.sources.length} sources)`);
  assert.ok(FILES.length > 500 && FILES.includes('index.js') && FILES.includes('ledger/projector.js'), `${L}: premise — the census spans the whole tree (${FILES.length} files)`);
});
cell('RT-TOKEN-SITES', (L) => assert.deepStrictEqual(R.token, sites(REVIEWED_TOKEN), `${L}: every \`token\` access in the tree is a reviewed site (file + exact line); a new one needs a reason here`));
cell('RT-ESCAPES', (L) => assert.deepStrictEqual(R.escape, sites(REVIEWED_ESCAPE), `${L}: no payment_sdk record leaves whole except the reviewed escapes`));
cell('RT-ACCESSOR', (L) => assert.deepStrictEqual(R.accessor, sites(REVIEWED_ACCESSOR), `${L}: every call into record-token is a reviewed reader / writer`));
cell('RT-REASONS', (L) => {
  for (const [s, why] of [...REVIEWED_TOKEN, ...REVIEWED_ESCAPE, ...REVIEWED_ACCESSOR]) assert.ok(typeof why === 'string' && why.length >= 12, `${L}: a reviewed site without a reason: ${s}`);
});

// ── negatives: ONE census over the tree with every bypass planted; each planted line must surface in the right kind ──
const PLANT = {
  // the earlier ALIAS reader (in a payment_sdk reader file): dotted / computed / template / destructured / optional / a key built from 'token'
  'payments/sdk/cards.js': [
    'function zAlias1(rec) { const paymentRecord = rec; return paymentRecord.token; }',
    "function zAlias2(rec) { const r2 = rec; return r2['token']; }",
    'function zAlias3(rec) { return rec[`token`]; }',
    'function zAlias4(rec) { const { token: t } = rec; return t; }',
    'function zAlias5(rec) { return rec?.token; }',
    "function zAlias6(rec) { const k = 'token'; return rec[k]; }",
  ],
  // the whole-record FORWARD (Codex #150): the record read and handed on whole, so a reader elsewhere sees its token
  'payments/sdk/coordinator.js': [
    'async function zFwd1(deps, id) { const rec = await readRecord(deps.db, id); return deps.log({ ...rec }); }',
    'async function zFwd2(deps, id) { const rec = await readRecord(deps.db, id); return Object.assign({}, rec); }',
    'async function zFwd3(deps, id) { const rec = await readRecord(deps.db, id); return JSON.stringify(rec); }',
    "async function zFwd4(deps, id) { const rec = await readRecord(deps.db, id); await deps.db.ref('x').set(rec); }",
    'async function zFwd5(deps, id) { const rec = await readRecord(deps.db, id); return { snapshot: rec }; }',
    'async function zFwd6(deps, id) { const rec = await readRecord(deps.db, id); for (const k in rec) deps.log(k); }',
    "async function zFwd7(deps, id) { await R.casRecord(deps.db, id, (r) => { deps.log(Object.values(r)); return undefined; }); }",
    // the ARGUMENT-ONLY helper (Codex #150): a helper in a file that never names payment_sdk, reached only through its argument
    "async function zArg1(deps, id) { const rec = await readRecord(deps.db, id); return require('./z-pick').pick(rec, 'tok' + 'en'); }",
    "async function zArg2(deps, id) { const rec = await readRecord(deps.db, id); return require('./z-pick').copy(rec); }",
    "async function zArg3(deps, id) { const rec = await readRecord(deps.db, id); return require('./z-pick').field(rec); }",
    // a new reader through the OWNER
    "async function zOwn(deps, id) { const rec = await readRecord(deps.db, id); return require('./record-token').tokenOf(rec); }",
    // a dispatch callback that copies the record it is handed (the callback-property taint)
    'async function zCb(deps, orderId) { return dispatch(deps, orderId, { legId: null, action: null, amount_cents: 0, pre: (r) => ({ ...r }), call: async () => null, apply: () => null }); }',
    // a record returned in a result object, spread by the caller (the `.record` taint)
    'async function zRet1(deps, id) { const rec = await readRecord(deps.db, id); return { record: rec }; }',
    'async function zRet2(deps, id) { const res = await zRet1(deps, id); return { ...res.record }; }',
  ],
  // the OUTSIDE reader: a module outside payments/sdk (ledger) reading the token off a snapshot
  'ledger/projector.js': ['function zOut1(snap) { return snap.val().token; }'],
};
const VIRTUAL = {
  'payments/sdk/z-pick.js': "'use strict';\nmodule.exports.pick = (o, k) => o[k];\nmodule.exports.copy = (o) => ({ ...o });\nmodule.exports.field = (o) => o.token;\n",
  'virtual-new-reader.js': "'use strict';\nconst z = async (db, id) => (await db.ref(`payment_sdk/${id}`).once('value')).val().token;\nmodule.exports = { z };\n",
};
const planted = (f) => (VIRTUAL[f] !== undefined ? VIRTUAL[f] : PLANT[f] ? `${real(f)}\n${PLANT[f].join('\n')}\n` : real(f));
const N = C.census([...FILES, ...Object.keys(VIRTUAL)].sort(), planted);
const has = (kind, file, text) => N[kind].includes(`${file} | ${text}`);
cell('RT-NEG-ALIAS', (L) => { for (const t of PLANT['payments/sdk/cards.js']) assert.ok(has('token', 'payments/sdk/cards.js', t) || (t.includes('rec[k]') && has('escape', 'payments/sdk/cards.js', t)), `${L}: an aliased / computed / destructured / optional reader is caught: ${t}`); });
cell('RT-NEG-OUTSIDE', (L) => {
  assert.ok(has('token', 'ledger/projector.js', PLANT['ledger/projector.js'][0]), `${L}: a reader outside payments/sdk (ledger) is caught`);
  assert.ok(has('token', 'virtual-new-reader.js', "const z = async (db, id) => (await db.ref(`payment_sdk/${id}`).once('value')).val().token;"), `${L}: a NEW file reading payment_sdk's token is caught`);
});
cell('RT-NEG-FORWARD', (L) => { for (const t of PLANT['payments/sdk/coordinator.js'].filter((x) => /zFwd/.test(x))) assert.ok(has('escape', 'payments/sdk/coordinator.js', t), `${L}: a whole-record forward is caught: ${t}`); });
cell('RT-NEG-ARG-HELPER', (L) => {
  assert.ok(has('escape', 'payments/sdk/z-pick.js', 'module.exports.pick = (o, k) => o[k];'), `${L}: a helper reading its record ARGUMENT by a built key is caught (in the helper)`);
  assert.ok(has('escape', 'payments/sdk/z-pick.js', 'module.exports.copy = (o) => ({ ...o });'), `${L}: a helper copying its record argument whole is caught`);
  assert.ok(has('token', 'payments/sdk/z-pick.js', 'module.exports.field = (o) => o.token;'), `${L}: a helper reading .token off its argument is caught`);
});
cell('RT-NEG-OWNER-READER', (L) => assert.ok(has('accessor', 'payments/sdk/coordinator.js', PLANT['payments/sdk/coordinator.js'].find((x) => /zOwn/.test(x))), `${L}: a NEW reader through record-token is caught`));
cell('RT-NEG-CALLBACK', (L) => assert.ok(has('escape', 'payments/sdk/coordinator.js', PLANT['payments/sdk/coordinator.js'].find((x) => /zCb/.test(x))), `${L}: a dispatch callback copying the record it is handed is caught`));
cell('RT-NEG-RETURNED', (L) => {
  assert.ok(has('escape', 'payments/sdk/coordinator.js', PLANT['payments/sdk/coordinator.js'].find((x) => /zRet1/.test(x))), `${L}: a record placed in a returned object is caught`);
  assert.ok(has('escape', 'payments/sdk/coordinator.js', PLANT['payments/sdk/coordinator.js'].find((x) => /zRet2/.test(x))), `${L}: the caller spreading res.record is caught`);
});
console.log(fails.length ? `\nrecord-token.guard: FAILED ${fails.length} cell(s): ${fails.join(', ')}` : `\nrecord-token.guard: OK (${pass})`);
process.exit(fails.length ? 1 : 0);
