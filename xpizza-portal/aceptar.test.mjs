// PLAN-portal-team-invites r2.1 §3 / §7 (T-c) — the /aceptar stage machine over the REAL aceptar.html (jsdom), with the Firebase
// and network seams stubbed exactly where aceptar-boot.js wires the real ones. Every stage and every transition of §3, incl. a
// reload at each boundary (a fresh startAceptar over the restored state), the pending window, an existing / NEW account, an
// unverified restored session, requires-recent-login, and the URL hygiene (no one-time code survives, no token in any URL).
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startAceptar, ledeOf, cleanUrl, RETRY_MS } from './aceptar.js';
const require = createRequire(new URL('../xpizza-functions/x.js', import.meta.url));
const { JSDOM } = require('jsdom');

const HTML = readFileSync(new URL('./aceptar.html', import.meta.url), 'utf8');
const ID = 'inviteAAAAAAAAAAAAAAAAAAAA';
const LINK = `https://portal.test/aceptar.html?invite=${ID}&mode=signIn&oobCode=SECRETCODE&apiKey=k&lang=es`;
const OPEN = { state: 'open', brand_name: 'Pizzería Del Valle', branch_names: ['Bulevar del Norte'], inviter_name: 'Marcela Pineda' };
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function rig({ href = LINK, preview = OPEN, user = null, link = true, accept = [{ ok: true, outcome: 'granted', password_set: false, brand_name: 'Pizzería Del Valle', member: { name: 'Jorge Ayala', email: 'jorge@m.hn' } }], signIn = null, updatePw = null, onPw = null, onPwSet = null } = {}) {
  const dom = new JSDOM(HTML, { url: href });
  const doc = dom.window.document;
  const calls = { signIn: [], replace: [], accept: 0, pwSet: 0, portal: 0, signOut: 0, reset: [], timers: [] };
  let session = user;
  const listeners = [];
  const uidOf = (u) => (u ? (u.uid || `u_${u.email}`) : null);
  const acceptQ = [...accept];
  const deps = {
    doc, href,
    history: { replaceState: (_s, _t, url) => calls.replace.push(url) },
    goPortal: () => { calls.portal += 1; },
    setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return calls.timers.length; },
    clearTimeout: () => {},
    auth: {
      ready: async () => session,
      isLink: () => link,
      signInWithLink: async (email, h) => { calls.signIn.push([email, h]); if (signIn) throw signIn; session = { email }; },
      signOut: async () => { calls.signOut += 1; session = null; },
      // onPw / onPwSet: the session flips to another account DURING the await with NO change notification yet (the r2 race)
      updatePassword: async (pw, user) => { calls.pwUser = user; if (onPw) onPw(); if (updatePw) throw updatePw; calls.pw = pw; },
      uid: () => uidOf(session),
      user: () => session,
      onChange: (cb) => { listeners.push(cb); cb(session); return () => {}; },
      sendReset: async (email) => { calls.reset.push(email); },
      email: () => 'jorge@m.hn',
    },
    api: {
      preview: async () => { if (preview instanceof Error) throw preview; return preview; },
      accept: async () => { calls.accept += 1; const r = acceptQ.length > 1 ? acceptQ.shift() : acceptQ[0]; if (r instanceof Error) throw r; return r; },
      passwordSet: async (user) => { calls.pwSet += 1; calls.pwSetUser = user; if (onPwSet) onPwSet(); },
    },
  };
  const visible = () => ['st-email', 'st-busy', 'st-password', 'st-error', 'st-invalid'].filter((id) => !doc.getElementById(id).hidden);
  const $ = (id) => doc.getElementById(id);
  const submit = async (id) => { $(id).dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await tick(); };
  const click = async (id) => { $(id).click(); await tick(); };
  const switchTo = async (u) => { session = u; for (const cb of listeners) cb(u); await tick(); };
  const setSession = (u) => { session = u; };
  return { dom, doc, $, deps, calls, visible, submit, click, switchTo, setSession, start: async () => { await startAceptar(deps); await tick(); } };
}
const notFound = Object.assign(new Error('nf'), { status: 404 });

