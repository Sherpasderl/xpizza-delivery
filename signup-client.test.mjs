// PLAN-signup-email-social phase 1 — the CLIENT, through the REAL account.js of BOTH forms in jsdom (form-harness).
// Only the unreachable dependency is replaced: account.js's Firebase SDK (a dynamic https import) → a stateful fake
// (window.__FB_FAKE); the network is the stubbed fetch; GIS is a window.google stub. Cells per brand:
//   A  flow A (new, post-rollout): phone → code → email (owner hint pinned; "@" chips; 44px) → name + terms (Guardar gated
//      on terms) + promos → the name write AND completeProfile (exact body) → "¡Perfil creado!" only after both;
//   B  completeProfile refused → the error shows, nothing reported complete;
//   C  returning with this brand's terms → "¡Hola de nuevo!" (no write);
//   D  the claim branch: completeProfile BEFORE claimOrder, then the credited confirmation;
//   E  Google (flow B): button only when configured; googleStart → GIS initialize(nonce) → googleSignIn (unlinked) → "Tu
//      teléfono" → requestOtp / verifyOtp carry the ticket → linked → the email pane skipped, the Google name prefilled →
//      completeProfile with the Google email; a conflict drops the Google prefill (email pane, no Google name);
//   F  GIS script failure → "Google no está disponible acá"; a stale callback is ignored;
//   G  (advisor ruling (2)) checkout card, post-rollout nameless: "Guardar y continuar" opens the completion panes, keeps the
//      typed address, and saves it automatically after completeProfile; a dismissal saves nothing and the card stays;
//   I  (advisor ruling, train review P1) an unreadable / pending config, or legal_ready:false, is TODAY's flow (no panes, pay
//      never blocked); (codex r1 P1-3/P1-4) in an AFFIRMATIVELY active rollout a reload derives the pay / Mi cuenta gate from the
//      server and unreadable terms keep the panes;
//   K  (codex r2 #2) a linked Google mint ALREADY UNDERWAY when the phone is chosen: undone (signed out, no marker, no
//      afterLogin); a phone verify meanwhile waits for it and ends as the only session;
//   L  (codex r3 P1 + owner rulings r4/r7) a mint that NEVER settles doesn't wedge sign-in (bounded wait); one that resolves late
//      signs out, clears the marker and RELOADS the page (no repair); a logout meanwhile → signed out, no reload;
//   P  (owner ruling r7) the fresh page after the reload heals a marker left without an auth session; the next sign-in works;
//   M  (codex r3 P2) a superseded gate read (suSetGate('complete') meanwhile) never routes: no panes, pay proceeds;
//   I+ (codex r2 #4) pay during a PENDING restore read is refused only once the config affirmatively reports the rollout active
//      (a pending CONFIG read never blocks), then the panes open only if the resolved state requires them;
//   J  (codex r1 P2-7) Mi cuenta "Recibir promociones" → setPromos (a failure reverts);
//   Q  (codex cfgfix r1 P1) a config resolving ACTIVE while a started checkout awaits the location pick never aborts it (the
//      gate captured at processPayment's start); a stalled config BODY is a failed read (bounded, then retried);
//   H  LEGACY DIFFERENTIAL (advisor ruling (3)) vs the slice base's account.js — a legacy account, and (train review P1 + codex
//      cfgfix r1) a post-rollout account whose config read FAILS, never answers, stalls its body, or is not affirmatively
//      active (legal_ready:false, no rollout_at — also with Google configured), on login, the checkout card (incl. whether pay
//      is permitted) and Mi cuenta (no "Recibir promociones", no setPromos):
//      the same panes, the same request bodies (bar the one declared getSignupConfig read) and the same database writes, on
//      the login routes (named / nameless → (d)) and the checkout card (e).
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { loadForm, settle, serve, envelope, BRAND, counter, closeAll, res, OPEN } from './form-harness.mjs';

const { ok, count } = counter();
const BASE = 'fdf9d21c';
const ROLL = 1_700_000_000_000;
const SEAM = 'async function ensureFirebase() {';
const MARKER = { 'xpizza-orders': 'xpizza_acct', 'la-musa-orders': 'lamusa_acct' };
const LEGAL = { terms_url: 'https://legal.test/terminos', privacy_url: 'https://legal.test/privacidad' };
const CFG = (over = {}) => ({ ok: true, ...LEGAL, legal_ready: true, google_enabled: false, google_client_id: null, email_login_enabled: false, rollout_at: ROLL, ...over });
const HINT = 'Te enviamos ahí tu recibo y nuestras promociones.';

// ── a stateful fake of the Firebase surface account.js uses ──
function setPath(tree, path, v) {
  const ks = path.split('/').filter(Boolean); let o = tree;
  for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]]; }
  if (v === null) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = JSON.parse(JSON.stringify(v));
}
const getPath = (tree, path) => path.split('/').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), tree);
function fakeFirebase(st) {
  const snap = (v) => ({ exists: () => v != null, val: () => (v === undefined ? null : JSON.parse(JSON.stringify(v))) });
  const user = () => (st.uid ? { uid: st.uid, getIdToken: async () => 'idt:' + st.uid } : null);
  return { app: {}, db: {},
    auth: { get currentUser() { return user(); }, authStateReady: async () => {} },
    authMod: { signInWithCustomToken: async (a, tok) => { st.uid = String(tok).replace(/^tok:/, ''); }, onAuthStateChanged: (a, cb) => { cb(user()); return () => {}; }, signOut: async () => { st.uid = null; } },
    dbMod: { ref: (db, path) => ({ path: path || '' }), get: async (r) => snap(getPath(st.tree, r.path)),
      update: async (r, obj) => { st.writes.push({ op: 'update', path: r.path, obj }); for (const [k, v] of Object.entries(obj)) setPath(st.tree, r.path + '/' + k, v); },
      set: async (r, v) => { st.writes.push({ op: 'set', path: r.path, v }); setPath(st.tree, r.path, v); },
      remove: async (r) => { st.writes.push({ op: 'remove', path: r.path }); setPath(st.tree, r.path, null); },
      onValue: (r, cb) => { cb(snap(getPath(st.tree, r.path))); return () => {}; }, off: () => {} } };
}
const UID = 'u_' + 'a'.repeat(24);
const PROFILE = (over = {}) => ({ phone: '50499990000', phone_hash: 'ph', created_at: ROLL + 1000, last_login: ROLL + 1000, ...over });

