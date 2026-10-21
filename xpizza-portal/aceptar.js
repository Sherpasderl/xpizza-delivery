// PLAN-portal-team-invites r2.1 §3 (T-c) — the invitee's /aceptar page: a RESUMABLE stage machine. On every load the stage is
// decided from the RESTORED state (the URL's invite id, the server's invite preview, a restored Firebase session), so a
// reload, a lost response or a crash never strands the invitee:
//   A4 invalid      no / malformed invite id, or the server does not know it (uniform not-found)
//   A1 email        an email link + no session → ask the address, sign in with the link, strip the one-time code from the URL
//   A2b busy        accept (idempotent for the same uid); the server's 30 s in-flight window → one auto-retry, then the fallback
//   A2 password     shown ONLY when acceptance reports password_set !== true (providerData is never consulted)
//   A3 error        one card: used/expired · email mismatch · no longer active · could not complete
//   done            → the portal, already signed in
// Built to the OWNER-APPROVED mockup v8. Every Firebase / network call is INJECTED (deps) so the whole machine is testable;
// aceptar-boot.js wires the real SDK. Data is rendered with textContent only. No ID token ever appears in a URL or a log.

export const INVITE_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
export const RETRY_MS = 31000;   // the server's in-flight window is 30 s
export const ERR = Object.freeze({
  used: { title: 'Este enlace ya se usó o venció', text: 'Pedile al dueño que te reenvíe la invitación.', portal: true },
  mismatch: { title: 'Ese correo no coincide con la invitación', text: 'Escribí el correo exacto donde te llegó el enlace.', action: 'Probar otra vez' },
  inactive: { title: 'Esta invitación ya no está activa', text: 'El dueño la canceló o envió una nueva. Revisá tu correo más reciente.', portal: true },
  failed: { title: 'No pudimos completar la invitación', text: 'Revisá tu conexión e intentá de nuevo.', action: 'Reintentar', neutral: true },
});
// server acceptance code → card (PLAN §3 step 2)
export const CARD_FOR = Object.freeze({ already_used: 'used', expired: 'used', superseded: 'inactive', cancelled: 'inactive', email_mismatch: 'mismatch',
  // codex T-c build r1: the inviter lost authority / the branch or brand is gone → «ya no está activa», never a retry
  inviter_not_authorized: 'inactive', location_not_member: 'inactive', brand_invalid: 'inactive' });

export function ledeOf(p) {
  const brand = p && typeof p.brand_name === 'string' && p.brand_name ? p.brand_name : null;
  const branches = p && Array.isArray(p.branch_names) && p.branch_names.length ? ` (${p.branch_names.join(', ')})` : '';
  const role = `como Gerente de sucursal${branches}.`;
  const inviter = p && typeof p.inviter_name === 'string' && p.inviter_name ? p.inviter_name : null;
  if (inviter && brand) return `${inviter} te invitó a ${brand} ${role}`;
  if (brand) return `Te invitaron a ${brand} ${role}`;   // defensive branch only: owners always carry a profile name
  return `Te invitaron ${role}`;
}
// the URL after the email link is consumed: ONLY ?invite= survives (Firebase's oobCode / mode / apiKey / lang are dropped)
export function cleanUrl(href, inviteId) {
  const u = new URL(href);
  return `${u.pathname}?invite=${encodeURIComponent(inviteId)}`;
}

