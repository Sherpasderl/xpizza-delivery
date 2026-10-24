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
function buildHost({ dom, XPD, currentUser, controller, store, storageThrows = false }) {
  const body = [
    liftFn('companionShellHtml'), liftFn('companionReadDraft'), liftFn('companionWriteDraft'),
    liftFn('companionClearDraft'), liftFn('companionRenderScreen'), liftFn('companionRenderE2'),
    liftFn('companionRenderOnboarding'), liftFn('companionHasHeldWork'), liftFn('companionSubmit'),
  ].join('\n');
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { if (storageThrows) throw new Error('quota exceeded'); store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const fn = new Function(
    '$', 'escapeHtml', 'showScreen', 'toast', 'driverGreeting', 'render', 'XPD', 'currentUser', 'companion',
    'localStorage', 'allTasks', 'companionDraftKey', '__out',
    `let companionStep = 'profile'; let companionDraft = null;\n${body}\n` +
    'return { companionRenderOnboarding, companionSubmit, companionRenderE2, companionHasHeldWork, ' +
    'companionReadDraft, companionWriteDraft, ' +
    'getStep: () => companionStep, setStep: (s) => { companionStep = s; }, ' +
    'getScreenHtml: () => $("screen-companion").innerHTML };',
  );
  const showScreenCalls = [];
  const toastCalls = [];
  const renderCalls = [];
  const api = fn(dom.$, escapeHtml, (n) => showScreenCalls.push(n), (m, k) => toastCalls.push([m, k]),
    driverGreeting, () => renderCalls.push(1), XPD, currentUser, controller,
    localStorage, {}, (uid) => `sherpa_driver_onboarding_draft_${uid}`, {});
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

// ---- A3 "Guardar perfil" STAGES, never submits ----
t('A3 "Guardar perfil" writes the draft + advances to the checklist, and does NOT call submitDriverProfile', async () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'elmer@x.hn' }; const xpd = makeXPD(); const store = {};
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store });
  host.setStep('profile'); host.companionRenderOnboarding();
  dom.$('co-name').value = 'Elmer Padilla'; dom.$('co-phone').value = '+504 9'; dom.$('co-plate').value = 'ABC 1234';
  dom.$('co-save').click(); await tick();               // RUN the real co-save handler (+ settle any mutated submit)
  const draft = JSON.parse(store[`sherpa_driver_onboarding_draft_A`]);
  assert.equal(draft.name, 'Elmer Padilla');            // staged to the draft
  assert.equal(host.getStep(), 'checklist');            // advanced
  assert.equal(xpd.calls.submit, 0, 'Guardar perfil must NOT submit');
});

// ---- SLICE2:ONBOARDING-NAV: the «App de navegación» row is injected + wired after the checklist renders ----
// (Codex r4-followup): covers the shipped index.html insertAdjacentHTML injection, not merely the absence of a
// crash. Removing the ONBOARDING-NAV injection turns this RED.
t('the «App de navegación» row (co-nav-row) is injected after the checklist renders and is WIRED', async () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'e@x.hn' }; const xpd = makeXPD(); const store = {};
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store });
  host.setStep('checklist'); host.companionRenderOnboarding();
  assert.ok(dom.$('co-nav-row'), 'co-nav-row exists after the checklist renders (afterend sibling injection)');
  assert.ok(host.getScreenHtml().includes('App de navegación'), 'the nav-row markup is present in the companion screen');
  assert.ok(dom.$('co-nav-row')._h && typeof dom.$('co-nav-row')._h.click === 'function', 'co-nav-row is WIRED (has a click handler)');
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

// ---- codex r3 #4: onboarding progress advances through the REAL handlers even when localStorage writes fail ----
t('checklist acknowledgments advance through the REAL handlers even when localStorage.setItem throws', async () => {
  const dom = makeDom(); const user = { uid: 'A', email: 'e@x.hn' }; const xpd = makeXPD(); const store = {};
  const host = buildHost({ dom, XPD: xpd, currentUser: user, controller: makeCtl(xpd, user), store, storageThrows: true });
  host.setStep('checklist'); host.companionRenderOnboarding();
  dom.$('co-bx-perms').closest('label').click();        // RUN the real perms-ack handler (writes draft + re-renders)
  dom.$('co-bx-cash').closest('label').click();         // RUN the real cash-ack handler
  const d = host.companionReadDraft();
  assert.equal(d.ackPerms, true, 'perms ack retained in-memory despite the storage failure');
  assert.equal(d.ackCash, true, 'cash ack retained in-memory despite the storage failure');
  assert.equal(store['sherpa_driver_onboarding_draft_A'], undefined, 'nothing was persisted (storage threw)');
});

await Promise.all(_pending).catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
console.log(`✓ onboarding-host: ${passed} tests passed`);
