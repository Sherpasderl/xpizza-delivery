'use strict';
/**
 * PLAN-signup-email-social r3 (APPROVED, BC1/BC2) — signup-core on the RTDB emulator (real transactions):  npm run test:signup-core
 *   A Google verification through google-auth-library's REAL verifySignedJwtWithCertsAsync with test RS256 keys: valid; wrong
 *     audience; unsupported issuer; expired; bad signature; no configuration; email_verified false / absent / "true"; empty sub;
 *     no nonce;
 *   B the challenge: single use, this session + brand only, expiry;
 *   C googleSignIn: unlinked → ticket (no profile / index / token); linked + LIVE → that uid (activity refreshed); linked to a
 *     tombstoned uid → inert (a ticket); a replayed nonce → refused;
 *   D the ticket state machine: issued → bound → (rebind) bound → consumed; every rejected transition; concurrent redemption of one
 *     ticket on two phones → exactly one;
 *   E linking: linked / noop / conflict; two uids racing for one identity → one link; two Google links on one account (residual);
 *   F completeProfile: per-brand consent with SERVER versions + time; missing legal → refused; tombstoned → refused; validation;
 *   G setPromos: promotions only, terms kept; tombstoned → refused; not completed → refused;
 *   H BC2 tombstone: REPLACES user_private with exactly {deleted_at}; a retry keeps the first timestamp; the sweep aborts when
 *     last_active is fresh; completeProfile racing the tombstone always ends at exactly {deleted_at};
 *   I removeLinks by uid only; isLive false after the tombstone; hasSignupData;
 *   J the provider email: recorded unverified only when none is set; email_source kept / typed; tombstone untouched.
 */
require('./_emulator-required')('database');
const assert = require('assert');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { OAuth2Client } = require('google-auth-library');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-xpizza', databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=demo-xpizza-signup` });
const db = admin.database();
const S = require('../signup-core');
const WATCHDOG = setTimeout(() => { console.error('signup-core: FAILED — watchdog'); process.exit(1); }, 300000);

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const NOW = 1_800_000_000_000;
const AUD = ['client-a.apps.googleusercontent.com'];
const SESSION = 's'.repeat(32), SESSION2 = 't'.repeat(32);
const RID = 'merch_a';
const UID = 'u_' + 'a'.repeat(24), UID2 = 'u_' + 'b'.repeat(24);

