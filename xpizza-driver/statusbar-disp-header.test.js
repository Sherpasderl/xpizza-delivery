// statusbar-disp-header.test.js — the SLICE3:DISP-HEADER insert region in renderStatusBar. Proves (1) the idle
// statuses (available / returning) render the prototype S.disponible header: «En turno» + «desde las {h:mm} ·
// {elapsed}» from shift_started_at (legacy «En turno» with no sub when the start is unknown) + the Sola mark in place
// of the dot; and (2) EVERY other status (at_restaurant / assigned / en_route_delivery / on_break / off_shift) renders
// BYTE-IDENTICAL to the pre-region behaviour — the insert is a pure no-op for them (advisor: "(b) changes ONLY the idle
// branch"). Lifts the REAL renderStatusBar into jsdom. Run: `node statusbar-disp-header.test.js`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fmtClockHM } from './time-format.js';   // the shared clock formatter renderStatusBar's DISP-HEADER now calls

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

function boot({ status, shift_started_at = null, last_ping = Date.now(), lat, lng, stale = false, eta = null } = {}) {
  // the REAL .status-bar parent: dot.closest('.status-bar') must resolve for the .enturno add/remove to work
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<div class="status-bar"><div class="status-dot" id="status-dot"></div><div class="status-label" id="status-label">x</div>'
    + '<div class="gps-meta" id="gps-meta">x</div></div></body></html>', { pretendToBeVisual: true });
  const { document } = dom.window;
  const $ = (id) => document.getElementById(id);
  const driverState = { status, shift_started_at, last_ping, lat, lng };
  const XPD = { isStalePing: () => stale };
  const computeReturnEta = () => eta;
  const body = 'const DRV2_PAUSE_ENABLED = false;\nconst DRV2_ENDSHIFT_SLIDE = false;\nconst DRV2_PAUSE_SVG = "";\nfunction drv2PauseShift(){}\n' + liftFn('renderStatusBar') + '\nreturn { renderStatusBar };';
  const api = (new Function('document', '$', 'driverState', 'XPD', 'computeReturnEta', 'fmtClockHM', body))(
    document, $, driverState, XPD, computeReturnEta, fmtClockHM);
  const snap = () => { const dot = $('status-dot'), lbl = $('status-label'), meta = $('gps-meta'), sb = document.querySelector('.status-bar');
    return { dot: dot.className, dotHtml: dot.innerHTML, lbl: lbl.textContent, meta: meta.textContent, metaCls: meta.className, sbCls: sb.className }; };
  api.renderStatusBar();
  // reRender re-runs renderStatusBar on the SAME DOM after changing status — exposes transition (idle→non-idle) behaviour
  return Object.assign(snap(), { reRender: (s) => { driverState.status = s; api.renderStatusBar(); return snap(); } });
}

let passed = 0;
const t = (name, fn) => { try { fn(); passed += 1; } catch (e) { console.error(`✗ ${name}`); throw e; } };

// (1) idle — the prototype «En turno» header
t('available with shift_started_at → «En turno» + «desde las {h:mm} · {elapsed}» + Sola, dot replaced', () => {
  const START = Date.now() - 116 * 60000;   // started 1:56 ago (relative → clock-independent)
  const r = boot({ status: 'available', shift_started_at: START });
  assert.equal(r.lbl, 'En turno', 'label «En turno»');
  assert.ok(r.dot.includes('sola'), 'dot carries .sola');
  assert.ok(/<svg[\s>]/.test(r.dotHtml), 'the Sola svg is injected into the dot');
  assert.ok(/^desde las \d{1,2}:\d\d · \d+:\d\d$/.test(r.meta), `sub «desde las {h:mm} · {elapsed}» (got «${r.meta}»)`);
});

t('available WITHOUT a known start → «En turno» with NO sub (legacy fallback)', () => {
  const r = boot({ status: 'available', shift_started_at: null });
  assert.equal(r.lbl, 'En turno');
  assert.equal(r.meta, '', 'no invented start — empty sub');
});

t('returning is also an idle «En turno» header (not the phase label)', () => {
  const r = boot({ status: 'returning', shift_started_at: Date.now() - 27 * 60000 });
  assert.equal(r.lbl, 'En turno');
  assert.ok(r.dot.includes('sola'));
});

// (2) every OTHER status renders byte-identical to the pre-DISP-HEADER behaviour (the insert is a no-op)
const NON_IDLE = [
  { status: 'at_restaurant', dot: 'status-dot green live', lbl: 'En restaurante' },
  { status: 'assigned', dot: 'status-dot amber', lbl: 'Asignado' },
  { status: 'en_route_delivery', dot: 'status-dot blue live', lbl: 'En camino' },   // no lat/lng → no ETA branch
  { status: 'on_break', dot: 'status-dot red', lbl: 'En pausa' },
  { status: 'off_shift', dot: 'status-dot', lbl: 'Fuera de turno' },
];
for (const ex of NON_IDLE) {
  t(`${ex.status} → byte-identical (dot «${ex.dot}», «${ex.lbl}», «GPS vivo», no Sola)`, () => {
    const r = boot({ status: ex.status });
    assert.equal(r.dot, ex.dot, 'dot className unchanged');
    assert.equal(r.dotHtml, '', 'NO Sola svg injected (dot innerHTML empty)');
    assert.equal(r.lbl, ex.lbl, 'phase label unchanged');
    assert.equal(r.meta, 'GPS vivo', 'GPS freshness meta unchanged');
    assert.ok(!/\bstale\b/.test(r.metaCls), 'not marked stale');
  });
}

// the en_route ETA branch is still reachable & unchanged for non-idle (returning no longer reaches it — it's idle now)
t('en_route_delivery with a live ETA → «↩ N min» (the original return path, untouched)', () => {
  const r = boot({ status: 'en_route_delivery', lat: 15.5, lng: -88.0, eta: 7 });
  assert.equal(r.meta, '↩ 7 min', 'ETA meta unchanged');
  assert.equal(r.lbl, 'En camino');
});

// (3) transition on a REUSED DOM — leaving idle restores the normal header (Codex P2: .enturno / Sola must not persist)
t('available → at_restaurant on the SAME DOM: .enturno + the Sola svg are removed, the phase header is restored', () => {
  const START = Date.now() - 97 * 60000;
  const h = boot({ status: 'available', shift_started_at: START });
  assert.ok(h.sbCls.includes('enturno'), 'idle adds .enturno to the status bar');
  assert.ok(/<svg/.test(h.dotHtml), 'idle injects the Sola svg');
  assert.ok(h.meta.includes(fmtClockHM(START)), 'the header uses the REAL shared clock formatter (kills the «00:00» literal mutant)');
  const r2 = h.reRender('at_restaurant');
  assert.ok(!r2.sbCls.includes('enturno'), '.enturno removed when leaving idle');
  assert.equal(r2.dotHtml, '', 'the Sola svg is cleared');
  assert.equal(r2.lbl, 'En restaurante', 'the phase label is restored');
  assert.equal(r2.dot, 'status-dot green live', 'the phase dot is restored');
  const fresh = boot({ status: 'at_restaurant' });   // and it equals a FRESH at_restaurant render
  assert.equal(r2.dot, fresh.dot); assert.equal(r2.dotHtml, fresh.dotHtml); assert.equal(r2.lbl, fresh.lbl); assert.equal(r2.sbCls, fresh.sbCls);
});

console.log(`✓ statusbar-disp-header: ${passed} tests passed`);
