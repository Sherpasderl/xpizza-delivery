// «Ganado hoy» on the two shift-close surfaces — the cuadre receipt row (prototype S.cuadre :894) and the cerrado
// summary card (prototype S.cerrado :901). Both render the ONE source (drv2DayEarned / its confirm-time snapshot)
// EXACTLY, blank-not-wrong, with NO second/fabricated source. EXECUTES the REAL shipped index.html code: cuadreEarnCardHtml
// (pure, lifted) and showCerrado (lifted into a real jsdom DOM). run: `node ganado-hoy-earnings.test.js`.
//
// Mutants these kill (apply to index.html, must go RED — proven in GANADO-HOY mutant sweep):
//   (missing row)   cuadreEarnCardHtml early-returns '' when priced            → the cuadre «priced» cell RED
//   (second source) cuadreEarnCardHtml amount from anything but drv2DayEarned   → the cuadre «ONLY» cell RED
//   (missing card)  showCerrado drops the .cerrado-earn card when priced        → the cerrado «priced» cell RED
//   (second source) showCerrado amount from anything but the passed snapshot     → the cerrado «ONLY» cell RED
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(__dir, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = require('jsdom');
const SCRIPT = readFileSync(join(__dir, 'index.html'), 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1];

// Lift a named function's source by brace-matching (the endshift-confirm / cuadre-submit idiom).
function liftFn(name) {
  const start = SCRIPT.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const open = SCRIPT.indexOf('{', SCRIPT.indexOf('(', start));
  let depth = 0, end = -1;
  for (let k = open; k < SCRIPT.length; k++) { const c = SCRIPT[k]; if (c === '{') depth++; else if (c === '}') { if (--depth === 0) { end = k + 1; break; } } }
  assert.notEqual(end, -1, `unbalanced braces lifting ${name}`);
  return SCRIPT.slice(start, end);
}

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.error(`  🔴 ${name}\n    ${e && e.message ? e.message : e}`); process.exitCode = 1; } }

// ───────── cuadreEarnCardHtml (pure) ─────────
const ICONS = { wallet: '<svg id="w"></svg>', cash: '<svg id="c"></svg>' };
function cuadreCard({ show, de }) {
  const fn = new Function('CUADRE_SHOW_EARNINGS', 'drv2DayEarned', 'ICONS', liftFn('cuadreEarnCardHtml') + '\nreturn cuadreEarnCardHtml;')(show, () => de, ICONS);
  return fn();
}

t('(cuadre) priced ⇒ «Ganado hoy · L N» row with the drv2DayEarned amount + exact prototype subtext', () => {
  const html = cuadreCard({ show: true, de: { ready: true, cents: 42000, count: 6 } });
  assert.match(html, /class="cuadre-earn"/, 'the .cuadre-earn card renders');
  assert.match(html, /Ganado hoy · L 420\b/, '«Ganado hoy · L 420» for 42000c (the one source)');
  assert.match(html, /Informativo\. No se resta del efectivo; se paga aparte\./, 'exact prototype S.cuadre :894 subtext');
  assert.match(html, /class="ic ok"/, 'green (ok) icon chip, per the prototype');
});
t('(cuadre) amount tracks drv2DayEarned ONLY — a different cents ⇒ a different L (kills a second source)', () => {
  assert.match(cuadreCard({ show: true, de: { ready: true, cents: 15050, count: 2 } }), /Ganado hoy · L 150\.5\b/, 'cuadre amount L 150.5 for 15050c tracks drv2DayEarned');
});
t('(cuadre) Pagos OFF ⇒ no card', () => {
  assert.equal(cuadreCard({ show: false, de: { ready: true, cents: 42000, count: 6 } }), '', 'CUADRE_SHOW_EARNINGS false → blank');
});
t('(cuadre) not ready / unpriced / zero ⇒ blank (never a false L0)', () => {
  assert.equal(cuadreCard({ show: true, de: { ready: false, cents: null, count: 0 } }), '', 'not ready → blank');
  assert.equal(cuadreCard({ show: true, de: { ready: true, cents: null, count: 3 } }), '', 'unpriced (cents null) → blank');
  assert.equal(cuadreCard({ show: true, de: { ready: true, cents: 0, count: 0 } }), '', 'zero → blank');
});

