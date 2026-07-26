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
/* T7 (codex-visual-fix): the name-capture field (post-verify pane) felt short + too squared at the
   host form's 8px field radius — raised to 58px (from 52px) and softened toward the phone
   field's (.acct-cc/.acct-inp) own 14px rounding, so it reads as one substantial, related field
   language rather than a cramped, unrelated afterthought. */
#acct-name-inp{height:58px;border-radius:13px}
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

    <section class="acct-pane" id="acct-pane-newaddr">
      <!-- built by renderNewAddressPane() at open time (Task 5) — self-contained, own map -->
    </section>

    <section class="acct-pane" id="acct-pane-createprofile">
      <!-- built by renderCreateProfilePane() post-OTP for an incomplete profile -->
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

    // Completeness-routed (not is_new): confirm the LIVE profile before deciding (codex R1 #1).
    // A TRI-STATE read distinguishes a resolved-but-incomplete profile (→ show Creá tu perfil) from
    // an unavailable read (timeout/error → fail-open to Mi Cuenta, NEVER the create pane).
    const st = await accountSnapshotStatus();
    // Arm the CHECKOUT account layer for THIS page load regardless of branch (codex R1 FIX 1): the
    // user was a guest at DOMContentLoaded, so the marker-gated init already skipped — wrapPageHooks()
    // + initDeliveryStep() must run now on EVERY logged-in outcome, not only the complete one. Without
    // this, an incomplete user who DISMISSES the overlay create pane reaches checkout with the account
    // layer un-armed (_acctCreateProfileActive false) → the payment hard-block never fires. Arming it
    // makes checkout enter its own "Creá tu perfil" hard-block (payment hidden until saved).
    // initDeliveryStep() operates ONLY on the checkout DOM (#acct-deliver / payment) — it never calls
    // showPane and never disturbs the overlay pane shown below; it also respects the existing
    // _acctRestoring/_acctRestoreGen guards internally.
    try { wrapPageHooks(); } catch (_) {}
    if (st.status === 'ok' && profileComplete(st.snap)) {
      _acctData = st.snap;
      renderChip();
      closeSheet();
      // Returning complete user — arm DETERMINISTICALLY from st.snap (codex R1 FIX 1b): the reduced
      // 2-step flow activates for THIS page load with no second read.
      try { initDeliveryStep(st.snap).catch(() => {}); } catch (_) {}
    } else if (st.status === 'ok') {
      // positively-confirmed INCOMPLETE → the full Creá tu perfil in the sheet, AND arm the checkout
      // hard-block underneath from st.snap DIRECTLY (codex R1 FIX 1b) so applyCreateProfileFlow sets
      // _acctCreateProfileActive=true + hides payment SYNCHRONOUSLY — a slow/failed second read can no
      // longer leave checkout payable if the user dismisses this overlay pane.
      _acctData = st.snap;
      renderCreateProfilePane((st.snap && st.snap.name) || data.name || '');
      try { initDeliveryStep(st.snap).catch(() => {}); } catch (_) {}
    } else {
      // read UNAVAILABLE (timeout/error) — never show create on an unconfirmed read; fail-open to Mi
      // Cuenta, and arm the checkout layer with NO preSnap → it re-reads and fail-opens (correct when
      // we couldn't confirm; the checkout's own complete-before-pay gate still enforces at pay).
      renderChip();
      renderAccountPane(); showPane('account');
      try { initDeliveryStep().catch(() => {}); } catch (_) {}
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

  // Tri-state variant of accountSnapshot() (codex R1 #1): distinguishes a RESOLVED read
  // (status:'ok', snap may be null/partial = a real profile state) from an UNAVAILABLE read
  // (timeout / SDK error / dead session). Callers that must NOT misclassify a slow read as
  // "incomplete profile" use this; the plain accountSnapshot() (fail-open-to-null) stays for
  // the checkout autofill path. Guest fast-path preserved: no marker → resolved ok/null instantly.
  async function accountSnapshotStatus() {
    if (!marker()) return { status: 'ok', snap: null };            // guest — resolved, no account
    const TIMEOUT = Symbol('timeout');
    try {
      const out = await Promise.race([
        (async () => {
          const { auth, db, dbMod } = await ensureFirebase();
          await auth.authStateReady();
          if (!auth.currentUser) { heal(); return null; }
          const snap = await dbMod.get(dbMod.ref(db, 'user_profiles/' + auth.currentUser.uid));
          return snap.exists() ? snap.val() : null;
        })(),
        new Promise((r) => setTimeout(() => r(TIMEOUT), 1500)),
      ]);
      if (out === TIMEOUT) return { status: 'unavailable' };
      return { status: 'ok', snap: out };
    } catch (_) {
      return { status: 'unavailable' };
    }
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
    // T1 (spec constraint #3) — REJECT, never normalize-and-persist, an invalid address: this is
    // the LAST line of defense regardless of caller (Cambiar, Creá-tu-perfil, "+ Agregar", any
    // future one) — so a caller bug can never silently write a saved address that would later
    // block checkout behind a hidden field (renderConfirmCard's own guard is defense-in-depth,
    // not the source of truth). Validate BEFORE any network read/write.
    const _label = String(label || '').trim();
    const _detected = String(detected || '').trim();
    const _details = String(details || '').trim();
    const latOk = typeof lat === 'number' && isFinite(lat);
    const lngOk = typeof lng === 'number' && isFinite(lng);
    if (!_label) return { ok: false, reason: 'invalid-label', message: 'Elegí un nombre para la dirección (Casa, Trabajo, etc.).' };
    if (!_detected) return { ok: false, reason: 'invalid-detected', message: 'No pudimos detectar la dirección — moví el pin en el mapa.' };
    if (_details.length < 3) return { ok: false, reason: 'invalid-details', message: 'Agregá una referencia para el repartidor (mínimo 3 caracteres).' };
    if (!latOk || !lngOk) return { ok: false, reason: 'invalid-latlng', message: 'Ubicación inválida — moví el pin en el mapa.' };

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
        label: _label.slice(0, 40),
        detected: _detected.slice(0, 200),
        details: _details.slice(0, 200),
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
/* T7 (codex-visual-fix): renamed from the collision-prone .acct-h1/.acct-h2 — those names were
   ALSO the login sheet's real <h1 class="acct-h1"> title class (line ~103 above); since this
   later stylesheet always wins the cascade, every login/creá-perfil h1 title was silently getting
   height:9px + rotate(-4deg) applied to it once injectDeliverStyles() had run this pageload
   (guaranteed sooner now that Tasks 2/3/4/5 call it far more eagerly) — a squashed, rotated title
   overlapping its subtitle. Purely a class rename on the decorative map's <i> road-lines; the map
   itself is visually unchanged. */
.acct-mh1{left:0;right:0;top:26px;height:9px;transform:rotate(-4deg)}
.acct-mh2{left:0;right:0;top:56px;height:12px;transform:rotate(-4deg)}
.acct-mv1{top:0;bottom:0;left:76px;width:10px;transform:rotate(6deg)}
.acct-mv2{top:0;bottom:0;left:182px;width:8px;transform:rotate(6deg)}
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

  // ── T1 — "complete profile" predicate (spec constraint #7, codex R1 #8) ──
  // name complete = first+last (>=2 words); address complete = REUSES pickDefaultAddress's own
  // guard (detected + numeric lat/lng + details>=3). The LIVE accountSnapshot() snap is
  // authoritative for this decision — the localStorage marker is only the instant-chip hint,
  // NEVER the gate for step-removal/reduced-flow (spec R1 #7 / non-negotiable #1).
  function profileComplete(snap) {
    if (!snap) return false;
    const nameOk = String(snap.name || '').trim().split(/\s+/).filter(Boolean).length >= 2;
    if (!nameOk) return false;
    return !!pickDefaultAddress(snap);
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
  let _acctCreateProfileActive = false;  // true ONLY while "Creá tu perfil" is on screen (payment hidden + CTA shown) — the submit-gate keys off this, never a profileComplete() inference (FIX A)
  let _acctAddrOneOff = false;   // true when the order's delivery address is a USE-ONCE choice (Cambiar "Usar en este pedido" / an edit-mode-new address NOT explicitly "Guardar dirección"-saved) — onOrderConfirmed must never makeDefault/persist it (FIX B)
  let _acctRestoring = false;    // true ONLY while index.html's restoreOrderForm() rebuilds a cancelled/failed-payment retry from the xpizza_pending_pay snapshot — the snapshot's delivery data is authoritative, so every account delivery-refresh entry point must early-return (never repopulate the DOM from the DEFAULT saved address) (FIX 7 / R4)
  let _acctRestoreGen = 0;       // bumped on every restore START (setRestoring(true)). initDeliveryStep()'s snapshot read is async: restoreOrderForm() is SYNCHRONOUS and clears _acctRestoring in its finally BEFORE the suspended init can resume, so a flag-only re-check would read false and miss the race. Capturing the gen before the await and comparing after catches a restore that BOTH began and completed during the await (R5 async re-check).

  // ── Task B4/3: the "Entregar a" confirm card + autofill — orchestrates the 3 flow states
  // (spec: guest handled entirely elsewhere by the marker() gate; incomplete profile → Task 2's
  // Creá tu perfil; complete profile → Task 3's reduced 2-step "cart → pay" flow). FAIL-OPEN at
  // every step — any miss/timeout/incomplete/invariant-fail routes to the normal fillable UI,
  // never a hidden-but-empty section, never an advance to payment without valid delivery data.
  // preSnap (codex R1 FIX 1b): when provided (!== undefined), arm DETERMINISTICALLY from a snapshot
  // the caller already has — skip the internal accountSnapshot() await entirely (and thus its
  // post-await R5 re-check, since with no await there's no restore race to catch). verifyCode's
  // COMPLETE and confirmed-INCOMPLETE branches pass st.snap so _acctCreateProfileActive is set
  // synchronously (incomplete → hides payment) and a slow/failed SECOND read can't leave checkout
  // payable. Omitting the arg preserves the original read-and-fail-open behavior for every other
  // caller (DOMContentLoaded, setOrderType, save-success, the UNAVAILABLE branch).
  async function initDeliveryStep(preSnap) {
    if (!$('acct-deliver')) return;               // host form has no mount — never touch anything
    if (_acctRestoring) return;                   // a payment-retry restore owns the DOM — the snapshot is authoritative, never repopulate from the profile (FIX 7 / R4)
    const hasPre = (preSnap !== undefined);
    const restoreGen = _acctRestoreGen;           // snapshot the restore generation BEFORE any async read (R5)
    setPaymentVisible(true);   // default reveal; only applyCreateProfileFlow (incomplete) hides it (FIX 1)
    const snap = hasPre ? preSnap : await accountSnapshot();   // preSnap → deterministic, no await; else fail-open, timeboxed ~1.5s internally — LIVE, authoritative (spec R1 #7)
    if (!hasPre && (_acctRestoring || _acctRestoreGen !== restoreGen)) return;   // a retry-restore began (and possibly already completed, resetting _acctRestoring) DURING the await — never clobber the restored DOM (R5 async re-check). Only when we actually awaited.
    if (!snap) { _acctData = null; revertToNormalFillable(); refreshSaveToggle(); return; }   // no account / miss/timeout → normal empty form
    _acctData = snap;
    if (pageOrderType() !== 'delivery') { revertToNormalFillable(); refreshSaveToggle(); return; }   // pickup — out of scope (spec), leave raw fields

    if (profileComplete(snap)) {
      const addr = pickDefaultAddress(snap);
      if (addr) {
        // Map-timing (spec R2): establish the CHECKOUT lat/lng + delivery-zone state DIRECTLY
        // from the saved address BEFORE the invariant check — gmap isn't initialized until s2
        // (goToLocation→initMap), so a bare placeAccountPin() call alone would only stash a
        // pending __restorePos, not values the invariant check below can trust as established.
        establishCheckoutFromAddress(addr);
        populateOrderFieldsFromAddress(snap, addr);   // fill the (soon-hidden) submit fields BEFORE the invariant reads them back
        if (reducedFlowInvariantOk(snap, addr)) {
          renderS1CompactSummary(snap, addr);
          renderS2RichSummary(snap, addr);
          relabelSteps(true);
          _acctReducedActive = true;
          _acctAddrId = addr.id;
          hideRawAndAddrSection();
          return;
        }
      }
      // FAIL-OPEN: the live snapshot says complete, but the map-timing/zone/invariant re-check
      // failed RIGHT NOW (e.g. genuinely out of the current delivery zone) — never advance/hide
      // behind an unconfirmed state. Fall through to the normal fillable flow below.
    }
    applyCreateProfileFlow(snap);   // Task 2 — no-skip profile creation (also the fail-open destination above)
  }

  // Shared "Entregar a" card markup — the decorative map header + name/phone/Cambiar row + address
  // label/reference — used by BOTH the legacy renderConfirmCard (s1, pre-Task-3 behavior for a
  // valid-address-but-incomplete-profile customer) and the new Task 3 rich summary atop s2's
  // payment (renderS2RichSummary). Pure string template, byte-identical to the markup this
  // replaced inside renderConfirmCard — extracted only to avoid drift between the two mounts.
  function deliverCardHtml(name, phone, addr, changeBtnId) {
    return `
<div class="acct-deliver">
  <div class="acct-map">
    <i class="acct-mh1"></i><i class="acct-mh2"></i><i class="acct-mv1"></i><i class="acct-mv2"></i>
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
    <button class="acct-change" type="button" id="${changeBtnId}">Cambiar</button>
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
  }

  function renderConfirmCard(snap, addr) {
    injectDeliverStyles();
    const mount = $('acct-deliver'); if (!mount) return;

    // INVARIANT (codex re-gate): renderConfirmCard is the ONLY function that HIDES #address-details, so the
    // usable-reference guard lives here — covering EVERY caller (default autofill, "Mis direcciones" tap,
    // save-on-order re-render, any future one). An address missing detected/lat/lng OR with details <3 must
    // NEVER be shown as the hidden-field card (delivery requires details>=3 → checkout would block on a hidden
    // input). Instead prefill what we have, place the pin, and open the fillable edit view with
    // #address-details empty + focused so the customer supplies the reference (saveEditedAddress's >=3 guard
    // then persists it). Keeps the raw fields VISIBLE — never hidden-and-blocked.
    if (!addr || typeof addr.detected !== 'string' || typeof addr.lat !== 'number' || typeof addr.lng !== 'number'
        || typeof addr.details !== 'string' || addr.details.trim().length < 3) {
      const m2 = marker() || {};
      const nm = (snap && snap.name) || m2.name || '';
      const ph = (snap && snap.phone) || m2.phone || '';
      setVal('cname', nm);
      if (typeof window.__applyPhoneRaw === 'function') window.__applyPhoneRaw(ph); else setVal('cphone', ph);
      if (addr && typeof addr.detected === 'string') setVal('address-detected', addr.detected);
      if (addr && typeof addr.lat === 'number' && typeof addr.lng === 'number') placeAccountPin(addr.lat, addr.lng);
      if (addr && addr.id) _acctAddrId = addr.id;
      _acctCardActive = false;
      enterEditMode(false);                                   // reveal raw fields + label picker (hides nothing)
      const df = $('address-details'); if (df) { df.value = ''; df.focus(); }
      return;
    }

    const rawWrap = $('raw-name-phone');
    const addrSection = addrSectionEl();
    const m = marker() || {};
    const name = (snap && snap.name) || m.name || '';
    const phone = (snap && snap.phone) || m.phone || '';

    mount.innerHTML = `<div class="acct-eyebrow">Entregar a</div>` + deliverCardHtml(name, phone, addr, 'acct-change-btn');
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

  // opts (Task 2/T2): { ctaText, onSave, showCancel } — all optional, default to the ORIGINAL
  // Cambiar-flow behavior byte-for-byte (ctaText='Guardar dirección', onSave=saveEditedAddress,
  // showCancel=true) so this extension is purely additive for existing callers. T2's "Creá tu
  // perfil" reuses this exact scaffolding with its own CTA text + a dedicated re-validating
  // handler (saveCreateProfile) and no Cancelar (profile creation isn't skippable).
  function injectLabelPicker(addrSection, opts) {
    opts = opts || {};
    const ctaText = opts.ctaText || 'Guardar dirección';
    const onSave = opts.onSave || saveEditedAddress;
    const showCancel = opts.showCancel !== false;
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
<p class="acct-field-hint" id="acct-label-picker-err" style="display:none;color:#B23B3B"></p>
<button type="button" class="acct-save-addr-btn" id="acct-save-addr-btn">${ICON_CHECK_BIG} ${escapeHtml(ctaText)}</button>
${showCancel ? '<button type="button" class="acct-cancel-edit" id="acct-cancel-edit-btn">‹ Cancelar</button>' : ''}`;
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
    const saveBtn = $('acct-save-addr-btn'); if (saveBtn) saveBtn.onclick = onSave;
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
      refreshDeliveryUI(Object.assign({ id: res.addrId }, _acctData.addresses[res.addrId]));
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
      if (addr) { refreshDeliveryUI(addr); return; }
    }
    _acctCardActive = false;   // no saved address to fall back to — leave the raw fields as a guest would see them
    _acctReducedActive = false;
    refreshSaveToggle();
  }

  // ── Task B7: subtle opt-in "Guardar esta dirección" toggle for an order that ISN'T already
  // riding a saved, unedited address (e.g. a logged-in customer's very first delivery order, or one
  // whose in-flow save attempt failed). Hidden while the B5 edit surface (with its own explicit
  // "Guardar dirección") is open — the two affordances are never shown at once.
  function refreshSaveToggle() {
    const addrSection = addrSectionEl();
    const existing = $('acct-save-toggle-wrap');
    // Never show alongside the Task 3 reduced-flow summary or the Task 2 required label picker —
    // both of those already own the "save this address" decision for their surface.
    const shouldShow = !!marker() && pageOrderType() === 'delivery' && !_acctEditMode && !_acctReducedActive
      && !$('acct-label-picker') && (!_acctCardActive || _acctAddrUnsaved);
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
      // Save-intent (redirect fix): prefer a PERSISTED block matched to THIS order — it survives the PixelPay
      // redirect+reload, which resets every closure flag (_acctAddrOneOff/_acctAddrId/_acctEditIsNew/_acctData);
      // else the live flags (correct for a same-page CASH order). Consume the block ONCE so a later unrelated
      // confirmation can never replay it.
      let intent = null;
      try { const raw = localStorage.getItem('xpizza_acct_intent'); if (raw) { const p = JSON.parse(raw); if (p && p.order_id === order.order_id) intent = p; } } catch (_) {}
      try { localStorage.removeItem('xpizza_acct_intent'); } catch (_) {}
      const loggedIn = intent ? !!intent.uid : !!marker();
      if (!loggedIn) return;                       // guest — never save
      const oneOff = intent ? !!intent.oneOff : !!_acctAddrOneOff;
      if (oneOff) return;                          // USE-ONCE ("Usar en este pedido" / an unsaved edit) — never persist or default
      const addrId = intent ? (intent.addrId || null) : (_acctAddrId || null);
      if (addrId) return;                          // an ALREADY-SAVED address drove the order → nothing to persist; NEVER mint a DUPLICATE (the redirect bug: reset flags → addrId null → saveAddress would dup) and NEVER change the default
      const isNew = intent ? !!intent.isNew : !!_acctEditIsNew;
      if (!isNew) return;                          // no addrId + not a new-address-to-save → nothing
      const detected = order.address_detected, details = order.address_details;
      const la = order.lat, ln = order.lng;
      if (!detected || typeof la !== 'number' || typeof ln !== 'number') return;
      const label = (intent && intent.label) || (_acctEditLabel && _acctEditLabel.trim()) || 'Dirección';
      // A genuinely-new address the customer opted to save (not one-off) → persist, NON-default (default is
      // ONLY ever set by the explicit "Guardar dirección"/"Guardar y continuar" pre-payment).
      const res = await saveAddress({ label, detected, details, lat: la, lng: ln, makeDefault: false });
      if (res && res.ok) { _acctAddrUnsaved = false; _acctAddrId = res.addrId; refreshSaveToggle(); }
    } catch (_) { /* never affects the order — it already succeeded */ }
  }

  // Persist the account save-intent at ORDER-SUBMIT so the ONLINE (PixelPay) redirect+reload path — which
  // resets every closure flag — can still enforce the rules in onOrderConfirmed. Called from index.html's
  // processPixelPay() (BEFORE the redirect) with the order_id. Guest/pickup → clear (nothing to persist).
  function captureDeliverySaveIntent(orderId) {
    try {
      if (!orderId || !marker() || pageOrderType() !== 'delivery') { try { localStorage.removeItem('xpizza_acct_intent'); } catch (_) {} return; }
      const m = marker() || {};
      const label = (_acctEditLabel && _acctEditLabel.trim())
        || (_acctData && _acctAddrId && _acctData.addresses && _acctData.addresses[_acctAddrId] && _acctData.addresses[_acctAddrId].label)
        || 'Dirección';
      const intent = { order_id: String(orderId), uid: m.uid || 1, oneOff: !!_acctAddrOneOff, addrId: _acctAddrId || null, isNew: !!_acctEditIsNew, label };
      try { localStorage.setItem('xpizza_acct_intent', JSON.stringify(intent)); } catch (_) {}
    } catch (_) {}
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
    refreshDeliveryUI(Object.assign({ id: addrId }, a));
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
      if (next) refreshDeliveryUI(next);
      else if (_acctReducedActive) applyCreateProfileFlow(_acctData);   // the only address just got deleted → profile is now INCOMPLETE: route to the fillable Creá-tu-perfil (hides payment + shows the "Guardar y continuar" CTA the submit-gate points at) — never a payable-looking-but-gate-blocked dead pay button
      // else: leave the current card/fields as-is rather than yanking the form mid-order.
    }
    try { await deleteAddress(addrId); } catch (_) { /* fail-open — the list already reflects the deletion */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Task 5 — "+ Agregar" self-contained Nueva dirección (spec constraint #4 / codex R1 #4). Opens
  // INSIDE the account sheet with its OWN google.maps.Map/Marker/Geocoder + acctLat/acctLng —
  // NEVER the checkout gmap/lat/lng/__restorePos/placeAccountPin. On save → saveAddress using
  // ONLY these account-map values → returns to Mi Cuenta (list, new one shown). NEVER enters the
  // order/checkout flow (the bug this replaces: the old startAddNewAddress closed the sheet and
  // dumped the customer into the order form's own address fields).
  // ══════════════════════════════════════════════════════════════════════════════════════════

  // The "+ Agregar" pane and the login-sheet "Creá tu perfil" pane share this account-only sink;
  // the account-scoped fullscreen map twin (above) is the ONLY writer. Never the checkout globals.
  let _nadLat = null, _nadLng = null, _nadDetected = '';
  let _nadPinTouched = false;   // TRUE only after a REAL user placement (drag or Listo-commit) — never the fallback/GPS auto-pin (codex re-gate FIX 2)

  function injectNewAddrStyles() {
    if ($('acct-nad-styles')) return;
    const st = document.createElement('style');
    st.id = 'acct-nad-styles';
    st.textContent = `
.acct-nad-top{display:flex;align-items:center;gap:10px;margin:0 0 4px}
.acct-nad-back{background:none;border:none;font-family:inherit;font-size:14px;font-weight:650;color:#17130F;cursor:pointer;padding:4px 0}
.acct-nad-title{font-size:15px;font-weight:700;color:#8C7B6E}
.acct-nad-map{height:168px;border-radius:16px;border:1px solid #E2D8C8;background:#EFE7DA}
.acct-nad-hint{margin-top:8px;font-size:12px;color:#8C7B6E}
.acct-nad-textarea{width:100%;min-height:60px;padding:14px 15px;border:1.5px solid #E2D8C8;border-radius:13px;background:#fff;font-size:15px;font-family:inherit;color:#17130F;outline:none;resize:vertical}
.acct-nad-textarea:focus{border-color:#17130F}
.acct-verified-ro{display:flex;align-items:center;justify-content:space-between;height:52px;padding:0 15px;border:1.5px solid #EDE5D9;border-radius:13px;background:#FBF6EE;color:#17130F}
.acct-verified-ro .v{font-size:15.5px;font-weight:650;font-variant-numeric:tabular-nums}
.acct-verified-ro .ok{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:#2A6A42}
.acct-two{display:flex;gap:10px}
.acct-two .acct-inp{flex:1;min-width:0;height:58px;border-radius:13px}
`;
    document.head.appendChild(st);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Account-scoped fullscreen map TWIN (spec Part C) — a standalone duplicate of the checkout
  // fullscreen center-pin map, account-scoped. HARD symbol firewall (codex R1 #4): it NEVER calls
  // openFullscreenMap/closeFullscreenMap/setFullscreenMapType/reverseGeocodeFS, never uses
  // #fs-*/#map-fullscreen* ids, and never assigns lat/lng/gmap/gmarker/fsMap/__restorePos. Its
  // ONLY state sink is _nadLat/_nadLng/_nadDetected/_nadPinTouched. Reading checkout lat/lng ONCE
  // as a starting center hint (guarded typeof, read-only) is the sole permitted contact.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  let _acctFsMap = null;            // the fullscreen google.maps.Map (account-scoped twin of checkout fsMap)
  let _acctFsGeocoder = null;
  let _acctFsEpoch = 0;             // bumped on every open; late async callbacks compare against it
  let _acctFsPreviewId = null;      // which preview to refresh on Listo
  let _acctFsPrevOverflow = '';     // document.body.style.overflow at open — restored on close (sheet may still need lock)
  let _nadGeoSeq = 0;               // per-request monotonic seq (codex R1 FIX 2): only the LATEST-requested reverse-geocode may write _nadDetected, so an older in-epoch callback resolving last can't overwrite the committed pin's address

  let _acctFsStylesDone = false;
  function injectAcctFsStyles() {
    if (_acctFsStylesDone) return; _acctFsStylesDone = true;
    const st = document.createElement('style');
    st.textContent = `
.acct-fs-overlay{position:fixed;inset:0;z-index:1200;display:none;flex-direction:column;background:#E4DAC7}
.acct-fs-overlay.open{display:flex}
.acct-fs-map{flex:1;width:100%}
.acct-fs-toggle{position:absolute;top:14px;right:14px;display:flex;gap:6px;z-index:4}
.acct-fs-toggle button{padding:7px 12px;font-size:12px;font-weight:700;border:none;border-radius:8px;font-family:inherit;cursor:pointer;box-shadow:0 2px 7px -2px rgba(40,28,12,.35)}
.acct-fs-bar{background:#fff;padding:13px 16px calc(13px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:12px;border-top:1px solid #EDE5D9}
.acct-fs-bar .a{flex:1;min-width:0}
.acct-fs-bar .a .l{font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#B3A594}
.acct-fs-bar .a b{display:block;font-size:14px;font-weight:600;color:#17130F;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.acct-fs-done{flex:none;background:#17130F;color:#fff;border:none;border-radius:12px;padding:13px 20px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.acct-fs-pin{position:absolute;left:calc(50% - 15px);top:calc(50% - 36px);width:30px;height:30px;z-index:3;pointer-events:none;filter:drop-shadow(0 8px 7px rgba(40,28,12,.34))}
.acct-fs-pindot{position:absolute;left:calc(50% - 6px);top:calc(50% - 4px);width:12px;height:6px;border-radius:50%;background:rgba(40,28,12,.28);filter:blur(1.5px);z-index:2;pointer-events:none}
.acct-map-preview{height:150px;border-radius:15px;overflow:hidden;border:1px solid #E2D8C8;position:relative;cursor:pointer;background:#E4DAC7}
.acct-map-preview .pv{position:absolute;inset:0;pointer-events:none}
.acct-map-preview .hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.acct-map-preview .hint span{background:rgba(24,18,12,.6);color:#fff;font-size:12.5px;font-weight:650;padding:8px 15px;border-radius:20px;backdrop-filter:blur(2px)}`;
    document.head.appendChild(st);
  }

  let _acctFsBuilt = false;
  function ensureAcctFsOverlay() {
    injectAcctFsStyles();
    if (_acctFsBuilt) return;
    const ov = document.createElement('div');
    ov.className = 'acct-fs-overlay'; ov.id = 'acct-fs-overlay';
    ov.innerHTML = `
<div class="acct-fs-map" id="acct-fs-map"></div>
<div class="acct-fs-toggle">
  <button type="button" id="acct-fs-road">Mapa</button>
  <button type="button" id="acct-fs-sat">Satélite</button>
</div>
<div class="acct-fs-pindot"></div>
<svg class="acct-fs-pin" viewBox="0 0 24 24" fill="${CONFIG.accent}" stroke="#fff" stroke-width="1.4"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/><circle cx="12" cy="9" r="2.6" fill="#fff" stroke="none"/></svg>
<div class="acct-fs-bar">
  <div class="a"><div class="l">Tu ubicación</div><b id="acct-fs-addr">Detectando…</b></div>
  <button type="button" class="acct-fs-done" id="acct-fs-done">${ICON_CHECK_BIG} Listo</button>
</div>`;
    document.body.appendChild(ov);
    ov.querySelector('#acct-fs-road').onclick = () => setAcctFsMapType('roadmap');
    ov.querySelector('#acct-fs-sat').onclick = () => setAcctFsMapType('satellite');
    ov.querySelector('#acct-fs-done').onclick = () => closeAcctFullscreenMap(true);
    _acctFsBuilt = true;
  }

  function setAcctFsMapType(type) {
    if (_acctFsMap) _acctFsMap.setMapTypeId(type);
    const road = document.getElementById('acct-fs-road'), sat = document.getElementById('acct-fs-sat');
    if (road) { road.style.background = type === 'roadmap' ? '#17130F' : '#fff'; road.style.color = type === 'roadmap' ? '#fff' : '#333'; }
    if (sat)  { sat.style.background  = type === 'satellite' ? '#17130F' : '#fff'; sat.style.color  = type === 'satellite' ? '#fff' : '#333'; }
  }

  function openAcctFullscreenMap(previewId) {
    ensureAcctFsOverlay();
    if (!window.google || !window.google.maps) { setTimeout(() => openAcctFullscreenMap(previewId), 250); return; }
    _acctFsPreviewId = previewId || null;
    const ov = document.getElementById('acct-fs-overlay');
    ov.classList.add('open');
    // suppress background scroll; remember prior value so close restores it (sheet may still need lock)
    _acctFsPrevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const epoch = ++_acctFsEpoch;

    // starting center: current account pin → else checkout lat/lng (READ-ONLY hint) → else restaurant
    let start = null;
    if (typeof _nadLat === 'number' && typeof _nadLng === 'number') start = { lat: _nadLat, lng: _nadLng };
    if (!start) { try { if (typeof lat === 'number' && typeof lng === 'number') start = { lat, lng }; } catch (_) {} }
    if (!start) { let f = { lat: 15.5003, lng: -88.025 }; try { if (typeof RESTAURANT_LAT === 'number' && typeof RESTAURANT_LNG === 'number') f = { lat: RESTAURANT_LAT, lng: RESTAURANT_LNG }; } catch (_) {} start = f; }

    const el = document.getElementById('acct-fs-map');
    if (!_acctFsMap) {
      _acctFsMap = new google.maps.Map(el, { center: start, zoom: 17, mapTypeId: 'roadmap', disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy' });
      setAcctFsMapType('roadmap');
      // center-pin: reverse-geocode on any center change (display only) …
      _acctFsMap.addListener('center_changed', () => {
        const c = _acctFsMap.getCenter(); reverseGeocodeAcctFs(c.lat(), c.lng(), _acctFsEpoch);
      });
      // … but only a USER drag commits lat/lng + marks the pin as user-placed (codex R1 #3)
      _acctFsMap.addListener('dragend', () => {
        const c = _acctFsMap.getCenter();
        commitAcctPin(c.lat(), c.lng());
      });
    } else {
      _acctFsMap.setCenter(start);
    }
    reverseGeocodeAcctFs(start.lat, start.lng, epoch);
    // If we have no user pin yet, offer geolocation as a starting VIEW (never marks touched)
    if (!_nadPinTouched && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => { if (_acctFsEpoch === epoch && _acctFsMap) _acctFsMap.setCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
        () => {}, { timeout: 8000, enableHighAccuracy: true, maximumAge: 0 }
      );
    }
  }

  // Single commit path for a user-placed pin (codex R1 FIX 2b): sets the committed lat/lng, marks
  // touched, and CLEARS _nadDetected so no stale address can be saved against the new pin — then
  // starts the latest-seq geocode. Save stays blocked (validateCreateProfile requires _nadDetected)
  // until that geocode's callback lands and re-enables the CTA. Shared by dragend AND Listo.
  function commitAcctPin(la, ln) {
    _nadLat = la; _nadLng = ln; _nadPinTouched = true;
    _nadDetected = '';                                            // invalidate the prior address until the committed pin's geocode resolves
    const addrEl = document.getElementById('acct-fs-addr'); if (addrEl) addrEl.textContent = 'Confirmando dirección…';
    reverseGeocodeAcctFs(la, ln, _acctFsEpoch);
  }

  function reverseGeocodeAcctFs(la, ln, epoch) {
    if (!window.google || !window.google.maps) return;
    if (!_acctFsGeocoder) _acctFsGeocoder = new google.maps.Geocoder();
    const seq = ++_nadGeoSeq;                                     // latest request wins (codex R1 FIX 2)
    _acctFsGeocoder.geocode({ location: { lat: la, lng: ln } }, (results, status) => {
      if (epoch !== _acctFsEpoch) return;                         // stale — pane/map torn down; ignore (codex R1 #5)
      if (seq !== _nadGeoSeq) return;                             // superseded by a newer request; in-epoch ordering (codex R1 FIX 2)
      const detected = (status === 'OK' && results[0]) ? results[0].formatted_address
                     : ('Lat: ' + la.toFixed(5) + ', Lng: ' + ln.toFixed(5));   // fallback → never permanently empty
      _nadDetected = detected;
      const addrEl = document.getElementById('acct-fs-addr'); if (addrEl) addrEl.textContent = detected;
      // The committed pin's address just landed → re-enable Save (covers the empty→stuck-disabled
      // case, codex R1 FIX 2b). Guard to the create pane so an unrelated pane is never touched.
      const cp = document.getElementById('acct-pane-createprofile');
      if (cp && cp.classList.contains('acct-on')) refreshCreateProfileCta();
    });
  }

  function closeAcctFullscreenMap(commit) {
    const ov = document.getElementById('acct-fs-overlay'); if (ov) ov.classList.remove('open');
    document.body.style.overflow = _acctFsPrevOverflow || '';
    // If the user never dragged but did move the map to a place and tapped Listo, treat the
    // resting center as their placement (matches checkout's "close commits center").
    if (commit && _acctFsMap) {
      const c = _acctFsMap.getCenter();
      // Commit the FINAL center via the shared path (codex R1 FIX 2/2b): clears _nadDetected first
      // (no stale address can be saved against the new pin) then re-geocodes with the newest seq →
      // its callback is the authoritative writer of _nadDetected for the committed pin.
      commitAcctPin(c.lat(), c.lng());
    }
    if (_acctFsPreviewId) renderAcctMapPreview(_acctFsPreviewId);   // reflect the chosen pin + address
    // if the create pane is the active one, its CTA gating depends on the just-committed pin
    const cp = $('acct-pane-createprofile');
    if (cp && cp.classList.contains('acct-on')) refreshCreateProfileCta();
  }

  function renderAcctMapPreview(containerId) {
    const host = document.getElementById(containerId); if (!host) return;
    host.className = 'acct-map-preview';
    const placed = (typeof _nadLat === 'number' && typeof _nadLng === 'number');
    host.innerHTML = `<div class="pv" id="${containerId}-pv"></div>
<svg class="acct-fs-pin" style="filter:drop-shadow(0 6px 5px rgba(40,28,12,.3))" viewBox="0 0 24 24" fill="${CONFIG.accent}" stroke="#fff" stroke-width="1.4"><path d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/><circle cx="12" cy="9" r="2.6" fill="#fff" stroke="none"/></svg>
<div class="acct-fs-pindot"></div>
<div class="hint"><span>${placed ? 'Toca para ajustar' : 'Toca para marcar tu ubicación'}</span></div>`;
    host.onclick = () => openAcctFullscreenMap(containerId);
    initAcctPreviewMap(containerId);
  }

  function initAcctPreviewMap(containerId) {
    if (!window.google || !window.google.maps) { setTimeout(() => initAcctPreviewMap(containerId), 300); return; }
    const el = document.getElementById(containerId + '-pv'); if (!el) return;
    let c = null;
    if (typeof _nadLat === 'number' && typeof _nadLng === 'number') c = { lat: _nadLat, lng: _nadLng };
    if (!c) { try { if (typeof lat === 'number' && typeof lng === 'number') c = { lat, lng }; } catch (_) {} }
    if (!c) { c = { lat: 15.5003, lng: -88.025 }; try { if (typeof RESTAURANT_LAT === 'number' && typeof RESTAURANT_LNG === 'number') c = { lat: RESTAURANT_LAT, lng: RESTAURANT_LNG }; } catch (_) {} }
    new google.maps.Map(el, { center: c, zoom: 16, disableDefaultUI: true, gestureHandling: 'none', keyboardShortcuts: false, clickableIcons: false });
    // preview is display-only; the tappable wrapper opens fullscreen
  }

  function startAddNewAddress() {
    renderNewAddressPane();   // self-contained — NEVER closes the sheet, NEVER touches the order form
  }

  function renderNewAddressPane() {
    injectDeliverStyles();
    injectNewAddrStyles();
    const pane = $('acct-pane-newaddr'); if (!pane) return;
    _acctFsEpoch++;                          // invalidate any late geocode from a prior map session
    _nadLat = null; _nadLng = null; _nadDetected = ''; _nadPinTouched = false;   // fresh address entry
    pane.innerHTML = `
<div class="acct-nad-top">
  <button type="button" class="acct-nad-back" id="acct-nad-back" aria-label="Volver a Mi cuenta">‹ Mi cuenta</button>
  <span class="acct-nad-title">Nueva dirección</span>
</div>
<div class="acct-eyebrow">Ubicación en el mapa</div>
<div id="acct-nad-preview"></div>
<div class="acct-mlabel" style="margin-top:18px">Referencia</div>
<textarea id="acct-nad-details" class="acct-nad-textarea" rows="2" placeholder="Portón, color de casa, piso, punto de referencia…" maxlength="200"></textarea>
<div class="acct-mlabel">Guardar como</div>
<div class="acct-lchips" id="acct-nad-lchips">
  <button type="button" class="acct-lchip" data-label="Casa">${ICON_HOUSE}Casa</button>
  <button type="button" class="acct-lchip" data-label="Trabajo">${ICON_WORK}Trabajo</button>
  <button type="button" class="acct-lchip acct-on" data-label="">${ICON_TAG}Otra</button>
</div>
<input type="text" id="acct-nad-label" class="acct-label-custom-inp" placeholder="Ponle un nombre… (ej: Casa de mis papás)" maxlength="40" style="margin-top:10px"/>
<p class="acct-field-hint" id="acct-nad-err" style="display:none;color:#B23B3B"></p>
<button type="button" class="acct-save-addr-btn" id="acct-nad-save-btn">${ICON_CHECK_BIG} Guardar dirección</button>`;

    const backBtn = $('acct-nad-back'); if (backBtn) backBtn.onclick = closeNewAddressPane;
    wireNewAddrLabelChips();
    const saveBtn = $('acct-nad-save-btn'); if (saveBtn) saveBtn.onclick = saveNewAddressFromPane;

    showPane('newaddr');
    renderAcctMapPreview('acct-nad-preview');
  }

  function wireNewAddrLabelChips() {
    const wrap = $('acct-nad-lchips'); if (!wrap) return;
    wrap.querySelectorAll('.acct-lchip').forEach((chip) => {
      chip.onclick = () => {
        wrap.querySelectorAll('.acct-lchip').forEach((c) => c.classList.remove('acct-on'));
        chip.classList.add('acct-on');
        const custom = $('acct-nad-label');
        const val = chip.getAttribute('data-label');
        if (val) { if (custom) custom.value = val; }
        else { if (custom) { custom.value = ''; custom.focus(); } }
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // "Creá tu perfil" IN THE LOGIN SHEET (spec Part A) — a full profile-creation pane shown post-OTP
  // to a positively-confirmed INCOMPLETE customer. Identity (name) + the account-scoped map twin +
  // referencia + label. Distinct from the CHECKOUT create flow (saveCreateProfile above): its own
  // ids (acct-cp-first/last/details/label/preview), its own save (saveCreateProfilePane), its own
  // _nad* map sink — never the checkout gmap/lat/lng.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  let _acctCpLabel = 'Casa';   // chip-picked (or custom) label for the create-pane address

  function renderCreateProfilePane(prefillName) {
    injectDeliverStyles(); injectNewAddrStyles(); injectAcctFsStyles();
    const pane = $('acct-pane-createprofile'); if (!pane) return;
    _acctFsEpoch++;                                                             // invalidate any late geocode from a prior map session
    _nadLat = null; _nadLng = null; _nadDetected = ''; _nadPinTouched = false;  // fresh address entry
    _acctCpLabel = 'Casa';                                                      // default preset chosen
    const phone = (_loginPhone || (marker() && marker().phone) || '').toString();
    const nm = String(prefillName || '').trim();
    const parts = nm.split(/\s+/).filter(Boolean);
    const firstV = parts.length ? parts[0] : '';
    const lastV = parts.length > 1 ? parts.slice(1).join(' ') : '';
    pane.innerHTML = `
<h1 class="acct-h1">Creá tu perfil</h1>
<p class="acct-sub">Guardá tu nombre y dirección — la próxima vez pedís en dos toques.</p>
<div class="acct-mlabel">Teléfono <span style="color:#B3A594;font-weight:600">· ya verificado</span></div>
<div class="acct-verified-ro"><span class="v">${escapeHtml(phone)}</span><span class="ok">${ICON_CHECK_SM} WhatsApp</span></div>
<div class="acct-mlabel" style="margin-top:16px">Nombre y apellido</div>
<div class="acct-two">
  <input type="text" id="acct-cp-first" class="acct-inp" placeholder="Nombre" maxlength="40" value="${escapeHtml(firstV)}" autocomplete="given-name">
  <input type="text" id="acct-cp-last" class="acct-inp" placeholder="Apellido" maxlength="40" value="${escapeHtml(lastV)}" autocomplete="family-name">
</div>
<div class="acct-mlabel" style="margin-top:16px">¿A dónde te lo llevamos?</div>
<div id="acct-cp-preview"></div>
<textarea id="acct-cp-details" class="acct-nad-textarea" rows="2" placeholder="Referencia: portón, color, piso…" maxlength="200" style="margin-top:9px"></textarea>
<div class="acct-mlabel">Guardar como</div>
<div class="acct-lchips" id="acct-cp-lchips">
  <button type="button" class="acct-lchip acct-on" data-label="Casa">${ICON_HOUSE}Casa</button>
  <button type="button" class="acct-lchip" data-label="Trabajo">${ICON_WORK}Trabajo</button>
  <button type="button" class="acct-lchip" data-label="">${ICON_TAG}Otra</button>
</div>
<input type="text" id="acct-cp-label" class="acct-label-custom-inp" placeholder="Ponle un nombre…" maxlength="40" style="margin-top:10px;display:none"/>
<p class="acct-field-hint" id="acct-cp-err" style="display:none;color:#B23B3B"></p>
<button type="button" class="acct-cta" id="acct-cp-save" disabled>Guardar perfil</button>`;
    showPane('createprofile');
    wireCreateProfilePane();
    renderAcctMapPreview('acct-cp-preview');
    refreshCreateProfileCta();
  }

  function wireCreateProfilePane() {
    const chips = $('acct-cp-lchips');
    if (chips) chips.querySelectorAll('.acct-lchip').forEach((chip) => {
      chip.onclick = () => {
        chips.querySelectorAll('.acct-lchip').forEach((c) => c.classList.remove('acct-on'));
        chip.classList.add('acct-on');
        const custom = $('acct-cp-label'); const val = chip.getAttribute('data-label');
        if (val) { _acctCpLabel = val; if (custom) custom.style.display = 'none'; }
        else { if (custom) { custom.style.display = ''; custom.value = ''; custom.focus(); } _acctCpLabel = ''; }
        refreshCreateProfileCta();
      };
    });
    ['acct-cp-first','acct-cp-last','acct-cp-details','acct-cp-label'].forEach((id) => {
      const el = $(id); if (el) el.addEventListener('input', () => { if (id === 'acct-cp-label') _acctCpLabel = el.value.trim(); refreshCreateProfileCta(); });
    });
    const save = $('acct-cp-save'); if (save) save.onclick = saveCreateProfilePane;
  }

  // Returns {ok:true, first, last, details, label} or {ok:false, msg, focus}. Pure read of the
  // pane — no side effects. Used by BOTH the live CTA-enable AND the submit-time re-check (codex
  // R1 #3) so no field can be bypassed via paste/autofill/Enter/double-click/programmatic.
  function validateCreateProfile() {
    const first = (($('acct-cp-first') || {}).value || '').trim();
    const last  = (($('acct-cp-last')  || {}).value || '').trim();
    const details = (($('acct-cp-details') || {}).value || '').trim();
    const label = _acctCpLabel;
    if (!first) return { ok: false, msg: 'Agregá tu nombre.', focus: 'acct-cp-first' };
    if (!last)  return { ok: false, msg: 'Agregá tu apellido.', focus: 'acct-cp-last' };
    if (typeof _nadLat !== 'number' || typeof _nadLng !== 'number' || !isFinite(_nadLat) || !isFinite(_nadLng) || !_nadDetected || !_nadPinTouched)
      return { ok: false, msg: 'Marcá tu ubicación en el mapa (tocá el mapa y ajustá el pin).' };
    if (details.length < 3) return { ok: false, msg: 'Agregá una referencia — portón, color, piso…', focus: 'acct-cp-details' };
    if (!label) return { ok: false, msg: 'Elegí cómo guardar la dirección.', focus: 'acct-cp-label' };
    return { ok: true, first, last, details, label };
  }

  function refreshCreateProfileCta() {
    const btn = $('acct-cp-save'); if (!btn) return;
    btn.disabled = !validateCreateProfile().ok;
  }

  // Save the login-sheet Creá tu perfil. Mirrors the checkout create pattern: a THROWING name
  // write (never saveName(), which swallows failures — codex R1 #2), then the hardened saveAddress,
  // then a live re-confirm of profileComplete before declaring success (codex R1 #7). Named
  // distinctly from the checkout saveCreateProfile() to avoid the same-scope collision.
  async function saveCreateProfilePane() {
    const errEl = $('acct-cp-err'); if (errEl) errEl.style.display = 'none';
    const v = validateCreateProfile();                          // submit-time re-validate ALL (codex R1 #3)
    if (!v.ok) { if (errEl) { errEl.style.display = 'block'; errEl.textContent = v.msg; } const f = v.focus && $(v.focus); if (f) f.focus(); return; }
    const btn = $('acct-cp-save'); if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
    const fullName = (v.first + ' ' + v.last).trim().slice(0, 80);

    // 1) name — THROWING write (never saveName(), which swallows failures — codex R1 #2)
    try {
      const { auth, db, dbMod } = await ensureFirebase();
      await auth.authStateReady();
      if (!auth.currentUser) { heal(); throw new Error('no-session'); }
      await dbMod.update(dbMod.ref(db, 'user_profiles/' + auth.currentUser.uid), { name: fullName });
      const m = marker(); if (m) { m.name = fullName; try { localStorage.setItem(CONFIG.MARKER, JSON.stringify(m)); } catch (_) {} }
    } catch (_) {
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'No pudimos guardar tu nombre. Intentá de nuevo.'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar perfil'; }
      return;
    }

    // 2) address — the hardened writer (rejects empty label/details<3/empty detected/non-numeric)
    const res = await saveAddress({ label: v.label, detected: _nadDetected, details: v.details, lat: _nadLat, lng: _nadLng, makeDefault: true });
    if (!res.ok) {
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = res.message || 'No pudimos guardar la dirección. Intentá de nuevo.'; }
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar perfil'; }
      return;
    }

    // 3) re-confirm the LIVE predicate before declaring success (codex R1 #7)
    const st = await accountSnapshotStatus();
    if (st.status === 'ok' && profileComplete(st.snap)) {
      _acctData = st.snap;
      renderChip();
      toast('Perfil creado');
      closeSheet();
      try { wrapPageHooks(); initDeliveryStep().catch(() => {}); } catch (_) {}   // reflect completeness THIS load
      return;
    }
    // writes persisted but re-read is unavailable or still-incomplete → do NOT claim success;
    // fail-open to Mi Cuenta (checkout re-enforces complete-before-pay).
    _acctData = (st.status === 'ok') ? st.snap : _acctData;
    renderAccountPane(); showPane('account');
    if (st.status === 'unavailable') toast('Guardado. Verificá tu conexión.');
  }

  // Teardown on close: bump the map-session epoch so any late reverse-geocode from this pane's
  // fullscreen map is invalidated (codex R1 #5), and reset the account-only _nad* sink. The
  // fullscreen twin's own map/geocoder instances (acctFsMap) are cached-and-reused across opens,
  // matching the host form's fullscreen-map pattern (never destroyed).
  function closeNewAddressPane() {
    _acctFsEpoch++;                    // invalidate any late geocode from this pane's map
    _nadLat = null; _nadLng = null; _nadDetected = ''; _nadPinTouched = false;
    showPane('account');
  }

  async function saveNewAddressFromPane() {
    const btn = $('acct-nad-save-btn');
    const errEl = $('acct-nad-err');
    if (errEl) errEl.style.display = 'none';

    const details = ($('acct-nad-details') || {}).value || '';
    const label = (($('acct-nad-label') || {}).value || '').trim();

    // Re-validates INSIDE the handler — the account-map values ONLY, never placeAccountPin/
    // checkout gmap/lat/lng/__restorePos (spec R1 #4).
    if (typeof _nadLat !== 'number' || typeof _nadLng !== 'number' || !isFinite(_nadLat) || !isFinite(_nadLng) || !_nadDetected) {
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Confirmá la ubicación en el mapa.'; }
      return;
    }
    if (!_nadPinTouched) {   // the pin is still the fallback/GPS starting view — require a deliberate placement (FIX 2)
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Ubicá tu dirección en el mapa (arrastrá o tocá el pin).'; }
      return;
    }
    if (details.trim().length < 3) {
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Agregá una referencia — portón, color, piso…'; }
      $('acct-nad-details')?.focus();
      return;
    }
    if (!label) {
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Elegí cómo guardar esta dirección.'; }
      return;
    }

    if (btn) { btn.disabled = true; btn.innerHTML = 'Guardando…'; }
    const hadNoAddresses = !(_acctData && _acctData.addresses && Object.keys(_acctData.addresses).length);
    const res = await saveAddress({ label, detected: _nadDetected, details, lat: _nadLat, lng: _nadLng, makeDefault: hadNoAddresses });
    if (!res.ok) {
      if (errEl) { errEl.style.display = 'block'; errEl.textContent = res.message || 'No pudimos guardar la dirección. Intentá de nuevo.'; }
      if (btn) { btn.disabled = false; btn.innerHTML = ICON_CHECK_BIG + ' Guardar dirección'; }
      return;
    }

    if (!_acctData) _acctData = {};
    if (!_acctData.addresses) _acctData.addresses = {};
    _acctData.addresses[res.addrId] = { label, detected: _nadDetected, details, lat: _nadLat, lng: _nadLng };
    if (hadNoAddresses) _acctData.default_address = res.addrId;
    toast('Dirección guardada');
    closeNewAddressPane();
    renderAddressesSection();   // Mi Cuenta's list, new one shown
  }

  // ── Sign-out / delete-account: revert the form back to the pristine guest state ──
  function revertToGuestForm() {
    setPaymentVisible(true);   // sign-out → guest form, payment visible (FIX 1)
    _acctData = null; _acctAddrId = null; _acctCardActive = false; _acctEditMode = false;
    _acctEditIsNew = false; _acctAddrUnsaved = false; _acctSaveToggleOn = true; _acctAddrOneOff = false;
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

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Task 2 — "Creá tu perfil": logged-in + !profileComplete, no-skip. Reachable ONLY from
  // initDeliveryStep()/applyProfileState(), themselves reachable ONLY behind marker() (the
  // DOMContentLoaded gate at the bottom). A guest never runs a byte of this.
  // ══════════════════════════════════════════════════════════════════════════════════════════

  function injectCreateProfileStyles() {
    if ($('acct-cp-styles')) return;
    const st = document.createElement('style');
    st.id = 'acct-cp-styles';
    // T7 — the name-capture field reads more substantial at ~58px with a radius that softens
    // toward the phone field's own rounding, rather than the sheet's tighter 8px squared corner.
    st.textContent = `
.acct-cp-card{border:1px solid #E2D8C8;border-radius:20px;overflow:hidden;background:#fff;box-shadow:0 12px 30px -18px rgba(40,28,12,.3);padding:15px;margin-bottom:4px}
.acct-cp-phonerow{display:flex;align-items:center;justify-content:space-between;height:52px;padding:0 14px;border:1.5px solid #EDE5D9;border-radius:13px;background:#FBF6EE;color:#17130F;margin-bottom:14px}
.acct-cp-phoneval{font-size:15.5px;font-weight:650;font-variant-numeric:tabular-nums}
.acct-cp-verified{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;color:#2A6A42}
.acct-cp-two{display:flex;gap:10px}
.acct-cp-inp{flex:1;min-width:0;height:58px;padding:0 15px;border:1.5px solid #E2D8C8;border-radius:12px;background:#fff;font-size:16px;font-weight:550;color:#17130F;outline:none;font-family:inherit}
.acct-cp-inp:focus{border-color:#17130F}
.acct-cp-inp::placeholder{color:#B3A594;font-weight:450}
`;
    document.head.appendChild(st);
  }

  // Best-effort prefill for a returning-but-incomplete-profile customer who already has SOME
  // saved address (possibly missing a valid reference/lat-lng — a legacy record, or one this
  // session hasn't finished yet). Unlike pickDefaultAddress(), this does NOT filter for validity —
  // it's purely a "don't make them start from zero" convenience; saveCreateProfile() re-validates
  // everything before persisting regardless of what was prefilled.
  function pickPartialAddress(snap) {
    if (!snap || !snap.addresses) return null;
    const ids = Object.keys(snap.addresses);
    if (!ids.length) return null;
    const id = (snap.default_address && snap.addresses[snap.default_address]) ? snap.default_address : ids[0];
    const a = snap.addresses[id];
    if (!a) return null;
    return Object.assign({ id }, a);
  }

  // s2 side of Creá tu perfil: the normal fillable address fields (map/geocode unchanged) PLUS a
  // REQUIRED "Guardar como" label picker (this profile isn't complete without one) wired to
  // saveCreateProfile — reuses the existing injectLabelPicker scaffolding via its opts extension.
  function applyCreateProfileAddressUI(snap) {
    if (pageOrderType() !== 'delivery') return;   // pickup needs no address — out of scope (spec)
    const addrSection = addrSectionEl();
    if (!addrSection) return;
    addrSection.style.display = '';
    const partial = pickPartialAddress(snap);
    if (partial) {
      if (typeof partial.detected === 'string') setVal('address-detected', partial.detected);
      if (typeof partial.details === 'string') setVal('address-details', partial.details);
      if (typeof partial.lat === 'number' && typeof partial.lng === 'number') placeAccountPin(partial.lat, partial.lng);
    }
    _acctEditIsNew = !(partial && partial.id);
    _acctAddrId = (partial && partial.id) || null;
    _acctEditLabel = (partial && partial.label) || '';
    injectLabelPicker(addrSection, { ctaText: 'Guardar y continuar', onSave: saveCreateProfile, showCancel: false });
  }

  // s1 side of Creá tu perfil: phone (read-only + verificado, never asked again) + Nombre +
  // Apellido as TWO separate inputs. #raw-name-phone (the single #cname field) is hidden but its
  // inputs stay in the DOM, kept live-synced from nombre+apellido — this is the ONLY reason
  // goToLocation()/buildOrder() (byte-identical, unmodified) keep working untouched.
  function applyCreateProfileFlow(snap) {
    injectDeliverStyles();
    injectCreateProfileStyles();
    const mount = $('acct-deliver'); if (!mount) { refreshSaveToggle(); return; }   // host form has no mount — never touch anything
    const m = marker() || {};
    const phone = (snap && snap.phone) || m.phone || '';
    // Prefer whatever is CURRENTLY typed into #cname (e.g. the customer typed a full name, then
    // toggled to pickup and back — #cname was live-synced and never cleared) over the last-saved
    // snapshot name, so a re-render of this card never silently drops in-progress input.
    const liveCname = (($('cname') || {}).value || '').trim();
    const existingName = liveCname || ((snap && snap.name) || m.name || '').trim();
    const parts = existingName.split(/\s+/).filter(Boolean);
    const nombreVal = parts[0] || '';
    const apellidoVal = parts.slice(1).join(' ') || '';

    mount.innerHTML = `
<div class="acct-eyebrow">Creá tu perfil</div>
<div class="acct-cp-card">
  <div class="acct-cp-phonerow"><span class="acct-cp-phoneval">${escapeHtml(phone)}</span><span class="acct-cp-verified">${ICON_CHECK_SM} Verificado</span></div>
  <div class="acct-cp-two">
    <input type="text" id="acct-cp-nombre" class="acct-cp-inp" placeholder="Nombre" maxlength="40" value="${escapeHtml(nombreVal)}" autocomplete="given-name">
    <input type="text" id="acct-cp-apellido" class="acct-cp-inp" placeholder="Apellido" maxlength="40" value="${escapeHtml(apellidoVal)}" autocomplete="family-name">
  </div>
  <p class="acct-field-hint" id="acct-cp-name-err" style="display:none;color:#B23B3B;margin-top:8px"></p>
</div>`;

    const rawWrap = $('raw-name-phone'); if (rawWrap) rawWrap.style.display = 'none';

    const syncName = () => {
      const n = (($('acct-cp-nombre') || {}).value || '');
      const a = (($('acct-cp-apellido') || {}).value || '');
      setVal('cname', (n + ' ' + a).trim());
      const err = $('acct-cp-name-err'); if (err) err.style.display = 'none';
    };
    const nInp = $('acct-cp-nombre'), aInp = $('acct-cp-apellido');
    if (nInp) nInp.addEventListener('input', syncName);
    if (aInp) aInp.addEventListener('input', syncName);
    syncName();
    if (typeof window.__applyPhoneRaw === 'function') window.__applyPhoneRaw(phone); else setVal('cphone', phone);

    applyCreateProfileAddressUI(snap);
    setPaymentVisible(false);   // hide payment until "Guardar y continuar" saves the profile (FIX 1)
  }

  // "Guardar y continuar" (spec R1 #3 — no-skip): re-validates EVERY field INSIDE the handler,
  // never trusting a disabled-CTA UI state alone (covers Enter, autofill timing, double-click,
  // programmatic calls) — before any update({name})/saveAddress()/stage change. saveAddress()
  // itself (Task 1) independently rejects an invalid persist regardless of this handler.
  async function saveCreateProfile() {
    const btn = $('acct-save-addr-btn');
    const pickerErr = $('acct-label-picker-err');
    if (pickerErr) pickerErr.style.display = 'none';

    const nombre = (($('acct-cp-nombre') || {}).value || '').trim();
    const apellido = (($('acct-cp-apellido') || {}).value || '').trim();
    if (!nombre || !apellido) {
      const err = $('acct-cp-name-err');
      if (err) { err.style.display = 'block'; err.textContent = 'Ingresá tu nombre y apellido.'; }
      (nombre ? $('acct-cp-apellido') : $('acct-cp-nombre'))?.focus();
      return;
    }
    const detected = ($('address-detected') || {}).value || '';
    const details = ($('address-details') || {}).value || '';
    const { lat: curLat, lng: curLng } = pageLatLng();
    const label = (($('acct-label-custom') || {}).value || _acctEditLabel || '').trim();

    if (typeof curLat !== 'number' || typeof curLng !== 'number' || !isFinite(curLat) || !isFinite(curLng) || !detected) {
      if (pickerErr) { pickerErr.style.display = 'block'; pickerErr.textContent = 'Confirmá tu ubicación en el mapa.'; }
      return;
    }
    if (details.trim().length < 3) {
      const df = $('address-details'); if (df) df.focus();
      if (pickerErr) { pickerErr.style.display = 'block'; pickerErr.textContent = 'Agregá una referencia — portón, color, piso…'; }
      return;
    }
    if (!label) {
      if (pickerErr) { pickerErr.style.display = 'block'; pickerErr.textContent = 'Elegí cómo guardar esta dirección.'; }
      return;
    }

    if (btn) { btn.disabled = true; btn.innerHTML = 'Guardando…'; }
    const fullName = (nombre + ' ' + apellido).trim().slice(0, 80);

    try {
      const { auth, db, dbMod } = await ensureFirebase();
      await auth.authStateReady();
      if (!auth.currentUser) { heal(); throw new Error('no-session'); }
      await dbMod.update(dbMod.ref(db, 'user_profiles/' + auth.currentUser.uid), { name: fullName });
      if (!_acctData) _acctData = {};
      _acctData.name = fullName;
      const m = marker(); if (m) { m.name = fullName; try { localStorage.setItem(CONFIG.MARKER, JSON.stringify(m)); } catch (_) {} }
      renderChip();
    } catch (_) {
      // Non-blocking is the wrong call HERE specifically — a failed name write means the profile
      // will still read as incomplete next time, so surface it and let the customer retry rather
      // than silently proceeding as if it worked (the address save below hasn't run yet either).
      if (pickerErr) { pickerErr.style.display = 'block'; pickerErr.textContent = 'No pudimos guardar tu nombre. Intentá de nuevo.'; }
      if (btn) { btn.disabled = false; btn.innerHTML = ICON_CHECK_BIG + ' Guardar y continuar'; }
      return;
    }

    const addrIdForSave = _acctEditIsNew ? undefined : _acctAddrId;
    const res = await saveAddress({ addrId: addrIdForSave, label, detected, details, lat: curLat, lng: curLng, makeDefault: true });
    if (!res.ok) {
      if (pickerErr) { pickerErr.style.display = 'block'; pickerErr.textContent = res.message || 'No pudimos guardar la dirección. Intentá de nuevo.'; }
      if (btn) { btn.disabled = false; btn.innerHTML = ICON_CHECK_BIG + ' Guardar y continuar'; }
      return;
    }

    if (!_acctData.addresses) _acctData.addresses = {};
    _acctData.addresses[res.addrId] = { label, detected, details, lat: curLat, lng: curLng };
    _acctData.default_address = res.addrId;
    _acctAddrId = res.addrId;
    exitEditMode();
    toast('Perfil guardado');
    // Profile is NOW complete (name + address both just wrote successfully) — collapse into the
    // same reduced 2-step "Entregar a" experience a returning user gets, for the rest of this
    // order (refreshDeliveryUI re-derives + re-checks the invariant fresh; never assumes).
    refreshDeliveryUI(Object.assign({ id: res.addrId }, _acctData.addresses[res.addrId]));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Task 3 — complete-profile returning flow: cart → pay (3→2 steps), "Entregar a" summary atop
  // payment. Reachable ONLY from initDeliveryStep()/refreshDeliveryUI(), themselves reachable
  // ONLY behind marker() (the DOMContentLoaded gate at the bottom). ALL of it is additionally
  // gated on profileComplete(_acctData) at the call site — a guest, or a logged-in customer whose
  // LIVE snapshot isn't confirmed complete, never reaches any function in this section.
  // ══════════════════════════════════════════════════════════════════════════════════════════

  let _acctReducedActive = false;   // true while the Task 3 2-step "Entregar a" summary is showing

  function injectCompactSummaryStyles() {
    if ($('acct-compact-styles')) return;
    const st = document.createElement('style');
    st.id = 'acct-compact-styles';
    st.textContent = `
.acct-compact{display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid #EDE5D9;border-radius:14px;background:#FBF6EE;margin-bottom:4px}
.acct-compact .acct-cav{width:30px;height:30px;border-radius:50%;background:#F0E8DA;color:#2A231C;display:flex;align-items:center;justify-content:center;flex:none}
.acct-compact .acct-ctxt{flex:1;min-width:0;font-size:13.5px;color:#17130F;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acct-compact .acct-ctxt b{font-weight:700}
`;
    document.head.appendChild(st);
  }

  // Map-timing (spec R2 / codex R2) — gmap isn't initialized until s2 (goToLocation→initMap), and
  // placeAccountPin() only sets the checkout lat/lng when gmap already exists (else it stashes
  // __restorePos for later). The invariant re-check below must run against ACTUALLY-ESTABLISHED
  // values, never a pending __restorePos — so set the bare page globals DIRECTLY from the saved
  // address here, and ALSO prime __restorePos so a later map init (e.g. via Cambiar) shows the
  // right pin instead of re-geolocating.
  function establishCheckoutFromAddress(addr) {
    if (!addr || typeof addr.lat !== 'number' || typeof addr.lng !== 'number') return;
    try {
      lat = addr.lat; lng = addr.lng;   // bare page globals — shared lexical scope (see pageLatLng/placeAccountPin)
      __restorePos = { lat: addr.lat, lng: addr.lng };
      if (typeof checkDeliveryRadius === 'function') checkDeliveryRadius(addr.lat, addr.lng);   // establishes isWithinDeliveryZone for the check below
    } catch (_) { /* fail-open — reducedFlowInvariantOk reads back whatever actually landed and falls back if it's not numeric */ }
  }

  // Populate the EXISTING order-submit fields from the saved address. The reduced flow HIDES these fields,
  // so they MUST be filled or the unchanged processPayment()/buildOrder() would read empties → a returning
  // complete-profile delivery user could not check out (details<3 error on a hidden field). Mirrors the
  // legacy renderConfirmCard; name/phone derived from snap+marker() exactly as renderS2RichSummary.
  function populateOrderFieldsFromAddress(snap, addr) {
    if (!addr) return;
    _acctAddrOneOff = false;   // a persisted/default address is populating the order — NOT a use-once (covers the reduced flow + every save→refreshDeliveryUI path) (FIX B)
    const m = marker() || {};
    const name = (snap && snap.name) || m.name || '';
    const phone = (snap && snap.phone) || m.phone || '';
    setVal('cname', name);
    if (typeof window.__applyPhoneRaw === 'function') window.__applyPhoneRaw(phone); else setVal('cphone', phone);
    setVal('address-detected', addr.detected);
    setVal('address-details', addr.details);
  }

  // The LOCAL invariant re-check (spec R1 #2): non-empty first+last name, phone, address-detected,
  // numeric lat/lng, IN delivery zone, details>=3 — evaluated against whatever is ACTUALLY
  // established at call time (never assumes establishCheckoutFromAddress succeeded).
  function reducedFlowInvariantOk(snap, addr) {
    try {
      const nameOk = String((snap && snap.name) || '').trim().split(/\s+/).filter(Boolean).length >= 2;
      const phoneOk = !!((snap && snap.phone) || (marker() || {}).phone);
      const detectedOk = !!(addr && typeof addr.detected === 'string' && addr.detected.trim().length > 0);
      const detailsOk = !!(addr && typeof addr.details === 'string' && addr.details.trim().length >= 3);
      // Read back the ACTUAL hidden submit fields — these (not the snapshot) are what buildOrder submits,
      // so the section must never be hidden over an empty/short one (codex re-gate FIX 3).
      const domDetailsOk = (($('address-details') || {}).value || '').trim().length >= 3;
      const domNameOk = (($('cname') || {}).value || '').trim().length > 0;
      const domDetectedOk = (($('address-detected') || {}).value || '').trim().length > 0;
      const domPhoneOk = (($('cphone') || {}).value || '').replace(/\D/g, '').length >= 8;
      const { lat: la, lng: ln } = pageLatLng();
      const latlngOk = typeof la === 'number' && isFinite(la) && typeof ln === 'number' && isFinite(ln);
      let zoneOk = true;
      try { zoneOk = (typeof isWithinDeliveryZone !== 'undefined') ? !!isWithinDeliveryZone : true; } catch (_) { zoneOk = true; }
      return nameOk && phoneOk && detectedOk && detailsOk && domDetailsOk && domNameOk && domDetectedOk && domPhoneOk && latlngOk && zoneOk;
    } catch (_) { return false; }
  }

  // Toggle the step-label TEXT ONLY (progress-bar % is untouched — it's driven per-call-site by
  // the existing showStage()/goBack() calls, not by label text) between "de 3" (default/
  // guest-identical) and "de 2" (reduced — ONLY ever applied behind marker()+confirmed-complete-
  // profile). Reversible — the fail-open paths and T6's pickup toggle call this with toTwo=false.
  function relabelSteps(toTwo) {
    const l1 = $('step-label-s1'), l2 = $('step-label-s2');
    if (l1) l1.textContent = toTwo ? 'Paso 1 de 2 — Tu pedido' : 'Paso 1 de 3 — Tu pedido';
    if (l2) l2.textContent = toTwo ? 'Paso 2 de 2 — Pago' : 'Paso 2 de 3 — Entrega & Pago';
  }

  function shortAddrLine(addr) {
    if (!addr) return '';
    return (addr.details && addr.details.trim()) || (addr.detected || '').split(',')[0] || addr.detected || '';
  }

  // s1's compact "Entregar a … · Cambiar" line (raw name/phone hidden) — replaces the raw fields
  // in the SAME #acct-deliver mount. Cambiar opens the Task 4 two-action chooser.
  function renderS1CompactSummary(snap, addr) {
    injectDeliverStyles();
    injectCompactSummaryStyles();
    const mount = $('acct-deliver'); if (!mount) return;
    mount.innerHTML = `
<div class="acct-eyebrow">Entregar a</div>
<div class="acct-compact">
  <span class="acct-cav">${PERSON_SVG}</span>
  <span class="acct-ctxt"><b>${escapeHtml(addr.label || 'Guardado')}</b> · ${escapeHtml(shortAddrLine(addr))}</span>
  <button class="acct-change" type="button" id="acct-change-btn-s1">Cambiar</button>
</div>`;
    const btn = $('acct-change-btn-s1'); if (btn) btn.onclick = openCambiarPanel;
  }

  // The rich "Entregar a" summary ATOP s2's payment (above "Forma de pago") — reuses the same
  // card markup as the legacy renderConfirmCard via deliverCardHtml (byte-identical visuals).
  function renderS2RichSummary(snap, addr) {
    injectDeliverStyles();
    const mount = $('acct-s2-summary'); if (!mount) return;
    const m = marker() || {};
    const name = (snap && snap.name) || m.name || '';
    const phone = (snap && snap.phone) || m.phone || '';
    mount.innerHTML = `<div class="acct-eyebrow">Entregar a</div>` + deliverCardHtml(name, phone, addr, 'acct-change-btn-s2');
    const btn = $('acct-change-btn-s2'); if (btn) btn.onclick = openCambiarPanel;
  }

  function hideRawAndAddrSection() {
    const rawWrap = $('raw-name-phone'); if (rawWrap) rawWrap.style.display = 'none';
    const addrSection = addrSectionEl(); if (addrSection) addrSection.style.display = 'none';
  }

  // Payment-section visibility (codex re-gate FIX 1) — hidden ONLY while "Creá tu perfil" is active
  // (logged-in + incomplete + delivery) so a first-time user can't skip the profile save and pay.
  // Shown in EVERY other state. A guest never calls this; the id/class toggles are inert otherwise. Idempotent.
  function setPaymentVisible(show) {
    // Payment hidden ⇔ "Creá tu perfil" is actively on screen (its the ONLY caller of setPaymentVisible(false),
    // via applyCreateProfileFlow). The submit-gate keys off THIS explicit flag — never a profileComplete()
    // inference — so a failed/slow snapshot (→ normal fillable, payment shown) stays fail-open (FIX A).
    _acctCreateProfileActive = !show;
    const lbl = $('acct-pay-label'); if (lbl) lbl.style.display = show ? '' : 'none';
    try { const pc = document.querySelector('.pay-container'); if (pc) pc.style.display = show ? '' : 'none'; } catch (_) {}
  }

  // Submit-choke gate (codex re-gate FIX 1, defense-in-depth) — block a LOGGED-IN DELIVERY submit when the
  // profile isn't complete/saved (covers DOM tampering / payment somehow reachable). Guest + complete +
  // pickup → false (unaffected). Fail-open: any error → false (never block a real order). Called from
  // processPayment().
  function deliverySubmitBlocked() {
    try {
      // Gate ONLY while the create-profile step is genuinely on screen (explicit flag set inside
      // applyCreateProfileFlow via setPaymentVisible(false)). Guest / complete / pickup, OR a failed/slow
      // snapshot that fell back to the normal fillable form (payment shown → flag false), all proceed —
      // FAIL-OPEN (FIX A). processPayment's own lat/lng/zone/details checks still apply as defense-in-depth.
      if (!_acctCreateProfileActive) return false;
      const err = $('acct-label-picker-err') || $('acct-cp-name-err');
      if (err) { err.style.display = 'block'; err.textContent = 'Guardá tu perfil para continuar.'; }
      const btn = $('acct-save-addr-btn'); if (btn) { try { btn.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {} }
      return true;
    } catch (_) { return false; }
  }

  // The fail-open reversion: restore the guest-identical fillable DOM (raw fields visible, address
  // section visible for delivery, step labels back to "de 3"), and clear the Task 3 summary mounts.
  // Safe/idempotent to call anytime — a fresh page load where nothing was ever hidden is a no-op
  // beyond the label/mount resets.
  function revertToNormalFillable() {
    _acctReducedActive = false;
    relabelSteps(false);
    const s2mount = $('acct-s2-summary'); if (s2mount) s2mount.innerHTML = '';
    const mount = $('acct-deliver'); if (mount) mount.innerHTML = '';
    const rawWrap = $('raw-name-phone'); if (rawWrap) rawWrap.style.display = '';
    const addrSection = addrSectionEl();
    if (addrSection) { addrSection.style.display = (pageOrderType() === 'delivery') ? '' : 'none'; }
    const picker = $('acct-label-picker'); if (picker) picker.remove();
  }

  // Central re-render dispatcher for every "an address just changed mid-session" call site (Mi
  // Cuenta's address-list tap, delete-fallback, Cambiar's "Guardar dirección" success, Cancelar).
  // Re-derives + re-checks the invariant fresh every time — NEVER assumes the caller already
  // validated anything. Complete + invariant-ok → Task 3 reduced flow; anything else → Task 2's
  // Creá-tu-perfil-style fillable flow (which itself degrades gracefully to a plain fillable form
  // when there's nothing to prefill).
  function refreshDeliveryUI(addrOverride) {
    if (_acctRestoring) return;   // a payment-retry restore owns the DOM — the snapshot's address is authoritative, never overwrite it with the default (FIX 7 / R4)
    setPaymentVisible(true);   // default reveal; the incomplete create-profile branch re-hides it (FIX 1)
    if (!_acctData) return;
    if (pageOrderType() !== 'delivery') { hidePickupDeliverySummary(); return; }
    if (profileComplete(_acctData)) {
      const addr = addrOverride || pickDefaultAddress(_acctData);
      if (addr) {
        establishCheckoutFromAddress(addr);
        populateOrderFieldsFromAddress(_acctData, addr);   // fill the (soon-hidden) submit fields BEFORE the invariant reads them back
        if (reducedFlowInvariantOk(_acctData, addr)) {
          renderS1CompactSummary(_acctData, addr);
          renderS2RichSummary(_acctData, addr);
          relabelSteps(true);
          _acctReducedActive = true;
          _acctAddrId = addr.id;
          hideRawAndAddrSection();
          return;
        }
      }
    }
    _acctReducedActive = false;
    applyCreateProfileFlow(_acctData);
  }

  // Task 6 — pickup hides the delivery summary + drops delivery validation WITHOUT clearing
  // persisted/default data (_acctData / saved addresses are completely untouched — this only
  // touches DOM/UI state). Restores the raw name/phone fields (prefilled, editable) since pickup
  // needs no "Entregar a" summary at all.
  function hidePickupDeliverySummary() {
    setPaymentVisible(true);   // pickup always shows payment (FIX 1)
    _acctReducedActive = false;
    relabelSteps(false);
    const s2mount = $('acct-s2-summary'); if (s2mount) s2mount.innerHTML = '';
    const mount = $('acct-deliver'); if (mount) mount.innerHTML = '';
    const rawWrap = $('raw-name-phone'); if (rawWrap) rawWrap.style.display = '';
    const picker = $('acct-label-picker'); if (picker) picker.remove();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // Task 4 — Cambiar: TWO distinct actions from the returning-flow summary (spec "Cambiar (on the
  // returning payment summary)"). "Usar en este pedido" (pick a saved address → order fields
  // ONLY, no persist, no default change) vs "Guardar dirección" (edit/add → persists via the
  // EXISTING enterEditMode(true)/saveEditedAddress scaffolding, unchanged, makeDefault:true). No
  // silent default/profile mutation on a one-off. Reachable only via renderS1CompactSummary/
  // renderS2RichSummary's Cambiar buttons — themselves only ever rendered behind
  // marker()+profileComplete (Task 3).
  // ══════════════════════════════════════════════════════════════════════════════════════════

  function openCambiarPanel() {
    const mount = $('acct-s2-summary'); if (!mount) return;
    // Cambiar can be tapped from s1's compact line before s2 (and its map) has ever been shown —
    // jump there so the chooser (and, if "Usar una dirección nueva" is picked, the real map) is
    // visible. Name/phone are already known+valid at this point (that's the Task 3 invariant that
    // got us here), so bypassing goToLocation()'s own re-validation here is safe.
    try {
      const s2 = document.getElementById('s2');
      if (s2 && !s2.classList.contains('active') && typeof showStage === 'function') {
        showStage('s2', 50);
        setTimeout(() => { try { if (typeof initMap === 'function') initMap(); } catch (_) {} }, 100);
      }
    } catch (_) {}

    injectDeliverStyles();
    const addrs = (_acctData && _acctData.addresses) || {};
    const otherIds = Object.keys(addrs).filter((id) => id !== _acctAddrId);
    const rowsHtml = otherIds.map((id) => {
      const a = addrs[id];
      return `<div class="acct-acard" data-use-id="${escapeHtml(id)}">
  <span class="acct-dotmark" style="background:#CFC2B1"></span>
  <div class="acct-al2"><div class="acct-aname2">${escapeHtml(a.label || 'Dirección')}</div>
  <div class="acct-aline2">${escapeHtml(a.details || a.detected || '')}</div></div>
</div>`;
    }).join('');
    mount.innerHTML = `
<div class="acct-eyebrow">Cambiar dirección de entrega</div>
${rowsHtml || '<p class="acct-fine" style="text-align:left;margin:0 0 10px">No tenés otras direcciones guardadas.</p>'}
<button type="button" class="acct-addlink" id="acct-cambiar-new">+ Usar una dirección nueva</button>
<button type="button" class="acct-cancel-edit" id="acct-cambiar-cancel">‹ Cancelar</button>`;
    mount.querySelectorAll('[data-use-id]').forEach((row) => {
      row.onclick = () => selectSavedAddressForOrder(row.getAttribute('data-use-id'));
    });
    const newBtn = $('acct-cambiar-new');
    if (newBtn) newBtn.onclick = () => {
      mount.innerHTML = '';
      relabelSteps(false);
      _acctReducedActive = false;
      const rawWrap = $('raw-name-phone'); if (rawWrap) rawWrap.style.display = '';
      const addrSection = addrSectionEl();
      if (addrSection) addrSection.style.display = '';
      _acctAddrOneOff = true;   // use-once until the customer explicitly taps "Guardar dirección" (which clears it) (FIX B)
      enterEditMode(true);   // existing scaffolding — its "Guardar dirección" persists (makeDefault:true) + applies
      if (addrSection) setTimeout(() => addrSection.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    };
    const cancelBtn = $('acct-cambiar-cancel');
    if (cancelBtn) cancelBtn.onclick = () => refreshDeliveryUI();
    setTimeout(() => mount.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  }

  // "Usar en este pedido" — order fields ONLY, NO saveAddress() call, NO default_address change.
  function selectSavedAddressForOrder(addrId) {
    if (!_acctData || !_acctData.addresses || !_acctData.addresses[addrId]) return;
    const a = _acctData.addresses[addrId];
    _acctAddrId = addrId;   // backs THIS order only — _acctData.default_address is untouched
    _acctAddrOneOff = true;   // USE-ONCE: onOrderConfirmed must never persist/default this (FIX B)
    const addr = Object.assign({ id: addrId }, a);
    establishCheckoutFromAddress(addr);
    setVal('address-detected', a.detected);
    setVal('address-details', a.details);
    placeAccountPin(a.lat, a.lng);
    if (reducedFlowInvariantOk(_acctData, addr)) {
      renderS1CompactSummary(_acctData, addr);
      renderS2RichSummary(_acctData, addr);
      relabelSteps(true);
      _acctReducedActive = true;
      hideRawAndAddrSection();
      toast('Dirección actualizada para este pedido');
    } else {
      // FAIL-OPEN: this saved address fails the invariant right now (e.g. genuinely out of the
      // current delivery zone) — never leave a hidden-but-invalid summary standing; drop to the
      // normal fillable view so processPayment()'s own checks (and the customer's eyes) catch it.
      _acctReducedActive = false;
      relabelSteps(false);
      const rawWrap = $('raw-name-phone'); if (rawWrap) rawWrap.style.display = '';
      const addrSection = addrSectionEl(); if (addrSection) addrSection.style.display = '';
      const s2mount = $('acct-s2-summary'); if (s2mount) s2mount.innerHTML = '';
      toast('Esa dirección no está disponible ahora mismo — revisá el mapa.');
    }
  }

  function wrapPageHooks() {
    try {
      if (typeof window.setOrderType === 'function' && !window.setOrderType.__acctWrapped) {
        const orig = window.setOrderType;
        // Task 6 — re-run the completeness application on 'delivery' (reduced flow if still
        // complete+valid, else the normal fillable UI); 'pickup' hides the summary WITHOUT
        // touching persisted/default data (hidePickupDeliverySummary/refreshDeliveryUI own this).
        const wrapped = function (type) {
          orig(type);
          if (_acctRestoring) return;   // a payment-retry restore calls setOrderType to rebuild the base UI — the snapshot is authoritative, skip the account re-entry entirely (FIX 7 / R4)
          try {
            if (type === 'delivery') { refreshDeliveryUI(); } else { hidePickupDeliverySummary(); }
            applyCardVisibility(); refreshSaveToggle();
          } catch (_) {}
        };
        wrapped.__acctWrapped = true;
        window.setOrderType = wrapped;
      }
    } catch (_) {}
    try {
      if (typeof window.startAnotherOrder === 'function' && !window.startAnotherOrder.__acctWrapped) {
        const orig = window.startAnotherOrder;
        const wrapped = function () {
          orig();
          _acctEditMode = false; _acctAddrUnsaved = false; _acctSaveToggleOn = true; _acctAddrOneOff = false;
          try {
            // orig() reset lat/lng/address fields to blank for a fresh order — re-establish the
            // reduced-flow summary (or the fillable UI) for the NEW order, same as page load.
            if (pageOrderType() === 'delivery') { refreshDeliveryUI(); } else { hidePickupDeliverySummary(); }
            applyCardVisibility(); refreshSaveToggle();
          } catch (_) {}
        };
        wrapped.__acctWrapped = true;
        window.startAnotherOrder = wrapped;
      }
    } catch (_) {}
    // T2 no-skip: when the Creá-tu-perfil card is the active s1 UI, a blank/one-word name must
    // NEVER be allowed to advance past s1 — re-validated HERE (inside the wrapped function,
    // before the ORIGINAL goToLocation() ever runs), not just a disabled-CTA illusion. Guests
    // (and any complete-profile / no-card state) hit the `if` guard's false branch and fall
    // straight through to the ORIGINAL, byte-identical goToLocation().
    try {
      if (typeof window.goToLocation === 'function' && !window.goToLocation.__acctGuarded) {
        const orig = window.goToLocation;
        const wrapped = function () {
          if (marker() && $('acct-cp-nombre')) {
            const nombre = ($('acct-cp-nombre').value || '').trim();
            const apellido = ($('acct-cp-apellido').value || '').trim();
            if (!nombre || !apellido) {
              const err = $('acct-cp-name-err');
              if (err) { err.style.display = 'block'; err.textContent = 'Ingresá tu nombre y apellido.'; }
              (nombre ? $('acct-cp-apellido') : $('acct-cp-nombre')).focus();
              return;   // BLOCKED — the original goToLocation() never runs
            }
          }
          return orig.apply(this, arguments);
        };
        wrapped.__acctGuarded = true;
        window.goToLocation = wrapped;
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
  window.__ACCOUNT.profileComplete = profileComplete;
  window.__ACCOUNT.deleteAddress = deleteAddress;
  window.__ACCOUNT.onOrderConfirmed = onOrderConfirmed;
  window.__ACCOUNT.deliverySubmitBlocked = deliverySubmitBlocked;
  window.__ACCOUNT.captureDeliverySaveIntent = captureDeliverySaveIntent;
  window.__ACCOUNT.setRestoring = function (v) { try { _acctRestoring = !!v; if (v) _acctRestoreGen++; } catch (_) {} };   // index.html's restoreOrderForm() brackets its snapshot rebuild with this so the account refresh can't overwrite the retry's address with the default (FIX 7 / R4); bumping the gen on start lets an in-flight async init detect a restore that completed during its await (R5)
})();
