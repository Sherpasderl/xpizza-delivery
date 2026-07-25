/* account.js — User Profiles P0 (customer accounts). Self-contained; guest path never touches this
   beyond reading the localStorage marker. Firebase SDK is imported ONLY on login interaction (H8). */
(function () {
  'use strict';
  const CONFIG = {
    restaurant_id: 'x_pizza',                 // 'x_pizza' | 'la_musa'
    brand: 'X. Pizza',
    accent: '#A9791A',                        // gold (La Musa: rojo musa)
    OTP_URL:    'https://requestotp-m7syoovdsa-uc.a.run.app',
    VERIFY_URL: 'https://verifyotp-m7syoovdsa-uc.a.run.app',
    DELETE_URL: 'https://deleteaccount-m7syoovdsa-uc.a.run.app',
    fb: { apiKey:'AIzaSyDWFYrzHvaNnRZERbN8jIuAzkY85daFJXU', authDomain:'xpizza-delivery.firebaseapp.com',
          databaseURL:'https://xpizza-delivery-default-rtdb.firebaseio.com', projectId:'xpizza-delivery',
          messagingSenderId:'185867271616', appId:'1:185867271616:web:84bb37552b40c1d517dc25' },
    MARKER: 'xpizza_acct',                    // localStorage key (La Musa: 'lamusa_acct')
  };

  // Lazy Firebase — imported on first use only. Returns { auth, db-helpers } cached after first load.
  let _fb = null;
  async function ensureFirebase() {
    if (_fb) return _fb;
    const V = 'https://www.gstatic.com/firebasejs/10.12.2';
    const [{ initializeApp }, authMod, dbMod] = await Promise.all([
      import(`${V}/firebase-app.js`),
      import(`${V}/firebase-auth.js`),
      import(`${V}/firebase-database.js`),
    ]);
    const app = initializeApp(CONFIG.fb);
    const auth = authMod.getAuth(app);
    await authMod.setPersistence(auth, authMod.browserLocalPersistence);
    _fb = { app, auth, authMod, db: dbMod.getDatabase(app), dbMod };
    return _fb;
  }

  const $ = (id) => document.getElementById(id);
  const marker = () => { try { return JSON.parse(localStorage.getItem(CONFIG.MARKER) || 'null'); } catch (_) { return null; } };
  const PERSON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.2" r="3.7"/><path d="M5.5 19.5c0-3.5 2.9-5.6 6.5-5.6s6.5 2.1 6.5 5.6"/></svg>';
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // Chip CSS — seamless soft-avatar treatment ported VERBATIM from the locked mockup's .chip/.av/.nm/.cv
  // (docs/superpowers/mockups/xpizza-autofill-mockup.html): NO pill border/background/shadow, a
  // borderless soft avatar disc + name + caret, hover=opacity only. Injected once, purely local
  // DOM/CSS — no network, safe for the guest fast-path.
  function injectChipStyles() {
    if ($('acct-chip-styles')) return;
    const st = document.createElement('style');
    st.id = 'acct-chip-styles';
    st.textContent = `
.header{position:relative}
.acct-chip-mount{position:absolute;top:14px;right:14px;z-index:2;display:flex}
.acct-chip{display:flex;align-items:center;gap:9px;background:transparent;border:none;border-radius:999px;padding:5px 3px;cursor:pointer;font-family:inherit;line-height:1;transition:opacity .15s}
.acct-chip:hover{opacity:.66}
.acct-chip .acct-av{width:28px;height:28px;border-radius:50%;background:#F0E8DA;color:#2A231C;display:flex;align-items:center;justify-content:center;flex:none}
.acct-chip--out .acct-av{background:#F0E8DA;color:#2A231C}
.acct-chip .acct-nm{font-size:13.5px;font-weight:650;letter-spacing:-.01em;color:#17130F}
.acct-chip .acct-cv{color:#B3A594;font-size:10px;margin-left:-1px}
`;
    document.head.appendChild(st);
  }

  function renderChip() {
    injectChipStyles();
    const el = $('acct-chip'); if (!el) return;
    const m = marker();
    if (m && m.name) {
      el.innerHTML = `<button class="acct-chip" type="button" aria-label="Mi cuenta">
        <span class="acct-av">${PERSON_SVG}</span><span class="acct-nm">${escapeHtml(firstName(m.name))}</span><span class="acct-cv">▾</span></button>`;
      el.querySelector('button').onclick = openAccountSheet;      // defined Task 6
    } else {
      el.innerHTML = `<button class="acct-chip acct-chip--out" type="button" aria-label="Entrar a mi cuenta">
        <span class="acct-av">${PERSON_SVG}</span><span class="acct-nm">Entrar</span></button>`;
      el.querySelector('button').onclick = openLoginSheet;        // defined Task 3
    }
  }
  document.addEventListener('DOMContentLoaded', renderChip);

  // ── Login / account overlay — built + inserted into <body> lazily, once, on first open.
  // Markup ported from the locked mockups (xpizza-login-mockup.html / xpizza-account-mockup.html),
  // classes prefixed `acct-` to avoid any collision with the host form's CSS. No SDK load here.
  let _overlayBuilt = false;
  let _loginPhone = '';   // full E.164-ish phone captured phone-pane → otp/name panes (closure state)

  function injectSheetStyles() {
    if ($('acct-sheet-styles')) return;
    const st = document.createElement('style');
    st.id = 'acct-sheet-styles';
    st.textContent = `
.acct-overlay{position:fixed;inset:0;z-index:1000;display:none;align-items:flex-end;justify-content:center;background:rgba(23,19,15,.46)}
.acct-overlay.acct-open{display:flex}
@media (min-width:520px){ .acct-overlay{align-items:center} }
.acct-sheet{width:100%;max-width:420px;max-height:92vh;background:#FFFDFA;border-radius:22px 22px 0 0;box-shadow:0 -20px 60px -20px rgba(40,28,12,.5);overflow:hidden;display:flex;flex-direction:column;font-family:inherit;animation:acct-up .28s cubic-bezier(.2,.7,.2,1);transition:transform .16s ease-out}
@media (min-width:520px){ .acct-sheet{border-radius:22px;max-height:88vh} }
@keyframes acct-up{from{transform:translateY(24px);opacity:0}to{transform:none;opacity:1}}
.acct-topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 18px 8px;flex:none}
.acct-iconbtn{width:34px;height:34px;border-radius:50%;border:none;background:transparent;color:#17130F;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;font-family:inherit}
.acct-iconbtn:hover{background:#F4EEE4}
.acct-mark{font-weight:800;font-size:17px;letter-spacing:-.03em;color:#17130F}
.acct-mark .acct-dot{color:${CONFIG.accent}}
.acct-body{flex:1;overflow:auto;padding:6px 26px 26px}
.acct-pane{display:none;flex-direction:column}
.acct-pane.acct-on{display:flex}
.acct-h1{font-size:26px;line-height:1.12;letter-spacing:-.02em;font-weight:800;color:#17130F;margin:8px 0 0}
.acct-sub{color:#8C7B6E;font-size:14.5px;line-height:1.5;margin:10px 0 0;max-width:32ch}
.acct-mlabel{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#B3A594;margin:22px 0 9px}
.acct-phone-row{display:flex;gap:9px}
.acct-cc{flex:none;display:flex;align-items:center;gap:7px;height:52px;padding:0 14px;border:1.5px solid #E2D8C8;border-radius:14px;background:#fff;font-size:16px;font-weight:650;color:#17130F;font-family:inherit}
.acct-inp{flex:1;min-width:0;height:52px;padding:0 15px;border:1.5px solid #E2D8C8;border-radius:14px;background:#fff;font-size:17px;font-weight:550;color:#17130F;outline:none;font-family:inherit}
.acct-inp::placeholder{color:#B3A594;font-weight:450}
.acct-inp:focus{border-color:#17130F}
/* the name-capture field (post-verify pane) is squared to the host FORM's own field radius (8px)
   rather than the sheet's pill radius — it sits right before the order form's own "Tus datos"
   step and should read as the same field language. */
#acct-name-inp{border-radius:8px}
.acct-cta{width:100%;height:52px;border:none;border-radius:15px;background:#17130F;color:#fff;font-size:16px;font-weight:700;letter-spacing:.01em;cursor:pointer;font-family:inherit;transition:background .15s;margin-top:20px}
.acct-cta:hover{background:#2A231C}
.acct-cta[disabled]{background:#E7DFD3;color:#B3A594;cursor:not-allowed}
.acct-fine{color:#B3A594;font-size:12px;line-height:1.5;text-align:center;margin-top:14px}
.acct-guest{text-align:center;margin-top:16px}
.acct-guest button,.acct-linkbtn{background:none;border:none;font-family:inherit;font-size:14px;font-weight:650;color:#17130F;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.acct-otp{display:flex;gap:9px;justify-content:space-between;margin-top:22px}
.acct-otp input{width:100%;aspect-ratio:1/1.15;text-align:center;font-size:24px;font-weight:700;color:#17130F;border:1.5px solid #E2D8C8;border-radius:14px;background:#fff;outline:none;font-family:inherit}
.acct-otp input.acct-filled{border-color:#17130F}
.acct-otp input:focus{border-color:${CONFIG.accent}}
.acct-resend{margin-top:18px;font-size:13px;color:#8C7B6E}
.acct-resend button{background:none;border:none;font-family:inherit;font-size:13px;font-weight:700;color:#17130F;cursor:pointer;text-decoration:underline;text-underline-offset:2px;padding:0}
.acct-resend button[disabled]{color:#B3A594;text-decoration:none;cursor:default}
.acct-hey{font-size:24px;font-weight:800;letter-spacing:-.02em;color:#17130F;margin:6px 0 0}
.acct-heysub{color:#8C7B6E;font-size:14px;margin-top:6px}
.acct-rows{margin-top:22px;border-top:1px solid #EDE5D9}
.acct-row{display:flex;align-items:center;justify-content:space-between;padding:16px 2px;border-bottom:1px solid #EDE5D9}
.acct-row .acct-rl{display:flex;flex-direction:column;gap:2px}
.acct-row .acct-rt{font-size:15px;font-weight:650;color:#17130F}
.acct-row .acct-rd{font-size:12.5px;color:#B3A594}
.acct-row.acct-soon .acct-rt{color:#8C7B6E}
.acct-soon-tag{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${CONFIG.accent};background:#F3E7CC;padding:2px 7px;border-radius:5px}
.acct-signout{margin-top:22px;text-align:center}
.acct-signout button{background:none;border:none;font-family:inherit;font-size:14px;font-weight:650;color:#8C7B6E;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.acct-delete{margin-top:10px;text-align:center}
.acct-delete button{background:none;border:none;font-family:inherit;font-size:12.5px;font-weight:600;color:#B3A594;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.acct-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);background:#17130F;color:#fff;padding:12px 18px;border-radius:12px;font-size:13.5px;font-weight:600;opacity:0;pointer-events:none;transition:all .3s;z-index:1100}
.acct-toast.acct-show{opacity:1;transform:translateX(-50%) translateY(0)}
`;
    document.head.appendChild(st);
  }

  // Brand mark markup — CONFIG.brand is a developer-set constant (not user input); safe to interpolate.
  function brandMarkHtml() {
    const parts = String(CONFIG.brand).split('.');
    return parts.length > 1
      ? escapeHtml(parts[0]) + '<span class="acct-dot">.</span>' + escapeHtml(parts.slice(1).join('.'))
      : escapeHtml(CONFIG.brand);
  }

  function buildOverlay() {
    if (_overlayBuilt) return;
    injectSheetStyles();
    const wrap = document.createElement('div');
    wrap.id = 'acct-overlay';
    wrap.className = 'acct-overlay';
    wrap.innerHTML = `
<div class="acct-sheet" role="dialog" aria-modal="true" aria-label="Mi cuenta">
  <div class="acct-topbar">
    <button class="acct-iconbtn" id="acct-back" type="button" aria-label="Atrás" style="visibility:hidden">‹</button>
    <div class="acct-mark">${brandMarkHtml()}</div>
    <button class="acct-iconbtn" id="acct-close" type="button" aria-label="Cerrar">×</button>
  </div>
  <div class="acct-body">
    <section class="acct-pane acct-on" id="acct-pane-phone">
      <h1 class="acct-h1">Entrá a tu cuenta</h1>
      <p class="acct-sub">Guardá tus datos y pedí más rápido la próxima vez.</p>
      <div class="acct-mlabel">Teléfono</div>
      <div class="acct-phone-row">
        <button class="acct-cc" type="button" disabled>+504</button>
        <input class="acct-inp" id="acct-ph-inp" inputmode="numeric" placeholder="9795-9999" autocomplete="off">
      </div>
      <button class="acct-cta" id="acct-cont-btn" disabled type="button">Continuar</button>
      <p class="acct-fine">Te enviaremos un código de verificación por WhatsApp.</p>
      <div class="acct-guest"><button type="button" id="acct-guest-btn">Prefiero seguir como invitado</button></div>
    </section>

    <section class="acct-pane" id="acct-pane-otp">
      <h1 class="acct-h1">Ingresá el código</h1>
      <p class="acct-sub">Te lo enviamos por WhatsApp al <b id="acct-otp-phone"></b>.</p>
      <div class="acct-otp" id="acct-otp-boxes">
        <input inputmode="numeric" maxlength="1"><input inputmode="numeric" maxlength="1"><input inputmode="numeric" maxlength="1">
        <input inputmode="numeric" maxlength="1"><input inputmode="numeric" maxlength="1"><input inputmode="numeric" maxlength="1">
      </div>
      <div class="acct-resend" id="acct-resend"></div>
      <button class="acct-cta" id="acct-verify-btn" disabled type="button">Verificar</button>
      <p class="acct-fine" id="acct-otp-err" style="display:none;color:#B23B3B"></p>
    </section>

    <section class="acct-pane" id="acct-pane-name">
      <h1 class="acct-h1">¡Listo!</h1>
      <p class="acct-sub">Ya podés pedir más rápido la próxima vez.</p>
      <div class="acct-mlabel">Tu nombre</div>
      <input class="acct-inp" id="acct-name-inp" placeholder="¿Cómo te llamás?" style="width:100%" maxlength="80">
      <button class="acct-cta" id="acct-save-name-btn" disabled type="button">Guardar</button>
      <p class="acct-fine" id="acct-name-err" style="display:none"></p>
    </section>

    <section class="acct-pane" id="acct-pane-account">
      <!-- built by renderAccountPane() at open time (Task 6) -->
    </section>
  </div>
</div>`;
    document.body.appendChild(wrap);
    _overlayBuilt = true;
    wireOverlayEvents();
  }

  function showPane(name) {
    document.querySelectorAll('#acct-overlay .acct-pane').forEach((p) => p.classList.remove('acct-on'));
    const p = $('acct-pane-' + name); if (p) p.classList.add('acct-on');
    const back = $('acct-back'); if (back) back.style.visibility = (name === 'otp') ? 'visible' : 'hidden';
  }

  function openOverlay() {
    buildOverlay();
    $('acct-overlay').classList.add('acct-open');
    bindKeyboardInset();
  }
  function closeSheet() {
    const ov = $('acct-overlay'); if (ov) ov.classList.remove('acct-open');
    unbindKeyboardInset();
  }

  // ── Keyboard-safe sheet (Task B2) — on iOS Safari, focusing an input inside the fixed-position
  // bottom sheet can leave it (and its CTA) hidden under the on-screen keyboard: the sheet is
  // pinned to the layout viewport, which the keyboard doesn't shrink, only visualViewport does.
  // Lift the sheet by the covered amount so the focused field stays reachable. No-op wherever
  // visualViewport isn't supported (desktop / most Android) — those already reflow natively.
  let _vvBound = false;
  function applyKeyboardInset() {
    const sheet = document.querySelector('#acct-overlay .acct-sheet');
    const vv = window.visualViewport;
    if (!sheet || !vv) return;
    const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    sheet.style.transform = covered > 40 ? `translateY(-${covered}px)` : '';
    const active = document.activeElement;
    if (covered > 40 && active && sheet.contains(active) && typeof active.scrollIntoView === 'function') {
      active.scrollIntoView({ block: 'nearest' });
    }
  }
  function bindKeyboardInset() {
    if (_vvBound || !window.visualViewport) return;
    _vvBound = true;
    window.visualViewport.addEventListener('resize', applyKeyboardInset);
    window.visualViewport.addEventListener('scroll', applyKeyboardInset);
  }
  function unbindKeyboardInset() {
    const sheet = document.querySelector('#acct-overlay .acct-sheet');
    if (sheet) sheet.style.transform = '';
  }

  function openLoginSheet() {
    openOverlay();
    showPane('phone');
    const inp = $('acct-ph-inp');
    if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 80); }
    const cta = $('acct-cont-btn'); if (cta) cta.disabled = true;
  }

  function wireOverlayEvents() {
    $('acct-close').onclick = closeSheet;
    $('acct-guest-btn').onclick = closeSheet;    // guest flow untouched — just closes the sheet
    $('acct-back').onclick = () => showPane('phone');

    // Phone pane: digits-only NNNN-NNNN formatting, CTA enabled at 8 digits. CC is a static +504
    // for P0 (the login phone is almost always the local WhatsApp number; a US customer can still
    // order as guest) — the order form's PHONE_COUNTRIES dropdown is intentionally NOT reused here.
    const phInp = $('acct-ph-inp'), contBtn = $('acct-cont-btn');
    phInp.addEventListener('input', () => {
      const d = phInp.value.replace(/\D/g, '').slice(0, 8);
      phInp.value = d.length > 4 ? d.slice(0, 4) + '-' + d.slice(4) : d;
      contBtn.disabled = d.length !== 8;
    });
    contBtn.onclick = () => {
      const digits = phInp.value.replace(/\D/g, '');
      if (digits.length !== 8) return;
      contBtn.disabled = true;
      sendCode('+504' + digits);   // Task 4 — plain fetch, no SDK load here
    };
    $('acct-back').onclick = () => {
      showPane('phone');
      const d = phInp.value.replace(/\D/g, '');
      contBtn.disabled = d.length !== 8;   // restore the real enabled-state on back-nav
    };

    wireOtpBoxes();
    wireNamePane();
  }

  // 6-box OTP input: digits-only, auto-advance, backspace-back, Verificar enabled when all 6 filled.
  function wireOtpBoxes() {
    const boxes = Array.from(document.querySelectorAll('#acct-otp-boxes input'));
    const verifyBtn = $('acct-verify-btn');
    boxes.forEach((b, i) => {
      b.addEventListener('input', () => {
        b.value = b.value.replace(/\D/g, '').slice(0, 1);
        b.classList.toggle('acct-filled', !!b.value);
        if (b.value && i < boxes.length - 1) boxes[i + 1].focus();
        verifyBtn.disabled = boxes.some((x) => !x.value);
      });
      b.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !b.value && i > 0) boxes[i - 1].focus();
      });
    });
    verifyBtn.onclick = verifyCode;
  }

  function wireNamePane() {
    const inp = $('acct-name-inp'), btn = $('acct-save-name-btn');
    inp.addEventListener('input', () => { btn.disabled = !inp.value.trim(); });
    btn.onclick = async () => {
      btn.disabled = true;
      await saveName(inp.value);
      renderChip();
      closeSheet();
      // Mid-session login, new-user name capture (Tasks B4–B7) — see the analogous call in verifyCode().
      try { wrapPageHooks(); initDeliveryStep().catch(() => {}); } catch (_) {}
    };
  }

  // ── requestOtp (Continuar → send WhatsApp code) — plain fetch, NO Firebase SDK load here (H8).
  // The backend response is always {ok:true,cooldown:30} (uniform, no-enumeration design); we
  // advance to the OTP pane and start the resend countdown regardless of network hiccups.
  let _resendTimer = null;
  function startResendCountdown() {
    let t = 29;
    const el = $('acct-resend');
    function render() {
      if (!el) return;
      if (t <= 0) {
        clearInterval(_resendTimer);
        el.innerHTML = '';
        const label = document.createTextNode('¿No lo recibiste? ');
        const btn = document.createElement('button');
        btn.type = 'button'; btn.textContent = 'Reenviar código';
        btn.onclick = () => sendCode(_loginPhone);
        el.appendChild(label); el.appendChild(btn);
        return;
      }
      el.textContent = '¿No lo recibiste? Reenviar en 0:' + (t < 10 ? '0' : '') + t;
    }
    clearInterval(_resendTimer);
    render();
    _resendTimer = setInterval(() => { t--; render(); }, 1000);
  }

  async function sendCode(phone) {
    _loginPhone = phone;
    const otpPhoneEl = $('acct-otp-phone'); if (otpPhoneEl) otpPhoneEl.textContent = phone;   // textContent — no innerHTML sink
    try {
      await fetch(CONFIG.OTP_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, restaurant_id: CONFIG.restaurant_id }),
      });
    } catch (_) { /* uniform UX regardless — never reveal rate-limit/enumeration */ }
    showPane('otp');
    startResendCountdown();
    const boxes = document.querySelectorAll('#acct-otp-boxes input');
    boxes.forEach((b) => { b.value = ''; b.classList.remove('acct-filled'); });
    if (boxes[0]) setTimeout(() => boxes[0].focus(), 100);
  }

  // ── Toast (small transient message; no SDK involved) ──
  function toast(msg) {
    let el = $('acct-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'acct-toast';
      el.className = 'acct-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;   // textContent — no innerHTML sink
    el.classList.add('acct-show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('acct-show'), 1800);
  }

  // ── verifyOtp → signInWithCustomToken → persist marker → (new user) capture name ──
  async function verifyCode() {
    const boxes = Array.from(document.querySelectorAll('#acct-otp-boxes input'));
    const code = boxes.map((b) => b.value).join('');
    if (code.length !== 6) return;
    const verifyBtn = $('acct-verify-btn'); if (verifyBtn) verifyBtn.disabled = true;
    const errEl = $('acct-otp-err'); if (errEl) errEl.style.display = 'none';

    let data;
    try {
      const res = await fetch(CONFIG.VERIFY_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: _loginPhone, code }),
      });
      data = await res.json().catch(() => ({}));
    } catch (_) { data = { ok: false }; }

    if (!data || !data.ok || !data.token) {
      boxes.forEach((b) => { b.value = ''; b.classList.remove('acct-filled'); });
      if (boxes[0]) boxes[0].focus();
      if (errEl) { errEl.textContent = 'Código incorrecto o vencido'; errEl.style.display = 'block'; }   // generic — no specifics
      return;
    }

    // Success — NOW load Firebase (H8: only on a verified login) and mint the session.
    try {
      const { auth, authMod } = await ensureFirebase();
      await authMod.signInWithCustomToken(auth, data.token);
      localStorage.setItem(CONFIG.MARKER, JSON.stringify({
        uid: auth.currentUser.uid, name: data.name || '', phone: _loginPhone,
      }));
    } catch (_) {
      if (errEl) { errEl.textContent = 'No pudimos iniciar sesión. Intentá de nuevo.'; errEl.style.display = 'block'; }
      if (verifyBtn) verifyBtn.disabled = false;
      return;
    }

    if (data.is_new || !data.name) {
      showPane('name');
      const nameInp = $('acct-name-inp');
      if (nameInp) { nameInp.value = ''; setTimeout(() => nameInp.focus(), 80); }
      const saveBtn = $('acct-save-name-btn'); if (saveBtn) saveBtn.disabled = true;
    } else {
      renderChip();
      closeSheet();
      // Mid-session login (Tasks B4–B7): the marker-gated DOMContentLoaded init already ran (and
      // skipped, guest at load time) — re-run it now that marker() is truthy so the confirm card /
      // save-on-order toggle activate for THIS page load without requiring a reload.
      try { wrapPageHooks(); initDeliveryStep().catch(() => {}); } catch (_) {}
    }
  }

  // name ≤80 client-validated to match the RTDB rule's `.validate` (length <= 80) — a longer value
  // is REJECTED server-side; write failures never wedge the flow (the account already exists).
  async function saveName(rawName) {
    const name = String(rawName || '').trim().slice(0, 80);
    if (!name) return;
    try {
      const { auth, db, dbMod } = await ensureFirebase();
      await dbMod.update(dbMod.ref(db, 'user_profiles/' + auth.currentUser.uid), { name });
      const m = marker(); if (m) { m.name = name; localStorage.setItem(CONFIG.MARKER, JSON.stringify(m)); }
    } catch (_) {
      // account is already live (token minted); a failed name write must not wedge the flow
      toast('No pudimos guardar tu nombre, podés intentarlo luego');
    }
  }

  // ── Account sheet (logged-in) — name/phone (from marker, no SDK needed to display), Pronto rows
  // (Mis direcciones / Mis pedidos — P2/P3, disabled), sign-out, delete-account (H10).
  // name/phone are user-controlled (localStorage marker) — EVERY render uses textContent, never
  // interpolated into an innerHTML template string (XSS-safe by construction).
  function renderAccountPane() {
    const pane = $('acct-pane-account'); if (!pane) return;
    const m = marker() || {};
    pane.innerHTML = '';   // rebuilt from scratch each open — the static rows below carry no user values

    const hey = document.createElement('h1');
    hey.className = 'acct-hey';
    hey.textContent = 'Hola' + (m.name ? ', ' + firstName(m.name) : '');   // textContent — no innerHTML sink
    pane.appendChild(hey);

    const sub = document.createElement('p');
    sub.className = 'acct-heysub';
    sub.textContent = m.phone || '';   // textContent — no innerHTML sink
    pane.appendChild(sub);

    // Mis direcciones (Task B6) — real, populated from whatever _acctData we currently have (may be
    // stale/empty until openAccountSheet()'s background refresh below lands; never blocks the sheet).
    const addrSection = document.createElement('div');
    addrSection.id = 'acct-addr-section';
    addrSection.className = 'acct-sec';
    pane.appendChild(addrSection);
    renderAddressesSection();

    const rows = document.createElement('div');   // Mis pedidos stays Pronto (P3) — untouched
    rows.className = 'acct-rows';
    rows.innerHTML =   // static copy only — zero user values interpolated here
      '<div class="acct-row acct-soon"><div class="acct-rl"><span class="acct-rt">Mis pedidos</span>' +
      '<span class="acct-rd">Repetí un pedido anterior</span></div><span class="acct-soon-tag">Pronto</span></div>';
    pane.appendChild(rows);

    const disclosure = document.createElement('p');   // H9 — phone-account model disclosure
    disclosure.className = 'acct-fine';
    disclosure.textContent = 'Tu cuenta está ligada a tu número de WhatsApp.';
    pane.appendChild(disclosure);

    const signout = document.createElement('div');
    signout.className = 'acct-signout';
    const soBtn = document.createElement('button');
    soBtn.type = 'button'; soBtn.textContent = 'Cerrar sesión';
    soBtn.onclick = doSignOut;
    signout.appendChild(soBtn);
    pane.appendChild(signout);

    const del = document.createElement('div');
    del.className = 'acct-delete';
    const delBtn = document.createElement('button');
    delBtn.type = 'button'; delBtn.textContent = 'Eliminar mi cuenta';
    delBtn.onclick = doDeleteAccount;
    del.appendChild(delBtn);
    pane.appendChild(del);
  }

  async function openAccountSheet() {
    openOverlay();
    renderAccountPane();      // from the marker only — instant, no SDK wait, no stale-UI flash
    showPane('account');
    // Session robustness (Task 8): verify the marker's session is actually alive; if the Firebase
    // session is genuinely gone (e.g. IndexedDB cleared) self-heal to guest quietly, no crash.
    try {
      const { auth } = await ensureFirebase();
      await auth.authStateReady();
      if (!auth.currentUser) { heal(); return; }
      // Mis direcciones (Task B6) — refresh the address list live; fail-open, never blocks the
      // already-open sheet (which rendered instantly above from the marker alone).
      const snap = await accountSnapshot();
      if (snap) { _acctData = snap; renderAddressesSection(); }
    } catch (_) { /* fail-open — leave the marker as-is; sign-out/delete surface any real trouble */ }
  }

  async function doSignOut() {
    try {
      const { auth, authMod } = await ensureFirebase();
      await authMod.signOut(auth);
    } catch (_) { /* fail-open — clear local state regardless of SDK/network trouble */ }
    try { localStorage.removeItem(CONFIG.MARKER); } catch (_) {}
    renderChip();
    closeSheet();
    try { revertToGuestForm(); } catch (_) {}   // Tasks B4–B7: drop the confirm card back to raw fields
  }

  async function doDeleteAccount() {
    const ok = window.confirm('Esto borra tu cuenta y tus datos. No se puede deshacer.');
    if (!ok) return;
    try {
      const { auth, authMod } = await ensureFirebase();
      const idTok = await auth.currentUser.getIdToken();
      const res = await fetch(CONFIG.DELETE_URL, {
        method: 'POST',
        headers: { 'x-firebase-id-token': idTok },
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.ok) {
        try { await authMod.signOut(auth); } catch (_) {}
        try { localStorage.removeItem(CONFIG.MARKER); } catch (_) {}
        renderChip();
        closeSheet();
        try { revertToGuestForm(); } catch (_) {}   // Tasks B4–B7: drop the confirm card back to raw fields
        toast('Cuenta eliminada');
      } else {
        toast('No pudimos eliminar tu cuenta. Intentá de nuevo.');
      }
    } catch (_) {
      toast('No pudimos eliminar tu cuenta. Intentá de nuevo.');
    }
  }

  // ── Session robustness (Task 8) — self-heal a marker whose Firebase session is actually dead
  // (e.g. IndexedDB cleared) back to guest, quietly. Callers MUST have already awaited
  // auth.authStateReady() before concluding currentUser === null — never clear a valid marker
  // just because persistence restoration hasn't finished yet (customerIdToken above does this).
  function heal() {
    try { localStorage.removeItem(CONFIG.MARKER); } catch (_) {}
    renderChip();
  }
  // Invariant: the marker is the ONLY thing gating the guest fast-path — ensureFirebase() is never
  // called from renderChip() or DOMContentLoaded; only from a login tap, a verified sign-in, an
  // opened account sheet's sign-out/delete, or a logged-in order's customerIdToken().

  // ── Order attribution — fail-open token helper (Task 7). Guest with no marker returns null
  // INSTANTLY with zero SDK load, zero network — the byte-identical guest guarantee lives here.
  async function customerIdToken() {
    if (!marker()) return null;                        // GUEST — no SDK, no header, byte-identical
    try {
      const { auth } = await ensureFirebase();
      await auth.authStateReady();                      // v10: resolves once persistence restore completes
      if (auth.currentUser) return await auth.currentUser.getIdToken();
      heal();                                           // marker present but session truly gone → self-heal to guest (Task 8)
      return null;
    } catch (_) { return null; }                        // fail-open — never block the order
  }

  // ── Address data layer (Task B3) — fail-open, timeboxed account read + atomic address CRUD.
  // Guest fast-path is preserved: accountSnapshot() returns null INSTANTLY (no SDK, no network)
  // when there's no marker, exactly like customerIdToken() above.
  async function accountSnapshot() {
    if (!marker()) return null;                                    // guest — no SDK, no read
    try {
      return await Promise.race([
        (async () => {
          const { auth, db, dbMod } = await ensureFirebase();
          await auth.authStateReady();
          if (!auth.currentUser) { heal(); return null; }
          const snap = await dbMod.get(dbMod.ref(db, 'user_profiles/' + auth.currentUser.uid));
          return snap.exists() ? snap.val() : null;
        })(),
        new Promise((r) => setTimeout(() => r(null), 1500)),        // deadline → treat as no-account
      ]);
    } catch (_) { return null; }
  }

  // $addrId rule: /^a_[a-f0-9]{6,32}$/ — 'a_' + 12 lowercase-hex chars comfortably satisfies it.
  function newAddrId() {
    const bytes = new Uint8Array(6);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return 'a_' + hex;
  }

  const MAX_ADDRESSES = 10;   // client-side cap (R6) — RTDB rules have no numChildren() validator

  // saveAddress({addrId?, label, detected, details, lat, lng, makeDefault}) — ONE atomic multi-path
  // update() so the referential `.write` invariant (default_address must point at an existing
  // address) is always satisfied mid-write. Passing an existing addrId always EDITS it (never
  // counts against the ≤10 cap); omitting addrId CREATES a new one and is refused past the cap.
  // Never throws; never blocks a caller — every caller must treat a false return as "didn't save,
  // keep going".
  async function saveAddress({ addrId, label, detected, details, lat, lng, makeDefault } = {}) {
    try {
      const { auth, db, dbMod } = await ensureFirebase();
      await auth.authStateReady();
      const user = auth.currentUser;
      if (!user) { heal(); return { ok: false, reason: 'no-session' }; }

      const isNew = !addrId;
      if (isNew) {
        const profSnap = await dbMod.get(dbMod.ref(db, 'user_profiles/' + user.uid + '/addresses'));
        const existing = profSnap.exists() ? profSnap.val() : {};
        if (Object.keys(existing || {}).length >= MAX_ADDRESSES) {
          return { ok: false, reason: 'cap', message: 'Ya guardaste el máximo de 10 direcciones. Editá o borrá una para agregar otra.' };
        }
        addrId = newAddrId();
      }

      const now = Date.now();
      const updates = {};
      updates['user_profiles/' + user.uid + '/addresses/' + addrId] = {
        label: String(label || '').trim().slice(0, 40) || 'Dirección',
        detected: String(detected || '').trim().slice(0, 200),
        details: String(details || '').trim().slice(0, 200),
        lat, lng,
        created_at: now,
        last_used_at: now,
      };
      if (makeDefault) updates['user_profiles/' + user.uid + '/default_address'] = addrId;
      await dbMod.update(dbMod.ref(db), updates);
      return { ok: true, addrId };
    } catch (_) {
      return { ok: false, reason: 'error' };
    }
  }

  // deleteAddress(addrId) — clears the node and, if it was the default, nulls default_address in
  // the SAME atomic update (otherwise the referential `.write` clause would deny a write that left
  // default_address pointing at a now-missing address).
  async function deleteAddress(addrId) {
    if (!addrId) return { ok: false };
    try {
      const { auth, db, dbMod } = await ensureFirebase();
      await auth.authStateReady();
      const user = auth.currentUser;
      if (!user) { heal(); return { ok: false, reason: 'no-session' }; }

      const defSnap = await dbMod.get(dbMod.ref(db, 'user_profiles/' + user.uid + '/default_address'));
      const wasDefault = defSnap.exists() && defSnap.val() === addrId;

      const updates = {};
      updates['user_profiles/' + user.uid + '/addresses/' + addrId] = null;
      if (wasDefault) updates['user_profiles/' + user.uid + '/default_address'] = null;
      await dbMod.update(dbMod.ref(db), updates);
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: 'error' };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Tasks B4–B7 — the "Entregar a" confirm card, Cambiar/label-picker edit flow, saved-addresses
  // management in Mi cuenta, and opt-in save-on-order. ALL of this is gated on marker() being
  // truthy (a logged-in customer) — a guest never runs a byte of this section (see the
  // DOMContentLoaded gate at the bottom). Every DOM/network call is try/catch-guarded; nothing
  // here may block the order form's own submit/validation logic, which is left untouched.
  // ══════════════════════════════════════════════════════════════════════════════════════════

  // Monochrome line-icons only (no emoji) — ported from the locked mockup's label chips + checks.
  const ICON_HOUSE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/></svg>';
  const ICON_WORK = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7.5" width="18" height="12.5" rx="2"/><path d="M8.5 7.5V6a2 2 0 012-2h3a2 2 0 012 2v1.5"/></svg>';
  const ICON_TAG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4L13.4 20.6a2 2 0 01-2.8 0l-6.2-6.2a2 2 0 01-.6-1.4V5a2 2 0 012-2h7.9a2 2 0 011.4.6l6.2 6.2a2 2 0 010 2.6z"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/></svg>';
  const ICON_PIN_SM = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7zm0 9.5A2.5 2.5 0 1112 6.5a2.5 2.5 0 010 5z"/></svg>';
  const ICON_CHECK_SM = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  const ICON_CHECK_BIG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

  function injectDeliverStyles() {
    if ($('acct-deliver-styles')) return;
    const st = document.createElement('style');
    st.id = 'acct-deliver-styles';
    st.textContent = `
.acct-eyebrow{font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase;color:#B3A594;margin:0 0 10px}
.acct-deliver{border:1px solid #E2D8C8;border-radius:20px;overflow:hidden;background:#fff;box-shadow:0 12px 30px -18px rgba(40,28,12,.3);font-family:inherit;margin-bottom:4px}
.acct-map{height:84px;position:relative;overflow:hidden;background:radial-gradient(120% 140% at 50% -40%, #EFE7DA 0%, #E4DAC7 100%);border-bottom:1px solid #EDE5D9}
.acct-map i{position:absolute;background:#F7F2E8;box-shadow:0 0 0 1px #E7DDCB}
.acct-h1{left:0;right:0;top:26px;height:9px;transform:rotate(-4deg)}
.acct-h2{left:0;right:0;top:56px;height:12px;transform:rotate(-4deg)}
.acct-v1{top:0;bottom:0;left:76px;width:10px;transform:rotate(6deg)}
.acct-v2{top:0;bottom:0;left:182px;width:8px;transform:rotate(6deg)}
.acct-blk{position:absolute;background:#EAE0CE;border-radius:2px;opacity:.7}
.acct-pin{position:absolute;left:calc(50% - 11px);top:18px;width:22px;height:22px;z-index:2;filter:drop-shadow(0 5px 4px rgba(40,28,12,.28))}
.acct-pindot{position:absolute;left:calc(50% - 3px);top:38px;width:7px;height:3px;border-radius:50%;background:rgba(40,28,12,.28);filter:blur(1px)}
.acct-drow{display:flex;align-items:flex-start;gap:12px;padding:14px 15px 4px}
.acct-avatar{width:38px;height:38px;border-radius:50%;background:#F0E8DA;flex:none;display:flex;align-items:center;justify-content:center;color:#2A231C;margin-top:1px}
.acct-who{flex:1;min-width:0}
.acct-nm2{font-size:16px;font-weight:750;letter-spacing:-.02em;line-height:1.15;color:#17130F}
.acct-ph2{font-size:13px;color:#8C7B6E;margin-top:3px;font-variant-numeric:tabular-nums}
.acct-change{flex:none;background:none;border:none;font-family:inherit;font-size:13px;font-weight:700;color:#17130F;text-decoration:underline;text-underline-offset:3px;cursor:pointer;padding:6px 2px;margin-top:2px}
.acct-addr{display:flex;gap:10px;padding:11px 15px 15px;margin-top:6px;border-top:1px dashed #E2D8C8}
.acct-lbl{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:${CONFIG.accent}}
.acct-al{flex:1;min-width:0}
.acct-aname{font-size:14px;font-weight:700;letter-spacing:-.01em;color:#17130F;margin-top:5px}
.acct-aline{font-size:12.5px;color:#8C7B6E;line-height:1.45;margin-top:2px}
.acct-saved{display:inline-flex;align-items:center;gap:5px;margin-top:10px;font-size:11px;font-weight:700;color:#2A6A42;background:#E7F0E9;border-radius:999px;padding:4px 10px}
.acct-lchips{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.acct-lchip{display:inline-flex;align-items:center;gap:7px;border:1.5px solid #E2D8C8;background:#fff;border-radius:12px;padding:9px 13px;font-family:inherit;font-size:13.5px;font-weight:650;color:#8C7B6E;cursor:pointer;transition:.14s;letter-spacing:-.01em}
.acct-lchip svg{color:#B3A594;transition:color .14s}
.acct-lchip:hover{border-color:#CFC2B1}
.acct-lchip.acct-on{border-color:#17130F;color:#17130F;background:#FBF6EE}
.acct-lchip.acct-on svg{color:${CONFIG.accent}}
.acct-field-hint{font-size:11.5px;color:#B3A594;margin:7px 2px 0;letter-spacing:.01em}
.acct-label-custom-inp{width:100%;padding:14px;border:1.5px solid #E2D8C8;border-radius:8px;font-size:15px;font-family:inherit;outline:none;color:#17130F}
.acct-label-custom-inp:focus{border-color:#17130F}
.acct-save-addr-btn{width:100%;padding:14px;background:#17130F;color:#fff;border:none;border-radius:8px;font-family:inherit;font-size:15px;font-weight:700;cursor:pointer;margin-top:14px;display:flex;align-items:center;justify-content:center;gap:8px}
.acct-save-addr-btn:hover{background:#2A231C}
.acct-save-addr-btn[disabled]{background:#E7DFD3;color:#B3A594;cursor:not-allowed}
.acct-cancel-edit{width:100%;padding:10px;background:none;border:none;font-family:inherit;font-size:13.5px;font-weight:650;color:#8C7B6E;text-decoration:underline;text-underline-offset:3px;cursor:pointer;margin-top:2px}
.acct-savetoggle{display:flex;align-items:center;gap:9px;margin:14px 2px 0;font-size:13px;color:#5b4f41;cursor:pointer;user-select:none;font-family:inherit}
.acct-savetoggle input{width:auto;margin:0}
.acct-sec{margin-top:24px}
.acct-sechd{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:11px}
.acct-sectitle{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#B3A594}
.acct-addlink{background:none;border:none;font-family:inherit;font-size:13px;font-weight:700;color:#17130F;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.acct-acard{display:flex;align-items:center;gap:11px;border:1px solid #EDE5D9;border-radius:15px;padding:13px 14px;margin-bottom:9px;background:#fff;cursor:pointer;transition:border-color .12s}
.acct-acard:hover{border-color:#E2D8C8}
.acct-acard .acct-dotmark{width:8px;height:8px;border-radius:50%;background:${CONFIG.accent};flex:none}
.acct-acard.acct-on2{border-color:#17130F;box-shadow:0 0 0 3px #F3E7CC}
.acct-acard .acct-al2{flex:1;min-width:0}
.acct-acard .acct-aname2{font-size:14.5px;font-weight:700;color:#17130F}
.acct-acard .acct-aline2{font-size:12px;color:#8C7B6E;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acct-acard .acct-chk{color:${CONFIG.accent};flex:none;display:flex}
.acct-acard .acct-del{color:#B3A594;font-size:19px;padding:2px 5px;flex:none;line-height:1}
.acct-acard .acct-del:hover{color:#B23B3B}
`;
    document.head.appendChild(st);
  }

  function setVal(id, val) { const el = $(id); if (el) el.value = (val == null ? '' : val); }

  // pageOrderType()/pageLatLng() read the HOST FORM's own top-level `let` globals (orderType/lat/lng
  // — declared in index.html's main inline <script>, which runs BEFORE this file's DOMContentLoaded
  // callbacks fire). Classic <script> tags on the same page share one top-level lexical scope, so a
  // bare identifier reference here resolves to the live page variable — no `window.` prefix (`let`
  // doesn't attach to window). try/catch-guarded so a missing/renamed host global fails open.
  function pageOrderType() {
    try { return (typeof orderType !== 'undefined') ? orderType : 'delivery'; } catch (_) { return 'delivery'; }
  }
  function pageLatLng() {
    try { return { lat: (typeof lat !== 'undefined') ? lat : null, lng: (typeof lng !== 'undefined') ? lng : null }; }
    catch (_) { return { lat: null, lng: null }; }
  }
  // Place a pin on the host form's live map if it's already initialized; otherwise stash it via the
  // form's own __restorePos mechanism for the next initMap() run (identical to the cancelled-
  // payment-retry path already in index.html).
  function placeAccountPin(la, ln) {
    if (la == null || ln == null) return;
    try {
      if (typeof gmap !== 'undefined' && gmap && typeof placePin === 'function') { placePin(la, ln, false); return; }
    } catch (_) { /* fall through to __restorePos */ }
    __restorePos = { lat: la, lng: ln };
  }

  function addrSectionEl() {
    try { return document.querySelector('#address-detected')?.closest('.section') || null; }
    catch (_) { return null; }
  }

  function pickDefaultAddress(snap) {
    if (!snap || !snap.addresses) return null;
    const ids = Object.keys(snap.addresses);
    if (!ids.length) return null;
    const id = (snap.default_address && snap.addresses[snap.default_address]) ? snap.default_address : ids[0];
    const a = snap.addresses[id];
    if (!a || typeof a.lat !== 'number' || typeof a.lng !== 'number' || !a.detected || typeof a.details !== 'string' || a.details.trim().length < 3) return null;   // needs a usable reference (delivery requires details>=3); else fall back to the fillable form, never block behind a hidden field
    return Object.assign({ id }, a);
  }

  // ── Module state for the delivery step / edit flow (Tasks B4–B7). Reset on sign-out. ──
  let _acctData = null;          // last accountSnapshot() profile value, or null
  let _acctAddrId = null;        // addrId currently backing the confirm card / this order
  let _acctEditMode = false;     // true while "Cambiar" / "+ Agregar" edit surface is open
  let _acctEditIsNew = false;    // true when the open edit session targets a brand-new address
  let _acctEditLabel = '';       // chip-picked (or custom) label for the address being edited
  let _acctCardActive = false;   // true once the confirm card has replaced the raw Tus-datos fields
  let _acctAddrUnsaved = false;  // true when the address populating the order isn't a persisted one
  let _acctSaveToggleOn = true;  // B7 "Guardar esta dirección" toggle state (default-checked)

  // ── Task B4: the "Entregar a" confirm card + autofill ──
  async function initDeliveryStep() {
    if (!$('acct-deliver')) return;               // host form has no mount — never touch anything
    const snap = await accountSnapshot();          // fail-open, timeboxed ~1.5s internally
    if (!snap) { refreshSaveToggle(); return; }     // no account / miss/timeout → normal empty form
    _acctData = snap;
    if (pageOrderType() !== 'delivery') { refreshSaveToggle(); return; }   // pickup — leave raw fields
    const addr = pickDefaultAddress(snap);
    if (!addr) { refreshSaveToggle(); return; }     // account with no usable saved address — normal form
    renderConfirmCard(snap, addr);
  }

  function renderConfirmCard(snap, addr) {
    injectDeliverStyles();
    const mount = $('acct-deliver'); if (!mount) return;
    const rawWrap = $('raw-name-phone');
    const addrSection = addrSectionEl();
    const m = marker() || {};
    const name = (snap && snap.name) || m.name || '';
    const phone = (snap && snap.phone) || m.phone || '';

    mount.innerHTML = `
<div class="acct-eyebrow">Entregar a</div>
<div class="acct-deliver">
  <div class="acct-map">
    <i class="acct-h1"></i><i class="acct-h2"></i><i class="acct-v1"></i><i class="acct-v2"></i>
    <span class="acct-blk" style="left:16px;top:6px;width:54px;height:19px"></span>
    <span class="acct-blk" style="left:108px;top:7px;width:66px;height:17px"></span>
    <span class="acct-blk" style="left:20px;top:44px;width:48px;height:26px"></span>
    <div class="acct-pindot"></div>
    <svg class="acct-pin" viewBox="0 0 24 24" fill="${CONFIG.accent}" stroke="#fff" stroke-width="1.4"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/><circle cx="12" cy="9" r="2.6" fill="#fff" stroke="none"/></svg>
  </div>
  <div class="acct-drow">
    <span class="acct-avatar">${PERSON_SVG}</span>
    <div class="acct-who">
      <div class="acct-nm2">${escapeHtml(name)}</div>
      <div class="acct-ph2">${escapeHtml(phone)}</div>
    </div>
    <button class="acct-change" type="button" id="acct-change-btn">Cambiar</button>
  </div>
  <div class="acct-addr">
    <div class="acct-al">
      <div class="acct-lbl">${ICON_PIN_SM} ${escapeHtml(addr.label || 'Guardado')}</div>
      <div class="acct-aname">${escapeHtml((addr.detected || '').split(',')[0] || addr.detected || '')}</div>
      <div class="acct-aline">${escapeHtml(addr.details || addr.detected || '')}</div>
      <span class="acct-saved">${ICON_CHECK_SM} Guardado en tu cuenta</span>
    </div>
  </div>
</div>`;
    if (rawWrap) rawWrap.style.display = 'none';
    if (addrSection) addrSection.style.display = 'none';
    const changeBtn = $('acct-change-btn'); if (changeBtn) changeBtn.onclick = () => enterEditMode(false);

    // Populate the EXISTING order fields — the unchanged submit/validation logic just works.
    setVal('cname', name);
    if (typeof window.__applyPhoneRaw === 'function') window.__applyPhoneRaw(phone); else setVal('cphone', phone);
    setVal('address-detected', addr.detected);
    setVal('address-details', addr.details);
    placeAccountPin(addr.lat, addr.lng);   // places the pin NOW if the map is already up, else sets __restorePos for the next initMap (matches selectSavedAddress)

    _acctAddrId = addr.id;
    _acctEditIsNew = false;
    _acctAddrUnsaved = false;
    _acctCardActive = true;
    refreshSaveToggle();
  }

  // ── Task B5: Cambiar — reveal raw fields + label picker; re-pin via the form's own map/geocode ──
  function enterEditMode(isNew) {
    _acctEditMode = true;
    _acctEditIsNew = !!isNew;
    _acctEditLabel = isNew ? '' : ((_acctData && _acctAddrId && _acctData.addresses && _acctData.addresses[_acctAddrId] && _acctData.addresses[_acctAddrId].label) || '');

    const mount = $('acct-deliver'); if (mount) mount.innerHTML = '';
    const rawWrap = $('raw-name-phone'); if (rawWrap) rawWrap.style.display = '';
    const addrSection = addrSectionEl();
    if (addrSection) {
      if (pageOrderType() === 'delivery') addrSection.style.display = '';
      injectLabelPicker(addrSection);
    }
    if (isNew) {
      setVal('address-detected', '');
      setVal('address-details', '');
      __restorePos = null;   // fresh pin — geolocate/let the customer drop it themselves
    }
    refreshSaveToggle();
  }

  function exitEditMode() {
    _acctEditMode = false;
    const picker = $('acct-label-picker'); if (picker) picker.remove();
  }

  function injectDeliverStylesOnce() { injectDeliverStyles(); }   // alias for readability at call sites

  function injectLabelPicker(addrSection) {
    injectDeliverStylesOnce();
    if (!addrSection || $('acct-label-picker')) return;
    const wrap = document.createElement('div');
    wrap.id = 'acct-label-picker';
    wrap.className = 'field-group';
    const knownLabel = (_acctEditLabel === 'Casa' || _acctEditLabel === 'Trabajo') ? _acctEditLabel : '';
    wrap.innerHTML = `
<label class="field-label">Guardar como</label>
<div class="acct-lchips">
  <button type="button" class="acct-lchip${knownLabel === 'Casa' ? ' acct-on' : ''}" data-label="Casa">${ICON_HOUSE}Casa</button>
  <button type="button" class="acct-lchip${knownLabel === 'Trabajo' ? ' acct-on' : ''}" data-label="Trabajo">${ICON_WORK}Trabajo</button>
  <button type="button" class="acct-lchip${knownLabel ? '' : ' acct-on'}" data-label="">${ICON_TAG}Otra</button>
</div>
<input type="text" id="acct-label-custom" class="acct-label-custom-inp" placeholder="Ponle un nombre… (ej: Casa de mis papás)" maxlength="40" style="margin-top:10px"/>
<p class="acct-field-hint">Le ponés el nombre que quieras. La próxima vez la elegís en un toque.</p>
<button type="button" class="acct-save-addr-btn" id="acct-save-addr-btn">${ICON_CHECK_BIG} Guardar dirección</button>
<button type="button" class="acct-cancel-edit" id="acct-cancel-edit-btn">‹ Cancelar</button>`;
    addrSection.appendChild(wrap);

    wrap.querySelectorAll('.acct-lchip').forEach((chip) => {
      chip.onclick = () => {
        wrap.querySelectorAll('.acct-lchip').forEach((c) => c.classList.remove('acct-on'));
        chip.classList.add('acct-on');
        const custom = $('acct-label-custom');
        const val = chip.getAttribute('data-label');
        if (val) { _acctEditLabel = val; if (custom) custom.value = val; }
        else { _acctEditLabel = (custom && custom.value) || ''; if (custom) { custom.value = ''; custom.placeholder = 'Ponle un nombre… (ej: Casa de mis papás)'; custom.focus(); } }
      };
    });
    const customInp = $('acct-label-custom');
    if (customInp) {
      customInp.value = knownLabel || _acctEditLabel || '';
      customInp.addEventListener('input', () => { _acctEditLabel = customInp.value; });
    }
    const saveBtn = $('acct-save-addr-btn'); if (saveBtn) saveBtn.onclick = saveEditedAddress;
    const cancelBtn = $('acct-cancel-edit-btn'); if (cancelBtn) cancelBtn.onclick = cancelEdit;
  }

  async function saveEditedAddress() {
    const btn = $('acct-save-addr-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }

    const nameVal = ($('cname') || {}).value || '';
    const detected = ($('address-detected') || {}).value || '';
    const details = ($('address-details') || {}).value || '';
    const { lat: curLat, lng: curLng } = pageLatLng();
    const label = (($('acct-label-custom') || {}).value || _acctEditLabel || '').trim() || 'Otra';

    // A saved address MUST carry a usable reference: the confirm card HIDES #address-details, and delivery
    // requires it (>=3 chars), so saving with empty/short details would later block checkout behind a hidden
    // field. Require it here (matches processPayment's delivery rule); keep the customer in edit mode to fix.
    if (details.trim().length < 3) {
      const df = $('address-details'); if (df) df.focus();
      toast('Agregá una referencia — portón, color, piso…');
      if (btn) { btn.disabled = false; btn.innerHTML = ICON_CHECK_BIG + ' Guardar dirección'; }
      return;
    }

    // Name edit → profile `name` write ONLY — NEVER phone (phone is immutable; a per-order contact
    // edit goes to #cphone→createOrder only).
    try {
      if (_acctData && nameVal.trim() && nameVal.trim() !== (_acctData.name || '')) {
        const { auth, db, dbMod } = await ensureFirebase();
        await auth.authStateReady();
        if (auth.currentUser) {
          const trimmed = nameVal.trim().slice(0, 80);
          await dbMod.update(dbMod.ref(db, 'user_profiles/' + auth.currentUser.uid), { name: trimmed });
          _acctData.name = trimmed;
          const m = marker(); if (m) { m.name = trimmed; try { localStorage.setItem(CONFIG.MARKER, JSON.stringify(m)); } catch (_) {} }
          renderChip();
        }
      }
    } catch (_) { /* non-blocking — the address save below still proceeds */ }

    const addrIdForSave = _acctEditIsNew ? undefined : _acctAddrId;
    const res = (curLat != null && curLng != null && detected)
      ? await saveAddress({ addrId: addrIdForSave, label, detected, details, lat: curLat, lng: curLng, makeDefault: true })
      : { ok: false, reason: 'no-pin' };

    if (res.ok) {
      if (!_acctData) _acctData = {};
      if (!_acctData.addresses) _acctData.addresses = {};
      _acctData.addresses[res.addrId] = { label, detected, details, lat: curLat, lng: curLng };
      _acctData.default_address = res.addrId;
      _acctAddrId = res.addrId;
      exitEditMode();
      renderConfirmCard(_acctData, Object.assign({ id: res.addrId }, _acctData.addresses[res.addrId]));
      toast('Dirección guardada');
    } else if (res.reason === 'cap') {
      toast(res.message || 'Ya guardaste el máximo de 10 direcciones.');
      if (btn) { btn.disabled = false; btn.innerHTML = ICON_CHECK_BIG + ' Guardar dirección'; }
    } else {
      // A failed save must never block the order — the customer still finishes this one with
      // whatever they typed; we just won't have it saved for next time.
      _acctAddrUnsaved = true;
      toast('No pudimos guardar la dirección, pero podés continuar con tu pedido.');
      exitEditMode();
      refreshSaveToggle();
    }
  }

  function cancelEdit() {
    exitEditMode();
    if (_acctData) {
      const addr = pickDefaultAddress(_acctData);
      if (addr) { renderConfirmCard(_acctData, addr); return; }
    }
    _acctCardActive = false;   // no saved address to fall back to — leave the raw fields as a guest would see them
    refreshSaveToggle();
  }

  // ── Task B7: subtle opt-in "Guardar esta dirección" toggle for an order that ISN'T already
  // riding a saved, unedited address (e.g. a logged-in customer's very first delivery order, or one
  // whose in-flow save attempt failed). Hidden while the B5 edit surface (with its own explicit
  // "Guardar dirección") is open — the two affordances are never shown at once.
  function refreshSaveToggle() {
    const addrSection = addrSectionEl();
    const existing = $('acct-save-toggle-wrap');
    const shouldShow = !!marker() && pageOrderType() === 'delivery' && !_acctEditMode && (!_acctCardActive || _acctAddrUnsaved);
    if (!shouldShow) { if (existing) existing.remove(); return; }
    if (existing || !addrSection) return;   // already showing (leave the customer's choice alone) — or no host section
    injectDeliverStylesOnce();
    const wrap = document.createElement('label');
    wrap.id = 'acct-save-toggle-wrap';
    wrap.className = 'acct-savetoggle';
    wrap.innerHTML = `<input type="checkbox" id="acct-save-toggle" checked/> Guardar esta dirección en mi cuenta`;
    addrSection.appendChild(wrap);
    _acctSaveToggleOn = true;
    const cb = $('acct-save-toggle');
    if (cb) cb.addEventListener('change', () => { _acctSaveToggleOn = cb.checked; });
  }

  // Called from index.html at the ONE point every confirmed-order path funnels through
  // (showSuccess() — cash-accepted, "already paid", and the online-payment-return "paid"/
  // "scheduled_paid" states all call it). Never awaited by the caller; never throws.
  async function onOrderConfirmed(order) {
    try {
      if (!order || order.order_type !== 'delivery') return;
      if (!marker()) return;                       // guest — never save (unreachable in practice, defense-in-depth)
      if (!_acctSaveToggleOn) return;               // dismissed — respect it
      if (_acctCardActive && !_acctAddrUnsaved) return;   // already a saved, unedited address — nothing new to persist
      const detected = order.address_detected, details = order.address_details;
      const la = order.lat, ln = order.lng;
      if (!detected || typeof la !== 'number' || typeof ln !== 'number') return;
      const label = (_acctEditLabel && _acctEditLabel.trim())
        || (_acctData && _acctAddrId && _acctData.addresses && _acctData.addresses[_acctAddrId] && _acctData.addresses[_acctAddrId].label)
        || 'Dirección';
      const res = await saveAddress({ addrId: _acctEditIsNew ? undefined : _acctAddrId, label, detected, details, lat: la, lng: ln, makeDefault: true });
      if (res && res.ok) { _acctAddrUnsaved = false; _acctAddrId = res.addrId; refreshSaveToggle(); }
    } catch (_) { /* never affects the order — it already succeeded */ }
  }

  // ── Task B6: Mis direcciones list in the account sheet — select / add / delete ──
  function renderAddressesSection() {
    injectDeliverStylesOnce();
    const sec = $('acct-addr-section'); if (!sec) return;
    const addrs = (_acctData && _acctData.addresses) || {};
    const ids = Object.keys(addrs);
    const defId = _acctData && _acctData.default_address;
    let rowsHtml;
    if (!ids.length) {
      rowsHtml = '<p class="acct-fine" style="text-align:left;margin:0 0 4px">Aún no tenés direcciones guardadas.</p>';
    } else {
      rowsHtml = ids.map((id) => {
        const a = addrs[id];
        const isDefault = id === defId;
        return `<div class="acct-acard${isDefault ? ' acct-on2' : ''}" data-addr-id="${escapeHtml(id)}">
  <span class="acct-dotmark" style="${isDefault ? '' : 'background:#CFC2B1'}"></span>
  <div class="acct-al2">
    <div class="acct-aname2">${escapeHtml(a.label || 'Dirección')}</div>
    <div class="acct-aline2">${escapeHtml(a.details || a.detected || '')}</div>
  </div>
  ${isDefault ? `<span class="acct-chk">${ICON_CHECK_BIG}</span>` : ''}
  <span class="acct-del" data-del-id="${escapeHtml(id)}" role="button" aria-label="Borrar dirección" title="Borrar">×</span>
</div>`;
      }).join('');
    }
    sec.innerHTML = `
<div class="acct-sechd"><span class="acct-sectitle">Mis direcciones</span><button class="acct-addlink" type="button" id="acct-add-addr-btn">+ Agregar</button></div>
${rowsHtml}`;
    sec.querySelectorAll('.acct-acard[data-addr-id]').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-del-id]')) return;
        selectSavedAddress(card.getAttribute('data-addr-id'));
      });
    });
    sec.querySelectorAll('[data-del-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); removeSavedAddress(btn.getAttribute('data-del-id')); });
    });
    const addBtn = $('acct-add-addr-btn'); if (addBtn) addBtn.onclick = startAddNewAddress;
  }

  async function selectSavedAddress(addrId) {
    if (!_acctData || !_acctData.addresses || !_acctData.addresses[addrId]) return;
    const a = _acctData.addresses[addrId];
    _acctData.default_address = addrId;
    _acctAddrId = addrId;
    renderAddressesSection();
    renderConfirmCard(_acctData, Object.assign({ id: addrId }, a));
    placeAccountPin(a.lat, a.lng);
    closeSheet();
    try { await saveAddress({ addrId, label: a.label, detected: a.detected, details: a.details, lat: a.lat, lng: a.lng, makeDefault: true }); }
    catch (_) { /* fail-open — the in-memory selection above already applies for this order */ }
  }

  async function removeSavedAddress(addrId) {
    if (!_acctData || !_acctData.addresses || !_acctData.addresses[addrId]) return;
    const ok = window.confirm('¿Borrar esta dirección guardada?');
    if (!ok) return;
    const wasDefault = _acctData.default_address === addrId;
    delete _acctData.addresses[addrId];
    if (wasDefault) _acctData.default_address = null;
    renderAddressesSection();
    if (_acctAddrId === addrId) {
      _acctAddrId = null;
      const next = pickDefaultAddress(_acctData);
      if (next) renderConfirmCard(_acctData, next);
      // else: leave the current card/fields as-is rather than yanking the form mid-order.
    }
    try { await deleteAddress(addrId); } catch (_) { /* fail-open — the list already reflects the deletion */ }
  }

  function startAddNewAddress() {
    closeSheet();
    enterEditMode(true);
    try {
      const s1 = document.getElementById('s1');
      if (s1 && s1.classList.contains('active')) {
        const nameField = document.getElementById('cname'); if (nameField) nameField.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (typeof showStage === 'function') {
        showStage('s1', 25);
      }
    } catch (_) {}
  }

  // ── Sign-out / delete-account: revert the form back to the pristine guest state ──
  function revertToGuestForm() {
    _acctData = null; _acctAddrId = null; _acctCardActive = false; _acctEditMode = false;
    _acctEditIsNew = false; _acctAddrUnsaved = false; _acctSaveToggleOn = true;
    const mount = $('acct-deliver'); if (mount) mount.innerHTML = '';
    const rawWrap = $('raw-name-phone'); if (rawWrap) rawWrap.style.display = '';
    const addrSection = addrSectionEl();
    if (addrSection) {
      addrSection.style.display = (pageOrderType() === 'delivery') ? '' : 'none';
      const picker = $('acct-label-picker'); if (picker) picker.remove();
    }
    const toggle = $('acct-save-toggle-wrap'); if (toggle) toggle.remove();
  }

  // ── Keep card/toggle visibility correct across delivery↔pickup toggles + "another order" resets,
  // without editing index.html's own functions — wrap them once, fail-open, guest-safe (only ever
  // installed from the marker()-gated DOMContentLoaded hook below).
  function applyCardVisibility() {
    if (!_acctCardActive || _acctEditMode) return;   // nothing to reassert, or edit surface owns visibility
    const addrSection = addrSectionEl();
    const rawWrap = $('raw-name-phone');
    const isDelivery = pageOrderType() === 'delivery';
    if (rawWrap) rawWrap.style.display = 'none';
    if (addrSection && isDelivery) addrSection.style.display = 'none';
  }

  function wrapPageHooks() {
    try {
      if (typeof window.setOrderType === 'function' && !window.setOrderType.__acctWrapped) {
        const orig = window.setOrderType;
        const wrapped = function (type) { orig(type); try { applyCardVisibility(); refreshSaveToggle(); } catch (_) {} };
        wrapped.__acctWrapped = true;
        window.setOrderType = wrapped;
      }
    } catch (_) {}
    try {
      if (typeof window.startAnotherOrder === 'function' && !window.startAnotherOrder.__acctWrapped) {
        const orig = window.startAnotherOrder;
        const wrapped = function () {
          orig();
          _acctEditMode = false; _acctAddrUnsaved = false; _acctSaveToggleOn = true;
          try { applyCardVisibility(); refreshSaveToggle(); } catch (_) {}
        };
        wrapped.__acctWrapped = true;
        window.startAnotherOrder = wrapped;
      }
    } catch (_) {}
  }

  // GUEST BYTE-IDENTICAL GATE: everything in Tasks B4–B7 (SDK, DOM, network) is reachable ONLY
  // through this listener, and ONLY once marker() (an instant localStorage read, no network) is
  // truthy. A guest returns before a single byte of this section runs.
  document.addEventListener('DOMContentLoaded', () => {
    if (!marker()) return;
    wrapPageHooks();
    initDeliveryStep().catch(() => {});
  });

  window.__ACCOUNT = { CONFIG, ensureFirebase };   // internal handle for later tasks/tests
  window.__ACCOUNT.customerIdToken = customerIdToken;
  window.__ACCOUNT.accountSnapshot = accountSnapshot;
  window.__ACCOUNT.newAddrId = newAddrId;
  window.__ACCOUNT.saveAddress = saveAddress;
  window.__ACCOUNT.deleteAddress = deleteAddress;
  window.__ACCOUNT.onOrderConfirmed = onOrderConfirmed;
})();