test('A4: no / malformed invite id, or a uniform server not-found → «Este enlace no es válido»', async () => {
  for (const href of ['https://portal.test/aceptar.html', 'https://portal.test/aceptar.html?invite=short', 'https://portal.test/aceptar.html?invite=<script>']) {
    const r = rig({ href }); await r.start();
    assert.deepStrictEqual(r.visible(), ['st-invalid'], href);
  }
  const nf = rig({ preview: notFound }); await nf.start();
  assert.deepStrictEqual(nf.visible(), ['st-invalid']);
  const noLink = rig({ link: false }); await noLink.start();
  assert.deepStrictEqual(noLink.visible(), ['st-invalid'], 'no link and no session');
});

test('A1 → link sign-in → the one-time code is stripped → accept → A2 (a NEW account) → password → the portal', async () => {
  const r = rig(); await r.start();
  assert.deepStrictEqual(r.visible(), ['st-email']);
  assert.strictEqual(r.$('invite-lede').textContent, 'Marcela Pineda te invitó a Pizzería Del Valle como Gerente de sucursal (Bulevar del Norte).');
  assert.strictEqual(r.$('restname').textContent, 'Pizzería Del Valle');
  r.$('correo').value = ' jorge@m.hn ';
  await r.submit('emailform');
  assert.deepStrictEqual(r.calls.signIn, [['jorge@m.hn', LINK]]);
  assert.ok(r.calls.replace.length >= 1 && r.calls.replace.every((u) => u === `/aceptar.html?invite=${ID}`), 'the URL keeps ONLY ?invite= (no oobCode / apiKey / mode / lang)');
  assert.deepStrictEqual(r.visible(), ['st-password'], 'password_set:false → A2 (providerData never consulted)');
  assert.strictEqual(r.$('welcome-text').textContent, 'ya sos parte del equipo de Pizzería Del Valle.');
  assert.strictEqual(r.$('whoami').textContent, 'Entrás como Jorge Ayala · jorge@m.hn');
  r.$('pw').value = 'corta'; await r.submit('pwform');
  assert.ok(r.$('pw-fld').classList.contains('err') && r.calls.pwSet === 0, 'under 8 chars: refused locally');
  r.$('pw').value = 'contrasena-larga'; await r.submit('pwform');
  assert.strictEqual(r.calls.pw, 'contrasena-larga'); assert.strictEqual(r.calls.pwSet, 1); assert.strictEqual(r.calls.portal, 1);
});

test('RESUMABLE: a reload with a restored session goes straight to accept (the link is never re-consumed); password_set → straight to the portal', async () => {
  const r = rig({ href: `https://portal.test/aceptar.html?invite=${ID}`, user: { email: 'jorge@m.hn' }, link: false,
    accept: [{ ok: true, outcome: 'consumed', password_set: true }] });
  await r.start();
  assert.strictEqual(r.calls.signIn.length, 0); assert.strictEqual(r.calls.accept, 1); assert.strictEqual(r.calls.portal, 1, 'an existing account keeps its password');
  // a reload after updatePassword but BEFORE memberPasswordSet: A2 again (harmless)
  const again = rig({ href: `https://portal.test/aceptar.html?invite=${ID}`, user: { email: 'j@m.hn' }, link: false });
  await again.start();
  assert.deepStrictEqual(again.visible(), ['st-password']);
  // a used invite + a session → accept (it may be THIS user's), not the used card
  const used = rig({ preview: { ...OPEN, state: 'used' }, user: { email: 'j@m.hn' }, accept: [{ ok: true, outcome: 'consumed', password_set: true }] });
  await used.start(); assert.strictEqual(used.calls.portal, 1);
});

test('A2b: pending → busy + ONE auto-retry after the 30 s window → the fallback; manual retry recovers', async () => {
  const r = rig({ user: { email: 'j@m.hn' }, accept: [{ ok: false, code: 'pending' }, { ok: false, code: 'pending' }, { ok: true, outcome: 'granted', password_set: true }] });
  await r.start();
  assert.deepStrictEqual(r.visible(), ['st-busy']);
  assert.strictEqual(r.calls.timers.length, 1, 'pending: ONE auto-retry scheduled'); assert.strictEqual(r.calls.timers[0].ms, RETRY_MS);
  assert.ok(RETRY_MS > 30000, 'past the server in-flight window');
  r.calls.timers[0].fn(); await tick();
  assert.ok(!r.$('busy-fallback').hidden && r.$('busy-live').hidden, 'still pending → «Todavía no pudimos activar tu acceso»');
  await r.click('retry2');
  assert.strictEqual(r.calls.portal, 1);
});

