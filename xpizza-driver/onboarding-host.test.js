// run: `node onboarding-host.test.js` (no framework, repo idiom). EXECUTES the REAL shipped index.html companion
// handlers (lifted by brace-matching and run via `new Function`, the repo idiom) against a fake DOM + fake
// Firebase + the REAL controller — no source-grep assertions. Proves the host behaviors codex flagged:
// A3 "Guardar perfil" stages (never submits); the practice flow calls no operational writer + is brand-neutral;
// E2 is a plain screen with NO automatic sign-out (the driver taps "Cerrar sesión").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { driverGreeting } from './brand-helpers.js';
import { makeCompanionController } from './onboarding-helpers.js';
import { postActRoute } from './postact-route.js';   // Inicio b: the pure post-activation routing the host interpose consults

const SCRIPT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8')
  .match(/<script type="module">([\s\S]*?)<\/script>/)[1];

// Lift a brace-matched `function <name>(` definition from the module source.
function liftFn(name) {
  let start = SCRIPT.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  if (SCRIPT.slice(start - 6, start) === 'async ') start -= 6;   // keep the `async ` prefix (liftFn gotcha)
  let depth = 0, seen = false;
  for (let i = start; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') { depth++; seen = true; }
    else if (SCRIPT[i] === '}') { depth--; if (seen && depth === 0) return SCRIPT.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// A minimal fake DOM. Elements "exist" only after an innerHTML writes them (ids scanned from the markup), so
// $('co-name') is null before the form renders — matching a real DOM, so the profile-preserve guard behaves.
function makeDom() {
  const els = {};
  const exists = new Set(['screen-companion', 'off-driver-name']);   // off-driver-name: the shipped render()'s offshift fall-through writes it
  const mkEl = (id) => ({ value: '', _text: '', _html: '', _h: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); if (id === 'screen-companion') { exists.clear(); exists.add('screen-companion'); exists.add('off-driver-name'); for (const m of String(v).matchAll(/id="([\w-]+)"/g)) exists.add(m[1]); } },
    addEventListener(ev, fn) { this._h[ev] = fn; }, click() { return this._h.click && this._h.click(); },
    classList: { toggle() {}, contains() { return false; }, add() {}, remove() {} },
    closest() { return this; }, querySelectorAll() { return []; }, getAttribute() { return null; },
    // Real-DOM 'afterend' = a SIBLING inserted after this element. In this flat mock the new node lives at the
    // companion-screen level, so reflect the markup in screen-companion's innerHTML and register its ids so
    // $(newId) resolves + it is queryable — matching the shipped SLICE2:ONBOARDING-NAV injection (index.html).
    insertAdjacentHTML(pos, html) { const sc = els['screen-companion']; if (sc) sc._html += String(html); for (const m of String(html).matchAll(/id="([\w-]+)"/g)) exists.add(m[1]); },
    set textContent(v) { this._text = v; }, get textContent() { return this._text; } });
  const $ = (id) => (exists.has(id) ? (els[id] || (els[id] = mkEl(id))) : null);
  return { $, els, exists };
}
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Build a runnable module of the lifted host fns, with externals injected and `companionStep`/`companion` local.
function buildHost({ dom, XPD, currentUser, controller, store, storageThrows = false, removeThrows = false }) {
  const body = [
    liftFn('companionShellHtml'), liftFn('companionReadDraft'), liftFn('companionWriteDraft'),
    liftFn('companionClearDraft'), liftFn('companionRenderScreen'), liftFn('companionRenderE2'),
    liftFn('companionRenderOnboarding'), liftFn('companionHasHeldWork'), liftFn('companionSubmit'),
    // Inicio b r1/r2: the progress store, device-flag helpers, the routing step, and the SHIPPED render() — all lifted
    // so the tests drive the REAL render→controller→flag lifecycle (r2: render() so deleting the interpose dies).
    liftFn('companionReadProgress'), liftFn('companionWriteProgress'), liftFn('companionSetChecklistPending'),
    liftFn('companionChecklistPending'), liftFn('companionClearChecklistPending'), liftFn('companionPostActStep'),
    liftFn('render'),
    // The practica intro card's pay-hint helper the SHIPPED companionRenderOnboarding now calls (earnings slice).
    // Lifted real: no window.PayRate here, so it returns the base «Ves tu resumen» hint — the Pagos-off session view.
    liftFn('drv2PracticaPayHint'),
  ].join('\n');
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { if (storageThrows) throw new Error('quota exceeded'); store[k] = String(v); },
    removeItem: (k) => { if (removeThrows) throw new Error('remove failed'); delete store[k]; },
  };
  const showScreenCalls = [];
  const toastCalls = [];
  const fn = new Function(
    '$', 'escapeHtml', 'showScreen', 'toast', 'driverGreeting', 'XPD', 'currentUser', 'companion',
    'localStorage', 'allTasks', 'companionDraftKey', 'postActRoute', 'ICONS', '__out',
    `let companionStep = 'profile'; let companionDraft = null;\n` +
    // r2: per-uid MAPS, so a dismissal for one uid survives another uid's activation + dismissal.
    `const companionChecklistPendingMem = {}; const companionChecklistClearedMem = {}; let companionProgressMem = {};\n` +
    // render()'s ambient state + the non-companion renderers it reaches on the legacy fall-through (stubbed inert;
    // driverState inactive → the short offshift fall-through, enough to tell checklist (companion) vs app (offshift)):
    `let companionSuspended = false; let companionNeutralNotice = false; let driverState = null; let optimisticShift = null; let drv2NavHome = false;\n` +
    // Inicio c: the practica branch consults companionDemo (null here → it renders the intro, which this suite asserts)
    // and drv2LiveBoard() (the start-guard reads an EMPTY board here). companionDemoAlive is short-circuited (companionDemo
    // is null) but defined for completeness. The isolated demo controller itself is proven in practica-demo.test.js.
    `let companionDemo = null; function companionDemoAlive() { return false; } function drv2LiveBoard() { return []; }\n` +
    `function companionSyncSuspendedNotice() {} function stopKeepAlive() {} function renderStatusBar() {} function renderActiveAndQueue() {} function ensureOfflineBanner() {}\n` +
    `const companionChecklistKey = (uid) => \`sherpa_driver_checklist_pending_\${uid}\`;\n` +
    `const companionProgressKey = (uid) => \`sherpa_driver_checklist_progress_\${uid}\`;\n` +
    `${body}\n` +
    'return { companionRenderOnboarding, companionSubmit, companionRenderE2, companionHasHeldWork, ' +
    'companionReadDraft, companionWriteDraft, companionClearDraft, companionReadProgress, companionWriteProgress, ' +
    'companionChecklistPending, companionSetChecklistPending, companionClearChecklistPending, companionPostActStep, render, ' +
    'setDriverState: (v) => { driverState = v; }, ' +
    'getStep: () => companionStep, setStep: (s) => { companionStep = s; }, ' +
    'getScreenHtml: () => $("screen-companion").innerHTML };',
  );
  const api = fn(dom.$, escapeHtml, (n) => showScreenCalls.push(n), (m, k) => toastCalls.push([m, k]),
    driverGreeting, XPD, currentUser, controller,
    localStorage, {}, (uid) => `sherpa_driver_onboarding_draft_${uid}`, postActRoute, new Proxy({}, { get: () => '' }), {});
  api.showScreenCalls = showScreenCalls; api.toastCalls = toastCalls;
  return api;
}

