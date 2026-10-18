'use strict';
/**
 * PLAN-signup-email-social r3 (+ BC1–BC3) — the REAL index.js handlers on the emulators:  npm run test:signup-http
 * Stubbed boundaries only: WhatsApp (records the code), the Firebase Auth token mint / verify (deterministic), and Google's
 * certificate fetch (google-auth-library's OAuth2Client.verifyIdToken is routed to its REAL verifySignedJwtWithCertsAsync with
 * test RS256 keys — the verification itself is never stubbed).
 *   1 DIFFERENTIAL (§3.2 + BC3): verifyOtp / requestOtp WITHOUT a ticket vs the slice base, deterministic dependencies, Google
 *     config absent AND present — identical response bytes, identical WhatsApp sends, and an identical database except
 *     exactly ONE declared additive write per login: user_private/{uid}/last_active;
 *   2 Flow B end to end: googleStart → googleSignIn (unlinked → ticket) → requestOtp{ticket} → verifyOtp{ticket} → link
 *     'linked' (auth_links/google/{sub} = the PHONE account's uid; the provider email recorded unverified) → a later Google
 *     login returns a token for that SAME uid; a third brand's config renders through getSignupConfig;
 *   3 conflict: a second phone account linking the same Google identity → its phone login succeeds with its own token,
 *     link 'conflict', the first account byte-identical;
 *   4 ticket binding: a ticket bound to one code is dead after a newer code (no ticket) for the phone; a ticket on another
 *     phone / another session → 'invalid'; the phone login always succeeds;
 *   5 BC3: the activity refresh — written on a phone login; a hung refresh never delays the login past its deadline nor
 *     changes the response; a tombstoned uid → the login proceeds exactly as today and the tombstone is untouched;
 *   6 the sweep race (BC3 + §3.6): a login between the sweep's read and its tombstone makes the sweep abort for that account
 *     (kept, logs in); an untouched stale account is tombstoned, removed and its links deleted; a link to a deleted account
 *     is pruned;
 *   7 deleteAccount: tombstone {deleted_at}, today's removals + deleted_uids, every auth_links row; that Google identity is
 *     inert afterwards (a ticket, never the deleted uid); the old session's completeProfile / setPromos → refused;
 *   9 codex r1: the profile endpoints are rate-limited; the residual cleanup runs with no profiles;
 *   8 completeProfile / setPromos / getSignupConfig over HTTP: per-brand consent from the server legal config; no token → 401;
 *     an unknown or missing restaurant → 400 (never a default brand).
 */
require('./_emulator-required')('database', 'firestore');

const assert = require('assert');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const express = require('express');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-xpizza';
process.env.OTP_SALT = process.env.OTP_SALT || 'h'.repeat(40);
const WATCHDOG = setTimeout(() => { console.error('signup-http: FAILED — watchdog'); process.exit(1); }, 900000);
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// ── 1. the differential runs FIRST, in fresh worker processes (each clears the database it uses) ──
function runWorker(mode, google) {
  const r = spawnSync(process.execPath, [path.join(__dirname, '_signup-otp-worker.js'), mode, google], { env: process.env, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 240000 });
  const m = /@@RESULT@@(.*)\n/.exec(r.stdout || '');
  assert.ok(r.status === 0 && m, `worker ${mode} ${google}: rc ${r.status}\n${(r.stderr || '').slice(-2000)}`);
  return JSON.parse(m[1]);
}
function differential() {
  for (const g of ['google:off', 'google:on']) {
    const base = runWorker('base', g); const cur = runWorker('current', g);
    assert.deepStrictEqual(cur.responses, base.responses, `🔴 ${g}: response bytes differ`);
    assert.deepStrictEqual(cur.sent, base.sent, `🔴 ${g}: WhatsApp sends differ`);
    const priv = cur.db.user_private || {}; const rest = { ...cur.db }; delete rest.user_private;
    assert.deepStrictEqual(rest, base.db, `🔴 ${g}: the database differs beyond user_private`);
    const uids = Object.keys((base.db && base.db.user_profiles) || {});
    assert.ok(uids.length === 2, `premise: two accounts (${uids.length})`);
    assert.deepStrictEqual(Object.keys(priv).sort(), uids.sort(), 'one additive node per logged-in account');
    for (const u of uids) { assert.deepStrictEqual(Object.keys(priv[u]), ['last_active'], `🔴 ${u}: only last_active`); assert.strictEqual(typeof priv[u].last_active, 'number'); }
    assert.ok(base.responses.some((r) => r.label === 'verify new' && /"ok":true/.test(r.body)), 'premise: the scenario logs in');
  }
}