// ── test RS256 keys + a JWT signer (the library verifies the signature for real) ──
const KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const OTHER = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERTS = { kid1: KEY.publicKey.export({ type: 'spki', format: 'pem' }) };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims, key = KEY.privateKey) {
  const head = b64({ alg: 'RS256', kid: 'kid1', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ iss: 'https://accounts.google.com', aud: AUD[0], sub: '1234567890', email: 'ana@gmail.com', email_verified: true, name: 'Ana', iat: now, exp: now + 600, nonce: 'n1', ...claims });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const client = new OAuth2Client();
const verify = (audiences) => (token) => S.verifyGoogleIdToken(token, { audiences, client, certs: CERTS });

async function fixtures() {
  await db.ref('/').set(null);
  await db.ref(`restaurants/${RID}/legal`).set({ terms_url: 'https://merch-a.test/terminos', privacy_url: 'https://merch-a.test/privacidad', terms_version: 't-2026-10', privacy_version: 'p-2026-10', promos_copy_version: 'promo-1' });
  for (const [uid, ph] of [[UID, 'ph_a'], [UID2, 'ph_b']]) {
    await db.ref(`user_profiles/${uid}`).set({ phone: '50499990000', phone_hash: ph, created_at: 1, last_login: 1 });
    await db.ref(`phone_index/${ph}`).set(uid);
  }
}

(async () => {
  // ═══ A. Google verification (real library path) ═══
  {
    const v = verify(AUD);
    const good = await v(jwt({}));
    assert.ok(good.ok && good.sub === '1234567890' && good.nonce === 'n1', JSON.stringify(good));
    const cases = [
      ['wrong audience', jwt({ aud: 'someone-else.apps.googleusercontent.com' })],
      ['unsupported issuer', jwt({ iss: 'https://evil.example' })],
      ['expired', jwt({ iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 })],
      ['bad signature', jwt({}, OTHER.privateKey)],
      ['email_verified false', jwt({ email_verified: false })],
      ['email_verified absent', jwt({ email_verified: undefined })],
      ['email_verified "true" (a string)', jwt({ email_verified: 'true' })],
      ['empty sub', jwt({ sub: '' })],
      ['no nonce', jwt({ nonce: undefined })],
      ['garbage', 'not.a.jwt'],
    ];
    for (const [label, t] of cases) { const r = await v(t); assert.ok(!r.ok, `🔴 ${label} was accepted (${JSON.stringify(r)})`); }
    assert.deepStrictEqual(await verify(null)(jwt({})), { ok: false, reason: 'google_unconfigured' }, 'no audiences → fail-closed');
    assert.strictEqual(S.audiencesFor('merch_a', { GOOGLE_OAUTH_AUDIENCES__MERCH_A: ' a , b ' }).join('|'), 'a|b');
    assert.strictEqual(S.audiencesFor('merch-a', { GOOGLE_OAUTH_AUDIENCES__MERCH_A: 'a' }), null, '🔴 merch-a must never read merch_a\'s audiences (collision-free keys)');
    assert.strictEqual(S.audiencesFor('merch_a', {}), null); assert.strictEqual(S.audiencesFor('../x', { 'GOOGLE_OAUTH_AUDIENCES__../X': 'a' }), null);
    ok(`Google verification through the real library (test RS256 keys): valid accepted; ${cases.length} bad tokens refused (audience, issuer, expired, signature, email_verified false/absent/string, empty sub, no nonce, garbage); no per-brand audiences → fail-closed`);
  }

  // ═══ B. the challenge ═══
  await fixtures();
  {
    const c = await S.startGoogle(db, { rid: RID, sessionId: SESSION, now: NOW });
    assert.ok(c.ok && c.nonce);
    assert.strictEqual(await S.consumeChallenge(db, { nonce: c.nonce, sessionId: SESSION2, rid: RID, now: NOW }), false, 'another session');
    assert.strictEqual(await S.consumeChallenge(db, { nonce: c.nonce, sessionId: SESSION, rid: 'merch_b', now: NOW }), false, 'another brand');
    assert.strictEqual(await S.consumeChallenge(db, { nonce: c.nonce, sessionId: SESSION, rid: RID, now: NOW + S.SIGNUP.CHALLENGE_TTL_MS + 1 }), false, 'expired');
    assert.strictEqual(await S.consumeChallenge(db, { nonce: c.nonce, sessionId: SESSION, rid: RID, now: NOW }), true, 'this session + brand');
    assert.strictEqual(await S.consumeChallenge(db, { nonce: c.nonce, sessionId: SESSION, rid: RID, now: NOW }), false, 'single use');
    assert.deepStrictEqual(await S.startGoogle(db, { rid: RID, sessionId: 'short', now: NOW }), { ok: false, reason: 'bad_request' });
    ok('the challenge: refused for another session / brand / after expiry; consumed once by its own session + brand; never twice; a malformed session refused');
  }

  // ═══ C. googleSignIn ═══
  await fixtures();
  const signIn = async (claims, session = SESSION) => {
    const c = await S.startGoogle(db, { rid: RID, sessionId: session, now: NOW });
    return S.googleSignIn(db, { idToken: jwt({ nonce: c.nonce, ...claims }), sessionId: session, rid: RID, now: NOW, verify: verify(AUD) });
  };
  {
    const r = await signIn({});
    assert.ok(r.ok && r.linked === false && r.ticket && r.email === 'ana@gmail.com', JSON.stringify(r));
    assert.ok(!(await db.ref('auth_links').once('value')).exists(), 'no link');
    assert.strictEqual((await db.ref(`link_tickets/${r.ticket}`).once('value')).val().state, 'issued');
    await db.ref('auth_links/google/1234567890').set({ uid: UID, at: 1 });
    const r2 = await signIn({});
    assert.ok(r2.ok && r2.linked === true && r2.uid === UID, JSON.stringify(r2));
    assert.strictEqual((await db.ref(`user_private/${UID}/last_active`).once('value')).val(), NOW, 'activity refreshed');
    await db.ref(`user_private/${UID}`).set({ deleted_at: 5 });
    const r3 = await signIn({});
    assert.ok(r3.ok && r3.linked === false, '🔴 a link to a tombstoned account must be inert');
    const c = await S.startGoogle(db, { rid: RID, sessionId: SESSION, now: NOW });
    const tok = jwt({ nonce: c.nonce });
    assert.ok((await S.googleSignIn(db, { idToken: tok, sessionId: SESSION, rid: RID, now: NOW, verify: verify(AUD) })).ok);
    assert.deepStrictEqual(await S.googleSignIn(db, { idToken: tok, sessionId: SESSION, rid: RID, now: NOW, verify: verify(AUD) }), { ok: false, reason: 'nonce_mismatch' }, 'a replayed token/nonce');
    assert.deepStrictEqual(await S.googleSignIn(db, { idToken: jwt({ nonce: 'never-issued' }), sessionId: SESSION, rid: RID, now: NOW, verify: verify(AUD) }), { ok: false, reason: 'nonce_mismatch' });
    ok('googleSignIn: unlinked → a ticket (no link, no profile); linked + live → that uid with last_active refreshed; linked to a tombstoned account → inert (a ticket); a replayed or never-issued nonce → refused');
  }

  // ═══ D. the ticket state machine ═══
  await fixtures();
  {
    const t = (await signIn({ sub: '777' })).ticket;
    const base = { ticketId: t, sessionId: SESSION, rid: RID, now: NOW };
    assert.strictEqual(await S.redeemTicket(db, { ...base, phoneHash: 'ph_a', challengeId: 'c1', uid: UID }), null, 'issued → consumed refused');
    assert.strictEqual(await S.bindTicket(db, { ...base, sessionId: SESSION2, phoneHash: 'ph_a', challengeId: 'c1' }), false, 'bind: another session');
    assert.strictEqual(await S.bindTicket(db, { ...base, rid: 'merch_b', phoneHash: 'ph_a', challengeId: 'c1' }), false, 'bind: another brand');
    assert.strictEqual(await S.bindTicket(db, { ...base, phoneHash: 'ph_a', challengeId: 'c1' }), true, 'issued → bound');
    assert.strictEqual(await S.bindTicket(db, { ...base, phoneHash: 'ph_b', challengeId: 'c2' }), true, 'bound → bound (rebind)');
    for (const [label, over] of [['old phone/challenge', { phoneHash: 'ph_a', challengeId: 'c1' }], ['wrong challenge', { phoneHash: 'ph_b', challengeId: 'c9' }], ['wrong session', { phoneHash: 'ph_b', challengeId: 'c2', sessionId: SESSION2 }], ['wrong brand', { phoneHash: 'ph_b', challengeId: 'c2', rid: 'merch_b' }], ['expired', { phoneHash: 'ph_b', challengeId: 'c2', now: NOW + S.SIGNUP.TICKET_TTL_MS + 1 }]]) {
      assert.strictEqual(await S.redeemTicket(db, { ...base, uid: UID2, ...over }), null, `redeem refused: ${label}`);
    }
    const got = await S.redeemTicket(db, { ...base, phoneHash: 'ph_b', challengeId: 'c2', uid: UID2 });
    assert.deepStrictEqual(got, { kind: 'google', key: '777', email: 'ana@gmail.com' });
    assert.strictEqual(await S.redeemTicket(db, { ...base, phoneHash: 'ph_b', challengeId: 'c2', uid: UID2 }), null, 'consumed → nothing');
    assert.strictEqual(await S.bindTicket(db, { ...base, phoneHash: 'ph_b', challengeId: 'c3' }), false, 'consumed → bound refused');
    // concurrent redemption of ONE ticket on two phones
    const t2 = (await signIn({ sub: '888' })).ticket;
    await S.bindTicket(db, { ticketId: t2, sessionId: SESSION, rid: RID, now: NOW, phoneHash: 'ph_a', challengeId: 'cx' });
    const both = await Promise.all([S.redeemTicket(db, { ticketId: t2, sessionId: SESSION, rid: RID, now: NOW, phoneHash: 'ph_a', challengeId: 'cx', uid: UID }), S.redeemTicket(db, { ticketId: t2, sessionId: SESSION, rid: RID, now: NOW, phoneHash: 'ph_a', challengeId: 'cx', uid: UID2 })]);
    assert.strictEqual(both.filter(Boolean).length, 1, '🔴 one ticket redeemed twice');
    ok('tickets: issued→consumed refused; bind refused for another session / brand; issued→bound→rebind; redeem refused for the old binding, a wrong challenge / session / brand, after expiry; consumed → nothing (no redeem, no rebind); one ticket redeemed concurrently → exactly once');
  }

  // ═══ E. linking ═══
  await fixtures();
  {
    assert.deepStrictEqual(await S.linkIdentity(db, { kind: 'google', key: 'g1', uid: UID, now: NOW }), { link: 'linked' });
    assert.deepStrictEqual(await S.linkIdentity(db, { kind: 'google', key: 'g1', uid: UID, now: NOW + 1 }), { link: 'noop' });
    assert.deepStrictEqual(await S.linkIdentity(db, { kind: 'google', key: 'g1', uid: UID2, now: NOW }), { link: 'conflict' });
    assert.deepStrictEqual((await db.ref('auth_links/google/g1').once('value')).val(), { uid: UID, at: NOW }, 'the first link is untouched (no overwrite)');
    const race = await Promise.all([S.linkIdentity(db, { kind: 'google', key: 'g2', uid: UID, now: NOW }), S.linkIdentity(db, { kind: 'google', key: 'g2', uid: UID2, now: NOW })]);
    assert.deepStrictEqual(race.map((x) => x.link).sort(), ['conflict', 'linked'], '🔴 two uids both linked one identity');
    assert.deepStrictEqual(await S.linkIdentity(db, { kind: 'google', key: 'g3', uid: UID, now: NOW }), { link: 'linked' }, 'a second Google on the same account (accepted residual)');
    assert.deepStrictEqual(await S.linkIdentity(db, { kind: 'apple', key: 'x', uid: UID, now: NOW }), { link: 'invalid' });
    ok('linking: linked / noop for the same uid / conflict for another (the first link untouched); two uids racing for one identity → exactly one link; a second Google on one account links (the accepted residual)');
  }

  // ═══ F. completeProfile ═══
  await fixtures();
  {
    assert.deepStrictEqual(await S.completeProfile(db, { uid: UID, rid: RID, email: ' Ana@Gmail.com ', acceptTerms: true, promos: false, now: NOW }), { ok: true });
    const p = (await db.ref(`user_private/${UID}`).once('value')).val();
    assert.deepStrictEqual(p, { email: 'ana@gmail.com', email_verified: false, email_source: 'typed', last_active: NOW,
      consent: { [RID]: { terms: { version: 't-2026-10', privacy_version: 'p-2026-10', at: NOW }, promos: { value: false, copy_version: 'promo-1', at: NOW } } } });
    await S.completeProfile(db, { uid: UID, rid: 'merch_b', email: 'ana@gmail.com', acceptTerms: true, promos: true, now: NOW }).then((r) => assert.deepStrictEqual(r, { ok: false, reason: 'legal_unconfigured' }));
    for (const [args, reason] of [[{ acceptTerms: false }, 'bad_request'], [{ acceptTerms: 'yes' }, 'bad_request'], [{ promos: 'no' }, 'bad_request'], [{ email: 'not-an-email' }, 'bad_email'], [{ email: 'a@b' }, 'bad_email']]) {
      assert.deepStrictEqual(await S.completeProfile(db, { uid: UID, rid: RID, email: 'ana@gmail.com', acceptTerms: true, promos: false, now: NOW, ...args }), { ok: false, reason });
    }
    await db.ref(`auth_links/email/${S.sha256('ana@gmail.com')}`).set({ uid: UID, at: 1 });
    await S.completeProfile(db, { uid: UID, rid: RID, email: 'ana@gmail.com', acceptTerms: true, promos: false, now: NOW });
    assert.strictEqual((await db.ref(`user_private/${UID}/email_verified`).once('value')).val(), true, 'verified only through an email-login link to THIS uid');
    await db.ref(`user_private/${UID2}`).set({ deleted_at: 7 });
    assert.deepStrictEqual(await S.completeProfile(db, { uid: UID2, rid: RID, email: 'b@b.co', acceptTerms: true, promos: true, now: NOW }), { ok: false, reason: 'deleted' });
    assert.deepStrictEqual((await db.ref(`user_private/${UID2}`).once('value')).val(), { deleted_at: 7 }, 'the tombstone untouched');
    ok('completeProfile: per-brand consent with the SERVER legal versions and the server time, normalized email; another brand with no legal config → refused; non-affirmative terms / non-boolean promos / bad emails → refused; email_verified only via an email-login link to this uid; a tombstoned account → refused, tombstone untouched');
  }

  // ═══ G. setPromos ═══
  {
    assert.deepStrictEqual(await S.setPromos(db, { uid: UID, rid: RID, value: true, now: NOW + 9 }), { ok: true });
    const c = (await db.ref(`user_private/${UID}/consent/${RID}`).once('value')).val();
    assert.ok(c.promos.value === true && c.promos.at === NOW + 9 && c.terms.version === 't-2026-10' && c.terms.at === NOW, 'promotions changed, terms kept');
    assert.deepStrictEqual(await S.setPromos(db, { uid: UID2, rid: RID, value: true, now: NOW }), { ok: false, reason: 'deleted' });
    const fresh = 'u_' + 'd'.repeat(24);
    assert.deepStrictEqual(await S.setPromos(db, { uid: fresh, rid: RID, value: true, now: NOW }), { ok: false, reason: 'not_completed' });
    assert.ok(!(await db.ref(`user_private/${fresh}`).once('value')).exists(), 'nothing created');
    ok('setPromos: changes promotions only (terms record kept); a tombstoned account → refused; no completed profile for the brand → refused, nothing created');
  }

  // ═══ H. BC2 tombstone ═══
  await fixtures();
  {
    await S.completeProfile(db, { uid: UID, rid: RID, email: 'ana@gmail.com', acceptTerms: true, promos: true, now: NOW });
    assert.strictEqual(await S.tombstone(db, UID, { now: NOW + 1 }), true);
    assert.deepStrictEqual((await db.ref(`user_private/${UID}`).once('value')).val(), { deleted_at: NOW + 1 }, 'BC2: REPLACED with exactly {deleted_at} (email + consent gone atomically)');
    assert.strictEqual(await S.tombstone(db, UID, { now: NOW + 99 }), true);
    assert.deepStrictEqual((await db.ref(`user_private/${UID}`).once('value')).val(), { deleted_at: NOW + 1 }, 'a retry keeps the first timestamp');
    await db.ref(`user_private/${UID2}`).set({ last_active: NOW });
    assert.strictEqual(await S.tombstone(db, UID2, { now: NOW + 5, staleBefore: NOW - 1000 }), false, 'the sweep aborts on a fresh last_active');
    assert.deepStrictEqual((await db.ref(`user_private/${UID2}`).once('value')).val(), { last_active: NOW });
    assert.strictEqual(await S.tombstone(db, UID2, { now: NOW + 5, staleBefore: NOW + 1 }), true, 'stale → the sweep tombstones');
    // completeProfile racing the tombstone → always exactly {deleted_at} at the end
    for (let i = 0; i < 12; i++) {
      const u = 'u_' + String(i).padStart(24, 'c');
      await db.ref(`user_profiles/${u}`).set({ phone: '1', phone_hash: `h${i}`, created_at: 1, last_login: 1 });
      await Promise.all([S.completeProfile(db, { uid: u, rid: RID, email: 'x@y.co', acceptTerms: true, promos: true, now: NOW }), S.tombstone(db, u, { now: NOW + 3 })]);
      const end = (await db.ref(`user_private/${u}`).once('value')).val();
      assert.deepStrictEqual(end, { deleted_at: NOW + 3 }, `🔴 race ${i}: ${JSON.stringify(end)}`);
    }
    ok('BC2: the tombstone REPLACES user_private with exactly {deleted_at}; a retry keeps the first timestamp; the inactivity sweep aborts when last_active is fresh and tombstones when stale; completeProfile racing the tombstone (12×) always ends at exactly {deleted_at}');
  }

  // ═══ I. removeLinks / isLive / hasSignupData ═══
  await fixtures();
  {
    await db.ref('auth_links/google').set({ g1: { uid: UID, at: 1 }, g2: { uid: UID, at: 1 }, g3: { uid: UID2, at: 1 } });
    assert.strictEqual(await S.isLive(db, UID), true);
    assert.strictEqual(await S.hasSignupData(db, UID), true);
    assert.strictEqual(await S.removeLinks(db, UID), 2);
    assert.deepStrictEqual((await db.ref('auth_links/google').once('value')).val(), { g3: { uid: UID2, at: 1 } }, 'only THIS account\'s rows');
    await S.tombstone(db, UID, { now: NOW });
    assert.strictEqual(await S.isLive(db, UID), false, 'tombstoned → not live');
    await db.ref(`phone_index/ph_b`).set('u_' + 'z'.repeat(24));
    assert.strictEqual(await S.isLive(db, UID2), false, 'an inconsistent phone_index → not live');
    assert.strictEqual(await S.hasSignupData(db, 'u_' + 'e'.repeat(24)), false);
    ok('removeLinks removes only this account\'s rows (by the uid query); isLive is false after the tombstone and on an inconsistent phone_index; hasSignupData');
  }

  // ═══ J. the provider email (§3.1) ═══
  await fixtures();
  {
    assert.strictEqual(await S.noteProviderEmail(db, UID, ' Ana@Gmail.com ', 'google'), true);
    assert.deepStrictEqual((await db.ref(`user_private/${UID}`).once('value')).val(), { email: 'ana@gmail.com', email_verified: false, email_source: 'google' }, 'recorded, NOT verified');
    assert.strictEqual(await S.noteProviderEmail(db, UID, 'other@gmail.com', 'google'), false, 'never overwrites an email');
    await S.completeProfile(db, { uid: UID, rid: RID, email: 'ana@gmail.com', acceptTerms: true, promos: false, now: NOW });
    assert.strictEqual((await db.ref(`user_private/${UID}/email_source`).once('value')).val(), 'google', 'kept the provider email → source kept');
    await S.completeProfile(db, { uid: UID, rid: RID, email: 'typed@mail.com', acceptTerms: true, promos: false, now: NOW });
    assert.strictEqual((await db.ref(`user_private/${UID}/email_source`).once('value')).val(), 'typed', 'a different email → typed');
    await db.ref(`user_private/${UID2}`).set({ deleted_at: 3 });
    assert.strictEqual(await S.noteProviderEmail(db, UID2, 'b@gmail.com', 'google'), false);
    assert.deepStrictEqual((await db.ref(`user_private/${UID2}`).once('value')).val(), { deleted_at: 3 }, 'tombstone untouched');
    ok('the provider email: recorded (unverified, email_source google) only when none is set; completeProfile keeps the source for the same email, "typed" otherwise; a tombstoned account untouched');
  }

  // ═══ K. codex build r1: P1-1 a deletion between isLive and the activity transaction REFUSES; P2-6 consumed tickets keep no
  //     private data; expired challenges / tickets pruned ═══
  await fixtures();
  {
    await db.ref('auth_links/google/1234567890').set({ uid: UID, at: 1 });
    // a db whose user_private/<UID> transaction first sees the deletion commit (the race codex reproduced)
    const racing = { ref: (p) => { const r = db.ref(p); if (p !== `user_private/${UID}`) return r;
      return { transaction: async (fn) => { await db.ref(`user_private/${UID}`).set({ deleted_at: 9 }); return r.transaction(fn); }, once: (...a) => r.once(...a) }; } };
    const c = await S.startGoogle(db, { rid: RID, sessionId: SESSION, now: NOW });
    const r = await S.googleSignIn(racing, { idToken: jwt({ nonce: c.nonce }), sessionId: SESSION, rid: RID, now: NOW, verify: verify(AUD) });
    assert.deepStrictEqual(r, { ok: false, reason: 'account_unavailable' }, `🔴 a linked login whose activity transaction saw the tombstone must refuse (${JSON.stringify(r)})`);
    // P2-6
    await fixtures();
    const t = (await signIn({ sub: '999' })).ticket;
    await S.bindTicket(db, { ticketId: t, sessionId: SESSION, rid: RID, now: NOW, phoneHash: 'ph_a', challengeId: 'cz' });
    assert.ok(await S.redeemTicket(db, { ticketId: t, sessionId: SESSION, rid: RID, now: NOW, phoneHash: 'ph_a', challengeId: 'cz', uid: UID }));
    const row = (await db.ref(`link_tickets/${t}`).once('value')).val();
    assert.deepStrictEqual(Object.keys(row).sort(), ['consumed_at', 'exp', 'state'], `🔴 a consumed ticket keeps private data: ${JSON.stringify(row)}`);
    // expiry pruning
    await db.ref('auth_challenges').set({ old: { exp: NOW - 1, used: false }, live: { exp: NOW + 1000, used: false } });
    await db.ref('link_tickets/expired_one').set({ state: 'issued', exp: NOW - 5, email: 'x@y.co' });
    assert.strictEqual(await S.pruneExpired(db, NOW), 2, 'the expired challenge + the expired ticket');
    assert.deepStrictEqual(Object.keys((await db.ref('auth_challenges').once('value')).val()), ['live'], 'the live challenge kept');
    assert.ok((await db.ref(`link_tickets/${t}`).once('value')).exists() && !(await db.ref('link_tickets/expired_one').once('value')).exists(), 'the unexpired ticket kept, the expired one gone');
  }
  ok('codex r1: a linked Google login whose activity transaction sees a tombstone that committed after isLive → REFUSED (no uid); a consumed ticket keeps only {state, consumed_at, exp}; expired challenges / tickets are pruned');

  clearTimeout(WATCHDOG);
  console.log(`\nsignup-core.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('signup-core.emulator FAILED:', e && e.stack || e); process.exit(1); });