// ───────── showCerrado (jsdom) ─────────
function runCerrado(earned) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const document = dom.window.document;
  const fn = new Function('document', 'authGen', 'render', 'setTimeout', 'clearTimeout',
    'let drv2CerradoDismiss = null, drv2CerradoTick = null, driverState = null;\n' +
    'function hnDayStartMs(ms){ return ms; }\n' +
    liftFn('drv2CerradoEarnStale') + '\n' + liftFn('showCerrado') + '\nreturn showCerrado;')(document, 0, () => {}, () => 1, () => {});
  fn({ deliveries: 6, cashOwed: 1430 }, 1000, 1000 + 6960000, earned);   // ~1 h 56 min window
  return document.getElementById('cerrado-screen');
}

t('(cerrado) priced ⇒ the «Ganado hoy» okwash card with the snapshot amount + exact prototype footnote', () => {
  const ov = runCerrado({ ready: true, cents: 42000, count: 6 });
  assert.ok(ov, '#cerrado-screen exists');
  const card = ov.querySelector('.cerrado-earn');
  assert.ok(card, 'the .cerrado-earn card renders');
  assert.match(card.querySelector('.ce-lbl').textContent, /^Ganado hoy$/, 'the «Ganado hoy» label');
  assert.equal(card.querySelector('.ce-big').textContent, 'L420', 'the amount L 420 for 42000c (the passed snapshot)');
  assert.match(card.querySelector('.ce-tiny').textContent, /^Se paga aparte según el calendario de la plataforma$/, 'exact prototype S.cerrado :901 footnote');
});
t('(cerrado) amount tracks the passed snapshot ONLY — a different cents ⇒ a different L (kills a second source)', () => {
  assert.equal(runCerrado({ ready: true, cents: 15050, count: 2 }).querySelector('.cerrado-earn .ce-big').textContent, 'L150.5', 'cerrado amount L 150.5 for 15050c tracks the snapshot');
});
t('(cerrado) no snapshot / not ready / unpriced / zero ⇒ no card (blank-not-wrong)', () => {
  assert.equal(runCerrado(null).querySelector('.cerrado-earn'), null, 'null earned → no card');
  assert.equal(runCerrado({ ready: false, cents: null }).querySelector('.cerrado-earn'), null, 'not ready → no card');
  assert.equal(runCerrado({ ready: true, cents: null }).querySelector('.cerrado-earn'), null, 'unpriced → no card');
  assert.equal(runCerrado({ ready: true, cents: 0 }).querySelector('.cerrado-earn'), null, 'zero → no card');
});
// The cerrado summary's cash line must still be the cash (not the earnings) — proves the new card didn't cross wires.
t('(cerrado) the cash line stays «Entregaste L 1,430» independent of earnings', () => {
  assert.match(runCerrado({ ready: true, cents: 42000, count: 6 }).textContent, /Entregaste\s*L 1,430\s*en efectivo/, 'cash line intact');
});

// ───────── P2b: the cerrado snapshot is bound to its HN day + shift + session, and invalidates when any changes ─────────
function boundCerrado() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const document = dom.window.document;
  const ticks = [];
  const api = new Function('document', 'setTimeout', 'clearTimeout',
    'let drv2CerradoDismiss = null, drv2CerradoTick = null, authGen = 0, driverState = { current_shift_id: "sh1" };\n' +
    'function hnDayStartMs(ms){ return ms; }\n' +   // identity: the test passes already-day-aligned instants
    'function render(){}\n' +
    liftFn('drv2CerradoEarnStale') + '\n' + liftFn('showCerrado') + '\n' + liftFn('drv2ValidateCerradoEarn') + '\n' +
    'return { open: (earned) => showCerrado({ deliveries: 6, cashOwed: 1430 }, 1000, 7960000, earned), validate: () => drv2ValidateCerradoEarn(), dismiss: () => { if (drv2CerradoDismiss) drv2CerradoDismiss(); }, setShift: (s) => { driverState = s === null ? null : { current_shift_id: s }; }, setGen: (g) => { authGen = g; } };')(
    document, (fn, delay) => { ticks.push({ fn, delay }); return ticks.length; }, () => {});
  return { document, api, fireTicks: () => { const t = ticks.slice(); ticks.length = 0; t.forEach(({ fn }) => fn()); }, lastDelay: () => ticks.length ? ticks[ticks.length - 1].delay : null };
}

