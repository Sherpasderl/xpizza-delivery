// return-target.test.js — the returning-state nav target (prototype S.disponibleRegresando). Drives the REAL
// drv2SetReturnTarget / drv2GetReturnTarget / drv2ClearReturnTarget / drv2CaptureReturnTarget + renderDisponible
// (lifted from index.html) with the REAL brandLabel (label source) and the REAL navBtnHtml (deep-link). Proves:
//   • capture at THIS client's delivery → the returning screen shows a SOFT nav button to the stamped hub, labelled
//     with the order's display name (both brands, data-driven — never a literal);
//   • NO capture (another device / an offline replay never ran this client's btn-delivered) → the button is HIDDEN,
//     and NEVER falls back to XPD.RESTAURANT / a brand constant (the advisor mutant);
//   • an account switch (uid mismatch) hides it; leaving the returning state clears it; sessionStorage rehydrates it.
// Run: `node return-target.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { brandLabel } from './brand-helpers.js';      // the REAL label source (order.restaurant_display_name)
import { navBtnHtml } from './stacked-view.js';         // the REAL deep-link builder (Waze/Maps href to the hub)

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');
const SCRIPT = readFileSync(join(__dir, 'index.html'), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];
function liftFn(name) {
  let start = SCRIPT.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  let depth = 0, seen = false;
  for (let i = start; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') { depth++; seen = true; }
    else if (SCRIPT[i] === '}') { depth--; if (seen && depth === 0) return SCRIPT.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function liftLine(re, label) { const m = SCRIPT.match(re); assert.ok(m, `${label} not found`); return m[0]; }
// the REAL module state (so the test uses the real sessionStorage key, not a re-declared literal)
const KEY_LINE = liftLine(/const RETURN_TARGET_KEY = '[^']*';/, 'RETURN_TARGET_KEY');
const VAR_LINE = liftLine(/let returnTarget = null;/, 'returnTarget');
const RETURN_TARGET_KEY = KEY_LINE.match(/'([^']*)'/)[1];

function boot({ status = 'returning', uid = 'drv', seed = undefined } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="idle-state">'
    + '<div class="idle-top"><div class="idle-check" id="idle-icon"></div><div class="idle-msg" id="idle-msg">x</div>'
    + '<div class="idle-sub" id="idle-sub">x</div><button class="idle-help-link" id="idle-help-link">h</button>'
    + '<button class="big-btn primary hidden" id="arrive-btn">Estoy en el restaurante</button></div>'
    + '<div class="statbar" id="idle-statbar"><div id="stat-deliveries">0</div><div id="stat-cash">L 0</div></div>'
    + '</div></body></html>', { url: 'https://driver.test/', pretendToBeVisual: true });
  const { document, window } = dom.window;
  const sessionStorage = window.sessionStorage;
  if (seed !== undefined) { try { sessionStorage.setItem(RETURN_TARGET_KEY, JSON.stringify(seed)); } catch {} }
  const $ = (id) => document.getElementById(id);
  const ICONS = new Proxy({}, { get: (_, k) => `<svg data-ic="${String(k)}"></svg>` });
  const NAVP_ICONS = { navi: '<svg data-navi></svg>' };
  const driverState = { status, last_ping: Date.now() };
  const XPD = { isStalePing: () => false, RESTAURANT: { lat: 15.507489753573818, lng: -88.0398486953722, name: 'X Pizza' } };
  const drv2ReadNavPref = () => 'Waze';
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const currentUser = { uid };
  const body = KEY_LINE + '\n' + VAR_LINE + '\nconst DRV2_PAUSE_ENABLED = false;\nconst DRV2_ENDSHIFT_SLIDE = false;\nfunction renderPausa(){}\nlet drv2SoloCancel = null;\nfunction renderSoloCancel(){}\n'
    + liftFn('drv2SetReturnTarget') + '\n' + liftFn('drv2GetReturnTarget') + '\n'
    + liftFn('drv2ClearReturnTarget') + '\n' + liftFn('drv2CaptureReturnTarget') + '\n'
    + liftFn('renderDisponible') + '\n'
    + 'return { drv2SetReturnTarget, drv2GetReturnTarget, drv2ClearReturnTarget, drv2CaptureReturnTarget, renderDisponible, runRegion: (src, o, actingUid) => { eval(src); }, setStatus: (s) => { driverState.status = s; }, setUid: (u) => { currentUser.uid = u; }, raw: () => { try { return sessionStorage.getItem(RETURN_TARGET_KEY); } catch { return null; } } };';
  const names = ['document', '$', 'sessionStorage', 'ICONS', 'NAVP_ICONS', 'driverState', 'XPD', 'brandLabel', 'navBtnHtml', 'drv2ReadNavPref', 'escapeHtml', 'currentUser'];
  const api = (new Function(...names, body))(document, $, sessionStorage, ICONS, NAVP_ICONS, driverState, XPD, brandLabel, navBtnHtml, drv2ReadNavPref, escapeHtml, currentUser);
  return { api, document, host: $('idle-state'), $ };
}

// a delivered order ENTRY as the btn-delivered handler sees it: `o.order` (the record) + `o.pickupTask` (stamped hub)
const entry = (displayName, lat, lng, rid = 'x_pizza') => ({
  order: { restaurant_display_name: displayName, restaurant_id: rid },
  pickupTask: { id: 'pk1', destination_lat: lat, destination_lng: lng },
});

let passed = 0;
const t = (name, fn) => { try { fn(); passed += 1; } catch (e) { console.error(`✗ ${name}`); throw e; } };

t('x_pizza: capture → returning nav button; label = brandLabel(order) EXACTLY (display name ONLY, address omitted), deep-linked to the stamped hub', () => {
  const h = boot({ status: 'returning' });
  const order = { restaurant_display_name: 'X. Pizza', restaurant_id: 'x_pizza' };   // a realistic display name — the brand, NOT the address
  h.api.drv2CaptureReturnTarget({ order, pickupTask: { id: 'pk1', destination_lat: 15.50749, destination_lng: -88.03985 } });
  h.api.renderDisponible();
  const nav = h.host.querySelector('.disp-return-nav');
  assert.ok(nav, 'the returning nav button is shown');
  assert.equal(nav.querySelector('.nav-primary .nav-dest').textContent, '→ ' + brandLabel(order), 'label equals brandLabel(order) EXACTLY — no address appended (the address has no data source; ruling)');
  assert.doesNotMatch(nav.querySelector('.nav-primary .nav-dest').textContent, / · |Blvd|Norte|Col\./, 'NO address fragment in the label');
  assert.match(nav.querySelector('.nav-primary').getAttribute('href'), /waze\.com\/ul\?ll=15\.50749,-88\.03985/, 'Waze deep-link points at the stamped hub');
  assert.ok(h.host.querySelector('#arrive-btn'), 'the «Estoy en el restaurante» arrive-btn is KEPT (below the nav button)');
});

t('la_musa: a DIFFERENT brand → its OWN display name + its OWN hub (brand-agnostic, never the X.Pizza constant)', () => {
  const h = boot({ status: 'returning' });
  const order = { restaurant_display_name: 'La Musa', restaurant_id: 'la_musa' };
  h.api.drv2CaptureReturnTarget({ order, pickupTask: { id: 'pk2', destination_lat: 15.49000, destination_lng: -88.02000 } });
  h.api.renderDisponible();
  const nav = h.host.querySelector('.disp-return-nav');
  assert.equal(nav.querySelector('.nav-primary .nav-dest').textContent, '→ ' + brandLabel(order), 'la_musa label = its display name exactly');
  assert.match(nav.querySelector('.nav-primary').getAttribute('href'), /ll=15\.49,-88\.02/, 'la_musa hub (not 15.5074/-88.0398)');
  assert.doesNotMatch(nav.querySelector('.nav-primary').getAttribute('href'), /15\.50749|88\.0398/, 'NOT the hardcoded X.Pizza RESTAURANT hub');
});

t('NO snapshot (another device / offline replay never ran this client btn-delivered) → the nav button is HIDDEN, no constant fallback (advisor mutant)', () => {
  const h = boot({ status: 'returning' });   // nothing captured
  h.api.renderDisponible();
  assert.ok(!h.host.querySelector('.disp-return-nav'), 'no nav button without a snapshot');
  assert.ok(!/X Pizza|X\. Pizza|waze\.com/.test(h.host.innerHTML), 'NEVER falls back to XPD.RESTAURANT / a brand constant');
  assert.ok(h.host.querySelector('#arrive-btn'), 'the arrive-btn is still there (the manual at_restaurant trigger)');
});

t('account switch: a target captured by another uid is NOT shown (hidden), never leaked across accounts', () => {
  const h = boot({ status: 'returning', uid: 'drvA' });
  h.api.drv2CaptureReturnTarget(entry('X. Pizza', 15.5, -88.0));
  h.api.setUid('drvB');                       // a different driver signs in on this device
  h.api.renderDisponible();
  assert.ok(!h.host.querySelector('.disp-return-nav'), 'the other account’s target is not shown');
});

t('leaving the returning state clears the snapshot (available / at_restaurant)', () => {
  const h = boot({ status: 'returning' });
  h.api.drv2CaptureReturnTarget(entry('X. Pizza', 15.5, -88.0));
  h.api.renderDisponible();
  assert.ok(h.host.querySelector('.disp-return-nav'), 'shown while returning');
  h.api.setStatus('available'); h.api.renderDisponible();
  assert.equal(h.api.raw(), null, 'the snapshot is cleared from sessionStorage on leaving returning');
  h.api.setStatus('returning'); h.api.renderDisponible();
  assert.ok(!h.host.querySelector('.disp-return-nav'), 'and it does NOT come back (truly cleared)');
});

t('a nameless or hub-less completion captures NO target (no dead button)', () => {
  const h1 = boot({ status: 'returning' });
  h1.api.drv2CaptureReturnTarget(entry('', 15.5, -88.0));            // unknown/unconfigured brand → no name
  h1.api.renderDisponible();
  assert.ok(!h1.host.querySelector('.disp-return-nav'), 'no name → no button');
  const h2 = boot({ status: 'returning' });
  h2.api.drv2CaptureReturnTarget({ order: { restaurant_display_name: 'X. Pizza' }, pickupTask: {} });   // no stamped hub
  h2.api.renderDisponible();
  assert.ok(!h2.host.querySelector('.disp-return-nav'), 'no finite hub → no button');
});

t('sessionStorage rehydrates the target after a reload (fresh module state, same session store)', () => {
  const h = boot({ status: 'returning', uid: 'drv', seed: { name: 'X. Pizza', lat: 15.51, lng: -88.04, uid: 'drv' } });
  h.api.renderDisponible();   // in-memory returnTarget starts null → reads the seeded sessionStorage
  const nav = h.host.querySelector('.disp-return-nav');
  assert.ok(nav, 'rehydrated from sessionStorage');
  assert.equal(nav.querySelector('.nav-primary .nav-dest').textContent, '→ X. Pizza', 'rehydrated label (display name only)');
});

t('stacked: the LAST completed delivery wins (overwrite)', () => {
  const h = boot({ status: 'returning' });
  h.api.drv2CaptureReturnTarget(entry('X. Pizza', 15.5, -88.0, 'x_pizza'));
  h.api.drv2CaptureReturnTarget(entry('La Musa', 15.49, -88.02, 'la_musa'));   // a second delivery completes
  h.api.renderDisponible();
  const nav = h.host.querySelector('.disp-return-nav');
  assert.match(nav.querySelector('.nav-primary .nav-dest').textContent, /La Musa/, 'the last completion’s restaurant is the target');
});

t('P2-8: the btn-delivered SLICE3:RETURN-TARGET-CAPTURE region actually CAPTURES (integration — kills the removed-capture mutant)', () => {
  const region = SCRIPT.match(/SLICE3:RETURN-TARGET-CAPTURE:START[\s\S]*?===== \*\/\n([\s\S]*?)\n\s*\/\* ===== SLICE3:RETURN-TARGET-CAPTURE:END/)[1];
  assert.ok(/drv2CaptureReturnTarget\(o, actingUid\)/.test(region), 'the region calls the capture with the pre-await actingUid (Codex P2-2)');
  const h = boot({ status: 'returning' });
  h.api.runRegion(region, entry('X. Pizza', 15.5, -88.03, 'x_pizza'), 'drv');   // run the REAL region source in the handler closure
  h.api.renderDisponible();
  assert.ok(h.host.querySelector('.disp-return-nav'), 'the region captured the target — emptying the region → no button → RED');
});

t('P2-3/NEW-2: drv2SessionTeardown clears returnTarget + drv2SoloCancel + the problema overlay; BOTH teardown points call it (A→B→A / shift-end)', () => {
  // Structural: the EVERY-auth-transition teardown (covers a uid change A→B→A where B never renders the returning
  // state) AND cleanupShift (shift end / sign-out) both call drv2SessionTeardown — removing either call → RED.
  const authRegion = SCRIPT.match(/SLICE3:INICIO-DEMO-TEARDOWN:START[\s\S]*?===== \*\/\n([\s\S]*?)\n\s*\/\* ===== SLICE3:INICIO-DEMO-TEARDOWN:END/)[1];
  const shiftRegion = SCRIPT.match(/SLICE3:OFFLINE-TEARDOWN-3:START[\s\S]*?===== \*\/\n([\s\S]*?)\n\s*\/\* ===== SLICE3:OFFLINE-TEARDOWN-3:END/)[1];
  assert.match(authRegion, /drv2SessionTeardown\(\)/, 'the every-auth-transition teardown calls drv2SessionTeardown (uid change A→B→A)');
  assert.match(shiftRegion, /drv2SessionTeardown\(\)/, 'cleanupShift (shift end / sign-out → onAuth null) calls drv2SessionTeardown');
  // Behavioral: lift the REAL drv2SessionTeardown and prove it clears every per-session state.
  const dom = new JSDOM('<!doctype html><body><div id="drv2-problema" class="open"></div></body>', { url: 'https://driver.test/', pretendToBeVisual: true });
  const { document } = dom.window;
  const $ = (id) => document.getElementById(id);
  const sessionStorage = dom.window.sessionStorage;
  sessionStorage.setItem(RETURN_TARGET_KEY, JSON.stringify({ name: 'X', lat: 1, lng: 1, uid: 'drvA' }));
  // FIXTURE (prod parity): the lifted drv2SessionTeardown reads drv2CerradoDismiss through an `if (…)` guard. Production
  // ALWAYS declares it at module scope (index.html `let drv2CerradoDismiss = null;`), null unless a «Turno cerrado» summary
  // is open — so the real teardown resolves the binding and the guard short-circuits when no summary is open. Declare it
  // null here (the no-open-summary default) so the fragment harness mirrors that always-declared binding.
  const body = KEY_LINE + '\nlet returnTarget = { name: "X", lat: 1, lng: 1, uid: "drvA" };\nlet drv2SoloCancel = { cancelledNum: 7 };\nlet drv2ProblemGen = 5, drv2ProblemInFlight = true;\nlet drv2CerradoDismiss = null;\n'
    + liftFn('drv2ClearReturnTarget') + '\n' + liftFn('drv2SessionTeardown') + '\n'
    + 'return { run: () => drv2SessionTeardown(), state: () => ({ returnTarget, drv2SoloCancel, drv2ProblemGen, drv2ProblemInFlight }), raw: () => { try { return sessionStorage.getItem(RETURN_TARGET_KEY); } catch { return null; } } };';
  const api = (new Function('document', '$', 'sessionStorage', body))(document, $, sessionStorage);
  assert.ok($('drv2-problema'), 'the problema overlay is mounted before teardown');
  const before = api.state();
  api.run();
  const after = api.state();
  assert.equal(after.returnTarget, null, 'returnTarget cleared (A→B→A cannot resurrect it)');
  assert.equal(api.raw(), null, 'the sessionStorage target is removed too');
  assert.equal(after.drv2SoloCancel, null, 'drv2SoloCancel banner cleared');
  assert.equal(after.drv2ProblemInFlight, false, 'problema in-flight reset');
  assert.ok(after.drv2ProblemGen > before.drv2ProblemGen, 'problema generation bumped → any in-flight ack is invalidated');
  assert.ok(!$('drv2-problema'), 'the body-mounted problema overlay is removed from the DOM (NEW-2: must not survive teardown)');
});

t('P2-3/r3: the auth-transition teardown fires on sign-out or a uid change, NOT on the initial same-account restore (keeps the saved return target on reload)', () => {
  const region = SCRIPT.match(/SLICE3:INICIO-DEMO-TEARDOWN:START[\s\S]*?===== \*\/\n([\s\S]*?)\n\s*\/\* ===== SLICE3:INICIO-DEMO-TEARDOWN:END/)[1];
  const run = (prevUid, user) => {
    let tore = 0;
    // Prod parity: the auth-transition region drops the platform-rate listener via unsubscribeDriverRate() (a real
    // module-scope fn in production). This cell asserts the teardown GATING (prevUid logic), not the rate unsubscribe,
    // so stub it as a no-op — matching that production always resolves the binding.
    const body = 'let drv2PrevAuthUid = _prev;\nfunction companionDemoTeardown(){}\nfunction unsubscribeDriverRate(){}\nfunction drv2SessionTeardown(){ _spy(); }\n' + region + '\nreturn drv2PrevAuthUid;';
    const after = (new Function('_prev', 'user', '_spy', body))(prevUid, user, () => { tore++; });
    return { tore, after };
  };
  const initial = run(null, { uid: 'A' });   // initial restore: prevUid null → A
  assert.equal(initial.tore, 0, 'the initial same-account restore does NOT tear down (a mutant that calls it unconditionally → RED)');
  assert.equal(initial.after, 'A', 'the previous uid advances to A');
  assert.equal(run('A', { uid: 'B' }).tore, 1, 'a cross-account uid change A→B tears down');
  assert.equal(run('A', null).tore, 1, 'a sign-out A→null tears down');
  assert.equal(run('A', { uid: 'A' }).tore, 0, 'a same-account re-auth (token refresh) does NOT tear down');
});

console.log(`✓ return-target: ${passed} tests passed`);