// ── the in-process boundaries for cells 2–8 ──
const SENT = [];
{
  const p = require.resolve('../whatsapp'); const real = require(p);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, tplOtp: ({ code }) => `CODE:${code}`, isEnabledForRestaurant: async () => false, sendMessage: async (to, body) => { SENT.push({ to, body }); return { ok: true }; } } };
}
const MINTED = [];
{
  const p = require.resolve('firebase-admin/auth'); const real = require(p);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, getAuth: () => ({
    createCustomToken: async (uid, claims) => { MINTED.push({ uid, claims }); return `tok:${uid}`; },
    verifyIdToken: async (t) => { const m = /^idt:(u_[a-f0-9]{24})$/.exec(String(t)); if (!m) throw new Error('bad'); return { uid: m[1], customer: true }; } }) } };
}
const KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERTS = { kid1: KEY.publicKey.export({ type: 'spki', format: 'pem' }) };
{
  const p = require.resolve('google-auth-library'); const real = require(p);
  class TestOAuth2Client extends real.OAuth2Client {
    async verifyIdToken({ idToken, audience }) { return this.verifySignedJwtWithCertsAsync(idToken, CERTS, audience, ['accounts.google.com', 'https://accounts.google.com']); }   // only the cert FETCH is replaced
  }
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { ...real, OAuth2Client: TestOAuth2Client } };
}
const AUD = { x_pizza: 'client-x.apps.googleusercontent.com', la_musa: 'client-l.apps.googleusercontent.com', r3_synth: 'client-r3.apps.googleusercontent.com' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function gjwt(rid, claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'kid1', typ: 'JWT' });
  const body = b64({ iss: 'https://accounts.google.com', aud: AUD[rid], sub: '1000001', email: 'ana@gmail.com', email_verified: true, name: 'Ana Google', iat: now, exp: now + 600, ...claims });
  return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), KEY.privateKey).toString('base64url')}`;
}

let app, admin, rtdb, fsdb, S, T3, makeRtdbMirror;
function call(handler, { method = 'POST', body, query = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const w = express(); w.use(express.json()); w.use(handler);
    const s = http.createServer(w).listen(0, '127.0.0.1', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${s.address().port}/${query}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
        const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
        s.close(() => resolve({ status: r.status, json: j, text: t }));
      } catch (e) { s.close(() => reject(e)); }
    });
  });
}
const lastCodeTo = (phone) => { for (let i = SENT.length - 1; i >= 0; i--) if (String(SENT[i].to).includes(phone.slice(-8))) { const m = /CODE:(\d{6})/.exec(SENT[i].body); if (m) return m[1]; } return null; };
const freshOtp = async () => { await rtdb.ref('otp').remove(); await rtdb.ref('otp_ip').remove(); await rtdb.ref('rate_limits').remove(); };
async function phoneLogin(phone, rid, extra = {}) {
  await freshOtp();
  const rq = await call(app.requestOtp, { body: { phone, restaurant_id: rid, ...extra } });
  assert.strictEqual(rq.status, 200);
  const code = lastCodeTo(phone); assert.ok(code, `a code for ${phone}`);
  return call(app.verifyOtp, { body: { phone, code, ...extra } });
}
const SESSION = 'sess_' + 'a'.repeat(30), SESSION2 = 'sess_' + 'b'.repeat(30);
async function googleTicketOrLogin(rid, session, claims = {}) {
  const st = await call(app.googleStart, { body: { restaurant_id: rid, session_id: session } });
  assert.ok(st.status === 200 && st.json.ok && st.json.nonce, `googleStart: ${st.text}`);
  return call(app.googleSignIn, { body: { restaurant_id: rid, session_id: session, id_token: gjwt(rid, { nonce: st.json.nonce, ...claims }) } });
}
const uidOfPhone = async (phone) => { const OTP = require('../otp-lib'); return (await rtdb.ref(`phone_index/${OTP.phoneHash(phone)}`).once('value')).val(); };
const LEGAL = { terms_url: 'https://legal.test/terminos', privacy_url: 'https://legal.test/privacidad', terms_version: 't-1', privacy_version: 'p-1', promos_copy_version: 'promo-1' };

(async () => {
  differential();
  ok('DIFFERENTIAL vs the slice base (deterministic deps; Google config absent AND present): verifyOtp / requestOtp without a ticket → identical response bytes, WhatsApp sends and database, except exactly ONE additive write per login: user_private/{uid}/last_active');

  for (const [rid, aud] of Object.entries(AUD)) process.env[`GOOGLE_OAUTH_AUDIENCES__${rid.toUpperCase()}`] = aud;
  app = require('../index.js');
  admin = require('firebase-admin'); rtdb = admin.database(); fsdb = admin.firestore();
  S = require('../signup-core'); T3 = require('../contract/third-brand'); ({ makeRtdbMirror } = require('../catalog/mirror-rtdb'));
  await rtdb.ref('/').set(null);
  await T3.publishThirdBrand(fsdb, { mirror: makeRtdbMirror(rtdb) });
  for (const rid of Object.keys(AUD)) await rtdb.ref(`restaurants/${rid}/legal`).set({ ...LEGAL, terms_version: `t-${rid}` });

  // ── 2. Flow B end to end ──
  const P1 = '50499991001', P2 = '50499991002';
  let U1;
  {
    const g = await googleTicketOrLogin('la_musa', SESSION);
    assert.ok(g.json.ok && g.json.linked === false && g.json.ticket && g.json.email === 'ana@gmail.com', g.text);
    assert.ok(!(await rtdb.ref('auth_links').once('value')).exists() && !(await rtdb.ref('user_profiles').once('value')).exists(), 'nothing created by an unlinked Google sign-in');
    const v = await phoneLogin(P1, 'la_musa', { link_ticket: g.json.ticket, session_id: SESSION });
    assert.ok(v.json.ok && v.json.token && v.json.link === 'linked', v.text);
    U1 = await uidOfPhone(P1);
    assert.strictEqual(v.json.token, `tok:${U1}`, 'the PHONE account\'s token');
    assert.deepStrictEqual((await rtdb.ref('auth_links/google/1000001').once('value')).val().uid, U1, 'the link → the phone account');
    const priv = (await rtdb.ref(`user_private/${U1}`).once('value')).val();
    assert.ok(priv.email === 'ana@gmail.com' && priv.email_verified === false && priv.email_source === 'google' && typeof priv.last_active === 'number', JSON.stringify(priv));
    const again = await googleTicketOrLogin('la_musa', SESSION2);
    assert.ok(again.json.ok && again.json.linked === true && again.json.token === `tok:${U1}`, `a returning Google login → the same account (${again.text})`);
    assert.deepStrictEqual(MINTED[MINTED.length - 1], { uid: U1, claims: { customer: true } }, 'the same customer claim as a phone login');
    const cfg = await call(app.getSignupConfig, { method: 'GET', query: '?restaurant_id=r3_synth' });
    assert.ok(cfg.status === 200 && cfg.json.google_enabled === true && cfg.json.google_client_id === AUD.r3_synth && cfg.json.legal_ready === true && cfg.json.terms_url === LEGAL.terms_url && cfg.json.email_login_enabled === false && cfg.json.rollout_at === null, cfg.text);
    await rtdb.ref('signup_config/rollout_at').set(1234);
    assert.strictEqual((await call(app.getSignupConfig, { method: 'GET', query: '?restaurant_id=r3_synth' })).json.rollout_at, 1234, 'rollout_at from the server config');
    // codex build r2 #3: legal documents missing → NO rollout_at (signup not rolled out for this brand), whatever is set
    const legal3 = (await rtdb.ref('restaurants/r3_synth/legal').once('value')).val();
    await rtdb.ref('restaurants/r3_synth/legal').remove();
    const off = await call(app.getSignupConfig, { method: 'GET', query: '?restaurant_id=r3_synth' });
    assert.ok(off.json.ok && off.json.legal_ready === false && off.json.rollout_at === null, `🔴 legal not ready must withhold rollout_at (${off.text})`);
    await rtdb.ref('restaurants/r3_synth/legal').set(legal3);
    assert.strictEqual((await call(app.getSignupConfig, { method: 'GET', query: '?restaurant_id=r3_synth' })).json.rollout_at, 1234, 'legal restored → rolled out again');
  }
  ok('Flow B: Google (unlinked) → a ticket, nothing created → phone verification with the ticket → link "linked" to the PHONE account (provider email recorded, unverified) → a later Google login mints that SAME uid with the same customer claim; the third brand\'s config renders (no rollout_at while its legal documents are missing)');

  // ── 3. conflict ──
  {
    const g = await googleTicketOrLogin('x_pizza', SESSION);
    // the identity is linked + live → a direct login (which refreshes U1's activity), so force a ticket with a DIFFERENT sub,
    // then link that sub to U1 meanwhile (another device) before the phone verification redeems it
    assert.ok(g.json.linked === true, 'premise: already linked');
    const t2 = await googleTicketOrLogin('x_pizza', SESSION, { sub: '1000002' });
    assert.ok(t2.json.ticket);
    await rtdb.ref('auth_links/google/1000002').set({ uid: U1, at: 1 });   // the identity got linked to U1 meanwhile (another device)
    const before = JSON.stringify((await rtdb.ref(`user_private/${U1}`).once('value')).val()) + JSON.stringify((await rtdb.ref(`user_profiles/${U1}`).once('value')).val());
    const v = await phoneLogin(P2, 'x_pizza', { link_ticket: t2.json.ticket, session_id: SESSION });
    const U2 = await uidOfPhone(P2);
    assert.ok(v.json.ok && v.json.token === `tok:${U2}` && v.json.link === 'conflict', v.text);
    assert.strictEqual((await rtdb.ref('auth_links/google/1000002/uid').once('value')).val(), U1, 'the other link untouched');
    const after = JSON.stringify((await rtdb.ref(`user_private/${U1}`).once('value')).val()) + JSON.stringify((await rtdb.ref(`user_profiles/${U1}`).once('value')).val());
    assert.strictEqual(after, before, '🔴 the other account changed');
  }
  ok('conflict: a phone login linking an identity already linked to another account → its own token, link "conflict"; the other account and its link byte-identical');

  // ── 4. ticket binding ──
  {
    const P3 = '50499991003';
    const t = (await googleTicketOrLogin('x_pizza', SESSION, { sub: '1000003' })).json.ticket;
    await freshOtp();
    await call(app.requestOtp, { body: { phone: P3, restaurant_id: 'x_pizza', link_ticket: t, session_id: SESSION } });
    // a NEWER code for the phone WITHOUT the ticket → the ticket's challenge is dead
    await rtdb.ref('otp').remove(); await rtdb.ref('otp_ip').remove();
    await call(app.requestOtp, { body: { phone: P3, restaurant_id: 'x_pizza' } });
    const v = await call(app.verifyOtp, { body: { phone: P3, code: lastCodeTo(P3), link_ticket: t, session_id: SESSION } });
    assert.ok(v.json.ok && v.json.token && v.json.link === 'invalid', `a newer code kills the bound challenge (${v.text})`);
    assert.ok(!(await rtdb.ref('auth_links/google/1000003').once('value')).exists());
    const t4 = (await googleTicketOrLogin('x_pizza', SESSION, { sub: '1000004' })).json.ticket;
    await freshOtp();
    await call(app.requestOtp, { body: { phone: P3, restaurant_id: 'x_pizza', link_ticket: t4, session_id: SESSION } });
    const v2 = await call(app.verifyOtp, { body: { phone: P3, code: lastCodeTo(P3), link_ticket: t4, session_id: SESSION2 } });
    assert.ok(v2.json.ok && v2.json.link === 'invalid', 'another session at verify');
    // the ticket is still bound to P3: another phone's code (requested WITHOUT the ticket) cannot redeem it
    const t5 = (await googleTicketOrLogin('x_pizza', SESSION, { sub: '1000005' })).json.ticket;
    await freshOtp();
    await call(app.requestOtp, { body: { phone: P3, restaurant_id: 'x_pizza', link_ticket: t5, session_id: SESSION } });
    await rtdb.ref('otp_ip').remove();
    await call(app.requestOtp, { body: { phone: '50499991004', restaurant_id: 'x_pizza' } });
    const v3 = await call(app.verifyOtp, { body: { phone: '50499991004', code: lastCodeTo('50499991004'), link_ticket: t5, session_id: SESSION } });
    assert.ok(v3.json.ok && v3.json.link === 'invalid', `the ticket bound to another phone (${v3.text})`);
    assert.ok(!(await rtdb.ref('auth_links/google/1000005').once('value')).exists());
  }
  ok('ticket binding: a newer code (no ticket) kills the bound challenge; another session at verify, or another phone → link "invalid"; the phone login succeeds every time');

  // ── 5. BC3 ──
  {
    const P5 = '50499991005';
    await phoneLogin(P5, 'x_pizza'); const U5 = await uidOfPhone(P5);
    const la1 = (await rtdb.ref(`user_private/${U5}/last_active`).once('value')).val();
    assert.strictEqual(typeof la1, 'number', 'written on a phone login');
    const realTouch = S.touchActivity;
    S.touchActivity = () => new Promise(() => {});   // the refresh HANGS
    try {
      const t0 = Date.now(); const v = await phoneLogin(P5, 'x_pizza'); const el = Date.now() - t0;
      assert.ok(v.json.ok && v.json.token === `tok:${U5}` && !('link' in v.json), v.text);
      assert.ok(el < 1500 + 6000, `bounded (${el} ms)`);
    } finally { S.touchActivity = realTouch; }
    S.touchActivity = async () => { throw new Error('rtdb down'); };
    try { const v = await phoneLogin(P5, 'x_pizza'); assert.ok(v.json.ok && v.json.token === `tok:${U5}`, 'a failed refresh never errors the login'); } finally { S.touchActivity = realTouch; }
    await rtdb.ref(`user_private/${U5}`).set({ deleted_at: 42 });
    const v = await phoneLogin(P5, 'x_pizza');
    assert.ok(v.json.ok && v.json.token === `tok:${U5}`, 'the login proceeds exactly as today');
    assert.deepStrictEqual((await rtdb.ref(`user_private/${U5}`).once('value')).val(), { deleted_at: 42 }, 'the tombstone untouched (the refresh aborted)');
  }
  ok('BC3: a phone login writes last_active; a HUNG refresh never delays the login past its deadline and a FAILED one never errors it (same response); a tombstoned uid → the login proceeds, the tombstone untouched');

  // ── 6. the sweep race ──
  {
    const ACCOUNT = require('../account-lib');
    const OLD = Date.now() - ACCOUNT.INACTIVE_MS - 86400e3;
    const PA = '50499991006', PB = '50499991007';
    await phoneLogin(PA, 'x_pizza'); await phoneLogin(PB, 'x_pizza');
    const UA = await uidOfPhone(PA), UB = await uidOfPhone(PB);
    for (const u of [UA, UB]) { await rtdb.ref(`user_profiles/${u}/last_login`).set(OLD); await rtdb.ref(`user_private/${u}/last_active`).set(OLD); }
    await rtdb.ref('auth_links/google/2000001').set({ uid: UB, at: 1 });
    await rtdb.ref('auth_links/google/2000009').set({ uid: 'u_' + 'f'.repeat(24), at: 1 });
    await rtdb.ref(`user_private/${'u_' + 'f'.repeat(24)}`).set({ deleted_at: 7 });   // a link that raced an earlier deletion
    // interleave: A logs in AFTER the sweep's read (pruneCandidates) and BEFORE A's tombstone transaction
    const realCandidates = ACCOUNT.pruneCandidates; const realTomb = S.tombstone;
    let interleaved = false, loginDone = null;
    ACCOUNT.pruneCandidates = (profiles, cutoff) => { const c = realCandidates(profiles, cutoff); loginDone = phoneLogin(PA, 'x_pizza'); return c; };
    S.tombstone = async (db, uid, opts) => { if (uid === UA && !interleaved) { interleaved = true; await loginDone; } return realTomb(db, uid, opts); };
    try { await app.pruneInactiveAccounts.run({}); } finally { ACCOUNT.pruneCandidates = realCandidates; S.tombstone = realTomb; }
    assert.ok(interleaved, 'premise: the login interleaved');
    assert.ok((await rtdb.ref(`user_profiles/${UA}`).once('value')).exists() && !(await rtdb.ref(`user_private/${UA}/deleted_at`).once('value')).exists(), '🔴 the sweep removed an account that logged in after its read');
    assert.strictEqual(await uidOfPhone(PA), UA, 'A keeps its account');
    assert.ok(!(await rtdb.ref(`user_profiles/${UB}`).once('value')).exists() && !(await uidOfPhone(PB)), 'B (untouched) removed');
    assert.deepStrictEqual(Object.keys((await rtdb.ref(`user_private/${UB}`).once('value')).val()), ['deleted_at'], 'B tombstoned (BC2)');
    assert.ok(!(await rtdb.ref(`deleted_uids/${UB}`).once('value')).exists(), 'the sweep still writes no deleted_uids (account-lib unchanged)');
    assert.ok(!(await rtdb.ref('auth_links/google/2000001').once('value')).exists(), 'B\'s link removed');
    assert.ok(!(await rtdb.ref('auth_links/google/2000009').once('value')).exists(), 'the link to an earlier-deleted account pruned');
  }
  ok('the sweep race: a login between the sweep\'s read and its tombstone makes the sweep ABORT for that account (kept, same uid); an untouched stale account is tombstoned (exactly {deleted_at}), removed and its link deleted; a link to an earlier-deleted account pruned');

  // ── 7. deleteAccount ──
  {
    const tokU1 = `idt:${U1}`;
    const d = await call(app.deleteAccount, { headers: { 'x-firebase-id-token': tokU1 } });
    assert.ok(d.status === 200 && d.json.ok, d.text);
    assert.deepStrictEqual(Object.keys((await rtdb.ref(`user_private/${U1}`).once('value')).val()), ['deleted_at'], 'BC2 tombstone');
    assert.ok(!(await rtdb.ref(`user_profiles/${U1}`).once('value')).exists() && (await rtdb.ref(`deleted_uids/${U1}`).once('value')).exists(), 'today\'s removals + deleted_uids');
    const rows = (await rtdb.ref('auth_links/google').orderByChild('uid').equalTo(U1).once('value')).val();
    assert.strictEqual(rows, null, 'every link of the account removed');
    const g = await googleTicketOrLogin('la_musa', SESSION);
    assert.ok(g.json.ok && g.json.linked === false, 'that Google identity is inert (a ticket, never the deleted uid)');
    const cp = await call(app.completeProfile, { headers: { 'x-firebase-id-token': tokU1 }, body: { restaurant_id: 'la_musa', email: 'a@b.co', accept_terms: true, promos: false } });
    const sp = await call(app.setPromos, { headers: { 'x-firebase-id-token': tokU1 }, body: { restaurant_id: 'la_musa', value: true } });
    assert.ok(cp.status === 401 && sp.status === 401, `the old session refused (${cp.status}/${sp.status})`);
    assert.deepStrictEqual(Object.keys((await rtdb.ref(`user_private/${U1}`).once('value')).val()), ['deleted_at']);
  }
  ok('deleteAccount: tombstone (exactly {deleted_at}), today\'s removals + deleted_uids, every link by uid; the Google identity is inert afterwards; the old session\'s completeProfile / setPromos refused, the tombstone intact');

  // ── 8. completeProfile / setPromos / getSignupConfig ──
  {
    const P8 = '50499991008'; await phoneLogin(P8, 'r3_synth'); const U8 = await uidOfPhone(P8);
    const H = { 'x-firebase-id-token': `idt:${U8}` };
    const cp = await call(app.completeProfile, { headers: H, body: { restaurant_id: 'r3_synth', email: 'Cliente@Mail.com', accept_terms: true, promos: true } });
    assert.ok(cp.status === 200 && cp.json.ok, cp.text);
    const c = (await rtdb.ref(`user_private/${U8}/consent/r3_synth`).once('value')).val();
    assert.ok(c.terms.version === 't-r3_synth' && c.promos.value === true && c.promos.copy_version === 'promo-1', JSON.stringify(c));
    const sp = await call(app.setPromos, { headers: H, body: { restaurant_id: 'r3_synth', value: false } });
    assert.ok(sp.json.ok && (await rtdb.ref(`user_private/${U8}/consent/r3_synth/promos/value`).once('value')).val() === false);
    assert.strictEqual((await call(app.completeProfile, { body: { restaurant_id: 'r3_synth', email: 'a@b.co', accept_terms: true, promos: false } })).status, 401, 'no token');
    for (const rid of [undefined, '', 'nope_rid']) {
      assert.strictEqual((await call(app.completeProfile, { headers: H, body: { restaurant_id: rid, email: 'a@b.co', accept_terms: true, promos: false } })).status, 400, `rid ${rid}: never a default brand`);
      assert.strictEqual((await call(app.getSignupConfig, { method: 'GET', query: rid == null ? '' : `?restaurant_id=${rid}` })).status, 400);
      assert.strictEqual((await call(app.googleStart, { body: { restaurant_id: rid, session_id: SESSION } })).status, 400);
    }
    delete process.env.GOOGLE_OAUTH_AUDIENCES__R3_SYNTH;
    const g = await call(app.googleStart, { body: { restaurant_id: 'r3_synth', session_id: SESSION } });
    assert.deepStrictEqual(g.json, { ok: false, reason: 'google_unconfigured' });
    assert.strictEqual((await call(app.getSignupConfig, { method: 'GET', query: '?restaurant_id=r3_synth' })).json.google_enabled, false);
  }
  ok('completeProfile / setPromos over HTTP for the third brand: consent from ITS server legal config; promotions revocable alone; no token → 401; a missing / empty / unknown restaurant → 400 on every endpoint (never a default brand); no audiences → google_unconfigured and google_enabled false');

  // ── 9. codex build r1: P2-9 completeProfile / setPromos are rate-limited; P2-10 the residual cleanup runs with NO profiles ──
  {
    const P9 = '50499991009'; await phoneLogin(P9, 'x_pizza'); const U9 = await uidOfPhone(P9);
    await rtdb.ref('rate_limits').remove();
    const H = { 'x-firebase-id-token': `idt:${U9}` };
    let limitedAt = null;
    for (let i = 0; i < 40 && limitedAt === null; i++) {
      const r = await call(i % 2 ? app.setPromos : app.completeProfile, { headers: H, body: i % 2 ? { restaurant_id: 'x_pizza', value: true } : { restaurant_id: 'x_pizza', email: 'a@b.co', accept_terms: true, promos: false } });
      if (r.status === 429) limitedAt = i;
    }
    assert.ok(limitedAt !== null && limitedAt <= 31, `🔴 the profile endpoints must be rate-limited (first 429 at ${limitedAt})`);
    await rtdb.ref('user_profiles').remove();
    await rtdb.ref('auth_links/google/3000001').set({ uid: 'u_' + 'e'.repeat(24), at: 1 });
    await rtdb.ref(`user_private/${'u_' + 'e'.repeat(24)}`).set({ deleted_at: 3 });
    await rtdb.ref('link_tickets/stale_ticket_aaaaaaaa').set({ state: 'issued', exp: 5, email: 'x@y.co' });
    await app.pruneInactiveAccounts.run({});
    assert.ok(!(await rtdb.ref('auth_links/google/3000001').once('value')).exists(), '🔴 the dead link survives a run with no profiles');
    assert.ok(!(await rtdb.ref('link_tickets/stale_ticket_aaaaaaaa').once('value')).exists(), '🔴 the expired ticket survives');
  }
  ok('codex r1: completeProfile / setPromos answer 429 past the per-IP limit; with NO profiles left the scheduled run still removes a dead link and an expired ticket');

  clearTimeout(WATCHDOG);
  console.log(`\nsignup-http.emulator: OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('signup-http.emulator FAILED:', e && e.stack || e); process.exit(1); });
