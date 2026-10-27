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
  const exists = new Set(['screen-companion']);
  const mkEl = (id) => ({ value: '', _text: '', _html: '', _h: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); if (id === 'screen-companion') { exists.clear(); exists.add('screen-companion'); for (const m of String(v).matchAll(/id="([\w-]+)"/g)) exists.add(m[1]); } },
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
    // Inicio b r1: the post-activation progress store, the device-flag helpers, and the routing step render()
    // delegates to — lifted so the REAL flag/routing lifecycle is driven by the tests (not re-implemented).
    liftFn('companionReadProgress'), liftFn('companionWriteProgress'), liftFn('companionSetChecklistPending'),
    liftFn('companionChecklistPending'), liftFn('companionClearChecklistPending'), liftFn('companionPostActStep'),
  ].join('\n');
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { if (storageThrows) throw new Error('quota exceeded'); store[k] = String(v); },
    removeItem: (k) => { if (removeThrows) throw new Error('remove failed'); delete store[k]; },
  };
  const fn = new Function(
    '$', 'escapeHtml', 'showScreen', 'toast', 'driverGreeting', 'render', 'XPD', 'currentUser', 'companion',
    'localStorage', 'allTasks', 'companionDraftKey', 'postActRoute', '__out',
    `let companionStep = 'profile'; let companionDraft = null;\n` +
    `let companionChecklistPendingMem = null; let companionChecklistClearedMem = null; let companionProgressMem = {};\n` +
    `const companionChecklistKey = (uid) => \`sherpa_driver_checklist_pending_\${uid}\`;\n` +
    `const companionProgressKey = (uid) => \`sherpa_driver_checklist_progress_\${uid}\`;\n` +
    `${body}\n` +
    'return { companionRenderOnboarding, companionSubmit, companionRenderE2, companionHasHeldWork, ' +
    'companionReadDraft, companionWriteDraft, companionReadProgress, companionWriteProgress, ' +
    'companionChecklistPending, companionSetChecklistPending, companionClearChecklistPending, companionPostActStep, ' +
    'getStep: () => companionStep, setStep: (s) => { companionStep = s; }, ' +
    'getScreenHtml: () => $("screen-companion").innerHTML };',
  );
  const showScreenCalls = [];
  const toastCalls = [];
  const renderCalls = [];
  const api = fn(dom.$, escapeHtml, (n) => showScreenCalls.push(n), (m, k) => toastCalls.push([m, k]),
    driverGreeting, () => renderCalls.push(1), XPD, currentUser, controller,
    localStorage, {}, (uid) => `sherpa_driver_onboarding_draft_${uid}`, postActRoute, {});
  api.showScreenCalls = showScreenCalls; api.toastCalls = toastCalls; api.renderCalls = renderCalls;
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
    assert.ok(host.renderCalls.length >= 1, '«Terminar» triggered render()');
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

t('P2 "progress lost" FIXED: checklist acks live in the durable progress store and survive the controller clearing the draft', async () => {
  const { ctl, host, dom } = await activate('A');
  host.companionPostActStep(ctl.decide());                 // → checklist
  host.setStep('checklist'); host.companionRenderOnboarding();
  dom.$('co-ck-perms').click();                            // ack → progress store
  await ctl.refresh();                                     // the controller clears the pending-profile DRAFT (active ≠ pending)
  assert.equal(host.companionReadProgress('A').ackPerms, true, 'the ack persists in the progress store across a draft-clearing refresh');
  assert.equal(host.companionReadDraft().ackPerms, undefined, 'and it was NOT written to the (cleared) pending draft');
});

// ---- "Pedir aprobación" (A4) is the submit path ----
t('"Pedir aprobación" runs companionSubmit → submitDriverProfile is called once', async () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'e@x.hn' }; const xpd = makeXPD(); const store = {};
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store });
  await host.companionSubmit();                         // RUN the real submit handler
  assert.equal(xpd.calls.submit, 1, 'Pedir aprobación submits exactly once');
});

// ---- A5 practice is brand-neutral and calls NO operational writer ----
t('the practice flow renders the neutral greeting and, through its final "done" step, calls NO operational writer', async () => {
  const user = { uid: 'A', email: 'e@x.hn' };
  // (a) the greeting step renders the neutral no-brand greeting
  let dom = makeDom(); let xpd = makeXPD();
  let host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store: { [`sherpa_driver_onboarding_draft_A`]: JSON.stringify({ practiceStep: 3 }) } });
  host.setStep('practice'); host.companionRenderOnboarding();
  assert.ok(host.getScreenHtml().includes('Hola, soy su repartidor.'), 'practice greeting is the neutral driverGreeting({})');
  // (b) advancing through the LAST step's "Terminé la práctica" runs the done branch — it must write no real order
  dom = makeDom(); xpd = makeXPD();
  host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store: { [`sherpa_driver_onboarding_draft_A`]: JSON.stringify({ practiceStep: 5 }) } });
  host.setStep('practice'); host.companionRenderOnboarding();
  dom.$('co-practice-next').click(); await tick();      // RUN the final practice step (the done branch)
  assert.equal(xpd.calls.complete, 0, 'practice must never complete a real task');
  assert.equal(xpd.calls.accept, 0); assert.equal(xpd.calls.pickup, 0); assert.equal(xpd.calls.submit, 0);
});

// ---- E2 is a plain screen with NO automatic sign-out; the DRIVER taps "Cerrar sesión" ----
t('companionRenderE2 shows E2 WITHOUT signing out; tapping "Cerrar sesión" signs out', async () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'e@x.hn' }; const xpd = makeXPD(); const store = {};
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store });
  host.companionRenderE2();
  const html = dom.$('screen-companion').innerHTML;
  assert.ok(html.includes('Cuenta desactivada'), 'E2 copy shown');
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
  assert.ok(host.renderCalls.length >= 1, 'flag-off falls through to the legacy render');
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
