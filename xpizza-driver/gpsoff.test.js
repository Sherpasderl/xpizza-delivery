// gpsoff — the location-off idle state. (1) gpsoffHtml builder output per cause/platform; (2) the REAL lifted
// gpsoffActive / applyGpsoff logic (index.html LOGIC-3) over a jsdom idle DOM: it swaps the idle content for the card
// only when location is off, routes «Abrir ajustes» by cause, and «Más tarde» dismisses. Run: `node gpsoff.test.js`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { gpsoffHtml } from './stacked-view.js';
import { tabBarHtml } from './tab-bar-view.js';   // O6: applyGpsoff now calls mountTabBar (P2.5 — gpsoff has no tab bar)

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');
const HTML = readFileSync(join(__dir, 'index.html'), 'utf8');
const SCRIPT = HTML.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const CSS = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];   // the first <style> block holds PRESENTATION-3 + the base layout
function liftFn(name) {
  let start = SCRIPT.indexOf(`function ${name}(`);
  if (SCRIPT.slice(start - 6, start) === 'async ') start -= 6;
  assert.notEqual(start, -1, `function ${name} not found`);
  let depth = 0, seen = false;
  for (let i = start; i < SCRIPT.length; i++) {
    if (SCRIPT[i] === '{') { depth++; seen = true; }
    else if (SCRIPT[i] === '}') { depth--; if (seen && depth === 0) return SCRIPT.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
function regionBody(name) {
  const s = SCRIPT.indexOf(`SLICE3:${name}:START`);
  const bodyStart = SCRIPT.indexOf('\n', s) + 1;
  const end = SCRIPT.indexOf(`SLICE3:${name}:END`, bodyStart);
  return SCRIPT.slice(bodyStart, SCRIPT.lastIndexOf('/*', end));
}
const esc = (s) => String(s == null ? '' : s);

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log('  ok -', name); }

// ---------- (1) the builder ----------
t('builder native + permission DENIED: «Permiso de ubicación» «Negado», battery row, «Abrir ajustes» routes to permission', () => {
  const h = gpsoffHtml({ native: true, permission: 'denied', providerEnabled: true, batteryUnrestricted: true }, { esc });
  assert.match(h, /Activá tu ubicación/);
  assert.match(h, /Permiso de ubicación[\s\S]*Negado/);
  assert.match(h, /Bater[ií]a[\s\S]*Ok/, 'the battery row is native-only');
  assert.match(h, /id="gpsoff-settings" data-cause="permission"/, 'routes to app details for a permission cause');
  assert.match(h, /id="gpsoff-later"/);
});
t('builder native + PROVIDER off: a «Ubicación del teléfono» «Apagada» row, «Abrir ajustes» routes to provider', () => {
  const h = gpsoffHtml({ native: true, permission: 'granted', providerEnabled: false, batteryUnrestricted: true }, { esc });
  assert.match(h, /Ubicación del teléfono[\s\S]*Apagada/);
  assert.match(h, /data-cause="provider"/, 'routes to the location switch when the provider is off');
});
t('builder WEB: permission cause only — NO battery row, NO «Abrir ajustes», «Más tarde» only', () => {
  const h = gpsoffHtml({ native: false, permission: 'denied' }, { esc });
  assert.match(h, /Permiso de ubicación/);
  assert.ok(!/Bater[ií]a/.test(h), 'no battery row on web');
  assert.ok(!/gpsoff-settings/.test(h), 'no settings opener on web');
  assert.match(h, /id="gpsoff-later"/);
});

// ---------- (2) the lifted apply logic ----------
function build() {
  const dom = new JSDOM('<!doctype html><body><div id="screen-onshift"><div id="idle-state"><div class="idle-top"><div id="idle-msg"></div><button id="idle-help-link">¿Por qué?</button></div><div class="statbar" id="idle-statbar"></div></div></div></body>');
  const { document, window } = dom.window;
  const $ = (id) => document.getElementById(id);
  // mock OS surfaces: native OemSettings (getLocationStatus/getStatus + the two openers) and the web Permissions API
  const opens = { location: 0, app: 0 };
  let locStatus = { permission: 'denied', providerEnabled: true };   // what the native plugin reports
  let permState = 'denied';                                           // what navigator.permissions reports (web)
  window.Capacitor = { Plugins: { OemSettings: {
    getLocationStatus: () => Promise.resolve(locStatus),
    getStatus: () => Promise.resolve({ batteryUnrestricted: true }),
    openLocationSettings: () => { opens.location += 1; },
    openAppDetails: () => { opens.app += 1; },
  } } };
  window.navigator.permissions = { query: () => Promise.resolve({ state: permState }) };
  let nativeFlag = true;
  const deps = { document, window, navigator: window.navigator, $, gpsoffHtml, escapeHtml: esc, isNative: () => nativeFlag, tabBarHtml };
  const body = 'let gpsoffState = null, gpsoffDismissed = false, gpsoffChecking = false;\n'
    + 'const TAB_SHOW_PEDIDOS = false, TAB_SHOW_GANANCIAS = false;\n'   // O6: applyGpsoff → mountTabBar (bar off while gpsoff)
    + liftFn('mountTabBar') + '\n'
    + liftFn('checkLocationStatus') + '\n' + liftFn('gpsoffActive') + '\n' + liftFn('applyGpsoff') + '\n'
    + 'function hostResume() {\n' + regionBody('GPSOFF-RESUME-3') + '\n}\n'          // app-resume trigger (clears dismiss + re-checks)
    + 'function hostDenied() {\n const err = { code: 1, PERMISSION_DENIED: 1 };\n' + regionBody('GPSOFF-DENIED-3') + '\n}\n'          // web PERMISSION_DENIED trigger (err = the watchPosition error cb param)
    + 'return { check: checkLocationStatus, apply: applyGpsoff, active: gpsoffActive, resume: hostResume, denied: hostDenied,'
    + ' setState: (s) => { gpsoffState = s; }, setDismissed: (d) => { gpsoffDismissed = d; }, dismissed: () => gpsoffDismissed };';
  const names = Object.keys(deps);
  const api = new Function(...names, body)(...names.map((n) => deps[n]));
  return { api, $, document, opens,
    setNative: (v) => { nativeFlag = v; }, setLocStatus: (s) => { locStatus = s; }, setPermState: (s) => { permState = s; },
    cardShown: () => { const c = $('gpsoff-state'); return !!(c && !c.classList.contains('hidden')); },
    barShown: () => !!$('screen-onshift').querySelector(':scope > .tabs'),
    mountBar: () => $('screen-onshift').insertAdjacentHTML('beforeend', '<nav class="tabs"></nav>'),
    idleTopHidden: () => $('idle-state').querySelector('.idle-top').classList.contains('hidden') };
}

t('active: null/dismissed → false; permission denied OR provider off → true; all good → false', () => {
  const h = build();
  assert.equal(h.api.active(), false, 'no state → not active');
  h.api.setState({ native: true, permission: 'granted', providerEnabled: true });
  assert.equal(h.api.active(), false, 'all good → not active');
  h.api.setState({ native: true, permission: 'denied', providerEnabled: true });
  assert.equal(h.api.active(), true, 'permission denied → active');
  h.api.setState({ native: true, permission: 'granted', providerEnabled: false });
  assert.equal(h.api.active(), true, 'provider off → active');
  h.api.setDismissed(true);
  assert.equal(h.api.active(), false, '«Más tarde» dismiss wins');
});

t('apply: location off → the card REPLACES the idle content (idle-top hidden); all good → idle content restored', () => {
  const h = build();
  h.api.setState({ native: true, permission: 'denied', providerEnabled: true, batteryUnrestricted: true });
  h.api.apply();
  assert.equal(h.cardShown(), true, 'the gpsoff card shows');
  assert.equal(h.idleTopHidden(), true, 'the normal idle content (incl. the help link) is hidden');
  h.api.setState({ native: true, permission: 'granted', providerEnabled: true });
  h.api.apply();
  assert.equal(h.cardShown(), false, 'card cleared when location is fine');
  assert.equal(h.idleTopHidden(), false, 'the idle content is restored');
});

t('apply: «Más tarde» dismisses the card (until the next recheck re-sets it)', () => {
  const h = build();
  h.api.setState({ native: true, permission: 'denied', providerEnabled: true });
  h.api.apply();
  assert.equal(h.cardShown(), true);
  h.$('gpsoff-later').click();   // the real handler sets gpsoffDismissed = true + re-applies
  assert.equal(h.cardShown(), false, 'dismissed → hidden');
  assert.equal(h.api.dismissed(), true, 'the dismiss flag latched');
});

// ---------- copy pins (owner-approved, byte-for-byte; never-change) ----------
t('COPY PIN: every gpsoff string is exactly as the prototype draws it / the owner approved', () => {
  // permission denied + provider off + battery restricted → all rows + both causes present
  const h = gpsoffHtml({ native: true, permission: 'denied', providerEnabled: false, batteryUnrestricted: false }, { esc });
  for (const s of [
    'Activá tu ubicación',
    'Despacho necesita verte en el mapa para asignarte pedidos. Sin GPS no se bloquea nada que ya tengás en mano.',
    'Permiso de ubicación', '“Permitir siempre”', 'Negado',          // curly “Permitir siempre” (U+201C/U+201D)
    'Ubicación del teléfono', 'Encendé el GPS', 'Apagada',                      // owner-approved provider-off row
    'Batería', 'Sin restricción', 'Revisar',                                    // owner-approved battery-err chip
    'Abrir ajustes de ubicación', 'Más tarde',
  ]) assert.ok(h.includes(s), `gpsoff copy must contain exactly: ${s}`);
  // the good-state chips
  const ok = gpsoffHtml({ native: true, permission: 'granted', providerEnabled: true, batteryUnrestricted: true }, { esc });
  assert.ok(ok.includes('>Ok<'), 'granted/unrestricted → «Ok» chip');
  assert.ok(!ok.includes('Ubicación del teléfono'), 'the provider row appears ONLY when the switch is off');
});

// ---------- layout contract (jsdom has no layout, so assert the shipped CSS) ----------
t('LAYOUT CONTRACT: gpsoff fills #onshift-content to the SCREEN bottom — absolute overlay (inset 0) + foot margin-top:auto', () => {
  // the gpsoff-state rule: position:absolute with all four insets 0 (a full overlay of the anchored #onshift-content)
  const gs = (CSS.match(/(?:^|})\s*\.gpsoff-state\s*\{([^}]*)\}/) || [])[1] || '';
  assert.ok(gs, '.gpsoff-state rule present');
  assert.match(gs, /position:\s*absolute/, '.gpsoff-state is an absolute overlay');
  for (const side of ['top', 'right', 'bottom', 'left']) assert.match(gs, new RegExp('\\b' + side + ':\\s*0\\b'), `.gpsoff-state ${side}:0 (full inset)`);
  // #onshift-content is the positioned ANCHOR (a bare rule — distinct from the .delivering #onshift-content variants)
  assert.ok(CSS.includes('#onshift-content { position: relative'), '#onshift-content { position: relative } anchors the overlay');
  // the foot is pinned to the bottom of the overlay (margin-top:auto below the flex:1 body)
  const gf = (CSS.match(/(?:^|})\s*\.gpsoff-foot\s*\{([^}]*)\}/) || [])[1] || '';
  assert.match(gf, /margin-top:\s*auto/, '.gpsoff-foot is pinned to the screen bottom');
});