let passed = 0;
const _pending = [];
const tick = () => new Promise((r) => setTimeout(r, 0));
function t(name, fn) { _pending.push(Promise.resolve().then(fn).then(() => { passed++; }, (e) => { console.error(`✗ ${name}`); throw e; })); }
const makeXPD = (over = {}) => {
  const calls = { submit: 0, signOut: 0, complete: 0, accept: 0, pickup: 0 };
  return { calls,
    submitDriverProfile: async (f) => { calls.submit++; calls.submitFields = f; return (over.submit ? over.submit(f) : { ok: true }); },
    signOutUser: async () => { calls.signOut++; },
    completeTask: async () => { calls.complete++; }, acceptTask: async () => { calls.accept++; }, pickupComplete: async () => { calls.pickup++; },
    readOwnAccount: async () => (over.account !== undefined ? over.account : { onboarding_state: 'pending', enabled: false }),
    readDriverAdminFlag: async () => true };
};
const makeCtl = (xpd, currentUser) => makeCompanionController({
  getUid: () => currentUser.uid, readFlag: () => xpd.readDriverAdminFlag(), readAccount: (u) => xpd.readOwnAccount(u),
  submit: (f) => xpd.submitDriverProfile(f), clearDraft: () => {}, bootSettled: async () => {}, rerender: () => {},
});