t('(cerrado P2b) a midnight crossing blanks the stale «Ganado hoy» snapshot', () => {
  const realNow = Date.now;
  try {
    const { document, api } = boundCerrado();
    Date.now = () => 500;
    api.open({ ready: true, cents: 42000, count: 6, day: 500, shiftId: 'sh1' });
    assert.ok(document.querySelector('.cerrado-earn'), 'card present at open');
    api.validate();
    assert.ok(document.querySelector('.cerrado-earn'), 'same day + shift + session → card stays');
    Date.now = () => 90000000;   // the HN day rolled over while the summary stayed open
    api.validate();
    assert.equal(document.querySelector('.cerrado-earn'), null, 'midnight crossing → the stale «Ganado hoy» card is blanked');
  } finally { Date.now = realNow; }
});
t('(cerrado P2b) a replacement shift / session change blanks the snapshot', () => {
  const realNow = Date.now;
  try {
    Date.now = () => 500;
    let h = boundCerrado();
    h.api.open({ ready: true, cents: 42000, count: 6, day: 500, shiftId: 'sh1' });
    h.api.setShift('sh2'); h.api.validate();
    assert.equal(h.document.querySelector('.cerrado-earn'), null, 'a replacement shift under the same login → blanked');
    h = boundCerrado();
    h.api.open({ ready: true, cents: 42000, count: 6, day: 500, shiftId: 'sh1' });
    h.api.setGen(1); h.api.validate();
    assert.equal(h.document.querySelector('.cerrado-earn'), null, 'a session change (authGen) → blanked');
  } finally { Date.now = realNow; }
});

// ───────── P2c: render() keeps the driver on the open Ganancias screen on ordinary live updates ─────────
function renderWith({ board, optimisticShift = null, driverState = { active: false }, ganHidden = false }) {
  const calls = { showScreen: [], renderGanancias: 0 };
  const gn = { classList: { contains: (c) => c === 'hidden' && ganHidden } };
  const els = { 'screen-ganancias': gn, 'off-driver-name': { textContent: '' } };
  const scope = {
    currentUser: { email: 'd@x.pizza', uid: 'drv' },
    companion: null, companionSyncSuspendedNotice: () => {},
    driverState, optimisticShift,
    $: (id) => els[id] || null,
    drv2LiveBoard: () => board,
    renderGanancias: () => { calls.renderGanancias++; },
    drv2GananciasView: 'hoy',
    showScreen: (s) => { calls.showScreen.push(s); },
    stopKeepAlive: () => {}, startKeepAlive: () => {}, ensureOfflineBanner: () => {},
    renderStatusBar: () => {}, renderActiveAndQueue: () => {},
  };
  const names = Object.keys(scope);
  new Function(...names, 'let companionSuspended, companionNeutralNotice, drv2NavHome = false;\n' + liftFn('render') + '\nreturn render;')(...Object.values(scope))();
  return calls;
}
t('(P2c) on Ganancias + an ordinary update (no work) → STAYS on Ganancias (re-renders in place, no navigation)', () => {
  const c = renderWith({ board: [] });
  assert.equal(c.renderGanancias, 1, 'Ganancias re-rendered in place');
  assert.deepEqual(c.showScreen, [], 'no showScreen — the driver was NOT ejected to on/offshift');
});
t('(P2c) on Ganancias + WORK arrives → takeover to the board (onshift), Ganancias not held', () => {
  const c = renderWith({ board: [{}], optimisticShift: true });
  assert.equal(c.renderGanancias, 0, 'did NOT hold Ganancias when work arrived');
  assert.ok(c.showScreen.includes('onshift'), 'took over to the operational board (onshift)');
});
t('(P2c) Ganancias NOT open → guard inert, ordinary off-shift render proceeds', () => {
  const c = renderWith({ board: [], ganHidden: true });
  assert.equal(c.renderGanancias, 0, 'guard inert when Ganancias is not the open screen');
  assert.ok(c.showScreen.includes('offshift'), 'normal off-shift render');
});

