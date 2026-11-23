// Rule 16b (owner 11-12): no single word alone on a paragraph's last line. The slot-1114 sweep (2026-11-14) found «varios.» (Equipos
// lede), «primero.» (Productos review note), «noche.» (Ventas footer), «mapa.» / «Sherpa» / «km.» (Envío) at 390 px. One rule on the
// SHARED body-copy classes asks the browser for balanced last lines (`text-wrap: pretty`), instead of per-string fixes.
// COMPUTED styles: jsdom over the shipped styles.css (the cascade decides; a later rule resetting it fails here). The real-browser
// re-shoot is the slot's job. Run: node --test portal-text-fit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const CSS = readFileSync(join(DIR, 'styles.css'), 'utf8');

// every body-copy class the sweep flagged, in the ancestry it renders in
const SHAPES = [
  ['the page lede (Equipos, every page)', '<div class="app"><p class="lede" id="t">x</p></div>'],
  ['the section note (Productos review)', '<div class="secnote" id="t"><span>x</span></div>'],
  ['the Ventas footer', '<p class="vfoot" id="t">x</p>'],
  ['the Envío field note', '<div class="envio"><p class="efnote" id="t">x</p></div>'],
  ['the Envío callout', '<div class="envio"><div class="ecallout" id="t"><div>x</div></div></div>'],
];
test('body copy asks for a balanced last line (text-wrap: pretty) — no orphaned word at 390 px', () => {
  for (const [what, html] of SHAPES) {
    const dom = new JSDOM(`<!doctype html><style>${CSS}</style><body>${html}</body>`, { pretendToBeVisual: true });
    const e = dom.window.document.getElementById('t');
    const decl = [...dom.window.document.styleSheets[0].cssRules].filter((r) => r.selectorText && e.matches(r.selectorText)).map((r) => r.style.getPropertyValue('text-wrap')).filter(Boolean);
    assert.equal(decl.at(-1), 'pretty', `${what}: the last matching text-wrap is pretty (${JSON.stringify(decl)})`);
  }
});