// ---- A3 perfil «Pedir aprobación» (co-save) SUBMITS with exactly {name,phone,vehicle,plate} (Inicio b reorder:
// pending onboarding is profile-only; the checklist moved to post-activation, so co-save submits directly) ----
t('perfil «Pedir aprobación» (co-save) submits via companionSubmit with exactly {name,phone,vehicle,plate}', async () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'elmer@x.hn' }; const xpd = makeXPD(); const store = {};
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store });
  host.setStep('profile'); host.companionRenderOnboarding();
  dom.$('co-name').value = 'Elmer Padilla'; dom.$('co-phone').value = '+504 9'; dom.$('co-plate').value = 'ABC 1234';
  dom.$('co-save').click(); await tick();               // RUN the real co-save handler (submits directly)
  const draft = JSON.parse(store[`sherpa_driver_onboarding_draft_A`]);
  assert.equal(draft.name, 'Elmer Padilla');            // still staged to the draft before submit
  assert.equal(xpd.calls.submit, 1, '«Pedir aprobación» submits exactly once');
  assert.deepEqual(xpd.calls.submitFields, { name: 'Elmer Padilla', phone: '+504 9', vehicle: 'moto', plate: 'ABC 1234' },
    'submits EXACTLY {name,phone,vehicle,plate} — no extra fields');
});

// ---- the «App de navegación» row is in the POST-ACTIVATION checklist (#co-ck-nav) and WIRED (Inicio b): the row is
// now included directly in the rebuilt checklist, so a tap must reach the nav-pref flow (drv2NavReturn + renderNavApp).
t('the post-activation checklist renders #co-ck-nav WIRED: a tap reaches the nav-pref flow', async () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'e@x.hn' }; const xpd = makeXPD(); const store = {};
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store });
  // The lifted handler resolves its free `renderNavApp`/`drv2NavReturn` from globals (sloppy new Function), so spy there.
  let navOpened = 0; const prevNav = globalThis.renderNavApp, prevRet = globalThis.drv2NavReturn;
  globalThis.renderNavApp = () => { navOpened++; };
  try {
    host.setStep('checklist'); host.companionRenderOnboarding();
    assert.ok(dom.$('co-ck-nav'), '#co-ck-nav exists in the post-activation checklist');
    assert.ok(host.getScreenHtml().includes('App de navegación'), 'the nav-row markup is present in the companion screen');
    assert.ok(dom.$('co-ck-nav')._h && typeof dom.$('co-ck-nav')._h.click === 'function', '#co-ck-nav is WIRED (has a click handler)');
    dom.$('co-ck-nav').click();                          // RUN the real handler
    assert.equal(navOpened, 1, 'a tap reaches the nav-pref flow (renderNavApp)');
    assert.equal(globalThis.drv2NavReturn, 'companion', 'the nav return target is set so choosing an app comes back to the companion');
  } finally { globalThis.renderNavApp = prevNav; globalThis.drv2NavReturn = prevRet; }
});

// ---- Inicio b r1: the post-activation routing lifecycle driven through the REAL companionPostActStep + the real
// device-flag/progress helpers + ACTUAL clicks. Kills the 4 mutants (host routing deleted, «Terminar» a no-op, uid
// scoping removed, practice buttons disconnected) + r1 P1 (no «activated» loop) + r1 P2 (cleared beats a persisted
// '1'; flag-off never routes). `activate` drives the REAL controller through the OBSERVED profile_submitted→active
// transition so decide() genuinely yields 'activated'.
async function activate(uid, opts = {}) {
  const user = { uid, email: `${uid}@x.hn` };
  const xpd = makeXPD(); let acct = { onboarding_state: 'profile_submitted', enabled: false };
  xpd.readOwnAccount = async () => acct;
  const ctl = makeCtl(xpd, user); const dom = makeDom(); const store = {};
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: ctl, store, ...opts });
  await ctl.refresh();                                   // profile_submitted → waiting
  acct = { onboarding_state: 'active', enabled: true };
  await ctl.refresh();                                   // OBSERVED transition → decide()='activated'
  return { user, xpd, ctl, dom, store, host, setAcct: (a) => { acct = a; } };
}