// ───────── P2b/r2: the cerrado snapshot is validated AT OPEN and on an HN-midnight tick ─────────
t('(cerrado r2) a snapshot already STALE when the summary OPENS is NOT painted (validate at open)', () => {
  const realNow = Date.now;
  try {
    const { document, api } = boundCerrado();
    Date.now = () => 90000000;                 // a new HN day: the snapshot (day 500) is already stale at paint time
    api.open({ ready: true, cents: 42000, count: 6, day: 500, shiftId: 'sh1' });
    assert.equal(document.querySelector('.cerrado-earn'), null, 'stale-at-open snapshot paints NO «Ganado hoy» card');
  } finally { Date.now = realNow; }
});
t('(cerrado r2) an OPEN card blanks itself at the HN-midnight tick with NO feed update', () => {
  const realNow = Date.now;
  try {
    const h = boundCerrado();
    Date.now = () => 500;
    h.api.open({ ready: true, cents: 42000, count: 6, day: 500, shiftId: 'sh1' });
    assert.ok(h.document.querySelector('.cerrado-earn'), 'card present at open (same day)');
    Date.now = () => 90000000;                 // the HN day rolled over while the card stayed open
    h.fireTicks();                             // the scheduled next-midnight re-validate fires (no feed update)
    assert.equal(h.document.querySelector('.cerrado-earn'), null, 'the midnight tick blanked the stale card');
  } finally { Date.now = realNow; }
});
t('(cerrado r3) the tick deadline is anchored to the SNAPSHOT day, not a post-validate Date.now (no extra-day staleness)', () => {
  const realNow = Date.now;
  try {
    const h = boundCerrado();
    // The race Codex r3 flagged: Date.now reads the snapshot's day (500) at the at-open validate — so the card PAINTS —
    // then a time ALREADY PAST the snapshot's next HN midnight (500 + 86400000 = 86400500) by the time the tick schedules.
    let seq = [500]; const afterMidnight = 86400600;
    Date.now = () => seq.length ? seq.shift() : afterMidnight;
    h.api.open({ ready: true, cents: 42000, count: 6, day: 500, shiftId: 'sh1' });
    assert.ok(h.document.querySelector('.cerrado-earn'), 'card painted (snapshot day matched at the at-open validate)');
    // Anchored on earned.day: its next midnight already passed ⇒ delay clamps to ~immediate (≤ a second), so the stale
    // card is blanked now. A fresh-Date.now deadline would be ~a full day (86400000+) — the extra-day staleness bug.
    assert.ok(h.lastDelay() != null && h.lastDelay() <= 2000, `tick fires ~immediately, not a day late; got delay=${h.lastDelay()}`);
  } finally { Date.now = realNow; }
});

