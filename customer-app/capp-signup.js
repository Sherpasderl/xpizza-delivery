// Customer app G6 — the in-app SIGN-IN / SIGN-UP sheet: the approved signup prototype's `new` + `existing` flows
// (SIGNUP-mockup/approved/signup-prototype-APPROVED-2026-10-15.html), on the shell's tokens, against the CONFIRMED platform wire
// (CONTRACT-capp-signup-platform-wire.md). UMD, brand-agnostic (no restaurant id or name — guarded). DARK.
//
// Panes (advisor rulings 2026-10-27): phone («Entrá a tu cuenta»; «o» + «Continuar con Google» when the platform enables it;
// «Prefiero seguir como invitado» except under a member-only gate; «Continuar con correo» is G6b, NOT rendered) → code → when the
// server says completion is needed: email (skipped when Google supplied it) → name + Terms (required) + promotions (optional) →
// «¡Perfil creado!»; an existing account → «¡Hola de nuevo, {name}!». The top bar carries the Sola + «Sherpa» lock-up (a Sherpa
// surface). Copy is the prototype's, else the order forms' already-approved strings (the error lines); nothing new.
//
//   createSignup({ doc, host, api, auth, google?, timers?, now? }) → { open({ ctx, prefill?, memberOnly? }), close(), state }
//     host: the element the sheet lives in (outside the store mount's #app, so a re-render never wipes it)
//     api: a CappSignupApi · auth: a CappAuthFirebase · google.getIdToken({ clientId, nonce }) → Promise<id_token> (GIS popup)
//     events (opts.onEvent): 'signed-in' { uid, name, phone, email, isNew } at «Listo» · 'guest' («Prefiero seguir como invitado»)
//                            · 'closed'
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappSignup = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
  const I = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const IC = { close: I('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'), back: I('<path d="M19 12H5"/><path d="M11 18l-6-6 6-6"/>'), check: I('<path d="m5 12.5 4.5 4.5L19 7.5"/>'), alert: I('<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>') };
  // the Sola compass (Sherpa-owned surfaces only)
  const SOLA = `<svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 9.2A14.8 14.8 0 1 1 24 38.8A14.8 14.8 0 1 1 24 9.2" stroke="currentColor" stroke-width="3.4" fill="none"/><path d="M24 12.6L27.3 24L20.7 24Z" fill="var(--acc)"/><path d="M27.3 24L24 31.6L20.7 24Z" fill="currentColor"/><circle cx="24" cy="24" r="1.7" fill="var(--bg)"/></svg>`;
  const GOOGLE_G = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
  // copy: the prototype's; the error / resend lines are the order forms' approved strings; the code errors the approved checkout sheet's
  const COPY = {
    codeErr: { code_wrong: 'Ese código no es. Revisalo e intentá de nuevo.', code_expired: 'Este código ya venció. Pedí uno nuevo.', too_many_attempts: (m) => `Demasiados intentos. Probá de nuevo en ${m} min.` },
    codeGeneric: 'Código incorrecto o vencido',
    saveErr: 'No pudimos guardar tu perfil. Intentá de nuevo.',
    googleUnavailable: 'Google no está disponible acá. Seguí con tu número.',
    linkConflict: 'Esa cuenta de Google ya está conectada a otro número. Entraste con tu número.',
  };
  const GUEST_CTX = new Set(['checkout', 'checkout-returning', 'code', 'refusal']);   // the openings with a checkout behind them
  const fmtLocal = (d) => (d.length > 4 ? d.slice(0, 4) + '-' + d.slice(4) : d);
  const localOf = (e164) => String(e164 || '').replace(/\D/g, '').replace(/^504/, '').slice(0, 8);
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
  const rand = () => { try { const b = new Uint8Array(18); crypto.getRandomValues(b); return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); } catch (_) { return Math.random().toString(36).slice(2).padEnd(24, '0'); } };

  function createSignup(opts) {
    const o = opts || {};
    const doc = o.doc, host = o.host, api = o.api, auth = o.auth;
    const T = o.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), setInterval: (f, ms) => setInterval(f, ms), clearInterval: (t) => clearInterval(t) };
    const emit = (n, d) => { try { (o.onEvent || (() => {}))(n, d); } catch (_) {} };
    // gen: every async continuation belongs to ONE opening of the sheet — closing makes it stale (nothing lands after a close)
    const S = { open: false, gen: 0, pane: 'phone', stack: [], path: 'phone', memberOnly: false, phone: '', email: '', name: '', promos: false, terms: false,
      google: null, uid: null, isNew: false, completion: null, busy: false, err: '', code: '', resendAt: 0, cfg: null, existing: false };
    let tick = null;

    // ── rendering: the approved app prototype v6 signupInner (P:2196-2217) — the shell port of the approved signup prototype ──
    const digits = () => S.phone.replace(/\D/g, '');
    const err = () => (S.err ? `<p class="inline err">${IC.alert}<span>${esc(S.err)}</span></p>` : '');
    const topb = () => `<div class="topb">${S.stack.length ? `<button class="iconbtn" data-su="back" aria-label="Atrás">${IC.back}</button>` : '<span class="iconbtn"></span>'}<span class="bm">${SOLA} Sherpa</span><button class="iconbtn" data-su="close" aria-label="Cerrar">${IC.close}</button></div>`;
    function phonePane() {
      const viaGoogle = S.path === 'google';
      const g = !viaGoogle && S.cfg && S.cfg.googleEnabled && o.google && typeof o.google.getIdToken === 'function';
      // advisor 2026-10-27: «Continuar con correo» is G6b (not rendered: no control without effect); the guest link only where there is a
      // checkout to continue as a guest (the prototype draws it only for an order) — never from Cuenta, never under a member-only gate
      const alts = viaGoogle ? '' : `${g ? `<div class="or">o</div><button class="alt" data-su="google">${GOOGLE_G}Continuar con Google</button>` : ''}${!S.memberOnly && GUEST_CTX.has(S.ctx) ? '<button class="lnk" data-su="guest">Prefiero seguir como invitado</button>' : ''}`;
      return `<div class="h1">${viaGoogle ? 'Tu teléfono' : 'Entrá a tu cuenta'}</div><p class="sub">${viaGoogle ? 'Lo necesitamos para la entrega y para avisarte por WhatsApp.' : 'Guardá tus datos y pedí más rápido la próxima vez.'}</p>
    <span class="ml">Teléfono</span><div class="phonerow"><span class="cc">+504</span><input class="inp" id="su-phone" type="tel" inputmode="numeric" autocomplete="tel" placeholder="9999-9999" value="${esc(S.phone)}" aria-label="Teléfono"></div>
    <button class="cta" data-su="phone-go"${digits().length === 8 && !S.busy ? '' : ' disabled'}>Continuar</button><p class="fine">Te enviaremos un código de verificación por WhatsApp.</p>${err()}
    ${alts}`;
    }
    function codePane() {
      const left = Math.max(0, Math.ceil((S.resendAt - Date.now()) / 1000));
      return `<div class="h1">Ingresá el código</div><p class="sub">Te lo enviamos por WhatsApp al <b>+504 ${esc(fmtLocal(digits()))}</b>.</p>
    <div class="otp" role="group" aria-label="Código de 6 dígitos">${[0, 1, 2, 3, 4, 5].map((i) => `<input inputmode="numeric" autocomplete="one-time-code" maxlength="6" class="${S.code[i] ? 'f' : ''}" value="${esc(S.code[i] || '')}" data-su-otp="${i}" aria-label="Dígito ${i + 1}">`).join('')}</div>${err()}
    <button class="cta" data-su="verify"${S.code.length === 6 && !S.busy ? '' : ' disabled'}>Verificar</button><div class="rowx">${left > 0 ? `<span data-su-left>Reenviar en 0:${left < 10 ? '0' : ''}${left}</span>` : '<button data-su="resend">Reenviar código</button>'}</div>`;
    }
    function emailPane() {
      const v = S.email.trim(), ok = EMAIL_RE.test(v), at = S.email.indexOf('@'), dom = at >= 0 ? S.email.slice(at + 1) : null;
      const chips = at >= 0 ? ['gmail.com', 'hotmail.com', 'yahoo.com'].filter((d) => d.startsWith(dom)).map((d) => `<button class="chip" data-su="chip" data-v="${esc(S.email.slice(0, at) + '@' + d)}">${esc(S.email.slice(0, at))}@${d}</button>`).join('') : '';
      return `<div class="h1">Tu correo</div><p class="sub">Te sirve para recuperar tu cuenta si cambiás de número.</p><span class="ml">Correo</span><input class="inp" id="su-email" type="email" inputmode="email" autocomplete="email" placeholder="tu@correo.com" maxlength="254" value="${esc(S.email)}" aria-label="Correo">${chips ? `<div class="chips">${chips}</div>` : ''}<button class="cta" data-su="email-go"${ok ? '' : ' disabled'}>Continuar</button>`;
    }
    function namePane() {
      const c = S.cfg || {}, link = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener"><b>${t}</b></a>` : `<b>${t}</b>`);
      return `<div class="h1">¿Cómo te llamás?</div><p class="sub">Así te saludamos y el repartidor sabe a quién buscar.</p><span class="ml">Tu nombre</span><input class="inp" id="su-name" autocomplete="name" placeholder="Nombre y apellido" maxlength="80" value="${esc(S.name)}" aria-label="Tu nombre">${S.google && S.google.fromGoogle && S.name ? '<span class="badge">Lleno desde Google</span>' : ''}
    <div class="checks"><label class="check"><input type="checkbox" id="su-terms"${S.terms ? ' checked' : ''}><span>Acepto los ${link(c.termsUrl, 'Términos')} y la ${link(c.privacyUrl, 'Política de privacidad')}</span></label><label class="check"><input type="checkbox" id="su-promos"${S.promos ? ' checked' : ''}><span>Quiero recibir promociones por correo y WhatsApp <span class="mute">· opcional</span></span></label></div>${err()}
    <button class="cta" data-su="save"${S.name.trim() && S.terms && !S.busy ? '' : ' disabled'}>Guardar</button>`;
    }
    function donePane() {
      // advisor ruling (e): no per-store rewards row; the existing account = greeting + Cuenta (+ Google) + «Listo»
      if (S.existing) {
        const ge = S.google && S.google.email;
        return `<div class="ok">${IC.check}</div><div class="h1" style="text-align:center">¡Hola de nuevo${firstName(S.name) ? ', ' + esc(firstName(S.name)) : ''}!</div><p class="sub" style="text-align:center;max-width:none">${ge ? 'Entraste con Google a tu misma cuenta (la próxima vez podés usar cualquiera de los dos).' : 'Entraste con tu número.'} Tus recompensas y pedidos siguen aquí.</p><div class="facts"><div><span>Cuenta</span><span>+504 ${esc(fmtLocal(digits()))}</span></div>${ge ? `<div><span>Google</span><span>${esc(ge)}</span></div>` : ''}</div><button class="cta" data-su="finish">Listo</button>`;
      }
      return `<div class="ok">${IC.check}</div><div class="h1" style="text-align:center">¡Perfil creado!</div><p class="sub" style="text-align:center;max-width:none">Ya podés pedir más rápido la próxima vez.</p><div class="facts"><div><span>Nombre</span><span>${esc(S.name)}</span></div><div><span>Teléfono</span><span>+504 ${esc(fmtLocal(digits()))}</span></div><div><span>Correo</span><span>${esc(S.email || 'Sin correo')}</span></div><div><span>Promociones</span><span>${S.promos ? 'Sí' : 'No'}</span></div></div><button class="cta" data-su="finish">Listo</button>`;
    }
    function render() {
      if (!S.open) { host.innerHTML = ''; return; }
      const ae = doc.activeElement, keep = ae && host.contains(ae) && ae.id ? [ae.id, ae.selectionStart, ae.selectionEnd] : null;
      const pane = S.pane === 'code' ? codePane() : S.pane === 'email' ? emailPane() : S.pane === 'name' ? namePane() : S.pane === 'done' ? donePane() : phonePane();
      host.innerHTML = `<div class="scrim" data-su="close"></div><div class="sheet" role="dialog" aria-modal="true" aria-label="Tu cuenta" style="max-height:92%"><div class="grab"></div><div class="sg">${topb()}${pane}</div></div>`;
      if (keep) { const el = doc.getElementById(keep[0]); if (el) { try { el.focus({ preventScroll: true }); if (el.setSelectionRange && keep[1] != null) el.setSelectionRange(keep[1], keep[2]); } catch (_) {} } }
    }
    function go(pane) { S.stack.push(S.pane); S.pane = pane; S.err = ''; render(); }
    const live = (g) => S.open && g === S.gen;

    // ── the flow ──
    function tickStart() { tickStop(); tick = T.setInterval(() => { if (!S.open || S.pane !== 'code') return tickStop(); const el = host.querySelector('[data-su-left]'); if (!el) return; if (Date.now() >= S.resendAt) render(); else { const l = Math.ceil((S.resendAt - Date.now()) / 1000); el.textContent = `Reenviar en 0:${l < 10 ? '0' : ''}${l}`; } }, 1000); }
    function tickStop() { if (tick !== null) { T.clearInterval(tick); tick = null; } }
    async function sendCode() {
      const g = S.gen; S.busy = true; S.code = ''; S.resendAt = Date.now() + 29000;
      if (S.pane !== 'code') go('code'); else render();
      tickStart();
      await api.requestOtp({ phone: '+504' + digits(), ...(S.google && S.google.ticket ? { linkTicket: S.google.ticket, sessionId: S.google.session } : {}) });
      if (!live(g)) return; S.busy = false; render();   // the pane advances regardless (the forms' uniform no-enumeration response)
    }
    async function signedIn(g, r) {
      let uid = null;
      try { uid = await auth.signInWithCustomToken(r.token); } catch (_) { uid = null; }
      if (!live(g)) { if (uid) { try { await auth.signOut(); } catch (_) {} } return; }   // a mint for a closed sheet is undone
      if (!uid) { S.busy = false; S.err = COPY.codeGeneric; render(); return; }
      // Codex G6 r1 #4: another account than the one verified before (Back to the phone, a new number) starts from ITS data only —
      // nothing of the previous account's name / email / consent carries over (a Google link in progress belongs to this phone)
      if (S.uid && S.uid !== uid) Object.assign(S, { name: '', email: '', promos: false, terms: false, existing: false, completion: null, google: S.google && S.google.ticket ? S.google : null });
      S.uid = uid; S.isNew = r.isNew === true; S.completion = r.completion;
      if (r.profile) { if (r.profile.name && !S.name) S.name = r.profile.name; if (r.profile.email && !S.email) S.email = r.profile.email; }
      if (r.name && !S.name) S.name = r.name;
      S.busy = false;
      if (r.completion === 'needed') { S.existing = false; if (S.google && S.google.email) { S.email = S.google.email; go('name'); } else go('email'); return; }
      S.existing = true; go('done');
    }
    async function verify() {
      if (S.busy || S.code.length !== 6) return;
      const g = S.gen; S.busy = true; S.err = ''; render();
      const r = await api.verifyOtp({ phone: '+504' + digits(), code: S.code, ...(S.google && S.google.ticket ? { linkTicket: S.google.ticket, sessionId: S.google.session } : {}) });
      if (!live(g)) return;
      if (!r.ok) {
        S.busy = false; S.code = '';
        S.err = r.reason === 'too_many_attempts' ? COPY.codeErr.too_many_attempts(Math.max(1, Math.ceil((r.retryInS || 600) / 60))) : COPY.codeErr[r.reason] || COPY.codeGeneric;
        render(); return;
      }
      // the Google prefill is kept only for a link that held (the forms' rule); a conflict signs in with the number alone
      if (S.google && S.google.ticket && r.link && r.link !== 'linked' && r.link !== 'noop') S.google = null;
      await signedIn(g, r);
    }
    async function googleFlow() {
      const g = S.gen, session = rand();
      const st = await api.googleStart({ sessionId: session });
      if (!live(g)) return;
      if (!st.ok) { S.err = COPY.googleUnavailable; render(); return; }
      let idToken = null; try { idToken = await o.google.getIdToken({ clientId: S.cfg.googleClientId, nonce: st.nonce }); } catch (_) { idToken = null; }
      if (!live(g) || !idToken) return;   // the customer closed Google's popup: nothing changes
      const r = await api.googleSignIn({ sessionId: session, idToken });
      if (!live(g)) return;
      if (!r.ok) { S.err = COPY.googleUnavailable; render(); return; }
      if (r.linked) { S.google = { email: (r.profile && r.profile.email) || '' }; await signedIn(g, r); return; }
      // unlinked: the phone pane «Tu teléfono» with the link ticket; the name pane will say «Lleno desde Google»
      S.google = { ticket: r.ticket, session, email: r.email || '', fromGoogle: !!r.name }; S.name = S.name || r.name || ''; S.path = 'google'; go('phone');
    }
    async function save() {
      if (S.busy || !S.name.trim() || !S.terms) return;
      const g = S.gen; S.busy = true; S.err = ''; render();
      let idToken = null; try { idToken = await auth.idToken(); } catch (_) { idToken = null; }
      const r = idToken ? await api.completeProfile({ idToken, email: S.email.trim(), name: S.name.trim(), promos: S.promos }) : { ok: false };
      if (!live(g)) return;
      S.busy = false;
      if (!r.ok) { S.err = COPY.saveErr; render(); return; }
      go('done');
    }
    async function close(why) {
      const wasSignedIn = !!S.uid, finished = S.pane === 'done';
      S.open = false; S.gen++; tickStop(); render();
      // a sign-in left mid-completion (no Terms yet) is undone — never a member without the required consent
      if (wasSignedIn && !finished && S.completion === 'needed') { try { await auth.signOut(); } catch (_) {} }
      emit(why === 'guest' ? 'guest' : why === 'done' ? 'done' : 'closed', {});
    }

    function finish() { const d = { uid: S.uid, name: S.name.trim(), phone: '+504' + digits(), email: S.email.trim() || null, isNew: !S.existing }; S.completion = 'complete'; emit('signed-in', d); close('done'); }

    // ── controls ──
    host.addEventListener('click', (ev) => {
      const t = ev.target && ev.target.closest ? ev.target.closest('[data-su]') : null; if (!t || t.disabled || !S.open) return;
      const a = t.dataset.su;
      if (a === 'close') return void (S.pane === 'done' ? finish() : close('close'));   // the account is made: ✕ / the scrim on «Listo» = «Listo»
      if (a === 'guest') return void close('guest');
      if (a === 'back') { if (S.stack.length && !S.busy) { S.pane = S.stack.pop(); S.err = ''; if (S.pane === 'phone' && S.path === 'google' && !S.stack.length) S.path = 'phone'; render(); } return; }
      if (a === 'phone-go') return void sendCode();
      if (a === 'resend') return void sendCode();
      if (a === 'verify') return void verify();
      if (a === 'google') return void googleFlow();
      if (a === 'chip') { S.email = t.dataset.v; render(); return; }
      if (a === 'email-go') { if (EMAIL_RE.test(S.email.trim())) go('name'); return; }
      if (a === 'save') return void save();
      if (a === 'finish') finish();
    });
    host.addEventListener('input', (ev) => {
      const el = ev.target; if (!el || !S.open) return;
      if (el.id === 'su-phone') { const d = el.value.replace(/\D/g, '').slice(0, 8); S.phone = fmtLocal(d); el.value = S.phone; const b = host.querySelector('[data-su="phone-go"]'); if (b) b.disabled = d.length !== 8 || S.busy; return; }
      if (el.id === 'su-email') { S.email = el.value; render(); return; }
      if (el.id === 'su-name') { S.name = el.value; const b = host.querySelector('[data-su="save"]'); if (b) b.disabled = !(S.name.trim() && S.terms) || S.busy; return; }
      if (el.dataset && el.dataset.suOtp !== undefined) {
        const i = Math.min(Number(el.dataset.suOtp) || 0, S.code.length), d = el.value.replace(/\D/g, '');
        S.code = d.length >= 6 ? d.slice(0, 6) : (S.code.slice(0, i) + d).slice(0, 6); S.err = ''; render();
        const nx = host.querySelector(`[data-su-otp="${Math.min(S.code.length, 5)}"]`); if (nx) { try { nx.focus({ preventScroll: true }); } catch (_) {} }
      }
    });
    host.addEventListener('change', (ev) => {
      const el = ev.target; if (!el || !S.open) return;
      if (el.id === 'su-terms') { S.terms = el.checked; const b = host.querySelector('[data-su="save"]'); if (b) b.disabled = !(S.name.trim() && S.terms) || S.busy; }
      if (el.id === 'su-promos') S.promos = el.checked;
    });

    return {
      state: S,
      // ctx: where it was opened from; prefill: the device marker's full E.164 («Entrá de nuevo»); memberOnly: no guest path (a gate)
      open({ ctx, prefill, memberOnly } = {}) {
        S.gen++; Object.assign(S, { open: true, pane: 'phone', stack: [], path: 'phone', memberOnly: memberOnly === true, phone: prefill ? fmtLocal(localOf(prefill)) : '', email: '', name: '', promos: false, terms: false,
          google: null, uid: null, isNew: false, completion: null, busy: false, err: '', code: '', resendAt: 0, existing: false, ctx: ctx || null });
        render();
        const g = S.gen;
        if (!S.cfg) api.config().then((c) => { if (c && c.ok) S.cfg = c; if (live(g) && S.pane === 'phone') render(); });   // the platform's Google / legal — never awaited by the paint
      },
      close: () => close('close'),
    };
  }

  return { createSignup, COPY };
});