test('A3 cards: used / expired, no longer active, mismatch («Probar otra vez» → sign out → A1), could-not-complete («Reintentar»)', async () => {
  for (const [p, title] of [[{ ...OPEN, state: 'expired' }, 'Este enlace ya se usó o venció'], [{ ...OPEN, state: 'used' }, 'Este enlace ya se usó o venció'],
    [{ ...OPEN, state: 'cancelled' }, 'Esta invitación ya no está activa'], [{ ...OPEN, state: 'superseded' }, 'Esta invitación ya no está activa']]) {
    const r = rig({ preview: p }); await r.start();
    assert.deepStrictEqual(r.visible(), ['st-error']); assert.strictEqual(r.$('err-title').textContent, title, p.state);
    assert.ok(!r.$('err-portal').hidden && r.$('err-action').hidden, `${p.state}: «Ir al portal»`);
  }
  for (const [code, title] of [['already_used', 'Este enlace ya se usó o venció'], ['superseded', 'Esta invitación ya no está activa'], ['cancelled', 'Esta invitación ya no está activa']]) {
    const r = rig({ user: { email: 'j@m.hn' }, accept: [{ ok: false, code }] }); await r.start();
    assert.strictEqual(r.$('err-title').textContent, title, code);
  }
  const mm = rig({ user: { email: 'other@m.hn' }, accept: [{ ok: false, code: 'email_mismatch' }] }); await mm.start();
  assert.strictEqual(mm.$('err-title').textContent, 'Ese correo no coincide con la invitación');
  assert.strictEqual(mm.$('err-action').textContent, 'Probar otra vez');
  await mm.click('err-action');
  assert.strictEqual(mm.calls.signOut, 1); assert.deepStrictEqual(mm.visible(), ['st-email']);
  const net = rig({ user: { email: 'j@m.hn' }, accept: [new Error('net'), { ok: true, outcome: 'granted', password_set: true }] }); await net.start();
  assert.strictEqual(net.$('err-title').textContent, 'No pudimos completar la invitación'); assert.ok(net.$('err-card').classList.contains('neutral'));
  await net.click('err-action'); assert.strictEqual(net.calls.portal, 1, '«Reintentar» re-runs the acceptance');
  const wrongMail = rig({ signIn: Object.assign(new Error('x'), { code: 'auth/invalid-email' }) }); await wrongMail.start();
  wrongMail.$('correo').value = 'x@y.hn'; await wrongMail.submit('emailform');
  assert.strictEqual(wrongMail.$('err-title').textContent, 'Ese correo no coincide con la invitación');
  const spent = rig({ signIn: Object.assign(new Error('x'), { code: 'auth/invalid-action-code' }) }); await spent.start();
  spent.$('correo').value = 'x@y.hn'; await spent.submit('emailform');
  assert.strictEqual(spent.$('err-title').textContent, 'Este enlace ya se usó o venció');
});

test('codex plan r2 P1-3: a restored UNVERIFIED session → email_unverified → the link stage (sign out, consume the link) → accept', async () => {
  const r = rig({ user: { email: 'j@m.hn' }, accept: [{ ok: false, code: 'email_unverified' }, { ok: true, outcome: 'granted', password_set: true }] });
  await r.start();
  assert.strictEqual(r.calls.signOut, 1); assert.deepStrictEqual(r.visible(), ['st-email']);
  r.$('correo').value = 'j@m.hn'; await r.submit('emailform');
  assert.strictEqual(r.calls.signIn.length, 1); assert.strictEqual(r.calls.portal, 1);
  const noLink = rig({ href: `https://portal.test/aceptar.html?invite=${ID}`, user: { email: 'j@m.hn' }, link: false, accept: [{ ok: false, code: 'email_unverified' }] });
  await noLink.start(); assert.strictEqual(noLink.$('err-title').textContent, 'Este enlace ya se usó o venció');
});

test('requires-recent-login (a later reload) → the reset link to the verified address; the grant is already committed', async () => {
  const r = rig({ user: { email: 'jorge@m.hn' }, updatePw: Object.assign(new Error('x'), { code: 'auth/requires-recent-login' }) });
  await r.start();
  r.$('pw').value = 'contrasena-larga'; await r.submit('pwform');
  assert.deepStrictEqual(r.calls.reset, ['jorge@m.hn']); assert.ok(!r.$('reset-sent').hidden && r.$('pwform').hidden);
  assert.strictEqual(r.calls.pwSet, 0, 'nothing recorded until a password really exists');
});