// ---------- (3) the REAL detection + routing + triggers (P2-6) ----------
async function at(name, fn) { await fn(); passed += 1; console.log('  ok -', name); }

await at('detection NATIVE: getLocationStatus denied → card shows; granted+on → card clears (mutant: detection removed → RED)', async () => {
  const h = build();
  h.setLocStatus({ permission: 'denied', providerEnabled: true });
  await h.api.check();
  assert.equal(h.cardShown(), true, 'a real denied read shows the card');
  assert.equal(h.api.active(), true);
  h.setLocStatus({ permission: 'granted', providerEnabled: true });
  await h.api.check();
  assert.equal(h.cardShown(), false, 'a real granted+provider-on read clears it');
});

await at('detection DARK-SAFE: native with no getLocationStatus method → no card, no state (old binary)', async () => {
  const h = build();
  delete h.$('idle-state').ownerDocument.defaultView.Capacitor.Plugins.OemSettings.getLocationStatus;
  await h.api.check();
  assert.equal(h.cardShown(), false, 'absent method → never a card on native');
  assert.equal(h.api.active(), false);
});

await at('detection WEB: no native, navigator.permissions denied → card (permission cause only)', async () => {
  const h = build();
  h.setNative(false);
  h.setPermState('denied');
  await h.api.check();
  assert.equal(h.cardShown(), true, 'web permission-denied shows the card');
});