// legacy upgrade guard (through the REAL controller): a cold-start already-active account yields decide()='legacy',
// not 'activated' — so everyone on upgrade (no device flag) goes straight to the app.
t('legacy active driver (cold start, no transition, no flag) → app, never the checklist', async () => {
  const user = { uid: 'L', email: 'l@x.hn' };
  const xpd = makeXPD({ account: { onboarding_state: 'active', enabled: true } });
  const ctl = makeCtl(xpd, user); const host = buildHost({ dom: makeDom(), XPD: xpd, currentUser: user, controller: ctl, store: {} });
  await ctl.refresh();
  assert.equal(ctl.decide().action, 'legacy', 'cold-start active → legacy (no observed transition)');
  assert.equal(host.companionPostActStep(ctl.decide()), false, 'legacy + no flag → app, never the checklist');
  assert.equal(host.companionChecklistPending('L'), false, 'no flag was written for a legacy render');
});

t('MUTANT host-routing-deleted + P1 no-loop: fresh activation → checklist once; the transition is consumed', async () => {
  const { ctl, host } = await activate('A');
  assert.equal(ctl.decide().action, 'activated', 'the observed transition yields «activated»');
  assert.equal(host.companionPostActStep(ctl.decide()), true, 'host routing renders the checklist on activation');
  assert.equal(host.companionChecklistPending('A'), true, 'the device checklist-pending flag is set');
  assert.equal(ctl.decide().action, 'legacy', 'the approval transition was CONSUMED → next decide() is legacy (P1: «activated» fires once)');
  assert.equal(host.companionPostActStep(ctl.decide()), true, 'a re-render before «Terminar» stays on the checklist (flag still set)');
});

t('MUTANT Terminar-no-op + P2 cleared-beats-persisted: «Terminar» → app on the first click, even when removeItem throws', async () => {
  for (const removeThrows of [false, true]) {
    const { ctl, host, dom } = await activate('A', { removeThrows });
    host.companionPostActStep(ctl.decide());               // activation → flag set + checklist
    assert.equal(host.companionChecklistPending('A'), true);
    host.setStep('checklist'); host.companionRenderOnboarding();
    dom.$('co-terminar').click();                          // RUN the real «Terminar» handler (clears flag + render())
    assert.equal(host.companionChecklistPending('A'), false, `«Terminar» cleared the flag (removeThrows=${removeThrows}: cleared marker beats any persisted '1')`);
    assert.equal(host.companionPostActStep(ctl.decide()), false, 'after «Terminar» → app, never the checklist');
    assert.equal(host.showScreenCalls.at(-1), 'offshift', '«Terminar» → the SHIPPED render() showed the app (offshift), not the checklist');
  }
});

t('MUTANT uid-scoping-removed: the checklist-pending flag never leaks across uids', async () => {
  const { host } = await activate('A');
  host.companionSetChecklistPending('A');
  assert.equal(host.companionChecklistPending('A'), true);
  assert.equal(host.companionChecklistPending('B'), false, "uid B must NOT inherit uid A's pending flag");
});

t('MUTANT practice-buttons-disconnected + P2 practice-safe: both entries advance; a routine render in practice does not eject', async () => {
  const { ctl, host, dom } = await activate('A');
  host.companionPostActStep(ctl.decide());                 // → checklist (flag set)
  host.setStep('checklist'); host.companionRenderOnboarding();
  dom.$('co-ck-practice').click();
  assert.equal(host.getStep(), 'practice', 'the practice ROW entry advances to the practice step');
  host.companionPostActStep(ctl.decide());                 // a routine render WHILE in practice
  assert.equal(host.getStep(), 'practice', 'a routine render during practice does NOT eject the driver back to the checklist');
  host.setStep('checklist'); host.companionRenderOnboarding();
  dom.$('co-practice-go').click();
  assert.equal(host.getStep(), 'practice', 'the FOOTER practice button also advances to the practice step');
});

t('P2 flag-off read never routes to the checklist (even with a stale pending flag)', async () => {
  const { ctl, host, xpd } = await activate('A');
  host.companionSetChecklistPending('A');                  // a stale pending flag exists
  xpd.readDriverAdminFlag = async () => false;             // the companion feature reads OFF now
  await ctl.refresh();                                     // S.flag becomes false
  assert.equal(host.companionPostActStep(ctl.decide()), false, 'flag-off → normal routing (never the checklist), despite the pending flag');
});

t('r2 MUTANT interpose-deleted-from-render(): the SHIPPED render() routes a fresh activation to the checklist, not the app', async () => {
  const { ctl, host } = await activate('A');
  assert.equal(ctl.decide().action, 'activated');
  host.render();                                           // the REAL shipped render() — its companion block must route here
  assert.equal(host.showScreenCalls.at(-1), 'companion', 'render() showed the companion checklist — deleting `if (companionPostActStep(r)) return;` would show offshift (the app) here');
  assert.ok(host.getScreenHtml().includes('Listo para repartir'), 'the checklist is what the shipped render() rendered');
  assert.equal(host.companionChecklistPending('A'), true, 'render() recorded checklist-pending');
});