test('text only + URL hygiene: data is textContent (no HTML sink); the lede variants; no token or code in a URL', async () => {
  const src = readFileSync(new URL('./aceptar.js', import.meta.url), 'utf8') + readFileSync(new URL('./aceptar-boot.js', import.meta.url), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), 'no HTML sinks');
  assert.ok(!/console\.(log|info|warn|error)/.test(src), 'nothing logged (no token can reach a log)');
  const boot = readFileSync(new URL('./aceptar-boot.js', import.meta.url), 'utf8');
  assert.strictEqual(boot.split('sherpaFetch(`').length - 1, 1, 'ONE network call site, through the self-update wrapper');
  assert.ok(boot.includes("sherpaFetch(`${BASE}/${fn}`, { method: 'POST', headers, body: JSON.stringify(body || {}) })"), 'the URL is the bare function URL: the token rides in a header, the invite id in the body');
  assert.ok(boot.includes('headers.Authorization = `Bearer ${t}`'), 'the bearer is a header');
  const r = rig({ preview: { ...OPEN, brand_name: '<b>X</b>' } }); await r.start();
  assert.strictEqual(r.$('restname').textContent, '<b>X</b>'); assert.strictEqual(r.$('restname').children.length, 0);
  assert.strictEqual(ledeOf({ ...OPEN, inviter_name: null }), 'Te invitaron a Pizzería Del Valle como Gerente de sucursal (Bulevar del Norte).', 'defensive branch');
  assert.strictEqual(ledeOf({ state: 'open', brand_name: null, branch_names: [], inviter_name: null }), 'Te invitaron como Gerente de sucursal.');
  assert.strictEqual(cleanUrl(LINK, ID), `/aceptar.html?invite=${ID}`);
});

test('codex T-c build r1 P1: A2 is bound to the ACCEPTING uid — another tab switching the account clears personal data and never sets its password', async () => {
  const r = rig({ user: { uid: 'uA', email: 'a@m.hn' }, accept: [{ ok: true, outcome: 'granted', password_set: false, brand_name: 'Pizzería Del Valle', member: { name: 'Jorge Ayala', email: 'jorge@m.hn' } }, { ok: false, code: 'email_mismatch' }] });
  await r.start();
  assert.deepStrictEqual(r.visible(), ['st-password']);
  assert.ok(r.$('whoami').textContent.includes('Jorge Ayala'));
  // another tab signs in as B (auth state sync): personal data cleared, the page decides again for B
  await r.switchTo({ uid: 'uB', email: 'b@m.hn' });
  assert.strictEqual(r.$('whoami').textContent, '', 'A\'s name / email are gone from the DOM');
  assert.strictEqual(r.calls.accept, 2, 'the page re-decided for the new account');
  assert.strictEqual(r.$('err-title').textContent, 'Ese correo no coincide con la invitación', 'B is judged on its own');
  // a submit when the live account is not the accepting one (the change event not yet seen): refused, nothing updated
  const s2 = rig({ user: { uid: 'uA', email: 'a@m.hn' } }); await s2.start();
  s2.setSession({ uid: 'uB', email: 'b@m.hn' });
  s2.$('pw').value = 'contrasena-larga'; await s2.submit('pwform');
  assert.strictEqual(s2.calls.pw, undefined, '🔴 B\'s password is never changed from A\'s A2'); assert.strictEqual(s2.calls.pwSet, 0);
  // the normal path hands the CAPTURED accepting user to both the updater and the flag call
  const ok3 = rig({ user: { uid: 'uA', email: 'a@m.hn' } }); await ok3.start();
  ok3.$('pw').value = 'contrasena-larga'; await ok3.submit('pwform');
  assert.strictEqual(ok3.calls.pwUser.uid, 'uA'); assert.strictEqual(ok3.calls.pwSetUser.uid, 'uA'); assert.strictEqual(ok3.calls.portal, 1);
});