await at('routing: «Abrir ajustes» opens LOCATION settings for a provider-off cause, APP details for a permission cause (mutant: routing removed → RED)', async () => {
  const h = build();
  h.setLocStatus({ permission: 'granted', providerEnabled: false });   // provider off
  await h.api.check();
  h.$('gpsoff-settings').click();
  assert.equal(h.opens.location, 1, 'provider cause → openLocationSettings');
  assert.equal(h.opens.app, 0);
  const h2 = build();
  h2.setLocStatus({ permission: 'denied', providerEnabled: true });     // permission denied
  await h2.api.check();
  h2.$('gpsoff-settings').click();
  assert.equal(h2.opens.app, 1, 'permission cause → openAppDetails');
  assert.equal(h2.opens.location, 0);
});

await at('trigger GPSOFF-DENIED-3: a web PERMISSION_DENIED re-checks → the card appears', async () => {
  const h = build();
  h.setNative(false); h.setPermState('denied');
  h.api.denied();                 // the real region body calls checkLocationStatus()
  await Promise.resolve(); await Promise.resolve();   // let the async check settle
  assert.equal(h.cardShown(), true, 'PERMISSION_DENIED triggered the detection → card');
});

await at('trigger GPSOFF-RESUME-3: app resume clears a «Más tarde» dismiss and re-checks', async () => {
  const h = build();
  h.setLocStatus({ permission: 'denied', providerEnabled: true });
  await h.api.check();
  h.$('gpsoff-later').click();    // dismiss
  assert.equal(h.cardShown(), false, 'dismissed');
  try { Object.defineProperty(h.$('idle-state').ownerDocument, 'visibilityState', { value: 'visible', configurable: true }); } catch (_) {}
  h.api.resume();                 // the real region: clears dismiss + re-checks
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.api.dismissed(), false, 'resume cleared the dismiss');
  assert.equal(h.cardShown(), true, 'and the card is back after the re-check');
});

t('O6 (Codex r1 P2.5): the tab bar is removed while gpsoff is shown and restored on dismiss', () => {
  const h = build();
  h.mountBar();                                                       // idle board leaves the bar mounted
  assert.ok(h.barShown(), 'bar present on the idle board');
  h.api.setState({ native: true, permission: 'denied', providerEnabled: true });   // gpsoff active
  h.api.apply();
  assert.ok(!h.barShown(), 'gpsoff shown → bar removed (prototype S.gpsoff has none)');
  assert.ok(h.cardShown(), 'the gpsoff card is shown');
  h.api.setDismissed(true); h.api.apply();                            // «Más tarde»
  assert.ok(h.barShown(), 'dismissed → bar restored on the idle board');
  assert.ok(!h.cardShown(), 'the gpsoff card is hidden');
});

console.log(`✓ gpsoff: ${passed} checks passed`);