export function startAceptar(deps) {
  const { doc, href, history, auth, api, goPortal } = deps;
  const later = deps.setTimeout || setTimeout;
  const cancel = deps.clearTimeout || clearTimeout;
  const $ = (id) => doc.getElementById(id);
  const STAGES = ['st-email', 'st-busy', 'st-password', 'st-error', 'st-invalid'];
  const show = (id) => { for (const s of STAGES) $(s).hidden = s !== id; };
  // gen: every async continuation captures it and drops its result once it moved (an auth change, a newer acceptance)
  const st = { gen: 0, inviteId: null, preview: null, retryTimer: null, autoRetried: false, member: null, cardAction: null, acceptUid: null, accepting: false };
  const params = (() => { try { return new URL(href).searchParams; } catch (_) { return null; } })();
  const inviteId = params ? params.get('invite') : null;

  const header = (name) => { const ok = typeof name === 'string' && name.length > 0; $('restname').textContent = ok ? name : ''; $('restname').hidden = !ok; $('restsep').hidden = !ok; };
  function card(kind) {
    const c = ERR[kind];
    $('err-card').className = `errbox${c.neutral ? ' neutral' : ''}`;
    $('err-title').textContent = c.title; $('err-text').textContent = c.text;
    $('err-portal').hidden = !c.portal;
    $('err-action').hidden = !c.action; $('err-action').textContent = c.action || '';
    st.cardAction = kind === 'mismatch' ? tryAgain : kind === 'failed' ? (st.failedRetry || init) : null;
    show('st-error');
  }
  const invalid = () => { header(null); show('st-invalid'); };
  // the action parameters (oobCode / mode / apiKey / lang) stay while they may still be needed — a reload at A1 must still be A1
  // (codex T-c build r2) — and are stripped once the link was consumed, or once a restored session's acceptance made them moot
  let stripped = false;
  const stripLink = () => { if (!stripped && params && inviteId && [...params.keys()].some((k) => k !== 'invite')) { stripped = true; history.replaceState(null, '', cleanUrl(href, inviteId)); } };
  // personal data never outlives the account it belongs to (codex T-c build r1 P1)
  function clearPersonal() {
    st.acceptUser = null;
    $('whoami').textContent = ''; $('whoami').hidden = true; $('welcome-text').textContent = '';
    $('pw').value = ''; $('correo').value = ''; $('reset-text').textContent = ''; $('reset-sent').hidden = true;
    st.member = null; st.acceptUid = null;
  }
  function invalidate() { st.gen += 1; if (st.retryTimer) { cancel(st.retryTimer); st.retryTimer = null; } st.accepting = false; }

  async function init() {
    invalidate();
    const gen = st.gen;
    st.failedRetry = init;
    const user = await auth.ready();   // the restored session (resolved FIRST: absent ≠ malformed)
    if (gen !== st.gen) return;
    if (inviteId == null) return user ? goPortal() : invalid();   // a signed-in visit without an invite → the portal
    if (!INVITE_ID_RE.test(inviteId)) return invalid();
    st.inviteId = inviteId;
    let p;
    try { p = await api.preview(inviteId); } catch (e) { if (gen !== st.gen) return; return e && e.status === 404 ? invalid() : card('failed'); }
    if (gen !== st.gen) return;
    st.preview = p;
    header(p.brand_name);
    if (p.state === 'cancelled' || p.state === 'superseded') return card('inactive');
    if (p.state === 'expired') return card('used');
    if (p.state === 'used' && !user) return card('used');   // a used invite may still be THIS user's, mid-way (resumable)
    if (user) return accept();
    if (auth.isLink(href)) { $('invite-lede').textContent = ledeOf(p); return show('st-email'); }
    return invalid();   // no link and no session: open the page from the invitation email
  }

  async function onEmail(e) {
    e.preventDefault();
    const email = String($('correo').value || '').trim();
    if (!email) { $('correo-fld').classList.add('invalid'); return; }
    $('emailbtn').disabled = true;
    const gen = st.gen;
    try {
      await auth.signInWithLink(email, href);
      if (gen !== st.gen) return;
      stripLink();   // consumed: the one-time code never survives a reload
      return accept();
    } catch (err) {
      if (gen !== st.gen) return;
      const code = err && err.code;
      if (code === 'auth/invalid-email') return card('mismatch');
      if (code === 'auth/invalid-action-code' || code === 'auth/expired-action-code') return card('used');
      st.failedRetry = () => { show('st-email'); };
      return card('failed');
    } finally { $('emailbtn').disabled = false; }
  }

  async function accept() {
    if (st.accepting) return;   // serialized: one acceptance in flight (codex T-c build r1 P2)
    if (st.retryTimer) { cancel(st.retryTimer); st.retryTimer = null; }
    st.gen += 1; const gen = st.gen;
    st.accepting = true; st.acceptUid = auth.uid(); st.acceptUser = auth.user();
    $('retry1').disabled = true; $('retry2').disabled = true;
    show('st-busy');
    $('busy-live').hidden = false; $('busy-retry').hidden = false; $('busy-fallback').hidden = true;
    st.failedRetry = accept;
    let r;
    try { r = await api.accept(st.inviteId); } catch (e) { r = null; }
    if (gen !== st.gen) return;   // obsolete: an auth change or a newer acceptance owns the page now
    st.accepting = false; $('retry1').disabled = false; $('retry2').disabled = false;
    if (!r) return card('failed');
    if (r.ok) {
      stripLink();   // a restored session's acceptance: the link parameters are no longer needed
      if (r.brand_name) header(r.brand_name);
      if (r.password_set === true) return goPortal();
      st.member = r.member || null;
      return passwordStage(r.brand_name || (st.preview && st.preview.brand_name));
    }
    const code = r.code;
    if (code === 'pending') {
      if (st.autoRetried) { $('busy-live').hidden = true; $('busy-retry').hidden = true; $('busy-fallback').hidden = false; return; }
      st.autoRetried = true;
      st.retryTimer = later(() => { st.retryTimer = null; if (gen === st.gen) accept(); }, RETRY_MS);
      return;
    }
    if (code === 'email_unverified') {   // a restored session whose email isn't verified → consume the link, which verifies it
      if (auth.isLink(href)) { await auth.signOut(); if (gen !== st.gen) return; $('invite-lede').textContent = ledeOf(st.preview); return show('st-email'); }
      return card('used');
    }
    if (code === 'not_found') return invalid();   // never retried
    if (CARD_FOR[code]) return card(CARD_FOR[code]);
    return card('failed');
  }

  function passwordStage(brand) {
    $('welcome-text').textContent = brand ? `ya sos parte del equipo de ${brand}.` : 'ya sos parte del equipo.';
    const m = st.member;
    $('whoami').hidden = !m; $('whoami').textContent = m ? `Entrás como ${m.name} · ${m.email}` : '';
    $('reset-sent').hidden = true; $('pwform').hidden = false;
    show('st-password');
  }

  async function onPassword(e) {
    e.preventDefault();
    // A2 belongs to the ACCEPTING account: another tab switching the session must never set a different user's password
    if (!st.acceptUid || auth.uid() !== st.acceptUid) { clearPersonal(); return init(); }
    const pw = String($('pw').value || '');
    if (pw.length < 8) { $('pw-fld').classList.add('invalid'); $('pw-note').classList.add('invalid'); return; }
    $('pwbtn').disabled = true;
    const gen = st.gen; const uid = st.acceptUid; const who = st.acceptUser; const email = auth.email();   // read while uid is verified
    // the live account must STILL be the accepting one after every await (a session switch may land before its notification)
    const stillA = () => gen === st.gen && auth.uid() === uid;
    const reenter = () => { clearPersonal(); init(); };
    try {
      await auth.updatePassword(pw, who);
      if (!stillA()) return reenter();
      await api.passwordSet(who);   // with the ACCEPTING user's own ID token: the server records it for that account only
      if (!stillA()) return reenter();
      return goPortal();
    } catch (err) {
      if (gen !== st.gen) return;
      if (!stillA() || (err && err.code === 'account_changed')) return reenter();
      if (err && err.code === 'auth/requires-recent-login') {   // a later reload: Firebase's mailer sends a reset link to the verified address
        try { await auth.sendReset(email); } catch (_) { if (gen !== st.gen) return; if (!stillA()) return reenter(); st.failedRetry = () => passwordStage(null); return card('failed'); }
        if (gen !== st.gen) return;
        if (!stillA()) return reenter();
        $('pwform').hidden = true; $('reset-text').textContent = `a ${email} para crear tu contraseña.`; $('reset-sent').hidden = false;
        return;
      }
      st.failedRetry = () => passwordStage(st.preview && st.preview.brand_name);
      return card('failed');
    } finally { $('pwbtn').disabled = false; }
  }

  async function tryAgain() {   // mismatch: sign out, back to the link stage (if the link is still here)
    await auth.signOut();
    if (auth.isLink(href)) { $('correo').value = ''; $('invite-lede').textContent = ledeOf(st.preview); return show('st-email'); }
    return card('used');
  }

  // ANY auth change after the first decision (another tab signs out / switches account): drop pending work, clear personal
  // data from the DOM, and decide again from the new state (codex T-c build r1 P1)
  let lastUid;
  auth.onChange((u) => {
    const uid = u && u.uid ? u.uid : null;
    if (lastUid === undefined) { lastUid = uid; return; }
    if (uid === lastUid) return;
    lastUid = uid;
    if (st.acceptUid && uid !== st.acceptUid) { clearPersonal(); init(); }
  });

  $('emailform').addEventListener('submit', onEmail);
  $('pwform').addEventListener('submit', onPassword);
  $('retry1').addEventListener('click', () => accept());
  $('retry2').addEventListener('click', () => { st.autoRetried = false; accept(); });
  $('err-action').addEventListener('click', () => { if (st.cardAction) st.cardAction(); });
  $('eye').addEventListener('click', () => { const on = $('pw').type === 'password'; $('pw').type = on ? 'text' : 'password'; $('eye').textContent = on ? 'Ocultar' : 'Mostrar'; $('eye').setAttribute('aria-pressed', String(on)); });
  $('correo').addEventListener('input', () => $('correo-fld').classList.remove('invalid'));
  $('pw').addEventListener('input', () => { $('pw-fld').classList.remove('invalid'); $('pw-note').classList.remove('invalid'); });
  return init();
}