test('codex T-c build r2 P1: the session flips to B DURING updatePassword with no notification yet → the flag call never runs, A2 is cleared, B re-decided', async () => {
  const A = { uid: 'uA', email: 'a@m.hn' }; const B = { uid: 'uB', email: 'b@m.hn' };
  let r;
  r = rig({ user: A, onPw: () => r.setSession(B),
    accept: [{ ok: true, outcome: 'granted', password_set: false, brand_name: 'Pizzería Del Valle', member: { name: 'Jorge Ayala', email: 'jorge@m.hn' } }, { ok: false, code: 'email_mismatch' }] });
  await r.start();
  r.$('pw').value = 'contrasena-larga'; await r.submit('pwform');
  assert.strictEqual(r.calls.pwUser.uid, 'uA', 'only A\'s own user object was updated');
  assert.strictEqual(r.calls.pwSet, 0, '🔴 memberPasswordSet never runs once the live account is B');
  assert.strictEqual(r.calls.portal, 0);
  assert.strictEqual(r.$('whoami').textContent, '', 'A\'s name / email are gone from the DOM');
  assert.strictEqual(r.calls.accept, 2, 'the page re-decided for B'); assert.strictEqual(r.$('err-title').textContent, 'Ese correo no coincide con la invitación');
  // the flip lands during the flag call itself: that call already carried A's own user (A's token), and the page re-enters, never the portal
  let q;
  q = rig({ user: A, onPwSet: () => q.setSession(B), accept: [{ ok: true, outcome: 'granted', password_set: false, brand_name: 'Pizzería Del Valle', member: { name: 'Jorge Ayala', email: 'jorge@m.hn' } }, { ok: false, code: 'email_mismatch' }] });
  await q.start();
  q.$('pw').value = 'contrasena-larga'; await q.submit('pwform');
  assert.strictEqual(q.calls.pwSetUser && q.calls.pwSetUser.uid, 'uA', 'the flag is authenticated as A (A\'s token), never "whoever is current"');
  assert.strictEqual(q.calls.portal, 0, 'a flip during the flag call re-enters, never the portal'); assert.strictEqual(q.$('whoami').textContent, ''); assert.strictEqual(q.calls.accept, 2);
  // requires-recent-login while the session flipped: no reset email is sent for B, re-entry instead
  let rr;
  rr = rig({ user: A, onPw: () => rr.setSession(B), updatePw: Object.assign(new Error('x'), { code: 'auth/requires-recent-login' }), accept: [{ ok: true, outcome: 'granted', password_set: false, brand_name: 'X', member: { name: 'Jorge Ayala', email: 'jorge@m.hn' } }, { ok: false, code: 'email_mismatch' }] });
  await rr.start(); rr.$('pw').value = 'contrasena-larga'; await rr.submit('pwform');
  assert.deepStrictEqual(rr.calls.reset, [], 'no reset email once the live account is B'); assert.ok(rr.$('reset-sent').hidden); assert.strictEqual(rr.calls.accept, 2);
  // the updater refuses (boot's account_changed) → re-entry, not the could-not-complete card
  const ac = rig({ user: A, updatePw: Object.assign(new Error('x'), { code: 'account_changed' }), accept: [{ ok: true, outcome: 'granted', password_set: false, brand_name: 'X', member: { name: 'Jorge Ayala', email: 'jorge@m.hn' } }, { ok: false, code: 'email_mismatch' }] });
  await ac.start(); ac.$('pw').value = 'contrasena-larga'; await ac.submit('pwform');
  assert.strictEqual(ac.calls.pwSet, 0); assert.strictEqual(ac.calls.accept, 2, 'account_changed re-enters (not the could-not-complete card)'); assert.strictEqual(ac.$('whoami').textContent, '');
});

