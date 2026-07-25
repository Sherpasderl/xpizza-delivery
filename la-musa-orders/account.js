/* account.js — User Profiles P0 (customer accounts). Self-contained; guest path never touches this
   beyond reading the localStorage marker. Firebase SDK is imported ONLY on login interaction (H8). */
(function () {
  'use strict';
  const CONFIG = {
    restaurant_id: 'la_musa',                 // 'x_pizza' | 'la_musa'
    brand: 'La Musa',
    accent: '#B61218',                        // rojo musa (X. Pizza: gold)
    OTP_URL:    'https://requestotp-m7syoovdsa-uc.a.run.app',
    VERIFY_URL: 'https://verifyotp-m7syoovdsa-uc.a.run.app',
    DELETE_URL: 'https://deleteaccount-m7syoovdsa-uc.a.run.app',
    fb: { apiKey:'AIzaSyDWFYrzHvaNnRZERbN8jIuAzkY85daFJXU', authDomain:'xpizza-delivery.firebaseapp.com',
          databaseURL:'https://xpizza-delivery-default-rtdb.firebaseio.com', projectId:'xpizza-delivery',
          messagingSenderId:'185867271616', appId:'1:185867271616:web:84bb37552b40c1d517dc25' },
    MARKER: 'lamusa_acct',                    // localStorage key (X. Pizza: 'xpizza_acct')
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

  // Chip CSS — ported from the locked account mockup (.chip/.av/.nm/.cv), brand-recolored via CONFIG.accent.
  // Injected once, purely local DOM/CSS — no network, safe for the guest fast-path.
  function injectChipStyles() {
    if ($('acct-chip-styles')) return;
    const st = document.createElement('style');
    st.id = 'acct-chip-styles';
    st.textContent = `
.header{position:relative}
.acct-chip-mount{position:absolute;top:14px;right:14px;z-index:2;display:flex}
.acct-chip{display:flex;align-items:center;gap:8px;background:#F5EFE4;border:1px solid #E2D8C8;border-radius:999px;padding:6px 12px 6px 8px;cursor:pointer;font-family:inherit;line-height:1}
.acct-chip--out{background:#FFFDFA}
.acct-chip .acct-av{width:26px;height:26px;border-radius:50%;background:${CONFIG.accent};color:#fff;display:flex;align-items:center;justify-content:center;flex:none}
.acct-chip--out .acct-av{background:#EDE5D9;color:#5b4f41}
.acct-chip .acct-nm{font-size:14px;font-weight:650;color:#17130F}
.acct-chip .acct-cv{color:#B3A594;font-size:11px}
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
.acct-sheet{width:100%;max-width:420px;max-height:92vh;background:#FFFDFA;border-radius:22px 22px 0 0;box-shadow:0 -20px 60px -20px rgba(40,28,12,.5);overflow:hidden;display:flex;flex-direction:column;font-family:inherit;animation:acct-up .28s cubic-bezier(.2,.7,.2,1)}
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
  }
  function closeSheet() {
    const ov = $('acct-overlay'); if (ov) ov.classList.remove('acct-open');
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

    const rows = document.createElement('div');
    rows.className = 'acct-rows';
    rows.innerHTML =   // static copy only — zero user values interpolated here
      '<div class="acct-row acct-soon"><div class="acct-rl"><span class="acct-rt">Mis direcciones</span>' +
      '<span class="acct-rd">Guardá tus direcciones favoritas</span></div><span class="acct-soon-tag">Pronto</span></div>' +
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
      if (!auth.currentUser) heal();
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

  window.__ACCOUNT = { CONFIG, ensureFirebase };   // internal handle for later tasks/tests
  window.__ACCOUNT.customerIdToken = customerIdToken;
})();