t('r2 cleared-state is PER-UID: A dismisses, B activates+dismisses (same session), back to A → still dismissed, with removeItem throwing', async () => {
  const { host } = await activate('A', { removeThrows: true });   // one host = one in-memory maps instance
  host.companionSetChecklistPending('A'); host.companionClearChecklistPending('A');   // A: pending → Terminar (localStorage keeps '1' — removeItem threw)
  assert.equal(host.companionChecklistPending('A'), false, 'A dismissed');
  host.companionSetChecklistPending('B'); host.companionClearChecklistPending('B');   // B: pending → Terminar (same session)
  assert.equal(host.companionChecklistPending('B'), false, 'B dismissed');
  // a SINGLE-uid cleared marker would have been overwritten by B's clear → A would resurface from the persisted '1'.
  assert.equal(host.companionChecklistPending('A'), false, "A's dismissal SURVIVED B's cycle (per-uid cleared MAP, not a single uid)");
});

t('r2 "progress lost" FIXED through a REAL controller draft-clear (the draft is genuinely cleared, the ack survives)', async () => {
  const user = { uid: 'A', email: 'a@x.hn' }; const store = {}; const dom = makeDom();
  const xpd = makeXPD(); let acct = { onboarding_state: 'profile_submitted', enabled: false };
  xpd.readOwnAccount = async () => acct;
  const hostRef = {};
  const ctl = makeCompanionController({
    getUid: () => user.uid, readFlag: () => xpd.readDriverAdminFlag(), readAccount: (u) => xpd.readOwnAccount(u),
    submit: (f) => xpd.submitDriverProfile(f),
    clearDraft: () => { if (hostRef.host) hostRef.host.companionClearDraft(user.uid); },   // the REAL host draft-clear, as companionEnsure wires it
    bootSettled: async () => {}, rerender: () => {},
  });
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: ctl, store });
  hostRef.host = host;
  await ctl.refresh();                                     // profile_submitted
  host.companionWriteDraft({ name: 'Draftee' });           // something in the pending draft
  acct = { onboarding_state: 'active', enabled: true }; await ctl.refresh();   // OBSERVED transition
  host.companionPostActStep(ctl.decide());                 // → checklist
  host.setStep('checklist'); host.companionRenderOnboarding();
  dom.$('co-ck-perms').click();                            // ack → PROGRESS store
  assert.equal(host.companionReadProgress('A').ackPerms, true);
  await ctl.refresh();                                     // active ≠ pending → env.clearDraft() → REAL host.companionClearDraft('A')
  assert.equal(host.companionReadDraft().name, undefined, 'the controller GENUINELY cleared the pending draft');
  assert.equal(host.companionReadProgress('A').ackPerms, true, 'the ack survives in the progress store across the REAL draft-clear');
});

// ---- "Pedir aprobación" (A4) is the submit path ----
t('"Pedir aprobación" runs companionSubmit → submitDriverProfile is called once', async () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'e@x.hn' }; const xpd = makeXPD(); const store = {};
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store });
  await host.companionSubmit();                         // RUN the real submit handler
  assert.equal(xpd.calls.submit, 1, 'Pedir aprobación submits exactly once');
});

// ---- A5 practice is brand-neutral and calls NO operational writer ----
// Inicio c: the practica branch is now the prototype S.practica INTRO card (not a text walkthrough); «Empezar práctica»
// launches the isolated demo controller (companionPracticeStart), whose ZERO-write guarantee is proven end-to-end in
// practica-demo.test.js. Here: the intro card renders to proto, and «back» returns to the checklist.
t('the practica branch renders the prototype intro card (banner + 4 named steps + «Empezar práctica»); back → checklist', () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'e@x.hn' }; const xpd = makeXPD();
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store: {} });
  host.setStep('practice'); host.companionRenderOnboarding();
  const html = host.getScreenHtml();
  assert.ok(html.includes('Nada de esto es real'), 'the «Nada de esto es real» banner is shown (demo is marked non-real)');
  assert.ok(html.includes('Te llega una oferta') && html.includes('Vas al restaurante') && html.includes('Deslizás'), 'the 4 named steps are listed');
  assert.ok(dom.$('co-practica-start'), '«Empezar práctica» launches the demo controller');
  assert.ok(dom.$('co-practica-back'), 'the back control is present');
  dom.$('co-practica-back').click();
  assert.equal(host.getStep(), 'checklist', 'back returns to the checklist');
});

