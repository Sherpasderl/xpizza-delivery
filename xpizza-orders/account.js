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

  window.__ACCOUNT = { CONFIG, ensureFirebase };   // internal handle for later tasks/tests
})();