// boot a form. opts: { cfg (object | 'fail'), profile, terms (bool), signedIn (marker), complete: {ok}|fn, verify (extra fields), google {...}, base (true = the slice base's account.js) }
async function boot(dir, opts = {}) {
  const src = opts.base ? execFileSync('git', ['show', `${BASE}:${dir}/account.js`], { encoding: 'utf8', maxBuffer: 1 << 26 }) : null;
  const marker = opts.signedIn ? `try { localStorage.setItem(${JSON.stringify(MARKER[dir])}, ${JSON.stringify(JSON.stringify({ uid: UID, name: opts.signedIn.name || '', phone: '+50499990000' }))}); } catch (_) {}\n` : '';
  const w = loadForm(dir, { transforms: { 'account.js': (code) => {
    const c = src || code;
    assert.strictEqual(c.split(SEAM).length, 2, 'premise: one ensureFirebase');
    let out = c.replace(SEAM, `${SEAM} if (window.__FB_FAKE) return window.__FB_FAKE;`);
    if (!opts.base) { const k = 'location.reload();'; assert.strictEqual(out.split(k).length, 2, 'premise: one reload (the forced sign-out)'); out = out.replace(k, 'window.__reloads = (window.__reloads || 0) + 1;'); }   // jsdom does not navigate: count it
    if (opts.authWait) { const k = 'const SU_AUTH_WAIT_MS = 8000;'; assert.strictEqual(out.split(k).length, 2, 'premise: the auth wait constant'); out = out.replace(k, `const SU_AUTH_WAIT_MS = ${opts.authWait};`); }
    if (opts.exposeGate) { const k = 'function suSetGate(g) {'; assert.strictEqual(out.split(k).length, 2, 'premise: suSetGate'); out = out.replace(k, `window.__suSetGate = (g) => suSetGate(g); ${k}`); }
    return marker + out;
  } } });
  const st = { uid: opts.signedIn && !opts.noSession ? UID : null, tree: { user_profiles: {}, user_private: {} }, writes: [] };
  if (opts.profile !== undefined) st.tree.user_profiles[UID] = opts.profile;
  if (opts.terms) st.tree.user_private[UID] = { consent: { [BRAND[dir].rid]: { terms: { version: 't', privacy_version: 'p', at: 1 }, promos: { value: false, copy_version: 'c', at: 1 } } } };
  w.__FB_FAKE = fakeFirebase(st);
  if (opts.profileFault) {   // 'once' = the first profile read throws; 'stall' = every profile read hangs
    const get0 = w.__FB_FAKE.dbMod.get; let n = 0;
    w.__FB_FAKE.dbMod.get = async (r) => { if (r.path === 'user_profiles/' + UID) { n++; if (opts.profileFault === 'stall') return new Promise(() => {}); if (n === 1) throw new Error('unavailable'); } return get0(r); };
  }
  if (opts.termsHold) { const get0 = w.__FB_FAKE.dbMod.get; w.__FB_FAKE.dbMod.get = async (r) => { if (/\/consent\//.test(r.path)) await opts.termsHold; return get0(r); }; }
  await settle();
  await serve(w, envelope(BRAND[dir].rid, BRAND[dir].menu(w)));
  const calls = [];
  w.__respond = (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    const headers = (init && init.headers) || {};
    calls.push({ url, body, headers });
    if (/getsignupconfig/.test(url) && opts.cfgHold) return opts.cfgHold.then(() => res(opts.cfg));
    if (/getsignupconfig/.test(url) && opts.cfg === 'pending') return new Promise(() => {});   // never answers
    if (/getsignupconfig/.test(url) && opts.cfg === 'stall') return Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) });   // headers, then a body that never arrives
    if (/getsignupconfig/.test(url)) return opts.cfg === 'fail' || opts.cfg === undefined ? Promise.reject(new Error('offline')) : res(opts.cfg);
    if (/requestotp/.test(url)) return res({ ok: true, cooldown: 30 });
    if (/verifyotp/.test(url)) {
      if (st.tree.user_profiles[UID] === undefined) st.tree.user_profiles[UID] = PROFILE();
      return res({ ok: true, token: 'tok:' + UID, is_new: false, name: (st.tree.user_profiles[UID] || {}).name || null, ...(typeof opts.verify === 'function' ? opts.verify(body) : (opts.verify || {})) });
    }
    if (/completeprofile/.test(url)) {
      const r = typeof opts.complete === 'function' ? opts.complete(body) : (opts.complete || { ok: true });
      if (r.ok) setPath(st.tree, `user_private/${UID}/consent/${BRAND[dir].rid}/terms`, { version: 't', privacy_version: 'p', at: 2 });
      return Promise.resolve({ ok: !!r.ok, status: r.ok ? 200 : 400, json: () => Promise.resolve(r) });
    }
    if (/setpromos/.test(url)) { const r = opts.promos || { ok: true }; return Promise.resolve({ ok: !!r.ok, status: r.ok ? 200 : 500, json: () => Promise.resolve(r) }); }
    if (/googlestart/.test(url)) return res({ ok: true, nonce: 'nonce-' + calls.filter((c) => /googlestart/.test(c.url)).length });
    if (/googlesignin/.test(url)) return res(opts.google && opts.google.signIn ? opts.google.signIn(body) : { ok: true, linked: false, ticket: 'ticket_' + 'x'.repeat(20), email: 'ana@gmail.com', name: 'Ana Google' });
    if (/claimOrder/.test(url)) return res({ ok: true, credited: true, delta: 2, unit: 'punch' });
    return new Promise(() => {});
  };
  return { w, st, calls, d: w.document, base: !!opts.base };
}
const waitFor = async (pred, label, ms = 4000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout: ' + label); await new Promise((r) => setTimeout(r, 15)); } };
const pane = (d) => { const p = d.querySelector('#acct-overlay .acct-pane.acct-on'); return p ? p.id : null; };
const type = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
async function phoneLogin({ w, d, calls, base }, { claim = null } = {}) {
  if (claim) w.__ACCOUNT.startProfileClaim(claim); else d.querySelector('#acct-chip button').click();
  await waitFor(() => pane(d) === 'acct-pane-phone', 'phone pane');
  // a customer types the code SECONDS after the sheet opens: the sheet's config read (started with the phone pane) has
  // landed. (Never waited on by the page — codex cfgfix r1; the slice base reads no config.)
  if (!base) { await waitFor(() => call(calls, /getsignupconfig/).length >= 1, 'the sheet reads the config'); await settle(); await settle(); }
  type(w, d.getElementById('acct-ph-inp'), '99990000');
  d.getElementById('acct-cont-btn').click();
  await waitFor(() => pane(d) === 'acct-pane-otp', 'otp pane');
  d.querySelectorAll('#acct-otp-boxes input').forEach((b, i) => type(w, b, String((i + 3) % 10)));
  d.getElementById('acct-verify-btn').click();
}
const call = (calls, re) => calls.filter((c) => re.test(c.url));

for (const dir of ['xpizza-orders', 'la-musa-orders']) {
  const RID = BRAND[dir].rid;
  // ── A. flow A ──
  {
    const t = await boot(dir, { cfg: CFG() });
    await phoneLogin(t);
    await waitFor(() => pane(t.d) === 'acct-pane-su-email', 'email pane');
    const p = t.d.getElementById('acct-pane-su-email');
    assert.ok(p.textContent.includes(HINT), '🔴 the owner\'s email hint, exact');
    const em = t.d.getElementById('acct-su-email');
    assert.strictEqual(em.value, '', 'the email starts EMPTY'); assert.strictEqual(em.getAttribute('inputmode'), 'email');
    assert.ok(t.d.getElementById('acct-su-email-go').disabled, 'Continuar disabled while empty');
    type(t.w, em, 'ana@');
    const chips = [...t.d.querySelectorAll('#acct-su-chips button')].map((b) => b.textContent);
    assert.deepStrictEqual(chips, ['ana@gmail.com', 'ana@hotmail.com', 'ana@yahoo.com'], '"@" chips');
    assert.ok(/min-height:44px/.test(t.d.getElementById('acct-su-styles').textContent), 'chips ≥ 44px');
    t.d.querySelector('#acct-su-chips button').click();
    assert.strictEqual(em.value, 'ana@gmail.com'); assert.ok(!t.d.getElementById('acct-su-email-go').disabled);
    t.d.getElementById('acct-su-email-go').click();
    await waitFor(() => pane(t.d) === 'acct-pane-su-name', 'name pane');
    const links = [...t.d.querySelectorAll('#acct-pane-su-name .acct-chk a')].map((a) => a.getAttribute('href'));
    assert.deepStrictEqual(links, [LEGAL.terms_url, LEGAL.privacy_url], 'the brand\'s legal links from the server config');
    assert.ok(t.d.getElementById('acct-pane-su-name').textContent.includes('Acepto los Términos y la Política de privacidad'), 'terms copy');
    assert.ok(t.d.getElementById('acct-pane-su-name').textContent.includes('Quiero recibir promociones por correo y WhatsApp'), 'promotions copy');
    assert.ok(!t.d.getElementById('acct-su-promo').checked, 'promotions unticked');
    type(t.w, t.d.getElementById('acct-su-name'), 'Ana Pérez');
    assert.ok(t.d.getElementById('acct-su-save').disabled, '🔴 Guardar disabled until the terms are ticked');
    t.d.getElementById('acct-su-terms').click();
    assert.ok(!t.d.getElementById('acct-su-save').disabled);
    t.d.getElementById('acct-su-save').click();
    await waitFor(() => pane(t.d) === 'acct-pane-su-done', 'done pane');
    const cp = call(t.calls, /completeprofile/);
    assert.strictEqual(cp.length, 1);
    assert.deepStrictEqual(cp[0].body, { restaurant_id: RID, email: 'ana@gmail.com', accept_terms: true, promos: false }, 'the exact completeProfile body');
    assert.strictEqual(cp[0].headers['X-Firebase-ID-Token'], 'idt:' + UID, 'the customer\'s own token');
    assert.ok(t.st.writes.some((x) => x.path === `user_profiles/${UID}` && x.obj.name === 'Ana Pérez'), 'the name write');
    assert.ok(t.d.getElementById('acct-pane-su-done').textContent.includes('¡Perfil creado!') && t.d.getElementById('acct-pane-su-done').textContent.includes('ana@gmail.com'));
    assert.deepStrictEqual(call(t.calls, /verifyotp/)[0].body, { phone: '+50499990000', code: '345678' }, 'verifyOtp without a ticket: today\'s body');
    t.d.getElementById('acct-su-finish').click(); await settle();
  }
  ok(`${dir} A: flow A — phone → code → email (empty, owner hint, @-chips ≥44px) → name + terms (Guardar gated) + promos (unticked) → the name write + completeProfile {exact body, own token} → "¡Perfil creado!"`);

  // ── B. completeProfile refused ──
  {
    const t = await boot(dir, { cfg: CFG(), complete: { ok: false, reason: 'legal_unconfigured' } });
    await phoneLogin(t);
    await waitFor(() => pane(t.d) === 'acct-pane-su-email', 'email');
    type(t.w, t.d.getElementById('acct-su-email'), 'a@b.co'); t.d.getElementById('acct-su-email-go').click();
    await waitFor(() => pane(t.d) === 'acct-pane-su-name', 'name');
    type(t.w, t.d.getElementById('acct-su-name'), 'Ana Pérez'); t.d.getElementById('acct-su-terms').click(); t.d.getElementById('acct-su-save').click();
    await waitFor(() => t.d.getElementById('acct-su-name-err').style.display === 'block', 'error shown');
    assert.strictEqual(pane(t.d), 'acct-pane-su-name', '🔴 never "¡Perfil creado!" on a refusal');
    assert.ok(!t.d.getElementById('acct-su-save').disabled, 'retry possible');
  }
  ok(`${dir} B: a refused completeProfile shows the error and reports nothing complete (no done pane; retry enabled)`);

  // ── C. returning with terms ──
  {
    const t = await boot(dir, { cfg: CFG(), profile: PROFILE({ name: 'Ana Pérez' }), terms: true });
    await phoneLogin(t);
    await waitFor(() => pane(t.d) === 'acct-pane-su-hello', 'hello pane');
    assert.ok(t.d.getElementById('acct-pane-su-hello').textContent.includes('¡Hola de nuevo, Ana!'));
    assert.strictEqual(call(t.calls, /completeprofile/).length, 0, 'no write');
  }
  ok(`${dir} C: a returning account with this brand's terms → "¡Hola de nuevo, Ana!" with no write`);

  // ── D. the claim branch ──
  {
    const t = await boot(dir, { cfg: CFG() });
    await phoneLogin(t, { claim: { phone: '+50499990000', name: 'Ana Pérez', order_id: 'ord_1', n: 2, unit: 'punch' } });
    await waitFor(() => pane(t.d) === 'acct-pane-su-email', 'email');
    assert.ok(!t.d.getElementById('acct-su-alts'), 'no Google button on a claim prefill');
    type(t.w, t.d.getElementById('acct-su-email'), 'a@b.co'); t.d.getElementById('acct-su-email-go').click();
    await waitFor(() => pane(t.d) === 'acct-pane-su-name', 'name');
    assert.strictEqual(t.d.getElementById('acct-su-name').value, 'Ana Pérez', 'the name soft-filled from the order');
    t.d.getElementById('acct-su-terms').click(); t.d.getElementById('acct-su-save').click();
    await waitFor(() => pane(t.d) === 'acct-pane-confirm', 'claim confirmation');
    const iC = t.calls.findIndex((c) => /completeprofile/.test(c.url)), iO = t.calls.findIndex((c) => /claimOrder/.test(c.url));
    assert.ok(iC > -1 && iO > iC, '🔴 completeProfile BEFORE claimOrder');
  }
  ok(`${dir} D: the claim branch runs completeProfile (name soft-filled from the order) BEFORE claimOrder, then the credited confirmation`);

  // ── E. Google (the GIS BUTTON flow, armed when the sheet opens — codex r1 P2-5) ──
  const gisStub = (w) => { const g = { inits: [], buttons: [], prompts: 0 }; w.google = { accounts: { id: { initialize: (o) => g.inits.push(o), renderButton: (el, o) => g.buttons.push({ el, o }), prompt: () => { g.prompts++; } } } }; return g; };
  {
    const off = await boot(dir, { cfg: CFG() });
    off.d.querySelector('#acct-chip button').click(); await settle(); await settle();
    assert.ok(!off.d.getElementById('acct-su-alts'), 'no Google button without configuration');
    for (const conflict of [false, true]) {
      const t = await boot(dir, { cfg: CFG({ google_enabled: true, google_client_id: 'cid.apps.googleusercontent.com' }), verify: (b) => (b.link_ticket ? { link: conflict ? 'conflict' : 'linked' } : {}) });
      const gis = gisStub(t.w);
      t.d.querySelector('#acct-chip button').click();
      await waitFor(() => gis.inits.length === 1 && gis.buttons.length === 1, 'GIS initialized + button rendered');
      assert.ok(gis.inits[0].client_id === 'cid.apps.googleusercontent.com' && gis.inits[0].nonce === 'nonce-1' && gis.inits[0].ux_mode === 'popup', 'initialized with the server nonce, popup button flow');
      assert.strictEqual(gis.prompts, 0, '🔴 never One Tap (prompt)');
      assert.ok(gis.buttons[0].el.id === 'acct-su-gslot' && gis.buttons[0].o.text === 'continue_with' && gis.buttons[0].o.locale === 'es', 'Google\'s own button in the slot');
      const startBody = call(t.calls, /googlestart/)[0].body;
      assert.ok(startBody.restaurant_id === RID && /^[A-Za-z0-9_-]{20,}$/.test(startBody.session_id), 'googleStart {rid, session}');
      gis.inits[0].callback({ credential: 'gcred' });
      await waitFor(() => t.d.querySelector('#acct-pane-phone .acct-h1').textContent === 'Tu teléfono', '"Tu teléfono"');
      assert.deepStrictEqual(call(t.calls, /googlesignin/)[0].body, { restaurant_id: RID, session_id: startBody.session_id, id_token: 'gcred' });
      type(t.w, t.d.getElementById('acct-ph-inp'), '99990000'); t.d.getElementById('acct-cont-btn').click();
      await waitFor(() => pane(t.d) === 'acct-pane-otp', 'otp');
      assert.deepStrictEqual(call(t.calls, /requestotp/)[0].body, { phone: '+50499990000', restaurant_id: RID, link_ticket: 'ticket_' + 'x'.repeat(20), session_id: startBody.session_id }, 'requestOtp carries the ticket');
      t.d.querySelectorAll('#acct-otp-boxes input').forEach((b, i) => type(t.w, b, String(i)));
      t.d.getElementById('acct-verify-btn').click();
      if (!conflict) {
        await waitFor(() => pane(t.d) === 'acct-pane-su-name', 'name pane (email skipped)');
        assert.strictEqual(t.d.getElementById('acct-su-name').value, 'Ana Google', 'the Google name prefilled');
        assert.ok(t.d.getElementById('acct-pane-su-name').textContent.includes('Lleno desde Google'));
        t.d.getElementById('acct-su-terms').click(); t.d.getElementById('acct-su-save').click();
        await waitFor(() => call(t.calls, /completeprofile/).length === 1, 'completeProfile');
        assert.strictEqual(call(t.calls, /completeprofile/)[0].body.email, 'ana@gmail.com', 'the Google email');
      } else {
        await waitFor(() => pane(t.d) === 'acct-pane-su-email', 'email pane (Google dropped)');
        assert.strictEqual(t.d.getElementById('acct-su-email').value, '', 'no Google email kept');
        type(t.w, t.d.getElementById('acct-su-email'), 'a@b.co'); t.d.getElementById('acct-su-email-go').click();
        await waitFor(() => pane(t.d) === 'acct-pane-su-name', 'name');
        assert.strictEqual(t.d.getElementById('acct-su-name').value, '', '🔴 no Google name after a refused link');
      }
      assert.ok(call(t.calls, /verifyotp/)[0].body.link_ticket, 'verifyOtp carries the ticket');
    }
  }
  ok(`${dir} E: Google only when configured; the BUTTON flow (renderButton, popup; never prompt) with the server nonce → googleSignIn → "Tu teléfono" → the ticket rides requestOtp + verifyOtp → linked: email skipped, Google name prefilled, completeProfile with the Google email; a conflict drops the Google prefill`);

  // ── F. GIS failure; a stale callback; choosing the phone cancels Google (codex r1 P1-2) ──
  {
    const t = await boot(dir, { cfg: CFG({ google_enabled: true, google_client_id: 'cid' }) });
    t.d.querySelector('#acct-chip button').click();
    await waitFor(() => !!t.d.querySelector('script[src="https://accounts.google.com/gsi/client"]'), 'GIS script requested');
    t.d.querySelector('script[src="https://accounts.google.com/gsi/client"]').onerror();
    await waitFor(() => t.d.getElementById('acct-su-gerr').style.display === 'block', 'unavailable message');
    assert.ok(t.d.getElementById('acct-su-gerr').textContent.includes('Google no está disponible acá'));
    assert.ok(pane(t.d) === 'acct-pane-phone' && !t.d.getElementById('acct-cont-btn').hidden, 'the phone path stays');
    // a stale callback: the sheet closed and reopened → only the live attempt's callback proceeds
    const g = gisStub(t.w);
    t.d.getElementById('acct-close').click(); await settle();
    t.d.querySelector('#acct-chip button').click(); await waitFor(() => g.inits.length === 1, 'attempt A');
    t.d.getElementById('acct-close').click(); await settle();
    t.d.querySelector('#acct-chip button').click(); await waitFor(() => g.inits.length === 2, 'attempt B');
    g.inits[0].callback({ credential: 'stale' }); await settle(); await settle();
    assert.strictEqual(call(t.calls, /googlesignin/).length, 0, '🔴 a stale attempt\'s callback is ignored');
    // P1-2: the customer then chooses the phone → attempt B's late callback is ignored too
    type(t.w, t.d.getElementById('acct-ph-inp'), '99990000'); t.d.getElementById('acct-cont-btn').click();
    await waitFor(() => pane(t.d) === 'acct-pane-otp', 'otp');
    g.inits[1].callback({ credential: 'late' }); await settle(); await settle();
    assert.strictEqual(call(t.calls, /googlesignin/).length, 0, '🔴 a Google callback after choosing the phone must be ignored');
    // a fresh sheet arms a live attempt again
    t.d.getElementById('acct-close').click(); await settle();
    t.d.querySelector('#acct-chip button').click(); await waitFor(() => g.inits.length === 3, 'attempt C');
    g.inits[2].callback({ credential: 'fresh' }); await waitFor(() => call(t.calls, /googlesignin/).length === 1, 'the live attempt');
    assert.strictEqual(call(t.calls, /googlesignin/)[0].body.id_token, 'fresh');
  }
  ok(`${dir} F: a GIS script failure → "Google no está disponible acá", phone path intact; an older attempt's callback is ignored; choosing the phone cancels the pending Google attempt (a late callback does nothing); a fresh sheet works`);

  // ── K. codex r2 #2: a linked Google sign-in whose session mint is underway when the customer picks the phone ──
  for (const phoneVerifies of [false, true]) {
    const GUID = 'u_' + 'g'.repeat(24);
    const t = await boot(dir, { cfg: CFG({ google_enabled: true, google_client_id: 'cid' }), profile: PROFILE(),
      google: { signIn: () => ({ ok: true, linked: true, token: 'tok:' + GUID, name: 'Ana Google' }) } });
    const g = gisStub(t.w);
    const am = t.w.__FB_FAKE.authMod; const mint0 = am.signInWithCustomToken; let release; const held = new Promise((r) => { release = r; });
    const mints = []; let signOuts = 0;
    am.signInWithCustomToken = async (a, tok) => { mints.push(tok); if (tok === 'tok:' + GUID) await held; return mint0(a, tok); };
    const so0 = am.signOut; am.signOut = async (a) => { signOuts++; return so0(a); };
    t.d.querySelector('#acct-chip button').click(); await waitFor(() => g.inits.length === 1, 'armed');
    g.inits[0].callback({ credential: 'c' });
    await waitFor(() => mints.length === 1, 'the Google mint is underway (suspended)');
    type(t.w, t.d.getElementById('acct-ph-inp'), '99990000'); t.d.getElementById('acct-cont-btn').click();   // the customer picks the phone
    await waitFor(() => pane(t.d) === 'acct-pane-otp', 'otp');
    if (phoneVerifies) {
      t.d.querySelectorAll('#acct-otp-boxes input').forEach((b, i) => type(t.w, b, String(i)));
      t.d.getElementById('acct-verify-btn').click();
      await waitFor(() => call(t.calls, /verifyotp/).length === 1, 'verifyOtp answered'); await settle(); await settle();
      assert.strictEqual(mints.length, 1, '🔴 the phone mint must wait for the Google mint already underway');
    }
    release(); await settle(); await settle(); await new Promise((x) => setTimeout(x, 60));
    assert.strictEqual(signOuts, 1, '🔴 the stale Google session is signed out');
    assert.strictEqual(t.w.__reloads || 0, 0, '🔴 no marker on screen (the phone code pending) → no reload: the open flow carries on');
    const mk = JSON.parse(t.w.localStorage.getItem(MARKER[dir]) || 'null');
    if (!phoneVerifies) {
      assert.ok(t.st.uid === null && mk === null, `🔴 a Google mint finishing after the phone was chosen leaves no session and no marker (${t.st.uid}, ${JSON.stringify(mk)})`);
      assert.strictEqual(pane(t.d), 'acct-pane-otp', 'no afterLogin: the code pane stays');
    } else {
      await waitFor(() => pane(t.d) === 'acct-pane-su-email', 'the phone login routes on');
      assert.ok(t.st.uid === UID && mk && mk.uid === UID && mk.phone, `🔴 the phone session is the only one (${t.st.uid}, ${JSON.stringify(mk)})`);
      assert.deepStrictEqual(mints, ['tok:' + GUID, 'tok:' + UID], 'Google settled first, then the phone');
    }
  }
  ok(`${dir} K: a linked Google mint already underway when the phone is chosen is undone on resolve (signed out, no marker, no afterLogin); a phone verify meanwhile waits for it and ends as the only session`);

  // ── I. advisor ruling (train review P1): completion only when the config AFFIRMATIVELY reports the rollout active ──
  {
    const t = await boot(dir, { cfg: 'fail' });   // the config can't be read (twice)
    await phoneLogin(t);
    await waitFor(() => pane(t.d) === 'acct-pane-createprofile', '🔴 an unreadable config is today\'s flow (the (d) pane), never the completion panes');
    assert.ok(call(t.calls, /getsignupconfig/).length >= 2, 'the config read is retried, never cached as a failure');
    // a signed-in post-rollout account without terms, config unreadable: pay proceeds, Mi cuenta is today's
    const f = await boot(dir, { cfg: 'fail', signedIn: { name: 'Ana Pérez' }, profile: PROFILE({ name: 'Ana Pérez' }) });
    await waitFor(() => call(f.calls, /getsignupconfig/).length >= 1, 'the restore read'); await settle(); await new Promise((x) => setTimeout(x, 200));
    assert.strictEqual(f.w.__ACCOUNT.deliverySubmitBlocked(), false, '🔴 an unreadable config must never block pay');
    await settle(); assert.notStrictEqual(pane(f.d), 'acct-pane-su-email', 'no completion panes');
    f.d.querySelector('#acct-chip button').click(); await settle(); await new Promise((x) => setTimeout(x, 150));
    assert.notStrictEqual(pane(f.d), 'acct-pane-su-email', '🔴 Mi cuenta with an unreadable config is today\'s, no completion panes');
    // legal_ready:false with a rollout timestamp: not affirmatively active → today's flow
    const nl = await boot(dir, { cfg: CFG({ legal_ready: false }) });
    await phoneLogin(nl);
    await waitFor(() => pane(nl.d) === 'acct-pane-createprofile', '🔴 legal_ready:false is today\'s flow');
    // AFFIRMATIVE rollout: a failed completion then a RELOAD → the gate comes from the server again (kept: codex r1 P1-3/P1-4)
    const r = await boot(dir, { cfg: CFG(), signedIn: { name: 'Ana Pérez' }, profile: PROFILE({ name: 'Ana Pérez' }) });
    await waitFor(() => call(r.calls, /getsignupconfig/).length >= 1, 'the restored session reads the config');
    await settle(); await settle(); await new Promise((x) => setTimeout(x, 100));
    assert.strictEqual(r.w.__ACCOUNT.deliverySubmitBlocked(), true, '🔴 a named post-rollout account without terms must not pay before completing');
    await waitFor(() => pane(r.d) === 'acct-pane-su-email', 'the completion panes open at pay');
    const m = await boot(dir, { cfg: CFG(), signedIn: { name: 'Ana Pérez' }, profile: PROFILE({ name: 'Ana Pérez' }) });
    await waitFor(() => call(m.calls, /getsignupconfig/).length >= 1, 'the load read'); await settle(); await settle();   // the rollout known active (opened before that: today's Mi cuenta — cell H acct-cfgpending)
    m.d.querySelector('#acct-chip button').click();
    await waitFor(() => pane(m.d) === 'acct-pane-su-email', '🔴 Mi cuenta opens the completion panes for an incomplete account');
    const l = await boot(dir, { cfg: CFG(), signedIn: { name: 'Ana Pérez' }, profile: PROFILE({ created_at: ROLL - 1, name: 'Ana Pérez' }) });
    await waitFor(() => call(l.calls, /getsignupconfig/).length >= 1, 'read'); await settle(); await new Promise((x) => setTimeout(x, 100));
    assert.strictEqual(l.w.__ACCOUNT.deliverySubmitBlocked(), false, 'a legacy account is never gated');
    // AFFIRMATIVE rollout + unreadable terms → the panes (kept)
    const ut = await boot(dir, { cfg: CFG() });
    { const get0 = ut.w.__FB_FAKE.dbMod.get; ut.w.__FB_FAKE.dbMod.get = async (r) => { if (/\/consent\//.test(r.path)) throw new Error('permission'); return get0(r); }; }
    await phoneLogin(ut);
    await waitFor(() => pane(ut.d) === 'acct-pane-su-email', '🔴 unreadable terms (rollout active) keep the panes');
    // a PENDING CONFIG read never blocks pay; once it resolves active, the panes only when required
    for (const [label, profile, terms, panes] of [['incomplete', PROFILE({ name: 'Ana Pérez' }), false, true], ['complete', PROFILE({ name: 'Ana Pérez' }), true, false], ['legacy', PROFILE({ created_at: ROLL - 1, name: 'Ana Pérez' }), false, false]]) {
      let go; const hold = new Promise((x) => { go = x; });
      const pr = await boot(dir, { cfg: CFG(), cfgHold: hold, signedIn: { name: 'Ana Pérez' }, profile, terms });
      await waitFor(() => call(pr.calls, /getsignupconfig/).length >= 1, 'the config read is pending'); await settle();
      assert.strictEqual(pr.w.__ACCOUNT.deliverySubmitBlocked(), false, `🔴 ${label}: a PENDING config read must never block pay`);
      assert.notStrictEqual(pane(pr.d), 'acct-pane-su-email', 'no panes before the state is known');
      go(); await settle(); await settle(); await new Promise((x) => setTimeout(x, 120));
      assert.strictEqual(pr.w.__ACCOUNT.deliverySubmitBlocked(), panes, `${label}: once resolved, pay gated only when required`);
      if (panes) await waitFor(() => pane(pr.d) === 'acct-pane-su-email', `${label}: the panes once resolved`);
      else assert.notStrictEqual(pane(pr.d), 'acct-pane-su-email', `${label}: no panes`);
    }
    // codex r2 #4 (kept): the rollout KNOWN active, the terms read PENDING → pay refused, then the panes only when required
    for (const [label, terms, panes] of [['incomplete', false, true], ['complete', true, false]]) {
      let go; const hold = new Promise((x) => { go = x; });
      const pr = await boot(dir, { cfg: CFG(), termsHold: hold, signedIn: { name: 'Ana Pérez' }, profile: PROFILE({ name: 'Ana Pérez' }), terms });
      await waitFor(() => call(pr.calls, /getsignupconfig/).length >= 1, 'config read'); await settle(); await settle();
      assert.strictEqual(pr.w.__ACCOUNT.deliverySubmitBlocked(), true, `🔴 ${label}: rollout active, completion read PENDING → pay refused`);
      assert.notStrictEqual(pane(pr.d), 'acct-pane-su-email', 'no panes before the state is known');
      go(); await settle(); await settle(); await new Promise((x) => setTimeout(x, 120));
      if (panes) await waitFor(() => pane(pr.d) === 'acct-pane-su-email', `${label}: the panes once resolved`);
      else { assert.notStrictEqual(pane(pr.d), 'acct-pane-su-email', `${label}: no panes`); assert.strictEqual(pr.w.__ACCOUNT.deliverySubmitBlocked(), false, `${label}: pay proceeds once resolved`); }
    }
  }
  ok(`${dir} I: an unreadable config (retried, never cached) or legal_ready:false is today's flow — the (d) pane at login, pay never blocked, Mi cuenta today's; a PENDING config read never blocks pay; in an AFFIRMATIVELY active rollout a reload gates a post-rollout account without terms at pay and in Mi cuenta, unreadable terms keep the panes, a pending terms read refuses pay then panes only when required; a legacy account is never gated`);

  // ── L. codex r3 P1 + OWNER ruling (r4): a hung mint never wedges sign-in; a late stale mint signs the customer out fully ──
  //   hang: the phone completes after the bounded wait; late: the Google mint then resolves → signed out, no marker, the chip
  //   signed-out, no routing — and the next sign-in works; logout: the customer signs out during the hang, then it resolves → still out
  for (const mode of ['hang', 'late', 'heal', 'logout']) {
    const GUID = 'u_' + 'g'.repeat(24);
    const t = await boot(dir, { cfg: CFG({ google_enabled: true, google_client_id: 'cid' }), authWait: 250,
      profile: mode === 'logout' ? PROFILE({ name: 'Ana Pérez' }) : PROFILE(), terms: mode === 'logout',
      google: { signIn: () => ({ ok: true, linked: true, token: 'tok:' + GUID, name: 'Ana Google' }) } });
    const g = gisStub(t.w);
    const am = t.w.__FB_FAKE.authMod; const mint0 = am.signInWithCustomToken; let release; const held = new Promise((r) => { release = r; });
    const mints = []; let signOuts = 0;
    am.signInWithCustomToken = async (a, tok) => { mints.push(tok); if (tok === 'tok:' + GUID) await held; return mint0(a, tok); };
    const so0 = am.signOut; am.signOut = async (a) => {
      signOuts++; await so0(a);
      if (mode === 'heal' && signOuts === 1) {   // codex r8: a concurrent read finds no session DURING the signOut await → the real heal() drops the marker
        t.w.__ACCOUNT.deliverySubmitBlocked();
        await waitFor(() => !t.w.localStorage.getItem(MARKER[dir]), 'a concurrent read healed the marker during signOut');
      }
    };
    t.d.querySelector('#acct-chip button').click(); await waitFor(() => g.inits.length === 1, 'armed');
    g.inits[0].callback({ credential: 'c' });
    await waitFor(() => mints.length === 1, 'the Google mint hangs');
    type(t.w, t.d.getElementById('acct-ph-inp'), '99990000'); t.d.getElementById('acct-cont-btn').click();
    await waitFor(() => pane(t.d) === 'acct-pane-otp', 'otp');
    t.d.querySelectorAll('#acct-otp-boxes input').forEach((b, i) => type(t.w, b, String(i)));
    t.d.getElementById('acct-verify-btn').click();
    const routed = () => pane(t.d) === (mode === 'logout' ? 'acct-pane-su-hello' : 'acct-pane-su-email');
    await waitFor(() => t.st.uid === UID && routed(), '🔴 a hung mint must not wedge the next sign-in (bounded wait)', 4000);
    const mk = () => JSON.parse(t.w.localStorage.getItem(MARKER[dir]) || 'null');
    assert.ok(t.st.uid === UID && mk() && mk().uid === UID, 'the phone session + marker');
    assert.strictEqual(signOuts, 0, 'nothing signed out while the stale mint hangs');
    if (mode === 'hang') continue;
    if (mode === 'logout') {   // the customer signs out from Mi cuenta while the Google mint still hangs
      t.d.getElementById('acct-su-hello-ok').click(); await settle(); await new Promise((x) => setTimeout(x, 400));
      if (!t.d.querySelector('.acct-signout button')) { t.d.querySelector('#acct-chip button').click(); }
      await waitFor(() => !!t.d.querySelector('.acct-signout button'), 'Mi cuenta → Cerrar sesión');
      t.d.querySelector('.acct-signout button').click();
      await waitFor(() => t.st.uid === null && mk() === null, 'signed out');
    }
    const so = signOuts;
    release(); await settle(); await settle(); await new Promise((x) => setTimeout(x, 80));
    assert.strictEqual(signOuts, so + 1, '🔴 a late stale mint must sign out');
    assert.ok(t.st.uid === null && mk() === null, `🔴 a late stale mint leaves the customer fully signed out, no marker (${t.st.uid}, ${JSON.stringify(mk())})`);
    assert.strictEqual(t.w.__reloads || 0, mode === 'logout' ? 0 : 1, '🔴 a late stale mint with a session on screen RELOADS the page (exactly once) — also when a heal() drops the marker during its signOut; after a logout (no marker) it does not');
    assert.deepStrictEqual(mints, ['tok:' + GUID, 'tok:' + UID], 'no repair mint — only the two sign-ins');
    // (in a browser the page is gone here — what the customer sees next is the fresh page: cell P)
  }
  ok(`${dir} L: a Google mint that never settles doesn't wedge sign-in (the phone completes after the bounded wait); resolving late it signs out, clears the marker and reloads the page once (no repair mint) — also when a concurrent heal() drops the marker during its signOut; a logout during the hang, then the late resolve → signed out, no reload`);

  // ── P. OWNER ruling (r7) — the fresh page after the reload: a write that landed before unload left a marker, but the auth
  //    session is gone → the restore path heals it: signed out, no panes, pay not gated; the next sign-in works
  {
    const t = await boot(dir, { cfg: CFG(), signedIn: { name: 'María López' }, noSession: true, profile: PROFILE({ name: 'María López' }) });
    await settle(); await settle(); await new Promise((x) => setTimeout(x, 200));
    const mk = () => JSON.parse(t.w.localStorage.getItem(MARKER[dir]) || 'null');
    assert.strictEqual(mk(), null, '🔴 a marker left by a write before unload is healed on the fresh page (no auth session)');
    assert.ok(!t.d.querySelector('#acct-overlay.acct-open'), 'no panes');
    assert.strictEqual(t.w.__ACCOUNT.deliverySubmitBlocked(), false, 'a guest: pay is not gated');
    await phoneLogin(t);
    await waitFor(() => t.st.uid === UID && mk() && mk().uid === UID && pane(t.d) === 'acct-pane-su-email', 'the next sign-in works', 4000);
  }
  ok(`${dir} P: the fresh page after the reload — a stale marker without an auth session is healed (signed out, no panes, pay not gated); the next sign-in works`);

  // ── M. codex r3 P2: a superseded gate read never reopens the panes ──
  {
    let go; const hold = new Promise((x) => { go = x; });
    const t = await boot(dir, { cfg: CFG(), termsHold: hold, signedIn: { name: 'Ana Pérez' }, profile: PROFILE({ name: 'Ana Pérez' }), exposeGate: true });
    await waitFor(() => call(t.calls, /getsignupconfig/).length >= 1, 'the restore read is pending'); await settle(); await settle();
    assert.strictEqual(t.w.__ACCOUNT.deliverySubmitBlocked(), true, 'pay waits on the pending read');
    t.w.__suSetGate('complete');   // a completion saved meanwhile
    go(); await settle(); await settle(); await new Promise((x) => setTimeout(x, 150));   // the OLD read resolves 'needed' (no terms on record)
    assert.notStrictEqual(pane(t.d), 'acct-pane-su-email', '🔴 a superseded read must not reopen the completion panes');
    assert.strictEqual(t.w.__ACCOUNT.deliverySubmitBlocked(), false, 'pay proceeds on the current (complete) gate');
  }
  ok(`${dir} M: pay waiting on a pending read; a completion meanwhile (suSetGate complete); the OLD read resolving "needed" opens no panes and pay proceeds`);

  // ── J. codex r1 P2-7: "Recibir promociones" in Mi cuenta ──
  for (const fail of [false, true]) {
    const t = await boot(dir, { cfg: CFG(), signedIn: { name: 'Ana Pérez' }, profile: PROFILE({ name: 'Ana Pérez' }), terms: true, promos: fail ? { ok: false } : { ok: true } });
    await waitFor(() => call(t.calls, /getsignupconfig/).length >= 1, 'the load read'); await settle(); await settle();   // the rollout known active
    t.d.querySelector('#acct-chip button').click();
    await waitFor(() => !!t.d.getElementById('acct-su-promos'), 'the promotions row');
    const sw = t.d.getElementById('acct-su-promos');
    assert.ok(!sw.checked && t.d.getElementById('acct-row-promos').textContent.includes('Recibir promociones'), 'reflects the stored choice (off)');
    sw.click(); await waitFor(() => call(t.calls, /setpromos/).length === 1 && !sw.disabled, 'setPromos');
    assert.deepStrictEqual(call(t.calls, /setpromos/)[0].body, { restaurant_id: RID, value: true });
    assert.strictEqual(sw.checked, !fail, fail ? '🔴 a failure reverts the switch' : 'saved');
    if (fail) assert.ok(t.d.getElementById('acct-toast').textContent.includes('No pudimos guardar tu preferencia'), 'and says so');
  }
  { const l = await boot(dir, { cfg: CFG(), signedIn: { name: 'Ana Pérez' }, profile: PROFILE({ created_at: ROLL - 1, name: 'Ana Pérez' }) });
    l.d.querySelector('#acct-chip button').click(); await waitFor(() => pane(l.d) === 'acct-pane-account', 'Mi cuenta'); await settle(); await settle();
    assert.ok(!l.d.getElementById('acct-row-promos'), 'no row for an account without this brand\'s terms'); }
  ok(`${dir} J: Mi cuenta shows "Recibir promociones" for an account with this brand's terms; the switch calls setPromos {rid, value}; a failure reverts it and says so; no row without terms`);

  // ── G. the checkout card (advisor ruling (2)) ──
  for (const dismiss of [false, true]) {
    const t = await boot(dir, { cfg: CFG(), signedIn: { name: '' }, profile: PROFILE() });
    await waitFor(() => call(t.calls, /getsignupconfig/).length >= 1, 'the load read'); await settle(); await settle();   // the rollout known active (pending: today's card — cell H cfgpending-checkout)
    t.w.eval("orderType = 'delivery'; lat = 14.08; lng = -87.2;");
    t.w.__ACCOUNT.applyCreateProfileFlow(PROFILE());
    await settle();
    type(t.w, t.d.getElementById('acct-cp-nombre'), 'Ana'); type(t.w, t.d.getElementById('acct-cp-apellido'), 'Pérez');
    t.d.getElementById('address-detected').value = 'Col. Palmira'; t.d.getElementById('address-details').value = 'Portón negro';
    const lab = t.d.getElementById('acct-label-custom'); if (lab) lab.value = 'Casa';
    t.d.getElementById('acct-save-addr-btn').click();
    await waitFor(() => pane(t.d) === 'acct-pane-su-email', 'the completion panes open');
    assert.ok(!t.st.writes.length, 'nothing written yet');
    if (dismiss) {
      t.d.getElementById('acct-close').click(); await settle(); await settle();
      assert.ok(!t.st.writes.length && !call(t.calls, /completeprofile/).length, '🔴 a dismissal saves nothing');
      assert.ok(!t.d.getElementById('acct-save-addr-btn').disabled && t.d.getElementById('acct-cp-nombre').value === 'Ana' && t.d.getElementById('address-details').value === 'Portón negro', 'the card stays as typed');
      continue;
    }
    type(t.w, t.d.getElementById('acct-su-email'), 'a@b.co'); t.d.getElementById('acct-su-email-go').click();
    await waitFor(() => pane(t.d) === 'acct-pane-su-name', 'name');
    assert.strictEqual(t.d.getElementById('acct-su-name').value, 'Ana Pérez', 'the card\'s name carried');
    type(t.w, t.d.getElementById('acct-su-name'), 'María López');   // edited in the completion pane (codex r1 P2-8)
    t.d.getElementById('acct-su-terms').click(); t.d.getElementById('acct-su-save').click();
    await waitFor(() => t.st.writes.some((x) => /addresses/.test(JSON.stringify(x))), 'the address saved automatically');
    const iC = t.calls.findIndex((c) => /completeprofile/.test(c.url));
    assert.ok(iC > -1, 'completeProfile');
    const addr = JSON.stringify(t.st.tree.user_profiles[UID].addresses || {});
    assert.ok(addr.includes('Col. Palmira') && addr.includes('Portón negro') && addr.includes('Casa'), `🔴 the typed address kept and saved (${addr})`);
    const names = t.st.writes.filter((x) => x.obj && typeof x.obj.name === 'string').map((x) => x.obj.name);
    assert.deepStrictEqual(names, ['María López'], `🔴 the checkout must not overwrite the completed name (${JSON.stringify(names)})`);
    assert.strictEqual(t.st.tree.user_profiles[UID].name, 'María López');
  }
  ok(`${dir} G: the checkout card for a post-rollout nameless account opens the completion panes, keeps the typed address and saves it automatically after completeProfile; a dismissal saves nothing and leaves the card as typed`);

  // ── Q. codex cfgfix r1 P1: the gate captured at checkout START; a stalled config body is a bounded, retried read ──
  {
    let go; const hold = new Promise((x) => { go = x; });
    const t = await boot(dir, { cfg: CFG(), cfgHold: hold, signedIn: { name: 'Ana Pérez' }, profile: PROFILE({ name: 'Ana Pérez' }) });
    await waitFor(() => call(t.calls, /getsignupconfig/).length >= 1, 'the config read is pending'); await settle();
    const seen = []; const dsb0 = t.w.__ACCOUNT.deliverySubmitBlocked; t.w.__ACCOUNT.deliverySubmitBlocked = () => { const b = dsb0(); seen.push(b); return b; };
    t.w.eval('__locPickPromise = new Promise(function (r) { __locPickDone = r; });');   // a location pick is resolving
    assert.ok(t.w.processPayment.__acctWrapped, 'premise: processPayment is wrapped for a signed-in session');
    const pay = t.w.processPayment();
    go(); await settle(); await settle(); await new Promise((x) => setTimeout(x, 150));   // the config resolves ACTIVE meanwhile ('needed')
    t.w.eval('__locPickDone(); __locPickDone = null; __locPickPromise = null;');
    await pay.catch(() => {}); await settle();
    assert.deepStrictEqual(seen, [false], '🔴 a config resolving active during the location wait must not abort the started checkout');
    assert.notStrictEqual(pane(t.d), 'acct-pane-su-email', 'no completion panes for the started checkout');
    assert.strictEqual(dsb0(), true, 'premise: the live gate DID close (the rollout resolved active, this account needs completion)');
    // a stalled config BODY (headers arrive, the body never does): the WHOLE read is bounded at 2.5 s → a failed read, never cached.
    // A GUEST page reads no config at load, so this responder answers the FIRST request (codex cfgfix r2).
    const s2 = await boot(dir, { cfg: 'stall' });
    s2.d.querySelector('#acct-chip button').click();   // the phone pane reads the config
    await waitFor(() => call(s2.calls, /getsignupconfig/).length === 1, 'the first config read (its body stalls)');
    await new Promise((r) => setTimeout(r, 2800)); await settle();   // past the 2.5 s bound
    s2.d.getElementById('acct-close').click(); await settle();
    s2.d.querySelector('#acct-chip button').click();   // reopened: a timed-out read was not cached → a NEW request
    await waitFor(() => call(s2.calls, /getsignupconfig/).length === 2, '🔴 a stalled config BODY must time out and be read again (the whole read bounded)', 3000);
    assert.strictEqual(s2.w.__ACCOUNT.deliverySubmitBlocked(), false, 'pay never blocked by a stalled config');
  }
  ok(`${dir} Q: a config resolving ACTIVE while a started checkout awaits its location pick does not abort it (the gate captured at processPayment's start); a stalled config BODY (from the first request) is a bounded failed read — not cached, read again — pay never blocked`);

  // ── H. the LEGACY differential vs the slice base ──
  {
    const scenario = async (base, variant) => {
      const k = variant.replace(/^acct-|-checkout$/g, '');
      const CFGS = { cfgfail: 'fail', cfgpending: 'pending', cfgstall: 'stall', legalfalse: CFG({ legal_ready: false }), rolloutoff: CFG({ rollout_at: null }),
        googlenorollout: CFG({ rollout_at: null, google_enabled: true, google_client_id: 'cid' }), profflaky: 'fail', profstall: 'fail' };
      const post = k in CFGS && k !== 'rolloutoff';   // a POST-rollout account (the legacy variants keep created_at < rollout_at)
      const legacyCfg = k in CFGS ? CFGS[k] : CFG();
      const prof = variant === 'named' ? PROFILE({ created_at: ROLL - 1, name: 'Ana Pérez' }) : (post ? PROFILE() : PROFILE({ created_at: ROLL - 1 }));
      if (/^acct-/.test(variant)) {   // Mi cuenta for a signed-in account WITH this brand's terms on record
        const t = await boot(dir, { base, cfg: legacyCfg, signedIn: { name: 'Ana Pérez' }, profile: PROFILE({ name: 'Ana Pérez' }), terms: true });
        await settle(); t.d.querySelector('#acct-chip button').click();
        await new Promise((r) => setTimeout(r, 400)); await settle();
        return { panes: pane(t.d), promos: !!t.d.getElementById('acct-row-promos'), writes: t.st.writes, calls: t.calls.filter((c) => !/getsignupconfig/.test(c.url)).map((c) => ({ url: c.url, body: c.body })) };
      }
      if (/checkout$/.test(variant)) {
        const t = await boot(dir, { base, cfg: legacyCfg, signedIn: { name: '' }, profile: prof });
        t.w.eval("orderType = 'delivery'; lat = 14.08; lng = -87.2;");
        t.w.__ACCOUNT.applyCreateProfileFlow(prof); await settle();
        type(t.w, t.d.getElementById('acct-cp-nombre'), 'Ana'); type(t.w, t.d.getElementById('acct-cp-apellido'), 'Pérez');
        t.d.getElementById('address-detected').value = 'Col. Palmira'; t.d.getElementById('address-details').value = 'Portón negro';
        const lab = t.d.getElementById('acct-label-custom'); if (lab) lab.value = 'Casa';
        t.d.getElementById('acct-save-addr-btn').click();
        await waitFor(() => t.st.writes.length >= 2, 'legacy checkout writes');
        await settle(); await settle();
        // measure pay only once the page's config read has LANDED (the load read can need its bounded retry)
        if (!base) { await waitFor(() => call(t.calls, /getsignupconfig/).length >= 1, 'the config read', 6000); await settle(); await settle(); await new Promise((r) => setTimeout(r, 100)); }
        // address ids are random per run (newAddrId) and the address timestamps are the clock → normalized; everything else compared as is
        const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'created_at' || k === 'last_used_at' ? undefined : x)).replace(/a_[a-f0-9]{6,32}/g, 'a_ID'));
        return { writes: norm(t.st.writes), panes: pane(t.d), payBlocked: t.w.__ACCOUNT.deliverySubmitBlocked(), deliver: (t.d.getElementById('acct-deliver') || {}).textContent, calls: t.calls.filter((c) => !/getsignupconfig/.test(c.url)).map((c) => ({ url: c.url, body: c.body })) };
      }
      const t = await boot(dir, { base, cfg: legacyCfg, profile: prof, profileFault: { profflaky: 'once', profstall: 'stall' }[k] });
      await phoneLogin(t);
      // profstall: sampled just after ONE 1.5 s profile timeout — today's flow has left the code pane by then (codex cfgfix r2)
      await waitFor(() => t.calls.some((c) => /verifyotp/.test(c.url)), 'verify'); await new Promise((r) => setTimeout(r, k === 'profstall' ? 1900 : 300)); await settle();
      return { writes: t.st.writes, panes: pane(t.d), open: t.d.getElementById('acct-overlay').classList.contains('acct-open'), calls: t.calls.filter((c) => !/getsignupconfig/.test(c.url)).map((c) => ({ url: c.url, body: c.body })) };
    };
    for (const variant of ['nameless', 'named', 'rolloutoff', 'checkout', 'cfgfail', 'legalfalse', 'cfgfail-checkout', 'legalfalse-checkout', 'cfgpending', 'cfgstall', 'cfgpending-checkout', 'cfgstall-checkout',
      'googlenorollout', 'profflaky', 'profstall', 'acct-cfgfail', 'acct-legalfalse', 'acct-rolloutoff', 'acct-cfgpending']) {
      const a = await scenario(true, variant), b = await scenario(false, variant);
      assert.deepStrictEqual(b, a, `🔴 ${variant}: a legacy account differs from the slice base`);
      if (variant === 'nameless') assert.strictEqual(a.panes, 'acct-pane-createprofile', 'premise: today\'s (d) pane');
      if (/^cfg(fail|pending|stall)$/.test(variant)) assert.strictEqual(a.panes, 'acct-pane-createprofile', 'premise: today\'s (d) pane');
      if (/^prof(flaky|stall)$/.test(variant)) assert.notStrictEqual(a.panes, 'acct-pane-otp', 'premise: today\'s flow has left the code pane (an unavailable profile read fails open)');
      if (/checkout$/.test(variant)) assert.strictEqual(a.payBlocked, false, 'premise: today\'s card, once saved, permits pay');
      if (/^acct-/.test(variant)) assert.ok(a.panes === 'acct-pane-account' && a.promos === false, 'premise: today\'s Mi cuenta, no promos row');
      if (/checkout/.test(variant)) assert.ok(a.writes.some((x) => x.obj && x.obj.name === 'Ana Pérez'), 'premise: today\'s (e) name write');
    }
  }
  ok(`${dir} H: LEGACY DIFFERENTIAL vs ${BASE}: a legacy nameless login (today's (d) pane), a legacy named login, a brand the server reports NOT rolled out, the legacy checkout card (e), and a POST-ROLLOUT account whose config read fails / never answers / stalls its body (login + checkout card, pay permitted) or is not affirmatively active (legal_ready:false, login + checkout card; no rollout_at with Google configured → no Google button); Mi cuenta under a failed / pending config, legal_ready:false and no rollout_at (no promos row, no setPromos); a profile read that fails once or stalls after login (today's single read — no retry) — identical panes, request bodies (bar the declared getSignupConfig read) and database writes`);
  closeAll(); OPEN.length = 0;
}

console.log(`\nsignup-client: OK (${count()})`);
process.exit(0);
