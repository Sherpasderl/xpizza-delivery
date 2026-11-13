// The asm9 SBS defects (the SBS review's CLASSIFICATION-asm9, D1–D6), each pinned where the DOM can show it; the re-shoot of the
// frames is the next Chrome turn's. RED first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(join(ROOT, 'xpizza-functions/x.js'))('jsdom');
const CSS = readFileSync(join(HERE, 'capp.css'), 'utf8');
const dom = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;

test('D3 (C-2, 16b/16c): the comment hint is NOT the global bordered `.opt` box — it sits beside «Comentario» as plain hint text', () => {
  const R = require('./capp-rate.js');
  const d = dom(R.sheetHtml({ storeName: 'X. Pizza', num: 4821, dishes: [{ id: 'd1', name: 'Margherita' }], delivery: true, value: null, initial: null, editable: true }));
  const hint = [...d.querySelectorAll('label.lbl span')].find((s) => /opcional, lo lee el restaurante/.test(s.textContent));
  assert.ok(hint, 'premise: the hint beside the label');
  assert.equal(d.querySelectorAll('.rate .opt').length, 0, '🔴 D3: no element of the rate sheet carries the global `.opt` (a 64 px bordered option box)');
  assert.ok(/\.opt\{[^}]*border:/.test(CSS), 'premise: `.opt` IS the bordered option box');
});

test('D6 (robustness / 16b): a logo that FAILS to load becomes the initials plate — never the broken-image glyph + overflowing alt text', () => {
  const H = require('./capp-home.js');
  assert.equal(typeof H.logoFallback, 'function', '🔴 D6: the ONE fallback (installed once by the shell)');
  const d = dom('<div class="avatar"><img src="x.png" alt="X Pizza" data-initials="XP"></div><span class="logo"><img src="y.png" alt="" data-initials="LM"></span><img class="other" src="z.png">');
  H.logoFallback(d);
  for (const img of [...d.querySelectorAll('img[data-initials]')]) img.dispatchEvent(new d.defaultView.Event('error'));
  const [av, lg] = [d.querySelector('.avatar'), d.querySelector('.logo')];
  assert.ok(av.classList.contains('txt') && av.textContent === 'XP' && !av.querySelector('img'), '🔴 D6: the store avatar ⇒ «XP» plate');
  assert.ok(lg.classList.contains('txt') && lg.textContent === 'LM' && !lg.querySelector('img'), '🔴 D6: the card chip ⇒ «LM» plate');
  assert.equal(av.getAttribute('aria-hidden'), 'true', 'the plate is decorative (the name is beside it)');
  assert.ok(d.querySelector('img.other'), 'an unrelated image is never touched');
  const src = readFileSync(join(HERE, 'capp-ui.js'), 'utf8') + readFileSync(join(HERE, 'capp-home.js'), 'utf8');
  assert.equal((src.match(/<img src="\$\{esc\((?:cfg|r)\.logo\)\}"[^>]*data-initials=/g) || []).length, 2, '🔴 D6: BOTH logo images (store avatar, card chip) carry their initials');
  assert.ok(/CappHome\.logoFallback\(doc\)/.test(readFileSync(join(HERE, 'capp-shell-ui.js'), 'utf8')), '🔴 D6: the shell installs it');
});

test('D2 (C-6c desk, 16b): the fee / ETA cells grow to their content and their bold line never wraps (frame f2a: «Envío desde L 45» on ONE line)', () => {
  const cells = CSS.match(/\.app\.desk \.cells\{[^}]*\}/)[0], b = CSS.match(/\.app\.desk \.cells b\{[^}]*\}/)[0];
  assert.ok(/flex:1 0 auto/.test(cells), '🔴 D2: the cells box takes its content width (never squeezed by the Delivery/Pickup toggle)');
  assert.ok(/white-space:nowrap/.test(b), '🔴 D2: «Envío desde L 45» never breaks');
});