// ───────── P2c Fix 2: the REAL Inicio tab handler leaves Ganancias past the stay guard ─────────
t('(P2c nav) tapping Inicio (REAL mountTabBar handler → render) LEAVES Ganancias', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="screen-ganancias"></div></body></html>');
  const document = dom.window.document;
  const gn = document.getElementById('screen-ganancias');   // Ganancias open (not hidden)
  const calls = { showScreen: [], renderGanancias: 0 };
  const els = { 'screen-ganancias': gn, 'off-driver-name': { textContent: '' } };
  const scope = {
    document,
    drv2LiveBoard: () => [], TAB_SHOW_PEDIDOS: true, TAB_SHOW_GANANCIAS: true,
    tabBarHtml: () => '<div class="tabs"><button class="tab-btn" data-tab="inicio">Inicio</button></div>',
    openCuenta: () => {}, openHistoryModal: () => {}, openGanancias: () => {},
    currentUser: { email: 'd@x.pizza', uid: 'drv' },
    companion: null, companionSyncSuspendedNotice: () => {},
    driverState: { active: false }, optimisticShift: null,
    $: (id) => els[id] || null,
    renderGanancias: () => { calls.renderGanancias++; },
    drv2GananciasView: 'hoy',
    showScreen: (s) => { calls.showScreen.push(s); },
    stopKeepAlive: () => {}, startKeepAlive: () => {}, ensureOfflineBanner: () => {},
    renderStatusBar: () => {}, renderActiveAndQueue: () => {},
  };
  const names = Object.keys(scope);
  new Function(...names, 'let drv2NavHome = false, companionSuspended, companionNeutralNotice;\n' +
    liftFn('render') + '\n' + liftFn('mountTabBar') + '\n' +
    'mountTabBar(document.getElementById("screen-ganancias"), "ganancias", true); return null;')(...Object.values(scope));
  const inicio = gn.querySelector('[data-tab="inicio"]');
  assert.ok(inicio, 'the Inicio tab button mounted');
  inicio.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(calls.renderGanancias, 0, 'did NOT swallow the Inicio tap by re-rendering Ganancias');
  assert.ok(calls.showScreen.includes('offshift'), 'the REAL Inicio handler + render left Ganancias (→ offshift)');
});
t('(P2c nav r3) an Inicio tap whose render EARLY-RETURNS (companion) must NOT leak nav intent into a later ordinary render', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="screen-ganancias"></div></body></html>');
  const document = dom.window.document;
  const gn = document.getElementById('screen-ganancias');   // Ganancias open
  const calls = { showScreen: [], renderGanancias: 0 };
  const els = { 'screen-ganancias': gn, 'off-driver-name': { textContent: '' } };
  const decideQ = [{ action: 'deactivate' }, { action: 'legacy' }];   // 1st render (Inicio tap) early-returns; 2nd (ordinary) falls through to the stay guard
  const scope = {
    document,
    drv2LiveBoard: () => [], TAB_SHOW_PEDIDOS: true, TAB_SHOW_GANANCIAS: true,
    tabBarHtml: () => '<div class="tabs"><button class="tab-btn" data-tab="inicio">Inicio</button></div>',
    openCuenta: () => {}, openHistoryModal: () => {}, openGanancias: () => {},
    currentUser: { email: 'd@x.pizza', uid: 'drv' },
    companion: { decide: () => decideQ.shift() || { action: 'legacy' } },
    companionRenderE2: () => {}, companionRenderScreen: () => {}, companionPostActStep: () => false, companionHasHeldWork: () => false, companionSyncSuspendedNotice: () => {},
    driverState: { active: false }, optimisticShift: null,
    $: (id) => els[id] || null,
    renderGanancias: () => { calls.renderGanancias++; },
    drv2GananciasView: 'hoy',
    showScreen: (s) => { calls.showScreen.push(s); },
    stopKeepAlive: () => {}, startKeepAlive: () => {}, ensureOfflineBanner: () => {},
    renderStatusBar: () => {}, renderActiveAndQueue: () => {},
  };
  const names = Object.keys(scope);
  const h = new Function(...names, 'let drv2NavHome = false, companionSuspended, companionNeutralNotice;\n' +
    liftFn('render') + '\n' + liftFn('mountTabBar') + '\n' +
    'mountTabBar(document.getElementById("screen-ganancias"), "ganancias", true); return { render, navHome: () => drv2NavHome };')(...Object.values(scope));
  // 1) tap Inicio: render() early-returns via companion 'deactivate' BEFORE the stay guard — the try/finally must still clear the intent.
  gn.querySelector('[data-tab="inicio"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.navHome(), false, 'nav intent CLEARED even though the Inicio render early-returned (try/finally)');
  // 2) a later ordinary render (companion legacy) on the open Ganancias with no work must STAY — never consume a leaked intent.
  calls.renderGanancias = 0; calls.showScreen.length = 0;
  h.render();
  assert.equal(calls.renderGanancias, 1, 'the later ordinary render STAYED on Ganancias (no leaked nav intent ejected it)');
  assert.deepEqual(calls.showScreen, [], 'no navigation on the ordinary render');
});

console.log(`\nganado-hoy-earnings: ${failed === 0 ? 'OK' : 'INCOMPLETE'} (${passed} passed, ${failed} failed)`);