test('codex T-c build r2 P2: the link parameters stay until consumed — signed out → A1 → reload → still A1 (not A4)', async () => {
  const r = rig({ link: true }); await r.start();
  assert.deepStrictEqual(r.visible(), ['st-email']);
  assert.deepStrictEqual(r.calls.replace, [], 'nothing stripped at load');
  // reload: the address bar is whatever the page left there (still the full link)
  const reloadHref = r.calls.replace.length ? `https://portal.test${r.calls.replace.at(-1)}` : LINK;
  assert.strictEqual(reloadHref, LINK);
  const again = rig({ href: reloadHref }); again.deps.auth.isLink = (h) => h === LINK; await again.start();
  assert.deepStrictEqual(again.visible(), ['st-email'], 'still A1 after the reload');
  // consumed → stripped (only then)
  again.$('correo').value = 'jorge@m.hn'; await again.submit('emailform');
  assert.deepStrictEqual(again.calls.replace, [`/aceptar.html?invite=${ID}`], 'consumed → stripped once');
  // a failed link sign-in keeps them (the link may be retried)
  const bad = rig({ signIn: Object.assign(new Error('x'), { code: 'auth/invalid-action-code' }) }); await bad.start();
  bad.$('correo').value = 'jorge@m.hn'; await bad.submit('emailform');
  assert.deepStrictEqual(bad.calls.replace, []);
  // a restored session whose acceptance FAILS (mismatch) keeps them: «Probar otra vez» still needs the link
  const mm = rig({ user: { uid: 'u1', email: 'x@m.hn' }, accept: [{ ok: false, code: 'email_mismatch' }] }); await mm.start();
  assert.deepStrictEqual(mm.calls.replace, []);
});

test('codex T-c build r1 P2s: authority / scope codes → inactive; not_found → invalid (no retry); acceptance serialized; no-invite signed-in → portal; URL cleaned on the restored path; reset → an exit', async () => {
  for (const code of ['inviter_not_authorized', 'location_not_member', 'brand_invalid']) {
    const r = rig({ user: { uid: 'u1', email: 'j@m.hn' }, accept: [{ ok: false, code }] }); await r.start();
    assert.strictEqual(r.$('err-title').textContent, 'Esta invitación ya no está activa', code);
  }
  const nf = rig({ user: { uid: 'u1', email: 'j@m.hn' }, accept: [{ ok: false, code: 'not_found' }] }); await nf.start();
  assert.deepStrictEqual(nf.visible(), ['st-invalid']); assert.strictEqual(nf.calls.accept, 1, 'never retried');
  // serialized: a retry click while an acceptance is in flight does not start a second one
  let release; const slow = rig({ user: { uid: 'u1', email: 'j@m.hn' } });
  slow.deps.api.accept = () => { slow.calls.accept += 1; return new Promise((res) => { release = res; }); };
  const started = startAceptar(slow.deps); await tick();
  slow.$('retry1').click(); slow.$('retry1').click(); await tick();
  assert.strictEqual(slow.calls.accept, 1, 'one acceptance in flight'); assert.ok(slow.$('retry1').disabled, 'the retry is disabled while in flight');
  slow.$('retry1').disabled = false; slow.$('retry1').click(); await tick();   // even a forced click is refused by the in-flight guard
  assert.strictEqual(slow.calls.accept, 1, 'one acceptance in flight (guard)');
  release({ ok: true, outcome: 'granted', password_set: true }); await started; await tick();
  assert.strictEqual(slow.calls.portal, 1);
  // a signed-in visit WITHOUT ?invite → the portal; a malformed one → invalid
  const bare = rig({ href: 'https://portal.test/aceptar.html', user: { uid: 'u1', email: 'j@m.hn' } }); await bare.start();
  assert.strictEqual(bare.calls.portal, 1); assert.strictEqual(bare.calls.accept, 0);
  const bad = rig({ href: 'https://portal.test/aceptar.html?invite=x', user: { uid: 'u1', email: 'j@m.hn' } }); await bad.start();
  assert.deepStrictEqual(bad.visible(), ['st-invalid']);
  // the restored-session path also strips the one-time code from the address bar
  const restored = rig({ user: { uid: 'u1', email: 'j@m.hn' }, accept: [{ ok: true, outcome: 'consumed', password_set: true }] }); await restored.start();
  assert.deepStrictEqual(restored.calls.replace, [`/aceptar.html?invite=${ID}`], 'a restored acceptance strips the link parameters');
  // after the reset link: an actionable exit (the existing «Ir al portal»)
  const rs = rig({ user: { uid: 'u1', email: 'jorge@m.hn' }, updatePw: Object.assign(new Error('x'), { code: 'auth/requires-recent-login' }) }); await rs.start();
  rs.$('pw').value = 'contrasena-larga'; await rs.submit('pwform');
  const exit = rs.$('reset-sent').querySelector('a.btn');
  assert.ok(!rs.$('reset-sent').hidden && exit && exit.textContent === 'Ir al portal' && exit.getAttribute('href') === './');
});
