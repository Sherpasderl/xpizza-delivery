// Pure nav-view builders (R7 Cuenta + «App de navegación») — run: `node nav-view.test.js` (no framework, repo idiom).
// These assert the pure markup; the handler binding + the drivers/{uid}/nav_app write are co-verified by the jsdom
// real-writer branch harness. The contract: Cuenta is MINIMAL (only the rows with a live effect), the picker is a
// single preference defaulting to Waze, and every control the host wires carries its stable id.
import assert from 'node:assert/strict';
import { cuentaHtml, navAppHtml } from './nav-view.js';

let passed = 0;
function t(name, fn) { fn(); passed += 1; }

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const ICONS = { back: '<i>B</i>', navi: '<i>N</i>', chev: '<i>></i>', check: '<i>C</i>', info: '<i>i</i>', waze: '<i>WZ</i>', gmaps: '<i>GM</i>' };
const DEPS = { icons: ICONS, esc };

// ---------- cuentaHtml: MINIMAL (R7) ----------
t('cuenta: title + back + spacer', () => {
  const h = cuentaHtml({ ...DEPS, navLabel: 'Waze' });
  assert.ok(h.includes('<div class="set-ttl">Cuenta</div>'), 'title');
  assert.ok(h.includes('id="cuenta-back"'), 'back hook');
});
t('cuenta: the nav row shows the current preference label as the detail', () => {
  assert.ok(cuentaHtml({ ...DEPS, navLabel: 'Waze' }).includes('Waze · turno a turno se abre afuera'), 'Waze label');
  assert.ok(cuentaHtml({ ...DEPS, navLabel: 'Google Maps' }).includes('Google Maps · turno a turno se abre afuera'), 'Maps label');
});
t('cuenta: the nav row carries its binding hook + title', () => {
  const h = cuentaHtml({ ...DEPS, navLabel: 'Waze' });
  assert.ok(h.includes('id="cuenta-navapp"'), 'nav row hook');
  assert.ok(h.includes('<div class="set-t">App de navegación</div>'), 'nav row title');
});
t('cuenta: «Cerrar sesión» present with its hook', () => {
  const h = cuentaHtml({ ...DEPS, navLabel: 'Waze' });
  assert.ok(h.includes('id="cuenta-signout"'), 'signout hook');
  assert.ok(h.includes('>Cerrar sesión<'), 'signout label');
});
t('cuenta: MINIMAL — none of the prototype rows WITHOUT a live reader leak in (no-control-without-effect)', () => {
  const h = cuentaHtml({ ...DEPS, navLabel: 'Waze' });
  assert.ok(!h.includes('Mi perfil'), 'no profile row');
  assert.ok(!h.includes('Sonido'), 'no sound row');
  assert.ok(!h.includes('Reglas de efectivo'), 'no cash-rules row');
  assert.ok(!h.includes('Ayuda'), 'no help row');
  assert.ok(!h.includes('Recibís pedidos de'), 'no receiving-from chips');
  assert.ok(!h.includes('data-go'), 'no prototype demo navigation');
});
t('cuenta: the label is escaped (no raw injection through navLabel)', () => {
  assert.ok(cuentaHtml({ ...DEPS, navLabel: '<x>' }).includes('&lt;x&gt;'), 'escaped');
});

// ---------- navAppHtml: one preference, default Waze ----------
t('navApp: title + back + «Guardar» foot', () => {
  const h = navAppHtml('waze', DEPS);
  assert.ok(h.includes('<div class="set-ttl">App de navegación</div>'), 'title');
  assert.ok(h.includes('id="navapp-back"'), 'back hook');
  assert.ok(h.includes('id="navapp-save"') && h.includes('>Guardar<'), 'save button');
});
t('navApp: both options with exact prototype copy', () => {
  const h = navAppHtml('waze', DEPS);
  assert.ok(h.includes('id="navapp-waze"') && h.includes('Waze') && h.includes('Mejor con tráfico en SPS'), 'waze option');
  assert.ok(h.includes('id="navapp-maps"') && h.includes('Google Maps') && h.includes('Mejor para buscar referencias'), 'maps option');
});
t('navApp: sel="waze" marks ONLY Waze selected', () => {
  const h = navAppHtml('waze', DEPS);
  assert.ok(/class="set-opt sel" id="navapp-waze"/.test(h), 'waze selected');
  assert.ok(/class="set-opt" id="navapp-maps"/.test(h), 'maps not selected');
});
t('navApp: sel="maps" marks ONLY Maps selected', () => {
  const h = navAppHtml('maps', DEPS);
  assert.ok(/class="set-opt sel" id="navapp-maps"/.test(h), 'maps selected');
  assert.ok(/class="set-opt" id="navapp-waze"/.test(h), 'waze not selected');
});
t('navApp: an unknown/absent sel selects NOTHING (host defaults Waze before calling)', () => {
  const h = navAppHtml(undefined, DEPS);
  assert.ok(!h.includes('set-opt sel'), 'no option pre-selected on unknown sel');
});
t('navApp: the reference-map + «abrir la otra» reassurance copy is present', () => {
  const h = navAppHtml('waze', DEPS);
  assert.ok(h.includes('El mapa del app es solo de referencia'), 'reference-map intro');
  assert.ok(h.includes('Siempre podés abrir la otra'), 'fallback reassurance');
});
t('navApp: both brand logos rendered (icons wired)', () => {
  const h = navAppHtml('waze', DEPS);
  assert.ok(h.includes(ICONS.waze) && h.includes(ICONS.gmaps), 'logos');
});

console.log(`nav-view.test.js: ${passed} passed`);