// ---- E2 is a plain screen with NO automatic sign-out; the DRIVER taps "Cerrar sesión" ----
t('companionRenderE2 shows E2 WITHOUT signing out; tapping "Cerrar sesión" signs out', async () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'e@x.hn' }; const xpd = makeXPD(); const store = {};
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store });
  host.companionRenderE2();
  const html = dom.$('screen-companion').innerHTML;
  assert.ok(html.includes('Cuenta desactivada'), 'E2 copy shown');
  // refreshed to prototype S.desactivada: dim lock illustration + full copy + «Hablá con despacho» dispatch card
  assert.ok(/co-illus/.test(html) && /M7\.5 11V7\.5/.test(html), 'E2 shows the (dim) lock illustration');
  assert.ok(/Si tenés efectivo pendiente, entregalo en el restaurante/.test(html), 'E2 uses the full prototype copy');
  assert.ok(/Hablá con despacho/.test(html) && /co-dispatch-card/.test(html), 'E2 has the «Hablá con despacho» dispatch card');
  assert.ok(!/#8a241d|#7a3a35|#B4322A/.test(html), 'the old red E2 colors are gone');
  assert.equal(xpd.calls.signOut, 0, 'E2 must NOT auto sign-out');
  await dom.$('co-e2-signout').click();                 // the DRIVER taps it
  await Promise.resolve();
  assert.equal(xpd.calls.signOut, 1, 'tapping Cerrar sesión signs out');
});

// ---- submit explicit deactivation → shows E2, still NO auto sign-out ----
t('a submit that returns an explicit deactivation message shows E2 and does not auto sign-out', async () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'e@x.hn' };
  const xpd = makeXPD({ submit: () => { throw { code: 'functions/permission-denied', message: 'Tu cuenta está desactivada.' }; } });
  const store = {};
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store });
  await host.companionSubmit();
  assert.ok(dom.$('screen-companion').innerHTML.includes('Cuenta desactivada'), 'explicit deactivation → E2 shown');
  assert.equal(xpd.calls.signOut, 0, 'no automatic sign-out on submit deactivation');
});

// ---- codex r3 #2: a completed FLAG-OFF read governs the submit outcome (legacy only, never E2) ----
t('a submit outcome is forced to legacy (no E2) when the last read confirmed the flag OFF', async () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'e@x.hn' };
  const xpd = makeXPD({ submit: () => { throw { code: 'functions/permission-denied', message: 'Tu cuenta está desactivada.' }; } });
  xpd.readDriverAdminFlag = async () => false;          // the flag reads OFF
  const ctl = makeCtl(xpd, user);
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: ctl, store: {} });
  await ctl.refresh();                                   // completed flag-off read → controller.isFlagOff() === true
  await host.companionSubmit();                          // callable returns an explicit deactivation
  assert.ok(!host.getScreenHtml().includes('Cuenta desactivada'), 'flag-off must NOT show E2');
  assert.ok(host.showScreenCalls.includes('offshift'), 'flag-off falls through to the shipped render (the app)');
});

// ---- codex r3 #4 (Inicio b: the acks are now #co-ck-perms / #co-ck-cash on the rebuilt post-activation checklist):
// onboarding progress advances through the REAL handlers even when localStorage writes fail ----
t('post-activation checklist acks (#co-ck-perms / #co-ck-cash) advance through the REAL handlers even when localStorage.setItem throws', async () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'e@x.hn' }; const xpd = makeXPD(); const store = {};
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store, storageThrows: true });
  host.setStep('checklist'); host.companionRenderOnboarding();
  dom.$('co-ck-perms').click();                          // RUN the real perms-ack handler (writes PROGRESS + re-renders)
  dom.$('co-ck-cash').click();                           // RUN the real cash-ack handler
  const p = host.companionReadProgress(user.uid);        // r1 P2: acks live in the durable PROGRESS store, not the draft
  assert.equal(p.ackPerms, true, 'perms ack retained in-memory (progress) despite the storage failure');
  assert.equal(p.ackCash, true, 'cash ack retained in-memory (progress) despite the storage failure');
  assert.equal(store['sherpa_driver_checklist_progress_A'], undefined, 'nothing persisted to the progress store (storage threw)');
});

await Promise.all(_pending).catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
console.log(`✓ onboarding-host: ${passed} tests passed`);
